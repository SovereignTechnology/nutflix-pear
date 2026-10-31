/**
 * Desktop IPC protocol (lane L6-0; design `docs/plan/L6-design.md` §2). FROZEN for L6-A/B/C:
 * change it only through `docs/archive/contract-requests/`.
 *
 * Three hops use it:
 *   renderer ⇄ main   `ipcRenderer.invoke` on `CHANNEL.*` (structured clone), gated in main
 *                     (sender frame, then `validateArgs`) — `CallMsg` / `SubMsg` / `ReplyMsg` /
 *                     `EventMsg`.
 *   main ⇄ host       `utilityProcess` parentPort (structured clone) — `HostIn` / `HostOut`;
 *                     the host runs the same guards again.
 *   host ⇄ worker     `./worker-protocol.ts` over `./framing.ts` (length-prefixed JSON).
 *
 * Pure TypeScript: no electron / node / bare imports, and only TYPE imports from `@sovit/core`
 * (its root barrel loads nostr-tools, which crashes under Bare at module load). This module runs
 * unchanged in main, host, preload, renderer and the Bare worker.
 */
import type {
  AUTO_TOP_UP_MAX_SATS,
  AUTO_TOP_UP_MAX_SATS_PER_DAY,
  MAX_NFX_SCOPED_RELAYS,
  CatalogVideo,
  Comment,
  FeedQuery,
  MeltQuote,
  MintQuote,
  MintUrl,
  NetworkAdapter,
  NfxAddress,
  NfxNetwork,
  NfxVideo,
  Notification,
  NostrEventId,
  NostrPubkey,
  Page,
  PeerSpend,
  Playlist,
  PricePolicy,
  Profile,
  SearchFilters,
  SeederStatus,
  Sats,
  Settings,
  Sha256Hex,
  SignerStatus,
  UnixSeconds,
  UploadInput,
  UploadProgress,
  VideoManifest,
  VideoStats,
  WalletChangeEvent,
  WalletHistoryEntry,
  media,
  wallet as walletTypes,
} from '@sovit/core';

// ---- versions, channels, limits ---------------------------------------------------------

/** Renderer ⇄ main ⇄ host message version. Every message carries `v: IPC_V`. */
export const IPC_V = 1 as const;

/** `ipcMain.handle` channel names. Everything else the renderer sends is dropped by main. */
export const CHANNEL = {
  /** `invoke(call, CallMsg)` → `ReplyMsg`. */
  call: 'nf:call',
  /** `invoke(sub, SubMsg)` → `ReplyMsg` with `id = subId` (acknowledges sub and unsub). */
  sub: 'nf:sub',
  /** main → renderer `webContents.send(event, EventMsg)`. */
  event: 'nf:event',
  /** `invoke(grant, GrantFileMsg)` → `ReplyMsg` whose result is a `FileToken` (SE-1). */
  grant: 'nf:grant-file',
} as const;
export type Channel = (typeof CHANNEL)[keyof typeof CHANNEL];

/**
 * ADR 0013: the prompt page's two `ipcMain.handle` channels (its own preload, its own origin).
 * Main accepts them only from the open prompt window; the app window's preload never uses them.
 */
export const PROMPT_CHANNEL = {
  /** `invoke(init)` → the `PromptForm` to show, or `null`. */
  init: 'nf-prompt:init',
  /** `invoke(answer, PageAnswer | null)` → `true` when main took it. */
  answer: 'nf-prompt:answer',
} as const;

/** Contracts v10: the NFX networks the guards accept — core's `NFX_NETWORKS` (checked below). */
export const NFX_NETWORK_IDS = ['nfx:testnet:1'] as const;

/**
 * Hard caps enforced by the guards (and, for the last two, by main's IPC gate per
 * webContents). A value over a cap is rejected, never truncated.
 */
export const LIMITS = {
  /** Any single string field unless a tighter cap below applies (UTF-16 code units). */
  maxString: 4096,
  /** Long text bodies: comment content, video description. */
  maxBody: 16384,
  /** Any array unless a tighter cap below applies. */
  maxArray: 256,
  /** `Playlist.videoIds` (NIP-51 sets grow past `maxArray`). */
  maxPlaylistItems: 1000,
  /** Image / caption URLs passed to `image()` (query strings allowed). */
  maxUrl: 2048,
  /** Relay, mint and Blossom server URLs — `MAX_URL_LENGTH` in the Settings screen. */
  maxServerUrl: 512,
  /** One hashtag. */
  maxTag: 128,
  /** Short labels: rendition label, reaction, NIP-51 `d`, quote id. */
  maxLabel: 256,
  /** Page size a caller may ask for (`feed`, `related`, `wallet.history`). */
  maxPage: 200,
  /** `setPrefetchSeconds` / `Settings.prefetchSeconds` ceiling ("buffer = money"). */
  maxPrefetchSec: 600,
  /** 21 M BTC in sats — every `Sats` value is an integer in `[0, maxSats]`. */
  maxSats: 2_100_000_000_000_000,
  /** `Settings.seeding.diskCapBytes` ceiling: 10 000 GiB (Settings' `DISK_CAP_MAX_GB`). */
  maxDiskCapBytes: 10_000 * 1024 ** 3,
  /**
   * `Settings.autoTopUp.belowSats` ceiling (the Settings screen's threshold maximum) — a
   * threshold, not an amount (was `maxAutoTopUpSats`; renamed in issue #2's independent review).
   */
  maxAutoTopUpThresholdSats: 10_000_000,
  /**
   * Issue #2: `Settings.autoTopUp.amountSats` ceiling and the most one auto top-up moves — core's
   * `AUTO_TOP_UP_MAX_SATS` (pinned below; this module imports no core runtime code).
   */
  maxAutoTopUpAmountSats: 10_000,
  /** Issue #2: the most auto top-ups move in any rolling 24 h — core's `AUTO_TOP_UP_MAX_SATS_PER_DAY`. */
  maxAutoTopUpSatsPerDay: 50_000,
  /** Contracts v10: `NfxSettings.scopedRelays` — core's `MAX_NFX_SCOPED_RELAYS`. */
  maxNfxScopedRelays: 8,
  /** `PricePolicy.minPaySats` ceiling — core's `MAX_MIN_PAY_SATS` (the manifest parser's bound). */
  maxMinPaySats: 1_000_000,
  /** A custom thumbnail's bytes (same cap as host-fetched images, design §3). */
  maxThumbnailBytes: 5 * 1024 * 1024,
  /** `WireError.message` after sanitising. */
  maxErrorMessage: 512,
  /** Absolute file paths (grant-file, host ⇄ worker). */
  maxPath: 4096,
  /** Nesting depth `rehydrate`/`dehydrate` will walk. */
  maxDepth: 64,
  /** Calls in flight per webContents before main answers `rate-limited`. */
  inflightPerWc: 64,
  /** Live subscriptions per webContents before main answers `rate-limited`. */
  subsPerWc: 256,
} as const;

