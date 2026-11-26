/**
 * The worker's NFX play sessions (ADR 0020 slice 5d): `nfx.play.open` / `nfx.play.close`, one
 * `NfxWatchSession` each over a `HyperdhtFetcher`, with one `NfxPeerPool` (a connection per
 * seeder, shared) and one `NfxRangeServer` for all of them.
 *
 * Slice 5e-4: a session whose seeders have iroh endpoints fetches over iroh first (NFX-06 §6),
 * through an `IrohFetcher`, then over HyperDHT (`NfxFallbackFetcher`); one with iroh endpoints
 * only (an nfxd seeder) fetches over iroh alone. The iroh side dials from the worker's WATCHING
 * node (`./iroh.ts`): its own helper with an ephemeral id, never the serving node's, so what this
 * worker serves cannot be linked to what it watches. It starts on the first fetch that needs it
 * and stops when no session that could use it is left.
 *
 * #89 (ADR 0023): while the host has WebRTC on, a session also asks the peers the worker's WebRTC
 * node is connected to in the video's web swarms (`./rtc-fetcher.ts`), after iroh and before
 * HyperDHT, and only beside one of them: those connections come from the host's signaling.
 *
 * Payment-independent: free NFX play needs no payment providers. With them the worker has a
 * legacy swarm, and sessions dial from its DHT node; without them (no swarm, no seeder) a DHT
 * node of this module's own is created on the first open — with the bootstrap the worker would
 * give its swarm, and like the swarm of a worker with real payments never bound to loopback (only
 * `--dev-mocks` providers fence the swarm to 127.0.0.1, and those always have a swarm): a
 * loopback-bound node cannot reach a peer's LAN addresses, which HyperDHT tries for peers behind
 * the same address — and destroyed by `shutdown`.
 *
 * The watcher key pair is per network and never the seeder's or the legacy swarm's (NFX-12 §1):
 * with a seeder, `Corestore.createKeyPair('nfx:<namespace>:watcher')`, stable across runs (the
 * NFX-07 account a paid session will need is keyed by it); without one, an ephemeral pair for
 * this worker run — free mode keeps no account, so there is nothing to persist, and a run's
 * dials cannot be linked to the next run's.
 *
 * Pear #123 (ADR 0024): `nfx.play.stats` and `nfx.play.addresses` read a session's fetchers
 * (each counts the sources only it can name). Addresses are read only when asked, and only for
 * the answer: nothing here logs one.
 *
 * NFX-18 (plan P3): a keep of what is watched (`./keeping.ts`) reads an open play through
 * `keepView` (its sources, how long it has been open by the worker's monotonic clock, what its
 * player read) and goes on fetching after the play closed through `fetcherFor`, a fetcher built
 * exactly as a play's is, which holds the watching iroh node up as a play does until it closes.
 */
import type { NfxPlayStats, PlaySourceAddress, PlaySourceStat } from '@sovit/core';
import { nfx } from '@sovit/core';
import type { Logger, NfxDht, PeerKeyPair, SeederCrypto, SeederFs } from '@sovit/seeder';
import { fromHex } from '@sovit/seeder';
import DHT from 'hyperdht';

import { IpcError } from '../../ipc/errors.js';
import type { ErrorCode } from '../../ipc/protocol.js';
import { LIMITS } from '../../ipc/protocol.js';
import type {
  NfxHyperdhtEndpointWire,
  NfxIrohEndpointWire,
  NfxPlayOpenArgs,
  WorkerMethodTable,
} from '../../ipc/worker-protocol.js';
import type { BootstrapNode } from '../net/peer-node.js';
import type { WorkerRuntime } from '../runtime.js';
import { NfxFallbackFetcher } from './fallback-fetcher.js';
import { HyperdhtFetcher, NfxPeerPool } from './hyperdht-fetcher.js';
import type { IrohFetchClient } from './iroh-fetcher.js';
import { IrohFetcher } from './iroh-fetcher.js';
import { NfxRangeServer } from './range-server.js';
import type { RtcFetchClient } from './rtc-fetcher.js';
import { RtcFetcher } from './rtc-fetcher.js';
import type { NfxRtcConnection } from './rtc-node.js';
import type { NfxFetcher, NfxSpool, NfxWatchKeepable } from './watch.js';
import { NfxWatchSession } from './watch.js';

