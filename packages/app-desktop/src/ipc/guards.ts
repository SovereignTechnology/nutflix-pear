/**
 * Hand-written, composable runtime guards for everything that crosses a process boundary
 * (design §2 "Rules"). No dependencies, no `URL`/`TextEncoder` globals: the same code runs in
 * main, host, preload and the Bare worker.
 *
 * Every guard is TOTAL — it returns `false` for anything that is not exactly the expected
 * shape and never throws (the exported validators are additionally wrapped in `safe`, so a
 * hostile getter or Proxy cannot escape as an exception). Objects must be plain (prototype
 * `Object.prototype` or `null`) with no unknown keys; optional properties are absent, never
 * present-as-`undefined` (every package compiles with `exactOptionalPropertyTypes`). Strings
 * and arrays have hard caps (`LIMITS`); a value over a cap is rejected, never truncated.
 * Optional TRAILING call arguments may be absent or `undefined` (JS parameter semantics).
 */
import type {
  CashuP2pkPubkey,
  CoreKeyHex,
  HyperblobId,
  HyperblobRef,
  MeltQuote,
  MintQuote,
  MintUrl,
  NostrEvent,
  NostrEventId,
  NostrPubkey,
  PeerSpend,
  PeerWindow,
  PricePolicy,
  RelayUrl,
  Rendition,
  Sats,
  Sha256Hex,
  UnixSeconds,
  VideoManifest,
} from '@sovit/core';
import type {
  AnyCallMsg,
  ConfirmForm,
  ErrorCode,
  FileToken,
  GrantFileMsg,
  Guard,
  HostIn,
  HostOut,
  PromptAnswer,
  PromptForm,
  ImageMime,
  ReissuePlanWire,
  Method,
  MethodTable,
  NfMediaImgUrl,
  ReplyMsg,
  SeederStatusWire,
  SessionId,
  SubMsg,
  Topic,
  UploadId,
  EventMsg,
  WireError,
  WireMap,
} from './protocol.js';
import {
  BIP39_LIST_SIZE,
  ERROR_CODES,
  IMAGE_MIMES,
  IPC_V,
  KEYCHAIN_SLOTS,
  LIMITS,
  MAX_AUTH_URL,
  MAX_REISSUE_PLANS,
  MAX_RESTORE_MINTS,
  MAX_SECRET_BYTES,
  RECOVERY_CONFIRM_WORDS,
  RECOVERY_WORDS,
} from './protocol.js';

export type { Guard };

// ---- primitives ---------------------------------------------------------------------------

/** Wraps a guard so nothing it touches (getters, Proxies) can make it throw. */
export function safe<T>(g: Guard<T>): Guard<T> {
  return (x: unknown): x is T => {
    try {
      return g(x);
    } catch {
      return false;
    }
  };
}

export type PlainObject = Readonly<Record<string, unknown>>;

/** A plain data object (structured clone / JSON produce exactly these). */
export function isPlainObject(x: unknown): x is PlainObject {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const proto: unknown = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

export const bool: Guard<boolean> = (x): x is boolean => typeof x === 'boolean';

/** A finite number in `[min, max]`. */
export function num(min: number, max: number): Guard<number> {
  return (x): x is number => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
}

/** A safe integer in `[min, max]`. */
export function int(min: number, max: number): Guard<number> {
  return (x): x is number =>
    typeof x === 'number' && Number.isSafeInteger(x) && x >= min && x <= max;
}

// C0 controls and DEL; `multiline` text additionally allows \t \n \r.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_EXCEPT_WS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * A string of `min`..`max` UTF-16 code units with no control characters (`multiline` allows
 * tab, LF and CR).
 */
export function text(min: number, max: number, opts: { multiline?: boolean } = {}): Guard<string> {
  const bad = opts.multiline === true ? CONTROL_EXCEPT_WS : CONTROL;
  return (x): x is string =>
    typeof x === 'string' && x.length >= min && x.length <= max && !bad.test(x);
}

/** A string of at most `max` code units matching `re` (anchor `re` yourself). */
export function matches(re: RegExp, max: number): Guard<string> {
  return (x): x is string => typeof x === 'string' && x.length <= max && re.test(x);
}

/** One of `values` (strict equality). */
export function oneOf<const T extends string | number | boolean>(values: readonly T[]): Guard<T> {
  return (x): x is T => (values as readonly unknown[]).includes(x);
}

export function literal<const T extends string | number | boolean | null>(value: T): Guard<T> {
  return (x): x is T => x === value;
}

export function nullable<T>(g: Guard<T>): Guard<T | null> {
  return (x): x is T | null => x === null || g(x);
}

export function union<T extends readonly unknown[]>(
  ...gs: { readonly [K in keyof T]: Guard<T[K]> }
): Guard<T[number]> {
  return (x): x is T[number] => gs.some((g) => g(x));
}

/**
 * A dense array of `min`..`max` elements, each passing `g`. Holes read as `undefined` and so
 * fail every element guard that does not admit `undefined`.
 */
export function arrayOf<T>(g: Guard<T>, max: number, min = 0): Guard<readonly T[]> {
  return (x): x is readonly T[] => {
    if (!Array.isArray(x) || x.length < min || x.length > max) return false;
    // for-of reads holes through the array iterator, i.e. as `undefined`.
    for (const v of x as readonly unknown[]) if (!g(v)) return false;
    return true;
  };
}

