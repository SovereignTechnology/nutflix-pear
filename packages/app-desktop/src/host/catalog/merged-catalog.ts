/**
 * The NIP-71 catalogue and one NFX network's, merged (ADR 0020, contracts v9).
 *
 * - Subscriptions, tags, author and search are merged newest first, under one time cursor: both
 *   sides are asked for a page from the same `until`, the newest `limit` of the union are kept,
 *   and the cursor names the oldest kept second (`t:` cursors, as `videoPage` writes them).
 * - Trending (ranked by nutzaps, which NFX has none of), shorts, related and everything keyed by
 *   event id are the NIP-71 catalogue's alone.
 * - Twins: an NFX manifest whose `e` names a NIP-71 event by the same author is dropped while that
 *   event exists, because the NIP-71 video plays today. A link to another author's event is
 *   ignored. The check covers events outside the page (one batched fetch).
 * - An NFX failure never fails a page: the NIP-71 videos are listed without it.
 */
import type {
  CatalogVideo,
  FeedQuery,
  NfxAddress,
  NfxVideo,
  NostrEventId,
  NostrPubkey,
  Page,
  Profile,
  VideoManifest,
} from '@sovit/core';
import { nostr } from '@sovit/core';
import type { Logger } from '../log.js';
import { FEED_PAGE, type CatalogSource, type SearchQuery } from './catalog.js';
import type { NfxSource } from './nfx-catalog.js';

export class MergedCatalog implements CatalogSource {
  private readonly legacy: CatalogSource;
  private readonly nfx: NfxSource;
  private readonly log: Logger;

  constructor(legacy: CatalogSource, nfx: NfxSource, log: Logger) {
    this.legacy = legacy;
    this.nfx = nfx;
    this.log = log;
  }

  async feed(q: FeedQuery, viewer: NostrPubkey | null): Promise<Page<CatalogVideo>> {
    if (q.source === 'trending' || q.source === 'shorts') return this.legacy.feed(q, viewer);
    const [legacy, nfx] = await Promise.all([
      this.legacy.feed(q, viewer),
      this.nfxOrNothing(() => this.nfx.feed(q, viewer)),
    ]);
    return this.merge(legacy, nfx, q.limit ?? FEED_PAGE);
  }

  async search(q: SearchQuery): Promise<Page<CatalogVideo>> {
    const [legacy, nfx] = await Promise.all([
      this.legacy.search(q),
      this.nfxOrNothing(() => this.nfx.search(q)),
    ]);
    return this.merge(legacy, nfx, FEED_PAGE);
  }

  video(id: NostrEventId): Promise<VideoManifest | null> {
    return this.legacy.video(id);
  }

  videos(ids: readonly NostrEventId[]): Promise<VideoManifest[]> {
    return this.legacy.videos(ids);
  }

  nfxVideo(addr: NfxAddress): Promise<NfxVideo | null> {
    return this.nfx.video(addr);
  }

  related(id: NostrEventId, limit: number): Promise<readonly VideoManifest[]> {
    return this.legacy.related(id, limit);
  }

  profile(pubkey: NostrPubkey): Promise<Profile | null> {
    return this.legacy.profile(pubkey);
  }

  seedersOnline(video: VideoManifest): Promise<number | undefined> {
    return this.legacy.seedersOnline(video);
  }

  /** The NFX side of a page, or an empty one when it fails (logged; the NIP-71 page stands). */
  private async nfxOrNothing(read: () => Promise<Page<NfxVideo>>): Promise<Page<NfxVideo>> {
    try {
      return await read();
    } catch {
      this.log.warn('nfx catalog read failed; listing NIP-71 videos only');
      return { items: [] };
    }
  }

  /** NFX videos whose same-author NIP-71 twin exists, on this page or on the relays. */
  private async twins(
    legacy: readonly CatalogVideo[],
    nfx: readonly NfxVideo[],
  ): Promise<Set<NfxAddress>> {
    const linked = nfx.filter((v) => v.legacyId !== undefined);
    if (linked.length === 0) return new Set();
    const authorOf = new Map<string, NostrPubkey>();
    for (const v of legacy) if (v.kind !== 38504) authorOf.set(v.id, v.author);
    const missing = linked.flatMap((v) =>
      v.legacyId === undefined || authorOf.has(v.legacyId) ? [] : [v.legacyId],
    );
    if (missing.length > 0) {
      try {
        for (const v of await this.legacy.videos(missing)) authorOf.set(v.id, v.author);
      } catch {
        // Unknown twins stay listed: a duplicate card is better than a missing video.
        this.log.warn('nfx twin lookup failed; listing both');
      }
    }
    const out = new Set<NfxAddress>();
    for (const v of linked) {
      if (v.legacyId !== undefined && authorOf.get(v.legacyId) === v.author) out.add(v.id);
    }
    return out;
  }

  private async merge(
    legacy: Page<CatalogVideo>,
    nfx: Page<NfxVideo>,
    limit: number,
  ): Promise<Page<CatalogVideo>> {
    if (nfx.items.length === 0) return legacy;
    const twins = await this.twins(legacy.items, nfx.items);
    const all: CatalogVideo[] = [...legacy.items, ...nfx.items.filter((v) => !twins.has(v.id))];
    all.sort((a, b) => nostr.byNewest(a.event, b.event));
    const items = all.slice(0, limit);
    const more = all.length > limit || legacy.next !== undefined || nfx.next !== undefined;
    const next = more ? nostr.encodeTimeCursor(items.map((v) => v.event)) : undefined;
    return next === undefined ? { items } : { items, next };
  }
}
