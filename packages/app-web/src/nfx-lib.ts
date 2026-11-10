/**
 * The part of nfx's web player library (ADR 0022 item 2; nfx `web/player/src/lib.ts`, its types in
 * `api.ts`) that this client calls. The adapter is written against this interface, so the real
 * library, pinned by commit and sha256 in `nfx-web.lock`, is wired in by the site build (M4) and the
 * tests pass a fake. The shapes follow the library's own declarations as of nfx PR #83: an `open()`
 * that takes the origins with the renditions each serves (`OriginSource`) and the renditions the
 * session may play, a mesh whose signaling is of kind `trackers`, `RTCIceServer`s with `stun:` URLs
 * only, and a session with hls.js levels that carry their rendition id.
 *
 * What the adapter does not take from the library: `resolveManifest` and `watchEndpoints`. The
 * manifest comes from core's catalogue and the endpoints from core's beacon watch, over the one
 * Nostr pool the rest of the client uses; `open()` verifies the manifest again in WebAssembly
 * either way, and checks every byte against the hash list it anchors.
 */

/** One rendition as hls.js parsed it from the master playlist (the library's `Level`). */
export interface NfxLevel {
  /** What `setLevel()` takes. */
  readonly index: number;
  /**
   * The rendition id (the hash list's `renditions[].id`), which the library matches by the level's
   * playlist content name, never by its bitrate or size.
   */
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly bitrate: number;
}

/** What `onEvent` hears (the library's `PlayerEvent`); nothing after `destroy()`. */
export type NfxPlayerEvent =
  | { readonly type: 'log'; readonly message: string }
  | {
      readonly type: 'origin';
      readonly origin: string;
      readonly ok: boolean;
      /** Why it was skipped: no hash list that verifies, or none of the allowed renditions served. */
      readonly why?: string;
    }
  | { readonly type: 'verified'; readonly sha256: string; readonly url: string }
  | {
      readonly type: 'rejected';
      readonly sha256: string | null;
      readonly url: string;
      readonly why: string;
    }
  | { readonly type: 'levels'; readonly levels: readonly NfxLevel[] }
  | { readonly type: 'playing' }
  | { readonly type: 'error'; readonly message: string };

/**
 * NFX-10 §1 signalling through WebTorrent trackers: `wss:` (or `ws:` to a loopback host), 1 to 4.
 * The library also takes `{ kind: 'nostr', relays }` (nfx #80), which this client does not use yet.
 */
export interface NfxTrackerSignaling {
  readonly kind: 'trackers';
  readonly urls: string[];
}

/** A STUN server (`stun:` or `stuns:` URLs, no credentials); the library takes at most 4. */
export interface NfxIceServer {
  readonly urls: string[];
}

/**
 * An origin and the renditions it serves (the library's `OriginSource`, NFX-03 §4): its beacon's
 * `https` endpoint's `renditions`. Absent: every rendition. Empty: none, and `open()` skips it.
 */
export interface NfxOriginSource {
  /** `https://host[:port][/prefix]`, as a bare origin string. */
  readonly url: string;
  /** At most 32 ids; ids the hash list does not name are ignored. */
  readonly renditions?: string[];
}

/** `open()`'s options, as this client passes them (always a signed manifest, never a bare root). */
export interface NfxOpenOptions {
  /** The signed kind-38504 event as JSON; the library verifies it again (NFX-02). */
  readonly manifestJson: string;
  /**
   * Origin bases (NFX-05 §6) tried in order: the session takes every file from the first that
   * serves a hash list that verifies and holds an allowed rendition. A bare string serves every
   * rendition.
   */
  readonly origins: (string | NfxOriginSource)[];
  /**
   * The renditions the session may play, by hash-list id, preferred first: 1 to 32 distinct ids,
   * never `meta` (`TypeError` otherwise, before anything is fetched), each one the hash list has
   * (`RangeError` otherwise, once it verified). Absent: every rendition. The session's levels are
   * these, cut to what its origin serves; hls.js starts on the first of them and adapts among them.
   */
  readonly renditions?: string[];
  /** The browser mesh; absent = every byte from an origin. */
  readonly signaling?: NfxTrackerSignaling;
  readonly iceServers?: NfxIceServer[];
  readonly onEvent?: (event: NfxPlayerEvent) => void;
  /** Aborting it cancels `open()`, or destroys the session once open. */
  readonly signal?: AbortSignal;
}

/** One video playing in one element (the library's `Session`). */
export interface NfxLibSession {
  /**
   * The renditions the session offers (allowed, and served by its origin), once hls.js has parsed
   * the master playlist (empty before).
   */
  readonly levels: readonly NfxLevel[];
  /** Play `index` from now on, or -1 to let hls.js pick; throws `RangeError` for any other. */
  setLevel(index: number): void;
  /** Stops hls.js, the p2p loader, its tracker sockets and peers, and the media source. Idempotent. */
  destroy(): void;
}

/** The library: `init` once (the WASM verifier), then `open` per element. */
export interface NfxPlayerLib {
  init(options?: { readonly wasmUrl?: string }): Promise<void>;
  /**
   * Resolves once a hash list verified and hls.js started; rejects if the manifest fails NFX-02,
   * no origin serves a hash list that verifies and holds an allowed rendition, `renditions` names
   * one the hash list lacks, MediaSource is missing, or `signal` aborts first.
   */
  open(el: HTMLVideoElement, options: NfxOpenOptions): Promise<NfxLibSession>;
}
