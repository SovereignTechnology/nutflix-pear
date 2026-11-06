/**
 * Host ⇄ worker protocol (design §2 "Host ⇄ worker"), carried by `./framing.ts` over the
 * pear-runtime/bare-sidecar IPC pipe (`Bare.IPC` in the worker). JSON only: keys and blob ids
 * are hex, Maps are `WireMap`, bytes are lower-case hex strings.
 *
 *   requests   `{ op: 'req', id, m, a }`  — `a` is ONE object (named fields, not a tuple)
 *   responses  `{ op: 'res', id, ok: true, r }` | `{ op: 'res', id, ok: false, e: WireError }`
 *   events     `{ op: 'ev', e, …fields }` — worker → host only
 *
 * Each side numbers its own requests; `id` is only unique per direction. Both sides validate
 * everything they receive with `./worker-guards.ts` (the host because the worker handles peer
 * data; the worker because the host is Node with a network stack).
 *
 * Runtime-neutral like the rest of `src/ipc/`: type-only imports from `@sovit/core`.
 */
import type {
  BlockRange,
  CashuP2pkPubkey,
  CashuProof,
  CoreKeyHex,
  HyperblobRef,
  IrohRelayUrl,
  LockedProofSet,
  MintKeyset,
  MintUrl,
  NostrEventId,
  NostrPubkey,
  PayMessage,
  PeerSpend,
  PricePolicy,
  RenditionSpec,
  Sats,
  Settings,
  Sha256Hex,
  UnixSeconds,
  UploadInput,
  UploadProgress,
  VideoManifest,
  media,
} from '@sovit/core';
import type {
  FfmpegStatus,
  ImageMime,
  SeederStatusWire,
  SessionId,
  UploadId,
  WireError,
  WireMap,
} from './protocol.js';

/** Bumped on any incompatible change; carried by `init` and the `ready` event. */
export const WORKER_V = 1 as const;

/** The worker's playback server as the host sees it. Only main ever dials it (design §1). */
export type LoopbackLink = `http://127.0.0.1:${number}/${string}`;

/** Studio metadata: `UploadInput` without the file and the thumbnail (sent separately). */
export type UploadMeta = Omit<UploadInput, 'file' | 'thumbnailChoice'>;

// ---- host → worker ----------------------------------------------------------------------

export interface WorkerInit {
  readonly v: typeof WORKER_V;
  /** Absolute directory the worker owns (its Corestore, seeder state, transcode temp). */
  readonly storage: string;
  readonly seeding: Settings['seeding'];
  readonly prefetchSeconds: number;
  /** Binaries for probe/transcode, when configured or found by the host. */
  readonly ffmpeg?: { readonly ffmpeg: string; readonly ffprobe: string };
  /**
   * Development doubles (D1). `bootstrap` is ONLY accepted together with `mocks: true` and only
   * with `127.0.0.1` entries — the guard enforces the `--dev-mocks` fence (never a public DHT
   * with mock payments).
   */
  readonly dev?: {
    readonly mocks: boolean;
    readonly fixtures: boolean;
    readonly bootstrap?: readonly { readonly host: '127.0.0.1'; readonly port: number }[];
  };
  /**
   * Stage 3 (ADR 0012): the user's PUBLIC payment identity, present when the host's money plane
   * is live (a signer connected, the NIP-60 wallet open). With it the worker runs the real
   * engines and asks the host for every PAY, HELLO signature, redeem and nutzap (`pay.*`,
   * `seller.*`); without it (and without `dev.mocks`) it runs no swarm. Never with `dev.mocks`.
   */
  readonly payments?: {
    readonly pubkey: NostrPubkey;
    /** The NIP-60 wallet's P2PK key: HELLO `p2pk`, what peers lock the seeder share to. */
    readonly p2pk: CashuP2pkPubkey;
    /** Mints the wallet takes payment at and pays from. */
    readonly mints: readonly MintUrl[];
  };
  /**
   * Slice 5b (ADR 0020): `Settings.nfx.enabled` at start; later changes come as `nfx.configure`.
   * The worker serves its NFX videos over HyperDHT only while this AND seeding are on. Absent =
   * off. The network is the one the worker packages for (contracts v10 has one). Slice 5e-3: with
   * the network's iroh relays (`Settings.nfx.irohRelays`, none when unset).
   */
  readonly nfx?: NfxConfigureArgs;
  /**
   * Slice 5e-3 (ADR 0021): the iroh helper's executable, absolute. With it, and while NFX seeding
   * is on, the worker also serves its NFX videos over iroh (NFX-06); without it (absent or `null`)
   * it speaks HyperDHT only, and that is not an error. Dev and CI name it in the host's
   * environment (`NUTFLIX_IROH_HELPER`); slice 5e-5 supplies a packaged build's own copy.
   */
  readonly irohHelper?: string | null;
}

