import type { CatalogVideo, NfxVideo, PricePolicy, VideoManifest } from './manifest.js';
import type { NostrEvent, Profile, RelayConfig } from './nostr.js';
import type { PeerWindow } from './payment.js';
import type {
  IrohRelayUrl,
  MintUrl,
  NfxAddress,
  NostrEventId,
  NostrPubkey,
  RelayUrl,
  Sats,
  Sha256Hex,
  UnixSeconds,
} from './primitives.js';
import type { SignerStatus } from './signer.js';
import type { Wallet } from './wallet.js';

/**
 * NetworkAdapter — everything the UI is allowed to call (assumption A11, build-plan §2.1).
 *
 * `@sovit/ui` imports nothing else from core at runtime. Two implementations:
 *   - app-desktop: over worker IPC (preload exposes exactly these methods)
 *   - app-web: over WebSocket to a gateway + in-page Hypercore (or MSE fallback per S-B)
 * plus `MockNetworkAdapter` (fixture videos, fake sats) for screens and Storybook.
 *
 * Every method that returns Nostr-derived data returns it already signature-verified.
 */

export type Unsubscribe = () => void;

export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque cursor; `undefined` = no more. */
  readonly next?: string;
}

export interface FeedQuery {
  readonly source: 'subscriptions' | 'trending' | 'tags' | 'author' | 'shorts';
  readonly tags?: readonly string[];
  readonly author?: NostrPubkey;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface Comment {
  readonly id: NostrEventId;
  readonly author: NostrPubkey;
  readonly content: string; // raw; rendered by the markdown subset only
  readonly createdAt: UnixSeconds;
  readonly parent?: NostrEventId;
  readonly reactions: number;
  readonly event: NostrEvent;
}

export interface VideoStats {
  /** Unique paying pubkeys from kind 9321 — labelled "paid views" in the UI. */
  readonly paidViews: number;
  readonly satsToCreator: Sats;
  /** All NIP-25 reactions on the video (likes + dislikes + emoji), newest per pubkey. */
  readonly reactions: number;
  /**
   * v4: `+`/empty reactions, newest per pubkey. Dislikes are always shown (Cameron,
   * 2026-09-23, ADR 0007), so both counts are required.
   */
  readonly likes: number;
  /** v4: `-` reactions, newest per pubkey. */
  readonly dislikes: number;
  /** v4: the signed-in viewer's current reaction, when it is a like or a dislike. */
  readonly myReaction?: 'like' | 'dislike';
  readonly comments: number;
  /**
   * Seeders currently announcing this core (from swarm / 10019). v5 (L6-B request 5):
   * ABSENT = unknown — the adapter has no way to count them yet. Screens gate playback only
   * on a KNOWN 0; `play()` reports the truth either way.
   */
  readonly seedersOnline?: number;
}

/**
 * Core has no DOM lib (it runs on Bare too), so browser objects are typed structurally.
 * Shells narrow these to the real `File` / `Blob` / `MediaSource`.
 */
export interface BlobLike {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface FileLike extends BlobLike {
  readonly name: string;
  readonly lastModified: number;
}
/** Marker for a DOM `MediaSource`; the web shell owns the real type. */
export interface MediaSourceLike {
  readonly readyState: 'closed' | 'open' | 'ended';
}

/**
 * Spike S-B PASSED: Hypercore 11 + Hyperblobs run in-page over a WebSocket Duplex with an
 * in-memory `hypercore-storage` backend, so the web shell's primary source is
 * `service-worker` (SW answers `<video>` range requests from the in-page core). `mediasource`
 * is the A8 fallback (gateway-served sha256 segments + MSE) and stays available.
 */
export type PlaySource =
  | { readonly kind: 'url'; readonly url: string } // desktop: hypercore-blob-server localhost range URL
  | { readonly kind: 'service-worker'; readonly url: string } // web: SW-served range URL from in-page core
  | { readonly kind: 'mediasource'; readonly mediaSource: MediaSourceLike }; // web fallback: MSE

export interface PlaySession {
  readonly videoId: NostrEventId;
  readonly rendition: string;
  readonly source: PlaySource;
  readonly policy: PricePolicy;
  /** Live per-seeder spend for the peer panel. */
  onPeers(cb: (peers: readonly PeerSpend[]) => void): Unsubscribe;
  /** Live totals for the header chip: sats/min while playing. */
  onSpend(cb: (s: { readonly total: Sats; readonly ratePerMin: Sats }) => void): Unsubscribe;
  /** Prefetch depth in seconds (build-plan §6.2 "buffer = money"). */
  setPrefetchSeconds(sec: number): void;
  /** Pause = stop paying. Must be honoured by the transport, not just the element. */
  pause(): void;
  resume(): void;
  /** Switch rendition at a keyframe; the UI shows the price difference first. */
  switchRendition(label: string): Promise<PlaySession>;
  close(): Promise<void>;
}

/** v11 (ADR 0020 slice 5d): one rendition of an NFX video, as its hash list lists it. */
export interface NfxRenditionInfo {
  readonly id: string;
  /** Bits per second, from the hash list. */
  readonly bandwidth: number;
  /** `<width>x<height>`, when listed. */
  readonly resolution?: string;
}

/**
 * v11 (ADR 0020 slice 5d): a free NFX play session. Nothing is paid, so it carries no price,
 * spend or peers, and nothing on it reaches the money plane. Switching rendition is closing it
 * and opening another.
 */
export interface NfxPlaySession {
  readonly videoId: NfxAddress;
  readonly rendition: string;
  readonly renditions: readonly NfxRenditionInfo[];
  readonly source: PlaySource;
  close(): Promise<void>;
}

export interface PeerSpend {
  readonly pubkey: NostrPubkey;
  readonly sats: Sats;
  readonly ratePerMin: Sats;
  readonly blocks: number;
  readonly latencyMs?: number;
}

export interface UploadInput {
  /**
   * v5 (SE-1, L6-0): Desktop — the renderer passes an opaque FILE TOKEN minted by the main
   * process for a file the user picked, never a path; the host resolves it to a path before
   * the pipeline runs (an unknown token is `file-token-invalid`). Web: a File (the gateway
   * transcodes after the BUD-02 upload, Stage 3).
   */
  readonly file: string | FileLike;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly kind: 21 | 22;
  readonly mints: readonly MintUrl[];
  readonly satsPerBlock: Sats;
  readonly split: { readonly seeder: number; readonly creator: number };
  readonly thumbnailChoice?: number | BlobLike;
  /**
   * v8 (ADR 0020): also package this video for NFX — CMAF files named by sha256 and a hash list,
   * kept in the node's NFX store — once the legacy upload has published. Free videos only
   * (`satsPerBlock` 0, issue #15): every boundary refuses `nfx` on a priced video, so the free
   * NFX path never undercuts a paid one. Absent or `false`: legacy only. An NFX failure never
   * fails the legacy upload.
   */
  readonly nfx?: boolean;
  // v6: no `mirrorTo` — media lives on Pear only (Cameron, 2026-09-25); nothing is mirrored to
  // Blossom servers and our manifests name none.
}

export type UploadProgress =
  | { readonly stage: 'probing' }
  | { readonly stage: 'transcoding'; readonly rendition: string; readonly percent: number }
  | { readonly stage: 'thumbnails'; readonly candidates: readonly string[] }
  | { readonly stage: 'writing'; readonly rendition: string; readonly percent: number }
  | { readonly stage: 'publishing' }
  | { readonly stage: 'done'; readonly video: VideoManifest }
  | { readonly stage: 'error'; readonly message: string };

export interface SeederStatus {
  readonly enabled: boolean;
  readonly pubkey: NostrPubkey;
  readonly videos: number;
  readonly bytesStored: number;
  readonly diskCapBytes: number;
  readonly peers: readonly PeerWindow[];
  readonly earned: {
    readonly total: Sats;
    readonly unswapped: Sats;
    readonly byMint: ReadonlyMap<MintUrl, Sats>;
  };
  readonly banned: readonly {
    readonly pubkey: NostrPubkey;
    readonly reason: string;
    readonly at: UnixSeconds;
  }[];
}

/**
 * v10 (ADR 0020, slice 5a): the NFX networks this build speaks (NFX-01 namespaces). Phase 1 is
 * nfx's testnet only; a namespace outside this list is refused at every boundary.
 */
export const NFX_NETWORKS = ['nfx:testnet:1'] as const;
export type NfxNetwork = (typeof NFX_NETWORKS)[number];

/** v10: the most NFX-04 scoped relays one network may list. */
export const MAX_NFX_SCOPED_RELAYS = 8 as const;

/** v12: the most iroh relays (NFX-06 §1) one network may list. */
export const MAX_NFX_IROH_RELAYS = 4 as const;

/**
 * v10 (ADR 0020): taking part in an NFX network. Off unless `enabled`: no NFX query, listing,
 * seeding or beacon happens without it.
 */
export interface NfxSettings {
  readonly enabled: boolean;
  readonly network: NfxNetwork;
  /**
   * The network's NFX-04 scoped relays: `wss://`, or `ws://` to a loopback address only (a
   * local node's embedded relay); unique; at most `MAX_NFX_SCOPED_RELAYS`. Beacons go here and
   * nowhere else (NFX-03 §7); the catalogue reads them only when the read relays have nothing
   * (NFX-04 §4).
   */
  readonly scopedRelays: readonly RelayUrl[];
  /**
   * v12 (ADR 0021): the network's own iroh relays (NFX-06 §1), the only relays the iroh helper
   * uses and the only ones beacons name; a relay a ticket names that is not here is dropped.
   * Unique; at most `MAX_NFX_IROH_RELAYS`. Absent = none: without one, iroh connects directly or
   * not at all. A local setting, never taken from a beacon.
   */
  readonly irohRelays?: readonly IrohRelayUrl[];
}

export interface Settings {
  readonly relays: readonly RelayConfig[];
  readonly defaultMints: readonly MintUrl[];
  readonly seeding: {
    readonly enabled: boolean;
    readonly diskCapBytes: number;
    /**
     * v6 (ADR 0015): serve creators' thumbnails and avatars (their profile cores), free, while
     * seeding. Absent = `true`. `false`: images are read for display and not served.
     */
    readonly serveImages?: boolean;
  };
  readonly prefetchSeconds: number;
  readonly hoverPreview: boolean;
  /**
   * v6 (security review F18, Cameron 2026-09-24): `false` (the default) loads only images whose
   * sha256 the publisher signed (a Blossom `x` / `image-x`), verified; any other image — a
   * tracking pixel in waiting — is refused and the UI keeps its placeholder. `true` loads any
   * `https:` image, and its host sees the viewer's IP address.
   */
  readonly loadRemoteImages: boolean;
  readonly theme: 'dark' | 'light' | 'system';
  /** v10 (ADR 0020): absent = off. */
  readonly nfx?: NfxSettings;
  /**
   * v5 (L5-Settings/Wallet, L6-B, SE-4) — normative: `belowSats <= 0` means DISABLED (a patch
   * cannot remove the key, so "off" is written as 0). `belowSats` is compared with the balance
   * at the mint a payment is about to draw from, and the top-up is funded from `fromMint`
   * (melt there, mint at the target); it never fires for `fromMint` itself. The target must be
   * one of `defaultMints` — never a mint first seen in a video's manifest (security review F4:
   * a creator's own mint would otherwise receive the user's sats unattended).
   *
   * v6 amendment (Stage 3, issue #2, Cameron 2026-09-24) — auto top-ups EXECUTE: off by default
   * (absent, or `belowSats <= 0`); each top-up moves `amountSats` (1 … `AUTO_TOP_UP_MAX_SATS`;
   * absent = `AUTO_TOP_UP_MAX_SATS`), at most `AUTO_TOP_UP_MAX_SATS_PER_DAY` in any rolling
   * 24 hours; the first top-up into a given mint needs the money gate's native confirm; every
   * top-up is a wallet history entry.
   */
  readonly autoTopUp?: {
    readonly belowSats: Sats;
    readonly fromMint: MintUrl;
    readonly amountSats?: Sats;
  };
}

/** Issue #2: the most one auto top-up moves (and the default top-up size). */
export const AUTO_TOP_UP_MAX_SATS = 10_000;
/** Issue #2: the most auto top-ups move in any rolling 24 hours. */
export const AUTO_TOP_UP_MAX_SATS_PER_DAY = 50_000;

export interface NetworkAdapter {
  /** Which shell we are in. The UI uses this only for capability copy, never for logic. */
  readonly platform: 'desktop' | 'web' | 'mock';

