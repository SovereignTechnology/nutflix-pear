/**
 * NFX seeding over HyperDHT (NFX-12, ADR 0020 slice 5b): this node's stored NFX videos, served
 * free over `nfx/files/1` while seeding AND NFX are both on, and only then.
 *
 * The listener uses one key pair per network, derived from the worker's Corestore primary key
 * (`nfx:<namespace>:seeder`), never the legacy swarm's key, so the two identities cannot be
 * linked. A beacon's `hyperdht` endpoint names that key and carries its `bind` for the seeder's
 * Nostr key (NFX-12 §2), which the host's beacon publisher (slice 5c) asks for.
 *
 * Free mode: no admission and no `nfx/pay/1` (every pay/1 open is refused); the store answers
 * only for files a stored video's verified hash list names.
 */
import type {
  HyperdhtEndpoint,
  Logger,
  NfxDht,
  NfxFileSource,
  NfxListener,
  PeerKeyPair,
} from '@sovit/seeder';
import { hyperdhtEndpoint, listenNfx } from '@sovit/seeder';

export interface NfxSeedingDeps {
  /** The DHT node to listen on (the swarm's), or `null` while there is none. */
  readonly dht: () => NfxDht | null;
  /** A key pair derived by name from the worker's primary key (`Corestore.createKeyPair`). */
  readonly keyPair: (name: string) => Promise<PeerKeyPair>;
  readonly source: NfxFileSource;
  readonly logger: Logger;
}

/** The key pair name for `namespace`'s NFX-12 listener. */
export const seederKeyName = (namespace: string): string => `nfx:${namespace}:seeder`;

export class NfxSeeding {
  readonly namespace: string;
  private readonly d: NfxSeedingDeps;
  private listener: NfxListener | null = null;
  private keyPair: PeerKeyPair | null = null;
  private closed = false;
  /** Every `set` runs after the one before it, so on/off races settle in call order. */
  private queue: Promise<void> = Promise.resolve();

  constructor(d: NfxSeedingDeps, namespace: string) {
    this.d = d;
    this.namespace = namespace;
  }

  /** Whether the listener is up. */
  get serving(): boolean {
    return this.listener !== null;
  }

  /** Connections the listener holds now. */
  get connections(): number {
    return this.listener?.connections ?? 0;
  }

  /** Serve (`true`) or stop (`false`). Settles once the listener matches; never throws. */
  set(on: boolean): Promise<void> {
    this.queue = this.queue.then(() => this.apply(on));
    return this.queue;
  }

  /**
   * The `hyperdht` endpoint for beacons signed by `seeder` (64 hex) on this network, while
   * serving; `null` otherwise, so no beacon names a listener that is not up.
   */
  async endpoint(seeder: string): Promise<HyperdhtEndpoint | null> {
    await this.queue;
    if (this.listener === null) return null;
    return hyperdhtEndpoint(await this.peerKeyPair(), seeder, this.namespace);
  }

  /** Stop for good. */
  close(): Promise<void> {
    this.closed = true;
    return this.set(false);
  }

  private async peerKeyPair(): Promise<PeerKeyPair> {
    this.keyPair ??= await this.d.keyPair(seederKeyName(this.namespace));
    return this.keyPair;
  }

  private async apply(on: boolean): Promise<void> {
    const want = on && !this.closed;
    if (want && this.listener === null) {
      const dht = this.d.dht();
      if (dht === null) {
        this.d.logger.warn('nfx: no DHT to listen on; not seeding NFX');
        return;
      }
      try {
        const keyPair = await this.peerKeyPair();
        this.listener = await listenNfx(dht, { keyPair, source: this.d.source });
        this.d.logger.info('nfx: seeding over HyperDHT', { namespace: this.namespace });
      } catch (err) {
        this.d.logger.error('nfx: the HyperDHT listener did not start', { error: err });
      }
    } else if (!want && this.listener !== null) {
      const listener = this.listener;
      this.listener = null;
      try {
        await listener.close();
      } catch (err) {
        this.d.logger.warn('nfx: the HyperDHT listener did not close cleanly', { error: err });
      }
      this.d.logger.info('nfx: stopped seeding over HyperDHT', { namespace: this.namespace });
    }
  }
}
