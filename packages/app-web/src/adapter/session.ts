/**
 * A free NFX play in the page (contracts v11, v14): an `element` source whose `attach(el)` hands
 * the screen's `<video>` to nfx's player (`open(el, …)`), with the origins, trackers and ICE servers
 * the adapter resolved. Detaching or closing destroys the player's session: hls.js, the p2p loader,
 * its tracker sockets and peers.
 *
 * Renditions are the player's hls.js levels, known once its master playlist is parsed (`levels`),
 * each by its hash-list rendition id (the library's `Level.id`, nfx #83), so the quality menu and
 * `playNfx(addr, id)` speak the ids the contract does; `setRendition` is the player's `setLevel` on
 * the level with that id. Before that, the session lists none and hls.js picks (`rendition` is
 * `auto`). The library offers only the renditions the play allows (`renditions`) that its origin
 * serves (`origins`), so the menu never lists one nobody this page can reach holds (pear #97).
 *
 * Contracts v15: what goes wrong is kept as `problems` (a file the player refused, an origin whose
 * hash list did not verify, a play that stopped), and `onChange` tells the watch page when the
 * renditions arrive or a problem is added.
 */
import type {
  ElementPlaySource,
  MAX_NFX_PLAY_PROBLEMS,
  MediaElementLike,
  NfxAddress,
  NfxPlayProblem,
  NfxPlaySession,
  NfxRenditionInfo,
  Unsubscribe,
} from '@sovit/core';

import { WebAdapterError, rejectWith } from '../errors.js';
import type { PlayOrigin } from './endpoints.js';
import type {
  NfxIceServer,
  NfxLevel,
  NfxLibSession,
  NfxOpenOptions,
  NfxOriginSource,
  NfxPlayerEvent,
  NfxPlayerLib,
} from '../nfx-lib.js';

/** An origin as `open()` takes it: a bare base when it serves every rendition. */
export function originSource(o: PlayOrigin): string | NfxOriginSource {
  return o.renditions === undefined ? o.url : { url: o.url, renditions: [...o.renditions] };
}

/** What `rendition` reads while hls.js picks. */
export const AUTO_RENDITION = 'auto';

/** The most problems one session keeps (contracts v15), the newest. */
export const WEB_MAX_PLAY_PROBLEMS: typeof MAX_NFX_PLAY_PROBLEMS = 16;

