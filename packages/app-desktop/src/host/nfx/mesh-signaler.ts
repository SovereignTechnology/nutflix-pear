/**
 * Signaling over Nostr for the app's WebRTC side (NFX-10 §6 `nfx-mesh/1`, ADR 0023, #89): how
 * the worker's WebRTC node meets browsers, nfxd mesh endpoints and other apps, with no tracker.
 * The wire and its checks are `@sovit/core`'s (`nfx/mesh-signal.ts`, `signer/mesh-key.ts`); this
 * is the session: which rooms it is in, presence, who offers, and its bounds.
 *
 * - **Session keys:** random, in memory, never the user's key or the seeder key, wiped at `stop`.
 *   One for the rooms of what this app SEEDS (its beacons already say what it seeds), and a
 *   separate one for each PLAY session, so that what the user watches is not tied, for anyone
 *   reading the relays, to what they seed or to their other plays. Every event is signed when it
 *   is sent.
 * - **Rooms** (one per stream swarm): the rendition of each open play session first, then the
 *   swarms the worker serves (`nfx.rtc.swarms`), at most `MAX_ROOMS`. No room is joined, and
 *   nothing is published, unless the host started the signaler (WebRTC on, a helper, a relay).
 * - **Relays:** one subscription per relay for all rooms (relays cap subscriptions), remade when
 *   the rooms change, every `RESUBSCRIBE_S` regardless, and, with a growing wait, when the relay
 *   closed it. Each relay is subscribed on its own so that one relay's forgery under a real
 *   event's id cannot make the pool drop the real event another relay delivers (§6.5); events
 *   are taken once here, by id, only after they verified.
 * - **Presence:** `connect` on joining a room and every 30 s, to the relays it can hear on;
 *   `disconnect` on leaving and at `stop` (best effort, to the relays last used).
 * - **Connecting (§6.6):** the lower session key offers. On a valid `connect` from a higher key
 *   this side asks the worker for an offer and sends it; on an offer it asks for the answer and
 *   sends that; the answer to its own pending offer is handed to the worker. With both offers in
 *   flight the lower key's stands. An offer unanswered for 15 s, or a connection not open 15 s
 *   after its answer (20 s after answering), has failed.
 * - **A negotiation that ends without an open connection costs its peer a backoff**, whoever
 *   ended it and however (a timeout, its `disconnect`, no relay took the event): 30 s, doubling
 *   to 10 min, before this side offers to that key again, and two thirds of that before it
 *   answers an offer from it (an honest peer's own retry comes after its own 30 s).
 * - **Bounds (§6.5, and this host's own):** 256 peers' presence per room; one negotiation per
 *   peer and 16 per room, of which at most 4 own offers and 4 answered offers not yet open;
 *   `MAX_ROOM_PEERS` connections per room; `MAX_UNOPENED` negotiations of each direction in all;
 *   worker calls (`offer`, `answer`) from token buckets per room and in all, one set per
 *   direction, so a flood of offers cannot starve this side's own; a cancelled call stays
 *   counted until the worker has answered it; 8 offers or answers decrypted per sender per 30 s;
 *   the last 4096 event ids per room; a relay's events past `MAX_EVENTS_PER_S` dropped unread;
 *   SDPs over the worker's limit refused. Only a newer offer replaces a peer's connection.
 * - **The worker** tells it when a connection opens or closes (`nfx.rtc.peer`), and when its
 *   helper went away (`nfx.rtc.reset`): every connection and negotiation went with it, and
 *   connection ids start over.
 *
 * Nothing here logs an SDP, an address or a key.
 */
import type { NostrEvent, NostrFilter, RelayUrl, UnixSeconds } from '@sovit/core';
import { nfx, signer } from '@sovit/core';

import { MAX_NFX_SDP } from '../../ipc/worker-protocol.js';
import type { Logger } from '../log.js';

