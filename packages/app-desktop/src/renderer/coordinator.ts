/**
 * The playback coordinator (SE-2/SE-3; design §4). ONE per app. It wraps the adapter ONCE
 * (stable identity for every screen) and owns every `PlaySession` the screens open:
 *
 *   - `play()` / `switchRendition()` register the session with an OWNER: the screen instance
 *     mounted when the call was made (`screenMounted(key)`), or the mini-player;
 *   - at most ONE session is unpaused: a new session, and every wrapped `resume()`, pauses all
 *     others (a rendition switch's replacement does not pause its predecessor — the screen
 *     closes that one itself);
 *   - Watch's `onMiniPlayer` hand-off (`handOff`) moves ownership to the mini-player, closing
 *     whatever the mini-player held; a hand-off for a video other than the watch route being
 *     navigated to (watch → watch REMOUNT) is closed instead;
 *   - Shorts' `onPlaybackStart` pauses the mini-player (`pauseMini`);
 *   - dismissing the mini-player closes its session; expanding it (`expandMini`) returns the
 *     `WatchHandoff` to pass as Watch's `resumeSession` and gives ownership back to a screen;
 *   - after each route commit (`routeCommitted`) every session owned by neither the mounted
 *     screen nor the mini-player is closed — nothing leaks, whatever a screen forgot.
 *
 * The host adds its own backstop (≤ 1 unpaused session per webContents, `wc-gone` closes all).
 * Framework-free: React code subscribes with `subscribe()` and reads `snapshot()`.
 */
import type { NetworkAdapter, NostrEventId, PlaySession, Unsubscribe } from '@sovit/core';
import type { Route, WatchHandoff } from '@sovit/ui';

type Owner =
  | { readonly kind: 'screen'; readonly key: number }
  | { readonly kind: 'mini' }
  /** Handed back by `expandMini`, waiting for the watch route to commit. */
  | { readonly kind: 'adopting'; readonly videoId: NostrEventId };

interface Entry {
  readonly id: number;
  /** The adapter's session (what the coordinator drives). */
  readonly inner: PlaySession;
  /** What screens hold (what the coordinator hands out and recognises). */
  readonly outer: PlaySession;
  /** Rendition-switch lineage: a switch's replacement shares it and never pauses it. */
  readonly lineage: number;
  owner: Owner;
  paused: boolean;
  closed: boolean;
  ratePerMin: number;
  unsubSpend: Unsubscribe | undefined;
}

export interface MiniState {
  readonly handoff: WatchHandoff;
  /** The coordinator's view: `true` = the session is paused (not paying). */
  readonly paused: boolean;
}

export interface CoordinatorSnapshot {
  readonly mini: MiniState | null;
  /** Sessions open (registered and not closed). */
  readonly open: number;
  /** Open sessions that are not paused. Invariant: ≤ 1 outside a rendition switch. */
  readonly unpaused: number;
  /** sats/min of the unpaused session(s), for the header's WalletChip. 0 = not streaming. */
  readonly ratePerMin: number;
}

export interface CoordinatorOptions {
  /**
   * Pause the page's own `<video>` elements (not the mini-player's) — used when the
   * mini-player resumes over a screen whose session the coordinator just paused, so the
   * screen's element follows its (now paused) session. Watch and Shorts hear that element
   * pause, call their (already paused, so no-op) `session.pause()` and show "Paused — not
   * paying". Default: none.
   */
  readonly pauseScreenMedia?: () => void;
}

function closeQuietly(s: PlaySession): void {
  s.close().catch(() => undefined);
}

export class PlaybackCoordinator {
  private readonly entries = new Map<number, Entry>();
  private readonly byOuter = new WeakMap<PlaySession, Entry>();
  private nextId = 1;
  private screenKey = 0;
  private requested: Route | undefined;
  private mini: { entry: Entry; handoff: WatchHandoff; positionSec: number } | null = null;
  private readonly listeners = new Set<() => void>();
  private snap: CoordinatorSnapshot = { mini: null, open: 0, unpaused: 0, ratePerMin: 0 };
  private wrapped: { source: NetworkAdapter; adapter: NetworkAdapter } | undefined;

  constructor(private readonly opts: CoordinatorOptions = {}) {}

  // ---- the adapter ------------------------------------------------------------------------