// ---- ids and tokens ---------------------------------------------------------------------

declare const ipcBrand: unique symbol;
type IpcBrand<T, B extends string> = T & { readonly [ipcBrand]: B };

/** Host-minted play-session id: 32 lower-case hex (128 bits), bound to one webContents. */
export type SessionId = IpcBrand<string, 'SessionId'>;
/** Preload-minted upload id: 32 lower-case hex; keys the `upload.progress` topic. */
export type UploadId = IpcBrand<string, 'UploadId'>;
/**
 * SE-1: main-minted opaque token standing for one user-chosen file — `nf-file:` + 32 lower-case
 * hex. Single-use, per webContents, 10-minute TTL. Main swaps it for the path only when relaying
 * `studio.upload`; any other string in `UploadInputWire.file` is `file-token-invalid`.
 */
export type FileToken = `nf-file:${string}`;
/** What the renderer plays: main's `nf-media:` proxy in front of the worker's blob server. */
export type NfMediaPlayUrl = `nf-media://play/${string}`;
/** What `image()` resolves to and Studio thumbnail candidates are: served by main from the host. */
export type NfMediaImgUrl = `nf-media://img/${string}`;
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';
export const IMAGE_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const satisfies readonly ImageMime[];

// ---- Map-free wire shapes ---------------------------------------------------------------

/**
 * A `ReadonlyMap` flattened for the wire (contextBridge is not trusted to carry Maps; JSON
 * cannot). `./wiremap.ts` converts; the renderer rebuilds Maps with `rehydrate`.
 */
export interface WireMap<K extends string, V> {
  readonly $map: readonly (readonly [K, V])[];
}

/** `SeederStatus` with `earned.byMint` as a `WireMap`. */
export type SeederStatusWire = Omit<SeederStatus, 'earned'> & {
  readonly earned: Omit<SeederStatus['earned'], 'byMint'> & {
    readonly byMint: WireMap<MintUrl, Sats>;
  };
};

/** `studio.analytics` result with `satsByRendition` as a `WireMap`. */
export type AnalyticsWire = VideoStats & { readonly satsByRendition: WireMap<string, Sats> };

/**
 * `PlaySession` minus its methods. The preload builds the real `PlaySession` around `sid`:
 * `pause`/`resume`/`setPrefetchSeconds`/`switchRendition`/`close` → `session.*` calls,
 * `onPeers`/`onSpend` → `session.peers`/`session.spend` topics.
 */
export interface PlaySessionWire {
  readonly sid: SessionId;
  readonly videoId: NostrEventId;
  readonly rendition: string;
  readonly source: { readonly kind: 'url'; readonly url: NfMediaPlayUrl };
  readonly policy: PricePolicy;
}

/** Custom thumbnail as it crosses the bridge: the preload reads the renderer's Blob. */
export interface ThumbnailBytes {
  readonly bytes: Uint8Array;
  readonly type: ImageMime;
}

/**
 * `UploadInput` for the wire (SE-1): `file` is a `FileToken`, never a path and never a
 * `FileLike`; the custom thumbnail is bytes; `uploadId` keys the `upload.progress` topic the
 * preload subscribes to BEFORE it calls `studio.upload`.
 */
export type UploadInputWire = Omit<UploadInput, 'file' | 'thumbnailChoice'> & {
  readonly uploadId: UploadId;
  readonly file: FileToken;
  readonly thumbnailChoice?: number | ThumbnailBytes;
};

/**
 * `UploadProgress` as the renderer receives it: thumbnail candidates are `nf-media://img/…`
 * (the host registers the worker's files; paths never reach the renderer).
 */
export type UploadProgressWire =
  | Exclude<UploadProgress, { readonly stage: 'thumbnails' }>
  | { readonly stage: 'thumbnails'; readonly candidates: readonly NfMediaImgUrl[] };

/** Studio's `FfmpegStatus` (`@sovit/ui` screens/Studio/parts.tsx), re-declared: ipc stays DOM/React-free. */
export interface FfmpegStatus {
  readonly found: boolean;
  /** Where it was found, or the configured path that did not work. */
  readonly path?: string | undefined;
  readonly version?: string | undefined;
  readonly os?: 'macos' | 'windows' | 'linux' | undefined;
}

// ---- the signer connect flow (Stage 3, ADR 0013) ------------------------------------------

/**
 * How the local key is unlocked, or that the signer is remote (the user's choice):
 *   `passphrase`  typed into main's trusted prompt window at every launch;
 *   `keychain`    the passphrase sealed by the OS keychain (Electron `safeStorage`), so the app
 *                 unlocks by itself;
 *   `nip46`       a remote signer (bunker); the key never touches this device.
 */
export type UnlockMethod = 'passphrase' | 'keychain' | 'nip46';
export const UNLOCK_METHODS = [
  'passphrase',
  'keychain',
  'nip46',
] as const satisfies readonly UnlockMethod[];

/** `desktop.signer.info`: public facts for the Settings screen. Never key material. */
export interface DesktopSignerInfo {
  /** The last method the user chose; `null` = never connected, or signed out. */
  readonly method: UnlockMethod | null;
  readonly hasLocalKey: boolean;
  /** The OS keychain can seal secrets here (never Linux's `basic_text` fallback). */
  readonly keychain: boolean;
  /** A NIP-46 session is remembered in the keychain (reconnects at launch). */
  readonly remembered: boolean;
}

/**
 * What the renderer may ask for: only WHICH kind of signer. Everything secret — the unlock
 * method, a passphrase, an nsec, a bunker URI — is chosen or typed in main's prompt window.
 */
export interface SignerConnectWire {
  readonly kind: 'local' | 'nip46';
}

