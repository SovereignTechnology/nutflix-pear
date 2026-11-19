/**
 * OnePeerRouter — every block a downloader asks the swarm for travels from ONE peer (security
 * review F33; Cameron, 2026-09-24: "request each range from a single seeder — no duplicates,
 * seeders paid fairly"), and no peer is ever asked for more blocks than its credit allows
 * (issue #8: the viewer's credit sized per seeder window). ADR 0018.
 *
 * WHY THIS REACHES INTO HYPERCORE. Hypercore chooses the peer a request goes to and offers no
 * public way to choose it. Its normal paths already give a block to one peer at a time: a queued
 * `get` is taken by the first peer able to serve it, and a range block is skipped while a request
 * for it is in flight. The one path that asks a SECOND peer for a block already in flight is the
 * hotswap (`Replicator._updateHotswap`): whenever a peer has spare capacity it re-requests blocks
 * in flight elsewhere (up to three peers per block); the first answer wins and the others are
 * cancelled, which is too late once they were sent. Each seeder counts what it sent and must be
 * paid for it (not paying window-cuts it), so a raced block is paid twice. Measured on piped
 * streams, three full seeders and 48 blocks read at once: 65–67 deliveries without this router,
 * 48 with it.
 *
 * What it changes on each attached core (hypercore 11.40.3; `__tests__/one-peer-router.test.ts`
 * pins every internal named here and fails loudly when one moves):
 *
 *   1. `replicator.hotswaps` becomes a queue that never races. `pick(peer)` yields a block only
 *      when its single request has STALLED (below), and as the replacement request goes out the
 *      stalled one is CANCELLED: a failover to one other peer, never two peers at once.
 *   2. Each replication `Peer`'s `getMaxInflight()` — hypercore's per-peer pipelining cap, read
 *      before every request it makes to that peer — is capped at
 *      `inflight + budget(remote, core) − used(remote)`, so what is outstanding at a peer never
 *      exceeds its credit, whichever blocks hypercore picks. Only the `UNCAPPED` sentinel leaves
 *      hypercore's own cap; anything else that is not a finite number ≥ 1 asks nothing.
 *   3. `refresh()` re-runs hypercore's scheduler (`updateAll()`) after a budget grew (an ACK, a
 *      HELLO), and while a request is stalled a ticker runs `updatePeer()` so a failover can fire.
 *   4. (lane P2-owed-viewer, ADR 0018 amendment) with the `single` option, a peer whose count is
 *      not known yet — its `pay/1` report is not in — is asked one block at a time on the cores
 *      it counts.
 *   5. (lane P2-owed-viewer, ADR 0015 amendment) with the `free` option, a peer that serves a core
 *      outside payment (its `PRICE { free: true }`) is capped on that core by the budget alone:
 *      what it may count on its other cores does not hold that core back, and nothing asked of it
 *      there — in flight, cancelled or lost with a peer — is ever counted in `used` or `debt`.
 *   6. (lane W8b-p2p, round-8 review) with the `room` option, the free requests out at a peer and
 *      what it may count share its window while they are in flight: a free request fits under
 *      `room − used − (free requests out)`, a counted one under `budget − used − (free requests
 *      out)`. So a free core the peer turns sold mid-flight — it then counts those requests —
 *      never takes it past its window (it would cut and ban us). Landed, cancelled or lost, a
 *      free request is still never debt.
 *
 * A request has STALLED when it is at least `stallMs` old AND its peer has delivered no block on
 * that core for `stallMs` (measured from the later of the request and the peer's last block): a
 * peer still delivering — an honest seeder on a slow link, its pipeline queued behind the blocks
 * it is sending — is never failed over; only a silent one is. A request `STALL_HARD_FACTOR ×
 * stallMs` old has stalled whatever its peer delivers, so a peer trickling other blocks cannot
 * hold one block back for ever.
 *
 * `used(remote)` is what the peer may have sent that nothing will pay yet: requests in flight and
 * blocks being verified, plus, for good, every request cancelled after it went out and every
 * request that died with its channel. The peer may have sent those; hypercore drops a late
 * answer, so it can never be paid, and the seeder still counts it against its window.
 *
 * FAIL CLOSED, ALWAYS:
 *   - When the internals are not what this was written against — the replicator, or any peer
 *     already on it — `attachCore` throws `RoutingUnsupported`: nothing downloads unrouted.
 *   - A peer that joins later without the pinned fields is asked for nothing (cap 0).
 *   - A replicator the router lets go of (the last detach, or `close()`) is PARKED, not handed
 *     back to hypercore's own scheduler: the core may still be replicating (shutdown closes the
 *     connections after the payer), and hypercore's cap (≥ 16) plus its racing hotswap would
 *     overrun every seeder the moment a block landed. Parked, every peer — and every peer that
 *     joins — is capped at 0 new requests and the no-race queue stays; blocks already in flight
 *     still land. The next `attachCore` of that core, by any router, takes it over, and a block
 *     still in flight there fails over as any other (the ticker restarts with the queue). No
 *     router hears a block land on a parked core, so every peer's quiet clock restarts at the
 *     takeover: a seeder that kept delivering is not failed over for the park, and a silent one
 *     fails over `stallMs` after the takeover.
 *
 * Runtime-neutral (Node and Bare): no Node imports, timers only.
 */
