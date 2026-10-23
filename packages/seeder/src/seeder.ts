/**
 * Seeder — the daemon's public façade (build-plan §2.1 `@sovit/seeder`). This is the API
 * L3 (gateway) and L6 (desktop shell) consume; see docs/archive/lanes/L2.md "Public API".
 *
 * Composition:
 *   BlobStore (Corestore + Hyperblobs, CAS index, disk cap)
 *   SessionRegistry (Noise key → PeerSession, admission, synchronous upload gate)
 *   SwarmManager (hyperswarm, ban-list firewall, join per core)
 *   FlushScheduler (PaymentEngine.flush every N blocks / T ms)
 *   BanList (Noise + Nostr, persisted)
 *   CorePolicyStore (per-core prices, persisted — lane W8b-p2p)
 *   Logger (redacting; the only output path)
 */
import { OWED_END_CORE, payment } from '@sovit/core';
import type {
  BlockRange,
  CoreKeyHex,
  MintUrl,
  NostrPubkey,
  PaymentEngineSeeder,
  PayProtocol,
  PricePolicy,
  Sats,
  UnixSeconds,
} from '@sovit/core';
import type { BlobReadStream } from 'hyperblobs';
import type Hypercore from 'hypercore';
import type { ReplicationStream, ReplicationStreamOptions } from 'hypercore';
import type { PeerInfo, SwarmConnection } from 'hyperswarm';

import type { SeederCrypto } from './adapters/crypto.js';
import type { SeederFs } from './adapters/fs.js';
import { BlobStore } from './blobs/blob-store.js';
import type { PutOptions, PutResult, SeedCore } from './blobs/blob-store.js';
import { resolveConfig } from './config.js';
import type { ResolvedSeederConfig, SeederConfig } from './config.js';
import type { Logger } from './log/logger.js';
import { silentLogger } from './log/logger.js';
import type { CutReason, PeerSession, PeerSessionInfo } from './net/peer-session.js';
import { RateLimiter } from './net/rate-limit.js';
import { SessionRegistry } from './net/session-registry.js';
import type { SessionEvent } from './net/session-registry.js';
import { SwarmManager } from './net/swarm.js';
import { FlushScheduler } from './payment/flush-scheduler.js';
import type { FlushResult, FlushTrigger } from './payment/flush-scheduler.js';
import { attachPayBridge } from './payment/pay-bridge.js';
import { BanList } from './store/ban-list.js';
import type { PersistedBan } from './store/ban-list.js';
import { CasIndex } from './store/cas-index.js';
import type { CasEntry } from './store/cas-index.js';
import { CorePolicyStore } from './store/core-policies.js';
import { DiskCap } from './store/disk-cap.js';
import { NfxFileStore } from './store/nfx-files.js';

export interface SeederDeps {
  /**
   * The seeder-side engine. It must also be an `UnpaidLedger` (both engines of `@sovit/core` are):
   * the seeder reports what a peer still owes in `OWED` and `ACK.outstanding` (contracts v6
   * amendment) — required, so no seeder can be built that silently leaves them out.
   */
  readonly engine: PaymentEngineSeeder &
    payment.UnpaidLedger & { readonly config?: EngineConfigLike };
  readonly fs: SeederFs;
  readonly crypto: SeederCrypto;
  readonly logger?: Logger;
  readonly now?: () => number;
  /**
   * `false` while no more PAYs should be taken on (the runtime's pending-PAY cap: the queue of
   * accepted-but-unredeemed PAYs grows while a mint is down). Sessions then stop being served
   * (cut 'local', no ban) until it drains.
   */
  readonly accepting?: () => boolean;
}

interface EngineConfigLike {
  readonly flushEveryBlocks: number;
  readonly flushEveryMs: number;
}

export type SeederEvent =
  | { readonly type: 'session-open'; readonly session: PeerSessionInfo }
  | { readonly type: 'session-close'; readonly session: PeerSessionInfo }
  | { readonly type: 'session-cut'; readonly session: PeerSessionInfo; readonly reason: CutReason }
  | { readonly type: 'session-refused'; readonly noiseKeyHex: string; readonly reason: string }
  | { readonly type: 'blob-added'; readonly entry: CasEntry; readonly deduplicated: boolean }
  | { readonly type: 'blob-removed'; readonly sha256: string }
  | { readonly type: 'flush'; readonly result: FlushResult; readonly trigger: FlushTrigger }
  | {
      readonly type: 'double-spend';
      readonly peer: NostrPubkey;
      readonly mint: MintUrl;
      readonly amount: Sats;
    };

