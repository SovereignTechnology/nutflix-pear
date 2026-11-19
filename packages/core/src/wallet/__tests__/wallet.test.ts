/**
 * The wallet against a real (in-process) Cashu mint: `TestMint` + `@cashu/cashu-ts`, so blind
 * signatures, DLEQ, P2PK witnesses and double-spend state are all real. Adversary cases:
 * concurrent sends, reserved lock tags, proofs locked to someone else, already-spent proofs,
 * a mint outage, a lost response after the mint spent the inputs, and a mint that strips DLEQ.
 */
import { describe, expect, it } from 'vitest';
import {
  getPubKeyFromPrivKey,
  verifyMintSignatures,
  Amount,
  type RequestFn,
} from '@cashu/cashu-ts';

import type { CashuP2pkPubkey, MintUrl, Sats, UnixSeconds } from '../../contracts/index.js';
import { TestMint } from '../../mocks/test-mint.js';
import { checkPayLock } from '../../payment/lock.js';
import { PENDING_SETTLE_AFTER_S, WalletError } from '../spend.js';
import { MemoryProofStore, proofTotal } from '../store.js';
import { CashuMintConnections, CashuWallet, memoryWalletKey } from '../wallet.js';

const MINT = 'https://mint.test-a.example' as MintUrl;
const sats = (n: number): Sats => n as Sats;

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function keyOf(fill: number): { sk: Uint8Array; pub: CashuP2pkPubkey } {
  const sk = new Uint8Array(32).fill(fill);
  return { sk, pub: hex(getPubKeyFromPrivKey(sk)) as CashuP2pkPubkey };
}

