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
 * - Events come verified (`NostrClient.subscribe`); `beaconPeers` still parses each (signature,
 *   TTL, the address) before anything is dialled.
 */
import type { NfxVideo, NostrEvent, NostrFilter, RelayUrl, UnixSeconds } from '@sovit/core';

import { beaconFilter } from './play.js';

/** One republish interval (NFX-03 §3: TTL/2, TTL ≤ 120 s) and a little slack. */
export const NFX_BEACON_WAIT_MS = 62_000;
/** How long the Watch page's early subscription stays open without a play. */
export const NFX_BEACON_WARM_MS = 90_000;
/** A beacon is kept this long after its `created_at` (its TTL is at most 120 s). */
export const NFX_BEACON_KEEP_S = 120;
export const MAX_BEACON_VIDEOS = 16;
export const MAX_BEACONS_PER_VIDEO = 64;

export interface NfxBeaconWatchDeps {
  /** A live subscription on `relays` (`NostrClient.subscribe`): verified events only. */
  readonly subscribe: (
    filter: NostrFilter,
    relays: readonly RelayUrl[],
    onEvent: (ev: NostrEvent) => void,
  ) => () => void;
  /** Unix seconds. */
  readonly now: () => number;
  readonly timers?: {
    readonly setTimeout: (fn: () => void, ms: number) => unknown;
    readonly clearTimeout: (h: unknown) => void;
  };
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

const realTimers = {
  // Never what keeps the process alive: a quit closes the watch anyway.
  setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms).unref(),
  clearTimeout: (h: unknown): void => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

export class NfxBeaconWatch {
  private readonly d: NfxBeaconWatchDeps;
  private readonly timers: NonNullable<NfxBeaconWatchDeps['timers']>;
  /** By video address, oldest first (a Map keeps insertion order; touched ones move last). */
  private readonly videos = new Map<string, Watched>();
  private closed = false;

  constructor(d: NfxBeaconWatchDeps) {
    this.d = d;
    this.timers = d.timers ?? realTimers;
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
      watched.unsubscribe = this.d.subscribe(filter, relays, (ev) => {
        this.add(watched, ev);
      });
    }
    this.keepOpen(watched, ms);
    return watched;
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
