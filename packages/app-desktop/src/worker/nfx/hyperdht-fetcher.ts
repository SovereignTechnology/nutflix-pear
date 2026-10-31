/**
 * An `NfxFetcher` over NFX-12 (HyperDHT + `nfx/files/1`, ADR 0020 slice 5d): whole files from the
 * seeders a host found in verified beacons, tried in the order given.
 *
 * - `NfxPeerPool` (one per worker) holds ONE connection per seeder and network, shared by every
 *   session: a seeder caps connections per watcher key (`listenNfx`: 2), and every session of a
 *   run dials with the same key. It is dialed on first use with the network's watcher key pair
 *   (NFX-12 §1: never the seeder's, never the legacy swarm's) and destroyed once no session holds
 *   it. Sessions asking for the same file of the same video share one transfer, and a video's
 *   channel never carries more requests than NFX-12 §4 allows (8, free mode): the rest queue.
 * - `@sovit/seeder`'s client checks each file's size and sha256 (NFX-05 §4).
 * - `HyperdhtFetcher` is one session's view: a seeder that does not have a file (`missing`) is
 *   asked for the next one all the same; one that cannot be reached, does not serve the video,
 *   breaks the protocol, stalls or serves a bad file is dropped for the session (NFX-05 §4: a
 *   source that served a mismatch is discarded — the client also closes that connection, for
 *   every session) and the next seeder is asked.
 * - `close` ends the session's fetches at once and releases its connections; a transfer another
 *   session shares goes on for that one.
 */
import { nfx } from '@sovit/core';
import type {
  FetchFailure,
  Logger,
  NfxConnection,
  NfxDht,
  PeerKeyPair,
  SeederCrypto,
} from '@sovit/seeder';
import { dialNfx, toHex } from '@sovit/seeder';

import type { NfxFetcher } from './watch.js';

/** How long one dial may take before the next seeder is tried. */
export const NFX_DIAL_TIMEOUT_MS = 20_000;

/** Why a transfer failed; `unreachable`: the seeder could not be dialed. */
export type NfxFetchFailure = FetchFailure | 'unreachable';

export type NfxFetchOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: NfxFetchFailure };

export interface NfxPeerPoolOptions {
  /** The DHT node to dial from (resolved on each dial). */
  readonly dht: () => Promise<NfxDht>;
  /** The watcher's key pair for `namespace`. */
  readonly keyPair: (namespace: string) => Promise<PeerKeyPair>;
  readonly crypto: SeederCrypto;
  readonly logger: Logger;
  readonly dialTimeoutMs?: number;
}

/** A session's share of one seeder's connection. */
export interface NfxPeerLease {
  fetch(video: nfx.VideoAddr, sha: string, size: number, exact: boolean): Promise<NfxFetchOutcome>;
  /** Give the share back (idempotent); the last one destroys the connection. */
  release(): void;
}

/** Requests of one video in flight on one connection, and those waiting for a slot. */
interface Channel {
  active: number;
  readonly queue: (() => void)[];
}