import type { Logger } from '../log/logger.js';
import { toHex } from '../util/hex.js';

/** The hypercore release whose internals this module was written and tested against. */
export const ROUTED_HYPERCORE_VERSION = '11.40.3';
/**
 * A request unanswered this long, from a peer that delivered nothing for as long, is moved to
 * another peer that has the block. A 64 KiB block takes well under a second from any peer worth
 * streaming from; the default prefetch (30 s) covers it.
 */
export const DEFAULT_STALL_MS = 4000;
/** The shortest `stallMs` accepted: below it nearly every request would be failed over. */
export const MIN_STALL_MS = 50;
/**
 * A request this many `stallMs` old has stalled even when its peer keeps delivering other blocks
 * (a peer holding one block back while trickling the rest). 16 s by default.
 */
export const STALL_HARD_FACTOR = 4;
/** Remotes whose lost-request count is remembered after their last peer is gone. */
export const MAX_REMEMBERED_REMOTES = 4096;
/** `PRIORITY.CANCELLED` in `hypercore/lib/replicator.js`: a request cancelled or answered. */
const CANCELLED = 255;

/**
 * The one budget value that keeps hypercore's own per-peer cap (a test measuring racing alone).
 * A dedicated sentinel, so no `null` / `undefined` / `Infinity` — "unknown" in the APIs next to
 * this one — can lift a cap by accident.
 */
export const UNCAPPED: unique symbol = Symbol('one-peer-router.uncapped');

/** The `peer` of a `download` event (the fields read here). */
export interface DownloadPeer {
  readonly remotePublicKey: Uint8Array;
}

/** What the router needs of a Hypercore session (structural: every package declares its own). */
export interface RoutableCore {
  readonly key: Uint8Array;
  readonly opened: boolean;
  on(event: 'peer-add' | 'peer-remove', cb: (peer: never) => void): unknown;
  on(event: 'download', cb: (index: number, bytes: number, peer: DownloadPeer) => void): unknown;
  off(event: 'peer-add' | 'peer-remove', cb: (peer: never) => void): unknown;
  off(event: 'download', cb: (index: number, bytes: number, peer: DownloadPeer) => void): unknown;
}

/**
 * Blocks `remote` (its Noise key, hex) may have outstanding toward us right now, for a request on
 * `core`: its credit — its window less the blocks it delivered that are not paid yet. Read before
 * every request. `UNCAPPED` — and only `UNCAPPED` — means "no cap" (hypercore's own); every other
 * value that is not a finite number ≥ 1 asks nothing: 0, negatives, `NaN`, `±Infinity` (a
 * division by zero must not uncap a peer), `null` / `undefined` ("unknown") and a throw all fail
 * closed.
 */
export type PeerBudget = (remote: string, core: string) => number | typeof UNCAPPED;

export interface OnePeerRouterOptions {
  readonly budget: PeerBudget;
  readonly logger: Logger;
  /** Default `DEFAULT_STALL_MS`; at least `MIN_STALL_MS` (a tiny one would fail over everything). */
  readonly stallMs?: number;
  /** A request was taken from a stalled peer (`remote`) and given to another one. */
  readonly onFailover?: (remote: string, core: string) => void;
  /**
   * Lane P2-owed-viewer (ADR 0018 amendment): `true` = ask `remote` at most ONE block at a time on
   * the cores it counts (every routed core it does not serve `free`), within its credit as always
   * — its `pay/1` report of what it still counts for us is not in yet (`SeederCredit`). A throw
   * counts as `true` (the narrower cap).
   */
  readonly single?: (remote: string) => boolean;
  /**
   * Lane P2-owed-viewer (ADR 0015 amendment): `true` = `remote` serves `core` outside payment (its
   * `PRICE { free: true }` on the current connection), so it counts nothing it sends of it. Its
   * cap on `core` is `budget` less what it has in flight THERE (not `used`), and none of its
   * requests on `core` — in flight, being verified, cancelled after sending, or lost when its peer
   * goes — is counted in `used`, `inflight` or `debt`. Read live: a core that turns sold counts
   * again from then on, all of it (the safe side). A throw counts as `false` (counted).
   */
  readonly free?: (remote: string, core: string) => boolean;
  /**
   * Lane W8b-p2p (round-8 review): the most `remote` may still count against us over EVERY core
   * right now — its window less what it already counts (blocks delivered unpaid, reported, lost).
   * Given, requests on a core it serves `free` must fit under it too, together with what it may
   * count (`used`), and a request on a core it counts must fit under its budget together with
   * the free requests out there: a free core it turns SOLD while they are out would otherwise
   * count them on top of a full window, and cut and ban an honest downloader. They share the
   * window only while in flight — landed, cancelled or lost, a free request still leaves no debt.
   * Absent: free requests are capped by `budget` alone. Anything but a finite number ≥ 0 (a throw
   * too) is 0: no free request, and every counted one leaves room for those already out.
   */
  readonly room?: (remote: string) => number;
}

