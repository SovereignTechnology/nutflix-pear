/**
 * Guards for the host ⇄ worker protocol (`./worker-protocol.ts`). Same rules as `./guards.ts`:
 * total, exact keys, capped. Complete by construction — a method or event without a guard is
 * a compile error.
 *
 *   worker side:  `isHostToWorker(msg)` on every decoded frame; then `validateHostResult[m]`
 *                 on the result of each of its own requests.
 *   host side:    `isWorkerToHost(msg)` on every decoded frame; then `validateWorkerResult[m]`
 *                 on the result of each of its own requests.
 */
import type { UploadProgress } from '@sovit/core';
import type { Guard } from './protocol.js';
import { IMAGE_MIMES, LIMITS } from './protocol.js';
import {
  arrayOf,
  bool,
  int,
  isAbsolutePath,
  isCashuP2pk,
  isCoreKey,
  isCount,
  isEventId,
  isHyperblobRef,
  isImageMime,
  isInvoice,
  isIrohRelayUrl,
  isIrohRelays,
  isLabel,
  isMintUrl,
  isMsgId,
  isPeerSpend,
  isPositiveSats,
  isPricePolicy,
  isPubkey,
  isSats,
  isSeederStatusWire,
  isSessionId,
  isSha256,
  isUnixSeconds,
  isUploadId,
  isVideoManifest,
  isWireError,
  literal,
  matches,
  nullable,
  num,
  obj,
  oneOf,
  renditionDraftGuards,
  safe,
  text,
  union,
  nfxOnlyIfFree,
  uploadMetaGuards,
  uploadMetaOptGuards,
  wireMap,
} from './guards.js';
import type {
  HostMethod,
  HostMethodTable,
  HostToWorker,
  NfxIrohEndpointWire,
  PublishDraft,
  WorkerEvent,
  WorkerEventName,
  WorkerMethod,
  WorkerMethodTable,
  WorkerToHost,
} from './worker-protocol.js';
import {
  MAX_NFX_IROH_ADDRS,
  MAX_NFX_PLAY_PEERS,
  MAX_NFX_RENDITIONS,
  NFX_RESOLUTION,
  NFX_UPLOAD_FAILURES,
  WORKER_V,
} from './worker-protocol.js';

const anyValue = (_x: unknown): _x is unknown => true;

/** ADR 0015: a blob in a creator's profile core, and an image's byte size. */
const isHyperImageUrl = matches(
  /^hyper:\/\/[0-9a-f]{64}\/[0-9]{1,15}-[0-9]{1,15}(?:\+[0-9]{1,15})?$/,
  200,
);
const isImageSize = int(1, LIMITS.maxThumbnailBytes);
/** An image as lower-case hex: at most the image cap (two characters a byte). */
const isImageHex = matches(/^(?:[0-9a-f]{2})+$/, 2 * LIMITS.maxThumbnailBytes);

const isSeeding = obj(
  { enabled: bool, diskCapBytes: int(0, LIMITS.maxDiskCapBytes) },
  { serveImages: bool },
);
const isPrefetch = num(0, LIMITS.maxPrefetchSec);
const isPort = int(1, 65535);
const isSid = obj({ sid: isSessionId });

const isDev = safe(
  (x: unknown): x is NonNullable<WorkerMethodTable['init'][0]['dev']> =>
    obj(
      { mocks: bool, fixtures: bool },
      { bootstrap: arrayOf(obj({ host: literal('127.0.0.1'), port: isPort }), 16, 1) },
    )(x) &&
    // The --dev-mocks fence (D1): a custom (testnet) bootstrap only together with mock payments.
    (x.bootstrap === undefined || x.mocks),
);

const isPayments = obj({
  pubkey: isPubkey,
  p2pk: isCashuP2pk,
  mints: arrayOf(isMintUrl, 16, 1),
});

/**
 * Slice 5b: `Settings.nfx` for the worker. Slice 5e-3: with its iroh relays, in the IPC guard's
 * normal form (`isIrohRelays`: iroh's own spelling, unique, at most 4), so the worker compares a
 * relay the helper reports as a string.
 */
const isNfxConfigure = obj({ enabled: bool, irohRelays: isIrohRelays });

