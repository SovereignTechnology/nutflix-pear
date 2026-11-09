/**
 * In-memory router (design §4 "Router"): a history of `{ route, extras }` entries with
 * back/forward. No URL, no `location`, no hash: the page is one document (`will-navigate` is
 * blocked in main) and the renderer has no reason to expose state in a URL.
 *
 * `extras` carry what `Route` (orchestrator-owned, v4) cannot yet: Search filters, the Wallet
 * intent, Library's open playlist, Watch's playlist context and Watch's `resumeSession`.
 *
 * Rules:
 *   - navigating to the route already shown does not push; its extras are merged in place;
 *   - `shorts → shorts` REPLACES (each swipe is not a history step; Shorts must not remount);
 *   - `intercept` may rewrite a target entry before it commits (the shell uses it to expand
 *     the mini-player when the viewer navigates to the video it is playing);
 *   - at most `MAX_HISTORY` entries; the oldest are dropped.
 */
import type {
  Route,
  SearchFilterState,
  WalletIntent,
  WatchHandoff,
  WatchPlaylist,
} from '../screens/index.js';

export interface RouteExtras {
  readonly searchFilters?: Partial<SearchFilterState> | undefined;
  readonly walletIntent?: WalletIntent | undefined;
  readonly playlistId?: string | undefined;
  readonly watchPlaylist?: WatchPlaylist | undefined;
  readonly resumeSession?: WatchHandoff | undefined;
}

export interface HistoryEntry {
  /** Unique per entry (a new entry = a new key; an in-place extras update keeps it). */
  readonly key: number;
  readonly route: Route;
  readonly extras: RouteExtras;
}

export interface RouterState {
  readonly entry: HistoryEntry;
  readonly canBack: boolean;
  readonly canForward: boolean;
  /** Bumped by every change, including in-place extras updates. */
  readonly version: number;
}

export const MAX_HISTORY = 100;

/** Structural equality of two routes (they are small, flat, JSON-safe objects). */
export function sameRoute(a: Route, b: Route): boolean {
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

export class Router {
  private stack: HistoryEntry[];
  private index = 0;
  private nextKey = 1;
  private version = 0;
  private state: RouterState;
  private readonly listeners = new Set<() => void>();
  /** Rewrites a target entry before it commits (identity by default). */
  intercept: (entry: HistoryEntry) => HistoryEntry = (e) => e;
  /** Called with every route about to be shown (before listeners run). */
  onRequest: (route: Route) => void = () => undefined;

  constructor(initial: Route, extras: RouteExtras = {}) {
    this.stack = [{ key: this.nextKey++, route: initial, extras }];
    this.state = this.makeState();
  }

  snapshot(): RouterState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get current(): HistoryEntry {
    const e = this.stack[this.index];
    if (e === undefined) throw new Error('router: history index out of range');
    return e;
  }

  /** The `navigate` every screen gets. */
  readonly navigate = (route: Route, extras: RouteExtras = {}): void => {
    const cur = this.current;
    if (sameRoute(cur.route, route)) {
      this.replaceCurrent(this.intercept({ ...cur, extras: { ...cur.extras, ...extras } }));
      return;
    }
    const target = this.intercept({ key: this.nextKey++, route, extras });
    if (cur.route.name === 'shorts' && route.name === 'shorts') {
      this.replaceCurrent(target);
      return;
    }
    this.stack = [...this.stack.slice(0, this.index + 1), target];
    if (this.stack.length > MAX_HISTORY) this.stack = this.stack.slice(-MAX_HISTORY);
    this.index = this.stack.length - 1;
    this.changed();
  };

  /** Merges `patch` into the current entry's extras (e.g. Search filter changes). */
  readonly updateExtras = (patch: RouteExtras): void => {
    const cur = this.current;
    this.replaceCurrent({ ...cur, extras: { ...cur.extras, ...patch } }, false);
  };

  readonly back = (): void => {
    if (this.index === 0) return;
    this.move(this.index - 1);
  };

  readonly forward = (): void => {
    if (this.index >= this.stack.length - 1) return;
    this.move(this.index + 1);
  };

  private move(to: number): void {
    const target = this.stack[to];
    if (target === undefined) return;
    this.index = to;
    this.stack[to] = this.intercept(target);
    this.changed();
  }

  private replaceCurrent(entry: HistoryEntry, request = true): void {
    this.stack[this.index] = entry;
    this.changed(request);
  }

  private changed(request = true): void {
    this.version++;
    if (request) this.onRequest(this.current.route);
    this.state = this.makeState();
    for (const l of [...this.listeners]) l();
  }

  private makeState(): RouterState {
    return {
      entry: this.current,
      canBack: this.index > 0,
      canForward: this.index < this.stack.length - 1,
      version: this.version,
    };
  }
}
