/**
 * NFX-18 (plan P3): the worker's keep jobs (`nfx/keeping.ts`) over a real NFX store in a temp
 * directory, with fakes for the plays and the network: the minute rule, the play's spool taken at
 * its close, two jobs at once and the rest in order, one while a play is open, the hour's budget,
 * a drop that stops its job, a failure and its retry, a resume after a restart, NFX off.
 */
import { randomBytes } from 'node:crypto';

import { nfx } from '@sovit/core';
import { KeepBudget, NfxStore, nodeCrypto, nodeFs, silentLogger } from '@sovit/seeder';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NfxHyperdhtEndpointWire, NfxKeptVideoWire } from '../../ipc/worker-protocol.js';
import type { NfxKeepingDeps } from '../nfx/keeping.js';
import { NfxKeeping } from '../nfx/keeping.js';
import type { NfxFetcher, NfxSpool } from '../nfx/watch.js';
import { NfxFetchError } from '../nfx/watch.js';
import type { NfxPlayKeep, NfxSources } from '../nfx/watching.js';
import { tempDir } from './helpers/harness.js';
import type { TestNfxVideo } from './helpers/nfx-video.js';
import { INIT, NFX_NS, SCALE, segment, sha256, testNfxVideo } from './helpers/nfx-video.js';

vi.setConfig({ testTimeout: 30_000 });

const ENDPOINT: NfxHyperdhtEndpointWire = {
  t: 'hyperdht',
  peer: 'a'.repeat(64),
  bind: 'b'.repeat(128),
};
/** Three videos of two renditions over one init and four 2 s segments, each its own. */
const VIDEOS = [0, 1, 2].map((v) =>
  testNfxVideo(
    Array.from({ length: 4 }, (_, i) => segment(i * 2 * SCALE, 40 + 7 * i + 100 * v)),
    `${NFX_NS}:nutflix-${v.toString(16).padStart(32, '0')}`,
  ),
);
const V0 = VIDEOS[0]!;
const V1 = VIDEOS[1]!;
const V2 = VIDEOS[2]!;
const INIT_SHA = sha256(INIT);

function addrOf(v: TestNfxVideo): nfx.VideoAddr {
  const a = nfx.VideoAddr.parse(v.video);
  if (!a.ok) throw new Error('bad test video');
  return a.value;
}

/** The sha256 of `v`'s playlist for rendition `id`. */
function playlistOf(v: TestNfxVideo, id: string): string {
  const list = nfx.verifyHashList(v.files.get(v.root)!, v.root, addrOf(v), BigInt(v.segs));
  if (!list.ok) throw new Error(list.error.reason);
  const r = list.value.renditions.find((x) => x.id === id)!;
  return list.value.files.find((f) => f.role === 'playlist' && f.name === r.playlist)!.sha256;
}

