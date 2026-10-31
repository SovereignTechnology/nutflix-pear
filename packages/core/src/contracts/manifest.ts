import type { NostrEvent } from './nostr.js';
import type {
  CashuP2pkPubkey,
  CoreKeyHex,
  MintUrl,
  NfxAddress,
  NostrEventId,
  NostrPubkey,
  Sats,
  Sha256Hex,
  UnixSeconds,
} from './primitives.js';

/**
 * Video manifest = a parsed, verified NIP-71 event (build-plan §2.2).
 *
 * Two identities per rendition (assumption A2):
 *   - Blossom identity: `sha256` of the full file (the `x` in imeta)
 *   - transport identity: Hypercore key + Hyperblobs id
 */

/**
 * Hyperblobs blob id, exactly as returned by `Hyperblobs.put()`:
 * `{ byteOffset, blockOffset, blockLength, byteLength }`. Verify against
 * docs/vendor/hyperblobs.md before assuming field names.
 */
export interface HyperblobId {
  readonly byteOffset: number;
  readonly blockOffset: number;
  readonly blockLength: number;
  readonly byteLength: number;
}

export interface HyperblobRef {
  readonly core: CoreKeyHex;
  readonly blob: HyperblobId;
}

/** Hyperblobs default block size. Assumption A9 CONFIRMED against hyperblobs@2.12.1 README (`blockSize: 64KB`). */
export const DEFAULT_BLOCK_SIZE = 65_536 as const;

/** Default unpaid window in blocks (assumption A4 — refined by spike S-A; threat T3). */
export const DEFAULT_WINDOW_BLOCKS = 4 as const;

/**
 * v5 (ADR 0007, amended by ADR 0010): the PAY size viewers batch to when a policy does not
 * set `minPaySats`. Each PAY is a P2PK proof set and a mint round-trip, and mints charge per
 * input, so a 1–4 sat PAY can cost more in fees and round-trips than it carries.
 */
export const DEFAULT_MIN_PAY_SATS = 10 as const;

/**
 * v5 amendment (Stage 3, 2026-09-24): the most blocks a minimum PAY may widen the unpaid window
 * to. A creator's `minpay` is untrusted: unbounded, it would make every seeder of the video grant
 * a huge unpaid window (and a seeder may serve below the manifest price, so a bound on the tag
 * alone cannot hold). The effective window is
 * `max(windowBlocks, min(ceil(minPaySats / satsPerBlock), MAX_MIN_PAY_WINDOW_BLOCKS))` — a
 * seeder's own larger `windowBlocks` still wins. Viewers then pay PAYs below the minimum, which
 * a seeder never refuses (ADR 0010 §3.3).
 */
export const MAX_MIN_PAY_WINDOW_BLOCKS = 64 as const;

/** v6 (ADR 0015): the largest image (thumbnail, avatar) fetched or published, in bytes. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The largest `minpay` a manifest may state (a sanity bound; the window cap is the real one). */
export const MAX_MIN_PAY_SATS = 1_000_000 as const;

export interface Rendition {
  /** Label shown in the player, e.g. "1080p". */
  readonly label: string;
  readonly mime: 'video/mp4' | 'video/webm' | (string & {});
  readonly sha256: Sha256Hex;
  readonly size: number;
  readonly width?: number;
  readonly height?: number;
  readonly bitrateKbps?: number;
  readonly hyper: HyperblobRef;
  /**
   * As written in the imeta `url`:
   * `hyper://<core key, 64-char lower-case hex>/<blockOffset>-<blockLength>[+<byteOffset>]`.
   * `byteLength` is the imeta `size`; `+<byteOffset>` only when non-zero. z32 core keys are
   * NOT accepted (`manifest/hyper-url.ts`, `media/hyper-url.ts`, `mocks/fixtures.ts` agree).
   */
  readonly hyperUrl: string;
  /**
   * Blossom HTTP fallbacks (`fallback` entries) as another publisher wrote them. v6: Nutflix
   * never fetches them — media is on Pear only — and never writes any (Studio emits `[]`).
   */
  readonly fallbacks: readonly string[];
  /**
   * Thumbnail; its sha256 is verified before display (T16). v6 (ADR 0015): a `hyper://` URL in the
   * creator's profile core — then `sha256` and `size` (imeta `image-size`, ≤ `MAX_IMAGE_BYTES`) are
   * REQUIRED and the parser checks the URL against the size. Otherwise another publisher's `https:`.
   */
  readonly image?: { readonly url: string; readonly sha256?: Sha256Hex; readonly size?: number };
  /** Optional tiny inline placeholder (data: URL) for blur-up. */
  readonly placeholder?: string;
  /** WebVTT captions as a Blossom blob. */
  readonly captions?: readonly {
    readonly lang: string;
    readonly url: string;
    readonly sha256?: Sha256Hex;
  }[];
  /** Storyboard sprite for scrub preview. */
  readonly storyboard?: {
    readonly url: string;
    readonly sha256?: Sha256Hex;
    readonly cols: number;
    readonly rows: number;
    readonly intervalSec: number;
  };
}