/** NFX play sessions open at once per worker. */
export const MAX_NFX_SESSIONS = 4;
/** Under `<storage>/tmp` (wiped at every worker start): each session spools in `<sid>/`. */
export const NFX_PLAY_DIR = 'nfx-play';
/** How long the own DHT node may take to bootstrap before the first dial goes ahead anyway. */
const BOOTSTRAP_WAIT_MS = 15_000;

/** The key pair name for `namespace`'s watcher (beside `seederKeyName`, `./seeding.ts`). */
export const watcherKeyName = (namespace: string): string => `nfx:${namespace}:watcher`;

/** Pear #123: the sources a play reports, open ones first, then the most bytes; at most 64. */
export function rankSources(list: readonly PlaySourceStat[]): PlaySourceStat[] {
  return [...list]
    .sort((a, b) => Number(b.connected) - Number(a.connected) || b.bytesDown - a.bytesDown)
    .slice(0, LIMITS.maxPlaySources);
}

/** Slice 5e-4: the watching iroh node (`NfxIrohNode` with no key pair), as sessions use it. */
export interface NfxWatchingIroh {
  /** Its helper, started on first need; `null` when it cannot run (and why was logged). */
  start(): Promise<IrohFetchClient | null>;
  /** Stop the helper and empty its store (the next `start` brings up a fresh node). */
  stop(): Promise<void>;
  /** Stop for good. */
  close(): Promise<void>;
  /** Changes at every start, restart and stop of the helper. */
  readonly generation: number;
  /** The network's iroh relays it runs with (NFX-06 §1). */
  readonly networkRelays: readonly string[];
}

/** #89: the worker's WebRTC node (`NfxRtcNode`), as sessions use it. */
export interface NfxWatchingRtc {
  /** Whether the host turned WebRTC on. */
  readonly on: boolean;
  /** Its helper, started on first need; `null` when off or it cannot run. */
  start(): Promise<RtcFetchClient | null>;
  /** The open connections in a web swarm. */
  connections(swarm: string): readonly NfxRtcConnection[];
  /** Pear #123: the running helper, never starting one (addresses). */
  current?(): RtcFetchClient | null;
  /** Pear #123: changes at every start, restart and stop of the helper. */
  readonly generation?: number;
}

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
  /** Slice 5e-4: the watching iroh node, or `null` without an iroh helper (HyperDHT only). */
  readonly iroh?: NfxWatchingIroh | null;
  /** #89: the WebRTC node, or `null` without an iroh helper (it runs in that binary). */
  readonly rtc?: NfxWatchingRtc | null;
  /** NFX-18: the worker's monotonic clock (ms): how long a play has been open. */
  readonly now: () => number;
  /** NFX-18: called whenever a play opens or closes (keeping yields to playback). */
  readonly onChange?: () => void;
  /** TESTS ONLY: shorter bounds (a read's wait, a dial). */
  readonly readWaitMs?: number;
  readonly dialTimeoutMs?: number;
}

/** NFX-18: the sources a fetch asks, in `nfx.play.open`'s terms. */
export interface NfxSources {
  readonly video: nfx.VideoAddr;
  /** The manifest `root` and `segs`. */
  readonly root: string;
  readonly segs: number;
  readonly peers: readonly NfxHyperdhtEndpointWire[];
  readonly iroh: readonly NfxIrohEndpointWire[];
}

