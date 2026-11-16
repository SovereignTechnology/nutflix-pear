/**
 * #89: the mesh signaler (NFX-10 §6) over an in-memory relay, with stand-in workers. Two
 * signalers meet and connect by the spec's rules; then one signaler against hand-made peers:
 * timeouts and backoff, glare, replays, what a hostile room can and cannot make it do, its
 * keys, its relays, and teardown.
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
  ANSWERED_TIMEOUT_S,
  BACKOFF_S,
  DIRECTED_PER_WINDOW,
  MAX_EVENTS_PER_S,
  MAX_PENDING_ANSWERS,
  MAX_PENDING_OFFERS,
  MAX_PRESENCE,
  MAX_ROOM_PEERS,
  MAX_ROOMS,
  NfxMeshSignaler,
  OPEN_TIMEOUT_S,
  PRESENCE_EVERY_S,
  PRESENCE_JITTER_S,
  ROOM_CALL_BURST,
  ROOM_CALL_REFILL_S,
  SUB_RETRY_S,
  SWARMS_EVERY_S,
  SWARMS_FAILURES,
} from '../nfx/mesh-signaler.js';

const R1 = 'wss://signal.test' as RelayUrl;
const R2 = 'wss://other.test' as RelayUrl;
const RELAYS = [R1];
const SWARM = 'nfx/1/web/nfx:testnet:1:mesh-test/720p';
const ROOM = nfx.meshRoom(SWARM);
const sdpOf = (who: string, n: number): string =>
  `v=0\r\no=${who} ${String(n)} 0 IN IP4 0.0.0.0\r\n`;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};

const sorted = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b);

interface Made {
  readonly peer: number;
  readonly sdp: string;
}

class FakeRtc implements MeshRtc {
  readonly offers: { swarm: string; peer: number }[] = [];
  readonly answers: { swarm: string; offer: string; peer: number }[] = [];
  readonly accepts: { peer: number; answer: string }[] = [];
  readonly hangups: number[] = [];
  served: string[] = [];
  down = false;
  /** Offers and answers wait here until `release()`. */
  hold = false;
  /** How many `offer` and `answer` calls were made, held and refused ones included. */
  asked = 0;
  private readonly held: (() => void)[] = [];
  private next = 0;

  constructor(private readonly who: string) {}

  private fail(): Promise<never> {
    return Promise.reject(new Error('backend-down: WebRTC is off'));
  }

  private make(record: (peer: number) => void): Promise<Made> {
    this.asked += 1;
    if (this.down) return this.fail();
    const go = (): Made => {
      const peer = ++this.next;
      record(peer);
      return { peer, sdp: sdpOf(this.who, peer) };
    };
    if (!this.hold) return Promise.resolve(go());
    return new Promise((resolve) => {
      this.held.push(() => {
        resolve(go());
      });
    });
  }

  release(): void {
    for (const go of this.held.splice(0)) go();
  }

  /** The helper restarted: its connection ids start over. */
  restart(): void {
    this.next = 0;
  }

  offer(swarm: string): Promise<Made> {
    return this.make((peer) => {
      this.offers.push({ swarm, peer });
    });
  }

  answer(swarm: string, offer: string): Promise<Made> {
    return this.make((peer) => {
      this.answers.push({ swarm, offer, peer });
    });
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
  /** What the signaler's random source returns: 0 = no jitter at all. */
  random: number;
  /** While true the relay refuses every event. */
  refusing: boolean;
}

function world(): World {
  const w: World = {
    pool: new nostr.FakeRelayPool({
      rejectPublish: () => (w.refusing ? 'blocked: not today' : null),
    }),
    now: 1_790_000_000,
    random: 0,
    refusing: false,
  };
  return w;
}