async function until(pred: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Call {
  readonly video: string;
  readonly sha: string;
  resolve(): void;
  reject(err: Error): void;
}

/** The network: per video its files; each fetch waits for the test unless `auto`. */
class Net {
  readonly calls: Call[] = [];
  readonly fetched: { readonly video: string; readonly sha: string }[] = [];
  readonly closed: string[] = [];
  readonly failing = new Set<string>();
  auto = false;
  maxInFlight = 0;
  maxPerVideo = 0;

  fetcherFor(s: NfxSources): NfxFetcher {
    const key = s.video.toString();
    const v = VIDEOS.find((x) => x.video === key)!;
    const mine = new Set<Call>();
    let closed = false;
    const drop = (c: Call): void => {
      mine.delete(c);
      this.calls.splice(this.calls.indexOf(c), 1);
    };
    return {
      fetch: (sha) =>
        new Promise<Uint8Array>((resolve, reject) => {
          if (closed) {
            reject(new NfxFetchError(['closed']));
            return;
          }
          const call: Call = {
            video: key,
            sha,
            resolve: () => {
              drop(call);
              const bytes = v.files.get(sha);
              if (bytes === undefined || this.failing.has(key)) {
                reject(new NfxFetchError(['missing']));
                return;
              }
              this.fetched.push({ video: key, sha });
              resolve(bytes);
            },
            reject: (err) => {
              drop(call);
              reject(err);
            },
          };
          this.calls.push(call);
          mine.add(call);
          this.maxInFlight = Math.max(this.maxInFlight, this.calls.length);
          this.maxPerVideo = Math.max(this.maxPerVideo, mine.size);
          if (this.auto || this.failing.has(key)) call.resolve();
        }),
      close: () => {
        closed = true;
        this.closed.push(key);
        for (const c of [...mine]) c.reject(new NfxFetchError(['closed']));
        return Promise.resolve();
      },
    };
  }

  inFlight(): string[] {
    return this.calls.map((c) => c.video);
  }

  /** Answer `v`'s fetches until the store holds it. */
  async finish(store: NfxStore, v: TestNfxVideo): Promise<void> {
    const held = (): boolean => store.servedRenditions(addrOf(v)) !== undefined;
    while (!held()) {
      await until(() => held() || this.calls.some((c) => c.video === v.video), 'a fetch');
      for (const c of this.calls.filter((x) => x.video === v.video)) c.resolve();
      await sleep(1);
    }
  }
}

interface PlayTimes {
  readonly openForMs?: number;
  readonly mediaReadMs?: number;
}

/** A play of `v` at 720p, as `NfxWatching.keepView` gives one; `close` hands `spool` over. */
function play(
  v: TestNfxVideo,
  over: PlayTimes = {},
  spool: ReadonlyMap<string, Uint8Array> = new Map(),
): { readonly view: NfxPlayKeep; close(): Promise<void> } {
  let take: ((s: NfxSpool) => Promise<void>) | null = null;
  let closing = false;
  const playlistSha = playlistOf(v, '720p');
  const view: NfxPlayKeep = {
    sid: randomBytes(16).toString('hex'),
    sources: { video: addrOf(v), root: v.root, segs: v.segs, peers: [ENDPOINT], iroh: [] },
    openForMs: over.openForMs ?? 60_000,
    mediaReadMs: over.mediaReadMs ?? 60_000,
    hashListBytes: v.files.get(v.root)!,
    rendition: '720p',
    playlistSha,
    playlistBytes: v.files.get(playlistSha)!,
    keepOnClose: (t) => {
      if (closing) return false;
      take = t;
      return true;
    },
  };
  return {
    view,
    close: async () => {
      closing = true;
      await take?.({
        shas: [...spool.keys()],
        read: (sha) => Promise.resolve(spool.get(sha) ?? null),
      });
    },
  };
}

const teardown: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const t of teardown.splice(0).reverse()) await t();
});

async function setup(
  o: { readonly starts?: number; readonly bytes?: number } & Partial<NfxKeepingDeps> = {},
): Promise<{
  readonly store: NfxStore;
  readonly net: Net;
  readonly keeping: NfxKeeping;
  readonly changed: string[];
  playing(on: boolean): void;
  entry(v: TestNfxVideo): NfxKeptVideoWire | undefined;
}> {
  const { starts, bytes, ...deps } = o;
  const d = await tempDir('nf-keeping-');
  teardown.push(() => d.rm());
  const store = new NfxStore({ fs: nodeFs, crypto: nodeCrypto, dataDir: d.dir });
  await store.load();
  const budget = new KeepBudget({
    fs: nodeFs,
    crypto: nodeCrypto,
    dir: d.dir,
    ...(starts === undefined ? {} : { startsPerHour: starts }),
    ...(bytes === undefined ? {} : { bytesPerHour: bytes }),
  });
  await budget.load();
  const net = new Net();
  let playing = false;
  const changed: string[] = [];
  const keeping = new NfxKeeping({
    store,
    budget,
    fetcherFor: (s) => net.fetcherFor(s),
    playing: () => playing,
    changed: (v) => changed.push(v),
    logger: silentLogger,
    on: true,
    eventMs: 5,
    ...deps,
  });
  teardown.push(() => keeping.close());
  return {
    store,
    net,
    keeping,
    changed,
    playing: (on) => {
      playing = on;
      keeping.wake();
    },
    entry: (v) => keeping.list().find((x) => x.video === v.video),
  };
}

/** Keep `v` as watched from a play, and close the play (its spool handed over). */
async function keepAndClose(
  keeping: NfxKeeping,
  v: TestNfxVideo,
  spool?: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  const p = play(v, {}, spool);
  expect(await keeping.keepPlay(p.view, 'watched')).toEqual({ state: 'filling' });
  await p.close();
}

