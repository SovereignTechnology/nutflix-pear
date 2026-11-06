/**
 * WorkerHost — the desktop data plane (design §1 Worker row, §6 L6-C). Runtime-neutral: the
 * runtime is injected (`WorkerRuntime`), so the same object runs under Node in tests and
 * under Bare in production (`./entry.ts` wires it to `Bare.IPC` through `./rpc.ts`).
 *
 * It owns, per worker process:
 *   - ONE `@sovit/seeder` (its Corestore is the worker's only Corestore) created with
 *     `swarm: null`, and ONE `PeerNode` (Hyperswarm, firewall = the seeder's ban list);
 *   - the `CreditPool` + `ViewerPayer` (viewer side: pay what we download, stay under the
 *     seeders' unpaid window);
 *   - the `PlaybackServer` and one `PlaybackGate` per play session;
 *   - the ffmpeg probe and Studio uploads (L8's runner, `studio.publish` asked of the host);
 *   - slice 5b/5d (ADR 0020): NFX seeding over HyperDHT, and free NFX play sessions
 *     (`nfx/watching.ts`), which need no payment providers — without them the worker has no
 *     swarm, and NFX play dials from a DHT node of its own;
 *   - slice 5e-3 (ADR 0021): with an iroh helper (`init.irohHelper`), the same NFX videos over
 *     iroh too (`nfx/iroh-seeding.ts`), through ONE helper process (`nfx/iroh.ts`).
 *
 * Every request arrives already validated by `validateWorkerArgs` (the rpc layer runs the
 * L6-0 guards); failures are thrown as `<code>: …` errors that the rpc layer turns into
 * `WireError`s with `toWireError`.
 */
import type {
  CoreKeyHex,
  IrohRelayUrl,
  MintUrl,
  NostrPubkey,
  PeerSpend,
  PricePolicy,
  Sats,
  Sha256Hex,
  UploadProgress,
  VideoManifest,
} from '@sovit/core';
import { MAX_IMAGE_BYTES, manifest, media } from '@sovit/core';
import type { LogLevel, Logger, SeedCore } from '@sovit/seeder';
import { Seeder, fromHex, toHex } from '@sovit/seeder';

import { fromHex as hexToBytes } from '../ipc/codec.js';
import { IpcError } from '../ipc/errors.js';
import type { ErrorCode, FfmpegStatus, SeederStatusWire, SessionId } from '../ipc/protocol.js';
import { LIMITS } from '../ipc/protocol.js';
import type {
  HostMethod,
  HostMethodTable,
  NfxPlayOpenArgs,
  NfxStoredVideoWire,
  PlayOpenArgs,
  Req,
  StudioUploadArgs,
  WorkerEvent,
  WorkerInit,
  WorkerMethodTable,
} from '../ipc/worker-protocol.js';
import { WORKER_V } from '../ipc/worker-protocol.js';
import { randomHex, sodiumCrypto, sodiumSha256 } from './crypto.js';
import type { DleqSelfCheck } from './dev/dleq-selfcheck.js';
import type { LoopbackPayHub } from './dev/loopback-pay.js';
import type { DevTestnet, FixtureInput, FixtureNet } from './dev/fixtures-net.js';
import { probeFfmpeg } from './ffmpeg.js';
import { createWorkerLogger } from './log.js';
import type { LogEvent } from './log.js';
import { PeerNode } from './net/peer-node.js';
import type { BootstrapNode } from './net/peer-node.js';
import type { SpawnDleqThread } from './pay/dleq-thread.js';
import { boundToSessions, sessionsCovering } from './pay/session-ranges.js';
import type { TailTerms } from './pay/unpaid-record.js';
import { UnpaidRecord } from './pay/unpaid-record.js';
import type { PaidEvent } from './pay/viewer-payer.js';
import { ViewerPayer } from './pay/viewer-payer.js';
import { CreditPool } from './playback/credit.js';
import type { GateClock } from './playback/gate.js';
import { PlaybackGate, bytesPerSecondOf } from './playback/gate.js';
import { PlaybackServer } from './playback/server.js';
import type { ProviderContext, WorkerProviders } from './providers.js';
import {
  MISSING_PROVIDERS_DETAIL,
  MISSING_PROVIDERS_REASON,
  getWorkerProviders,
} from './providers.js';
import type { WorkerRuntime } from './runtime.js';
import { NFX_IROH_DIR, NfxIrohNode } from './nfx/iroh.js';
import { NfxIrohSeeding } from './nfx/iroh-seeding.js';
import { NfxSeeding } from './nfx/seeding.js';
import { NFX_PLAY_DIR, NfxWatching } from './nfx/watching.js';
import { NFX_DEFAULT_NAMESPACE } from './studio/nfx.js';
import { runWorkerUpload } from './studio/upload.js';

/** Live play sessions per worker (the host backstop keeps ≤ 1 unpaused per window). */
export const MAX_SESSIONS = 16;
/** Trailing window for `ratePerMin`. */
const RATE_WINDOW_MS = 60_000;
/** At most one `seeder.status` push per this many ms. */
const STATUS_THROTTLE_MS = 1000;
/** ADR 0015: the corestore name of this node's own profile core (avatar, thumbnails). */
export const PROFILE_CORE_NAME = 'nutflix-profile';
/** How long one image read may take over the swarm. */
export const IMAGE_FETCH_TIMEOUT_MS = 15_000;
/**
 * Fix round 4: how long `play.close` (and shutdown) waits for the session's tail to be paid —
 * PAYs built while the session still authorises them, ACKed, blocks in flight landed — before the
 * session goes. The host revokes the session only after `play.close` answers.
 */
export const CLOSE_DRAIN_MS = 5000;
/** Lane P2-owed-viewer: the worker's durable record of unpaid blocks lives here (per identity). */
export const UNPAID_DIR = 'unpaid';
const ZERO_PUBKEY = '00'.repeat(32) as NostrPubkey;

export type HostRequester = <M extends HostMethod>(
  m: M,
  a: HostMethodTable[M][0],
) => Promise<HostMethodTable[M][1]>;

export type WorkerRequest = Req<WorkerMethodTable>;