export interface SeederStats {
  readonly cores: number;
  readonly blobs: number;
  readonly usedBytes: number;
  readonly capBytes: number;
  readonly sessions: number;
  readonly swarmConnections: number;
  readonly bans: number;
  readonly flushes: number;
  readonly pendingPaidBlocks: number;
}

export class Seeder {
  readonly config: ResolvedSeederConfig;
  readonly log: Logger;
  readonly banList: BanList;
  readonly index: CasIndex;
  readonly diskCap: DiskCap;
  /** NFX videos' files (ADR 0020), apart from every core, counted in the same disk cap. */
  readonly nfx: NfxFileStore;
  readonly rateLimiter: RateLimiter;
  readonly sessions: SessionRegistry;
  readonly blobs: BlobStore;
  readonly swarm: SwarmManager | null;
  readonly scheduler: FlushScheduler;
  private readonly engine: PaymentEngineSeeder;
  private readonly ledger: payment.UnpaidLedger;
  private readonly listeners = new Set<(e: SeederEvent) => void>();
  private readonly readyListeners = new Set<(session: PeerSession) => void>();
  /**
   * Upload gates by core key, each with the Hypercore SESSION it is attached to: a core closed by
   * key and reopened is a new session, and gets a new gate (fix round 4 — keyed by key alone, the
   * reopened core used to be served with no accounting at all).
   */
  private readonly gates = new Map<
    string,
    { readonly core: Hypercore; readonly detach: () => void }
  >();
  private readonly protocols = new Map<PeerSession, PayProtocol>();
  private readonly unsubs: (() => void)[] = [];
  private policyOverride: PricePolicy | null;
  /**
   * Per-core policies (`setCorePolicy`). Lane W8b-p2p (round-8 review, MEDIUM): loaded back from
   * `corePolicyStore` at start, so a core this node sold before a restart — an upload, a played
   * video still in its store — is still sold after it: never marked free (`setFreeCore`), and
   * priced as before.
   */
  private readonly corePolicies = new Map<CoreKeyHex, PricePolicy>();
  private readonly corePolicyStore: CorePolicyStore;
  /** ADR 0015: cores served outside payment. */
  private readonly freeCores = new Set<CoreKeyHex>();
  /**
   * Per session × core, the price boundaries announced to that peer (security review F9): each
   * entry applies from `fromBlock` on. A PAY is verified against the entry in force at its first
   * block, so blocks sent before a `PRICE` stay at the old price, as the `PRICE` promised.
   */
  private readonly priceHistory = new WeakMap<
    PeerSession,
    Map<CoreKeyHex, { readonly fromBlock: number; readonly policy: PricePolicy }[]>
  >();
  /**
   * Per session × core, the terms this peer was last told on its pay/1 channel (contracts v6
   * amendment, rule 1): a `PRICE` goes out before a block only when what is served differs from
   * what was said — once per core, and again when it turns free or sold.
   */
  private readonly told = new WeakMap<PeerSession, Map<CoreKeyHex, 'free' | 'priced'>>();
  /** Sessions whose `OWED` report went out (once per connection, rule 2). */
  private readonly owedSent = new WeakSet<PeerSession>();
  private started = false;
  private closed = false;

