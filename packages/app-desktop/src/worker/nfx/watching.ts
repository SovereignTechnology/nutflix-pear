/**
 * The worker's NFX play sessions (ADR 0020 slice 5d): `nfx.play.open` / `nfx.play.close`, one
 * `NfxWatchSession` each over a `HyperdhtFetcher`, with one `NfxPeerPool` (a connection per
 * seeder, shared) and one `NfxRangeServer` for all of them.
 *
 * Payment-independent: free NFX play needs no payment providers. With them the worker has a
 * legacy swarm, and sessions dial from its DHT node; without them (no swarm, no seeder) a DHT
 * node of this module's own is created on the first open — with the bootstrap the worker would
 * give its swarm, bound to 127.0.0.1 when that bootstrap is loopback only — and destroyed by
 * `shutdown`.
 *
 * The watcher key pair is per network and never the seeder's or the legacy swarm's (NFX-12 §1):
 * with a seeder, `Corestore.createKeyPair('nfx:<namespace>:watcher')`, stable across runs (the
 * NFX-07 account a paid session will need is keyed by it); without one, an ephemeral pair for
 * this worker run — free mode keeps no account, so there is nothing to persist, and a run's
 * dials cannot be linked to the next run's.
 */
import { nfx } from '@sovit/core';
import type { Logger, NfxDht, PeerKeyPair, SeederCrypto, SeederFs } from '@sovit/seeder';
import { fromHex } from '@sovit/seeder';
import DHT from 'hyperdht';

import { IpcError } from '../../ipc/errors.js';
import type { ErrorCode } from '../../ipc/protocol.js';
import type { NfxPlayOpenArgs, WorkerMethodTable } from '../../ipc/worker-protocol.js';
import type { BootstrapNode } from '../net/peer-node.js';
import type { WorkerRuntime } from '../runtime.js';
import { HyperdhtFetcher, NfxPeerPool } from './hyperdht-fetcher.js';
import { NfxRangeServer } from './range-server.js';
import { NfxWatchSession } from './watch.js';

/** NFX play sessions open at once per worker. */
export const MAX_NFX_SESSIONS = 4;
/** Under `<storage>/tmp` (wiped at every worker start): each session spools in `<sid>/`. */
export const NFX_PLAY_DIR = 'nfx-play';
/** How long the own DHT node may take to bootstrap before the first dial goes ahead anyway. */
const BOOTSTRAP_WAIT_MS = 15_000;

/** The key pair name for `namespace`'s watcher (beside `seederKeyName`, `./seeding.ts`). */
export const watcherKeyName = (namespace: string): string => `nfx:${namespace}:watcher`;

export interface NfxWatchingDeps {
  /** The legacy swarm's DHT node while there is one (payment providers present), else `null`. */
  readonly swarmDht: () => NfxDht | null;
  /** The bootstrap for the own DHT node (`null`: HyperDHT's public bootstrap). */
  readonly bootstrap: readonly BootstrapNode[] | null;
  /** A key pair derived by name from the seeder's Corestore, or `null` without a seeder. */
  readonly seederKeyPair: (name: string) => Promise<PeerKeyPair> | null;
  readonly fs: SeederFs;
  /** Remove a directory and everything in it; a missing one is fine. */
  readonly rmTree: (path: string) => Promise<void>;
  /** `<storage>/tmp/nfx-play`. */
  readonly spoolDir: string;
  readonly crypto: SeederCrypto;
  readonly createHttpServer: WorkerRuntime['createHttpServer'];
  readonly randomHex: (n: number) => string;
  readonly logger: Logger;
  /** TESTS ONLY: shorter bounds (a read's wait, a dial). */
  readonly readWaitMs?: number;
  readonly dialTimeoutMs?: number;
}

function fail(code: ErrorCode, detail: string): never {
  throw new IpcError(code, `${code}: ${detail}`);
}

export class NfxWatching {
  private readonly d: NfxWatchingDeps;
  private readonly sessions = new Map<string, NfxWatchSession>();
  private readonly ephemeral = new Map<string, PeerKeyPair>();
  private readonly pool: NfxPeerPool;
  private server: NfxRangeServer | null = null;
  private ownDht: DHT | null = null;
  private ownReady: Promise<DHT> | null = null;
  private closing: Promise<void> | null = null;

  constructor(d: NfxWatchingDeps) {
    this.d = d;
    this.pool = new NfxPeerPool({
      dht: () => this.dht(),
      keyPair: (namespace) => this.watcherKeyPair(namespace),
      crypto: d.crypto,
      logger: d.logger,
      ...(d.dialTimeoutMs === undefined ? {} : { dialTimeoutMs: d.dialTimeoutMs }),
    });
  }

