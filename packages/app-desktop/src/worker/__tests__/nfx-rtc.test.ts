/**
 * #89 (ADR 0023): the worker's WebRTC pieces against stand-ins.
 *
 * - `RtcFetcher` places segments only from the hash list and playlists (web swarm, #EXTINF index),
 *   asks only peers whose announcement holds the segment, drops and hangs up a peer that sends
 *   what the hash list contradicts, is not put off by `absent` or `busy`, stops at the helper's own
 *   trouble, and asks one peer for one segment at a time.
 * - `NfxRtcSeeding` serves each stored rendition in its web swarm, segment ids in playlist order,
 *   from the store's paths at the hash list's sizes, in pages; stops serving what left the store;
 *   serves again for a new helper; refuses a video whose playlists do not resolve.
 *
 * The real helper is driven by `nfx-rtc.integration.test.ts`.
 */
import { nfx } from '@sovit/core';
import type { NfxStoreFile, NfxVideoRecord } from '@sovit/seeder';
import { silentLogger } from '@sovit/seeder';
import { describe, expect, it, vi } from 'vitest';

import type { HelperRtcSegment, IrohHelper } from '../iroh/helper.js';
import { HelperError, PoisonedError } from '../iroh/helper.js';
import type { NfxIrohStore } from '../nfx/iroh-seeding.js';
import type { RtcFetchClient } from '../nfx/rtc-fetcher.js';
import { RtcFetcher } from '../nfx/rtc-fetcher.js';
import type { NfxRtcConnection, NfxRtcNode } from '../nfx/rtc-node.js';
import { holds } from '../nfx/rtc-node.js';
import { NfxRtcSeeding, PAGE_BYTES, pages } from '../nfx/rtc-seeding.js';
import { NfxFetchError } from '../nfx/watch.js';
import { segments, sha256, testNfxVideo } from './helpers/nfx-video.js';
import type { TestNfxVideo } from './helpers/nfx-video.js';

function addr(v: TestNfxVideo): nfx.VideoAddr {
  const a = nfx.VideoAddr.parse(v.video);
  if (!a.ok) throw new Error('bad test video');
  return a.value;
}

function hashList(v: TestNfxVideo): nfx.HashList {
  const l = nfx.verifyHashList(v.files.get(v.root)!, v.root, addr(v), BigInt(v.segs));
  if (!l.ok) throw new Error('bad test hash list');
  return l.value;
}

/** The playlist sha256 of rendition `id`. */
function playlistSha(v: TestNfxVideo, id: string): string {
  const list = hashList(v);
  const r = list.renditions.find((x) => x.id === id)!;
  return list.files.find((f) => f.role === 'playlist' && f.name === r.playlist)!.sha256;
}

async function reasons(p: Promise<unknown>): Promise<readonly string[]> {
  try {
    await p;
  } catch (e) {
    if (e instanceof NfxFetchError) return e.reasons;
    throw e;
  }
  throw new Error('resolved');
}

/** Peers serving `blobs` by segment id; each may be told to misbehave. */
class FakeRtc implements RtcFetchClient {
  readonly gets: { peer: number; segment: number; sha256: string; maxBytes: number }[] = [];
  readonly hangups: number[] = [];
  readonly fail = new Map<number, Error>();
  readonly lie = new Set<number>();
  /** Every get waits for this, when set. */
  gate: Promise<void> | null = null;
  inFlight = 0;
  maxInFlight = 0;

  constructor(private readonly bodies: readonly Uint8Array[]) {}

  async rtcGetFile(
    peer: number,
    segment: number,
    expect: { readonly sha256: string; readonly maxBytes: number },
  ): Promise<Uint8Array> {
    this.gets.push({ peer, segment, ...expect });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.gate !== null) await this.gate;
      const err = this.fail.get(peer);
      if (err !== undefined) throw err;
      const body = this.lie.has(peer) ? new Uint8Array([1, 2, 3]) : this.bodies[segment];
      if (body === undefined) throw new HelperError('absent', 'not held');
      // As the real client does: only bytes under the asked sha256.
      if (sha256(body) !== expect.sha256) throw new PoisonedError('a segment');
      return body;
    } finally {
      this.inFlight -= 1;
    }
  }

  rtcHangup(peer: number): Promise<boolean> {
    this.hangups.push(peer);
    return Promise.resolve(true);
  }
}