  // ---- identity ------------------------------------------------------------------
  signer(): Promise<SignerStatus>;
  me(): Promise<NostrPubkey | null>;
  profile(pubkey: NostrPubkey): Promise<Profile | null>;
  /**
   * v6 (ADR 0015 part c): set the signed-in user's profile picture. The image (JPEG, PNG or WebP,
   * at most `MAX_IMAGE_BYTES`) goes into their profile core on Pear, and their kind 0 is
   * re-published with every other field kept and `picture` = its `hyper://` URL (+ sha256, size).
   */
  setProfilePicture(image: { readonly bytes: Uint8Array; readonly type: string }): Promise<Profile>;

  // ---- catalog -------------------------------------------------------------------
  /** v9: may hold NFX videos (subscriptions, tags, author); trending and shorts are NIP-71 only. */
  feed(q: FeedQuery): Promise<Page<CatalogVideo>>;
  video(id: NostrEventId): Promise<VideoManifest | null>;
  /** v9 (ADR 0020): the current revision of an NFX manifest, unless deleted or not free. */
  nfxVideo(addr: NfxAddress): Promise<NfxVideo | null>;
  /**
   * v11 (ADR 0020 slice 5d): play a free NFX video from the seeders its beacons name, every file
   * checked against the hash list. `rendition` is a hash-list rendition id (default: the best).
   */
  playNfx(addr: NfxAddress, rendition?: string): Promise<NfxPlaySession>;
  stats(id: NostrEventId): Promise<VideoStats>;
  related(id: NostrEventId, limit?: number): Promise<readonly VideoManifest[]>;
  search(q: {
    readonly text: string;
    readonly cursor?: string;
    readonly filters?: SearchFilters;
  }): Promise<Page<CatalogVideo>>;

