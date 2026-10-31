/**
 * ADR 0016 (issue #3): the desktop's recovery phrase flows end to end against fakes of lane N1's
 * seam (`support/fake-recovery.ts`) — a real `MainBridge` whose "main" answers prompts and native
 * confirms by script, a real `LocalSigner` (NIP-44 to self), real files in a temp userData, and
 * core's `FakeRelayPool`. Every test ends with the canary: no word, no index list and no entropy
 * reached the logs, a result or a progress event.
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MintUrl, NostrPubkey, RelayUrl, Sats, Signer, UnixSeconds } from '@sovit/core';
import { nostr, signer as signerMod, wallet as walletMod } from '@sovit/core';

import { isConfirmForm, isPromptForm } from '../../ipc/guards.js';
import type {
  ConfirmForm,
  HostOut,
  PromptAnswer,
  PromptForm,
  RecoveryProgressWire,
} from '../../ipc/protocol.js';
import { MAX_REISSUE_PLANS } from '../../ipc/protocol.js';
import { memoryLogger } from '../log.js';
import type { MoneyPlane } from '../money.js';
import { GateRefusal, PAY_STILL_BUILDING_HOLD } from '../pay-melt-gate.js';
import { entropyHex } from '../recovery/core.js';
import {
  MAX_REISSUED_MINTS,
  readEnvelope,
  recoveryPath,
  writeEnvelope,
} from '../recovery/files.js';
import type { PlaneSeed } from '../recovery/service.js';
import type { RecoveryTimers } from '../recovery/service.js';
import {
  CONFIRM_ATTEMPTS,
  RELAY_RETRY_FIRST_MS,
  RELAY_RETRY_MAX_MS,
  RELAY_RUN_WAIT_MS,
  RESTORE_ROUNDS,
  RecoveryService,
  WATCH_RETRY_MAX_MS,
  reasonOf,
} from '../recovery/service.js';
import { MainBridge } from '../signer/main-bridge.js';
import { CANCEL_LIMIT, UNLOCK_ATTEMPTS } from '../signer/desktop-signer.js';
import { FakeRecoveryCore, entropyHexOf, wordsOf } from './support/fake-recovery.js';

const MINT_A = 'https://mint-a.recovery.test' as MintUrl;
const MINT_B = 'https://mint-b.recovery.test' as MintUrl;
const RELAY = 'wss://relay.recovery.test' as RelayUrl;
const PASS = 'correct horse battery staple';
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A fixed first phrase: "legal winner thank year wave sausage worth useful legal winner thank yellow". */
const ENTROPY_1 = new Uint8Array(16).fill(0x7f);
const ENTROPY_2 = new Uint8Array(16).fill(0x80);
const ENTROPY_3 = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface FakePlane {
  readonly pubkey: NostrPubkey;
  readonly mints: readonly MintUrl[];
  readonly seeded: walletMod.SeededWallet | undefined;
  readonly wallet: {
    balances(): Promise<ReadonlyMap<MintUrl, Sats>>;
    mints(): Promise<readonly MintUrl[]>;
  };
  /** W8a: journal entries per mint (`World.pending`). */
  pendingAt(mint: MintUrl): Promise<number>;
  /** Fix round 9: of those, the young ones (`World.pending` less `World.overdue`). */
  youngPendingAt(mint: MintUrl): Promise<number>;
  close(): void;
}

interface World {
  readonly svc: RecoveryService;
  readonly core: FakeRecoveryCore;
  readonly signer: Signer;
  readonly pubkey: NostrPubkey;
  readonly dir: string;
  readonly pool: nostr.FakeRelayPool;
  readonly log: ReturnType<typeof memoryLogger>;
  readonly asked: PromptForm[];
  readonly confirms: ConfirmForm[];
  readonly out: HostOut[];
  readonly progress: RecoveryProgressWire[];
  /** Each reopen: did `beforeOpen` write this identity's phrase file (with no plane open)? */
  readonly reopens: { savedWithNoPlane: boolean }[];
  plane(): FakePlane | undefined;
  /** Replace the prompt script (a promise holds the window open). */
  answer: (f: PromptForm) => PromptAnswer | null | Promise<PromptAnswer | null>;
  confirm: (f: ConfirmForm) => boolean;
  balances: Map<MintUrl, number>;
  /** W8a: journal entries the plane reports per mint (none by default). */
  pending: Map<MintUrl, number>;
  /**
   * Fix round 9: how many of a mint's entries are overdue (past `PENDING_SETTLE_AFTER_S`); the rest
   * are young, as a fresh entry is (none overdue by default).
   */
  overdue: Map<MintUrl, number>;
  /** W8a: the relay copy retry's timers, fired by hand. */
  readonly timers: ManualTimers;
  /** W8a: `closeSessions` and reopens, in order. */
  readonly lifecycle: string[];
  clock: number;
  openPlane(): Promise<void>;
}

/** Timers a test fires by hand (W8a: the relay copy retry). */
interface ManualTimers extends RecoveryTimers {
  readonly armed: { readonly ms: number; readonly fn: () => unknown }[];
  /**
   * Fire the next armed timer; resolves once what it started has settled — or, for work a test
   * holds on purpose (`hangs`), after a few turns.
   */
  fire(o?: { readonly hangs?: boolean }): Promise<void>;
}

function manualTimers(): ManualTimers {
  const armed: { ms: number; fn: () => unknown }[] = [];
  return {
    armed,
    setTimeout: (fn, ms) => {
      const h = { ms, fn };
      armed.push(h);
      return h;
    },
    clearTimeout: (h) => {
      const i = armed.indexOf(h as { ms: number; fn: () => unknown });
      if (i >= 0) armed.splice(i, 1);
    },
    fire: async (o = {}) => {
      const h = armed.shift();
      if (h === undefined) throw new Error('no timer armed');
      // The retry it started, then a few turns for what that schedules (a fixed wall-clock wait
      // alone flaked on a loaded CI runner).
      const work = h.fn();
      if (o.hangs !== true) await work;
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    },
  };
}

async function world(
  o: { kind?: 'local' | 'nip46'; core?: FakeRecoveryCore | null } = {},
): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), 'nf-n2-svc-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'wallet');
  const core = o.core === null ? undefined : (o.core ?? new FakeRecoveryCore());
  const { signer: local, file } = await signerMod.LocalSigner.create({
    passphrase: enc(PASS),
    cost: signerMod.minimumCost(),
  });
  const pubkey = await local.getPublicKey();
  // A NIP-46-like signer: the same key, another kind (no local passphrase to re-check).
  const signer: Signer =
    o.kind === 'nip46'
      ? ({
          kind: 'nip46',
          getPublicKey: () => local.getPublicKey(),
          signEvent: (e) => local.signEvent(e),
          nip44Encrypt: (pk, t) => local.nip44Encrypt(pk, t),
          nip44Decrypt: (pk, c) => local.nip44Decrypt(pk, c),
        } as Signer)
      : local;
  const pool = new nostr.FakeRelayPool();
  const log = memoryLogger('debug');
  const out: HostOut[] = [];
  const w = {} as World;
  w.answer = () => null;
  w.confirm = () => false;
  w.balances = new Map();
  w.pending = new Map();
  w.overdue = new Map();
  const timers = manualTimers();
  const lifecycle: string[] = [];
  w.clock = 1_000_000;
  const asked: PromptForm[] = [];
  const confirms: ConfirmForm[] = [];
  const bridge: MainBridge = new MainBridge({
    post: (m) => {
      out.push(m);
      if (m.kind === 'prompt') {
        expect(isPromptForm(m.form), m.form.kind).toBe(true);
        asked.push(structuredClone(m.form));
        void Promise.resolve(w.answer(m.form)).then((a) => {
          bridge.onPromptAnswer(m.req, a);
        });
      } else if (m.kind === 'confirm') {
        expect(isConfirmForm(m.form)).toBe(true);
        confirms.push(structuredClone(m.form));
        const ok = w.confirm(m.form);
        queueMicrotask(() => {
          bridge.onConfirmResult(m.req, ok);
        });
      }
    },
  });
  let plane: FakePlane | undefined;
  const reopens: { savedWithNoPlane: boolean }[] = [];
  const progress: RecoveryProgressWire[] = [];
  const makePlane = (seed: PlaneSeed | undefined): FakePlane => {
    if (seed !== undefined) seed.core.seedOption(seed.material);
    const seeded = seed?.core.seeded({} as walletMod.CashuWallet);
    return {
      pubkey,
      mints: [MINT_A],
      seeded,
      wallet: {
        balances: () =>
          Promise.resolve(new Map(w.balances) as unknown as ReadonlyMap<MintUrl, Sats>),
        mints: () => Promise.resolve([MINT_A, MINT_B]),
      },
      pendingAt: (mint) => Promise.resolve(w.pending.get(mint) ?? 0),
      youngPendingAt: (mint) =>
        Promise.resolve(Math.max(0, (w.pending.get(mint) ?? 0) - (w.overdue.get(mint) ?? 0))),
      close: () => {
        seed?.material.seed.wipe();
      },
    };
  };
  const svc: RecoveryService = new RecoveryService({
    core,
    dir,
    bridge,
    signer: () => signer,
    plane: () => plane as unknown as MoneyPlane | undefined,
    reopenMoney: async (between) => {
      lifecycle.push('reopen');
      const old = plane;
      plane = undefined;
      old?.close();
      let err: unknown;
      let failed = false;
      const before = await readFile(recoveryPath(dir, pubkey), 'utf8').catch(() => null);
      if (between !== undefined)
        try {
          await between();
        } catch (e) {
          failed = true;
          err = e;
        }
      const after = await readFile(recoveryPath(dir, pubkey), 'utf8').catch(() => null);
      // `plane` is read back through the getter: `beforeOpen` could have reopened it.
      reopens.push({
        savedWithNoPlane: w.plane() === undefined && after !== null && after !== before,
      });
      plane = makePlane(await svc.seedFor(signer, pubkey));
      if (failed) throw err;
    },
    checkPassphrase: async (pass, pk) => {
      try {
        const s = await signerMod.LocalSigner.unlock(file, pass);
        const ok = (await s.getPublicKey()) === pk;
        await s.lock();
        return ok;
      } catch {
        return false;
      }
    },
    relays: { pool, write: () => [RELAY], read: () => [RELAY] },
    log,
    now: () => 1_760_000_000 as UnixSeconds,
    clock: () => w.clock,
    timers,
    closeSessions: () => {
      lifecycle.push('close sessions');
      return Promise.resolve();
    },
  });
  svc.onProgress((p) => progress.push(p));
  if (core !== undefined) core.wallet.balances.clear();
  Object.assign(w, {
    svc,
    core,
    signer,
    pubkey,
    dir,
    pool,
    log,
    asked,
    confirms,
    out,
    progress,
    reopens,
    timers,
    lifecycle,
    plane: () => plane,
    openPlane: async () => {
      plane = makePlane(await svc.seedFor(signer, pubkey));
    },
  });
  await w.openPlane();
  return w;
}

/** Plays the user through a new phrase: "I wrote them down", then the right words back. */
function userWhoWritesItDown(w: World, opts: { later?: boolean; wrongWords?: boolean } = {}): void {
  let shown: readonly number[] = [];
  w.answer = (f) => {
    if (f.kind === 'recovery-show') {
      shown = [...f.words];
      return { kind: 'recovery-show', done: opts.later !== true };
    }
    if (f.kind === 'recovery-confirm')
      return {
        kind: 'recovery-confirm',
        words: f.positions.map((p) =>
          opts.wrongWords === true ? ((shown[p] ?? 0) + 1) % 2048 : (shown[p] ?? 0),
        ),
      };
    if (f.kind === 'recovery-reauth') return { kind: 'secret', value: enc(PASS) };
    return null;
  };
}