  /** Whether `sid` names a session here (open or opening). */
  has(sid: string): boolean {
    return this.sessions.has(sid);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** `nfx.play.open`. Throws `<code>: …` errors; a session that fails to open leaves nothing. */
  async open(a: NfxPlayOpenArgs): Promise<WorkerMethodTable['nfx.play.open'][1]> {
    if (this.closing !== null) fail('backend-down', 'worker is shutting down');
    if (this.sessions.has(a.sid)) fail('invalid-argument', 'duplicate session id');
    if (this.sessions.size >= MAX_NFX_SESSIONS)
      fail('rate-limited', 'too many open NFX play sessions');
    const video = nfx.VideoAddr.parse(a.video);
    if (!video.ok || video.value.toString() !== a.video)
      fail('invalid-argument', 'not an NFX video address');
    const peers: Uint8Array[] = [];
    const seen = new Set<string>();
    for (const p of a.peers) {
      if (seen.has(p.peer)) continue;
      seen.add(p.peer);
      peers.push(fromHex(p.peer));
    }
    const fetcher = new HyperdhtFetcher({
      pool: this.pool,
      video: video.value,
      peers,
      logger: this.d.logger,
    });
    const session = new NfxWatchSession({
      video: video.value,
      root: a.root,
      segs: a.segs,
      ...(a.rendition === undefined ? {} : { rendition: a.rendition }),
      prefetchSeconds: a.prefetchSeconds,
      fetcher,
      fs: this.d.fs,
      rmTree: this.d.rmTree,
      dir: this.d.fs.join(this.d.spoolDir, a.sid),
      logger: this.d.logger,
      ...(this.d.readWaitMs === undefined ? {} : { waitMs: this.d.readWaitMs }),
    });
    // Claimed before any await: a second open of the sid is refused, a close finds it.
    this.sessions.set(a.sid, session);
    try {
      const opened = await session.open();
      const server = this.rangeServer();
      await server.listen();
      if (this.sessions.get(a.sid) !== session || session.closed)
        fail('session-closed', 'the play session closed');
      const link = server.register(a.sid, session);
      this.d.logger.info('nfx play session opened', {
        rendition: opened.rendition,
        segments: opened.layout.parts.length - 2,
      });
      return { link, rendition: opened.rendition, renditions: opened.renditions };
    } catch (err) {
      if (this.sessions.get(a.sid) === session) this.sessions.delete(a.sid);
      await session.close();
      throw err;
    }
  }

  /** `nfx.play.close`: its link 404s, its fetches stop, its spool goes. Idempotent. */
  async close(sid: string): Promise<void> {
    const session = this.sessions.get(sid);
    if (session === undefined) return;
    this.sessions.delete(sid);
    this.server?.unregister(sid);
    await session.close();
  }

  /** Worker shutdown: every session, the range server, the own DHT node. Never throws. */
  shutdown(): Promise<void> {
    this.closing ??= (async () => {
      await Promise.all([...this.sessions.keys()].map((sid) => this.close(sid)));
      this.pool.close();
      await this.server?.close().catch(() => undefined);
      await this.ownReady?.catch(() => undefined);
      try {
        await this.ownDht?.destroy();
      } catch (err) {
        this.d.logger.warn('nfx: the watcher DHT node did not close cleanly', { error: err });
      }
    })();
    return this.closing;
  }

  private rangeServer(): NfxRangeServer {
    this.server ??= new NfxRangeServer({
      createHttpServer: this.d.createHttpServer,
      randomHex: this.d.randomHex,
      logger: this.d.logger,
    });
    return this.server;
  }

  /** The swarm's DHT node, else the own one (created once). */
  private dht(): Promise<NfxDht> {
    const swarm = this.d.swarmDht();
    if (swarm !== null) return Promise.resolve(swarm);
    if (this.closing !== null) return Promise.reject(new Error('nfx: shutting down'));
    this.ownReady ??= this.startOwnDht();
    return this.ownReady;
  }

  private async startOwnDht(): Promise<DHT> {
    const bootstrap = this.d.bootstrap;
    const loopback = bootstrap !== null && bootstrap.every((b) => b.host === '127.0.0.1');
    const dht = new DHT(
      bootstrap === null ? {} : loopback ? { bootstrap, host: '127.0.0.1' } : { bootstrap },
    );
    this.ownDht = dht;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      dht.fullyBootstrapped().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, BOOTSTRAP_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    this.d.logger.info('nfx: a watcher DHT node of its own (no legacy swarm)', { loopback });
    return dht;
  }

  /** See the module comment: derived with a seeder, else ephemeral for this run. */
  private watcherKeyPair(namespace: string): Promise<PeerKeyPair> {
    const derived = this.d.seederKeyPair(watcherKeyName(namespace));
    if (derived !== null) return derived;
    let kp = this.ephemeral.get(namespace);
    if (kp === undefined) {
      kp = DHT.keyPair();
      this.ephemeral.set(namespace, kp);
    }
    return Promise.resolve(kp);
  }
}