  // ---- social --------------------------------------------------------------------
  comments(videoId: NostrEventId, sort: 'new' | 'top', cursor?: string): Promise<Page<Comment>>;
  comment(videoId: NostrEventId, content: string, parent?: NostrEventId): Promise<Comment>;
  /**
   * NIP-25 reaction content: `+` (like), `-` (dislike) or an emoji. Publishing a new
   * reaction replaces the viewer's previous one (clients count the newest per pubkey), so
   * like -> dislike is a second `react`, not an `unreact` first.
   */
  react(videoId: NostrEventId, reaction: string): Promise<void>;
  /**
   * v4: withdraw the viewer's reaction on the video (NIP-09 deletion request for their
   * kind-7 events on it). Returns the viewer to neutral. Never implemented as a `-`
   * reaction: dislikes are public, so un-like must not register as one.
   */
  unreact(videoId: NostrEventId): Promise<void>;
  nutzap(videoId: NostrEventId, amount: Sats, mint: MintUrl, comment?: string): Promise<void>;
  subscribe(channel: NostrPubkey): Promise<void>;
  unsubscribe(channel: NostrPubkey): Promise<void>;
  subscriptions(): Promise<readonly NostrPubkey[]>;
  report(videoId: NostrEventId, reason: string): Promise<void>;

