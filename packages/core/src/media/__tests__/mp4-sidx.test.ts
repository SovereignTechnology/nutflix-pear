/**
 * The global `sidx` of spike S-E, against hand-built boxes and a hand-computed vector (ISO/IEC
 * 14496-12 §8.16.3); the real packager's bytes are covered in node-real-ffmpeg-nfx.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { MediaError } from '../errors.js';
import { buildSidx, initTrack, segmentStart, stripSegmentIndex } from '../mp4-sidx.js';

const u32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
};
const u64 = (n: number): Uint8Array =>
  new Uint8Array([...u32(Math.floor(n / 2 ** 32)), ...u32(n % 2 ** 32)]);
/** The bytes of an ASCII string (box types, brands). */
function codes(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
const cat = (...parts: Uint8Array[]): Uint8Array => {
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
const text = (s: string): Uint8Array => codes(s);

/** A track: tkhd v0 (times, then track_ID), mdia/mdhd v0 (times, then timescale), hdlr. */
const trak = (id: number, scale: number, kind: string): Uint8Array =>
  box(
    'trak',
    box('tkhd', full(0), u32(0), u32(0), u32(id), new Uint8Array(68)),
    box(
      'mdia',
      box('mdhd', full(0), u32(0), u32(0), u32(scale), u32(0), new Uint8Array(4)),
      box('hdlr', full(0), u32(0), text(kind), new Uint8Array(12)),
    ),
  );
const init = cat(
  box('ftyp', text('iso6'), u32(0)),
  box(
    'moov',
    box('mvhd', full(0), new Uint8Array(96)),
    trak(2, 48000, 'soun'),
    trak(1, 12800, 'vide'),
  ),
);
const traf = (id: number, start: number): Uint8Array =>
  box('traf', box('tfhd', full(0), u32(id)), box('tfdt', full(1), u64(start)));
const moof = box('moof', box('mfhd', full(0), u32(1)), traf(2, 96000), traf(1, 25600));
const mdat = box('mdat', new Uint8Array(32).fill(7));
const segment = cat(
  box('styp', text('msdh'), u32(0)),
  box('sidx', full(1), new Uint8Array(32)),
  moof,
  mdat,
);

describe('the global sidx (spike S-E)', () => {
  it('reads the video track of an init, whatever its order', () => {
    expect(initTrack(init)).toEqual({ trackId: 1, timescale: 12800 });
  });

  it("reads a segment's start for that track from its tfdt", () => {
    expect(segmentStart(segment, 1)).toBe(25600);
    expect(segmentStart(segment, 2)).toBe(96000);
    expect(() => segmentStart(segment, 3)).toThrow(MediaError);
  });

  it('strips only the top-level styp and sidx, keeping moof and mdat byte for byte', () => {
    expect(stripSegmentIndex(segment)).toEqual(cat(moof, mdat));
    expect(stripSegmentIndex(cat(moof, mdat))).toEqual(cat(moof, mdat));
  });

  it('writes the version-1 sidx a hand computes', () => {
    const sidx = buildSidx(
      { trackId: 1, timescale: 12800 },
      [
        { size: 1000, start: 0 },
        { size: 2000, start: 25600 },
      ],
      51200,
    );
    const hex = Buffer.from(sidx).toString('hex');
    expect(hex).toBe(
      [
        '00000040',
        '73696478',
        '01000000', // size 64, 'sidx', version 1
        '00000001',
        '00003200', // reference_ID 1, timescale 12800
        '0000000000000000',
        '0000000000000000', // earliest presentation 0, first_offset 0
        '0000',
        '0002', // reserved, two references
        '000003e8',
        '00006400',
        '90000000', // 1000 bytes, 25600 ticks, SAP type 1
        '000007d0',
        '00006400',
        '90000000',
      ].join(''),
    );
  });

  it('refuses what a sidx cannot say, and malformed boxes, as MediaError', () => {
    const t = { trackId: 1, timescale: 12800 };
    expect(() => buildSidx(t, [], 0)).toThrow(MediaError);
    expect(() => buildSidx({ trackId: 2 ** 32, timescale: 1 }, [{ size: 1, start: 0 }], 1)).toThrow(
      MediaError,
    );
    expect(() => buildSidx({ trackId: 1, timescale: 0 }, [{ size: 1, start: 0 }], 1)).toThrow(
      MediaError,
    );
    expect(() => buildSidx(t, [{ size: 0, start: 0 }], 10)).toThrow(MediaError);
    expect(() => buildSidx(t, [{ size: 2 ** 31, start: 0 }], 10)).toThrow(MediaError);
    expect(() =>
      buildSidx(
        t,
        [
          { size: 1, start: 10 },
          { size: 1, start: 5 },
        ],
        20,
      ),
    ).toThrow(MediaError);
    expect(() => buildSidx(t, [{ size: 1, start: 10 }], 10)).toThrow(MediaError);
    // A box that claims more than it holds, a truncated tkhd, no moov.
    expect(() => initTrack(cat(u32(64), text('moov')))).toThrow(MediaError);
    expect(() => initTrack(box('moov', box('trak', box('tkhd', full(0)))))).toThrow(MediaError);
    expect(() => initTrack(box('ftyp'))).toThrow(MediaError);
    expect(() => segmentStart(mdat, 1)).toThrow(MediaError);
  });
});