export interface WorkerHostOptions {
  readonly runtime: WorkerRuntime;
  /** Events to the host (the rpc layer validates and frames them). */
  readonly emit: (ev: WorkerEvent) => void;
  /** Worker → host requests (`studio.publish`). */
  readonly request: HostRequester;
  /** Dev (D1): the in-process `pay/1` hub, shared with in-process fixture seeders. */
  readonly hub?: LoopbackPayHub;
  readonly logLevel?: LogLevel;
  /** Stage 2 seam; default `getWorkerProviders` (undefined in Stage 1). */
  readonly providers?: (ctx: ProviderContext) => WorkerProviders | undefined;
  readonly clock?: GateClock;
  /** x264 preset for Studio transcodes (tests: `ultrafast`). */
  readonly uploadPreset?: string;
  /**
   * TESTS ONLY: a local DHT for a worker with REAL payments (`init.dev.bootstrap` is fenced to
   * mock payments). Programmatic only — never reachable over IPC, never set by `entry.ts`.
   */
  readonly testBootstrap?: readonly BootstrapNode[];
  readonly now?: () => number;
  /**
   * TESTS ONLY (programmatic, never over IPC): shorter bounds for an image read
   * (`IMAGE_FETCH_TIMEOUT_MS`), a seeder's report (`REPORT_WAIT_MS`) and the unpaid record's
   * batches (`FLUSH_MS`).
   */
  readonly imageTimeoutMs?: number;
  readonly reportWaitMs?: number;
  readonly unpaidFlushMs?: number;
}

interface Net {
  readonly providers: WorkerProviders;
  readonly seeder: Seeder;
  readonly node: PeerNode;
  readonly payer: ViewerPayer;
  readonly credit: CreditPool;
  /** Lane P2-owed-viewer: blocks received and not paid, per seeder (null: dev mocks). */
  readonly record: UnpaidRecord | null;
}

interface PeerTally {
  sats: number;
  blocks: number;
  readonly recent: { at: number; amount: number }[];
}

interface Session {
  readonly sid: SessionId;
  readonly core: CoreKeyHex;
  /** Its rendition's blocks in `core`, first and last (fix round 5: whose PAYs are whose). */
  readonly first: number;
  readonly last: number;
  readonly gate: PlaybackGate;
  readonly openedAt: number;
  total: number;
  readonly recent: { at: number; amount: number }[];
  readonly peers: Map<NostrPubkey, PeerTally>;
  closed: boolean;
  /**
   * Its close in progress (the tail being paid): a second `play.close` waits for it. Resolves
   * with the blocks of it still unpaid (lane P2-owed-viewer).
   */
  closing: Promise<number> | null;
}

/** A core the image path reads (ADR 0015). */
interface ImageCore {
  /** Reads in flight. */
  refs: number;
  /** The image path opened it: a replica read for display — free while open, closed if unserved. */
  readonly opened: boolean;
}

function fail(code: ErrorCode, detail: string): never {
  throw new IpcError(code, `${code}: ${detail}`);
}

/** `p`, or a rejection after `ms` (a read that never finishes is a failed read). */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('deadline'));
    }, ms);
  });
  return Promise.race([p, deadline]).finally(() => {
    clearTimeout(timer);
  });
}

function trailingSum(recent: { at: number; amount: number }[], now: number): number {
  while (recent.length > 0 && (recent[0]?.at ?? now) < now - RATE_WINDOW_MS) recent.shift();
  let s = 0;
  for (const r of recent) s += r.amount;
  return s;
}

export class WorkerHost {
  private readonly o: WorkerHostOptions;
  private readonly now: () => number;
  private initialising: Promise<void> | null = null;
  private live: {
    readonly init: WorkerInit;
    readonly log: Logger;
    readonly server: PlaybackServer;
    readonly storage: string;
    readonly tmpDir: string;
  } | null = null;
  private net: Net | null = null;
  private hub: LoopbackPayHub | null = null;
  private fixtures: FixtureNet | null = null;
  private testnet: DevTestnet | null = null;
  /** `--dev-fixtures`: the DLEQ self-check (`dev/dleq-selfcheck.ts`), once it is loaded. */
  private devDleq: Promise<DleqSelfCheck | null> | null = null;
  private seeding: WorkerInit['seeding'] = { enabled: false, diskCapBytes: 0 };
  /** Slice 5b: `Settings.nfx.enabled`, as the host last said. */
  private nfxEnabled = false;
  /** Slice 5b: NFX-12 seeding of the store's NFX videos (with the net). */
  private nfxSeeding: NfxSeeding | null = null;
  /** Slice 5e-3: `Settings.nfx.irohRelays`, as the host last said. */
  private nfxIrohRelays: readonly IrohRelayUrl[] = [];
  /** Slice 5e-3: NFX-06 seeding of the same videos (with the net and an iroh helper). */
  private nfxIroh: NfxIrohSeeding | null = null;
  /** Slice 5d: free NFX play sessions (with or without the net). */
  private nfxWatch: NfxWatching | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly corePolicies = new Map<CoreKeyHex, PricePolicy>();
  /**
   * Lane W8b-p2p: the key of our own profile core once it is open — never a video: a play open
   * naming it is refused, so a hostile manifest cannot give it a price (kept across restarts now).
   */
  private profileKey: CoreKeyHex | null = null;
  /**
   * ADR 0015: profile cores the image path uses — `opened` when that path opened them (a replica
   * read for display, closed again when this node may not serve it), `refs` = reads in flight.
   */
  private readonly imageCores = new Map<CoreKeyHex, ImageCore>();
  private readonly coresAttached = new Set<string>();
  private readonly lastSidForCore = new Map<string, Session>();
  private readonly uploads = new Set<string>();
  private ffmpeg: media.FfmpegPaths | null = null;
  private ffmpegStatus: { readonly key: string; readonly status: FfmpegStatus } | null = null;
  private earnedTotal = 0;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private closing: Promise<void> | null = null;