  // ---- library (NIP-51; private sets are encrypted) ------------------------------
  library: {
    history(cursor?: string): Promise<
      Page<{
        readonly video: VideoManifest;
        readonly positionSec: number;
        readonly at: UnixSeconds;
      }>
    >;
    recordProgress(videoId: NostrEventId, positionSec: number): Promise<void>;
    watchLater(): Promise<readonly VideoManifest[]>;
    setWatchLater(videoId: NostrEventId, on: boolean): Promise<void>;
    playlists(author?: NostrPubkey): Promise<readonly Playlist[]>;
    savePlaylist(p: Omit<Playlist, 'id' | 'author'> & { readonly id?: string }): Promise<Playlist>;
    liked(): Promise<readonly VideoManifest[]>;
  };

  // ---- playback ------------------------------------------------------------------
  play(videoId: NostrEventId, rendition?: string): Promise<PlaySession>;
  /**
   * Verifies the Blossom `x` hash before handing back a displayable URL (T16). v6 (ADR 0015): a
   * `hyper://` image (a creator's profile core) is read over Pear and needs `sha256` AND `size`
   * (`Rendition.image.size`, `Profile.pictureSize`).
   */
  image(url: string, sha256?: Sha256Hex, size?: number): Promise<string>;

  // ---- money ---------------------------------------------------------------------
  readonly wallet: Wallet;

  // ---- studio --------------------------------------------------------------------
  studio: {
    upload(input: UploadInput, onProgress: (p: UploadProgress) => void): Promise<VideoManifest>;
    myVideos(cursor?: string): Promise<Page<VideoManifest>>;
    analytics(
      videoId: NostrEventId,
    ): Promise<VideoStats & { readonly satsByRendition: ReadonlyMap<string, Sats> }>;
  };

  // ---- seeder --------------------------------------------------------------------
  seeder: {
    status(): Promise<SeederStatus>;
    setEnabled(on: boolean): Promise<void>;
    melt(mint: MintUrl, bolt11: string): Promise<{ paid: boolean }>;
    unban(pubkey: NostrPubkey): Promise<void>;
    onStatus(cb: (s: SeederStatus) => void): Unsubscribe;
  };

  // ---- settings ------------------------------------------------------------------
  settings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;

  // ---- live ----------------------------------------------------------------------
  /** New videos from followed channels + replies to my comments, while open. */
  notifications(cb: (n: Notification) => void): Unsubscribe;
}

export interface SearchFilters {
  readonly since?: UnixSeconds;
  readonly until?: UnixSeconds;
  readonly minDurationSec?: number;
  readonly maxDurationSec?: number;
  readonly tags?: readonly string[];
  readonly author?: NostrPubkey;
}

export interface Playlist {
  readonly id: string; // NIP-51 `d` tag
  readonly author: NostrPubkey;
  readonly title: string;
  readonly description?: string;
  readonly videoIds: readonly NostrEventId[];
  readonly isPrivate: boolean;
}

export type Notification =
  | { readonly type: 'new-video'; readonly video: VideoManifest }
  | { readonly type: 'reply'; readonly comment: Comment; readonly videoId: NostrEventId }
  | { readonly type: 'nutzap-received'; readonly amount: Sats; readonly videoId?: NostrEventId };