/** The canary: nothing secret about any phrase in logs, results, progress or errors. */
function expectNoPhrase(w: World, extra: unknown[] = []): void {
  const phrases = [...w.core.phrases.generated, ENTROPY_1, ENTROPY_2, ENTROPY_3];
  const logs = w.log.lines.map((l) => JSON.stringify(l)).join('\n');
  const sink = `${logs}\n${JSON.stringify(w.progress)}\n${JSON.stringify(extra)}`;
  for (const e of phrases) {
    const indices = w.core.phrases.toIndices(e as walletMod.RecoveryEntropy);
    const words = wordsOf(indices);
    expect(sink).not.toContain(entropyHexOf(e));
    expect(sink).not.toContain(JSON.stringify(indices));
    expect(sink).not.toContain(indices.join(','));
    // No run of three of its words in order (a single common word may appear in a sentence).
    for (let i = 0; i + 3 <= words.length; i++)
      expect(sink).not.toContain(words.slice(i, i + 3).join(' '));
  }
}

describe('setup: a new phrase (ADR 0016 §1, D2, D5)', () => {
  it('shows indices, seals the entropy NIP-44 to self (0600 in 0700) while no plane holds the wallet, publishes the relay copy, confirms three words, reissues after the fee confirm', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_1);
    w.balances.set(MINT_A, 1_000);
    w.balances.set(MINT_B, 0);
    w.core.wallet.balances.set(MINT_A, 1_000);
    w.core.wallet.plans.set(MINT_A, { inputs: 4, feeSats: 2 });
    userWhoWritesItDown(w);
    w.confirm = () => true;
    expect((await w.svc.status()).state).toBe('not-on-device');

    const r = await w.svc.setup();

    // The window got 12 indices — exactly the phrase — and never a word.
    const show = w.asked.find((f) => f.kind === 'recovery-show');
    expect(show).toEqual({
      kind: 'recovery-show',
      words: w.core.phrases.toIndices(ENTROPY_1 as walletMod.RecoveryEntropy),
      again: false,
    });
    const conf = w.asked.find((f) => f.kind === 'recovery-confirm');
    expect(conf?.kind === 'recovery-confirm' && conf.positions).toHaveLength(3);
    // Saved during the reopen, with no plane open.
    expect(w.reopens).toEqual([{ savedWithNoPlane: true }]);
    // The sealed file: 0600 in a 0700 directory, the entropy NIP-44 to self.
    const path = recoveryPath(w.dir, w.pubkey);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(w.dir)).mode & 0o777).toBe(0o700);
    const env = await readEnvelope(path);
    expect(env).toMatchObject({ confirmed: true, reissued: true, relayCopy: true, replaces: null });
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain(entropyHex(ENTROPY_1));
    const plain = JSON.parse(await w.signer.nip44Decrypt(w.pubkey, env?.sealed ?? '')) as unknown;
    expect(plain).toEqual({ v: 1, entropy: entropyHex(ENTROPY_1), created: 1_760_000_000 });
    // The relay copy: kind 30078, d = nutflix/nut13/<device>, the same ciphertext, no other tag.
    const copies = w.pool.published.filter((p) => p.event.kind === walletMod.RECOVERY_RELAY_KIND);
    expect(copies).toHaveLength(1);
    const ev = copies[0]?.event;
    expect(ev?.tags).toEqual([['d', `${walletMod.RECOVERY_D_PREFIX}${env?.device ?? ''}`]]);
    expect(ev?.content).toBe(env?.sealed);
    expect(ev?.pubkey).toBe(w.pubkey);
    // The plane now derives from THIS phrase.
    const seed = w.core.materials.at(-1)?.seed as unknown as { entropyHex: string; wiped: boolean };
    expect(seed.entropyHex).toBe(entropyHex(ENTROPY_1));
    expect(seed.wiped).toBe(false);
    // The fee was shown natively before anything moved, then the reissue ran.
    expect(w.confirms).toEqual([
      {
        kind: 'recovery-reissue',
        plans: [{ mint: MINT_A, amount: 1_000, inputs: 4, feeSats: 2 }],
      },
    ]);
    expect(w.core.wallet.reissued.map((p) => p.mint)).toEqual([MINT_A]);
    expect(r).toEqual({
      status: { state: 'covered', reissuePending: false, relayCopy: true },
      reissuedSats: 998,
      feeSats: 2,
      reissueFailed: 0,
    });
    // The entropy the fake core handed out was wiped after use.
    expect(w.core.phrases.generated).toHaveLength(1);
    expectNoPhrase(w, [r]);
  });

  it('closing the window (or Escape) discards the phrase: nothing saved, nothing published, no reopen', async () => {
    const w = await world();
    w.answer = () => null;
    await expect(w.svc.setup()).rejects.toMatchObject({ code: 'cancelled' });
    expect(await readdir(w.dir).catch(() => [])).toEqual([]);
    expect(w.pool.published).toEqual([]);
    expect(w.reopens).toEqual([]);
    expect((await w.svc.status()).state).toBe('not-on-device');
    expectNoPhrase(w);
  });

  it('"Later": saved and published but not confirmed; the fee declined leaves the reissue pending, and setup then finishes only the reissue', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_2);
    w.balances.set(MINT_A, 500);
    w.core.wallet.balances.set(MINT_A, 500);
    w.core.wallet.plans.set(MINT_A, { inputs: 2, feeSats: 1 });
    userWhoWritesItDown(w, { later: true });
    w.confirm = () => false;
    const r = await w.svc.setup();
    expect(w.asked.map((f) => f.kind)).toEqual(['recovery-show']);
    expect(r.status).toEqual({ state: 'not-confirmed', reissuePending: true, relayCopy: true });
    expect(r.reissueFailed).toBe(1);
    expect(w.core.wallet.reissued).toEqual([]);

    // Again: no new phrase, no window with words — only the reissue.
    w.asked.length = 0;
    w.confirm = () => true;
    const r2 = await w.svc.setup();
    expect(w.asked).toEqual([]);
    expect(w.core.phrases.generated).toHaveLength(1);
    expect(r2.status).toEqual({ state: 'not-confirmed', reissuePending: false, relayCopy: true });
    expect(r2.reissuedSats).toBe(499);
    expectNoPhrase(w, [r, r2]);
  });

  it('three wrong confirmations: kept, not confirmed', async () => {
    const w = await world();
    userWhoWritesItDown(w, { wrongWords: true });
    w.confirm = () => true;
    const r = await w.svc.setup();
    expect(w.asked.filter((f) => f.kind === 'recovery-confirm')).toHaveLength(CONFIRM_ATTEMPTS);
    expect(w.asked.filter((f) => f.kind === 'recovery-confirm').map((f) => f.retry)).toEqual([
      false,
      true,
      true,
    ]);
    expect(r.status.state).toBe('not-confirmed');
    expectNoPhrase(w, [r]);
  });

  it('relays refusing the copy: sealed on this device only, and the status says so', async () => {
    const w = await world();
    (w.pool as unknown as { publish: nostr.PoolLike['publish'] }).publish = (relays) =>
      Promise.resolve(relays.map((url) => ({ url, ok: false, reason: 'blocked' })));
    userWhoWritesItDown(w);
    w.confirm = () => true;
    const r = await w.svc.setup();
    expect(r.status).toEqual({ state: 'covered', reissuePending: false, relayCopy: false });
    expect(w.log.lines.some((l) => l.msg.includes('reached no relay'))).toBe(true);
  });

  it('a phrase file that does not open is never replaced (status unreadable, setup forbidden)', async () => {
    const w = await world();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(w.dir, { recursive: true, mode: 0o700 });
    await writeFile(recoveryPath(w.dir, w.pubkey), '{"not":"an envelope"}', { mode: 0o600 });
    await w.openPlane();
    expect((await w.svc.status()).state).toBe('unreadable');
    await expect(w.svc.setup()).rejects.toMatchObject({ code: 'forbidden' });
    expect(await readFile(recoveryPath(w.dir, w.pubkey), 'utf8')).toBe('{"not":"an envelope"}');
    expect(w.log.lines.some((l) => l['reason'] === 'recovery-unreadable')).toBe(true);
  });

  it('a seed the wallet did not take: the phrase is on this device but the status says unreadable, never covered', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    w.core.takesSeed = false;
    const r = await w.svc.setup();
    expect(w.plane()?.seeded).toBeUndefined();
    expect(r.status.state).toBe('unreadable');
    expect((await w.svc.status()).state).toBe('unreadable');
    // Nothing was reissued into outputs the phrase could not restore.
    expect(w.core.wallet.reissued).toEqual([]);
  });

  it('a phrase sealed to another identity does not open: the plane derives nothing from it', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    const env = await readEnvelope(recoveryPath(w.dir, w.pubkey));
    const { signer: other } = await signerMod.LocalSigner.create({
      passphrase: enc('another passphrase!'),
      cost: signerMod.minimumCost(),
    });
    const foreign = await other.nip44Encrypt(
      await other.getPublicKey(),
      JSON.stringify({ v: 1, entropy: entropyHex(ENTROPY_3), created: 1 }),
    );
    await writeFile(recoveryPath(w.dir, w.pubkey), JSON.stringify({ ...env, sealed: foreign }), {
      mode: 0o600,
    });
    const before = w.core.materials.length;
    await w.openPlane();
    expect(w.core.materials.length).toBe(before);
    expect(w.plane()?.seeded).toBeUndefined();
    expect((await w.svc.status()).state).toBe('unreadable');
  });
});

describe('rotation, show again (ADR 0016 §1: re-authentication first)', () => {
  it('a finished phrase is replaced only after the passphrase; the old one is kept as .retired and its relay copy retired once the reissue completed', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_1, ENTROPY_2);
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    const first = await readEnvelope(recoveryPath(w.dir, w.pubkey));
    w.asked.length = 0;
    const r = await w.svc.setup();
    expect(w.asked[0]).toEqual({ kind: 'recovery-reauth', retry: false });
    const second = await readEnvelope(recoveryPath(w.dir, w.pubkey));
    expect(second?.device).not.toBe(first?.device);
    expect(second?.replaces).toBeNull();
    const names = await readdir(w.dir);
    expect(names).toContain(`recovery-${w.pubkey}.${first?.device ?? ''}.retired`);
    // The old copy: blanked and deleted (NIP-09), best effort.
    const d = `${walletMod.RECOVERY_D_PREFIX}${first?.device ?? ''}`;
    const blank = w.pool.published.find(
      (p) =>
        p.event.kind === walletMod.RECOVERY_RELAY_KIND &&
        p.event.content === '' &&
        p.event.tags[0]?.[1] === d,
    );
    expect(blank).toBeDefined();
    const deletion = w.pool.published.find((p) => p.event.kind === 5);
    expect(deletion?.event.tags).toContainEqual([
      'a',
      `${String(walletMod.RECOVERY_RELAY_KIND)}:${w.pubkey}:${d}`,
    ]);
    // The plane derives from the NEW phrase.
    const seed = w.core.materials.at(-1)?.seed as unknown as { entropyHex: string };
    expect(seed.entropyHex).toBe(entropyHex(ENTROPY_2));
    expect(r.status.state).toBe('covered');
    expectNoPhrase(w, [r]);
  });

  it('a replacement whose reissue was declined keeps `replaces` (the old copy stays until the reissue completes)', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    const first = await readEnvelope(recoveryPath(w.dir, w.pubkey));
    w.balances.set(MINT_A, 100);
    w.core.wallet.balances.set(MINT_A, 100);
    w.core.wallet.plans.set(MINT_A, { inputs: 1, feeSats: 1 });
    w.confirm = () => false;
    await w.svc.setup();
    const second = await readEnvelope(recoveryPath(w.dir, w.pubkey));
    expect(second).toMatchObject({ reissued: false, replaces: first?.device });
    expect(w.pool.published.some((p) => p.event.kind === 5)).toBe(false);
    w.confirm = () => true;
    await w.svc.setup();
    expect(await readEnvelope(recoveryPath(w.dir, w.pubkey))).toMatchObject({
      reissued: true,
      replaces: null,
    });
    expect(w.pool.published.some((p) => p.event.kind === 5)).toBe(true);
  });

  it('a wrong passphrase three times is `forbidden`; nothing is shown or replaced', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    const before = await readFile(recoveryPath(w.dir, w.pubkey), 'utf8');
    w.asked.length = 0;
    w.answer = (f) =>
      f.kind === 'recovery-reauth' ? { kind: 'secret', value: enc('wrong!') } : null;
    await expect(w.svc.show()).rejects.toMatchObject({ code: 'forbidden' });
    expect(w.asked.map((f) => f.kind)).toEqual(Array(UNLOCK_ATTEMPTS).fill('recovery-reauth'));
    await expect(w.svc.setup()).rejects.toMatchObject({ code: 'forbidden' });
    expect(await readFile(recoveryPath(w.dir, w.pubkey), 'utf8')).toBe(before);
    expect(w.asked.some((f) => f.kind === 'recovery-show')).toBe(false);
  });

  it('show again: the same indices after the passphrase; an unconfirmed backup can be confirmed then', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_3);
    userWhoWritesItDown(w, { later: true });
    w.confirm = () => true;
    await w.svc.setup();
    expect((await w.svc.status()).state).toBe('not-confirmed');
    userWhoWritesItDown(w);
    w.asked.length = 0;
    await w.svc.show();
    expect(w.asked.map((f) => f.kind)).toEqual([
      'recovery-reauth',
      'recovery-show',
      'recovery-confirm',
    ]);
    expect(w.asked[1]).toEqual({
      kind: 'recovery-show',
      words: w.core.phrases.toIndices(ENTROPY_3 as walletMod.RecoveryEntropy),
      again: true,
    });
    expect((await w.svc.status()).state).toBe('covered');
    expectNoPhrase(w);
  });

  it('a remote signer (NIP-46) re-authenticates with main’s native confirm instead', async () => {
    const w = await world({ kind: 'nip46' });
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    w.asked.length = 0;
    w.confirms.length = 0;
    w.confirm = (f) => f.kind !== 'recovery-reveal';
    await expect(w.svc.show()).rejects.toMatchObject({ code: 'cancelled' });
    expect(w.confirms).toEqual([{ kind: 'recovery-reveal' }]);
    expect(w.asked).toEqual([]);
    w.confirm = () => true;
    await w.svc.show();
    expect(w.asked.map((f) => f.kind)).toEqual(['recovery-show']);
  });
});

