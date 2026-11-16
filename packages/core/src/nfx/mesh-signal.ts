/**
 * Signaling over Nostr for the NFX mesh (NFX-10 §6, `nfx-mesh/1`): how WebRTC peers of one
 * stream swarm find each other and exchange their SDP offers and answers through ordinary Nostr
 * relays, with no tracker. Written from the spec and pinned by its vectors
 * (`docs/vendor/nfx-test-vectors/mesh-signal*.json`).
 *
 * Every event is kind 25050 (ephemeral) with `i` = `nfx-mesh/1`: `connect` / `disconnect`
 * presence in a room, and `offer` / `answer` whose content is the NIP-44 v2 ciphertext of a
 * complete SDP, between per-session keys. Each carries a room proof: a BIP-340 signature by the
 * room's key, which anyone who knows the stream swarm id can derive (§6.1: it is not access
 * control, it keeps blind spam out).
 *
 * As everything in `@sovit/core/nfx`: pure, with the clock passed in, and nothing here signs or
 * holds a key. The tags and the room-proof preimage are built here; the session key that signs
 * and decrypts is `signer/mesh-key.ts`. `readMeshEvent` takes decryption as a function.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

import { verifyEvent } from './event.js';
import { isLowerHex, sha256, sha256Hex, utf8 } from './util.js';

/** The ephemeral kind NIP-DC's draft and this profile share (NFX-11 §1). */
export const KIND_MESH_SIGNAL = 25050;
/** The protocol identifier (`i`) and the application (`y`) of every event (§6.2). */
export const MESH_PROTOCOL = 'nfx-mesh/1';
export const MESH_APP = 'nfx';
/** Freshness (§6.5): `created_at` from `now - 60` to `now + 30`. */
export const MESH_MAX_AGE = 60;
export const MESH_MAX_FUTURE = 30;
/** A `connect` lives `expiration - created_at`, at most 90 s; senders use 90 (§6.2). */
export const MESH_PRESENCE_TTL = 90;
/** The most bytes of an offer's or answer's content (§6.2). */
export const MESH_MAX_CONTENT = 32768;

export type MeshPresenceType = 'connect' | 'disconnect';
export type MeshDirectedType = 'offer' | 'answer';
export type MeshSignalType = MeshPresenceType | MeshDirectedType;

/** One stream swarm's room (§6.1). The secret is derivable by anyone who knows the swarm id. */
export interface MeshRoom {
  readonly swarm: string;
  /** `P`: the room's BIP-340 x-only public key, 64 lowercase hex. */
  readonly key: string;
  readonly secret: Uint8Array;
}

const ROOM_DOMAIN = utf8('nfx/1/web/room');

/** `h_0 = sha256("nfx/1/web/room" || 0x00 || stream swarm id)` (§6.1). */
export function meshRoomSeed(swarm: string): Uint8Array {
  const id = utf8(swarm);
  const input = new Uint8Array(ROOM_DOMAIN.length + 1 + id.length);
  input.set(ROOM_DOMAIN, 0);
  input.set(id, ROOM_DOMAIN.length + 1);
  return sha256(input);
}

/** The x-only public key of `h` if it is a secp256k1 secret key (`0 < h < n`), else `undefined`. */
export function meshRoomKeyOf(h: Uint8Array): string | undefined {
  try {
    return bytesToHex(schnorr.getPublicKey(h));
  } catch {
    return undefined;
  }
}

/** The room of stream swarm `swarm`: the first `h_i` that is a secret key, and its public key. */
export function meshRoom(swarm: string): MeshRoom {
  let h = meshRoomSeed(swarm);
  for (;;) {
    const key = meshRoomKeyOf(h);
    if (key !== undefined) return { swarm, key, secret: h };
    h = sha256(h);
  }
}

/** The first value of the first tag called `name`, or `""` (§6.3's "or `""` if absent"). */
function first(tags: readonly (readonly string[])[], name: string): string {
  return tags.find((t) => t[0] === name)?.[1] ?? '';
}

/**
 * The room-proof challenge of an event with these tags and content (§6.3), by its `t`: presence
 * binds every presence tag, a directed event its receiver and ciphertext.
 */
export function meshChallenge(tags: readonly (readonly string[])[], content: string): string {
  const t = first(tags, 't');
  if (t === 'offer' || t === 'answer') return JSON.stringify([first(tags, 'p'), content]);
  return JSON.stringify([
    'nip-dc-presence-v1',
    t,
    first(tags, 'P'),
    first(tags, 'd'),
    first(tags, 'i'),
    first(tags, 'y'),
    first(tags, 'version'),
    first(tags, 'expiration'),
    content,
  ]);
}