/** Slice 5b: `Settings.nfx` as the worker needs it; slice 5e-3 adds the network's iroh relays. */
export interface NfxConfigureArgs {
  readonly enabled: boolean;
  /** The only relays the iroh helper uses and beacons name (NFX-06 §1); at most 4, unique. */
  readonly irohRelays: readonly IrohRelayUrl[];
}

/** Slice 5b: an NFX-12 endpoint as a beacon carries it (NFX-03 §4, NFX-12 §2). */
export interface NfxHyperdhtEndpointWire {
  readonly t: 'hyperdht';
  /** The listener's Ed25519 key, 64 lowercase hex. */
  readonly peer: string;
  /** The peer key's signature over `nfx/hyperdht/1:<seeder>:<namespace>`, 128 lowercase hex. */
  readonly bind: string;
}

/** Slice 5e-3: the most direct addresses a beacon's iroh endpoint names. */
export const MAX_NFX_IROH_ADDRS = 16;

/**
 * Slice 5e-3: an NFX-06 endpoint as a beacon carries it (NFX-03 §4): the iroh helper's node, and
 * one BlobTicket per collection it serves for the video (NFX-06 §2).
 */
export interface NfxIrohEndpointWire {
  readonly t: 'iroh';
  /** The helper's iroh endpoint id (an Ed25519 public key), 64 lowercase hex. */
  readonly node: string;
  /** Its home relay when that is one of the network's (NFX-06 §1), else `''`. */
  readonly relay: IrohRelayUrl | '';
  /** Its direct addresses, `ip:port`, at most `MAX_NFX_IROH_ADDRS`. */
  readonly addrs: readonly string[];
  /** Collection → ticket: `meta`, and one per rendition id of the hash list. Unique keys. */
  readonly tickets: WireMap<string, string>;
}

/**
 * Slice 5e-3: where a beacon for one video says this node serves it: over HyperDHT (NFX-12) and
 * over iroh (NFX-06), each `null` while it is not served that way.
 */
export interface NfxEndpointsWire {
  readonly hyperdht: NfxHyperdhtEndpointWire | null;
  readonly iroh: NfxIrohEndpointWire | null;
}

/** Slice 5b: a video this node's NFX store holds, verified against its root when stored. */
export interface NfxStoredVideoWire {
  /** `<namespace>:<video-id>` (NFX-01). */
  readonly video: string;
  readonly root: Sha256Hex;
  readonly segs: number;
}

/** Slice 5d: the most seeders one `nfx.play.open` names. */
export const MAX_NFX_PLAY_PEERS = 16;
/** Slice 5d: the most renditions one `nfx.play.open` reports (the highest-bandwidth ones). */
export const MAX_NFX_RENDITIONS = 16;
/** Slice 5d: a rendition's `resolution` as it crosses (`<w>x<h>`, NFX-05 §2, bounded here). */
export const NFX_RESOLUTION = /^[0-9]{1,6}x[0-9]{1,6}$/;

/**
 * Slice 5d (ADR 0020): watch one free NFX video. The host found it (a verified manifest by its
 * author) and the seeders that beacon it (verified beacons, their `bind` checked); the worker
 * fetches its files from them over NFX-12 and serves one rendition as one progressive fMP4.
 */
export interface NfxPlayOpenArgs {
  /** Host-minted; one id space with `play.open`'s. */
  readonly sid: SessionId;
  /** `<namespace>:<video-id>` (NFX-01): the manifest's `d`. */
  readonly video: string;
  /** The manifest `root`: sha256 of the hash list. */
  readonly root: Sha256Hex;
  /** The manifest `segs`: how many files the hash list lists. */
  readonly segs: number;
  /** A rendition id of the hash list; absent: the highest-bandwidth one. */
  readonly rendition?: string;
  /** The beaconed `hyperdht` endpoints, in the order to try them (1..`MAX_NFX_PLAY_PEERS`). */
  readonly peers: readonly NfxHyperdhtEndpointWire[];
  readonly prefetchSeconds: number;
}