describe('restore (ADR 0016 §5)', () => {
  it('needs this device’s phrase in use first', async () => {
    const w = await world();
    await expect(w.svc.restore()).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(w.asked).toEqual([]);
  });

  it('the relay copies are read ONLY by an explicit restore: never at startup, setup or show', async () => {
    const w = await world();
    const reads = (): number =>
      w.pool.queries.filter((q) => q.filter.kinds?.includes(walletMod.RECOVERY_RELAY_KIND) === true)
        .length;
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    await w.openPlane();
    await w.svc.status();
    await w.svc.show();
    expect(reads()).toBe(0);
    w.answer = (f) =>
      f.kind === 'recovery-restore' ? { kind: 'recovery-restore', words: [] } : null;
    await w.svc.restore();
    expect(reads()).toBe(1);
    expect(w.pool.queries.at(-1)?.filter).toMatchObject({
      kinds: [walletMod.RECOVERY_RELAY_KIND],
      authors: [w.pubkey],
    });
  });

  it('scans this device’s phrases (current + retired), every relay copy the identity decrypts and a typed phrase — once each — with progress and one row per mint', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_1, ENTROPY_2);
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup(); // ENTROPY_1
    await w.svc.setup(); // rotation: ENTROPY_2 current, ENTROPY_1 retired
    // Another device's copy on the relays (sealed to the same identity), plus a duplicate of
    // ENTROPY_1 and junk.
    const other = await w.signer.nip44Encrypt(
      w.pubkey,
      JSON.stringify({ v: 1, entropy: entropyHex(ENTROPY_3), created: 5 }),
    );
    await w.pool.publish(
      [RELAY],
      await w.signer.signEvent({
        kind: walletMod.RECOVERY_RELAY_KIND,
        created_at: 1_760_000_100,
        tags: [['d', `${walletMod.RECOVERY_D_PREFIX}${'ab'.repeat(16)}`]],
        content: other,
      }),
    );
    await w.pool.publish(
      [RELAY],
      await w.signer.signEvent({
        kind: walletMod.RECOVERY_RELAY_KIND,
        created_at: 1_760_000_101,
        tags: [['d', `${walletMod.RECOVERY_D_PREFIX}${'cd'.repeat(16)}`]],
        content: 'not nip44',
      }),
    );
    const typed = w.core.phrases.toIndices(ENTROPY_3 as walletMod.RecoveryEntropy);
    w.answer = (f) =>
      f.kind === 'recovery-restore' ? { kind: 'recovery-restore', words: [...typed] } : null;
    w.core.wallet.restores.set(entropyHex(ENTROPY_1), {
      [MINT_A]: { outcome: 'restored', restoredSats: 40 },
    });
    w.core.wallet.restores.set(entropyHex(ENTROPY_3), {
      [MINT_A]: { outcome: 'restored', restoredSats: 2 },
      [MINT_B]: { outcome: 'unsupported', restoredSats: 0 },
    });
    w.progress.length = 0;
    const r = await w.svc.restore();
    const scanned = w.core.wallet.restoreCalls.map((c) => c.entropyHex).sort();
    expect(scanned).toEqual(
      [entropyHex(ENTROPY_1), entropyHex(ENTROPY_2), entropyHex(ENTROPY_3)].sort(),
    );
    expect(w.core.wallet.restoreCalls.every((c) => c.liveDuringRestore)).toBe(true);
    expect(w.core.wallet.restoreCalls[0]?.mints).toEqual([MINT_A, MINT_B]);
    expect(r).toEqual({
      phrases: 3,
      reports: [
        { mint: MINT_A, outcome: 'restored', restoredSats: 42 },
        { mint: MINT_B, outcome: 'unsupported', restoredSats: 0 },
      ],
    });
    // Every seed made for the restore was wiped after its pass.
    const restoreSeeds = w.core.phrases.seeds.slice(-3);
    expect(restoreSeeds.every((s) => s.wiped)).toBe(true);
    // Progress: numbers and the user's own mint URLs only.
    expect(w.progress.length).toBeGreaterThan(0);
    for (const p of w.progress) {
      expect(Object.keys(p).sort()).toEqual([
        'keysets',
        'keysetsDone',
        'mint',
        'phrase',
        'phrases',
      ]);
      expect(p.phrases).toBe(3);
    }
    expect(w.log.lines.find((l) => l.msg === 'restoring from recovery phrases')).toMatchObject({
      phrases: 3,
      relayUnreadable: 1,
      localUnreadable: 0,
    });
    expectNoPhrase(w, [r]);
  });

  it('a typed phrase with a bad checksum is refused by core (the problem named, never a word)', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    const bad = [...w.core.phrases.toIndices(ENTROPY_1 as walletMod.RecoveryEntropy)];
    bad[11] = ((bad[11] ?? 0) + 1) % 2048;
    w.answer = (f) =>
      f.kind === 'recovery-restore' ? { kind: 'recovery-restore', words: bad } : null;
    const err = await w.svc.restore().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'invalid-argument' });
    expect((err as Error).message).toMatch(/\(checksum\)$/);
    expect(w.core.wallet.restoreCalls).toEqual([]);
    expectNoPhrase(w, [(err as Error).message]);
  });

  it('a pass that fails marks its mints unreachable and the others still run', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_1);
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    w.core.wallet.failRestore.add(entropyHex(ENTROPY_1));
    const typed = w.core.phrases.toIndices(ENTROPY_2 as walletMod.RecoveryEntropy);
    w.core.wallet.restores.set(entropyHex(ENTROPY_2), {
      [MINT_B]: { outcome: 'restored', restoredSats: 7 },
    });
    w.answer = (f) =>
      f.kind === 'recovery-restore' ? { kind: 'recovery-restore', words: [...typed] } : null;
    const r = await w.svc.restore();
    expect(r.reports).toEqual([
      { mint: MINT_A, outcome: 'unreachable', restoredSats: 0 },
      { mint: MINT_B, outcome: 'restored', restoredSats: 7 },
    ]);
  });
});

describe('guard rails', () => {
  it('without N1’s code: status unavailable, every flow refused, nothing derived', async () => {
    const w = await world({ core: null });
    expect(await w.svc.status()).toEqual({
      state: 'unavailable',
      reissuePending: false,
      relayCopy: false,
    });
    for (const f of [() => w.svc.setup(), () => w.svc.show(), () => w.svc.restore()])
      await expect(f()).rejects.toMatchObject({ code: 'payments-unavailable' });
    expect(await w.svc.seedFor(w.signer, w.pubkey)).toBeUndefined();
  });

  it('dismissed windows are throttled like connect; one flow at a time', async () => {
    const w = await world();
    w.answer = () => null;
    for (let i = 0; i < CANCEL_LIMIT; i++)
      await expect(w.svc.setup()).rejects.toMatchObject({ code: 'cancelled' });
    await expect(w.svc.setup()).rejects.toMatchObject({ code: 'rate-limited' });
    await expect(w.svc.restore()).rejects.toMatchObject({ code: 'rate-limited' });
    w.clock += 61_000;
    let release: (a: PromptAnswer | null) => void = () => undefined;
    w.answer = () =>
      new Promise<PromptAnswer | null>((res) => {
        release = res;
      });
    w.asked.length = 0;
    const first = w.svc.setup();
    await vi.waitFor(() => {
      expect(w.asked.map((f) => f.kind)).toEqual(['recovery-show']);
    });
    await expect(w.svc.show()).rejects.toMatchObject({ code: 'rate-limited' });
    await expect(w.svc.restore()).rejects.toMatchObject({ code: 'rate-limited' });
    release(null);
    await expect(first).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('a core error whose message carries words is `internal` to the renderer and only its code is logged', async () => {
    const w = await world();
    const words = wordsOf(w.core.phrases.toIndices(ENTROPY_1 as walletMod.RecoveryEntropy)).join(
      ' ',
    );
    w.core.phrases.generate = () => {
      throw new Error(`invalid-argument: ${words}`);
    };
    const err = await w.svc.setup().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'internal' });
    expect((err as Error).message).not.toContain(words.split(' ')[0] ?? '');
    expect(w.log.lines.map((l) => JSON.stringify(l)).join('\n')).not.toContain(words);
    expectNoPhrase(w, [(err as Error).message]);
  });

  it('reasonOf passes only allow-listed codes and error names', () => {
    expect(reasonOf(new Error('counters-unreadable: damaged'))).toBe('counters-unreadable');
    expect(reasonOf(new Error('abandon: ability able about'))).toBe('error');
    expect(reasonOf(Object.assign(new Error('x'), { name: 'RecoveryPhraseError' }))).toBe(
      'RecoveryPhraseError',
    );
    expect(reasonOf(Object.assign(new Error('x'), { name: 'abandon ability' }))).toBe('error');
    expect(reasonOf('zoo: zoo')).toBe('error');
  });

  it('a reissue plan for another mint, or one whose fee eats the amount, is never asked', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    w.balances.set(MINT_A, 3);
    w.core.wallet.balances.set(MINT_A, 3);
    w.core.wallet.plans.set(MINT_A, { inputs: 3, feeSats: 3 });
    const r = await w.svc.setup();
    expect(w.confirms).toEqual([]);
    // W8a (orchestrator decision, final cross-lane review [low] service.ts:456) made these `true`
    // and `1`: dust kept the backup pending so that a replaced phrase's relay copy was not retired
    // while the 3 sats stayed restorable only by the old phrase. Fix round 8, F56 (the round-8
    // verifier): that kept the backup pending for good — and "Replace phrase" gone with it — while
    // any dust sat at a mint with input fees, so exposed words could never be rotated away. The
    // two are split now: dust counts as done for the backup (never asked, never recorded), and it
    // keeps a replaced phrase's relay copy instead ("fix round 8: F56" below tests that half).
    expect(r.status.reissuePending).toBe(false);
    expect(r.reissueFailed).toBe(0);
    expect(await readEnvelope(recoveryPath(w.dir, w.pubkey))).toMatchObject({
      reissued: true,
      reissuedMints: [],
    });
    expect(w.core.wallet.reissued).toEqual([]);
  });
});

