/**
 * The NIP-71 catalogue and one NFX network's, merged (ADR 0020, contracts v9).
 *
 * - Subscriptions, tags, author and search are merged newest first, under one time cursor: both
 *   sides are asked for a page from the same `until`, the newest `limit` of the union are kept,
 *   and the cursor names the oldest kept second (`t:` cursors, as `videoPage` writes them).
 * - Trending (ranked by nutzaps, which NFX has none of), shorts, related and everything keyed by
 *   event id are the NIP-71 catalogue's alone.
 * - Twins: an NFX manifest whose `e` names a NIP-71 event by the same author is that event's copy
 *   (a link to another author's event is ignored), and only one of the two is listed:
 *   - Slice 5d-4: when the network's videos can play here (`NfxSource.playable`) and the NIP-71
 *     video is free, the NFX copy, which plays from the network's seeders without a wallet (its
 *     comments stay the NIP-71 event's). A free NIP-71 video whose copy is on another page goes
 *     only when the copy is sure to be listed by the same feed (`covers`): author and
 *     subscription feeds, a tag feed when the copy has one of its tags; search pairs within a
 *     page only.
 *   - Otherwise the NIP-71 video: a priced one is never undercut by a free copy (ADR 0020), and
 *     without the scoped relays the copy cannot play.
 *   An NFX copy's NIP-71 event is looked up outside the page too (one batched fetch).
 * - An NFX failure never fails a page: the NIP-71 videos are listed without it.
 */
