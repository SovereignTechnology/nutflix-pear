import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VideoAddr, checkPlaylist, verifyFile, verifyHashList } from '../../nfx/index.js';
import { packageNfx, type NfxPackageDeps } from '../nfx-package.js';
import {
  createNodeMediaPipeline,
  findFfmpeg,
  nodeFsAdapter,
  nodeProcessRunner,
} from '../node/index.js';
import { nodeSha256 } from '../node/sha256.js';

/**
 * NFX-05 packaging with real ffmpeg: the ladder `transcode` encodes, remuxed by stream copy
 * into CMAF and checked as a consumer would check it. Skipped, not failed, without a binary
 * (`node-real-ffmpeg.test.ts` resolves it the same way: `NUTFLIX_FFMPEG`, then PATH).
 */
const bins = findFfmpeg();

describe.skipIf(bins === undefined)('NFX packaging with real ffmpeg', () => {
  let base = '';
  let input = '';
  const runner = nodeProcessRunner();

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'nutflix-nfx-'));
    input = join(base, 'source.mp4');
    const gen = await runner.run(bins!.ffmpeg, [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=30:duration=6',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=6',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      input,
    ]);
    expect(gen.exitCode, gen.stderr).toBe(0);
  }, 60_000);

  afterAll(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  const deps = (): NfxPackageDeps => ({
    runner,
    fs: nodeFsAdapter({ tmpDir: base }),
    sha256: nodeSha256,
    binaries: bins!,
  });
  const video = (): VideoAddr => {
    const v = VideoAddr.parse('nfx:regtest:1:media-it-clip');
    if (!v.ok) throw new Error('video');
    return v.value;
  };

  it('remuxes the transcoded ladder into verified NFX-05 content, by stream copy', async () => {
    // Not ultrafast: x264 then signals Constrained Baseline even with `-profile:v high`.
    const p = createNodeMediaPipeline({ binaries: bins!, tmpDir: base, preset: 'veryfast' });
    const plan = p.plan(await p.probe(input));
    const out = await p.transcode(input, plan, () => undefined);
    // A name that looks like an option and a protocol still reaches ffmpeg as a file name.
    const odd = join(base, '-720p concat:x $(id).mp4');
    await copyFile(out.renditions[0]!.path, odd);
    const renditions = [{ ...out.renditions[0]!, path: odd }, ...out.renditions.slice(1)];

    const packaged = await packageNfx(deps(), {
      video: video(),
      renditions,
      thumbnailPath: out.thumbnails[0]!.path,
    });
    const list = packaged.hashList;
    expect(list.renditions.map((r) => r.id)).toEqual(['720p', '360p']);
    for (const r of list.renditions) {
      expect(r.codecs).toMatch(/^avc1\.64[0-9a-f]{4},mp4a\.40\.2$/);
    }
    expect(list.renditions[0]?.resolution).toBe('1280x720');
    const count = (role: string): number => list.files.filter((f) => f.role === role).length;
    expect(['playlist-master', 'playlist', 'init', 'segment', 'thumb'].map(count)).toEqual([
      1, 2, 2, 6, 1,
    ]);
    // Every segment but the last is exactly one GOP; the grid is the same in both renditions.
    for (const id of ['720p', '360p']) {
      const durs = list.files
        .filter((f) => f.role === 'segment' && f.name.startsWith(`${id}-`))
        .map((f) => f.durMs);
      expect(durs.slice(0, -1)).toEqual([2000n, 2000n]);
    }

    // As a consumer: the hash list against its root, every file against its sha256.
    const verified = verifyHashList(packaged.hashListBytes, packaged.root, video(), packaged.segs);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    for (const f of packaged.files) {
      const bytes =
        f.source.kind === 'bytes' ? f.source.bytes : new Uint8Array(await readFile(f.source.path));
      expect(verifyFile(f.entry.sha256, bytes).ok, f.entry.name).toBe(true);
      if (f.entry.role === 'playlist' || f.entry.role === 'playlist-master') {
        expect(checkPlaylist(verified.value, bytes).ok, f.entry.name).toBe(true);
      }
    }
    for (const dir of packaged.workDirs) await rm(dir, { recursive: true, force: true });
  }, 180_000);

  it('refuses a playlist posing as a rendition: the input guard admits only MP4', async () => {
    const hostile = join(base, 'upload.mp4');
    await writeFile(
      hostile,
      `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n${input}\n#EXT-X-ENDLIST\n`,
    );
    const spec = {
      label: '720p',
      height: 720,
      videoBitrateKbps: 2500,
      audioBitrateKbps: 128,
      codec: 'h264',
      container: 'mp4',
    } as const;
    await expect(
      packageNfx(deps(), {
        video: video(),
        renditions: [{ spec, path: hostile, width: 1280, height: 720 }],
      }),
    ).rejects.toMatchObject({ name: 'MediaError', code: 'process-failed' });
  }, 60_000);
});