/**
 * The independent review of this lane (2026-09-27, docs/archive/reviews/2026-09-26-pre-push-nut13-desktop.md
 * § Independent review): each test failed before its fix.
 */
describe('independent review fixes', () => {
  it('IR1: a plan main’s dialog cannot show (an http dev mint, too many inputs) is left out and counted; the other mints are still asked and reissued', async () => {
    const w = await world();
    const HTTP = 'http://127.0.0.1:3399' as MintUrl;
    w.core.phrases.queue.push(ENTROPY_1);
    for (const [mint, amount] of [
      [MINT_A, 1_000],
      [HTTP, 500],
      [MINT_B, 700],
    ] as const) {
      w.balances.set(mint, amount);
      w.core.wallet.balances.set(mint, amount);
    }
    w.core.wallet.plans.set(MINT_A, { inputs: 4, feeSats: 2 });
    w.core.wallet.plans.set(HTTP, { inputs: 2, feeSats: 1 });
    w.core.wallet.plans.set(MINT_B, { inputs: 100_001, feeSats: 3 });
    userWhoWritesItDown(w);
    w.confirm = () => true;
    const r = await w.svc.setup();
    expect(w.confirms).toEqual([
      { kind: 'recovery-reissue', plans: [{ mint: MINT_A, amount: 1_000, inputs: 4, feeSats: 2 }] },
    ]);
    expect(w.core.wallet.reissued.map((p) => p.mint)).toEqual([MINT_A]);
    expect(r).toMatchObject({ reissuedSats: 998, feeSats: 2, reissueFailed: 2 });
    // The two left out are still uncovered: the reissue is not recorded as complete.
    expect(r.status.reissuePending).toBe(true);
    expect(
      w.log.lines.filter((l) => l.msg.startsWith('a reissue plan main’s dialog')),
    ).toHaveLength(2);
    expect(w.log.lines.some((l) => l.msg.includes('did not pass the IPC guard'))).toBe(false);
    expect(w.log.lines.some((l) => l.msg.includes('not confirmed by the user'))).toBe(false);
    expectNoPhrase(w, [r]);
  });

  it('IR2: a declined fee dialog counts as a dismissal — the renderer cannot reopen it again and again', async () => {
    const w = await world();
    w.balances.set(MINT_A, 500);
    w.core.wallet.balances.set(MINT_A, 500);
    w.core.wallet.plans.set(MINT_A, { inputs: 2, feeSats: 1 });
    userWhoWritesItDown(w, { later: true });
    w.confirm = () => false;
    for (let i = 0; i < CANCEL_LIMIT; i++) {
      const r = await w.svc.setup();
      expect(r.status.reissuePending).toBe(true);
    }
    expect(w.confirms).toHaveLength(CANCEL_LIMIT);
    await expect(w.svc.setup()).rejects.toMatchObject({ code: 'rate-limited' });
    await expect(w.svc.show()).rejects.toMatchObject({ code: 'rate-limited' });
    expect(w.confirms).toHaveLength(CANCEL_LIMIT);
    w.clock += 61_000;
    w.confirm = () => true;
    const r = await w.svc.setup();
    expect(r.status.reissuePending).toBe(false);
    expect(w.core.wallet.reissued.map((p) => p.mint)).toEqual([MINT_A]);
  });

  it('IR5: a finished phrase that did not open (sealed to another key) is never rotated away — forbidden, nothing asked, the file untouched', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    const path = recoveryPath(w.dir, w.pubkey);
    const env = await readEnvelope(path);
    expect(env?.reissued).toBe(true);
    const { signer: other } = await signerMod.LocalSigner.create({
      passphrase: enc('another passphrase!'),
      cost: signerMod.minimumCost(),
    });
    const foreign = JSON.stringify({
      ...env,
      sealed: await other.nip44Encrypt(
        await other.getPublicKey(),
        JSON.stringify({ v: 1, entropy: entropyHex(ENTROPY_3), created: 1 }),
      ),
    });
    await writeFile(path, foreign, { mode: 0o600 });
    await w.openPlane(); // the envelope parses, the seal does not open: `unreadable`
    expect((await w.svc.status()).state).toBe('unreadable');
    w.asked.length = 0;
    await expect(w.svc.setup()).rejects.toMatchObject({ code: 'forbidden' });
    expect(w.asked).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe(foreign);
    expect((await readdir(w.dir)).some((n) => n.endsWith('.retired'))).toBe(false);
  });

  it('IR7: a relay copy whose retirement did not land stays recorded, and the next setup retries it before asking anything', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    const path = recoveryPath(w.dir, w.pubkey);
    const first = await readEnvelope(path);
    // The relays take the new copy but refuse the old one's blank and its deletion.
    let refuseRetire = true;
    const publish = w.pool.publish.bind(w.pool);
    (w.pool as unknown as { publish: nostr.PoolLike['publish'] }).publish = (relays, ev) =>
      refuseRetire && (ev.kind === 5 || ev.content === '')
        ? Promise.resolve(relays.map((url) => ({ url, ok: false, reason: 'blocked' })))
        : publish(relays, ev);
    await w.svc.setup(); // rotation
    const second = await readEnvelope(path);
    expect(second).toMatchObject({ reissued: true, replaces: first?.device });
    expect(w.log.lines.some((l) => l.msg.includes('may still be on a relay'))).toBe(true);

    refuseRetire = false;
    const before = w.pool.published.length;
    w.asked.length = 0;
    w.answer = () => null; // the user then closes the passphrase window
    await expect(w.svc.setup()).rejects.toMatchObject({ code: 'cancelled' });
    expect(w.asked.map((f) => f.kind)).toEqual(['recovery-reauth']);
    const d = `${walletMod.RECOVERY_D_PREFIX}${first?.device ?? ''}`;
    const retired = w.pool.published.slice(before);
    expect(
      retired.some(
        (p) =>
          p.event.kind === walletMod.RECOVERY_RELAY_KIND &&
          p.event.content === '' &&
          p.event.tags[0]?.[1] === d,
      ),
    ).toBe(true);
    expect(retired.some((p) => p.event.kind === 5)).toBe(true);
    expect(await readEnvelope(path)).toMatchObject({
      device: second?.device,
      reissued: true,
      replaces: null,
    });
  });

  it('IR8: a remote signer’s rotation is confirmed with its own native question, not “show your phrase”', async () => {
    const w = await world({ kind: 'nip46' });
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    const before = await readFile(recoveryPath(w.dir, w.pubkey), 'utf8');
    w.confirms.length = 0;
    w.asked.length = 0;
    w.confirm = (f) => f.kind !== 'recovery-rotate';
    await expect(w.svc.setup()).rejects.toMatchObject({ code: 'cancelled' });
    expect(w.confirms).toEqual([{ kind: 'recovery-rotate' }]);
    expect(w.asked).toEqual([]);
    expect(await readFile(recoveryPath(w.dir, w.pubkey), 'utf8')).toBe(before);
    w.confirm = () => true;
    w.confirms.length = 0;
    await w.svc.setup();
    expect(w.confirms[0]).toEqual({ kind: 'recovery-rotate' });
    expect(w.asked[0]?.kind).toBe('recovery-show');
    // Show again keeps the reveal question.
    w.confirms.length = 0;
    await w.svc.show();
    expect(w.confirms).toEqual([{ kind: 'recovery-reveal' }]);
  });

  it('IR4: mint addresses typed in the restore window are scanned too (ADR 0016 §5.1) — normalised, https only, once each', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_1);
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    const TYPED = 'https://other-wallet-mint.recovery.test' as MintUrl;
    w.answer = (f) =>
      f.kind === 'recovery-restore'
        ? {
            kind: 'recovery-restore',
            words: [],
            mints: [
              TYPED,
              MINT_A,
              'HTTPS://Other-Wallet-Mint.recovery.test' as MintUrl,
              // Not an https mint URL: main's guard refuses it; the host drops it too.
              'http://plain.recovery.test' as MintUrl,
            ],
          }
        : null;
    w.core.wallet.restores.set(entropyHex(ENTROPY_1), {
      [TYPED]: { outcome: 'restored', restoredSats: 5 },
    });
    const r = await w.svc.restore();
    expect(w.core.wallet.restoreCalls[0]?.mints).toEqual([MINT_A, MINT_B, TYPED]);
    expect(r.reports).toEqual([
      { mint: MINT_A, outcome: 'nothing', restoredSats: 0 },
      { mint: MINT_B, outcome: 'nothing', restoredSats: 0 },
      { mint: TYPED, outcome: 'restored', restoredSats: 5 },
    ]);
    expect(w.log.lines.find((l) => l.msg === 'restoring from recovery phrases')).toMatchObject({
      mints: 3,
      // Distinct https mints typed: TYPED and MINT_A (the http one dropped, the case twin merged).
      typedMints: 2,
    });
    expectNoPhrase(w, [r]);
  });
});

/**
 * Fix round 7 (the lane verifier's finding on the IR1 fix): a reissue that did not finish is
 * retried by "Finish backup", and that retry must plan ONLY the mints not yet reissued under the
 * phrase — the envelope records each mint as it moves — so a mint that can never be asked (an
 * http dev mint) or one that failed this time never makes the covered mints move, and pay their
 * fee, again.
 */
