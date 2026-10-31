/**
 * PeerNode — one Hyperswarm for one `Seeder` (design §1 Worker row: "one Corestore + one
 * Hyperswarm (firewall = `seeder.banList.firewall`)"). Used by the worker itself AND by the
 * in-process fixture seeders of `--dev-fixtures` / the §5(a) test, so there is exactly one
 * implementation of "a connection arrives":
 *
 *   1. admission through the seeder's `SessionRegistry` (ban list → rate limits → stream cap;
 *      a refused connection is destroyed) — the same call `@sovit/seeder`'s own SwarmManager
 *      makes, so the synchronous upload gate accounts every block we send;
 *   2. Corestore replication over the connection (the seeder's store: one Corestore);
 *   3. `pay/1` when payments are wired: one protocol instance per connection, attached to the
 *      connection's protomux, bridged to the seeder (peers who download from us pay us) and to
 *      the viewer payer (we pay peers we download from), then our HELLO.
 *
 * The seeder is created with `swarm: null`; this class owns the swarm instead because the
 * seeder's SwarmManager can neither bind the DHT to loopback (the `--dev-mocks` fence) nor
 * hand out the connection for `pay/1`. `loopbackOnly` binds the DHT node to 127.0.0.1.
 */
import { payProtocol } from '@sovit/core';
import type { HelloMessage, PayProtocol } from '@sovit/core';
import type { ReplicationStream } from 'hypercore';
import DHT from 'hyperdht';
import Hyperswarm from 'hyperswarm';
import type { PeerDiscovery, PeerInfo, SwarmConnection } from 'hyperswarm';
import type { Logger, Seeder } from '@sovit/seeder';
import { fromHex, toHex } from '@sovit/seeder';

import type { ViewerPayer } from '../pay/viewer-payer.js';

export interface BootstrapNode {
  readonly host: string;
  readonly port: number;
}

export interface PayLink {
  /** Identifies the connection itself: hex of the Noise handshake hash (same on both ends). */
  readonly connectionId: string;
  readonly localNoise: string;
  readonly remoteNoise: string;
  /** The connection; the protocol may watch it for `close`. */
  readonly stream: ReplicationStream;
}

export interface PayWiring {
  /** One `pay/1` instance per connection; `null` runs that connection without payments. */
  readonly protocol: (link: PayLink) => PayProtocol | null;
  /**
   * What we announce on a connection (seeder terms + our identity). Stage 3 (ADR 0012): signed by
   * the host over THIS connection's handshake (`binding`, `null` without one), so it may be async.
   */
  readonly hello: (
    binding: payProtocol.ConnectionBinding | null,
  ) => Omit<HelloMessage, 'type'> | Promise<Omit<HelloMessage, 'type'>>;
}

export interface PeerNodeOptions {
  readonly seeder: Seeder;
  readonly logger: Logger;
  /** `null` = hyperswarm's default public bootstrap. */
  readonly bootstrap: readonly BootstrapNode[] | null;
  /** Bind the DHT's UDP socket to 127.0.0.1 only (dev / tests). */
  readonly loopbackOnly: boolean;
  readonly keyPair?: { publicKey: Uint8Array; secretKey: Uint8Array };
  readonly pay: PayWiring | null;
  /** Viewer role: receives each paid connection's protocol. */
  readonly payer?: ViewerPayer | null;
  readonly maxPeers?: number;
}

export interface JoinMode {
  readonly server: boolean;
  readonly client: boolean;
}

export class PeerNode {
  private readonly o: PeerNodeOptions;
  private readonly log: Logger;
  private swarm: Hyperswarm | null = null;
  private readonly joined = new Map<string, { d: PeerDiscovery; mode: JoinMode }>();
  private destroyed = false;

  constructor(o: PeerNodeOptions) {
    this.o = o;
    this.log = o.logger.child({ component: 'peer-node' });
  }

  get publicKey(): Uint8Array {
    if (this.swarm === null) throw new Error('peer node not started');
    return this.swarm.keyPair.publicKey;
  }

  get connections(): number {
    return this.swarm?.connections.size ?? 0;
  }

  /** The swarm's DHT node while started (NFX-12 servers listen on it, slice 5b); else `null`. */
  get dht(): DHT | null {
    return this.swarm?.dht ?? null;
  }

