/**
 * Issue #8 (a), host half (ADR 0014 amendment): the desktop wallet journal on disk and the money
 * plane over it, against the in-process TestMint, a FakeRelayPool and a real LocalSigner.
 *
 *   - the file: one per identity, 0600 in a 0700 directory, written atomically; a symlink or a
 *     file others can read is refused; writes to one path are serialised and an open waits for
 *     the last one;
 *   - the money plane: the journal is sealed at open, holds an operation whose answer was lost,
 *     survives `close` + a new open (the startup settle recovers it), refuses to journal once
 *     closed (the request never leaves), and a journal that does not open refuses the wallet
 *     and is left byte for byte;
 *   - the host says why: a plain "no wallet" is not what a broken journal shows.
 */
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getPubKeyFromPrivKey, type RequestFn } from '@cashu/cashu-ts';
import type { CashuP2pkPubkey, MintUrl, RelayUrl, Sats, UnixSeconds } from '@sovit/core';
import { mocks, nostr, signer as signerMod, wallet as walletMod } from '@sovit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHost } from '../host.js';
import { SignerIdentity } from '../identity.js';
import { memoryLogger } from '../log.js';
import { MoneyPlane } from '../money.js';
import {
  JOURNAL_UNREADABLE,
  NO_WALLET_YET,
  SwitchingWallet,
  unavailableReason,
} from '../wallet.js';
import { WALLET_DIR, journalFile, journalPath, openWalletJournal } from '../wallet-journal.js';
import { fakeSpawner, FakeWorker } from './support/fake-worker.js';

const MINT = 'https://mint.journal-host.test' as MintUrl;
const RELAY = 'wss://relay.journal-host.test' as RelayUrl;
const TO = Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(0x44))).toString(
  'hex',
) as CashuP2pkPubkey;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nf-journal-host-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function localSigner(): Promise<signerMod.LocalSigner> {
  return (
    await signerMod.LocalSigner.create({
      passphrase: Buffer.from('journal host passphrase'),
      cost: signerMod.minimumCost(),
    })
  ).signer;
}

describe('the journal file (host)', () => {
  it('lives per identity in <userData>/wallet, 0600 in 0700; a non-pubkey name is refused', async () => {
    const s = await localSigner();
    const me = await s.getPublicKey();
    const wdir = join(dir, WALLET_DIR);
    await mkdir(wdir, { mode: 0o755 });
    await openWalletJournal({ dir: wdir, signer: s, pubkey: me });
    expect((await stat(wdir)).mode & 0o777).toBe(0o700); // a loose mode is tightened
    const p = journalPath(wdir, me);
    expect(p).toBe(join(wdir, `journal-${me}.sealed`));
    expect((await stat(p)).mode & 0o777).toBe(0o600);
    expect(await readdir(wdir)).toEqual([`journal-${me}.sealed`]); // no temp file left behind
    expect(() => journalPath(wdir, '../../etc/passwd' as never)).toThrow(/invalid-argument/);
  });

  it('refuses a symlinked or readable-by-others journal instead of using it', async () => {
    const s = await localSigner();
    const me = await s.getPublicKey();
    const wdir = join(dir, WALLET_DIR);
    await openWalletJournal({ dir: wdir, signer: s, pubkey: me });
    const p = journalPath(wdir, me);
    await chmod(p, 0o644);
    await expect(openWalletJournal({ dir: wdir, signer: s, pubkey: me })).rejects.toThrow(
      /^journal-unreadable: the journal file is refused/,
    );
    const other = join(dir, 'elsewhere.sealed');
    await writeFile(other, await readFile(p), { mode: 0o600 });
    await rm(p);
    await symlink(other, p);
    await expect(openWalletJournal({ dir: wdir, signer: s, pubkey: me })).rejects.toThrow(
      /^journal-unreadable: the journal file is refused/,
    );
    // Neither refusal wrote anything: the file behind the link is what it was.
    expect((await readFile(other)).equals(await readFile(p))).toBe(true);
  });

  it('writes to one path land in call order, and a read waits for the write in flight', async () => {
    const p = join(dir, 'j.sealed');
    const a = journalFile(p);
    const b = journalFile(p); // another instance (the next money plane) on the same path
    const writes = [a.write('first'), a.write('second'), b.write('third')];
    expect(await b.read()).toBe('third');
    await Promise.all(writes);
    expect(await a.read()).toBe('third');
  });
});

