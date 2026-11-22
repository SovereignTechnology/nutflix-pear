/**
 * TestMint behaves like a mint where it matters to the adversary suite: it refuses a forged
 * signature, an unbalanced swap, a locked proof without its witness, a double-spend and an
 * unknown keyset — so a test that passes against it is not passing because the mint is lax. A
 * melt answered PENDING (`holdNextMelt`) holds its inputs like cdk and Nutshell until it settles.
 */
import { describe, expect, it } from 'vitest';
import {
  Amount,
  Mint,
  OutputData,
  getPubKeyFromPrivKey,
  verifyMintSignatures,
  type Proof,
} from '@cashu/cashu-ts';

import type { MintUrl, Sats } from '../../contracts/index.js';
import { CashuMintConnections, CashuWallet } from '../../wallet/wallet.js';
import { MemoryProofStore } from '../../wallet/store.js';
import { TestLightning, TestMint } from '../test-mint.js';

const URL_ = 'https://mint.test.example' as MintUrl;

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function swap(tm: TestMint, inputs: Proof[], outAmount: number): Promise<unknown> {
  const mint = new Mint(URL_, { customRequest: tm.request });
  const keys = { id: tm.keysetId, keys: tm.keyset().keys };
  const outputs = OutputData.createRandomData(outAmount, keys).map((o) => o.blindedMessage);
  return mint.swap({ inputs, outputs });
}

const toProof = (p: ReturnType<TestMint['issue']>[number]): Proof => ({
  ...p,
  amount: Amount.from(p.amount),
});

describe('TestMint refuses what a real mint refuses', () => {
  it('issues proofs whose DLEQ verifies against its keyset', async () => {
    const tm = new TestMint({ url: URL_ });
    const proofs = tm.issue(37).map(toProof);
    expect(proofs.length).toBeGreaterThan(0);
    const checked = await verifyMintSignatures(proofs, () => tm.keyset(), { require: true });
    expect(checked.invalid).toEqual([]);
    expect(checked.valid).toHaveLength(proofs.length);
  });

  it('a forged signature (C) → 10003', async () => {
    const tm = new TestMint({ url: URL_ });
    const [p] = tm.issue(4).map(toProof);
    const forged = {
      ...p!,
      C: p!.C.startsWith('02') ? `03${p!.C.slice(2)}` : `02${p!.C.slice(2)}`,
    };
    await expect(swap(tm, [forged], 4)).rejects.toMatchObject({ code: 10003 });
  });

  it('an unbalanced swap → 11002, and nothing is spent', async () => {
    const tm = new TestMint({ url: URL_ });
    const proofs = tm.issue(4).map(toProof);
    await expect(swap(tm, proofs, 5)).rejects.toMatchObject({ code: 11002 });
    expect(tm.isSpent(proofs[0]!.secret)).toBe(false);
  });

  it('a P2PK-locked proof without its witness → 10003', async () => {
    const tm = new TestMint({ url: URL_ });
    const pub = hex(getPubKeyFromPrivKey(new Uint8Array(32).fill(3)));
    await expect(swap(tm, tm.issue(2, { p2pk: pub }).map(toProof), 2)).rejects.toMatchObject({
      code: 10003,
    });
  });

  it('a double-spend → 11001 (and a proof repeated inside one swap too)', async () => {
    const tm = new TestMint({ url: URL_ });
    const proofs = tm.issue(8).map(toProof);
    await swap(tm, proofs, 8);
    expect(tm.isSpent(proofs[0]!.secret)).toBe(true);
    await expect(swap(tm, proofs, 8)).rejects.toMatchObject({ code: 11001 });
    const twice = tm.issue(2).map(toProof);
    await expect(swap(tm, [twice[0]!, twice[0]!], 4)).rejects.toMatchObject({ code: 11001 });
  });

  it('an unknown keyset → 12001; markSpent() spends behind everyone’s back', async () => {
    const tm = new TestMint({ url: URL_ });
    const [p] = tm.issue(1).map(toProof);
    await expect(swap(tm, [{ ...p!, id: '00ffffffffffffff' }], 1)).rejects.toMatchObject({
      code: 12001,
    });
    tm.markSpent([p!]);
    await expect(swap(tm, [p!], 1)).rejects.toMatchObject({ code: 11001 });
  });
});