/** Rooms joined at once: play sessions' first, then served swarms. */
export const MAX_ROOMS = 32;
/** Connections and negotiations with distinct peers in one room (the helper allows 8 a swarm). */
export const MAX_ROOM_PEERS = 8;
export const MAX_PRESENCE = 256;
export const MAX_NEGOTIATIONS = 16;
export const MAX_PENDING_OFFERS = 4;
/** Offers answered in one room whose connections are not open yet. */
export const MAX_PENDING_ANSWERS = 4;
/** Negotiations of one direction in every room together (the helper holds 32 connections). */
export const MAX_UNOPENED = 8;
export const MAX_SEEN_IDS = 4096;
/** Offers and answers decrypted per sender per `DIRECTED_WINDOW_S`. */
export const DIRECTED_PER_WINDOW = 8;
export const DIRECTED_WINDOW_S = 30;
export const PRESENCE_EVERY_S = 30;
export const ANSWER_TIMEOUT_S = 15;
export const OPEN_TIMEOUT_S = 15;
export const ANSWERED_TIMEOUT_S = 20;
export const BACKOFF_S = 30;
export const BACKOFF_MAX_S = 600;
/** How often the served swarms are asked of the worker again. */
export const SWARMS_EVERY_S = 60;
/** A subscription is remade this often even when nothing changed. */
export const RESUBSCRIBE_S = 600;
/** The wait before subscribing again on a relay that closed the subscription; it doubles. */
export const SUB_RETRY_S = 5;
export const SUB_RETRY_MAX_S = 300;
/** A subscription that lived this long before it closed starts that wait over. */
const SUB_STABLE_S = 60;
/** Worker calls of one direction: a burst, then one per `*_REFILL_S`, per room and in all. */
export const ROOM_CALL_BURST = 4;
export const ROOM_CALL_REFILL_S = 5;
export const CALL_BURST = 8;
export const CALL_REFILL_S = 2;
/** Events read per relay per second; the rest are dropped unread. */
export const MAX_EVENTS_PER_S = 100;
/** Senders whose backoff or decrypt count is remembered per room. */
const MAX_REMEMBERED = 1024;
const TICK_MS = 1000;

/** The worker's WebRTC calls (`nfx.rtc.*`). */
export interface MeshRtc {
  offer(swarm: string): Promise<{ readonly peer: number; readonly sdp: string }>;
  answer(swarm: string, offer: string): Promise<{ readonly peer: number; readonly sdp: string }>;
  accept(peer: number, answer: string): Promise<void>;
  hangup(peer: number): Promise<void>;
  swarms(): Promise<readonly string[]>;
}

export interface MeshSignalerDeps {
  /** The signaling relays now (general relays: a scoped relay refuses kind 25050). */
  readonly relays: () => readonly RelayUrl[];
  /**
   * A live subscription on ONE relay; events arrive unverified, and `onClose` is called when the
   * relay or its connection ended it. Returns the unsubscribe.
   */
  readonly subscribe: (
    relay: RelayUrl,
    filter: NostrFilter,
    onEvent: (raw: unknown) => void,
    onClose: () => void,
  ) => () => void;
  /** Sends a signed event; resolves to how many relays accepted it. */
  readonly publish: (relays: readonly RelayUrl[], event: NostrEvent) => Promise<number>;
  readonly rtc: MeshRtc;
  /** Unix seconds. */
  readonly now: () => number;
  readonly log: Logger;
  readonly timers?: {
    readonly setInterval: (fn: () => void, ms: number) => unknown;
    readonly clearInterval: (h: unknown) => void;
  };
}

/** One attempt to connect to one peer; the object is its identity. */
interface Negotiation {
  /** `starting`: the worker is making the offer or the answer. */
  state: 'starting' | 'offered' | 'accepted' | 'answered';
  /** Whether the offer is ours. */
  readonly own: boolean;
  /** The worker's connection id, once it gave one. */
  peer: number | null;
  /** Our offer's event id (`offered`). */
  offerId: string | null;
  /** When the current state began (Unix seconds). */
  at: number;
  /** `created_at` of the offer it is made from. */
  offerAt: number;
  /** Ended; a worker call still in flight cleans up when it settles. */
  cancelled: boolean;
}

interface Presence {
  readonly createdAt: number;
  /** `0` for a `disconnect` (kept until it is 60 s old, so an older `connect` stays dead). */
  readonly expiration: number;
}

