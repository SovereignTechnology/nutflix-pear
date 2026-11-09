/**
 * Which renditions a video's live beacons say are held, and by how many seeders (pear #97, the
 * maintainer's decision of 2026-11-09): a player never picks a rendition that no reachable seeder
 * holds, and among those the bandwidth allows, prefers the one most seeders hold.
 *
 * What a beacon endpoint holds (NFX-03 §4):
 *
 * - `iroh` (NFX-06 §2): the renditions it has a ticket for. Without a `meta` ticket nothing can be
 *   fetched from it, so it holds none.
 * - `https` (NFX-05 §6): its optional `renditions` (nfx, `nfxd --renditions`); absent or empty
 *   means every rendition.
 * - `webrtc` (NFX-10 §2): its `renditions`; absent or empty means every rendition.
 * - `hyperdht` (NFX-12): files by sha256 from a seeder that keeps whole videos, so every
 *   rendition.
 * - `hyper` (deprecated, never dialled) and unknown endpoints: none.
 *
 * Only each seeder's newest valid beacon counts (NFX-03 §2), as the play paths read them, and only
 * a free beacon for this manifest's author and address. A seeder holds the union of what its
 * endpoints hold, restricted to the transports and endpoints the caller can use. Everything is
 * bounded: the newest `MAX_AVAILABILITY_EVENTS` events, `MAX_AVAILABILITY_SEEDERS` seeders and
 * `MAX_AVAILABILITY_RENDITIONS` named rendition ids (a beacon is untrusted data).
 */
import type { NfxVideo, NostrEvent } from '../contracts/index.js';
import { parseBeacon, type Endpoint } from './beacon.js';
import { KIND_MANIFEST } from './event.js';
import { RESERVED_RENDITION_ID } from './hashlist.js';

/** The beacons considered, newest first. */
export const MAX_AVAILABILITY_EVENTS = 512;
/** The seeders counted. */
export const MAX_AVAILABILITY_SEEDERS = 64;
/** The distinct rendition ids counted; ids past it are ignored. */
export const MAX_AVAILABILITY_RENDITIONS = 32;
/** The longest rendition id counted (a hash list's ids are labels like `720p`). */
export const MAX_RENDITION_ID_LENGTH = 64;

/** The transports an endpoint type belongs to. */
export type NfxTransport = 'iroh' | 'https' | 'webrtc' | 'hyperdht';

export interface RenditionAvailability {
  /** Seeders counted: a newest, free beacon for this video that names a usable endpoint. */
  readonly seeders: number;
  /** Of those, the ones holding every rendition. */
  readonly all: number;
  /** Rendition id → seeders that hold it by name (the `all` ones not included). */
  readonly named: ReadonlyMap<string, number>;
}

export interface AvailabilityOptions {
  /** The transports this player speaks; absent = all four. */
  readonly transports?: readonly NfxTransport[];
  /** Whether this player can use `e` (say, an origin it may fetch from); absent = every one. */
  readonly usable?: (e: Endpoint) => boolean;
}

/** How many reachable seeders hold rendition `id`. */
export function holders(a: RenditionAvailability, id: string): number {
  return a.all + (a.named.get(id) ?? 0);
}

/** What one endpoint holds: every rendition, these ids, or nothing. */
function held(e: Endpoint): 'all' | readonly string[] {
  switch (e.t) {
    case 'iroh':
      return e.tickets.has(RESERVED_RENDITION_ID)
        ? [...e.tickets.keys()].filter((k) => k !== RESERVED_RENDITION_ID)
        : [];
    case 'https':
      return e.renditions === undefined || e.renditions.length === 0 ? 'all' : e.renditions;
    case 'webrtc':
      return e.renditions.length === 0 ? 'all' : e.renditions;
    case 'hyperdht':
      return 'all';
    case 'hyper':
      return [];
  }
}

function isRenditionId(id: string): boolean {
  return id !== '' && id !== RESERVED_RENDITION_ID && id.length <= MAX_RENDITION_ID_LENGTH;
}

/** What one seeder holds: every rendition, or these rendition ids. */
export type SeederHolds = 'all' | Iterable<string>;

