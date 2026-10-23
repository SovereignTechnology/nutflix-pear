import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { mocks } from '@sovit/core';
import type { PricePolicy } from '@sovit/core';
import { afterEach, describe, expect, it } from 'vitest';

import { Seeder } from '../seeder.js';
import type { SeederEvent } from '../seeder.js';
import { toHex } from '../util/hex.js';
import { FakePayProtocol, hello } from './fake-pay-protocol.js';
import {
  FakeStream,
  adapters,
  capturedLogger,
  nfxVideo,
  noiseKey,
  pubkey,
  tmpDir,
} from './helpers.js';

const BLOCK = 1024;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function make(
  opts: {
    windowBlocks?: number;
    maxStreams?: number;
    maxStreamsPerKey?: number;
    diskCapBytes?: number;
    dataDir?: string;
    mode?: mocks.MockPaymentMode;
  } = {},
) {
  const t = opts.dataDir ? null : await tmpDir();
  const engine = new mocks.MockPaymentEngine({
    mode: 'honest',
    config: { windowBlocks: opts.windowBlocks ?? 4 },
  });
  const log = capturedLogger();
  const events: SeederEvent[] = [];
  const seeder = await Seeder.create(
    {
      dataDir: opts.dataDir ?? t!.dir,
      diskCapBytes: opts.diskCapBytes ?? 64 * BLOCK,
      blockSize: BLOCK,
      swarm: null,
      rateLimits: {
        maxStreams: opts.maxStreams ?? 8,
        maxStreamsPerKey: opts.maxStreamsPerKey ?? 2,
        connectsPerWindow: 100,
        windowMs: 1000,
      },
      flushEveryBlocks: 1000,
      flushEveryMs: 60_000,
    },
    { engine, logger: log.logger, ...adapters },
  );
  seeder.on((e) => events.push(e));
  cleanups.push(async () => {
    await seeder.close();
    if (t) await t.rm();
  });
  return { seeder, engine, log, events };
}