interface Backoff {
  readonly failures: number;
  /** No offer to this key before then. */
  readonly until: number;
  /** No answer to an offer from this key before then. */
  readonly inUntil: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

interface Room {
  readonly room: nfx.MeshRoom;
  /** The session this room is joined as: the seeding one, or a play session's. */
  readonly key: signer.MeshSessionKey;
  /** `SEED`, or the play session whose key it is. */
  readonly owner: string;
  readonly presence: Map<string, Presence>;
  readonly negotiations: Map<string, Negotiation>;
  /** Session key → the worker's connection id, and the offer it came from. */
  readonly connected: Map<string, { readonly peer: number; readonly offerAt: number }>;
  readonly backoff: Map<string, Backoff>;
  readonly seen: Set<string>;
  readonly directed: Map<string, number[]>;
  readonly offers: Bucket;
  readonly answers: Bucket;
  /** Cancelled negotiations whose worker call has not settled (still counted in the caps). */
  readonly zombies: Set<Negotiation>;
  /** When `connect` last went out (Unix seconds). */
  announcedAt: number;
}

/** One relay's subscription. */
interface Sub {
  off: () => void;
  /** The room keys it covers. */
  readonly rooms: string;
  readonly at: number;
  /** The relay or its connection ended it. */
  dead: boolean;
  retryAt: number;
  failures: number;
  eventsAt: number;
  events: number;
}

/** A play session id is never this (session ids are not empty). */
const SEED = '';

const realTimers = {
  // `unref`ed: the signaler is never what keeps the host process alive.
  setInterval: (fn: () => void, ms: number): unknown => setInterval(fn, ms).unref(),
  clearInterval: (h: unknown): void => {
    clearInterval(h as ReturnType<typeof setInterval>);
  },
};

function refill(b: Bucket, now: number, burst: number, refillS: number): void {
  // A clock that went backwards refills nothing.
  b.tokens = Math.min(burst, b.tokens + Math.max(0, now - b.at) / refillS);
  b.at = now;
}

/** Remember `k` in a bounded map: the oldest entry goes when it is full. */
function remember<V>(m: Map<string, V>, k: string, v: V): void {
  if (!m.has(k) && m.size >= MAX_REMEMBERED) {
    const oldest = m.keys().next();
    if (oldest.done !== true) m.delete(oldest.value);
  }
  m.set(k, v);
}

export class NfxMeshSignaler {
  private readonly d: MeshSignalerDeps;
  /** The seeding session's key; non-null while running. */
  private seedKey: signer.MeshSessionKey | null = null;
  /** Play session → its own session key (made when its room is joined). */
  private readonly playKeys = new Map<string, signer.MeshSessionKey>();
  private timer: unknown = null;
  /** Room key → room. */
  private readonly rooms = new Map<string, Room>();
  /** Play session → its swarm. */
  private readonly playing = new Map<string, string>();
  private seeded: readonly string[] = [];
  private seededAt = Number.NEGATIVE_INFINITY;
  /** Relay → its subscription. */
  private readonly subs = new Map<string, Sub>();
  /** Where presence last went, for the `disconnect`s of `stop`. */
  private relaysUsed: readonly RelayUrl[] = [];
  /** The worker's connection id → where it belongs. */
  private readonly peers = new Map<number, { readonly room: string; readonly from: string }>();
  private readonly offers: Bucket = { tokens: CALL_BURST, at: 0 };
  private readonly answers: Bucket = { tokens: CALL_BURST, at: 0 };
  private readonly swarmRooms = new Map<string, string>();

  constructor(d: MeshSignalerDeps) {
    this.d = d;
  }

  get running(): boolean {
    return this.seedKey !== null;
  }

  /** The seeding session's key, while running (tests). */
  get pubkey(): string | null {
    return this.seedKey?.pubkey ?? null;
  }

  /** The session key this side uses in `swarm`'s room, if it is in it (tests). */
  keyIn(swarm: string): string | null {
    return this.rooms.get(this.roomKeyOf(swarm))?.key.pubkey ?? null;
  }

  /** Begin a session: fresh keys, the rooms wanted now, and the clock. */
  start(): void {
    if (this.seedKey !== null) return;
    this.seedKey = signer.MeshSessionKey.create();
    const timers = this.d.timers ?? realTimers;
    this.timer = timers.setInterval(() => {
      this.tick();
    }, TICK_MS);
    this.seededAt = Number.NEGATIVE_INFINITY;
    const now = this.d.now();
    for (const b of [this.offers, this.answers]) {
      b.tokens = CALL_BURST;
      b.at = now;
    }
    this.tick();
  }

  /** End the session: leave every room (a `disconnect` each, best effort) and wipe the keys. */
  stop(): void {
    const seedKey = this.seedKey;
    if (seedKey === null) return;
    if (this.timer !== null) (this.d.timers ?? realTimers).clearInterval(this.timer);
    this.timer = null;
    for (const r of [...this.rooms.values()]) this.leave(r);
    for (const s of this.subs.values()) s.off();
    this.subs.clear();
    this.peers.clear();
    this.seeded = [];
    this.seedKey = null;
    seedKey.destroy();
    for (const k of this.playKeys.values()) k.destroy();
    this.playKeys.clear();
  }

