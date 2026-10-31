/**
 * Test support (not a suite): a tiny but VALID NFX video in memory — synthetic fMP4 boxes (the
 * shapes core's `media/__tests__/nfx-play.test.ts` uses), two rendition playlists over the same
 * init and segments, and a hash list in core's rendering (`nfx.renderHashList`) — plus the layout C
 * bytes a watcher must serve for it, and an `NfxFileSource` that serves it as the store would.
 */
import { createHash } from 'node:crypto';

import type { Sha256Hex } from '@sovit/core';
import { media, nfx } from '@sovit/core';
import type { NfxFileSource } from '@sovit/seeder';

export const NFX_NS = 'nfx:testnet:1';
export const NFX_TEST_VIDEO = `${NFX_NS}:nutflix-${'c'.repeat(32)}`;
/** The track's timescale; every segment lasts 2 s, i.e. 25 600 ticks. */
export const SCALE = 12800;
const TICKS_PER_SEGMENT = 25_600;

const u32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
};
const u64 = (n: number): Uint8Array =>
  new Uint8Array([...u32(Math.floor(n / 2 ** 32)), ...u32(n % 2 ** 32)]);
function codes(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
export const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const box = (type: string, ...body: Uint8Array[]): Uint8Array => {
  const inner = cat(...body);
  return cat(u32(8 + inner.length), codes(type), inner);
};
const full = (version: number): Uint8Array => new Uint8Array([version, 0, 0, 0]);

const trak = box(
  'trak',
  box('tkhd', full(0), u32(0), u32(0), u32(1), new Uint8Array(68)),
  box(
    'mdia',
    box('mdhd', full(0), u32(0), u32(0), u32(SCALE), u32(0), new Uint8Array(4)),
    box('hdlr', full(0), u32(0), codes('vide'), new Uint8Array(12)),
  ),
);
export const INIT = cat(
  box('ftyp', codes('iso6'), u32(0)),
  box('moov', box('mvhd', full(0), new Uint8Array(96)), trak),
);
/** The `styp` + `sidx` the packager writes in front of every segment. */
export const LEAD = cat(
  box('styp', codes('msdh'), u32(0)),
  box('sidx', full(1), new Uint8Array(32)),
);

/** A segment whose `tfdt` is `start`, with `fill` bytes of media and the usual leading index. */
export const segment = (start: number, fill: number): Uint8Array =>
  cat(
    LEAD,
    box(
      'moof',
      box('mfhd', full(0), u32(1)),
      box('traf', box('tfhd', full(0), u32(1)), box('tfdt', full(1), u64(start))),
    ),
    box('mdat', new Uint8Array(fill).fill(7 + (start % 200))),
  );

/** `n` honest segments: segment i at `i × 2 s`. */
export const segments = (n: number): Uint8Array[] =>
  Array.from({ length: n }, (_, i) => segment(i * TICKS_PER_SEGMENT, 30 + 7 * i));

export const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export interface TestNfxVideo {
  readonly video: string;
  readonly root: Sha256Hex;
  readonly segs: number;
  /** Every listed file by sha256, and the hash list under `root`. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly segmentShas: readonly string[];
  /** Layout C as the plan predicts it: the init, the global sidx, each segment from its `moof`. */
  readonly expected: Uint8Array;
  /** Where the sidx starts in `expected`, and each segment. */
  readonly sidxAt: number;
  readonly segmentAt: readonly number[];
}

/**
 * The video: renditions `720p` (2 Mbit/s, 1280x720) and `360p` (500 kbit/s, 640x360), whose
 * playlists list the same init and `segs` (default: three honest ones).
 */
export function testNfxVideo(segs: readonly Uint8Array[] = segments(3)): TestNfxVideo {
  const initSha = sha256(INIT);
  const segmentShas = segs.map(sha256);
  const playlist = (extra: readonly string[]): Uint8Array =>
    new TextEncoder().encode(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:2',
        ...extra,
        `#EXT-X-MAP:URI="${initSha}.mp4"`,
        ...segmentShas.flatMap((s) => ['#EXTINF:2.000,', `${s}.m4s`]),
        '#EXT-X-ENDLIST',
        '',
      ].join('\n'),
    );
  const high = playlist([]);
  const low = playlist(['#EXT-X-INDEPENDENT-SEGMENTS']);
  const list: nfx.HashList = {
    v: 1,
    video: NFX_TEST_VIDEO,
    files: [
      {
        name: 'playlist-720p.m3u8',
        role: 'playlist',
        sha256: sha256(high),
        size: BigInt(high.length),
        durMs: undefined,
      },
      {
        name: 'playlist-360p.m3u8',
        role: 'playlist',
        sha256: sha256(low),
        size: BigInt(low.length),
        durMs: undefined,
      },
      {
        name: 'init.mp4',
        role: 'init',
        sha256: initSha,
        size: BigInt(INIT.length),
        durMs: undefined,
      },
      ...segs.map((b, i) => ({
        name: `seg-${String(i)}.m4s`,
        role: 'segment' as const,
        sha256: segmentShas[i] ?? '',
        size: BigInt(b.length),
        durMs: 2000n,
      })),
    ],
    renditions: [
      {
        id: '360p',
        playlist: 'playlist-360p.m3u8',
        bandwidth: 500_000n,
        codecs: undefined,
        resolution: '640x360',
      },
      {
        id: '720p',
        playlist: 'playlist-720p.m3u8',
        bandwidth: 2_000_000n,
        codecs: undefined,
        resolution: '1280x720',
      },
    ],
  };
  const hashList = nfx.renderHashList(list);
  const root = sha256(hashList) as Sha256Hex;
  const files = new Map<string, Uint8Array>([
    [root, hashList],
    [sha256(high), high],
    [sha256(low), low],
    [initSha, INIT],
    ...segs.map((b) => [sha256(b), b] as const),
  ]);

  // Layout C, built here from the boxes rather than by the code under test.
  const track = media.initTrack(INIT);
  let start0 = 0;
  try {
    if (segs[0] !== undefined) start0 = media.segmentStart(segs[0], track.trackId);
  } catch {
    // Not fMP4 (a test of a refused open): `expected` is not used.
  }
  const starts = segs.map((_, i) => start0 + i * TICKS_PER_SEGMENT);
  const sidx = media.buildSidx(
    track,
    segs.map((b, i) => ({ size: b.length - LEAD.length, start: starts[i] ?? 0 })),
    start0 + segs.length * TICKS_PER_SEGMENT,
  );
  const stripped = segs.map((b) => b.subarray(LEAD.length));
  const segmentAt: number[] = [];
  let at = INIT.length + sidx.length;
  for (const s of stripped) {
    segmentAt.push(at);
    at += s.length;
  }
  return {
    video: NFX_TEST_VIDEO,
    root,
    segs: list.files.length,
    files,
    segmentShas,
    expected: cat(INIT, sidx, ...stripped),
    sidxAt: INIT.length,
    segmentAt,
  };
}

/** `files` served for `video` only, as the NFX store answers (only listed files, only that video). */
export function memorySource(files: ReadonlyMap<string, Uint8Array>, video: string): NfxFileSource {
  return {
    hasVideo: (v) => v.toString() === video,
    file: (v, sha) => {
      const data = v.toString() === video ? files.get(sha) : undefined;
      if (data === undefined) return undefined;
      return {
        size: data.byteLength,
        read: (offset, length) => Promise.resolve(data.subarray(offset, offset + length)),
      };
    },
  };
}