type GuardMap<T> = { readonly [K in keyof T]-?: Guard<T[K]> };
type NoKeys = Record<never, never>;

/**
 * An exact-keys plain object: every `req` key present and valid, `opt` keys absent or valid
 * (never `undefined`), nothing else.
 */
export function obj<R extends object, O extends object = NoKeys>(
  req: GuardMap<R>,
  opt?: GuardMap<O>,
): Guard<R & Partial<O>> {
  const reqKeys = Object.keys(req) as (keyof R & string)[];
  const optKeys = opt === undefined ? [] : (Object.keys(opt) as (keyof O & string)[]);
  const known = new Set<string>([...reqKeys, ...optKeys]);
  return (x): x is R & Partial<O> => {
    if (!isPlainObject(x)) return false;
    for (const k of Object.keys(x)) if (!known.has(k)) return false;
    for (const k of reqKeys) if (!hasOwn(x, k) || !req[k](x[k])) return false;
    if (opt !== undefined) for (const k of optKeys) if (hasOwn(x, k) && !opt[k](x[k])) return false;
    return true;
  };
}

type OptionalTail<O extends readonly unknown[]> = { [K in keyof O]?: O[K] | undefined };

/**
 * A call-argument tuple: the `req` positions present and valid, then up to `opt.length`
 * trailing positions each absent, `undefined`, or valid. Longer arrays are rejected.
 */
export function tuple<const R extends readonly unknown[], const O extends readonly unknown[] = []>(
  req: { readonly [K in keyof R]: Guard<R[K]> },
  opt?: { readonly [K in keyof O]: Guard<O[K]> },
): Guard<[...R, ...OptionalTail<O>]> {
  const r = req as readonly Guard<unknown>[];
  const o = (opt ?? []) as readonly Guard<unknown>[];
  return (x): x is [...R, ...OptionalTail<O>] => {
    if (!Array.isArray(x) || x.length < r.length || x.length > r.length + o.length) return false;
    const args = x as readonly unknown[];
    if (!r.every((g, i) => g(args[i]))) return false;
    return o.every((g, i) => {
      const v = args[r.length + i];
      return v === undefined || g(v);
    });
  };
}

/** A genuine `Uint8Array` (not a look-alike) of at most `max` bytes. */
export function bytes(max: number): Guard<Uint8Array> {
  return (x): x is Uint8Array =>
    ArrayBuffer.isView(x) &&
    Object.prototype.toString.call(x) === '[object Uint8Array]' &&
    (x as Uint8Array).byteLength <= max;
}

/** A `WireMap` of at most `max` entries with unique keys. */
export function wireMap<K extends string, V>(
  key: Guard<K>,
  value: Guard<V>,
  max: number = LIMITS.maxArray,
): Guard<WireMap<K, V>> {
  const entry = (e: unknown): e is readonly [K, V] =>
    Array.isArray(e) && e.length === 2 && key(e[0]) && value(e[1]);
  const entries = arrayOf(entry, max);
  return (x): x is WireMap<K, V> => {
    if (!isPlainObject(x) || Object.keys(x).length !== 1 || !hasOwn(x, '$map')) return false;
    const list: unknown = x['$map'];
    if (!entries(list)) return false;
    return new Set(list.map((e) => e[0])).size === list.length;
  };
}

/** Narrows a string guard to a branded type (brands are compile-time only). */
export function branded<B extends string>(g: Guard<string>): Guard<B> {
  return g as Guard<B>;
}

// ---- ids, hex, money ------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

export const isHex64 = matches(HEX64, 64);
export const isPubkey = branded<NostrPubkey>(isHex64);
export const isEventId = branded<NostrEventId>(isHex64);
export const isSha256 = branded<Sha256Hex>(isHex64);
export const isCoreKey = branded<CoreKeyHex>(isHex64);
/** NUT-11 P2PK key: 33-byte compressed secp256k1 (same check as core's manifest builder). */
export const isCashuP2pk = branded<CashuP2pkPubkey>(matches(/^0[23][0-9a-f]{64}$/, 66));
export const isSessionId = safe(branded<SessionId>(matches(HEX32, 32)));
export const isUploadId = safe(branded<UploadId>(matches(HEX32, 32)));
export const isFileToken = safe(
  matches(/^nf-file:[0-9a-f]{32}$/, 40) as Guard<FileToken>,
) satisfies Guard<FileToken>;

