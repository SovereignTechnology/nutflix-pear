/**
 * `OnePeerRouter` (security review F33, issue #8) on real Corestores over directly piped
 * replication streams — no swarm, nothing leaves the process.
 *
 * The first block PINS the hypercore internals the router reaches into (it was written against
 * hypercore 11.40.3): the version, the objects and fields, and the lines of `lib/replicator.js`
 * whose order the router depends on. If any of it moves, these fail loudly — re-verify
 * `net/one-peer.ts` against the new release before touching the pin.
 *
 * The rest proves the behaviour: three full seeders racing for the same blocks deliver each block
 * ONCE; per-peer budgets hold whatever hypercore picks; a stalled request moves to ONE other peer
 * after `stallMs` (never two at once); a seeder that disconnects mid-range has its blocks
 * re-requested from the others, each block still delivered once.
 */
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';

import Corestore from 'corestore';
import { afterEach, describe, expect, it } from 'vitest';

import { silentLogger } from '../log/logger.js';
import {
  OnePeerRouter,
  ROUTED_HYPERCORE_VERSION,
  RoutingUnsupported,
  STALL_HARD_FACTOR,
  UNCAPPED,
  isRoutablePeer,
  routableReplicator,
} from '../net/one-peer.js';
import type { PeerBudget, RoutableCore } from '../net/one-peer.js';
import { toHex } from '../util/hex.js';
import { tmpDir } from './helpers.js';

const require = createRequire(import.meta.url);
const BLOCK = 1024;

/** The parts of a hypercore session (and its internals) these tests touch. */
interface RawPeer {
  readonly remotePublicKey: Uint8Array;
  readonly inflight: number;
  readonly dataProcessing: number;
  readonly stats: { readonly wireCancel: { readonly tx: number }; readonly hotswaps: number };
  getMaxInflight(): number;
}
interface RawCore extends RoutableCore {
  readonly length: number;
  readonly peers: readonly RawPeer[];
  readonly replicator: { readonly stats: { readonly hotswaps: number }; updateAll?(): void };
  ready(): Promise<void>;
  append(blocks: Uint8Array[]): Promise<unknown>;
  get(index: number, opts?: { timeout?: number }): Promise<Uint8Array | null>;
  update(opts: { wait: boolean }): Promise<boolean>;
  download(range: { start: number; end: number }): { done(): Promise<void> };
  on(event: 'download' | 'upload', cb: (index: number, bytes: number, peer: RawPeer) => void): this;
  on(event: 'peer-add' | 'peer-remove', cb: (peer: never) => void): this;
  off(event: 'peer-add' | 'peer-remove', cb: (peer: never) => void): this;
  off(event: 'download', cb: (index: number, bytes: number, peer: RawPeer) => void): this;
}
interface RawStream {
  readonly noiseStream: { readonly opened: Promise<boolean>; readonly remotePublicKey: Uint8Array };
  pipe<T>(dest: T): T;
  on(event: 'error', cb: () => void): unknown;
  destroy(): void;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_r, reject) => {
      setTimeout(() => {
        reject(new Error(`still pending after ${String(ms)} ms`));
      }, ms);
    }),
  ]);
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

async function store(): Promise<Corestore> {
  const t = await tmpDir('nutflix-one-peer-');
  const s = new Corestore(t.dir);
  cleanups.push(async () => {
    await s.close();
    await t.rm();
  });
  return s;
}

function coreOf(s: Corestore, opts: { name?: string; key?: Uint8Array }): RawCore {
  return s.get(opts) as unknown as RawCore;
}

/**
 * Pipe `seeder` → `viewer`. `hold()` withholds everything the seeder sends from then on (a peer
 * that took our requests and answers none of them), `release()` lets it through, and
 * `releaseSlowly(ms)` lets it through one message every `ms` from now on (a slow link: the seeder
 * keeps delivering, each request waits behind the ones before it).
 */
function connect(seeder: Corestore, viewer: Corestore) {
  const a = seeder.replicate(true) as unknown as RawStream;
  const b = viewer.replicate(false) as unknown as RawStream;
  a.on('error', () => undefined);
  b.on('error', () => undefined);
  let held = false;
  let slowMs = 0;
  let nextAt = 0;
  const queued: Buffer[] = [];
  const later = (chunk: Buffer): void => {
    nextAt = Math.max(Date.now(), nextAt + slowMs);
    setTimeout(() => gate.push(chunk), nextAt - Date.now());
  };
  const gate = new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      if (held) queued.push(chunk);
      else if (slowMs > 0) later(chunk);
      else {
        cb(null, chunk);
        return;
      }
      cb();
    },
  });
  a.pipe(gate).pipe(b as unknown as NodeJS.WritableStream);
  b.pipe(a);
  return {
    remote: async (): Promise<string> => {
      await b.noiseStream.opened;
      return toHex(b.noiseStream.remotePublicKey);
    },
    hold: (): void => {
      held = true;
    },
    release: (): void => {
      held = false;
      for (const c of queued.splice(0)) gate.push(c);
    },
    releaseSlowly: (ms: number): void => {
      held = false;
      slowMs = ms;
      nextAt = Date.now() - ms;
      for (const c of queued.splice(0)) later(c);
    },
    destroy: (): void => {
      a.destroy();
      b.destroy();
    },
  };
}

interface World {
  readonly viewer: RawCore;
  /** The seeders' stores (index = seeder) and the viewer's, to connect again. */
  readonly stores: Corestore[];
  readonly viewerStore: Corestore;
  readonly remotes: string[];
  readonly links: ReturnType<typeof connect>[];
  /** Blocks each seeder sent the viewer (its `upload` events), by seeder index. */
  readonly uploads: number[];
  /** Every `download` the viewer saw: block index and the remote it came from. */
  readonly downloads: { readonly index: number; readonly from: string }[];
}

/**
 * An origin with `n` blocks, `seeders − 1` full mirrors, a viewer connected to all of them and
 * synced (it knows the length; nothing downloaded yet). Tests route the viewer afterwards.
 */
async function world(n: number, seeders: number, blockSize = BLOCK): Promise<World> {
  const origin = await store();
  const oc = coreOf(origin, { name: 'video' });
  await oc.ready();
  await oc.append(Array.from({ length: n }, (_, i) => new Uint8Array(blockSize).fill(i % 251)));
  const stores = [origin];
  for (let i = 1; i < seeders; i++) {
    const s = await store();
    const c = coreOf(s, { key: oc.key });
    await c.ready();
    const l = connect(origin, s);
    await c.download({ start: 0, end: n }).done();
    l.destroy();
    stores.push(s);
  }
  const vs = await store();
  const viewer = coreOf(vs, { key: oc.key });
  await viewer.ready();
  const uploads = stores.map(() => 0);
  const downloads: { index: number; from: string }[] = [];
  viewer.on('download', (index, _b, peer) => {
    downloads.push({ index, from: toHex(peer.remotePublicKey) });
  });
  const links: ReturnType<typeof connect>[] = [];
  const remotes: string[] = [];
  for (const [i, s] of stores.entries()) {
    const c = coreOf(s, { key: oc.key });
    await c.ready();
    c.on('upload', () => {
      uploads[i] = (uploads[i] ?? 0) + 1;
    });
    const l = connect(s, vs);
    links.push(l);
    remotes.push(await l.remote());
  }
  await until(() => viewer.peers.length === seeders, 10_000, 'every seeder to join the core');
  await viewer.update({ wait: true });
  return { viewer, stores, viewerStore: vs, remotes, links, uploads, downloads };
}

