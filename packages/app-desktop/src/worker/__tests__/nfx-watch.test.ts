/**
 * Slice 5d, without a network: `NfxWatchSession` over an in-memory fetcher (a segment that breaks
 * the plan fails the session, `close` deletes the spool and refuses waiting reads, the prefetch
 * window and a read's priority) and `NfxRangeServer` on node:http (404 for anything but a live
 * session's own link, 405, 416, 503 before any header, a cut connection rather than a short body).
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';

import { nfx } from '@sovit/core';
import { nodeFs, silentLogger } from '@sovit/seeder';
import { afterEach, describe, expect, it } from 'vitest';

import type { NfxRangeSource } from '../nfx/range-server.js';
import { NfxRangeServer, parseRange } from '../nfx/range-server.js';
import type { NfxFetcher, NfxWatchSessionOptions } from '../nfx/watch.js';
import { NfxWatchSession, wireRenditions } from '../nfx/watch.js';
import { httpGet, nodeHttpServer, sleep, tempDir } from './helpers/harness.js';
import { INIT, segment, segments, sha256, testNfxVideo } from './helpers/nfx-video.js';
import type { TestNfxVideo } from './helpers/nfx-video.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface MemoryFetcher extends NfxFetcher {
  readonly asked: string[];
  /** Fetches of these shas never answer until `close`. */
  readonly hold: Set<string>;
}

function memoryFetcher(files: ReadonlyMap<string, Uint8Array>): MemoryFetcher {
  const asked: string[] = [];
  const hold = new Set<string>();
  const held: ((err: Error) => void)[] = [];
  let closed = false;
  return {
    asked,
    hold,
    fetch: (sha, size, exact) => {
      asked.push(sha);
      if (hold.has(sha))
        return new Promise<Uint8Array>((_resolve, reject) => {
          held.push(reject);
        });
      const b = files.get(sha);
      if (closed || b === undefined || (exact ? b.length !== size : b.length > size))
        return Promise.reject(new Error('missing'));
      return Promise.resolve(b);
    },
    close: () => {
      closed = true;
      for (const reject of held.splice(0)) reject(new Error('closed'));
      return Promise.resolve();
    },
  };
}

async function spoolDir(): Promise<string> {
  const d = await tempDir('nf-nfx-play-');
  cleanups.push(() => d.rm());
  return join(d.dir, 'tmp', 'nfx-play', 'a'.repeat(32));
}

function session(
  v: TestNfxVideo,
  dir: string,
  fetcher: NfxFetcher,
  over: Partial<NfxWatchSessionOptions> = {},
): NfxWatchSession {
  const video = nfx.VideoAddr.parse(v.video);
  if (!video.ok) throw new Error('bad test video');
  const s = new NfxWatchSession({
    video: video.value,
    root: v.root,
    segs: v.segs,
    prefetchSeconds: 30,
    fetcher,
    fs: nodeFs,
    rmTree: (p) => rm(p, { recursive: true, force: true }),
    dir,
    logger: silentLogger,
    waitMs: 2000,
    ...over,
  });
  cleanups.push(() => s.close());
  return s;
}

async function rangeServer(): Promise<NfxRangeServer> {
  const server = new NfxRangeServer({
    createHttpServer: nodeHttpServer,
    randomHex: (n) => randomBytes(n).toString('hex'),
    logger: silentLogger,
  });
  cleanups.push(() => server.close());
  await server.listen();
  return server;
}

/** Bounded wait for `cond`. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await sleep(10);
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

/**
 * One request; how it ended — `complete` false when the connection was cut mid-body, status 0 when
 * it was cut before any header arrived.
 */
function request(
  url: string,
  o: { readonly method?: string; readonly headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; complete: boolean }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: o.method ?? 'GET', headers: o.headers ?? {}, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', () => undefined);
        res.on('close', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            complete: res.complete,
          });
        });
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNRESET')
        resolve({ status: 0, headers: {}, body: Buffer.alloc(0), complete: false });
      else reject(err);
    });
    req.end();
  });
}

const ID = 'b'.repeat(32);

