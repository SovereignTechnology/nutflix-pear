/**
 * Live NFX beacons (NFX-03, NFX-04): who seeds a video, read the only way a scoped relay offers.
 *
 * Beacons are kind 20464, ephemeral (NIP-01): a scoped relay forwards them to live subscribers and
 * never stores them (NFX-04: "Beacons stay ephemeral; only kind 38504 is ever persisted"). A
 * one-shot query therefore finds nothing, whatever is being seeded, and a watcher must hold a
 * subscription open until a beacon arrives. Seeders republish at TTL/2 (NFX-03 §3; TTL ≤ 120 s),
 * so one arrives within `NFX_BEACON_WAIT_MS` when anyone seeds the video. The exit run against
 * nfxd's embedded relay found the one-shot query (slice 5f).
 *
 * - **`wait`** (a play opening) holds the video's subscription open and answers as soon as the
 *   beacons seen make `usable` true, or after `ms` with whatever was seen.
 * - **`watch`** (the Watch page loading the video) opens it ahead of the click, so Play usually
 *   finds a beacon already here.
 * - **A small cache:** what arrived stays for `NFX_BEACON_KEEP_S` after its `created_at` (a beacon
 *   lives at most 120 s), so a second rendition or a retry needs no new wait. Bounded: at most
 *   `MAX_BEACON_VIDEOS` videos and `MAX_BEACONS_PER_VIDEO` beacons each, the oldest dropped first.
 * - Events come verified (`NostrClient.subscribe`); a reader still parses each beacon (signature,
 *   TTL, the address) before anything is dialled.
 * - **One subscription per relay, reopened when it closes** (ADR 0026, 2026-11-26): a relay that
 *   cannot be reached, or drops the connection, is asked again after `NFX_BEACON_RETRY_MS`,
 *   doubling up to `NFX_BEACON_RETRY_MAX_MS`, while the video is watched. Before, one subscription
 *   covered every relay and was never reopened, so a relay that was down when the Watch page
 *   opened stayed unheard for the whole watch, even after it came back.
 *
 * Moved from the desktop host into core (ADR 0022) so the web client watches beacons the same
 * way. Runtime-agnostic: the subscription is passed in, and so are timers where the runtime wants
 * them unlike a browser's (the desktop host `unref`s its own, so a quit never waits on a watch).
 */
import type {
  NfxVideo,
  NostrEvent,
  NostrFilter,
  RelayUrl,
  UnixSeconds,
} from '../contracts/index.js';
import { beaconFilter } from '../nfx/beacon.js';

/** One republish interval (NFX-03 §3: TTL/2, TTL ≤ 120 s) and a little slack. */
export const NFX_BEACON_WAIT_MS = 62_000;
/** How long the Watch page's early subscription stays open without a play. */
export const NFX_BEACON_WARM_MS = 90_000;
/** A beacon is kept this long after its `created_at` (its TTL is at most 120 s). */
export const NFX_BEACON_KEEP_S = 120;
export const MAX_BEACON_VIDEOS = 16;
export const MAX_BEACONS_PER_VIDEO = 64;
/** The first wait before a closed relay's subscription is opened again; it doubles each time. */
export const NFX_BEACON_RETRY_MS = 1_000;
export const NFX_BEACON_RETRY_MAX_MS = 30_000;

export interface NfxBeaconWatchDeps {
  /**
   * A live subscription on `relays` (`NostrClient.subscribe`): verified events only. The watcher
   * passes one relay at a time. `onClose`, when the subscription supports it, is called once when
   * the relay closes it or cannot be reached; the watcher then opens it again later.
   */
  readonly subscribe: (
    filter: NostrFilter,
    relays: readonly RelayUrl[],
    onEvent: (ev: NostrEvent) => void,
    onClose?: (reason: string) => void,
  ) => () => void;
  /** Unix seconds. */
  readonly now: () => number;
  /** Default: the runtime's `setTimeout` / `clearTimeout`, as they are. */
  readonly timers?: NfxBeaconWatchTimers | undefined;
}

export interface NfxBeaconWatchTimers {
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (h: unknown) => void;
}