export const isSats = int(0, LIMITS.maxSats) as Guard<Sats>;
export const isPositiveSats = int(1, LIMITS.maxSats) as Guard<Sats>;
/** Unix seconds, 0 … year 36812. */
export const isUnixSeconds = int(0, 2 ** 40) as Guard<UnixSeconds>;
/** Safe integers of either sign (counters that may legitimately go negative). */
export const isSafeInt = int(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
export const isCount = int(0, Number.MAX_SAFE_INTEGER);
/** A message id / subId / request id: a non-negative 31-bit integer. */
export const isMsgId = int(0, 0x7fffffff);
/** A webContents id. */
export const isWcId = int(1, 0x7fffffff);

// ---- URLs -----------------------------------------------------------------------------------
//
// Consistent with packages/ui/src/screens/Settings/model.ts (`validateRelayUrl`,
// `validateMintUrl`) and Studio/model.ts (`normalizeHttpsUrl`), which it does NOT import:
// `@sovit/ui` has a root export only (React + DOM), and these guards must not depend on the
// `URL` global. They accept the NORMALISED output of those validators — scheme `wss:` (relays)
// or `https:` (mints, Blossom mirrors), no user-info, no fragment, no query for mints/mirrors,
// no trailing slash, at most 512 chars, an ASCII (IDNA-encoded) host — plus the same shapes
// with an upper-case scheme. Loopback and LAN hosts pass (legitimate desktop setups; the host
// decides what it proxies). guards.test.ts cross-checks against the real validators.

const LABEL = '[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?';
const HOST = `(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9A-Fa-f:.]{2,45}\\])`;
const PORT = '(?::[0-9]{1,5})?';
const PCHAR = "[A-Za-z0-9\\-._~!$&'()*+,;=:@%]";
/** Empty, or `/…` not ending in `/`. */
const PATH_NO_TRAILING = `(?:/[A-Za-z0-9\\-._~!$&'()*+,;=:@%/]*${PCHAR})?`;
const QUERY = "(?:\\?[A-Za-z0-9\\-._~!$&'()*+,;=:@%/?]*)?";

const RELAY_RE = new RegExp(`^[Ww][Ss][Ss]://${HOST}${PORT}${PATH_NO_TRAILING}${QUERY}$`);
const HTTPS_SERVER_RE = new RegExp(`^[Hh][Tt][Tt][Pp][Ss]://${HOST}${PORT}${PATH_NO_TRAILING}$`);
/** `image()` sources: any https URL without user-info or whitespace/controls (the host re-checks). */
const IMAGE_RE = new RegExp(
  `^[Hh][Tt][Tt][Pp][Ss]://${HOST}${PORT}(?:[/?#][^\\s\\u0000-\\u001f\\u007f]*)?$`,
);
const NF_IMG_RE = /^nf-media:\/\/img\/[A-Za-z0-9_-]{1,128}$/;
/** ADR 0015: a blob in a creator's profile core (the rendition `hyper://` grammar). */
const HYPER_IMG_RE = /^hyper:\/\/[0-9a-f]{64}\/[0-9]{1,15}-[0-9]{1,15}(?:\+[0-9]{1,15})?$/;
/** ADR 0013 NIP-46 approval links: like `IMAGE_RE`, and no C1 controls or bidi overrides either. */
const AUTH_URL_RE = new RegExp(
  `^[Hh][Tt][Tt][Pp][Ss]://${HOST}${PORT}(?:[/?#][^\\s\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]*)?$`,
);

export const isRelayUrl = safe(branded<RelayUrl>(matches(RELAY_RE, LIMITS.maxServerUrl)));
export const isMintUrl = safe(branded<MintUrl>(matches(HTTPS_SERVER_RE, LIMITS.maxServerUrl)));
export const isNfMediaImgUrl = matches(NF_IMG_RE, 150) as Guard<NfMediaImgUrl>;
export const isImageSource: Guard<string> = safe(
  (x): x is string =>
    matches(IMAGE_RE, LIMITS.maxUrl)(x) || isNfMediaImgUrl(x) || matches(HYPER_IMG_RE, 200)(x),
);

// ---- text fields ----------------------------------------------------------------------------

export const isTitle = text(1, LIMITS.maxString);
export const isBody = text(0, LIMITS.maxBody, { multiline: true });
export const isCommentBody = text(1, LIMITS.maxBody, { multiline: true });
export const isCursor = text(0, LIMITS.maxString);
export const isLabel = text(1, LIMITS.maxLabel);
export const isTag = text(1, LIMITS.maxTag);
export const isTags = arrayOf(isTag, LIMITS.maxArray);
/** NIP-25 content: `+`, `-`, empty, or an emoji / `:shortcode:`. */
export const isReaction = text(0, 64);
/** A Lightning invoice as the screens pass it (shape only; the mint decodes it). */
export const isInvoice = matches(/^[\x21-\x7e]+$/, LIMITS.maxString);
export const isImageMime = oneOf<ImageMime>(IMAGE_MIMES);
export const isPageLimit = int(1, LIMITS.maxPage);

// ---- contract shapes (arguments) ------------------------------------------------------------

const isFeedQuery = obj(
  { source: oneOf(['subscriptions', 'trending', 'tags', 'author', 'shorts'] as const) },
  { tags: isTags, author: isPubkey, cursor: isCursor, limit: isPageLimit },
);

const isSearchFilters = obj(
  {},
  {
    since: isUnixSeconds,
    until: isUnixSeconds,
    minDurationSec: num(0, 1e7),
    maxDurationSec: num(0, 1e7),
    tags: isTags,
    author: isPubkey,
  },
);

const isSearchQuery = obj(
  { text: text(0, LIMITS.maxString, { multiline: true }) },
  { cursor: isCursor, filters: isSearchFilters },
);

const isSavePlaylist = obj(
  {
    title: isTitle,
    videoIds: arrayOf(isEventId, LIMITS.maxPlaylistItems),
    isPrivate: bool,
  },
  { description: isBody, id: isLabel },
);

const isMintQuote: Guard<MintQuote> = obj({
  mint: isMintUrl,
  quoteId: isLabel,
  amount: isSats,
  bolt11: isInvoice,
  expiry: isUnixSeconds,
  state: oneOf(['UNPAID', 'PAID', 'ISSUED'] as const),
});

const isMeltQuote: Guard<MeltQuote> = obj({
  mint: isMintUrl,
  quoteId: isLabel,
  amount: isSats,
  feeReserve: isSats,
  expiry: isUnixSeconds,
  state: oneOf(['UNPAID', 'PENDING', 'PAID'] as const),
});

const isHistoryOpts = obj({}, { limit: isPageLimit, mint: isMintUrl });

const isSplit = (x: unknown): x is { readonly seeder: number; readonly creator: number } =>
  obj({ seeder: int(0, 100), creator: int(0, 100) })(x) && x.seeder + x.creator === 100;

const isThumbnailBytes = obj({
  bytes: bytes(LIMITS.maxThumbnailBytes),
  type: isImageMime,
});

/** Studio's `UploadInput` minus `file`/`thumbnailChoice` — shared with the worker protocol. */
export const uploadMetaGuards = {
  title: isTitle,
  description: isBody,
  tags: isTags,
  kind: oneOf([21, 22] as const),
  mints: arrayOf(isMintUrl, 32, 1),
  satsPerBlock: isSats,
  split: isSplit,
} as const;

/** Optional upload-meta fields. v8 (ADR 0020): `nfx`, also package the video for NFX. */
export const uploadMetaOptGuards = { nfx: bool } as const;

/**
 * Contracts v8: `nfx` only on a free video (`satsPerBlock` 0, issue #15) — the free NFX path
 * must never undercut a paid video. Checked here and again by the worker.
 */
export function nfxOnlyIfFree(meta: {
  readonly satsPerBlock: number;
  readonly nfx?: boolean;
}): boolean {
  return meta.nfx !== true || meta.satsPerBlock === 0;
}

const isUploadInputShape = obj(
  { ...uploadMetaGuards, uploadId: isUploadId, file: isFileToken },
  {
    thumbnailChoice: union(int(0, 63), isThumbnailBytes),
    ...uploadMetaOptGuards,
  },
);
const isUploadInputWire = ((x: unknown) =>
  isUploadInputShape(x) && nfxOnlyIfFree(x)) as typeof isUploadInputShape;

const isRelayConfig = obj({ url: isRelayUrl, read: bool, write: bool });

const isSettingsPatch = obj(
  {},
  {
    relays: arrayOf(isRelayConfig, LIMITS.maxArray),
    defaultMints: arrayOf(isMintUrl, LIMITS.maxArray),
    seeding: obj(
      { enabled: bool, diskCapBytes: int(0, LIMITS.maxDiskCapBytes) },
      { serveImages: bool },
    ),
    prefetchSeconds: num(0, LIMITS.maxPrefetchSec),
    hoverPreview: bool,
    loadRemoteImages: bool,
    theme: oneOf(['dark', 'light', 'system'] as const),
    // SE-4: `belowSats: 0` is the v4 "off" sentinel; the host treats `<= 0` as disabled.
    // Issue #2: `amountSats` is a whole number of sats in 1 … `AUTO_TOP_UP_MAX_SATS` (absent =
    // the max) — anything else refuses the whole patch (and a stored file, which then reads as
    // the defaults: auto top-up off).
    autoTopUp: obj(
      {
        belowSats: int(0, LIMITS.maxAutoTopUpThresholdSats) as Guard<Sats>,
        fromMint: isMintUrl,
      },
      { amountSats: int(1, LIMITS.maxAutoTopUpAmountSats) as Guard<Sats> },
    ),
  },
);

const isPrefetchSeconds = num(0, LIMITS.maxPrefetchSec);
const isPositionSec = num(0, 1e7);

/**
 * Argument validators for every method — a missing or mistyped entry is a compile error.
 * Main runs them on every renderer call (after the sender-frame check); the host runs them
 * again.
 */
export const validateArgs: { readonly [M in Method]: Guard<MethodTable[M][0]> } = wrapAll({
  signer: tuple([]),
  me: tuple([]),
  profile: tuple([isPubkey]),
  setProfilePicture: tuple([isThumbnailBytes]),
  feed: tuple([isFeedQuery]),
  video: tuple([isEventId]),
  stats: tuple([isEventId]),
  related: tuple([isEventId], [isPageLimit]),
  search: tuple([isSearchQuery]),
  comments: tuple([isEventId, oneOf(['new', 'top'] as const)], [isCursor]),
  comment: tuple([isEventId, isCommentBody], [isEventId]),
  react: tuple([isEventId, isReaction]),
  unreact: tuple([isEventId]),
  nutzap: tuple(
    [isEventId, isPositiveSats, isMintUrl],
    [text(0, LIMITS.maxString, { multiline: true })],
  ),
  subscribe: tuple([isPubkey]),
  unsubscribe: tuple([isPubkey]),
  subscriptions: tuple([]),
  report: tuple([isEventId, text(0, LIMITS.maxString, { multiline: true })]),
  'library.history': tuple([], [isCursor]),
  'library.recordProgress': tuple([isEventId, isPositionSec]),
  'library.watchLater': tuple([]),
  'library.setWatchLater': tuple([isEventId, bool]),
  'library.playlists': tuple([], [isPubkey]),
  'library.savePlaylist': tuple([isSavePlaylist]),
  'library.liked': tuple([]),
  play: tuple([isEventId], [isLabel]),
  image: tuple([isImageSource], [isSha256, int(1, LIMITS.maxThumbnailBytes)]),
  'session.pause': tuple([isSessionId]),
  'session.resume': tuple([isSessionId]),
  'session.setPrefetchSeconds': tuple([isSessionId, isPrefetchSeconds]),
  'session.switchRendition': tuple([isSessionId, isLabel]),
  'session.close': tuple([isSessionId]),
  'wallet.mints': tuple([]),
  'wallet.balance': tuple([isMintUrl]),
  'wallet.inputFeePpk': tuple([isMintUrl]),
  'wallet.balances': tuple([]),
  'wallet.mintQuote': tuple([isMintUrl, isPositiveSats]),
  'wallet.pollQuote': tuple([isMintQuote]),
  'wallet.meltQuote': tuple([isMintUrl, isInvoice]),
  'wallet.melt': tuple([isMeltQuote]),
  'wallet.history': tuple([], [isHistoryOpts]),
  'studio.upload': tuple([isUploadInputWire]),
  'studio.myVideos': tuple([], [isCursor]),
  'studio.analytics': tuple([isEventId]),
  'seeder.status': tuple([]),
  'seeder.setEnabled': tuple([bool]),
  'seeder.melt': tuple([isMintUrl, isInvoice]),
  'seeder.unban': tuple([isPubkey]),
  settings: tuple([]),
  updateSettings: tuple([isSettingsPatch]),
  'desktop.ffmpeg': tuple([obj({ recheck: bool })]),
  'desktop.signer.info': tuple([]),
  'desktop.signer.connect': tuple([obj({ kind: oneOf(['local', 'nip46'] as const) })]),
  'desktop.signer.unlock': tuple([]),
  'desktop.signer.lock': tuple([]),
  'desktop.signer.signOut': tuple([]),
  // ADR 0016: the renderer names an action, nothing else — no word, index, mint or amount.
  'desktop.wallet.recovery.status': tuple([]),
  'desktop.wallet.recovery.setup': tuple([]),
  'desktop.wallet.recovery.show': tuple([]),
  'desktop.wallet.recovery.restore': tuple([]),
  // R5-R1: the renderer names a held top-up's ledger entry, nothing else (main confirms).
  'desktop.wallet.topUp.holds': tuple([]),
  'desktop.wallet.topUp.resume': tuple([matches(/^[0-9a-f]{16}$/, 16)]),
});

function wrapAll<T extends Record<string, Guard<unknown>>>(table: T): T {
  const out: Record<string, Guard<unknown>> = {};
  for (const [k, g] of Object.entries(table)) out[k] = safe(g);
  return Object.freeze(out) as T;
}

/** The runtime method list (same keys as `MethodTable`). */
export const METHODS: readonly Method[] = Object.freeze(Object.keys(validateArgs) as Method[]);

export function isMethod(x: unknown): x is Method {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(validateArgs, x);
}

// ---- errors ---------------------------------------------------------------------------------

export const isErrorCode = oneOf<ErrorCode>(ERROR_CODES);

export const isWireError: Guard<WireError> = safe(
  (x): x is WireError =>
    obj({ code: isErrorCode, message: text(0, LIMITS.maxErrorMessage, { multiline: true }) })(x) &&
    x.message.startsWith(`${x.code}: `),
);

// ---- renderer ⇄ main messages ---------------------------------------------------------------

const isV = literal(IPC_V);

/** A complete call: envelope, known method, and arguments valid for that method. */
export const isCallMsg: Guard<AnyCallMsg> = safe((x): x is AnyCallMsg => {
  if (
    !obj({ v: isV, id: isMsgId, method: isMethod, args: (a): a is unknown => Array.isArray(a) })(x)
  )
    return false;
  return validateArgs[x.method](x.args);
});

export const isTopic: Guard<Topic> = safe(
  union(
    obj({ t: oneOf(['seeder.status', 'notifications', 'wallet.change'] as const) }),
    obj({ t: oneOf(['session.peers', 'session.spend'] as const), sid: isSessionId }),
    obj({ t: literal('upload.progress'), uploadId: isUploadId }),
    obj({ t: oneOf(['signer.status', 'recovery.progress'] as const) }),
  ),
);

export const isSubMsg: Guard<SubMsg> = safe(
  union(
    obj({ v: isV, op: literal('sub'), subId: isMsgId, topic: isTopic }),
    obj({ v: isV, op: literal('unsub'), subId: isMsgId }),
  ),
);

/** An absolute path (POSIX, drive-letter or UNC), no NUL, within `LIMITS.maxPath`. */
export const isAbsolutePath: Guard<string> = safe(
  (x): x is string =>
    typeof x === 'string' &&
    x.length > 1 &&
    x.length <= LIMITS.maxPath &&
    !x.includes('\u0000') &&
    (x.startsWith('/') || /^[A-Za-z]:[\\/]/.test(x) || x.startsWith('\\\\')),
);

export const isGrantFileMsg: Guard<GrantFileMsg> = safe(obj({ v: isV, path: isAbsolutePath }));

const anyValue = (_x: unknown): _x is unknown => true;

export const isReplyMsg: Guard<ReplyMsg> = safe(
  union(
    obj({ v: isV, id: isMsgId, ok: literal(true), result: anyValue }),
    obj({ v: isV, id: isMsgId, ok: literal(false), error: isWireError }),
  ),
);

export const isEventMsg: Guard<EventMsg> = safe(obj({ v: isV, subId: isMsgId, payload: anyValue }));

// ---- main ⇄ host ------------------------------------------------------------------------------

const isUploadFile = obj({ path: isAbsolutePath, name: text(1, 1024), size: isCount });

/** A secret crossing main ⇄ host: non-empty UTF-8 bytes, bounded. */
const isSecretBytes: Guard<Uint8Array> = (x): x is Uint8Array =>
  bytes(MAX_SECRET_BYTES)(x) && x.byteLength > 0;

/**
 * ADR 0013: a NIP-46 `auth_url` main may open in the user's browser — `https:` only, an ASCII
 * (IDNA-encoded) host, no user-info, no whitespace / control / bidi characters, bounded. A regex,
 * not `URL`: this module runs under Bare too.
 */
export const isAuthUrl: Guard<string> = safe(matches(AUTH_URL_RE, MAX_AUTH_URL));

/**
 * Security review F25: an external link main may offer to open (a Markdown link the user clicked)
 * — the same rule as a NIP-46 approval link: `https:`, an ASCII host, no user-info, no
 * whitespace / control / bidi characters, bounded.
 */
export const isExternalLink: Guard<string> = safe(matches(AUTH_URL_RE, MAX_AUTH_URL));

/**
 * Issue #2: the first auto top-up into a mint — two distinct mint URLs (a top-up never funds a
 * mint from itself) and an amount within the per-top-up cap.
 */
const isTopUpFirstForm = (x: unknown): x is Extract<PromptForm, { kind: 'top-up-first' }> =>
  obj({
    kind: literal('top-up-first'),
    target: isMintUrl,
    source: isMintUrl,
    amount: int(1, LIMITS.maxAutoTopUpAmountSats) as Guard<Sats>,
  })(x) && x.target !== x.source;

// ---- the recovery phrase (ADR 0016) --------------------------------------------------------
//
// A word crosses every hop as its index into the BIP-39 English list, never as text: the prompt
// page maps indices through its own bundled list, so neither the host nor anything upstream can
// put prose in the trusted window, and nothing that is not a small integer is accepted as a word.

/** One BIP-39 English word, as its index. */
export const isWordIndex: Guard<number> = int(0, BIP39_LIST_SIZE - 1);
/** A whole phrase: exactly `RECOVERY_WORDS` indices. */
export const isPhraseIndices: Guard<readonly number[]> = safe(
  arrayOf(isWordIndex, RECOVERY_WORDS, RECOVERY_WORDS),
);
/** The confirmation's positions: `RECOVERY_CONFIRM_WORDS` distinct 0-based positions, ascending. */
export const isConfirmPositions: Guard<readonly number[]> = safe(
  (x): x is readonly number[] =>
    arrayOf(int(0, RECOVERY_WORDS - 1), RECOVERY_CONFIRM_WORDS, RECOVERY_CONFIRM_WORDS)(x) &&
    x.every((p, i) => i === 0 || p > (x[i - 1] ?? RECOVERY_WORDS)),
);
/** A restore's typed phrase: none (`[]`) or a whole one. */
const isTypedPhrase = (x: unknown): x is readonly number[] =>
  arrayOf(isWordIndex, RECOVERY_WORDS)(x) && (x.length === 0 || x.length === RECOVERY_WORDS);

/**
 * One mint's reissue for main's dialog: an https mint, a fee below the amount, inputs bounded.
 * The host checks each plan with it before asking (a plan that fails is left out and counted,
 * never allowed to sink the whole question: independent review IR1).
 */
export const isReissuePlanWire: Guard<ReissuePlanWire> = safe(
  (x): x is ReissuePlanWire =>
    obj({
      mint: isMintUrl,
      amount: isPositiveSats,
      inputs: int(1, 100_000),
      feeSats: isSats,
    })(x) && x.feeSats < x.amount,
);

/** ADR 0016: a native-dialog question from the host (data only; main holds the words). */
export const isConfirmForm: Guard<ConfirmForm> = safe(
  union(
    (x): x is Extract<ConfirmForm, { kind: 'recovery-reissue' }> =>
      obj({
        kind: literal('recovery-reissue'),
        plans: arrayOf(isReissuePlanWire, MAX_REISSUE_PLANS, 1),
      })(x) && new Set(x.plans.map((p) => p.mint)).size === x.plans.length,
    obj({ kind: literal('recovery-reveal') }),
    obj({ kind: literal('recovery-rotate') }),
    obj({
      kind: literal('topup-resume'),
      target: isMintUrl,
      amount: isPositiveSats,
      reason: oneOf(['checking', 'unreadable', 'unreachable', 'owed', 'waiting'] as const),
    }),
  ),
);

/** ADR 0013: a question for main's prompt window (data only; the page holds the words). */
export const isPromptForm: Guard<PromptForm> = safe(
  union(
    obj({ kind: literal('local-setup'), hasKey: bool, keychain: bool }),
    obj({ kind: literal('unlock-passphrase'), retry: bool }),
    obj({
      kind: oneOf([
        'new-passphrase',
        'import-nsec',
        'create-wallet',
        'remove-key',
        'recovery-restore',
      ] as const),
    }),
    obj({ kind: literal('bunker'), keychain: bool }),
    obj({ kind: literal('bunker-auth'), url: isAuthUrl }),
    isTopUpFirstForm,
    obj({ kind: literal('recovery-show'), words: isPhraseIndices, again: bool }),
    obj({ kind: literal('recovery-confirm'), positions: isConfirmPositions, retry: bool }),
    obj({ kind: literal('recovery-reauth'), retry: bool }),
  ),
);

/** ADR 0013: the prompt window's answer (the host checks it matches the question it asked). */
export const isPromptAnswer: Guard<PromptAnswer> = safe(
  union(
    obj({
      kind: literal('local-setup'),
      method: oneOf(['passphrase', 'keychain'] as const),
      flow: oneOf(['unlock', 'import', 'generate', 'remove'] as const),
    }),
    obj({ kind: literal('secret'), value: isSecretBytes }),
    obj({ kind: literal('bunker'), uri: isSecretBytes, remember: bool }),
    obj({ kind: literal('create-wallet'), create: bool }),
    obj({ kind: literal('remove-key'), confirm: bool }),
    obj({ kind: literal('bunker-auth'), open: bool }),
    obj({ kind: literal('top-up-first'), confirm: bool }),
    obj({ kind: literal('recovery-show'), done: bool }),
    obj({
      kind: literal('recovery-confirm'),
      words: arrayOf(isWordIndex, RECOVERY_CONFIRM_WORDS, RECOVERY_CONFIRM_WORDS),
    }),
    obj(
      { kind: literal('recovery-restore'), words: isTypedPhrase },
      { mints: arrayOf(isMintUrl, MAX_RESTORE_MINTS, 1) },
    ),
  ),
);

const isKeychainSlot = oneOf(KEYCHAIN_SLOTS);

/**
 * ADR 0013: does `a` answer `form` — and only with what `form` offered? (Main checks the page's
 * answer with it, the host checks main's.) An unlock method or flow the question did not offer,
 * or "remember" without a keychain, does not fit.
 */
export function promptAnswerFits(form: PromptForm, a: PromptAnswer): boolean {
  switch (form.kind) {
    case 'local-setup':
      return (
        a.kind === 'local-setup' &&
        (a.method === 'passphrase' || form.keychain) &&
        (form.hasKey
          ? a.flow === 'unlock' || a.flow === 'remove'
          : a.flow === 'import' || a.flow === 'generate')
      );
    case 'unlock-passphrase':
    case 'new-passphrase':
    case 'import-nsec':
      return a.kind === 'secret';
    case 'bunker':
      return a.kind === 'bunker' && (!a.remember || form.keychain);
    case 'create-wallet':
      return a.kind === 'create-wallet';
    case 'remove-key':
      return a.kind === 'remove-key';
    case 'bunker-auth':
      return a.kind === 'bunker-auth';
    case 'top-up-first':
      return a.kind === 'top-up-first';
    case 'recovery-show':
      return a.kind === 'recovery-show';
    case 'recovery-confirm':
      return a.kind === 'recovery-confirm' && a.words.length === form.positions.length;
    case 'recovery-restore':
      return a.kind === 'recovery-restore';
    case 'recovery-reauth':
      return a.kind === 'secret';
  }
}

/** Main → host. Calls and subs are re-validated in full (the host runs the guards again). */
export const isHostIn: Guard<HostIn> = safe(
  union(
    obj({ kind: literal('call'), wc: isWcId, msg: isCallMsg }, { file: isUploadFile }),
    obj({ kind: literal('sub'), wc: isWcId, msg: isSubMsg }),
    obj({ kind: literal('wc-gone'), wc: isWcId }),
    obj({ kind: literal('image'), req: isMsgId, id: matches(/^[A-Za-z0-9_-]{1,128}$/, 128) }),
    obj({ kind: literal('prompt-answer'), req: isMsgId, answer: nullable(isPromptAnswer) }),
    obj({
      kind: literal('keychain-result'),
      req: isMsgId,
      ok: bool,
      value: nullable(isSecretBytes),
    }),
    obj({ kind: literal('confirm-result'), req: isMsgId, ok: bool }),
  ),
);

/** Host → main. Main is the more privileged side; it checks shapes before acting on them. */
export const isHostOut: Guard<HostOut> = safe(
  union(
    obj({ kind: oneOf(['reply', 'sub-reply'] as const), wc: isWcId, msg: isReplyMsg }),
    obj({ kind: literal('event'), wc: isWcId, msg: isEventMsg }),
    obj({
      kind: literal('media-link'),
      token: matches(/^[A-Za-z0-9_-]{16,128}$/, 128),
      url: nullable(
        matches(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[\x21-\x7e]*$/, LIMITS.maxUrl),
      ),
    }),
    obj({
      kind: literal('image'),
      req: isMsgId,
      bytes: nullable(bytes(LIMITS.maxThumbnailBytes)),
      type: nullable(isImageMime),
    }),
    obj({ kind: literal('prompt'), req: isMsgId, form: isPromptForm }),
    obj({ kind: literal('prompt-cancel'), req: isMsgId }),
    (x): x is Extract<HostOut, { kind: 'keychain' }> =>
      obj({
        kind: literal('keychain'),
        req: isMsgId,
        op: oneOf(['get', 'forget'] as const),
        slot: isKeychainSlot,
      })(x) ||
      obj({
        kind: literal('keychain'),
        req: isMsgId,
        op: literal('put'),
        slot: isKeychainSlot,
        value: isSecretBytes,
      })(x),
    obj({ kind: literal('confirm'), req: isMsgId, form: isConfirmForm }),
    obj({ kind: literal('confirm-cancel'), req: isMsgId }),
  ),
);

// ---- data shapes the host receives from the worker (reused by worker-guards.ts) ---------------

const isHyperblobId: Guard<HyperblobId> = obj({
  byteOffset: isCount,
  blockOffset: isCount,
  blockLength: isCount,
  byteLength: isCount,
});
export const isHyperblobRef: Guard<HyperblobRef> = obj({ core: isCoreKey, blob: isHyperblobId });

export const isPricePolicy: Guard<PricePolicy> = obj(
  {
    satsPerBlock: isSats,
    blockSize: int(1, 2 ** 31),
    mints: arrayOf(isMintUrl, 32),
    split: isSplit,
    creatorP2pk: isCashuP2pk,
  },
  // v5: a creator's NIP-71 `minpay` (1 … the manifest parser's bound).
  { minPaySats: int(1, LIMITS.maxMinPaySats) as Guard<Sats> },
);

const isMaybeHashedUrl = obj(
  { url: text(1, LIMITS.maxUrl) },
  { sha256: isSha256, size: int(1, LIMITS.maxThumbnailBytes) },
);

export const renditionDraftGuards = {
  req: {
    label: isLabel,
    mime: text(1, 128),
    sha256: isSha256,
    size: isCount,
    hyper: isHyperblobRef,
    hyperUrl: text(1, LIMITS.maxUrl),
    fallbacks: arrayOf(text(1, LIMITS.maxUrl), 32),
  },
  opt: {
    width: isCount,
    height: isCount,
    bitrateKbps: num(0, 1e7),
    placeholder: text(1, 65536),
  },
} as const;

export const isRendition: Guard<Rendition> = obj(renditionDraftGuards.req, {
  ...renditionDraftGuards.opt,
  image: isMaybeHashedUrl,
  captions: arrayOf(
    obj({ lang: text(1, 64), url: text(1, LIMITS.maxUrl) }, { sha256: isSha256 }),
    64,
  ),
  storyboard: obj(
    {
      url: text(1, LIMITS.maxUrl),
      cols: int(1, 1000),
      rows: int(1, 1000),
      intervalSec: num(0, 1e6),
    },
    { sha256: isSha256 },
  ),
});

const isNostrEvent: Guard<NostrEvent> = obj({
  id: isEventId,
  pubkey: isPubkey,
  kind: int(0, 65535),
  created_at: isUnixSeconds,
  tags: arrayOf(arrayOf(text(0, LIMITS.maxBody, { multiline: true }), 64, 1), 4096),
  content: text(0, 262144, { multiline: true }),
  sig: matches(/^[0-9a-f]{128}$/, 128),
});

export const isVideoManifest: Guard<VideoManifest> = obj(
  {
    id: isEventId,
    kind: oneOf([21, 22] as const),
    author: isPubkey,
    title: isTitle,
    description: isBody,
    publishedAt: isUnixSeconds,
    tags: isTags,
    renditions: arrayOf(isRendition, 16, 1),
    price: isPricePolicy,
    blossomServers: arrayOf(text(1, LIMITS.maxUrl), 32),
    event: isNostrEvent,
  },
  { durationSec: num(0, 1e7) },
);

export const isPeerSpend: Guard<PeerSpend> = obj(
  { pubkey: isPubkey, sats: isSats, ratePerMin: isSats, blocks: isCount },
  { latencyMs: num(0, 1e7) },
);

const isPeerWindow: Guard<PeerWindow> = obj({
  peer: isPubkey,
  uploaded: isCount,
  paid: isCount,
  outstanding: isSafeInt,
  windowBlocks: isCount,
  banned: bool,
  lastActivity: isUnixSeconds,
});

export const isSeederStatusWire: Guard<SeederStatusWire> = obj({
  enabled: bool,
  pubkey: isPubkey,
  videos: isCount,
  bytesStored: isCount,
  diskCapBytes: isCount,
  peers: arrayOf(isPeerWindow, 4096),
  earned: obj({ total: isSats, unswapped: isSats, byMint: wireMap(isMintUrl, isSats) }),
  banned: arrayOf(
    obj({ pubkey: isPubkey, reason: text(0, LIMITS.maxLabel), at: isUnixSeconds }),
    4096,
  ),
});
