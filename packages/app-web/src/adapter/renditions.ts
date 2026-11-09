/**
 * Which renditions a web play may use, and which it starts on (pear #97, the maintainer's
 * decision of 2026-11-09): never a rendition no reachable seeder holds, and the one most of them
 * hold first.
 *
 * - **Held** comes from core's `nfx.renditionAvailability` over the beacons, counting only what
 *   this page can reach: `https` origins it may fetch from (`beaconOrigin`) and `webrtc` bridges
 *   with a tracker it may use (`beaconTracker`). An endpoint without a `renditions` list holds
 *   every rendition.
 * - **When every counted seeder holds every rendition** (the usual case, and every one-rendition
 *   video), nothing is pinned: hls.js picks, as before.
 * - **Otherwise** the hash list is read from the play's origins (checked against the manifest's
 *   root, as the player checks it), the held renditions are ordered by core's
 *   `nfx.preferRenditions`, and the player starts on the first. The player's `level` is an index
 *   into hls.js's levels, which hls.js 1.7.3 sorts by HDCP level, height (when every level has a
 *   resolution), frame rate, video range, codec and then bitrate. Renditions of one NFX package
 *   differ only in height and bandwidth, so `levelOrder` is that order. The session checks the
 *   level it pinned once hls.js lists its levels, and moves to the matching one if they differ.
 *
 * TODO(pear #97): nfx's web library is getting an `open()` option that restricts its levels to
 * given rendition ids. Once pear pins a library with it, pass `allowed` (every held id, the
 * preferred first) instead of only the starting level, so hls.js adapts to bandwidth among the
 * held renditions; until then the start is pinned and the viewer's quality menu still lists every
 * level.
 */
import type { NfxVideo, NostrEvent } from '@sovit/core';
import {
  MAX_HASH_LIST_BYTES,
  availabilityVaries,
  parseATag,
  preferRenditions,
  renditionAvailability,
  verifyHashList,
  type Endpoint,
  type RenditionAvailability,
} from '@sovit/core/nfx';

import { beaconOrigin, beaconTracker } from './endpoints.js';
import { getBounded, type FetchFn } from './http.js';

/**
 * How long reading the hash list may take, ms, from every origin together: a beacon names the
 * origins, so a stalling one must not hold the play back for long.
 */
export const HASH_LIST_TIMEOUT_MS = 10_000;
/** The most origins asked for the hash list. */
export const HASH_LIST_ORIGINS = 3;

/** Whether this page can use endpoint `e` (the rules `beaconEndpoints` applies). */
export function webUsable(e: Endpoint): boolean {
  if (e.t === 'https') return beaconOrigin(e.url) !== null;
  if (e.t === 'webrtc') return e.trackerUrls.some((u) => beaconTracker(u) !== null);
  return false;
}

/** Per-rendition availability of `video` for this page, from its beacons `events`. */
export function webAvailability(
  video: Pick<NfxVideo, 'id' | 'author'>,
  events: readonly NostrEvent[],
  now: number,
): RenditionAvailability {
  return renditionAvailability(video, events, now, {
    transports: ['https', 'webrtc'],
    usable: webUsable,
  });
}

/** One rendition of a hash list, as the start choice needs it. */
export interface PlayRendition {
  readonly id: string;
  /** Bits per second (the master playlist's `BANDWIDTH`, hls.js's `bitrate`). */
  readonly bandwidth: number;
  /** Lines, from `resolution` (`<w>x<h>`), when listed. */
  readonly height?: number;
}

/** hls.js 1.7.3's level order for one NFX package's renditions (module comment). */
export function levelOrder<R extends PlayRendition>(renditions: readonly R[]): R[] {
  const byHeight = renditions.every((r) => r.height !== undefined);
  return [...renditions].sort(
    (a, b) => (byHeight ? (a.height ?? 0) - (b.height ?? 0) : 0) || a.bandwidth - b.bandwidth,
  );
}

/** Where the player starts, and what it may play (pear #97). */
export interface StartChoice {
  /** The hls.js level to start on (`levelOrder`). */
  readonly level: number;
  /** That level's rendition: what the session checks the pinned level against. */
  readonly rendition: PlayRendition;
  /** Every held rendition id, the preferred first (for the library's coming option). */
  readonly allowed: readonly string[];
}

/** The renditions of a verified hash list, as `PlayRendition`s (one past 2^53 bit/s is left out). */
function playRenditions(
  list: readonly {
    readonly id: string;
    readonly bandwidth: bigint;
    readonly resolution?: string | undefined;
  }[],
): PlayRendition[] {
  const out: PlayRendition[] = [];
  for (const r of list) {
    if (r.bandwidth > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    const m = /^([1-9][0-9]{0,4})x([1-9][0-9]{0,4})$/.exec(r.resolution ?? '');
    const height = m === null ? undefined : Number(m[2]);
    out.push({
      id: r.id,
      bandwidth: Number(r.bandwidth),
      ...(height === undefined ? {} : { height }),
    });
  }
  return out;
}

/** The start choice for `renditions` (a hash list's) given who holds what, or `undefined`. */
export function chooseStart(
  renditions: readonly PlayRendition[],
  held: RenditionAvailability,
): StartChoice | undefined {
  if (!availabilityVaries(held)) return undefined;
  const preferred = preferRenditions(renditions, held);
  const first = preferred[0];
  if (first === undefined) return undefined;
  const level = levelOrder(renditions).findIndex((r) => r.id === first.id);
  return { level, rendition: first, allowed: preferred.map((r) => r.id) };
}

/**
 * Pear #97: where a play of `video` starts, when its seeders hold different renditions: the hash
 * list read from the first of `origins` (at most `HASH_LIST_ORIGINS`, within
 * `HASH_LIST_TIMEOUT_MS` in all) that serves one that verifies, then `chooseStart`.
 * `undefined` when nothing needs pinning, or no origin served a hash list (the player then reports
 * its own origin problems, and hls.js picks).
 */
export async function startFor(
  fetchFn: FetchFn,
  video: Pick<NfxVideo, 'id' | 'root' | 'segs'>,
  origins: readonly string[],
  held: RenditionAvailability,
  now: () => number = Date.now,
): Promise<StartChoice | undefined> {
  if (!availabilityVaries(held)) return undefined;
  const target = parseATag(video.id);
  if (!target.ok) return undefined;
  const deadline = now() + HASH_LIST_TIMEOUT_MS;
  for (const origin of origins.slice(0, HASH_LIST_ORIGINS)) {
    const left = deadline - now();
    if (left <= 0) break;
    let bytes: Uint8Array;
    try {
      bytes = await getBounded(fetchFn, `${origin}/${video.root}`, {
        maxBytes: MAX_HASH_LIST_BYTES,
        timeoutMs: left,
      });
    } catch {
      continue;
    }
    const list = verifyHashList(bytes, video.root, target.value.addr, BigInt(video.segs));
    if (list.ok) return chooseStart(playRenditions(list.value.renditions), held);
  }
  return undefined;
}