  /** Wraps `adapter` once; the same wrapper comes back for the same adapter. */
  wrap(adapter: NetworkAdapter): NetworkAdapter {
    if (this.wrapped?.source === adapter) return this.wrapped.adapter;
    const a = adapter;
    const wrapped: NetworkAdapter = {
      platform: a.platform,
      wallet: a.wallet,
      library: a.library,
      studio: a.studio,
      seeder: a.seeder,
      signer: () => a.signer(),
      me: () => a.me(),
      profile: (pk) => a.profile(pk),
      setProfilePicture: (image) => a.setProfilePicture(image),
      feed: (q) => a.feed(q),
      video: (id) => a.video(id),
      nfxVideo: (addr) => a.nfxVideo(addr),
      stats: (id) => a.stats(id),
      related: (id, limit) => (limit === undefined ? a.related(id) : a.related(id, limit)),
      search: (q) => a.search(q),
      comments: (id, sort, cursor) =>
        cursor === undefined ? a.comments(id, sort) : a.comments(id, sort, cursor),
      comment: (id, content, parent) =>
        parent === undefined ? a.comment(id, content) : a.comment(id, content, parent),
      react: (id, r) => a.react(id, r),
      unreact: (id) => a.unreact(id),
      nutzap: (id, amount, mint, comment) =>
        comment === undefined ? a.nutzap(id, amount, mint) : a.nutzap(id, amount, mint, comment),
      subscribe: (pk) => a.subscribe(pk),
      unsubscribe: (pk) => a.unsubscribe(pk),
      subscriptions: () => a.subscriptions(),
      report: (id, reason) => a.report(id, reason),
      play: (id, rendition) => this.play(a, id, rendition),
      image: (url, sha) => (sha === undefined ? a.image(url) : a.image(url, sha)),
      settings: () => a.settings(),
      updateSettings: (p) => a.updateSettings(p),
      notifications: (cb) => a.notifications(cb),
    };
    this.wrapped = { source: adapter, adapter: wrapped };
    return wrapped;
  }

  // ---- routing hooks (the shell calls these) ----------------------------------------------

  /** A screen instance is mounted (from a layout effect, before any screen effect runs). */
  screenMounted(key: number): void {
    this.screenKey = key;
  }

  /** A navigation was requested (before React renders it). */
  routeRequested(route: Route): void {
    this.requested = route;
  }

  /**
   * The route is committed (from a passive effect, after unmounted screens handed off): close
   * everything owned by neither the mounted screen nor the mini-player.
   */
  routeCommitted(route: Route): void {
    this.requested = route;
    for (const e of [...this.entries.values()]) {
      const o = e.owner;
      if (o.kind === 'adopting') {
        if (route.name === 'watch' && route.videoId === o.videoId) {
          e.owner = { kind: 'screen', key: this.screenKey };
        } else void this.close(e);
      } else if (o.kind === 'screen' && o.key !== this.screenKey) void this.close(e);
    }
    this.publish();
  }

  // ---- mini-player -------------------------------------------------------------------------

  /** Watch's `onMiniPlayer(session, videoId, handoff)`. */
  readonly handOff = (session: PlaySession, videoId: NostrEventId, handoff: WatchHandoff): void => {
    const e = this.byOuter.get(session);
    if (e === undefined || e.closed) {
      // Not one of ours (or already closed): never keep a stray paying session.
      closeQuietly(session);
      return;
    }
    const r = this.requested;
    if (r?.name === 'watch' && r.videoId !== videoId) {
      // watch → watch remount: the old video's session is stale, not a mini-player.
      void this.close(e);
      this.publish();
      return;
    }
    const prev = this.mini;
    if (prev !== null && prev.entry !== e) void this.close(prev.entry);
    // `e.paused` stays the coordinator's own record (the transport's state), not the
    // hand-off's player status (which reads "paused" while merely buffering).
    e.owner = { kind: 'mini' };
    this.mini = {
      entry: e,
      handoff: { ...handoff, session: e.outer },
      positionSec: handoff.positionSec,
    };
    this.publish();
  };

  /** Shorts' `onPlaybackStart`: the mini-player stops paying. */
  readonly pauseMini = (): void => {
    const m = this.mini;
    if (m === null || m.entry.paused) return;
    this.pauseEntry(m.entry);
    this.publish();
  };

  /** The mini-player's play button: its session becomes the one paying. */
  readonly resumeMini = (): void => {
    const m = this.mini;
    if (m === null) return;
    const others = this.pauseOthers(m.entry);
    if (others > 0) this.opts.pauseScreenMedia?.();
    m.entry.paused = false;
    m.entry.inner.resume();
    this.publish();
  };

  /** The mini-player reports its element's position (for expand and back-navigation). */
  readonly miniProgress = (positionSec: number): void => {
    if (this.mini === null || !Number.isFinite(positionSec)) return;
    this.mini.positionSec = positionSec;
  };

  /** Dismiss: the mini-player's session is closed. */
  readonly dismissMini = (): void => {
    const m = this.mini;
    if (m === null) return;
    this.mini = null;
    void this.close(m.entry);
    this.publish();
  };