  constructor(o: WorkerHostOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  /** The playback server's port (0 before `init`). */
  get port(): number {
    return this.live?.server.port ?? 0;
  }

  /** Test / diagnostics hooks (read-only views). */
  get internals(): {
    readonly seeder: Seeder | null;
    readonly node: PeerNode | null;
    readonly payer: ViewerPayer | null;
    readonly credit: CreditPool | null;
    readonly record: UnpaidRecord | null;
    readonly server: PlaybackServer | null;
    readonly providers: WorkerProviders | null;
    readonly fixtures: FixtureNet | null;
    gate(sid: string): PlaybackGate | null;
  } {
    return {
      seeder: this.net?.seeder ?? null,
      node: this.net?.node ?? null,
      payer: this.net?.payer ?? null,
      credit: this.net?.credit ?? null,
      record: this.net?.record ?? null,
      server: this.live?.server ?? null,
      providers: this.net?.providers ?? null,
      fixtures: this.fixtures,
      gate: (sid) => this.sessions.get(sid)?.gate ?? null,
    };
  }

  /** The `ready` event that follows a successful `init` (sent by the rpc layer). */
  readyEvent(): WorkerEvent {
    return { op: 'ev', e: 'ready', v: WORKER_V, port: this.port };
  }

  /** Dispatch one validated host request. Throws `<code>: …` errors. */
  async handle(req: WorkerRequest): Promise<unknown> {
    if (this.closing !== null) fail('backend-down', 'worker is shutting down');
    if (req.m === 'init') {
      await this.init(req.a);
      return undefined;
    }
    if (this.live === null) fail('backend-down', 'worker is not initialised');
    switch (req.m) {
      case 'play.open':
        return this.playOpen(req.a);
      case 'play.pause':
        this.session(req.a.sid).gate.pause();
        return undefined;
      case 'play.resume':
        this.session(req.a.sid).gate.resume();
        return undefined;
      case 'play.prefetch':
        this.session(req.a.sid).gate.setPrefetchSeconds(req.a.seconds);
        return undefined;
      case 'play.close':
        return { unpaid: await this.closeSession(req.a.sid) };
      case 'seeder.status':
        return this.seederStatus();
      case 'seeder.configure':
        this.configureSeeding(req.a);
        return undefined;
      case 'seeder.melt':
        return fail(
          'payments-unavailable',
          'melting seeder earnings lands with the Stage 2 wallet',
        );
      case 'seeder.unban':
        this.net?.seeder.unban({ pubkey: req.a.pubkey });
        this.pushStatusSoon();
        return undefined;
      case 'nfx.configure':
        this.nfxEnabled = req.a.enabled;
        this.nfxIrohRelays = req.a.irohRelays;
        await this.applyNfxSeeding();
        return undefined;
      case 'nfx.endpoint':
        return {
          hyperdht: (await this.nfxSeeding?.endpoint(req.a.seeder)) ?? null,
          iroh: this.nfxIroh?.endpoint(req.a.video) ?? null,
        };
      case 'nfx.videos':
        return { videos: this.nfxVideos() };
      case 'nfx.play.open':
        return this.nfxPlayOpen(req.a);
      case 'nfx.play.close':
        await this.nfxWatch?.close(req.a.sid);
        return undefined;
      case 'studio.ffmpeg':
        return this.probe(req.a.recheck, req.a.path);
      case 'studio.upload':
        return this.upload(req.a);
      case 'image.fetch':
        return this.imageFetch(req.a);
      case 'profile.putImage':
        return this.putProfileImage(hexToBytes(req.a.hex));
    }
  }

  // ------------------------------------------------------------------ init

  private init(a: WorkerInit): Promise<void> {
    if (this.initialising !== null) fail('invalid-argument', 'worker already initialised');
    this.initialising = this.doInit(a);
    return this.initialising;
  }

  private async doInit(a: WorkerInit): Promise<void> {
    const { runtime } = this.o;
    const log = createWorkerLogger({
      emit: (ev: LogEvent) => {
        this.o.emit(ev);
      },
      level: this.o.logLevel ?? 'info',
    });
    const dev = a.dev;
    if (dev !== undefined) {
      const { checkDevFence } = await import('./dev/dev-mocks.js');
      checkDevFence(dev);
    }
    const fs = runtime.seederFs;
    await fs.mkdir(a.storage, { recursive: true });
    // Studio work dirs (transcodes, thumbnail candidates) live here; a previous run's are dead.
    const tmpDir = fs.join(a.storage, 'tmp');
    await runtime.mediaFs(a.storage).rm(tmpDir, { recursive: true });
    await fs.mkdir(tmpDir, { recursive: true });
    this.seeding = a.seeding;
    this.nfxEnabled = a.nfx?.enabled === true;
    this.nfxIrohRelays = a.nfx?.irohRelays ?? [];
    if (a.ffmpeg !== undefined) this.ffmpeg = a.ffmpeg;

    const server = new PlaybackServer({ logger: log, randomHex });
    await server.listen();
    this.live = { init: a, log, server, storage: a.storage, tmpDir };
    // Slice 5d: before the providers, which free NFX play does not need. The swarm's DHT and the
    // seeder's key derivation are read when a session dials, so a worker with payment providers
    // dials from its swarm and one without dials from a node of its own (`nfx/watching.ts`).
    this.nfxWatch = new NfxWatching({
      swarmDht: () => this.net?.node.dht ?? null,
      bootstrap: dev?.bootstrap ?? this.o.testBootstrap ?? null,
      seederKeyPair: (name) => this.net?.seeder.blobs.store.createKeyPair(name) ?? null,
      fs,
      rmTree: (p) => runtime.mediaFs(a.storage).rm(p, { recursive: true }),
      spoolDir: fs.join(tmpDir, NFX_PLAY_DIR),
      crypto: sodiumCrypto,
      createHttpServer: runtime.createHttpServer,
      randomHex,
      logger: log,
    });

    let providers: WorkerProviders | undefined;
    const ctx: ProviderContext = { storage: a.storage };
    if (dev?.mocks === true) {
      const { devMockProviders } = await import('./dev/dev-mocks.js');
      const { LoopbackPayHub } = await import('./dev/loopback-pay.js');
      this.hub = this.o.hub ?? new LoopbackPayHub();
      providers = devMockProviders({ hub: this.hub, label: randomHex(8) });
      log.warn('DEV MOCKS: MockPaymentEngine + in-process pay/1; swarm fenced to loopback');
    } else if (a.payments !== undefined) {
      // Stage 3 (ADR 0012): the host's money plane is live — real engines, every money step
      // asked of the host.
      const { realProviders, servedPriceCeiling } = await import('./pay/real-providers.js');
      try {
        providers = realProviders({
          payments: a.payments,
          dir: fs.join(a.storage, 'payments'),
          join: (...p) => fs.join(...p),
          state: runtime.stateFs,
          ...(runtime.dleqThread === undefined ? {} : { dleqThread: runtime.dleqThread }),
          request: this.o.request,
          // Fix round 5: a PAY is built for a session whose blob covers its blocks (open ones
          // first, then those closing — fix round 4 keeps a closing session until its tail is
          // paid). By core alone, a rendition switch's NEW session was named for the old one's
          // tail, the host refused it as outside its video, and the blocks were written off.
          sidsFor: (range) => sessionsCovering(range, this.sessions.values()),
          // F54: the cores open in THIS run, never a policy kept from an earlier one (those
          // still refuse free, but a kept ceiling would never come down).
          priceCeiling: () => servedPriceCeiling(this.net?.seeder ?? null),
          logger: log,
        });
      } catch (err) {
        log.error('payments could not start', { error: err });
        providers = undefined;
      }
    } else {
      providers = (this.o.providers ?? getWorkerProviders)(ctx);
    }
    if (providers === undefined) {
      log.warn(MISSING_PROVIDERS_REASON);
      return;
    }

    let bootstrap: readonly BootstrapNode[] | null = dev?.bootstrap ?? this.o.testBootstrap ?? null;
    if (dev?.fixtures === true && bootstrap === null) {
      const { startDevTestnet } = await import('./dev/fixtures-net.js');
      this.testnet = await startDevTestnet();
      bootstrap = this.testnet.bootstrap;
    }
    if (providers.loopbackOnly && bootstrap === null)
      fail('invalid-argument', 'dev providers need a loopback bootstrap');

    const seeder = await Seeder.create(
      {
        dataDir: fs.join(a.storage, 'seeder'),
        diskCapBytes: a.seeding.diskCapBytes,
        swarm: null,
        // Several videos at their own manifest prices: each core's PRICE (or `free` for a profile
        // core) precedes its first block, a returning viewer gets OWED, and every ACK carries
        // `outstanding` — always on in `Seeder` (contracts v6 amendment), dev mocks included.
      },
      {
        engine: providers.seederEngine,
        fs,
        crypto: sodiumCrypto,
        logger: log,
        ...(providers.accepting === undefined ? {} : { accepting: providers.accepting }),
      },
    );
    const keyPair = await seeder.blobs.store.createKeyPair('nutflix-desktop-swarm');
    const credit = new CreditPool(providers.creditBlocks);
    // Lane P2-owed-viewer (ADR 0018 amendment): the durable record of blocks received and not paid,
    // per OUR identity (the seeders count per it). Not with --dev-mocks: that identity is new every
    // run, so nothing it left could ever be reported back to it.
    const record =
      dev?.mocks === true
        ? null
        : new UnpaidRecord({
            state: runtime.stateFs,
            dir: fs.join(a.storage, UNPAID_DIR),
            join: (...p) => fs.join(...p),
            pubkey: providers.pubkey,
            logger: log,
            ...(this.o.unpaidFlushMs === undefined ? {} : { flushMs: this.o.unpaidFlushMs }),
          });
    const payOwed = providers.payOwed;
    const payer = new ViewerPayer({
      pay: providers.pay,
      ownMints: providers.viewerMints,
      credit,
      logger: log,
      clock: runtime.monotonicNow,
      policyFor: (core) => this.corePolicies.get(core) ?? null,
      boundRange: (range) => boundToSessions(range, this.sessions.values()),
      onPaid: (e) => {
        this.onPaid(e);
      },
      ...(record === null ? {} : { record, termsFor: (core, i) => this.termsFor(core, i) }),
      ...(payOwed === undefined ? {} : { payOwed }),
      ...(this.o.reportWaitMs === undefined ? {} : { reportWaitMs: this.o.reportWaitMs }),
    });
    const node = new PeerNode({
      seeder,
      logger: log,
      bootstrap,
      loopbackOnly: providers.loopbackOnly,
      keyPair,
      pay: providers.payWiring,
      payer,
    });
    seeder.on((e) => {
      if (e.type === 'flush') this.earnedTotal += e.result.swapped;
      if (e.type !== 'blob-added' && e.type !== 'blob-removed') this.pushStatusSoon();
    });
    seeder.start();
    node.start();
    this.net = { providers, seeder, node, payer, credit, record };
    this.nfxSeeding = new NfxSeeding(
      {
        dht: () => node.dht,
        keyPair: (name) => seeder.blobs.store.createKeyPair(name),
        source: seeder.nfx.source(),
        logger: log,
      },
      NFX_DEFAULT_NAMESPACE,
    );
    // Slice 5e-3 (ADR 0021): with a helper, over iroh as well. Its store is a cache under `tmp/`
    // (emptied above); its key is derived like the listener's, under its own name. Without a
    // helper the worker speaks HyperDHT only.
    const irohHelper = a.irohHelper ?? null;
    if (irohHelper !== null)
      this.nfxIroh = new NfxIrohSeeding({
        node: new NfxIrohNode(
          {
            file: irohHelper,
            spawn: runtime.spawnHelper,
            isExecutable: (p) => runtime.isExecutable(p),
            stateDir: fs.join(tmpDir, NFX_IROH_DIR),
            rmTree: (p) => runtime.mediaFs(a.storage).rm(p, { recursive: true }),
            keyPair: (name) => seeder.blobs.store.createKeyPair(name),
            logger: log,
          },
          NFX_DEFAULT_NAMESPACE,
        ),
        store: seeder.nfx,
        logger: log,
      });
    // Listening announces on the DHT, which can take a while: `ready` does not wait for it.
    void this.applyNfxSeeding();
    // ADR 0015: our own profile core (avatar, thumbnails) is served free while seeding.
    this.ownProfile().catch(() => {
      log.warn('the profile core could not be opened');
    });
    log.info('worker initialised', { seeding: a.seeding.enabled, port: server.port });

    if (dev?.fixtures === true && bootstrap !== null) void this.startFixtures(bootstrap);
    // ADR 0017: show whether this build's worker finds its DLEQ thread (only a runtime that has
    // threads — Bare — can say; the check logs one line).
    if (dev?.fixtures === true && runtime.dleqThread !== undefined)
      this.devDleq = this.startDevDleqCheck(runtime.dleqThread, log);
  }

  private async startDevDleqCheck(
    spawn: SpawnDleqThread,
    log: Logger,
  ): Promise<DleqSelfCheck | null> {
    try {
      const { startDleqSelfCheck } = await import('./dev/dleq-selfcheck.js');
      // Closing meanwhile: never start a thread that `close` would not stop.
      if (this.closing !== null) return null;
      return startDleqSelfCheck({ spawn, logger: log });
    } catch (err) {
      log.error('the DLEQ self-check could not start', { error: err });
      return null;
    }
  }

  private async startFixtures(bootstrap: readonly BootstrapNode[]): Promise<void> {
    const live = this.live;
    if (live === null) return;
    const log = live.log;
    try {
      const {
        DEV_FIXTURES_ENV,
        MAX_DEV_FIXTURE_BYTES,
        generateDevClip,
        parseDevFixturesEnv,
        startFixtureNet,
        syntheticBytes,
      } = await import('./dev/fixtures-net.js');
      const hub = this.hub;
      if (hub === null) throw new Error('internal: fixtures without the dev pay hub');
      const fs = this.o.runtime.seederFs;
      // Fixture seeders are rebuilt every run: drop the previous runs' stores first.
      const root = fs.join(live.storage, 'dev-fixtures');
      await this.o.runtime.mediaFs(live.storage).rm(root, { recursive: true });
      const dir = fs.join(root, randomHex(8));
      await fs.mkdir(dir, { recursive: true });
      if (this.ffmpeg === null) await this.probe(false);
      const paths = this.ffmpeg;
      const fixtures: FixtureInput[] = [];
      // The §5(b) seam: files named by the environment (L6-A's e2e), else our own clip.
      const raw = this.o.runtime.env(DEV_FIXTURES_ENV);
      const specs = parseDevFixturesEnv(raw);
      if (raw !== undefined && specs === null)
        log.warn('DEV FIXTURES: ignoring a malformed fixture list', { variable: DEV_FIXTURES_ENV });
      for (const spec of specs ?? []) {
        const st = await fs.stat(spec.path);
        if (st === null || !st.isFile || st.size < 1 || st.size > MAX_DEV_FIXTURE_BYTES) {
          log.warn('DEV FIXTURES: skipping an unreadable fixture file', { title: spec.title });
          continue;
        }
        fixtures.push({
          title: spec.title,
          ...(spec.description !== undefined ? { description: spec.description } : {}),
          bytes: await fs.readFile(spec.path),
          durationSec: await this.durationOf(spec.path, paths),
        });
      }
      if (fixtures.length === 0) {
        let bytes: Uint8Array | null = null;
        if (paths !== null) {
          const clip = fs.join(dir, 'testsrc.mp4');
          if (await generateDevClip(this.o.runtime.runner, paths.ffmpeg, clip))
            bytes = await fs.readFile(clip);
        }
        if (bytes === null) {
          log.warn('DEV FIXTURES: no ffmpeg — serving synthetic, unplayable bytes');
          bytes = syntheticBytes(8 * 65536);
        }
        fixtures.push({ title: 'Dev fixture: test pattern (6 s)', bytes, durationSec: 6 });
      }
      this.fixtures = await startFixtureNet({
        baseDir: dir,
        fs,
        crypto: sodiumCrypto,
        hub,
        bootstrap,
        logger: log,
        fixtures,
        now: this.now,
      });
      this.o.emit({ op: 'ev', e: 'dev.fixtures', videos: this.fixtures.videos });
    } catch (err) {
      log.error('dev fixtures failed to start', { error: err });
    }
  }

  /** A fixture file's duration by ffprobe (L8's probe), 6 s when that is not possible. */
  private async durationOf(path: string, binaries: media.FfmpegPaths | null): Promise<number> {
    if (binaries === null || this.live === null) return 6;
    try {
      const probe = await media
        .createMediaPipeline({
          runner: this.o.runtime.runner,
          fs: this.o.runtime.mediaFs(this.live.tmpDir),
          sha256: sodiumSha256,
          binaries,
        })
        .probe(path);
      return probe.durationSec > 0 ? probe.durationSec : 6;
    } catch {
      return 6;
    }
  }

  // ------------------------------------------------------------------ playback

  private requireNet(): Net {
    if (this.net === null) fail('payments-unavailable', MISSING_PROVIDERS_DETAIL);
    return this.net;
  }

  private session(sid: string): Session {
    const s = this.sessions.get(sid);
    // A session closing (its tail being paid) is closed to the host already.
    if (s === undefined || s.closed) fail('session-closed', 'no such play session');
    return s;
  }

  private async playOpen(a: PlayOpenArgs): Promise<WorkerMethodTable['play.open'][1]> {
    const live = this.live;
    if (live === null) fail('backend-down', 'worker is not initialised');
    const net = this.requireNet();
    if (this.sessions.has(a.sid) || this.nfxWatch?.has(a.sid) === true)
      fail('invalid-argument', 'duplicate session id');
    if (this.sessions.size >= MAX_SESSIONS) fail('rate-limited', 'too many open play sessions');
    const { hyper, size } = a.rendition;
    if (hyper.blob.blockLength < 1 || hyper.blob.byteLength !== size)
      fail('invalid-argument', 'rendition size does not match its blob');
    const core = hyper.core;
    // Lane W8b-p2p: our own profile core is always free (ADR 0015); a manifest naming it as a
    // video would price it on our seeder — and since the seeder keeps its prices across restarts,
    // it would stay sold, our avatar and thumbnails no longer served free.
    if (core === this.profileKey)
      fail('forbidden', 'that core is this node’s own profile core, not a video');
    // Fix round 4: an image read of this very core in flight (a thumbnail URL naming a video)
    // would go on under the paid route with blocks outside the video: refuse; a retry works.
    if ((this.imageCores.get(core)?.refs ?? 0) > 0)
      fail('rate-limited', 'this video is being read as an image; try again');
    // Claimed before any await: from here the image path refuses the core, and
    // `releaseImageCore` leaves it open (it checks the policy). The policy also ends any
    // free-serving of it (`setCorePolicy` clears the mark).
    this.corePolicies.set(core, a.policy);
    net.seeder.setCorePolicy(core, a.policy);
    const sc = await net.seeder.blobs.openCoreByKey(fromHex(core));
    if (this.sessions.has(a.sid)) fail('invalid-argument', 'duplicate session id');
    if (!this.coresAttached.has(core)) {
      // F33 / issue #8: routes the core (one seeder per block, per-seeder credit). It throws when
      // hypercore is not the release the router is pinned to — and then the core is NOT marked
      // attached, so a retry cannot download it unrouted (fail closed).
      net.payer.attachCore(sc.core);
      this.coresAttached.add(core);
    }
    net.node.join(sc.core.discoveryKey, { server: this.seeding.enabled, client: true });
    const gate = new PlaybackGate({
      core: sc.core,
      blob: hyper.blob,
      blockSize: a.policy.blockSize,
      bytesPerSec: bytesPerSecondOf({
        bitrateKbps: a.rendition.bitrateKbps,
        size,
        durationSec: a.durationSec,
      }),
      prefetchSeconds: a.prefetchSeconds,
      credit: net.credit,
      logger: live.log,
      ...(this.o.clock ? { clock: this.o.clock } : {}),
    });
    const link = live.server.register(a.sid, core, hyper.blob, gate);
    const s: Session = {
      sid: a.sid,
      core,
      first: hyper.blob.blockOffset,
      last: hyper.blob.blockOffset + hyper.blob.blockLength - 1,
      gate,
      openedAt: this.now(),
      total: 0,
      recent: [],
      peers: new Map(),
      closed: false,
      closing: null,
    };
    this.sessions.set(a.sid, s);
    this.lastSidForCore.set(core, s);
    live.log.info('play session opened', { core, prefetchBlocks: gate.prefetchBlocks });
    return { key: core, link };
  }

  /**
   * Slice 5d: a free NFX play session — no payment providers needed, no price, no gate (NFX
   * Phase 1 plays free videos only). One sid space with `play.open`.
   */
  private nfxPlayOpen(a: NfxPlayOpenArgs): Promise<WorkerMethodTable['nfx.play.open'][1]> {
    const watch = this.nfxWatch;
    if (watch === null) fail('backend-down', 'worker is not initialised');
    if (this.sessions.has(a.sid)) fail('invalid-argument', 'duplicate session id');
    return watch.open(a);
  }

  /**
   * Close a play session. Its tail is paid FIRST (fix round 4): PAYs for blocks pending below a
   * batch, waiting behind an unACKed PAY, or still in flight need the session — the host builds a
   * PAY only for an open session it authorised, and it revokes it only after `play.close` answers
   * — so the session stays (closed to the host, but a PAY can still name it: `sessionsCovering`)
   * until the drain is done or `CLOSE_DRAIN_MS` passed. Blocks left owed after that are settled as
   * unpaid by the payer. Fix round 5: the drain pays and waits for THIS session's blocks only —
   * after a rendition switch the new session streams the same core, and its blocks must not hold
   * the old one's `play.close` (and the switch) up.
   */
  private closeSession(sid: string): Promise<number> {
    const s = this.sessions.get(sid);
    if (s === undefined) return Promise.resolve(0);
    if (s.closing !== null) return s.closing;
    s.closed = true;
    s.gate.close();
    this.live?.server.unregister(sid);
    const payer = this.net?.payer;
    s.closing = (async () => {
      try {
        await payer?.drain(CLOSE_DRAIN_MS, {
          core: s.core,
          fromBlock: s.first,
          toBlock: s.last,
        });
      } catch {
        // a drain never throws; nothing may keep the session from closing
      } finally {
        this.sessions.delete(sid);
      }
      // Lane P2-owed-viewer: what is still unpaid of it is its tail — the host keeps an
      // authorisation for it, and the record keeps the blocks, until a seeder reports them.
      const record = this.net?.record ?? null;
      if (record === null) return 0;
      record.flush();
      return record.unpaidFor(sid);
    })();
    return s.closing;
  }

  /**
   * Lane P2-owed-viewer: the terms block `index` of `core` is received for — the first session
   * whose blob covers it (open ones first, as a PAY would be built), its blob and the manifest
   * policy it was opened with.
   */
  private termsFor(core: CoreKeyHex, index: number): TailTerms | null {
    const policy = this.corePolicies.get(core);
    if (policy === undefined) return null;
    const [sid] = sessionsCovering(
      { core, fromBlock: index, toBlock: index },
      this.sessions.values(),
    );
    const s = sid === undefined ? undefined : this.sessions.get(sid);
    if (s === undefined) return null;
    return { sid: s.sid, core, first: s.first, last: s.last, policy };
  }

  /** One PAY went out: attribute it to the session playing that core (or the last one did). */
  private onPaid(e: PaidEvent): void {
    let s: Session | undefined;
    for (const x of this.sessions.values()) if (x.core === e.core) s = x;
    s ??= this.lastSidForCore.get(e.core);
    if (s === undefined) return;
    const now = this.now();
    s.total += e.amount;
    s.recent.push({ at: now, amount: e.amount });
    let t = s.peers.get(e.seeder);
    if (t === undefined) {
      t = { sats: 0, blocks: 0, recent: [] };
      s.peers.set(e.seeder, t);
    }
    t.sats += e.amount;
    t.blocks += e.blocks;
    t.recent.push({ at: now, amount: e.amount });
    this.o.emit({
      op: 'ev',
      e: 'spend',
      sid: s.sid,
      mint: e.mint,
      amount: e.amount,
      total: s.total as Sats,
      ratePerMin: trailingSum(s.recent, now) as Sats,
    });
    const peers: PeerSpend[] = [];
    for (const [pubkey, p] of s.peers) {
      if (peers.length >= LIMITS.maxArray) break;
      peers.push({
        pubkey,
        sats: p.sats as Sats,
        blocks: p.blocks,
        ratePerMin: trailingSum(p.recent, now) as Sats,
      });
    }
    this.o.emit({ op: 'ev', e: 'peers', sid: s.sid, peers });
  }

  // ------------------------------------------------------------------ seeder

  private seederStatus(): SeederStatusWire {
    const net = this.net;
    if (net === null)
      return {
        enabled: false,
        pubkey: ZERO_PUBKEY,
        videos: 0,
        bytesStored: 0,
        diskCapBytes: this.seeding.diskCapBytes,
        peers: [],
        earned: { total: 0 as Sats, unswapped: 0 as Sats, byMint: { $map: [] } },
        banned: [],
      };
    const stats = net.seeder.stats();
    const banned: SeederStatusWire['banned'][number][] = [];
    for (const b of net.seeder.bans()) {
      if (b.pubkey === null || !/^[0-9a-f]{64}$/.test(b.pubkey)) continue;
      banned.push({
        pubkey: b.pubkey as NostrPubkey,
        reason: b.reason.slice(0, LIMITS.maxLabel),
        at: b.at as SeederStatusWire['banned'][number]['at'],
      });
    }
    return {
      enabled: this.seeding.enabled,
      pubkey: net.providers.pubkey,
      videos: stats.cores,
      bytesStored: stats.usedBytes,
      diskCapBytes: this.seeding.diskCapBytes,
      peers: net.providers.seederEngine.windows().slice(0, 4096),
      earned: {
        total: this.earnedTotal as Sats,
        unswapped: 0 as Sats,
        byMint: { $map: [] as (readonly [MintUrl, Sats])[] },
      },
      banned: banned.slice(0, 4096),
    };
  }

  // ------------------------------------------------------------------ images (ADR 0015)

  /** Whether this node serves creators' profile cores (thumbnails, avatars): free, while seeding. */
  private servesImages(): boolean {
    return this.seeding.enabled && this.seeding.serveImages !== false;
  }

  /**
   * Our own profile core: our avatar and our videos' thumbnails, always free while seeding. Lane
   * W8b-p2p (round-8 review, info): marked free the moment it is ready — before its upload gate
   * is attached and its terms are said to a peer that paired while it opened — not after the
   * open returns (P1's R9, which the image path already honoured, now for this core too).
   */
  private async ownProfile(): Promise<SeedCore> {
    const net = this.requireNet();
    const sc = await net.seeder.openCore(PROFILE_CORE_NAME, { free: true });
    this.profileKey = sc.keyHex;
    // A price an earlier run gave it (a hostile manifest played before this guard existed, or
    // before the core was open) is dropped: it is never sold. No session of this run can hold it
    // (`playOpen` refuses it once the key is known).
    if (!this.corePolicies.has(sc.keyHex) && net.seeder.corePolicyMap().has(sc.keyHex)) {
      net.seeder.setCorePolicy(sc.keyHex, null);
      net.seeder.setFreeCore(sc.keyHex, true);
    }
    net.node.join(sc.core.discoveryKey, { server: this.seeding.enabled, client: true });
    return sc;
  }

  /**
   * Write an image into our profile core — a Studio thumbnail (the host names it in the manifest)
   * or our avatar (the host names it in our kind 0).
   */
  private async putProfileImage(
    bytes: Uint8Array,
  ): Promise<{ url: string; sha256: Sha256Hex; size: number }> {
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_IMAGE_BYTES)
      fail('invalid-argument', 'image is empty or larger than the image cap');
    const sc = await this.ownProfile();
    const blob = await sc.blobs.put(bytes);
    const h = sodiumSha256();
    h.update(bytes);
    return {
      url: manifest.encodeHyperUrl({ core: sc.keyHex, blob }),
      sha256: h.digest(),
      size: bytes.byteLength,
    };
  }

