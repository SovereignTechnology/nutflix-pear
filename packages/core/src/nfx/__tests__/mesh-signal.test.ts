/**
 * NFX-10 §6, signaling over Nostr (`nfx-mesh/1`), against the suite's vectors
 * (docs/vendor/nfx-test-vectors/mesh-signal.json and mesh-signal-invalid.json, nfx b5fe5e4):
 * the room derivation and its rehash step, the room-proof challenge, preimage and id of each
 * event type, every valid event read by the session it is for, every invalid one dropped and
 * every foreign one ignored, and NIP-44 v2 as nostr-tools implements it against the official
 * cases the vectors carry.
 *
 * The vectors' keys are published throwaways. Decryption here is nostr-tools' directly, with the
 * vector's session secret; the session key that signs in production is `signer/mesh-key.ts`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as nip44 from 'nostr-tools/nip44';
import { getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { describe, expect, it } from 'vitest';

import {
  KIND_MESH_SIGNAL,
  MESH_MAX_AGE,
  MESH_MAX_CONTENT,
  MESH_MAX_FUTURE,
  MESH_PRESENCE_TTL,
  isSdp,
  meshChallenge,
  meshDirectedTags,
  meshPresenceTags,
  meshProofPreimage,
  meshRoom,
  meshRoomFilter,
  meshRoomKeyOf,
  meshRoomSeed,
  readMeshEvent,
  type MeshRead,
} from '../mesh-signal.js';
import { sha256, sha256Hex, utf8 } from '../util.js';

const DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'docs',
  'vendor',
  'nfx-test-vectors',
);
const load = (name: string): unknown => JSON.parse(readFileSync(join(DIR, name), 'utf8'));

interface RawEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}
type EventName = 'connect' | 'disconnect' | 'offer' | 'answer';

const v = load('mesh-signal.json') as {
  secret_keys_DO_NOT_USE: { offerer: string; answerer: string; room: string };
  now: number;
  max_age: number;
  max_future: number;
  presence_ttl: number;
  max_content: number;
  rooms: {
    stream_swarm_id: string;
    h0: string;
    rehashes: number;
    secret: string;
    pubkey: string;
  }[];
  rehash: { h: string; valid: boolean; next: string; next_valid: boolean }[];
  room: { stream_swarm_id: string; pubkey: string };
  sessions: Record<'offerer' | 'answerer', { pubkey: string; session_id: string }>;
  nip44: { conversation_key: string; offer_nonce: string; answer_nonce: string };
  sdp: { offer: string; answer: string };
  events: Record<EventName | 'answerer_connect', RawEvent>;
  roomproof: Record<EventName, { challenge: string; preimage: string; id: string }>;
  connect_with_unknown_tag: RawEvent;
  nip44_reference: {
    get_conversation_key: { sec1: string; pub2: string; conversation_key: string }[];
    calc_padded_len: [number, number][];
    encrypt_decrypt: {
      sec1: string;
      sec2: string;
      conversation_key: string;
      nonce: string;
      plaintext: string;
      payload: string;
    }[];
    invalid_decrypt: { conversation_key: string; payload: string; note: string }[];
  };
};
const bad = load('mesh-signal-invalid.json') as {
  now: number;
  room: string;
  offerer: string;
  answerer: string;
  rejected: { name: string; reason: string; event: RawEvent }[];
  ignored: { name: string; reason: string; event: RawEvent }[];
};

/** A session's view: its key, and NIP-44 v2 decryption with the vector's secret. */
function session(who: 'offerer' | 'answerer'): {
  self: string;
  decrypt: (from: string, content: string) => string | undefined;
} {
  const sk = hexToBytes(v.secret_keys_DO_NOT_USE[who]);
  return {
    self: getPublicKey(sk),
    decrypt: (from, content) => {
      try {
        return nip44.decrypt(content, nip44.getConversationKey(sk, from));
      } catch {
        return undefined;
      }
    },
  };
}

const read = (e: unknown, who: 'offerer' | 'answerer', now = v.now): MeshRead =>
  readMeshEvent(e, { room: v.room.pubkey, now, ...session(who) });

