/**
 * `--dev-fixtures` catalogue (design §5(a)). DEV ONLY and refused unless `--dev-mocks` is on
 * too (`host.ts`): it serves core's mock fixture manifests plus the LIVE manifests the worker
 * announces in its `dev.fixtures` event (cores it actually seeds on its dev network). None of
 * these are signed events — they bypass `verifyIncoming` by construction — so every use is
 * logged loudly, and nothing here is reachable in a production run.
 *
 * Boot race: the worker announces its fixtures only after it has built its dev network (about
 * a second after start, more for big files), and the Home screen fetches its feed once, at
 * mount. So reads that depend on the live set WAIT for the first `dev.fixtures` — bounded by
 * `FIXTURE_WAIT_MS` from construction, and cut short when the worker fails for good or is
 * stopped — then answer with whatever is there (logged once). `profile()` never reads the live
 * set and does not wait.
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
import { mocks } from '@sovit/core';

import type { Logger } from '../log.js';
import type { Timers } from '../worker/supervisor.js';
import type { CatalogSource, SearchQuery } from './catalog.js';
import { FEED_PAGE } from './catalog.js';

/** Upper bound (ms, from construction) on the wait for the worker's first `dev.fixtures`. */
export const FIXTURE_WAIT_MS = 15_000;

export interface FixtureCatalogOptions {
  /** The wait bound, ms; clamped to `[0, FIXTURE_WAIT_MS]`. */
  readonly waitMs?: number;
  readonly timers?: Timers;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

function paginate<T>(items: readonly T[], cursor: string | undefined, limit: number): Page<T> {
  const start = cursor !== undefined && /^\d{1,9}$/.test(cursor) ? Number(cursor) : 0;
  const slice = items.slice(start, start + limit);
  const end = start + slice.length;
  return end < items.length ? { items: slice, next: String(end) } : { items: slice };
}

export class FixtureCatalog implements CatalogSource {
  private readonly log: Logger;
  private live: readonly VideoManifest[] = [];
  private readonly liveIds = new Set<string>();
  private readonly timers: Timers;
  private timer: unknown;
  /** Pending until the first `dev.fixtures`, the bound, or the worker going away. */
  private readonly settled: Promise<void>;
  private settle: (() => void) | null;

