/**
 * Small helpers that mirror nfx-proto's `hex32` module and the Rust string semantics the
 * parsers depend on. NFX writes every key, hash and signature as lowercase hex; uppercase or
 * mixed case is rejected, never normalized. SHA-256 is `@noble/hashes`' (the library nostr-tools
 * is built on), so `@sovit/core/nfx` runs in a page without sodium (ADR 0022); its digests are
 * libsodium's byte for byte (`__tests__/crypto-parity.test.ts`). Nothing here implements a hash.
 */
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from 'nostr-tools/utils';

export const U64_MAX = 0xffff_ffff_ffff_ffffn;

const LOWER_HEX = /^[0-9a-f]*$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;

export function isLowerHex(s: string, len: number): boolean {
  return s.length === len && LOWER_HEX.test(s);
}

/**
 * ASCII-decimal unsigned integer: no sign, no leading zeros (except `"0"`), at most 20 digits
 * and ≤ 2^64 − 1 (NFX-02 §3). A `bigint`, so every value the Rust accepts is kept exactly.
 */
export function parseU64Strict(s: string): bigint | undefined {
  if (!DECIMAL.test(s)) return undefined;
  const value = BigInt(s);
  return value <= U64_MAX ? value : undefined;
}

/** Rust's `char::is_whitespace` (the Unicode White_Space property), for a UTF-16 code unit. */
export function isRustWhitespace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) ||
    c === 0x20 ||
    c === 0x85 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

/** Rust's `char::is_control` (general category Cc). */
function isRustControl(c: number): boolean {
  return c <= 0x1f || (c >= 0x7f && c <= 0x9f);
}

/**
 * Rust's `str::trim`. Not `String.prototype.trim`, which also strips U+FEFF: a line holding
 * only a BOM is blank to JavaScript and not to the reference.
 */
export function rustTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isRustWhitespace(s.charCodeAt(start))) start++;
  while (end > start && isRustWhitespace(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}

/**
 * An `https://` URL with a non-empty host, no userinfo, and no whitespace or control
 * characters. Deliberately minimal: NFX only needs to refuse other schemes, empty hosts, and
 * `https://trusted.example@other.example`-style lookalikes.
 */
export function isHttpsUrl(s: string): boolean {
  if (!s.startsWith('https://')) return false;
  const authority = s.slice('https://'.length).split(/[/?#]/, 1)[0] ?? '';
  if (authority === '' || authority.includes('@')) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isRustWhitespace(c) || isRustControl(c)) return false;
  }
  return true;
}

/** No lone surrogates: the string has a UTF-8 encoding (`String.prototype.isWellFormed`). */
export function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Order two strings by Unicode code point, which is Rust's `String` order (UTF-8 byte order).
 * JavaScript's `<` compares UTF-16 code units and puts U+1F600 before U+FF61.
 */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) ?? 0;
    const y = b.codePointAt(j) ?? 0;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  if (i === a.length) return j === b.length ? 0 : -1;
  return 1;
}

const IPV4 = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/;
const IPV6_GROUP = /^(?:0|[1-9a-f][0-9a-f]{0,3})$/;

/** The eight groups of an IPv6 address written with hex groups only, or `undefined`. */
function ipv6Groups(text: string): number[] | undefined {
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const side = (h: string | undefined): string[] | undefined => {
    if (h === undefined || h === '') return [];
    const groups = h.split(':');
    return groups.every((g) => IPV6_GROUP.test(g)) ? groups : undefined;
  };
  const head = side(halves[0]);
  const tail = side(halves[1]);
  if (head === undefined || tail === undefined) return undefined;
  const given = head.length + tail.length;
  if (halves.length === 1 ? given !== 8 : given > 7) return undefined;
  const zeros = new Array<string>(8 - given).fill('0');
  return [...head, ...zeros, ...tail].map((g) => parseInt(g, 16));
}

/** RFC 5952 text of eight groups: lowercase, the first longest run of two or more zeros as `::`. */
function ipv6Text(groups: readonly number[]): string {
  let bestAt = -1;
  let bestLen = 1;
  for (let i = 0; i < 8;) {
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestAt = i;
      bestLen = j - i;
    }
    i = j === i ? i + 1 : j;
  }
  const hex = (g: number): string => g.toString(16);
  if (bestAt < 0) return groups.map(hex).join(':');
  const head = groups.slice(0, bestAt).map(hex).join(':');
  const tail = groups
    .slice(bestAt + bestLen)
    .map(hex)
    .join(':');
  return `${head}::${tail}`;
}

/**
 * `ip:port` in canonical text form (NFX-10 §1): a dotted IPv4 address with no leading zeros, or
 * a bracketed RFC 5952 IPv6 address (lowercase, the longest zero run compressed, no zone), never
 * an IPv4 address written inside IPv6 (the dotted forms, and `::ffff:0:0/96` and `::/96` however
 * they are spelled, so `::` and `::1` too); a port from 1 to 65535 with no leading zeros. Names and
 * URLs are refused. At most 64 characters are looked at.
 */
export function isCanonicalSocketAddr(s: string): boolean {
  // `[ffff:…:ffff]:65535` is 47 characters.
  if (s.length > 64) return false;
  const colon = s.lastIndexOf(':');
  if (colon < 1) return false;
  const port = s.slice(colon + 1);
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) return false;
  const host = s.slice(0, colon);
  if (host.startsWith('[') && host.endsWith(']')) {
    const text = host.slice(1, -1);
    const groups = ipv6Groups(text);
    if (groups === undefined || ipv6Text(groups) !== text) return false;
    // `::ffff:0:0/96` (IPv4-mapped) and `::/96` (IPv4-compatible, with `::` and `::1`): an IPv4
    // address inside IPv6 however it is spelled, and no address a STUN server answers at.
    const head = groups.slice(0, 5).every((g) => g === 0);
    return !(head && (groups[5] === 0xffff || groups[5] === 0));
  }
  const m = IPV4.exec(host);
  if (m === null) return false;
  return m.slice(1).every((o) => Number(o) <= 255);
}

const encoder = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Strict UTF-8: refuses invalid bytes instead of substituting U+FFFD, and keeps a BOM. */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function sha256(bytes: Uint8Array): Uint8Array {
  return nobleSha256(bytes);
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}