const isInit = safe(
  (x: unknown): x is WorkerMethodTable['init'][0] =>
    obj(
      {
        v: literal(WORKER_V),
        storage: isAbsolutePath,
        seeding: isSeeding,
        prefetchSeconds: isPrefetch,
      },
      {
        ffmpeg: obj({ ffmpeg: isAbsolutePath, ffprobe: isAbsolutePath }),
        dev: isDev,
        payments: isPayments,
        nfx: isNfxConfigure,
        // Slice 5e-3: the iroh helper's executable (absolute, bounded), or none.
        irohHelper: nullable(isAbsolutePath),
      },
    )(x) &&
    // Real payments and mock payments never run together.
    !(x.payments !== undefined && x.dev?.mocks === true),
);

const isPlayOpen = obj(
  {
    sid: isSessionId,
    videoId: isEventId,
    rendition: obj(
      { label: isLabel, hyper: isHyperblobRef, size: isCount },
      { bitrateKbps: num(0, 1e7) },
    ),
    policy: isPricePolicy,
    prefetchSeconds: isPrefetch,
  },
  { durationSec: num(0, 1e7) },
);

const isThumbnailHex = obj({
  hex: matches(/^(?:[0-9a-f]{2})+$/, 2 * LIMITS.maxThumbnailBytes),
  type: isImageMime,
});

const isUploadMetaShape = obj(uploadMetaGuards, uploadMetaOptGuards);
/** Contracts v8: `nfx` only on a free video, re-checked on this hop (the host checked it too). */
const isUploadMeta = ((x: unknown) =>
  isUploadMetaShape(x) && nfxOnlyIfFree(x)) as typeof isUploadMetaShape;

/** An NFX-01 video address: `nfx:<network>:<specver>:<video-id>`. */
const isNfxVideoAddr = matches(
  /^nfx:[a-z0-9-]{2,32}:(?:0|[1-9][0-9]{0,19}):[a-z0-9][a-z0-9-]{6,62}$/,
  128,
);

const isNfxUploadStatusWire = union(
  obj(
    {
      state: literal('stored'),
      video: isNfxVideoAddr,
      root: isSha256,
      segs: matches(/^(?:0|[1-9][0-9]{0,19})$/, 20),
      renditions: int(1, 16),
      bytes: isCount,
    },
    { thumb: obj({ sha256: isSha256, mime: literal('image/jpeg') }) },
  ),
  obj({ state: literal('failed'), reason: oneOf(NFX_UPLOAD_FAILURES) }),
);

const isStudioUpload = obj(
  { uploadId: isUploadId, path: isAbsolutePath, name: text(1, 1024), meta: isUploadMeta },
  { thumbnailChoice: union(int(0, 63), isThumbnailHex) },
);

const isNfxHyperdhtEndpoint = obj({
  t: literal('hyperdht'),
  peer: matches(/^[0-9a-f]{64}$/, 64),
  bind: matches(/^[0-9a-f]{128}$/, 128),
});

/**
 * Slice 5e-3: a key of an iroh endpoint's `tickets` — `meta` or a rendition id (NFX-03 §4). A
 * rendition id comes from a hash list: a label, nothing longer. The worker serves over iroh only
 * a video whose every rendition id passes this.
 */
export const isNfxTicketKey = isLabel;
/** An iroh-blobs `BlobTicket` in its string form (NFX-06 §2): `blob` + lowercase base32. */
export const isNfxBlobTicket = matches(/^blob[a-z2-7]{8,4092}$/, 4096);
/** A direct address as iroh prints one: `a.b.c.d:port` or `[ipv6(%scope)]:port`. */
export const isNfxSocketAddr = matches(
  /^(?:[0-9]{1,3}(?:\.[0-9]{1,3}){3}|\[[0-9a-f:.]{2,45}(?:%[0-9]{1,10})?\]):[0-9]{1,5}$/,
  64,
);
const isNfxIrohEndpointShape = obj({
  t: literal('iroh'),
  node: matches(/^[0-9a-f]{64}$/, 64),
  relay: union(literal(''), isIrohRelayUrl),
  addrs: arrayOf(isNfxSocketAddr, MAX_NFX_IROH_ADDRS),
  // `meta` and at most one per rendition the worker serves.
  tickets: wireMap(isNfxTicketKey, isNfxBlobTicket, MAX_NFX_RENDITIONS + 1),
});
/** It carries the `meta` collection, without which an iroh-only fetcher has no hash list. */
const isNfxIrohEndpoint = safe(
  (x: unknown): x is NfxIrohEndpointWire =>
    isNfxIrohEndpointShape(x) && x.tickets.$map.some(([k]) => k === 'meta'),
);