/**
 * A question main's trusted prompt window asks (host → main). Data only: the window's own page
 * holds every word it shows, so neither the host nor anything upstream supplies prose.
 */
export type PromptForm =
  /**
   * Choose how to unlock; with no key yet, also create or import; with one, unlock it — or
   * remove it (a forgotten passphrase).
   */
  | { readonly kind: 'local-setup'; readonly hasKey: boolean; readonly keychain: boolean }
  | { readonly kind: 'unlock-passphrase'; readonly retry: boolean }
  | { readonly kind: 'new-passphrase' }
  | { readonly kind: 'import-nsec' }
  | { readonly kind: 'bunker'; readonly keychain: boolean }
  /** No NIP-60 wallet was found for an existing identity: create one? (default: no) */
  | { readonly kind: 'create-wallet' }
  /** Delete the encrypted key file from this device? (default: keep it) */
  | { readonly kind: 'remove-key' }
  /**
   * A remote signer asks the user to approve this app on its web page (NIP-46 `auth_url`). The
   * one piece of upstream data a question carries: an `https:` URL (`isAuthUrl`), whose HOST the
   * page shows; main opens it only when the user clicks "Open in browser".
   */
  | { readonly kind: 'bunker-auth'; readonly url: string }
  /**
   * Issue #2 (security review F4): the FIRST auto top-up into `target` — move `amount` sats there
   * from `source`? Both mints come from the user's own Settings (`defaultMints`, `fromMint`), never
   * from a manifest; the page shows their hosts. Default: no. Only an explicit yes is remembered.
   */
  | {
      readonly kind: 'top-up-first';
      readonly target: MintUrl;
      readonly source: MintUrl;
      readonly amount: Sats;
    }
  /**
   * ADR 0016: show the recovery phrase — `RECOVERY_WORDS` indices into the BIP-39 English list,
   * never words: the page maps them through its own bundled list, so nothing upstream can put
   * text in this window. `again`: an existing phrase shown after re-authentication (else a new
   * one, which "Later" saves unconfirmed and a cancel discards).
   */
  | { readonly kind: 'recovery-show'; readonly words: readonly number[]; readonly again: boolean }
  /**
   * ADR 0016: confirm the backup — type the words at these `RECOVERY_CONFIRM_WORDS` positions
   * (0-based, ascending). The page answers their indices; the host compares them.
   */
  | {
      readonly kind: 'recovery-confirm';
      readonly positions: readonly number[];
      readonly retry: boolean;
    }
  /**
   * ADR 0016: restore — optionally type a phrase (12 fields completing from the page's list;
   * checksum checked in the page, main and the host). Answered with 0 or 12 indices.
   */
  | { readonly kind: 'recovery-restore' }
  /** ADR 0016: re-authenticate before the phrase is shown again: the local key's passphrase. */
  | { readonly kind: 'recovery-reauth'; readonly retry: boolean };
export type PromptKind = PromptForm['kind'];

/**
 * Security review F25: asked by MAIN itself, never by the host (the host's `prompt` guard does
 * not know it) — open this external link, whose HOST the page shows, in the user's browser?
 * `https:` only (`isExternalLink`); main opens its own copy, and only on the user's click.
 */
export interface OpenLinkForm {
  readonly kind: 'open-link';
  readonly url: string;
}
/** Every question the prompt window can show: the host's, and main's own. */
export type WindowForm = PromptForm | OpenLinkForm;

/** The window's answer (main → host); `null` = cancelled. Secrets are UTF-8 bytes. */
export type PromptAnswer =
  | {
      readonly kind: 'local-setup';
      readonly method: 'passphrase' | 'keychain';
      readonly flow: 'unlock' | 'import' | 'generate' | 'remove';
    }
  | { readonly kind: 'secret'; readonly value: Uint8Array }
  | { readonly kind: 'bunker'; readonly uri: Uint8Array; readonly remember: boolean }
  | { readonly kind: 'create-wallet'; readonly create: boolean }
  | { readonly kind: 'remove-key'; readonly confirm: boolean }
  | { readonly kind: 'bunker-auth'; readonly open: boolean }
  | { readonly kind: 'top-up-first'; readonly confirm: boolean }
  /** ADR 0016: `done` = "I wrote them down"; `false` = "Later" (saved, not confirmed). */
  | { readonly kind: 'recovery-show'; readonly done: boolean }
  /** ADR 0016: the indices typed at the asked positions, in the same order. */
  | { readonly kind: 'recovery-confirm'; readonly words: readonly number[] }
  /**
   * ADR 0016: a typed phrase as `RECOVERY_WORDS` indices, or none (`[]`); `mints`: https mint
   * addresses typed there too (§5.1: the words alone do not say which mints were used), 1 to
   * `MAX_RESTORE_MINTS`, absent when none.
   */
  | {
      readonly kind: 'recovery-restore';
      readonly words: readonly number[];
      readonly mints?: readonly MintUrl[];
    };

// ---- the recovery phrase (Stage 3, ADR 0016) ----------------------------------------------

/** Words in a recovery phrase (NUT-13: 12 BIP-39 English words, 128 bits). */
export const RECOVERY_WORDS = 12;
/** The BIP-39 English list: a word crosses every hop as its index, 0 … `BIP39_LIST_SIZE - 1`. */
export const BIP39_LIST_SIZE = 2048;
/** Words the confirmation step asks for. */
export const RECOVERY_CONFIRM_WORDS = 3;
/** Mints one reissue confirm may list (at most the wallet's keyset bound, ADR 0016 §5). */
export const MAX_REISSUE_PLANS = 32;
/** Mint addresses the restore window takes (ADR 0016 §5.1), besides the wallet's own mints. */
export const MAX_RESTORE_MINTS = 8;

/**
 * `desktop.wallet.recovery.status`:
 *   `covered`        this device's phrase is here, and the user confirmed writing it down;
 *   `not-confirmed`  the phrase is here, the backup was not confirmed;
 *   `not-on-device`  no phrase here: new ecash from this device is not covered;
 *   `unreadable`     a phrase file is here but did not open (signer offline, damaged file) —
 *                    it is kept, and new ecash is not covered until it opens;
 *   `unavailable`    no unlocked signer with a wallet, or this build has no phrase support.
 */