describe('RtcFetcher (#89)', () => {
  const bodies = segments(3);
  const v = testNfxVideo(bodies);
  const swarm = addr(v).webStreamSwarmId('360p');

  function fetcher(
    conns: NfxRtcConnection[],
    client: RtcFetchClient | null,
  ): { f: RtcFetcher; learnAll: () => void } {
    const f = new RtcFetcher({
      video: addr(v),
      root: v.root,
      segs: v.segs,
      client: () => Promise.resolve(client),
      connections: (s) => conns.filter((c) => c.swarm === s),
      logger: silentLogger,
    });
    const learnAll = (): void => {
      f.learn(v.root, v.files.get(v.root)!);
      // 360p first: its swarm is where the shared segments are placed.
      for (const id of ['360p', '720p']) {
        const sha = playlistSha(v, id);
        f.learn(sha, v.files.get(sha)!);
      }
    };
    return { f, learnAll };
  }

  const conn = (peer: number, have: [number, number][], s = swarm): NfxRtcConnection => ({
    peer,
    swarm: s,
    dir: 'out',
    have,
  });

  it('places a segment by web swarm and #EXTINF index, only from the hash list and playlist', async () => {
    const client = new FakeRtc(bodies);
    const { f, learnAll } = fetcher([conn(1, [[0, 2]])], client);
    const seg = v.segmentShas[2]!;
    expect(await reasons(f.fetch(seg, bodies[2]!.length, true))).toEqual(['unmapped']);
    // A playlist before its hash list places nothing; a forged hash list is ignored.
    f.learn(playlistSha(v, '360p'), v.files.get(playlistSha(v, '360p'))!);
    f.learn(v.root, new Uint8Array([1]));
    expect(f.placeOf(seg)).toBeUndefined();
    learnAll();
    expect(f.placeOf(seg)).toEqual({ swarm, index: 2 });
    await expect(f.fetch(seg, bodies[2]!.length, true)).resolves.toEqual(bodies[2]);
    expect(client.gets).toEqual([
      { peer: 1, segment: 2, sha256: seg, maxBytes: bodies[2]!.length },
    ]);
    // The hash list, an init or a playlist is never in a web swarm.
    expect(await reasons(f.fetch(v.root, 100, false))).toEqual(['unmapped']);
  });

  it('asks only peers whose announcement holds the segment', async () => {
    const client = new FakeRtc(bodies);
    const other = addr(v).webStreamSwarmId('720p');
    const { f, learnAll } = fetcher(
      [conn(1, [[0, 0]]), conn(2, [[1, 1]], other), conn(3, [[0, 1]])],
      client,
    );
    learnAll();
    await f.fetch(v.segmentShas[1]!, bodies[1]!.length, true);
    expect(client.gets.map((g) => g.peer)).toEqual([3]);
    expect(await reasons(f.fetch(v.segmentShas[2]!, bodies[2]!.length, true))).toEqual(['no-peer']);
    expect(
      holds(
        [
          [0, 1],
          [4, 4],
        ],
        4,
      ),
    ).toBe(true);
    expect(holds([[0, 1]], 2)).toBe(false);
  });

  it('drops and hangs up a peer that lies; absent and busy only move on', async () => {
    const client = new FakeRtc(bodies);
    client.lie.add(1);
    client.fail.set(2, new HelperError('absent', 'gone from its cache'));
    client.fail.set(3, new HelperError('busy', 'one at a time'));
    const all: [number, number][] = [[0, 2]];
    const { f, learnAll } = fetcher(
      [conn(1, all), conn(2, all), conn(3, all), conn(4, all)],
      client,
    );
    learnAll();
    const seg = v.segmentShas[0]!;
    await expect(f.fetch(seg, bodies[0]!.length, true)).resolves.toEqual(bodies[0]);
    expect(client.gets.map((g) => g.peer)).toEqual([1, 2, 3, 4]);
    expect(client.hangups).toEqual([1]);
    // The liar is never asked again; the others are.
    client.gets.length = 0;
    await f.fetch(v.segmentShas[1]!, bodies[1]!.length, true);
    expect(client.gets.map((g) => g.peer)).toEqual([2, 3, 4]);
  });

  it('says why when nobody serves it, and stops at the helper’s own trouble', async () => {
    const client = new FakeRtc(bodies);
    client.fail.set(1, new HelperError('timeout', 'slow'));
    client.fail.set(2, new HelperError('transfer-failed', 'cut'));
    client.fail.set(3, new HelperError('not-ready', 'restarting'));
    const all: [number, number][] = [[0, 2]];
    const { f, learnAll } = fetcher(
      [conn(1, all), conn(2, all), conn(3, all), conn(4, all)],
      client,
    );
    learnAll();
    expect(await reasons(f.fetch(v.segmentShas[0]!, bodies[0]!.length, true))).toEqual([
      'timeout',
      'transfer',
      'helper',
    ]);
    expect(client.hangups).toEqual([2]);
    expect(client.gets.map((g) => g.peer)).toEqual([1, 2, 3]);
  });

  it('is off without a helper, refuses an impossible size, and closes', async () => {
    const off = fetcher([conn(1, [[0, 2]])], null);
    off.learnAll();
    expect(await reasons(off.f.fetch(v.segmentShas[0]!, 10, true))).toEqual(['rtc-off']);
    expect(await reasons(off.f.fetch(v.segmentShas[0]!, 0, true))).toEqual(['size']);
    expect(await reasons(off.f.fetch(v.segmentShas[0]!, 65 * 1024 * 1024, true))).toEqual(['size']);
    await off.f.close();
    expect(await reasons(off.f.fetch(v.segmentShas[0]!, 10, true))).toEqual(['closed']);
  });

  it('asks one peer for one segment at a time', async () => {
    const client = new FakeRtc(bodies);
    let open = (): void => undefined;
    client.gate = new Promise((r) => {
      open = r;
    });
    const { f, learnAll } = fetcher([conn(1, [[0, 2]])], client);
    learnAll();
    const all = Promise.all(
      [0, 1, 2].map((i) => f.fetch(v.segmentShas[i]!, bodies[i]!.length, true)),
    );
    await vi.waitFor(() => {
      expect(client.gets).toHaveLength(1);
    });
    open();
    await expect(all).resolves.toEqual(bodies);
    expect(client.maxInFlight).toBe(1);
  });
});