/** Slice 5d: one rendition of an NFX video, as the player's quality menu needs it. */
export interface NfxRenditionWire {
  readonly id: string;
  /** Peak bits per second (NFX-05 `bandwidth`). */
  readonly bandwidth: number;
  readonly resolution?: string;
}

export interface PlayOpenArgs {
  /** Host-minted; the worker keys the session by it. */
  readonly sid: SessionId;
  readonly videoId: NostrEventId;
  readonly rendition: {
    readonly label: string;
    readonly hyper: HyperblobRef;
    readonly size: number;
    readonly bitrateKbps?: number;
  };
  readonly durationSec?: number;
  readonly policy: PricePolicy;
  readonly prefetchSeconds: number;
}

/** A custom thumbnail on the host ⇄ worker hop (JSON): bytes as lower-case hex. */
export interface ThumbnailHex {
  readonly hex: string;
  readonly type: ImageMime;
}

export interface StudioUploadArgs {
  readonly uploadId: UploadId;
  /** Absolute path main resolved from the renderer's `FileToken` (SE-1). */
  readonly path: string;
  /** Display name (never parsed from `path`). */
  readonly name: string;
  readonly meta: UploadMeta;
  readonly thumbnailChoice?: number | ThumbnailHex;
}

/** Requests the host makes: `[args, result]`. */
export interface WorkerMethodTable {
  init: [args: WorkerInit, result: undefined];
  /** Opens the core, registers the session with the blob server's allowlist, returns the link. */
  'play.open': [
    args: PlayOpenArgs,
    result: { readonly key: CoreKeyHex; readonly link: LoopbackLink },
  ];
  'play.pause': [args: { readonly sid: SessionId }, result: undefined];
  'play.resume': [args: { readonly sid: SessionId }, result: undefined];
  'play.prefetch': [args: { readonly sid: SessionId; readonly seconds: number }, result: undefined];
  /**
   * Closes the session; its link 404s afterwards. Idempotent. Lane P2-owed-viewer: answers once
   * the session's tail was paid or its drain ran out, with `unpaid` — the blocks received for this
   * session that are still unpaid (the worker's durable record); the host then keeps a tail
   * authorisation for them (ADR 0018 amendment). A second call for a session already gone
   * answers 0.
   */
  'play.close': [args: { readonly sid: SessionId }, result: { readonly unpaid: number }];
  'seeder.status': [args: Record<string, never>, result: SeederStatusWire];
  /** Pushed by the host whenever Settings.seeding changes. */
  'seeder.configure': [args: Settings['seeding'], result: undefined];
  'seeder.melt': [
    args: { readonly mint: MintUrl; readonly bolt11: string },
    result: { readonly paid: boolean },
  ];
  'seeder.unban': [args: { readonly pubkey: NostrPubkey }, result: undefined];
  /**
   * Slice 5b: pushed by the host whenever `Settings.nfx.enabled` changes; slice 5e-3: and
   * whenever its iroh relays do.
   */
  'nfx.configure': [args: NfxConfigureArgs, result: undefined];
  /**
   * Slice 5b: the `hyperdht` endpoint for `seeder`'s beacons while NFX seeding is up, else null.
   * Slice 5e-3: per video (`<namespace>:<video-id>`), with the `iroh` endpoint while that video
   * is served over iroh. Answers at once: what is still being imported is not named yet.
   */
  'nfx.endpoint': [
    args: { readonly seeder: NostrPubkey; readonly video: string },
    result: NfxEndpointsWire,
  ];
  /** Slice 5b: the NFX videos this node stores (what its beacons may announce). */
  'nfx.videos': [
    args: Record<string, never>,
    result: { readonly videos: readonly NfxStoredVideoWire[] },
  ];
  /**
   * Slice 5d: answers once the hash list verified, the rendition's init and first segment are
   * spooled and layout C is planned; the rest arrives in the background. `link` serves the
   * whole rendition as one fMP4 (`video/mp4`, single ranges). `rendition` is the one served;
   * `renditions` lists the hash list's (at most `MAX_NFX_RENDITIONS`, by bandwidth).
   */
  'nfx.play.open': [
    args: NfxPlayOpenArgs,
    result: {
      readonly link: LoopbackLink;
      readonly rendition: string;
      readonly renditions: readonly NfxRenditionWire[];
    },
  ];
  /** Slice 5d: closes the session (its link 404s, its fetches stop, its spool goes). Idempotent. */
  'nfx.play.close': [args: { readonly sid: SessionId }, result: undefined];
  /** Probes the binary (`path` = the configured one, when set). */
  'studio.ffmpeg': [
    args: { readonly recheck: boolean; readonly path?: string },
    result: FfmpegStatus,
  ];
  /** Progress arrives as `upload.progress` events; the worker calls `studio.publish` on the host. */
  'studio.upload': [args: StudioUploadArgs, result: VideoManifest];
  /**
   * ADR 0015: read one image from a creator's profile core over Pear. The worker checks the
   * length and sha256; the bytes come back as hex.
   */
  'image.fetch': [
    args: { readonly url: string; readonly sha256: Sha256Hex; readonly size: number },
    result: { readonly hex: string },
  ];
  /** ADR 0015 part c: write an image (hex) into this node's own profile core. */
  'profile.putImage': [
    args: { readonly hex: string },
    result: { readonly url: string; readonly sha256: Sha256Hex; readonly size: number },
  ];
}
export type WorkerMethod = keyof WorkerMethodTable;