  private constructor(
    config: ResolvedSeederConfig,
    deps: SeederDeps,
    loaded: {
      readonly banList: BanList;
      readonly index: CasIndex;
      readonly corePolicies: CorePolicyStore;
      readonly nfx: NfxFileStore;
    },
  ) {
    this.config = config;
    this.engine = deps.engine;
    this.ledger = deps.engine;
    this.log = (deps.logger ?? silentLogger).child({ component: 'seeder' });
    this.policyOverride = config.policy;
    this.banList = loaded.banList;
    this.index = loaded.index;
    this.corePolicyStore = loaded.corePolicies;
    for (const [core, policy] of loaded.corePolicies.entries()) this.corePolicies.set(core, policy);
    // One cap over both stores: the Hyperblobs payload and the NFX files.
    this.diskCap = new DiskCap(
      config.diskCapBytes,
      this.index.totalBytes() + loaded.nfx.totalBytes(),
    );
    this.nfx = loaded.nfx;
    this.nfx.attach(this.diskCap);
    this.rateLimiter = new RateLimiter(config.rateLimits, deps.now ?? Date.now);
    this.sessions = new SessionRegistry({
      engine: deps.engine,
      banList: this.banList,
      rateLimiter: this.rateLimiter,
      logger: this.log,
      ...(deps.now ? { now: deps.now } : {}),
      // v5: the engine's effective window needs the core's price. A core with no policy
      // (no default either) is served unpriced — its PAYs cannot be verified anyway.
      pricing: (core) => this.pricingFor(core),
      ...(deps.accepting ? { accepting: deps.accepting } : {}),
      isFree: (core) => this.freeCores.has(core),
      // Contracts v6 amendment, rule 1 — always on: a core's terms precede its blocks.
      beforeBlock: (session, core, free) => {
        this.announceTerms(session, core, free);
      },
      // …and are said as soon as the peer opens the core, before it asks for anything: ADR 0015's
      // viewer asks for an image block only after a `PRICE { free: true }` (independent review,
      // 2026-09-27). The registry contains what this throws; `beforeBlock` stays the backstop.
      onPeerAdd: (session, core) => {
        this.announceTerms(session, core, this.freeCores.has(core));
      },
    });
    this.blobs = new BlobStore({
      storageDir: config.storageDir,
      blockSize: config.blockSize,
      fs: deps.fs,
      crypto: deps.crypto,
      index: this.index,
      diskCap: this.diskCap,
      logger: this.log,
      onCoreOpened: (sc) => {
        this.onCoreOpened(sc);
      },
      onCoreClosed: (sc) => {
        this.onCoreClosed(sc);
      },
    });
    this.swarm = config.swarm
      ? new SwarmManager({
          config: config.swarm,
          banList: this.banList,
          registry: this.sessions,
          logger: this.log,
          onSession: (session, conn, info) => {
            this.onSwarmSession(session, conn, info);
          },
        })
      : null;
    this.scheduler = new FlushScheduler(deps.engine, {
      everyBlocks: config.flushEveryBlocks,
      everyMs: config.flushEveryMs,
      logger: this.log,
    });
  }

  /** Open storage, load the ban list + CAS index, size the disk cap. Does not touch the network. */
  static async create(userConfig: SeederConfig, deps: SeederDeps): Promise<Seeder> {
    // Checked here, not at the first connection: an engine without the ledger would otherwise
    // fail inside every session (no OWED report; every PAY cutting its session).
    const ledger: Partial<payment.UnpaidLedger> = deps.engine;
    if (typeof ledger.outstandingOn !== 'function' || typeof ledger.unpaid !== 'function')
      throw new TypeError(
        'Seeder: the engine must be an UnpaidLedger (outstandingOn, unpaid) — contracts v6 amendment',
      );
    const config = resolveConfig(userConfig, deps.fs.join.bind(deps.fs), deps.engine.config);
    const log = (deps.logger ?? silentLogger).child({ component: 'seeder' });
    await deps.fs.mkdir(config.dataDir, { recursive: true });
    await deps.fs.mkdir(config.storageDir, { recursive: true });
    const nowSec = (): UnixSeconds => Math.floor((deps.now ?? Date.now)() / 1000) as UnixSeconds;
    const banList = new BanList({
      fs: deps.fs,
      crypto: deps.crypto,
      dataDir: config.dataDir,
      now: nowSec,
    });
    const index = new CasIndex({
      fs: deps.fs,
      crypto: deps.crypto,
      dataDir: config.dataDir,
      now: nowSec,
    });
    const corePolicies = new CorePolicyStore({
      fs: deps.fs,
      crypto: deps.crypto,
      dataDir: config.dataDir,
    });
    const nfx = new NfxFileStore({
      fs: deps.fs,
      crypto: deps.crypto,
      dataDir: config.dataDir,
      logger: log,
      now: nowSec,
    });
    await banList.load();
    await index.load();
    await corePolicies.load();
    await nfx.load();
    if (banList.corruptOnLoad)
      log.error('ban list on disk was unreadable; starting with an empty list');
    if (index.corruptOnLoad)
      log.error('CAS index on disk was unreadable; starting with an empty index');
    if (corePolicies.corruptOnLoad)
      log.error('core policies on disk were unreadable; starting with none');
    if (corePolicies.dropped > 0)
      log.warn('malformed core policies on disk were dropped', { dropped: corePolicies.dropped });
    if (nfx.corruptOnLoad)
      log.error('NFX file index on disk was unreadable; starting with no NFX videos');

    const seeder = new Seeder(config, deps, { banList, index, corePolicies, nfx });
    await seeder.blobs.ready();
    seeder.wireEvents();
    seeder.log.info('seeder created', {
      dataDir: config.dataDir,
      blobs: index.entries().length,
      nfxVideos: nfx.videos().length,
      usedBytes: seeder.diskCap.usedBytes,
      capBytes: config.diskCapBytes,
      bans: banList.entries().length,
      corePolicies: corePolicies.entries().size,
    });
    return seeder;
  }

  // ------------------------------------------------------------------ lifecycle

