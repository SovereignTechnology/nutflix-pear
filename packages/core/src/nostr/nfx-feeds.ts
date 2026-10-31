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
  const base: NostrFilter = {
    search: q,
    ...(filters.since === undefined ? {} : { since: filters.since }),
    ...(filters.until === undefined ? {} : { until: filters.until }),
    ...(filters.author === undefined ? {} : { authors: [filters.author] }),
    ...(filters.tags && filters.tags.length > 0 ? { '#t': filters.tags } : {}),
  };
  const min = filters.minDurationSec;
  const max = filters.maxDurationSec;
  return nfxVideoPage(client, namespace, base, opts, (v) => {
    if (min === undefined && max === undefined) return true;
    if (v.durationSec === undefined) return false;
    return (
      (min === undefined || v.durationSec >= min) && (max === undefined || v.durationSec <= max)
    );
  });
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