// ---- worker → host ----------------------------------------------------------------------

/** A finished rendition as the worker hands it over: `Rendition` minus Blossom-only fields. */
export type RenditionDraftWire = media.RenditionDraft;

/**
 * Everything the host needs to build + sign the NIP-71 event (`manifest.buildVideoEvent`) for
 * an upload: the host adds `creatorP2pk` and `publishedAt` and signs (v6: no Blossom servers —
 * media is on Pear only).
 */
export interface PublishDraft {
  readonly uploadId: UploadId;
  readonly meta: UploadMeta;
  readonly durationSec: number;
  readonly blockSize: number;
  readonly renditions: readonly RenditionDraftWire[];
  readonly thumbnail:
    | { readonly kind: 'candidate'; readonly path: string; readonly sha256: Sha256Hex }
    /** The bytes are the ones the host sent in `StudioUploadArgs.thumbnailChoice`. */
    | { readonly kind: 'custom'; readonly sha256: Sha256Hex; readonly type: ImageMime };
  readonly storyboard?: {
    readonly path: string;
    readonly vttPath: string;
    readonly sha256: Sha256Hex;
    readonly cols: number;
    readonly rows: number;
    readonly intervalSec: number;
  };
  readonly codec: RenditionSpec['codec'];
  /**
   * ADR 0015: the chosen thumbnail as written into the creator's profile core — the host puts it
   * on the first rendition (`image`, with `image-x` and `image-size`).
   */
  readonly thumbnailImage?: {
    readonly url: string;
    readonly sha256: Sha256Hex;
    readonly size: number;
  };
}

/** Why the NFX side of an upload did not complete (the legacy upload is unaffected). */
export type NfxUploadFailure =
  /** The renditions are not H.264 in MP4, which NFX-05 packages. */
  | 'unsupported'
  /** ffmpeg's CMAF remux or the packager's own checks failed. */
  | 'packaging-failed'
  /** The NFX files do not fit in the disk cap (one pool with the legacy store). */
  | 'disk-cap'
  /** The NFX store refused the package or could not write it. */
  | 'store-failed';

export const NFX_UPLOAD_FAILURES: readonly NfxUploadFailure[] = [
  'unsupported',
  'packaging-failed',
  'disk-cap',
  'store-failed',
];

/** `upload.nfx`: the packaged video as slice 4's publisher needs it, or why there is none. */
export type NfxUploadStatusWire =
  | {
      readonly state: 'stored';
      /** `<namespace>:<video-id>` (NFX-01): the hash list's `video`, the manifest's `d`. */
      readonly video: string;
      /** sha256 of the hash list: the manifest `root`. */
      readonly root: Sha256Hex;
      /** The manifest `segs` (a u64 as decimal text). */
      readonly segs: string;
      readonly renditions: number;
      /** Bytes the store holds for the video's files (shared files counted once). */
      readonly bytes: number;
      /** The hash list's role-`thumb` file, when the upload had one: the manifest's `thumb`. */
      readonly thumb?: { readonly sha256: Sha256Hex; readonly mime: 'image/jpeg' };
    }
  | { readonly state: 'failed'; readonly reason: NfxUploadFailure };

/** A proof set on the worker → host hop (ADR 0012: the host redeems / checks it). */
export interface ProofSetWire {
  readonly mint: MintUrl;
  readonly proofs: readonly CashuProof[];
}

/** `seller.redeem`'s answer: a spent proof is data, not an error (IPC error codes are closed). */
export type RedeemResult =
  { readonly ok: true; readonly sats: Sats } | { readonly ok: false; readonly spent: boolean };

