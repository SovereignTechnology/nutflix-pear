/**
 * NFX catalog reads (ADR 0020 Phase 1, contracts v9; NFX-04 §5 query patterns). Every item is an
 * `NfxVideo` from `nfx.listNfxVideos`: the current, undeleted, free revision of a manifest in
 * the namespace, from events that passed the client's verification boundary.
 *
 * Deletions (NFX-02 §6) are fetched for exactly the addresses a page shows, from the same relays,
 * in one query; a manifest is listed only after its deletions were asked for.
 */
import type {
  NfxAddress,
  NfxVideo,
  NostrEvent,
  NostrEventId,
  NostrFilter,
  NostrPubkey,
  Page,
  RelayUrl,
  SearchFilters,
} from '../contracts/index.js';
import { parseATag } from '../nfx/beacon.js';
import { listNfxVideos } from '../nfx/catalog.js';
import { KIND_DELETION, KIND_MANIFEST } from '../nfx/event.js';
import type { NostrClient } from './client.js';
import { applyTimeCursor, decodeTimeCursor, encodeTimeCursor } from './cursor.js';
import { DEFAULT_PAGE, MAX_PAGE, type FeedOptions } from './feeds.js';

const clampLimit = (n: number | undefined): number =>
  Math.min(MAX_PAGE, Math.max(1, n ?? DEFAULT_PAGE));

/** Where a read goes: the client's read relays by default (NFX-04 §4: public relays first). */
export interface NfxReadOptions extends FeedOptions {
  readonly relays?: readonly RelayUrl[] | undefined;
}

/**
 * The deletions that may withdraw `manifests`: kind 5 by their authors naming their addresses.
 * `parseDeletion` (inside `listNfxVideos`) then keeps only the valid, own-address ones.
 */
async function deletionsFor(
  client: NostrClient,
  manifests: readonly { readonly event: NostrEvent; readonly address: string }[],
  relays: readonly RelayUrl[] | undefined,
): Promise<NostrEvent[]> {
  if (manifests.length === 0) return [];
  const authors = [...new Set(manifests.map((m) => m.event.pubkey))];
  const addresses = [...new Set(manifests.map((m) => m.address))];
  return client.query({ kinds: [KIND_DELETION], authors, '#a': addresses }, relays);
}

/**
 * `38504:<pubkey>:<d>` of a manifest event in `namespace`, from its `d` tag. Only the parser
 * validates it; this bounds what a relay's answer can put into the deletion query (a `d` in the
 * namespace, no longer than a video id can make it).
 */
function addressOf(event: NostrEvent, namespace: string): string | undefined {
  const d = event.tags.find((t) => t[0] === 'd')?.[1];
  if (d === undefined || !d.startsWith(`${namespace}:`) || d.length > namespace.length + 64) {
    return undefined;
  }
  return `${KIND_MANIFEST}:${event.pubkey}:${d}`;
}

/** Events → the listed videos, after one deletion query for their addresses. */
async function listed(
  client: NostrClient,
  namespace: string,
  events: readonly NostrEvent[],
  relays: readonly RelayUrl[] | undefined,
): Promise<NfxVideo[]> {
  const addressed = events.flatMap((event) => {
    const address = addressOf(event, namespace);
    return address === undefined ? [] : [{ event, address }];
  });
  const deletions = await deletionsFor(client, addressed, relays);
  return listNfxVideos(namespace, events, deletions, client.now());
}

/**
 * One page of NFX videos in `namespace` matching `base` (`authors`, `#t`, `search`, `since`,
 * `until`), newest revision first, with the time cursor `videoPage` uses, so a NIP-71 page and an
 * NFX page can share one cursor. `keep` filters further (search's duration limits).
 */
export async function nfxVideoPage(
  client: NostrClient,
  namespace: string,
  base: NostrFilter,
  opts: NfxReadOptions = {},
  keep: (v: NfxVideo) => boolean = () => true,
): Promise<Page<NfxVideo>> {
  const limit = clampLimit(opts.limit);
  const cursor = decodeTimeCursor(opts.cursor);
  const applied = applyTimeCursor(
    { ...base, kinds: [KIND_MANIFEST], '#n': [namespace], limit: limit + 5 },
    cursor,
  );
  const events = (await client.query(applied.filter, opts.relays)).filter(applied.keep);
  const videos = (await listed(client, namespace, events, opts.relays)).filter(keep);
  const items = videos.slice(0, limit);
  const next = items.length === limit ? encodeTimeCursor(items.map((v) => v.event)) : undefined;
  return next === undefined ? { items } : { items, next };
}

