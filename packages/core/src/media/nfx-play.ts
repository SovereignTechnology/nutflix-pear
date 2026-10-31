/**
 * Layout C for a remote NFX rendition (ADR 0020 slice 5d, spike S-E): the init, one global `sidx`
 * for every segment, then each segment from its `moof` — what Chromium plays with an exact
 * duration and seeks by Range (S-E findings 2–5).
 *
 * A viewer fetches whole files (`files/1`), so the global `sidx` must be written before most
 * segments arrive. It is predicted from what a viewer has before the first frame anyway:
 * - **the verified hash list**, giving each segment's size and duration;
 * - **the init**, giving the track and its timescale;
 * - **the first segment**, giving its `tfdt` and the length of its leading `styp`/`sidx`
 *   (`lead`), which the packager writes the same in front of every segment.
 *
 * Every later segment is then checked against the prediction on arrival (`checkNfxSegment`): same
 * size, same lead, its `tfdt` where the prediction put it. A mismatch must end the session,
 * because the byte offsets were already promised to the player.
 *
 * Pure: no I/O. The caller verifies every file's sha256 before handing it here.
 */
import { progressiveLayout, type ProgressiveLayout } from '../nfx/progressive.js';
import { childBoxes, type Mp4Child } from './mp4-codecs.js';
import { buildSidx, initTrack, segmentStart, type Mp4Track } from './mp4-sidx.js';

/** One segment as the hash list names it. */
export interface NfxPlaySegment {
  readonly sha256: string;
  readonly size: number;
  readonly durMs: number;
}

export interface NfxPlayPlan {
  readonly layout: ProgressiveLayout;
  readonly track: Mp4Track;
  /** Bytes of top-level `styp`/`sidx` in front of every segment's `moof`. */
  readonly lead: number;
  /** Each segment's predicted `tfdt`, in the track's timescale. */
  readonly starts: readonly number[];
  readonly segments: readonly NfxPlaySegment[];
}

export type NfxPlanResult =
  | { readonly ok: true; readonly plan: NfxPlayPlan }
  | { readonly ok: false; readonly reason: string };

/**
 * The bytes of top-level `styp`/`sidx` boxes before a segment's first `moof`, or `undefined` when
 * the segment is not `[styp|sidx]* moof …` with no index box after its media (then serving it from
 * an offset would be wrong).
 */
export function segmentLead(segment: Uint8Array): number | undefined {
  let boxes: readonly Mp4Child[];
  try {
    boxes = childBoxes(segment);
  } catch {
    return undefined;
  }
  let lead = 0;
  let media = false;
  for (const box of boxes) {
    const end = box.body.byteOffset - segment.byteOffset + box.body.length;
    if (box.type === 'styp' || box.type === 'sidx') {
      if (media) return undefined;
      lead = end;
    } else {
      if (!media && box.type !== 'moof') return undefined;
      media = true;
    }
  }
  return media ? lead : undefined;
}

/** Ticks of `ms` milliseconds at `timescale`, rounded. */
const ticks = (ms: number, timescale: number): number => Math.round((ms * timescale) / 1000);

/**
 * Plans layout C for one rendition: `init` (its entry and bytes), its `segments` in playlist order,
 * and the bytes of the first one.
 */
export function planNfxPlayback(o: {
  readonly init: { readonly sha256: string; readonly size: number };
  readonly initBytes: Uint8Array;
  readonly segments: readonly NfxPlaySegment[];
  readonly first: Uint8Array;
}): NfxPlanResult {
  const fail = (reason: string): NfxPlanResult => ({ ok: false, reason });
  const [head] = o.segments;
  if (head === undefined) return fail('no segments');
  if (o.initBytes.length !== o.init.size) return fail('the init is not its listed size');
  if (o.first.length !== head.size) return fail('the first segment is not its listed size');
  if (o.segments.length > 65_535) return fail('too many segments for one sidx');
  for (const s of o.segments) {
    if (!Number.isSafeInteger(s.durMs) || s.durMs < 1) return fail('a segment has no duration');
  }
  let track: Mp4Track;
  let start0: number;
  try {
    track = initTrack(o.initBytes);
    start0 = segmentStart(o.first, track.trackId);
  } catch {
    return fail('the init or the first segment is not fragmented MP4');
  }
  const lead = segmentLead(o.first);
  if (lead === undefined) return fail('the first segment has an index box after its media');
  const starts: number[] = [];
  let ms = 0;
  for (const s of o.segments) {
    if (s.size <= lead) return fail('a segment is no longer than its index boxes');
    starts.push(start0 + ticks(ms, track.timescale));
    ms += s.durMs;
  }
  const end = start0 + ticks(ms, track.timescale);
  if (!Number.isSafeInteger(end)) return fail('the presentation is too long');
  let sidx: Uint8Array;
  try {
    sidx = buildSidx(
      track,
      o.segments.map((s, i) => ({ size: s.size - lead, start: starts[i] ?? 0 })),
      end,
    );
  } catch {
    return fail('the segment index could not be built');
  }
  const layout = progressiveLayout([
    { kind: 'file', sha256: o.init.sha256, size: o.init.size },
    { kind: 'bytes', bytes: sidx },
    ...o.segments.map((s) => ({
      kind: 'file' as const,
      sha256: s.sha256,
      size: s.size - lead,
      skip: lead,
    })),
  ]);
  return { ok: true, plan: { layout, track, lead, starts, segments: o.segments } };
}

/**
 * Whether segment `index`'s verified bytes are what the plan promised: its listed size, the same
 * lead, and its `tfdt` where the plan put it.
 */
export function checkNfxSegment(plan: NfxPlayPlan, index: number, bytes: Uint8Array): boolean {
  if (bytes.length !== plan.segments[index]?.size) return false;
  if (segmentLead(bytes) !== plan.lead) return false;
  try {
    return segmentStart(bytes, plan.track.trackId) === plan.starts[index];
  } catch {
    return false;
  }
}