  /** A play session opened on `swarm` (its rendition's): join its room first. */
  play(sid: string, swarm: string): void {
    if (sid === SEED) return;
    this.playing.set(sid, swarm);
    // Announced at once: a play wants its peers now, not at the next second.
    if (this.seedKey !== null) this.tick();
  }

  /** That play session closed: its room is left and its key wiped. */
  unplay(sid: string): void {
    if (!this.playing.delete(sid)) return;
    if (this.seedKey !== null) this.reconcile();
    this.playKeys.get(sid)?.destroy();
    this.playKeys.delete(sid);
  }

  /** The worker says a connection opened or closed (`nfx.rtc.peer`). */
  onPeer(e: { readonly peer: number; readonly open: boolean }): void {
    const at = this.peers.get(e.peer);
    if (at === undefined) return;
    const r = this.rooms.get(at.room);
    if (r === undefined) {
      this.peers.delete(e.peer);
      return;
    }
    const n = r.negotiations.get(at.from);
    if (e.open) {
      if (n?.peer !== e.peer) return;
      r.negotiations.delete(at.from);
      n.cancelled = true;
      r.connected.set(at.from, { peer: e.peer, offerAt: n.offerAt });
      r.backoff.delete(at.from);
      return;
    }
    this.peers.delete(e.peer);
    if (r.connected.get(at.from)?.peer === e.peer) r.connected.delete(at.from);
    if (n?.peer === e.peer) this.fail(r, at.from, n, false);
  }

  /**
   * The worker went down, or its WebRTC helper went away (`nfx.rtc.reset`): every connection and
   * negotiation went with it, and connection ids start over, so no id held here means anything.
   * A worker call still in flight is answered by the next helper, if at all: what it made is
   * hung up when it settles.
   */
  reset(): void {
    this.peers.clear();
    for (const r of this.rooms.values()) {
      for (const n of r.negotiations.values()) n.cancelled = true;
      r.negotiations.clear();
      r.connected.clear();
      r.zombies.clear();
    }
    this.seededAt = Number.NEGATIVE_INFINITY;
  }

  /** The clock: served swarms, subscriptions, presence, timeouts. Public so tests can drive it. */
  tick(): void {
    const seedKey = this.seedKey;
    if (seedKey === null) return;
    const now = this.d.now();
    if (now - this.seededAt >= SWARMS_EVERY_S) {
      this.seededAt = now;
      this.d.rtc.swarms().then(
        (swarms) => {
          if (this.seedKey !== seedKey) return;
          this.seeded = swarms;
          this.reconcile();
        },
        () => {
          // The worker is down or WebRTC is off: nothing is served, so no seeding room stands.
          if (this.seedKey !== seedKey) return;
          this.seeded = [];
          this.reconcile();
        },
      );
    }
    this.reconcile();
    // Presence only where this side can hear the answer to it.
    const hearing = this.d.relays().filter((u) => this.subs.get(u)?.dead === false);
    for (const r of this.rooms.values()) {
      if (hearing.length > 0 && now - r.announcedAt >= PRESENCE_EVERY_S) {
        r.announcedAt = now;
        this.send(hearing, () => r.key.presence('connect', r.room, now));
      }
      for (const [from, p] of r.presence) {
        const dead =
          p.expiration === 0 ? now - p.createdAt > nfx.MESH_MAX_AGE : p.expiration <= now;
        if (dead) r.presence.delete(from);
      }
      for (const [from, n] of r.negotiations) {
        if (n.state === 'starting') continue;
        const limit =
          n.state === 'offered'
            ? ANSWER_TIMEOUT_S
            : n.state === 'accepted'
              ? OPEN_TIMEOUT_S
              : ANSWERED_TIMEOUT_S;
        if (now - n.at > limit) this.fail(r, from, n, true);
      }
      for (const [from, times] of r.directed) {
        const fresh = times.filter((t) => now - t < DIRECTED_WINDOW_S);
        if (fresh.length === 0) r.directed.delete(from);
        else r.directed.set(from, fresh);
      }
      for (const [from, b] of r.backoff) {
        // Forgotten once a quiet 10 min has passed: the count starts over.
        if (now - b.until > BACKOFF_MAX_S) r.backoff.delete(from);
      }
    }
  }