describe('the money plane over the sealed journal', () => {
  function rig(wrap?: (r: RequestFn) => RequestFn) {
    const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x2e) });
    const pool = new nostr.FakeRelayPool();
    const request = wrap === undefined ? mint.request : wrap(mint.request);
    let t = 1_757_000_000;
    const open = (signer: signerMod.LocalSigner, create = false): Promise<MoneyPlane> =>
      MoneyPlane.open({
        signer,
        pool,
        relays: () => [{ url: RELAY, read: true, write: true }],
        defaultMints: () => [MINT],
        log: memoryLogger('warn'),
        mintRequest: () => request,
        journalDir: join(dir, WALLET_DIR),
        tailDir: null, // in memory: not about tail authorisations
        ...(create ? { createWallet: true } : {}),
        now: () => t++ as UnixSeconds,
      });
    return { mint, pool, open };
  }

  /** Loses the next swap answer; the restore endpoint is down while `restoreDown`. */
  function lossy() {
    const st = { drop: 0, restoreDown: false };
    const wrap =
      (inner: RequestFn): RequestFn =>
      async <T>(args: Parameters<RequestFn>[0]): Promise<T> => {
        if (st.restoreDown && args.endpoint.endsWith('/v1/restore'))
          throw new Error('connect ETIMEDOUT');
        const res = await inner<T>(args);
        if (st.drop > 0 && args.endpoint.endsWith('/v1/swap')) {
          st.drop--;
          throw new Error('socket hang up');
        }
        return res;
      };
    return { st, wrap };
  }

  async function fund(plane: MoneyPlane, mint: mocks.TestMint, n: number): Promise<void> {
    const q = await plane.wallet.mintQuote(MINT, n as Sats);
    mint.payQuote(q.quoteId);
    await plane.wallet.pollQuote(q);
  }

  it('a lost answer stays on disk across close and reopen, and the startup settle recovers it', async () => {
    const net = lossy();
    const { mint, open } = rig(net.wrap);
    const s = await localSigner();
    const me = await s.getPublicKey();
    const plane = await open(s, true);
    expect(await plane.recovery).toBeNull(); // nothing to settle in a fresh journal
    await fund(plane, mint, 32);
    net.st.drop = 1;
    net.st.restoreDown = true;
    await expect(plane.wallet.send(4 as Sats, { p2pk: TO, mint: MINT })).rejects.toThrow(
      /mint-error/,
    );
    expect(await plane.wallet.balance(MINT)).toBe(0); // held (issue #8 c)
    // On disk, sealed to this identity: the entry is there.
    const disk = await walletMod.SealedJournal.open({
      file: journalFile(journalPath(join(dir, WALLET_DIR), me)),
      signer: s,
      pubkey: me,
    });
    expect(disk.initial.ops.map((o) => o.kind)).toEqual(['send']);
    plane.close();

    net.st.restoreDown = false;
    const again = await open(s);
    expect(await again.recovery).toEqual({ recovered: 1, left: 0 });
    expect(await again.wallet.balance(MINT)).toBe(28);
    again.close();
  });

  it('held inputs come back by themselves: the plane settles an aged entry with only the balance read (review finding 1)', async () => {
    // Before: settles ran only inside an operation at that mint, or once at open. With the whole
    // balance held, the playback gate (`checkBalance`, which reads `wallet.balance`) refused
    // before any operation could run, so the sats stayed held until a restart.
    const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x2d) });
    const pool = new nostr.FakeRelayPool();
    const st = { refuseSwap: 0 };
    const request: RequestFn = async <T>(args: Parameters<RequestFn>[0]): Promise<T> => {
      if (st.refuseSwap > 0 && args.endpoint.endsWith('/v1/swap')) {
        st.refuseSwap--;
        throw new Error('connect ECONNREFUSED'); // never reached the mint
      }
      return mint.request<T>(args);
    };
    const clock = { t: 1_757_000_000 };
    const timers: { fn: () => void; ms: number; live: boolean }[] = [];
    const s = await localSigner();
    const plane = await MoneyPlane.open({
      signer: s,
      pool,
      relays: () => [{ url: RELAY, read: true, write: true }],
      defaultMints: () => [MINT],
      log: memoryLogger('warn'),
      mintRequest: () => request,
      journalDir: join(dir, WALLET_DIR),
      tailDir: null, // in memory: not about tail authorisations
      createWallet: true,
      now: () => clock.t as UnixSeconds,
      settleTimer: (fn, ms) => {
        const t = { fn, ms, live: true };
        timers.push(t);
        return () => {
          t.live = false;
        };
      },
    });
    try {
      await plane.recovery;
      await fund(plane, mint, 16); // one 16-sat proof
      st.refuseSwap = 1;
      await expect(plane.wallet.send(4 as Sats, { p2pk: TO, mint: MINT })).rejects.toThrow(
        /mint-error/,
      );
      expect(await plane.wallet.balance(MINT)).toBe(0); // held
      await plane.settles.idle();
      const planned = timers.filter((t) => t.live);
      expect(planned).toHaveLength(1);
      expect(planned[0]?.ms).toBe(
        (walletMod.PENDING_SETTLE_AFTER_S + walletMod.SETTLE_MARGIN_S) * 1000,
      );
      // An hour passes; only the balance is read (the header chip, the playback gate).
      clock.t += 3600;
      expect(await plane.wallet.balance(MINT)).toBe(0);
      // The planned settle runs (the runtime's timer): the input is back, spendable once.
      const due = planned[0];
      if (due === undefined) throw new Error('no settle planned');
      due.live = false;
      due.fn();
      await plane.settles.idle();
      expect(await plane.wallet.balance(MINT)).toBe(16);
      expect(timers.filter((t) => t.live)).toHaveLength(0); // nothing left to settle
      await plane.wallet.send(16 as Sats, { p2pk: TO, mint: MINT });
      expect(await plane.wallet.balance(MINT)).toBe(0);
    } finally {
      plane.close();
    }
    // Closed: the loop plans nothing more.
    expect(timers.filter((t) => t.live)).toHaveLength(0);
  });

  it('closing the plane (lock, sign-out) cancels its planned settle', async () => {
    const net = lossy();
    const { mint, pool } = rig(net.wrap);
    const timers: { live: boolean }[] = [];
    const s = await localSigner();
    const plane = await MoneyPlane.open({
      signer: s,
      pool,
      relays: () => [{ url: RELAY, read: true, write: true }],
      defaultMints: () => [MINT],
      log: memoryLogger('warn'),
      mintRequest: () => net.wrap(mint.request),
      journalDir: join(dir, WALLET_DIR),
      tailDir: null, // in memory: not about tail authorisations
      createWallet: true,
      settleTimer: () => {
        const t = { live: true };
        timers.push(t);
        return () => {
          t.live = false;
        };
      },
    });
    await plane.recovery;
    await fund(plane, mint, 16);
    net.st.drop = 1;
    net.st.restoreDown = true;
    await expect(plane.wallet.send(4 as Sats, { p2pk: TO, mint: MINT })).rejects.toThrow(
      /mint-error/,
    );
    await plane.settles.idle();
    expect(timers.filter((t) => t.live)).toHaveLength(1);
    plane.close();
    expect(timers.filter((t) => t.live)).toHaveLength(0);
    expect(plane.settles.plannedAt).toBeNull();
  });

  it('once closed, nothing more is journaled: a payment is refused before its request leaves', async () => {
    const { mint, open } = rig();
    const s = await localSigner();
    const plane = await open(s, true);
    await fund(plane, mint, 16);
    const swaps = mint.calls.filter((c) => c === 'POST /v1/swap').length;
    plane.close();
    await expect(plane.wallet.send(2 as Sats, { p2pk: TO, mint: MINT })).rejects.toThrow(
      /journal-unreadable|closed/,
    );
    expect(mint.calls.filter((c) => c === 'POST /v1/swap').length).toBe(swaps);
  });

  it('a journal that does not open refuses the wallet, and the file is left byte for byte', async () => {
    const { open } = rig();
    const s = await localSigner();
    const me = await s.getPublicKey();
    (await open(s, true)).close();
    const p = journalPath(join(dir, WALLET_DIR), me);
    const env = JSON.parse(await readFile(p, 'utf8')) as { box: string };
    // Complement the tag's last byte, so the file always changes. Writing a fixed `00` changed nothing
    // one run in 256 (the tag is random: it ended in 00), the damage was no damage, the journal
    // opened, and this test failed on a green tree.
    const flipped = (Number.parseInt(env.box.slice(-2), 16) ^ 0xff).toString(16).padStart(2, '0');
    const damaged = JSON.stringify({ ...env, box: `${env.box.slice(0, -2)}${flipped}` });
    await writeFile(p, damaged, { mode: 0o600 });
    await expect(open(s)).rejects.toThrow(/^journal-unreadable: /);
    expect(await readFile(p, 'utf8')).toBe(damaged);
  });
});

