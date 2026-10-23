/**
 * Ambient types for `sodium-universal@5.0.1` (→ `sodium-native@5.1.0` on Node and Bare), only
 * the members the seeder calls: the NFX-12 `bind` signature (`src/nfx/bind.ts`), RFC 8032
 * Ed25519 over a HyperDHT key pair's libsodium-format secret key.
 */
declare module 'sodium-universal' {
  interface SodiumUniversal {
    readonly crypto_sign_BYTES: number;
    readonly crypto_sign_PUBLICKEYBYTES: number;
    readonly crypto_sign_SECRETKEYBYTES: number;
    crypto_sign_detached(sig: Uint8Array, m: Uint8Array, sk: Uint8Array): void;
  }
  const sodium: SodiumUniversal;
  export default sodium;
}