/** Slice 5d: a free NFX video to watch, from the seeders that beacon it. */
const isNfxPlayOpen = obj(
  {
    sid: isSessionId,
    video: isNfxVideoAddr,
    root: isSha256,
    segs: int(1, Number.MAX_SAFE_INTEGER),
    peers: arrayOf(isNfxHyperdhtEndpoint, MAX_NFX_PLAY_PEERS, 1),
    prefetchSeconds: isPrefetch,
  },
  { rendition: isLabel },
);

/** Arguments of every host → worker request. */
export const validateWorkerArgs: {
  readonly [M in WorkerMethod]: Guard<WorkerMethodTable[M][0]>;
} = {
  init: safe(isInit),
  'play.open': safe(isPlayOpen),
  'play.pause': safe(isSid),
  'play.resume': safe(isSid),
  'play.prefetch': safe(obj({ sid: isSessionId, seconds: isPrefetch })),
  'play.close': safe(isSid),
  'seeder.status': safe(obj({}) as Guard<Record<string, never>>),
  'seeder.configure': safe(isSeeding),
  'seeder.melt': safe(obj({ mint: isMintUrl, bolt11: isInvoice })),
  'seeder.unban': safe(obj({ pubkey: isPubkey })),
  'nfx.configure': safe(isNfxConfigure),
  'nfx.endpoint': safe(obj({ seeder: isPubkey, video: isNfxVideoAddr })),
  'nfx.videos': safe(obj({}) as Guard<Record<string, never>>),
  'nfx.play.open': safe(isNfxPlayOpen),
  'nfx.play.close': safe(isSid),
  'studio.ffmpeg': safe(obj({ recheck: bool }, { path: isAbsolutePath })),
  'studio.upload': safe(isStudioUpload),
  'image.fetch': safe(obj({ url: isHyperImageUrl, sha256: isSha256, size: isImageSize })),
  'profile.putImage': safe(obj({ hex: isImageHex })),
};

/**
 * Lane P2-owed-viewer: the most blocks a `play.close` may report unpaid (the worker's record holds
 * at most 1024 per seeder; the host caps a tail authorisation at the session's remaining budget).
 */
const MAX_TAIL_BLOCKS = 1 << 20;

const isUndefined = (x: unknown): x is undefined => x === undefined;
/** JSON has no `undefined`: a void result arrives as an absent `r`, i.e. `undefined`. */
const isVoid = isUndefined;

const isLoopbackLink = matches(
  /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[\x21-\x7e]*$/,
  LIMITS.maxUrl,
) as Guard<WorkerMethodTable['play.open'][1]['link']>;

const isFfmpegStatus = obj(
  { found: bool },
  {
    path: text(1, LIMITS.maxPath),
    version: text(0, LIMITS.maxLabel),
    os: oneOf(['macos', 'windows', 'linux'] as const),
  },
);

/** Slice 5b: the most NFX videos one `nfx.videos` lists. */
export const MAX_NFX_STORED_VIDEOS = 4096;

const isNfxStoredVideo = obj({
  video: isNfxVideoAddr,
  root: isSha256,
  segs: int(1, Number.MAX_SAFE_INTEGER),
});

/** Slice 5d: a rendition's id comes from a peer's hash list: a label, nothing longer. */
export const isNfxRenditionWire = obj(
  { id: isLabel, bandwidth: int(1, Number.MAX_SAFE_INTEGER) },
  { resolution: matches(NFX_RESOLUTION, 13) },
);

const isNfxPlayOpenShape = obj({
  link: isLoopbackLink,
  rendition: isLabel,
  renditions: arrayOf(isNfxRenditionWire, MAX_NFX_RENDITIONS, 1),
});
/** The rendition served is one of those listed. */
const isNfxPlayOpenResult = safe(
  (x: unknown): x is WorkerMethodTable['nfx.play.open'][1] =>
    isNfxPlayOpenShape(x) && x.renditions.some((r) => r.id === x.rendition),
);