/**
 * Counts what each seeder holds (one entry per seeder, at most `MAX_AVAILABILITY_SEEDERS` read):
 * a seeder holding nothing (no valid id) is not counted; ids past `MAX_AVAILABILITY_RENDITIONS`
 * distinct ones are ignored.
 */
export function countHolders(seeders: Iterable<SeederHolds>): RenditionAvailability {
  const named = new Map<string, number>();
  let counted = 0;
  let all = 0;
  for (const holds of seeders) {
    if (counted >= MAX_AVAILABILITY_SEEDERS) break;
    if (holds === 'all') {
      counted += 1;
      all += 1;
      continue;
    }
    const ids = new Set<string>();
    for (const id of holds) if (isRenditionId(id)) ids.add(id);
    if (ids.size === 0) continue;
    counted += 1;
    for (const id of ids) {
      const n = named.get(id);
      if (n !== undefined) named.set(id, n + 1);
      else if (named.size < MAX_AVAILABILITY_RENDITIONS) named.set(id, 1);
    }
  }
  return { seeders: counted, all, named };
}

/**
 * Per-rendition availability of `video` from its beacons `events` (any order) at `now` (unix
 * seconds). See the module comment for what counts.
 */
export function renditionAvailability(
  video: Pick<NfxVideo, 'id' | 'author'>,
  events: readonly NostrEvent[],
  now: number,
  opts: AvailabilityOptions = {},
): RenditionAvailability {
  const transports = new Set<string>(opts.transports ?? ['iroh', 'https', 'webrtc', 'hyperdht']);
  const newestFirst = [...events]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, MAX_AVAILABILITY_EVENTS);
  const seen = new Set<string>();
  const perSeeder: SeederHolds[] = [];
  for (const ev of newestFirst) {
    if (perSeeder.length >= MAX_AVAILABILITY_SEEDERS) break;
    const parsed = parseBeacon(ev, now);
    if (!parsed.ok) continue;
    const b = parsed.value;
    // A seeder's newest valid beacon is the only one that counts, whatever it names.
    if (seen.has(b.seeder)) continue;
    seen.add(b.seeder);
    const address = `${String(KIND_MANIFEST)}:${b.creator}:${b.content.video.toString()}`;
    if (b.creator !== video.author || address !== video.id || !b.content.free) continue;
    let every = false;
    const ids = new Set<string>();
    for (const e of b.content.endpoints) {
      if (!transports.has(e.t) || (opts.usable !== undefined && !opts.usable(e))) continue;
      const h = held(e);
      if (h === 'all') every = true;
      else for (const id of h) if (isRenditionId(id)) ids.add(id);
    }
    if (every) perSeeder.push('all');
    else if (ids.size > 0) perSeeder.push(ids);
  }
  return countHolders(perSeeder);
}

/**
 * `renditions` (a hash list's, with `bandwidth` in bits per second) in the order a player should
 * try them, leaving out every one no counted seeder holds: those within `maxBandwidth` first (all
 * of them when it is absent), the one most seeders hold first and, at equal holders, the higher
 * bandwidth first; then the held ones above `maxBandwidth`, the lowest bandwidth first.
 */
export function preferRenditions<R extends { readonly id: string; readonly bandwidth: number }>(
  renditions: readonly R[],
  availability: RenditionAvailability,
  opts: { readonly maxBandwidth?: number } = {},
): R[] {
  const max = opts.maxBandwidth ?? Infinity;
  const heldOnes = renditions.filter((r) => holders(availability, r.id) > 0);
  const fits = heldOnes
    .filter((r) => r.bandwidth <= max)
    .sort(
      (a, b) =>
        holders(availability, b.id) - holders(availability, a.id) || b.bandwidth - a.bandwidth,
    );
  const over = heldOnes.filter((r) => r.bandwidth > max).sort((a, b) => a.bandwidth - b.bandwidth);
  return [...fits, ...over];
}

/** Whether the counted seeders hold different sets: some rendition is held by fewer than all. */
export function availabilityVaries(a: RenditionAvailability): boolean {
  return a.named.size > 0;
}