  constructor(log: Logger, o: FixtureCatalogOptions = {}) {
    this.log = log.child('dev-fixtures');
    this.log.warn('DEV FIXTURES ON: serving UNSIGNED fixture manifests (never in production)');
    this.timers = o.timers ?? realTimers;
    let resolve: () => void = () => undefined;
    this.settled = new Promise<void>((r) => {
      resolve = r;
    });
    this.settle = resolve;
    const waitMs = Math.min(FIXTURE_WAIT_MS, Math.max(0, o.waitMs ?? FIXTURE_WAIT_MS));
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.stopWaiting('dev fixtures: none from the worker in time; serving the mock catalogue', {
        waitMs,
      });
    }, waitMs);
  }

  /** Whether reads still wait for the worker's first `dev.fixtures`. */
  get waiting(): boolean {
    return this.settle !== null;
  }

  /** The worker's `dev.fixtures` event: replaces the live set (and ends the wait). */
  setLive(videos: readonly VideoManifest[]): void {
    this.live = videos;
    this.liveIds.clear();
    for (const v of videos) this.liveIds.add(v.id);
    this.log.warn('dev fixtures: live manifests from the worker (unsigned)', {
      count: videos.length,
    });
    this.stopWaiting();
  }

  /** The worker failed for good or was stopped: its fixtures are not coming, stop waiting. */
  workerGone(): void {
    this.stopWaiting('dev fixtures: the media worker is gone; serving the mock catalogue');
  }

  /** Ends the wait once; `why` is logged only if it was still pending. */
  private stopWaiting(why?: string, fields?: Readonly<Record<string, number>>): void {
    const settle = this.settle;
    if (settle === null) return;
    this.settle = null;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    if (why !== undefined) this.log.warn(why, fields);
    settle();
  }

  /** `fn` once the live set is known (or known not to be coming). */
  private async afterWait<T>(fn: () => T): Promise<T> {
    if (this.settle !== null) await this.settled;
    return fn();
  }

  private all(): VideoManifest[] {
    const seen = new Set(this.liveIds);
    return [...this.live, ...mocks.VIDEOS.filter((v) => !seen.has(v.id))];
  }

  /** Contracts v9: the mock NFX videos join the feeds a merged catalogue lists them in. */
  private withNfx(): CatalogVideo[] {
    return [...this.all(), ...mocks.NFX_VIDEOS];
  }

  feed(q: FeedQuery, viewer: NostrPubkey | null): Promise<Page<CatalogVideo>> {
    return this.afterWait(() => this.feedNow(q, viewer));
  }

  private feedNow(q: FeedQuery, viewer: NostrPubkey | null): Page<CatalogVideo> {
    let items: CatalogVideo[] = this.all();
    switch (q.source) {
      case 'subscriptions':
        items = viewer === null ? [] : this.withNfx().filter((v) => v.kind !== 22);
        break;
      case 'trending':
        // Live (playable) first, then the mock fixtures in their own order.
        items = items.filter((v) => v.kind === 21);
        break;
      case 'tags':
        items = this.withNfx().filter((v) => v.tags.some((t) => q.tags?.includes(t)));
        break;
      case 'author':
        items = this.withNfx().filter((v) => v.author === q.author);
        break;
      case 'shorts':
        items = items.filter((v) => v.kind === 22);
        break;
    }
    return paginate(items, q.cursor, q.limit ?? FEED_PAGE);
  }

  video(id: NostrEventId): Promise<VideoManifest | null> {
    return this.afterWait(() => this.all().find((v) => v.id === id) ?? null);
  }

  nfxVideo(addr: NfxAddress): Promise<NfxVideo | null> {
    return Promise.resolve(mocks.NFX_VIDEOS.find((v) => v.id === addr) ?? null);
  }

  videos(ids: readonly NostrEventId[]): Promise<VideoManifest[]> {
    return this.afterWait(() => {
      const byId = new Map(this.all().map((v) => [v.id as string, v]));
      return [...new Set(ids)].flatMap((id) => {
        const v = byId.get(id);
        return v ? [v] : [];
      });
    });
  }

  related(id: NostrEventId, limit: number): Promise<readonly VideoManifest[]> {
    return this.afterWait(() => {
      const all = this.all();
      const v = all.find((x) => x.id === id);
      if (!v) return [];
      const score = (o: VideoManifest): number =>
        (o.author === v.author ? 2 : 0) + o.tags.filter((t) => v.tags.includes(t)).length;
      return all
        .filter((o) => o.id !== id)
        .sort((a, b) => score(b) - score(a))
        .slice(0, limit);
    });
  }

  search(q: SearchQuery): Promise<Page<CatalogVideo>> {
    return this.afterWait(() => {
      const needle = q.text.trim().toLowerCase();
      const items =
        needle === ''
          ? []
          : this.withNfx().filter(
              (v) =>
                v.title.toLowerCase().includes(needle) || v.tags.some((t) => t.includes(needle)),
            );
      return paginate(items, q.cursor, FEED_PAGE);
    });
  }

  profile(pubkey: NostrPubkey): Promise<Profile | null> {
    if (pubkey === mocks.ME) return Promise.resolve(mocks.MY_PROFILE);
    return Promise.resolve(mocks.CHANNELS.find((c) => c.pubkey === pubkey)?.profile ?? null);
  }

  /** Live fixtures are seeded by the worker's own dev network; mock fixtures by nobody. */
  seedersOnline(video: VideoManifest): Promise<number> {
    return this.afterWait(() => (this.liveIds.has(video.id) ? 1 : 0));
  }
}
