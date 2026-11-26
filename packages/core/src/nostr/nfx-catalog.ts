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

/**
 * How many more merged pages a page that withdrawals left short reads to fill itself
 * (`toppedUp`). A short page is right (the cursor skips nothing); a full one reads better.
 */
const NFX_TOP_UP_ROUNDS = 2;

/** A feed's page size as `nfxVideoPage` applies it: 1 to `MAX_PAGE`. */
const pageSize = (n: number | undefined): number =>
  Math.min(MAX_PAGE, Math.max(1, n ?? NFX_FEED_PAGE));

type SearchSupport = (relay: RelayUrl) => Promise<boolean>;

/**
 * Pages of one query from different relay sets, as one page: one video per address, the newest
 * revision winning and, at the same `created_at`, the earlier page's copy (callers pass the scoped
 * relays' page first, so the network's own copy wins a tie); newest first, at most `limit`. There
 * is more when any page had more or the union ran past `limit` (the overflow is never dropped),
 * and the cursor is the merged page's own. `withdrawn` revisions are left out. A relay set whose
 * page was full (it has `next`) was read only down to its oldest video, so nothing older is listed
 * here: the cursor never passes a set's unread videos. Without a withdrawal that cuts nothing
 * (each full page alone fills `limit` above its own oldest video); with one, the page may come out
 * short, or empty with the frontier set's own cursor, and `dropped` counts what was left out.
 */
function mergePages(
  pages: readonly Page<NfxVideo>[],
  limit: number,
  withdrawn: ReadonlySet<string> = new Set(),
): { readonly page: Page<NfxVideo>; readonly dropped: number } {
  let frontier: { readonly video: NfxVideo; readonly next: string } | undefined;
  for (const p of pages) {
    if (p.next === undefined) continue;
    const oldest = [...p.items].sort((a, b) => byNewest(a.event, b.event)).at(-1);
    if (
      oldest !== undefined &&
      (frontier === undefined || byNewest(oldest.event, frontier.video.event) < 0)
    ) {
      frontier = { video: oldest, next: p.next };
    }
  }
  const newest = new Map<string, NfxVideo>();
  let dropped = 0;
  for (const v of pages.flatMap((p) => p.items)) {
    if (withdrawn.has(v.eventId)) {
      dropped++;
      continue;
    }
    const seen = newest.get(v.id);
    if (seen === undefined || v.event.created_at > seen.event.created_at) newest.set(v.id, v);
  }
  const unique = [...newest.values()].sort((a, b) => byNewest(a.event, b.event));
  const all = unique.filter(
    (v) => frontier === undefined || byNewest(v.event, frontier.video.event) <= 0,
  );
  dropped += unique.length - all.length;
  const items = all.slice(0, limit);
  const more = all.length > limit || pages.some((p) => p.next !== undefined);
  const next = more
    ? (encodeTimeCursor(items.map((v) => v.event)) ??
      frontier?.next ??
      pages.find((p) => p.next !== undefined)?.next)
    : undefined;
  return { page: next === undefined ? { items } : { items, next }, dropped };
}

/**
 * `page`, filled from the merged page after it when `mergePages` left it short (`dropped` > 0) and
 * there is more, while `rounds` last. The two are consecutive pages of one query, so the first
 * `limit` of both is a page too, and its cursor is that page's own. A read that fails, or is not in
 * within `waitMs` (what is left of the read's deadline), keeps `page`: short, but its cursor skips
 * nothing.
 */