describe('fix round 7: a retry never moves a covered mint again', () => {
  const HTTP = 'http://127.0.0.1:3399' as MintUrl;
  const fund = (w: World, mint: MintUrl, amount: number, feeSats: number): void => {
    w.balances.set(mint, amount);
    w.core.wallet.balances.set(mint, amount);
    w.core.wallet.plans.set(mint, { inputs: 2, feeSats });
  };

  it('an http plan the dialog cannot show: "Finish backup" again and again asks nothing and moves nothing; the record is the envelope on disk', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_1);
    fund(w, MINT_A, 1_000, 2);
    fund(w, HTTP, 500, 1);
    userWhoWritesItDown(w);
    w.confirm = () => true;
    const path = recoveryPath(w.dir, w.pubkey);

    const r1 = await w.svc.setup();
    expect(r1).toMatchObject({ reissuedSats: 998, feeSats: 2, reissueFailed: 1 });
    expect(await readEnvelope(path)).toMatchObject({ reissued: false, reissuedMints: [MINT_A] });

    // The verifier's probe ran setup three times: mint-a was swapped (and charged) each time.
    w.asked.length = 0;
    const r2 = await w.svc.setup();
    const r3 = await w.svc.setup();
    for (const r of [r2, r3])
      expect(r).toEqual({
        status: { state: 'covered', reissuePending: true, relayCopy: true },
        reissuedSats: 0,
        feeSats: 0,
        reissueFailed: 1,
      });
    expect(w.asked).toEqual([]);
    expect(w.confirms).toEqual([
      { kind: 'recovery-reissue', plans: [{ mint: MINT_A, amount: 1_000, inputs: 2, feeSats: 2 }] },
    ]);
    expect(w.core.wallet.reissued.map((p) => p.mint)).toEqual([MINT_A]);
    // mint-a is not even planned again (no mint round trip for it); the http one is, each time.
    expect(w.core.wallet.planned).toEqual([MINT_A, HTTP, HTTP, HTTP]);
    expect(await readEnvelope(path)).toMatchObject({ reissued: false, reissuedMints: [MINT_A] });

    // The envelope on disk is the record (it survives a restart): without the entry, mint-a is
    // planned and asked again.
    const env = await readEnvelope(path);
    if (env === null) throw new Error('no envelope');
    await writeEnvelope(w.dir, path, { ...env, reissuedMints: [] });
    await w.svc.setup();
    expect(w.confirms).toHaveLength(2);
    expect(w.core.wallet.planned.slice(4)).toEqual([MINT_A, HTTP]);
    expectNoPhrase(w, [r1, r2, r3]);
  });

  it('a mint whose reissue failed is retried alone: the one that moved is neither asked nor charged again', async () => {
    const w = await world();
    fund(w, MINT_A, 1_000, 2);
    fund(w, MINT_B, 700, 1);
    w.core.wallet.failReissue.add(MINT_B);
    userWhoWritesItDown(w);
    w.confirm = () => true;
    const r1 = await w.svc.setup();
    expect(r1).toMatchObject({ reissuedSats: 998, feeSats: 2, reissueFailed: 1 });
    expect(r1.status.reissuePending).toBe(true);

    w.core.wallet.failReissue.clear();
    const r2 = await w.svc.setup();
    expect(w.confirms[1]).toEqual({
      kind: 'recovery-reissue',
      plans: [{ mint: MINT_B, amount: 700, inputs: 2, feeSats: 1 }],
    });
    expect(w.core.wallet.reissued.map((p) => p.mint)).toEqual([MINT_A, MINT_B]);
    expect(r2).toMatchObject({ reissuedSats: 699, feeSats: 1, reissueFailed: 0 });
    expect(r2.status.reissuePending).toBe(false);
    expect(await readEnvelope(recoveryPath(w.dir, w.pubkey))).toMatchObject({
      reissued: true,
      reissuedMints: [MINT_A, MINT_B],
    });
    expectNoPhrase(w, [r1, r2]);
  });

  it(`more than ${String(MAX_REISSUE_PLANS)} mints: the next "Finish backup" asks only the rest, never the first ${String(MAX_REISSUE_PLANS)} again`, async () => {
    const w = await world();
    const mints = Array.from(
      { length: MAX_REISSUE_PLANS + 1 },
      (_, i) => `https://m${String(i)}.recovery.test` as MintUrl,
    );
    for (const m of mints) fund(w, m, 100, 1);
    userWhoWritesItDown(w);
    w.confirm = () => true;
    const r1 = await w.svc.setup();
    expect(r1.reissueFailed).toBe(1);
    expect(r1.status.reissuePending).toBe(true);
    const r2 = await w.svc.setup();
    const second = w.confirms[1];
    expect(second?.kind === 'recovery-reissue' && second.plans.map((p) => p.mint)).toEqual([
      mints[MAX_REISSUE_PLANS],
    ]);
    expect(r2).toMatchObject({ reissuedSats: 99, feeSats: 1, reissueFailed: 0 });
    expect(r2.status.reissuePending).toBe(false);
    expect(w.core.wallet.reissued.map((p) => p.mint)).toEqual(mints);
  });

  it(`never asks more mints than the envelope can record (${String(MAX_REISSUED_MINTS)}): a mint moved but not recorded would be moved again`, async () => {
    const w = await world();
    fund(w, MINT_A, 100, 1);
    fund(w, MINT_B, 200, 1);
    userWhoWritesItDown(w);
    w.confirm = () => false; // the first dialog declined: the reissue stays pending
    await w.svc.setup();
    const path = recoveryPath(w.dir, w.pubkey);
    const env = await readEnvelope(path);
    if (env === null) throw new Error('no envelope');
    // Room for one more mint.
    const others = Array.from(
      { length: MAX_REISSUED_MINTS - 1 },
      (_, i) => `https://done${String(i)}.recovery.test` as MintUrl,
    );
    await writeEnvelope(w.dir, path, { ...env, reissuedMints: others });
    w.confirm = () => true;
    const r = await w.svc.setup();
    expect(w.confirms[1]).toEqual({
      kind: 'recovery-reissue',
      plans: [{ mint: MINT_A, amount: 100, inputs: 2, feeSats: 1 }],
    });
    expect(r).toMatchObject({ reissuedSats: 99, reissueFailed: 1 });
    expect((await readEnvelope(path))?.reissuedMints).toEqual([...others, MINT_A]);
    expect(w.log.lines.some((l) => l.msg.includes('could not be recorded'))).toBe(false);
    // Full now: nothing more is asked, nothing moves.
    await w.svc.setup();
    expect(w.confirms).toHaveLength(2);
    expect(w.core.wallet.reissued.map((p) => p.mint)).toEqual([MINT_A]);
  });

  it('a rotation starts a new record: every mint is moved again, under the NEW phrase', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_1, ENTROPY_2);
    fund(w, MINT_A, 100, 1);
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    const path = recoveryPath(w.dir, w.pubkey);
    const first = await readEnvelope(path);
    expect(first).toMatchObject({ reissued: true, reissuedMints: [MINT_A] });
    const r = await w.svc.setup(); // rotation
    const second = await readEnvelope(path);
    expect(second?.device).not.toBe(first?.device);
    expect(second).toMatchObject({ reissued: true, reissuedMints: [MINT_A] });
    expect(w.confirms.filter((f) => f.kind === 'recovery-reissue')).toHaveLength(2);
    expect(w.core.wallet.reissued.map((p) => p.mint)).toEqual([MINT_A, MINT_A]);
    expect(r.status).toEqual({ state: 'covered', reissuePending: false, relayCopy: true });
    expectNoPhrase(w, [r]);
  });
});

/**
 * Lane W8a (final cross-lane review, money plane / NUT-13): each test failed before its fix.
 */
describe('W8a: restore follows core’s resume', () => {
  const K = `00${'ab'.repeat(7)}`;
  const noWords = (w: World): void => {
    w.answer = (f) =>
      f.kind === 'recovery-restore' ? { kind: 'recovery-restore', words: [] } : null;
  };
  async function covered(): Promise<World> {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_1);
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    noWords(w);
    return w;
  }
  const callsOf = (w: World) =>
    w.core.wallet.restoreCalls
      .filter((c) => c.entropyHex === entropyHex(ENTROPY_1))
      .map((c) => ({ mints: c.mints, resume: c.resume }));

  it('a scan the batch cap stopped is continued from where it stopped until it is complete: the sats of every call add up, and it never reads “refused”', async () => {
    const w = await covered();
    w.core.wallet.steps.set(entropyHex(ENTROPY_1), {
      [MINT_A]: [
        { outcome: 'refused', restoredSats: 0, resume: { [K]: 20_000 } },
        { outcome: 'restored', restoredSats: 30, resume: { [K]: 40_000 } },
        { outcome: 'nothing', restoredSats: 0 },
      ],
    });
    w.progress.length = 0;
    const r = await w.svc.restore();
    expect(r.reports).toEqual([
      { mint: MINT_A, outcome: 'restored', restoredSats: 30 },
      { mint: MINT_B, outcome: 'nothing', restoredSats: 0 },
    ]);
    expect(callsOf(w)).toEqual([
      { mints: [MINT_A, MINT_B], resume: undefined },
      { mints: [MINT_A], resume: { [MINT_A]: { [K]: 20_000 } } },
      { mints: [MINT_A], resume: { [MINT_A]: { [K]: 40_000 } } },
    ]);
    expect(w.progress.filter((p) => p.mint === MINT_A).length).toBeGreaterThan(2);
    // Complete: the next restore starts that mint from the start again.
    w.core.wallet.restoreCalls.length = 0;
    await w.svc.restore();
    expect(callsOf(w)).toEqual([{ mints: [MINT_A, MINT_B], resume: undefined }]);
    expectNoPhrase(w, [r]);
  });

  it(`bounded per restore (${String(RESTORE_ROUNDS)} calls a mint): still unfinished, the mint reads "could not be reached" — not "refused" — and the next restore continues from the kept cursor`, async () => {
    const w = await covered();
    const steps = Array.from({ length: RESTORE_ROUNDS + 5 }, (_, i) => ({
      outcome: 'refused' as const,
      restoredSats: 0,
      resume: { [K]: 20_000 * (i + 1) },
    }));
    w.core.wallet.steps.set(entropyHex(ENTROPY_1), { [MINT_A]: steps });
    const r = await w.svc.restore();
    expect(r.reports[0]).toEqual({ mint: MINT_A, outcome: 'unreachable', restoredSats: 0 });
    const calls = callsOf(w);
    expect(calls).toHaveLength(RESTORE_ROUNDS);
    expect(w.log.lines.some((l) => l.msg.includes('not finished'))).toBe(true);
    w.core.wallet.restoreCalls.length = 0;
    await w.svc.restore();
    // It goes on from the cursor the last call returned (never from 0 again).
    expect(callsOf(w)[0]).toEqual({
      mints: [MINT_A, MINT_B],
      resume: { [MINT_A]: { [K]: 20_000 * RESTORE_ROUNDS } },
    });
  });

  it('a call that does not move the scan on (a batch that cannot be asked) stops it for now; the cursor is kept', async () => {
    const w = await covered();
    w.core.wallet.steps.set(entropyHex(ENTROPY_1), {
      [MINT_A]: [
        { outcome: 'refused', restoredSats: 0, resume: { [K]: 20_000 } },
        { outcome: 'unreachable', restoredSats: 0, resume: { [K]: 20_000 } },
      ],
    });
    const r = await w.svc.restore();
    expect(callsOf(w)).toHaveLength(2);
    expect(r.reports[0]).toEqual({ mint: MINT_A, outcome: 'unreachable', restoredSats: 0 });
    w.core.wallet.restoreCalls.length = 0;
    await w.svc.restore();
    expect(callsOf(w)[0]?.resume).toEqual({ [MINT_A]: { [K]: 20_000 } });
  });

  it('info (b): the typed all-zero phrase (“abandon … about”) is refused by name — nothing scanned, no row “could not be reached”', async () => {
    const w = await covered();
    const zero = w.core.phrases.toIndices(new Uint8Array(16) as walletMod.RecoveryEntropy);
    w.answer = (f) =>
      f.kind === 'recovery-restore' ? { kind: 'recovery-restore', words: [...zero] } : null;
    const err = await w.svc.restore().catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('public example phrase'),
    });
    expect(w.core.wallet.restoreCalls).toEqual([]);
  });
});