export interface OnePeerRouterStats {
  readonly cores: number;
  readonly peers: number;
  /** Requests moved from a stalled peer to another one. */
  readonly failovers: number;
  /**
   * Blocks seen in flight at two peers at once without a failover — a request path this module
   * does not know about (the pinned tests say hypercore 11.40.3 has none). Logged as an error.
   */
  readonly raced: number;
}

export class RoutingUnsupported extends Error {
  override readonly name = 'RoutingUnsupported';
  readonly code = 'routing-unsupported' as const;
  constructor(detail: string) {
    super(
      `routing-unsupported: ${detail} (written against hypercore ${ROUTED_HYPERCORE_VERSION}; ` +
        're-verify packages/seeder/src/net/one-peer.ts before changing hypercore)',
    );
  }
}

// ---------------------------------------------------------------- hypercore internals (pinned)

/** `lib/replicator.js` request objects (the fields read here). */
interface WireRequest {
  readonly peer: ReplicationPeerInternals;
  readonly timestamp: number;
  readonly priority: number;
}

/** `lib/replicator.js` `BlockRequest`. */
interface BlockRequestInternals {
  readonly index: number;
  readonly inflight: WireRequest[];
  hotswap: { readonly ref: HotswapQueueLike } | null;
}

/** `lib/hotswap-queue.js`: the interface `Replicator` calls. */
interface HotswapQueueLike {
  add(block: BlockRequestInternals): void;
  remove(block: BlockRequestInternals): void;
  pick(peer: ReplicationPeerInternals): Iterable<BlockRequestInternals>;
}

/** `lib/replicator.js` `Peer`. */
interface ReplicationPeerInternals {
  readonly remotePublicKey: Uint8Array;
  readonly inflight: number;
  readonly dataProcessing: number;
  readonly stats: { readonly wireCancel: { readonly tx: number } };
  getMaxInflight(): number;
  _cancelRequest(req: WireRequest): void;
}

/** `lib/replicator.js` `Replicator`. */
interface ReplicatorInternals {
  hotswaps: HotswapQueueLike;
  readonly peers: readonly unknown[];
  updateAll(): void;
  updatePeer(peer: unknown): void;
}

function isFn(o: unknown, name: string): boolean {
  return typeof (o as Record<string, unknown> | null | undefined)?.[name] === 'function';
}

/**
 * The replicator of `core`, after checking every internal the router relies on; throws
 * `RoutingUnsupported` otherwise. `Replicator.Peer` is hypercore's own "hack to be able to access
 * Peer from outside this module".
 */
export function routableReplicator(core: RoutableCore): ReplicatorInternals {
  if (!core.opened) throw new RoutingUnsupported('the core is not open yet');
  const r = (core as unknown as { replicator?: unknown }).replicator;
  if (typeof r !== 'object' || r === null) throw new RoutingUnsupported('no core.replicator');
  const rep = r as Record<string, unknown>;
  const hs = rep['hotswaps'];
  if (!isFn(hs, 'add') || !isFn(hs, 'remove') || !isFn(hs, 'pick'))
    throw new RoutingUnsupported('replicator.hotswaps is not a hotswap queue');
  if (!Array.isArray(rep['peers'])) throw new RoutingUnsupported('no replicator.peers');
  for (const m of ['updateAll', 'updatePeer', '_updateHotswap'])
    if (!isFn(rep, m)) throw new RoutingUnsupported(`no Replicator#${m}`);
  const Peer = (r as { constructor?: { Peer?: { prototype?: unknown } } }).constructor?.Peer;
  for (const m of ['getMaxInflight', 'getMaxHotswapInflight', '_cancelRequest', '_requestBlock'])
    if (!isFn(Peer?.prototype, m)) throw new RoutingUnsupported(`no Peer#${m}`);
  return r as ReplicatorInternals;
}

/** A replication peer carries every field the cap reads, or it cannot be capped. */
export function isRoutablePeer(p: unknown): boolean {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Partial<ReplicationPeerInternals>;
  return (
    o.remotePublicKey instanceof Uint8Array &&
    typeof o.inflight === 'number' &&
    typeof o.dataProcessing === 'number' &&
    typeof o.stats?.wireCancel.tx === 'number' &&
    isFn(o, 'getMaxInflight') &&
    isFn(o, '_cancelRequest')
  );
}

/** One router per replicator: two would fight over its queue and its caps. */
const owners = new WeakMap<object, OnePeerRouter>();

/** In flight + being verified + cancelled after sending, for one replication peer. */
function load(p: ReplicationPeerInternals): number {
  return p.inflight + p.dataProcessing + p.stats.wireCancel.tx;
}

/** Requests for `block` neither cancelled nor answered. */
function live(block: BlockRequestInternals): number {
  let n = 0;
  for (const r of block.inflight) if (r.priority !== CANCELLED) n++;
  return n;
}