  /** Start the swarm (if configured), join every open core, arm the flush scheduler. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.scheduler.start();
    if (this.swarm) {
      this.swarm.start();
      for (const sc of this.blobs.openCores()) this.swarm.join(sc.core.discoveryKey);
    }
    this.log.info('seeder started', { swarm: this.swarm !== null });
  }

  /** Graceful stop: final flush, drop every connection, close swarm + store, persist. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    for (const off of this.unsubs) off();
    await this.scheduler.stop({ flush: true });
    this.sessions.closeAll();
    for (const g of this.gates.values()) g.detach();
    this.gates.clear();
    if (this.swarm) await this.swarm.destroy();
    await this.blobs.close();
    await Promise.all([
      this.banList.flushed(),
      this.index.flushed(),
      this.corePolicyStore.flushed(),
    ]);
    if (this.corePolicyStore.lastPersistError !== null)
      this.log.warn('core policies could not be written: they are unpriced after a restart');
    this.log.info('seeder closed');
  }

  on(cb: (e: SeederEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Called with every admitted session once replication runs on it, so `session.mux` is set:
   * where a shell attaches `pay/1`. `session-open` is too early for a swarm connection — it fires
   * at admission, before `store.replicate(conn)` creates the connection's Protomux. Direct streams
   * (`replicate()`) already carry one at admission; they are reported right after it.
   */
  onSessionReady(cb: (session: PeerSession) => void): () => void {
    this.readyListeners.add(cb);
    return () => this.readyListeners.delete(cb);
  }

  // ------------------------------------------------------------------ blobs

  /**
   * Open (or create) a named core. Lane W8b-p2p (round-8 review, info): with `free`, the core is
   * served outside payment from the moment it is ready — marked before its upload gate is
   * attached and before its terms are said to a peer that paired while it opened (they hear
   * `free`, never silence first) — unless it has a price of its own (`setFreeCore`'s rule). The
   * desktop's own profile core opens this way.
   */
  async openCore(name?: string, opts: { readonly free?: boolean } = {}): Promise<SeedCore> {
    if (opts.free !== true) return this.blobs.openCore(name);
    const sc = await this.blobs.openCore(name, {
      beforeOpened: (c) => {
        if (!this.corePolicies.has(c.keyHex)) this.freeCores.add(c.keyHex);
      },
    });
    // Already open (the hook did not run), or opened by a concurrent caller without `free`.
    this.setFreeCore(sc.keyHex, true);
    return sc;
  }

  putBytes(bytes: Uint8Array, opts?: PutOptions): Promise<PutResult> {
    return this.blobs.putBytes(bytes, opts).then((r) => this.afterPut(r));
  }

  putFile(path: string, opts?: PutOptions): Promise<PutResult> {
    return this.blobs.putFile(path, opts).then((r) => this.afterPut(r));
  }

  putStream(
    source: () => AsyncIterable<Uint8Array>,
    size: number,
    opts?: PutOptions,
  ): Promise<PutResult> {
    return this.blobs.putStream(source, size, opts).then((r) => this.afterPut(r));
  }

  hasBlob(sha256: string): boolean {
    return this.index.has(sha256);
  }

  blob(sha256: string): CasEntry | undefined {
    return this.index.get(sha256);
  }

  listBlobs(): readonly CasEntry[] {
    return this.index.entries();
  }

  getBlob(sha256: string, opts?: { readonly wait?: boolean }): Promise<Uint8Array | null> {
    return this.blobs.get(sha256, opts);
  }

  createBlobReadStream(
    sha256: string,
    opts?: { readonly start?: number; readonly end?: number; readonly wait?: boolean },
  ): BlobReadStream | null {
    return this.blobs.createReadStream(sha256, opts);
  }

  async removeBlob(sha256: string): Promise<boolean> {
    const ok = await this.blobs.remove(sha256);
    if (ok) this.emit({ type: 'blob-removed', sha256 });
    return ok;
  }

  // ------------------------------------------------------------------ network

  /**
   * Replicate over a stream you own (gateway WS bridge, tests). Boolean → a fresh Noise
   * stream is created; pipe the returned raw stream to the remote. A stream with a
   * `noiseStream` (hyperswarm connection) → attached as-is. The session is admitted once
   * the Noise handshake completes; a refused stream is destroyed. NOTE: without
   * `opts.keyPair` every fresh stream gets a NEW Noise identity (Corestore behaviour), so
   * pass the node's stable key pair when bans are expected to stick. Like every stream of
   * `blobs.store` (round 9, F57), it serves only the cores open in `blobs` — each gated.
   */
  replicate(
    isInitiator: boolean | ReplicationStream,
    opts?: ReplicationStreamOptions,
  ): ReplicationStream {
    const stream = this.blobs.store.replicate(isInitiator, opts);
    const noise = stream.noiseStream;
    const admit = (): void => {
      const s = this.sessions.admit(noise, null);
      if (s === null) return;
      this.log.debug('direct stream admitted', { noiseKey: s.noiseKeyHex });
      this.sessionReady(s);
    };
    if (noise.remotePublicKey !== null) admit();
    else noise.once('connect', admit);
    return stream;
  }