describe('NFX-10 §6.1 rooms', () => {
  it('derives each room from its stream swarm id', () => {
    for (const r of v.rooms) {
      expect(bytesToHex(meshRoomSeed(r.stream_swarm_id)), r.stream_swarm_id).toBe(r.h0);
      const room = meshRoom(r.stream_swarm_id);
      expect(bytesToHex(room.secret)).toBe(r.secret);
      expect(room.key).toBe(r.pubkey);
      expect(room.swarm).toBe(r.stream_swarm_id);
    }
    expect(meshRoom(v.room.stream_swarm_id).key).toBe(v.room.pubkey);
  });

  it('rehashes a value that is not a secret key (0 < h < n)', () => {
    for (const c of v.rehash) {
      const h = hexToBytes(c.h);
      expect(meshRoomKeyOf(h) !== undefined, c.h).toBe(c.valid);
      const next = sha256(h);
      expect(bytesToHex(next)).toBe(c.next);
      expect(meshRoomKeyOf(next) !== undefined).toBe(c.next_valid);
    }
  });

  it('subscribes to a room from 60 s back', () => {
    expect(meshRoomFilter(v.room.pubkey, v.now)).toEqual({
      kinds: [25050],
      '#P': [v.room.pubkey],
      since: v.now - 60,
    });
  });
});

describe('NFX-10 §6.2–6.3 events and room proofs', () => {
  it('pins the limits', () => {
    expect([KIND_MESH_SIGNAL, MESH_MAX_AGE, MESH_MAX_FUTURE, MESH_PRESENCE_TTL]).toEqual([
      25050,
      v.max_age,
      v.max_future,
      v.presence_ttl,
    ]);
    expect(MESH_MAX_CONTENT).toBe(v.max_content);
  });

  it('builds each event type’s tags in the spec’s order', () => {
    const { offerer, answerer } = v.sessions;
    const P = v.room.pubkey;
    const at = v.events.connect.created_at;
    const built: Record<EventName, string[][]> = {
      connect: meshPresenceTags('connect', P, offerer.session_id, at),
      disconnect: meshPresenceTags('disconnect', P, offerer.session_id, at),
      offer: meshDirectedTags(P, offerer.session_id, answerer.pubkey),
      answer: meshDirectedTags(P, answerer.session_id, offerer.pubkey, v.events.offer.id),
    };
    for (const name of ['connect', 'disconnect', 'offer', 'answer'] as const) {
      const ev = v.events[name];
      expect(built[name], name).toEqual(ev.tags.filter((t) => t[0] !== 'roomproof'));
    }
  });

  it('reproduces each room proof’s challenge, preimage and id', () => {
    for (const name of ['connect', 'disconnect', 'offer', 'answer'] as const) {
      const ev = v.events[name];
      const proof = v.roomproof[name];
      const challenge = meshChallenge(ev.tags, ev.content);
      expect(challenge, name).toBe(proof.challenge);
      const preimage = meshProofPreimage(v.room.pubkey, ev.created_at, ev.pubkey, challenge);
      expect(preimage, name).toBe(proof.preimage);
      expect(sha256Hex(utf8(preimage)), name).toBe(proof.id);
      expect(ev.tags.find((t) => t[0] === 'roomproof')?.[1], name).toBe(proof.id);
    }
  });

  it('reads every valid event as the session it is for', () => {
    const { offerer, answerer } = v.sessions;
    const at = v.events.connect.created_at;
    expect(read(v.events.connect, 'answerer')).toEqual({
      kind: 'connect',
      id: v.events.connect.id,
      from: offerer.pubkey,
      sessionId: offerer.session_id,
      createdAt: at,
      expiration: at + 90,
    });
    expect(read(v.events.answerer_connect, 'offerer')).toMatchObject({
      kind: 'connect',
      from: answerer.pubkey,
      sessionId: answerer.session_id,
    });
    expect(read(v.events.disconnect, 'answerer')).toEqual({
      kind: 'disconnect',
      id: v.events.disconnect.id,
      from: offerer.pubkey,
      sessionId: offerer.session_id,
      createdAt: at,
    });
    expect(read(v.events.offer, 'answerer')).toEqual({
      kind: 'offer',
      id: v.events.offer.id,
      from: offerer.pubkey,
      sessionId: offerer.session_id,
      createdAt: at,
      sdp: v.sdp.offer,
    });
    expect(read(v.events.answer, 'offerer')).toEqual({
      kind: 'answer',
      id: v.events.answer.id,
      from: answerer.pubkey,
      sessionId: answerer.session_id,
      createdAt: at,
      offerId: v.events.offer.id,
      sdp: v.sdp.answer,
    });
    // Tags a reader does not know are ignored, not refused.
    expect(read(v.connect_with_unknown_tag, 'answerer').kind).toBe('connect');
    // The lower session key is the offerer (§6.6).
    expect(offerer.pubkey < answerer.pubkey).toBe(true);
  });

  it('ignores its own events and directed ones for another session, without decrypting', () => {
    const noDecrypt = (): string | undefined => {
      throw new Error('decrypt must not be called');
    };
    const as = (self: string, e: unknown): MeshRead =>
      readMeshEvent(e, { room: v.room.pubkey, now: v.now, self, decrypt: noDecrypt });
    expect(as(v.sessions.offerer.pubkey, v.events.connect)).toEqual({
      kind: 'ignored',
      why: 'our own event',
    });
    expect(as('ab'.repeat(32), v.events.offer).kind).toBe('ignored');
    expect(as('ab'.repeat(32), v.events.answer).kind).toBe('ignored');
  });

  it('holds the freshness bounds exactly', () => {
    const at = v.events.connect.created_at;
    expect(read(v.events.disconnect, 'answerer', at + 60).kind).toBe('disconnect');
    expect(read(v.events.disconnect, 'answerer', at + 61).kind).toBe('dropped');
    expect(read(v.events.disconnect, 'answerer', at - 30).kind).toBe('disconnect');
    expect(read(v.events.disconnect, 'answerer', at - 31).kind).toBe('dropped');
    // A connect with the full 90 s is still fresh at 60 s (the `connect-expired` vector has a
    // shorter one that is not).
    expect(read(v.events.connect, 'answerer', at + 60).kind).toBe('connect');
  });

  it('drops every invalid event and ignores every foreign one', () => {
    expect(bad.room).toBe(v.room.pubkey);
    for (const c of bad.rejected) {
      const who = c.name.startsWith('answer-') ? 'offerer' : 'answerer';
      const r = readMeshEvent(c.event, { room: bad.room, now: bad.now, ...session(who) });
      expect(r.kind, `${c.name} (${c.reason})`).toBe('dropped');
    }
    for (const c of bad.ignored) {
      const r = readMeshEvent(c.event, { room: bad.room, now: bad.now, ...session('answerer') });
      expect(r.kind, `${c.name} (${c.reason})`).toBe('ignored');
    }
  });

  it('drops what is not an event at all, without throwing', () => {
    for (const junk of [null, 7, 'x', [], {}, { kind: 25050 }, { ...v.events.connect, tags: [[]] }])
      expect(read(junk, 'answerer').kind).toBe('dropped');
  });

  it('knows an SDP by its first line', () => {
    expect(isSdp('v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n')).toBe(true);
    expect(isSdp('v=0\n')).toBe(true);
    expect(isSdp('v=0')).toBe(false);
    expect(isSdp(' v=0\r\n')).toBe(false);
    expect(isSdp('{"type":"offer"}')).toBe(false);
  });
});