export type RecoveryState =
  'covered' | 'not-confirmed' | 'not-on-device' | 'unreadable' | 'unavailable';
export const RECOVERY_STATES = [
  'covered',
  'not-confirmed',
  'not-on-device',
  'unreadable',
  'unavailable',
] as const satisfies readonly RecoveryState[];

export interface RecoveryStatusWire {
  readonly state: RecoveryState;
  /** The balance held before the phrase is not all under it yet (ADR 0016 D5). */
  readonly reissuePending: boolean;
  /** The encrypted copy reached at least one of the user's relays (ADR 0016 D2). */
  readonly relayCopy: boolean;
}

/** `desktop.wallet.recovery.setup`'s result. Amounts only, never a word. */
export interface RecoverySetupWire {
  readonly status: RecoveryStatusWire;
  readonly reissuedSats: Sats;
  readonly feeSats: Sats;
  /** Mints whose reissue did not run or failed (the balance there stays uncovered). */
  readonly reissueFailed: number;
}

export type RestoreOutcomeWire = walletTypes.RestoreOutcome;
export const RESTORE_OUTCOMES = [
  'restored',
  'nothing',
  'unsupported',
  'unreachable',
  'refused',
] as const satisfies readonly RestoreOutcomeWire[];

/** `desktop.wallet.recovery.restore`'s result: one row per mint, over every phrase scanned. */
export interface RecoveryRestoreWire {
  /** Phrases scanned: this device's, the relay copies the identity decrypts, the typed one. */
  readonly phrases: number;
  readonly reports: readonly {
    readonly mint: MintUrl;
    readonly outcome: RestoreOutcomeWire;
    readonly restoredSats: Sats;
  }[];
}

/** Topic `recovery.progress`: where a restore is (numbers and the user's own mint URL). */
export interface RecoveryProgressWire {
  /** 1-based index of the phrase being scanned, of `phrases`. */
  readonly phrase: number;
  readonly phrases: number;
  readonly mint: MintUrl;
  readonly keysetsDone: number;
  readonly keysets: number;
}

/** One mint's reissue as main's native confirm shows it (core's `ReissuePlan`). */
export interface ReissuePlanWire {
  readonly mint: MintUrl;
  readonly amount: Sats;
  readonly inputs: number;
  readonly feeSats: Sats;
}

/**
 * A question the HOST asks main to put in a native dialog (ADR 0016) — data only: main builds
 * every word (`host-confirm.ts`), Cancel is the default.
 *   `recovery-reissue`  move the balance at these mints under the recovery phrase, for this fee;
 *   `recovery-reveal`   show the phrase again (the re-authentication of a signer without a local
 *                       passphrase: NIP-46);
 *   `recovery-rotate`   replace the phrase with a new one (the same re-authentication, worded for
 *                       what it does: independent review IR8).
 */
export type ConfirmForm =
  | { readonly kind: 'recovery-reissue'; readonly plans: readonly ReissuePlanWire[] }
  | { readonly kind: 'recovery-reveal' }
  | { readonly kind: 'recovery-rotate' }
  /** R5-R1: resume auto top-ups into `target`, past a held one (waived, still watched). */
  | {
      readonly kind: 'topup-resume';
      readonly target: MintUrl;
      readonly amount: Sats;
      readonly reason: TopUpHoldReason;
    };

/**
 * R5-R1: why an open auto top-up holds back its target (Settings shows it; main words it).
 *   `checking`     not looked at since the host started;
 *   `unreadable`   its sealed record did not open — a damaged record, or a signer that cannot
 *                  answer now (a remote signer offline): the two look the same;
 *   `unreachable`  the target mint could not be asked about the quote (or forgot it);
 *   `owed`         the payment left the source mint (the melt paid, or the source says PAID) and the
 *                  target has not credited it: it may still arrive;
 *   `waiting`      the mints have not settled yet (a melt in flight, the release guard, a quote
 *                  with no expiry, or a state that is neither UNPAID nor PAID).
 */
export type TopUpHoldReason = 'checking' | 'unreadable' | 'unreachable' | 'owed' | 'waiting';

/** R5-R1: one held auto top-up of the signed-in identity (`desktop.wallet.topUp.holds`). */
export interface TopUpHoldWire {
  /** The ledger entry (16 hex): what `desktop.wallet.topUp.resume` names. */
  readonly id: string;
  readonly target: MintUrl;
  readonly amount: Sats;
  /** When the top-up started. */
  readonly since: UnixSeconds;
  readonly reason: TopUpHoldReason;
}

/** What main's keychain holds, one sealed file each. */
export type KeychainSlot = 'passphrase' | 'nip46';
export const KEYCHAIN_SLOTS = ['passphrase', 'nip46'] as const satisfies readonly KeychainSlot[];

/** Longest secret that crosses main ⇄ host (a bunker URI with a few relays). */
export const MAX_SECRET_BYTES = 2048;
/** Longest NIP-46 `auth_url` a question may carry. */
export const MAX_AUTH_URL = 2048;

// ---- the method table -------------------------------------------------------------------

interface HistoryItem {
  readonly video: VideoManifest;
  readonly positionSec: number;
  readonly at: UnixSeconds;
}
type SavePlaylistInput = Omit<Playlist, 'id' | 'author'> & { readonly id?: string };
interface SearchQuery {
  readonly text: string;
  readonly cursor?: string;
  readonly filters?: SearchFilters;
}

/**
 * Every call the renderer can make: `[args, result]`. Exact against contracts v4 — the
 * assertions at the bottom of this file fail compilation when `NetworkAdapter`/`Wallet` gain,
 * lose or change a method. Sub-objects are dotted (`library.*`, `studio.*`, `seeder.*`,
 * `wallet.*`); `session.*` are `PlaySession`'s methods keyed by `sid`; `desktop.*` are
 * shell-only. Callback-shaped members are `Topic`s, not methods (`TOPIC_METHODS`); the rest of
 * the adapter that is deliberately NOT bridged is `EXCLUDED_METHODS` (D3).
 */