describe('W8a: a reissue is complete only when nothing is left outside the phrase', () => {
  // Fix round 8, F55: the title said "its spendable balance moves" — nothing moves at a mint while
  // an operation is journaled there now (see the comment at the rotation below).
  it('an operation still journaled at a mint: nothing moves there, the mint is not recorded, the backup stays pending and the replaced relay copy stays — until a later "Finish backup" finds it clean and moves it once', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_1, ENTROPY_2);
    userWhoWritesItDown(w);
    w.confirm = () => true;
    w.balances.set(MINT_A, 100);
    w.core.wallet.balances.set(MINT_A, 100);
    w.core.wallet.plans.set(MINT_A, { inputs: 3, feeSats: 1 });
    await w.svc.setup(); // ENTROPY_1, complete
    const path = recoveryPath(w.dir, w.pubkey);
    const first = await readEnvelope(path);
    expect(first).toMatchObject({ reissued: true, replaces: null });
    // A melt is pending at mint A (a slow Lightning payment) when the user rotates.
    w.pending.set(MINT_A, 1);
    const blanks = (): number =>
      w.pool.published.filter(
        (p) => p.event.kind === walletMod.RECOVERY_RELAY_KIND && p.event.content === '',
      ).length;
    const r = await w.svc.setup(); // rotation → ENTROPY_2
    // Fix round 8, F55 (the round-8 verifier): this pinned `99` — the spendable balance moved
    // while the melt was pending and, the mint not recorded, every later "Finish backup" planned
    // every proof there (the seeded ones included) and swapped it, and charged its fee, again.
    // Nothing moves at a mint while an operation is journaled there: no dialog, no fee.
    expect(r.reissuedSats).toBe(0);
    expect(r.feeSats).toBe(0);
    expect(r.reissueFailed).toBe(1);
    expect(r.status.reissuePending).toBe(true);
    expect(w.core.wallet.reissued.map((p) => p.mint)).toEqual([MINT_A]); // ENTROPY_1's only
    expect(w.confirms.filter((f) => f.kind === 'recovery-reissue')).toHaveLength(1);
    const second = await readEnvelope(path);
    expect(second).toMatchObject({ reissued: false, reissuedMints: [], replaces: first?.device });
    expect(blanks()).toBe(0); // ENTROPY_1's copy stays: it still restores what the melt holds
    // The melt failed and its inputs came back: "Finish backup" moves them, and only then does the
    // replaced copy go.
    w.pending.delete(MINT_A);
    const again = await w.svc.setup();
    expect(again).toMatchObject({ reissuedSats: 99, feeSats: 1, reissueFailed: 0 });
    expect(again.status.reissuePending).toBe(false);
    expect(w.core.wallet.reissued.map((p) => p.mint)).toEqual([MINT_A, MINT_A]);
    expect(await readEnvelope(path)).toMatchObject({
      reissued: true,
      reissuedMints: [MINT_A],
      replaces: null,
    });
    expect(blanks()).toBe(1);
  });

  // Fix round 8, F56 (the round-8 verifier): this was "… blocks it too", pinning
  // `reissuePending: true` and `reissueFailed: 1` — an entry at a mint with nothing spendable (a
  // dead mint holding a melt never settles) kept the backup pending for good, and "Replace phrase"
  // with it. Nothing there can move: the backup is finished; what the entry may give back keeps a
  // replaced relay copy instead, until it settles.
  // Fix round 9: this fake scripts no plan at mint A, so its `reissuePlan` throws — the mint cannot
  // be asked, the "dead mint" of the comment above — and that is what still counts it done here
  // (and watched: `watchedMints`, dropped by the retry below once the entry cleared). At a mint
  // that answers, a young entry keeps the reissue pending ("F56, round 9" and "fix round 9" below).
  it('a mint whose whole balance is held (nothing spendable) does not keep the backup pending — it keeps a replaced relay copy until the entry settles', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_1, ENTROPY_2);
    userWhoWritesItDown(w);
    w.confirm = () => true;
    w.balances.set(MINT_A, 0);
    w.pending.set(MINT_A, 2);
    const r = await w.svc.setup();
    expect(w.confirms).toEqual([]);
    expect(r.status.reissuePending).toBe(false);
    expect(r.reissueFailed).toBe(0);
    const path = recoveryPath(w.dir, w.pubkey);
    const first = await readEnvelope(path);
    expect(first).toMatchObject({ reissued: true, reissuedMints: [] });
    // "Replace phrase" works while the entry is there, and the replaced copy stays...
    const rotated = await w.svc.setup();
    const second = await readEnvelope(path);
    expect(second?.device).not.toBe(first?.device);
    expect(rotated.status.reissuePending).toBe(false);
    expect(second).toMatchObject({ reissued: true, replaces: first?.device });
    expect(w.pool.published.some((p) => p.event.kind === 5)).toBe(false);
    expect(w.log.lines.some((l) => l.msg.includes('relay copy is kept'))).toBe(true);
    // ...until the relay copy retry finds the entry settled, and retires it.
    w.pending.clear();
    expect(w.timers.armed).toHaveLength(1);
    await w.timers.fire();
    await vi.waitFor(async () => {
      expect((await readEnvelope(path))?.replaces).toBeNull();
    });
    expect(w.pool.published.some((p) => p.event.kind === 5)).toBe(true);
    expect(w.timers.armed).toEqual([]);
    expectNoPhrase(w, [r, rotated]);
  });
});

/**
 * Fix round 8 (the round-8 verifier of W8a-money): F55, F56 and the info item. Written, NOT run
 * here (no test runner on this machine: they run in CI); each one's reasoning against the code
 * before its fix is in the review record's "Fix round 8" section.
 */
describe('fix round 8: F55, F56, the relay retry and the flows', () => {
  /** Mirrors what core's store holds after a reissue: the balance less the fee, seeded. */
  const mirrorReissue = (w: World): void => {
    const reissue = w.core.wallet.reissue.bind(w.core.wallet);
    w.core.wallet.reissue = async (p) => {
      const moved = await reissue(p);
      w.balances.set(p.mint, moved.reissued);
      w.core.wallet.balances.set(p.mint, moved.reissued);
      return moved;
    };
  };
  const blanks = (w: World): number =>
    w.pool.published.filter(
      (p) => p.event.kind === walletMod.RECOVERY_RELAY_KIND && p.event.content === '',
    ).length;

  it('F55: a mint an operation is journaled at is never moved while it is — "Finish backup" again and again asks nothing and charges nothing; once it settles the mint moves once and is recorded', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_1, ENTROPY_2);
    userWhoWritesItDown(w);
    w.confirm = () => true;
    w.balances.set(MINT_A, 100);
    w.core.wallet.balances.set(MINT_A, 100);
    w.core.wallet.plans.set(MINT_A, { inputs: 3, feeSats: 1 });
    mirrorReissue(w);
    await w.svc.setup(); // ENTROPY_1: 100 → 99 under it
    const path = recoveryPath(w.dir, w.pubkey);
    // A PAY whose answer was lost is journaled at mint A (up to 600 s) when the user rotates.
    w.pending.set(MINT_A, 1);
    const rotated = await w.svc.setup(); // → ENTROPY_2
    const presses = [await w.svc.setup(), await w.svc.setup()]; // "Finish backup", twice
    for (const r of [rotated, ...presses])
      expect(r).toMatchObject({
        status: { reissuePending: true },
        reissuedSats: 0,
        feeSats: 0,
        reissueFailed: 1,
      });
    // The verifier measured [100, fee 1], [99, fee 1], [98, fee 1] at mint A here: one per setup.
    expect(w.core.wallet.reissued).toEqual([{ mint: MINT_A, amount: 100, inputs: 3, feeSats: 1 }]);
    expect(w.confirms.filter((f) => f.kind === 'recovery-reissue')).toHaveLength(1);
    expect(await readEnvelope(path)).toMatchObject({ reissued: false, reissuedMints: [] });
    // Planned each time (the plan settles the journal first), asked never.
    expect(w.core.wallet.planned).toEqual([MINT_A, MINT_A, MINT_A, MINT_A]);
    // The PAY settled: the next press moves mint A once, under ENTROPY_2, and records it.
    w.pending.delete(MINT_A);
    const done = await w.svc.setup();
    expect(done).toMatchObject({
      status: { reissuePending: false },
      reissuedSats: 98,
      feeSats: 1,
      reissueFailed: 0,
    });
    expect(w.core.wallet.reissued.map((p) => [p.amount, p.feeSats])).toEqual([
      [100, 1],
      [99, 1],
    ]);
    expect(await readEnvelope(path)).toMatchObject({
      reissued: true,
      reissuedMints: [MINT_A],
      replaces: null,
    });
    expect(blanks(w)).toBe(1);
    expectNoPhrase(w, [rotated, ...presses, done]);
  });

  it('F55: a moved mint is recorded at once — an entry begun during the move, on the seeded wallet, does not leave it unrecorded, to be moved and charged again', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    w.balances.set(MINT_A, 100);
    w.core.wallet.balances.set(MINT_A, 100);
    w.core.wallet.plans.set(MINT_A, { inputs: 3, feeSats: 1 });
    // A receive at mint A is journaled while the reissue runs (after the plan was taken clean):
    // its outputs derive from the phrase the wallet is seeded with — this one.
    const reissue = w.core.wallet.reissue.bind(w.core.wallet);
    w.core.wallet.reissue = async (p) => {
      const moved = await reissue(p);
      w.pending.set(p.mint, 1);
      return moved;
    };
    const r = await w.svc.setup();
    expect(r).toMatchObject({
      status: { reissuePending: false },
      reissuedSats: 99,
      feeSats: 1,
      reissueFailed: 0,
    });
    expect(await readEnvelope(recoveryPath(w.dir, w.pubkey))).toMatchObject({
      reissued: true,
      reissuedMints: [MINT_A],
    });
    expect(w.core.wallet.reissued.map((p) => p.mint)).toEqual([MINT_A]);
    expectNoPhrase(w, [r]);
  });

  // Fix round 9 (the static reviewer of the F55/F56 fix, [medium] service.ts:717): this was "F56:
  // dust with an operation journaled at the same mint is still done — nothing there is worth
  // moving", pinning `reissuePending: false` and `reissueFailed: 0` with the entry young. Its
  // premise is false when the entry holds the balance: a PENDING melt's inputs, or a lost send's,
  // come back to THIS mint under the phrase they were made under, and a mint counted done was never
  // looked at again — so what came back stayed under the replaced, possibly leaked, phrase for good.
  // A young entry at a mint that answers keeps the reissue pending again, as before F56; once every
  // entry there is overdue the mint counts done but is watched (the reopen: "fix round 9" below).
  it('F56, round 9: dust with a YOUNG operation journaled at the same mint keeps the reissue pending; once the entry is overdue the mint is done, but watched', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    w.balances.set(MINT_A, 3);
    w.core.wallet.balances.set(MINT_A, 3);
    w.core.wallet.plans.set(MINT_A, { inputs: 3, feeSats: 3 });
    w.pending.set(MINT_A, 1);
    const r = await w.svc.setup();
    expect(w.confirms).toEqual([]);
    expect(r).toMatchObject({ status: { reissuePending: true }, reissueFailed: 1 });
    const path = recoveryPath(w.dir, w.pubkey);
    expect(await readEnvelope(path)).toMatchObject({ reissued: false, reissuedMints: [] });
    // Ten minutes on the mint still reports the melt PENDING: the entry is overdue. "Finish backup":
    w.overdue.set(MINT_A, 1);
    const r2 = await w.svc.setup();
    expect(w.confirms).toEqual([]);
    expect(r2).toMatchObject({ status: { reissuePending: false }, reissueFailed: 0 });
    expect(await readEnvelope(path)).toMatchObject({
      reissued: true,
      reissuedMints: [],
      watchedMints: [MINT_A],
    });
    expect(w.core.wallet.reissued).toEqual([]);
    expectNoPhrase(w, [r, r2]);
  });

  it('F56: dust counts as done — the backup is finished and "Replace phrase" rotates — but the replaced relay copy stays until the dust is spent', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_1, ENTROPY_2);
    userWhoWritesItDown(w);
    w.confirm = () => true;
    // 3 sats at a mint whose input fee eats them all.
    w.balances.set(MINT_A, 3);
    w.core.wallet.balances.set(MINT_A, 3);
    w.core.wallet.plans.set(MINT_A, { inputs: 3, feeSats: 3 });
    const r1 = await w.svc.setup();
    expect(r1).toMatchObject({
      status: { reissuePending: false },
      reissuedSats: 0,
      feeSats: 0,
      reissueFailed: 0,
    });
    const path = recoveryPath(w.dir, w.pubkey);
    const first = await readEnvelope(path);
    expect(first).toMatchObject({ reissued: true, reissuedMints: [] });
    // The verifier's probe: more setups with a second phrase queued left the device, the one
    // `recovery-show` and `reissued: false` unchanged. The next setup is a rotation now.
    w.asked.length = 0;
    const r2 = await w.svc.setup();
    expect(w.asked.map((f) => f.kind)).toEqual([
      'recovery-reauth',
      'recovery-show',
      'recovery-confirm',
    ]);
    const second = await readEnvelope(path);
    expect(second?.device).not.toBe(first?.device);
    const seed = w.core.materials.at(-1)?.seed as unknown as { entropyHex: string };
    expect(seed.entropyHex).toBe(entropyHex(ENTROPY_2));
    expect(r2).toMatchObject({
      status: { reissuePending: false },
      reissuedSats: 0,
      reissueFailed: 0,
    });
    expect(w.confirms).toEqual([]);
    expect(w.core.wallet.reissued).toEqual([]);
    // The dust is restorable only by the replaced phrase: its relay copy stays...
    expect(second).toMatchObject({ reissued: true, replaces: first?.device });
    expect(blanks(w)).toBe(0);
    // ...through a retry while the dust is there...
    expect(w.timers.armed).toHaveLength(1);
    await w.timers.fire();
    expect((await readEnvelope(path))?.replaces).toBe(first?.device);
    expect(blanks(w)).toBe(0);
    // ...and goes at the first retry after the dust was spent.
    w.balances.set(MINT_A, 0);
    w.core.wallet.balances.set(MINT_A, 0);
    expect(w.timers.armed).toHaveLength(1);
    await w.timers.fire();
    await vi.waitFor(async () => {
      expect((await readEnvelope(path))?.replaces).toBeNull();
    });
    expect(blanks(w)).toBe(1);
    expect(w.timers.armed).toEqual([]);
    expectNoPhrase(w, [r1, r2]);
  });

  it('F56: a replaced copy kept for dust is not retired by the next setup either, while the dust is there', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_1, ENTROPY_2);
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup(); // ENTROPY_1, nothing held
    w.balances.set(MINT_B, 2);
    w.core.wallet.balances.set(MINT_B, 2);
    w.core.wallet.plans.set(MINT_B, { inputs: 2, feeSats: 2 });
    await w.svc.setup(); // rotation → ENTROPY_2; the 2 sats at mint B stay under ENTROPY_1
    const path = recoveryPath(w.dir, w.pubkey);
    const second = await readEnvelope(path);
    expect(second?.replaces).not.toBeNull();
    // The next setup retries the retirement first (IR7) — and keeps the copy: the dust is there.
    w.asked.length = 0;
    w.answer = () => null; // then the user closes the passphrase window
    await expect(w.svc.setup()).rejects.toMatchObject({ code: 'cancelled' });
    expect(w.asked.map((f) => f.kind)).toEqual(['recovery-reauth']);
    expect(await readEnvelope(path)).toMatchObject({
      device: second?.device,
      replaces: second?.replaces,
    });
    expect(blanks(w)).toBe(0);
  });

  it('info: a Settings action pressed during a relay copy retry waits for it — never refused as if a phrase window were open', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    let refuse = true;
    let held = false;
    let land: () => void = () => undefined;
    const publish = w.pool.publish.bind(w.pool);
    (w.pool as unknown as { publish: nostr.PoolLike['publish'] }).publish = (relays, ev) => {
      if (ev.kind !== walletMod.RECOVERY_RELAY_KIND) return publish(relays, ev);
      if (refuse) return Promise.resolve(relays.map((url) => ({ url, ok: false, reason: 'down' })));
      // The retry's publish: held open, like a slow relay, until the test lets it land.
      held = true;
      return new Promise<Awaited<ReturnType<nostr.PoolLike['publish']>>>((res) => {
        land = () => {
          res(publish(relays, ev));
        };
      });
    };
    await w.svc.setup();
    const path = recoveryPath(w.dir, w.pubkey);
    expect((await readEnvelope(path))?.relayCopy).toBe(false);
    refuse = false;
    expect(w.timers.armed).toHaveLength(1);
    await w.timers.fire({ hangs: true }); // the retry starts; its publish hangs
    await vi.waitFor(() => {
      expect(held).toBe(true);
    });
    w.asked.length = 0;
    // The user presses "Show phrase" meanwhile (settled either way: nothing left unhandled).
    const shown = w.svc.show().then(
      () => 'shown',
      (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 30));
    // Waiting for the retry: nothing asked yet — and not refused `rate-limited`.
    expect(w.asked).toEqual([]);
    land();
    expect(await shown).toBe('shown');
    expect(w.asked.map((f) => f.kind)).toEqual(['recovery-reauth', 'recovery-show']);
    // The retry's write landed before the flow ran, and stands.
    expect((await readEnvelope(path))?.relayCopy).toBe(true);
    expect(w.timers.armed).toEqual([]);
    expectNoPhrase(w);
  });
});

