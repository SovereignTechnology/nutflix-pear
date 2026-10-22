/**
 * The NFX-12 §2 beacon endpoint `{t:"hyperdht", peer, bind}`: `bind` is the peer key's
 * Ed25519 signature over `"nfx/hyperdht/1:" + seeder + ":" + namespace`, so a beacon can only
 * name a peer key whose holder agreed to be advertised by that nostr key on that network. It
 * depends on neither the video nor the time: a seeder signs it once per network. The message
 * and the verifier are the codec's (`@sovit/core` `nfx`); only the signing lives here, beside
 * the key pair the transport listens on.
 */
import { nfx } from '@sovit/core';
import sodium from 'sodium-universal';

import { bytesEqual, toHex } from '../util/hex.js';

/** A HyperDHT (Noise) key pair: libsodium Ed25519, the secret key's last 32 bytes are the public key. */
export interface PeerKeyPair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

export interface HyperdhtEndpoint {
  readonly t: 'hyperdht';
  readonly peer: string;
  readonly bind: string;
}

/**
 * `bind` (128 lowercase hex) for `keyPair` advertised by `seeder` (64 lowercase hex nostr key)
 * on `namespace` (NFX-01). Throws on a malformed argument: these are the caller's own values.
 */
export function hyperdhtBind(keyPair: PeerKeyPair, seeder: string, namespace: string): string {
  checkKeyPair(keyPair);
  if (!/^[0-9a-f]{64}$/.test(seeder)) {
    throw new Error('invalid-argument: seeder is not 64 lowercase hex');
  }
  const ns = nfx.Namespace.parse(namespace);
  if (!ns.ok || ns.value.toString() !== namespace) {
    throw new Error('invalid-argument: namespace is not an NFX-01 namespace');
  }
  const sig = new Uint8Array(sodium.crypto_sign_BYTES);
  const message = new TextEncoder().encode(nfx.hyperdhtBindMessage(seeder, namespace));
  sodium.crypto_sign_detached(sig, message, keyPair.secretKey);
  return toHex(sig);
}

/** The endpoint object for beacon content (NFX-03 §4), in the codec's field order. */
export function hyperdhtEndpoint(
  keyPair: PeerKeyPair,
  seeder: string,
  namespace: string,
): HyperdhtEndpoint {
  return {
    t: 'hyperdht',
    peer: toHex(keyPair.publicKey),
    bind: hyperdhtBind(keyPair, seeder, namespace),
  };
}

function checkKeyPair(keyPair: PeerKeyPair): void {
  const { publicKey, secretKey } = keyPair;
  if (
    publicKey.byteLength !== sodium.crypto_sign_PUBLICKEYBYTES ||
    secretKey.byteLength !== sodium.crypto_sign_SECRETKEYBYTES ||
    !bytesEqual(secretKey.subarray(32), publicKey)
  ) {
    throw new Error('invalid-argument: not an Ed25519 key pair');
  }
}
