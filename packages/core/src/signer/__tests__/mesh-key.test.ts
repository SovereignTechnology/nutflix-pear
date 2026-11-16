/**
 * MeshSessionKey (NFX-10 §6.4): what it signs is read back by `readMeshEvent` as the other
 * session, it signs nothing else, it sends only an SDP, and a destroyed key does nothing.
 */
import { describe, expect, it } from 'vitest';

import { meshRoom, readMeshEvent, type MeshRead } from '../../nfx/mesh-signal.js';
import { MeshSessionKey } from '../mesh-key.js';

const SWARM = 'nfx/1/web/nfx:testnet:1:mesh-key/720p';
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
const NOW = 1_790_000_000;

const readAs = (me: MeshSessionKey, e: unknown, now = NOW): MeshRead =>
  readMeshEvent(e, {
    room: meshRoom(SWARM).key,
    now,
    self: me.pubkey,
    decrypt: (from, content) => me.decrypt(from, content),
  });

describe('MeshSessionKey', () => {
  it('is a fresh key and session id every time', () => {
    const a = MeshSessionKey.create();
    const b = MeshSessionKey.create();
    expect(a.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.pubkey).not.toBe(b.pubkey);
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it('signs presence, an offer and its answer that the other session reads', () => {
    const room = meshRoom(SWARM);
    const a = MeshSessionKey.create();
    const b = MeshSessionKey.create();

    const connect = a.presence('connect', room, NOW);
    expect(connect.kind).toBe(25050);
    expect(connect.pubkey).toBe(a.pubkey);
    expect(connect.content).toBe('');
    expect(readAs(b, connect)).toEqual({
      kind: 'connect',
      id: connect.id,
      from: a.pubkey,
      sessionId: a.sessionId,
      createdAt: NOW,
      expiration: NOW + 90,
    });
    expect(readAs(b, a.presence('disconnect', room, NOW)).kind).toBe('disconnect');

    const offer = a.offer(room, b.pubkey, SDP, NOW);
    // Relays see ciphertext, never the SDP.
    expect(offer.content).not.toContain('v=0');
    expect(readAs(b, offer)).toMatchObject({ kind: 'offer', from: a.pubkey, sdp: SDP });
    const answer = b.answer(room, a.pubkey, offer.id, SDP, NOW + 1);
    expect(readAs(a, answer)).toMatchObject({ kind: 'answer', offerId: offer.id, sdp: SDP });

    // A third session cannot read them, and they are not for it.
    const c = MeshSessionKey.create();
    expect(readAs(c, offer).kind).toBe('ignored');
    expect(c.decrypt(a.pubkey, offer.content)).toBeUndefined();
  });

  it('proves the room it signs in, and no other', () => {
    const a = MeshSessionKey.create();
    const b = MeshSessionKey.create();
    const other = meshRoom('nfx/1/web/nfx:testnet:1:mesh-key/360p');
    const connect = a.presence('connect', other, NOW);
    // Read in the first room: its `P` is another room's.
    expect(readAs(b, connect).kind).toBe('dropped');
  });

  it('sends only an SDP, to a peer key, within the size limit', () => {
    const room = meshRoom(SWARM);
    const a = MeshSessionKey.create();
    const b = MeshSessionKey.create();
    expect(() => a.offer(room, b.pubkey, 'hello', NOW)).toThrow(/only an SDP/);
    expect(() => a.offer(room, a.pubkey, SDP, NOW)).toThrow(/peer session key/);
    expect(() => a.offer(room, 'xyz', SDP, NOW)).toThrow(/peer session key/);
    expect(() => a.answer(room, b.pubkey, 'not-an-id', SDP, NOW)).toThrow(/event id/);
    expect(() => a.offer(room, b.pubkey, `v=0\r\n${'a'.repeat(40_000)}`, NOW)).toThrow(/too long/);
    expect(() => a.presence('connect', room, -1)).toThrow(/time/);
    // Decryption yields an SDP or nothing.
    expect(b.decrypt(a.pubkey, 'not base64 at all')).toBeUndefined();
    expect(b.decrypt('nope', a.offer(room, b.pubkey, SDP, NOW).content)).toBeUndefined();
  });

  it('has no way to sign anything else, and its key is out of reach', () => {
    const a = MeshSessionKey.create();
    expect(Object.getOwnPropertyNames(MeshSessionKey.prototype).sort()).toEqual([
      'answer',
      'constructor',
      'decrypt',
      'destroy',
      'offer',
      'presence',
    ]);
    expect('signEvent' in a).toBe(false);
    expect('nip44Encrypt' in a).toBe(false);
    // The key is a `#` field: not a property, and not in a dump of the object.
    expect(Object.keys(a).sort()).toEqual(['pubkey', 'sessionId']);
    expect(JSON.stringify(a)).toBe(JSON.stringify({ pubkey: a.pubkey, sessionId: a.sessionId }));
  });

  it('refuses a presence type or a room that is not one', () => {
    const a = MeshSessionKey.create();
    const room = meshRoom(SWARM);
    expect(() => a.presence('offer' as never, room, NOW)).toThrow(/presence type/);
    expect(() => a.presence('connect', { ...room, key: 'xyz' }, NOW)).toThrow(/mesh room/);
    expect(() => a.presence('connect', { ...room, secret: new Uint8Array(31) }, NOW)).toThrow(
      /mesh room/,
    );
    // A secret that is not the key's: the proof would not verify, so nothing is returned.
    const other = meshRoom(`${SWARM}x`);
    expect(() => a.presence('connect', { ...room, secret: other.secret }, NOW)).toThrow(
      /did not verify/,
    );
  });

  it('does nothing once destroyed', () => {
    const room = meshRoom(SWARM);
    const a = MeshSessionKey.create();
    const b = MeshSessionKey.create();
    const offer = b.offer(room, a.pubkey, SDP, NOW);
    a.destroy();
    a.destroy();
    expect(() => a.presence('connect', room, NOW)).toThrow(/signer-locked/);
    expect(() => a.offer(room, b.pubkey, SDP, NOW)).toThrow(/signer-locked/);
    expect(a.decrypt(b.pubkey, offer.content)).toBeUndefined();
  });
});