  /**
   * Expand: the `WatchHandoff` for Watch's `resumeSession` (updated position/paused), or null.
   * The session waits in "adopting" until the watch route for its video commits.
   */
  expandMini(update?: {
    readonly positionSec?: number;
    readonly paused?: boolean;
  }): WatchHandoff | null {
    const m = this.mini;
    if (m === null) return null;
    this.mini = null;
    const handoff: WatchHandoff = {
      ...m.handoff,
      positionSec: update?.positionSec ?? m.positionSec,
      paused: update?.paused ?? m.entry.paused,
    };
    m.entry.owner = { kind: 'adopting', videoId: handoff.videoId };
    this.publish();
    return handoff;
  }

  /** True while `session` is open and not held by the mini-player (safe to pass as `resumeSession`). */
  canResume(session: PlaySession): boolean {
    const e = this.byOuter.get(session);
    return e !== undefined && !e.closed && e.owner.kind !== 'mini';
  }

  // ---- state for React ---------------------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): CoordinatorSnapshot {
    return this.snap;
  }

  // ---- internals ---------------------------------------------------------------------------

  private async play(
    a: NetworkAdapter,
    id: NostrEventId,
    rendition?: string,
  ): Promise<PlaySession> {
    const owner: Owner = { kind: 'screen', key: this.screenKey };
    const inner = rendition === undefined ? await a.play(id) : await a.play(id, rendition);
    const e = this.register(inner, owner, undefined);
    if (owner.key !== this.screenKey) {
      // The screen that asked is gone: its session must not outlive it.
      void this.close(e);
      this.publish();
    }
    return e.outer;
  }

  private register(inner: PlaySession, owner: Owner, from: Entry | undefined): Entry {
    const id = this.nextId++;
    const entry: Entry = {
      id,
      inner,
      outer: undefined as unknown as PlaySession,
      lineage: from?.lineage ?? id,
      owner,
      paused: false,
      closed: false,
      ratePerMin: 0,
      unsubSpend: undefined,
    };
    const outer: PlaySession = {
      videoId: inner.videoId,
      rendition: inner.rendition,
      source: inner.source,
      policy: inner.policy,
      onPeers: (cb) => inner.onPeers(cb),
      onSpend: (cb) => inner.onSpend(cb),
      setPrefetchSeconds: (sec) => {
        inner.setPrefetchSeconds(sec);
      },
      pause: () => {
        if (entry.closed) return;
        this.pauseEntry(entry);
        this.publish();
      },
      resume: () => {
        if (entry.closed) return;
        this.pauseOthers(entry);
        entry.paused = false;
        inner.resume();
        this.publish();
      },
      switchRendition: async (label) => {
        const next = await inner.switchRendition(label);
        const ne = this.register(next, entry.owner, entry);
        this.publish();
        return ne.outer;
      },
      close: async () => {
        if (entry.closed) return;
        const done = this.close(entry);
        this.publish();
        await done;
      },
    };
    (entry as { outer: PlaySession }).outer = outer;
    this.entries.set(id, entry);
    this.byOuter.set(outer, entry);
    // A new session is the one paying: pause every other (except its own lineage).
    this.pauseOthers(entry);
    try {
      entry.unsubSpend = inner.onSpend((s) => {
        entry.ratePerMin = Number(s.ratePerMin);
        this.publish();
      });
    } catch {
      entry.unsubSpend = undefined;
    }
    this.publish();
    return entry;
  }

  private pauseEntry(e: Entry): void {
    if (e.paused || e.closed) return;
    e.paused = true;
    try {
      e.inner.pause();
    } catch {
      // the transport is gone; nothing more is paid either way
    }
  }

  /** Pauses every open unpaused session outside `keep`'s lineage; returns how many. */
  private pauseOthers(keep: Entry): number {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e === keep || e.closed || e.paused || e.lineage === keep.lineage) continue;
      this.pauseEntry(e);
      n++;
    }
    return n;
  }

  /** Closes `e` (idempotent); resolves when the adapter's close settles (never rejects). */
  private close(e: Entry): Promise<void> {
    if (e.closed) return Promise.resolve();
    e.closed = true;
    this.entries.delete(e.id);
    if (this.mini?.entry === e) this.mini = null;
    try {
      e.unsubSpend?.();
    } catch {
      // ignore
    }
    return e.inner.close().catch(() => undefined);
  }

  private publish(): void {
    let unpaused = 0;
    let rate = 0;
    for (const e of this.entries.values()) {
      if (e.paused) continue;
      unpaused++;
      rate += e.ratePerMin;
    }
    const m = this.mini;
    const mini: MiniState | null =
      m === null ? null : { handoff: m.handoff, paused: m.entry.paused };
    const prev = this.snap;
    const same =
      prev.open === this.entries.size &&
      prev.unpaused === unpaused &&
      prev.ratePerMin === rate &&
      (prev.mini === null
        ? mini === null
        : mini !== null && prev.mini.handoff === mini.handoff && prev.mini.paused === mini.paused);
    if (same) return;
    this.snap = { mini, open: this.entries.size, unpaused, ratePerMin: rate };
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // a broken listener must not break playback bookkeeping
      }
    }
  }
}