describe('NFX-18: keep jobs', () => {
  it('keeps a watched video only after a minute; a download at once; nothing fetched while it plays', async () => {
    const s = await setup();
    const short: PlayTimes[] = [{ openForMs: 59_999 }, { mediaReadMs: 59_999 }];
    for (const over of short)
      await expect(s.keeping.keepPlay(play(V0, over).view, 'watched')).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    expect(s.store.keptVideos()).toEqual([]);

    const p = play(V0, { openForMs: 0, mediaReadMs: 0 });
    expect(await s.keeping.keepPlay(p.view, 'downloaded')).toEqual({ state: 'filling' });
    // Begun: the hash list and the playlist are on disk, 8 files in all (3 meta, init, 4 segments).
    expect(s.entry(V0)).toEqual({
      video: V0.video,
      root: V0.root,
      segs: V0.segs,
      held: [],
      filling: { rendition: '720p', done: 2, total: 8 },
      reasons: ['downloaded'],
      job: { state: 'waiting' },
    });
    await sleep(30);
    expect(s.net.calls).toEqual([]);
    await until(() => s.changed.includes(V0.video), 'nfx.keep.changed');
  });

  it("takes the play's spool at its close and fetches only the rest", async () => {
    const s = await setup();
    s.net.auto = true;
    const [seg0] = V0.segmentShas;
    const spool = new Map([
      [INIT_SHA, INIT],
      [seg0!, V0.files.get(seg0!)!],
    ]);
    await keepAndClose(s.keeping, V0, spool);
    await until(() => s.entry(V0)?.job?.state === 'held', 'held');
    expect(s.store.servedRenditions(addrOf(V0))).toEqual(['720p']);
    expect(new Set(s.net.fetched.map((f) => f.sha))).toEqual(
      new Set([playlistOf(V0, '360p'), ...V0.segmentShas.slice(1)]),
    );
    expect(s.entry(V0)).toMatchObject({ held: ['720p'], filling: null, reasons: ['watched'] });
    expect(s.net.closed).toEqual([V0.video]);
  });

  it('runs two jobs at once, one file each at a time, and the rest in order', async () => {
    const s = await setup();
    for (const v of [V0, V1, V2]) await keepAndClose(s.keeping, v);
    await until(() => s.net.calls.length === 2, 'two fetches');
    await sleep(20);
    expect(s.net.inFlight().sort()).toEqual([V0.video, V1.video].sort());
    expect(s.entry(V2)?.job).toEqual({ state: 'waiting' });
    expect(s.entry(V0)?.job).toEqual({ state: 'fetching' });

    await s.net.finish(s.store, V0);
    await until(() => s.net.inFlight().includes(V2.video), 'the third job');
    expect(s.net.inFlight().sort()).toEqual([V1.video, V2.video].sort());
    await s.net.finish(s.store, V1);
    await s.net.finish(s.store, V2);
    expect(s.net.maxInFlight).toBe(2);
    expect(s.net.maxPerVideo).toBe(1);
  });

  it('yields to playback: one job while a play is open, the other at its next file', async () => {
    const s = await setup();
    s.playing(true);
    for (const v of [V0, V1]) await keepAndClose(s.keeping, v);
    await until(() => s.net.calls.length === 1, 'one fetch');
    await sleep(30);
    expect(s.net.inFlight()).toEqual([V0.video]);
    expect(s.entry(V1)?.job).toEqual({ state: 'waiting' });

    s.playing(false);
    await until(() => s.net.inFlight().includes(V1.video), 'the second job');
    // A play opens again: the second job's file in flight lands, and it waits for its turn.
    s.playing(true);
    for (const c of s.net.calls.filter((x) => x.video === V1.video)) c.resolve();
    await sleep(30);
    expect(s.net.inFlight()).toEqual([V0.video]);
    await s.net.finish(s.store, V0);
    await until(() => s.net.inFlight().includes(V1.video), 'the second job again');
    await s.net.finish(s.store, V1);
    expect(s.net.maxInFlight).toBe(2);
  });

  it('the hour: no starts left refuses a new video; no bytes left makes the job wait', async () => {
    const one = await setup({ starts: 1 });
    await keepAndClose(one.keeping, V0);
    await expect(one.keeping.keepPlay(play(V1).view, 'watched')).rejects.toMatchObject({
      code: 'rate-limited',
    });
    // The same rendition again takes no new start.
    expect(await one.keeping.keepPlay(play(V0).view, 'downloaded')).toEqual({ state: 'filling' });

    const s = await setup({ bytes: 1, budgetRetryMs: 60_000 });
    s.net.auto = true;
    await keepAndClose(s.keeping, V0);
    await until(() => s.changed.includes(V0.video), 'nfx.keep.changed');
    await sleep(80);
    expect(s.entry(V0)?.job).toEqual({ state: 'waiting' });
    expect(s.net.fetched).toEqual([]);
    expect(s.store.servedRenditions(addrOf(V0))).toBeUndefined();
  });

  it('a drop of the last reason stops the job first, and the video stays gone', async () => {
    const s = await setup();
    await keepAndClose(s.keeping, V0);
    await until(() => s.net.calls.length === 1, 'a fetch');
    expect(await s.keeping.drop(V0.video, 'watched')).toBe(true);
    expect(s.store.keptOf(addrOf(V0))).toBeUndefined();
    await until(() => s.net.closed.includes(V0.video), 'its fetcher closed');
    expect(s.net.calls).toEqual([]);
    await sleep(30);
    expect(s.store.keptOf(addrOf(V0))).toBeUndefined();
    expect(s.keeping.list()).toEqual([]);
    expect(await s.keeping.drop(V0.video, 'watched')).toBe(false);

    // One reason of two: the video and its job stay.
    s.net.auto = true;
    const p = play(V1);
    await s.keeping.keepPlay(p.view, 'watched');
    await s.keeping.keepPlay(p.view, 'downloaded');
    expect(await s.keeping.drop(V1.video, 'watched')).toBe(true);
    await p.close();
    await until(() => s.entry(V1)?.job?.state === 'held', 'held');
    expect(s.entry(V1)?.reasons).toEqual(['downloaded']);
  });

  it('a file no source serves fails the job with why; a resume retries it', async () => {
    const s = await setup();
    s.net.failing.add(V0.video);
    await keepAndClose(s.keeping, V0);
    await until(() => s.entry(V0)?.job?.state === 'failed', 'failed');
    expect(s.entry(V0)?.job).toEqual({ state: 'failed', error: 'fetch' });
    expect(s.entry(V0)?.filling?.rendition).toBe('720p');

    s.net.failing.delete(V0.video);
    s.net.auto = true;
    s.keeping.resume({
      video: V0.video,
      root: V0.root,
      segs: V0.segs,
      rendition: '720p',
      peers: [ENDPOINT],
      iroh: [],
    });
    await until(() => s.entry(V0)?.job?.state === 'held', 'held');
    expect(s.store.servedRenditions(addrOf(V0))).toEqual(['720p']);
  });

  it('after a restart a filling keep waits for its sources, then fetches its hash list first', async () => {
    const s = await setup();
    const playlistSha = playlistOf(V0, '720p');
    const begun = await s.store.beginKeep({
      video: addrOf(V0),
      root: V0.root,
      segs: BigInt(V0.segs),
      hashListBytes: V0.files.get(V0.root)!,
      rendition: '720p',
      playlistBytes: V0.files.get(playlistSha)!,
      reason: 'watched',
    });
    expect(begun.ok).toBe(true);
    expect(s.entry(V0)?.job).toBeNull();
    await sleep(30);
    expect(s.net.calls).toEqual([]);

    const resume = (over: { readonly video?: string; readonly rendition?: string } = {}): void => {
      s.keeping.resume({
        video: over.video ?? V0.video,
        root: V0.root,
        segs: V0.segs,
        rendition: over.rendition ?? '720p',
        peers: [ENDPOINT],
        iroh: [],
      });
    };
    expect(() => {
      resume({ video: V1.video });
    }).toThrow(/^not-found:/);
    expect(() => {
      resume({ rendition: '360p' });
    }).toThrow(/^not-found:/);

    s.net.auto = true;
    resume();
    await until(() => s.entry(V0)?.job?.state === 'held', 'held');
    expect(s.net.fetched.slice(0, 2).map((f) => f.sha)).toEqual([V0.root, playlistSha]);
    expect(s.store.servedRenditions(addrOf(V0))).toEqual(['720p']);
    // Held already: a resume has nothing to do.
    resume();
    expect(s.entry(V0)?.job).toEqual({ state: 'held' });
  });

  it('NFX off: no keep begins and a running job waits; on again, it goes on; close stops it', async () => {
    const s = await setup();
    await keepAndClose(s.keeping, V0);
    await until(() => s.net.calls.length === 1, 'a fetch');
    s.keeping.setOn(false);
    await until(() => s.net.closed.includes(V0.video), 'its fetcher closed');
    await sleep(20);
    expect(s.net.calls).toEqual([]);
    expect(s.entry(V0)?.job).toEqual({ state: 'waiting' });
    await expect(s.keeping.keepPlay(play(V1).view, 'watched')).rejects.toMatchObject({
      code: 'forbidden',
    });

    s.keeping.setOn(true);
    await until(() => s.net.calls.length === 1, 'a fetch again');
    await s.keeping.close();
    expect(s.net.calls).toEqual([]);
    // Still filling, to be resumed by the next run.
    expect(s.store.keptOf(addrOf(V0))?.filling?.rendition).toBe('720p');
    await expect(s.keeping.keepPlay(play(V1).view, 'watched')).rejects.toMatchObject({
      code: 'backend-down',
    });
  });
});
