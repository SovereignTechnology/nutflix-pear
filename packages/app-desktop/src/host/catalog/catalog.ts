/**
 * Catalogue seam (design §5(a) "Fixtures via a provider seam"). Production reads through L1
 * over the relays (`NostrCatalog`); `--dev-fixtures` swaps in `FixtureCatalog`. Everything that
 * comes back here from a relay went through `NostrClient` → `verifyIncoming` (L1, T9).
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
  SearchFilters,
  VideoManifest,
} from '@sovit/core';
import { nostr } from '@sovit/core';

export interface SearchQuery {
  readonly text: string;
  readonly cursor?: string;
  readonly filters?: SearchFilters;
}

export interface CatalogSource {
  /**
   * `viewer` is the signed-in pubkey (subscriptions feed), or `null`. Contracts v9: NFX videos
   * appear only from a source that lists them (`MergedCatalog`).
   */
  feed(q: FeedQuery, viewer: NostrPubkey | null): Promise<Page<CatalogVideo>>;
  video(id: NostrEventId): Promise<VideoManifest | null>;
  /** Contracts v9: an NFX video by address, `null` from a source without NFX. */
  nfxVideo(addr: NfxAddress): Promise<NfxVideo | null>;
  videos(ids: readonly NostrEventId[]): Promise<VideoManifest[]>;
  related(id: NostrEventId, limit: number): Promise<readonly VideoManifest[]>;
  search(q: SearchQuery): Promise<Page<CatalogVideo>>;
  profile(pubkey: NostrPubkey): Promise<Profile | null>;
  /**
   * `VideoStats.seedersOnline`: a count only when the source KNOWS it, `undefined` otherwise
   * (contract v5: absent = unknown). The screens gate play only on a known 0, so a source
   * with no swarm lookup must never guess 0; `play()` reports the truth either way (#23).
   */
  seedersOnline(video: VideoManifest): Promise<number | undefined>;
}

/** Page sizes when the caller gives none (the mock's, so screens see the same rhythm). */
export const FEED_PAGE = 20;

export class NostrCatalog implements CatalogSource {
  private readonly client: () => nostr.NostrClient;

  /** `client` is re-read per call: it is rebuilt when the relays or the signer change. */
  constructor(client: () => nostr.NostrClient) {
    this.client = client;
  }

  async feed(q: FeedQuery, viewer: NostrPubkey | null): Promise<Page<VideoManifest>> {
    const c = this.client();
    const opts = { limit: q.limit ?? FEED_PAGE, cursor: q.cursor };
    switch (q.source) {
      case 'subscriptions': {
        if (viewer === null) return { items: [] };
        const { pubkeys } = await nostr.fetchSubscriptions(c, viewer);
        if (pubkeys.length === 0) return { items: [] };
        // Normal videos only, like the mock (shorts have their own feed).
        return nostr.videoPage(c, { authors: pubkeys, kinds: [21] }, opts);
      }
      case 'trending': {
        const page = await nostr.trendingFeed(c, opts);
        const items = page.items.filter((v) => v.kind === 21);
        return page.next === undefined ? { items } : { items, next: page.next };
      }
      case 'tags':
        return nostr.tagsFeed(c, q.tags ?? [], opts);
      case 'author':
        return q.author === undefined ? { items: [] } : nostr.authorFeed(c, q.author, opts);
      case 'shorts':
        return nostr.shortsFeed(c, opts);
    }
  }

  video(id: NostrEventId): Promise<VideoManifest | null> {
    return nostr.fetchVideo(this.client(), id);
  }

  /** The NIP-71 catalogue has no NFX videos; `MergedCatalog` adds them. */
  nfxVideo(_addr: NfxAddress): Promise<NfxVideo | null> {
    return Promise.resolve(null);
  }

  videos(ids: readonly NostrEventId[]): Promise<VideoManifest[]> {
    return nostr.fetchVideos(this.client(), ids);
  }

  async related(id: NostrEventId, limit: number): Promise<readonly VideoManifest[]> {
    const c = this.client();
    const v = await nostr.fetchVideo(c, id);
    return v === null ? [] : nostr.relatedVideos(c, v, limit);
  }

  search(q: SearchQuery): Promise<Page<VideoManifest>> {
    return nostr.searchVideos(this.client(), q.text, q.filters ?? {}, {
      cursor: q.cursor,
      limit: FEED_PAGE,
    });
  }

  profile(pubkey: NostrPubkey): Promise<Profile | null> {
    // No live NIP-05 lookup in Stage 1: it would make the host fetch a URL named by a relay
    // event; `nip05Status` stays `unverified` (docs/archive/lanes/L6-B.md).
    return nostr.fetchProfile(this.client(), pubkey);
  }

  /** The host has no swarm lookup for relay videos, so the count is unknown (#23). */
  seedersOnline(_video: VideoManifest): Promise<number | undefined> {
    return Promise.resolve(undefined);
  }
}