/**
 * What the room key signs (§6.3): `JSON([0, P, created_at, 25050, pubkey, challenge, ""])`, in
 * NIP-01's serialization. The proof's `id` is its sha256.
 */
export function meshProofPreimage(
  room: string,
  createdAt: number,
  pubkey: string,
  challenge: string,
): string {
  return JSON.stringify([0, room, createdAt, KIND_MESH_SIGNAL, pubkey, challenge, '']);
}

/** The tags of a presence event, in §6.2's order, without its room proof. */
export function meshPresenceTags(
  type: MeshPresenceType,
  room: string,
  sessionId: string,
  createdAt: number,
): string[][] {
  const tags = [
    ['t', type],
    ['P', room],
    ['d', sessionId],
    ['i', MESH_PROTOCOL],
    ['y', MESH_APP],
  ];
  if (type === 'connect') tags.push(['expiration', String(createdAt + MESH_PRESENCE_TTL)]);
  return tags;
}

/** The tags of an offer to `to`, or of the answer to offer `offerId`, without the room proof. */
export function meshDirectedTags(
  room: string,
  sessionId: string,
  to: string,
  offerId?: string,
): string[][] {
  const tags = [
    ['t', offerId === undefined ? 'offer' : 'answer'],
    ['P', room],
    ['d', sessionId],
    ['i', MESH_PROTOCOL],
    ['y', MESH_APP],
    ['p', to],
  ];
  if (offerId !== undefined) tags.push(['e', offerId]);
  return tags;
}

/** Whether `text` is an SDP as §6.2 means it: its first line is `v=0`. */
export function isSdp(text: string): boolean {
  return text.startsWith('v=0\r\n') || text.startsWith('v=0\n');
}

interface Common {
  /** The event id: what a reader remembers, and what an answer's `e` names. */
  readonly id: string;
  /** The sender's session key. */
  readonly from: string;
  readonly sessionId: string;
  readonly createdAt: number;
}

/** What `readMeshEvent` made of an event. */
export type MeshRead =
  /** Not this profile's, or not addressed to this session: no error, nothing remembered. */
  | { readonly kind: 'ignored'; readonly why: string }
  /** Ours by its tags, and invalid. */
  | { readonly kind: 'dropped'; readonly why: string }
  | (Common & { readonly kind: 'connect'; readonly expiration: number })
  | (Common & { readonly kind: 'disconnect' })
  | (Common & { readonly kind: 'offer'; readonly sdp: string })
  | (Common & { readonly kind: 'answer'; readonly offerId: string; readonly sdp: string });

export interface MeshReader {
  /** The room subscribed to: its key `P`. */
  readonly room: string;
  /** Unix seconds. */
  readonly now: number;
  /** This session's key: directed events to another are ignored, its own events too. */
  readonly self: string;
  /** NIP-44 v2 from `from` to this session; `undefined` if it does not decrypt (MAC first). */
  readonly decrypt: (from: string, content: string) => string | undefined;
}

const ignored = (why: string): MeshRead => ({ kind: 'ignored', why });
const dropped = (why: string): MeshRead => ({ kind: 'dropped', why });

const DECIMAL = /^(?:0|[1-9][0-9]{0,15})$/;
const TYPES: readonly string[] = ['connect', 'disconnect', 'offer', 'answer'];

/**
 * Read one relay event for `room` (§6.5), in the spec's order: what is not this profile's is
 * ignored before any cryptography, a malformed or stale event is dropped, a directed event for
 * another session is ignored before its signature is looked at, and only then come the NIP-01
 * check, the room proof and the decryption.
 */