/** Results of every host → worker request (checked by the host). */
export const validateWorkerResult: {
  readonly [M in WorkerMethod]: Guard<WorkerMethodTable[M][1]>;
} = {
  init: isVoid,
  'play.open': safe(obj({ key: isCoreKey, link: isLoopbackLink })),
  'play.pause': isVoid,
  'play.resume': isVoid,
  'play.prefetch': isVoid,
  // Lane P2-owed-viewer: a session's unpaid tail (a seeder's credit is at most 1024 blocks per
  // seeder; the host caps the authorisation at the session's remaining budget anyway).
  'play.close': safe(obj({ unpaid: int(0, MAX_TAIL_BLOCKS) })),
  'seeder.status': safe(isSeederStatusWire),
  'seeder.configure': isVoid,
  'seeder.melt': safe(obj({ paid: bool })),
  'seeder.unban': isVoid,
  'nfx.configure': isVoid,
  'nfx.endpoint': safe(
    obj({
      hyperdht: union(isNfxHyperdhtEndpoint, literal(null)),
      iroh: union(isNfxIrohEndpoint, literal(null)),
    }),
  ),
  'nfx.videos': safe(obj({ videos: arrayOf(isNfxStoredVideo, MAX_NFX_STORED_VIDEOS) })),
  'nfx.play.open': isNfxPlayOpenResult,
  'nfx.play.close': isVoid,
  'studio.ffmpeg': safe(isFfmpegStatus),
  'studio.upload': safe(isVideoManifest),
  // At most the image cap as hex (two characters a byte).
  'image.fetch': safe(obj({ hex: isImageHex })),
  'profile.putImage': safe(obj({ url: isHyperImageUrl, sha256: isSha256, size: isImageSize })),
};

const isRenditionDraft = obj(renditionDraftGuards.req, renditionDraftGuards.opt);

const publishDraftShape = obj(
  {
    uploadId: isUploadId,
    meta: isUploadMeta,
    durationSec: num(0, 1e7),
    blockSize: int(1, 2 ** 31),
    renditions: arrayOf(isRenditionDraft, 16, 1),
    thumbnail: union(
      obj({ kind: literal('candidate'), path: isAbsolutePath, sha256: isSha256 }),
      obj({ kind: literal('custom'), sha256: isSha256, type: oneOf(IMAGE_MIMES) }),
    ),
    codec: oneOf(['h264', 'vp9', 'av1'] as const),
  },
  {
    storyboard: obj({
      path: isAbsolutePath,
      vttPath: isAbsolutePath,
      sha256: isSha256,
      cols: int(1, 1000),
      rows: int(1, 1000),
      intervalSec: num(0, 1e6),
    }),
    thumbnailImage: obj({ url: isHyperImageUrl, sha256: isSha256, size: isImageSize }),
  },
);

const isPublishDraft: Guard<PublishDraft> = publishDraftShape;

// ---- money (ADR 0012): shapes only; the host's money plane authorises every call ----------