  /**
   * Fix round 4 (cross-lane review, HIGH): whether `core` is known here to be SOLD — then it is
   * never read as an image. A thumbnail URL can name any core; downloading a paid one would be
   * counted by every honest seeder of it (and browsing never spends sats). Known sold: a manifest
   * policy here (a video played or opening), a core the router pays for, or one our own seeder
   * prices (uploads, played cores) — lane W8b-p2p (round-8 review, MEDIUM): in THIS run or an
   * earlier one. The seeder keeps its per-core policies across restarts (`CorePolicyStore`), so
   * after a restart an image URL naming a video we uploaded or played — its blocks still in our
   * store — is refused here, and `setFreeCore` refuses it too; before, both maps were empty after
   * a restart and the image path marked the video free on our seeder. (The fix-round-4 memory of
   * cores a seeder PRICEd on the image path went with the probe — ADR 0015 amendment: such a
   * seeder is simply never asked, and remembering "sold somewhere" refused honest free images
   * whenever a gateway that prices them answered first.)
   */
  private soldCore(core: CoreKeyHex, net: Net): boolean {
    return (
      this.corePolicies.has(core) ||
      this.coresAttached.has(core) ||
      net.seeder.corePolicyMap().has(core)
    );
  }

  /**
   * `image.fetch`: one image from a creator's profile core, over Pear. Served on (free) only while
   * this node serves images; otherwise a replica opened here is closed once no read needs it, so
   * it is neither announced nor replicated.
   *
   * A core known to be sold here is refused (`soldCore`, fix round 4). The read is ROUTED
   * (`ViewerPayer.attachImageCore`, ADR 0015 amendment 2026-09-26): a peer is asked for the core's
   * blocks only after its `PRICE { free: true }` for it — silence or a price, and it is never
   * asked: no probe, nothing counted, whichever seeders of that core are in the swarm (a gateway
   * that prices it does not stop the read). Images held only by seeders that never say `free`
   * time out and show the placeholder. A read that times out leaves no debt at a free seeder. A
   * replica this path opened is marked free on our own seeder BEFORE it is opened (so a peer
   * pairing on it hears `free`, never silence first — lane P1-owed-seeder's R9) and until it is
   * closed, served or not; nothing else is ever marked free here.
   */
  private async imageFetch(a: {
    readonly url: string;
    readonly sha256: Sha256Hex;
    readonly size: number;
  }): Promise<{ hex: string }> {
    const net = this.requireNet();
    const ref = manifest.decodeHyperUrl(a.url, a.size);
    if (ref === null) fail('invalid-argument', 'not a hyper:// image');
    if (!Number.isSafeInteger(a.size) || a.size < 1 || a.size > MAX_IMAGE_BYTES)
      fail('invalid-argument', 'image size out of range');
    const core = ref.core;
    if (this.soldCore(core, net)) fail('forbidden', 'not an image core: that core is sold');
    let entry = this.imageCores.get(core);
    if (entry === undefined) {
      entry = { refs: 0, opened: net.seeder.blobs.coreByKey(core) === undefined };
      this.imageCores.set(core, entry);
    }
    const e = entry;
    e.refs++;
    let detach: (() => void) | null = null;
    const timeout = this.o.imageTimeoutMs ?? IMAGE_FETCH_TIMEOUT_MS;
    try {
      // Free while open, whatever the serving setting (ADR 0015 §5 "never counted"); refused for a
      // core with a price (`setFreeCore`). Only a replica THIS path opens — marked by key before
      // the open (R9), unmarked by `releaseImageCore` when it closes.
      if (e.opened) net.seeder.setFreeCore(core, true);
      const sc = await net.seeder.blobs.openCoreByKey(fromHex(core));
      // A play open may have claimed it while the open was awaited.
      if (this.soldCore(core, net)) fail('forbidden', 'not an image core: that core is sold');
      // Our own profile core (a core we write): every block is local, nothing to ask anyone.
      if (e.opened || !sc.core.writable) {
        // Throws RoutingUnsupported when hypercore is not the pinned release: nothing unrouted.
        detach = net.payer.attachImageCore(sc.core);
        net.node.join(sc.core.discoveryKey, { server: this.servesImages(), client: true });
      }
      const bytes = await withDeadline(sc.blobs.get(ref.blob, { timeout }), timeout);
      if (bytes === null) fail('not-found', 'image not found on the swarm');
      const h = sodiumSha256();
      h.update(bytes);
      if (bytes.byteLength !== a.size || h.digest() !== a.sha256)
        fail('hash-mismatch', 'image does not match its hash');
      return { hex: toHex(bytes) };
    } catch (err) {
      if (err instanceof IpcError) throw err;
      return fail('not-found', 'image could not be read from the swarm');
    } finally {
      detach?.();
      e.refs--;
      // Unserved — or found to be sold: the replica goes.
      if (e.refs === 0 && (!this.servesImages() || this.soldCore(core, net)))
        void this.releaseImageCore(core);
    }
  }