interface Waiter {
  readonly usable: (events: readonly NostrEvent[]) => boolean;
  readonly resolve: (events: NostrEvent[]) => void;
  timer: unknown;
}

interface Watched {
  readonly relaysKey: string;
  readonly events: Map<string, NostrEvent>;
  readonly waiters: Set<Waiter>;
  unsubscribe: (() => void) | null;
  /** When (ms, the timers' clock) the subscription may close if nobody waits. */
  until: number;
  stopTimer: unknown;
}

const runtimeTimers: NfxBeaconWatchTimers = {
  setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clearTimeout: (h: unknown): void => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

export class NfxBeaconWatch {
  private readonly d: NfxBeaconWatchDeps;
  private readonly timers: NfxBeaconWatchTimers;
  /** By video address, oldest first (a Map keeps insertion order; touched ones move last). */
  private readonly videos = new Map<string, Watched>();
  private closed = false;

  constructor(d: NfxBeaconWatchDeps) {
    this.d = d;
    this.timers = d.timers ?? runtimeTimers;
  }

  /** The live beacons seen for `video`, newest first. */
  seen(video: NfxVideo): NostrEvent[] {
    const w = this.videos.get(video.id);
    return w === undefined ? [] : this.live(w);
  }

  /** Hold `video`'s subscription on `relays` open for at least `ms` (the Watch page's warm-up). */
  watch(video: NfxVideo, relays: readonly RelayUrl[], ms = NFX_BEACON_WARM_MS): void {
    if (this.closed || relays.length === 0) return;
    this.open(video, relays, ms);
  }

  /**
   * The beacons seen for `video` once they make `usable` true, or after `ms` with whatever was
   * seen. The subscription stays open meanwhile, and for the warm-up after.
   */
  wait(
    video: NfxVideo,
    relays: readonly RelayUrl[],
    usable: (events: readonly NostrEvent[]) => boolean,
    ms = NFX_BEACON_WAIT_MS,
  ): Promise<NostrEvent[]> {
    if (this.closed || relays.length === 0) return Promise.resolve([]);
    const w = this.open(video, relays, Math.max(ms, NFX_BEACON_WARM_MS));
    const now = this.live(w);
    if (usable(now)) return Promise.resolve(now);
    return new Promise((resolve) => {
      const waiter: Waiter = { usable, resolve, timer: null };
      waiter.timer = this.timers.setTimeout(() => {
        w.waiters.delete(waiter);
        resolve(this.live(w));
      }, ms);
      w.waiters.add(waiter);
    });
  }

  /** Every subscription closes and every wait answers with what it has. */
  close(): void {
    this.closed = true;
    for (const w of this.videos.values()) {
      this.stop(w);
      for (const waiter of [...w.waiters]) {
        this.timers.clearTimeout(waiter.timer);
        w.waiters.delete(waiter);
        waiter.resolve(this.live(w));
      }
    }
    this.videos.clear();
  }

  private open(video: NfxVideo, relays: readonly RelayUrl[], ms: number): Watched {
    const relaysKey = [...relays].sort().join(' ');
    let w = this.videos.get(video.id);
    if (w !== undefined && w.relaysKey !== relaysKey) {
      // The network's relays changed: what the old ones said is kept, read anew from the new.
      this.stop(w);
      w = { ...w, relaysKey, unsubscribe: null, stopTimer: null };
    }
    w ??= {
      relaysKey,
      events: new Map(),
      waiters: new Set(),
      unsubscribe: null,
      until: 0,
      stopTimer: null,
    };
    // Most recently used last; the oldest idle one goes when there are too many.
    this.videos.delete(video.id);
    this.videos.set(video.id, w);
    this.evict();
    const watched = w;
    if (watched.unsubscribe === null) {
      const filter: NostrFilter = {
        ...beaconFilter(video),
        since: Math.max(0, this.d.now() - NFX_BEACON_KEEP_S) as UnixSeconds,
      };
      watched.unsubscribe = this.subscribeEach(watched, filter, relays);
    }
    this.keepOpen(watched, ms);
    return watched;
  }

  /**
   * One subscription per relay. When one closes (the relay down, unreachable, or dropping the
   * socket) it is opened again after a backoff, doubling from `NFX_BEACON_RETRY_MS` to
   * `NFX_BEACON_RETRY_MAX_MS`, and back to the start once that relay has sent a beacon. The
   * returned function closes them all and cancels any pending reopen.
   */
  private subscribeEach(w: Watched, filter: NostrFilter, relays: readonly RelayUrl[]): () => void {
    let stopped = false;
    const subs = new Map<RelayUrl, () => void>();
    const pending = new Set<unknown>();
    const start = (relay: RelayUrl, attempt: number): void => {
      if (stopped || this.closed) return;
      let heard = false;
      // An object, not a `let`: the close may be reported before `subscribe` returns.
      const ended = { closed: false };
      const un = this.d.subscribe(
        filter,
        [relay],
        (ev) => {
          heard = true;
          this.add(w, ev);
        },
        () => {
          if (ended.closed || stopped || this.closed) return;
          ended.closed = true;
          // Release what is left of it (a no-op on a pool that already closed it).
          const own = subs.get(relay);
          subs.delete(relay);
          own?.();
          // The first wait after a relay that sent beacons, else doubling per close in a row.
          const next = heard ? 0 : attempt + 1;
          const delay = Math.min(
            NFX_BEACON_RETRY_MAX_MS,
            NFX_BEACON_RETRY_MS * 2 ** Math.max(0, next - 1),
          );
          const h = this.timers.setTimeout(() => {
            pending.delete(h);
            start(relay, next);
          }, delay);
          pending.add(h);
        },
      );
      if (ended.closed) un();
      else subs.set(relay, un);
    };
    for (const relay of new Set(relays)) start(relay, 0);
    return () => {
      stopped = true;
      for (const h of pending) this.timers.clearTimeout(h);
      pending.clear();
      for (const un of subs.values()) un();
      subs.clear();
    };
  }

  private add(w: Watched, ev: NostrEvent): void {
    if (this.closed || w.events.has(ev.id)) return;
    w.events.set(ev.id, ev);
    if (w.events.size > MAX_BEACONS_PER_VIDEO) {
      const oldest = [...w.events.values()].sort((a, b) => a.created_at - b.created_at)[0];
      if (oldest !== undefined) w.events.delete(oldest.id);
    }
    const now = this.live(w);
    for (const waiter of [...w.waiters]) {
      if (!waiter.usable(now)) continue;
      this.timers.clearTimeout(waiter.timer);
      w.waiters.delete(waiter);
      waiter.resolve(now);
    }
  }

  /** Newest first, without the ones past `NFX_BEACON_KEEP_S` (dropped from the cache too). */
  private live(w: Watched): NostrEvent[] {
    const cutoff = this.d.now() - NFX_BEACON_KEEP_S;
    for (const [id, ev] of w.events) if (ev.created_at < cutoff) w.events.delete(id);
    return [...w.events.values()].sort((a, b) => b.created_at - a.created_at);
  }

  private keepOpen(w: Watched, ms: number): void {
    const at = Date.now() + ms;
    if (at <= w.until && w.stopTimer !== null) return;
    w.until = at;
    if (w.stopTimer !== null) this.timers.clearTimeout(w.stopTimer);
    const arm = (delay: number): void => {
      w.stopTimer = this.timers.setTimeout(() => {
        w.stopTimer = null;
        // A play still waiting keeps it open: it ends with that wait's own timer.
        if (w.waiters.size > 0) {
          arm(1_000);
          return;
        }
        this.stop(w);
      }, delay);
    };
    arm(ms);
  }

  private stop(w: Watched): void {
    if (w.stopTimer !== null) {
      this.timers.clearTimeout(w.stopTimer);
      w.stopTimer = null;
    }
    const un = w.unsubscribe;
    w.unsubscribe = null;
    un?.();
  }

  private evict(): void {
    while (this.videos.size > MAX_BEACON_VIDEOS) {
      const idle = [...this.videos.entries()].find(([, w]) => w.waiters.size === 0);
      if (idle === undefined) return;
      this.stop(idle[1]);
      this.videos.delete(idle[0]);
    }
  }
}