export interface PricePolicy {
  /** Sats per block (block size from `blockSize`). Integer. */
  readonly satsPerBlock: Sats;
  readonly blockSize: number;
  /** Creator-chosen mint(s). Open question 2: one or several. */
  readonly mints: readonly MintUrl[];
  /**
   * Percentages, integers, must sum to 100. Default 50/50 if the `split` tag is absent.
   * Per-PAY split (ADR 0005 Q1, amended by ADR 0007, specified by ADR 0010 — contracts v5):
   * the creator's fractional share is carried across PAYs on the same channel × core, see
   * `PayMessage`. With `carryIn = 0` it is ADR 0005's rule, `seederSats = ceil(amount ×
   * seeder / 100)`.
   */
  readonly split: { readonly seeder: number; readonly creator: number };
  /**
   * v5 (ADR 0007 as amended by ADR 0010 §minimum): the PAY size in sats a viewer SHOULD batch
   * to; absent = `DEFAULT_MIN_PAY_SATS` (10). The unpaid window must fit one such PAY, so the
   * effective window for this video is `max(windowBlocks, min(ceil(minPaySats / satsPerBlock),
   * MAX_MIN_PAY_WINDOW_BLOCKS))` (`effectiveWindowBlocks`). A seeder does NOT refuse a smaller
   * PAY: a viewer streaming from several seeders under one credit budget cannot always reach it
   * (ADR 0010). A creator raises it with the NIP-71 `minpay` tag (1 … `MAX_MIN_PAY_SATS`).
   */
  readonly minPaySats?: Sats;
  /** Creator's Cashu P2PK pubkey from their kind 10019. */
  readonly creatorP2pk: CashuP2pkPubkey;
}

export interface VideoManifest {
  readonly id: NostrEventId;
  readonly kind: 21 | 22;
  readonly author: NostrPubkey;
  readonly title: string;
  readonly description: string; // raw content; UI renders via the markdown subset only
  readonly publishedAt: UnixSeconds;
  readonly durationSec?: number;
  readonly tags: readonly string[]; // `t` hashtags
  readonly renditions: readonly Rendition[];
  readonly price: PricePolicy;
  /** `blossom` tags as another publisher wrote them; v6: never fetched, never written by Studio. */
  readonly blossomServers: readonly string[];
  /** The verified source event. Signature has been checked before this object exists. */
  readonly event: NostrEvent;
}

/**
 * v9 (ADR 0020, Phase 1): a parsed, verified NFX manifest (kind 38504, NFX-02), for listing.
 *
 * Always free: only a manifest with `license open` and no `price_hint` (or `0`) becomes one,
 * because this app cannot pay on NFX yet. It has no `PricePolicy` and no Hyperblob renditions:
 * its files are named by sha256 under `root` (NFX-05) and fetched over an NFX transport, so
 * nothing that pays, plays or fetches by URL takes one.
 */
export interface NfxVideo {
  readonly kind: 38504;
  /** The stable identity: the manifest's address. */
  readonly id: NfxAddress;
  /** The current revision's event id (NFX-02 §4 "Revisions"); it changes when the creator edits. */
  readonly eventId: NostrEventId;
  readonly author: NostrPubkey;
  readonly title: string;
  readonly description: string; // raw markdown; UI renders via the markdown subset only
  readonly publishedAt: UnixSeconds;
  readonly durationSec?: number;
  readonly tags: readonly string[]; // `t` hashtags
  /** `nfx:<network>:<specver>` (NFX-01). */
  readonly namespace: string;
  /** sha256 of the hash list (NFX-05): the integrity anchor of every file. */
  readonly root: Sha256Hex;
  readonly segs: number;
  /** A poster in the NFX file store, by sha256; never fetched by URL. */
  readonly thumb?: { readonly sha256: Sha256Hex; readonly mime: string };
  /** The NIP-71 event this manifest links to with `e`. The catalog trusts it only from the same author. */
  readonly legacyId?: NostrEventId;
  /** The verified source event. */
  readonly event: NostrEvent;
}

/** v9: what a catalog listing can hold, a NIP-71 video or an NFX one; narrow on `kind`. */
export type CatalogVideo = VideoManifest | NfxVideo;

/**
 * NIP-71 tag schema as published by this network. A `build` produces exactly these tags;
 * `parse` accepts a superset and ignores unknown tags; `verify` checks the signature and
 * that every rendition carries a `x` hash and a `hyper://` url.
 */
export interface Nip71TagSchema {
  readonly title: ['title', string];
  readonly published_at: ['published_at', string];
  readonly imeta: ['imeta', ...string[]]; // space-separated key/value pairs per NIP-92
  readonly mint: ['mint', string];
  readonly price: ['price', string, 'sat'];
  /** v5 (ADR 0010): optional; absent = `DEFAULT_MIN_PAY_SATS`. */
  readonly minpay?: ['minpay', string, 'sat'];
  readonly split: ['split', `seeder:${number}`, `creator:${number}`];
  readonly p2pk: ['p2pk', string];
  readonly t: ['t', string];
  readonly duration: ['duration', string];
  readonly blossom: ['blossom', string];
  readonly alt?: ['alt', string];
}

export type ManifestError =
  | { readonly code: 'bad-signature' }
  | { readonly code: 'wrong-kind'; readonly kind: number }
  | { readonly code: 'missing-tag'; readonly tag: keyof Nip71TagSchema }
  | { readonly code: 'bad-imeta'; readonly index: number; readonly reason: string }
  | { readonly code: 'bad-price'; readonly reason: string }
  | { readonly code: 'bad-split'; readonly reason: string };