export function readMeshEvent(raw: unknown, o: MeshReader): MeshRead {
  if (typeof raw !== 'object' || raw === null) return dropped('not an event');
  const e = raw as Readonly<Record<string, unknown>>;
  const { kind, pubkey, content, tags: rawTags } = e;
  const createdAt = e['created_at'];
  if (
    kind !== KIND_MESH_SIGNAL ||
    typeof pubkey !== 'string' ||
    !isLowerHex(pubkey, 64) ||
    typeof content !== 'string' ||
    typeof createdAt !== 'number' ||
    !Number.isSafeInteger(createdAt) ||
    !Array.isArray(rawTags) ||
    !rawTags.every(
      (t): t is string[] =>
        Array.isArray(t) && t.length > 0 && t.every((v) => typeof v === 'string'),
    )
  )
    return dropped('not a kind-25050 event');
  const tags: readonly (readonly string[])[] = rawTags;
  const all = (name: string): (readonly string[])[] => tags.filter((t) => t[0] === name);
  /** The value of the one tag called `name`; `null` when absent, `undefined` when not exactly one. */
  const one = (name: string): string | null | undefined => {
    const found = all(name);
    if (found.length === 0) return null;
    return found.length === 1 ? found[0]?.[1] : undefined;
  };

  // 1. Not ours: other applications use this kind.
  const i = all('i');
  if (i.length !== 1 || i[0]?.[1] !== MESH_PROTOCOL) return ignored('another protocol');
  const t = one('t');
  if (typeof t !== 'string' || !TYPES.includes(t)) return ignored('another event type');
  const type = t as MeshSignalType;
  if (pubkey === o.self) return ignored('our own event');

  // 2. The tags of its type.
  if (one('P') !== o.room) return dropped('P is not the room');
  if (one('y') !== MESH_APP) return dropped('y is not nfx');
  const sessionId = one('d');
  if (typeof sessionId !== 'string' || !isLowerHex(sessionId, 32))
    return dropped('d is not 32 lowercase hex');
  const proofs = all('roomproof');
  const proof = proofs[0];
  if (
    proofs.length !== 1 ||
    proof?.length !== 3 ||
    !isLowerHex(proof[1] ?? '', 64) ||
    !isLowerHex(proof[2] ?? '', 128)
  )
    return dropped('no room proof');
  const directed = type === 'offer' || type === 'answer';
  const p = one('p');
  const offerId = one('e');
  const expiration = one('expiration');
  if (directed) {
    if (typeof p !== 'string' || !isLowerHex(p, 64)) return dropped('p is not one key');
    if (expiration !== null) return dropped('expiration on a directed event');
    if (type === 'answer') {
      if (typeof offerId !== 'string' || !isLowerHex(offerId, 64))
        return dropped('an answer names one offer');
    } else if (offerId !== null) return dropped('e on an offer');
    if (content === '' || utf8(content).length > MESH_MAX_CONTENT || content.startsWith('#'))
      return dropped('content is not NIP-44 v2 within the limit');
  } else {
    if (p !== null) return dropped('p on presence');
    if (offerId !== null) return dropped('e on presence');
    if (content !== '') return dropped('presence with content');
    if (type === 'connect' ? typeof expiration !== 'string' : expiration !== null)
      return dropped('expiration is for connect, exactly once');
  }

  // 3. Freshness.
  if (createdAt < o.now - MESH_MAX_AGE || createdAt > o.now + MESH_MAX_FUTURE)
    return dropped('not fresh');
  let expires = 0;
  if (type === 'connect') {
    if (typeof expiration !== 'string' || !DECIMAL.test(expiration))
      return dropped('expiration is not a plain decimal');
    expires = Number(expiration);
    if (expires <= createdAt || expires > createdAt + MESH_PRESENCE_TTL)
      return dropped('expiration is not within 90 s of created_at');
    if (expires <= o.now) return dropped('expired');
  }

  // 4. For another session: none of our business, and no work spent on it.
  if (directed && p !== o.self) return ignored('for another session');

  // 5. The event, then its room proof.
  const verified = verifyEvent(raw);
  if (!verified.ok) return dropped('id or signature');
  const event = verified.value;
  const preimage = meshProofPreimage(
    o.room,
    event.created_at,
    event.pubkey,
    meshChallenge(event.tags, event.content),
  );
  const proofId = sha256Hex(utf8(preimage));
  let proven = false;
  if (proof[1] === proofId) {
    try {
      proven = schnorr.verify(hexToBytes(proof[2] ?? ''), hexToBytes(proofId), hexToBytes(o.room));
    } catch {
      proven = false;
    }
  }
  if (!proven) return dropped('room proof');

  const common: Common = { id: event.id, from: event.pubkey, sessionId, createdAt };
  if (type === 'connect') return { ...common, kind: 'connect', expiration: expires };
  if (type === 'disconnect') return { ...common, kind: 'disconnect' };

  // 6. The SDP.
  const sdp = o.decrypt(event.pubkey, event.content);
  if (sdp === undefined || !isSdp(sdp)) return dropped('content does not decrypt to an SDP');
  if (type === 'offer') return { ...common, kind: 'offer', sdp };
  return { ...common, kind: 'answer', offerId: offerId ?? '', sdp };
}

/** The subscription for a room (§6.5): its events of the last `MESH_MAX_AGE` seconds on. */
export function meshRoomFilter(
  room: string,
  now: number,
): { readonly kinds: number[]; readonly '#P': string[]; readonly since: number } {
  return { kinds: [KIND_MESH_SIGNAL], '#P': [room], since: now - MESH_MAX_AGE };
}
