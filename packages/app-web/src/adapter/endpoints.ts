/**
 * Where a play fetches from (ADR 0022 items 3 and 5): the HTTPS origins that seeders' live
 * beacons name, checked as nfx's player checks them and stricter, then merged with this client's
 * own. Peers are found over Nostr (NFX-10 §6, pear #89), by room: a beacon carries nothing for
 * that, and the trackers one may still name (`webrtc` endpoints) are not read.
 *
 * - **Which beacons count:** each must pass core's `parseBeacon` (signature, TTL, expiry, the
 *   `a` tag against the content), name this manifest's author and address, and be free (v1 plays
 *   free videos only). Only each seeder's newest beacon counts (NFX-03 §2), so a seeder can
 *   withdraw an endpoint. "Endpoints come from it, trust never does": nfx's player still checks
 *   every byte against the manifest's hash list.
 * - **Origins** (`https` endpoints): `https:` only; no user-info, query or fragment, because the
 *   player appends `/<root>/…` to the base and a query would steer its requests; a public host
 *   (`isPublicHost`). Reduced to `https://host[:port][/prefix]`.
 * - **What an origin serves** (NFX-03 §4, pear #97): its endpoint's `renditions`, absent meaning
 *   every rendition (core rejects a beacon whose list is empty, pear #104). When several seeders
 *   (or one beacon twice) name one origin, it serves only what every claim says, as nfx's library
 *   reads them (`Endpoints.originSources`): a beacon can narrow what an origin is taken to serve,
 *   never widen it, so the worst a lying beacon does is have the player skip that origin, rather
 *   than offer a level whose files it answers with `404`. An origin left serving nothing (claims
 *   that share no id) counts for no seeder's reach.
 * - **Caps:** at most 4 origins from one beacon, 8 in all, ranked by how many seeders name an
 *   entry, ties in the order of their beacons, newest first.
 * - **The play:** the beacons' origins, then `WEB_FALLBACK_ORIGIN`. The fallback origin serves
 *   every rendition unless a beacon names it, and then what its beacons say.
 */
import type { NfxVideo, NostrEvent } from '@sovit/core';
import { KIND_MANIFEST, MAX_RENDITION_ID_LENGTH, parseBeacon } from '@sovit/core/nfx';

import { MAX_SERVER_URL } from '../settings/validate.js';
import { isPublicHost, parseStrictUrl } from './hosts.js';

/** At most this many origins from beacons (nfx's player reports 8). */
export const MAX_BEACON_ORIGINS = 8;
/** At most this many origins from one beacon. */
export const PER_BEACON = 4;
/** The most rendition ids one claim keeps (nfx's library: `MAX_RENDITIONS`). */
export const MAX_CLAIMED_RENDITIONS = 32;

/**
 * An origin a play may fetch from, and the renditions it serves (nfx's `OriginSource`): absent,
 * every rendition; an empty list, none.
 */
export interface PlayOrigin {
  readonly url: string;
  readonly renditions?: readonly string[];
  /**
   * Where it ranks among the session's sources (NFX-17 §4.2, the library's `OriginSource.tier`):
   * 1, named by the video creator's own beacon; 3, by any other seeder's (an open source); 4,
   * this site's own fallback, the last resort. How many seeders name an origin never ranks it.
   * Absent: 4.
   */
  readonly tier?: 1 | 3 | 4;
}

/** A beacon's origin as `https://host[:port][/prefix]`, or `null` when it may not be used. */
export function beaconOrigin(raw: string): string | null {
  const u = parseStrictUrl(raw, MAX_SERVER_URL);
  if (u?.protocol !== 'https:' || raw.includes('?') || raw.includes('#')) return null;
  if (!isPublicHost(u.hostname)) return null;
  const base = u.origin + u.pathname.replace(/\/+$/, '');
  return base.length <= MAX_SERVER_URL ? base : null;
}

/**
 * What an `https` endpoint's `renditions` says its origin serves: `null` for every rendition
 * (absent), else its ids of at most `MAX_RENDITION_ID_LENGTH` characters, each once, the first
 * `MAX_CLAIMED_RENDITIONS` (core's parser has already refused `''`, `meta`, a repeat and an empty
 * list). Empty (every id too long): none.
 */
