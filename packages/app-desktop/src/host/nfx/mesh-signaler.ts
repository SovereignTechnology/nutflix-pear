/**
 * Signaling over Nostr for the app's WebRTC side (NFX-10 §6 `nfx-mesh/1`, ADR 0023, #89): how
 * the worker's WebRTC node meets browsers, nfxd mesh endpoints and other apps, with no tracker.
 * The wire and its checks are `@sovit/core`'s (`nfx/mesh-signal.ts`, `signer/mesh-key.ts`); this
 * is the session: which rooms it is in, presence, who offers, and its bounds.
 *
 * - **A session key per run** of the signaler (`start` … `stop`): random, in memory, never the
 *   user's key or the seeder key. Every event is signed when it is sent.
 * - **Rooms** (one per stream swarm): the rendition of each open play session first, then the
 *   swarms the worker serves (`nfx.rtc.swarms`), at most `MAX_ROOMS`. One relay subscription
 *   covers them all (relays cap subscriptions per connection), remade when the set changes.
 * - **Presence:** `connect` on joining a room and every 30 s, `disconnect` on leaving (best
 *   effort).
 * - **Connecting (§6.6):** the lower session key offers. On a valid `connect` from a higher key
 *   this side asks the worker for an offer and sends it; on an offer it asks for the answer and
 *   sends that; the answer to its own pending offer is handed to the worker. With both offers in
 *   flight the lower key's stands. An offer unanswered for 15 s, or a connection not open 15 s
 *   after its answer (20 s after answering), has failed: the worker's side is hung up, and the
 *   next offer to that peer waits 30 s, doubling to 10 min.
 * - **Bounds (§6.5):** 256 peers' presence per room; one negotiation per peer and 16 per room, 4
 *   of them own offers awaiting an answer; `MAX_ROOM_PEERS` connections per room (the helper's
 *   cap); 8 offers or answers decrypted per sender per 30 s; the last 4096 event ids per room;
 *   SDPs over the worker's limit refused.
 * - **The worker** tells it when a connection opens or closes (`nfx.rtc.peer`); a worker that
 *   went down took every connection with it.
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
  /** A live subscription on `relays`; events arrive unverified. Returns the unsubscribe. */
  readonly subscribe: (
    relays: readonly RelayUrl[],
    filter: NostrFilter,
    onEvent: (raw: unknown) => void,
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

type Negotiation =
  /** Asking the worker for an offer or an answer. */
  | { readonly state: 'starting'; readonly own: boolean; peer: number | null }
  /** Our offer is out. */
  | {
      readonly state: 'offered';
      readonly peer: number;
      readonly offerId: string;
      readonly at: number;
    }
  /** The answer to our offer is with the worker; the connection is not open yet. */
  | { readonly state: 'accepted'; readonly peer: number; readonly at: number }
  /** We answered their offer; the connection is not open yet. */
  | { readonly state: 'answered'; readonly peer: number; readonly at: number };

interface Presence {
  readonly createdAt: number;
  /** `0` for a `disconnect` (kept until it is 60 s old, so an older `connect` stays dead). */
  readonly expiration: number;
}

interface Room {
  readonly room: nfx.MeshRoom;
  readonly presence: Map<string, Presence>;
  readonly negotiations: Map<string, Negotiation>;
  /** Session key → the worker's connection id. */
  readonly connected: Map<string, number>;
  readonly backoff: Map<string, { failures: number; until: number }>;
  readonly seen: Set<string>;
  readonly directed: Map<string, number[]>;
  /** When `connect` last went out (Unix seconds). */
  announcedAt: number;
}

const realTimers = {
  setInterval: (fn: () => void, ms: number): unknown => setInterval(fn, ms),
  clearInterval: (h: unknown): void => {
    clearInterval(h as ReturnType<typeof setInterval>);
  },
};

export class NfxMeshSignaler {
  private readonly d: MeshSignalerDeps;
  private key: signer.MeshSessionKey | null = null;
  private timer: unknown = null;
  /** Room key → room. */
  private readonly rooms = new Map<string, Room>();
  /** Play session → its swarm. */
  private readonly playing = new Map<string, string>();
  private seeded: readonly string[] = [];
  private seededAt = Number.NEGATIVE_INFINITY;
  private unsubscribe: (() => void) | null = null;
  /** What the live subscription covers: its relays and room keys. */
  private subscribed = '';
  /** The worker's connection id → where it belongs. */
  private readonly peers = new Map<number, { readonly room: string; readonly from: string }>();

  constructor(d: MeshSignalerDeps) {
    this.d = d;
  }

  get running(): boolean {
    return this.key !== null;
  }

  /** This session's key, while running (tests and logs' prefix only). */
  get pubkey(): string | null {
    return this.key?.pubkey ?? null;
  }

  /** Begin a session: a fresh key, the rooms wanted now, and the clock. */
  start(): void {
    if (this.key !== null) return;
    this.key = signer.MeshSessionKey.create();
    const timers = this.d.timers ?? realTimers;
    this.timer = timers.setInterval(() => {
      this.tick();
    }, TICK_MS);
    this.seededAt = Number.NEGATIVE_INFINITY;
    this.tick();
  }

  /** End the session: leave every room (a `disconnect` each, best effort) and wipe the key. */
  stop(): void {
    const key = this.key;
    if (key === null) return;
    if (this.timer !== null) (this.d.timers ?? realTimers).clearInterval(this.timer);
    this.timer = null;
    const relays = this.d.relays();
    const now = this.d.now();
    for (const r of this.rooms.values()) {
      for (const n of r.negotiations.values()) this.hangup(n.peer);
      if (relays.length > 0) this.send(relays, () => key.presence('disconnect', r.room, now));
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.subscribed = '';
    this.rooms.clear();
    this.peers.clear();
    this.seeded = [];
    this.key = null;
    key.destroy();
  }

  /** A play session opened on `swarm` (its rendition's): join its room first. */
  play(sid: string, swarm: string): void {
    this.playing.set(sid, swarm);
    if (this.key !== null) this.reconcile();
  }

  /** That play session closed. */
  unplay(sid: string): void {
    if (this.playing.delete(sid) && this.key !== null) this.reconcile();
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
      r.connected.set(at.from, e.peer);
      r.backoff.delete(at.from);
      return;
    }
    this.peers.delete(e.peer);
    if (r.connected.get(at.from) === e.peer) r.connected.delete(at.from);
    if (n?.peer === e.peer) this.fail(r, at.from, n, false);
  }

  /** The worker went down: every connection and negotiation went with it. */
  onWorkerDown(): void {
    this.peers.clear();
    for (const r of this.rooms.values()) {
      r.negotiations.clear();
      r.connected.clear();
    }
    this.seededAt = Number.NEGATIVE_INFINITY;
  }

  /** The clock: served swarms, presence, timeouts. Public so tests can drive it. */
  tick(): void {
    const key = this.key;
    if (key === null) return;
    const now = this.d.now();
    if (now - this.seededAt >= SWARMS_EVERY_S) {
      this.seededAt = now;
      this.d.rtc.swarms().then(
        (swarms) => {
          if (this.key !== key) return;
          this.seeded = swarms;
          this.reconcile();
        },
        () => undefined, // the worker is down or WebRTC is off: the play rooms stand
      );
    }
    this.reconcile();
    const relays = this.d.relays();
    for (const r of this.rooms.values()) {
      if (relays.length > 0 && now - r.announcedAt >= PRESENCE_EVERY_S) {
        r.announcedAt = now;
        this.send(relays, () => key.presence('connect', r.room, now));
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

  /** Join and leave rooms to match what is wanted, and keep one subscription for them all. */
  private reconcile(): void {
    const key = this.key;
    if (key === null) return;
    const wanted = new Map<string, nfx.MeshRoom>();
    for (const swarm of [...new Set(this.playing.values()), ...this.seeded]) {
      if (wanted.size >= MAX_ROOMS) break;
      const room = this.rooms.get(this.roomKeyOf(swarm))?.room ?? nfx.meshRoom(swarm);
      if (!wanted.has(room.key)) wanted.set(room.key, room);
    }
    const relays = this.d.relays();
    const now = this.d.now();
    for (const [k, r] of [...this.rooms]) {
      if (wanted.has(k)) continue;
      this.rooms.delete(k);
      for (const n of r.negotiations.values()) this.hangup(n.peer);
      for (const [peer, at] of [...this.peers]) if (at.room === k) this.peers.delete(peer);
      if (relays.length > 0) this.send(relays, () => key.presence('disconnect', r.room, now));
    }
    for (const [k, room] of wanted) {
      if (this.rooms.has(k)) continue;
      this.rooms.set(k, {
        room,
        presence: new Map(),
        negotiations: new Map(),
        connected: new Map(),
        backoff: new Map(),
        seen: new Set(),
        directed: new Map(),
        // Announced by the next tick, once the subscription below is up.
        announcedAt: Number.NEGATIVE_INFINITY,
      });
    }
    const cover = `${relays.join(' ')}|${[...this.rooms.keys()].sort().join(' ')}`;
    if (cover === this.subscribed) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.subscribed = cover;
    if (relays.length === 0 || this.rooms.size === 0) return;
    const filter: NostrFilter = {
      kinds: [nfx.KIND_MESH_SIGNAL],
      '#P': [...this.rooms.keys()],
      since: (now - nfx.MESH_MAX_AGE) as UnixSeconds,
    };
    this.unsubscribe = this.d.subscribe(relays, filter, (raw) => {
      this.onEvent(raw);
    });
  }

  private readonly swarmRooms = new Map<string, string>();

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
    const key = this.key;
    if (key === null || typeof raw !== 'object' || raw === null) return;
    const tags = (raw as { readonly tags?: unknown }).tags;
    if (!Array.isArray(tags) || tags.length > 32) return;
    const p: unknown = tags.find((t: unknown) => Array.isArray(t) && t[0] === 'P');
    const roomKey: unknown = Array.isArray(p) ? p[1] : undefined;
    const r = typeof roomKey === 'string' ? this.rooms.get(roomKey) : undefined;
    if (r === undefined) return;
    const id = (raw as { readonly id?: unknown }).id;
    if (typeof id === 'string' && r.seen.has(id)) return;
    const now = this.d.now();
    const read = nfx.readMeshEvent(raw, {
      room: r.room.key,
      now,
      self: key.pubkey,
      decrypt: (from, content) => {
        const times = r.directed.get(from) ?? [];
        const fresh = times.filter((t) => now - t < DIRECTED_WINDOW_S);
        if (fresh.length >= DIRECTED_PER_WINDOW) return undefined;
        fresh.push(now);
        if (r.directed.size < 4 * MAX_PRESENCE || r.directed.has(from)) r.directed.set(from, fresh);
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
        if (known === undefined && r.presence.size >= MAX_PRESENCE) return;
        r.presence.set(read.from, { createdAt: read.createdAt, expiration });
        if (read.kind === 'connect') this.maybeOffer(r, read.from);
        else {
          const n = r.negotiations.get(read.from);
          if (n !== undefined) this.drop(r, read.from, n);
        }
        return;
      }
      case 'offer':
        this.onOffer(r, read.from, read.id, read.sdp);
        return;
      case 'answer':
        this.onAnswer(r, read.from, read.offerId, read.sdp);
        return;
    }
  }

  private roomFor(r: Room): boolean {
    return this.rooms.get(r.room.key) === r;
  }

  /** Distinct peers this room is connected to or negotiating with. */
  private peersIn(r: Room): number {
    let n = r.connected.size;
    for (const from of r.negotiations.keys()) if (!r.connected.has(from)) n += 1;
    return n;
  }

  private pendingOffers(r: Room): number {
    let n = 0;
    for (const x of r.negotiations.values())
      if (x.state === 'offered' || (x.state === 'starting' && x.own)) n += 1;
    return n;
  }

  /** §6.6: on a valid `connect` from a higher key we are not connected or connecting to. */
  private maybeOffer(r: Room, to: string): void {
    const key = this.key;
    if (key === null || !(key.pubkey < to)) return;
    if (r.connected.has(to) || r.negotiations.has(to)) return;
    const now = this.d.now();
    const back = r.backoff.get(to);
    if (back !== undefined && back.until > now) return;
    if (
      this.peersIn(r) >= MAX_ROOM_PEERS ||
      r.negotiations.size >= MAX_NEGOTIATIONS ||
      this.pendingOffers(r) >= MAX_PENDING_OFFERS
    )
      return;
    const relays = this.d.relays();
    if (relays.length === 0) return;
    const n: Negotiation = { state: 'starting', own: true, peer: null };
    r.negotiations.set(to, n);
    void (async () => {
      try {
        const made = await this.d.rtc.offer(r.room.swarm);
        n.peer = made.peer;
        if (!this.current(r, to, n, key)) {
          this.hangup(made.peer);
          return;
        }
        const at = this.d.now();
        const event = key.offer(r.room, to, made.sdp, at);
        this.peers.set(made.peer, { room: r.room.key, from: to });
        r.negotiations.set(to, { state: 'offered', peer: made.peer, offerId: event.id, at });
        const accepted = await this.d.publish(relays, event);
        const still = r.negotiations.get(to);
        if (accepted === 0 && still?.state === 'offered' && still.offerId === event.id)
          this.fail(r, to, still, true);
      } catch {
        // The worker refused (WebRTC off, at its limits, down) or the SDP could not be sent.
        const still = r.negotiations.get(to);
        if (still !== undefined && (still === n || still.peer === n.peer))
          this.fail(r, to, still, true);
      }
    })();
  }

  private onOffer(r: Room, from: string, offerId: string, sdp: string): void {
    const key = this.key;
    if (key === null || sdp.length > MAX_NFX_SDP) return;
    const pending = r.negotiations.get(from);
    if (pending !== undefined) {
      // Glare (§6.6): with our own offer to them pending, the lower key's offer stands.
      const ours = pending.state === 'offered' || (pending.state === 'starting' && pending.own);
      if (!ours || key.pubkey < from) return;
      this.drop(r, from, pending);
    } else if (r.negotiations.size >= MAX_NEGOTIATIONS) return;
    const old = r.connected.get(from);
    if (old === undefined && this.peersIn(r) >= MAX_ROOM_PEERS) return;
    const relays = this.d.relays();
    if (relays.length === 0) return;
    const n: Negotiation = { state: 'starting', own: false, peer: null };
    r.negotiations.set(from, n);
    void (async () => {
      try {
        // A peer that connects again replaces its old connection.
        if (old !== undefined) {
          r.connected.delete(from);
          this.hangup(old);
        }
        const made = await this.d.rtc.answer(r.room.swarm, sdp);
        n.peer = made.peer;
        if (!this.current(r, from, n, key)) {
          this.hangup(made.peer);
          return;
        }
        const at = this.d.now();
        const event = key.answer(r.room, from, offerId, made.sdp, at);
        this.peers.set(made.peer, { room: r.room.key, from });
        r.negotiations.set(from, { state: 'answered', peer: made.peer, at });
        await this.d.publish(relays, event);
      } catch {
        const still = r.negotiations.get(from);
        if (still !== undefined && (still === n || still.peer === n.peer))
          this.drop(r, from, still);
      }
    })();
  }

  private onAnswer(r: Room, from: string, offerId: string, sdp: string): void {
    const n = r.negotiations.get(from);
    // Only the answer that names our pending offer.
    if (n?.state !== 'offered' || n.offerId !== offerId) return;
    if (sdp.length > MAX_NFX_SDP) {
      this.fail(r, from, n, true);
      return;
    }
    const next: Negotiation = { state: 'accepted', peer: n.peer, at: this.d.now() };
    r.negotiations.set(from, next);
    this.d.rtc.accept(n.peer, sdp).catch(() => {
      if (r.negotiations.get(from) === next) this.fail(r, from, next, true);
    });
  }

  /** Whether `n` is still this room's negotiation with `from`, in this session. */
  private current(r: Room, from: string, n: Negotiation, key: signer.MeshSessionKey): boolean {
    return this.key === key && this.roomFor(r) && r.negotiations.get(from) === n;
  }

  /** A negotiation that failed (§6.6): gone, and the next offer to that peer waits. */
  private fail(r: Room, from: string, n: Negotiation, hangup: boolean): void {
    this.drop(r, from, n, hangup);
    const failures = (r.backoff.get(from)?.failures ?? 0) + 1;
    const wait = Math.min(BACKOFF_S * 2 ** (failures - 1), BACKOFF_MAX_S);
    if (r.backoff.size < 4 * MAX_PRESENCE || r.backoff.has(from))
      r.backoff.set(from, { failures, until: this.d.now() + wait });
  }

  /** Forget a negotiation and hang its connection up on the worker's side. */
  private drop(r: Room, from: string, n: Negotiation, hangup = true): void {
    if (r.negotiations.get(from) === n) r.negotiations.delete(from);
    if (n.peer !== null) {
      this.peers.delete(n.peer);
      if (hangup) this.hangup(n.peer);
    }
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
