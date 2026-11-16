/**
 * #89: the mesh signaler (NFX-10 §6) over an in-memory relay, with stand-in workers. Two
 * signalers meet and connect by the spec's rules; then one signaler against hand-made peers:
 * timeouts and backoff, glare, replays, the bounds, rooms, and teardown.
 *
 * The relay is core's `FakeRelayPool`, which forwards ephemeral kinds to live subscriptions and
 * stores none, as a real relay does. The clock is the test's; `tick()` is called by hand.
 */
import type { NostrEvent, RelayUrl } from '@sovit/core';
import { nfx, nostr, signer } from '@sovit/core';
import { describe, expect, it } from 'vitest';

import { memoryLogger } from '../log.js';
import type { MeshRtc } from '../nfx/mesh-signaler.js';
import {
  ANSWER_TIMEOUT_S,
  BACKOFF_S,
  MAX_PENDING_OFFERS,
  MAX_ROOMS,
  NfxMeshSignaler,
  PRESENCE_EVERY_S,
} from '../nfx/mesh-signaler.js';

const RELAYS = ['wss://signal.test' as RelayUrl];
const SWARM = 'nfx/1/web/nfx:testnet:1:mesh-test/720p';
const ROOM = nfx.meshRoom(SWARM);
const sdpOf = (who: string, n: number): string =>
  `v=0\r\no=${who} ${String(n)} 0 IN IP4 0.0.0.0\r\n`;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};

class FakeRtc implements MeshRtc {
  readonly calls: string[] = [];
  readonly offers: { swarm: string; peer: number }[] = [];
  readonly answers: { swarm: string; offer: string; peer: number }[] = [];
  readonly accepts: { peer: number; answer: string }[] = [];
  readonly hangups: number[] = [];
  served: string[] = [];
  down = false;
  private next = 0;

  constructor(private readonly who: string) {}

  private fail(): Promise<never> {
    return Promise.reject(new Error('backend-down: WebRTC is off'));
  }

  offer(swarm: string): Promise<{ peer: number; sdp: string }> {
    if (this.down) return this.fail();
    const peer = ++this.next;
    this.offers.push({ swarm, peer });
    return Promise.resolve({ peer, sdp: sdpOf(this.who, peer) });
  }

  answer(swarm: string, offer: string): Promise<{ peer: number; sdp: string }> {
    if (this.down) return this.fail();
    const peer = ++this.next;
    this.answers.push({ swarm, offer, peer });
    return Promise.resolve({ peer, sdp: sdpOf(this.who, peer) });
  }

  accept(peer: number, answer: string): Promise<void> {
    this.accepts.push({ peer, answer });
    return Promise.resolve();
  }

  hangup(peer: number): Promise<void> {
    this.hangups.push(peer);
    return Promise.resolve();
  }

  swarms(): Promise<readonly string[]> {
    return this.down ? this.fail() : Promise.resolve(this.served);
  }
}

interface World {
  readonly pool: nostr.FakeRelayPool;
  now: number;
}

function world(): World {
  return { pool: new nostr.FakeRelayPool(), now: 1_790_000_000 };
}

function signalerIn(w: World, who: string, relays: () => readonly RelayUrl[] = () => RELAYS) {
  const rtc = new FakeRtc(who);
  const s = new NfxMeshSignaler({
    relays,
    subscribe: (r, filter, onEvent) => w.pool.subscribe(r, [filter], { onevent: onEvent }),
    publish: async (r, event) => (await w.pool.publish(r, event)).filter((x) => x.ok).length,
    rtc,
    now: () => w.now,
    log: memoryLogger(),
    timers: { setInterval: () => 0, clearInterval: () => undefined },
  });
  return { s, rtc };
}

/** A hand-made remote session whose key is above or below `than`. */
function peer(than: string, where: 'above' | 'below'): signer.MeshSessionKey {
  for (;;) {
    const k = signer.MeshSessionKey.create();
    if (where === 'above' ? k.pubkey > than : k.pubkey < than) return k;
    k.destroy();
  }
}

const send = async (w: World, e: NostrEvent): Promise<void> => {
  await w.pool.publish(RELAYS, e);
  await settle();
};

const sent = (w: World, t: string, by?: string): NostrEvent[] =>
  w.pool.published
    .map((p) => p.event)
    .filter(
      (e) =>
        e.tags.some((x) => x[0] === 't' && x[1] === t) && (by === undefined || e.pubkey === by),
    );