/** What a `NoRaceQueue` asks of its router. */
interface QueueHost {
  readonly stallMs: number;
  mayAsk(peer: ReplicationPeerInternals): boolean;
  /** When `peer` last delivered a block on this core (`Date.now()`), 0 if never. */
  lastDelivery(peer: ReplicationPeerInternals): number;
  takeOver(block: BlockRequestInternals, stale: WireRequest): void;
  tracking(): void;
  raced(block: BlockRequestInternals): void;
}

/** The block's one live request when it has STALLED (see the module comment), else `null`. */
function stalled(block: BlockRequestInternals, now: number, host: QueueHost): WireRequest | null {
  let one: WireRequest | null = null;
  for (const r of block.inflight) {
    if (r.priority === CANCELLED) continue;
    if (one !== null) return null;
    one = r;
  }
  if (one === null) return null;
  const age = now - one.timestamp;
  if (age < host.stallMs) return null;
  if (age >= host.stallMs * STALL_HARD_FACTOR) return one;
  const quiet = now - Math.max(one.timestamp, host.lastDelivery(one.peer));
  return quiet >= host.stallMs ? one : null;
}

/** The host of a parked queue: nothing is offered, nothing is asked. */
const PARKED_HOST: QueueHost = {
  stallMs: DEFAULT_STALL_MS,
  mayAsk: () => false,
  lastDelivery: () => 0,
  takeOver: () => undefined,
  tracking: () => undefined,
  raced: () => undefined,
};

/**
 * The replicator's hotswap queue, minus the racing: it tracks the blocks in flight and offers one
 * only when its single request has stalled and the picking peer has credit.
 */
class NoRaceQueue implements HotswapQueueLike {
  private readonly tracked = new Set<BlockRequestInternals>();
  /** The block `pick` is offering right now and the stalled request it would replace. */
  private offered: { readonly block: BlockRequestInternals; readonly stale: WireRequest } | null =
    null;

  constructor(private host: QueueHost) {}

  get size(): number {
    return this.tracked.size;
  }

  /** Serve another router (a parked core taken over), or nobody (`PARKED_HOST`). */
  rebind(host: QueueHost): void {
    this.host = host;
    this.offered = null;
  }

  /** hypercore: a request for `block` went out (or one of several ended). */
  add(block: BlockRequestInternals): void {
    if (block.hotswap !== null && block.hotswap.ref !== this) block.hotswap.ref.remove(block);
    const offer = this.offered;
    if (offer?.block === block) {
      // `pick` offered it and the picking peer took it: the replacement is in `inflight` now.
      this.offered = null;
      this.host.takeOver(block, offer.stale);
    } else if (live(block) > 1) this.host.raced(block);
    if (block.inflight.length === 0) {
      this.remove(block);
      return;
    }
    block.hotswap = { ref: this };
    this.tracked.add(block);
    this.host.tracking();
  }

  /** hypercore: `block` resolved, was dropped, or its requests all ended. */
  remove(block: BlockRequestInternals): void {
    this.tracked.delete(block);
    block.hotswap = null;
  }

  /** hypercore's hotswap step for `peer`: only stalled blocks, only while `peer` has credit. */
  *pick(peer: ReplicationPeerInternals): Generator<BlockRequestInternals> {
    const now = Date.now();
    for (const block of [...this.tracked]) {
      if (!this.host.mayAsk(peer)) return;
      const stale = stalled(block, now, this.host);
      if (stale === null || stale.peer === peer) continue;
      this.offered = { block, stale };
      try {
        yield block;
      } finally {
        this.withdraw(block);
      }
    }
  }

  /** The offer of `block` was not taken (or `add` already took it). */
  private withdraw(block: BlockRequestInternals): void {
    if (this.offered?.block === block) this.offered = null;
  }

  hasStalled(now: number): boolean {
    for (const block of this.tracked) if (stalled(block, now, this.host) !== null) return true;
    return false;
  }

  /**
   * Blocks `from..to` with a request out or being verified: hypercore adds a block here when it
   * sends its request and removes it once it resolved, was dropped, or its requests all ended.
   */
  countIn(from: number, to: number): number {
    let n = 0;
    for (const block of this.tracked) if (block.index >= from && block.index <= to) n++;
    return n;
  }
}

// ---------------------------------------------------------------- parking (fail closed)

/** A replicator no router routes any more, while its core may still replicate. */
interface Parked {
  readonly queue: NoRaceQueue;
  /** Its `peer-add` listeners (a peer that joins is parked too). */
  readonly offs: readonly (() => void)[];
}

const parked = new WeakMap<object, Parked>();

/** The cap of a peer that must be asked for nothing: hypercore gates every request on it. */
const NOTHING = (): number => 0;

function askNothing(p: unknown): void {
  if (typeof p !== 'object' || p === null) return;
  Object.defineProperty(p, 'getMaxInflight', {
    value: NOTHING,
    configurable: true,
    writable: true,
  });
}

/**
 * Park `replicator`: its no-race queue stays (serving nobody), every peer and every peer that
 * joins through one of `sessions` is capped at 0 new requests. Blocks already requested land.
 */