/** Most proofs one set may carry on the hop (the engine's own cap is lower). */
const MAX_PROOFS = 128;
const HEX = /^[0-9a-f]+$/;
const isKeysetId = matches(/^(?:[0-9a-f]{16}|[0-9a-f]{66})$/, 66);
const isProof = obj(
  {
    id: isKeysetId,
    amount: int(1, LIMITS.maxSats),
    secret: text(1, 4096),
    C: matches(/^0[23][0-9a-f]{64}$/, 66),
  },
  {
    dleq: obj({ e: matches(HEX, 64), s: matches(HEX, 64) }, { r: matches(HEX, 64) }),
    witness: text(1, 8192),
  },
);
const isProofs = arrayOf(isProof, MAX_PROOFS, 1);
const isProofSet = obj({ mint: isMintUrl, proofs: isProofs });
const isLockedSet = obj({
  mint: isMintUrl,
  unit: literal('sat'),
  lockedTo: isCashuP2pk,
  proofs: isProofs,
});
const MAX_BLOCK = 2 ** 40;
const isRange = safe(
  (x: unknown): x is HostMethodTable['pay.build'][0]['range'] =>
    obj({ core: isCoreKey, fromBlock: int(0, MAX_BLOCK), toBlock: int(0, MAX_BLOCK) })(x) &&
    x.toBlock >= x.fromBlock,
);
const isPayBuild = obj({
  sid: isSessionId,
  range: isRange,
  seeder: obj({ pubkey: isPubkey, p2pk: isCashuP2pk, mint: isMintUrl }),
  policy: isPricePolicy,
  carryIn: int(0, 99),
});
/**
 * One set of a `PayMessage`: legitimately EMPTY when its share is 0 sats by the split (contracts
 * v5, `PayMessage`: "still addressed to its recipient") — at 90/10 a PAY of 3 blocks at 2 sats
 * gives the creator 0. Lane P2-owed-viewer (found building the independent review's 90/10 test):
 * `isLockedSet` asks for one proof at least, so such a PAY was refused AFTER the host had built it
 * (its proofs spent, locked to the seeder and the creator) and the payer asked for another.
 */
const isPaySet = obj({
  mint: isMintUrl,
  unit: literal('sat'),
  lockedTo: isCashuP2pk,
  proofs: arrayOf(isProof, MAX_PROOFS, 0),
});
/** A PAY carries at least one proof, in one set or the other (a PAY of nothing is malformed). */
const isPayMessage = safe(
  (x: unknown): x is HostMethodTable['pay.build'][1] =>
    obj({
      range: isRange,
      carryIn: int(0, 99),
      seederProofs: isPaySet,
      creatorProofs: isPaySet,
    })(x) && x.seederProofs.proofs.length + x.creatorProofs.proofs.length > 0,
);
/** A keyset from the host: amount → compressed public key, at most 64 denominations. */
const isKeys = safe((x: unknown): x is Readonly<Record<string, string>> => {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const entries = Object.entries(x);
  return (
    entries.length > 0 &&
    entries.length <= 64 &&
    entries.every(
      ([k, v]) =>
        /^[1-9][0-9]{0,18}$/.test(k) && typeof v === 'string' && /^0[23][0-9a-f]{64}$/.test(v),
    )
  );
});
const isMintKeyset = obj(
  {
    mint: isMintUrl,
    id: isKeysetId,
    unit: literal('sat'),
    active: bool,
    keys: isKeys,
    fetchedAt: isUnixSeconds,
  },
  { inputFeePpk: int(0, 100_000) },
);
const isHelloChallenge = matches(/^pay\/1:(?:[0-9a-f]{2}){32,64}:[0-9a-f]{64}$/, 256);
const isRedeemResult = union(
  obj({ ok: literal(true), sats: isSats }),
  obj({ ok: literal(false), spent: bool }),
);

/** Arguments of every worker → host request (checked by the host). */
export const validateHostArgs: { readonly [M in HostMethod]: Guard<HostMethodTable[M][0]> } = {
  'studio.publish': safe(isPublishDraft),
  'pay.build': safe(isPayBuild),
  // `helloChallenge()`: `<pay/1 name>:<handshake hash hex>:<sender Noise key hex>` — the host
  // signs a HELLO over exactly this and nothing else (ADR 0012).
  'pay.hello': safe(obj({ challenge: isHelloChallenge })),
  'seller.keyset': safe(obj({ mint: isMintUrl, id: isKeysetId })),
  'seller.redeem': safe(isProofSet),
  'seller.checkSpent': safe(isProofSet),
  'seller.spentByUs': safe(isProofSet),
  'seller.nutzap': safe(obj({ set: isLockedSet, core: isCoreKey })),
};

/** Results of every worker → host request (checked by the worker). */
export const validateHostResult: {
  readonly [M in HostMethod]: Guard<HostMethodTable[M][1]>;
} = {
  'studio.publish': safe(isVideoManifest),
  'pay.build': safe(isPayMessage),
  'pay.hello': safe(
    obj({ pubkey: isPubkey, createdAt: isUnixSeconds, signature: matches(/^[0-9a-f]{128}$/, 128) }),
  ),
  'seller.keyset': safe(union(isMintKeyset, literal(null))),
  'seller.redeem': safe(isRedeemResult),
  'seller.checkSpent': safe(arrayOf(bool, MAX_PROOFS, 1)),
  'seller.spentByUs': safe(bool),
  'seller.nutzap': isVoid,
};