describe('NIP-44 v2 (the vectors’ official cases, through nostr-tools)', () => {
  const ref = v.nip44_reference;

  it('derives conversation keys, the vector session’s included', () => {
    for (const c of ref.get_conversation_key)
      expect(bytesToHex(nip44.getConversationKey(hexToBytes(c.sec1), c.pub2))).toBe(
        c.conversation_key,
      );
    const ck = nip44.getConversationKey(
      hexToBytes(v.secret_keys_DO_NOT_USE.offerer),
      v.sessions.answerer.pubkey,
    );
    expect(bytesToHex(ck)).toBe(v.nip44.conversation_key);
  });

  it('reproduces the vector’s offer and answer ciphertext from the fixed nonces', () => {
    const ck = hexToBytes(v.nip44.conversation_key);
    expect(nip44.encrypt(v.sdp.offer, ck, hexToBytes(v.nip44.offer_nonce))).toBe(
      v.events.offer.content,
    );
    expect(nip44.encrypt(v.sdp.answer, ck, hexToBytes(v.nip44.answer_nonce))).toBe(
      v.events.answer.content,
    );
  });

  it('encrypts and decrypts the official case, and refuses the invalid ones', () => {
    for (const c of ref.encrypt_decrypt) {
      const ck = hexToBytes(c.conversation_key);
      expect(nip44.encrypt(c.plaintext, ck, hexToBytes(c.nonce))).toBe(c.payload);
      expect(nip44.decrypt(c.payload, ck)).toBe(c.plaintext);
    }
    for (const c of ref.invalid_decrypt)
      expect(() => nip44.decrypt(c.payload, hexToBytes(c.conversation_key)), c.note).toThrow();
  });
});