  /**
   * Attach a `pay/1` protocol instance to a session (the implementation arrives in Stage 2;
   * the seeder only depends on the contract). Returns a detach function.
   */
  attachPayProtocol(session: PeerSession, protocol: PayProtocol): () => void {
    const detach = attachPayBridge({
      session,
      protocol,
      policy: (core, range) => this.policyForRange(session, core, range),
      scheduler: this.scheduler,
      logger: this.log,
      // Contracts v6 amendment: every ACK says what this peer still owes on the core (rule 4),
      // and the open channel gets the OWED report (rules 2–3).
      outstanding: (core) => this.ledger.outstandingOn(session.accountId(), core),
      onOpen: () => {
        this.announceOwed(session, protocol);
      },
    });
    this.protocols.set(session, protocol);
    session.stream.once('close', () => this.protocols.delete(session));
    // Cores this peer opened before pay/1 was attached: their `peer-add` found nothing to say the
    // terms on, so say them now (rule 1, unprompted).
    for (const [core, g] of this.gates)
      if (this.sessions.pairedSessions(g.core).includes(session))
        this.tellTerms(session, core as CoreKeyHex);
    return () => {
      this.protocols.delete(session);
      detach();
    };
  }

  /** The DEFAULT policy (`config.policy` / `setPolicy()`): what a core without its own gets. */
  policy(): PricePolicy {
    if (this.policyOverride === null)
      throw new Error('seeder has no PricePolicy configured; cannot verify PAY');
    return this.policyOverride;
  }

  /**
   * v3 (ADR 0004 (c)): the policy a `PAY` for `core` is verified against — the per-core
   * policy set with `setCorePolicy()`, else the default. `PricePolicy` is per video
   * (`creatorP2pk`, `satsPerBlock`, mints), so a multi-video seeder or a gateway sets one
   * per core; a single-video seeder just uses the default. Throws like `policy()` when
   * neither exists.
   */
  policyFor(core?: CoreKeyHex): PricePolicy {
    if (core !== undefined) {
      const p = this.corePolicies.get(core);
      if (p !== undefined) return p;
    }
    return this.policy();
  }

  /**
   * The policy a `PAY` for `range` on `session` is verified against: the one this peer was told
   * applies from the range's first block (F9), else `policyFor(core)`. A range spanning a price
   * boundary gets the policy of its first block — and fails the amount check, as it should: the
   * payer splits PAYs at `effectiveFromBlock`.
   */
  policyForRange(session: PeerSession, core: CoreKeyHex, range: BlockRange): PricePolicy {
    const history = this.priceHistory.get(session)?.get(core);
    let hit: PricePolicy | undefined;
    for (const e of history ?? []) if (e.fromBlock <= range.fromBlock) hit = e.policy;
    return hit ?? this.policyFor(core);
  }

  /** Whether `session` has been sold `core`: a counted block sent, or a priced `PRICE` said. */
  private pricedOn(session: PeerSession, core: CoreKeyHex): boolean {
    return session.uploadedCores.has(core) || this.told.get(session)?.get(core) === 'priced';
  }

  private toldOf(session: PeerSession): Map<CoreKeyHex, 'free' | 'priced'> {
    let m = this.told.get(session);
    if (m === undefined) {
      m = new Map();
      this.told.set(session, m);
    }
    return m;
  }

  private historyOf(
    session: PeerSession,
  ): Map<CoreKeyHex, { readonly fromBlock: number; readonly policy: PricePolicy }[]> {
    let m = this.priceHistory.get(session);
    if (m === undefined) {
      m = new Map();
      this.priceHistory.set(session, m);
    }
    return m;
  }

  /**
   * Tell every live `pay/1` peer that was sold `core` (sent a counted block, or told its price) its
   * new price, and remember it. A core served free now gets no priced `PRICE` (its next block says
   * `free`).
   */
  private announcePrice(core: CoreKeyHex, prev: PricePolicy, next: PricePolicy): void {
    if (this.freeCores.has(core)) return;
    for (const [session, protocol] of this.protocols) {
      if (session.closed || !this.pricedOn(session, core)) continue;
      const fromBlock = session.nextIndexFor(core);
      const byCore = this.historyOf(session);
      const list = byCore.get(core) ?? [{ fromBlock: 0, policy: prev }];
      list.push({ fromBlock, policy: next });
      byCore.set(core, list);
      this.toldOf(session).set(core, 'priced');
      protocol.sendPrice({ core, satsPerBlock: next.satsPerBlock, effectiveFromBlock: fromBlock });
    }
  }