export interface MethodTable {
  // identity
  signer: [args: [], result: SignerStatus];
  me: [args: [], result: NostrPubkey | null];
  profile: [args: [pubkey: NostrPubkey], result: Profile | null];
  /** ADR 0015 part c: the bytes cross as a `Uint8Array` (structured clone), at most 5 MiB. */
  setProfilePicture: [
    args: [image: { readonly bytes: Uint8Array; readonly type: string }],
    result: Profile,
  ];
  // catalog
  feed: [args: [q: FeedQuery], result: Page<CatalogVideo>];
  video: [args: [id: NostrEventId], result: VideoManifest | null];
  /** Contracts v9 (ADR 0020): an NFX manifest by its address. */
  nfxVideo: [args: [addr: NfxAddress], result: NfxVideo | null];
  stats: [args: [id: NostrEventId], result: VideoStats];
  related: [args: [id: NostrEventId, limit?: number | undefined], result: readonly VideoManifest[]];
  search: [args: [q: SearchQuery], result: Page<CatalogVideo>];
  // social
  comments: [
    args: [videoId: NostrEventId, sort: 'new' | 'top', cursor?: string | undefined],
    result: Page<Comment>,
  ];
  comment: [
    args: [videoId: NostrEventId, content: string, parent?: NostrEventId | undefined],
    result: Comment,
  ];
  react: [args: [videoId: NostrEventId, reaction: string], result: undefined];
  unreact: [args: [videoId: NostrEventId], result: undefined];
  nutzap: [
    args: [videoId: NostrEventId, amount: Sats, mint: MintUrl, comment?: string | undefined],
    result: undefined,
  ];
  subscribe: [args: [channel: NostrPubkey], result: undefined];
  unsubscribe: [args: [channel: NostrPubkey], result: undefined];
  subscriptions: [args: [], result: readonly NostrPubkey[]];
  report: [args: [videoId: NostrEventId, reason: string], result: undefined];
  // library
  'library.history': [args: [cursor?: string | undefined], result: Page<HistoryItem>];
  'library.recordProgress': [args: [videoId: NostrEventId, positionSec: number], result: undefined];
  'library.watchLater': [args: [], result: readonly VideoManifest[]];
  'library.setWatchLater': [args: [videoId: NostrEventId, on: boolean], result: undefined];
  'library.playlists': [args: [author?: NostrPubkey | undefined], result: readonly Playlist[]];
  'library.savePlaylist': [args: [p: SavePlaylistInput], result: Playlist];
  'library.liked': [args: [], result: readonly VideoManifest[]];
  // playback
  play: [args: [videoId: NostrEventId, rendition?: string | undefined], result: PlaySessionWire];
  image: [
    args: [url: string, sha256?: Sha256Hex | undefined, size?: number | undefined],
    result: NfMediaImgUrl,
  ];
  'session.pause': [args: [sid: SessionId], result: undefined];
  'session.resume': [args: [sid: SessionId], result: undefined];
  'session.setPrefetchSeconds': [args: [sid: SessionId, sec: number], result: undefined];
  /** Resolves the NEW session (new `sid`); the host closes the old one. */
  'session.switchRendition': [args: [sid: SessionId, label: string], result: PlaySessionWire];
  'session.close': [args: [sid: SessionId], result: undefined];
  // money (read side + melt; D3: never send / receive)
  'wallet.mints': [args: [], result: readonly MintUrl[]];
  'wallet.balance': [args: [mint: MintUrl], result: Sats];
  'wallet.inputFeePpk': [args: [mint: MintUrl], result: number];
  'wallet.balances': [args: [], result: WireMap<MintUrl, Sats>];
  'wallet.mintQuote': [args: [mint: MintUrl, amount: Sats], result: MintQuote];
  'wallet.pollQuote': [
    args: [quote: MintQuote],
    result: { state: MintQuote['state']; minted?: Sats },
  ];
  'wallet.meltQuote': [args: [mint: MintUrl, bolt11: string], result: MeltQuote];
  /** Stage 2: main's money gate (native confirm) sits in front of this. */
  'wallet.melt': [
    args: [quote: MeltQuote],
    result: { paid: boolean; preimage?: string; change: Sats },
  ];
  'wallet.history': [
    args: [opts?: { readonly limit?: number; readonly mint?: MintUrl } | undefined],
    result: readonly WalletHistoryEntry[],
  ];
  // studio
  /** Progress arrives on topic `{ t: 'upload.progress', uploadId }`. */
  'studio.upload': [args: [input: UploadInputWire], result: VideoManifest];
  'studio.myVideos': [args: [cursor?: string | undefined], result: Page<VideoManifest>];
  'studio.analytics': [args: [videoId: NostrEventId], result: AnalyticsWire];
  // seeder
  'seeder.status': [args: [], result: SeederStatusWire];
  'seeder.setEnabled': [args: [on: boolean], result: undefined];
  'seeder.melt': [args: [mint: MintUrl, bolt11: string], result: { paid: boolean }];
  'seeder.unban': [args: [pubkey: NostrPubkey], result: undefined];
  // settings
  settings: [args: [], result: Settings];
  updateSettings: [args: [patch: Partial<Settings>], result: Settings];
  // shell-only
  /** Pre-v5 stand-in for a `studio.ffmpeg()` contract method (Studio `ffmpeg`/`onRecheckFfmpeg`). */
  'desktop.ffmpeg': [args: [opts: { readonly recheck: boolean }], result: FfmpegStatus];
  /** Stage 3 (ADR 0013): the signer connect flow; status changes arrive on `signer.status`. */
  'desktop.signer.info': [args: [], result: DesktopSignerInfo];
  /** Runs the flow in main's prompt window; resolves the new status (rejects `cancelled`). */
  'desktop.signer.connect': [args: [req: SignerConnectWire], result: SignerStatus];
  /** Unlock again with the chosen method (a locked local key, a remembered bunker). */
  'desktop.signer.unlock': [args: [], result: SignerStatus];
  'desktop.signer.lock': [args: [], result: undefined];
  /** Main confirms first: forgets the signer and everything the keychain holds for it. */
  'desktop.signer.signOut': [args: [], result: undefined];
  /**
   * Stage 3 (ADR 0016): the recovery phrase. The renderer names an ACTION only; every word is
   * shown and typed in main's prompt window, the reissue fee confirmed in a native dialog.
   * Progress of a restore arrives on `recovery.progress`.
   */
  'desktop.wallet.recovery.status': [args: [], result: RecoveryStatusWire];
  'desktop.wallet.recovery.setup': [args: [], result: RecoverySetupWire];
  'desktop.wallet.recovery.show': [args: [], result: undefined];
  'desktop.wallet.recovery.restore': [args: [], result: RecoveryRestoreWire];
  /**
   * R5-R1 (Cameron, 2026-10-02): the auto top-ups held back for a mint, and resuming one. The
   * renderer names an entry only; the host asks main's native confirm, and resolves `false` when
   * it is not confirmed. A resumed hold is waived, never deleted: it is still finished if the
   * mint pays it.
   */
  'desktop.wallet.topUp.holds': [args: [], result: readonly TopUpHoldWire[]];
  'desktop.wallet.topUp.resume': [args: [id: string], result: boolean];
}
export type Method = keyof MethodTable;
export type ArgsOf<M extends Method> = MethodTable[M][0];
export type ResultOf<M extends Method> = MethodTable[M][1];