function rig(
  opts: {
    readonly fee?: number;
    readonly wrap?: (r: RequestFn) => RequestFn;
    readonly walletKey?: Uint8Array;
    readonly nut20?: boolean;
    readonly nut09?: boolean;
    readonly mint?: TestMint;
    readonly now?: () => UnixSeconds;
  } = {},
): { mint: TestMint; store: MemoryProofStore; wallet: CashuWallet } {
  const mint =
    opts.mint ??
    new TestMint({
      url: MINT,
      seed: new Uint8Array(32).fill(1),
      inputFeePpk: opts.fee ?? 0,
      ...(opts.nut20 === undefined ? {} : { nut20: opts.nut20 }),
      ...(opts.nut09 === undefined ? {} : { nut09: opts.nut09 }),
    });
  const store = new MemoryProofStore();
  const request = opts.wrap ? opts.wrap(mint.request) : mint.request;
  const wallet = new CashuWallet({
    mints: new CashuMintConnections({ request: () => request }),
    store,
    ...(opts.walletKey ? { key: memoryWalletKey(opts.walletKey) } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { mint, store, wallet };
}

async function fund(w: CashuWallet, mint: TestMint, amount: number): Promise<void> {
  const q = await w.mintQuote(MINT, sats(amount));
  expect(w.pendingMintQuotes().map((x) => x.quoteId)).toContain(q.quoteId);
  expect(await w.pollQuote(q)).toEqual({ state: 'UNPAID' });
  mint.payQuote(q.quoteId);
  expect(await w.pollQuote(q)).toEqual({ state: 'ISSUED', minted: amount });
  expect(w.pendingMintQuotes()).toEqual([]);
}

describe('inputFeePpk (v6: mint fees shown in the price)', () => {
  it('reports the active keyset’s input_fee_ppk, 0 for a free mint', async () => {
    expect(await rig({ fee: 100 }).wallet.inputFeePpk(MINT)).toBe(100);
    expect(await rig().wallet.inputFeePpk(MINT)).toBe(0);
  });
});

describe('F17: NUT-20 locked mint quotes', () => {
  const quoteBody = (mint: TestMint, id: string) =>
    mint.request<{ pubkey?: string }>({
      endpoint: `${MINT}/v1/mint/quote/bolt11/${id}`,
      method: 'GET',
    });

  it('a quote is locked to the wallet key, and mints with its signature', async () => {
    const me = keyOf(21);
    const { mint, wallet } = rig({ walletKey: me.sk });
    const q = await wallet.mintQuote(MINT, sats(40));
    expect((await quoteBody(mint, q.quoteId)).pubkey).toBe(me.pub);
    mint.payQuote(q.quoteId);
    expect(await wallet.pollQuote(q)).toEqual({ state: 'ISSUED', minted: 40 });
    expect(await wallet.balance(MINT)).toBe(40);
  });

  it('knowing the quote id is worth nothing: another wallet, and a raw unsigned mint, are refused', async () => {
    const { mint, wallet } = rig({ walletKey: keyOf(22).sk });
    const q = await wallet.mintQuote(MINT, sats(8));
    mint.payQuote(q.quoteId);
    // A thief with the id and its own wallet (another key) — refused before the mint is asked.
    const thief = rig({ walletKey: keyOf(23).sk, mint }).wallet;
    await expect(thief.pollQuote(q)).rejects.toMatchObject({ code: 'invalid-argument' });
    const keyless = rig({ mint }).wallet;
    await expect(keyless.pollQuote(q)).rejects.toMatchObject({ code: 'invalid-argument' });
    // …and the mint itself refuses an unsigned mint of the locked quote (NUT-20 error 20008).
    await expect(
      mint.request({
        endpoint: `${MINT}/v1/mint/bolt11`,
        method: 'POST',
        requestBody: {
          quote: q.quoteId,
          outputs: [{ amount: 8, id: mint.keysetId, B_: `02${'11'.repeat(32)}` }],
        },
      }),
    ).rejects.toMatchObject({ code: 20008 });
    // The owner still mints.
    expect(await wallet.pollQuote(q)).toEqual({ state: 'ISSUED', minted: 8 });
  });

  it('unlocked where it cannot be locked: a mint without NUT-20, a wallet without a key, a signer-held key', async () => {
    const plain = rig({ walletKey: keyOf(24).sk, nut20: false });
    const q1 = await plain.wallet.mintQuote(MINT, sats(5));
    expect((await quoteBody(plain.mint, q1.quoteId)).pubkey).toBeUndefined();
    const nokey = rig();
    const q2 = await nokey.wallet.mintQuote(MINT, sats(5));
    expect((await quoteBody(nokey.mint, q2.quoteId)).pubkey).toBeUndefined();
    const k = memoryWalletKey(keyOf(25).sk);
    const held = new CashuWallet({
      mints: new CashuMintConnections({ request: () => nokey.mint.request }),
      store: new MemoryProofStore(),
      key: { pubkey: k.pubkey, sign: (m) => k.sign(m) }, // like signerWalletKey: no withSecretHex
    });
    const q3 = await held.mintQuote(MINT, sats(5));
    expect((await quoteBody(nokey.mint, q3.quoteId)).pubkey).toBeUndefined();
    nokey.mint.payQuote(q3.quoteId);
    expect(await held.pollQuote(q3)).toEqual({ state: 'ISSUED', minted: 5 });
  });

  it('a mint that does not lock the quote it was asked to lock is refused', async () => {
    const { wallet } = rig({
      walletKey: keyOf(26).sk,
      wrap:
        (r): RequestFn =>
        async <T>(args: Parameters<RequestFn>[0]): Promise<T> => {
          const out = await r<Record<string, unknown>>(args);
          if (
            args.endpoint.endsWith('/v1/mint/quote/bolt11') &&
            (args.method ?? 'GET') === 'POST'
          ) {
            const { pubkey: _dropped, ...rest } = out;
            return rest as T;
          }
          return out as T;
        },
    });
    // cashu-ts refuses an unlocked answer itself; the wallet checks the pubkey too (defense in depth).
    await expect(wallet.mintQuote(MINT, sats(5))).rejects.toThrow(/unlocked|lock/i);
    expect(wallet.pendingMintQuotes()).toEqual([]);
  });
});

describe('CashuWallet (NUT-04 / NUT-11 / NUT-03 / NUT-05 over a real mint)', () => {
  it('funds through a mint quote; balance and history follow', async () => {
    const { mint, wallet } = rig();
    await fund(wallet, mint, 100);
    expect(await wallet.balance(MINT)).toBe(100);
    expect(await wallet.mints()).toEqual([MINT]);
    const [top] = await wallet.history({ limit: 1 });
    expect(top).toMatchObject({ direction: 'in', amount: 100, memo: 'top-up' });
  });

  it('P2PK send: exactly the amount, locked to the recipient with the binding tag, every proof with a DLEQ the recipient can verify; change committed; the sender pays the swap fee', async () => {
    const { mint, wallet } = rig({ fee: 100 });
    await fund(wallet, mint, 100);
    const to = keyOf(5);
    const seller = keyOf(6).pub;
    const set = await wallet.send(sats(10), { p2pk: to.pub, mint: MINT, tags: [['pay1', seller]] });
    expect(set).toMatchObject({ mint: MINT, unit: 'sat', lockedTo: to.pub });
    expect(proofTotal(set.proofs)).toBe(10);
    for (const p of set.proofs) {
      expect(p.dleq?.r).toBeDefined();
      const checked = await verifyMintSignatures(
        [{ ...p, amount: Amount.from(p.amount) }],
        () => mint.keyset(),
        { require: true },
      );
      expect(checked.invalid).toEqual([]);
      expect(checked.valid).toHaveLength(1);
      expect(checkPayLock(p.secret, to.pub, { binding: seller })).toEqual({ ok: true });
    }
    const fee = 100 - 10 - (await wallet.balance(MINT));
    expect(fee).toBeGreaterThanOrEqual(1); // inputs cost 100 ppk each, rounded up
    const [out] = await wallet.history({ limit: 1 });
    expect(out).toMatchObject({ direction: 'out', amount: 10 + fee });
    // The recipient can redeem them; nobody else can (both wallets on the SAME mint).
    const thief = new CashuWallet({
      mints: new CashuMintConnections({ request: () => mint.request }),
      store: new MemoryProofStore(),
      key: memoryWalletKey(keyOf(7).sk),
    });
    await expect(thief.receive(set)).rejects.toMatchObject({ code: 'not-ours' });
    const good = new CashuWallet({
      mints: new CashuMintConnections({ request: () => mint.request }),
      store: new MemoryProofStore(),
      key: memoryWalletKey(to.sk),
    });
    expect(await good.receive(set)).toBeGreaterThanOrEqual(8); // 10 less the receiving swap's fee
    // Presenting the thief's own key as the lock does not help: the witness must match `data`.
    const forged = { ...set, lockedTo: keyOf(7).pub };
    await expect(thief.receive(forged)).rejects.toMatchObject({ code: 'not-ours' });
  });

  it('refuses a lock tag with spending semantics, a bad recipient key, a non-positive amount, and more than the balance', async () => {
    const { mint, wallet } = rig();
    await fund(wallet, mint, 20);
    const to = keyOf(5).pub;
    for (const tag of ['locktime', 'refund', 'pubkeys', 'n_sigs', 'sigflag', 'n_sigs_refund'])
      await expect(
        wallet.send(sats(1), { p2pk: to, mint: MINT, tags: [[tag, '1']] }),
      ).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    await expect(
      wallet.send(sats(1), { p2pk: 'nothex' as CashuP2pkPubkey, mint: MINT }),
    ).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(wallet.send(sats(0), { p2pk: to, mint: MINT })).rejects.toThrow(
      /invalid-argument/,
    );
    await expect(wallet.send(sats(21), { p2pk: to, mint: MINT })).rejects.toMatchObject({
      code: 'insufficient-funds',
    });
    expect(await wallet.balance(MINT)).toBe(20);
  });

  it('two concurrent sends never select the same proof (per-mint lock): one succeeds, the other is insufficient, the mint sees no double-spend', async () => {
    const { mint, wallet } = rig();
    await fund(wallet, mint, 10);
    const to = keyOf(5).pub;
    const results = await Promise.allSettled([
      wallet.send(sats(6), { p2pk: to, mint: MINT }),
      wallet.send(sats(6), { p2pk: to, mint: MINT }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(
      rejected?.status === 'rejected' ? (rejected.reason as unknown) : undefined,
    ).toMatchObject({
      code: 'insufficient-funds',
    });
    expect(await wallet.balance(MINT)).toBe(4);
  });

  it('receive: proofs locked to our wallet key are signed and swapped; a proof already spent is `spent`; unlocked proofs are swapped too', async () => {
    const me = keyOf(9);
    const { mint, wallet } = rig({ walletKey: me.sk });
    expect(await wallet.p2pkPubkey()).toBe(me.pub);
    const locked = mint.issue(13, { p2pk: me.pub, tags: [['pay1', keyOf(6).pub]] });
    expect(await wallet.receive({ mint: MINT, proofs: locked })).toBe(13);
    await expect(wallet.receive({ mint: MINT, proofs: locked })).rejects.toMatchObject({
      code: 'spent',
    });
    const plain = mint.issue(5);
    expect(await wallet.receive({ mint: MINT, proofs: plain })).toBe(5);
    expect(await wallet.balance(MINT)).toBe(18);
    // A wallet without a key cannot receive locked proofs at all.
    const keyless = rig();
    await expect(
      keyless.wallet.receive({ mint: MINT, proofs: mint.issue(2, { p2pk: me.pub }) }),
    ).rejects.toMatchObject({
      code: 'not-ours',
    });
    await expect(keyless.wallet.p2pkPubkey()).rejects.toThrow(/no NIP-60 wallet key/);
  });

  it('melt: quote → pay; the fee reserve comes back as change; the history records what left', async () => {
    const mint = new TestMint({ url: MINT, seed: new Uint8Array(32).fill(1), feeReserve: 4 });
    const wallet = new CashuWallet({
      mints: new CashuMintConnections({ request: () => mint.request }),
      store: new MemoryProofStore(),
    });
    await fund(wallet, mint, 64);
    const q = await wallet.meltQuote(MINT, 'lnbc200n1testinvoice'); // 200 × 0.1 sat = 20 sat
    expect(q).toMatchObject({ amount: 20, feeReserve: 4 });
    const r = await wallet.melt(q);
    expect(r.paid).toBe(true);
    expect(await wallet.balance(MINT)).toBe(64 - 20);
    await expect(wallet.meltQuote(MINT, 'not an invoice')).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  // Security review F8 follow-up: the native confirm dialog shows the quote's fee reserve, so the
  // wallet must not pay under a larger one than the quote it was handed (a compromised renderer
  // could otherwise show 1 sat while the mint reserves more).
  it('melt refuses when the mint asks a larger fee reserve than the quote that was shown; nothing leaves', async () => {
    const mint = new TestMint({ url: MINT, seed: new Uint8Array(32).fill(1), feeReserve: 4 });
    const wallet = new CashuWallet({
      mints: new CashuMintConnections({ request: () => mint.request }),
      store: new MemoryProofStore(),
    });
    await fund(wallet, mint, 64);
    const q = await wallet.meltQuote(MINT, 'lnbc200n1testinvoice');
    await expect(wallet.melt({ ...q, feeReserve: 1 })).rejects.toMatchObject({
      code: 'bad-mint-response',
    });
    expect(await wallet.balance(MINT)).toBe(64);
    expect((await wallet.melt(q)).paid).toBe(true);
  });

  it('a mint outage before the swap reaches it leaves the inputs in the wallet (reconciled as unspent)', async () => {
    const { mint, wallet } = rig();
    await fund(wallet, mint, 16);
    mint.failNext(1);
    await expect(wallet.send(sats(3), { p2pk: keyOf(5).pub, mint: MINT })).rejects.toMatchObject({
      code: 'mint-error',
    });
    expect(await wallet.balance(MINT)).toBe(16);
    // …and the next send works.
    await wallet.send(sats(3), { p2pk: keyOf(5).pub, mint: MINT });
    expect(await wallet.balance(MINT)).toBe(13);
  });

  // Without NUT-09 (no restore, so no journal — ADR 0014) a lost answer is a reconciled loss. With
  // it, the same loss is recovered: see "F31: a lost answer loses nothing".
  it('a response lost AFTER the mint spent the inputs is reconciled: the spent inputs are dropped and the loss is recorded (never silently kept)', async () => {
    let dropNextSwap = false;
    const { mint, wallet } = rig({
      nut09: false,
      wrap: (inner) =>
        (async (args: Parameters<RequestFn>[0]) => {
          const res = await inner(args);
          if (dropNextSwap && args.endpoint.endsWith('/v1/swap')) {
            dropNextSwap = false;
            throw new Error('socket hang up');
          }
          return res;
        }) as RequestFn,
    });
    await fund(wallet, mint, 16);
    dropNextSwap = true;
    await expect(wallet.send(sats(3), { p2pk: keyOf(5).pub, mint: MINT })).rejects.toMatchObject({
      code: 'mint-error',
    });
    expect(await wallet.balance(MINT)).toBe(0); // the 16-sat input is gone at the mint
    const [loss] = await wallet.history({ limit: 1 });
    expect(loss).toMatchObject({ direction: 'out', amount: 16 });
    expect(loss?.memo).toMatch(/lost in a failed mint operation/);
  });

  it('a mint that strips DLEQ from its signatures is refused (requireSigDleq); the spent inputs are reconciled, not kept', async () => {
    const { mint, wallet } = rig({
      nut09: false,
      wrap: (inner) =>
        (async (args: Parameters<RequestFn>[0]) => {
          const res = await inner<{ signatures?: { dleq?: unknown }[] }>(args);
          if (args.endpoint.endsWith('/v1/swap') && Array.isArray(res.signatures))
            for (const s of res.signatures) delete s.dleq;
          return res;
        }) as RequestFn,
    });
    await fund(wallet, mint, 8);
    await expect(wallet.send(sats(3), { p2pk: keyOf(5).pub, mint: MINT })).rejects.toBeInstanceOf(
      WalletError,
    );
    expect(await wallet.balance(MINT)).toBe(0);
  });

  it('keyset(): the contract shape, cached; an unknown keyset id is an error', async () => {
    const { mint, wallet } = rig();
    const ks = await wallet.keyset(MINT, mint.keysetId);
    expect(ks).toMatchObject({ mint: MINT, id: mint.keysetId, unit: 'sat', active: true });
    expect(ks.keys['1']).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(await wallet.keyset(MINT, mint.keysetId)).toBe(ks);
    await expect(wallet.keyset(MINT, '00ffffffffffffff')).rejects.toThrow();
  });
});

// ADR 0014 (security review F31): a send, receive or mint writes its outputs to the store before
// the request; if the answer is lost, what the mint signed is restored (NUT-09), never gone.
describe('F31: a lost answer loses nothing (journal + NUT-09 restore)', () => {
  /** A transport that loses the answer to the next request on `path` (after the mint ran it). */
  function lossy(path: string) {
    let drop = 0;
    let refuse = 0;
    let noRestore = 0;
    const bodies: unknown[] = [];
    const wrap =
      (inner: RequestFn): RequestFn =>
      async <T>(args: Parameters<RequestFn>[0]): Promise<T> => {
        if (args.endpoint.endsWith('/v1/restore') && noRestore > 0) {
          noRestore--;
          throw new Error('connect ETIMEDOUT');
        }
        if (args.endpoint.endsWith(path)) {
          bodies.push(JSON.parse(JSON.stringify(args.requestBody ?? null)));
          if (refuse > 0) {
            refuse--; // never reached the mint
            throw new Error('connect ECONNREFUSED');
          }
        }
        const res = await inner<T>(args);
        if (args.endpoint.endsWith(path) && drop > 0) {
          drop--;
          throw new Error('socket hang up');
        }
        return res;
      };
    return {
      wrap,
      bodies,
      dropNext: () => {
        drop++;
      },
      refuseNext: () => {
        refuse++;
      },
      noRestoreNext: () => {
        noRestore++;
      },
    };
  }
  const outputsOf = (body: unknown): string[] =>
    ((body as { outputs?: { B_: string }[] }).outputs ?? []).map((o) => o.B_);

  it('a send whose answer was lost completes: the locked set comes back, the change is kept', async () => {
    const net = lossy('/v1/swap');
    const { mint, store, wallet } = rig({ wrap: net.wrap });
    await fund(wallet, mint, 16);
    net.dropNext();
    const recipient = keyOf(5).pub;
    const set = await wallet.send(sats(3), { p2pk: recipient, mint: MINT });
    expect(proofTotal(set.proofs)).toBe(3);
    const keys = await wallet.keyset(MINT, mint.keysetId);
    for (const p of set.proofs) {
      expect(checkPayLock(p.secret, recipient).ok).toBe(true);
      const checked = await verifyMintSignatures(
        [{ ...p, amount: Amount.from(p.amount) }],
        () => keys,
        { require: true },
      );
      expect(checked.invalid).toEqual([]);
      expect(checked.valid).toHaveLength(1);
    }
    expect(await wallet.balance(MINT)).toBe(13);
    expect(await store.pending(MINT)).toEqual([]);
    const [last] = await wallet.history({ limit: 1 });
    expect(last).toMatchObject({ direction: 'out', amount: 3 });
  });

  it('a receive whose answer was lost is recovered in the same call', async () => {
    const payer = rig();
    await fund(payer.wallet, payer.mint, 16);
    const me = keyOf(7);
    const set = await payer.wallet.send(sats(5), { p2pk: me.pub, mint: MINT });
    const net = lossy('/v1/swap');
    const { store, wallet } = rig({ mint: payer.mint, wrap: net.wrap, walletKey: me.sk });
    net.dropNext();
    expect(await wallet.receive(set)).toBe(5);
    expect(await wallet.balance(MINT)).toBe(5);
    expect(await store.pending(MINT)).toEqual([]);
  });

  it('a top-up whose mint answer was lost is minted anyway; if the mint could not be asked, the next poll recovers it', async () => {
    const net = lossy('/v1/mint/bolt11');
    const { mint, store, wallet } = rig({ wrap: net.wrap });
    const q = await wallet.mintQuote(MINT, sats(16));
    mint.payQuote(q.quoteId);
    net.dropNext();
    expect(await wallet.pollQuote(q)).toEqual({ state: 'ISSUED', minted: 16 });
    expect(await wallet.balance(MINT)).toBe(16);

    const q2 = await wallet.mintQuote(MINT, sats(8));
    mint.payQuote(q2.quoteId);
    net.dropNext();
    net.noRestoreNext();
    await expect(wallet.pollQuote(q2)).rejects.toMatchObject({ code: 'mint-error' });
    expect(await store.pending(MINT)).toHaveLength(1);
    // The mint now says ISSUED — by the request whose answer we lost.
    expect(await wallet.pollQuote(q2)).toEqual({ state: 'ISSUED', minted: 8 });
    expect(await wallet.balance(MINT)).toBe(24);
    expect(await store.pending(MINT)).toEqual([]);
  });

  it('a retried receive reuses the journaled outputs; a mint that already signed them answers once', async () => {
    const payer = rig();
    await fund(payer.wallet, payer.mint, 16);
    const me = keyOf(8);
    const set = await payer.wallet.send(sats(6), { p2pk: me.pub, mint: MINT });
    const net = lossy('/v1/swap');
    const { store, wallet } = rig({ mint: payer.mint, wrap: net.wrap, walletKey: me.sk });
    net.refuseNext();
    await expect(wallet.receive(set)).rejects.toMatchObject({ code: 'mint-error' });
    expect(await store.pending(MINT)).toHaveLength(1);
    expect(await wallet.receive(set)).toBe(6);
    expect(net.bodies).toHaveLength(2);
    expect(outputsOf(net.bodies[1])).toEqual(outputsOf(net.bodies[0]));
    expect(await store.pending(MINT)).toEqual([]);
  });

  it('a send the mint never saw keeps its inputs out of selection until the wait is over, then frees them', async () => {
    let now = 1_900_000_000;
    const net = lossy('/v1/swap');
    const { mint, store, wallet } = rig({ wrap: net.wrap, now: () => now as UnixSeconds });
    await fund(wallet, mint, 16); // one 16-sat proof
    net.refuseNext();
    await expect(wallet.send(sats(3), { p2pk: keyOf(5).pub, mint: MINT })).rejects.toMatchObject({
      code: 'mint-error',
    });
    // Kept (maybe still in flight), but HELD: issue #8 (ADR 0014 amendment) takes a pending
    // send's inputs out of the balance too, where this test used to expect 16 — they are not
    // spendable, so showing them was showing money the user cannot use.
    expect(await store.proofs(MINT)).toHaveLength(1);
    expect(await wallet.balance(MINT)).toBe(0);
    await expect(wallet.send(sats(3), { p2pk: keyOf(5).pub, mint: MINT })).rejects.toMatchObject({
      code: 'insufficient-funds',
    });
    now += PENDING_SETTLE_AFTER_S;
    await wallet.send(sats(3), { p2pk: keyOf(5).pub, mint: MINT });
    expect(await wallet.balance(MINT)).toBe(13);
    expect(await store.pending(MINT)).toEqual([]);
  });

  it('a restored signature without its DLEQ (NUT-12 mint) is refused: nothing is committed, the journal stays', async () => {
    let strip = false;
    const { mint, store, wallet } = rig({
      wrap: (inner) =>
        (async (args: Parameters<RequestFn>[0]) => {
          const res = await inner<{ signatures?: { dleq?: unknown }[] }>(args);
          if (strip && /\/v1\/(swap|restore)$/.test(args.endpoint) && Array.isArray(res.signatures))
            for (const sig of res.signatures) delete sig.dleq;
          return res;
        }) as RequestFn,
    });
    await fund(wallet, mint, 16);
    strip = true;
    await expect(wallet.send(sats(3), { p2pk: keyOf(5).pub, mint: MINT })).rejects.toBeInstanceOf(
      WalletError,
    );
    expect(await store.pending(MINT)).toHaveLength(1);
    // Held while pending, and out of the balance too since issue #8 (ADR 0014 amendment; this
    // used to expect 16): the input is still in the store, just not spendable.
    expect(await store.proofs(MINT)).toHaveLength(1);
    expect(await wallet.balance(MINT)).toBe(0);
    strip = false;
    await wallet.recoverPending(); // an honest answer now: the change is restored
    expect(await wallet.balance(MINT)).toBe(13);
    expect(await store.pending(MINT)).toEqual([]);
  });

  it('without NUT-09 at the mint nothing is journaled', async () => {
    const net = lossy('/v1/swap');
    const { mint, store, wallet } = rig({ wrap: net.wrap, nut09: false });
    await fund(wallet, mint, 16);
    net.refuseNext();
    await expect(wallet.send(sats(3), { p2pk: keyOf(5).pub, mint: MINT })).rejects.toMatchObject({
      code: 'mint-error',
    });
    expect(await store.pending(MINT)).toEqual([]);
  });
});