  /** Stop serving and close every idle profile-core replica the image path opened. */
  private async releaseImageCores(): Promise<void> {
    for (const [core, e] of [...this.imageCores])
      if (e.refs === 0) await this.releaseImageCore(core);
  }

  private async releaseImageCore(core: CoreKeyHex): Promise<void> {
    const e = this.imageCores.get(core);
    const net = this.net;
    if (e === undefined || e.refs > 0 || net === null) return;
    this.imageCores.delete(core);
    if (!e.opened) return; // a core we write to, or one a playback opened: not ours to close
    // A playback claimed it (its policy is set before it awaits the open — fix round 4: this used
    // to race a play open) or attached it: it is routed and paid for now, and closing its session
    // would leave the router, settler and payer on a dead one. Not ours to close, and no longer
    // free (`setCorePolicy` cleared the mark). F33 independent review.
    if (this.corePolicies.has(core) || this.coresAttached.has(core)) return;
    const sc = net.seeder.blobs.coreByKey(core);
    if (sc !== undefined) net.node.leave(sc.core.discoveryKey);
    try {
      await net.seeder.blobs.closeCoreByKey(core);
    } catch {
      // already closed, or re-opened as a named core since: leave it
    }
    // Free until closed (fix round 4): while it could serve a block, that block was never counted.
    // A new image read that opened it again meanwhile owns the mark now.
    if (!this.imageCores.has(core)) net.seeder.setFreeCore(core, false);
  }

