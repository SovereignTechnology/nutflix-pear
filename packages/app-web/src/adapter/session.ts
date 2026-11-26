/**
 * A free NFX play in the page (contracts v11, v14): an `element` source whose `attach(el)` hands
 * the screen's `<video>` to nfx's player (`open(el, …)`), with the origins, signaling relays and ICE servers
 * the adapter resolved. Detaching or closing destroys the player's session: hls.js, the p2p loader,
 * its relay sockets and peers.
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
  MAX_PLAY_SOURCES,
  MediaElementLike,
  NfxAddress,
  NfxPlayProblem,
  NfxPlaySession,
  NfxPlayStats,
  NfxRenditionInfo,
  PlaySourceAddress,
  PlaySourceStat,
  Unsubscribe,
} from '@sovit/core';

import { WebAdapterError, rejectWith } from '../errors.js';
import type { PlayOrigin } from './endpoints.js';
import type {
  NfxIceServer,
  NfxLevel,
  NfxLibPeerAddress,
  NfxLibSession,
  NfxLibStats,
  NfxOpenOptions,
  NfxOriginSource,
  NfxPlayerEvent,
  NfxPlayerLib,
  NfxSegmentSource,
} from '../nfx-lib.js';

/** `MAX_PLAY_SOURCES` (contracts v19), as a value: core's constant is imported as a type only. */
const MAX_SOURCES: typeof MAX_PLAY_SOURCES = 64;

/** A network-chosen string as the contract carries it: printable ASCII, at most `max`. */
function printable(raw: string, max: number): string {
  return raw.replace(/[^\x20-\x7e]/g, '?').slice(0, max);
}

/** A URL's host, or the string cut short when it is not a URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return printable(url, 64);
  }
}

/**
 * Contracts v19 (ADR 0024): the library's `stats()` as stats for nerds reads it. The origin is one
 * source (what its loader took plus the segments the mesh fetched over HTTP); each mesh peer
 * another. A library pinned before nfx #99 has no per-peer list: its peers are one row of totals.
 */
export function playStats(s: NfxLibStats): NfxPlayStats {
  const mesh = s.mesh;
  const sources: PlaySourceStat[] = [
    {
      kind: 'origin',
      id: hostOf(s.origin),
      via: 'beacon',
      bytesDown: (s.originBytes ?? 0) + (mesh?.bytes.http ?? 0),
      bytesUp: 0,
      files: mesh?.segments?.http ?? s.verified,
      connected: true,
    },
  ];
  if (mesh !== null) {
    if (mesh.peerList !== undefined) {
      for (const p of mesh.peerList) {
        const id = printable(p.id, 64);
        sources.push({
          kind: 'webrtc',
          id,
          via: p.via.startsWith('nostr:') ? 'nostr' : hostOf(p.via),
          bytesDown: p.down,
          bytesUp: p.up,
          files: p.segments,
          connected: p.connected,
          ...(id.startsWith('-NX0100-') ? { label: 'nfxd bridge?' } : {}),
        });
      }
    } else if (mesh.bytes.p2p > 0 || mesh.uploaded > 0) {
      sources.push({
        kind: 'webrtc',
        id: 'all peers',
        via: mesh.signaling,
        bytesDown: mesh.bytes.p2p,
        bytesUp: mesh.uploaded,
        files: 0,
        connected: mesh.peers > 0,
        label: 'totals',
      });
    }
  }
  const endpoints = (mesh?.signaling === 'trackers' ? mesh.trackers : (mesh?.relays ?? [])).map(
    hostOf,
  );
  const open = mesh?.signal?.open;
  return {
    sources: sources
      .sort((a, b) => Number(b.connected) - Number(a.connected) || b.bytesDown - a.bytesDown)
      .slice(0, MAX_SOURCES),
    engine: printable(s.engine, 120),
    ...(mesh?.connected === undefined
      ? {}
      : { peers: { connected: mesh.connected, total: mesh.peers } }),
    ...(mesh === null
      ? {}
      : {
          signaling: {
            kind: mesh.signaling,
            endpoints,
            ...(open === undefined ? {} : { open }),
          },
        }),
    verified: s.verified,
    refused: s.rejected.length + (mesh?.rejected.length ?? 0),
    ...(mesh?.source === undefined
      ? {}
      : {
          transport: {
            source: mesh.source,
            ...(mesh.rescues === undefined ? {} : { rescues: mesh.rescues }),
            ...(mesh.webrtc === 'ok' || mesh.webrtc === 'blocked' ? { webrtc: mesh.webrtc } : {}),
          },
        }),
    ...(s.bandwidthEstimate === undefined ? {} : { bandwidthEstimate: s.bandwidthEstimate }),
  };
}

/** Contracts v19: a peer's selected candidate pair as the contract carries it. */
export function playAddress(a: NfxLibPeerAddress): PlaySourceAddress {
  const hidden = a.address === '' || a.address.endsWith('.local');
  const ip = printable(a.address, 48);
  const host = ip.includes(':') ? `[${ip}]` : ip;
  const detail = [a.remoteType, a.protocol].filter((x) => x !== '').join('/');
  return {
    kind: 'webrtc',
    id: printable(a.id, 64),
    address: hidden ? '' : a.port === null ? host : `${host}:${String(a.port)}`,
    path: a.path,
    ...(a.rttMs === null ? {} : { rttMs: a.rttMs }),
    ...(detail === '' ? {} : { detail: printable(detail, 24) }),
  };
}