describe('NfxMeshSignaler: two sessions meet (NFX-10 §6.6)', () => {
  it('announce, the lower key offers, the higher answers, and both hand the SDP to the worker', async () => {
    const w = world();
    const a = signalerIn(w, 'a');
    const b = signalerIn(w, 'b');
    a.s.play('sid-a', SWARM);
    b.s.play('sid-b', SWARM);
    a.s.start();
    b.s.start();
    await settle();
    const [low, high] = a.s.pubkey! < b.s.pubkey! ? [a, b] : [b, a];
    // B joined after A's first connect went out (ephemeral: not stored), so only A has heard a
    // connect. When B is the lower key, the next round of presence is what lets it offer.
    if (low.rtc.offers.length === 0) {
      w.now += PRESENCE_EVERY_S;
      a.s.tick();
      b.s.tick();
      await settle();
    }
    expect(low.rtc.offers).toEqual([{ swarm: SWARM, peer: 1 }]);
    expect(high.rtc.offers).toEqual([]);
    expect(high.rtc.answers).toEqual([
      { swarm: SWARM, offer: sdpOf(low === a ? 'a' : 'b', 1), peer: 1 },
    ]);
    expect(low.rtc.accepts).toEqual([{ peer: 1, answer: sdpOf(high === a ? 'a' : 'b', 1) }]);

    // The relay carried only nfx-mesh/1 events of kind 25050, and never an SDP in the clear.
    for (const { event } of w.pool.published) {
      expect(event.kind).toBe(25050);
      expect(event.tags).toContainEqual(['i', 'nfx-mesh/1']);
      expect(event.tags).toContainEqual(['P', ROOM.key]);
      expect(event.content).not.toContain('v=0');
    }
    expect(sent(w, 'offer')).toHaveLength(1);
    expect(sent(w, 'answer')[0]?.tags).toContainEqual(['e', sent(w, 'offer')[0]!.id]);

    // The worker says both connections opened: later presence starts nothing new.
    low.s.onPeer({ peer: 1, open: true });
    high.s.onPeer({ peer: 1, open: true });
    w.now += PRESENCE_EVERY_S;
    a.s.tick();
    b.s.tick();
    await settle();
    expect(low.rtc.offers).toHaveLength(1);
    expect(high.rtc.answers).toHaveLength(1);
    expect([...low.rtc.hangups, ...high.rtc.hangups]).toEqual([]);

    // The connection closed: the next presence connects again.
    low.s.onPeer({ peer: 1, open: false });
    high.s.onPeer({ peer: 1, open: false });
    w.now += PRESENCE_EVERY_S;
    a.s.tick();
    b.s.tick();
    await settle();
    expect(low.rtc.offers).toHaveLength(2);

    a.s.stop();
    b.s.stop();
    await settle();
    expect(sent(w, 'disconnect')).toHaveLength(2);
    expect(a.s.pubkey).toBeNull();
  });
});