  /** Join and leave rooms to match what is wanted, and keep the subscriptions on them. */
  private reconcile(): void {
    const seedKey = this.seedKey;
    if (seedKey === null) return;
    // Room key → its swarm and whose room it is. A swarm this app seeds is the seeding session's
    // even while it is played; a play-only one is its (first) play session's.
    const wanted = new Map<string, { readonly swarm: string; readonly owner: string }>();
    const seededRooms = new Set(this.seeded.map((s) => this.roomKeyOf(s)));
    for (const [sid, swarm] of this.playing) {
      if (wanted.size >= MAX_ROOMS) break;
      const k = this.roomKeyOf(swarm);
      if (!wanted.has(k)) wanted.set(k, { swarm, owner: seededRooms.has(k) ? SEED : sid });
    }
    for (const swarm of this.seeded) {
      if (wanted.size >= MAX_ROOMS) break;
      const k = this.roomKeyOf(swarm);
      if (!wanted.has(k)) wanted.set(k, { swarm, owner: SEED });
    }
    const relays = this.d.relays();
    if (relays.length > 0) this.relaysUsed = [...relays];
    const now = this.d.now();
    for (const [k, r] of [...this.rooms]) {
      // Left, or to be joined again as another session (its play session closed, or the swarm
      // is seeded now).
      if (wanted.get(k)?.owner !== r.owner) this.leave(r);
    }
    for (const [k, w] of wanted) {
      if (this.rooms.has(k)) continue;
      let key = seedKey;
      if (w.owner !== SEED) {
        key = this.playKeys.get(w.owner) ?? signer.MeshSessionKey.create();
        this.playKeys.set(w.owner, key);
      }
      this.rooms.set(k, {
        room: nfx.meshRoom(w.swarm),
        key,
        owner: w.owner,
        presence: new Map(),
        negotiations: new Map(),
        connected: new Map(),
        backoff: new Map(),
        seen: new Set(),
        directed: new Map(),
        offers: { tokens: ROOM_CALL_BURST, at: now },
        answers: { tokens: ROOM_CALL_BURST, at: now },
        zombies: new Set(),
        // Announced by the next tick, once the subscriptions below are up.
        announcedAt: Number.NEGATIVE_INFINITY,
      });
    }
    this.subscribe(relays, now);
  }

  /** One subscription per relay on every room: opened, remade when stale, retried when closed. */
  private subscribe(relays: readonly RelayUrl[], now: number): void {
    for (const [relay, s] of [...this.subs]) {
      if (this.rooms.size > 0 && relays.some((u) => u === relay)) continue;
      s.off();
      this.subs.delete(relay);
    }
    if (this.rooms.size === 0) return;
    const rooms = [...this.rooms.keys()].sort();
    const cover = rooms.join(' ');
    const filter: NostrFilter = {
      kinds: [nfx.KIND_MESH_SIGNAL],
      '#P': rooms,
      since: (now - nfx.MESH_MAX_AGE) as UnixSeconds,
    };
    for (const relay of relays) {
      const old = this.subs.get(relay);
      if (old !== undefined) {
        const due = old.dead
          ? now >= old.retryAt
          : old.rooms !== cover || now - old.at >= RESUBSCRIBE_S;
        if (!due) continue;
        old.off();
      }
      const sub: Sub = {
        off: () => undefined,
        rooms: cover,
        at: now,
        dead: false,
        retryAt: 0,
        failures: old?.dead === true ? old.failures : 0,
        eventsAt: now,
        events: 0,
      };
      let live = true;
      this.subs.set(relay, sub);
      const off = this.d.subscribe(
        relay,
        filter,
        (raw) => {
          if (!live) return;
          // A relay that floods is read no faster than this.
          const t = this.d.now();
          if (t !== sub.eventsAt) {
            sub.eventsAt = t;
            sub.events = 0;
          }
          sub.events += 1;
          if (sub.events <= MAX_EVENTS_PER_S) this.onEvent(raw);
        },
        () => {
          // Deaf on this relay until it is subscribed again: no presence goes there meanwhile.
          if (!live || sub.dead) return;
          const t = this.d.now();
          sub.dead = true;
          sub.failures = t - sub.at >= SUB_STABLE_S ? 1 : sub.failures + 1;
          sub.retryAt = t + Math.min(SUB_RETRY_S * 2 ** (sub.failures - 1), SUB_RETRY_MAX_S);
        },
      );
      sub.off = () => {
        live = false;
        off();
      };
    }
  }