function signalerIn(w: World, who: string, relays: () => readonly RelayUrl[] = () => RELAYS) {
  const rtc = new FakeRtc(who);
  const log = memoryLogger();
  /** Relay → the subscriptions held on it, each by the relay's way to close it. */
  const subs = new Map<string, Set<() => void>>();
  /** Relay → how many subscriptions were ever opened on it. */
  const opened = new Map<string, number>();
  const s = new NfxMeshSignaler({
    relays,
    subscribe: (relay, filter, onEvent, onClose) => {
      const off = w.pool.subscribe([relay], [filter], { onevent: onEvent });
      const mine = subs.get(relay) ?? new Set<() => void>();
      subs.set(relay, mine);
      mine.add(onClose);
      opened.set(relay, (opened.get(relay) ?? 0) + 1);
      return () => {
        mine.delete(onClose);
        off();
      };
    },
    publish: async (r, event) => (await w.pool.publish(r, event)).filter((x) => x.ok).length,
    rtc,
    now: () => w.now,
    log,
    random: () => w.random,
    timers: { setInterval: () => 0, clearInterval: () => undefined },
  });
  return {
    s,
    rtc,
    log,
    /** The relay closes every subscription this signaler holds on it. */
    close: (relay: RelayUrl): void => {
      for (const onClose of [...(subs.get(relay) ?? [])]) onClose();
    },
    held: (relay: RelayUrl): number => subs.get(relay)?.size ?? 0,
    opened: (relay: RelayUrl): number => opened.get(relay) ?? 0,
  };
}

/** A hand-made remote session whose key is above or below `than`. */
function peer(than: string, where: 'above' | 'below'): signer.MeshSessionKey {
  for (;;) {
    const k = signer.MeshSessionKey.create();
    if (where === 'above' ? k.pubkey > than : k.pubkey < than) return k;
    k.destroy();
  }
}

/** One event from a hand-made session that is not needed again. */
function from(
  than: string,
  where: 'above' | 'below',
  make: (k: signer.MeshSessionKey) => NostrEvent,
): NostrEvent {
  const k = peer(than, where);
  try {
    return make(k);
  } finally {
    k.destroy();
  }
}

const send = async (
  w: World,
  e: NostrEvent,
  relays: readonly RelayUrl[] = RELAYS,
): Promise<void> => {
  await w.pool.publish(relays, e);
  await settle();
};

const sent = (w: World, t: string, by?: string): NostrEvent[] =>
  w.pool.published
    .map((p) => p.event)
    .filter(
      (e) =>
        e.tags.some((x) => x[0] === 't' && x[1] === t) && (by === undefined || e.pubkey === by),
    );

const roomOf = (e: NostrEvent): string | undefined => e.tags.find((t) => t[0] === 'P')?.[1];

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
    const [low, high] = a.s.keyIn(SWARM)! < b.s.keyIn(SWARM)! ? [a, b] : [b, a];
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
    expect(a.s.keyIn(SWARM)).toBeNull();
    // Nothing was logged at all, so no SDP, address or key was.
    expect([...a.log.lines, ...b.log.lines]).toEqual([]);
  });
});