  /**
   * Contracts v6 amendment, rule 1: a block of `core` is about to go to this peer (`free`: outside
   * payment) — unless the peer was already told exactly that on this connection, send the core's
   * `PRICE` first. Runs inside Hypercore's `upload` event, before the block is written, so the
   * `PRICE` precedes it on the wire. Priced: from one past the highest block of the core counted on
   * this connection (0 at first), remembered for the PAYs to come (F9). A core with no price at
   * all (none of its own, no default) has no terms to announce.
   */
  private announceTerms(session: PeerSession, core: CoreKeyHex, free: boolean): void {
    const protocol = this.protocols.get(session);
    if (protocol === undefined || session.closed) return;
    const told = this.toldOf(session);
    const said = told.get(core);
    // `told` is set only once the PRICE is out: a send that throws is retried on the next block
    // (the session cuts this one, `PeerSession.onUpload`).
    if (free) {
      if (said === 'free') return;
      protocol.sendPrice({ core, satsPerBlock: 0 as Sats, effectiveFromBlock: 0, free: true });
      told.set(core, 'free');
      return;
    }
    if (said === 'priced') return;
    const policy = this.corePolicies.get(core) ?? this.policyOverride;
    if (policy === null) return;
    const fromBlock = session.nextIndexFor(core);
    protocol.sendPrice({ core, satsPerBlock: policy.satsPerBlock, effectiveFromBlock: fromBlock });
    const byCore = this.historyOf(session);
    const list = fromBlock === 0 ? [] : (byCore.get(core) ?? []);
    list.push({ fromBlock, policy });
    byCore.set(core, list);
    told.set(core, 'priced');
  }

  /**
   * `announceTerms` at the core's current kind, for a peer that has the core open but asked for
   * nothing yet (unprompted, rule 1). Never throws: a failure is logged, and the core's next block
   * to that peer says the terms first or is not sent (`beforeBlock` fails closed).
   */
  private tellTerms(session: PeerSession, core: CoreKeyHex): void {
    try {
      this.announceTerms(session, core, this.freeCores.has(core));
    } catch (err) {
      this.log.error('terms not said unprompted — the next block says them first', {
        error: err,
      });
    }
  }

  /** `tellTerms` to every live session `core` is paired on now (its kind or price changed). */
  private tellPaired(core: CoreKeyHex): void {
    const g = this.gates.get(core);
    if (g === undefined) return;
    for (const session of this.sessions.pairedSessions(g.core)) this.tellTerms(session, core);
  }

  /**
   * Contracts v6 amendment, rules 2–3: the channel is open (both HELLOs verified, the pubkey bound)
   * — report, once, every core where this peer's pubkey still owes blocks, oldest first and within
   * the `OWED` caps, each after that core's priced `PRICE` (the terms an owed range is paid at). A
   * core served free now, or with no price at all, gets its `OWED` with no `PRICE`: counted, but
   * not payable here now. v7 rule 5: the report then ends with the end marker — also when nothing
   * is owed — so the viewer knows it is complete without waiting.
   */
  private announceOwed(session: PeerSession, protocol: PayProtocol): void {
    const peer = session.pubkey;
    if (peer === null || session.closed || session.cutReason !== null) return;
    if (this.owedSent.has(session)) return;
    this.owedSent.add(session);
    const report = this.ledger.unpaid(peer, payment.OWED_LIMITS);
    let blocks = 0;
    for (const { core, ranges } of report) {
      if (!this.freeCores.has(core)) this.announceTerms(session, core, false);
      protocol.sendOwed({ core, ranges });
      for (const [from, to] of ranges) blocks += to - from + 1;
    }
    protocol.sendOwed({ core: OWED_END_CORE, ranges: [] });
    if (report.length > 0) this.log.debug('OWED sent', { cores: report.length, blocks });
  }

  /** v5: `policyFor` for the effective window, never throwing (unpriced when none). */
  private pricingFor(core: CoreKeyHex): Pick<PricePolicy, 'satsPerBlock' | 'minPaySats'> {
    const p = this.corePolicies.get(core) ?? this.policyOverride;
    return p ?? { satsPerBlock: 0 as PricePolicy['satsPerBlock'] };
  }