  /** Leave a room: its connections and negotiations end, and a `disconnect` goes out. */
  private leave(r: Room): void {
    if (this.rooms.get(r.room.key) !== r) return;
    this.rooms.delete(r.room.key);
    for (const n of r.negotiations.values()) {
      n.cancelled = true;
      this.hangup(n.peer);
    }
    for (const c of r.connected.values()) this.hangup(c.peer);
    for (const [peer, at] of [...this.peers]) if (at.room === r.room.key) this.peers.delete(peer);
    // Only where a `connect` went: a room never announced has nobody to tell.
    if (!Number.isFinite(r.announcedAt)) return;
    const relays = this.d.relays();
    const to = relays.length > 0 ? relays : this.relaysUsed;
    const now = this.d.now();
    if (to.length > 0) this.send(to, () => r.key.presence('disconnect', r.room, now));
  }

  /** The room key of `swarm` (derivation cached: it is a hash chain and a point multiplication). */
  private roomKeyOf(swarm: string): string {
    let k = this.swarmRooms.get(swarm);
    if (k === undefined) {
      if (this.swarmRooms.size > 4 * MAX_ROOMS) this.swarmRooms.clear();
      k = nfx.meshRoom(swarm).key;
      this.swarmRooms.set(swarm, k);
    }
    return k;
  }

  /** One event off a relay: for one of our rooms, read as §6.5 says, taken once. */
  private onEvent(raw: unknown): void {
    if (this.seedKey === null || typeof raw !== 'object' || raw === null) return;
    let roomKey: unknown;
    let id: unknown;
    try {
      const tags = (raw as { readonly tags?: unknown }).tags;
      if (!Array.isArray(tags) || tags.length > 32) return;
      const p: unknown = tags.find((t: unknown) => Array.isArray(t) && t[0] === 'P');
      roomKey = Array.isArray(p) ? p[1] : undefined;
      id = (raw as { readonly id?: unknown }).id;
    } catch {
      return;
    }
    const r = typeof roomKey === 'string' ? this.rooms.get(roomKey) : undefined;
    if (r === undefined) return;
    if (typeof id === 'string' && r.seen.has(id)) return;
    const now = this.d.now();
    const key = r.key;
    const read = nfx.readMeshEvent(raw, {
      room: r.room.key,
      now,
      self: key.pubkey,
      decrypt: (from, content) => {
        const fresh = (r.directed.get(from) ?? []).filter((t) => now - t < DIRECTED_WINDOW_S);
        if (fresh.length >= DIRECTED_PER_WINDOW) return undefined;
        fresh.push(now);
        remember(r.directed, from, fresh);
        return key.decrypt(from, content);
      },
    });
    if (read.kind === 'ignored' || read.kind === 'dropped') return;
    // Only ids of events that passed: a forgery under a real id must not hide the real one.
    r.seen.add(read.id);
    if (r.seen.size > MAX_SEEN_IDS) {
      const oldest = r.seen.values().next();
      if (oldest.done !== true) r.seen.delete(oldest.value);
    }
    switch (read.kind) {
      case 'connect':
      case 'disconnect': {
        const known = r.presence.get(read.from);
        const expiration = read.kind === 'connect' ? read.expiration : 0;
        // The newest wins; a disconnect wins a tie with a connect of the same second.
        if (
          known !== undefined &&
          (known.createdAt > read.createdAt ||
            (known.createdAt === read.createdAt && known.expiration === 0))
        )
          return;
        if (known === undefined && r.presence.size >= MAX_PRESENCE && !this.evictPresence(r))
          return;
        r.presence.set(read.from, { createdAt: read.createdAt, expiration });
        if (read.kind === 'connect') this.maybeOffer(r, read.from);
        else {
          // It left mid-negotiation: that negotiation ended unopened.
          const n = r.negotiations.get(read.from);
          if (n !== undefined) this.fail(r, read.from, n, true);
        }
        return;
      }
      case 'offer':
        this.onOffer(r, read.from, read.id, read.sdp, read.createdAt);
        return;
      case 'answer':
        this.onAnswer(r, read.from, read.offerId, read.sdp);
        return;
    }
  }