/**
 * Fix round 9 (the static reviewer of the F55/F56 fix): a mint whose balance an operation holds is
 * never counted reissued for good — a young entry at a mint that answers blocks, an overdue one (or
 * a mint that cannot be asked, whatever it holds) counts done but WATCHED, and the backup reopens
 * once such a mint shows a spendable balance worth moving; a Settings action during a relay copy
 * retry stuck on a NIP-46 signer answers. Written, NOT run here (no test runner on this machine:
 * they run in CI); each one's reasoning against the code before its fix is in the review record's
 * "Round 9" section.
 */
describe('fix round 9: watched mints, the reopen, the bounded wait', () => {
  /** Mirrors what core's store holds after a reissue: the balance less the fee, seeded. */
  const mirrorReissue = (w: World): void => {
    const reissue = w.core.wallet.reissue.bind(w.core.wallet);
    w.core.wallet.reissue = async (p) => {
      const moved = await reissue(p);
      w.balances.set(p.mint, moved.reissued);
      w.core.wallet.balances.set(p.mint, moved.reissued);
      return moved;
    };
  };
  const blanks = (w: World): number =>
    w.pool.published.filter(
      (p) => p.event.kind === walletMod.RECOVERY_RELAY_KIND && p.event.content === '',
    ).length;
  const hold = (w: World, mint: MintUrl, sats: number): void => {
    w.balances.set(mint, sats);
    w.core.wallet.balances.set(mint, sats);
  };

  it('the reviewer’s scenario: a PENDING melt holds the only mint’s whole balance at "Replace phrase" — young, it blocks; overdue, the mint is done but watched ("Replace phrase" back); the melt fails, the inputs come back, the backup reopens and "Finish backup" moves them under the new phrase', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_1, ENTROPY_2);
    userWhoWritesItDown(w);
    w.confirm = () => true;
    // (1) 5 000 sats at mint A, reissued under the first phrase (A): 4 999 of them are A's now.
    hold(w, MINT_A, 5_000);
    w.core.wallet.plans.set(MINT_A, { inputs: 4, feeSats: 1 });
    mirrorReissue(w);
    await w.svc.setup();
    const path = recoveryPath(w.dir, w.pubkey);
    const first = await readEnvelope(path);
    expect(first).toMatchObject({ reissued: true, reissuedMints: [MINT_A], replaces: null });
    // (2) Everything withdrawn over Lightning: the melt stays PENDING at the mint, its inputs held.
    hold(w, MINT_A, 0);
    w.pending.set(MINT_A, 1);
    // (3) The words were photographed: "Replace phrase" (A → B). The melt is young, the mint
    // answers: the mint is not counted done — the reviewer's step (4) wrote `reissued: true` here.
    const rotated = await w.svc.setup();
    expect(rotated).toMatchObject({
      status: { reissuePending: true },
      reissuedSats: 0,
      feeSats: 0,
      reissueFailed: 1,
    });
    expect(await readEnvelope(path)).toMatchObject({
      reissued: false,
      reissuedMints: [],
      replaces: first?.device,
    });
    expect(blanks(w)).toBe(0); // A's copy stays
    // Ten minutes on, the mint still reports the melt PENDING (overdue): "Finish backup" counts the
    // mint done — "Replace phrase" is back — but watches it, and A's copy stays.
    w.overdue.set(MINT_A, 1);
    const pressed = await w.svc.setup();
    expect(pressed).toMatchObject({
      status: { reissuePending: false },
      reissuedSats: 0,
      feeSats: 0,
      reissueFailed: 0,
    });
    expect(await readEnvelope(path)).toMatchObject({
      reissued: true,
      reissuedMints: [],
      watchedMints: [MINT_A],
      replaces: first?.device,
    });
    expect(blanks(w)).toBe(0);
    // While the melt is still there a retry changes nothing and asks the mint nothing; the next
    // wait follows the backoff.
    const planned = w.core.wallet.planned.length;
    expect(w.timers.armed.map((t) => t.ms)).toEqual([RELAY_RETRY_FIRST_MS]);
    await w.timers.fire();
    expect(await readEnvelope(path)).toMatchObject({ reissued: true, watchedMints: [MINT_A] });
    expect(w.core.wallet.planned).toHaveLength(planned);
    expect(w.timers.armed.map((t) => t.ms)).toEqual([2 * RELAY_RETRY_FIRST_MS]);
    // (5) Hours later the melt comes back UNPAID: the settle returns the 4 999 sats of A-derived
    // proofs to spendable at mint A. The next retry plans them (worth moving) and reopens the backup.
    w.pending.clear();
    w.overdue.clear();
    hold(w, MINT_A, 4_999);
    await w.timers.fire();
    const reopened = await readEnvelope(path);
    expect(reopened).toMatchObject({
      reissued: false,
      reissuedMints: [],
      replaces: first?.device,
    });
    expect(reopened?.watchedMints).toBeUndefined();
    expect(await w.svc.status()).toMatchObject({ reissuePending: true }); // "Finish backup" again
    expect(blanks(w)).toBe(0);
    expect(w.timers.armed).toEqual([]);
    // "Finish backup" moves them under B, records the mint, and only then retires A's copy.
    const finished = await w.svc.setup();
    expect(finished).toMatchObject({
      status: { reissuePending: false },
      reissuedSats: 4_998,
      feeSats: 1,
      reissueFailed: 0,
    });
    const seed = w.core.materials.at(-1)?.seed as unknown as { entropyHex: string };
    expect(seed.entropyHex).toBe(entropyHex(ENTROPY_2));
    expect(w.core.wallet.reissued.map((p) => [p.amount, p.feeSats])).toEqual([
      [5_000, 1],
      [4_999, 1],
    ]);
    const done = await readEnvelope(path);
    expect(done).toMatchObject({ reissued: true, reissuedMints: [MINT_A], replaces: null });
    expect(done?.watchedMints).toBeUndefined();
    expect(blanks(w)).toBe(1);
    expectNoPhrase(w, [rotated, pressed, finished]);
  });

  it('an overdue entry at a mint with a balance worth moving: nothing moves there (F55), but it no longer keeps the backup pending for as long as the operation lasts — done but watched, counted as not covered; once the entry settled the backup reopens and "Finish backup" moves the mint once', async () => {
    const w = await world();
    w.core.phrases.queue.push(ENTROPY_1, ENTROPY_2);
    userWhoWritesItDown(w);
    w.confirm = () => true;
    hold(w, MINT_A, 100);
    w.core.wallet.plans.set(MINT_A, { inputs: 3, feeSats: 1 });
    mirrorReissue(w);
    await w.svc.setup(); // ENTROPY_1: 100 → 99 under it
    const path = recoveryPath(w.dir, w.pubkey);
    const first = await readEnvelope(path);
    // A melt whose HTLC is stuck — journaled at mint A for hours (overdue) — when the user rotates.
    w.pending.set(MINT_A, 1);
    w.overdue.set(MINT_A, 1);
    const rotated = await w.svc.setup(); // → ENTROPY_2
    expect(rotated).toMatchObject({
      status: { reissuePending: false },
      reissuedSats: 0,
      feeSats: 0,
      reissueFailed: 1,
    });
    expect(w.core.wallet.reissued).toHaveLength(1); // ENTROPY_1's only: nothing moved while journaled
    expect(w.confirms.filter((f) => f.kind === 'recovery-reissue')).toHaveLength(1);
    expect(await readEnvelope(path)).toMatchObject({
      reissued: true,
      reissuedMints: [],
      watchedMints: [MINT_A],
      replaces: first?.device,
    });
    expect(blanks(w)).toBe(0); // ENTROPY_1's copy stays: the 99 sats are still its
    // The melt failed and its 50 sats of inputs came back: the next retry reopens the backup...
    w.pending.clear();
    w.overdue.clear();
    hold(w, MINT_A, 149);
    expect(w.timers.armed).toHaveLength(1);
    await w.timers.fire();
    expect(await readEnvelope(path)).toMatchObject({ reissued: false, reissuedMints: [] });
    // ...and "Finish backup" moves the mint once, under ENTROPY_2; ENTROPY_1's copy goes then.
    const finished = await w.svc.setup();
    expect(finished).toMatchObject({
      status: { reissuePending: false },
      reissuedSats: 148,
      feeSats: 1,
      reissueFailed: 0,
    });
    expect(w.core.wallet.reissued.map((p) => p.amount)).toEqual([100, 149]);
    expect(await readEnvelope(path)).toMatchObject({
      reissued: true,
      reissuedMints: [MINT_A],
      replaces: null,
    });
    expect(blanks(w)).toBe(1);
    expectNoPhrase(w, [rotated, finished]);
  });

  it('low: a balance at a mint that cannot be asked no longer keeps the backup pending for good — done but watched (still counted as not covered), each retry capped at WATCH_RETRY_MAX_MS; the backup reopens when the mint answers with it, and "Finish backup" moves only that mint', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    hold(w, MINT_A, 1_000);
    w.core.wallet.plans.set(MINT_A, { inputs: 2, feeSats: 2 });
    // Mint B holds 700 sats and does not answer (the fake scripts no plan: `reissuePlan` throws).
    hold(w, MINT_B, 700);
    const r = await w.svc.setup();
    expect(r).toMatchObject({
      status: { reissuePending: false },
      reissuedSats: 998,
      feeSats: 2,
      reissueFailed: 1,
    });
    const path = recoveryPath(w.dir, w.pubkey);
    expect(await readEnvelope(path)).toMatchObject({
      reissued: true,
      reissuedMints: [MINT_A],
      watchedMints: [MINT_B],
    });
    // Still down: every retry asks it again and keeps it watched; the wait stops growing at the cap.
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      await w.timers.fire();
      waits.push(w.timers.armed[0]?.ms ?? -1);
    }
    expect(waits).toEqual([
      2 * RELAY_RETRY_FIRST_MS,
      4 * RELAY_RETRY_FIRST_MS,
      8 * RELAY_RETRY_FIRST_MS,
      16 * RELAY_RETRY_FIRST_MS,
      WATCH_RETRY_MAX_MS,
      WATCH_RETRY_MAX_MS,
    ]);
    expect(w.core.wallet.planned.filter((m) => m === MINT_B)).toHaveLength(1 + 6);
    expect(await readEnvelope(path)).toMatchObject({ reissued: true, watchedMints: [MINT_B] });
    // The mint answers again, the 700 sats worth moving: the backup reopens...
    w.core.wallet.plans.set(MINT_B, { inputs: 2, feeSats: 1 });
    await w.timers.fire();
    const reopened = await readEnvelope(path);
    expect(reopened).toMatchObject({ reissued: false, reissuedMints: [MINT_A] });
    expect(reopened?.watchedMints).toBeUndefined();
    expect((await w.svc.status()).reissuePending).toBe(true);
    expect(w.timers.armed).toEqual([]);
    // ...and "Finish backup" asks for mint B alone (mint A is recorded) and records it.
    const r2 = await w.svc.setup();
    expect(w.confirms.at(-1)).toEqual({
      kind: 'recovery-reissue',
      plans: [{ mint: MINT_B, amount: 700, inputs: 2, feeSats: 1 }],
    });
    expect(r2).toMatchObject({
      status: { reissuePending: false },
      reissuedSats: 699,
      feeSats: 1,
      reissueFailed: 0,
    });
    const done = await readEnvelope(path);
    expect(done).toMatchObject({ reissued: true, reissuedMints: [MINT_A, MINT_B] });
    expect(done?.watchedMints).toBeUndefined();
    expect(w.core.wallet.reissued.map((p) => p.mint)).toEqual([MINT_A, MINT_B]);
    expectNoPhrase(w, [r, r2]);
  });

  it('low: dust at a mint that cannot be asked is watched too, and dropped — done like any dust — once the mint answers', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    hold(w, MINT_B, 2); // no plan scripted: mint B does not answer
    const r = await w.svc.setup();
    expect(w.confirms).toEqual([]);
    expect(r).toMatchObject({ status: { reissuePending: false }, reissueFailed: 1 });
    const path = recoveryPath(w.dir, w.pubkey);
    expect(await readEnvelope(path)).toMatchObject({ reissued: true, watchedMints: [MINT_B] });
    // Back, with an input fee that eats the 2 sats: nothing worth moving — no longer watched.
    w.core.wallet.plans.set(MINT_B, { inputs: 2, feeSats: 2 });
    expect(w.timers.armed).toHaveLength(1);
    await w.timers.fire();
    const env = await readEnvelope(path);
    expect(env).toMatchObject({ reissued: true });
    expect(env?.watchedMints).toBeUndefined();
    expect(w.timers.armed).toEqual([]);
    expect(w.confirms).toEqual([]);
    expectNoPhrase(w, [r]);
  });

  it('low: a plan the PAY/melt gate refused (a PAY at that mint still building) is not “cannot be asked” — the reissue stays pending, nothing is watched', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    hold(w, MINT_B, 700);
    w.core.wallet.plans.set(MINT_B, { inputs: 2, feeSats: 1 });
    w.core.wallet.reissuePlan = () => Promise.reject(new GateRefusal(PAY_STILL_BUILDING_HOLD));
    const r = await w.svc.setup();
    expect(w.confirms).toEqual([]);
    expect(r).toMatchObject({ status: { reissuePending: true }, reissueFailed: 1 });
    const env = await readEnvelope(recoveryPath(w.dir, w.pubkey));
    expect(env).toMatchObject({ reissued: false, reissuedMints: [] });
    expect(env?.watchedMints).toBeUndefined();
    expectNoPhrase(w, [r]);
  });

  it('low: a Settings action during a relay copy retry stuck on a NIP-46 signer answers — refused `remote-signer` once the bound passes, never left hanging — and the next action answers too', async () => {
    const w = await world({ kind: 'nip46' });
    userWhoWritesItDown(w);
    w.confirm = () => true;
    let refuse = true;
    const publish = w.pool.publish.bind(w.pool);
    (w.pool as unknown as { publish: nostr.PoolLike['publish'] }).publish = (relays, ev) =>
      refuse && ev.kind === walletMod.RECOVERY_RELAY_KIND
        ? Promise.resolve(relays.map((url) => ({ url, ok: false, reason: 'down' })))
        : publish(relays, ev);
    await w.svc.setup();
    const path = recoveryPath(w.dir, w.pubkey);
    expect((await readEnvelope(path))?.relayCopy).toBe(false);
    refuse = false;
    // The bunker never answers the retry's signing request (a phone asleep, an approval waiting).
    let signing = false;
    (w.signer as { signEvent: Signer['signEvent'] }).signEvent = () => {
      signing = true;
      return new Promise<never>(() => undefined);
    };
    expect(w.timers.armed).toHaveLength(1);
    await w.timers.fire({ hangs: true }); // the retry starts; its signing hangs
    await vi.waitFor(() => {
      expect(signing).toBe(true);
    });
    w.confirms.length = 0;
    // "Show phrase" meanwhile: it waits for the retry — bounded (one timer armed for the wait).
    const shown = w.svc.show().then(
      () => 'shown',
      (e: unknown) => e,
    );
    await vi.waitFor(() => {
      expect(w.timers.armed.map((t) => t.ms)).toEqual([RELAY_RUN_WAIT_MS]);
    });
    expect(w.confirms).toEqual([]);
    await w.timers.fire(); // the bound passes
    expect(await shown).toMatchObject({ code: 'remote-signer' });
    expect(w.confirms).toEqual([]); // nothing asked, nothing shown
    // The flows' lock was released: the next action waits and answers the same way — not refused
    // at once as "a recovery phrase window is already open".
    const restored = w.svc.restore().then(
      () => 'restored',
      (e: unknown) => e,
    );
    await vi.waitFor(() => {
      expect(w.timers.armed.map((t) => t.ms)).toEqual([RELAY_RUN_WAIT_MS]);
    });
    await w.timers.fire();
    expect(await restored).toMatchObject({ code: 'remote-signer' });
    expect((await readEnvelope(path))?.relayCopy).toBe(false);
    expectNoPhrase(w);
  });
});