/**
 * Adapter members deliberately NOT callable over IPC. The preload exposes a stub for each that
 * rejects `forbidden: …` so the `NetworkAdapter` shape stays complete.
 */
export const EXCLUDED_METHODS = {
  'wallet.send':
    'D3: produces P2PK-locked proofs; a compromised renderer could mint them for itself',
  'wallet.receive': 'D3: swaps arbitrary proofs into the wallet; engine-internal',
  'wallet.p2pkPubkey': 'engine-internal (nutzap target); no screen reads it in v4',
  'wallet.keyset': 'engine-internal (offline DLEQ); no screen reads it in v4',
} as const;
export type ExcludedMethod = keyof typeof EXCLUDED_METHODS;

/** Callback-shaped adapter members → the topic the preload subscribes to instead. */
export const TOPIC_METHODS = {
  'seeder.onStatus': 'seeder.status',
  notifications: 'notifications',
  'wallet.onChange': 'wallet.change',
} as const satisfies Record<string, Topic['t']>;
export type TopicMethod = keyof typeof TOPIC_METHODS;

/** Shell-only listeners on the bridge (not adapter members) → their topic (ADR 0013). */
export const SHELL_TOPIC_METHODS = {
  'desktop.signer.onStatus': 'signer.status',
  'desktop.wallet.recovery.onProgress': 'recovery.progress',
} as const satisfies Record<string, Topic['t']>;

/** Methods that exist only on the wire (PlaySession methods and shell extras). */
export type ShellMethod = Extract<Method, `session.${string}` | `desktop.${string}`>;

// ---- topics (subscriptions) -------------------------------------------------------------

export type Topic =
  | { readonly t: 'seeder.status' }
  | { readonly t: 'notifications' }
  | { readonly t: 'wallet.change' }
  | { readonly t: 'session.peers'; readonly sid: SessionId }
  | { readonly t: 'session.spend'; readonly sid: SessionId }
  | { readonly t: 'upload.progress'; readonly uploadId: UploadId }
  /** Shell-only (ADR 0013): the signer connected, locked, unlocked or signed out. */
  | { readonly t: 'signer.status' }
  /** Shell-only (ADR 0016): a restore's progress. */
  | { readonly t: 'recovery.progress' };
export type TopicName = Topic['t'];
export const TOPIC_NAMES = [
  'seeder.status',
  'notifications',
  'wallet.change',
  'session.peers',
  'session.spend',
  'upload.progress',
  'signer.status',
  'recovery.progress',
] as const satisfies readonly TopicName[];

/** `EventMsg.payload` per topic. */
export interface TopicPayload {
  'seeder.status': SeederStatusWire;
  notifications: Notification;
  'wallet.change': WalletChangeEvent;
  'session.peers': readonly PeerSpend[];
  'session.spend': { readonly total: Sats; readonly ratePerMin: Sats };
  'upload.progress': UploadProgressWire;
  'signer.status': SignerStatus;
  'recovery.progress': RecoveryProgressWire;
}

// ---- errors -----------------------------------------------------------------------------

export type MediaErrorCode = media.MediaErrorCode;
/** Core's `MediaErrorCode`, as a runtime list (asserted equal to the type below). */
export const MEDIA_ERROR_CODES = [
  'ffmpeg-not-found',
  'process-failed',
  'probe-parse',
  'no-video-stream',
  'not-faststart',
  'hash-mismatch',
  'unsupported-input',
  'aborted',
] as const satisfies readonly MediaErrorCode[];

/** Shell error codes. The first four are the prefixes the screens classify messages by. */
export const SHELL_ERROR_CODES = [
  'no-seeders',
  'no-balance',
  'no-signer',
  'relay-down',
  'not-found',
  'invalid-argument',
  'forbidden',
  'file-token-invalid',
  'payments-unavailable',
  'session-closed',
  'backend-down',
  'rate-limited',
  /** Stage 3 (ADR 0013): the user dismissed main's prompt window. */
  'cancelled',
  /** Stage 3 (ADR 0013): a NIP-46 bunker did not answer, or answered wrongly. */
  'remote-signer',
  'internal',
] as const;

export type ErrorCode = (typeof SHELL_ERROR_CODES)[number] | MediaErrorCode;
export const ERROR_CODES: readonly ErrorCode[] = [...SHELL_ERROR_CODES, ...MEDIA_ERROR_CODES];

/** Errors travel as data; `message` always starts with `` `${code}: ` `` (`./errors.ts`). */
export interface WireError {
  readonly code: ErrorCode;
  readonly message: string;
}

// ---- renderer ⇄ main messages -----------------------------------------------------------

export interface CallMsg<M extends Method = Method> {
  readonly v: typeof IPC_V;
  /** Caller-chosen, unique among the webContents' calls in flight. */
  readonly id: number;
  readonly method: M;
  readonly args: MethodTable[M][0];
}
/** `CallMsg` as a union discriminated on `method` (what the guards narrow to). */
export type AnyCallMsg = { [M in Method]: CallMsg<M> }[Method];

export type ReplyMsg<R = unknown> = { readonly v: typeof IPC_V; readonly id: number } & (
  { readonly ok: true; readonly result: R } | { readonly ok: false; readonly error: WireError }
);

export type SubMsg =
  | {
      readonly v: typeof IPC_V;
      readonly op: 'sub';
      /** Caller-chosen, unique per webContents. */
      readonly subId: number;
      readonly topic: Topic;
    }
  | { readonly v: typeof IPC_V; readonly op: 'unsub'; readonly subId: number };