describe('NfxMeshSignaler against hand-made peers', () => {
  async function one(): Promise<{ w: World; s: NfxMeshSignaler; rtc: FakeRtc; me: string }> {
    const w = world();
    const { s, rtc } = signalerIn(w, 'me');
    s.play('sid', SWARM);
    s.start();
    await settle();
    return { w, s, rtc, me: s.pubkey! };
  }

  it('an unanswered offer fails after 15 s, is hung up, and backs off 30 s then 60 s', async () => {
    const { w, s, rtc, me } = await one();
    const x = peer(me, 'above');
    await send(w, x.presence('connect', ROOM, w.now));
    expect(rtc.offers).toHaveLength(1);
    w.now += ANSWER_TIMEOUT_S;
    s.tick();
    expect(rtc.hangups).toEqual([]);
    w.now += 1;
    s.tick();
    expect(rtc.hangups).toEqual([1]);
    // Presence inside the backoff offers nothing; after it, once.
    w.now += BACKOFF_S - 1;
    await send(w, x.presence('connect', ROOM, w.now));
    expect(rtc.offers).toHaveLength(1);
    w.now += 2;
    await send(w, x.presence('connect', ROOM, w.now));
    expect(rtc.offers).toHaveLength(2);
    // The second failure doubles the wait.
    w.now += ANSWER_TIMEOUT_S + 1;
    s.tick();
    w.now += BACKOFF_S + 1;
    await send(w, x.presence('connect', ROOM, w.now));
    expect(rtc.offers).toHaveLength(2);
    w.now += BACKOFF_S;
    await send(w, x.presence('connect', ROOM, w.now));
    expect(rtc.offers).toHaveLength(3);
    s.stop();
  });

  it('never offers to a lower key, and answers its offer; an answer that names no pending offer is ignored', async () => {
    const { w, s, rtc, me } = await one();
    const low = peer(me, 'below');
    await send(w, low.presence('connect', ROOM, w.now));
    expect(rtc.offers).toEqual([]);
    const offer = low.offer(ROOM, me, sdpOf('low', 1), w.now);
    await send(w, offer);
    expect(rtc.answers).toEqual([{ swarm: SWARM, offer: sdpOf('low', 1), peer: 1 }]);
    const mine = sent(w, 'answer', me);
    expect(mine).toHaveLength(1);
    expect(low.decrypt(me, mine[0]!.content)).toBe(sdpOf('me', 1));
    // Delivered twice (two relays, a replay): taken once.
    await send(w, offer);
    expect(rtc.answers).toHaveLength(1);
    // An answer out of nowhere is not handed to the worker.
    await send(w, low.answer(ROOM, me, 'ab'.repeat(32), sdpOf('low', 2), w.now));
    expect(rtc.accepts).toEqual([]);
    // Not open 20 s after answering: hung up.
    w.now += 21;
    s.tick();
    expect(rtc.hangups).toEqual([1]);
    s.stop();
  });

  it('glare: with its own offer pending, the lower key ignores the other side’s offer', async () => {
    const { w, s, rtc, me } = await one();
    const x = peer(me, 'above');
    await send(w, x.presence('connect', ROOM, w.now));
    expect(rtc.offers).toHaveLength(1);
    await send(w, x.offer(ROOM, me, sdpOf('x', 1), w.now));
    expect(rtc.answers).toEqual([]);
    // Its answer to OUR offer is the one that counts.
    const ours = sent(w, 'offer', me)[0]!;
    await send(w, x.answer(ROOM, me, ours.id, sdpOf('x', 2), w.now));
    expect(rtc.accepts).toEqual([{ peer: 1, answer: sdpOf('x', 2) }]);
    s.stop();
  });

  it('a peer that offers again replaces its old connection', async () => {
    const { w, s, rtc, me } = await one();
    const low = peer(me, 'below');
    await send(w, low.offer(ROOM, me, sdpOf('low', 1), w.now));
    s.onPeer({ peer: 1, open: true });
    await send(w, low.offer(ROOM, me, sdpOf('low', 2), w.now + 1));
    expect(rtc.hangups).toEqual([1]);
    expect(rtc.answers.map((x) => x.peer)).toEqual([1, 2]);
    s.stop();
  });

  it('a disconnect ends a pending offer, and an older connect replayed after it starts nothing', async () => {
    const { w, s, rtc, me } = await one();
    const x = peer(me, 'above');
    const connect = x.presence('connect', ROOM, w.now);
    await send(w, connect);
    expect(rtc.offers).toHaveLength(1);
    w.now += 2;
    await send(w, x.presence('disconnect', ROOM, w.now));
    expect(rtc.hangups).toEqual([1]);
    // The same connect again (a relay replays it), and a fresh copy signed for the earlier time.
    await send(w, connect);
    await send(w, x.presence('connect', ROOM, w.now - 1));
    expect(rtc.offers).toHaveLength(1);
    s.stop();
  });

  it('keeps at most four own offers pending in a room, whoever announces', async () => {
    const { w, s, rtc, me } = await one();
    for (let i = 0; i < 12; i++) await send(w, peer(me, 'above').presence('connect', ROOM, w.now));
    expect(rtc.offers).toHaveLength(MAX_PENDING_OFFERS);
    // Offers still get answered while those wait: answering has its own slots.
    await send(w, peer(me, 'below').offer(ROOM, me, sdpOf('low', 1), w.now));
    expect(rtc.answers).toHaveLength(1);
    s.stop();
  });

  it('drops what is stale, forged, for another room, or too large for the worker', async () => {
    const { w, s, rtc, me } = await one();
    const x = peer(me, 'above');
    const low = peer(me, 'below');
    await send(w, x.presence('connect', ROOM, w.now - 61));
    await send(w, x.presence('connect', nfx.meshRoom(`${SWARM}x`), w.now));
    // A room proof by the wrong room secret, under our room's key.
    await send(
      w,
      x.presence('connect', { ...ROOM, secret: nfx.meshRoom(`${SWARM}x`).secret }, w.now),
    );
    const good = low.offer(ROOM, me, sdpOf('low', 1), w.now);
    // A tampered ciphertext under the real event's id and signature, straight to subscribers.
    w.pool.inject({ ...good, content: `${good.content.slice(0, -4)}AAAA` });
    await settle();
    await send(w, low.offer(ROOM, me, `v=0\r\n${'a'.repeat(17_000)}`, w.now));
    expect(rtc.offers).toEqual([]);
    expect(rtc.answers).toEqual([]);
    s.stop();
  });

  it('a worker that is off or down costs a backoff, never a crash; when it went down every connection went', async () => {
    const { w, s, rtc, me } = await one();
    const x = peer(me, 'above');
    rtc.down = true;
    await send(w, x.presence('connect', ROOM, w.now));
    expect(rtc.offers).toEqual([]);
    rtc.down = false;
    w.now += BACKOFF_S + 1;
    await send(w, x.presence('connect', ROOM, w.now));
    expect(rtc.offers).toHaveLength(1);
    const ours = sent(w, 'offer', me)[0]!;
    await send(w, x.answer(ROOM, me, ours.id, sdpOf('x', 1), w.now));
    s.onPeer({ peer: 1, open: true });
    s.onWorkerDown();
    w.now += PRESENCE_EVERY_S;
    await send(w, x.presence('connect', ROOM, w.now));
    expect(rtc.offers).toHaveLength(2);
    s.stop();
  });
});