interface Entry {
  readonly key: string;
  refs: number;
  /** The dial; `null`: the seeder could not be reached. */
  connection: Promise<NfxConnection | null>;
  /** Transfers in flight by `<video> <sha>`. */
  readonly transfers: Map<string, Promise<NfxFetchOutcome>>;
  readonly channels: Map<string, Channel>;
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export class NfxPeerPool {
  private readonly o: NfxPeerPoolOptions;
  private readonly entries = new Map<string, Entry>();
  private closed = false;

  constructor(o: NfxPeerPoolOptions) {
    this.o = o;
  }

  /** Connections held now. */
  get size(): number {
    return this.entries.size;
  }

  /** Take a share of the connection to `peer` (32 bytes) on `namespace`, dialing it if needed. */
  acquire(namespace: string, peer: Uint8Array): NfxPeerLease {
    const key = `${namespace} ${toHex(peer)}`;
    let entry = this.entries.get(key);
    if (entry === undefined || this.closed) {
      entry = this.dial(key, namespace, peer);
      if (!this.closed) this.entries.set(key, entry);
    }
    const e = entry;
    e.refs++;
    let released = false;
    return {
      fetch: (video, sha, size, exact) => this.fetchOn(e, video, sha, size, exact),
      release: () => {
        if (released) return;
        released = true;
        if (--e.refs > 0) return;
        if (this.entries.get(e.key) === e) this.entries.delete(e.key);
        void e.connection.then((c) => {
          c?.destroy('no play session needs it');
        });
      },
    };
  }

  /** Worker shutdown: every connection goes; later leases fetch nothing. */
  close(): void {
    this.closed = true;
    const all = [...this.entries.values()];
    this.entries.clear();
    for (const e of all)
      void e.connection.then((c) => {
        c?.destroy('the worker is shutting down');
      });
  }

  private dial(key: string, namespace: string, peer: Uint8Array): Entry {
    const entry: Entry = {
      key,
      refs: 0,
      connection: Promise.resolve(null),
      transfers: new Map(),
      channels: new Map(),
    };
    entry.connection = this.connect(entry, namespace, peer);
    // A seeder that cannot be reached is not remembered: a later session tries again.
    void entry.connection.then((c) => {
      if (c === null && this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry;
  }

  private async connect(
    entry: Entry,
    namespace: string,
    peer: Uint8Array,
  ): Promise<NfxConnection | null> {
    if (this.closed) return null;
    try {
      const [dht, keyPair] = await Promise.all([this.o.dht(), this.o.keyPair(namespace)]);
      const r = await dialNfx(dht, peer, {
        keyPair,
        crypto: this.o.crypto,
        timeoutMs: this.o.dialTimeoutMs ?? NFX_DIAL_TIMEOUT_MS,
        onClose: () => {
          // Gone: the next session to want it dials again.
          if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
        },
      });
      if (!r.ok) {
        this.o.logger.info('nfx: a seeder could not be dialed', { reason: r.reason });
        return null;
      }
      if (this.isClosed() || entry.refs === 0) {
        r.connection.destroy('no play session needs it');
        return null;
      }
      return r.connection;
    } catch (err) {
      this.o.logger.info('nfx: a seeder could not be dialed', { error: err });
      return null;
    }
  }

  /** Read fresh after an `await`. */
  private isClosed(): boolean {
    return this.closed;
  }

  private fetchOn(
    e: Entry,
    video: nfx.VideoAddr,
    sha: string,
    size: number,
    exact: boolean,
  ): Promise<NfxFetchOutcome> {
    const k = `${video.toString()} ${sha}`;
    let p = e.transfers.get(k);
    if (p === undefined) {
      p = this.transfer(e, video, sha, size, exact).finally(() => {
        e.transfers.delete(k);
      });
      e.transfers.set(k, p);
    }
    return p;
  }

  private async transfer(
    e: Entry,
    video: nfx.VideoAddr,
    sha: string,
    size: number,
    exact: boolean,
  ): Promise<NfxFetchOutcome> {
    const connection = await e.connection;
    if (connection === null) return { ok: false, reason: 'unreachable' };
    const release = await this.slot(e, video.toString());
    try {
      // Closed while this one queued.
      if (connection.closed) return { ok: false, reason: 'closed' };
      const files = connection.files(video);
      if (files === undefined) return { ok: false, reason: 'unserved' };
      const chunks: Uint8Array[] = [];
      const r = await files.fetch({
        sha,
        size,
        exact,
        sink: {
          write: (chunk) => {
            chunks.push(chunk);
          },
        },
      });
      return r.ok ? { ok: true, bytes: concat(chunks, r.bytes) } : r;
    } catch {
      // `fetch` never throws; whatever did, this transfer is over.
      return { ok: false, reason: 'closed' };
    } finally {
      release();
    }
  }

  /** A request slot on `video`'s channel of `e`; resolves with its release. */
  private async slot(e: Entry, video: string): Promise<() => void> {
    let ch = e.channels.get(video);
    if (ch === undefined) {
      ch = { active: 0, queue: [] };
      e.channels.set(video, ch);
    }
    const c = ch;
    if (c.active < nfx.MAX_FREE_REQUESTS_PER_CHANNEL) {
      c.active++;
    } else {
      // The slot is handed over by a release, never re-counted: no newcomer can take it meanwhile.
      await new Promise<void>((resolve) => {
        c.queue.push(resolve);
      });
    }
    return () => {
      const next = c.queue.shift();
      if (next !== undefined) next();
      else c.active--;
    };
  }
}

export interface HyperdhtFetcherOptions {
  readonly pool: NfxPeerPool;
  readonly video: nfx.VideoAddr;
  /** The seeders' 32-byte peer keys, in the order to try them. */
  readonly peers: readonly Uint8Array[];
  readonly logger: Logger;
}

interface Peer {
  readonly key: Uint8Array;
  /** Out for the rest of the session. */
  dropped: boolean;
  lease: NfxPeerLease | null;
}

/** Failures that say nothing against the seeder: it lacks this one file, or we asked too much. */
const KEEP: ReadonlySet<NfxFetchFailure> = new Set<NfxFetchFailure>([
  'missing',
  'busy',
  'duplicate',
  'invalid-argument',
]);

export class HyperdhtFetcher implements NfxFetcher {
  private readonly o: HyperdhtFetcherOptions;
  private readonly peers: Peer[];
  private closed = false;
  private abort: (() => void) | null = null;
  /** Settles when `close` is called: every fetch in flight ends with it. */
  private readonly aborted: Promise<NfxFetchOutcome>;

  constructor(o: HyperdhtFetcherOptions) {
    this.o = o;
    this.peers = o.peers.map((key) => ({ key, dropped: false, lease: null }));
    this.aborted = new Promise<NfxFetchOutcome>((resolve) => {
      this.abort = () => {
        resolve({ ok: false, reason: 'closed' });
      };
    });
  }

  async fetch(sha: string, size: number, exact: boolean): Promise<Uint8Array> {
    const namespace = this.o.video.namespace.toString();
    for (const peer of this.peers) {
      if (this.isClosed()) break;
      if (peer.dropped) continue;
      peer.lease ??= this.o.pool.acquire(namespace, peer.key);
      const r = await Promise.race([
        peer.lease.fetch(this.o.video, sha, size, exact),
        this.aborted,
      ]);
      if (this.isClosed()) break;
      if (r.ok) {
        // A transfer shared with another session was asked for with that one's bounds.
        if (exact ? r.bytes.byteLength === size : r.bytes.byteLength <= size) return r.bytes;
        this.drop(peer, 'mismatch');
      } else if (!KEEP.has(r.reason)) this.drop(peer, r.reason);
    }
    throw new Error(this.isClosed() ? 'nfx: the fetcher closed' : 'nfx: no seeder served the file');
  }

  close(): Promise<void> {
    this.closed = true;
    this.abort?.();
    for (const peer of this.peers) {
      peer.lease?.release();
      peer.lease = null;
    }
    return Promise.resolve();
  }

  /** Read fresh after an `await`. */
  private isClosed(): boolean {
    return this.closed;
  }

  private drop(peer: Peer, reason: string): void {
    if (peer.dropped) return;
    peer.dropped = true;
    this.o.logger.info('nfx: a seeder was dropped for this play session', { reason });
    peer.lease?.release();
    peer.lease = null;
  }
}
