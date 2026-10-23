/**
 * NFX on upload (`studio/nfx.ts`, ADR 0020): which uploads go to NFX, a packaging failure that
 * leaves the store alone, and, with the SYSTEM ffmpeg (skipped without one), the store as an
 * upload leaves it and a failed legacy publish that removes the NFX video again. The worker's
 * `studio.upload` stays legacy only until the host passes NFX settings (slice 5), so
 * `runWorkerUpload` is driven directly here.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { mocks, nfx } from '@sovit/core';
import type { TranscodeOutput, VideoManifest } from '@sovit/core';
import {
  createNodeMediaPipeline,
  findFfmpeg,
  nodeFsAdapter,
  nodeProcessRunner,
} from '@sovit/core/media/node';
import { DiskCap, NfxFileStore, Seeder, nodeFs, silentLogger } from '@sovit/seeder';
import type { Logger } from '@sovit/seeder';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { StudioUploadArgs } from '../../ipc/worker-protocol.js';
import { sodiumCrypto, sodiumSha256 } from '../crypto.js';
import { nfxEligible, storeNfxUpload } from '../studio/nfx.js';
import type { WorkerNfxDeps } from '../studio/nfx.js';
import { runWorkerUpload } from '../studio/upload.js';
import { tempDir } from './helpers/harness.js';

const regtest = ((): nfx.Namespace => {
  const n = nfx.Namespace.parse('nfx:regtest:1');
  if (!n.ok) throw new Error('namespace');
  return n.value;
})();

const meta = (satsPerBlock: number): StudioUploadArgs['meta'] => ({
  title: 'NFX upload',
  description: 'made by lavfi',
  tags: ['test'],
  kind: 21,
  mints: [mocks.MINTS.a],
  satsPerBlock: mocks.sats(satsPerBlock),
  split: { seeder: 50, creator: 50 },
});

/** Only what `nfxEligible` reads. */
const outputOf = (
  renditions: readonly { codec: 'h264' | 'vp9'; container: 'mp4' | 'webm' }[],
): TranscodeOutput =>
  ({
    renditions: renditions.map((spec, i) => ({ spec: { ...spec, label: `r${String(i)}` } })),
  }) as unknown as TranscodeOutput;

/** Warnings and errors, by message. */
function recordingLogger(): { logger: Logger; messages: string[] } {
  const messages: string[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (msg) => {
      messages.push(msg);
    },
    error: (msg) => {
      messages.push(msg);
    },
    child: () => logger,
  };
  return { logger, messages };
}

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function openStore(): Promise<{ store: NfxFileStore; cap: DiskCap }> {
  const t = await tempDir('nutflix-studio-nfx-');
  cleanups.push(() => t.rm());
  const store = new NfxFileStore({ fs: nodeFs, crypto: sodiumCrypto, dataDir: t.dir });
  await store.load();
  const cap = new DiskCap(1 << 30, 0);
  store.attach(cap);
  return { store, cap };
}

describe('NFX on upload', () => {
  it('takes free uploads whose renditions are all H.264 in MP4, and nothing else', () => {
    const h264 = { codec: 'h264', container: 'mp4' } as const;
    const vp9 = { codec: 'vp9', container: 'webm' } as const;
    expect(nfxEligible(meta(0), outputOf([h264, h264]))).toBe(true);
    expect(nfxEligible(meta(1), outputOf([h264]))).toBe(false);
    expect(nfxEligible(meta(0), outputOf([h264, vp9]))).toBe(false);
    expect(nfxEligible(meta(0), outputOf([]))).toBe(false);
  });

  it('leaves the store alone, and says so, when packaging fails', async () => {
    const { store, cap } = await openStore();
    const t = await tempDir('nutflix-studio-nfx-work-');
    cleanups.push(() => t.rm());
    const { logger, messages } = recordingLogger();
    const output = {
      renditions: [
        {
          spec: {
            label: '360p',
            height: 360,
            videoBitrateKbps: 800,
            audioBitrateKbps: 96,
            codec: 'h264',
            container: 'mp4',
          },
          path: join(t.dir, 'missing.mp4'),
          width: 640,
          height: 360,
        },
      ],
      thumbnails: [],
    } as unknown as TranscodeOutput;
    const stored = await storeNfxUpload(output, undefined, {
      store,
      nfx: { namespace: regtest, newVideoId: () => 'failing-video' },
      runner: {
        run: () => Promise.resolve({ exitCode: 1, stdout: new Uint8Array(), stderr: 'no input' }),
      },
      fs: nodeFsAdapter({ tmpDir: t.dir }),
      sha256: sodiumSha256,
      binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
      logger,
    });
    expect(stored).toBeUndefined();
    expect(messages).toEqual(['NFX packaging failed: uploading without NFX']);
    expect(store.videos()).toEqual([]);
    expect(cap.usedBytes + cap.pendingBytes).toBe(0);
  });

  it('refuses a video-id outside NFX-02 §2 before packaging anything', async () => {
    const { store } = await openStore();
    const { logger, messages } = recordingLogger();
    let ran = false;
    const stored = await storeNfxUpload(
      outputOf([{ codec: 'h264', container: 'mp4' }]),
      undefined,
      {
        store,
        nfx: { namespace: regtest, newVideoId: () => 'Not_An_Id' },
        runner: {
          run: () => {
            ran = true;
            return Promise.resolve({ exitCode: 0, stdout: new Uint8Array(), stderr: '' });
          },
        },
        fs: nodeFsAdapter(),
        sha256: sodiumSha256,
        binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
        logger,
      },
    );
    expect(stored).toBeUndefined();
    expect(ran).toBe(false);
    expect(messages).toEqual(['NFX video-id refused: uploading without NFX']);
  });
});

