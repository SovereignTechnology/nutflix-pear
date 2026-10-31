/**
 * Minimal ambient declarations for the Holepunch stack the desktop worker touches, plus
 * the module shapes `@sovit/seeder`'s and `@sovit/gateway/upstream`'s emitted `.d.ts` refer
 * to (their own ambient files under `src/types/` are not emitted, so every consumer supplies
 * compatible shapes — this file is the seeder/gateway copy extended with what L6-C uses).
 *
 * Written against the pinned versions by reading their source: hypercore@11.35.3,
 * corestore@7.12.2, hyperblobs@2.12.1, hyperswarm@4.17.0, hyperdht@6.34.0,
 * hypercore-blob-server@1.15.0, sodium-native@5.1.0. Nothing here is a full typing of those
 * libraries; a member that is not declared is not used.
 */

declare module 'hypercore' {
  import type { EventEmitter } from 'node:events';

  /** `lib/replicator.js` `Peer`: the `peer` argument of `upload` / `download`. */
  export interface ReplicationPeer {
    readonly remotePublicKey: Uint8Array;
    readonly stream: ReplicationStream;
  }

  /** Duplex-ish stream (streamx). Only what we call. */
  export interface ReplicationStream {
    readonly remotePublicKey: Uint8Array | null;
    readonly publicKey: Uint8Array | null;
    readonly noiseStream: ReplicationStream;
    readonly rawStream: ReplicationStream | null;
    readonly opened: Promise<boolean>;
    readonly destroyed: boolean;
    /** Set by `Hypercore.createProtocolStream` to the `Protomux` instance of this connection. */
    userData: unknown;
    destroy(err?: Error): void;
    end(): void;
    on(event: 'close' | 'connect', cb: () => void): this;
    on(event: 'error', cb: (err: Error) => void): this;
    once(event: 'close' | 'connect', cb: () => void): this;
    once(event: 'error', cb: (err: Error) => void): this;
    pipe<T extends { pipe: unknown }>(dest: T): T;
  }

  export interface ReplicationStreamOptions {
    readonly keyPair?: { publicKey: Uint8Array; secretKey: Uint8Array };
    readonly keepAlive?: number | false;
  }

  export interface HypercoreGetOptions {
    readonly wait?: boolean;
    readonly timeout?: number;
  }

  /** `lib/download.js`: a background range request. */
  export interface HypercoreDownload {
    ready(): Promise<void>;
    /** Resolves when every block of the range is local; rejects if the range is destroyed. */
    done(): Promise<void>;
    /** Detaches the request (hypercore cancels in-flight block requests on the wire). */
    destroy(): void;
  }

  export interface HypercoreEvents {
    upload: (index: number, byteLength: number, peer: ReplicationPeer) => void;
    download: (index: number, byteLength: number, peer: ReplicationPeer) => void;
    'peer-add': (peer: ReplicationPeer) => void;
    'peer-remove': (peer: ReplicationPeer) => void;
    append: () => void;
    close: () => void;
  }

  class Hypercore extends EventEmitter {
    readonly key: Uint8Array;
    readonly discoveryKey: Uint8Array;
    readonly length: number;
    readonly byteLength: number;
    readonly contiguousLength: number;
    readonly opened: boolean;
    readonly closed: boolean;
    readonly writable: boolean;
    readonly peers: readonly ReplicationPeer[];
    ready(): Promise<void>;
    close(): Promise<void>;
    has(index: number): Promise<boolean>;
    get(index: number, opts?: HypercoreGetOptions): Promise<Uint8Array | null>;
    /** Byte offset → `[block index, offset inside the block]`, `null` when unknown. */
    seek(bytes: number, opts?: HypercoreGetOptions): Promise<[number, number] | null>;
    download(range?: { readonly start?: number; readonly end?: number }): HypercoreDownload;
    /** Drops local copies of blocks `[start, end)`. */
    clear(start: number, end?: number): Promise<unknown>;
    append(block: Uint8Array | readonly Uint8Array[]): Promise<{ length: number }>;
    replicate(isInitiator: boolean | ReplicationStream): ReplicationStream;
    on<K extends keyof HypercoreEvents>(event: K, cb: HypercoreEvents[K]): this;
    off<K extends keyof HypercoreEvents>(event: K, cb: HypercoreEvents[K]): this;
    once<K extends keyof HypercoreEvents>(event: K, cb: HypercoreEvents[K]): this;
  }

  export default Hypercore;
}

declare module 'corestore' {
  import type Hypercore from 'hypercore';
  import type { ReplicationStream, ReplicationStreamOptions } from 'hypercore';

