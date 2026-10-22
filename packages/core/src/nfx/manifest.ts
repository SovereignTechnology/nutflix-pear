/**
 * Kind-38504 video manifests (NFX-02): the parse/verify algorithm of §4, and the publisher
 * side's tag list. Integer tags are `bigint`: NFX-02 §3 allows up to 2^64 − 1 and the parser
 * keeps every value nfx-proto keeps.
 */
import { pointFromHex } from '@cashu/cashu-ts';

import type { NostrEvent } from '../contracts/index.js';
import { fail, ok, type NfxResult, type Verified } from './errors.js';
import { KIND_MANIFEST, singleTag, tagValues, verifyEvent, type TagValues } from './event.js';
import { Namespace, VideoAddr } from './namespace.js';
import { isHttpsUrl, isLowerHex, parseU64Strict } from './util.js';

/** Tags that may appear at most once (NFX-02 §3 multiplicity rule). */
const SINGLE_VALUED = [
  'd',
  'n',
  'title',
  'published_at',
  'license',
  'root',
  'segs',
  'duration',
  'thumb',
  'price_hint',
  'key_price',
  'split',
  'mint',
  'cashu_key',
  'alt',
] as const;
/** Required in both modes. */
const REQUIRED = ['d', 'n', 'title', 'published_at', 'license', 'root', 'segs'] as const;
/** Required when licensed, prohibited when open. */
const LICENSED_ONLY = ['key_price', 'split', 'mint', 'cashu_key', 'free_seeder'] as const;
const LICENSED_REQUIRED = ['key_price', 'split', 'mint', 'cashu_key'] as const;

/** A poster blob, content-addressed (NFX-05). */
export interface Thumb {
  readonly sha256: string;
  readonly mime: string;
}

/** Licensed-mode economics (NFX-02 §3, NFX-08). */
export interface LicenseTerms {
  /** One-time price of the video key, in sats. */
  readonly keyPrice: bigint;
  /** Seeder share in basis points; the creator gets the rest at redemption. */
  readonly splitBps: number;
  /** The escrow mint (exactly one). */
  readonly mint: string;
  /** Compressed secp256k1 key (66 lowercase hex) the creator's share is P2PK-locked to. */
  readonly cashuKey: string;
  /** Seeders that may obtain the key by voucher (x-only pubkeys, hex). */
  readonly freeSeeders: readonly string[];
}

export type License =
  { readonly mode: 'open' } | { readonly mode: 'licensed'; readonly terms: LicenseTerms };

/** A manifest that passed NFX-02 §4 in full. */
export interface Manifest {
  readonly author: string;
  readonly createdAt: number;
  readonly addr: VideoAddr;
  readonly title: string;
  readonly publishedAt: bigint;
  /** sha256 of the hash list (NFX-05), 64 lowercase hex. */
  readonly root: string;
  readonly segs: bigint;
  readonly duration: bigint | undefined;
  readonly thumb: Thumb | undefined;
  /** Advisory per-chunk price (open mode only). */
  readonly priceHint: bigint | undefined;
  readonly license: License;
  readonly hashtags: readonly string[];
  readonly alt: string | undefined;
  /** Markdown description; never render HTML from it. */
  readonly description: string;
}

const bad = (reason: string): NfxResult<never> => fail('manifest', reason);

/** Run NFX-02 §4 on an untrusted event. Any failure rejects the whole event. */
export function parseManifest(raw: unknown): NfxResult<Verified<Manifest>> {
  const verified = verifyEvent(raw);
  if (!verified.ok) return verified;
  const event = verified.value;
  if (event.kind !== KIND_MANIFEST) return bad(`kind ${event.kind} is not ${KIND_MANIFEST}`);

  for (const name of SINGLE_VALUED) {
    const tag = singleTag(event, name);
    if (!tag.ok) return bad(tag.error.reason);
  }
  for (const name of REQUIRED) {
    const tag = required(event, name);
    if (!tag.ok) return tag;
  }
  // NFX-01 §3: exactly one `n`, and the `d` prefix must equal it.
  const namespace = Namespace.parse(requiredValue(event, 'n'));
  if (!namespace.ok) return namespace;
  const addr = VideoAddr.parse(requiredValue(event, 'd'));
  if (!addr.ok) return addr;
  if (!addr.value.namespace.equals(namespace.value)) {
    return bad('`d` namespace does not equal `n`');
  }

  const root = requiredValue(event, 'root');
  if (!isLowerHex(root, 64)) return bad('`root` is not 64 lowercase hex');
  const segs = integer(event, 'segs');
  if (!segs.ok) return segs;
  if ((segs.value ?? 0n) === 0n) return bad('`segs` must be >= 1');
  const publishedAt = integer(event, 'published_at');
  if (!publishedAt.ok) return publishedAt;
  const duration = integer(event, 'duration');
  if (!duration.ok) return duration;
  const priceHint = integer(event, 'price_hint');
  if (!priceHint.ok) return priceHint;
  const thumb = parseThumb(event);
  if (!thumb.ok) return thumb;

  let license: License;
  const mode = requiredValue(event, 'license');
  if (mode === 'open') {
    for (const name of LICENSED_ONLY) {
      if (tagValues(event, name).length > 0) {
        return bad(`\`${name}\` is prohibited in open mode`);
      }
    }
    license = { mode: 'open' };
  } else if (mode === 'licensed') {
    for (const name of LICENSED_REQUIRED) {
      const tag = required(event, name);
      if (!tag.ok) return tag;
    }
    if (priceHint.value !== undefined) return bad('`price_hint` is prohibited in licensed mode');
    const terms = licenseTerms(event);
    if (!terms.ok) return terms;
    license = { mode: 'licensed', terms: terms.value };
  } else {
    return bad(`unknown license ${JSON.stringify(mode)}`);
  }

  const alt = singleTag(event, 'alt');
  const manifest: Manifest = {
    author: event.pubkey,
    createdAt: event.created_at,
    addr: addr.value,
    title: requiredValue(event, 'title'),
    publishedAt: publishedAt.value ?? 0n,
    root,
    segs: segs.value ?? 0n,
    duration: duration.value,
    thumb: thumb.value,
    priceHint: priceHint.value,
    license,
    hashtags: tagValues(event, 't').flatMap((values) => values.slice(0, 1)),
    alt: alt.ok ? alt.value?.[0] : undefined,
    description: event.content,
  };
  return ok(manifest as Verified<Manifest>);
}

