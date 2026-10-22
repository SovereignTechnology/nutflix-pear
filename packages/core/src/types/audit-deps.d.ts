/**
 * Ambient types for the untyped Holepunch modules the audit surface uses (Stage 2). Only the
 * members this package calls are declared, checked against the installed sources:
 * `sodium-universal@5.0.1` → `sodium-native@5.1.0` (`node_modules/sodium-native/index.js`),
 * `compact-encoding@3.4.0` (`node_modules/compact-encoding/index.js`, docs/vendor/compact-encoding.md).
 */

declare module 'sodium-universal' {
  interface SodiumUniversal {
    sodium_malloc(size: number): Uint8Array;
    sodium_memzero(buf: Uint8Array): void;
    /** Constant-time equality of two equal-length buffers. */
    sodium_memcmp(a: Uint8Array, b: Uint8Array): boolean;
    randombytes_buf(buf: Uint8Array): void;

    // NFX (`src/nfx/`): content hashes and the NFX-12 `bind` signature, RFC 8032 Ed25519.
    readonly crypto_hash_sha256_BYTES: number;
    crypto_hash_sha256(out: Uint8Array, input: Uint8Array): void;
    readonly crypto_sign_BYTES: number;
    readonly crypto_sign_PUBLICKEYBYTES: number;
    readonly crypto_sign_SECRETKEYBYTES: number;
    readonly crypto_sign_SEEDBYTES: number;
    crypto_sign_verify_detached(sig: Uint8Array, m: Uint8Array, pk: Uint8Array): boolean;
    /** Tests only: the vectors' throwaway peer key, from its seed. */
    crypto_sign_seed_keypair(pk: Uint8Array, sk: Uint8Array, seed: Uint8Array): void;
    /** Tests only: reproduces the vectors' `bind` (Ed25519 is deterministic). */
    crypto_sign_detached(sig: Uint8Array, m: Uint8Array, sk: Uint8Array): void;

    readonly crypto_pwhash_ALG_ARGON2ID13: number;
    readonly crypto_pwhash_SALTBYTES: number;
    readonly crypto_pwhash_OPSLIMIT_INTERACTIVE: number;
    readonly crypto_pwhash_MEMLIMIT_INTERACTIVE: number;
    readonly crypto_pwhash_OPSLIMIT_MODERATE: number;
    readonly crypto_pwhash_MEMLIMIT_MODERATE: number;
    readonly crypto_pwhash_OPSLIMIT_MAX: number;
    readonly crypto_pwhash_MEMLIMIT_MAX: number;
    /** Undefined under sodium-javascript (browser): the local signer refuses to run there. */
    readonly crypto_pwhash_async?: (
      out: Uint8Array,
      passwd: Uint8Array,
      salt: Uint8Array,
      opslimit: number,
      memlimit: number,
      alg: number,
      cb: (err: Error | null) => void,
    ) => void;

    readonly crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
    readonly crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
    readonly crypto_aead_xchacha20poly1305_ietf_ABYTES: number;
    readonly crypto_aead_xchacha20poly1305_ietf_encrypt?: (
      c: Uint8Array,
      m: Uint8Array,
      ad: Uint8Array | null,
      nsec: null,
      npub: Uint8Array,
      k: Uint8Array,
    ) => number;
    /** Throws on authentication failure. */
    readonly crypto_aead_xchacha20poly1305_ietf_decrypt?: (
      m: Uint8Array,
      nsec: null,
      c: Uint8Array,
      ad: Uint8Array | null,
      npub: Uint8Array,
      k: Uint8Array,
    ) => number;
  }
  const sodium: SodiumUniversal;
  export default sodium;
}

declare module 'compact-encoding' {
  interface State {
    start: number;
    end: number;
    buffer: Uint8Array | null;
  }
  interface Encoding<T> {
    preencode(state: State, value: T): void;
    encode(state: State, value: T): void;
    decode(state: State): T;
  }
  const c: {
    state(start?: number, end?: number, buffer?: Uint8Array | null): State;
    readonly uint: Encoding<number>;
    readonly uint8: Encoding<number>;
    readonly string: Encoding<string>;
    readonly fixed32: Encoding<Uint8Array>;
    readonly raw: Encoding<Uint8Array>;
    encode<T>(enc: Encoding<T>, value: T): Uint8Array;
    decode<T>(enc: Encoding<T>, buffer: Uint8Array): T;
  };
  export type { Encoding, State };
  export default c;
}