function capped(s: string): string {
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

/** `url` as a viewer can read it: its host and the last part of its path, at most 120 characters. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const name =
      u.pathname
        .split('/')
        .filter((p) => p !== '')
        .at(-1) ?? '';
    return capped(name === '' ? u.host : `${u.host}/…/${name}`);
  } catch {
    return capped(url);
  }
}

/**
 * The problem a player event reports, or `null` for one that is not a problem. A play the browser
 * would not start on its own (`play: …`, autoplay refused) is not one: the element's controls
 * start it. nfx's player reports a refused segment from the mesh only in its log, as
 * `mesh: rejected <http|p2p> bytes for <url>: <why>`, so that line is read as a refusal too.
 */
export function problemOf(e: NfxPlayerEvent): NfxPlayProblem | null {
  switch (e.type) {
    case 'rejected':
      return { kind: 'refused', message: `Refused ${shortUrl(e.url)}: ${e.why}` };
    case 'origin':
      return e.ok
        ? null
        : {
            kind: 'origin',
            message: `${capped(e.origin)}: ${e.why ?? 'its hash list did not verify'}`,
          };
    case 'error':
      return e.message.startsWith('play: ') ? null : { kind: 'stopped', message: e.message };
    case 'log': {
      const m = /^mesh: rejected (http|p2p) bytes for (\S+): (.*)$/.exec(e.message);
      return m === null
        ? null
        : {
            kind: 'refused',
            message: `Refused ${shortUrl(m[2] ?? '')} from ${m[1] === 'p2p' ? 'a peer' : 'an origin'}: ${m[3] ?? ''}`,
          };
    }
    case 'verified':
    case 'levels':
    case 'playing':
      return null;
  }
}

export interface WebNfxSessionOptions {
  readonly videoId: NfxAddress;
  /** The signed manifest event as JSON (the player verifies it again). */
  readonly manifestJson: string;
  /** Tried in order, each with the renditions it serves (absent: every one). */
  readonly origins: readonly PlayOrigin[];
  /**
   * Pear #97: the renditions the play may use, by hash-list id, the preferred first (1 to 32);
   * absent, every rendition. hls.js starts on the first its origin serves.
   */
  readonly renditions?: readonly string[] | undefined;
  readonly trackers: readonly string[];
  readonly iceServers: readonly { readonly urls: readonly string[] }[];
  /**
   * The rendition the viewer picked (`playNfx(addr, id)`): played, and hls.js's choice turned
   * off, once its levels list it; when they do not, hls.js picks.
   */
  readonly pin?: string | undefined;
  /** The player, initialised (`init` done once for the page). */
  readonly player: () => Promise<NfxPlayerLib>;
  /** Told once, when the session closes. */
  readonly onClose?: ((s: WebNfxSession) => void) | undefined;
}

interface Attachment {
  readonly ac: AbortController;
  session: NfxLibSession | null;
}

/** A `<video>` element, as nfx's player needs one; anything else is refused. */
function asVideoElement(el: MediaElementLike): HTMLVideoElement {
  if (typeof HTMLVideoElement === 'undefined' || !(el instanceof HTMLVideoElement)) {
    throw new WebAdapterError('invalid-argument', 'an NFX video plays into a <video> element');
  }
  return el;
}

export class WebNfxSession implements NfxPlaySession {
  readonly videoId: NfxAddress;
  readonly source: ElementPlaySource;
  readonly #o: WebNfxSessionOptions;
  #levels: readonly NfxLevel[] = [];
  /** The rendition id playing by choice, or `null` while hls.js picks. */
  #picked: string | null;
  #attached: Attachment | null = null;
  #closed = false;
  #problems: NfxPlayProblem[] = [];
  /** Whether `pin` was set on the player's levels (once). */
  #pinned = false;
  readonly #listeners = new Set<() => void>();

  constructor(o: WebNfxSessionOptions) {
    this.#o = o;
    this.videoId = o.videoId;
    this.#picked = o.pin ?? null;
    this.source = {
      kind: 'element',
      attach: (el: MediaElementLike): Unsubscribe => this.#attach(el),
    };
  }

  get rendition(): string {
    return this.#picked ?? AUTO_RENDITION;
  }

  /** One per rendition id (the first level that has it), in hls.js's order. */
  get renditions(): readonly NfxRenditionInfo[] {
    const out: NfxRenditionInfo[] = [];
    for (const l of this.#levels) {
      if (out.some((r) => r.id === l.id)) continue;
      out.push({
        id: l.id,
        bandwidth: l.bitrate,
        ...(l.width > 0 && l.height > 0
          ? { resolution: `${String(l.width)}x${String(l.height)}` }
          : {}),
      });
    }
    return out;
  }

  /** Contracts v15: what went wrong, oldest first, the newest `WEB_MAX_PLAY_PROBLEMS`. */
  get problems(): readonly NfxPlayProblem[] {
    return [...this.#problems];
  }

  /** The last time the play stopped (the player refused to start, a fatal media error), if ever. */
  get error(): string | null {
    return this.#problems.findLast((p) => p.kind === 'stopped')?.message ?? null;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Contracts v15: told after the renditions, the rendition or the problems change. */
  onChange(cb: () => void): Unsubscribe {
    if (this.#closed) return () => undefined;
    const once = (): void => {
      cb();
    };
    this.#listeners.add(once);
    return () => {
      this.#listeners.delete(once);
    };
  }

  setRendition(id: string): Promise<void> {
    if (this.#closed) return rejectWith('session-closed', 'the play has ended');
    const session = this.#attached?.session ?? null;
    const level = typeof id === 'string' ? this.#levels.find((l) => l.id === id) : undefined;
    if (level === undefined || session === null) {
      return rejectWith('invalid-argument', 'no such rendition');
    }
    try {
      session.setLevel(level.index);
    } catch {
      return rejectWith('invalid-argument', 'no such rendition');
    }
    this.#picked = level.id;
    this.#changed();
    return Promise.resolve();
  }

  /** Idempotent. */
  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    this.#listeners.clear();
    this.#detach();
    this.#o.onClose?.(this);
    return Promise.resolve();
  }

  #changed(): void {
    for (const cb of [...this.#listeners]) {
      try {
        cb();
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  #problem(p: NfxPlayProblem): void {
    this.#problems.push(p);
    if (this.#problems.length > WEB_MAX_PLAY_PROBLEMS) {
      this.#problems.splice(0, this.#problems.length - WEB_MAX_PLAY_PROBLEMS);
    }
    this.#changed();
  }

  #attach(el: MediaElementLike): Unsubscribe {
    if (this.#closed) return () => undefined;
    const video = asVideoElement(el);
    this.#detach();
    const slot: Attachment = { ac: new AbortController(), session: null };
    this.#attached = slot;
    void this.#open(video, slot);
    return () => {
      if (this.#attached === slot) this.#detach();
    };
  }

  async #open(el: HTMLVideoElement, slot: Attachment): Promise<void> {
    const live = (): boolean => this.#attached === slot && !slot.ac.signal.aborted;
    try {
      const player = await this.#o.player();
      if (!live()) return;
      const o = this.#o;
      const options: NfxOpenOptions = {
        manifestJson: o.manifestJson,
        origins: o.origins.map(originSource),
        ...(o.renditions === undefined ? {} : { renditions: [...o.renditions] }),
        // Trackers, not nfx #80's `nostr` kind: the deployed seeder's bridge is tracker-signaled,
        // and Nostr signaling waits for nfxd's mesh endpoint (nfx #71 phase 2).
        ...(o.trackers.length > 0
          ? { signaling: { kind: 'trackers' as const, urls: [...o.trackers] } }
          : {}),
        iceServers: o.iceServers.map((s): NfxIceServer => ({ urls: [...s.urls] })),
        onEvent: (e) => {
          if (live()) this.#hear(e);
        },
        signal: slot.ac.signal,
      };
      const session = await player.open(el, options);
      if (!live()) {
        session.destroy();
        return;
      }
      slot.session = session;
      if (session.levels.length > 0) {
        this.#levels = [...session.levels];
        this.#pinLevel();
        this.#changed();
      }
    } catch (e) {
      if (live()) {
        this.#problem({
          kind: 'stopped',
          message: e instanceof Error ? e.message : 'the player did not start',
        });
      }
    }
  }

  #hear(e: NfxPlayerEvent): void {
    if (e.type === 'levels') {
      this.#levels = [...e.levels];
      this.#pinLevel();
      this.#changed();
      return;
    }
    const p = problemOf(e);
    if (p !== null) this.#problem(p);
  }

  /**
   * The viewer's pick (`pin`), once the player lists its levels: the level with that rendition id
   * is played; when there is none (the play does not allow it, or its origin does not serve it),
   * hls.js picks. Done once.
   */
  #pinLevel(): void {
    const want = this.#o.pin;
    const session = this.#attached?.session ?? null;
    if (want === undefined || this.#pinned || session === null || this.#levels.length === 0) {
      return;
    }
    this.#pinned = true;
    const level = this.#levels.find((l) => l.id === want);
    if (level === undefined) {
      this.#picked = null;
      return;
    }
    try {
      session.setLevel(level.index);
    } catch {
      // A level the player no longer lists: hls.js keeps picking.
      this.#picked = null;
    }
  }

  #detach(): void {
    const slot = this.#attached;
    if (slot === null) return;
    this.#attached = null;
    slot.ac.abort();
    slot.session?.destroy();
    slot.session = null;
  }
}