describe('W8a: the relay copy is retried until a relay takes it', () => {
  it('a copy no relay took is retried with a bounded backoff (the pending flag is the envelope’s `relayCopy`); once published, the status says so and the retries stop', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    let refuse = true;
    const publish = w.pool.publish.bind(w.pool);
    (w.pool as unknown as { publish: nostr.PoolLike['publish'] }).publish = (relays, ev) =>
      refuse && ev.kind === walletMod.RECOVERY_RELAY_KIND
        ? Promise.resolve(relays.map((url) => ({ url, ok: false, reason: 'down' })))
        : publish(relays, ev);
    const r = await w.svc.setup();
    expect(r.status.relayCopy).toBe(false);
    expect(w.timers.armed.map((t) => t.ms)).toEqual([RELAY_RETRY_FIRST_MS]);
    // Still down: the wait doubles, up to the cap.
    const waits: number[] = [];
    for (let i = 0; i < 9; i++) {
      await w.timers.fire();
      waits.push(w.timers.armed[0]?.ms ?? -1);
    }
    expect(waits.slice(0, 3)).toEqual([
      2 * RELAY_RETRY_FIRST_MS,
      4 * RELAY_RETRY_FIRST_MS,
      8 * RELAY_RETRY_FIRST_MS,
    ]);
    expect(waits.at(-1)).toBe(RELAY_RETRY_MAX_MS);
    expect((await readEnvelope(recoveryPath(w.dir, w.pubkey)))?.relayCopy).toBe(false);
    expect((await w.svc.status()).relayCopy).toBe(false);
    // The relays are back: the next retry publishes the sealed copy, records it, and stops.
    refuse = false;
    await w.timers.fire();
    const env = await readEnvelope(recoveryPath(w.dir, w.pubkey));
    expect(env?.relayCopy).toBe(true);
    const copy = w.pool.published.filter((p) => p.event.kind === walletMod.RECOVERY_RELAY_KIND);
    expect(copy.at(-1)?.event.content).toBe(env?.sealed);
    expect((await w.svc.status()).relayCopy).toBe(true);
    expect(w.timers.armed).toEqual([]);
    expectNoPhrase(w);
  });

  it('a plane opened with a copy still unpublished schedules the retry; stop() cancels it', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    const path = recoveryPath(w.dir, w.pubkey);
    const env = await readEnvelope(path);
    if (env === null) throw new Error('no envelope');
    // Fire what the setup left armed (its reopen found the new envelope before the publish): a
    // copy already on a relay leaves nothing to do, and nothing is armed again.
    while (w.timers.armed.length > 0) await w.timers.fire();
    // A copy recorded unpublished (a crash before the retry landed): the next plane open retries.
    await writeEnvelope(w.dir, path, { ...env, relayCopy: false });
    await w.openPlane();
    expect(w.timers.armed.map((t) => t.ms)).toEqual([RELAY_RETRY_FIRST_MS]);
    await w.timers.fire();
    expect((await readEnvelope(path))?.relayCopy).toBe(true);
    expect(w.timers.armed).toEqual([]);
    await writeEnvelope(w.dir, path, { ...env, relayCopy: false });
    await w.openPlane();
    expect(w.timers.armed).toHaveLength(1);
    w.svc.stop();
    expect(w.timers.armed).toEqual([]);
    await w.openPlane(); // stopped: nothing scheduled any more
    expect(w.timers.armed).toEqual([]);
  });
});

describe('W8a: the reopen and the counters store', () => {
  it('info: the play sessions are closed through the worker before each reopen (their tails carry what was left unpaid)', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    expect(w.lifecycle).toEqual(['close sessions', 'reopen']);
  });

  it('one counters store object per identity: every plane open gets the same one', async () => {
    const w = await world();
    userWhoWritesItDown(w);
    w.confirm = () => true;
    await w.svc.setup();
    const a = await w.svc.seedFor(w.signer, w.pubkey);
    const b = await w.svc.seedFor(w.signer, w.pubkey);
    expect(a?.material.counters).toBeDefined();
    expect(b?.material.counters).toBe(a?.material.counters);
  });
});
