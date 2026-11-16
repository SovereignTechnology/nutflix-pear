/**
 * The session key of NFX mesh signaling (NFX-10 §6.4, `nfx-mesh/1`): a fresh random secp256k1
 * key for one signaling session, held in secure memory, never stored and never a user's identity
 * key. It exists so WebRTC peers can address their offers and answers to each other; relays and
 * room members see it, and it links nothing beyond the session.
 *
 * It is no general signer. There is no way to make it sign an arbitrary event or message:
 * - it signs only the four `nfx-mesh/1` events it builds itself (kind 25050: `connect`,
 *   `disconnect`, `offer`, `answer`), with tags from `nfx/mesh-signal.ts`;
 * - it encrypts and decrypts NIP-44 v2 only as those events' content, and only an SDP goes in.
 *
 * Each event also carries the room proof (§6.3): a BIP-340 signature by the ROOM's key over the
 * proof id. That key is derived from the public stream swarm id (§6.1), so it is not a secret
 * this code guards; it is signed here because this directory is where signing lives.
 *
 * Nothing here logs. Signing, NIP-44 and key generation are nostr-tools', cashu-ts' and
 * libsodium's; no primitive is implemented here.
 */
import { schnorrSignMessage } from '@cashu/cashu-ts';
import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';

import type { NostrEvent } from '../contracts/index.js';
import {
  KIND_MESH_SIGNAL,
  MESH_MAX_CONTENT,
  isSdp,
  meshChallenge,
  meshDirectedTags,
  meshPresenceTags,
  meshProofPreimage,
  type MeshPresenceType,
  type MeshRoom,
} from '../nfx/mesh-signal.js';
import { isLowerHex, sha256Hex, utf8 } from '../nfx/util.js';
import { verifyIncoming } from '../nostr/event.js';
import { randomFill, secureAlloc, wipe, type SecureBuffer } from './secure.js';

function hexOf(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** A fresh random secret key in secure memory (retries the ~2^-128 invalid-scalar case). */
function generate(): { readonly sk: SecureBuffer; readonly pubkey: string } {
  for (;;) {
    const sk = secureAlloc(32);
    randomFill(sk);
    try {
      return { sk, pubkey: getPublicKey(sk) };
    } catch {
      wipe(sk);
    }
  }
}

export class MeshSessionKey {
  /** The session key's x-only public key, 64 lowercase hex: the events' `pubkey`. */
  readonly pubkey: string;
  /** The session id (`d`): 16 random bytes, 32 lowercase hex, fixed for the session. */
  readonly sessionId: string;
  private sk: SecureBuffer | null;

  private constructor(sk: SecureBuffer, pubkey: string, sessionId: string) {
    this.sk = sk;
    this.pubkey = pubkey;
    this.sessionId = sessionId;
  }

  /** A new session: a random key and a random session id. */
  static create(): MeshSessionKey {
    const { sk, pubkey } = generate();
    const id = new Uint8Array(16);
    randomFill(id);
    return new MeshSessionKey(sk, pubkey, hexOf(id));
  }

  /** A `connect` or `disconnect` in `room`, signed now (`now`: Unix seconds). */
  presence(type: MeshPresenceType, room: MeshRoom, now: number): NostrEvent {
    return this.sign(room, now, meshPresenceTags(type, room.key, this.sessionId, now), '');
  }

  /** An offer to session `to` in `room`: `sdp` encrypted to it (NIP-44 v2). */
  offer(room: MeshRoom, to: string, sdp: string, now: number): NostrEvent {
    const content = this.encrypt(to, sdp);
    return this.sign(room, now, meshDirectedTags(room.key, this.sessionId, to), content);
  }

  /** The answer to offer `offerId` from session `to`: `sdp` encrypted to it. */
  answer(room: MeshRoom, to: string, offerId: string, sdp: string, now: number): NostrEvent {
    if (!isLowerHex(offerId, 64)) throw new Error('invalid-argument: not an event id');
    const content = this.encrypt(to, sdp);
    return this.sign(room, now, meshDirectedTags(room.key, this.sessionId, to, offerId), content);
  }

  /**
   * The SDP in an offer's or answer's content from session `from`, or `undefined` if it does not
   * decrypt (NIP-44 v2 checks the MAC first) or is not an SDP.
   */
  decrypt(from: string, content: string): string | undefined {
    let ck: Uint8Array | undefined;
    try {
      if (!isLowerHex(from, 64) || typeof content !== 'string') return undefined;
      ck = nip44.getConversationKey(this.key(), from);
      const text = nip44.decrypt(content, ck);
      return isSdp(text) ? text : undefined;
    } catch {
      return undefined;
    } finally {
      wipe(ck);
    }
  }

  /** Wipe the key. Every later call throws. */
  destroy(): void {
    wipe(this.sk);
    this.sk = null;
  }

  private key(): SecureBuffer {
    if (this.sk === null) throw new Error('signer-locked: the mesh session has ended');
    return this.sk;
  }

  private encrypt(to: string, sdp: string): string {
    if (!isLowerHex(to, 64) || to === this.pubkey)
      throw new Error('invalid-argument: not a peer session key');
    if (typeof sdp !== 'string' || !isSdp(sdp))
      throw new Error('invalid-argument: only an SDP is sent');
    let ck: Uint8Array | undefined;
    try {
      ck = nip44.getConversationKey(this.key(), to);
      const content = nip44.encrypt(sdp, ck);
      if (utf8(content).length > MESH_MAX_CONTENT)
        throw new Error('invalid-argument: the SDP is too long to signal');
      return content;
    } finally {
      wipe(ck);
    }
  }

  /** Add the room proof, then sign as the session: the only signing path there is. */
  private sign(room: MeshRoom, now: number, tags: string[][], content: string): NostrEvent {
    const sk = this.key();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid-argument: not a time');
    const preimage = meshProofPreimage(room.key, now, this.pubkey, meshChallenge(tags, content));
    // cashu-ts signs SHA-256(message), which is the proof id (§6.3).
    const sig = schnorrSignMessage(preimage, room.secret);
    const signed = finalizeEvent(
      {
        kind: KIND_MESH_SIGNAL,
        created_at: now,
        tags: [...tags, ['roomproof', sha256Hex(utf8(preimage)), sig]],
        content,
      },
      sk,
    );
    const event = verifyIncoming(signed);
    if (event === null) throw new Error('signer: the signed event did not verify');
    return event;
  }
}
