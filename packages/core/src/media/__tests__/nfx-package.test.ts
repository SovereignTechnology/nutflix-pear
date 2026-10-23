/**
 * The NFX-05 packager against a fake ffmpeg that writes what the HLS muxer writes: content
 * names, rewritten playlists, the master playlist, the hash list and its self-check, and every
 * way the remux output is refused. Real ffmpeg: `node-real-ffmpeg-nfx.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import type { RenditionSpec } from '../../contracts/media.js';
import { VideoAddr, verifyHashList } from '../../nfx/index.js';
import { REMUX_INPUT_GUARD, cmafRemuxArgv } from '../argv.js';
import { MediaError } from '../errors.js';
import { packageNfx, type NfxPackageRendition, type NfxPackaged } from '../nfx-package.js';
import { nodeSha256 } from '../node/sha256.js';
import {
  FakeRunner,
  MemoryFs,
  avcEntry,
  box,
  concat,
  h264AacInit,
  initSegment,
  trakBox,
  type RecordedCall,
} from '../testing/fakes.js';

const parsed = VideoAddr.parse('nfx:regtest:1:packager-test');
if (!parsed.ok) throw new Error('video address');
const VIDEO = parsed.value;
const BINS = { ffmpeg: '/bin/ffmpeg', ffprobe: '/bin/ffprobe' };

const sha256Hex = (bytes: Uint8Array): string => {
  const h = nodeSha256();
  h.update(bytes);
  return h.digest();
};

function spec(
  label: string,
  height: number,
  codec: RenditionSpec['codec'] = 'h264',
): RenditionSpec {
  return {
    label,
    height,
    videoBitrateKbps: 1000,
    audioBitrateKbps: 128,
    codec,
    container: codec === 'vp9' ? 'webm' : 'mp4',
  };
}

const R720: NfxPackageRendition = {
  spec: spec('720p', 720),
  path: '/work/720p.mp4',
  width: 1280,
  height: 720,
};
const R360: NfxPackageRendition = {
  spec: spec('360p', 360),
  path: '/work/360p.mp4',
  width: 640,
  height: 360,
};

interface Remux {
  /** Segment (size, seconds) pairs. */
  readonly segments: readonly (readonly [number, string])[];
  readonly init?: Uint8Array;
  /** Replace the playlist text ffmpeg would write. */
  readonly playlist?: (text: string) => string;
}

/** A fake ffmpeg: for each remux call, writes the HLS muxer's output for that rendition. */
function remuxer(fs: MemoryFs, per: Record<string, Remux>): FakeRunner {
  return new FakeRunner((call: RecordedCall) => {
    const at = call.args.indexOf('-hls_segment_filename');
    const dir = (call.args[at + 1] ?? '').replace(/\/seg_%05d\.m4s$/, '');
    const label = /nutflix-nfx-([0-9a-z]+)-\d+$/.exec(dir)?.[1] ?? '';
    const r = per[label];
    if (r === undefined) return { exitCode: 1, stderr: `no fake for ${label}` };
    fs.set(`${dir}/init.mp4`, r.init ?? h264AacInit(label === '720p' ? 0x1f : 0x1e));
    let text =
      '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n' +
      '#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI="init.mp4"\n';
    r.segments.forEach(([size, secs], i) => {
      const name = `seg_${String(i).padStart(5, '0')}.m4s`;
      fs.set(`${dir}/${name}`, new Uint8Array(size).fill(label === '720p' ? 7 + i : 70 + i));
      text += `#EXTINF:${secs},\n${name}\n`;
    });
    text += '#EXT-X-ENDLIST\n';
    fs.set(`${dir}/index.m3u8`, r.playlist ? r.playlist(text) : text);
    return {};
  });
}

const GOOD: Record<string, Remux> = {
  '720p': {
    segments: [
      [5000, '2.000000'],
      [7000, '2.000000'],
      [3000, '1.500000'],
    ],
  },
  '360p': {
    segments: [
      [2000, '2.000000'],
      [2500, '2.000000'],
      [900, '1.500000'],
    ],
  },
};