function perIndex(downloads: readonly { index: number }[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const d of downloads) m.set(d.index, (m.get(d.index) ?? 0) + 1);
  return m;
}

const unlimited: PeerBudget = () => UNCAPPED;

function routed(
  viewer: RawCore,
  o: Omit<ConstructorParameters<typeof OnePeerRouter>[0], 'logger'>,
): OnePeerRouter {
  const router = new OnePeerRouter({ ...o, logger: silentLogger });
  cleanups.push(() => {
    router.close();
    return Promise.resolve();
  });
  router.attachCore(viewer);
  return router;
}

describe('hypercore internals the router relies on (pinned)', () => {
  it(`is hypercore ${ROUTED_HYPERCORE_VERSION} — re-verify net/one-peer.ts before moving this pin`, () => {
    const pkg = require('hypercore/package.json') as { version: string };
    expect(pkg.version).toBe(ROUTED_HYPERCORE_VERSION);
  });

  it('the replicator, its hotswap queue and its Peer have the members the router uses', async () => {
    const w = await world(4, 2);
    const rep = routableReplicator(w.viewer); // throws RoutingUnsupported otherwise
    expect(rep.peers).toHaveLength(2);
    for (const p of w.viewer.peers) {
      expect(isRoutablePeer(p)).toBe(true);
      expect(w.remotes).toContain(toHex(p.remotePublicKey));
    }
  });

  it('lib/replicator.js still does, in this order, what the router depends on', () => {
    const Replicator = require('hypercore/lib/replicator.js') as {
      prototype: Record<string, (...a: unknown[]) => unknown>;
      Peer: { prototype: Record<string, (...a: unknown[]) => unknown> };
    };
    const src = (f: unknown): string => String(f).replace(/\s+/g, ' ');
    const R = Replicator.prototype;
    const P = Replicator.Peer.prototype;
    // (1) The ONLY second-peer path: the hotswap step iterates `hotswaps.pick(peer)`.
    expect(src(R['_updateHotswap'])).toContain('for (const b of this.hotswaps.pick(peer))');
    // … and runs only from `updatePeer`, the method the failover ticker calls.
    expect(src(R['updatePeer'])).toContain('this._updateHotswap(peer)');
    expect(src(R['updateAll'])).not.toContain('_updateHotswap');
    // (2) A block request is pushed to `inflight`, THEN the queue's `add` runs, THEN it is sent:
    // `NoRaceQueue.add` sees the replacement request and cancels the stalled one before it goes.
    expect(src(P['_sendBlockRequest'])).toMatch(
      /b\.inflight\.push\(req\) this\.replicator\.hotswaps\.add\(b\) this\._send\(req\)/,
    );
    // (3) Every request is gated on `inflight >= getMaxInflight()` (the per-peer credit cap).
    for (const m of ['_updatePeer', '_updatePeerNonPrimary'])
      expect(src(R[m])).toContain('peer.inflight >= peer.getMaxInflight()');
    // … and a queued `get` is taken by one peer; a range block is skipped while one is in flight.
    // (11.40: a stale `queued === false` entry is dropped and the walk goes on, where 11.35 ended
    // the walk on it; either way a block is requested only through `peer._requestBlock(b)`.)
    expect(src(R['_updatePeer'])).toContain(
      'if (b.queued === false) { blks.dequeue() continue } if (peer._requestBlock(b) === true) {',
    );
    expect(src(P['_requestRangeBlock'])).toContain('if (b.inflight.length > 0)');
    // The one other path that sends a block request without that check is off by default.
    expect(src(P['_includeLastBlock'])).toContain(
      'if (this.replicator._alwaysLatestBlock === 0) return null',
    );
    // (4) `inflight` rises before the wire send; `dataProcessing` spans the verify; the download
    // event (where the payer counts the block as owed) runs after it drops, before `updatePeer`.
    expect(src(P['_send'])).toMatch(/this\.inflight\+\+ this\.replicator\._inflight\.add\(req\)/);
    expect(src(P['_handleData'])).toMatch(
      /this\.dataProcessing\+\+[\s\S]*this\.dataProcessing--[\s\S]*this\.replicator\._ondata\(this, req, data\)/,
    );
    expect(src(R['_ondata'])).toMatch(/this\._ondownload\([\s\S]*this\.updatePeer\(peer\)/);
    // (5) A cancel is counted per peer, and cancelled/answered requests carry priority 255.
    expect(src(P['_cancelRequest'])).toContain('incrementTx(this.stats.wireCancel');
    expect(src(P['_cancelRequest'])).toContain('req.priority = PRIORITY.CANCELLED');
    // (6) A new peer is announced (`peer-add`) in the same call that makes it schedulable, and a
    // removed one after its requests are cleared (their count still on `inflight`).
    expect(src(R['_addPeer'])).toMatch(
      /this\.peers\.push\(peer\)[\s\S]*this\._onpeerupdate\(true, peer\)/,
    );
    expect(src(R['_removePeer'])).toMatch(
      /this\._clearRequest\(peer, req\)[\s\S]*this\._onpeerupdate\(false, peer\)/,
    );
  });

  it('PRIORITY.CANCELLED is 255', async () => {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(require.resolve('hypercore/lib/replicator.js'), 'utf8');
    expect(text).toMatch(/CANCELLED: 255/);
  });
});

describe('OnePeerRouter', () => {
  it('F33: three full seeders racing for 48 blocks deliver each block ONCE (plain hypercore races them)', async () => {
    const N = 48;
    // Video-sized blocks: small ones are answered before a raced duplicate can leave the seeder.
    const SIZE = 65_536;
    // Before: plain hypercore. Its hotswap asks idle peers for blocks in flight elsewhere.
    const legacy = await world(N, 3, SIZE);
    await Promise.all(Array.from({ length: N }, (_, i) => legacy.viewer.get(i)));
    await sleep(200);
    // After: routed (no budget: this is about racing alone).
    const after = await world(N, 3, SIZE);
    const r = routed(after.viewer, { budget: unlimited });
    await Promise.all(Array.from({ length: N }, (_, i) => after.viewer.get(i)));
    await sleep(200);
    expect(after.viewer.replicator.stats.hotswaps).toBe(0);
    expect(r.stats()).toMatchObject({ failovers: 0, raced: 0 });
    expect(after.downloads).toHaveLength(N);
    expect([...perIndex(after.downloads).values()].every((c) => c === 1)).toBe(true);
    // What the seeders count is what the viewer received: nothing sent twice.
    expect(after.uploads.reduce((a, b) => a + b, 0)).toBe(N);
    // The same setup DOES race without the router (hypercore 11.35.3 races dozens of requests on
    // every run; how many duplicates get delivered depends on timing, 7–19 of 48 measured).
    expect(
      legacy.viewer.replicator.stats.hotswaps,
      'plain hypercore raced nothing',
    ).toBeGreaterThan(0);
    expect(legacy.uploads.reduce((a, b) => a + b, 0)).toBe(legacy.downloads.length);
  });

  it('issue #8: no peer ever holds more unpaid blocks than its budget, whatever hypercore picks', async () => {
    const N = 40;
    const windows = [1, 3, 6];
    const owed = new Map<string, number>();
    const w = await world(N, 3);
    const r = routed(w.viewer, {
      // Its credit: its window less what it delivered that is not "paid" yet.
      budget: (remote) => {
        const i = w.remotes.indexOf(remote);
        return i === -1 ? 0 : (windows[i] ?? 0) - (owed.get(remote) ?? 0);
      },
    });
    // "Pay" every block 15 ms after it lands; the seeder side counts sent − paid.
    const paid = w.remotes.map(() => 0);
    const worst = w.remotes.map(() => 0);
    w.viewer.on('download', (_i, _b, peer) => {
      const remote = toHex(peer.remotePublicKey);
      owed.set(remote, (owed.get(remote) ?? 0) + 1);
      setTimeout(() => {
        owed.set(remote, (owed.get(remote) ?? 1) - 1);
        const k = w.remotes.indexOf(remote);
        paid[k] = (paid[k] ?? 0) + 1;
        r.refresh();
      }, 15);
    });
    const sample = setInterval(() => {
      for (let k = 0; k < worst.length; k++)
        worst[k] = Math.max(worst[k] ?? 0, (w.uploads[k] ?? 0) - (paid[k] ?? 0));
    }, 1);
    try {
      await Promise.all(Array.from({ length: N }, (_, i) => w.viewer.get(i)));
    } finally {
      clearInterval(sample);
    }
    expect(w.downloads).toHaveLength(N);
    expect([...perIndex(w.downloads).values()].every((c) => c === 1)).toBe(true);
    for (let k = 0; k < windows.length; k++)
      expect(worst[k], `seeder ${String(k)} (window ${String(windows[k])})`).toBeLessThanOrEqual(
        windows[k] ?? 0,
      );
    // Every seeder took part (a budget of 1 is slow, not starved).
    for (const u of w.uploads) expect(u).toBeGreaterThan(0);
  });

  it('a stalled request moves to ONE other seeder after stallMs — never raced, the stalled one cancelled', async () => {
    const STALL = 400;
    let open = new Set<string>();
    const failovers: string[] = [];
    const w = await world(4, 3);
    const r = routed(w.viewer, {
      budget: (remote) => (open.has(remote) ? 4 : 0),
      stallMs: STALL,
      onFailover: (remote) => failovers.push(remote),
    });
    const [stalledRemote] = w.remotes;
    const stalledLink = w.links[0]!;
    // Only seeder 0 may be asked; it takes the request and never answers.
    stalledLink.hold();
    open = new Set([stalledRemote!]);
    r.refresh();
    const got = w.viewer.get(2);
    await until(() => w.uploads[0] === 1, 5000, 'seeder 0 to send block 2 into the void');
    // Everyone may be asked now — hypercore alone would race block 2 at once.
    open = new Set(w.remotes);
    r.refresh();
    await sleep(STALL / 4);
    expect(w.uploads[1]! + w.uploads[2]!, 'raced before stallMs').toBe(0);
    expect(r.used(stalledRemote!)).toBe(1); // the stalled request counts against seeder 0
    // After stallMs: moved to one other seeder, and the stalled request cancelled.
    expect(await got).not.toBeNull();
    expect(w.uploads[1]! + w.uploads[2]!).toBe(1);
    expect(failovers).toEqual([stalledRemote]);
    expect(r.stats().failovers).toBe(1);
    expect(w.downloads).toHaveLength(1);
    expect(w.downloads[0]!.from).not.toBe(stalledRemote);
    // Seeder 0 did send it: it counts it as ours for good, and so do we.
    expect(r.debt(stalledRemote!)).toBe(1);
    expect(r.used(stalledRemote!)).toBe(1);
    // Until it delivers again, a stalled seeder gets ONE request at a time (its budget would allow
    // three more): a withholding peer cannot take a fresh batch after every failover.
    expect(r.isStalled(stalledRemote!)).toBe(true);
    open = new Set([stalledRemote!]);
    r.refresh();
    const more = [w.viewer.get(0), w.viewer.get(3)];
    await until(() => (w.uploads[0] ?? 0) >= 2, 3000, 'one more request to seeder 0');
    await sleep(100);
    expect(w.uploads[0]).toBe(2);
    expect(r.inflight(stalledRemote!)).toBe(1);
    // It answers at last: its late block 2 is dropped (still one delivery of it), the new one
    // lands, and the limit lifts.
    stalledLink.release();
    await Promise.all(more);
    expect(r.isStalled(stalledRemote!)).toBe(false);
    expect(w.downloads.filter((d) => d.index === 2)).toHaveLength(1);
    expect(w.downloads).toHaveLength(3);
  });

  // Fix round 4 (test lens, INFO): the end-to-end "never raced" cases never consulted the hotswap
  // queue — each seeder's credit was always full, so hypercore had no spare peer to race with —
  // and a queue that offered every in-flight block at once stayed green there. Here a seeder with
  // SPARE capacity sits beside one withholding the blocks it was asked: hypercore consults the
  // queue for the spare peer on every pass, and nothing may be asked of it before stallMs.
  it('a spare seeder beside one holding blocks in flight: the queue is consulted and races nothing (each block sent once, no failover before stallMs)', async () => {
    const N = 8;
    const w = await world(N, 2);
    const r = routed(w.viewer, { budget: unlimited, stallMs: 60_000 });
    const holder = w.links[0]!;
    holder.hold();
    const gets = Array.from({ length: N }, (_, i) => w.viewer.get(i));
    await until(() => (w.uploads[0] ?? 0) > 0, 5000, 'seeder 0 to take requests');
    // Seeder 1 has spare capacity the whole time: hypercore runs the hotswap step for it.
    for (let i = 0; i < 10; i++) {
      w.viewer.replicator.updateAll?.();
      await sleep(30);
    }
    const held = w.uploads[0] ?? 0;
    expect(held).toBeGreaterThan(0);
    holder.release();
    await Promise.all(gets);
    await sleep(100);
    expect(r.stats()).toMatchObject({ failovers: 0, raced: 0 });
    expect(w.downloads).toHaveLength(N);
    expect([...perIndex(w.downloads).values()].every((c) => c === 1)).toBe(true);
    // Nothing was asked twice: what the seeders sent is what the viewer received.
    expect((w.uploads[0] ?? 0) + (w.uploads[1] ?? 0)).toBe(N);
  });

  // Lane P2-owed-viewer (ADR 0018 amendment): until a seeder's pay/1 report of what it still counts
  // for us is in, it is asked ONE block at a time (`SeederCredit`'s `single`). This replaces the
  // fix-round-4 `probe` option and its test (ADR 0015 amendment 2026-09-26: an image read no longer
  // probes — it asks only a seeder that said `free`); the narrow cap it pinned is the same.
  it('the single option: a peer awaiting its report is asked ONE block at a time, within its credit; a throwing predicate narrows; off again, it pipelines', async () => {
    let single: () => boolean = () => true;
    const w = await world(12, 1);
    const r = routed(w.viewer, { budget: () => 8, single: () => single() });
    const peer = w.viewer.peers[0]!;
    const remote = w.remotes[0]!;
    // The sync's last message may still be being verified (it counts as `dataProcessing`).
    await until(() => peer.inflight + peer.dataProcessing === 0, 5000, 'the sync to settle');
    expect(peer.getMaxInflight()).toBe(1);
    let worst = 0;
    const sample = setInterval(() => {
      worst = Math.max(worst, (w.uploads[0] ?? 0) - w.downloads.length);
    }, 1);
    try {
      await Promise.all(Array.from({ length: 6 }, (_, i) => w.viewer.get(i)));
    } finally {
      clearInterval(sample);
    }
    expect(w.downloads).toHaveLength(6);
    expect(worst).toBeLessThanOrEqual(1);
    single = () => {
      throw new Error('ledger bug');
    };
    expect(peer.getMaxInflight()).toBe(peer.inflight + 1);
    single = () => false;
    expect(peer.getMaxInflight()).toBe(peer.inflight + 8 - r.used(remote));
  });

  // Lane P2-owed-viewer (ADR 0015 amendment): a seeder that said `PRICE { free: true }` for a core
  // counts nothing it sends of it. Its requests there must neither be held back by what it may
  // count elsewhere nor ever become debt — a free image read that times out or is stopped leaves
  // nothing owed. The counted phase first shows the same requests DO become debt when not free.
  it('the free option: capped by the budget alone, and in-flight / released requests of a free core are never used or debt; counted, they are', async () => {
    // One seeder serving two cores over ONE stream: a video it sells and an image it serves free.
    const origin = await store();
    const video = coreOf(origin, { name: 'video' });
    const image = coreOf(origin, { name: 'image' });
    for (const c of [video, image]) {
      await c.ready();
      await c.append(Array.from({ length: 8 }, (_, i) => new Uint8Array(BLOCK).fill(i + 1)));
    }
    const vs = await store();
    const v = coreOf(vs, { key: video.key });
    const im = coreOf(vs, { key: image.key });
    await v.ready();
    await im.ready();
    let sent = 0;
    for (const c of [video, image]) c.on('upload', () => sent++);
    const link = connect(origin, vs);
    const remote = await link.remote();
    await until(() => v.peers.length === 1 && im.peers.length === 1, 10_000, 'both cores to pair');
    await v.update({ wait: true });
    await im.update({ wait: true });
    let free = false;
    const imageHex = toHex(im.key);
    const r = new OnePeerRouter({
      budget: () => 4,
      free: (_remote, core) => free && core === imageHex,
      logger: silentLogger,
    });
    cleanups.push(() => {
      r.close();
      link.destroy();
      return Promise.resolve();
    });
    r.attachCore(v);
    r.attachCore(im);
    const vp = v.peers[0]!;
    const ip = im.peers[0]!;
    await until(
      () => vp.inflight + vp.dataProcessing + ip.inflight + ip.dataProcessing === 0,
      5000,
      'the syncs to settle',
    );
    // Counted: two video requests into the void, abandoned — cancelled after they went out.
    link.hold();
    const lost = [v.get(0, { timeout: 300 }), v.get(1, { timeout: 300 })];
    await Promise.allSettled(lost);
    expect(sent).toBe(2);
    expect(r.used(remote)).toBe(2);
    expect(r.debt(remote)).toBe(2);
    // The image, counted: what it may count on the video holds it back…
    expect(ip.getMaxInflight()).toBe(4 - 2);
    // …served free: its own cap only.
    free = true;
    expect(ip.getMaxInflight()).toBe(4);
    const reads = [0, 1, 2].map((i) => im.get(i, { timeout: 20_000 }));
    for (const p of reads) p.catch(() => undefined);
    await until(() => sent >= 5, 5000, 'three image requests at the seeder');
    expect(ip.inflight).toBe(3);
    // In flight on the free core: not used, not in flight, not debt.
    expect(r.used(remote)).toBe(2);
    expect(r.inflight(remote)).toBe(0);
    expect(r.debt(remote)).toBe(2);
    // The read is abandoned: both cores let go of (parked) with the three still out — owed nothing.
    r.close();
    expect(r.debt(remote)).toBe(2);
    expect(r.lostOf(remote)).toBe(2);
    // Counted instead (a throwing predicate counts: the safe side), the same three would be debt.
    const r2 = new OnePeerRouter({
      budget: () => 4,
      free: () => {
        throw new Error('ledger bug');
      },
      logger: silentLogger,
    });
    const im2 = coreOf(vs, { key: image.key });
    await im2.ready();
    r2.attachCore(im2);
    expect(r2.used(remote)).toBe(3);
    r2.close();
    expect(r2.debt(remote)).toBe(3);
    link.release();
    await Promise.allSettled(reads);
  });

  // Lane W8b-p2p (round-8 review, info): free requests were left out of what a seeder may count,
  // so with its window full of counted requests it could still be asked up to its free cap on a
  // free core — and a seeder that turns that core SOLD while they are out counts them on top of
  // its window, and cuts and bans an honest viewer. With `room`, both kinds share the window while
  // in flight (never as debt).
  it('the room option: free requests fit under what the seeder may still count, and hold room there while out', async () => {
    const origin = await store();
    const video = coreOf(origin, { name: 'video' });
    const image = coreOf(origin, { name: 'image' });
    for (const c of [video, image]) {
      await c.ready();
      await c.append(Array.from({ length: 8 }, (_, i) => new Uint8Array(BLOCK).fill(i + 1)));
    }
    const vs = await store();
    const v = coreOf(vs, { key: video.key });
    const im = coreOf(vs, { key: image.key });
    await v.ready();
    await im.ready();
    let sent = 0;
    for (const c of [video, image]) c.on('upload', () => sent++);
    const link = connect(origin, vs);
    await link.remote();
    await until(() => v.peers.length === 1 && im.peers.length === 1, 10_000, 'both cores to pair');
    await v.update({ wait: true });
    await im.update({ wait: true });
    const imageHex = toHex(im.key);
    let room = 4;
    const r = new OnePeerRouter({
      budget: () => 4,
      free: (_remote, core) => core === imageHex,
      room: () => room,
      logger: silentLogger,
    });
    cleanups.push(() => {
      r.close();
      link.destroy();
      return Promise.resolve();
    });
    r.attachCore(v);
    r.attachCore(im);
    const vp = v.peers[0]!;
    const ip = im.peers[0]!;
    await until(
      () => vp.inflight + vp.dataProcessing + ip.inflight + ip.dataProcessing === 0,
      5000,
      'the syncs to settle',
    );
    link.hold();
    // Two counted video requests out: the free core may take only what is left of the window.
    const videoReads = [0, 1].map((i) => v.get(i, { timeout: 20_000 }));
    for (const p of videoReads) p.catch(() => undefined);
    await until(() => sent >= 2, 5000, 'two video requests at the seeder');
    const remote = toHex(vp.remotePublicKey);
    expect(r.used(remote)).toBe(2);
    expect(ip.getMaxInflight()).toBe(2); // not its free cap of 4: 4 − 2 counted
    // Two image requests out: they hold room in the window — the video may ask nothing more.
    const imageReads = [0, 1].map((i) => im.get(i, { timeout: 20_000 }));
    for (const p of imageReads) p.catch(() => undefined);
    await until(() => sent >= 4, 5000, 'two image requests at the seeder');
    expect(ip.inflight).toBe(2);
    expect(r.used(remote)).toBe(2); // still never counted as used…
    expect(r.debt(remote)).toBe(0); // …nor debt
    expect(vp.getMaxInflight()).toBe(vp.inflight); // 4 − 2 counted − 2 free out: nothing new
    expect(ip.getMaxInflight()).toBe(ip.inflight); // the window is spoken for
    // Junk room fails closed: no free request, and counted ones still leave room for those out.
    room = Number.NaN;
    expect(ip.getMaxInflight()).toBe(ip.inflight);
    room = 4;
    link.release();
    await Promise.allSettled([...videoReads, ...imageReads]);
    await until(
      () => vp.inflight + vp.dataProcessing + ip.inflight + ip.dataProcessing === 0,
      5000,
      'the reads to land',
    );
    // Landed: nothing held any more, and the free core's blocks left no debt.
    expect(ip.getMaxInflight()).toBe(4);
    expect(r.debt(remote)).toBe(0);
  });

  it('forgive(remote, n): drops at most n of the requests remembered as lost to it, nothing for junk', async () => {
    const w = await world(4, 1);
    const r = routed(w.viewer, { budget: () => 4 });
    const remote = w.remotes[0]!;
    w.links[0]!.hold();
    const lost = [0, 1, 2].map((i) => w.viewer.get(i, { timeout: 20_000 }));
    for (const p of lost) p.catch(() => undefined);
    await until(() => (w.uploads[0] ?? 0) >= 3, 5000, 'three requests at the seeder');
    w.links[0]!.destroy();
    await until(() => w.viewer.peers.length === 0, 5000, 'the peer to leave');
    expect(r.lostOf(remote)).toBe(3);
    for (const junk of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) r.forgive(remote, junk);
    expect(r.lostOf(remote)).toBe(3);
    r.forgive(remote, 1);
    expect(r.lostOf(remote)).toBe(2);
    expect(r.debt(remote)).toBe(2);
    r.forgive(remote, 99);
    expect(r.lostOf(remote)).toBe(0);
    expect(r.used(remote)).toBe(0);
    r.forgive('ab'.repeat(32), 5); // unknown: nothing
    expect(r.lostOf('ab'.repeat(32))).toBe(0);
  });

  it('after a failover the replacement seeder vanishes too: the block goes to a third one, never stuck', async () => {
    const STALL = 300;
    let open = new Set<string>();
    const w = await world(4, 3);
    const r = routed(w.viewer, {
      budget: (remote) => (open.has(remote) ? 4 : 0),
      stallMs: STALL,
    });
    const [s0, s1, s2] = w.remotes as [string, string, string];
    w.links[0]!.hold();
    w.links[1]!.hold();
    open = new Set([s0]);
    r.refresh();
    const got = w.viewer.get(1);
    await until(() => w.uploads[0] === 1, 5000, 'seeder 0 to take block 1');
    open = new Set([s1]);
    r.refresh();
    await until(() => w.uploads[1] === 1, 5000, 'the failover to seeder 1');
    expect(r.stats().failovers).toBe(1);
    // Seeder 1 goes away with the replacement request in flight.
    open = new Set([s2]);
    w.links[1]!.destroy();
    r.refresh();
    expect(await within(got, 5000)).not.toBeNull();
    expect(w.downloads).toEqual([{ index: 1, from: s2 }]);
  });

  it('a seeder that disconnects mid-range: its blocks are re-requested from the others, each delivered once', async () => {
    const N = 48;
    const w = await world(N, 3);
    // Small budgets keep requests in flight at every seeder when the link drops.
    const r = routed(w.viewer, { budget: () => 3 });
    // Each block leaves its budget once it lands (the "PAY" is instant here).
    const all = Promise.all(Array.from({ length: N }, (_, i) => w.viewer.get(i)));
    await until(() => w.downloads.length >= N / 3, 10_000, 'a third of the blocks');
    const gone = w.remotes[1]!;
    w.links[1]!.destroy();
    await all;
    await sleep(200);
    expect(w.downloads).toHaveLength(N);
    expect([...perIndex(w.downloads).values()].every((c) => c === 1)).toBe(true);
    const fromGone = w.downloads.filter((d) => d.from === gone).length;
    // Whatever it sent that never arrived stays counted against it (it may be owed, never paid).
    expect(r.debt(gone)).toBeGreaterThanOrEqual(w.uploads[1]! - fromGone);
    // The survivors sent exactly what arrived from them.
    for (const k of [0, 2])
      expect(w.uploads[k]).toBe(w.downloads.filter((d) => d.from === w.remotes[k]).length);
  });

  it('refuses a core without the pinned internals, and a second router on a routed core (fail closed)', async () => {
    const bare = Object.assign(new EventEmitter(), { key: new Uint8Array(32), opened: true });
    const router = new OnePeerRouter({ budget: unlimited, logger: silentLogger });
    expect(() => router.attachCore(bare as unknown as RoutableCore)).toThrow(RoutingUnsupported);
    const closed = Object.assign(new EventEmitter(), { key: new Uint8Array(32), opened: false });
    expect(() => router.attachCore(closed as unknown as RoutableCore)).toThrow(/not open/);
    const w = await world(2, 1);
    const detach = router.attachCore(w.viewer);
    const other = new OnePeerRouter({ budget: unlimited, logger: silentLogger });
    expect(() => other.attachCore(w.viewer)).toThrow(/another router/);
    // The same router again is reference counted. The last detach PARKS the core rather than
    // restoring hypercore's scheduler (F33 independent review, 2026-09-25: a released core may
    // still be replicating, and hypercore's cap and racing would overrun every seeder): every peer
    // is asked for nothing until a router takes the core over.
    const again = router.attachCore(w.viewer);
    detach();
    expect(router.stats().cores).toBe(1);
    again();
    expect(router.stats().cores).toBe(0);
    expect(w.viewer.peers[0]!.getMaxInflight()).toBe(0);
    expect(() => other.attachCore(w.viewer)).not.toThrow();
    expect(other.stats().cores).toBe(1);
    expect(w.viewer.peers[0]!.getMaxInflight()).toBeGreaterThan(0); // `other` caps it now
    other.close();
    expect(w.viewer.peers[0]!.getMaxInflight()).toBe(0);
    router.close();
    expect(() => router.attachCore(w.viewer)).toThrow(RoutingUnsupported);
  });

  it('refuses a stallMs that would fail over everything', () => {
    for (const bad of [0, 1, 49, Number.NaN, -1, Number.POSITIVE_INFINITY])
      expect(
        () => new OnePeerRouter({ budget: unlimited, logger: silentLogger, stallMs: bad }),
        String(bad),
      ).toThrow(RangeError);
    expect(new OnePeerRouter({ budget: unlimited, logger: silentLogger }).stallMs).toBe(4000);
  });

  it('refuses a replicator missing ANY member it relies on', () => {
    const complete = (): Record<string, unknown> => {
      class Peer {
        getMaxInflight(): number {
          return 16;
        }
        getMaxHotswapInflight(): number {
          return 16;
        }
        _cancelRequest(): void {
          // no wire
        }
        _requestBlock(): boolean {
          return false;
        }
      }
      class Replicator {
        static Peer: unknown = Peer;
        hotswaps: Record<string, unknown> = { add: noop, remove: noop, pick: noop };
        peers: unknown[] = [];
        updateAll = noop;
        updatePeer = noop;
        _updateHotswap = noop;
      }
      return new Replicator() as unknown as Record<string, unknown>;
    };
    const noop = (): void => undefined;
    const coreWith = (replicator: unknown): RoutableCore =>
      Object.assign(new EventEmitter(), {
        key: new Uint8Array(32),
        opened: true,
        replicator,
      }) as unknown as RoutableCore;
    expect(() => routableReplicator(coreWith(complete()))).not.toThrow();
    for (const m of ['hotswaps', 'peers', 'updateAll', 'updatePeer', '_updateHotswap']) {
      const r = complete();
      r[m] = undefined;
      expect(() => routableReplicator(coreWith(r)), m).toThrow(RoutingUnsupported);
    }
    for (const m of ['add', 'remove', 'pick']) {
      const r = complete();
      (r['hotswaps'] as Record<string, unknown>)[m] = undefined;
      expect(() => routableReplicator(coreWith(r)), `hotswaps.${m}`).toThrow(RoutingUnsupported);
    }
    for (const m of [
      'getMaxInflight',
      'getMaxHotswapInflight',
      '_cancelRequest',
      '_requestBlock',
    ]) {
      const r = complete();
      const Peer = (r.constructor as unknown as { Peer: { prototype: Record<string, unknown> } })
        .Peer;
      const saved = Peer.prototype[m];
      Peer.prototype[m] = undefined;
      expect(() => routableReplicator(coreWith(r)), `Peer#${m}`).toThrow(RoutingUnsupported);
      Peer.prototype[m] = saved;
    }
  });

  it('a block found in flight at two peers without a failover is counted and logged (an unknown path)', async () => {
    const w = await world(2, 2);
    const r = routed(w.viewer, { budget: unlimited });
    const [p0, p1] = w.viewer.peers;
    const queue = (w.viewer as unknown as { replicator: { hotswaps: { add(b: unknown): void } } })
      .replicator.hotswaps;
    const now = Date.now();
    queue.add({
      index: 0,
      hotswap: null,
      inflight: [
        { peer: p0, timestamp: now, priority: 1 },
        { peer: p1, timestamp: now, priority: 1 },
      ],
    });
    expect(r.stats().raced).toBe(1);
    // A cancelled or answered request is not "in flight".
    queue.add({
      index: 1,
      hotswap: null,
      inflight: [
        { peer: p0, timestamp: now, priority: 255 },
        { peer: p1, timestamp: now, priority: 1 },
      ],
    });
    expect(r.stats().raced).toBe(1);
  });

  it('the cap: only UNCAPPED keeps hypercore’s own, a finite budget caps it, NaN / ±Infinity / negative / null / undefined / a throw ask nothing', async () => {
    let budget: () => unknown = () => UNCAPPED;
    const w = await world(2, 1);
    const r = routed(w.viewer, { budget: () => budget() as number });
    const peer = w.viewer.peers[0]!;
    const base = (Object.getPrototypeOf(peer) as RawPeer).getMaxInflight.call(peer);
    expect(peer.getMaxInflight()).toBe(base);
    budget = () => 3;
    expect(peer.getMaxInflight()).toBe(peer.inflight + 3 - r.used(w.remotes[0]!));
    // `null` / `undefined` mean "unknown" in the APIs next to the budget (a window before HELLO):
    // they must never lift the cap (F33 independent review, 2026-09-25).
    for (const bad of [
      Number.NaN,
      -1,
      0,
      0.5,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      null,
      undefined,
      '8',
      Symbol('uncapped'),
    ]) {
      budget = () => bad;
      expect(peer.getMaxInflight(), String(bad)).toBe(peer.inflight);
    }
    budget = () => {
      throw new Error('ledger bug');
    };
    expect(peer.getMaxInflight()).toBe(peer.inflight);
    // Nothing can be fetched while the budget is 0…
    budget = () => 0;
    const p = w.viewer.get(1);
    await sleep(150);
    expect(w.downloads).toHaveLength(0);
    // …and refresh() lets hypercore ask once it grows.
    budget = () => 1;
    r.refresh();
    expect(await p).not.toBeNull();
    expect(w.downloads).toHaveLength(1);
  });
  // ------------------------------------------------ independent review, 2026-09-25

  it('close() PARKS a core still replicating: a held-back get and a block landing afterwards send nothing new, nor does a peer that joins (fail closed)', async () => {
    const w = await world(8, 2);
    const [s0] = w.remotes as [string, string];
    const r = routed(w.viewer, { budget: (remote) => (remote === s0 ? 1 : 0) });
    w.links[0]!.hold();
    const gets = Array.from({ length: 5 }, (_, i) => w.viewer.get(i).catch(() => null));
    await until(() => w.uploads[0] === 1, 5000, 'the first request to seeder 0');
    await sleep(100);
    expect(w.uploads).toEqual([1, 0]); // its budget of 1 holds the other four back
    // Shutdown with the connections still open.
    r.close();
    // The block in flight lands: hypercore's `_ondata` runs `updatePeer` on seeder 0 at once.
    // Handed back to hypercore, its own cap (≥ 16) would send it the four held-back requests.
    w.links[0]!.release();
    await until(() => w.downloads.length === 1, 5000, 'the block in flight at close()');
    await sleep(300);
    expect(w.uploads, 'requests sent after close()').toEqual([1, 0]);
    for (const p of w.viewer.peers) expect(p.getMaxInflight()).toBe(0);
    // A seeder that joins the parked core again is asked for nothing either.
    w.links[1]!.destroy();
    await until(() => w.viewer.peers.length === 1, 5000, 'seeder 1 to leave');
    const back = connect(w.stores[1]!, w.viewerStore);
    cleanups.push(() => {
      back.destroy();
      return Promise.resolve();
    });
    await back.remote();
    await until(() => w.viewer.peers.length === 2, 5000, 'seeder 1 to join again');
    await sleep(300);
    expect(w.uploads, 'requests to a peer that joined after close()').toEqual([1, 0]);
    for (const p of w.viewer.peers) expect(p.getMaxInflight()).toBe(0);
    expect(gets).toHaveLength(5); // still pending: the stores' close rejects them
  });

  // Fix round 2 (independent verifier, 2026-09-25): a parked core taken over kept its queue and
  // the blocks it tracks, but the failover ticker starts only from the queue's `add()` — nothing
  // new is queued here, so a block withheld across the park never failed over.
  it.each(['the same router', 'another router'] as const)(
    'a core parked with a block in flight and taken over by %s: the withheld block still fails over',
    async (who) => {
      const STALL = 300;
      const w = await world(4, 2);
      const [s0, s1] = w.remotes as [string, string];
      let s1Budget = 0;
      const failovers: string[] = [];
      const make = (): OnePeerRouter => {
        const router = new OnePeerRouter({
          budget: (remote) => (remote === s0 ? 1 : s1Budget),
          logger: silentLogger,
          stallMs: STALL,
          onFailover: (remote) => failovers.push(remote),
        });
        cleanups.push(() => {
          router.close();
          return Promise.resolve();
        });
        return router;
      };
      const first = make();
      const detach = first.attachCore(w.viewer);
      // Seeder 0 takes block 2 (its whole budget) and withholds it.
      w.links[0]!.hold();
      const got = w.viewer.get(2);
      await until(() => w.uploads[0] === 1, 5000, 'seeder 0 to take block 2');
      // Detached with block 2 in flight: parked, its queue still tracks block 2.
      detach();
      expect(first.stats().cores).toBe(0);
      // Long enough for the first router's ticker to find no route and stop, and for block 2's
      // request to be older than stallMs.
      await sleep(STALL);
      expect(w.uploads).toEqual([1, 0]);
      // Taken over, seeder 1 may take block 2: seeder 0 is at its cap and nothing new is queued,
      // so only the failover ticker can move it (`refresh()` runs no hotswap step).
      s1Budget = 4;
      const second = who === 'the same router' ? first : make();
      const takenOver = Date.now();
      second.attachCore(w.viewer);
      second.refresh();
      expect(await within(got, STALL * 10)).not.toBeNull();
      // Fix round 3: the quiet clock restarts at the takeover (no router heard a block land while
      // it was parked), so the withholding seeder fails over one stallMs after it — not sooner.
      expect(Date.now() - takenOver).toBeGreaterThanOrEqual(STALL);
      expect(second.stats().failovers).toBe(1);
      expect(failovers).toEqual([s0]);
      expect(w.downloads).toEqual([{ index: 2, from: s1 }]);
      expect(w.uploads).toEqual([1, 1]);
      // Cancelled after sending: seeder 0 counts it for good. The same router counts it twice —
      // once remembered at the detach (in flight then), once as the cancel — the conservative
      // double count the review's self-review records for a detach followed by a re-attach.
      expect(second.debt(s0)).toBe(who === 'the same router' ? 2 : 1);
    },
  );

  // Fix round 3 (independent verifier, 2026-09-25): while a core is parked no router listens to
  // its `download` events, so the blocks a seeder kept delivering then were never recorded, and
  // the ticker armed at the takeover judged that seeder silent and failed its blocks over (a
  // cancel after sending: each one paid twice). Measured by the verifier: failovers 3, debt 3.
  it.each(['the same router', 'another router'] as const)(
    'a core parked while its seeder keeps delivering, taken over by %s: that seeder is not failed over',
    async (who) => {
      const STALL = 1000;
      const N = 6;
      const w = await world(N, 2);
      const [s0] = w.remotes as [string, string];
      let s1Budget = 0;
      const make = (): OnePeerRouter => {
        const router = new OnePeerRouter({
          budget: (remote) => (remote === s0 ? N : s1Budget),
          logger: silentLogger,
          stallMs: STALL,
        });
        cleanups.push(() => {
          router.close();
          return Promise.resolve();
        });
        return router;
      };
      const first = make();
      const detach = first.attachCore(w.viewer);
      // Seeder 0 takes all six requests; its answers wait in the gate.
      w.links[0]!.hold();
      const got = Promise.all(Array.from({ length: N }, (_, i) => w.viewer.get(i)));
      await until(() => w.uploads[0] === N, 5000, 'six requests at seeder 0');
      // Parked with all six in flight; half a stallMs later its answers start to come, one every
      // 400 ms (a slow link), and no router hears them land.
      detach();
      await sleep(STALL / 2);
      w.links[0]!.releaseSlowly(400);
      // Taken over just after a block landed: the next one is ~400 ms away, the ticker ticks every
      // stallMs / 4, and every request is older than stallMs by then. Recorded nowhere, the
      // parked deliveries made seeder 0 look silent since its requests went out.
      await until(() => w.downloads.length >= 2, 5000, 'two blocks to land while parked');
      s1Budget = N;
      const second = who === 'the same router' ? first : make();
      second.attachCore(w.viewer);
      second.refresh();
      await within(got, 10_000);
      expect(second.stats().failovers).toBe(0);
      expect(w.uploads).toEqual([N, 0]);
      expect(w.downloads.map((d) => d.from)).toEqual(Array.from({ length: N }, () => s0));
      // No cancel after sending. The same router still carries the six it remembered as lost at
      // the detach (in flight then): the conservative double count the round-2 case pins too.
      expect(second.debt(s0)).toBe(who === 'the same router' ? N : 0);
    },
  );

  it('a seeder still delivering is never failed over, however old its last request — only a silent one is', async () => {
    const STALL = 1000;
    let open = new Set<string>();
    const w = await world(6, 2);
    const [s0, s1] = w.remotes as [string, string];
    const r = routed(w.viewer, {
      budget: (remote) => (open.has(remote) ? 4 : 0),
      stallMs: STALL,
    });
    // Seeder 0 takes four requests and its answers wait in the gate…
    w.links[0]!.hold();
    open = new Set([s0]);
    r.refresh();
    const got = Promise.all([0, 1, 2, 3].map((i) => w.viewer.get(i)));
    await until(() => w.uploads[0] === 4, 5000, 'four requests at seeder 0');
    // …seeder 1 could take any of them over…
    open = new Set([s0, s1]);
    r.refresh();
    // …and they arrive one every 400 ms: the last is 1.2 s old (> stallMs) when it lands, but
    // seeder 0 delivered a block 400 ms before it — a slow link, not a stalled peer. Measured by
    // request age alone, it was failed over (a cancel after sending: a debt for good).
    w.links[0]!.releaseSlowly(400);
    await within(got, 10_000);
    expect(r.stats().failovers).toBe(0);
    expect(r.debt(s0)).toBe(0);
    expect(r.isStalled(s0)).toBe(false);
    expect(w.uploads[1]).toBe(0);
    expect(w.downloads.map((d) => d.from)).toEqual([s0, s0, s0, s0]);
  });

  it(`a request ${String(STALL_HARD_FACTOR)} × stallMs old has stalled, however recently its seeder delivered other blocks`, async () => {
    const STALL = 200;
    const w = await world(2, 2);
    routed(w.viewer, { budget: () => 4, stallMs: STALL });
    const [p0, p1] = w.viewer.peers as [RawPeer, RawPeer];
    const queue = (
      w.viewer as unknown as {
        replicator: {
          hotswaps: {
            add(b: unknown): void;
            remove(b: unknown): void;
            pick(p: unknown): Iterable<unknown>;
          };
        };
      }
    ).replicator.hotswaps;
    /** Would `to` be offered a block whose one request went to `from` `age` ms ago? */
    const offered = (from: RawPeer, to: RawPeer, age: number): boolean => {
      const block = {
        index: 0,
        hotswap: null,
        inflight: [{ peer: from, timestamp: Date.now() - age, priority: 1 }],
      };
      queue.add(block);
      try {
        return [...queue.pick(to)].includes(block);
      } finally {
        queue.remove(block);
      }
    };
    // p1 delivered nothing: its request has stalled once it is stallMs old.
    expect(offered(p1, p0, STALL / 2)).toBe(false);
    expect(offered(p1, p0, STALL * 2)).toBe(true);
    // p0 delivered a block just now: its request of the same age has not…
    (w.viewer as unknown as EventEmitter).emit('download', 1, BLOCK, p0);
    expect(offered(p0, p1, STALL * 2)).toBe(false);
    expect(offered(p0, p1, STALL * STALL_HARD_FACTOR - 50)).toBe(false);
    // …until it is STALL_HARD_FACTOR × stallMs old: one block cannot be held back for ever by a
    // peer trickling the others.
    expect(offered(p0, p1, STALL * STALL_HARD_FACTOR)).toBe(true);
  });

  it('a replication peer without the pinned fields: refused at attach, asked for nothing when it joins later (fail closed)', async () => {
    const w = await world(2, 2);
    const hs = (w.viewer as unknown as { replicator: { hotswaps: unknown } }).replicator;
    const hypercoreQueue = hs.hotswaps;
    const peer = w.viewer.peers[0] as unknown as Record<string, unknown>;
    const saved = peer['dataProcessing'];
    const router = new OnePeerRouter({ budget: unlimited, logger: silentLogger });
    cleanups.push(() => {
      router.close();
      return Promise.resolve();
    });
    peer['dataProcessing'] = undefined; // a renamed field, as a hypercore release might do
    try {
      expect(() => router.attachCore(w.viewer)).toThrow(/pinned fields/);
    } finally {
      peer['dataProcessing'] = saved;
    }
    expect(router.stats().cores).toBe(0);
    expect(hs.hotswaps).toBe(hypercoreQueue); // nothing installed by the refused attach
    router.attachCore(w.viewer);
    const odd = { remotePublicKey: new Uint8Array(32), getMaxInflight: (): number => 16 };
    (w.viewer as unknown as EventEmitter).emit('peer-add', odd);
    expect(odd.getMaxInflight()).toBe(0);
  });

  it('a core closed and reopened under the same key (a new replicator) is routed anew, not left to hypercore', () => {
    const noop = (): void => undefined;
    class Peer {
      getMaxInflight(): number {
        return 16;
      }
      getMaxHotswapInflight(): number {
        return 16;
      }
      _cancelRequest(): void {
        // no wire
      }
      _requestBlock(): boolean {
        return false;
      }
    }
    class Replicator {
      static Peer: unknown = Peer;
      hotswaps: unknown = { add: noop, remove: noop, pick: noop };
      peers: unknown[] = [];
      updateAll = noop;
      updatePeer = noop;
      _updateHotswap = noop;
    }
    const key = new Uint8Array(32).fill(7);
    const session = (replicator: Replicator): RoutableCore =>
      Object.assign(new EventEmitter(), {
        key,
        opened: true,
        replicator,
      }) as unknown as RoutableCore;
    const first = new Replicator();
    const reopened = new Replicator();
    const hypercoreQueue = reopened.hotswaps;
    const router = new OnePeerRouter({ budget: unlimited, logger: silentLogger });
    router.attachCore(session(first));
    router.attachCore(session(reopened));
    expect(router.stats().cores).toBe(2);
    expect(reopened.hotswaps).not.toBe(hypercoreQueue);
    // Two sessions of ONE replicator share its route (every session sees every event).
    const again = router.attachCore(session(first));
    expect(router.stats().cores).toBe(2);
    again();
    expect(router.stats().cores).toBe(2);
    router.close();
  });

  // Fix round 5 (the verifier, MEDIUM): a closing play session waited for every request in flight
  // on its CORE — after a rendition switch the new session streams the same core, so the old
  // one's close waited on the new one's blocks. With a range, only blocks of that range count.
  it('inflightOn(core, range) counts the blocks of that range requested and not landed yet — not the rest of the core', async () => {
    const w = await world(8, 1);
    const r = routed(w.viewer, { budget: unlimited });
    const key = toHex(w.viewer.key);
    const [link] = w.links;
    link!.hold(); // the seeder's answers are withheld: both requests stay in flight
    const got = [w.viewer.get(1), w.viewer.get(6)];
    await until(() => w.uploads[0] === 2, 5000, 'both requests to reach the seeder');
    expect(r.inflightOn(key, { fromBlock: 0, toBlock: 3 })).toBe(1);
    expect(r.inflightOn(key, { fromBlock: 4, toBlock: 7 })).toBe(1);
    expect(r.inflightOn(key, { fromBlock: 2, toBlock: 5 })).toBe(0);
    expect(r.inflightOn(key, { fromBlock: 0, toBlock: 7 })).toBe(2);
    expect(r.inflightOn('ff'.repeat(32), { fromBlock: 0, toBlock: 7 })).toBe(0);
    expect(r.inflightOn(key)).toBeGreaterThanOrEqual(2); // the whole core, as before
    link!.release();
    await Promise.all(got);
    await until(
      () => r.inflightOn(key, { fromBlock: 0, toBlock: 7 }) === 0,
      5000,
      'both blocks to land',
    );
  });
});