  export interface CorestoreGetOptions {
    readonly name?: string;
    readonly key?: Uint8Array;
  }

  class Corestore {
    constructor(storage: string);
    ready(): Promise<void>;
    close(): Promise<void>;
    get(opts: CorestoreGetOptions): Hypercore;
    replicate(
      isInitiator: boolean | ReplicationStream,
      opts?: ReplicationStreamOptions,
    ): ReplicationStream;
    /** Deterministic key pair derived from the store's primary key (stable across restarts). */
    createKeyPair(name: string): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }>;
  }

  export default Corestore;
}

declare module 'hyperblobs' {
  import type Hypercore from 'hypercore';
  import type { HypercoreGetOptions } from 'hypercore';

  export interface BlobId {
    readonly byteOffset: number;
    readonly blockOffset: number;
    readonly blockLength: number;
    readonly byteLength: number;
  }

  export interface BlobWriteStream {
    readonly id: BlobId;
    write(chunk: Uint8Array): boolean;
    end(): void;
    once(event: 'close' | 'drain', cb: () => void): this;
    once(event: 'error', cb: (err: Error) => void): this;
    on(event: 'drain', cb: () => void): this;
    off(event: 'drain', cb: () => void): this;
    destroy(err?: Error): void;
  }

  /** streamx Readable: async-iterable, destroyable. */
  export interface BlobReadStream extends AsyncIterable<Uint8Array> {
    readonly destroyed: boolean;
    destroy(err?: Error): void;
  }

  export interface BlobGetOptions extends HypercoreGetOptions {
    readonly start?: number;
    readonly end?: number;
    readonly length?: number;
  }

  class Hyperblobs {
    constructor(core: Hypercore, opts?: { readonly blockSize?: number });
    readonly core: Hypercore;
    readonly blockSize: number;
    ready(): Promise<void>;
    close(): Promise<void>;
    put(blob: Uint8Array, opts?: { readonly blockSize?: number }): Promise<BlobId>;
    get(id: BlobId, opts?: BlobGetOptions): Promise<Uint8Array | null>;
    clear(id: BlobId): Promise<void>;
    createReadStream(id: BlobId, opts?: BlobGetOptions): BlobReadStream;
    createWriteStream(): BlobWriteStream;
  }

  export default Hyperblobs;
}

declare module 'hyperswarm' {
  import type { EventEmitter } from 'node:events';
  import type DHT from 'hyperdht';
  import type { ReplicationStream } from 'hypercore';

  export interface PeerInfo {
    readonly publicKey: Uint8Array;
    readonly topics: readonly Uint8Array[];
    readonly banned: boolean;
    readonly client: boolean;
    ban(banStatus?: boolean): void;
  }

  export interface PeerDiscovery {
    flushed(): Promise<void>;
    destroy(): Promise<void>;
  }

  export interface HyperswarmOptions {
    readonly keyPair?: { publicKey: Uint8Array; secretKey: Uint8Array };
    readonly seed?: Uint8Array;
    readonly maxPeers?: number;
    readonly bootstrap?: readonly { host: string; port: number }[];
    /** Return `true` to REJECT the connection. Must be synchronous. */
    readonly firewall?: (remotePublicKey: Uint8Array) => boolean;
    /** An existing DHT node (hyperswarm then does not create its own). */
    readonly dht?: unknown;
  }

  export interface SwarmConnection extends ReplicationStream {
    readonly remotePublicKey: Uint8Array;
    /** `@hyperswarm/secret-stream`: the Noise handshake hash, identical on both ends. */
    readonly handshakeHash: Uint8Array | null;
  }

  class Hyperswarm extends EventEmitter {
    constructor(opts?: HyperswarmOptions);
    readonly keyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
    /** The swarm's DHT node; NFX-12 servers listen on it too (slice 5b). */
    readonly dht: DHT;
    readonly peers: ReadonlyMap<string, PeerInfo>;
    readonly connections: ReadonlySet<SwarmConnection>;
    readonly destroyed: boolean;
    join(
      topic: Uint8Array,
      opts?: { readonly server?: boolean; readonly client?: boolean },
    ): PeerDiscovery;
    leave(topic: Uint8Array): Promise<void>;
    flush(): Promise<void>;
    listen(): Promise<void>;
    destroy(): Promise<void>;
    on(event: 'connection', cb: (conn: SwarmConnection, info: PeerInfo) => void): this;
    on(event: 'ban', cb: (info: PeerInfo, err: Error) => void): this;
    on(event: 'update', cb: () => void): this;
  }

  export default Hyperswarm;
}