  start(): void {
    if (this.swarm !== null || this.destroyed) return;
    const { bootstrap, loopbackOnly } = this.o;
    if (loopbackOnly && (bootstrap === null || bootstrap.some((b) => b.host !== '127.0.0.1')))
      throw new Error('invalid-argument: a loopback-only node needs a 127.0.0.1 bootstrap');
    const dht = loopbackOnly
      ? new DHT({ bootstrap: bootstrap ?? [], host: '127.0.0.1' })
      : undefined;
    const swarm = new Hyperswarm({
      firewall: this.o.seeder.banList.firewall,
      ...(dht !== undefined ? { dht } : bootstrap !== null ? { bootstrap } : {}),
      ...(this.o.keyPair ? { keyPair: this.o.keyPair } : {}),
      ...(this.o.maxPeers !== undefined ? { maxPeers: this.o.maxPeers } : {}),
    });
    swarm.on('connection', (conn, info) => {
      this.onConnection(conn, info);
    });
    this.swarm = swarm;
    this.log.info('swarm started', { loopbackOnly });
  }

  /** Announce (server) and/or look up (client) a core. Re-joining with other flags replaces. */
  join(discoveryKey: Uint8Array, mode: JoinMode): PeerDiscovery {
    const swarm = this.swarm;
    if (swarm === null) throw new Error('peer node not started');
    const hex = toHex(discoveryKey);
    const prev = this.joined.get(hex);
    if (prev?.mode.server === mode.server && prev.mode.client === mode.client) return prev.d;
    const d = swarm.join(discoveryKey, mode);
    this.joined.set(hex, { d, mode });
    if (prev) void prev.d.destroy().catch(() => undefined);
    return d;
  }

  /** Stop announcing and looking up `discoveryKey` (ADR 0015: a profile core read, not served). */
  leave(discoveryKey: Uint8Array): void {
    const hex = toHex(discoveryKey);
    const prev = this.joined.get(hex);
    if (prev === undefined) return;
    this.joined.delete(hex);
    void prev.d.destroy().catch(() => undefined);
  }

  /** Re-announce every joined topic with `server` (seeding switched on/off). */
  setServing(server: boolean): void {
    for (const [hex, j] of [...this.joined]) {
      if (j.mode.server === server) continue;
      this.join(fromHex(hex), { server, client: j.mode.client });
    }
  }

  async flush(): Promise<void> {
    await this.swarm?.flush();
  }

  async flushed(discoveryKey: Uint8Array): Promise<void> {
    await this.joined.get(toHex(discoveryKey))?.d.flushed();
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    const swarm = this.swarm;
    this.swarm = null;
    this.joined.clear();
    if (swarm !== null) await swarm.destroy();
  }

  private onConnection(conn: SwarmConnection, info: PeerInfo): void {
    const { seeder } = this.o;
    conn.on('error', () => undefined);
    const session = seeder.sessions.admit(conn, info);
    if (session === null) return;
    // Gated (round 9, F57): the peer is served only the cores the seeder has open — each behind
    // its upload gate — never another core in storage it names by discovery key.
    seeder.blobs.store.replicate(conn);
    const pay = this.o.pay;
    if (pay === null || this.swarm === null) return;
    const hash = conn.handshakeHash;
    if (hash === null) {
      this.log.warn('connection without a handshake hash — running it without pay/1');
      return;
    }
    const protocol = pay.protocol({
      connectionId: toHex(hash),
      localNoise: toHex(this.swarm.keyPair.publicKey),
      remoteNoise: session.noiseKeyHex,
      stream: conn,
    });
    if (protocol === null) return;
    const mux = session.mux;
    if (mux !== null) protocol.attach(mux);
    const detachSeeder = seeder.attachPayProtocol(session, protocol);
    const detachPayer = this.o.payer?.attachPeer(session.noiseKeyHex, protocol) ?? null;
    conn.once('close', () => {
      detachSeeder();
      detachPayer?.();
    });
    const binding = mux === null ? null : payProtocol.bindingFromMux(mux);
    void Promise.resolve()
      .then(() => pay.hello(binding))
      .then(
        (hello) => {
          if (protocol.state !== 'closed') protocol.sendHello(hello);
        },
        (err: unknown) => {
          this.log.warn('HELLO could not be built — this connection runs unpaid', { error: err });
        },
      );
  }
}
