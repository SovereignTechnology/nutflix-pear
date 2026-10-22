/**
 * Small helpers that mirror nfx-proto's `hex32` module and the Rust string semantics the
 * parsers depend on. NFX writes every key, hash and signature as lowercase hex; uppercase or
 * mixed case is rejected, never normalized. Hashing is libsodium's (`sodium-universal`), as in
 * the worker; nothing here implements a hash.
 */
import { bytesToHex } from 'nostr-tools/utils';
import sodium from 'sodium-universal';

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
  const out = new Uint8Array(sodium.crypto_hash_sha256_BYTES);
  sodium.crypto_hash_sha256(out, bytes);
  return out;
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}