describe('NfxMeshSignaler against hand-made peers', () => {
  async function one(): Promise<{ w: World; s: NfxMeshSignaler; rtc: FakeRtc; me: string }> {
    const w = world();
    const { s, rtc } = signalerIn(w, 'me');
    s.play('sid', SWARM);
    s.start();
    await settle();
    return { w, s, rtc, me: s.keyIn(SWARM)! };
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
    // An open connection clears the count: after it closes, the next offer is immediate.
    const ours = sent(w, 'offer', me).at(-1)!;
    await send(w, x.answer(ROOM, me, ours.id, sdpOf('x', 1), w.now));
    s.onPeer({ peer: 3, open: true });
    s.onPeer({ peer: 3, open: false });
    w.now += 1;
    await send(w, x.presence('connect', ROOM, w.now));
    expect(rtc.offers).toHaveLength(4);
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
    w.now += ANSWERED_TIMEOUT_S + 1;
    s.tick();
    expect(rtc.hangups).toEqual([1]);
    // It waits before it is answered again: 20 s (two thirds of the 30), so that its own retry,
    // 30 s after its own failure, is answered.
    w.now += 19;
    await send(w, low.offer(ROOM, me, sdpOf('low', 3), w.now));
    expect(rtc.answers).toHaveLength(1);
    w.now += 2;
    await send(w, low.offer(ROOM, me, sdpOf('low', 4), w.now));
    expect(rtc.answers).toHaveLength(2);
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

  it('only a newer offer replaces a peer’s connection', async () => {
    const { w, s, rtc, me } = await one();
    const low = peer(me, 'below');
    await send(w, low.offer(ROOM, me, sdpOf('low', 1), w.now));
    s.onPeer({ peer: 1, open: true });
    // Another offer of the same second, or an older one (a replay), tears nothing down.
    await send(w, low.offer(ROOM, me, sdpOf('low', 9), w.now));
    await send(w, low.offer(ROOM, me, sdpOf('low', 8), w.now - 5));
    expect(rtc.hangups).toEqual([]);
    expect(rtc.answers).toHaveLength(1);
    await send(w, low.offer(ROOM, me, sdpOf('low', 2), w.now + 1));
    expect(rtc.hangups).toEqual([1]);
    expect(rtc.answers.map((x) => x.peer)).toEqual([1, 2]);
    // The old connection's close, arriving late, is not the new negotiation's: that one still
    // opens, and is a connection a still newer offer replaces (a failed one would be waiting).
    s.onPeer({ peer: 1, open: false });
    s.onPeer({ peer: 2, open: true });
    await send(w, low.offer(ROOM, me, sdpOf('low', 3), w.now + 2));
    expect(rtc.hangups).toEqual([1, 2]);
    expect(rtc.answers).toHaveLength(3);
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

  it('connect and disconnect in a loop buy one worker call, not one each: the peer backs off', async () => {
    const { w, s, rtc, me } = await one();
    const x = peer(me, 'above');
    for (let i = 0; i < 20; i++) {
      w.now += 1;
      await send(w, x.presence('connect', ROOM, w.now));
      await send(w, x.presence('disconnect', ROOM, w.now));
    }
    expect(rtc.asked).toBe(1);
    // The same from a lower key, with offers: one answer.
    const low = peer(me, 'below');
    for (let i = 0; i < 6; i++) {
      w.now += 1;
      await send(w, low.offer(ROOM, me, sdpOf('low', i), w.now));
      await send(w, low.presence('disconnect', ROOM, w.now));
    }
    expect(rtc.answers).toHaveLength(1);
    s.stop();
  });

  it('keeps at most four own offers pending in a room, whoever announces', async () => {
    const { w, s, rtc, me } = await one();
    for (let i = 0; i < 12; i++)
      await send(
        w,
        from(me, 'above', (k) => k.presence('connect', ROOM, w.now)),
      );
    expect(rtc.offers).toHaveLength(MAX_PENDING_OFFERS);
    // Offers still get answered while those wait: answering has its own slots and its own budget.
    await send(
      w,
      from(me, 'below', (k) => k.offer(ROOM, me, sdpOf('low', 1), w.now)),
    );
    expect(rtc.answers).toHaveLength(1);
    s.stop();
  });

  it('an offer the worker is still making stays counted when its peer leaves', async () => {
    const { w, s, rtc, me } = await one();
    rtc.hold = true;
    const early = Array.from({ length: MAX_PENDING_OFFERS }, () => peer(me, 'above'));
    for (const x of early) await send(w, x.presence('connect', ROOM, w.now));
    expect(rtc.asked).toBe(MAX_PENDING_OFFERS);
    // They all leave while the worker is busy; newcomers must not pile more calls onto it.
    w.now += 1;
    for (const x of early) await send(w, x.presence('disconnect', ROOM, w.now));
    w.now += 60;
    for (let i = 0; i < 6; i++)
      await send(
        w,
        from(me, 'above', (k) => k.presence('connect', ROOM, w.now)),
      );
    expect(rtc.asked).toBe(MAX_PENDING_OFFERS);
    // The worker answers at last: what it made for the peers that left is hung up, unsent.
    rtc.release();
    await settle();
    expect(sorted(rtc.hangups)).toEqual([1, 2, 3, 4]);
    expect(sent(w, 'offer', me)).toEqual([]);
    // And the places are free again.
    await send(
      w,
      from(me, 'above', (k) => k.presence('connect', ROOM, w.now)),
    );
    expect(rtc.asked).toBe(MAX_PENDING_OFFERS + 1);
    s.stop();
  });

  it('offers that never complete hold four answer slots, not the room, and never our own offers', async () => {
    const { w, s, rtc, me } = await one();
    for (let i = 0; i < 10; i++)
      await send(
        w,
        from(me, 'below', (k) => k.offer(ROOM, me, sdpOf('low', i), w.now)),
      );
    expect(rtc.answers).toHaveLength(MAX_PENDING_ANSWERS);
    // Our own offers go out all the same.
    for (let i = 0; i < 3; i++)
      await send(
        w,
        from(me, 'above', (k) => k.presence('connect', ROOM, w.now)),
      );
    expect(rtc.offers).toHaveLength(3);
    // The slots free when those time out, and the worker is then asked within its budget.
    w.now += ANSWERED_TIMEOUT_S + 1;
    s.tick();
    for (let i = 0; i < 10; i++)
      await send(
        w,
        from(me, 'below', (k) => k.offer(ROOM, me, sdpOf('low', 20 + i), w.now)),
      );
    expect(rtc.answers).toHaveLength(MAX_PENDING_ANSWERS + ROOM_CALL_BURST);
    s.stop();
  });

  it('asks the worker for answers no faster than the room’s budget, and stops at eight peers', async () => {
    const { w, s, rtc, me } = await one();
    // Four offers answered and opened at once: the burst.
    for (let i = 1; i <= ROOM_CALL_BURST; i++) {
      await send(
        w,
        from(me, 'below', (k) => k.offer(ROOM, me, sdpOf('low', i), w.now)),
      );
      s.onPeer({ peer: i, open: true });
    }
    expect(rtc.answers).toHaveLength(ROOM_CALL_BURST);
    await send(
      w,
      from(me, 'below', (k) => k.offer(ROOM, me, sdpOf('low', 5), w.now)),
    );
    expect(rtc.answers).toHaveLength(ROOM_CALL_BURST);
    // One more every five seconds, up to the room's eight peers.
    for (let i = ROOM_CALL_BURST + 1; i <= MAX_ROOM_PEERS; i++) {
      w.now += ROOM_CALL_REFILL_S;
      await send(
        w,
        from(me, 'below', (k) => k.offer(ROOM, me, sdpOf('low', i), w.now)),
      );
      expect(rtc.answers).toHaveLength(i);
      s.onPeer({ peer: i, open: true });
    }
    w.now += 60;
    await send(
      w,
      from(me, 'below', (k) => k.offer(ROOM, me, sdpOf('low', 9), w.now)),
    );
    await send(
      w,
      from(me, 'above', (k) => k.presence('connect', ROOM, w.now)),
    );
    expect(rtc.asked).toBe(MAX_ROOM_PEERS);
    s.stop();
  });

  it('decrypts at most eight offers or answers per sender in 30 s', async () => {
    const { w, s, rtc, me } = await one();
    const x = peer(me, 'above');
    await send(w, x.presence('connect', ROOM, w.now));
    const ours = sent(w, 'offer', me)[0]!;
    // Eight answers that name nothing we sent use the sender's budget up.
    for (let i = 0; i < DIRECTED_PER_WINDOW; i++)
      await send(w, x.answer(ROOM, me, `${String(i)}b`.repeat(32), sdpOf('x', i), w.now));
    await send(w, x.answer(ROOM, me, ours.id, sdpOf('x', 99), w.now));
    expect(rtc.accepts).toEqual([]);
    // Another sender's budget is its own.
    await send(
      w,
      from(me, 'below', (k) => k.offer(ROOM, me, sdpOf('low', 1), w.now)),
    );
    expect(rtc.answers).toHaveLength(1);
    s.stop();
  });

  it('a full presence book does not lock a newcomer out', async () => {
    const { w, s, rtc, me } = await one();
    for (let i = 0; i < MAX_PRESENCE; i++) {
      // Spread over a few seconds: a relay is read no faster than MAX_EVENTS_PER_S.
      if (i % 50 === 0) w.now += 1;
      w.pool.store(from(me, 'below', (k) => k.presence('connect', ROOM, w.now)));
    }
    await settle();
    expect(rtc.asked).toBe(0);
    w.now += 1;
    await send(
      w,
      from(me, 'above', (k) => k.presence('connect', ROOM, w.now)),
    );
    expect(rtc.offers).toHaveLength(1);
    s.stop();
  }, 60_000);

  it('reads a flooding relay no faster than its limit', async () => {
    const { w, s, rtc, me } = await one();
    for (let i = 0; i < MAX_EVENTS_PER_S; i++)
      w.pool.inject({ kind: 25050, id: String(i), tags: [['P', ROOM.key]] });
    // Valid, but past the limit for this second: dropped unread (and so not remembered either).
    const connect = from(me, 'above', (k) => k.presence('connect', ROOM, w.now));
    await send(w, connect);
    expect(rtc.asked).toBe(0);
    w.now += 1;
    await send(w, connect);
    expect(rtc.offers).toHaveLength(1);
    s.stop();
  });

  it('drops what is stale, forged, for another room, or too large; a forgery does not hide the real event', async () => {
    const { w, s, rtc, me } = await one();
    const x = peer(me, 'above');
    const low = peer(me, 'below');
    await send(w, x.presence('connect', ROOM, w.now - 61));
    await send(w, x.presence('connect', nfx.meshRoom(`${SWARM}x`), w.now));
    // A connect altered after it was signed (here: another event's room proof swapped in).
    const real = x.presence('connect', ROOM, w.now);
    const other = x.presence('connect', ROOM, w.now + 1);
    w.pool.inject({
      ...real,
      tags: real.tags.map((t) =>
        t[0] === 'roomproof' ? other.tags.find((o) => o[0] === 'roomproof')! : t,
      ),
    });
    await settle();
    const good = low.offer(ROOM, me, sdpOf('low', 1), w.now);
    // A tampered ciphertext under the real event's id and signature, straight to subscribers.
    w.pool.inject({ ...good, content: `${good.content.slice(0, -4)}AAAA` });
    await settle();
    await send(
      w,
      from(me, 'below', (k) => k.offer(ROOM, me, `v=0\r\n${'a'.repeat(17_000)}`, w.now)),
    );
    expect(rtc.asked).toBe(0);
    // The real events, arriving after their forgeries, are taken.
    await send(w, good);
    expect(rtc.answers).toEqual([{ swarm: SWARM, offer: sdpOf('low', 1), peer: 1 }]);
    await send(w, real);
    expect(rtc.offers).toHaveLength(1);
    s.stop();
  });

  it('a worker that refuses costs a wait, not a failure against the peer', async () => {
    const { w, s, rtc, me } = await one();
    const x = peer(me, 'above');
    rtc.down = true;
    await send(w, x.presence('connect', ROOM, w.now));
    w.now += BACKOFF_S - 1;
    await send(w, x.presence('connect', ROOM, w.now));
    expect(rtc.asked).toBe(1);
    rtc.down = false;
    w.now += 2;
    await send(w, x.presence('connect', ROOM, w.now));
    expect(rtc.offers).toHaveLength(1);
    // That offer then times out: the wait is a first failure's 30 s, not a doubled one.
    w.now += ANSWER_TIMEOUT_S + 1;
    s.tick();
    w.now += BACKOFF_S + 1;
    await send(w, x.presence('connect', ROOM, w.now));
    expect(rtc.offers).toHaveLength(2);
    s.stop();
  });

  it('when the helper went away every id is forgotten, and what the worker makes late is hung up', async () => {
    const { w, s, rtc, me } = await one();
    const x = peer(me, 'above');
    await send(w, x.presence('connect', ROOM, w.now));
    const ours = sent(w, 'offer', me)[0]!;
    await send(w, x.answer(ROOM, me, ours.id, sdpOf('x', 1), w.now));
    s.onPeer({ peer: 1, open: true });
    // An offer is out (connection 2), and another is with the worker, when the helper restarts.
    await send(
      w,
      from(me, 'above', (k) => k.presence('connect', ROOM, w.now)),
    );
    expect(rtc.offers.at(-1)).toEqual({ swarm: SWARM, peer: 2 });
    rtc.hold = true;
    await send(
      w,
      from(me, 'above', (k) => k.presence('connect', ROOM, w.now)),
    );
    s.reset();
    rtc.restart();
    rtc.release();
    await settle();
    // What the new helper made for the cancelled negotiation (its connection 1) is hung up,
    // and nothing is sent for it.
    expect(rtc.hangups).toEqual([1]);
    expect(sent(w, 'offer', me)).toHaveLength(2);
    rtc.hold = false;
    // X is no longer held as connected: its next presence gets a new offer, the new helper's 2.
    w.now += 1;
    await send(w, x.presence('connect', ROOM, w.now));
    expect(rtc.offers.at(-1)).toEqual({ swarm: SWARM, peer: 2 });
    // The offer that was out before the restart is forgotten: its timeout, which would have
    // come first, hangs nothing up, least of all the new connection 2.
    w.now += ANSWER_TIMEOUT_S;
    s.tick();
    expect(rtc.hangups).toEqual([1]);
    s.stop();
  });

  it('an offer no relay takes fails at once; an answer not opened in 15 s, or refused by the worker, fails too', async () => {
    const { w, s, rtc, me } = await one();
    w.refusing = true;
    // Straight into the relay's subscriptions: it refuses what is published while it refuses.
    w.pool.store(from(me, 'above', (k) => k.presence('connect', ROOM, w.now)));
    await settle();
    expect(rtc.offers).toHaveLength(1);
    expect(rtc.hangups).toEqual([1]);
    w.refusing = false;
    // Answered, handed to the worker, never open.
    const x = peer(me, 'above');
    await send(w, x.presence('connect', ROOM, w.now));
    const ours = sent(w, 'offer', me).at(-1)!;
    await send(w, x.answer(ROOM, me, ours.id, sdpOf('x', 1), w.now));
    expect(rtc.accepts).toEqual([{ peer: 2, answer: sdpOf('x', 1) }]);
    w.now += OPEN_TIMEOUT_S;
    s.tick();
    expect(rtc.hangups).toEqual([1]);
    w.now += 1;
    s.tick();
    expect(rtc.hangups).toEqual([1, 2]);
    // The worker refuses an answer (a bad SDP): hung up as well.
    const y = peer(me, 'above');
    rtc.accept = () => Promise.reject(new Error('bad-request: not an answer'));
    await send(w, y.presence('connect', ROOM, w.now));
    const third = sent(w, 'offer', me).at(-1)!;
    await send(w, y.answer(ROOM, me, third.id, sdpOf('y', 1), w.now));
    expect(rtc.hangups).toEqual([1, 2, 3]);
    s.stop();
  });

  it('a worker call that returns after stop is hung up, and nothing is signed with a wiped key', async () => {
    const { w, s, rtc, me } = await one();
    rtc.hold = true;
    await send(
      w,
      from(me, 'above', (k) => k.presence('connect', ROOM, w.now)),
    );
    s.stop();
    await settle();
    rtc.release();
    await settle();
    expect(rtc.hangups).toEqual([1]);
    expect(sent(w, 'offer')).toEqual([]);
    expect(sent(w, 'disconnect', me)).toHaveLength(1);
  });
});

describe('NfxMeshSignaler rooms, keys and relays', () => {
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
    const rooms = connects.map(roomOf);
    expect(rooms).toContain(ROOM.key);
    expect(new Set(rooms).size).toBe(MAX_ROOMS);

    // The play session closes: its room is left, and a served swarm takes the place.
    s.unplay('sid');
    await settle();
    expect(sent(w, 'disconnect').map(roomOf)).toEqual([ROOM.key]);
    s.tick();
    await settle();
    expect(sent(w, 'connect')).toHaveLength(MAX_ROOMS + 1);

    s.stop();
    await settle();
    expect(sent(w, 'disconnect')).toHaveLength(1 + MAX_ROOMS);
  });

  it('a play has its own key: not the seeding key, not another play’s, and gone when it ends', async () => {
    const w = world();
    const { s, rtc } = signalerIn(w, 'me');
    const kept = `${SWARM}-kept`;
    const other = `${SWARM}-other`;
    rtc.served = [kept];
    s.play('one', SWARM);
    s.play('two', other);
    s.start();
    await settle();
    const seedKey = s.pubkey!;
    const first = s.keyIn(SWARM)!;
    const second = s.keyIn(other)!;
    expect(s.keyIn(kept)).toBe(seedKey);
    expect(new Set([seedKey, first, second]).size).toBe(3);
    // Every event in a room is signed by that room's key only.
    s.tick();
    await settle();
    const signerOf = new Map([
      [ROOM.key, first],
      [nfx.meshRoom(other).key, second],
      [nfx.meshRoom(kept).key, seedKey],
    ]);
    const connects = sent(w, 'connect');
    expect(connects).toHaveLength(3);
    for (const e of connects) expect(e.pubkey).toBe(signerOf.get(roomOf(e) ?? ''));
    // Watched again later: another key.
    s.unplay('one');
    s.play('three', SWARM);
    expect(s.keyIn(SWARM)).not.toBe(first);
    // A video this app seeds is in its room as the seeder, played or not.
    s.play('four', kept);
    expect(s.keyIn(kept)).toBe(seedKey);
    s.stop();
  });

  it('a play keeps its key when its video becomes seeded; the seeding key comes after it has left', async () => {
    const w = world();
    const { s, rtc } = signalerIn(w, 'me');
    s.play('one', SWARM);
    s.start();
    await settle();
    const mine = s.keyIn(SWARM)!;
    expect(mine).not.toBe(s.pubkey);
    rtc.served = [SWARM];
    w.now += SWARMS_EVERY_S;
    s.tick();
    await settle();
    expect(s.keyIn(SWARM)).toBe(mine);
    expect(sent(w, 'disconnect')).toEqual([]);
    // The play ends: its key says goodbye, and the seeding key announces at a random later time.
    w.random = 0.5;
    s.unplay('one');
    await settle();
    expect(sent(w, 'disconnect').map((e) => e.pubkey)).toEqual([mine]);
    expect(s.keyIn(SWARM)).toBe(s.pubkey);
    s.tick();
    expect(sent(w, 'connect', s.pubkey!)).toEqual([]);
    w.now += PRESENCE_EVERY_S / 2;
    s.tick();
    expect(sent(w, 'connect', s.pubkey!)).toHaveLength(1);
    s.stop();
  });

  it('when one of two plays of a video ends, the other’s key does not appear in the same second', async () => {
    const w = world();
    const { s } = signalerIn(w, 'me');
    s.play('one', SWARM);
    s.play('two', SWARM);
    s.start();
    await settle();
    const first = s.keyIn(SWARM)!;
    w.random = 0.5;
    s.unplay('one');
    await settle();
    const second = s.keyIn(SWARM)!;
    expect(second).not.toBe(first);
    expect(sent(w, 'disconnect').map((e) => e.pubkey)).toEqual([first]);
    s.tick();
    expect(sent(w, 'connect', second)).toEqual([]);
    w.now += PRESENCE_EVERY_S / 2;
    s.tick();
    expect(sent(w, 'connect', second)).toHaveLength(1);
    s.stop();
  });

  it('rooms keep their own beat, are spread again after a stall, and at stop only one key speaks', async () => {
    const w = world();
    const { s, rtc } = signalerIn(w, 'me');
    rtc.served = [`${SWARM}-kept`];
    s.play('one', SWARM);
    s.start();
    await settle();
    s.tick();
    expect(sent(w, 'connect')).toHaveLength(2);
    // The next round comes up to ten seconds early, by the room's own draw.
    w.random = 0.5;
    w.now += PRESENCE_EVERY_S;
    s.tick();
    expect(sent(w, 'connect')).toHaveLength(4);
    w.now += PRESENCE_EVERY_S - PRESENCE_JITTER_S / 2 - 1;
    s.tick();
    expect(sent(w, 'connect')).toHaveLength(4);
    w.now += 1;
    s.tick();
    expect(sent(w, 'connect')).toHaveLength(6);
    // The machine slept: both rooms are long overdue, and neither announces in the waking second.
    w.now += 600;
    s.tick();
    expect(sent(w, 'connect')).toHaveLength(6);
    w.now += PRESENCE_JITTER_S / 2;
    s.tick();
    expect(sent(w, 'connect')).toHaveLength(8);
    // Two keys are in use: at stop only the seeding key says goodbye.
    const seedKey = s.pubkey!;
    s.stop();
    await settle();
    expect(sent(w, 'disconnect').map((e) => e.pubkey)).toEqual([seedKey]);
  });

  it('one failed poll of the served swarms changes nothing; three in a row end the seeding rooms', async () => {
    const w = world();
    const { s, rtc } = signalerIn(w, 'me');
    const kept = `${SWARM}-kept`;
    rtc.served = [kept];
    s.start();
    await settle();
    expect(s.keyIn(kept)).toBe(s.pubkey);
    rtc.down = true;
    for (let i = 1; i < SWARMS_FAILURES; i++) {
      w.now += SWARMS_EVERY_S;
      s.tick();
      await settle();
      expect(s.keyIn(kept)).toBe(s.pubkey);
    }
    w.now += SWARMS_EVERY_S;
    s.tick();
    await settle();
    expect(s.keyIn(kept)).toBeNull();
    s.stop();
  });

  it('every room may always negotiate once; beyond that the rooms share eight places', async () => {
    const w = world();
    const { s, rtc } = signalerIn(w, 'me');
    const swarms = [0, 1, 2, 3].map((i) => `${SWARM}-${String(i)}`);
    swarms.forEach((swarm, i) => {
      s.play(`sid-${String(i)}`, swarm);
    });
    s.start();
    await settle();
    const counts: number[] = [];
    for (const swarm of swarms) {
      const me = s.keyIn(swarm)!;
      const before = rtc.asked;
      for (let i = 0; i < MAX_PENDING_OFFERS; i++)
        await send(
          w,
          from(me, 'above', (k) => k.presence('connect', nfx.meshRoom(swarm), w.now)),
        );
      counts.push(rtc.asked - before);
    }
    // 4 and 4 (three beyond the first each), then 3 (two more places were left), then the one
    // every room has.
    expect(counts).toEqual([4, 4, 3, 1]);
    s.stop();
  });

  it('a room’s connections end when it is left', async () => {
    const w = world();
    const { s, rtc } = signalerIn(w, 'me');
    s.play('sid', SWARM);
    s.start();
    await settle();
    const me = s.keyIn(SWARM)!;
    await send(
      w,
      from(me, 'below', (k) => k.offer(ROOM, me, sdpOf('low', 1), w.now)),
    );
    s.onPeer({ peer: 1, open: true });
    await send(
      w,
      from(me, 'above', (k) => k.presence('connect', ROOM, w.now)),
    );
    s.unplay('sid');
    expect(sorted(rtc.hangups)).toEqual([1, 2]);
    s.stop();
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
    // Signaling is switched off (no relays any more): the disconnect still goes where it announced.
    relays = [];
    s.stop();
    await settle();
    expect(sent(w, 'disconnect')).toHaveLength(1);
    expect(w.pool.published.at(-1)?.relays).toEqual(RELAYS);
  });

  it('subscribes on each relay by itself and takes an event once, whichever delivers it', async () => {
    const w = world();
    let relays: readonly RelayUrl[] = [R1, R2];
    const { s, rtc, held } = signalerIn(w, 'me', () => relays);
    s.play('sid', SWARM);
    s.start();
    await settle();
    expect([held(R1), held(R2)]).toEqual([1, 1]);
    const me = s.keyIn(SWARM)!;
    // The pool hands the event to both subscriptions.
    await send(
      w,
      from(me, 'above', (k) => k.presence('connect', ROOM, w.now)),
      [R1, R2],
    );
    expect(rtc.offers).toHaveLength(1);
    // A relay taken off the list is unsubscribed at the next tick.
    relays = [R1];
    s.tick();
    expect([held(R1), held(R2)]).toEqual([1, 0]);
    s.stop();
    expect(held(R1)).toBe(0);
  });

  it('a relay that closed the subscription gets no presence until it is subscribed again', async () => {
    const w = world();
    const { s, close, opened } = signalerIn(w, 'me', () => [R1, R2]);
    s.play('one', SWARM);
    s.start();
    await settle();
    expect(w.pool.published.at(-1)?.relays).toEqual([R1, R2]);
    expect(opened(R2)).toBe(1);
    close(R2);
    close(R2); // told twice: nothing more
    // A room joined meanwhile is announced only where this side can hear.
    s.play('two', `${SWARM}-other`);
    s.tick();
    await settle();
    expect(sent(w, 'connect')).toHaveLength(2);
    expect(w.pool.published.at(-1)?.relays).toEqual([R1]);
    expect(opened(R2)).toBe(1);
    // After the retry wait it is subscribed again, and the next round of presence goes to both.
    w.now += SUB_RETRY_S;
    s.tick();
    expect(opened(R2)).toBe(2);
    w.now += PRESENCE_EVERY_S;
    s.tick();
    await settle();
    expect(sent(w, 'connect')).toHaveLength(4);
    expect(w.pool.published.at(-1)?.relays).toEqual([R1, R2]);
    s.stop();
  });

  it('uses fresh keys and session ids at every start', async () => {
    const w = world();
    const { s } = signalerIn(w, 'me');
    s.play('sid', SWARM);
    s.start();
    await settle();
    const first = [s.pubkey, s.keyIn(SWARM)];
    s.start(); // already running: the same session
    expect([s.pubkey, s.keyIn(SWARM)]).toEqual(first);
    s.stop();
    s.stop();
    expect(s.running).toBe(false);
    s.start();
    await settle();
    expect(s.pubkey).not.toBe(first[0]);
    expect(s.keyIn(SWARM)).not.toBe(first[1]);
    const ids = new Set(sent(w, 'connect').map((e) => e.tags.find((t) => t[0] === 'd')?.[1]));
    expect(ids.size).toBe(2);
    s.stop();
  });
});
