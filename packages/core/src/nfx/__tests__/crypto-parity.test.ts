/**
 * ADR 0022: `@sovit/core/nfx` hashes with `@noble/hashes` and checks NFX-12 `bind` signatures with
 * `@noble/curves`, so a page needs no sodium. The desktop app used libsodium for both until then.
 * These tests hold the noble versions to libsodium's answers (sodium-native, through
 * sodium-universal under Node), on honest inputs and on every kind of bad one: the same digest,
 * and the same accept or refuse, with the one difference `verifyHyperdhtBind` documents (a public
 * key with a small-order part: refused here, sometimes accepted by libsodium).
 *
 * The edge cases are built with noble's own point and scalar arithmetic, in this test only.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/utils.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import sodium from 'sodium-universal';
import { describe, expect, it } from 'vitest';

import { hyperdhtBindMessage, verifyHyperdhtBind } from '../beacon.js';
import { sha256, sha256Hex } from '../util.js';

const Point = ed25519.Point;
const L = Point.Fn.ORDER;
const SEEDER = 'a'.repeat(64);
const NS = 'nfx:testnet:1';
const MSG = new TextEncoder().encode(hyperdhtBindMessage(SEEDER, NS));

/** A seeded byte stream, so a failure names a case that can be replayed. */
function bytesFrom(seed: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

function libsodiumHash(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(sodium.crypto_hash_sha256_BYTES);
  sodium.crypto_hash_sha256(out, bytes);
  return out;
}

interface Keys {
  readonly pk: Uint8Array;
  readonly sk: Uint8Array;
  /** The secret scalar, mod L (noble's view of the same seed). */
  readonly a: bigint;
}

function keysFrom(seed: Uint8Array): Keys {
  const pk = new Uint8Array(sodium.crypto_sign_PUBLICKEYBYTES);
  const sk = new Uint8Array(sodium.crypto_sign_SECRETKEYBYTES);
  sodium.crypto_sign_seed_keypair(pk, sk, seed);
  const ext = ed25519.utils.getExtendedPublicKey(seed);
  if (bytesToHex(ext.pointBytes) !== bytesToHex(pk))
    throw new Error('noble and libsodium keys differ');
  return { pk, sk, a: ext.scalar };
}

function libsodiumSign(k: Keys, msg: Uint8Array): Uint8Array {
  const sig = new Uint8Array(sodium.crypto_sign_BYTES);
  sodium.crypto_sign_detached(sig, msg, k.sk);
  return sig;
}

function libsodiumVerify(sig: Uint8Array, msg: Uint8Array, pk: Uint8Array): boolean {
  try {
    return sodium.crypto_sign_verify_detached(sig, msg, pk);
  } catch {
    return false;
  }
}

function ours(sig: Uint8Array, pk: Uint8Array): boolean {
  return verifyHyperdhtBind(bytesToHex(pk), bytesToHex(sig), SEEDER, NS);
}

/** The challenge `H(R || A || M) mod L`, as both libraries compute it. */
function challenge(R: Uint8Array, A: Uint8Array, msg: Uint8Array): bigint {
  return bytesToNumberLE(sha512(new Uint8Array([...R, ...A, ...msg]))) % L;
}

function sigOf(R: Uint8Array, S: bigint): Uint8Array {
  return new Uint8Array([...R, ...numberToBytesLE(S, 32)]);
}

/** An order-8 point: libsodium's own small-order list names its encoding. */
const T8 = Point.fromBytes(
  hexToBytes('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05'),
);
/** All 8 points of small order. */
const SMALL = Array.from({ length: 8 }, (_, k) => (k === 0 ? Point.ZERO : T8.multiply(BigInt(k))));

describe('SHA-256 (@noble/hashes) against libsodium', () => {
  it('gives libsodium’s digest for inputs of every length up to 300 bytes, and for 1 MiB', () => {
    for (let n = 0; n <= 300; n++) {
      const data = bytesFrom(n + 7, n);
      expect(bytesToHex(sha256(data)), `length ${String(n)}`).toBe(bytesToHex(libsodiumHash(data)));
    }
    const big = bytesFrom(99, 1 << 20);
    expect(sha256Hex(big)).toBe(bytesToHex(libsodiumHash(big)));
  });

  it('returns 32 bytes, and the empty digest is the published one', () => {
    expect(sha256(new Uint8Array(0)).length).toBe(32);
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('verifyHyperdhtBind (@noble/curves) against libsodium', () => {
  const keys = Array.from({ length: 12 }, (_, i) => keysFrom(bytesFrom(1000 + i, 32)));

  it('accepts what libsodium signs, and only for that seeder and network', () => {
    for (const k of keys) {
      const sig = libsodiumSign(k, MSG);
      expect(libsodiumVerify(sig, MSG, k.pk)).toBe(true);
      expect(ours(sig, k.pk)).toBe(true);
      expect(verifyHyperdhtBind(bytesToHex(k.pk), bytesToHex(sig), SEEDER, 'nfx:mainnet:1')).toBe(
        false,
      );
      expect(verifyHyperdhtBind(bytesToHex(k.pk), bytesToHex(sig), 'b'.repeat(64), NS)).toBe(false);
    }
  });

  it('answers as libsodium for every single-bit flip of the signature and of the key', () => {
    for (const k of keys.slice(0, 2)) {
      const sig = libsodiumSign(k, MSG);
      for (let bit = 0; bit < 512; bit++) {
        const bad = sig.slice();
        bad[bit >> 3] = (bad[bit >> 3] ?? 0) ^ (1 << (bit & 7));
        expect(ours(bad, k.pk), `signature bit ${String(bit)}`).toBe(
          libsodiumVerify(bad, MSG, k.pk),
        );
      }
      for (let bit = 0; bit < 256; bit++) {
        const bad = k.pk.slice();
        bad[bit >> 3] = (bad[bit >> 3] ?? 0) ^ (1 << (bit & 7));
        expect(ours(sig, bad), `key bit ${String(bit)}`).toBe(libsodiumVerify(sig, MSG, bad));
      }
    }
  });

  it('refuses S at or past L (a malleable twin), as libsodium does', () => {
    for (const k of keys) {
      const sig = libsodiumSign(k, MSG);
      const S = bytesToNumberLE(sig.subarray(32));
      for (const twin of [S + L, L, L + 1n, (1n << 256n) - 1n]) {
        if (twin >= 1n << 256n) continue;
        const bad = sigOf(sig.subarray(0, 32), twin);
        expect(libsodiumVerify(bad, MSG, k.pk)).toBe(false);
        expect(ours(bad, k.pk)).toBe(false);
      }
    }
  });

  it('refuses every small-order key and every non-canonical key encoding, as libsodium does', () => {
    const sig = libsodiumSign(keys[0]!, MSG);
    const p = (1n << 255n) - 19n;
    const encodings = [
      ...SMALL.map((P) => P.toBytes()),
      // The same points with the sign bit flipped, and y = p, p + 1 (0 and 1, not reduced).
      ...SMALL.map((P) => {
        const b = P.toBytes();
        b[31] = (b[31] ?? 0) ^ 0x80;
        return b;
      }),
      numberToBytesLE(p, 32),
      numberToBytesLE(p + 1n, 32),
      numberToBytesLE(p + 2n, 32),
      numberToBytesLE((1n << 255n) - 1n, 32),
      new Uint8Array(32).fill(0xff),
    ];
    for (const pk of encodings) {
      expect(libsodiumVerify(sig, MSG, pk), bytesToHex(pk)).toBe(false);
      expect(ours(sig, pk), bytesToHex(pk)).toBe(false);
    }
  });

  it('refuses an R of small order that the cofactored equation would accept, as libsodium does', () => {
    for (const k of keys.slice(0, 4)) {
      for (const T of SMALL) {
        // S = h·a with R a small-order point: [8]SB = [8]R + [8]hA holds, SB - hA = R does not.
        const R = T.toBytes();
        const S = (challenge(R, k.pk, MSG) * k.a) % L;
        const sig = sigOf(R, S);
        expect(ed25519.verify(sig, MSG, k.pk, { zip215: false })).toBe(true);
        expect(libsodiumVerify(sig, MSG, k.pk)).toBe(false);
        expect(ours(sig, k.pk)).toBe(false);
      }
    }
  });

  it('refuses an R with a small-order part, as libsodium does', () => {
    for (const k of keys.slice(0, 4)) {
      const r = bytesToNumberLE(bytesFrom(7, 32)) % L;
      for (const T of SMALL.slice(1)) {
        const R = Point.BASE.multiply(r).add(T).toBytes();
        const S = (r + challenge(R, k.pk, MSG) * k.a) % L;
        const sig = sigOf(R, S);
        expect(ed25519.verify(sig, MSG, k.pk, { zip215: false })).toBe(true);
        expect(libsodiumVerify(sig, MSG, k.pk)).toBe(false);
        expect(ours(sig, k.pk)).toBe(false);
      }
    }
  });

  it('refuses a key with a small-order part, which is where it may differ from libsodium', () => {
    // A' = aB + T. With R = rB and S = r + h·a, SB - hA' = R - hT: libsodium accepts exactly when
    // hT is the identity, i.e. 8 divides h. No key pair generator makes such a key; this refuses
    // every signature by one.
    let sodiumAccepted = 0;
    for (let i = 0; i < 64; i++) {
      const k = keys[i % keys.length]!;
      const A = Point.BASE.multiply(k.a).add(T8).toBytes();
      const r = (bytesToNumberLE(bytesFrom(5000 + i, 32)) % (L - 1n)) + 1n;
      const R = Point.BASE.multiply(r).toBytes();
      const h = challenge(R, A, MSG);
      const sig = sigOf(R, (r + h * k.a) % L);
      const lib = libsodiumVerify(sig, MSG, A);
      expect(lib, `case ${String(i)}`).toBe(h % 8n === 0n);
      if (lib) sodiumAccepted += 1;
      expect(ours(sig, A), `case ${String(i)}`).toBe(false);
    }
    // h changes from case to case, and about one in eight is a multiple of 8.
    expect(sodiumAccepted).toBeGreaterThan(0);
  });

  it('refuses what is not 64 + 128 lowercase hex before any curve work', () => {
    const k = keys[0]!;
    const sig = bytesToHex(libsodiumSign(k, MSG));
    const pk = bytesToHex(k.pk);
    expect(verifyHyperdhtBind(pk.toUpperCase(), sig, SEEDER, NS)).toBe(false);
    expect(verifyHyperdhtBind(pk, sig.toUpperCase(), SEEDER, NS)).toBe(false);
    expect(verifyHyperdhtBind(pk.slice(2), sig, SEEDER, NS)).toBe(false);
    expect(verifyHyperdhtBind(pk, `${sig}00`, SEEDER, NS)).toBe(false);
  });
});