describe('NfxMeshSignaler rooms and sessions', () => {
  it('joins the play room first, then served swarms, at most 32; leaves with a disconnect', async () => {
    const w = world();
    const { s, rtc } = signalerIn(w, 'me');
    rtc.served = Array.from({ length: 40 }, (_, i) => `${SWARM}-${String(i)}`);
    s.play('sid', SWARM);
    s.start();
    await settle();
    s.tick();
    await settle();
    const connects = sent(w, 'connect');
    expect(connects).toHaveLength(MAX_ROOMS);
    const rooms = connects.map((e) => e.tags.find((t) => t[0] === 'P')?.[1]);
    expect(rooms).toContain(ROOM.key);
    expect(new Set(rooms).size).toBe(MAX_ROOMS);

    // The play session closes: its room is left, and a served swarm takes the place.
    s.unplay('sid');
    await settle();
    expect(sent(w, 'disconnect').map((e) => e.tags.find((t) => t[0] === 'P')?.[1])).toEqual([
      ROOM.key,
    ]);
    s.tick();
    await settle();
    expect(sent(w, 'connect')).toHaveLength(MAX_ROOMS + 1);

    s.stop();
    await settle();
    expect(sent(w, 'disconnect')).toHaveLength(1 + MAX_ROOMS);
  });

  it('announces every 30 s, signs each event when it is sent, and says nothing without a relay', async () => {
    const w = world();
    let relays: readonly RelayUrl[] = [];
    const { s } = signalerIn(w, 'me', () => relays);
    s.play('sid', SWARM);
    s.start();
    await settle();
    expect(w.pool.published).toEqual([]);
    relays = RELAYS;
    s.tick();
    await settle();
    expect(sent(w, 'connect')).toHaveLength(1);
    w.now += PRESENCE_EVERY_S - 1;
    s.tick();
    expect(sent(w, 'connect')).toHaveLength(1);
    w.now += 1;
    s.tick();
    const [first, second] = sent(w, 'connect');
    expect(second!.created_at - first!.created_at).toBe(PRESENCE_EVERY_S);
    expect(second!.tags).toContainEqual(['expiration', String(second!.created_at + 90)]);
    s.stop();
  });

  it('uses a fresh key and session id at every start', async () => {
    const w = world();
    const { s } = signalerIn(w, 'me');
    s.play('sid', SWARM);
    s.start();
    await settle();
    const first = s.pubkey;
    s.start(); // already running: the same session
    expect(s.pubkey).toBe(first);
    s.stop();
    s.stop();
    expect(s.running).toBe(false);
    s.start();
    await settle();
    expect(s.pubkey).not.toBe(first);
    const ids = new Set(sent(w, 'connect').map((e) => e.tags.find((t) => t[0] === 'd')?.[1]));
    expect(ids.size).toBe(2);
    s.stop();
  });
});
