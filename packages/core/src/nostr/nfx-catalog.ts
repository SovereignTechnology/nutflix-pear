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
import { decodeTimeCursor, timeCursor } from './cursor.js';
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

/** One relay set's page of a query: `relays` (`undefined`: the read relays), from `cursor`. */
type PageRead = (
  relays: readonly RelayUrl[] | undefined,
  cursor: string | undefined,
  limit: number,
) => Promise<Page<NfxVideo>>;

/**
 * Pages of one query from different relay sets, as one page: one video per address, the newest
 * revision winning and, at the same `created_at`, the earlier page's copy (callers pass the scoped
 * relays' page first, so the network's own copy wins a tie); newest first, at most `limit`;
 * `withdrawn` revisions are left out, and `dropped` counts what was left out for them or for
 * `floor`.
 *
 * **The cursor never passes a set's unread videos, and never repeats.** A page with `next` was read
 * only down to its cursor's `until` (a full page's oldest video, or how far a search scan read,
 * even with no match), so nothing older than the newest such floor is listed here. Without a
 * withdrawal that cuts nothing (a full page alone fills `limit` above its own floor); with one, the
 * page comes out short. A full page's cursor is its last video's second; a short one's is the
 * floor, since everything above it was listed or withdrawn. Either way the cursor skips, at that
 * second, every id the page accounts for: listed, withdrawn, or a revision a listed one replaced,
 * plus the incoming `cursor`'s own at the same second and, on a short page (where `limit` cut
 * nothing), the sets' own cursors' there. So the next page starts where this one ended, and an
 * empty one still moves on.
 */
