/**
 * The NFX catalog source (ADR 0020 Phase 1, contracts v9): one network's free videos. Reads go to
 * the network's scoped relays, its own, and to the user's read relays AT ONCE, and the answers are
 * merged (ADR 0026, 2026-11-26; NFX-04 §4 as amended by nfx decision record 0110). Until then the
 * read relays were only the fallback, asked after the scoped read failed or came back short (ADR
 * 0020, 2026-11-19), so an unreachable scoped relay cost every read its whole connect timeout
 * before the read relays were even asked; on 2026-11-26 the scoped relay's host was unreachable
 * for 45 minutes. A scoped relay that keeps manifests in memory is still empty, or partly
 * refilled, for hours after a restart, and the merge still never lets that blank or shrink the
 * catalog. Everything comes back through `NostrClient` → `verifyIncoming`, then NFX-02's parser,
 * revisions and deletions (`nostr.nfxVideoPage`).
 *
 * Built only while `Settings.nfx` is enabled (contracts v10); off by default.
 *
 * Moved from the desktop host into core (ADR 0022), so the web client lists the network the same
 * way; the client and the relays are passed in. Search goes through NIP-11 (`searchSupport`): a
 * relay that does not list NIP-50 is never sent `search`, and is read with a plain query matched
 * here instead (`searchNfxVideosRouted`). Search reads the scoped relays first only when every
 * one of them lists NIP-50; otherwise the read relays first, as before (`scopedSearch`).
 */
import type {
  FeedQuery,
  NfxAddress,
  NfxVideo,
  NostrEventId,
  NostrPubkey,
  Page,
  RelayUrl,
  SearchFilters,
} from '../contracts/index.js';
import { parseATag } from '../nfx/beacon.js';
import { Namespace } from '../nfx/namespace.js';
import type { NostrClient } from './client.js';
import { encodeTimeCursor } from './cursor.js';
import { byNewest } from './event.js';
import { MAX_PAGE } from './feeds.js';
import { fetchSubscriptions } from './follows.js';
import {
  fetchNfxVideo,
  nfxAuthorsFeed,
  nfxTagsFeed,
  nfxTwinsOf,
  nfxVideoPage,
  nfxWithdrawn,
  searchNfxVideos,
  searchNfxVideosRouted,
} from './nfx-feeds.js';

/** Page size when the caller gives none (the desktop catalogue's and the mock's). */
export const NFX_FEED_PAGE = 20;

/**
 * How long a read that already has enough from one relay set (a full page, or the video) waits
 * for the other before it answers: long enough for a healthy relay to add a newer revision, short
 * enough that an unreachable one (whose connect timeout is about 7 s) never holds the page.
 */
export const NFX_MERGE_GRACE_MS = 1_500;

/** A feed's page size as `nfxVideoPage` applies it: 1 to `MAX_PAGE`. */
const pageSize = (n: number | undefined): number =>
  Math.min(MAX_PAGE, Math.max(1, n ?? NFX_FEED_PAGE));

type SearchSupport = (relay: RelayUrl) => Promise<boolean>;

/**
 * Pages of one query from different relay sets, as one page: one video per address, the newest
 * revision winning and, at the same `created_at`, the earlier page's copy (callers pass the scoped
 * relays' page first, so the network's own copy wins a tie); newest first, at most `limit`. There
 * is more when any page had more or the union ran past `limit` (the overflow is never dropped),
 * and the cursor is the merged page's own.
 */
function mergePages(
  pages: readonly Page<NfxVideo>[],
  limit: number,
  withdrawn: ReadonlySet<string> = new Set(),
): Page<NfxVideo> {
  const newest = new Map<string, NfxVideo>();
  for (const v of pages.flatMap((p) => p.items)) {
    if (withdrawn.has(v.eventId)) continue;
    const seen = newest.get(v.id);
    if (seen === undefined || v.event.created_at > seen.event.created_at) newest.set(v.id, v);
  }
  const all = [...newest.values()].sort((a, b) => byNewest(a.event, b.event));
  const items = all.slice(0, limit);
  const more = all.length > limit || pages.some((p) => p.next !== undefined);
  const next = more
    ? (encodeTimeCursor(items.map((v) => v.event)) ?? pages.find((p) => p.next !== undefined)?.next)
    : undefined;
  return next === undefined ? { items } : { items, next };
}

/** `supports`, asked at most once per relay while one call lasts; a failure counts as no. */
function oncePerRelay(supports: SearchSupport | undefined): SearchSupport | undefined {
  if (supports === undefined) return undefined;
  const asked = new Map<RelayUrl, Promise<boolean>>();
  return (relay) => {
    let answer = asked.get(relay);
    if (answer === undefined) {
      answer = supports(relay).catch(() => false);
      asked.set(relay, answer);
    }
    return answer;
  };
}