export interface EventMsg<P = unknown> {
  readonly v: typeof IPC_V;
  readonly subId: number;
  readonly payload: P;
}

/**
 * SE-1 grant: the preload turns a renderer `File` into its path with
 * `webUtils.getPathForFile` and asks main for a token. Reply result: `FileToken`.
 */
export interface GrantFileMsg {
  readonly v: typeof IPC_V;
  readonly path: string;
}

// ---- main ⇄ host (utilityProcess parentPort, structured clone) ----------------------------

/** Main → host. `wc` = the webContents id the message came from / answers go to. */
export type HostIn =
  | {
      readonly kind: 'call';
      readonly wc: number;
      readonly msg: AnyCallMsg;
      /** Only on `studio.upload`: main's resolution of `msg.args[0].file` (SE-1). */
      readonly file?: { readonly path: string; readonly name: string; readonly size: number };
    }
  | { readonly kind: 'sub'; readonly wc: number; readonly msg: SubMsg }
  /** The webContents was destroyed: drop its subscriptions, close its sessions. */
  | { readonly kind: 'wc-gone'; readonly wc: number }
  /** `nf-media://img/<id>` was requested; answer with an `image` HostOut carrying `req`. */
  | { readonly kind: 'image'; readonly req: number; readonly id: string }
  /** ADR 0013: the prompt window's answer to `prompt` `req` (`null` = cancelled or closed). */
  | { readonly kind: 'prompt-answer'; readonly req: number; readonly answer: PromptAnswer | null }
  /** ADR 0013: the outcome of `keychain` `req`; `value` only for a `get` that found one. */
  | {
      readonly kind: 'keychain-result';
      readonly req: number;
      readonly ok: boolean;
      readonly value: Uint8Array | null;
    }
  /** ADR 0016: the user's answer to `confirm` `req` (`ok` only for the confirm button). */
  | { readonly kind: 'confirm-result'; readonly req: number; readonly ok: boolean };

/** Host → main. */
export type HostOut =
  | { readonly kind: 'reply'; readonly wc: number; readonly msg: ReplyMsg }
  /** Acknowledges a `sub`/`unsub` (`msg.id` = `subId`). */
  | { readonly kind: 'sub-reply'; readonly wc: number; readonly msg: ReplyMsg }
  | { readonly kind: 'event'; readonly wc: number; readonly msg: EventMsg }
  /**
   * `nf-media://play/<token>` → the worker's loopback blob-server link; `url: null` revokes.
   * Sent BEFORE the reply that carries the `PlaySessionWire` naming `token`.
   */
  | { readonly kind: 'media-link'; readonly token: string; readonly url: string | null }
  | {
      readonly kind: 'image';
      readonly req: number;
      readonly bytes: Uint8Array | null;
      readonly type: ImageMime | null;
    }
  /** ADR 0013: ask the user in main's trusted prompt window; answered by `prompt-answer`. */
  | { readonly kind: 'prompt'; readonly req: number; readonly form: PromptForm }
  /** ADR 0013: the host no longer needs the answer (timeout, shutdown): close the window. */
  | { readonly kind: 'prompt-cancel'; readonly req: number }
  /**
   * ADR 0013: main's OS-keychain store (Electron `safeStorage`). `put` carries `value`; every op
   * is answered by `keychain-result`.
   */
  | {
      readonly kind: 'keychain';
      readonly req: number;
      readonly op: 'get' | 'put' | 'forget';
      readonly slot: KeychainSlot;
      readonly value?: Uint8Array;
    }
  /** ADR 0016: ask the user in main's native dialog (data only); answered by `confirm-result`. */
  | { readonly kind: 'confirm'; readonly req: number; readonly form: ConfirmForm }
  /**
   * ADR 0016: the host no longer needs the answer to `confirm` `req` (its deadline, shutdown):
   * close the dialog; no `confirm-result` follows (round-8 review, like `prompt-cancel`).
   */
  | { readonly kind: 'confirm-cancel'; readonly req: number };

// ---- guard type -------------------------------------------------------------------------

/** A total predicate: never throws, `false` for anything that is not exactly a `T`. */
export type Guard<T> = (x: unknown) => x is T;

// ---- compile-time exactness against contracts v4 ------------------------------------------
// These produce no JavaScript. If contracts v5 adds, removes or changes an adapter member, one
// of them fails `tsc -b` right here with the member's name in the message ("Type '"feed"'
// does not satisfy the constraint 'never'").

type Fn = (...args: never[]) => unknown;
type MethodKeys<T> = { [K in keyof T]-?: T[K] extends Fn ? K : never }[keyof T] & string;
type NonMethodKeys<T> = Exclude<keyof T, MethodKeys<T>>;
type SubObject = 'library' | 'studio' | 'seeder' | 'wallet';
interface SubObjectsOf<A extends NetworkAdapter> {
  library: A['library'];
  studio: A['studio'];
  seeder: A['seeder'];
  wallet: A['wallet'];
}
type SubObjects = SubObjectsOf<NetworkAdapter>;

/** Every callable on an adapter type, dotted for its sub-objects. */
export type AdapterMethodsOf<A extends NetworkAdapter> =
  MethodKeys<A> | { [O in SubObject]: `${O}.${MethodKeys<SubObjectsOf<A>[O]>}` }[SubObject];
/** Every callable on contracts v4 `NetworkAdapter`. */
export type AdapterMethod = AdapterMethodsOf<NetworkAdapter>;
/** What the wire accounts for: table methods (minus shell-only), exclusions, topics. */
export type BridgedMethod = Exclude<Method, ShellMethod> | ExcludedMethod | TopicMethod;
/** Adapter methods of `A` the wire does not account for — `never` for contracts v4. */
export type UncoveredMethods<A extends NetworkAdapter> = Exclude<
  AdapterMethodsOf<A>,
  BridgedMethod
>;

type AdapterFn<M extends AdapterMethod> = M extends `${infer O extends SubObject}.${infer K}`
  ? SubObjects[O][K & keyof SubObjects[O]]
  : NetworkAdapter[M & keyof NetworkAdapter];
type ContractArgs<M extends AdapterMethod> =
  AdapterFn<M> extends (...args: infer A) => unknown ? A : never;