  private configureSeeding(a: WorkerInit['seeding']): void {
    const prevCap = this.seeding.diskCapBytes;
    this.seeding = a;
    // ADR 0015: stop serving other creators' images first, so `setServing` cannot re-announce them.
    if (!this.servesImages()) void this.releaseImageCores();
    this.net?.node.setServing(a.enabled);
    void this.applyNfxSeeding();
    if (a.diskCapBytes !== prevCap)
      this.live?.log.info('disk cap change applies at the next worker start', {
        diskCapBytes: a.diskCapBytes,
      });
    this.pushStatusSoon();
  }

  /**
   * Slice 5b: NFX videos are served while seeding AND NFX are both on, and only then. Slice 5e-3:
   * over iroh too, with the network's iroh relays (its imports go on in the background).
   */
  private async applyNfxSeeding(): Promise<void> {
    const on = this.seeding.enabled && this.nfxEnabled;
    await Promise.all([this.nfxSeeding?.set(on), this.nfxIroh?.set(on, this.nfxIrohRelays)]);
  }

  /** Slice 5b: what the store holds, for the host's beacons (a `segs` past 2^53 is skipped). */
  private nfxVideos(): NfxStoredVideoWire[] {
    const out: NfxStoredVideoWire[] = [];
    for (const r of this.net?.seeder.nfx.videos() ?? []) {
      const segs = Number(r.segs);
      if (!Number.isSafeInteger(segs) || segs < 1) continue;
      out.push({ video: r.video, root: r.root as Sha256Hex, segs });
    }
    return out;
  }