export interface NfxSearchQuery {
  readonly text: string;
  readonly cursor?: string;
  readonly filters?: SearchFilters;
}

export interface NfxCatalogOptions {
  /**
   * Whether a relay answers NIP-50 search, from its NIP-11 document (`RelaySearchSupport`).
   * Absent: every relay is sent `search`, as before ADR 0022.
   */
  readonly searchSupport?: ((relay: RelayUrl) => Promise<boolean>) | undefined;
  /** `NFX_MERGE_GRACE_MS` unless given (tests). */
  readonly mergeGraceMs?: number | undefined;
}

type Settled<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );

export interface NfxSource {
  /** Subscriptions, tags and author; trending and shorts have no NFX videos. */
  feed(q: FeedQuery, viewer: NostrPubkey | null): Promise<Page<NfxVideo>>;
  search(q: NfxSearchQuery): Promise<Page<NfxVideo>>;
  /** `null` for an address outside this source's network. */
  video(addr: NfxAddress): Promise<NfxVideo | null>;
  /**
   * Slice 5d-4: the same-author NFX copies of these NIP-71 events (one bounded query), from the
   * scoped relays (the read relays when there are none) — which every feed page reads — so a copy
   * found here is one a feed lists.
   */
  twinsOf(
    legacy: readonly { readonly id: NostrEventId; readonly author: NostrPubkey }[],
  ): Promise<NfxVideo[]>;
  /**
   * Slice 5d-4: whether this network's videos can play here, which needs its scoped relays (the
   * only place beacons are read). The catalog prefers an NFX copy only when it can.
   */
  playable(): boolean;
}

export class NfxCatalog implements NfxSource {
  private readonly client: () => NostrClient;
  readonly namespace: string;
  private readonly scopedRelays: () => readonly RelayUrl[];
  private readonly searchSupport: SearchSupport | undefined;
  private readonly mergeGraceMs: number;

  /** Throws on a namespace NFX-01 refuses: a source never runs on one. */
  constructor(
    client: () => NostrClient,
    namespace: string,
    scopedRelays: () => readonly RelayUrl[],
    opts: NfxCatalogOptions = {},
  ) {
    const ns = Namespace.parse(namespace);
    if (!ns.ok || ns.value.toString() !== namespace) {
      throw new Error('NfxCatalog: not a canonical NFX namespace');
    }
    this.client = client;
    this.namespace = namespace;
    this.scopedRelays = scopedRelays;
    this.searchSupport = opts.searchSupport;
    this.mergeGraceMs = opts.mergeGraceMs ?? NFX_MERGE_GRACE_MS;
  }