function park(
  replicator: ReplicatorInternals,
  queue: NoRaceQueue,
  sessions: Iterable<RoutableCore>,
): void {
  queue.rebind(PARKED_HOST);
  replicator.hotswaps = queue;
  for (const p of replicator.peers) askNothing(p);
  const offs: (() => void)[] = [];
  for (const s of sessions) {
    const onAdd = (peer: never): void => {
      askNothing(peer);
    };
    s.on('peer-add', onAdd);
    offs.push(() => {
      s.off('peer-add', onAdd);
    });
  }
  parked.set(replicator, { queue, offs });
}

/** Take `replicator` out of the parked set; its queue when it is still the installed one. */
function unpark(replicator: ReplicatorInternals): NoRaceQueue | null {
  const p = parked.get(replicator);
  if (p === undefined) return null;
  parked.delete(replicator);
  for (const off of p.offs) off();
  return replicator.hotswaps === p.queue ? p.queue : null;
}

// ---------------------------------------------------------------- the router

interface Session {
  refs: number;
  readonly off: () => void;
}

interface Route {
  readonly keyHex: string;
  readonly replicator: ReplicatorInternals;
  readonly queue: NoRaceQueue;
  readonly peers: Map<ReplicationPeerInternals, string>;
  /** The sessions attached to this replicator (their listeners), reference counted. */
  readonly sessions: Map<RoutableCore, Session>;
}

export class OnePeerRouter {
  readonly stallMs: number;
  private readonly o: OnePeerRouterOptions;
  private readonly log: Logger;
  /** Keyed by REPLICATOR: a core closed and reopened under the same key is a new one to route. */
  private readonly routes = new Map<ReplicatorInternals, Route>();
  /** remote → its live replication peers on the routed cores. */
  private readonly byRemote = new Map<string, Set<ReplicationPeerInternals>>();
  /** remote → requests it may have answered that nothing will ever pay (peers gone). */
  private readonly lost = new Map<string, number>();
  /**
   * Remotes that let a request stall since they last delivered a block: one request at a time
   * until they deliver again. A peer that takes requests and answers none (withholding) would
   * otherwise take a fresh batch after every failover and delay each block by `stallMs`.
   */
  private readonly stalled = new Set<string>();
  /** Replication peer → when it last delivered a block on its core (the stall rule). */
  private readonly delivered = new WeakMap<object, number>();
  /** Replication peer → the routed core it replicates (hex; the `free` option asks per core). */
  private readonly coreOf = new WeakMap<object, string>();
  private failovers = 0;
  private raced = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private refreshQueued = false;
  private closed = false;

  constructor(o: OnePeerRouterOptions) {
    this.o = o;
    const stallMs = o.stallMs ?? DEFAULT_STALL_MS;
    if (!Number.isFinite(stallMs) || stallMs < MIN_STALL_MS)
      throw new RangeError(`stallMs must be a number ≥ ${String(MIN_STALL_MS)}`);
    this.stallMs = stallMs;
    this.log = o.logger.child({ component: 'one-peer-router' });
  }

  /**
   * Route `core`'s block requests (the core must be open). Reference counted per replicator (and
   * per session of it); returns a detach function — the last one PARKS the replicator (see the
   * module comment). Throws `RoutingUnsupported` when hypercore's internals are not the pinned
   * ones — the replicator's, or those of a peer already on it — or another router routes it.
   */
  attachCore(core: RoutableCore): () => void {
    if (this.closed) throw new RoutingUnsupported('the router is closed');
    const replicator = routableReplicator(core);
    let route = this.routes.get(replicator);
    if (route === undefined) {
      if (owners.has(replicator))
        throw new RoutingUnsupported('another router already routes this core');
      for (const p of replicator.peers)
        if (!isRoutablePeer(p))
          throw new RoutingUnsupported('a replication peer lacks the pinned fields');
      route = this.route(core, replicator);
    }
    this.listen(route, core);
    return this.detacher(route, core);
  }