/** NFX-18: an open play as a keep of it sees it (`NfxWatching.keepView`). */
export interface NfxPlayKeep extends NfxWatchKeepable {
  /** The play's session id. */
  readonly sid: string;
  readonly sources: NfxSources;
  /** How long the play has been open (ms, the worker's monotonic clock). */
  readonly openForMs: number;
  /** The media its player has read (ms). */
  readonly mediaReadMs: number;
  /** Hand its spooled files to `take` at its close; `false`: it is closing already. */
  keepOnClose(take: (spool: NfxSpool) => Promise<void>): boolean;
}

interface Built {
  readonly fetcher: NfxFetcher;
  /** Pear #123: its transports, in the order it asks them. */
  readonly names: readonly string[];
  /** It may dial over iroh (the watching node must stay up for it). */
  readonly viaIroh: boolean;
}

function fail(code: ErrorCode, detail: string): never {
  throw new IpcError(code, `${code}: ${detail}`);
}

export class NfxWatching {
  private readonly d: NfxWatchingDeps;
  private readonly sessions = new Map<string, NfxWatchSession>();
  /** Pear #123: each session's transports, in the order it asks them. */
  private readonly transports = new Map<string, readonly string[]>();
  /**
   * Slice 5e-4: the sessions that may fetch over iroh; the node stops when none is left. NFX-18:
   * and the keep fetchers (`keep:<n>`, never a session id) that may.
   */
  private readonly irohSessions = new Set<string>();
  /** NFX-18: each session's sources, and when it opened (the monotonic clock). */
  private readonly sources = new Map<string, NfxSources>();
  private readonly openedAt = new Map<string, number>();
  private keepFetchers = 0;
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
    const sources: NfxSources = {
      video: video.value,
      root: a.root,
      segs: a.segs,
      peers: a.peers,
      iroh: a.iroh,
    };
    const built = this.build(sources);
    if (built === null)
      fail('no-seeders', 'every seeder speaks iroh only, and this worker has no iroh helper');
    const { fetcher, names, viaIroh } = built;
    const session = new NfxWatchSession({
      video: video.value,
      root: a.root,
      segs: a.segs,
      ...(a.rendition === undefined ? {} : { rendition: a.rendition }),
      // Pear #97: only renditions these seeders hold, the most-held first.
      ...(a.held === undefined
        ? {}
        : {
            held: {
              seeders: a.held.seeders,
              all: a.held.all,
              named: new Map(a.held.named.$map),
            },
          }),
      prefetchSeconds: a.prefetchSeconds,
      fetcher,
      fs: this.d.fs,
      rmTree: this.d.rmTree,
      dir: this.d.fs.join(this.d.spoolDir, a.sid),
      logger: this.d.logger,
      ...(this.d.readWaitMs === undefined ? {} : { waitMs: this.d.readWaitMs }),
    });
    // Claimed before any await: a second open of the sid is refused, a close finds it (and an
    // iroh node a closing session would stop is held for this one).
    this.sessions.set(a.sid, session);
    this.transports.set(a.sid, names);
    this.sources.set(a.sid, sources);
    if (viaIroh) this.irohSessions.add(a.sid);
    this.d.onChange?.();
    try {
      const opened = await session.open();
      const server = this.rangeServer();
      await server.listen();
      if (this.sessions.get(a.sid) !== session || session.closed)
        fail('session-closed', 'the play session closed');
      const link = server.register(a.sid, session);
      this.openedAt.set(a.sid, this.d.now());
      this.d.logger.info('nfx play session opened', {
        rendition: opened.rendition,
        segments: opened.layout.parts.length - 2,
      });
      return { link, rendition: opened.rendition, renditions: opened.renditions };
    } catch (err) {
      if (this.sessions.get(a.sid) === session) {
        this.forget(a.sid);
        await session.close();
        await this.releaseIroh(a.sid);
      } else {
        await session.close();
      }
      throw err;
    }
  }

  /** `nfx.play.close`: its link 404s, its fetches stop, its spool goes. Idempotent. */
  async close(sid: string): Promise<void> {
    const session = this.sessions.get(sid);
    if (session === undefined) return;
    this.forget(sid);
    this.server?.unregister(sid);
    await session.close();
    await this.releaseIroh(sid);
  }

  /** A session's entries go (before its close, so a second close finds nothing). */
  private forget(sid: string): void {
    this.sessions.delete(sid);
    this.transports.delete(sid);
    this.sources.delete(sid);
    this.openedAt.delete(sid);
    this.d.onChange?.();
  }

  /**
   * NFX-18: open play `sid` as a keep of it sees it. Throws `session-closed` for a session that
   * is not open (closing, closed, unknown) and `invalid-argument` for one still opening.
   */
  keepView(sid: string): NfxPlayKeep {
    const session = this.sessions.get(sid);
    const sources = this.sources.get(sid);
    if (session === undefined || sources === undefined || session.closed)
      fail('session-closed', 'no such NFX play session');
    const openedAt = this.openedAt.get(sid);
    const keepable = session.keepable;
    if (openedAt === undefined || keepable === null)
      fail('invalid-argument', 'the play session is still opening');
    return {
      ...keepable,
      sid,
      sources,
      openForMs: this.d.now() - openedAt,
      mediaReadMs: session.mediaReadMs,
      keepOnClose: (take) => session.keepOnClose(take),
    };
  }

  /** NFX-18: file `sha` of `video` if an open play of it spooled it whole; else `null`. */
  async spooled(video: string, sha: string): Promise<Uint8Array | null> {
    for (const [sid, session] of [...this.sessions]) {
      if (this.sources.get(sid)?.video.toString() !== video) continue;
      const bytes = await session.spooledFile(sha);
      if (bytes !== null) return bytes;
    }
    return null;
  }

  /**
   * NFX-18: a fetcher over `sources`, built as a play's is (iroh, then WebRTC, then HyperDHT), for
   * a keep job that goes on after its play closed. Until it is closed it holds the watching iroh
   * node up, as a play does. `null`: no source this worker can use, or it is shutting down.
   */
  fetcherFor(sources: NfxSources): NfxFetcher | null {
    if (this.closing !== null) return null;
    const built = this.build(sources);
    if (built === null) return null;
    if (!built.viaIroh) return built.fetcher;
    const inner = built.fetcher;
    const holder = `keep:${String(this.keepFetchers++)}`;
    this.irohSessions.add(holder);
    let released: Promise<void> | null = null;
    return {
      fetch: (sha, size, exact) => inner.fetch(sha, size, exact),
      learn: (sha, bytes) => {
        inner.learn?.(sha, bytes);
      },
      close: () => {
        released ??= inner
          .close()
          .catch(() => undefined)
          .then(() => this.releaseIroh(holder));
        return released;
      },
    };
  }

  /**
   * The fetchers for `s`: iroh first (NFX-06 §6), then WebRTC, then HyperDHT, each only with
   * sources of its kind. `null` when none can be asked.
   */
  private build(s: NfxSources): Built | null {
    const peers: Uint8Array[] = [];
    const seen = new Set<string>();
    for (const p of s.peers) {
      if (seen.has(p.peer)) continue;
      seen.add(p.peer);
      peers.push(fromHex(p.peer));
    }
    // Slice 5e-4: iroh first (NFX-06 §6), then HyperDHT; each only with endpoints of its kind.
    const iroh = this.d.iroh ?? null;
    const fetchers: NfxFetcher[] = [];
    const names: string[] = [];
    let viaIroh = false;
    if (iroh !== null && s.iroh.length > 0) {
      viaIroh = true;
      names.push('iroh');
      fetchers.push(
        new IrohFetcher({
          video: s.video,
          root: s.root,
          segs: s.segs,
          endpoints: s.iroh,
          client: () => iroh.start(),
          generation: () => iroh.generation,
          networkRelays: () => iroh.networkRelays,
          logger: this.d.logger,
        }),
      );
    }
    // #89: then the peers the WebRTC node is connected to in this video's web swarms. Only beside
    // another source: the connections come from the host's signaling, never from this session.
    const rtc = this.d.rtc ?? null;
    if (rtc?.on === true && (fetchers.length > 0 || peers.length > 0)) {
      names.push('WebRTC');
      fetchers.push(
        new RtcFetcher({
          video: s.video,
          root: s.root,
          segs: s.segs,
          client: () => rtc.start(),
          connections: (swarm) => rtc.connections(swarm),
          logger: this.d.logger,
          current: () => rtc.current?.() ?? null,
          generation: () => rtc.generation ?? 0,
        }),
      );
    }
    if (peers.length > 0) {
      names.push('HyperDHT');
      fetchers.push(
        new HyperdhtFetcher({
          pool: this.pool,
          video: s.video,
          peers,
          logger: this.d.logger,
        }),
      );
    }
    const [only] = fetchers;
    if (only === undefined) return null;
    return {
      fetcher: fetchers.length === 1 ? only : new NfxFallbackFetcher(fetchers),
      names,
      viaIroh,
    };
  }

  /**
   * Pear #123 (ADR 0024): `nfx.play.stats`: where session `sid`'s bytes came from, per source,
   * open ones first, then the most bytes. Never an address.
   */
  stats(sid: string): NfxPlayStats {
    const session = this.sessions.get(sid);
    if (session === undefined) fail('session-closed', 'no such NFX play session');
    const s = session.stats();
    return {
      sources: rankSources(s.sources),
      engine: `nfx worker: ${(this.transports.get(sid) ?? []).join(', ')}`,
      peers: {
        connected: s.sources.filter((x) => x.connected).length,
        total: s.sources.length,
      },
      verified: s.verified,
      refused: s.refused,
    };
  }

  /**
   * Pear #123: `nfx.play.addresses`: where each connected source of `sid` goes now, read for
   * this answer only (the viewer switched addresses on). Never logged.
   */
  async addresses(sid: string): Promise<readonly PlaySourceAddress[]> {
    const session = this.sessions.get(sid);
    if (session === undefined) fail('session-closed', 'no such NFX play session');
    return (await session.addresses()).slice(0, LIMITS.maxPlaySources);
  }

  /** Slice 5e-4: `sid` no longer uses iroh; the node stops when no session does. */
  private async releaseIroh(sid: string): Promise<void> {
    if (!this.irohSessions.delete(sid) || this.irohSessions.size > 0) return;
    try {
      await this.d.iroh?.stop();
    } catch (err) {
      this.d.logger.warn('nfx: the watching iroh node did not stop cleanly', { error: err });
    }
  }

  /** Worker shutdown: every session, the range server, the own DHT node. Never throws. */
  shutdown(): Promise<void> {
    this.closing ??= (async () => {
      await Promise.all([...this.sessions.keys()].map((sid) => this.close(sid)));
      this.pool.close();
      await this.d.iroh?.close().catch(() => undefined);
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

  /**
   * The swarm's DHT node, else the own one (created once): what play sessions dial from, and
   * what the NFX-12 listener of an app with no mint listens on (NFX-18). The listener closes
   * before `shutdown` destroys it.
   */
  dht(): Promise<NfxDht> {
    const swarm = this.d.swarmDht();
    if (swarm !== null) return Promise.resolve(swarm);
    if (this.closing !== null) return Promise.reject(new Error('nfx: shutting down'));
    this.ownReady ??= this.startOwnDht();
    return this.ownReady;
  }

  private async startOwnDht(): Promise<DHT> {
    const bootstrap = this.d.bootstrap;
    const dht = new DHT(bootstrap === null ? {} : { bootstrap });
    this.ownDht = dht;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      dht.fullyBootstrapped().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, BOOTSTRAP_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    this.d.logger.info('nfx: a watcher DHT node of its own (no legacy swarm)', {
      bootstrap: bootstrap === null ? 'public' : 'configured',
    });
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