/**
 * An origin as `open()` takes it: a bare base when it serves every rendition and is this site's
 * own (tier 4, the library's default); otherwise with its claim and its tier (NFX-17 §4.2).
 */
export function originSource(o: PlayOrigin): string | NfxOriginSource {
  const tier = o.tier ?? 4;
  if (o.renditions === undefined && tier === 4) return o.url;
  return {
    url: o.url,
    ...(o.renditions === undefined ? {} : { renditions: [...o.renditions] }),
    ...(tier === 4 ? {} : { tier }),
  };
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
    case 'mesh':
      // Contracts v20: the viewer is told why no peer shows up (the library's own words name
      // what its check found; a short reason is enough here).
      return { kind: 'peers', message: capped(e.why) };
    case 'verified':
    case 'levels':
    case 'playing':
    case 'waiting':
    case 'resumed':
    case 'rescue':
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
  /** The signaling relays (NFX-10 §6); none: no mesh, every byte from an origin. */
  readonly meshRelays: readonly string[];
  /**
   * ADR 0025: where the mesh takes segments from; absent, the library's default (HTTPS first).
   * Passed only with signaling relays: without a mesh there are no peers to ask.
   */
  readonly segmentSource?: NfxSegmentSource | undefined;
  /** Contracts v20: told when the viewer switches HTTPS off or on, so the choice is kept. */
  readonly onPeersOnly?: ((on: boolean) => void) | undefined;
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
  /** Contracts v20: why the play is waiting for a peer, or `null` while it is not. */
  #waiting: 'no-peer' | 'slow' | null = null;
  /** Whether `pin` was set on the player's levels (once). */
  #pinned = false;
  /** Where the mesh takes segments from now (it can change while the play is open). */
  #segmentSource: NfxSegmentSource | undefined;
  readonly #listeners = new Set<() => void>();
  /**
   * Contracts v20: the switch that turns HTTPS off for segments. There only with a mesh that
   * has a segment source to switch: without one there are no peers to take them from.
   */
  readonly setPeersOnly?: (on: boolean) => Promise<void>;

  constructor(o: WebNfxSessionOptions) {
    this.#o = o;
    this.videoId = o.videoId;
    this.#picked = o.pin ?? null;
    this.#segmentSource = o.segmentSource;
    if (o.meshRelays.length > 0 && o.segmentSource !== undefined) {
      this.setPeersOnly = (on: boolean): Promise<void> => {
        if (this.#closed) return rejectWith('invalid-argument', 'the play is closed');
        const next: NfxSegmentSource = on ? 'peers-only' : 'peers-then-https';
        try {
          // A player not open yet starts with it; one from before nfx 0109 cannot switch.
          this.#attached?.session?.setSegmentSource?.(next);
        } catch (e) {
          return rejectWith(
            'invalid-argument',
            e instanceof Error ? e.message : 'the player refused the segment source',
          );
        }
        this.#segmentSource = next;
        this.#o.onPeersOnly?.(on);
        this.#changed();
        return Promise.resolve();
      };
    }
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

  /** Contracts v20: set while the play has nothing to play and waits for a peer. */
  get waiting(): 'no-peer' | 'slow' | null {
    return this.#waiting;
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

  /** Contracts v19 (ADR 0024): where the bytes came from, now. No addresses. */
  stats(): Promise<NfxPlayStats> {
    const session = this.#closed ? null : (this.#attached?.session ?? null);
    if (session === null) return Promise.resolve({ sources: [] });
    try {
      return Promise.resolve(playStats(session.stats()));
    } catch {
      return Promise.resolve({ sources: [] });
    }
  }

  /**
   * Contracts v19 (ADR 0024): each open peer's address, from the library (nfx #99), asked only
   * while the viewer has switched addresses on. A library pinned before it has none to give.
   */
  async addresses(): Promise<readonly PlaySourceAddress[]> {
    const session = this.#closed ? null : (this.#attached?.session ?? null);
    if (session?.addresses === undefined) return [];
    try {
      const list = await session.addresses();
      return list.slice(0, MAX_SOURCES).map(playAddress);
    } catch {
      return [];
    }
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
        // Signaling over Nostr (NFX-10 §6, pear #89): this page, the desktop app and nfxd's mesh
        // endpoint meet in the rendition's room on these relays. Never a tracker.
        ...(o.meshRelays.length > 0
          ? {
              signaling: { kind: 'nostr' as const, relays: [...o.meshRelays] },
              ...(this.#segmentSource === undefined ? {} : { segmentSource: this.#segmentSource }),
            }
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
    if (e.type === 'waiting' || e.type === 'resumed') {
      const waiting = e.type === 'waiting' ? e.reason : null;
      if (waiting === this.#waiting) return;
      this.#waiting = waiting;
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
