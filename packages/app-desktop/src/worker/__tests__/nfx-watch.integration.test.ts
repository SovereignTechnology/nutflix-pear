/**
 * Slice 5d: a worker WITHOUT payment providers (no swarm, no seeder) plays a free NFX video over a
 * local hyperdht testnet, through the real wire (`WorkerRpc` + the L6-0 guards). Seeders listen
 * with `@sovit/seeder`'s `listenNfx` on a source of a tiny but valid fMP4 video; the worker dials
 * them from a DHT node of its own, skips a seeder without the files, and its link serves layout C
 * (init ‖ sidx ‖ segments from their `moof`) by Range, byte for byte.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';

import { hyperdhtEndpoint, listenNfx } from '@sovit/seeder';
import type { NfxFileSource } from '@sovit/seeder';
import DHT from 'hyperdht';
import createTestnet from 'hyperdht/testnet.js';
import type { Testnet } from 'hyperdht/testnet.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionId } from '../../ipc/protocol.js';
import type { NfxHyperdhtEndpointWire, NfxPlayOpenArgs } from '../../ipc/worker-protocol.js';
import { MAX_NFX_SESSIONS, NFX_PLAY_DIR } from '../nfx/watching.js';
import type { WorkerClient } from './helpers/harness.js';
import { httpGet, startWorker, tempDir } from './helpers/harness.js';
import { NFX_NS, memorySource, testNfxVideo } from './helpers/nfx-video.js';

vi.setConfig({ testTimeout: 90_000 });

const sid = (): SessionId => randomBytes(16).toString('hex') as SessionId;

function httpHead(
  url: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'HEAD', agent: false }, (res) => {
      let n = 0;
      res.on('data', (c: Buffer) => {
        n += c.byteLength;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: n });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('slice 5d: free NFX play without payment providers', () => {
  let testnet: Testnet;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    testnet = await createTestnet(3);
  });
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    await testnet.destroy();
  });

  /** A seeder listening on the testnet; its beacon endpoint. */
  async function seeder(source: NfxFileSource): Promise<NfxHyperdhtEndpointWire> {
    const dht = new DHT({ bootstrap: testnet.bootstrap });
    cleanups.push(() => dht.destroy());
    await dht.fullyBootstrapped();
    const keyPair = DHT.keyPair();
    const listener = await listenNfx(dht, { keyPair, source });
    cleanups.push(() => listener.close());
    return hyperdhtEndpoint(keyPair, 'ab'.repeat(32), NFX_NS);
  }

  async function worker(): Promise<{ w: WorkerClient; storage: string }> {
    const d = await tempDir('nf-nfx-watch-');
    const w = startWorker({ logLevel: 'warn', testBootstrap: testnet.bootstrap });
    cleanups.push(
      () => d.rm(),
      () => w.close(),
    );
    await w.call('init', {
      v: 1,
      storage: d.dir,
      seeding: { enabled: false, diskCapBytes: 1024 ** 3 },
      prefetchSeconds: 30,
    });
    expect(w.host.internals.seeder).toBeNull();
    return { w, storage: d.dir };
  }

  it('opens over HyperDHT, skips a seeder without the files, and serves layout C by range', async () => {
    const v = testNfxVideo();
    const empty = await seeder(memorySource(new Map(), v.video));
    const full = await seeder(memorySource(v.files, v.video));
    const { w, storage } = await worker();
    const s = sid();
    const opened = await w.call('nfx.play.open', {
      sid: s,
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [empty, full],
      prefetchSeconds: 30,
    });
    // The highest bandwidth by default; every rendition listed, highest first.
    expect(opened.rendition).toBe('720p');
    expect(opened.renditions).toEqual([
      { id: '720p', bandwidth: 2_000_000, resolution: '1280x720' },
      { id: '360p', bandwidth: 500_000, resolution: '640x360' },
    ]);
    expect(opened.link).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/[0-9a-f]{32}/${s}$`));
    const size = v.expected.length;
    const expected = Buffer.from(v.expected);

    const whole = await httpGet(opened.link);
    expect(whole.status).toBe(200);
    expect(whole.headers['content-type']).toBe('video/mp4');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.headers['content-length']).toBe(String(size));
    expect(whole.body.equals(expected)).toBe(true);

    // Across init|sidx, sidx|segment 0, segment 0|1|2, and the whole view as one range.
    const [seg0, seg1, seg2] = v.segmentAt as [number, number, number];
    for (const [a, b] of [
      [v.sidxAt - 3, v.sidxAt + 5],
      [seg0 - 7, seg0 + 9],
      [seg1 - 1, seg2 + 2],
      [0, size - 1],
    ] as const) {
      const r = await httpGet(opened.link, { range: `bytes=${a}-${b}` });
      expect(r.status, `${a}-${b}`).toBe(206);
      expect(r.headers['content-range']).toBe(`bytes ${a}-${b}/${size}`);
      expect(r.body.equals(expected.subarray(a, b + 1)), `${a}-${b}`).toBe(true);
    }
    const tail = await httpGet(opened.link, { range: 'bytes=-10' });
    expect(tail.status).toBe(206);
    expect(tail.body.equals(expected.subarray(size - 10))).toBe(true);
    const open = await httpGet(opened.link, { range: `bytes=${seg2}-` });
    expect(open.body.equals(expected.subarray(seg2))).toBe(true);

    const head = await httpHead(opened.link);
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(size));
    expect(head.body).toBe(0);

    const unsatisfiable = await httpGet(opened.link, { range: `bytes=${size}-` });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers['content-range']).toBe(`bytes */${size}`);

    // The token is the session's: another sid on it, or another token, is 404.
    expect((await httpGet(opened.link.replace(s, 'f'.repeat(32)))).status).toBe(404);
    expect(
      (await httpGet(opened.link.replace(/\/[0-9a-f]{32}\//, `/${'0'.repeat(32)}/`))).status,
    ).toBe(404);

    const spool = join(storage, 'tmp', NFX_PLAY_DIR, s);
    expect(existsSync(spool)).toBe(true);
    await w.call('nfx.play.close', { sid: s });
    await w.call('nfx.play.close', { sid: s });
    expect((await httpGet(opened.link)).status).toBe(404);
    expect(existsSync(spool)).toBe(false);
    expect(w.invalid).toEqual([]);
  });

  it('a named rendition; refusals: unknown rendition, wrong segs, no seeder with it, too many', async () => {
    const v = testNfxVideo();
    const full = await seeder(memorySource(v.files, v.video));
    const empty = await seeder(memorySource(new Map(), v.video));
    const { w } = await worker();
    const args = (over: Partial<NfxPlayOpenArgs> = {}): NfxPlayOpenArgs => ({
      sid: sid(),
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [full],
      prefetchSeconds: 30,
      ...over,
    });

    const low = args({ rendition: '360p' });
    const opened = await w.call('nfx.play.open', low);
    expect(opened.rendition).toBe('360p');
    const r = await httpGet(opened.link);
    expect(r.body.equals(Buffer.from(v.expected))).toBe(true);
    // The sid is taken, by this session.
    await expect(w.call('nfx.play.open', { ...low })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await w.call('nfx.play.close', { sid: low.sid });

    await expect(w.call('nfx.play.open', args({ rendition: '4k' }))).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(w.call('nfx.play.open', args({ segs: v.segs + 1 }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(w.call('nfx.play.open', args({ peers: [empty] }))).rejects.toMatchObject({
      code: 'no-seeders',
    });

    const sessions = Array.from({ length: MAX_NFX_SESSIONS }, () => args());
    for (const a of sessions) await w.call('nfx.play.open', a);
    await expect(w.call('nfx.play.open', args())).rejects.toMatchObject({ code: 'rate-limited' });
    for (const a of sessions) await w.call('nfx.play.close', { sid: a.sid });
    expect(w.invalid).toEqual([]);
  });
});