  /** Make room in a full presence book: the entry nearest its end that nothing depends on. */
  private evictPresence(r: Room): boolean {
    let victim: string | null = null;
    let soonest = Number.POSITIVE_INFINITY;
    for (const [from, p] of r.presence) {
      if (r.connected.has(from) || r.negotiations.has(from)) continue;
      if (p.expiration < soonest) {
        soonest = p.expiration;
        victim = from;
      }
    }
    if (victim === null) return false;
    r.presence.delete(victim);
    return true;
  }

  /** Distinct peers this room is connected to or negotiating with. */
  private peersIn(r: Room): number {
    let n = r.connected.size + r.zombies.size;
    for (const from of r.negotiations.keys()) if (!r.connected.has(from)) n += 1;
    return n;
  }

  /** `r`'s negotiations of one direction, the cancelled ones still with the worker included. */
  private pending(r: Room, own: boolean): number {
    let c = 0;
    for (const n of r.negotiations.values()) if (n.own === own) c += 1;
    for (const n of r.zombies) if (n.own === own) c += 1;
    return c;
  }

  /** Whether a worker call of this direction may be made for `r` now; takes its tokens. */
  private mayCall(r: Room, own: boolean, now: number): boolean {
    if (r.negotiations.size + r.zombies.size >= MAX_NEGOTIATIONS) return false;
    let all = 0;
    for (const x of this.rooms.values()) all += this.pending(x, own);
    if (all >= MAX_UNOPENED) return false;
    const [room, total] = own ? [r.offers, this.offers] : [r.answers, this.answers];
    refill(room, now, ROOM_CALL_BURST, ROOM_CALL_REFILL_S);
    refill(total, now, CALL_BURST, CALL_REFILL_S);
    if (room.tokens < 1 || total.tokens < 1) return false;
    room.tokens -= 1;
    total.tokens -= 1;
    return true;
  }

  private begin(own: boolean, now: number, offerAt: number): Negotiation {
    return {
      state: 'starting',
      own,
      peer: null,
      offerId: null,
      at: now,
      offerAt,
      cancelled: false,
    };
  }

  /** §6.6: on a valid `connect` from a higher key we are not connected or connecting to. */
  private maybeOffer(r: Room, to: string): void {
    const key = r.key;
    if (!(key.pubkey < to)) return;
    if (r.connected.has(to) || r.negotiations.has(to)) return;
    const now = this.d.now();
    const back = r.backoff.get(to);
    if (back !== undefined && back.until > now) return;
    if (this.peersIn(r) >= MAX_ROOM_PEERS || this.pending(r, true) >= MAX_PENDING_OFFERS) return;
    const relays = this.d.relays();
    if (relays.length === 0 || !this.mayCall(r, true, now)) return;
    const n = this.begin(true, now, now);
    r.negotiations.set(to, n);
    void (async () => {
      let made: { readonly peer: number; readonly sdp: string };
      try {
        made = await this.d.rtc.offer(r.room.swarm);
      } catch {
        this.settle(r, to, n, false);
        return;
      }
      n.peer = made.peer;
      if (!this.settle(r, to, n, true)) return;
      try {
        const at = this.d.now();
        const event = key.offer(r.room, to, made.sdp, at);
        this.peers.set(made.peer, { room: r.room.key, from: to });
        n.state = 'offered';
        n.offerId = event.id;
        n.at = at;
        n.offerAt = at;
        if ((await this.d.publish(relays, event)) === 0) this.fail(r, to, n, true);
      } catch {
        // The SDP could not be signaled, or publishing threw.
        this.fail(r, to, n, true);
      }
    })();
  }

