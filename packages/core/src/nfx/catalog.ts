/**
 * NFX manifests → listings (ADR 0020 Phase 1, contracts v9). Pure: callers pass verified events
 * and `now`; the queries live in `nostr/nfx-feeds.ts`.
 *
 * What a listing shows of a network (NFX-02 §4, §6): the current revision of each address, not
 * withdrawn by a deletion of its author's, and in Phase 1 only a free one (`license open`, no
 * price hint).
 */
import type {
  NfxAddress,
  NfxVideo,
  NostrEvent,
  NostrEventId,
  Sha256Hex,
  UnixSeconds,
} from '../contracts/index.js';
import { type Deletion, deletionDeletes, parseDeletion } from './deletion.js';
import { KIND_MANIFEST, MAX_CLOCK_SKEW, tagValues } from './event.js';
import { manifestATag, parseManifest, type Manifest } from './manifest.js';

/** A manifest together with the verified event it came from. */
export interface ManifestEvent {
  readonly manifest: Manifest;
  readonly event: NostrEvent;
}

/**
 * The manifests among `events` that parse (NFX-02 §4) and are in `namespace`, in input order.
 * Every other event is dropped whole.
 */
export function manifestsIn(namespace: string, events: readonly NostrEvent[]): ManifestEvent[] {
  const out: ManifestEvent[] = [];
  for (const event of events) {
    if (event.kind !== KIND_MANIFEST) continue;
    const parsed = parseManifest(event);
    if (!parsed.ok || parsed.value.addr.namespace.toString() !== namespace) continue;
    out.push({ manifest: parsed.value, event });
  }
  return out;
}

/** Newest first; ties by the lower id first (the NIP-01 addressable order, NFX-02 §4). */
function newerFirst(a: ManifestEvent, b: ManifestEvent): number {
  const byTime = b.event.created_at - a.event.created_at;
  if (byTime !== 0) return byTime;
  return a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0;
}

/**
 * The current revision of each address (NFX-02 §4 "Revisions"): the highest `created_at`, ties
 * to the lowest id. A revision more than `MAX_CLOCK_SKEW` ahead of `now` is ignored, or it would
 * outrank every honest one until real time caught up. Result: newest first.
 */
export function currentRevisions(
  manifests: readonly ManifestEvent[],
  now: UnixSeconds,
): ManifestEvent[] {
  const best = new Map<string, ManifestEvent>();
  for (const m of manifests) {
    if (m.event.created_at > now + MAX_CLOCK_SKEW) continue;
    const key = manifestATag(m.manifest);
    const held = best.get(key);
    if (held === undefined || newerFirst(m, held) < 0) best.set(key, m);
  }
  return [...best.values()].sort(newerFirst);
}

/** The valid NFX deletions (NFX-02 §6) among `events`. */
export function deletionsIn(events: readonly NostrEvent[]): Deletion[] {
  const out: Deletion[] = [];
  for (const event of events) {
    const parsed = parseDeletion(event);
    if (parsed.ok) out.push(parsed.value);
  }
  return out;
}

/**
 * `manifests` less those a deletion withdraws: by the same author, naming the address, at least
 * as new as the revision (NFX-02 §6). Pass current revisions: a later revision republishes.
 */
export function withoutDeleted(
  manifests: readonly ManifestEvent[],
  deletions: readonly Deletion[],
): ManifestEvent[] {
  return manifests.filter((m) => !deletions.some((d) => deletionDeletes(d, m.manifest)));
}

/** Phase 1 lists free videos only: `license open`, and no price hint above 0 (ADR 0020). */
export function isListable(manifest: Manifest): boolean {
  return (
    manifest.license.mode === 'open' &&
    (manifest.priceHint === undefined || manifest.priceHint === 0n)
  );
}

/** A u64 from a manifest as a JS number, or `undefined` past `Number.MAX_SAFE_INTEGER`. */
function safeNumber(value: bigint): number | undefined {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

/**
 * The `NfxVideo` a listing shows, or `null` when it cannot be one: not listable, or a number
 * beyond what a listing can hold exactly (`published_at`, `segs`, `duration`). `legacyId` is
 * the event's one `e` tag when it is a 64-hex id; the catalog trusts it only from the same author.
 */
export function toNfxVideo(m: ManifestEvent): NfxVideo | null {
  const { manifest, event } = m;
  if (!isListable(manifest)) return null;
  const publishedAt = safeNumber(manifest.publishedAt);
  const segs = safeNumber(manifest.segs);
  const duration = manifest.duration === undefined ? undefined : safeNumber(manifest.duration);
  if (publishedAt === undefined || segs === undefined) return null;
  if (manifest.duration !== undefined && duration === undefined) return null;
  const links = tagValues(event, 'e');
  const link = links.length === 1 ? links[0]?.[0] : undefined;
  const legacyId = link !== undefined && /^[0-9a-f]{64}$/.test(link) ? link : undefined;
  return {
    kind: KIND_MANIFEST,
    id: manifestATag(manifest) as NfxAddress,
    eventId: event.id,
    // `parseManifest` takes the author from the event; the event's field carries the brand.
    author: event.pubkey,
    title: manifest.title,
    description: manifest.description,
    publishedAt: publishedAt as UnixSeconds,
    ...(duration === undefined ? {} : { durationSec: duration }),
    tags: manifest.hashtags,
    namespace: manifest.addr.namespace.toString(),
    root: manifest.root as Sha256Hex,
    segs,
    ...(manifest.thumb === undefined
      ? {}
      : { thumb: { sha256: manifest.thumb.sha256 as Sha256Hex, mime: manifest.thumb.mime } }),
    ...(legacyId === undefined ? {} : { legacyId: legacyId as NostrEventId }),
    event,
  };
}

/**
 * What a listing shows of `events` and `deletionEvents`: the current, undeleted, free revisions in
 * `namespace`, newest first (NFX-02 §4 and §6, ADR 0020).
 */
export function listNfxVideos(
  namespace: string,
  events: readonly NostrEvent[],
  deletionEvents: readonly NostrEvent[],
  now: UnixSeconds,
): NfxVideo[] {
  const current = currentRevisions(manifestsIn(namespace, events), now);
  const live = withoutDeleted(current, deletionsIn(deletionEvents));
  return live.flatMap((m) => {
    const v = toNfxVideo(m);
    return v === null ? [] : [v];
  });
}