  /**
   * `read` on the scoped relays, the network's own, and on the read relays at once (ADR 0026), and
   * the two answers `merge`d (scoped first). When the first answer is `enough` (a full page, the
   * video), the other gets `mergeGraceMs` more and is left out if it is still not in: a relay that
   * is down never holds a read that already has its answer. Otherwise both are awaited. When one
   * side fails, the other's answer stands, except an empty scoped answer beside a failed read: the
   * read relays' error is then reported, as is any error when both fail. Without scoped relays, the
   * read relays alone, as before.
   */
  private async bothAtOnce<T>(
    read: (relays: readonly RelayUrl[] | undefined) => Promise<T>,
    enough: (t: T) => boolean,
    hasAny: (t: T) => boolean,
    merge: (scoped: T, fallback: T, scopedRelays: readonly RelayUrl[]) => T | Promise<T>,
  ): Promise<T> {
    const scopedRelays = this.scopedRelays();
    if (scopedRelays.length === 0) return read(undefined);
    const got: [Settled<T> | undefined, Settled<T> | undefined] = [undefined, undefined];
    const sides = [read(scopedRelays), read(undefined)].map((p, i) =>
      settle(p).then((r) => {
        got[i] = r;
        return r;
      }),
    );
    const first = await Promise.race(sides);
    if (first.ok && enough(first.value)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.mergeGraceMs);
      });
      await Promise.race([Promise.all(sides), grace]);
      clearTimeout(timer);
    } else {
      await Promise.all(sides);
    }
    const [scoped, fallback] = got;
    if (scoped?.ok === true && fallback?.ok === true) {
      return merge(scoped.value, fallback.value, scopedRelays);
    }
    if (scoped?.ok === true) {
      // An empty scoped answer beside a failed read is the read relays' error, not "nothing".
      if (fallback?.ok === false && !hasAny(scoped.value)) throw fallback.error;
      return scoped.value;
    }
    if (fallback?.ok === true) return fallback.value;
    // Both failed (a side still pending here had to be the one that answered `enough`).
    throw fallback?.ok === false
      ? fallback.error
      : scoped?.ok === false
        ? scoped.error
        : new Error('NfxCatalog: no answer');
  }

  /**
   * `bothAtOnce` for a page of at most `limit`: a page is enough when it is full. The two pages are
   * merged (`mergePages`: one video per address, the newest revision, the scoped copy on a tie,
   * newest first, `limit`), so an empty or short scoped page never shrinks the catalog.
   */
  private bothAtOncePage(
    read: (relays: readonly RelayUrl[] | undefined) => Promise<Page<NfxVideo>>,
    limit: number,
  ): Promise<Page<NfxVideo>> {
    return this.bothAtOnce(
      read,
      (p) => p.items.length >= limit,
      (p) => p.items.length > 0,
      async (scoped, fallback, scopedRelays) =>
        mergePages(
          [scoped, fallback],
          limit,
          await this.withdrawnAcross(scoped.items, fallback.items, scopedRelays),
        ),
    );
  }

  /**
   * The event ids a deletion on the other relay set withdraws (ADR 0026). Each side's page was
   * checked against its own set's deletions only, so a video one side lists and the other does not
   * is asked about on the other set: an author's deletion that reached only the scoped relays (which
   * may then drop the manifest itself) still withdraws the copy a read relay kept. A video both sides
   * list needs no check: the newer revision wins, and each side's deletions are older than its own.
   * Both sets have just answered; a check that fails withdraws nothing.
   */
  private async withdrawnAcross(
    scoped: readonly NfxVideo[],
    fallback: readonly NfxVideo[],
    scopedRelays: readonly RelayUrl[],
  ): Promise<ReadonlySet<string>> {
    const c = this.client();
    const onlyIn = (xs: readonly NfxVideo[], other: readonly NfxVideo[]): NfxVideo[] => {
      const there = new Set(other.map((v) => v.id));
      return xs.filter((v) => !there.has(v.id));
    };
    const checks = await Promise.allSettled([
      nfxWithdrawn(c, this.namespace, onlyIn(fallback, scoped), scopedRelays),
      nfxWithdrawn(c, this.namespace, onlyIn(scoped, fallback), undefined),
    ]);
    const out = new Set<string>();
    for (const r of checks) if (r.status === 'fulfilled') for (const id of r.value) out.add(id);
    return out;
  }

  /**
   * NFX-04 §4's order, kept for search on scoped relays that do not all answer NIP-50
   * (`scopedSearch`): `read` on the read relays; on the scoped relays instead when that throws or
   * `isEmpty`. Without scoped relays, the first answer (or its error) stands.
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
      // The scoped relays are the fallback here; their own failure is the one reported.
    }
    return read(scoped);
  }

  async feed(q: FeedQuery, viewer: NostrPubkey | null): Promise<Page<NfxVideo>> {
    const c = this.client();
    const limit = pageSize(q.limit);
    const opts = { limit, cursor: q.cursor };
    const page = (
      relays: readonly RelayUrl[] | undefined,
      authors: readonly NostrPubkey[],
    ): Promise<Page<NfxVideo>> => nfxAuthorsFeed(c, this.namespace, authors, { ...opts, relays });
    switch (q.source) {
      case 'subscriptions': {
        if (viewer === null) return { items: [] };
        const { pubkeys } = await fetchSubscriptions(c, viewer);
        if (pubkeys.length === 0) return { items: [] };
        return this.bothAtOncePage((relays) => page(relays, pubkeys), limit);
      }
      case 'tags':
        return this.bothAtOncePage(
          (relays) => nfxTagsFeed(c, this.namespace, q.tags ?? [], { ...opts, relays }),
          limit,
        );
      case 'author': {
        const author = q.author;
        if (author === undefined) return { items: [] };
        return this.bothAtOncePage((relays) => page(relays, [author]), limit);
      }
      case 'network':
        return this.networkFeed(c, { limit: q.limit ?? NFX_FEED_PAGE, cursor: q.cursor });
      case 'trending':
      case 'shorts':
        return { items: [] };
    }
  }

  /**
   * Every video on the network, newest first: the scoped relays (the network's own) and the read
   * relays (which carry its mirrors) are both asked, so a video listed on only one still shows.
   * One video is one address, whichever relays held it or how many revisions; the newest wins, and
   * the scoped relays' copy a tie (`mergePages`). Fails only when every relay set does.
   */
  private async networkFeed(
    c: NostrClient,
    opts: { readonly limit: number; readonly cursor: string | undefined },
  ): Promise<Page<NfxVideo>> {
    const scoped = this.scopedRelays();
    const read = (relays: readonly RelayUrl[] | undefined): Promise<Page<NfxVideo>> =>
      nfxVideoPage(c, this.namespace, {}, { ...opts, relays });
    const settled = await Promise.allSettled(
      scoped.length === 0 ? [read(undefined)] : [read(scoped), read(undefined)],
    );
    const pages = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
    const first = settled.find((s) => s.status === 'rejected');
    if (pages.length === 0 && first !== undefined) throw first.reason;
    return mergePages(pages, opts.limit);
  }

  async search(q: NfxSearchQuery): Promise<Page<NfxVideo>> {
    if (q.text.trim() === '') return { items: [] };
    const c = this.client();
    const supports = oncePerRelay(this.searchSupport);
    const read = (relays: readonly RelayUrl[] | undefined): Promise<Page<NfxVideo>> => {
      const opts = { cursor: q.cursor, limit: NFX_FEED_PAGE, relays };
      return supports === undefined
        ? searchNfxVideos(c, this.namespace, q.text, q.filters ?? {}, opts)
        : searchNfxVideosRouted(c, this.namespace, q.text, q.filters ?? {}, {
            ...opts,
            supports,
          });
    };
    return (await this.scopedSearch(supports))
      ? this.bothAtOncePage(read, NFX_FEED_PAGE)
      : this.publicFirst(read, (p) => p.items.length === 0);
  }

  /**
   * Whether search reads the scoped relays with the read relays at once, as the feeds do (ADR
   * 0026): when every scoped relay lists
   * NIP-50 in its NIP-11 document (without `searchSupport`, every relay is taken to, as before ADR
   * 0022). The test network's `relay.nutflix.xyz` does. A scoped relay that does not is only
   * scanned (`scanNfxVideos`): each page downloads up to `NFX_SCAN_PAGE` manifests and matches
   * here, and few matches are expected however healthy the relay is, so reading it with the others
   * would add a heavy scan to nearly every search and merge its page, whose cursor is how far it
   * read and not its last match. Search then keeps the read relays first, as before. A scoped
   * relay whose NIP-11 document cannot be fetched (its host down) counts as one without NIP-50.
   */
  private async scopedSearch(supports: SearchSupport | undefined): Promise<boolean> {
    const scoped = this.scopedRelays();
    if (scoped.length === 0) return false;
    if (supports === undefined) return true;
    return (await Promise.all(scoped.map((r) => supports(r)))).every((yes) => yes);
  }

  twinsOf(
    legacy: readonly { readonly id: NostrEventId; readonly author: NostrPubkey }[],
  ): Promise<NfxVideo[]> {
    if (legacy.length === 0) return Promise.resolve([]);
    // The scoped relays only, which every feed page reads first, so a copy found here is one a
    // feed lists. Not `bothAtOnce`: a copy only the read relays hold is missed by a feed whose
    // scoped relays fill its pages, and then its NIP-71 video must stay (a duplicate, never a
    // gap). Scoped relays down: this fails, and the merged catalogue lists both.
    const scoped = this.scopedRelays();
    return nfxTwinsOf(
      this.client(),
      this.namespace,
      legacy,
      scoped.length === 0 ? {} : { relays: scoped },
    );
  }

  playable(): boolean {
    return this.scopedRelays().length > 0;
  }

  video(addr: NfxAddress): Promise<NfxVideo | null> {
    const target = parseATag(addr);
    if (!target.ok || target.value.addr.namespace.toString() !== this.namespace) {
      return Promise.resolve(null);
    }
    const c = this.client();
    // The newest revision either side holds, the scoped copy on a tie, unless a deletion on the
    // side that lacks it withdraws it.
    return this.bothAtOnce(
      (relays) => fetchNfxVideo(c, addr, { relays }),
      (v) => v !== null,
      (v) => v !== null,
      async (scoped, fallback, scopedRelays) => {
        const pick =
          scoped === null ||
          (fallback !== null && fallback.event.created_at > scoped.event.created_at)
            ? fallback
            : scoped;
        if (pick === null) return null;
        const gone = await this.withdrawnAcross(
          scoped === null ? [] : [scoped],
          fallback === null ? [] : [fallback],
          scopedRelays,
        );
        return gone.has(pick.eventId) ? null : pick;
      },
    );
  }
}