const bins = findFfmpeg();

describe.skipIf(bins === undefined)('NFX on upload with the system ffmpeg', () => {
  let base = '';
  let source = '';
  const runner = nodeProcessRunner();

  beforeAll(async () => {
    const t = await tempDir('nutflix-studio-nfx-real-');
    cleanups.push(() => t.rm());
    base = t.dir;
    source = join(base, 'source.mp4');
    const made = await runner.run(bins!.ffmpeg, [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=25:duration=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=4',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-y',
      source,
    ]);
    expect(made.exitCode, made.stderr).toBe(0);
  }, 60_000);

  it('stores every file the hash list names, verified, and removes the work directories', async () => {
    const pipeline = createNodeMediaPipeline({
      binaries: bins!,
      tmpDir: base,
      preset: 'ultrafast',
    });
    const output = await pipeline.transcode(
      source,
      pipeline.plan(await pipeline.probe(source)),
      () => undefined,
    );
    const workBase = join(base, 'work');
    await mkdir(workBase);
    const { store, cap } = await openStore();
    const stored = await storeNfxUpload(output, output.thumbnails[0]?.path, {
      store,
      nfx: { namespace: regtest, newVideoId: () => 'upload-nfx-clip' },
      runner,
      fs: nodeFsAdapter({ tmpDir: workBase }),
      sha256: sodiumSha256,
      binaries: bins!,
      logger: silentLogger,
    });
    expect(stored?.video).toBe('nfx:regtest:1:upload-nfx-clip');
    if (stored === undefined) return;

    const listBytes = await store.readFile(stored.root);
    expect(listBytes).not.toBeNull();
    const addr = nfx.VideoAddr.parse(stored.video);
    if (!addr.ok) throw new Error('address');
    const list = nfx.verifyHashList(
      listBytes!,
      stored.root,
      addr.value,
      BigInt(stored.files.length),
    );
    if (!list.ok) throw new Error(list.error.reason);
    expect(new Set(list.value.files.map((f) => f.role))).toEqual(
      new Set(['playlist-master', 'playlist', 'init', 'segment', 'thumb']),
    );
    for (const f of list.value.files) {
      const b = await store.readFile(f.sha256);
      expect(b?.byteLength).toBe(Number(f.size));
      expect(createHash('sha256').update(b!).digest('hex')).toBe(f.sha256);
    }
    expect(cap.usedBytes).toBe(store.totalBytes());
    expect(await readdir(workBase)).toEqual([]);
  }, 120_000);

  it('stores a free upload before the legacy publish, and removes it when that publish fails', async () => {
    const t = await tempDir('nutflix-studio-nfx-seeder-');
    cleanups.push(() => t.rm());
    const engine = new mocks.MockPaymentEngine({ mode: 'honest', config: { windowBlocks: 4 } });
    const seeder = await Seeder.create(
      { dataDir: t.dir, diskCapBytes: 1 << 30, swarm: null },
      { engine, fs: nodeFs, crypto: sodiumCrypto, logger: silentLogger },
    );
    cleanups.push(() => seeder.close());
    let ids = 0;
    const nfxDeps: WorkerNfxDeps = {
      namespace: regtest,
      newVideoId: () => `upload-clip-${String(++ids)}`,
    };
    const upload = (
      publish: () => Promise<VideoManifest>,
      satsPerBlock = 0,
    ): Promise<VideoManifest> =>
      runWorkerUpload(
        {
          uploadId: randomBytes(16).toString('hex') as StudioUploadArgs['uploadId'],
          path: source,
          name: 'source.mp4',
          meta: meta(satsPerBlock),
        },
        {
          seeder,
          binaries: bins!,
          runner,
          fs: nodeFsAdapter({ tmpDir: base }),
          sha256: sodiumSha256,
          logger: silentLogger,
          publish,
          progress: () => undefined,
          preset: 'ultrafast',
          nfx: nfxDeps,
        },
      );

    await expect(upload(() => Promise.reject(new Error('relay down')))).rejects.toThrow(
      'relay down',
    );
    expect(seeder.nfx.videos()).toEqual([]);
    expect(seeder.nfx.totalBytes()).toBe(0);

    const published = { id: 'published' } as unknown as VideoManifest;
    await expect(upload(() => Promise.resolve(published))).resolves.toBe(published);
    expect(seeder.nfx.videos().map((v) => v.video)).toEqual(['nfx:regtest:1:upload-clip-2']);

    // A priced upload never reaches NFX (ADR 0020).
    await expect(upload(() => Promise.resolve(published), 2)).resolves.toBe(published);
    expect(seeder.nfx.videos()).toHaveLength(1);
    expect(ids).toBe(2);
  }, 180_000);
});