/** Start a package; `result` is returned unawaited so a test attaches its handler at once. */
function run(
  per: Record<string, Remux> = GOOD,
  renditions: readonly NfxPackageRendition[] = [R720, R360],
  thumbnail = true,
): { fs: MemoryFs; runner: FakeRunner; result: Promise<NfxPackaged> } {
  const fs = new MemoryFs();
  fs.set('/work/thumb-0.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  const runner = remuxer(fs, per);
  const result = packageNfx(
    { runner, fs, sha256: nodeSha256, binaries: BINS },
    {
      video: VIDEO,
      renditions,
      ...(thumbnail ? { thumbnailPath: '/work/thumb-0.jpg' } : {}),
    },
  );
  return { fs, runner, result };
}

const text = (b: Uint8Array): string => new TextDecoder().decode(b);

function bytesOf(p: NfxPackaged, name: string, fs: MemoryFs): Uint8Array {
  const f = p.files.find((x) => x.entry.name === name);
  if (f === undefined) throw new Error(`no ${name}`);
  if (f.source.kind === 'bytes') return f.source.bytes;
  const b = fs.files.get(f.source.path);
  if (b === undefined) throw new Error(`no bytes at ${f.source.path}`);
  return b;
}

describe('packageNfx', () => {
  it('remuxes each rendition by stream copy into a verified NFX-05 package', async () => {
    const { fs, runner, result } = run();
    const p = await result;

    // One remux per rendition, stream copy only: no encoder anywhere in the argv.
    expect(runner.calls).toHaveLength(2);
    for (const [i, call] of runner.calls.entries()) {
      expect(call.file).toBe('/bin/ffmpeg');
      expect(call.args).toContain('copy');
      expect(call.args.some((a) => /libx264|libvpx|aac$/.test(a))).toBe(false);
      expect(call.args[call.args.indexOf('-i') + 1]).toBe(`file:${[R720, R360][i]?.path ?? ''}`);
    }

    expect(p.hashList.video).toBe('nfx:regtest:1:packager-test');
    expect(p.hashList.renditions).toEqual([
      {
        id: '720p',
        playlist: 'r720p.m3u8',
        bandwidth: 28_000n, // 7000 B over 2 s, the peak
        codecs: 'avc1.64001f,mp4a.40.2',
        resolution: '1280x720',
      },
      {
        id: '360p',
        playlist: 'r360p.m3u8',
        bandwidth: 10_000n,
        codecs: 'avc1.64001e,mp4a.40.2',
        resolution: '640x360',
      },
    ]);
    expect(p.hashList.files.map((f) => [f.name, f.role, f.durMs])).toEqual([
      ['master.m3u8', 'playlist-master', undefined],
      ['r720p.m3u8', 'playlist', undefined],
      ['r360p.m3u8', 'playlist', undefined],
      ['init-720p.mp4', 'init', undefined],
      ['720p-seg_00000.m4s', 'segment', 2000n],
      ['720p-seg_00001.m4s', 'segment', 2000n],
      ['720p-seg_00002.m4s', 'segment', 1500n],
      ['init-360p.mp4', 'init', undefined],
      ['360p-seg_00000.m4s', 'segment', 2000n],
      ['360p-seg_00001.m4s', 'segment', 2000n],
      ['360p-seg_00002.m4s', 'segment', 1500n],
      ['thumb.jpg', 'thumb', undefined],
    ]);
    expect(p.segs).toBe(12n);
    expect(p.root).toBe(sha256Hex(p.hashListBytes));
    expect(verifyHashList(p.hashListBytes, p.root, VIDEO, p.segs).ok).toBe(true);
    for (const f of p.files) {
      const b = bytesOf(p, f.entry.name, fs);
      expect(f.entry.sha256, f.entry.name).toBe(sha256Hex(b));
      expect(f.entry.size, f.entry.name).toBe(BigInt(b.length));
    }

    // Playlists name content only.
    const sha = (name: string): string =>
      p.files.find((f) => f.entry.name === name)?.entry.sha256 ?? '';
    const r720 = text(bytesOf(p, 'r720p.m3u8', fs));
    expect(r720).toContain(`#EXT-X-MAP:URI="${sha('init-720p.mp4')}.mp4"\n`);
    expect(r720).toContain(`#EXTINF:2.000000,\n${sha('720p-seg_00000.m4s')}.m4s\n`);
    expect(r720).not.toMatch(/seg_\d|init\.mp4/);
    expect(r720.endsWith('#EXT-X-ENDLIST\n')).toBe(true);
    expect(text(bytesOf(p, 'master.m3u8', fs))).toBe(
      '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=28000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\n' +
        `${sha('r720p.m3u8')}.m3u8\n` +
        '#EXT-X-STREAM-INF:BANDWIDTH=10000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"\n' +
        `${sha('r360p.m3u8')}.m3u8\n`,
    );
    expect(p.workDirs).toHaveLength(2);
    expect(fs.removed).toEqual([]);
  });

  it('is deterministic: the same remux output gives the same root', async () => {
    const a = await run().result;
    const b = await run().result;
    expect(b.root).toBe(a.root);
  });

  it('leaves the thumbnail out when none is given', async () => {
    const p = await run(GOOD, [R720, R360], false).result;
    expect(p.hashList.files.some((f) => f.role === 'thumb')).toBe(false);
    expect(p.segs).toBe(11n);
  });

  it('refuses a rendition that is not H.264 in MP4, before running ffmpeg', async () => {
    const vp9 = { ...R720, spec: spec('720p', 720, 'vp9') };
    const { runner, result } = run(GOOD, [vp9]);
    await expect(result).rejects.toMatchObject({ name: 'MediaError', code: 'unsupported-input' });
    expect(runner.calls).toHaveLength(0);
  });

  it('refuses duplicate or unsafe labels and bad dimensions', async () => {
    for (const renditions of [
      [R720, R720],
      [{ ...R720, spec: { ...R720.spec, label: '../720p' } }],
      [{ ...R720, width: 0 }],
      [],
    ]) {
      await expect(run(GOOD, renditions).result).rejects.toMatchObject({
        code: 'unsupported-input',
      });
    }
  });

  it('refuses renditions whose segment grids differ, and removes what it wrote', async () => {
    const skewed = {
      ...GOOD,
      '360p': { segments: [[2000, '2.000000'] as const, [900, '1.500000'] as const] },
    };
    const { fs, result } = run(skewed);
    await expect(result).rejects.toThrow(/durations differ/);
    expect(fs.removed).toHaveLength(2);
  });

  it('refuses a segment before the last that is not GOP_SECONDS long', async () => {
    const off = {
      '720p': {
        segments: [[5000, '2.500000'] as const, [3000, '1.500000'] as const],
      },
    };
    await expect(run(off, [R720]).result).rejects.toThrow(/segments are not 2 s/);
  });

  it.each([
    ['a missing EXT-X-ENDLIST', (t: string) => t.replace('#EXT-X-ENDLIST\n', ''), /incomplete/],
    [
      'a URI that is not a plain name',
      (t: string) => t.replace('seg_00001.m4s', '../x.m4s'),
      /plain name/,
    ],
    [
      'an absolute URL',
      (t: string) => t.replace('seg_00001.m4s', 'https://example.com/x.m4s'),
      /plain name/,
    ],
    [
      'an EXT-X-MAP other than init.mp4',
      (t: string) => t.replace('URI="init.mp4"', 'URI="other.mp4"'),
      /EXT-X-MAP/,
    ],
    ['a bad EXTINF', (t: string) => t.replace('#EXTINF:2.000000,', '#EXTINF:two,'), /EXTINF/],
    [
      'a zero-length segment',
      (t: string) => t.replace('#EXTINF:1.500000,', '#EXTINF:0.0001,'),
      /zero-length/,
    ],
    [
      'a segment without EXTINF',
      (t: string) => t.replace('#EXTINF:2.000000,\nseg_00000', 'seg_00000'),
      /without EXTINF/,
    ],
  ])('refuses remux output with %s', async (_what, playlist, message) => {
    const per = { '720p': { ...GOOD['720p']!, playlist } };
    await expect(run(per, [R720]).result).rejects.toThrow(message);
  });

  it('refuses an init segment with a codec NFX does not package', async () => {
    const hevc = initSegment([
      trakBox(box('hvc1', concat([new Uint8Array(78), box('hvcC', new Uint8Array(4))]))),
    ]);
    const per = { '720p': { ...GOOD['720p']!, init: hevc } };
    await expect(run(per, [R720]).result).rejects.toMatchObject({
      code: 'unsupported-input',
    });
    // a video-only init is fine: CODECS has no audio part
    const videoOnly = {
      '720p': { ...GOOD['720p']!, init: initSegment([trakBox(avcEntry(0x64, 0, 0x1f))]) },
    };
    const p = await run(videoOnly, [R720]).result;
    expect(p.hashList.renditions[0]?.codecs).toBe('avc1.64001f');
  });

  it('surfaces an ffmpeg failure as process-failed with its stderr', async () => {
    const { result } = run({}, [R720]);
    await expect(result).rejects.toMatchObject({
      code: 'process-failed',
      stderr: 'no fake for 720p',
    });
  });
});

describe('cmafRemuxArgv', () => {
  it('guards the input, reads it through file:, copies streams and writes the CMAF tail', () => {
    const argv = cmafRemuxArgv('-evil concat:x $(id).mp4', '/tmp/out');
    const i = argv.indexOf('-i');
    expect(argv.slice(i - REMUX_INPUT_GUARD.length, i)).toEqual([...REMUX_INPUT_GUARD]);
    expect(argv[i + 1]).toBe('file:-evil concat:x $(id).mp4');
    const opt = (flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
    expect(opt('-c')).toBe('copy');
    expect(opt('-f')).toBe('hls');
    expect(opt('-hls_time')).toBe('2');
    expect(opt('-hls_segment_type')).toBe('fmp4');
    expect(opt('-hls_playlist_type')).toBe('vod');
    expect(opt('-hls_flags')).toBe('independent_segments');
    expect(opt('-hls_fmp4_init_filename')).toBe('init.mp4');
    expect(opt('-hls_segment_filename')).toBe('/tmp/out/seg_%05d.m4s');
    expect(argv.at(-1)).toBe('/tmp/out/index.m3u8');
  });

  it('refuses an output directory with % or a leading -', () => {
    for (const dir of ['/tmp/a%d', '-x', '']) {
      expect(() => cmafRemuxArgv('/in.mp4', dir), dir).toThrow(MediaError);
    }
  });
});