describe('NfxWatchSession', () => {
  it('opens on segment 0 and fetches the rest; reads are layout C byte for byte', async () => {
    const v = testNfxVideo();
    const fetcher = memoryFetcher(v.files);
    const s = session(v, await spoolDir(), fetcher);
    const opened = await s.open();
    expect(opened.rendition).toBe('720p');
    expect(opened.layout.size).toBe(v.expected.length);
    await until(() => s.readySegments === 3, 'every segment');
    for (const p of nfx.locate(opened.layout, 0, opened.layout.size, 7)) {
      const at = (opened.layout.parts.find((x) => x.part === p.part)?.offset ?? -1) + p.offset;
      expect(
        Buffer.from(await s.read(p)).equals(Buffer.from(v.expected.subarray(at, at + p.length))),
      ).toBe(true);
    }
    // The hash list, the 720p playlist, the init and each segment, once each.
    expect(fetcher.asked).toHaveLength(3 + v.segmentShas.length);
    expect(new Set(fetcher.asked).size).toBe(fetcher.asked.length);
  });

  it('a segment whose tfdt is not where the plan put it fails the session', async () => {
    // Segment 1 starts one tick late: the sidx promised 25 600.
    const v = testNfxVideo([segment(0, 30), segment(25_601, 37), segment(51_200, 44)]);
    const dir = await spoolDir();
    const s = session(v, dir, memoryFetcher(v.files));
    const opened = await s.open();
    await until(() => s.failed, 'the failure');
    const [seg0, seg1] = v.segmentAt as [number, number];
    // Segment 1 is refused; what was spooled before it is still served.
    const [inSeg1] = nfx.locate(opened.layout, seg1, 4);
    await expect(s.read(inSeg1!)).rejects.toThrow();
    const [inSeg0] = nfx.locate(opened.layout, seg0, 4);
    expect(
      Buffer.from(await s.read(inSeg0!)).equals(Buffer.from(v.expected.subarray(seg0, seg0 + 4))),
    ).toBe(true);

    const server = await rangeServer();
    const link = server.register(ID, s);
    const before = await httpGet(link, { range: `bytes=0-${seg1 - 1}` });
    expect(before.status).toBe(206);
    expect(before.body.equals(Buffer.from(v.expected.subarray(0, seg1)))).toBe(true);
    // Its first bytes cannot be had: 503 before any header of a 206.
    expect((await httpGet(link, { range: `bytes=${seg1}-` })).status).toBe(503);
    // A range that reaches it from spooled bytes is cut, never answered short.
    const cut = await request(link);
    expect(cut.status).toBe(200);
    expect(cut.complete).toBe(false);
    expect(cut.body.length).toBeLessThan(v.expected.length);
  });

  it('refuses an open whose first segment the init cannot play (not fMP4)', async () => {
    const v = testNfxVideo([new Uint8Array(64).fill(1), ...segments(2).slice(1)]);
    const s = session(v, await spoolDir(), memoryFetcher(v.files));
    await expect(s.open()).rejects.toMatchObject({ code: 'unsupported-input' });
  });

  it('close refuses a waiting read, abandons the fetches and deletes the spool', async () => {
    const v = testNfxVideo();
    const dir = await spoolDir();
    const fetcher = memoryFetcher(v.files);
    fetcher.hold.add(v.segmentShas[2]!);
    const s = session(v, dir, fetcher);
    const opened = await s.open();
    expect(existsSync(join(dir, sha256(INIT)))).toBe(true);
    expect(existsSync(join(dir, v.segmentShas[0]!))).toBe(true);
    const [inSeg2] = nfx.locate(opened.layout, v.segmentAt[2]!, 4);
    const waiting = s.read(inSeg2!).then(
      () => 'served',
      () => 'refused',
    );
    await sleep(20);
    await s.close();
    expect(await waiting).toBe('refused');
    expect(s.closed).toBe(true);
    expect(existsSync(dir)).toBe(false);
    await expect(s.read(nfx.locate(opened.layout, 0, 4)[0]!)).rejects.toThrow();
  });

  it('a close while opening ends the open as session-closed and leaves no spool', async () => {
    const v = testNfxVideo();
    const dir = await spoolDir();
    const fetcher = memoryFetcher(v.files);
    fetcher.hold.add(v.segmentShas[0]!);
    const s = session(v, dir, fetcher);
    const opening = s.open().then(
      () => null,
      (e: unknown) => e,
    );
    await until(() => fetcher.asked.includes(v.segmentShas[0]!), 'the first segment asked');
    await s.close();
    expect(await opening).toMatchObject({ code: 'session-closed' });
    expect(existsSync(dir)).toBe(false);
  });

  it('fetches within the prefetch window from the read position; a read far ahead goes first', async () => {
    const v = testNfxVideo(segments(6));
    const fetcher = memoryFetcher(v.files);
    const s = session(v, await spoolDir(), fetcher, { prefetchSeconds: 0 });
    const opened = await s.open();
    // Segment 0 with `open`; the next MIN_AHEAD_SEGMENTS (2) at once, no further.
    await until(() => s.readySegments === 3, 'the window');
    await sleep(20);
    const [s3, s4, s5] = [v.segmentShas[3]!, v.segmentShas[4]!, v.segmentShas[5]!];
    expect(fetcher.asked).not.toContain(s3);
    // A seek to segment 5: fetched for the read, and nothing between.
    const [inSeg5] = nfx.locate(opened.layout, v.segmentAt[5]!, 6);
    const bytes = await s.read(inSeg5!);
    const at5 = v.segmentAt[5] ?? -1;
    expect(Buffer.from(bytes).equals(Buffer.from(v.expected.subarray(at5, at5 + 6)))).toBe(true);
    expect(fetcher.asked).toContain(s5);
    expect(fetcher.asked).not.toContain(s3);
    expect(fetcher.asked).not.toContain(s4);
  });

  it('wireRenditions: highest bandwidth first; what the wire cannot carry is left out', () => {
    const r = (id: string, bandwidth: bigint, resolution?: string): nfx.Rendition => ({
      id,
      playlist: `${id}.m3u8`,
      bandwidth,
      codecs: undefined,
      resolution,
    });
    expect(
      wireRenditions([
        r('low', 1n, '640x360'),
        r('high', 9n, '1x1234567'),
        r('a\u0001b', 5n),
        r('huge', 2n ** 60n),
        r('mid', 4n),
      ]),
    ).toEqual([
      { id: 'high', bandwidth: 9 },
      { id: 'mid', bandwidth: 4 },
      { id: 'low', bandwidth: 1, resolution: '640x360' },
    ]);
  });
});