describe('TestMint: a melt answered PENDING, settled later (the auto top-up’s round-4 tests)', () => {
  const TARGET = 'https://target.test.example' as MintUrl;

  async function funded(o: { lightning?: TestLightning } = {}) {
    const lightning = o.lightning ?? new TestLightning();
    const source = new TestMint({ url: URL_, lightning, feeReserve: 2 });
    const target = new TestMint({ url: TARGET, lightning });
    const byUrl: Record<string, TestMint> = { [URL_]: source, [TARGET]: target };
    const store = new MemoryProofStore();
    const wallet = new CashuWallet({
      mints: new CashuMintConnections({ request: (m) => byUrl[m]?.request }),
      store,
    });
    const q = await wallet.mintQuote(URL_, 500 as Sats);
    source.payQuote(q.quoteId);
    await wallet.pollQuote(q);
    const invoice = await wallet.mintQuote(TARGET, 100 as Sats);
    const melt = await wallet.meltQuote(URL_, invoice.bolt11);
    return { lightning, source, target, wallet, store, invoice, melt };
  }

  it('PENDING: the inputs read PENDING and cannot be spent, no change yet; settled paid: spent, the invoice paid once, the change restorable', async () => {
    const f = await funded();
    f.source.holdNextMelt(1);
    expect(await f.wallet.melt(f.melt)).toMatchObject({ paid: false });
    const [op] = await f.store.pending(URL_);
    expect(op?.kind).toBe('melt');
    expect(op!.spends.every((p) => !f.source.isSpent(p.secret))).toBe(true);
    expect(f.lightning.paid).toEqual([]);
    expect((await f.wallet.pollQuote(f.invoice)).state).toBe('UNPAID');
    // A spend of a held input is refused (11002); the quote cannot be melted twice (20005).
    await expect(
      swap(f.source, op!.spends.map(toProof), op!.spends[0]!.amount),
    ).rejects.toMatchObject({ code: 11002 });
    expect(f.source.settleMelts('paid')).toBe(1);
    expect(op!.spends.every((p) => f.source.isSpent(p.secret))).toBe(true);
    expect(f.lightning.paid).toHaveLength(1);
    expect(await f.wallet.recoverPending()).toEqual({ recovered: 1, left: 0 });
    expect((await f.wallet.pollQuote(f.invoice)).state).toBe('ISSUED');
    expect(f.source.settleMelts('paid')).toBe(0);
  });

  it("lightning 'now' pays the invoice while the melt still reads PENDING; settled failed releases the inputs; failNextMelt refuses with a code", async () => {
    const now = await funded();
    now.source.holdNextMelt(1, { lightning: 'now' });
    expect(await now.wallet.melt(now.melt)).toMatchObject({ paid: false });
    expect(now.lightning.paid).toHaveLength(1);
    expect(() => now.source.settleMelts('failed')).toThrow();

    const failed = await funded();
    failed.source.holdNextMelt(1);
    expect(await failed.wallet.melt(failed.melt)).toMatchObject({ paid: false });
    const [op] = await failed.store.pending(URL_);
    failed.source.settleMelts('failed');
    expect(op!.spends.every((p) => !failed.source.isSpent(p.secret))).toBe(true);
    expect(failed.lightning.paid).toEqual([]);

    const refused = await funded();
    refused.source.failNextMelt();
    await expect(refused.wallet.melt(refused.melt)).rejects.toThrow(/melt failed/);
    expect(await refused.wallet.balance(URL_)).toBe(500);
    expect(refused.lightning.paid).toEqual([]);
  });

  it('a mint quote carries the expiry the test set (round 5), 2100-01-01 by default', async () => {
    const wallet = (tm: TestMint): CashuWallet =>
      new CashuWallet({
        mints: new CashuMintConnections({ request: () => tm.request }),
        store: new MemoryProofStore(),
      });
    const plain = new TestMint({ url: URL_ });
    expect((await wallet(plain).mintQuote(URL_, 10 as Sats)).expiry).toBe(4_102_444_800);
    const soon = new TestMint({ url: URL_, quoteExpiry: 1_800_000_600 });
    const w = wallet(soon);
    const q = await w.mintQuote(URL_, 10 as Sats);
    expect(q.expiry).toBe(1_800_000_600);
    soon.payQuote(q.quoteId); // still payable: the number only
    expect(await w.pollQuote(q)).toEqual({ state: 'ISSUED', minted: 10 });
  });
});