export function mergeNfxPages(
  pages: readonly Page<NfxVideo>[],
  limit: number,
  withdrawn: ReadonlySet<string> = new Set(),
  cursor?: string,
): { readonly page: Page<NfxVideo>; readonly dropped: number } {
  let floor: number | undefined;
  for (const p of pages) {
    if (p.next === undefined) continue;
    const at =
      decodeTimeCursor(p.next)?.until ??
      (p.items.length === 0 ? undefined : Math.min(...p.items.map((v) => v.event.created_at)));
    if (at !== undefined && (floor === undefined || at > floor)) floor = at;
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
  const cut = floor;
  const all = cut === undefined ? unique : unique.filter((v) => v.event.created_at >= cut);
  dropped += unique.length - all.length;
  const items = all.slice(0, limit);
  if (all.length <= limit && pages.every((p) => p.next === undefined)) {
    return { page: { items }, dropped };
  }
  const short = items.length < limit;
  const until = short && floor !== undefined ? floor : items.at(-1)?.event.created_at;
  if (until === undefined) {
    // Only a set whose cursor is not a time cursor has more: carry on from it, as before.
    const next = pages.find((p) => p.next !== undefined)?.next;
    return { page: next === undefined ? { items } : { items, next }, dropped };
  }
  const listed = new Set(items.map((v) => v.id));
  const skip = new Set<string>();
  for (const v of pages.flatMap((p) => p.items)) {
    if (v.event.created_at === until && (withdrawn.has(v.eventId) || listed.has(v.id))) {
      skip.add(v.eventId);
    }
  }
  for (const c of [cursor, ...(short ? pages.map((p) => p.next) : [])]) {
    const t = decodeTimeCursor(c);
    if (t?.until === until) for (const id of t.seen) skip.add(id);
  }
  return { page: { items, next: timeCursor(until, skip) }, dropped };
}

/** `work`'s answer, or `undefined` when it fails or is not in within `ms`. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
  });
  try {
    return await Promise.race([work, late]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `page`, filled from the merged page after it when `mergeNfxPages` left it short (`dropped` > 0)
 * and there is more, while `rounds` last. `after` reads the next page for the room left, from
 * `page`'s cursor, so the two are consecutive pages of one query and the second's cursor carries on
 * from both. It answers `undefined` unless every relay set answered it: one set's page alone would
 * move the cursor past the other's unread videos. That, a failure, or no answer within `waitMs`
 * (what is left of the read's deadline) keeps `page`: short, but its cursor skips nothing.
 */
async function toppedUp(
  page: Page<NfxVideo>,
  dropped: number,
  limit: number,
  rounds: number,
  waitMs: number,
  after: (cursor: string, room: number) => Promise<Page<NfxVideo> | undefined>,
): Promise<Page<NfxVideo>> {
  if (dropped === 0 || rounds <= 0 || page.next === undefined || page.items.length >= limit) {
    return page;
  }
  const more = await within(after(page.next, limit - page.items.length), waitMs);
  if (more === undefined) return page;
  const listed = new Set(page.items.map((v) => v.id));
  const items = [...page.items, ...more.items.filter((v) => !listed.has(v.id))];
  return more.next === undefined ? { items } : { items, next: more.next };
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
   * two pages are merged (`mergeNfxPages`: one video per address, the newest revision, the scoped
   * copy on a tie, newest first, `limit`, a cursor that skips nothing), so an empty or short scoped
   * page never shrinks the catalog. A page that withdrawals left short is filled from the pages
   * after it (`toppedUp`), by the same deadline as the deletion checks (the grace's, or one grace
   * from the merge when no full answer started one), so neither holds the page past it. With
   * `emptyStands`, an empty scoped page beside a failed read is that empty page, not the error: the
   * read fails only when every relay set does (the Network feed).
   */
  private async bothAtOncePage(
    read: PageRead,
    limit: number,
    cursor: string | undefined,
    emptyStands = false,
  ): Promise<Page<NfxVideo>> {
    return (await this.mergedPage(read, limit, cursor, emptyStands, NFX_TOP_UP_ROUNDS)).page;
  }

  /** `bothAtOncePage`, and whether every relay set answered it (`whole`). */
  private async mergedPage(
    read: PageRead,
    limit: number,
    cursor: string | undefined,
    emptyStands: boolean,
    rounds: number,
  ): Promise<{ readonly page: Page<NfxVideo>; readonly whole: boolean }> {
    const alone = this.scopedRelays().length === 0;
    // One deadline for what the merge asks after the reads: the deletion checks, then a top-up.
    const after = { by: 0, dropped: 0, merged: false };
    const page = await this.bothAtOnce(
      (relays) => read(relays, cursor, limit),
      (p) => p.items.length >= limit,
      (p) => emptyStands || p.items.length > 0,
      async (scoped, fallback, scopedRelays, deadline) => {
        after.merged = true;
        after.by = deadline ?? Date.now() + this.mergeGraceMs;
        const merged = mergeNfxPages(
          [scoped, fallback],
          limit,
          await this.withdrawnAcross(scoped.items, fallback.items, scopedRelays, after.by),
          cursor,
        );
        after.dropped = merged.dropped;
        return merged.page;
      },
    );
    const filled = await toppedUp(
      page,
      after.dropped,
      limit,
      rounds,
      Math.max(0, after.by - Date.now()),
      async (next, room) => {
        const more = await this.mergedPage(read, room, next, emptyStands, rounds - 1);
        return more.whole ? more.page : undefined;
      },
    );
    return { page: filled, whole: alone || after.merged };
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
    const checks = await Promise.all([
      within(nfxWithdrawn(c, this.namespace, onlyIn(fallback, scoped), scopedRelays), wait),
      within(nfxWithdrawn(c, this.namespace, onlyIn(scoped, fallback), undefined), wait),
    ]);
    return new Set(checks.flatMap((ids) => [...(ids ?? [])]));
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
    const page =
      (authors: readonly NostrPubkey[]): PageRead =>
      (relays, cursor, size) =>
        nfxAuthorsFeed(c, this.namespace, authors, { limit: size, cursor, relays });
    switch (q.source) {
      case 'subscriptions': {
        if (viewer === null) return { items: [] };
        const { pubkeys } = await fetchSubscriptions(c, viewer);
        if (pubkeys.length === 0) return { items: [] };
        return this.bothAtOncePage(page(pubkeys), limit, q.cursor);
      }
      case 'tags':
        return this.bothAtOncePage(
          (relays, cursor, size) =>
            nfxTagsFeed(c, this.namespace, q.tags ?? [], { limit: size, cursor, relays }),
          limit,
          q.cursor,
        );
      case 'author': {
        const author = q.author;
        if (author === undefined) return { items: [] };
        return this.bothAtOncePage(page([author]), limit, q.cursor);
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
   * the newest wins, and the scoped relays' copy a tie (`mergeNfxPages`), unless a deletion on the set
   * that lacks it withdraws it (`withdrawnAcross`). Fails only when every relay set does.
   */
  private networkFeed(
    c: NostrClient,
    opts: { readonly limit: number; readonly cursor: string | undefined },
  ): Promise<Page<NfxVideo>> {
    return this.bothAtOncePage(
      (relays, cursor, size) =>
        nfxVideoPage(c, this.namespace, {}, { limit: size, cursor, relays }),
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
      size: number = NFX_FEED_PAGE,
    ): Promise<Page<NfxVideo>> => {
      const opts = { cursor, limit: size, relays };
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

  async twinsOf(
    legacy: readonly { readonly id: NostrEventId; readonly author: NostrPubkey }[],
  ): Promise<NfxVideo[]> {
    if (legacy.length === 0) return [];
    // Copies on the scoped relays only: a copy only the read relays hold may sit past a page the
    // scoped relays fill, and then its NIP-71 video must stay (a duplicate, never a gap). Scoped
    // relays down: this fails, and the merged catalogue lists both. The feeds also take the read
    // relays' deletions (ADR 0026, `withdrawnAcross`), so a copy one of those withdraws is no copy:
    // it is asked about there, within the grace, and an unknown answer hides nothing.
    const c = this.client();
    const scoped = this.scopedRelays();
    if (scoped.length === 0) return nfxTwinsOf(c, this.namespace, legacy, {});
    const twins = await nfxTwinsOf(c, this.namespace, legacy, { relays: scoped });
    if (twins.length === 0) return twins;
    const gone = await within(nfxWithdrawn(c, this.namespace, twins, undefined), this.mergeGraceMs);
    return gone === undefined ? [] : twins.filter((v) => !gone.has(v.eventId));
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
