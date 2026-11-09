/**
 * Where a play fetches from (ADR 0022 items 3 and 5): the HTTPS origins and WebTorrent trackers
 * that seeders' live beacons name, checked as nfx's player checks them and stricter, then merged
 * with this client's own.
 *
 * - **Which beacons count:** each must pass core's `parseBeacon` (signature, TTL, expiry, the
 *   `a` tag against the content), name this manifest's author and address, and be free (v1 plays
 *   free videos only). Only each seeder's newest beacon counts (NFX-03 §2), so a seeder can
 *   withdraw an endpoint. "Endpoints come from it, trust never does": nfx's player still checks
 *   every byte against the manifest's hash list.
 * - **Origins** (`https` endpoints): `https:` only; no user-info, query or fragment, because the
 *   player appends `/<root>/…` to the base and a query would steer its requests; a public host
 *   (`isPublicHost`). Reduced to `https://host[:port][/prefix]`.
 * - **Trackers** (`webrtc` endpoints' `tracker_urls`): `wss:` only (a beacon never points a viewer
 *   at a `ws:` tracker, loopback or not), the same URL rules, a public host, in the form
 *   `isTrackerUrl` takes.
 * - **Caps:** at most 4 origins and 4 trackers from one beacon, 8 origins in all; each list ranked
 *   by how many seeders name an entry, ties in the order of their beacons, newest first.
 * - **The play:** the beacons' origins, then `WEB_FALLBACK_ORIGIN`; the configured trackers, then
 *   the beacons', 4 in all (contracts v14).
 */
import type { NfxVideo, NostrEvent, TrackerUrl } from '@sovit/core';
import { KIND_MANIFEST, parseBeacon } from '@sovit/core/nfx';

import { WEB_MAX_TRACKERS } from '../settings/defaults.js';
import { MAX_SERVER_URL, isTrackerUrl } from '../settings/validate.js';
import { isPublicHost, parseStrictUrl } from './hosts.js';

/** At most this many origins from beacons (nfx's player reports 8). */
export const MAX_BEACON_ORIGINS = 8;
/** At most this many origins, and this many trackers, from one beacon. */
export const PER_BEACON = 4;

/** A beacon's origin as `https://host[:port][/prefix]`, or `null` when it may not be used. */
export function beaconOrigin(raw: string): string | null {
  const u = parseStrictUrl(raw, MAX_SERVER_URL);
  if (u?.protocol !== 'https:' || raw.includes('?') || raw.includes('#')) return null;
  if (!isPublicHost(u.hostname)) return null;
  const base = u.origin + u.pathname.replace(/\/+$/, '');
  return base.length <= MAX_SERVER_URL ? base : null;
}

/** A beacon's tracker as `wss://host[:port][/path]`, or `null` when it may not be used. */
export function beaconTracker(raw: string): TrackerUrl | null {
  const u = parseStrictUrl(raw, MAX_SERVER_URL);
  if (u?.protocol !== 'wss:' || raw.includes('?') || raw.includes('#')) return null;
  if (!isPublicHost(u.hostname)) return null;
  const t = `wss://${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  return isTrackerUrl(t) ? t : null;
}

/** What the live beacons of one video name, for this client. */
export interface BeaconEndpoints {
  /** Origins, most-named first, at most `MAX_BEACON_ORIGINS`. */
  readonly origins: readonly string[];
  /** Trackers, most-named first, at most `WEB_MAX_TRACKERS`. */
  readonly trackers: readonly TrackerUrl[];
  /** Seeders with a valid, free beacon for this video, whatever they name. */
  readonly seeders: number;
  /** Of those, the ones naming an origin or a tracker this client can use. */
  readonly reachable: number;
}

/** Most-named first; `Array.prototype.sort` is stable, so ties keep first-seen order. */
function ranked<T>(counts: ReadonlyMap<T, number>): T[] {
  return [...counts].sort((x, y) => y[1] - x[1]).map(([v]) => v);
}

/** The endpoints `events` (beacons, any order) name for `video` at `now` (unix seconds). */
export function beaconEndpoints(
  video: Pick<NfxVideo, 'id' | 'author'>,
  events: readonly NostrEvent[],
  now: number,
): BeaconEndpoints {
  const newestFirst = [...events].sort((a, b) => b.created_at - a.created_at);
  const seeders = new Set<string>();
  const origins = new Map<string, number>();
  const trackers = new Map<TrackerUrl, number>();
  let free = 0;
  let reachable = 0;
  for (const ev of newestFirst) {
    const parsed = parseBeacon(ev, now);
    if (!parsed.ok) continue;
    const b = parsed.value;
    // A seeder's newest valid beacon is the only one that counts, whatever it names.
    if (seeders.has(b.seeder)) continue;
    seeders.add(b.seeder);
    const address = `${String(KIND_MANIFEST)}:${b.creator}:${b.content.video.toString()}`;
    if (b.creator !== video.author || address !== video.id || !b.content.free) continue;
    free += 1;
    const own = { origins: [] as string[], trackers: [] as TrackerUrl[] };
    for (const e of b.content.endpoints) {
      if (e.t === 'https') {
        const o = beaconOrigin(e.url);
        if (o !== null && !own.origins.includes(o) && own.origins.length < PER_BEACON) {
          own.origins.push(o);
        }
      } else if (e.t === 'webrtc') {
        for (const raw of e.trackerUrls) {
          const t = beaconTracker(raw);
          if (t !== null && !own.trackers.includes(t) && own.trackers.length < PER_BEACON) {
            own.trackers.push(t);
          }
        }
      }
    }
    if (own.origins.length + own.trackers.length > 0) reachable += 1;
    for (const o of own.origins) origins.set(o, (origins.get(o) ?? 0) + 1);
    for (const t of own.trackers) trackers.set(t, (trackers.get(t) ?? 0) + 1);
  }
  return {
    origins: ranked(origins).slice(0, MAX_BEACON_ORIGINS),
    trackers: ranked(trackers).slice(0, WEB_MAX_TRACKERS),
    seeders: free,
    reachable,
  };
}

/** What one play hands nfx's player. */
export interface PlayEndpoints {
  readonly origins: readonly string[];
  readonly trackers: readonly TrackerUrl[];
}

/**
 * The beacons' origins, then `fallbackOrigin`; `configured` trackers (Settings), then the
 * beacons', at most `WEB_MAX_TRACKERS` in all. Duplicates are dropped.
 */
export function playEndpoints(
  beacons: Pick<BeaconEndpoints, 'origins' | 'trackers'>,
  configured: readonly TrackerUrl[],
  fallbackOrigin: string,
): PlayEndpoints {
  const origins = [...new Set([...beacons.origins, fallbackOrigin])];
  const trackers = [...new Set([...configured, ...beacons.trackers])].slice(0, WEB_MAX_TRACKERS);
  return { origins, trackers };
}
