/**
 * One NFX rendition as one progressive fragmented MP4 (spike S-E): the timing a global `sidx`
 * needs, read from a CMAF init and its segments, and the `sidx` itself (ISO/IEC 14496-12
 * §8.16.3). A `<video src>` player can then find the duration and seek by byte range in a file
 * made of the init, this index and the segments, without a playlist or MSE.
 *
 * Pure; every read is bounds-checked, and malformed input is a `MediaError`, never a throw of
 * anything else (the bytes are a creator's or a peer's, checked only against their sha256).
 */
import { MediaError } from './errors.js';
import { childBoxes } from './mp4-codecs.js';

const bad = (what: string): MediaError => new MediaError('process-failed', `cmaf: ${what}`);

/** A track as a `sidx` names it: its id and the timescale its times are in. */
export interface Mp4Track {
  readonly trackId: number;
  readonly timescale: number;
}

/** One segment as the index lists it: its size in the progressive file, and when it starts. */
export interface SidxSegment {
  /** Bytes of the segment as served (after `stripSegmentIndex`, if that was applied). */
  readonly size: number;
  /** Its `tfdt` base media decode time for the track, in the track's timescale. */
  readonly start: number;
}

function u32(b: Uint8Array, o: number): number {
  if (o < 0 || o + 4 > b.length) throw bad('field out of bounds');
  return (
    (b[o] ?? 0) * 0x1_00_00_00 +
    (((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0))
  );
}

function u64(b: Uint8Array, o: number): number {
  const v = u32(b, o) * 0x1_0000_0000 + u32(b, o + 4);
  if (!Number.isSafeInteger(v)) throw bad('a 64-bit time past 2^53');
  return v;
}

function child(data: Uint8Array, type: string): Uint8Array | undefined {
  return childBoxes(data).find((b) => b.type === type)?.body;
}

function required(data: Uint8Array, type: string): Uint8Array {
  const body = child(data, type);
  if (body === undefined) throw bad(`missing '${type}' box`);
  return body;
}

/** `tkhd` → track_ID (version 0: after two 32-bit times; version 1: two 64-bit times). */
function trackId(tkhd: Uint8Array): number {
  const version = tkhd[0];
  if (version === 0) return u32(tkhd, 4 + 8);
  if (version === 1) return u32(tkhd, 4 + 16);
  throw bad('unknown tkhd version');
}

/** `mdhd` → timescale. */
function timescale(mdhd: Uint8Array): number {
  const version = mdhd[0];
  const t = version === 0 ? u32(mdhd, 4 + 8) : version === 1 ? u32(mdhd, 4 + 16) : undefined;
  if (t === undefined) throw bad('unknown mdhd version');
  if (t === 0) throw bad('a zero timescale');
  return t;
}

/** `hdlr` → handler_type (after version/flags and pre_defined). */
function handler(hdlr: Uint8Array): string {
  if (hdlr.length < 12) throw bad('short hdlr');
  return String.fromCharCode(hdlr[8] ?? 0, hdlr[9] ?? 0, hdlr[10] ?? 0, hdlr[11] ?? 0);
}

/** The video track of an init segment (the one a `sidx` indexes), or its first track. */
export function initTrack(init: Uint8Array): Mp4Track {
  const moov = required(init, 'moov');
  const traks = childBoxes(moov).filter((b) => b.type === 'trak');
  if (traks.length === 0) throw bad('no track');
  const tracks = traks.map((t) => {
    const mdia = required(t.body, 'mdia');
    return {
      trackId: trackId(required(t.body, 'tkhd')),
      timescale: timescale(required(mdia, 'mdhd')),
      kind: handler(required(mdia, 'hdlr')),
    };
  });
  const pick = tracks.find((t) => t.kind === 'vide') ?? tracks[0];
  if (pick === undefined) throw bad('no track');
  return { trackId: pick.trackId, timescale: pick.timescale };
}

/** When a segment starts for `trackId`: the `tfdt` of that track's `traf` in its first `moof`. */
export function segmentStart(segment: Uint8Array, trackIdWanted: number): number {
  const moof = required(segment, 'moof');
  for (const traf of childBoxes(moof).filter((b) => b.type === 'traf')) {
    const tfhd = required(traf.body, 'tfhd');
    if (u32(tfhd, 4) !== trackIdWanted) continue;
    const tfdt = required(traf.body, 'tfdt');
    const version = tfdt[0];
    if (version === 0) return u32(tfdt, 4);
    if (version === 1) return u64(tfdt, 4);
    throw bad('unknown tfdt version');
  }
  throw bad(`no traf for track ${String(trackIdWanted)}`);
}

/**
 * A segment without its top-level `styp` and `sidx` boxes: what a producer that writes only
 * `moof` + `mdat` emits (S-E's variant B), and what a global index then covers.
 */
export function stripSegmentIndex(segment: Uint8Array): Uint8Array {
  // `childBoxes` hands back bodies; each box runs from the previous one's end to its body's end.
  const out: Uint8Array[] = [];
  let off = 0;
  for (const box of childBoxes(segment)) {
    const end = box.body.byteOffset - segment.byteOffset + box.body.length;
    if (box.type !== 'styp' && box.type !== 'sidx') out.push(segment.subarray(off, end));
    off = end;
  }
  const total = out.reduce((n, p) => n + p.length, 0);
  const joined = new Uint8Array(total);
  let o = 0;
  for (const p of out) {
    joined.set(p, o);
    o += p.length;
  }
  return joined;
}

/** `starts_with_SAP` = 1, `SAP_type` = 1: every segment begins with a closed GOP's IDR frame. */
const SAP_IDR = 0x9000_0000;
/** `referenced_size` is 31 bits; `reference_count` 16; durations 32. */
const MAX_REFERENCED_SIZE = 0x7fff_ffff;
const MAX_REFERENCES = 0xffff;
const MAX_U32 = 0xffff_ffff;

/**
 * A version-1 `sidx` indexing `segments`, which follow it directly in the file (first_offset 0).
 * Each reference is one segment; a segment's duration is the next one's start minus its own,
 * and the last one's is `end` minus its start (`end`: the rendition's end, same timescale).
 */
export function buildSidx(
  track: Mp4Track,
  segments: readonly SidxSegment[],
  end: number,
): Uint8Array {
  if (segments.length === 0 || segments.length > MAX_REFERENCES)
    throw bad('a sidx indexes 1 to 65535 segments');
  if (!Number.isSafeInteger(end)) throw bad('a bad end time');
  // DataView would wrap anything past 32 bits silently; a sidx must name the init's real track.
  for (const v of [track.trackId, track.timescale])
    if (!Number.isSafeInteger(v) || v < 1 || v > MAX_U32)
      throw bad('a track id or timescale past 32 bits');
  const size = 12 + 28 + 12 * segments.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  const put64 = (o: number, v: number): void => {
    view.setUint32(o, Math.floor(v / 0x1_0000_0000), false);
    view.setUint32(o + 4, v % 0x1_0000_0000, false);
  };
  view.setUint32(0, size, false);
  out.set([0x73, 0x69, 0x64, 0x78], 4); // 'sidx'
  view.setUint32(8, 0x0100_0000, false); // version 1, flags 0
  view.setUint32(12, track.trackId, false);
  view.setUint32(16, track.timescale, false);
  const first = segments[0];
  if (first === undefined) throw bad('no segment');
  put64(20, first.start); // earliest_presentation_time
  put64(28, 0); // first_offset: the segments follow the index
  view.setUint16(36, 0, false); // reserved
  view.setUint16(38, segments.length, false);
  segments.forEach((s, i) => {
    const next = segments[i + 1]?.start ?? end;
    const duration = next - s.start;
    if (!Number.isSafeInteger(s.size) || s.size < 1 || s.size > MAX_REFERENCED_SIZE)
      throw bad(`segment ${String(i)}: a size a sidx cannot carry`);
    if (!Number.isSafeInteger(s.start) || duration < 1 || duration > MAX_U32)
      throw bad(`segment ${String(i)}: starts out of order`);
    const o = 40 + 12 * i;
    view.setUint32(o, s.size, false); // reference_type 0 (media) | referenced_size
    view.setUint32(o + 4, duration, false);
    view.setUint32(o + 8, SAP_IDR, false);
  });
  return out;
}