/** A WebRTC helper's serving side, recorded. */
class FakeServer {
  readonly serves: { swarm: string; segments: readonly HelperRtcSegment[]; append: boolean }[] = [];
  readonly unserves: string[] = [];
  failServe: Error | null = null;

  rtcServe(swarm: string, segs: readonly HelperRtcSegment[], append = false): Promise<number> {
    if (this.failServe !== null) return Promise.reject(this.failServe);
    this.serves.push({ swarm, segments: segs, append });
    return Promise.resolve(segs.length);
  }

  rtcUnserve(swarm: string): Promise<boolean> {
    this.unserves.push(swarm);
    return Promise.resolve(true);
  }
}

class FakeNode {
  on = true;
  generation = 1;
  helper: FakeServer | null = new FakeServer();
  private readonly listeners = new Set<() => void>();

  onGeneration(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  start(): Promise<IrohHelper | null> {
    return Promise.resolve(this.helper as unknown as IrohHelper | null);
  }

  current(): IrohHelper | null {
    return this.helper as unknown as IrohHelper | null;
  }

  restart(): void {
    this.helper = new FakeServer();
    this.generation += 1;
    for (const cb of this.listeners) cb();
  }
}

function store(videos: TestNfxVideo[]): NfxIrohStore & { records: NfxVideoRecord[] } {
  const records = videos.map((v) => ({
    video: v.video,
    root: v.root,
    segs: String(v.segs),
    files: [],
    addedAt: 0,
  }));
  const byVideo = new Map(videos.map((v) => [v.video, v] as const));
  return {
    records,
    videos: () => records,
    file: (video, sha): NfxStoreFile | undefined => {
      const bytes = byVideo.get(video.toString())?.files.get(sha);
      if (bytes === undefined) return undefined;
      return { size: bytes.length, read: (o, n) => Promise.resolve(bytes.slice(o, o + n)) };
    },
    path: (video, sha) =>
      byVideo.get(video.toString())?.files.has(sha) === true ? `/store/files/${sha}` : undefined,
  };
}

describe('NfxRtcSeeding (#89)', () => {
  const bodies = segments(4);
  const v = testNfxVideo(bodies);

  /** Turn it on, and wait for the pass that queues. */
  async function start(s: NfxRtcSeeding): Promise<void> {
    await s.set(true);
    await s.idle();
  }

  /** Another pass, waited for. */
  async function again(s: NfxRtcSeeding): Promise<void> {
    s.refresh();
    await s.idle();
  }

  it('serves each rendition in its web swarm, by #EXTINF index, from the store at listed sizes', async () => {
    const node = new FakeNode();
    const s = new NfxRtcSeeding({
      node: node as unknown as NfxRtcNode,
      store: store([v]),
      logger: silentLogger,
    });
    await start(s);
    const helper = node.helper!;
    const want = bodies.map((b, id) => ({ id, path: `/store/files/${sha256(b)}`, size: b.length }));
    expect(helper.serves).toEqual([
      { swarm: addr(v).webStreamSwarmId('360p'), segments: want, append: false },
      { swarm: addr(v).webStreamSwarmId('720p'), segments: want, append: false },
    ]);
    expect(s.videos).toBe(1);
    expect(s.swarms(v.video)).toEqual([
      addr(v).webStreamSwarmId('360p'),
      addr(v).webStreamSwarmId('720p'),
    ]);
    // A pass with nothing new serves nothing again.
    await again(s);
    expect(helper.serves).toHaveLength(2);
    await s.close();
  });

  it('stops serving what left the store, and everything when turned off', async () => {
    const node = new FakeNode();
    const st = store([v]);
    const s = new NfxRtcSeeding({
      node: node as unknown as NfxRtcNode,
      store: st,
      logger: silentLogger,
    });
    await start(s);
    st.records.length = 0;
    await again(s);
    expect(node.helper!.unserves).toEqual([
      addr(v).webStreamSwarmId('360p'),
      addr(v).webStreamSwarmId('720p'),
    ]);
    expect(s.videos).toBe(0);
    st.records.push({ video: v.video, root: v.root, segs: String(v.segs), files: [], addedAt: 0 });
    await again(s);
    expect(s.videos).toBe(1);
    await s.set(false);
    expect(s.videos).toBe(0);
    expect(node.helper!.unserves).toHaveLength(4);
    await s.close();
  });

  it('serves again for a new helper, and never while WebRTC is off', async () => {
    const node = new FakeNode();
    const s = new NfxRtcSeeding({
      node: node as unknown as NfxRtcNode,
      store: store([v]),
      logger: silentLogger,
    });
    await start(s);
    node.restart();
    await again(s);
    expect(node.helper!.serves).toHaveLength(2);
    await s.close();

    const off = new FakeNode();
    off.on = false;
    const s2 = new NfxRtcSeeding({
      node: off as unknown as NfxRtcNode,
      store: store([v]),
      logger: silentLogger,
    });
    await start(s2);
    expect(off.helper!.serves).toEqual([]);
    await s2.close();
  });

  it('refuses a video whose hash list does not verify, once, and serves the others', async () => {
    // Its hash list names another video than the record does.
    const broken = testNfxVideo(segments(2));
    const files = broken.files;
    const node = new FakeNode();
    const warn = vi.fn();
    const s = new NfxRtcSeeding({
      node: node as unknown as NfxRtcNode,
      store: store([{ ...broken, video: `${broken.video}x`, files }, v]),
      logger: { ...silentLogger, warn },
    });
    await start(s);
    expect(s.videos).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      'nfx: a stored video is not served over WebRTC',
      expect.objectContaining({ video: `${broken.video}x` }),
    );
    await again(s);
    expect(warn).toHaveBeenCalledTimes(1);
    await s.close();
  });

  it('a helper failure is retried at the next pass, not held against the video', async () => {
    const node = new FakeNode();
    node.helper!.failServe = new HelperError('not-ready', 'restarting');
    const s = new NfxRtcSeeding({
      node: node as unknown as NfxRtcNode,
      store: store([v]),
      logger: silentLogger,
    });
    await start(s);
    expect(s.videos).toBe(0);
    node.helper!.failServe = null;
    await again(s);
    expect(s.videos).toBe(1);
    await s.close();
  });

  it('pages a long table under the frame cap, in order', () => {
    const long = Array.from({ length: 2000 }, (_, id) => ({
      id,
      path: `/store/files/${'ab'.repeat(32)}`,
      size: 1_000_000,
    }));
    const ps = pages(long);
    expect(ps.length).toBeGreaterThan(1);
    expect(ps.flat()).toEqual(long);
    for (const p of ps) expect(JSON.stringify(p).length).toBeLessThanOrEqual(PAGE_BYTES + 2);
    expect(pages([])).toEqual([]);
  });
});