  /**
   * Set (or with `null` clear) the policy for one core. When that changes the core's price, every
   * live `pay/1` peer that downloaded it gets a `PRICE` for the core (v5 `PRICE` names its core),
   * and blocks it was already sent stay at the old price (F9). A peer that has the core open and
   * was told it free (or nothing) is told the price now (rule 1, unprompted). `announce: false`
   * skips both; the core's next block to a peer still says its terms first.
   */
  setCorePolicy(
    core: CoreKeyHex,
    policy: PricePolicy | null,
    opts: { readonly announce?: boolean } = {},
  ): void {
    const prev = this.corePolicies.get(core) ?? this.policyOverride;
    if (policy === null) this.corePolicies.delete(core);
    else {
      this.corePolicies.set(core, policy);
      // A core with a price is sold, never served free (fix round 4).
      this.freeCores.delete(core);
    }
    // Lane W8b-p2p: kept across restarts (written in the background; `close` waits for it).
    if (!this.corePolicyStore.set(core, policy))
      this.log.warn('a core policy of an unexpected shape is not kept across restarts');
    const next = this.corePolicies.get(core) ?? this.policyOverride;
    if (!(opts.announce ?? true)) return;
    if (prev !== null && next !== null && prev.satsPerBlock !== next.satsPerBlock)
      this.announcePrice(core, prev, next);
    this.tellPaired(core);
  }

  /**
   * Per-core policies currently set (does not include the default) — those set in earlier runs
   * included (lane W8b-p2p: loaded back at start).
   */
  corePolicyMap(): ReadonlyMap<CoreKeyHex, PricePolicy> {
    return this.corePolicies;
  }

  /**
   * ADR 0015: serve `core` outside payment (a creator's profile core — thumbnails, avatars), or
   * stop. A free core's blocks are never recorded against a peer's window. Fix round 4: a core
   * with its own price policy is never marked free (`false` is returned and nothing changes), and
   * `setCorePolicy` clears the mark — so a caller that names a paid core by mistake (an image URL
   * pointing at a video) cannot give that video away. A change reaches every peer that has the
   * core open now, unprompted (rule 1): `{ free: true }`, or back to its price. Lane W8b-p2p: a
   * policy set in an EARLIER run counts too (they are kept across restarts), so an image URL
   * naming a video this node sold before a restart cannot give it away either.
   */
  setFreeCore(core: CoreKeyHex, free: boolean): boolean {
    if (!free) {
      if (this.freeCores.delete(core)) this.tellPaired(core);
      return true;
    }
    if (this.corePolicies.has(core)) return false;
    if (!this.freeCores.has(core)) {
      this.freeCores.add(core);
      this.tellPaired(core);
    }
    return true;
  }

  /** Whether `core` is served outside payment. */
  isFreeCore(core: CoreKeyHex): boolean {
    return this.freeCores.has(core);
  }

  /**
   * Change the DEFAULT price policy. With `announce` (default) every live `pay/1` peer gets a
   * `PRICE` message per core it has downloaded under the default policy (v5: `PRICE` names
   * its core); blocks already uploaded stay at the old price (`effectiveFromBlock` = one past
   * the highest index of that core sent on the session).
   */
  setPolicy(policy: PricePolicy, opts: { readonly announce?: boolean } = {}): void {
    const prev = this.policyOverride;
    const changed = prev !== null && prev.satsPerBlock !== policy.satsPerBlock;
    this.policyOverride = policy;
    if (!(opts.announce ?? true) || !changed) return;
    const cores = new Set<CoreKeyHex>();
    for (const session of this.protocols.keys()) {
      if (session.closed) continue;
      const sold = [
        ...(session.uploadedCores as ReadonlySet<CoreKeyHex>),
        ...[...(this.told.get(session) ?? [])].filter(([, t]) => t === 'priced').map(([c]) => c),
      ];
      for (const core of sold) if (!this.corePolicies.has(core)) cores.add(core);
    }
    for (const core of cores) this.announcePrice(core, prev, policy);
  }

  session(noiseKey: Uint8Array | string): PeerSession | undefined {
    return this.sessions.get(noiseKey);
  }

  sessionInfos(): readonly PeerSessionInfo[] {
    return this.sessions.all().map((s) => s.info());
  }

  // ------------------------------------------------------------------ bans

  bans(): readonly PersistedBan[] {
    return this.banList.entries();
  }

  ban(target: { pubkey?: NostrPubkey; noiseKey?: Uint8Array }, reason: string): void {
    this.banList.ban({ pubkey: target.pubkey ?? null, noiseKey: target.noiseKey ?? null, reason });
    if (target.pubkey !== undefined) {
      if (!this.engine.isBanned(target.pubkey))
        this.engine.ban(target.pubkey, reason, target.noiseKey);
      this.sessions.cutPubkey(target.pubkey, 'banned');
    }
    if (target.noiseKey !== undefined) {
      this.sessions.get(target.noiseKey)?.cut('banned');
      this.swarm?.peerInfo(target.noiseKey)?.ban(true);
    }
  }

