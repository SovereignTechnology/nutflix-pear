/**
 * NFX-18 (plan P3): a worker with no mint keeps a free NFX video its user watched. Driven through
 * the real wire (`WorkerRpc` + the L6-0 guards) against a seeder listening on a local hyperdht
 * testnet, with the worker's monotonic clock in the test's hands.
 *
 * - A keep before the play has been open a minute is refused.
 * - Once a minute was open and read, the keep begins; its play's spooled files go to the store
 *   when the play closes, and only the rest are fetched, each once.
 * - The rendition ends held: served, listed, announced by `nfx.keep.changed`, and dropped on ask.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { nfx } from '@sovit/core';
import { hyperdhtEndpoint, listenNfx } from '@sovit/seeder';
import type { NfxFileSource } from '@sovit/seeder';
import DHT from 'hyperdht';
import createTestnet from 'hyperdht/testnet.js';
import type { Testnet } from 'hyperdht/testnet.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionId } from '../../ipc/protocol.js';
import type { NfxHyperdhtEndpointWire, WorkerEvent } from '../../ipc/worker-protocol.js';
import { NFX_PLAY_DIR } from '../nfx/watching.js';
import { httpGet, nodeRuntime, sleep, startWorker, tempDir } from './helpers/harness.js';
import { NFX_NS, memorySource, segments, testNfxVideo } from './helpers/nfx-video.js';

vi.setConfig({ testTimeout: 90_000 });

const sid = (): SessionId => randomBytes(16).toString('hex') as SessionId;

/** `source`, counting how often each file is asked for. */
function counting(source: NfxFileSource, asked: Map<string, number>): NfxFileSource {
  return {
    hasVideo: (video) => source.hasVideo(video),
    file: (video, sha) => {
      asked.set(sha, (asked.get(sha) ?? 0) + 1);
      return source.file(video, sha);
    },
  };
}

describe('NFX-18: keeping what is watched', () => {
  let testnet: Testnet;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    testnet = await createTestnet(3);
  });
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    await testnet.destroy();
  });

  async function seeder(source: NfxFileSource): Promise<NfxHyperdhtEndpointWire> {
    const dht = new DHT({ bootstrap: testnet.bootstrap });
    cleanups.push(() => dht.destroy());
    await dht.fullyBootstrapped();
    const keyPair = DHT.keyPair();
    const listener = await listenNfx(dht, { keyPair, source });
    cleanups.push(() => listener.close());
    return hyperdhtEndpoint(keyPair, 'ab'.repeat(32), NFX_NS);
  }

  it('keeps the rendition a minute was watched of, finishing it after the play closes', async () => {
    // 40 segments of 2 s: a minute read leaves the last ones for the keep job.
    const v = testNfxVideo(segments(40));
    const addr = nfx.VideoAddr.parse(v.video);
    if (!addr.ok) throw new Error('bad test video');
    const asked = new Map<string, number>();
    const peer = await seeder(counting(memorySource(v.files, v.video), asked));

    let clock = 1_000_000;
    const d = await tempDir('nf-nfx-keep-');
    const w = startWorker({
      logLevel: 'warn',
      testBootstrap: testnet.bootstrap,
      runtime: { ...nodeRuntime(), monotonicNow: () => clock },
    });
    cleanups.push(
      () => d.rm(),
      () => w.close(),
    );
    await w.call('init', {
      v: 1,
      storage: d.dir,
      seeding: { enabled: false, diskCapBytes: 1024 ** 3 },
      prefetchSeconds: 0,
      nfx: { enabled: true, irohRelays: [] },
    });
    expect(w.host.internals.seeder).toBeNull();
    const store = w.host.internals.nfxStore;
    if (store === null) throw new Error('a worker with no mint has no NFX store');

    const s = sid();
    const opened = await w.call('nfx.play.open', {
      sid: s,
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [peer],
      iroh: [],
      prefetchSeconds: 0,
    });
    expect(opened.rendition).toBe('720p');
    // Segments 0-30 read: 62 s of media. With no prefetch the play asks for 31 and 32 at most.
    const end = v.segmentAt[31]! - 1;
    const read = await httpGet(opened.link, { range: `bytes=0-${end}` });
    expect(read.status).toBe(206);
    expect(read.body.equals(Buffer.from(v.expected.subarray(0, end + 1)))).toBe(true);

    // Open for less than a minute by the worker's clock.
    await expect(w.call('nfx.play.keep', { sid: s, reason: 'watched' })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(store.keptOf(addr.value)).toBeUndefined();
    clock += 60_000;
    expect(await w.call('nfx.play.keep', { sid: s, reason: 'watched' })).toEqual({
      state: 'filling',
    });
    const filling = (await w.call('nfx.keep.list', {})).videos;
    expect(filling).toEqual([
      {
        video: v.video,
        root: v.root,
        segs: v.segs,
        held: [],
        // The hash list, both playlists, the init and 40 segments; the first two written already.
        filling: { rendition: '720p', done: 2, total: 44 },
        reasons: ['watched'],
        // Nothing is fetched for the keep while its play is open.
        job: { state: 'waiting' },
      },
    ]);

    await w.call('nfx.play.close', { sid: s });
    expect(existsSync(join(d.dir, 'tmp', NFX_PLAY_DIR, s))).toBe(false);
    const deadline = Date.now() + 30_000;
    while (store.servedRenditions(addr.value) === undefined) {
      if (Date.now() > deadline) throw new Error('the rendition was never held');
      await sleep(100);
    }
    expect(store.servedRenditions(addr.value)).toEqual(['720p']);
    expect((await w.call('nfx.keep.list', {})).videos).toEqual([
      {
        video: v.video,
        root: v.root,
        segs: v.segs,
        held: ['720p'],
        filling: null,
        reasons: ['watched'],
        job: { state: 'held' },
      },
    ]);
    await w.event(
      (e): e is Extract<WorkerEvent, { e: 'nfx.keep.changed' }> =>
        e.e === 'nfx.keep.changed' && e.video === v.video,
      5_000,
    );

    // What the play spooled went to the store: asked for once, by the play. The tail the play
    // never asked for was fetched by the keep job, once.
    const shas = [v.root, ...v.segmentShas.slice(0, 31)];
    expect(shas.map((sha) => asked.get(sha))).toEqual(shas.map(() => 1));
    const tail = v.segmentShas.slice(33);
    expect(tail.map((sha) => asked.get(sha))).toEqual(tail.map(() => 1));

    // Dropped on ask: its one reason gone, the video goes.
    expect(await w.call('nfx.keep.drop', { video: v.video, reason: 'downloaded' })).toEqual({
      dropped: false,
    });
    expect(await w.call('nfx.keep.drop', { video: v.video, reason: 'watched' })).toEqual({
      dropped: true,
    });
    expect(store.servedRenditions(addr.value)).toBeUndefined();
    expect((await w.call('nfx.keep.list', {})).videos).toEqual([]);
    expect(w.invalid).toEqual([]);
  });
});