export function nfxAuthorsFeed(
  client: NostrClient,
  namespace: string,
  authors: readonly NostrPubkey[],
  opts: NfxReadOptions = {},
): Promise<Page<NfxVideo>> {
  if (authors.length === 0) return Promise.resolve({ items: [] });
  return nfxVideoPage(client, namespace, { authors }, opts);
}

export function nfxTagsFeed(
  client: NostrClient,
  namespace: string,
  tags: readonly string[],
  opts: NfxReadOptions = {},
): Promise<Page<NfxVideo>> {
  const t = tags.map((s) => s.trim().toLowerCase()).filter((s) => s !== '');
  if (t.length === 0) return Promise.resolve({ items: [] });
  return nfxVideoPage(client, namespace, { '#t': t }, opts);
}

/** A search's relay-side filter fields other than `search` itself. */
function searchBase(filters: SearchFilters): NostrFilter {
  return {
    ...(filters.since === undefined ? {} : { since: filters.since }),
    ...(filters.until === undefined ? {} : { until: filters.until }),
    ...(filters.author === undefined ? {} : { authors: [filters.author] }),
    ...(filters.tags && filters.tags.length > 0 ? { '#t': filters.tags } : {}),
  };
}

/** A search's duration limits, which no relay filters on. */
function withinDuration(filters: SearchFilters): (v: NfxVideo) => boolean {
  const min = filters.minDurationSec;
  const max = filters.maxDurationSec;
  return (v) => {
    if (min === undefined && max === undefined) return true;
    if (v.durationSec === undefined) return false;
    return (
      (min === undefined || v.durationSec >= min) && (max === undefined || v.durationSec <= max)
    );
  };
}

/** NIP-50 search over a namespace's manifests, with the same filters as `searchVideos`. */
export function searchNfxVideos(
  client: NostrClient,
  namespace: string,
  text: string,
  filters: SearchFilters = {},
  opts: NfxReadOptions = {},
): Promise<Page<NfxVideo>> {
  const q = text.trim();
  if (q === '') return Promise.resolve({ items: [] });
  return nfxVideoPage(
    client,
    namespace,
    { search: q, ...searchBase(filters) },
    opts,
    withinDuration(filters),
  );
}

/**
 * Whether `video` matches search `text` here, for a relay that does not search: every word of it
 * (split on white space, case-insensitive) appears in the title, the description or a `t` tag.
 */