declare module 'hyperdht' {
  import type NoiseSecretStream from '@hyperswarm/secret-stream';

  export interface KeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }

  export interface DHTOptions {
    readonly bootstrap?: readonly { host: string; port: number }[];
    /** UDP bind host; `127.0.0.1` keeps the node off every other interface. */
    readonly host?: string;
    readonly port?: number;
    readonly ephemeral?: boolean;
    readonly firewalled?: boolean;
    readonly keyPair?: KeyPair;
  }

  /** As `@sovit/seeder`'s declaration (`lib/server.js`), which `NfxDht` is written against. */
  export interface ServerOptions {
    readonly firewall?: (remotePublicKey: Uint8Array) => boolean | Promise<boolean>;
  }

  export interface Server {
    readonly publicKey: Uint8Array | null;
    listen(keyPair: KeyPair): Promise<void>;
    close(): Promise<void>;
  }

  export interface ConnectOptions {
    readonly keyPair?: KeyPair;
  }

  class DHT {
    constructor(opts?: DHTOptions);
    static keyPair(seed?: Uint8Array): KeyPair;
    address(): { host: string; port: number } | null;
    fullyBootstrapped(): Promise<void>;
    createServer(opts: ServerOptions, onconnection: (socket: NoiseSecretStream) => void): Server;
    connect(remotePublicKey: Uint8Array, opts?: ConnectOptions): NoiseSecretStream;
    destroy(): Promise<void>;
  }
  export default DHT;
}

declare module 'hyperdht/testnet.js' {
  export interface Testnet {
    readonly bootstrap: readonly { host: string; port: number }[];
    destroy(): Promise<void>;
  }
  function createTestnet(size?: number, opts?: { readonly host?: string }): Promise<Testnet>;
  export default createTestnet;
}

declare module 'hypercore-blob-server' {
  /** The request info `resolve` sees (decoded from the URL; `index.js` `decodeRequest`). */
  export interface BlobServerRequestInfo {
    readonly head: boolean | null;
    readonly range: { readonly start: number; readonly end: number } | null;
    readonly token: string | null;
    readonly key: Uint8Array | null;
    readonly blob: {
      readonly blockOffset: number;
      readonly blockLength: number;
      readonly byteOffset: number;
      readonly byteLength: number;
    } | null;
    readonly drive: Uint8Array | null;
    readonly pointer: number;
    readonly version: number;
    /** Path part before `?`, URI-decoded, or `null` for `/`. */
    readonly filename: string | null;
    readonly type: string;
  }

  /**
   * What `resolve` returns: `key` is handed verbatim to `store.get({ key })` (it need not be a
   * core key — the worker passes an opaque session handle), `null` = 404 without opening.
   */
  export type BlobServerResolved = { readonly key?: unknown; readonly encryptionKey?: null } | null;

  export interface BlobServerStore {
    get(opts: { readonly key: unknown; readonly active: boolean; readonly wait: boolean }): unknown;
    close(): Promise<void>;
  }

  export interface BlobServerOptions {
    readonly port?: number;
    readonly host?: string;
    readonly address?: string;
    readonly token?: string | Uint8Array | false;
    readonly anyPort?: boolean;
    readonly sandbox?: boolean;
    readonly resolve?: (
      key: Uint8Array,
      info: BlobServerRequestInfo,
    ) => BlobServerResolved | Promise<BlobServerResolved>;
  }

  class HypercoreBlobServer {
    constructor(store: BlobServerStore, opts?: BlobServerOptions);
    readonly host: string;
    readonly port: number;
    readonly token: string;
    listen(): Promise<void>;
    close(): Promise<void>;
    getLink(
      key: Uint8Array | string,
      opts: {
        readonly blob: {
          readonly blockOffset: number;
          readonly blockLength: number;
          readonly byteOffset: number;
          readonly byteLength: number;
        };
        readonly filename?: string;
        readonly type?: string;
      },
    ): string;
  }

  export default HypercoreBlobServer;
}

declare module 'sodium-native' {
  /** CommonJS addon: only the default import carries the bindings (no static named exports). */
  interface SodiumNative {
    readonly crypto_hash_sha256_BYTES: number;
    readonly crypto_hash_sha256_STATEBYTES: number;
    crypto_hash_sha256_init(state: Uint8Array): void;
    crypto_hash_sha256_update(state: Uint8Array, input: Uint8Array): void;
    crypto_hash_sha256_final(state: Uint8Array, out: Uint8Array): void;
    randombytes_buf(buf: Uint8Array): void;
  }
  const sodium: SodiumNative;
  export default sodium;
}
