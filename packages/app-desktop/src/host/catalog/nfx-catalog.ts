/**
 * The NFX catalog source (ADR 0020 Phase 1, contracts v9): one network's free videos. Reads go to
 * the user's read relays first and to the network's scoped relays only when those fail or have
 * nothing (NFX-04 §4: manifests are mirrored to public relays). Everything comes back through
 * `NostrClient` → `verifyIncoming`, then NFX-02's parser, revisions and deletions
 * (`nostr.nfxVideoPage`).
 *
 * Built only while `Settings.nfx` is enabled (contracts v10); off by default.
 */
import type { FeedQuery, NfxAddress, NfxVideo, NostrPubkey, Page, RelayUrl } from '@sovit/core';
import { nfx, nostr } from '@sovit/core';
import { FEED_PAGE, type SearchQuery } from './catalog.js';

export interface NfxSource {
  /** Subscriptions, tags and author; trending and shorts have no NFX videos. */
  feed(q: FeedQuery, viewer: NostrPubkey | null): Promise<Page<NfxVideo>>;
  search(q: SearchQuery): Promise<Page<NfxVideo>>;
  /** `null` for an address outside this source's network. */
  video(addr: NfxAddress): Promise<NfxVideo | null>;
}

export class NfxCatalog implements NfxSource {
  private readonly client: () => nostr.NostrClient;
  readonly namespace: string;
  private readonly scopedRelays: () => readonly RelayUrl[];

  /** Throws on a namespace NFX-01 refuses: a source never runs on one. */
  constructor(
    client: () => nostr.NostrClient,
    namespace: string,
    scopedRelays: () => readonly RelayUrl[],
  ) {
    const ns = nfx.Namespace.parse(namespace);
    if (!ns.ok || ns.value.toString() !== namespace) {
      throw new Error('NfxCatalog: not a canonical NFX namespace');
    }
    this.client = client;
    this.namespace = namespace;
    this.scopedRelays = scopedRelays;
  }

  /**
   * `read` on the read relays; on the scoped relays instead when that throws or `isEmpty`, and
   * there are scoped relays. Without any, the first answer (or its error) stands.
   */
  private async publicFirst<T>(
    read: (relays: readonly RelayUrl[] | undefined) => Promise<T>,
    isEmpty: (t: T) => boolean,
  ): Promise<T> {
    const scoped = this.scopedRelays();
    if (scoped.length === 0) return read(undefined);
    try {
      const first = await read(undefined);
      if (!isEmpty(first)) return first;
    } catch {
      // The scoped relays are the fallback; their own failure is the one reported.
    }
    return read(scoped);
  }

  async feed(q: FeedQuery, viewer: NostrPubkey | null): Promise<Page<NfxVideo>> {
    const c = this.client();
    const opts = { limit: q.limit ?? FEED_PAGE, cursor: q.cursor };
    const page = (
      relays: readonly RelayUrl[] | undefined,
      authors: readonly NostrPubkey[],
    ): Promise<Page<NfxVideo>> =>
      nostr.nfxAuthorsFeed(c, this.namespace, authors, { ...opts, relays });
    const empty = (p: Page<NfxVideo>): boolean => p.items.length === 0;
    switch (q.source) {
      case 'subscriptions': {
        if (viewer === null) return { items: [] };
        const { pubkeys } = await nostr.fetchSubscriptions(c, viewer);
        if (pubkeys.length === 0) return { items: [] };
        return this.publicFirst((relays) => page(relays, pubkeys), empty);
      }
      case 'tags':
        return this.publicFirst(
          (relays) => nostr.nfxTagsFeed(c, this.namespace, q.tags ?? [], { ...opts, relays }),
          empty,
        );
      case 'author': {
        const author = q.author;
        if (author === undefined) return { items: [] };
        return this.publicFirst((relays) => page(relays, [author]), empty);
      }
      case 'trending':
      case 'shorts':
        return { items: [] };
    }
  }

  search(q: SearchQuery): Promise<Page<NfxVideo>> {
    const c = this.client();
    return this.publicFirst(
      (relays) =>
        nostr.searchNfxVideos(c, this.namespace, q.text, q.filters ?? {}, {
          cursor: q.cursor,
          limit: FEED_PAGE,
          relays,
        }),
      (p) => p.items.length === 0,
    );
  }

  video(addr: NfxAddress): Promise<NfxVideo | null> {
    const target = nfx.parseATag(addr);
    if (!target.ok || target.value.addr.namespace.toString() !== this.namespace) {
      return Promise.resolve(null);
    }
    const c = this.client();
    return this.publicFirst(
      (relays) => nostr.fetchNfxVideo(c, addr, { relays }),
      (v) => v === null,
    );
  }
}