  unban(target: { pubkey?: NostrPubkey; noiseKey?: Uint8Array }): boolean {
    const ok = this.banList.unban(target);
    if (target.pubkey !== undefined && this.engine.isBanned(target.pubkey))
      this.engine.unban(target.pubkey);
    if (target.noiseKey !== undefined) this.swarm?.peerInfo(target.noiseKey)?.ban(false);
    return ok;
  }

  // ------------------------------------------------------------------ payment

  flushNow(): Promise<FlushResult> {
    return this.scheduler.flush('manual');
  }

  stats(): SeederStats {
    return {
      cores: this.blobs.openCores().length,
      blobs: this.index.entries().length,
      usedBytes: this.diskCap.usedBytes,
      capBytes: this.diskCap.capBytes,
      sessions: this.sessions.size,
      swarmConnections: this.swarm?.connections ?? 0,
      bans: this.banList.entries().length,
      flushes: this.scheduler.flushes,
      pendingPaidBlocks: this.scheduler.pendingBlocks,
    };
  }

  // ------------------------------------------------------------------ internals

  private afterPut(r: PutResult): PutResult {
    if (r.ok) this.emit({ type: 'blob-added', entry: r.entry, deduplicated: r.deduplicated });
    return r;
  }

  private onCoreOpened(sc: SeedCore): void {
    const had = this.gates.get(sc.keyHex);
    if (had?.core !== sc.core) {
      had?.detach();
      this.gates.set(sc.keyHex, { core: sc.core, detach: this.sessions.attachUploadGate(sc.core) });
      // A peer paired while the core was still opening had its `peer-add` before the gate was here.
      this.tellPaired(sc.keyHex);
    }
    if (this.started && this.swarm) this.swarm.join(sc.core.discoveryKey);
  }

  /** `closeCoreByKey`: that session's gate goes with it (a reopen attaches a new one). */
  private onCoreClosed(sc: SeedCore): void {
    const had = this.gates.get(sc.keyHex);
    if (had?.core !== sc.core) return;
    had.detach();
    this.gates.delete(sc.keyHex);
  }

  private onSwarmSession(session: PeerSession, conn: SwarmConnection, _info: PeerInfo): void {
    this.blobs.store.replicate(conn);
    this.log.info('swarm session', { noiseKey: session.noiseKeyHex });
    this.sessionReady(session);
  }

  private sessionReady(session: PeerSession): void {
    if (session.closed) return;
    for (const cb of this.readyListeners) {
      try {
        cb(session);
      } catch (err) {
        this.log.error('session-ready listener threw', { error: err });
      }
    }
  }

  private wireEvents(): void {
    this.unsubs.push(
      this.sessions.on((e: SessionEvent) => {
        switch (e.type) {
          case 'open':
            this.emit({ type: 'session-open', session: e.session.info() });
            break;
          case 'close': {
            const info = e.session.info();
            if (info.cutReason !== null)
              this.emit({ type: 'session-cut', session: info, reason: info.cutReason });
            this.emit({ type: 'session-close', session: info });
            break;
          }
          case 'refused':
            this.emit({ type: 'session-refused', noiseKeyHex: e.noiseKeyHex, reason: e.reason });
            break;
        }
      }),
    );
    // Belt and braces: an engine-side window decision (e.g. from a replayed bind) cuts too.
    this.unsubs.push(
      this.engine.onWindowExceeded((w) => {
        this.sessions.cutPubkey(w.peer, 'window-exceeded');
      }),
    );
    this.unsubs.push(
      this.engine.onDoubleSpend((peer, detail) => {
        this.log.warn('double-spend reported by mint — banning', {
          peer,
          mint: detail.mint,
          amount: detail.amount,
        });
        const noise = this.sessions.find(peer)[0]?.noiseKey ?? null;
        this.banList.ban({ pubkey: peer, noiseKey: noise, reason: 'double-spend' });
        this.sessions.cutPubkey(peer, 'banned');
        if (noise) this.swarm?.peerInfo(noise)?.ban(true);
        this.emit({ type: 'double-spend', peer, mint: detail.mint, amount: detail.amount });
      }),
    );
    this.unsubs.push(
      this.scheduler.onFlush((result, trigger) => {
        this.emit({ type: 'flush', result, trigger });
      }),
    );
  }

  private emit(e: SeederEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch (err) {
        this.log.error('seeder listener threw', { error: err });
      }
    }
  }
}