export function originClaim(renditions: readonly string[] | undefined): string[] | null {
  if (renditions === undefined) return null;
  const out: string[] = [];
  for (const id of renditions) {
    if (out.length >= MAX_CLAIMED_RENDITIONS) break;
    if (id.length <= MAX_RENDITION_ID_LENGTH && !out.includes(id)) out.push(id);
  }
  return out;
}

/** What two claims about one origin leave: only what both say it serves (`null`: every one). */
export function narrowClaim(
  a: readonly string[] | null,
  b: readonly string[] | null,
): string[] | null {
  if (a === null) return b === null ? null : [...b];
  return b === null ? [...a] : a.filter((id) => b.includes(id));
}

/** `url` with `claim` as a `PlayOrigin`. */
function playOrigin(url: string, claim: readonly string[] | null, tier: 1 | 3 | 4): PlayOrigin {
  return claim === null ? { url, tier } : { url, renditions: claim, tier };
}

/** What the live beacons of one video name, for this client. */
export interface BeaconEndpoints {
  /** Origins with what they serve, most-named first, at most `MAX_BEACON_ORIGINS`. */
  readonly origins: readonly PlayOrigin[];
  /** Seeders with a valid, free beacon for this video, whatever they name. */
  readonly seeders: number;
  /** Of those, the ones naming an origin this client can use. */
  readonly reachable: number;
}

/** The endpoints `events` (beacons, any order) name for `video` at `now` (unix seconds). */
export function beaconEndpoints(
  video: Pick<NfxVideo, 'id' | 'author'>,
  events: readonly NostrEvent[],
  now: number,
): BeaconEndpoints {
  const newestFirst = [...events].sort((a, b) => b.created_at - a.created_at);
  const seeders = new Set<string>();
  const origins = new Map<string, { claim: string[] | null; tier: 1 | 3 }>();
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
    const own = { origins: new Map<string, string[] | null>() };
    for (const e of b.content.endpoints) {
      if (e.t === 'https') {
        const o = beaconOrigin(e.url);
        if (o === null) continue;
        const claim = originClaim(e.renditions);
        const named = own.origins.get(o);
        // One beacon naming an origin twice narrows it too.
        if (named !== undefined) own.origins.set(o, narrowClaim(named, claim));
        else if (own.origins.size < PER_BEACON) own.origins.set(o, claim);
      }
    }
    const serving = [...own.origins.values()].filter((c) => c === null || c.length > 0);
    if (serving.length > 0) reachable += 1;
    // The creator's own beacon names tier 1 origins; any other seeder's, open ones (NFX-17 §4.2).
    // An origin takes the best tier that names it, and the claims of that tier.
    const tier: 1 | 3 = b.seeder === video.author ? 1 : 3;
    for (const [o, claim] of own.origins) {
      const c = origins.get(o);
      if (c === undefined || tier < c.tier) origins.set(o, { claim, tier });
      else if (tier === c.tier) origins.set(o, { claim: narrowClaim(c.claim, claim), tier });
    }
  }
  // By tier, never by how many seeders name an origin: keys are free (NFX-17 §4.2). The library
  // orders open sources itself. `Array.prototype.sort` is stable: ties keep first-seen order.
  const rankedOrigins = [...origins].sort((x, y) => x[1].tier - y[1].tier);
  return {
    origins: rankedOrigins
      .slice(0, MAX_BEACON_ORIGINS)
      .map(([url, { claim, tier }]) => playOrigin(url, claim, tier)),
    seeders: free,
    reachable,
  };
}

/**
 * The origins one play hands nfx's player: the beacons', then `fallbackOrigin` (every rendition,
 * unless a beacon names it: then its place and what the beacons say it serves). Duplicates are
 * dropped.
 */
export function playOrigins(
  beacons: Pick<BeaconEndpoints, 'origins'>,
  fallbackOrigin: string,
): PlayOrigin[] {
  const origins: PlayOrigin[] = [];
  // This site's own origin is configured, not named by a beacon: the last resort (tier 4).
  for (const o of [...beacons.origins, { url: fallbackOrigin, tier: 4 as const }]) {
    if (!origins.some((x) => x.url === o.url)) origins.push(o);
  }
  return origins;
}