describe('Seeder façade', () => {
  it('persists blobs + CAS index + disk usage across a restart and enforces the cap after reload', async () => {
    const first = await make({ diskCapBytes: 5 * BLOCK });
    const dataDir = first.seeder.config.dataDir;
    const a = await first.seeder.putBytes(new Uint8Array(3 * BLOCK).fill(1));
    expect(a.ok).toBe(true);
    expect(first.events.filter((e) => e.type === 'blob-added')).toHaveLength(1);
    expect(first.seeder.stats()).toMatchObject({
      blobs: 1,
      usedBytes: 3 * BLOCK,
      capBytes: 5 * BLOCK,
      cores: 1,
    });
    await first.seeder.index.flushed();
    await first.seeder.close();

    const second = await make({ diskCapBytes: 5 * BLOCK, dataDir });
    expect(second.seeder.stats()).toMatchObject({ blobs: 1, usedBytes: 3 * BLOCK });
    if (!a.ok) return;
    expect(second.seeder.blob(a.entry.sha256)?.blob).toEqual(a.entry.blob);
    await second.seeder.openCore();
    const back = await second.seeder.getBlob(a.entry.sha256);
    expect(back?.byteLength).toBe(3 * BLOCK);
    const tooBig = await second.seeder.putBytes(new Uint8Array(3 * BLOCK).fill(2));
    expect(tooBig).toMatchObject({ ok: false, error: { code: 'disk-cap' } });
    const fits = await second.seeder.putBytes(new Uint8Array(2 * BLOCK).fill(2));
    expect(fits.ok).toBe(true);
    expect(await second.seeder.removeBlob(a.entry.sha256)).toBe(true);
    expect(second.events.at(-1)).toMatchObject({ type: 'blob-removed', sha256: a.entry.sha256 });
    expect(second.seeder.stats().usedBytes).toBe(2 * BLOCK);
    expect(second.seeder.listBlobs()).toHaveLength(1);
  });

  it('counts NFX files and the Hyperblobs payload in one disk cap, across a restart', async () => {
    const v = nfxVideo('capped-video', [
      new Uint8Array(100).fill(1),
      new Uint8Array(200).fill(2),
      new Uint8Array(1000).fill(3),
    ]);
    const nfxBytes = 1300 + v.input.hashListBytes.byteLength;
    const first = await make({ diskCapBytes: 4 * BLOCK });
    expect((await first.seeder.nfx.putVideo(v.input)).ok).toBe(true);
    expect(first.seeder.stats().usedBytes).toBe(nfxBytes);
    const dataDir = first.seeder.config.dataDir;
    await first.seeder.close();

    const second = await make({ diskCapBytes: 4 * BLOCK, dataDir });
    expect(second.seeder.stats().usedBytes).toBe(nfxBytes);
    expect(second.seeder.nfx.videos()).toHaveLength(1);
    // A blob the cap would take alone does not fit beside the NFX files.
    const tooBig = await second.seeder.putBytes(new Uint8Array(3 * BLOCK).fill(4));
    expect(tooBig).toMatchObject({ ok: false, error: { code: 'disk-cap' } });
    expect((await second.seeder.putBytes(new Uint8Array(BLOCK).fill(4))).ok).toBe(true);
    expect(await second.seeder.nfx.removeVideo(v.input.video.toString())).toBe(true);
    expect(second.seeder.stats().usedBytes).toBe(BLOCK);
  });

  it('logs (redacted) and survives corrupt state files', async () => {
    const t = await tmpDir();
    cleanups.push(t.rm);
    await writeFile(path.join(t.dir, 'bans.json'), 'garbage');
    await writeFile(path.join(t.dir, 'cas-index.json'), '[]');
    const s = await make({ dataDir: t.dir });
    expect(s.log.records.filter((r) => r.level === 'error').map((r) => r.msg)).toEqual([
      'ban list on disk was unreadable; starting with an empty list',
      'CAS index on disk was unreadable; starting with an empty index',
    ]);
    expect(s.seeder.bans()).toHaveLength(0);
  });

  it('enforces the global stream cap and per-key cap at admission and emits refusals', async () => {
    const s = await make({ maxStreams: 3, maxStreamsPerKey: 1 });
    const streams = [1, 1, 2, 3, 4].map((k) => new FakeStream(noiseKey(k)));
    const admitted = streams.map((st) => s.seeder.sessions.admit(st));
    expect(admitted.map((x) => x !== null)).toEqual([true, false, true, true, false]);
    expect(streams[1]!.destroyed).toBe(true); // per-key cap
    expect(streams[4]!.destroyed).toBe(true); // global cap
    const refused = s.events.filter(
      (e): e is Extract<SeederEvent, { type: 'session-refused' }> => e.type === 'session-refused',
    );
    expect(refused.map((r) => r.reason)).toEqual(['per-key-cap', 'global-cap']);
    expect(s.seeder.stats().sessions).toBe(3);
    // releasing one slot lets the next in
    streams[2]!.destroy();
    await streams[2]!.closed();
    expect(s.seeder.stats().sessions).toBe(2);
    expect(s.seeder.sessions.admit(new FakeStream(noiseKey(4)))).not.toBeNull();
    expect(s.events.filter((e) => e.type === 'session-close')).toHaveLength(1);
  });

  it('manual ban/unban covers the engine, the sessions and disk; banned keys are refused', async () => {
    const s = await make();
    const st = new FakeStream(noiseKey(9));
    const session = s.seeder.sessions.admit(st)!;
    const pk = pubkey('manual');
    session.bindPubkey(pk);
    s.seeder.ban({ pubkey: pk, noiseKey: noiseKey(9) }, 'operator');
    expect(st.destroyed).toBe(true);
    expect(s.engine.isBanned(pk)).toBe(true);
    expect(s.seeder.bans()).toEqual([
      expect.objectContaining({ pubkey: pk, noiseKey: toHex(noiseKey(9)), reason: 'operator' }),
    ]);
    await st.closed();
    expect(s.seeder.sessions.admit(new FakeStream(noiseKey(9)))).toBeNull();
    expect(s.seeder.unban({ pubkey: pk })).toBe(true);
    expect(s.engine.isBanned(pk)).toBe(false);
    expect(s.seeder.sessions.admit(new FakeStream(noiseKey(9)))).not.toBeNull();
  });

  it('a double-spend (v5: refused at verify) bans the peer on both keys and cuts its session', async () => {
    const s = await make({ windowBlocks: 8 });
    const viewer = new mocks.MockPaymentEngine({ mode: 'double-spend' });
    const policy: PricePolicy = {
      satsPerBlock: 1 as never,
      blockSize: BLOCK,
      mints: s.engine.config.acceptedMints,
      split: { seeder: 50, creator: 50 },
      creatorP2pk: mocks.asP2pk('creator'),
    };
    s.seeder.setPolicy(policy);
    const st = new FakeStream(noiseKey(5));
    const session = s.seeder.sessions.admit(st)!;
    const protocol = new FakePayProtocol();
    s.seeder.attachPayProtocol(session, protocol);
    const pk = pubkey('ds');
    protocol.remoteHello(hello(pk));
    const core = mocks.asCoreKey('c');
    for (let i = 0; i < 8; i++) session.onUpload(core, i, BLOCK);
    const ref = {
      pubkey: s.engine.config.ownPubkey,
      p2pk: s.engine.config.ownP2pk,
      mint: policy.mints[0]!,
    };
    protocol.remotePay(await viewer.pay({ core, fromBlock: 0, toBlock: 3 }, ref, policy));
    await new Promise((r) => setTimeout(r, 0));
    protocol.remotePay(await viewer.pay({ core, fromBlock: 4, toBlock: 7 }, ref, policy));
    await new Promise((r) => setTimeout(r, 0));
    // v5: the replay is refused at verify, the engine bans and fires `onDoubleSpend`, and the
    // seeder cuts the session before the bridge can ACK it (a cut session gets no ACK).
    expect(protocol.acks.map((a) => (a.ok ? 'ok' : a.reason))).toEqual(['ok']);
    expect(st.destroyed).toBe(true);
    expect(session.cutReason).toBe('banned');
    expect(s.seeder.stats().pendingPaidBlocks).toBe(4);

    const res = await s.seeder.flushNow();
    expect(res).toMatchObject({ failed: 0, swapped: 2, nutzapped: 2 }); // 4 blocks × 1 sat, split 50/50
    expect(s.seeder.banList.isPubkeyBanned(pk)).toBe(true);
    expect(s.seeder.banList.isNoiseBanned(noiseKey(5))).toBe(true);
    const ds = s.events.find((e) => e.type === 'double-spend');
    expect(ds).toMatchObject({ peer: pk, amount: 4 });
    expect(s.events.some((e) => e.type === 'flush')).toBe(true);
    const all = s.log.lines.join('\n');
    expect(all).not.toContain('mock:');
    expect(all).toContain('double-spend');
  });

  it('setPolicy announces PRICE to live pay/1 peers — one per core on the default policy (v5: PRICE names its core) — with the old price honoured for uploaded blocks', async () => {
    const s = await make();
    const st = new FakeStream(noiseKey(6));
    const session = s.seeder.sessions.admit(st)!;
    const protocol = new FakePayProtocol();
    s.seeder.attachPayProtocol(session, protocol);
    for (let i = 0; i < 3; i++) session.onUpload('c', i, BLOCK);
    const base: PricePolicy = {
      satsPerBlock: 1 as never,
      blockSize: BLOCK,
      mints: s.engine.config.acceptedMints,
      split: { seeder: 50, creator: 50 },
      creatorP2pk: mocks.asP2pk('creator'),
    };
    s.seeder.setPolicy(base);
    s.seeder.setPolicy(base); // unchanged price: no announcement
    s.seeder.setPolicy({ ...base, satsPerBlock: 2 as never });
    expect(protocol.prices).toEqual([
      { type: 'PRICE', core: 'c', satsPerBlock: 2, effectiveFromBlock: 3 },
    ]);
    expect(s.seeder.policy().satsPerBlock).toBe(2);
  });

  it("core prices (ADR 0012; always on since the v6 amendment): the first block of each core sent to a pay/1 peer is preceded by PRICE from block 0 at that core's price, and PAYs are verified at it", async () => {
    const s = await make({ windowBlocks: 16 });
    const policy = (sats: number, who: string): PricePolicy => ({
      satsPerBlock: sats as never,
      blockSize: BLOCK,
      mints: s.engine.config.acceptedMints,
      split: { seeder: 50, creator: 50 },
      creatorP2pk: mocks.asP2pk(who),
    });
    s.seeder.setCorePolicy('a'.repeat(64) as never, policy(3, 'creator-A'), { announce: false });
    s.seeder.setCorePolicy('b'.repeat(64) as never, policy(5, 'creator-B'), { announce: false });
    const st = new FakeStream(noiseKey(9));
    const session = s.seeder.sessions.admit(st)!;
    const protocol = new FakePayProtocol();
    s.seeder.attachPayProtocol(session, protocol);
    session.onUpload('a'.repeat(64), 0, BLOCK);
    session.onUpload('a'.repeat(64), 1, BLOCK); // not the first: no second PRICE
    session.onUpload('b'.repeat(64), 7, BLOCK);
    session.onUpload('c'.repeat(64), 0, BLOCK); // no policy for it: nothing to announce
    expect(protocol.prices).toEqual([
      { type: 'PRICE', core: 'a'.repeat(64), satsPerBlock: 3, effectiveFromBlock: 0 },
      { type: 'PRICE', core: 'b'.repeat(64), satsPerBlock: 5, effectiveFromBlock: 0 },
    ]);
    expect(
      s.seeder.policyForRange(session, 'b'.repeat(64) as never, {
        core: 'b'.repeat(64) as never,
        fromBlock: 7,
        toBlock: 7,
      }).satsPerBlock,
    ).toBe(5);
    // This used to assert "off by default: a one-price seeder sends none". Cameron, 2026-09-26
    // (contracts v6 amendment, ADR 0015 amendment): every seeder sends a core's PRICE before its
    // first block, with no switch — so a one-price seeder (its price is the default policy) sends
    // it too, and the option is gone.
    const plain = await make({ windowBlocks: 16 });
    plain.seeder.setPolicy(policy(3, 'creator-A'));
    const ps = plain.seeder.sessions.admit(new FakeStream(noiseKey(10)))!;
    const pp = new FakePayProtocol();
    plain.seeder.attachPayProtocol(ps, pp);
    ps.onUpload('a'.repeat(64), 0, BLOCK);
    expect(pp.prices).toEqual([
      { type: 'PRICE', core: 'a'.repeat(64), satsPerBlock: 3, effectiveFromBlock: 0 },
    ]);
    expect('announceCorePrices' in plain.seeder.config).toBe(false);
  });

  // Security review F9: the seeder used to verify every PAY at its CURRENT price, so after a
  // price change an honest viewer's PAY for blocks sent earlier (at the old price, as the PRICE
  // promised) was `wrong-amount` — and enough of those window-cut the viewer.
  it('F9: blocks sent before a PRICE are verified at the old price, blocks after it at the new one; setCorePolicy announces per core', async () => {
    const s = await make({ windowBlocks: 16 });
    const viewer = new mocks.MockPaymentEngine({ mode: 'honest' });
    const oldP: PricePolicy = {
      satsPerBlock: 2 as never,
      blockSize: BLOCK,
      mints: s.engine.config.acceptedMints,
      split: { seeder: 50, creator: 50 },
      creatorP2pk: mocks.asP2pk('creator'),
    };
    const newP: PricePolicy = { ...oldP, satsPerBlock: 4 as never };
    const core = mocks.asCoreKey('F9');
    s.seeder.setPolicy(oldP);
    const session = s.seeder.sessions.admit(new FakeStream(noiseKey(9)))!;
    const protocol = new FakePayProtocol();
    s.seeder.attachPayProtocol(session, protocol);
    protocol.remoteHello(hello(pubkey('f9')));
    for (let i = 0; i < 3; i++) session.onUpload(core, i, BLOCK);
    s.seeder.setPolicy(newP);
    // v6 amendment: the core's price from block 0 now precedes its first block (always on), then
    // the change. (Written when only the change was announced.)
    expect(protocol.prices).toEqual([
      { type: 'PRICE', core, satsPerBlock: 2, effectiveFromBlock: 0 },
      { type: 'PRICE', core, satsPerBlock: 4, effectiveFromBlock: 3 },
    ]);
    for (let i = 3; i < 6; i++) session.onUpload(core, i, BLOCK);
    const ref = {
      pubkey: s.engine.config.ownPubkey,
      p2pk: s.engine.config.ownP2pk,
      mint: oldP.mints[0]!,
    };
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    // Old blocks at the NEW price: refused (the promise was the old price).
    protocol.remotePay(
      await viewer.pay({ core, fromBlock: 0, toBlock: 2 }, ref, newP, { carryIn: 0 }),
    );
    await tick();
    // Old blocks at the old price, new blocks at the new price: both accepted.
    protocol.remotePay(
      await viewer.pay({ core, fromBlock: 0, toBlock: 2 }, ref, oldP, { carryIn: 0 }),
    );
    await tick();
    protocol.remotePay(
      await viewer.pay({ core, fromBlock: 3, toBlock: 5 }, ref, newP, { carryIn: 0 }),
    );
    await tick();
    expect(protocol.acks.map((a) => (a.ok ? 'ok' : a.reason))).toEqual(['overpay', 'ok', 'ok']);
    expect(s.seeder.policyForRange(session, core, { core, fromBlock: 0, toBlock: 2 })).toBe(oldP);
    expect(s.seeder.policyForRange(session, core, { core, fromBlock: 3, toBlock: 5 })).toBe(newP);

    // A per-core policy change announces a PRICE for that core only.
    const other = mocks.asCoreKey('F9-other');
    session.onUpload(other, 0, BLOCK);
    // v6 amendment: `other`'s own first block was announced (at the default price, from 0)…
    expect(protocol.prices.filter((p) => p.core === other)).toEqual([
      { type: 'PRICE', core: other, satsPerBlock: 4, effectiveFromBlock: 0 },
    ]);
    s.seeder.setCorePolicy(core, { ...newP, satsPerBlock: 6 as never });
    expect(protocol.prices.at(-1)).toEqual({
      type: 'PRICE',
      core,
      satsPerBlock: 6,
      effectiveFromBlock: 6,
    });
    // …and the per-core change of `core` adds nothing for `other`.
    expect(protocol.prices.filter((p) => p.core === other)).toHaveLength(1);
  });

  it('v3 (c): setCorePolicy adds a per-core policy the pay bridge resolves by range.core; setPolicy stays the default', async () => {
    const s = await make({ windowBlocks: 16 });
    const viewer = new mocks.MockPaymentEngine({ mode: 'honest' });
    const base: PricePolicy = {
      satsPerBlock: 2 as never,
      blockSize: BLOCK,
      mints: s.engine.config.acceptedMints,
      split: { seeder: 50, creator: 50 },
      creatorP2pk: mocks.asP2pk('creator-A'),
    };
    const forB: PricePolicy = {
      ...base,
      satsPerBlock: 6 as never,
      creatorP2pk: mocks.asP2pk('creator-B'),
    };
    const coreA = mocks.asCoreKey('A');
    const coreB = mocks.asCoreKey('B');
    s.seeder.setPolicy(base);
    s.seeder.setCorePolicy(coreB, forB);
    expect(s.seeder.policyFor(coreA)).toBe(base);
    expect(s.seeder.policyFor(coreB)).toBe(forB);
    expect(s.seeder.policyFor()).toBe(base);
    expect([...s.seeder.corePolicyMap().keys()]).toEqual([coreB]);

    const st = new FakeStream(noiseKey(7));
    const session = s.seeder.sessions.admit(st)!;
    const protocol = new FakePayProtocol();
    s.seeder.attachPayProtocol(session, protocol);
    protocol.remoteHello(hello(pubkey('pc')));
    for (let i = 0; i < 2; i++) session.onUpload(coreA, i, BLOCK);
    for (let i = 0; i < 2; i++) session.onUpload(coreB, i, BLOCK);
    const ref = {
      pubkey: s.engine.config.ownPubkey,
      p2pk: s.engine.config.ownP2pk,
      mint: base.mints[0]!,
    };
    // B at the default price → refused under B's policy; B at B's price → ok; A at default → ok.
    protocol.remotePay(await viewer.pay({ core: coreB, fromBlock: 0, toBlock: 1 }, ref, base));
    await new Promise((r) => setTimeout(r, 0));
    protocol.remotePay(await viewer.pay({ core: coreB, fromBlock: 0, toBlock: 1 }, ref, forB));
    await new Promise((r) => setTimeout(r, 0));
    protocol.remotePay(await viewer.pay({ core: coreA, fromBlock: 0, toBlock: 1 }, ref, base));
    await new Promise((r) => setTimeout(r, 0));
    // and a core-less PAY is malformed (v5: on any session)
    const named = await viewer.pay({ core: coreA, fromBlock: 0, toBlock: 1 }, ref, base, {
      carryIn: 0,
    });
    const { core: _core, ...coreless } = named.range;
    protocol.remotePay({ ...named, range: coreless } as unknown as typeof named);
    await new Promise((r) => setTimeout(r, 0));
    expect(protocol.acks.map((a) => (a.ok ? 'ok' : a.reason))).toEqual([
      'wrong-p2pk-target',
      'ok',
      'ok',
      'malformed',
    ]);
    expect(s.seeder.stats().pendingPaidBlocks).toBe(4);

    // clearing the override falls back to the default
    s.seeder.setCorePolicy(coreB, null);
    expect(s.seeder.policyFor(coreB)).toBe(base);
    expect(s.seeder.corePolicyMap().size).toBe(0);
  });

  // Security review F27, hit by the real-mint lane: a viewer reconnected while its old connection
  // lingered, the new session's rebind reset the per-pubkey carry, and every PAY still arriving
  // on the old channel failed `carryIn`. The newest channel of a pubkey now wins.
  it('a second live session binding the same pubkey supersedes the first: it is cut without a ban', async () => {
    const s = await make();
    const pk = pubkey('reconnecting');
    const oldStream = new FakeStream(noiseKey(21));
    const first = s.seeder.sessions.admit(oldStream)!;
    expect(first.bindPubkey(pk)).toBe(true);
    const second = s.seeder.sessions.admit(new FakeStream(noiseKey(22)))!;
    expect(second.bindPubkey(pk)).toBe(true);
    expect(first.cutReason).toBe('local');
    expect(oldStream.destroyed).toBe(true);
    expect(second.cutReason).toBeNull();
    expect(s.seeder.banList.isPubkeyBanned(pk)).toBe(false);
    // Another pubkey's session is untouched.
    const other = s.seeder.sessions.admit(new FakeStream(noiseKey(23)))!;
    expect(other.bindPubkey(pubkey('someone-else'))).toBe(true);
    expect(second.cutReason).toBeNull();
  });

  it('onSessionReady: a direct replication stream is reported once admitted, with its Protomux; a refused one never; unsubscribe stops it', async () => {
    const a = await make({ maxStreams: 1 });
    const b = await make();
    const ready: { mux: boolean; noise: string }[] = [];
    const off = a.seeder.onSessionReady((session) => {
      ready.push({ mux: session.mux !== null, noise: session.noiseKeyHex });
    });
    const pipe = async () => {
      const x = a.seeder.replicate(true);
      const y = b.seeder.replicate(false);
      x.on('error', () => undefined);
      y.on('error', () => undefined);
      x.pipe(y).pipe(x);
      await y.noiseStream.opened;
      await new Promise((r) => setTimeout(r, 30));
      return { x, y };
    };
    const first = await pipe();
    expect(ready).toEqual([{ mux: true, noise: toHex(first.y.noiseStream.publicKey!) }]);
    // Over the global stream cap: refused at admission, never reported ready.
    await pipe();
    expect(a.events.some((e) => e.type === 'session-refused')).toBe(true);
    expect(ready).toHaveLength(1);

    // A listener that throws is contained (logged), not propagated into admission.
    a.seeder.onSessionReady(() => {
      throw new Error('listener bug');
    });
    off();
    first.x.destroy();
    await new Promise((r) => setTimeout(r, 30));
    await pipe();
    expect(a.seeder.sessions.size).toBe(1); // admitted…
    expect(ready).toHaveLength(1); // …but the unsubscribed listener heard nothing
    expect(a.log.lines.some((l) => l.includes('session-ready listener threw'))).toBe(true);
  });

  // Fix round 4 (cross-lane review, MEDIUM): the upload gate was attached only when no gate was
  // recorded for the core's KEY, and `closeCoreByKey` never removed that record — a closed session
  // leaves the core's monitors, so a core reopened by key served every block with no
  // `recordUpload`, no window cut and no PRICE (and every PAY for it was then refused).
  it('a core closed by closeCoreByKey and reopened by key gets its upload gate back: every open is gated', async () => {
    const s = await make({ windowBlocks: 8 });
    const key = new Uint8Array(32).fill(0x42);
    const peer = (k: number) => {
      const stream = new FakeStream(noiseKey(k));
      return { remotePublicKey: noiseKey(k), stream };
    };
    const first = await s.seeder.blobs.openCoreByKey(key);
    expect(first.core.listenerCount('upload')).toBe(1);
    await s.seeder.blobs.closeCoreByKey(first.keyHex);
    const again = await s.seeder.blobs.openCoreByKey(key);
    expect(again.core).not.toBe(first.core);
    expect(again.core.listenerCount('upload')).toBe(1);
    // …and it records what it serves.
    const p = peer(31);
    again.core.emit('upload', 0, BLOCK, p);
    expect(s.engine.window(toHex(noiseKey(31)) as never)?.uploaded).toBe(1);
    // A second open of the same (still open) core does not gate it twice.
    expect((await s.seeder.blobs.openCoreByKey(key)).core.listenerCount('upload')).toBe(1);
  });

  // Fix round 4 (cross-lane review, MEDIUM): an image read naming a paid core marked it free on
  // our own seeder, so every peer downloaded that video from us free and was never cut.
  it('setFreeCore refuses a core with its own price policy, and setCorePolicy clears the free flag', async () => {
    const s = await make();
    const priced = 'a1'.repeat(32) as never;
    const profile = 'b2'.repeat(32) as never;
    const policy: PricePolicy = {
      satsPerBlock: 2 as never,
      blockSize: BLOCK,
      mints: [mocks.MINTS.a],
      split: { seeder: 50, creator: 50 },
      creatorP2pk: mocks.asP2pk('creator'),
    };
    s.seeder.setCorePolicy(priced, policy);
    expect(s.seeder.setFreeCore(priced, true)).toBe(false);
    expect(s.seeder.isFreeCore(priced)).toBe(false);
    expect(s.seeder.setFreeCore(profile, true)).toBe(true);
    expect(s.seeder.isFreeCore(profile)).toBe(true);
    s.seeder.setCorePolicy(profile, policy); // a price for it now: sold, never free
    expect(s.seeder.isFreeCore(profile)).toBe(false);
    s.seeder.setCorePolicy(profile, null);
    expect(s.seeder.setFreeCore(profile, true)).toBe(true); // no policy any more: may be free
    expect(s.seeder.setFreeCore(profile, false)).toBe(true);
    expect(s.seeder.isFreeCore(profile)).toBe(false);
  });

  // Lane W8b-p2p (round-8 review, MEDIUM): per-core prices lived in memory only. After a restart
  // nothing priced a core this node had sold (an upload, a played video still in its store), so
  // the desktop's image path could mark it free on our own seeder — an attacker's thumbnail URL
  // naming our video, and every viewer downloaded it from us without paying.
  it('per-core policies are kept across a restart: a core sold before it stays sold — never free, priced as before', async () => {
    const policy: PricePolicy = {
      satsPerBlock: 3 as never,
      blockSize: BLOCK,
      mints: [mocks.MINTS.a],
      split: { seeder: 60, creator: 40 },
      creatorP2pk: mocks.asP2pk('creator'),
      minPaySats: 12 as never,
    };
    const sold = 'a1'.repeat(32) as never;
    const other = 'a2'.repeat(32) as never;
    const first = await make();
    const dataDir = first.seeder.config.dataDir;
    first.seeder.setCorePolicy(sold, policy);
    first.seeder.setCorePolicy(other, { ...policy, satsPerBlock: 1 as never });
    first.seeder.setCorePolicy(other, null); // forgotten: not kept either
    await first.seeder.close();
    const second = await make({ dataDir });
    expect([...second.seeder.corePolicyMap()]).toEqual([[sold, policy]]);
    expect(second.seeder.policyFor(sold)).toEqual(policy);
    // The attacker's thumbnail after the restart: our video is never marked free.
    expect(second.seeder.setFreeCore(sold, true)).toBe(false);
    expect(second.seeder.isFreeCore(sold)).toBe(false);
    expect(second.seeder.setFreeCore(other, true)).toBe(true); // no policy: may be free
    // A new price is kept too, and a cleared one is gone after the next restart.
    second.seeder.setCorePolicy(sold, null);
    await second.seeder.close();
    const third = await make({ dataDir });
    expect(third.seeder.corePolicyMap().size).toBe(0);
  });

  it('the policy file is checked on load: malformed entries are dropped (warned), a file that does not parse starts empty (logged)', async () => {
    const t = await tmpDir();
    cleanups.push(t.rm);
    const good = {
      satsPerBlock: 2,
      blockSize: BLOCK,
      mints: [mocks.MINTS.a],
      split: { seeder: 50, creator: 50 },
      creatorP2pk: mocks.asP2pk('creator'),
    };
    await writeFile(
      path.join(t.dir, 'core-policies.json'),
      JSON.stringify({
        version: 1,
        cores: [
          { core: 'b1'.repeat(32), policy: good },
          { core: 'not-a-key', policy: good },
          { core: 'b2'.repeat(32), policy: { ...good, satsPerBlock: -1 } },
          { core: 'b3'.repeat(32), policy: { ...good, split: { seeder: 70, creator: 70 } } },
          { core: 'b4'.repeat(32), policy: { ...good, mints: 'one' } },
        ],
      }),
    );
    const s = await make({ dataDir: t.dir });
    expect([...s.seeder.corePolicyMap().keys()]).toEqual(['b1'.repeat(32)]);
    expect(
      s.log.records.some((r) => r.msg === 'malformed core policies on disk were dropped'),
    ).toBe(true);
    await s.seeder.close();
    const u = await tmpDir();
    cleanups.push(u.rm);
    await writeFile(path.join(u.dir, 'core-policies.json'), '{ nope');
    const s2 = await make({ dataDir: u.dir });
    expect(s2.seeder.corePolicyMap().size).toBe(0);
    expect(s2.log.records.filter((r) => r.level === 'error').map((r) => r.msg)).toEqual([
      'core policies on disk were unreadable; starting with none',
    ]);
  });

  // Lane W8b-p2p (round-8 review, info): the desktop's own profile core was marked free only after
  // its open returned — after its upload gate was attached and its terms said to peers that paired
  // while it opened (silence, then `free`). Opened `free`, it is free from the moment it is ready.
  it('openCore(name, { free: true }): free before its upload gate is attached; never for a core with a price', async () => {
    const s = await make();
    const atGate: boolean[] = [];
    const attach = s.seeder.sessions.attachUploadGate.bind(s.seeder.sessions);
    s.seeder.sessions.attachUploadGate = (core) => {
      atGate.push(s.seeder.isFreeCore(toHex(core.key) as never));
      return attach(core);
    };
    const sc = await s.seeder.openCore('profile', { free: true });
    expect(atGate).toEqual([true]);
    expect(s.seeder.isFreeCore(sc.keyHex)).toBe(true);
    // Idempotent; and a core that has a price is never made free by it.
    expect(await s.seeder.openCore('profile', { free: true })).toBe(sc);
    const video = await s.seeder.openCore('video');
    expect(s.seeder.isFreeCore(video.keyHex)).toBe(false);
    s.seeder.setCorePolicy(video.keyHex, {
      satsPerBlock: 2 as never,
      blockSize: BLOCK,
      mints: [mocks.MINTS.a],
      split: { seeder: 50, creator: 50 },
      creatorP2pk: mocks.asP2pk('creator'),
    });
    await s.seeder.openCore('video', { free: true });
    expect(s.seeder.isFreeCore(video.keyHex)).toBe(false);
  });

  it('policy() throws until configured; close() is idempotent and flushes', async () => {
    const s = await make();
    expect(() => s.seeder.policy()).toThrow(/PricePolicy/);
    await s.seeder.close();
    await s.seeder.close();
    expect(s.engine.log.filter((l) => l.kind === 'flush')).toHaveLength(1);
  });
});