async function toppedUp(
  page: Page<NfxVideo>,
  dropped: number,
  limit: number,
  rounds: number,
  waitMs: number,
  after: (cursor: string) => Promise<Page<NfxVideo>>,
): Promise<Page<NfxVideo>> {
  if (dropped === 0 || rounds <= 0 || page.next === undefined || page.items.length >= limit) {
    return page;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, waitMs);
  });
  let more: Page<NfxVideo> | undefined;
  try {
    more = await Promise.race([after(page.next), late]);
  } catch {
    return page;
  } finally {
    clearTimeout(timer);
  }
  if (more === undefined) return page;
  const listed = new Set(page.items.map((v) => v.id));
  const all = [...page.items, ...more.items.filter((v) => !listed.has(v.id))];
  const items = all.slice(0, limit);
  // `more` covers everything after `page.next`, so its cursor carries on from both, unless the two
  // ran past `limit`: the page then ends at its own last video.
  const next =
    all.length > limit ? (encodeTimeCursor(items.map((v) => v.event)) ?? more.next) : more.next;
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
   * is down never holds a read that already has its answer. That deadline is handed to `merge`, so
   * whatever it still asks (`withdrawnAcross`) ends by it too. Otherwise both are awaited. When one
   * side fails, the other's answer stands, except an empty scoped answer beside a failed read: the
   * read relays' error is then reported, as is any error when both fail. Without scoped relays, the
   * read relays alone, as before.
   */
  private async bothAtOnce<T>(
    read: (relays: readonly RelayUrl[] | undefined) => Promise<T>,
    enough: (t: T) => boolean,
    hasAny: (t: T) => boolean,
    merge: (
      scoped: T,
      fallback: T,
      scopedRelays: readonly RelayUrl[],
      deadline: number | undefined,
    ) => T | Promise<T>,
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
    let deadline: number | undefined;
    if (first.ok && enough(first.value)) {
      deadline = Date.now() + this.mergeGraceMs;
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
      return merge(scoped.value, fallback.value, scopedRelays, deadline);
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
   * `bothAtOnce` for a page of at most `limit` from `cursor`: a page is enough when it is full. The
   * two pages are merged (`mergePages`: one video per address, the newest revision, the scoped copy
   * on a tie, newest first, `limit`), so an empty or short scoped page never shrinks the catalog. A
   * page that withdrawals left short is filled from the pages after it (`toppedUp`), by the same
   * deadline as the deletion checks (the grace's, or one grace from the merge when no full answer
   * started one), so neither holds the page past it. With
   * `emptyStands`, an empty scoped page beside a failed read is that empty page, not the error: the
   * read fails only when every relay set does (the Network feed).
   */
  private async bothAtOncePage(
    read: (
      relays: readonly RelayUrl[] | undefined,
      cursor: string | undefined,
    ) => Promise<Page<NfxVideo>>,
    limit: number,
    cursor: string | undefined,
    emptyStands = false,
    rounds = NFX_TOP_UP_ROUNDS,
  ): Promise<Page<NfxVideo>> {
    // One deadline for what the merge asks after the reads: the deletion checks, then a top-up.
    const after: { by: number; dropped: number } = { by: 0, dropped: 0 };
    const page = await this.bothAtOnce(
      (relays) => read(relays, cursor),
      (p) => p.items.length >= limit,
      (p) => emptyStands || p.items.length > 0,
      async (scoped, fallback, scopedRelays, deadline) => {
        after.by = deadline ?? Date.now() + this.mergeGraceMs;
        const merged = mergePages(
          [scoped, fallback],
          limit,
          await this.withdrawnAcross(scoped.items, fallback.items, scopedRelays, after.by),
        );
        after.dropped = merged.dropped;
        return merged.page;
      },
    );
    const waitMs = Math.max(0, after.by - Date.now());
    return toppedUp(page, after.dropped, limit, rounds, waitMs, (next) =>
      this.bothAtOncePage(read, limit, next, emptyStands, rounds - 1),
    );
  }

  /**
   * The event ids a deletion on the other relay set withdraws (ADR 0026). Each side's page was
   * checked against its own set's deletions only, so a video one side lists and the other does not
   * is asked about on the other set: an author's deletion that reached only the scoped relays (which
   * may then drop the manifest itself) still withdraws the copy a read relay kept. A video both sides
   * list needs no check: the newer revision wins, and each side's deletions are older than its own.
   * Both sets have just answered, but a relay can still stall: a check not done by `deadline` (the
   * read's own, when one set's full answer started the grace; else `mergeGraceMs` from now), or one
   * that fails, withdraws nothing, so an unknown deletion never holds a result past the grace.
   */
  private async withdrawnAcross(
    scoped: readonly NfxVideo[],
    fallback: readonly NfxVideo[],
    scopedRelays: readonly RelayUrl[],
    deadline: number | undefined,
  ): Promise<ReadonlySet<string>> {
    const c = this.client();
    const wait = deadline === undefined ? this.mergeGraceMs : Math.max(0, deadline - Date.now());
    const onlyIn = (xs: readonly NfxVideo[], other: readonly NfxVideo[]): NfxVideo[] => {
      const there = new Set(other.map((v) => v.id));
      return xs.filter((v) => !there.has(v.id));
    };
    const inTime = (check: Promise<Set<string>>): Promise<Set<string>> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<Set<string>>((resolve) => {
        timer = setTimeout(() => {
          resolve(new Set());
        }, wait);
      });
      return Promise.race([check, late]).finally(() => {
        clearTimeout(timer);
      });
    };
    const checks = await Promise.allSettled([
      inTime(nfxWithdrawn(c, this.namespace, onlyIn(fallback, scoped), scopedRelays)),
      inTime(nfxWithdrawn(c, this.namespace, onlyIn(scoped, fallback), undefined)),
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
    const page = (
      relays: readonly RelayUrl[] | undefined,
      cursor: string | undefined,
      authors: readonly NostrPubkey[],
    ): Promise<Page<NfxVideo>> =>
      nfxAuthorsFeed(c, this.namespace, authors, { limit, cursor, relays });
    switch (q.source) {
      case 'subscriptions': {
        if (viewer === null) return { items: [] };
        const { pubkeys } = await fetchSubscriptions(c, viewer);
        if (pubkeys.length === 0) return { items: [] };
        return this.bothAtOncePage(
          (relays, cursor) => page(relays, cursor, pubkeys),
          limit,
          q.cursor,
        );
      }
      case 'tags':
        return this.bothAtOncePage(
          (relays, cursor) =>
            nfxTagsFeed(c, this.namespace, q.tags ?? [], { limit, cursor, relays }),
          limit,
          q.cursor,
        );
      case 'author': {
        const author = q.author;
        if (author === undefined) return { items: [] };
        return this.bothAtOncePage(
          (relays, cursor) => page(relays, cursor, [author]),
          limit,
          q.cursor,
        );
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
   * relays (which carry its mirrors) are both asked at once, with the feeds' grace
   * (`bothAtOncePage`), so a video listed on only one still shows and a stalled set never holds the
   * other's full page. One video is one address, whichever relays held it or how many revisions;
   * the newest wins, and the scoped relays' copy a tie (`mergePages`), unless a deletion on the set
   * that lacks it withdraws it (`withdrawnAcross`). Fails only when every relay set does.
   */
  private networkFeed(
    c: NostrClient,
    opts: { readonly limit: number; readonly cursor: string | undefined },
  ): Promise<Page<NfxVideo>> {
    return this.bothAtOncePage(
      (relays, cursor) =>
        nfxVideoPage(c, this.namespace, {}, { limit: opts.limit, cursor, relays }),
      opts.limit,
      opts.cursor,
      true,
    );
  }

  async search(q: NfxSearchQuery): Promise<Page<NfxVideo>> {
    if (q.text.trim() === '') return { items: [] };
    const c = this.client();
    const supports = oncePerRelay(this.searchSupport);
    const read = (
      relays: readonly RelayUrl[] | undefined,
      cursor: string | undefined = q.cursor,
    ): Promise<Page<NfxVideo>> => {
      const opts = { cursor, limit: NFX_FEED_PAGE, relays };
      return supports === undefined
        ? searchNfxVideos(c, this.namespace, q.text, q.filters ?? {}, opts)
        : searchNfxVideosRouted(c, this.namespace, q.text, q.filters ?? {}, {
            ...opts,
            supports,
          });
    };
    return (await this.scopedSearch(supports))
      ? this.bothAtOncePage(read, NFX_FEED_PAGE, q.cursor)
      : this.publicFirst(
          (relays) => read(relays),
          (p) => p.items.length === 0,
        );
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
      async (scoped, fallback, scopedRelays, deadline) => {
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
          deadline,
        );
        return gone.has(pick.eventId) ? null : pick;
      },
    );
  }
}
