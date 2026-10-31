/**
 * Slice 5d: layout C planned from the init and the first segment, checked on every later one.
 * Synthetic fMP4 boxes (the shapes `mp4-sidx.test.ts` uses); real ffmpeg output is covered by the
 * nfx-playback e2e.
 */
import { describe, expect, it } from 'vitest';

import { locate } from '../../nfx/progressive.js';
import { buildSidx } from '../mp4-sidx.js';
import { checkNfxSegment, planNfxPlayback, segmentLead } from '../nfx-play.js';

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

const SCALE = 12800;
const trak = box(
  'trak',
  box('tkhd', full(0), u32(0), u32(0), u32(1), new Uint8Array(68)),
  box(
    'mdia',
    box('mdhd', full(0), u32(0), u32(0), u32(SCALE), u32(0), new Uint8Array(4)),
    box('hdlr', full(0), u32(0), codes('vide'), new Uint8Array(12)),
  ),
);
const init = cat(
  box('ftyp', codes('iso6'), u32(0)),
  box('moov', box('mvhd', full(0), new Uint8Array(96)), trak),
);
const lead = cat(box('styp', codes('msdh'), u32(0)), box('sidx', full(1), new Uint8Array(32)));
/** A segment whose `tfdt` is `start`, `fill` bytes of media, with the usual leading index. */
const segment = (start: number, fill: number, head: Uint8Array = lead): Uint8Array =>
  cat(
    head,
    box(
      'moof',
      box('mfhd', full(0), u32(1)),
      box('traf', box('tfhd', full(0), u32(1)), box('tfdt', full(1), u64(start))),
    ),
    box('mdat', new Uint8Array(fill).fill(7)),
  );

const hex = (i: number): string => i.toString(16).padStart(2, '0').repeat(32);
const segs = [segment(0, 40), segment(25_600, 50), segment(51_200, 30)];
const entries = segs.map((s, i) => ({ sha256: hex(i + 1), size: s.length, durMs: 2000 }));
const plan = (): ReturnType<typeof planNfxPlayback> =>
  planNfxPlayback({
    init: { sha256: hex(9), size: init.length },
    initBytes: init,
    segments: entries,
    first: segs[0]!,
  });

describe('planNfxPlayback (layout C, slice 5d)', () => {
  it('predicts every start and the global sidx from the first segment and the durations', () => {
    const r = plan();
    if (!r.ok) throw new Error(r.reason);
    const p = r.plan;
    expect(p.lead).toBe(lead.length);
    expect(p.track).toEqual({ trackId: 1, timescale: SCALE });
    expect(p.starts).toEqual([0, 25_600, 51_200]);
    const sidx = buildSidx(
      p.track,
      segs.map((s, i) => ({ size: s.length - lead.length, start: p.starts[i]! })),
      76_800,
    );
    const parts = p.layout.parts.map((x) => x.part);
    expect(parts[0]).toEqual({ kind: 'file', sha256: hex(9), size: init.length });
    expect(parts[1]).toEqual({ kind: 'bytes', bytes: sidx });
    expect(parts.slice(2)).toEqual(
      entries.map((e) => ({
        kind: 'file',
        sha256: e.sha256,
        size: e.size - lead.length,
        skip: lead.length,
      })),
    );
    expect(p.layout.size).toBe(
      init.length + sidx.length + segs.reduce((n, s) => n + s.length - lead.length, 0),
    );
    // A range across the sidx and a segment: the segment piece reads past the lead.
    const pieces = locate(p.layout, init.length, sidx.length + 4);
    expect(pieces.map((x) => [x.part.kind, x.offset, x.length])).toEqual([
      ['bytes', 0, sidx.length],
      ['file', 0, 4],
    ]);
  });

  it('accepts later segments that match, and refuses any that do not', () => {
    const r = plan();
    if (!r.ok) throw new Error(r.reason);
    expect(checkNfxSegment(r.plan, 1, segs[1]!)).toBe(true);
    expect(checkNfxSegment(r.plan, 2, segs[2]!)).toBe(true);
    // Its tfdt is not where the durations put it.
    expect(checkNfxSegment(r.plan, 1, segment(25_601, 50))).toBe(false);
    // A different lead (one sidx only), padded to the listed size.
    const sidxBox = box('sidx', full(1), new Uint8Array(32)).length;
    const oneSidx = segment(25_600, 50 + sidxBox, box('styp', codes('msdh'), u32(0)));
    expect(oneSidx.length).toBe(segs[1]!.length);
    expect(checkNfxSegment(r.plan, 1, oneSidx)).toBe(false);
    // Not its listed size, out of range, or not MP4.
    expect(checkNfxSegment(r.plan, 1, segs[2]!)).toBe(false);
    expect(checkNfxSegment(r.plan, 3, segs[2]!)).toBe(false);
    expect(checkNfxSegment(r.plan, 2, new Uint8Array(segs[2]!.length))).toBe(false);
  });

  it('refuses what it cannot serve from an offset', () => {
    const base = {
      init: { sha256: hex(9), size: init.length },
      initBytes: init,
      segments: entries,
      first: segs[0]!,
    };
    expect(planNfxPlayback({ ...base, segments: [] }).ok).toBe(false);
    expect(planNfxPlayback({ ...base, init: { sha256: hex(9), size: init.length + 1 } }).ok).toBe(
      false,
    );
    expect(planNfxPlayback({ ...base, first: segs[1]! }).ok).toBe(false);
    expect(
      planNfxPlayback({ ...base, segments: entries.map((e) => ({ ...e, durMs: 0 })) }).ok,
    ).toBe(false);
    // A sidx after the media: an offset would serve it in the middle of the view.
    const trailing = cat(
      segment(0, 40, new Uint8Array(0)),
      box('sidx', full(1), new Uint8Array(32)),
    );
    expect(segmentLead(trailing)).toBeUndefined();
    expect(
      planNfxPlayback({
        ...base,
        segments: [{ ...entries[0]!, size: trailing.length }],
        first: trailing,
      }).ok,
    ).toBe(false);
    expect(planNfxPlayback({ ...base, initBytes: new Uint8Array(init.length) }).ok).toBe(false);
  });

  it('segmentLead: the leading index bytes, or none before a moof', () => {
    expect(segmentLead(segs[0]!)).toBe(lead.length);
    expect(segmentLead(segment(0, 4, new Uint8Array(0)))).toBe(0);
    expect(segmentLead(cat(box('mdat', new Uint8Array(4)), segs[0]!))).toBeUndefined();
    expect(segmentLead(new Uint8Array([0, 0, 0, 99]))).toBeUndefined();
  });
});
