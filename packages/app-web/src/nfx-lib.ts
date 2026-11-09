/**
 * The part of nfx's web player library (ADR 0022 item 2; nfx `web/player/src/lib.ts`, its types in
 * `api.ts`) that this client calls. The adapter is written against this interface, so the real
 * library, pinned by commit and sha256 in `nfx-web.lock`, is wired in by the site build (M4) and the
 * tests pass a fake. The shapes follow the library's own declarations as of nfx PR #73: an `open()`
 * whose mesh is a `signaling` of kind `trackers`, `RTCIceServer`s with `stun:` URLs only, and a
 * session with hls.js levels.
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

/** NFX-10 §1 signalling through WebTorrent trackers: `wss:` (or `ws:` to a loopback host), 1 to 4. */
export interface NfxTrackerSignaling {
  readonly kind: 'trackers';
  readonly urls: string[];
}

/** A STUN server (`stun:` or `stuns:` URLs, no credentials); the library takes at most 4. */
export interface NfxIceServer {
  readonly urls: string[];
}

/** `open()`'s options, as this client passes them (always a signed manifest, never a bare root). */
export interface NfxOpenOptions {
  /** The signed kind-38504 event as JSON; the library verifies it again (NFX-02). */
  readonly manifestJson: string;
  /** Origin bases (NFX-05 §6) tried in order until one serves a hash list that verifies. */
  readonly origins: string[];
  /** The browser mesh; absent = every byte from an origin. */
  readonly signaling?: NfxTrackerSignaling;
  readonly iceServers?: NfxIceServer[];
  readonly onEvent?: (event: NfxPlayerEvent) => void;
  /** Aborting it cancels `open()`, or destroys the session once open. */
  readonly signal?: AbortSignal;
  /** Pin this level once the master playlist is parsed. */
  readonly level?: number;
}

/** One video playing in one element (the library's `Session`). */
export interface NfxLibSession {
  /** The renditions, once hls.js has parsed the master playlist (empty before). */
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
   * no origin serves a hash list that verifies, MediaSource is missing, or `signal` aborts first.
   */
  open(el: HTMLVideoElement, options: NfxOpenOptions): Promise<NfxLibSession>;
}