  private onOffer(r: Room, from: string, offerId: string, sdp: string, offerAt: number): void {
    const key = r.key;
    if (sdp.length > MAX_NFX_SDP) return;
    const now = this.d.now();
    // A peer whose last negotiation ended unopened waits before it is answered again.
    const back = r.backoff.get(from);
    if (back !== undefined && back.inUntil > now) return;
    const old = r.connected.get(from);
    // Only a newer offer replaces a connection: a replayed one must not tear it down.
    if (old !== undefined && offerAt <= old.offerAt) return;
    const pending = r.negotiations.get(from);
    // One negotiation per peer. Glare (§6.6): with our own offer to them pending, the lower
    // key's offer stands.
    if (pending !== undefined && (!pending.own || key.pubkey < from)) return;
    if (old === undefined && pending === undefined && this.peersIn(r) >= MAX_ROOM_PEERS) return;
    if (this.pending(r, false) >= MAX_PENDING_ANSWERS) return;
    const relays = this.d.relays();
    if (relays.length === 0 || !this.mayCall(r, false, now)) return;
    // Ours gives way (we are the higher key).
    if (pending !== undefined) this.drop(r, from, pending, true);
    const n = this.begin(false, now, offerAt);
    r.negotiations.set(from, n);
    // A peer that connects again replaces its old connection.
    if (old !== undefined) {
      r.connected.delete(from);
      this.peers.delete(old.peer);
      this.hangup(old.peer);
    }
    void (async () => {
      let made: { readonly peer: number; readonly sdp: string };
      try {
        made = await this.d.rtc.answer(r.room.swarm, sdp);
      } catch {
        this.settle(r, from, n, false);
        return;
      }
      n.peer = made.peer;
      if (!this.settle(r, from, n, true)) return;
      try {
        const at = this.d.now();
        const event = key.answer(r.room, from, offerId, made.sdp, at);
        this.peers.set(made.peer, { room: r.room.key, from });
        n.state = 'answered';
        n.at = at;
        if ((await this.d.publish(relays, event)) === 0) this.fail(r, from, n, true);
      } catch {
        this.fail(r, from, n, true);
      }
    })();
  }

  private onAnswer(r: Room, from: string, offerId: string, sdp: string): void {
    const n = r.negotiations.get(from);
    // Only the answer that names our pending offer.
    if (n?.state !== 'offered' || n.peer === null || n.offerId !== offerId) return;
    if (sdp.length > MAX_NFX_SDP) {
      this.fail(r, from, n, true);
      return;
    }
    n.state = 'accepted';
    n.at = this.d.now();
    this.d.rtc.accept(n.peer, sdp).catch(() => {
      this.fail(r, from, n, true);
    });
  }

  /**
   * The worker call that began `n` came back (`ok`: with a connection). Returns whether `n` goes
   * on. One that was cancelled meanwhile ends here: what the worker made for it is hung up and
   * its place in the counts freed.
   */
  private settle(r: Room, from: string, n: Negotiation, ok: boolean): boolean {
    if (n.cancelled) {
      r.zombies.delete(n);
      this.hangup(n.peer);
      return false;
    }
    if (ok) return true;
    // The worker refused (WebRTC off, at its limits, their SDP, down). Wait before asking it
    // again for this peer, without counting a failure against the peer.
    n.cancelled = true;
    if (r.negotiations.get(from) === n) r.negotiations.delete(from);
    const until = this.d.now() + BACKOFF_S;
    remember(r.backoff, from, {
      failures: r.backoff.get(from)?.failures ?? 0,
      until,
      inUntil: until,
    });
    return false;
  }

  /** A negotiation that ended without an open connection (§6.6): its peer waits. */
  private fail(r: Room, from: string, n: Negotiation, hangup: boolean): void {
    if (n.cancelled) return;
    this.drop(r, from, n, hangup);
    const failures = (r.backoff.get(from)?.failures ?? 0) + 1;
    const wait = Math.min(BACKOFF_S * 2 ** (failures - 1), BACKOFF_MAX_S);
    const now = this.d.now();
    remember(r.backoff, from, {
      failures,
      until: now + wait,
      inUntil: now + Math.floor((wait * 2) / 3),
    });
  }

  /**
   * End a negotiation and hang its connection up on the worker's side. One whose worker call is
   * still in flight stays counted (`zombies`) until that call settles.
   */
  private drop(r: Room, from: string, n: Negotiation, hangup: boolean): void {
    if (n.cancelled) return;
    n.cancelled = true;
    if (r.negotiations.get(from) === n) r.negotiations.delete(from);
    if (n.peer === null) {
      if (n.state === 'starting') r.zombies.add(n);
      return;
    }
    this.peers.delete(n.peer);
    if (hangup) this.hangup(n.peer);
  }

  private hangup(peer: number | null): void {
    if (peer !== null) this.d.rtc.hangup(peer).catch(() => undefined);
  }

  /** Sign now and send; a failure is the relays' and is not retried (the event would be stale). */
  private send(relays: readonly RelayUrl[], make: () => NostrEvent): void {
    try {
      this.d.publish(relays, make()).catch(() => undefined);
    } catch {
      this.d.log.warn('nfx mesh: an event could not be signed');
    }
  }
}