describe('NfxRangeServer', () => {
  const bytes = Uint8Array.from({ length: 300 }, (_, i) => i % 251);
  const source = (fail: (p: nfx.ProgressivePiece) => boolean = () => false): NfxRangeSource => {
    const layout = nfx.progressiveLayout([
      { kind: 'bytes', bytes: bytes.subarray(0, 100) },
      { kind: 'bytes', bytes: bytes.subarray(100) },
    ]);
    return {
      layout,
      read: async (p) => {
        // As a real failure (a wait that ran out) is: later, not in the same tick as the write
        // before it — Node sends a response's first bytes only once its socket is uncorked.
        if (fail(p)) {
          await sleep(20);
          throw new Error('not here');
        }
        if (p.part.kind !== 'bytes') throw new Error('no files here');
        return p.part.bytes.subarray(p.offset, p.offset + p.length);
      },
    };
  };

  it('serves only a live session’s own link; GET and HEAD only; one satisfiable range', async () => {
    const server = await rangeServer();
    const link = server.register(ID, source());
    const port = String(server.port);

    const whole = await httpGet(link);
    expect(whole.status).toBe(200);
    expect(whole.body.equals(Buffer.from(bytes))).toBe(true);
    const part = await httpGet(link, { range: 'bytes=90-109' });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 90-109/300');
    expect(part.body.equals(Buffer.from(bytes.subarray(90, 110)))).toBe(true);

    for (const url of [
      link.replace(ID, 'c'.repeat(32)),
      link.replace(/\/[0-9a-f]{32}\//, `/${'0'.repeat(32)}/`),
      `http://127.0.0.1:${port}/`,
      `http://127.0.0.1:${port}/${ID}`,
      `${link}?x=1`,
    ])
      expect((await httpGet(url)).status, url).toBe(404);
    expect((await request(link, { method: 'POST' })).status).toBe(405);
    const head = await request(link, { method: 'HEAD', headers: { range: 'bytes=10-' } });
    expect(head.status).toBe(206);
    expect(head.headers['content-length']).toBe('290');
    expect(head.body.length).toBe(0);
    for (const range of ['bytes=300-', 'bytes=5-2', 'bytes=0-1,3-4', 'items=0-1', 'bytes=-0'])
      expect((await httpGet(link, { range })).status, range).toBe(416);

    server.unregister(ID);
    expect((await httpGet(link)).status).toBe(404);
  });

  it('503 when the first bytes cannot be had; a cut connection when later ones cannot', async () => {
    const server = await rangeServer();
    const link = server.register(
      ID,
      source((p) => p.part.kind === 'bytes' && p.part.bytes.length === 200),
    );
    expect((await httpGet(link, { range: 'bytes=150-' })).status).toBe(503);
    const cut = await request(link);
    expect(cut.status).toBe(200);
    expect(cut.headers['content-length']).toBe('300');
    expect(cut.complete).toBe(false);
    // At most the bytes before the failing part, as they were.
    expect(cut.body.length).toBeLessThanOrEqual(100);
    expect(cut.body.equals(Buffer.from(bytes.subarray(0, cut.body.length)))).toBe(true);
  });

  it('parseRange', () => {
    expect(parseRange(undefined, 10)).toBe('none');
    expect(parseRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
    expect(parseRange('bytes=2-999', 10)).toEqual({ start: 2, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=-999', 10)).toEqual({ start: 0, end: 9 });
    for (const bad of [
      '',
      'bytes=',
      'bytes=-',
      'bytes=-0',
      'bytes=10-',
      'bytes=5-2',
      'bytes=0-1,3-4',
    ])
      expect(parseRange(bad, 10), bad).toBe('bad');
  });
});
