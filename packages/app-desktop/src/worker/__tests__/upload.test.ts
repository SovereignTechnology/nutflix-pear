/**
 * `studio.upload` through the worker: L8's pipeline with the SYSTEM ffmpeg (skipped without
 * one), renditions stored through the seeder, `upload.progress` events the host guard accepts,
 * and the `studio.publish` request to the host carrying a `PublishDraft` the host guard
 * accepts. Plus the `ffmpeg-not-found` path.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { NostrEvent, NostrEventId, NostrPubkey, VideoManifest } from '@sovit/core';
import { manifest, mocks, nfx } from '@sovit/core';
import { nodeProcessRunner } from '@sovit/core/media/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PublishDraft, StudioUploadArgs, WorkerEvent } from '../../ipc/worker-protocol.js';
import type { DevTestnet } from '../dev/fixtures-net.js';
import { startDevTestnet } from '../dev/fixtures-net.js';
import { pathCandidates } from '../ffmpeg.js';
import type { WorkerClient } from './helpers/harness.js';
import { nodeRuntime, startWorker, tempDir } from './helpers/harness.js';

const hasFfmpeg =
  process.platform === 'linux' &&
  pathCandidates(process.env['PATH'], 'linux').some(
    (p) => existsSync(p) && existsSync(p.replace(/ffmpeg$/, 'ffprobe')),
  );
const seeding = { enabled: true, diskCapBytes: 1024 ** 3 };
const meta: StudioUploadArgs['meta'] = {
  title: 'Upload test',
  description: 'made by lavfi',
  tags: ['test'],
  kind: 21,
  mints: [mocks.MINTS.a],
  satsPerBlock: mocks.sats(2),
  split: { seeder: 50, creator: 50 },
};

/** What the host would do after building + signing the NIP-71 event (here: unsigned). */
function manifestFrom(d: PublishDraft): VideoManifest {
  const author = 'cd'.repeat(32) as NostrPubkey;
  const id = randomBytes(32).toString('hex') as NostrEventId;
  const event: NostrEvent = {
    id,
    pubkey: author,
    kind: 21,
    created_at: mocks.FIXTURE_NOW,
    tags: [['title', d.meta.title]],
    content: d.meta.description,
    sig: '0'.repeat(128),
  };
  return {
    id,
    kind: 21,
    author,
    title: d.meta.title,
    description: d.meta.description,
    publishedAt: mocks.FIXTURE_NOW,
    durationSec: d.durationSec,
    tags: d.meta.tags,
    renditions: d.renditions,
    price: {
      satsPerBlock: d.meta.satsPerBlock,
      blockSize: d.blockSize,
      mints: d.meta.mints,
      split: d.meta.split,
      creatorP2pk: mocks.asP2pk('creator'),
    },
    blossomServers: [],
    event,
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
});