  private pushStatusSoon(): void {
    if (this.statusTimer !== null || this.closing !== null || this.live === null) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      if (this.closing !== null) return;
      this.o.emit({ op: 'ev', e: 'seeder.status', status: this.seederStatus() });
    }, STATUS_THROTTLE_MS);
  }

  // ------------------------------------------------------------------ studio

  private async probe(recheck: boolean, path?: string): Promise<FfmpegStatus> {
    const key = path ?? '';
    if (!recheck && this.ffmpegStatus?.key === key) return this.ffmpegStatus.status;
    const r = await probeFfmpeg(
      {
        runner: this.o.runtime.runner,
        pathEnv: this.o.runtime.env('PATH'),
        isExecutable: (p) => this.o.runtime.isExecutable(p),
        os: this.o.runtime.os,
      },
      path,
    );
    this.ffmpegStatus = { key, status: r.status };
    if (r.paths !== null) this.ffmpeg = r.paths;
    return r.status;
  }

  private async upload(a: StudioUploadArgs): Promise<VideoManifest> {
    const live = this.live;
    if (live === null) fail('backend-down', 'worker is not initialised');
    const net = this.requireNet();
    if (this.uploads.has(a.uploadId)) fail('invalid-argument', 'duplicate upload id');
    if (this.ffmpeg === null) await this.probe(false);
    const binaries = this.ffmpeg;
    if (binaries === null)
      throw new media.MediaError('ffmpeg-not-found', 'ffmpeg/ffprobe not found on this computer');
    this.uploads.add(a.uploadId);
    try {
      const video = await runWorkerUpload(a, {
        seeder: net.seeder,
        binaries,
        runner: this.o.runtime.runner,
        fs: this.o.runtime.mediaFs(live.tmpDir),
        sha256: sodiumSha256,
        logger: live.log,
        publish: (draft) => this.o.request('studio.publish', draft),
        putThumbnail: (bytes) => this.putProfileImage(bytes),
        progress: (p: UploadProgress) => {
          this.o.emit({ op: 'ev', e: 'upload.progress', uploadId: a.uploadId, progress: p });
        },
        ...(this.o.uploadPreset !== undefined ? { preset: this.o.uploadPreset } : {}),
        // Contracts v8: the NFX side reports on its own, after the legacy result went back.
        nfx: (status) => {
          void status.then((s) => {
            this.o.emit({ op: 'ev', e: 'upload.nfx', uploadId: a.uploadId, status: s });
          });
        },
      });
      for (const r of video.renditions) {
        net.seeder.setCorePolicy(r.hyper.core, video.price);
        const sc = net.seeder.blobs.coreByKey(r.hyper.core);
        if (sc !== undefined)
          net.node.join(sc.core.discoveryKey, { server: this.seeding.enabled, client: true });
      }
      return video;
    } finally {
      this.uploads.delete(a.uploadId);
    }
  }

  // ------------------------------------------------------------------ shutdown

  close(): Promise<void> {
    this.closing ??= (async () => {
      if (this.statusTimer !== null) clearTimeout(this.statusTimer);
      this.statusTimer = null;
      await this.initialising?.catch(() => undefined);
      // Its thread must be gone before the worker exits: a parked Bare thread holds `Bare.exit`.
      await (await this.devDleq)?.close();
      // Fix round 4: every session's tail is paid BEFORE its session goes and before the node is
      // destroyed (a PAY needs both), bounded by CLOSE_DRAIN_MS per session, in parallel.
      await Promise.all([...this.sessions.keys()].map((sid) => this.closeSession(sid)));
      await this.net?.payer.flush().catch(() => undefined);
      await this.live?.server.close();
      // Slice 5d: NFX play dials from the swarm's DHT (or its own node, destroyed here).
      await this.nfxWatch?.shutdown();
      // Slice 5b: the NFX-12 listener lives on the swarm's DHT, so it closes first.
      await this.nfxSeeding?.close();
      // Slice 5e-3: the iroh helper (its stdin ends, it exits), before the store it reads.
      await this.nfxIroh?.close();
      try {
        await this.net?.node.destroy();
      } finally {
        // F33 independent review: only once the connections are gone. Released while a core still
        // replicates, a routed core must not go back to hypercore's own scheduler (the router
        // parks it: nothing more is asked of any peer), and after `destroy` nothing replicates.
        this.net?.payer.close();
        // Lane P2-owed-viewer: the record's last write — what is left unpaid, and each seeder's
        // durable word, as the connections left them.
        this.net?.record?.close();
      }
      await this.fixtures?.close().catch(() => undefined);
      await this.net?.seeder.close();
      this.net?.providers.close?.();
      await this.testnet?.destroy().catch(() => undefined);
    })();
    return this.closing;
  }
}
