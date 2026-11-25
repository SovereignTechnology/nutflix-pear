/**
 * The part of nfx's web player library (ADR 0022 item 2; nfx `web/player/src/lib.ts`, its types in
 * `api.ts`) that this client calls. The adapter is written against this interface, so the real
 * library, pinned by commit and sha256 in `nfx-web.lock`, is wired in by the site build (M4) and the
 * tests pass a fake. The shapes follow the library's own declarations as of nfx PR #83: an `open()`
 * that takes the origins with the renditions each serves (`OriginSource`) and the renditions the
 * session may play, a mesh whose signaling is of kind `nostr`, `RTCIceServer`s with `stun:` URLs
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
 * NFX-10 §6 signalling over Nostr (`nfx-mesh/1`): general relays, `wss:` (or `ws:` to a loopback
 * host), 1 to 8; a scoped relay (NFX-04) may carry it too. Peers meet only on a relay both use.
 * The library also takes WebTorrent trackers (`{ kind: 'trackers', urls }`); this client never
 * passes them (pear #89).
 */
export interface NfxNostrSignaling {
  readonly kind: 'nostr';
  readonly relays: string[];
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
  /**
   * NFX-17 §4.2: 1, named by the creator's own beacon; 2, by a key the viewer rates; 3, by any
   * other beacon; 4, configured by this site, the last resort. Absent: 4.
   */
  readonly tier?: 1 | 2 | 3 | 4;
}

/** `open()`'s options, as this client passes them (always a signed manifest, never a bare root). */
export interface NfxOpenOptions {
  /** The signed kind-38504 event as JSON; the library verifies it again (NFX-02). */
  readonly manifestJson: string;
  /**
   * Origin bases (NFX-05 §6): the session takes the hash list from whichever delivers a copy
   * that verifies, then every file from all of them in NFX-17 §4.2's tiers, one source's bytes
   * per file, leaving a source that stalls, runs slow or sends bytes that do not verify (§4.3).
   * A bare string serves every rendition and is tier 4.
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
  readonly signaling?: NfxNostrSignaling;
  readonly iceServers?: NfxIceServer[];
  readonly onEvent?: (event: NfxPlayerEvent) => void;
  /** Aborting it cancels `open()`, or destroys the session once open. */
  readonly signal?: AbortSignal;
}

/**
 * One mesh peer in the library's `stats()` (nfx #99, `MeshPeer`). Its `id` and `via` come from the
 * network: shown as text only.
 */
export interface NfxLibPeer {
  readonly id: string;
  readonly via: string;
  readonly down: number;
  readonly up: number;
  readonly segments: number;
  readonly connected: boolean;
}

/**
 * The library's mesh counters (`MeshStats`). The fields nfx #99 added are optional: a library
 * pinned before it reports totals only.
 */
export interface NfxLibMeshStats {
  readonly signaling: 'nostr' | 'trackers';
  readonly trackers: readonly string[];
  readonly relays: readonly string[];
  readonly bytes: { readonly http: number; readonly p2p: number };
  readonly uploaded: number;
  /** Every peer connection since the start. */
  readonly peers: number;
  readonly rejected: readonly string[];
  readonly connected?: number;
  readonly segments?: { readonly http: number; readonly p2p: number };
  readonly peerList?: readonly NfxLibPeer[];
  readonly signal?: { readonly open: number } | null;
}

/** The library's `Session.stats()`, as stats for nerds reads it (contracts v19, ADR 0024). */
export interface NfxLibStats {
  readonly engine: string;
  /** The origin the session plays from. */
  readonly origin: string;
  readonly verified: number;
  readonly rejected: readonly unknown[];
  readonly mesh: NfxLibMeshStats | null;
  /** nfx #99: bytes the player's own loader took from the origin. */
  readonly originBytes?: number;
  /** nfx #99: hls.js's estimate, bits per second. */
  readonly bandwidthEstimate?: number;
}

/** nfx #99: an open peer connection's selected candidate pair (`PeerAddress`). */
export interface NfxLibPeerAddress {
  readonly id: string;
  /** An IP address, an mDNS `.local` name, or `''` when the browser hides it. */
  readonly address: string;
  readonly port: number | null;
  readonly remoteType: string;
  readonly localType: string;
  readonly protocol: string;
  readonly path: 'direct' | 'relayed' | 'unknown';
  readonly rttMs: number | null;
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
  /** A snapshot of where the bytes came from (stats for nerds). */
  stats(): NfxLibStats;
  /**
   * nfx #99: each open peer connection's selected candidate pair, read when called. Other viewers'
   * IP addresses: called only while the viewer has asked to see them. Absent before nfx #99.
   */
  addresses?(): Promise<NfxLibPeerAddress[]>;
  /** Stops hls.js, the p2p loader, its signaling sockets and peers, and the media source. Idempotent. */
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