export function nfxVideoMatchesText(video: NfxVideo, text: string): boolean {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  if (words.length === 0) return false;
  const hay = [video.title, video.description, ...video.tags].join('\n').toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** How many manifests one page of a client-side search reads from a relay that does not search. */
export const NFX_SCAN_PAGE = MAX_PAGE;

/**
 * Search on relays that do not answer NIP-50 (ADR 0022): a plain query for the namespace's
 * manifests (`kinds: [38504], #n`, with the search's other filters), matched here on title,
 * description and tags (`nfxVideoMatchesText`). `search` is never sent to them: a stock relay
 * may refuse an unknown field, or ignore it and return whatever matches the rest. One page reads
 * at most `NFX_SCAN_PAGE` manifests; when it found fewer matches than `limit` but read a full
 * page, the cursor continues from the oldest manifest read, so older matches are still reached.
 */
export async function scanNfxVideos(
  client: NostrClient,
  namespace: string,
  text: string,
  filters: SearchFilters = {},
  opts: NfxReadOptions = {},
): Promise<Page<NfxVideo>> {
  const q = text.trim();
  if (q === '') return { items: [] };
  const limit = clampLimit(opts.limit);
  const applied = applyTimeCursor(
    { ...searchBase(filters), kinds: [KIND_MANIFEST], '#n': [namespace], limit: NFX_SCAN_PAGE },
    decodeTimeCursor(opts.cursor),
  );
  const read = await client.query(applied.filter, opts.relays);
  const events = read.filter(applied.keep);
  const inRange = withinDuration(filters);
  const videos = (await listed(client, namespace, events, opts.relays)).filter(
    (v) => inRange(v) && nfxVideoMatchesText(v, q),
  );
  const items = videos.slice(0, limit);
  const next =
    items.length === limit
      ? encodeTimeCursor(items.map((v) => v.event))
      : read.length >= NFX_SCAN_PAGE
        ? encodeTimeCursor(events)
        : undefined;
  return next === undefined ? { items } : { items, next };
}

/**
 * Search routed by what each relay supports (ADR 0022): `search` goes only to the relays whose
 * NIP-11 document lists NIP-50 (`supports`), the others are read with `scanNfxVideos`, and the
 * two are merged by address, the newest revision winning. It fails only when every relay set
 * does. `opts.relays` absent means the client's read relays.
 */
export async function searchNfxVideosRouted(
  client: NostrClient,
  namespace: string,
  text: string,
  filters: SearchFilters,
  opts: NfxReadOptions & { readonly supports: (relay: RelayUrl) => Promise<boolean> },
): Promise<Page<NfxVideo>> {
  if (text.trim() === '') return { items: [] };
  const relays = opts.relays ?? client.readRelays;
  if (relays.length === 0) return { items: [] };
  const flags = await Promise.all(relays.map((r) => opts.supports(r).catch(() => false)));
  const nip50 = relays.filter((_, i) => flags[i] === true);
  const plain = relays.filter((_, i) => flags[i] !== true);
  const page = { limit: opts.limit, cursor: opts.cursor };
  const settled = await Promise.allSettled([
    ...(nip50.length > 0
      ? [searchNfxVideos(client, namespace, text, filters, { ...page, relays: nip50 })]
      : []),
    ...(plain.length > 0
      ? [scanNfxVideos(client, namespace, text, filters, { ...page, relays: plain })]
      : []),
  ]);
  const pages = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
  const failed = settled.find((s) => s.status === 'rejected');
  if (pages.length === 0 && failed !== undefined) throw failed.reason;
  const newest = new Map<string, NfxVideo>();
  for (const v of pages.flatMap((p) => p.items)) {
    const seen = newest.get(v.id);
    if (seen === undefined || v.event.created_at > seen.event.created_at) newest.set(v.id, v);
  }
  const items = [...newest.values()]
    .sort((a, b) => b.event.created_at - a.event.created_at)
    .slice(0, clampLimit(opts.limit));
  const more = pages.map((p) => p.next).filter((n): n is string => n !== undefined);
  const next =
    more.length === 0 ? undefined : (encodeTimeCursor(items.map((v) => v.event)) ?? more[0]);
  return next === undefined ? { items } : { items, next };
}

/** The most NIP-71 events one `nfxTwinsOf` call asks about (a page's worth). */
export const MAX_TWIN_LOOKUP = MAX_PAGE;

/**
 * The listed NFX copies of NIP-71 videos (ADR 0020 slice 5d-4): manifests in `namespace` whose one
 * `e` names an event of `legacy` and whose author is that event's author (a link from anyone else
 * is not a twin). One query, `#e` and `authors` bounded by `legacy` (at most `MAX_TWIN_LOOKUP`).
 */
export async function nfxTwinsOf(
  client: NostrClient,
  namespace: string,
  legacy: readonly { readonly id: NostrEventId; readonly author: NostrPubkey }[],
  opts: { readonly relays?: readonly RelayUrl[] | undefined } = {},
): Promise<NfxVideo[]> {
  const authorOf = new Map(legacy.slice(0, MAX_TWIN_LOOKUP).map((v) => [v.id, v.author]));
  if (authorOf.size === 0) return [];
  const events = await client.query(
    {
      kinds: [KIND_MANIFEST],
      authors: [...new Set(authorOf.values())],
      '#n': [namespace],
      '#e': [...authorOf.keys()],
      limit: MAX_PAGE,
    },
    opts.relays,
  );
  const videos = await listed(client, namespace, events, opts.relays);
  return videos.filter((v) => v.legacyId !== undefined && authorOf.get(v.legacyId) === v.author);
}

/**
 * One NFX video by address (NFX-04 §5 "one manifest": `#d` + `authors`, then the local `n`
 * check), or `null` when no current, undeleted, free revision is found.
 */
export async function fetchNfxVideo(
  client: NostrClient,
  addr: NfxAddress,
  opts: { readonly relays?: readonly RelayUrl[] | undefined } = {},
): Promise<NfxVideo | null> {
  const target = parseATag(addr);
  if (!target.ok) return null;
  const { creator, addr: videoAddr } = target.value;
  const events = await client.query(
    { kinds: [KIND_MANIFEST], authors: [creator as NostrPubkey], '#d': [videoAddr.toString()] },
    opts.relays,
  );
  const videos = await listed(client, videoAddr.namespace.toString(), events, opts.relays);
  return videos.find((v) => v.id === addr) ?? null;
}