describe.skipIf(!hasFfmpeg)('studio.upload with the system ffmpeg', () => {
  let testnet: DevTestnet;
  let w: WorkerClient;
  let source = '';
  const drafts: PublishDraft[] = [];

  beforeAll(async () => {
    testnet = await startDevTestnet();
    cleanups.push(() => testnet.destroy());
    const d = await tempDir('nf-l6c-upload-');
    cleanups.push(() => d.rm());
    source = join(d.dir, 'source clip $(id).mp4');
    const made = await nodeProcessRunner().run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=25',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-y',
      source,
    ]);
    expect(made.exitCode).toBe(0);
    w = startWorker({
      logLevel: 'warn',
      uploadPreset: 'ultrafast',
      handlers: {
        'studio.publish': (draft) => {
          drafts.push(draft);
          return Promise.resolve(manifestFrom(draft));
        },
      },
    });
    cleanups.push(() => w.close());
    await w.call('init', {
      v: 1,
      storage: join(d.dir, 'worker'),
      seeding,
      prefetchSeconds: 30,
      dev: {
        mocks: true,
        fixtures: false,
        bootstrap: testnet.bootstrap.map((b) => ({ host: '127.0.0.1' as const, port: b.port })),
      },
    });
  }, 60_000);

  it(
    'transcodes, stores through the seeder, asks the host to publish, reports progress',
    { timeout: 120_000 },
    async () => {
      const uploadId = randomBytes(16).toString('hex') as StudioUploadArgs['uploadId'];
      const video = await w.call('studio.upload', {
        uploadId,
        path: source,
        name: 'clip.mp4',
        meta,
      });
      expect(drafts).toHaveLength(1);
      const draft = drafts[0]!;
      expect(draft.uploadId).toBe(uploadId);
      expect(draft.codec).toBe('h264');
      expect(draft.thumbnail.kind).toBe('candidate');
      expect(draft.renditions.length).toBeGreaterThan(0);

      const seeder = w.host.internals.seeder!;
      for (const r of video.renditions) {
        expect(seeder.hasBlob(r.sha256)).toBe(true);
        expect(seeder.blob(r.sha256)?.coreKey).toBe(r.hyper.core);
        // The worker now charges the manifest price for it downstream.
        expect(seeder.policyFor(r.hyper.core).satsPerBlock).toBe(meta.satsPerBlock);
      }

      // ADR 0015: the thumbnail went into this node's own profile core, served free.
      const thumb = draft.thumbnailImage;
      expect(thumb).toBeDefined();
      expect(thumb?.sha256).toBe(draft.thumbnail.sha256);
      const own = await seeder.blobs.openCore('nutflix-profile');
      const ref = manifest.decodeHyperUrl(thumb!.url, thumb!.size);
      expect(ref?.core).toBe(own.keyHex);
      const bytes = await own.blobs.get(ref!.blob);
      expect(createHash('sha256').update(bytes!).digest('hex')).toBe(thumb?.sha256);
      expect(seeder.isFreeCore(own.keyHex)).toBe(true);

      const stages = w.events
        .filter(
          (e): e is Extract<WorkerEvent, { e: 'upload.progress' }> =>
            e.e === 'upload.progress' && e.uploadId === uploadId,
        )
        .map((e) => e.progress.stage);
      for (const s of ['probing', 'transcoding', 'thumbnails', 'writing', 'publishing', 'done'])
        expect(stages).toContain(s);
      expect(stages.at(-1)).toBe('done');
      expect(w.invalid).toEqual([]);
      expect(w.rpc.stats().droppedEvents).toBe(0);
    },
  );

  it(
    'packages a free upload for NFX once it has published, in the shared disk cap (contracts v8)',
    { timeout: 120_000 },
    async () => {
      const uploadId = randomBytes(16).toString('hex') as StudioUploadArgs['uploadId'];
      const seeder = w.host.internals.seeder!;
      const before = seeder.diskCap.usedBytes;
      const video = await w.call('studio.upload', {
        uploadId,
        path: source,
        name: 'clip.mp4',
        meta: { ...meta, satsPerBlock: mocks.sats(0), nfx: true },
      });
      // The legacy upload is the result, whatever the NFX side does.
      expect(video.renditions.length).toBeGreaterThan(0);

      const ev = await vi.waitFor(
        () => {
          const e = w.events.find(
            (x): x is Extract<WorkerEvent, { e: 'upload.nfx' }> =>
              x.e === 'upload.nfx' && x.uploadId === uploadId,
          );
          if (e === undefined) throw new Error('no upload.nfx yet');
          return e;
        },
        { timeout: 90_000, interval: 100 },
      );
      expect(ev.status).toMatchObject({ state: 'stored' });
      if (ev.status.state !== 'stored') return;
      expect(ev.status.video).toBe(`nfx:testnet:1:nutflix-${video.id.slice(0, 32)}`);
      const addr = nfx.VideoAddr.parse(ev.status.video);
      if (!addr.ok) throw new Error(addr.error.reason);
      expect(seeder.nfx.hasVideo(addr.value)).toBe(true);
      const list = seeder.nfx.file(addr.value, ev.status.root)!;
      const listBytes = await list.read(0, list.size);
      expect(createHash('sha256').update(listBytes).digest('hex')).toBe(ev.status.root);
      // What the hash list names is what the store serves for this video, and nothing else.
      const verified = nfx.verifyHashList(
        listBytes,
        ev.status.root,
        addr.value,
        BigInt(ev.status.segs),
      );
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      for (const f of verified.value.files) {
        expect(seeder.nfx.file(addr.value, f.sha256)?.size).toBe(Number(f.size));
      }
      // The manifest's thumb (slice 4a): the hash list's role-`thumb` file, a JPEG.
      const thumb = verified.value.files.find((f) => f.role === 'thumb');
      expect(thumb).toBeDefined();
      expect(ev.status.thumb).toEqual({ sha256: thumb?.sha256, mime: 'image/jpeg' });
      expect(seeder.diskCap.usedBytes - before).toBeGreaterThanOrEqual(ev.status.bytes);
      expect(w.invalid).toEqual([]);
    },
  );
});

describe('studio.upload without ffmpeg', () => {
  it('fails with ffmpeg-not-found (Studio shows the install help)', async () => {
    const testnet = await startDevTestnet();
    cleanups.push(() => testnet.destroy());
    const d = await tempDir('nf-l6c-noff-');
    cleanups.push(() => d.rm());
    const runtime = { ...nodeRuntime(), env: () => undefined };
    const w = startWorker({ runtime, logLevel: 'error' });
    cleanups.push(() => w.close());
    await w.call('init', {
      v: 1,
      storage: d.dir,
      seeding,
      prefetchSeconds: 30,
      dev: {
        mocks: true,
        fixtures: false,
        bootstrap: testnet.bootstrap.map((b) => ({ host: '127.0.0.1' as const, port: b.port })),
      },
    });
    expect(await w.call('studio.ffmpeg', { recheck: true })).toMatchObject({ found: false });
    await expect(
      w.call('studio.upload', {
        uploadId: randomBytes(16).toString('hex') as StudioUploadArgs['uploadId'],
        path: '/tmp/none.mp4',
        name: 'none.mp4',
        meta,
      }),
    ).rejects.toMatchObject({ code: 'ffmpeg-not-found' });
  }, 30_000);
});