const isPercent = num(0, 100);

/** Worker-side `UploadProgress`: thumbnail candidates are absolute paths. */
export const isWorkerUploadProgress: Guard<UploadProgress> = safe(
  union(
    obj({ stage: oneOf(['probing', 'publishing'] as const) }),
    obj({
      stage: oneOf(['transcoding', 'writing'] as const),
      rendition: isLabel,
      percent: isPercent,
    }),
    obj({ stage: literal('thumbnails'), candidates: arrayOf(isAbsolutePath, 64) }),
    obj({ stage: literal('done'), video: isVideoManifest }),
    obj({ stage: literal('error'), message: text(0, LIMITS.maxErrorMessage, { multiline: true }) }),
  ),
);

type Guarded<G> = { -readonly [K in keyof G]: G[K] extends Guard<infer T> ? T : never };

/** An exact-keys event guard; the table below checks it against `WorkerEvent`. */
function ev<const E extends WorkerEventName, G extends Readonly<Record<string, Guard<unknown>>>>(
  e: E,
  fields: G,
): Guard<{ op: 'ev'; e: E } & Guarded<G>> {
  const g = obj({ op: literal('ev'), e: literal(e), ...fields });
  return safe(g as unknown as Guard<{ op: 'ev'; e: E } & Guarded<G>>);
}

/** Every worker event (checked by the host). */
export const validateWorkerEvent: {
  readonly [E in WorkerEventName]: Guard<Extract<WorkerEvent, { readonly e: E }>>;
} = {
  ready: ev('ready', { v: literal(WORKER_V), port: isPort }),
  spend: ev('spend', {
    sid: isSessionId,
    mint: isMintUrl,
    amount: isPositiveSats,
    total: isSats,
    ratePerMin: isSats,
  }),
  peers: ev('peers', { sid: isSessionId, peers: arrayOf(isPeerSpend, LIMITS.maxArray) }),
  'seeder.status': ev('seeder.status', { status: isSeederStatusWire }),
  'upload.progress': ev('upload.progress', {
    uploadId: isUploadId,
    progress: isWorkerUploadProgress,
  }),
  'upload.nfx': ev('upload.nfx', { uploadId: isUploadId, status: isNfxUploadStatusWire }),
  'dev.fixtures': ev('dev.fixtures', { videos: arrayOf(isVideoManifest, LIMITS.maxArray) }),
  log: ev('log', {
    level: oneOf(['debug', 'info', 'warn', 'error'] as const),
    msg: text(0, LIMITS.maxString, { multiline: true }),
  }),
};

function own<T extends object>(table: T, k: unknown): k is keyof T & string {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(table, k);
}

const isRes = union(
  obj({ op: literal('res'), id: isMsgId, ok: literal(true) }, { r: anyValue }),
  obj({ op: literal('res'), id: isMsgId, ok: literal(false), e: isWireError }),
);

const isReqEnvelope = obj({ op: literal('req'), id: isMsgId, m: anyValue, a: anyValue });

/** Everything the worker may receive: a request with valid arguments, or a response. */
export const isHostToWorker: Guard<HostToWorker> = safe((x): x is HostToWorker => {
  if (isRes(x)) return true;
  if (!isReqEnvelope(x) || !own(validateWorkerArgs, x.m)) return false;
  return (validateWorkerArgs[x.m] as Guard<unknown>)(x.a);
});

/** Everything the host may receive: a request with valid arguments, a response, or an event. */
export const isWorkerToHost: Guard<WorkerToHost> = safe((x): x is WorkerToHost => {
  if (isRes(x)) return true;
  if (isReqEnvelope(x)) return own(validateHostArgs, x.m) && validateHostArgs[x.m](x.a);
  if (typeof x !== 'object' || x === null) return false;
  const e: unknown = (x as { e?: unknown }).e;
  return own(validateWorkerEvent, e) && (validateWorkerEvent[e] as Guard<unknown>)(x);
});