  /** Budgets may have grown: re-run hypercore's scheduler on every routed core (coalesced). */
  refresh(): void {
    if (this.refreshQueued || this.closed) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      if (this.closed) return;
      for (const route of this.routes.values()) {
        try {
          route.replicator.updateAll();
        } catch (err) {
          this.log.warn('scheduler refresh failed', { error: err });
        }
      }
    });
  }

  /**
   * What `remote` may have outstanding toward us beyond the blocks it delivered (see header) — on
   * the cores it counts (not those it serves `free`).
   */
  used(remote: string): number {
    let n = this.lost.get(remote) ?? 0;
    for (const p of this.byRemote.get(remote) ?? []) if (this.counted(remote, p)) n += load(p);
    return n;
  }

  /**
   * Requests in flight to `remote` and blocks from it being verified, on the routed cores it
   * counts (not those it serves `free`).
   */
  inflight(remote: string): number {
    let n = 0;
    for (const p of this.byRemote.get(remote) ?? [])
      if (this.counted(remote, p)) n += p.inflight + p.dataProcessing;
    return n;
  }

  /**
   * Requests `remote` may have answered that nothing will ever pay, remembered from replication
   * peers now gone (the part of `debt` that outlives them).
   */
  lostOf(remote: string): number {
    return this.lost.get(remote) ?? 0;
  }

  /**
   * Lane P2-owed-viewer (ADR 0018 amendment): drop `n` of the requests remembered as lost to
   * `remote` (at most all of them). Its `SeederCredit` calls it when `remote`'s `pay/1` report
   * came in: the seeder then said itself what it still counts from before this connection, which
   * replaces this estimate of it. Lost requests of the current connection are the caller's to keep
   * (it passes only what it remembered when the connection began).
   */
  forgive(remote: string, n: number): void {
    const had = this.lost.get(remote);
    if (had === undefined || !Number.isSafeInteger(n) || n <= 0) return;
    const left = had - Math.min(had, n);
    if (left > 0) this.lost.set(remote, left);
    else this.lost.delete(remote);
  }

  /**
   * Requests in flight and blocks being verified on the routed core `core` (hex; every routed core
   * without one), across its peers — what may still land there (fix round 4: a closing session
   * waits for it before its tail is paid). With `range`, the BLOCKS `fromBlock..toBlock` of `core`
   * requested and not landed yet, whichever peer has them (fix round 5: a closing session's own
   * blocks, not those of another session streaming the same core).
   */
  inflightOn(
    core?: string,
    range?: { readonly fromBlock: number; readonly toBlock: number },
  ): number {
    let n = 0;
    for (const route of this.routes.values()) {
      if (core !== undefined && route.keyHex !== core) continue;
      if (core !== undefined && range !== undefined)
        n += route.queue.countIn(range.fromBlock, range.toBlock);
      else for (const p of route.peers.keys()) n += p.inflight + p.dataProcessing;
    }
    return n;
  }

  /** `remote` let a request stall and has delivered nothing since (one request at a time). */
  isStalled(remote: string): boolean {
    return this.stalled.has(remote);
  }

  /**
   * The part of `used` that never comes back: cancelled after sending, or lost with a channel (on
   * the cores `remote` counts: a request of a `free` core is owed nothing, whatever became of it).
   */
  debt(remote: string): number {
    let n = this.lost.get(remote) ?? 0;
    for (const p of this.byRemote.get(remote) ?? [])
      if (this.counted(remote, p)) n += p.stats.wireCancel.tx;
    return n;
  }

  stats(): OnePeerRouterStats {
    let peers = 0;
    for (const r of this.routes.values()) peers += r.peers.size;
    return { cores: this.routes.size, peers, failovers: this.failovers, raced: this.raced };
  }

  /**
   * Let go of every core (the downloader is going away): each is PARKED — nothing more is asked
   * of any peer on it, even while its connections are still open.
   */
  close(): void {
    if (this.closed) return;
    for (const route of [...this.routes.values()]) this.release(route, []);
    this.closed = true;
    this.stopTicker();
  }

  // -------------------------------------------------------------- private

  private route(core: RoutableCore, replicator: ReplicatorInternals): Route {
    const keyHex = toHex(core.key);
    const host: QueueHost = {
      stallMs: this.stallMs,
      mayAsk: (peer) => peer.inflight < peer.getMaxInflight(),
      lastDelivery: (peer) => this.delivered.get(peer) ?? 0,
      takeOver: (block, stale) => {
        this.takeOver(keyHex, block, stale);
      },
      tracking: () => {
        this.armTicker();
      },
      raced: (block) => {
        this.raced++;
        this.log.error('a block is in flight at two peers (unknown request path)', {
          core: keyHex,
          index: block.index,
        });
      },
    };
    // A parked core keeps its queue (and the blocks it tracks); otherwise hypercore's goes.
    let queue = unpark(replicator);
    if (queue === null) queue = new NoRaceQueue(host);
    else queue.rebind(host);
    replicator.hotswaps = queue;
    owners.set(replicator, this);
    const route: Route = { keyHex, replicator, queue, peers: new Map(), sessions: new Map() };
    this.routes.set(replicator, route);
    // Peers already there. A new one is added in the same tick as `_addPeer` puts it in
    // `replicator.peers`, before its first sync, so it cannot have asked for a block yet.
    for (const p of replicator.peers) this.addPeer(route, p);
    if (queue.size > 0) {
      // A parked queue taken over may still track blocks in flight. While it was parked no
      // router heard a block land, so no peer's quiet clock is known: restart every one at the
      // takeover, or a seeder that kept delivering would be judged silent and its blocks failed
      // over (a cancel after sending: paid twice). A withholding one still fails over `stallMs`
      // from now (fix round 3, 2026-09-25).
      const now = Date.now();
      for (const p of replicator.peers)
        if (typeof p === 'object' && p !== null)
          this.delivered.set(p, Math.max(this.delivered.get(p) ?? 0, now));
      // The ticker otherwise starts only from the queue's `add()`: without it, a block its peer
      // withholds would never fail over when nothing new is queued (fix round 2, 2026-09-25).
      this.armTicker();
    }
    return route;
  }

  /** Follow `core`'s peers and downloads (once per session; every session sees every event). */
  private listen(route: Route, core: RoutableCore): void {
    const had = route.sessions.get(core);
    if (had !== undefined) {
      had.refs++;
      return;
    }
    const onAdd = (peer: never): void => {
      this.addPeer(route, peer);
    };
    const onRemove = (peer: never): void => {
      this.removePeer(route, peer);
    };
    const onDownload = (_index: number, _bytes: number, peer: DownloadPeer): void => {
      this.delivered.set(peer, Date.now());
      if (this.stalled.size > 0) this.stalled.delete(toHex(peer.remotePublicKey));
    };
    core.on('peer-add', onAdd);
    core.on('peer-remove', onRemove);
    core.on('download', onDownload);
    route.sessions.set(core, {
      refs: 1,
      off: () => {
        core.off('peer-add', onAdd);
        core.off('peer-remove', onRemove);
        core.off('download', onDownload);
      },
    });
  }

  private detacher(route: Route, core: RoutableCore): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const s = route.sessions.get(core);
      if (s === undefined) return; // released already (`close()`)
      if (--s.refs > 0) return;
      s.off();
      route.sessions.delete(core);
      if (route.sessions.size === 0) this.release(route, [core]);
    };
  }

  /** Stop routing `route` and PARK its replicator (listening for new peers on `extra` too). */
  private release(route: Route, extra: readonly RoutableCore[]): void {
    if (this.routes.get(route.replicator) !== route) return;
    this.routes.delete(route.replicator);
    const sessions = [...route.sessions.keys(), ...extra];
    for (const s of route.sessions.values()) s.off();
    route.sessions.clear();
    for (const p of [...route.peers.keys()]) this.removePeer(route, p);
    if (owners.get(route.replicator) === this) owners.delete(route.replicator);
    park(route.replicator, route.queue, sessions);
    // A read of a parked core waits for ever (or its timeout): say why, once.
    this.log.info('core released and parked: nothing more is asked of its peers', {
      core: route.keyHex,
    });
  }

  private addPeer(route: Route, p: unknown): void {
    if (!isRoutablePeer(p)) {
      // The pinned tests make this unreachable on 11.40.3. Should it happen, the peer cannot be
      // capped by its credit, so it is asked for nothing at all: say so loudly.
      askNothing(p);
      this.log.error('replication peer without the pinned fields: asked for nothing');
      return;
    }
    const peer = p as ReplicationPeerInternals;
    if (route.peers.has(peer)) return;
    const remote = toHex(peer.remotePublicKey);
    route.peers.set(peer, remote);
    this.coreOf.set(peer, route.keyHex);
    let set = this.byRemote.get(remote);
    if (set === undefined) {
      set = new Set();
      this.byRemote.set(remote, set);
    }
    set.add(peer);
    const proto = Object.getPrototypeOf(peer) as { getMaxInflight: () => number };
    const cap = (): number => this.cap(route, peer, remote, proto.getMaxInflight.call(peer));
    Object.defineProperty(peer, 'getMaxInflight', {
      value: cap,
      configurable: true,
      writable: true,
    });
  }

  /** `peer` left the core (`peer-remove`), or the core is being released: stop tracking it. */
  private removePeer(route: Route, p: unknown): void {
    const peer = p as ReplicationPeerInternals;
    const remote = route.peers.get(peer);
    if (remote === undefined) return;
    route.peers.delete(peer);
    // Requests in flight when the channel closed, blocks mid-verify and cancelled requests: the
    // peer may have sent every one of them and none of them will be paid, so they stay counted
    // against its window for good. (A block mid-verify that still lands is then counted twice,
    // which errs on the safe side.) Not on a core it serves `free`: it counted none of them — a
    // free read that timed out or was stopped leaves no debt (lane P2-owed-viewer).
    if (!this.isFree(remote, route.keyHex)) this.remember(remote, load(peer));
    const set = this.byRemote.get(remote);
    set?.delete(peer);
    if (set?.size === 0) this.byRemote.delete(remote);
    // A peer gone from the core is never scheduled again; on a release `park` caps it at 0.
    delete (peer as { getMaxInflight?: unknown }).getMaxInflight;
  }

  private remember(remote: string, n: number): void {
    if (n <= 0) return;
    const had = this.lost.get(remote) ?? 0;
    this.lost.delete(remote); // re-insert: the map's order is least recently touched first
    this.lost.set(remote, had + n);
    while (this.lost.size > MAX_REMEMBERED_REMOTES) {
      const oldest = this.lost.keys().next();
      if (oldest.done === true) break;
      this.lost.delete(oldest.value);
    }
  }

  /** hypercore's `getMaxInflight()` for `peer` (`base`), capped by the peer's credit. */
  private cap(route: Route, peer: ReplicationPeerInternals, remote: string, base: number): number {
    let budget: unknown;
    try {
      budget = this.o.budget(remote, route.keyHex);
    } catch {
      budget = 0;
    }
    if (budget === UNCAPPED) return base;
    const credit =
      typeof budget === 'number' && Number.isFinite(budget) && budget >= 1 ? Math.floor(budget) : 0;
    const room = this.roomOf(remote);
    if (this.isFree(remote, route.keyHex)) {
      // Served outside payment: only what is in flight on THIS core holds it back (lane
      // P2-owed-viewer) — never what the peer may count on the cores it sells as DEBT. Lane
      // W8b-p2p: with `room`, it also fits, with every free request out there, under what the
      // peer may still count — so a turn to sold mid-flight cannot take it past its window.
      let free = Math.max(0, credit - peer.inflight - peer.dataProcessing);
      if (room !== null)
        free = Math.min(free, Math.max(0, room - this.used(remote) - this.freeLoad(remote)));
      if (this.stalled.has(remote))
        free = Math.min(free, Math.max(0, 1 - peer.inflight - peer.dataProcessing));
      return Math.min(base, peer.inflight + free);
    }
    // Lane W8b-p2p: with `room`, free requests out at this peer hold room in its window too.
    const aside = room === null ? 0 : this.freeLoad(remote);
    let free = Math.max(0, credit - this.used(remote) - aside);
    if (this.stalled.has(remote) || this.isSingle(remote))
      free = Math.min(free, Math.max(0, 1 - this.inflight(remote)));
    return Math.min(base, peer.inflight + free);
  }

  /** The `room` option (lane W8b-p2p): `null` when absent; junk or a throw is 0. */
  private roomOf(remote: string): number | null {
    const room = this.o.room;
    if (room === undefined) return null;
    let r: unknown;
    try {
      r = room(remote);
    } catch {
      return 0;
    }
    return typeof r === 'number' && Number.isFinite(r) && r >= 0 ? Math.floor(r) : 0;
  }

  /**
   * Lane W8b-p2p: requests in flight to `remote` and blocks from it being verified on the cores it
   * serves `free` — what it would count should one of them turn sold before they land.
   */
  private freeLoad(remote: string): number {
    let n = 0;
    for (const p of this.byRemote.get(remote) ?? [])
      if (!this.counted(remote, p)) n += p.inflight + p.dataProcessing;
    return n;
  }

  /** The `single` option (lane P2-owed-viewer); a throw is `true` (the narrower cap). */
  private isSingle(remote: string): boolean {
    const single = this.o.single;
    if (single === undefined) return false;
    try {
      return single(remote);
    } catch {
      return true;
    }
  }

  /** The `free` option (lane P2-owed-viewer); a throw is `false` (counted: the safe side). */
  private isFree(remote: string, core: string): boolean {
    const free = this.o.free;
    if (free === undefined) return false;
    try {
      return free(remote, core);
    } catch {
      return false;
    }
  }

  /** Whether `p` (a peer of `remote`) replicates a core `remote` counts (not one it serves free). */
  private counted(remote: string, p: object): boolean {
    const core = this.coreOf.get(p);
    return core === undefined || !this.isFree(remote, core);
  }

  /**
   * A replacement request for `block` has just been added (hypercore's `_sendBlockRequest` calls
   * the queue's `add` before sending it): withdraw the stalled one, so the block stays with one
   * peer.
   */
  private takeOver(keyHex: string, block: BlockRequestInternals, stale: WireRequest): void {
    if (stale.priority !== CANCELLED) stale.peer._cancelRequest(stale);
    // hypercore leaves a cancelled request in `inflight` only on a block it is dropping; on a
    // live block it would keep the block from ever being queued again.
    const i = block.inflight.indexOf(stale);
    if (i !== -1) block.inflight.splice(i, 1);
    this.failovers++;
    const remote = toHex(stale.peer.remotePublicKey);
    this.stalled.delete(remote); // re-insert: least recently stalled first
    this.stalled.add(remote);
    while (this.stalled.size > MAX_REMEMBERED_REMOTES) {
      const oldest = this.stalled.values().next();
      if (oldest.done === true) break;
      this.stalled.delete(oldest.value);
    }
    this.log.info('block moved from a stalled peer', { core: keyHex, index: block.index });
    try {
      this.o.onFailover?.(remote, keyHex);
    } catch {
      // the listener's failure is its own
    }
  }

  private armTicker(): void {
    if (this.ticker !== null || this.closed) return;
    const t = setInterval(
      () => {
        this.tick();
      },
      Math.max(50, Math.floor(this.stallMs / 4)),
    );
    (t as { unref?: () => void }).unref?.();
    this.ticker = t;
  }

  private tick(): void {
    let tracking = false;
    const now = Date.now();
    for (const route of this.routes.values()) {
      const queue = route.queue;
      if (queue.size === 0) continue;
      tracking = true;
      if (!queue.hasStalled(now)) continue;
      // `updatePeer` runs hypercore's hotswap step for that peer, which asks our queue.
      for (const p of [...route.replicator.peers]) {
        try {
          route.replicator.updatePeer(p);
        } catch (err) {
          this.log.warn('failover pass failed', { error: err });
        }
      }
    }
    if (!tracking) this.stopTicker();
  }

  private stopTicker(): void {
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
  }
}
