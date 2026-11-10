/**
 * Which renditions a web play may use (pear #97, the maintainer's decision of 2026-11-09): never
 * one no reachable seeder holds, and the one most of them hold first. nfx's library does the
 * cutting (nfx #83): `open()` takes the allowed renditions, preferred first, and each origin with
 * the renditions it serves (`endpoints.ts`), and its session's levels are the allowed renditions
 * that the origin it plays from serves. hls.js then adapts to bandwidth among those alone.
 *
 * - **Held** comes from core's `nfx.renditionAvailability` over the beacons, counting only what
 *   this page can reach: `https` origins it may fetch from (`beaconOrigin`) that serve something,
 *   and `webrtc` bridges with a tracker it may use (`beaconTracker`). An endpoint without a
 *   `renditions` list holds every rendition.
 * - **When every counted seeder holds every rendition** (the usual case, and every one-rendition
 *   video), no list is passed: the library allows every rendition, and each origin's own list (if
 *   its beacon has one) still cuts what it is asked for.
 * - **Otherwise** the hash list is read from the play's origins (checked against the manifest's
 *   root, as the player checks it), and the held renditions it names are passed in core's
 *   `nfx.preferRenditions` order. Only ids of the verified hash list are passed: the library
 *   refuses an id the hash list lacks, and beacons come from any key.
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

import {
  MAX_CLAIMED_RENDITIONS,
  beaconOrigin,
  beaconTracker,
  type PlayOrigin,
} from './endpoints.js';
import { getBounded, type FetchFn } from './http.js';

/**
 * How long reading the hash list may take, ms, from every origin together: a beacon names the
 * origins, so a stalling one must not hold the play back for long.
 */
export const HASH_LIST_TIMEOUT_MS = 10_000;
/** The most origins asked for the hash list. */
export const HASH_LIST_ORIGINS = 3;
/** The most ids `open()`'s `renditions` takes (nfx's library: `MAX_RENDITIONS`). */
export const MAX_ALLOWED_RENDITIONS = MAX_CLAIMED_RENDITIONS;

/** Whether this page can use endpoint `e` (the rules `beaconEndpoints` applies). */
export function webUsable(e: Endpoint): boolean {
  // An origin whose list is empty serves nothing (NFX-03 §4, and nfx's library skips it).
  if (e.t === 'https') return beaconOrigin(e.url) !== null && e.renditions?.length !== 0;
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

/** One rendition of a hash list, as the preference order needs it. */
export interface PlayRendition {
  readonly id: string;
  /** Bits per second (the master playlist's `BANDWIDTH`). */
  readonly bandwidth: number;
}

/**
 * The renditions a play may use, by id, the preferred first (`preferRenditions`), at most
 * `MAX_ALLOWED_RENDITIONS`: `undefined` when every counted seeder holds every rendition (nothing
 * to restrict) or when none of `renditions` (a verified hash list's) is held.
 */
export function allowedRenditions(
  renditions: readonly PlayRendition[],
  held: RenditionAvailability,
): string[] | undefined {
  if (!availabilityVaries(held)) return undefined;
  const ids = [...new Set(preferRenditions(renditions, held).map((r) => r.id))];
  return ids.length === 0 ? undefined : ids.slice(0, MAX_ALLOWED_RENDITIONS);
}

/** `allowed` with `id` moved first, when it is one of them (a viewer's pick starts the play). */
export function preferring(allowed: readonly string[], id: string): string[] {
  return allowed.includes(id) ? [id, ...allowed.filter((x) => x !== id)] : [...allowed];
}

/** A verified hash list's renditions as `PlayRendition`s (one past 2^53 bit/s is left out). */
function playRenditions(
  list: readonly { readonly id: string; readonly bandwidth: bigint }[],
): PlayRendition[] {
  return list
    .filter((r) => r.bandwidth <= BigInt(Number.MAX_SAFE_INTEGER))
    .map((r) => ({ id: r.id, bandwidth: Number(r.bandwidth) }));
}

/**
 * Pear #97: the renditions a play of `video` may use (`allowedRenditions`), when its seeders hold
 * different ones: the hash list read from the first of `origins` (those serving something, at
 * most `HASH_LIST_ORIGINS`, within `HASH_LIST_TIMEOUT_MS` in all) that serves one that verifies.
 * `undefined` when nothing needs restricting, or no origin served a hash list (the player then
 * reports its own origin problems, and every rendition the origin serves is allowed).
 */
export async function renditionsFor(
  fetchFn: FetchFn,
  video: Pick<NfxVideo, 'id' | 'root' | 'segs'>,
  origins: readonly PlayOrigin[],
  held: RenditionAvailability,
  now: () => number = Date.now,
): Promise<string[] | undefined> {
  if (!availabilityVaries(held)) return undefined;
  const target = parseATag(video.id);
  if (!target.ok) return undefined;
  const deadline = now() + HASH_LIST_TIMEOUT_MS;
  const asked = origins.filter((o) => o.renditions?.length !== 0).slice(0, HASH_LIST_ORIGINS);
  for (const { url } of asked) {
    const left = deadline - now();
    if (left <= 0) break;
    let bytes: Uint8Array;
    try {
      bytes = await getBounded(fetchFn, `${url}/${video.root}`, {
        maxBytes: MAX_HASH_LIST_BYTES,
        timeoutMs: left,
      });
    } catch {
      continue;
    }
    const list = verifyHashList(bytes, video.root, target.value.addr, BigInt(video.segs));
    if (list.ok) return allowedRenditions(playRenditions(list.value.renditions), held);
  }
  return undefined;
}
