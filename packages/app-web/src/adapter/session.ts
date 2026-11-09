/**
 * A free NFX play in the page (contracts v11, v14): an `element` source whose `attach(el)` hands
 * the screen's `<video>` to nfx's player (`open(el, …)`), with the origins, trackers and ICE servers
 * the adapter resolved. Detaching or closing destroys the player's session: hls.js, the p2p loader,
 * its tracker sockets and peers.
 *
 * Renditions are the player's hls.js levels, known once its master playlist is parsed (`levels`);
 * a rendition's id is `l<index>`, and `setRendition` is the player's `setLevel`. Before that, the
 * session lists none and hls.js picks (`rendition` is `auto`).
 */
import type {
  ElementPlaySource,
  MediaElementLike,
  NfxAddress,
  NfxPlaySession,
  NfxRenditionInfo,
  Unsubscribe,
} from '@sovit/core';

import { WebAdapterError, rejectWith } from '../errors.js';
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

export interface WebNfxSessionOptions {
  readonly videoId: NfxAddress;
  /** The signed manifest event as JSON (the player verifies it again). */
  readonly manifestJson: string;
  readonly origins: readonly string[];
  readonly trackers: readonly string[];
  readonly iceServers: readonly { readonly urls: readonly string[] }[];
  /** A level to start on (`playNfx(addr, 'l<index>')`). */
  readonly level?: number | undefined;
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
  #error: string | null = null;

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

  /** The last error nfx's player reported (no origin verified, a fatal media error), if any. */
  get error(): string | null {
    return this.#error;
  }

  get closed(): boolean {
    return this.#closed;
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
    return Promise.resolve();
  }

  /** Idempotent. */
  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    this.#detach();
    this.#o.onClose?.(this);
    return Promise.resolve();
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
      if (session.levels.length > 0) this.#levels = [...session.levels];
    } catch (e) {
      if (live()) this.#error = e instanceof Error ? e.message : 'the player did not start';
    }
  }

  #hear(e: NfxPlayerEvent): void {
    if (e.type === 'levels') this.#levels = [...e.levels];
    else if (e.type === 'error') this.#error = e.message;
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