describe('the host says why payments are off', () => {
  it('SwitchingWallet answers with the journal reason, not "no wallet"', async () => {
    const w = new SwitchingWallet();
    await expect(w.balances()).rejects.toThrow(NO_WALLET_YET);
    w.set(undefined, unavailableReason('journal-unreadable'));
    await expect(w.balances()).rejects.toThrow(/wallet journal/);
    w.set(undefined, unavailableReason(null));
    await expect(w.balances()).rejects.toThrow(NO_WALLET_YET);
    expect(unavailableReason('no-wallet')).toBe(NO_WALLET_YET);
  });

  it('createHost with a signer whose journal is damaged: the wallet is unavailable with the journal reason', async () => {
    const s = await localSigner();
    const me = await s.getPublicKey();
    const wdir = join(dir, WALLET_DIR);
    await mkdir(wdir, { recursive: true, mode: 0o700 });
    await writeFile(journalPath(wdir, me), '{"not":"a journal"}', { mode: 0o600 });
    const log = memoryLogger('debug');
    const spawner = fakeSpawner(() => new FakeWorker());
    const pool = new nostr.FakeRelayPool();
    // A wallet event on the relays, so only the journal can stop the wallet from opening.
    const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x2f) });
    await MoneyPlane.open({
      signer: s,
      journalDir: null, // only publishes the wallet event; the host opens the journal below
      tailDir: null, // in memory: not about tail authorisations
      pool,
      relays: () => [{ url: RELAY, read: true, write: true }],
      defaultMints: () => [MINT],
      log: memoryLogger('warn'),
      mintRequest: () => mint.request,
      createWallet: true,
    }).then((p) => {
      p.close();
    });
    const host = await createHost({
      userData: dir,
      flags: { devMocks: false, devFixtures: false },
      post: () => undefined,
      log,
      workerEntry: '/nonexistent/worker.js',
      spawn: spawner.spawn,
      pool,
      identity: new SignerIdentity(s),
      mintRequest: () => mint.request,
      imageTransport: () => Promise.reject(new Error('no network in tests')),
    });
    try {
      await host.adapter.updateSettings({ relays: [{ url: RELAY, read: true, write: true }] });
      await expect(host.adapter.wallet.balances()).rejects.toThrow(JOURNAL_UNREADABLE);
      expect(
        log.lines.some((l) => l.level === 'error' && l['reason'] === 'journal-unreadable'),
      ).toBe(true);
      // The damaged file is still there, untouched.
      expect(await readFile(journalPath(wdir, me), 'utf8')).toBe('{"not":"a journal"}');
    } finally {
      host.stop();
    }
  });
});