/** Requests the worker makes: `[args, result]`. */
export interface HostMethodTable {
  'studio.publish': [args: PublishDraft, result: VideoManifest];
  /**
   * Build OUR PAY (viewer side) with the host's wallet — authorised only for an open play
   * session `sid`, the session's own core and price terms, within its block budget (ADR 0012).
   */
  'pay.build': [
    args: {
      readonly sid: SessionId;
      readonly range: BlockRange;
      readonly seeder: {
        readonly pubkey: NostrPubkey;
        readonly p2pk: CashuP2pkPubkey;
        readonly mint: MintUrl;
      };
      readonly policy: PricePolicy;
      readonly carryIn: number;
    },
    result: PayMessage,
  ];
  /** Sign OUR HELLO for a connection (the host signs nothing else for the worker). */
  'pay.hello': [
    args: { readonly challenge: string },
    result: {
      readonly pubkey: NostrPubkey;
      readonly createdAt: UnixSeconds;
      readonly signature: string;
    },
  ];
  /** Seeder side (the worker's engine hooks). */
  'seller.keyset': [
    args: { readonly mint: MintUrl; readonly id: string },
    result: MintKeyset | null,
  ];
  'seller.redeem': [args: ProofSetWire, result: RedeemResult];
  'seller.checkSpent': [args: ProofSetWire, result: readonly boolean[]];
  'seller.spentByUs': [args: ProofSetWire, result: boolean];
  /** Publish the creator's share of a flush as one NIP-61 nutzap. */
  'seller.nutzap': [
    args: { readonly set: LockedProofSet; readonly core: CoreKeyHex },
    result: undefined,
  ];
}
export type HostMethod = keyof HostMethodTable;

export type WorkerLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Worker → host events. `spend` is per PAY: the host debits its wallet by `amount` (§1). */
export type WorkerEvent =
  | { readonly op: 'ev'; readonly e: 'ready'; readonly v: typeof WORKER_V; readonly port: number }
  | {
      readonly op: 'ev';
      readonly e: 'spend';
      readonly sid: SessionId;
      readonly mint: MintUrl;
      /** Sats paid by this PAY (the delta). */
      readonly amount: Sats;
      /** Session total so far. */
      readonly total: Sats;
      readonly ratePerMin: Sats;
    }
  | {
      readonly op: 'ev';
      readonly e: 'peers';
      readonly sid: SessionId;
      readonly peers: readonly PeerSpend[];
    }
  | { readonly op: 'ev'; readonly e: 'seeder.status'; readonly status: SeederStatusWire }
  | {
      readonly op: 'ev';
      readonly e: 'upload.progress';
      readonly uploadId: UploadId;
      /** `thumbnails.candidates` are absolute paths here; the host maps them to `nf-media://img/…`. */
      readonly progress: UploadProgress;
    }
  /**
   * Contracts v8 (ADR 0020): the NFX side of an upload asked for with `meta.nfx`, after the
   * legacy upload published. Its own status: it never changes the legacy upload's result.
   */
  | {
      readonly op: 'ev';
      readonly e: 'upload.nfx';
      readonly uploadId: UploadId;
      readonly status: NfxUploadStatusWire;
    }
  /** `--dev-fixtures` only: live manifests of the worker's fixture cores (unsigned, dev). */
  | { readonly op: 'ev'; readonly e: 'dev.fixtures'; readonly videos: readonly VideoManifest[] }
  /** Already redacted by the worker's logger. */
  | { readonly op: 'ev'; readonly e: 'log'; readonly level: WorkerLogLevel; readonly msg: string };
export type WorkerEventName = WorkerEvent['e'];

// ---- envelopes --------------------------------------------------------------------------

export type Req<T, M extends keyof T = keyof T> = {
  [K in M]: {
    readonly op: 'req';
    readonly id: number;
    readonly m: K;
    readonly a: T[K] extends [infer A, unknown] ? A : never;
  };
}[M];

export type Res<R = unknown> =
  | { readonly op: 'res'; readonly id: number; readonly ok: true; readonly r: R }
  | { readonly op: 'res'; readonly id: number; readonly ok: false; readonly e: WireError };

/** What the worker reads from `Bare.IPC`. */
export type HostToWorker = Req<WorkerMethodTable> | Res;
/** What the host reads from the sidecar duplex. */
export type WorkerToHost = Req<HostMethodTable> | Res | WorkerEvent;
