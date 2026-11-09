/**
 * A free NFX play in the page (contracts v11, v14): an `element` source whose `attach(el)` hands
 * the screen's `<video>` to nfx's player (`open(el, …)`), with the origins, trackers and ICE servers
 * the adapter resolved. Detaching or closing destroys the player's session: hls.js, the p2p loader,
 * its tracker sockets and peers.
 *
 * Renditions are the player's hls.js levels, known once its master playlist is parsed (`levels`);
 * a rendition's id is `l<index>`, and `setRendition` is the player's `setLevel`. Before that, the
 * session lists none and hls.js picks (`rendition` is `auto`).
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
import type { PlayRendition } from './renditions.js';
import type {
  NfxIceServer,
  NfxLevel,
  NfxLibSession,
  NfxOpenOptions,
  NfxPlayerEvent,
  NfxPlayerLib,
} from '../nfx-lib.js';

/** The rendition id of hls.js level `index`. */
export function levelId(index: number): string {
  return `l${String(index)}`;
}

/** The hls.js level a rendition id names, or `null`. */
export function levelOf(id: string): number | null {
  const m = /^l(0|[1-9][0-9]{0,2})$/.exec(id);
  return m === null ? null : Number(m[1]);
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
  readonly origins: readonly string[];
  readonly trackers: readonly string[];
  readonly iceServers: readonly { readonly urls: readonly string[] }[];
  /** A level to start on (`playNfx(addr, 'l<index>')`). */
  readonly level?: number | undefined;
  /**
   * Pear #97: the rendition `level` was chosen for (from the hash list). Once hls.js lists its
   * levels, a pinned level that is not this rendition (by height and bitrate) is moved to the one
   * that is, or to automatic when none is.
   */
  readonly expect?: PlayRendition | undefined;
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
  #picked: number | null;
  #attached: Attachment | null = null;
  #closed = false;
  #problems: NfxPlayProblem[] = [];
  /** Pear #97: whether the pinned start level was checked against `expect`. */
  #checked = false;
  readonly #listeners = new Set<() => void>();

  constructor(o: WebNfxSessionOptions) {
    this.#o = o;
    this.videoId = o.videoId;
    this.#picked = o.level ?? null;
    this.source = {
      kind: 'element',
      attach: (el: MediaElementLike): Unsubscribe => this.#attach(el),
    };
  }

  get rendition(): string {
    return this.#picked === null ? AUTO_RENDITION : levelId(this.#picked);
  }

  get renditions(): readonly NfxRenditionInfo[] {
    return this.#levels.map((l) => ({
      id: levelId(l.index),
      bandwidth: l.bitrate,
      ...(l.width > 0 && l.height > 0
        ? { resolution: `${String(l.width)}x${String(l.height)}` }
        : {}),
    }));
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
    const index = levelOf(id);
    const session = this.#attached?.session ?? null;
    if (index === null || session === null || !this.#levels.some((l) => l.index === index)) {
      return rejectWith('invalid-argument', 'no such rendition');
    }
    try {
      session.setLevel(index);
    } catch {
      return rejectWith('invalid-argument', 'no such rendition');
    }
    this.#picked = index;
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
        origins: [...o.origins],
        ...(o.trackers.length > 0
          ? { signaling: { kind: 'trackers' as const, urls: [...o.trackers] } }
          : {}),
        iceServers: o.iceServers.map((s): NfxIceServer => ({ urls: [...s.urls] })),
        onEvent: (e) => {
          if (live()) this.#hear(e);
        },
        signal: slot.ac.signal,
        ...(this.#picked === null ? {} : { level: this.#picked }),
      };
      const session = await player.open(el, options);
      if (!live()) {
        session.destroy();
        return;
      }
      slot.session = session;
      if (session.levels.length > 0) {
        this.#levels = [...session.levels];
        this.#checkPinned();
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
      this.#checkPinned();
      this.#changed();
      return;
    }
    const p = problemOf(e);
    if (p !== null) this.#problem(p);
  }

  /**
   * Pear #97: the level pinned for `expect` must be that rendition. hls.js may order or filter its
   * levels differently from `levelOrder` (a codec the browser cannot play is dropped): then the
   * level that is it is played, or none is pinned when no level is. Checked once.
   */
  #checkPinned(): void {
    const want = this.#o.expect;
    const session = this.#attached?.session ?? null;
    if (want === undefined || this.#checked || session === null || this.#levels.length === 0) {
      return;
    }
    this.#checked = true;
    const is = (l: NfxLevel): boolean =>
      l.bitrate === want.bandwidth && (want.height === undefined || l.height === want.height);
    const pinned = this.#levels.find((l) => l.index === this.#picked);
    if (pinned !== undefined && is(pinned)) return;
    const match = this.#levels.find(is);
    try {
      session.setLevel(match?.index ?? -1);
      this.#picked = match?.index ?? null;
    } catch {
      // A level the player no longer lists: hls.js keeps what it had.
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