/** The contract's resolved result; `Promise<void>` reads as `undefined` (what a reply carries). */
type ContractResult<M extends AdapterMethod> =
  AdapterFn<M> extends (...args: never[]) => infer R ? VoidAsUndefined<Awaited<R>> : never;
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- maps the contract's `void` onto the wire's `undefined`
type VoidAsUndefined<T> = [T] extends [void] ? undefined : T;

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type IsNever<T> = [T] extends [never] ? true : false;
/** The keys of `T` whose check is not `true` — `never` when every check passes. */
type Failing<T> = { [K in keyof T]: T[K] extends true ? never : K }[keyof T];
/** Fails compilation with the offending name(s) in the message when `A` is not `never`. */
type ExpectNever<A extends never> = A;

/** `WireMap` → `ReadonlyMap`, recursively (what `rehydrate` returns). */
export type Rehydrated<T> =
  T extends WireMap<infer K, infer V>
    ? ReadonlyMap<K, Rehydrated<V>>
    : T extends string | number | boolean | bigint | symbol | null | undefined | Uint8Array
      ? T
      : T extends readonly (infer U)[]
        ? readonly Rehydrated<U>[]
        : T extends object
          ? { [P in keyof T]: Rehydrated<T[P]> }
          : T;

type AdapterArgChecked = Extract<Exclude<Method, ShellMethod | 'studio.upload'>, AdapterMethod>;
type AdapterResultChecked = Extract<Exclude<Method, ShellMethod | 'play' | 'image'>, AdapterMethod>;
type CallbackArg<M extends TopicMethod> =
  AdapterFn<M> extends (cb: (x: infer X) => void) => unknown ? X : never;
type PlaySession = ContractResult<'play'>;
type PlayData = 'videoId' | 'rendition' | 'policy';
type SessionWireMethod =
  Extract<Method, `session.${string}`> extends `session.${infer K}` ? K : never;

/** Referenced by `ProtocolAssertions` so every check stays in the build. */
interface Checks {
  /** The adapter's non-callable members are exactly `platform` + the four sub-objects. */
  members: Mutual<NonMethodKeys<NetworkAdapter>, 'platform' | SubObject>;
  excludedDisjoint: IsNever<Extract<Method, ExcludedMethod>>;
  topicsDisjoint: IsNever<Extract<Method, TopicMethod>>;
  /** PlaySession's data fields are all on `PlaySessionWire`, with the same types. */
  playKeys: IsNever<Exclude<NonMethodKeys<PlaySession>, keyof PlaySessionWire>>;
  playData: Mutual<Pick<PlaySessionWire, PlayData>, Pick<PlaySession, PlayData>>;
  playSource: PlaySessionWire['source'] extends PlaySession['source'] ? true : false;
  /** PlaySession's methods are all on the wire, as `session.*` or as a topic. */
  sessionMethods: IsNever<
    Exclude<MethodKeys<PlaySession>, SessionWireMethod | 'onPeers' | 'onSpend'>
  >;
  /** `image` resolves a narrower string (`nf-media://img/…`), still a contract result. */
  image: NfMediaImgUrl extends ContractResult<'image'> ? true : false;
  sessionPeers: Mutual<
    TopicPayload['session.peers'],
    Parameters<Parameters<PlaySession['onPeers']>[0]>[0]
  >;
  sessionSpend: Mutual<
    TopicPayload['session.spend'],
    Parameters<Parameters<PlaySession['onSpend']>[0]>[0]
  >;
  uploadProgress: UploadProgressWire extends UploadProgress ? true : false;
  /** The runtime media-code list is exactly core's `MediaErrorCode`. */
  mediaCodes: Mutual<(typeof MEDIA_ERROR_CODES)[number], MediaErrorCode>;
  /** Issue #2: the local top-up caps are exactly core's (a type-only import of the constants). */
  topUpMax: Mutual<(typeof LIMITS)['maxAutoTopUpAmountSats'], typeof AUTO_TOP_UP_MAX_SATS>;
  /** Contracts v10: the NFX limits and networks are exactly core's (type-only imports). */
  nfxScopedRelays: Mutual<(typeof LIMITS)['maxNfxScopedRelays'], typeof MAX_NFX_SCOPED_RELAYS>;
  nfxNetworks: Mutual<(typeof NFX_NETWORK_IDS)[number], NfxNetwork>;
  topUpPerDay: Mutual<
    (typeof LIMITS)['maxAutoTopUpSatsPerDay'],
    typeof AUTO_TOP_UP_MAX_SATS_PER_DAY
  >;
  /** ADR 0016: the recovery wire shapes are exactly the seam's (`wallet/recovery-api.ts`). */
  restoreOutcomes: Mutual<(typeof RESTORE_OUTCOMES)[number], walletTypes.RestoreOutcome>;
  reissuePlan: Mutual<ReissuePlanWire, walletTypes.ReissuePlan>;
  restoreReport: Mutual<RecoveryRestoreWire['reports'][number], walletTypes.RestoreReport>;
  restoreProgress: Mutual<
    Omit<RecoveryProgressWire, 'phrase' | 'phrases'>,
    walletTypes.RestoreProgress
  >;
}
/** Arguments: identical to the contract's parameters (except `studio.upload`, SE-1). */
type ArgChecks = { [M in AdapterArgChecked]: Mutual<MethodTable[M][0], ContractArgs<M>> };
/** Results: a rehydrated wire result IS the contract result, both ways. */
type ResultChecks = {
  [M in AdapterResultChecked]: Mutual<Rehydrated<MethodTable[M][1]>, ContractResult<M>>;
};
/** Topics carry exactly what the callbacks they replace receive. */
type TopicChecks = {
  [M in TopicMethod]: Mutual<Rehydrated<TopicPayload[(typeof TOPIC_METHODS)[M]]>, CallbackArg<M>>;
};

export type ProtocolAssertions = [
  /** An adapter method that is neither in the table, nor excluded, nor a topic. */
  ExpectNever<UncoveredMethods<NetworkAdapter>>,
  /** A table / exclusion / topic entry the adapter does not have. */
  ExpectNever<Exclude<BridgedMethod, AdapterMethod>>,
  ExpectNever<Failing<Checks>>,
  ExpectNever<Failing<ArgChecks>>,
  ExpectNever<Failing<ResultChecks>>,
  ExpectNever<Failing<TopicChecks>>,
];