import type {
  CatalogVideo,
  FeedQuery,
  NfxAddress,
  NfxVideo,
  NostrEvent,
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

/** Whether a feed's NFX side is sure to list `copy` on some page (see the module comment). */
type Covers = (copy: NfxVideo) => boolean;

function coversFeed(q: FeedQuery): Covers {
  switch (q.source) {
    case 'subscriptions':
    case 'author':
      // Same author as its NIP-71 event, which this feed listed: the NFX side asks for it too.
      return () => true;
    case 'tags': {
      const wanted = new Set((q.tags ?? []).map((t) => t.trim().toLowerCase()));
      return (copy) => copy.tags.some((t) => wanted.has(t.toLowerCase()));
    }
    case 'trending':
    case 'shorts':
      return () => false;
  }
}

/** A merged page whose every candidate was a dropped twin is stepped past, this many times. */
const MAX_EMPTY_STEPS = 3;

export class MergedCatalog implements CatalogSource {
  private readonly legacy: CatalogSource;
  private readonly nfx: NfxSource;
  private readonly log: Logger;

  constructor(legacy: CatalogSource, nfx: NfxSource, log: Logger) {
    this.legacy = legacy;
    this.nfx = nfx;
    this.log = log;
  }

  feed(q: FeedQuery, viewer: NostrPubkey | null): Promise<Page<CatalogVideo>> {
    if (q.source === 'trending' || q.source === 'shorts') return this.legacy.feed(q, viewer);
    return this.stepped(q.cursor, async (cursor) => {
      const at = cursor === undefined ? q : { ...q, cursor };
      const [legacy, nfx] = await Promise.all([
        this.legacy.feed(at, viewer),
        this.nfxOrNothing(() => this.nfx.feed(at, viewer)),
      ]);
      return this.merge(legacy, nfx, q.limit ?? FEED_PAGE, coversFeed(q));
    });
  }

  search(q: SearchQuery): Promise<Page<CatalogVideo>> {
    return this.stepped(q.cursor, async (cursor) => {
      const at = cursor === undefined ? q : { ...q, cursor };
      const [legacy, nfx] = await Promise.all([
        this.legacy.search(at),
        this.nfxOrNothing(() => this.nfx.search(at)),
      ]);
      return this.merge(legacy, nfx, FEED_PAGE, () => false);
    });
  }

  /** `page(cursor)`, stepping past a page left empty by twins (bounded). */
  private async stepped(
    cursor: string | undefined,
    page: (cursor: string | undefined) => Promise<Page<CatalogVideo>>,
  ): Promise<Page<CatalogVideo>> {
    let at = cursor;
    for (let step = 1; ; step++) {
      const p = await page(at);
      if (p.items.length > 0 || p.next === undefined || step === MAX_EMPTY_STEPS) return p;
      at = p.next;
    }
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

  /** Which side of each same-author twin pair this page drops (see the module comment). */
  private async pairs(
    legacy: readonly CatalogVideo[],
    nfx: readonly NfxVideo[],
    covers: Covers,
  ): Promise<{ readonly legacy: Set<NostrEventId>; readonly nfx: Set<NfxAddress> }> {
    const drop = { legacy: new Set<NostrEventId>(), nfx: new Set<NfxAddress>() };
    const playable = this.nfx.playable();
    const known = new Map<string, VideoManifest>();
    for (const v of legacy) if (v.kind !== 38504) known.set(v.id, v);
    const linked = nfx.filter((v) => v.legacyId !== undefined);
    const missing = [
      ...new Set(
        linked.flatMap((v) =>
          v.legacyId === undefined || known.has(v.legacyId) ? [] : [v.legacyId],
        ),
      ),
    ];
    if (missing.length > 0) {
      try {
        for (const v of await this.legacy.videos(missing)) known.set(v.id, v);
      } catch {
        // Unknown twins stay listed: a duplicate card is better than a missing video.
        this.log.warn('nfx twin lookup failed; listing both');
      }
    }
    for (const copy of linked) {
      const twin = copy.legacyId === undefined ? undefined : known.get(copy.legacyId);
      if (twin?.author !== copy.author) continue;
      if (playable && twin.price.satsPerBlock === 0) drop.legacy.add(twin.id);
      else drop.nfx.add(copy.id);
    }
    if (!playable) return drop;
    // Free NIP-71 videos on this page whose NFX copy is on another one.
    const free = legacy.flatMap((v) =>
      v.kind !== 38504 && v.price.satsPerBlock === 0 && !drop.legacy.has(v.id)
        ? [{ id: v.id, author: v.author }]
        : [],
    );
    if (free.length === 0) return drop;
    try {
      for (const copy of await this.nfx.twinsOf(free)) {
        if (copy.legacyId !== undefined && covers(copy)) drop.legacy.add(copy.legacyId);
      }
    } catch {
      this.log.warn('nfx twin lookup failed; listing both');
    }
    return drop;
  }

  private async merge(
    legacy: Page<CatalogVideo>,
    nfx: Page<NfxVideo>,
    limit: number,
    covers: Covers,
  ): Promise<Page<CatalogVideo>> {
    if (nfx.items.length === 0 && !this.nfx.playable()) return legacy;
    const drop = await this.pairs(legacy.items, nfx.items, covers);
    if (nfx.items.length === 0 && drop.legacy.size === 0) return legacy;
    // Nothing older than the oldest item of a side that has more is in order yet: that side's
    // next page may hold newer ones. (Dropped twins can leave a page short of `limit`.)
    const horizon = Math.max(oldestOf(legacy), oldestOf(nfx));
    const candidates = [...legacy.items, ...nfx.items].filter((v) => v.event.created_at >= horizon);
    const all = candidates.filter((v) =>
      v.kind === 38504 ? !drop.nfx.has(v.id) : !drop.legacy.has(v.id),
    );
    all.sort((a, b) => nostr.byNewest(a.event, b.event));
    const items = all.slice(0, limit);
    const more = all.length > limit || legacy.next !== undefined || nfx.next !== undefined;
    // A short page has seen every candidate down to the horizon, dropped twins included.
    const seen: NostrEvent[] =
      items.length === limit ? items.map((v) => v.event) : candidates.map((v) => v.event);
    const next = more ? nostr.encodeTimeCursor(seen.sort(nostr.byNewest)) : undefined;
    return next === undefined ? { items } : { items, next };
  }
}

/** The oldest item's second of a page that has more; -Infinity for a last (or empty) page. */
function oldestOf(page: Page<CatalogVideo>): number {
  if (page.next === undefined || page.items.length === 0) return -Infinity;
  return Math.min(...page.items.map((v) => v.event.created_at));
}