/** The NIP-01 address of a manifest, as beacons and deletions carry it in their `a` tag. */
export function manifestATag(manifest: Manifest): string {
  return `${KIND_MANIFEST}:${manifest.author}:${manifest.addr.toString()}`;
}

/**
 * The NFX-02 §3 tags, in the table's order: the publisher side of `parseManifest`. A
 * kind-38504 event with these tags and `description` as its content parses back to an equal
 * manifest (up to `author` and `createdAt`, which come from the signing).
 */
export function manifestTags(manifest: Manifest): string[][] {
  const tags: string[][] = [
    ['d', manifest.addr.toString()],
    ['n', manifest.addr.namespace.toString()],
    ['title', manifest.title],
    ['published_at', manifest.publishedAt.toString()],
    ['license', manifest.license.mode],
    ['root', manifest.root],
    ['segs', manifest.segs.toString()],
  ];
  if (manifest.duration !== undefined) tags.push(['duration', manifest.duration.toString()]);
  if (manifest.thumb !== undefined) {
    tags.push(['thumb', manifest.thumb.sha256, manifest.thumb.mime]);
  }
  if (manifest.priceHint !== undefined) tags.push(['price_hint', manifest.priceHint.toString()]);
  if (manifest.license.mode === 'licensed') {
    const terms = manifest.license.terms;
    tags.push(['key_price', terms.keyPrice.toString()]);
    tags.push(['split', terms.splitBps.toString()]);
    tags.push(['mint', terms.mint]);
    tags.push(['cashu_key', terms.cashuKey]);
    for (const seeder of terms.freeSeeders) tags.push(['free_seeder', seeder]);
  }
  for (const hashtag of manifest.hashtags) tags.push(['t', hashtag]);
  if (manifest.alt !== undefined) tags.push(['alt', manifest.alt]);
  return tags;
}

function required(event: NostrEvent, name: string): NfxResult<TagValues> {
  const tag = singleTag(event, name);
  if (!tag.ok) return bad(tag.error.reason);
  return tag.value === undefined ? bad(`missing \`${name}\` tag`) : ok(tag.value);
}

/** The first value of a tag `required` has already checked. */
function requiredValue(event: NostrEvent, name: string): string {
  const tag = required(event, name);
  return tag.ok ? tag.value[0] : '';
}

function integer(event: NostrEvent, name: string): NfxResult<bigint | undefined> {
  const tag = singleTag(event, name);
  if (!tag.ok) return bad(tag.error.reason);
  if (tag.value === undefined) return ok(undefined);
  const text = tag.value[0];
  const value = parseU64Strict(text);
  return value === undefined
    ? bad(`\`${name}\` is not an integer: ${JSON.stringify(text)}`)
    : ok(value);
}

function parseThumb(event: NostrEvent): NfxResult<Thumb | undefined> {
  const tag = singleTag(event, 'thumb');
  if (!tag.ok) return bad(tag.error.reason);
  if (tag.value === undefined) return ok(undefined);
  const [sha256, mime] = tag.value;
  if (!isLowerHex(sha256, 64) || mime === undefined || mime === '') {
    return bad('`thumb` must be 64 lowercase hex plus a MIME type');
  }
  return ok({ sha256, mime });
}

function licenseTerms(event: NostrEvent): NfxResult<LicenseTerms> {
  const keyPrice = integer(event, 'key_price');
  if (!keyPrice.ok) return keyPrice;
  const split = integer(event, 'split');
  if (!split.ok) return split;
  const splitBps = split.value ?? 0n;
  if (splitBps > 10_000n) return bad(`\`split\` ${splitBps.toString()} is outside [0,10000]`);
  const mint = requiredValue(event, 'mint');
  if (!isHttpsUrl(mint)) return bad('`mint` must be an https URL');
  const cashuKey = requiredValue(event, 'cashu_key');
  if (!isCompressedPoint(cashuKey)) {
    return bad('`cashu_key` is not a valid compressed secp256k1 point');
  }
  const freeSeeders: string[] = [];
  for (const values of tagValues(event, 'free_seeder')) {
    const seeder = values[0];
    if (seeder === undefined || !isLowerHex(seeder, 64)) {
      return bad('`free_seeder` must be 64 lowercase hex');
    }
    freeSeeders.push(seeder);
  }
  return ok({
    keyPrice: keyPrice.value ?? 0n,
    splitBps: Number(splitBps),
    mint,
    cashuKey,
    freeSeeders,
  });
}

/** 33 bytes in lowercase hex, prefix 02 or 03, and a point on the curve (cashu-ts → noble). */
function isCompressedPoint(hex: string): boolean {
  if (!isLowerHex(hex, 66) || !(hex.startsWith('02') || hex.startsWith('03'))) return false;
  try {
    pointFromHex(hex);
    return true;
  } catch {
    return false;
  }
}
