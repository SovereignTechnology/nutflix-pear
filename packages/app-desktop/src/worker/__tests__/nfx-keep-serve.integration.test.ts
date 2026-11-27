/**
 * NFX-18 (pear #156, P3b): a worker with NO payment providers (no mint, no seeder) still has its
 * NFX store and serves what it keeps over HyperDHT (NFX-12), on its watching side's own DHT node,
 * under the key a seeder would derive from the same storage. Driven through the real wire
 * (`WorkerRpc` + the L6-0 guards) on a local hyperdht testnet.
 *
 * - While a kept rendition is still filling, nothing of the video is served.
 * - Once it is held, its files come back byte for byte, each under its hash-list sha256.
 * - A worker started again over the same storage serves it under the same listener key.
 */
import { createHash } from 'node:crypto';

import type { NostrPubkey } from '@sovit/core';
import { nfx } from '@sovit/core';
import { dialNfx, nodeCrypto } from '@sovit/seeder';
import type { NfxStore } from '@sovit/seeder';
import DHT from 'hyperdht';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { WorkerEvent } from '../../ipc/worker-protocol.js';
import type { DevTestnet } from '../dev/fixtures-net.js';
import { startDevTestnet } from '../dev/fixtures-net.js';
import type { WorkerClient } from './helpers/harness.js';
import { sleep, startWorker, tempDir } from './helpers/harness.js';
import { testNfxVideo } from './helpers/nfx-video.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const SEEDER = 'ab'.repeat(32) as NostrPubkey;
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe('NFX-18: a worker with no mint serves what it keeps', () => {
  const teardown: (() => Promise<void>)[] = [];
  const v = testNfxVideo();
  let testnet: DevTestnet;
  let storage: string;
  let current: WorkerClient | null = null;

  beforeAll(async () => {
    testnet = await startDevTestnet();
    teardown.push(() => testnet.destroy());
    const d = await tempDir('nf-keep-serve-');
    storage = d.dir;
    teardown.push(() => d.rm());
  });
  afterAll(async () => {
    await current?.close();
    for (const t of teardown.splice(0).reverse()) await t().catch(() => undefined);
  });

  const addr = (): nfx.VideoAddr => {
    const a = nfx.VideoAddr.parse(v.video);
    if (!a.ok) throw new Error('bad test video');
    return a.value;
  };

  /** No providers: no seeder, no swarm. Seeding and NFX on. */
  async function start(): Promise<{ w: WorkerClient; store: NfxStore }> {
    await current?.close();
    const w = startWorker({ logLevel: 'info', testBootstrap: testnet.bootstrap });
    current = w;
    await w.call('init', {
      v: 1,
      storage,
      seeding: { enabled: true, diskCapBytes: 1024 ** 3 },
      prefetchSeconds: 30,
      nfx: { enabled: true, irohRelays: [] },
    });
    await w.event((e): e is Extract<WorkerEvent, { e: 'ready' }> => e.e === 'ready', 10_000);
    expect(w.host.internals.seeder).toBeNull();
    const store = w.host.internals.nfxStore;
    if (store === null) throw new Error('a worker with no mint has no NFX store');
    return { w, store };
  }

  /** The listener's key once it is up (asking is what waits for it). */
  async function peer(w: WorkerClient): Promise<string> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const r = await w.call('nfx.endpoint', { seeder: SEEDER, video: v.video });
      if (r.hyperdht !== null) {
        expect(
          nfx.verifyHyperdhtBind(r.hyperdht.peer, r.hyperdht.bind, SEEDER, 'nfx:testnet:1'),
        ).toBe(true);
        return r.hyperdht.peer;
      }
      if (Date.now() > deadline) throw new Error('the NFX-12 listener never came up');
      await sleep(250);
    }
  }

  /** Fetch file `sha` of the video from `peerHex`: its bytes, or `null` when refused. */
  async function fetchFrom(peerHex: string, sha: string): Promise<Uint8Array | null> {
    const dht = new DHT({ bootstrap: testnet.bootstrap });
    try {
      await dht.fullyBootstrapped();
      const dialed = await dialNfx(dht, Buffer.from(peerHex, 'hex'), {
        keyPair: DHT.keyPair(),
        crypto: nodeCrypto,
        timeoutMs: 20_000,
      });
      if (!dialed.ok) throw new Error(`dial failed: ${dialed.reason}`);
      try {
        const files = dialed.connection.files(addr());
        if (files === undefined) return null;
        const size = v.files.get(sha)!.byteLength;
        const chunks: Uint8Array[] = [];
        const r = await files.fetch({ sha, size, sink: { write: (c) => void chunks.push(c) } });
        return r.ok ? Buffer.concat(chunks) : null;
      } finally {
        dialed.connection.destroy('test over');
      }
    } finally {
      await dht.destroy();
    }
  }

  it('serves nothing while filling, every file once held, and the same key after a restart', async () => {
    const { w, store } = await start();
    const key = await peer(w);

    const listBytes = v.files.get(v.root)!;
    const list = nfx.verifyHashList(listBytes, v.root, addr(), BigInt(v.segs));
    if (!list.ok) throw new Error(list.error.reason);
    const entry = list.value.files.find((f) => f.name === 'playlist-720p.m3u8');
    if (entry === undefined) throw new Error('no 720p playlist');
    const begun = await store.beginKeep({
      video: addr(),
      root: v.root,
      segs: BigInt(v.segs),
      hashListBytes: listBytes,
      rendition: '720p',
      playlistBytes: v.files.get(entry.sha256)!,
      reason: 'watched',
    });
    if (!begun.ok) throw new Error(begun.message);
    if (begun.state !== 'filling') throw new Error(`not filling: ${begun.state}`);
    const { fillId } = begun;
    const missing = store.keepMissing(addr());
    // All but one file on disk: still filling, so nothing is served, the hash list included.
    for (const f of missing.slice(0, -1)) {
      const put = await store.putKeptFile(addr(), fillId, f.sha256, v.files.get(f.sha256)!);
      expect(put.ok).toBe(true);
    }
    expect(await fetchFrom(key, v.root)).toBeNull();

    const last = missing.at(-1)!;
    const lastPut = await store.putKeptFile(addr(), fillId, last.sha256, v.files.get(last.sha256)!);
    expect(lastPut.ok).toBe(true);
    const done = await store.completeKeep(addr(), fillId);
    expect(done.ok && done.state).toBe('held');
    for (const sha of [v.root, entry.sha256, ...v.segmentShas]) {
      const got = await fetchFrom(key, sha);
      expect(got === null ? null : sha256(got)).toBe(sha);
    }

    // Started again over the same storage, still with no mint: the same key, the video kept.
    const again = await start();
    expect(again.store.servedRenditions(addr())).toEqual(['720p']);
    expect(await peer(again.w)).toBe(key);
    const seg = await fetchFrom(key, v.segmentShas[0]!);
    expect(seg === null ? null : sha256(seg)).toBe(v.segmentShas[0]);
  });
});
