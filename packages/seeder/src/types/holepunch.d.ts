/**
 * Minimal ambient declarations for the Holepunch stack, covering EXACTLY the surface the
 * seeder uses. Written against the pinned versions (hypercore@11.35.3, hyperblobs@2.12.1,
 * corestore@7.12.2, hyperswarm@4.17.0, hyperdht@6.34.0, protomux@3.11.0,
 * @hyperswarm/secret-stream@6.9.1) by reading their source — see docs/archive/lanes/L2.md.
 * Nothing here is a full typing of those libraries.
 */

declare module 'hypercore' {
  import type { EventEmitter } from 'node:events';

  /**
   * The `peer` argument of the `upload` / `download` events: `lib/replicator.js` `Peer`.
   * Only public-ish fields the seeder reads. `stream` is the protomux stream, i.e. the
   * Noise secret stream of the connection (hyperswarm `conn`); `remotePublicKey` is the
   * remote Noise public key (32 bytes), set from `stream.remotePublicKey` at peer creation.
   */
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
    /**
     * On the Noise stream: set by `Hypercore.createProtocolStream()` to the `Protomux`
     * instance of this connection (`hypercore/index.js` `noiseStream.userData = protocol`).
     * Absent on stand-ins that never went through Hypercore.
     */
    readonly userData?: unknown;
    destroy(err?: Error): void;
    on(event: 'close' | 'connect', cb: () => void): this;
    on(event: 'error', cb: (err: Error) => void): this;
    once(event: 'close' | 'connect', cb: () => void): this;
    once(event: 'error', cb: (err: Error) => void): this;
    pipe<T extends { pipe: unknown }>(dest: T): T;
  }

  /**
   * A connection's `Protomux` (`noiseStream.userData`, set by `Hypercore.createProtocolStream()`),
   * as far as the seeder's gated Corestore uses it (lane W8b-p2p, round 9): `pair` (protomux
   * 3.11.0) sets the handler of a remote's channel open for `protocol` and `id` (`null`: any id not
   * paired on its own), REPLACING the handler set before under that key; the handler gets the
   * remote's id (a discovery key for Hypercore, or `null`).
   */
  export interface ProtocolMuxer {
    readonly isProtomux: true;
    pair(
      opts: { readonly protocol: string; readonly id?: Uint8Array | null },
      notify: (id: Uint8Array | null) => unknown,
    ): void;
  }

  /** Forwarded to `NoiseSecretStream` when a boolean is passed (fresh stream). */
  export interface ReplicationStreamOptions {
    readonly keyPair?: { publicKey: Uint8Array; secretKey: Uint8Array };
    readonly keepAlive?: number | false;
  }

  export interface HypercoreGetOptions {
    readonly wait?: boolean;
    readonly timeout?: number;
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
    append(block: Uint8Array | readonly Uint8Array[]): Promise<{ length: number }>;
    replicate(isInitiator: boolean | ReplicationStream): ReplicationStream;
    /** A connection's muxer: this core's replicator is attached to it (`_attachToMuxer`). */
    replicate(mux: ProtocolMuxer): ProtocolMuxer;
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
    /**
     * Boolean → returns the raw side of a fresh Noise stream to pipe somewhere; a stream
     * with a `noiseStream` (e.g. a hyperswarm connection) → attaches to it and returns it.
     */
    replicate(
      isInitiator: boolean | ReplicationStream,
      opts?: ReplicationStreamOptions,
    ): ReplicationStream;
  }

  export default Corestore;
}

declare module 'hyperblobs' {
  import type Hypercore from 'hypercore';
  import type { HypercoreGetOptions } from 'hypercore';

  /** Exactly `{ byteOffset, blockOffset, blockLength, byteLength }` as `put()` returns. */
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

  export interface BlobReadStream extends AsyncIterable<Uint8Array> {
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
  }

  export interface SwarmConnection extends ReplicationStream {
    readonly remotePublicKey: Uint8Array;
  }

  class Hyperswarm extends EventEmitter {
    constructor(opts?: HyperswarmOptions);
    readonly keyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
    readonly dht: { address(): { host: string; port: number } | null };
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
    readonly ephemeral?: boolean;
  }

  export interface ServerOptions {
    /**
     * Called with the remote's Noise key during the handshake (`lib/server.js` `_addHandshake`);
     * return `true` to REJECT. Only the first argument is used here.
     */
    readonly firewall?: (remotePublicKey: Uint8Array) => boolean | Promise<boolean>;
  }

  /** `lib/server.js` `Server`: listens on one key pair. */
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
    fullyBootstrapped(): Promise<void>;
    /** Every accepted connection is a secret-stream whose `remotePublicKey` is the dialer's. */
    createServer(opts: ServerOptions, onconnection: (socket: NoiseSecretStream) => void): Server;
    /** The returned stream opens once the Noise IK handshake with `remotePublicKey` completes. */
    connect(remotePublicKey: Uint8Array, opts?: ConnectOptions): NoiseSecretStream;
    destroy(): Promise<void>;
  }
  export default DHT;
}

declare module '@hyperswarm/secret-stream' {
  /** The paired raw side of a stream made without a transport (an in-memory Bridge). */
  export interface RawStream {
    pipe<T extends RawStream>(dest: T): T;
  }

  /**
   * A streamx Duplex of framed, encrypted messages. `write` returns `false` once 16 KiB are
   * buffered (streamx `highWaterMark`), and `'drain'` fires when the buffer has emptied.
   */
  class NoiseSecretStream {
    constructor(
      isInitiator: boolean,
      rawStream?: null,
      opts?: { readonly keyPair?: { publicKey: Uint8Array; secretKey: Uint8Array } },
    );
    readonly isInitiator: boolean;
    readonly publicKey: Uint8Array | null;
    readonly remotePublicKey: Uint8Array | null;
    readonly handshakeHash: Uint8Array | null;
    /** Resolves `true` once the handshake is done, `false` if the stream closed first. */
    readonly opened: Promise<boolean>;
    readonly destroyed: boolean;
    readonly rawStream: RawStream;
    /** Protomux keeps itself here (`Protomux.from`). */
    userData: unknown;
    write(data: Uint8Array): boolean;
    destroy(err?: Error): void;
    pause(): this;
    resume(): this;
    /** Send an empty keepalive frame after `ms` without a write. */
    setKeepAlive(ms: number): void;
    /** Destroy the stream after `ms` without receiving anything (refreshed by every frame). */
    setTimeout(ms: number): void;
    on(event: 'open' | 'close' | 'drain' | 'end', cb: () => void): this;
    on(event: 'error', cb: (err: Error) => void): this;
    once(event: 'open' | 'close' | 'drain', cb: () => void): this;
    once(event: 'error', cb: (err: Error) => void): this;
    off(event: 'open' | 'close' | 'drain', cb: () => void): this;
    off(event: 'error', cb: (err: Error) => void): this;
  }
  export default NoiseSecretStream;
}

declare module 'protomux' {
  /** `addMessage` result: `send` returns the stream's `write()` (`false` = wait for drain). */
  export interface ProtomuxMessage {
    send(message: Uint8Array): boolean;
  }

  /** `Channel` (protomux 3.11.0 `index.js`). Messages are numbered in `addMessage` order. */
  export interface ProtomuxChannel {
    readonly protocol: string;
    readonly id: Uint8Array | null;
    readonly opened: boolean;
    readonly closed: boolean;
    /** No encoding → compact-encoding `raw`: the handler gets a view into the frame. */
    addMessage(opts: { readonly onmessage?: (message: Uint8Array) => unknown }): ProtomuxMessage;
    open(): void;
    close(): void;
    /** `true` once the remote opened its side, `false` if it rejected or the channel closed. */
    fullyOpened(): Promise<boolean>;
  }

  export interface ChannelOptions {
    readonly protocol: string;
    readonly id?: Uint8Array | null;
    readonly onopen?: () => unknown;
    readonly onclose?: (isRemote: boolean) => unknown;
  }

  class Protomux {
    /** The stream's existing muxer (`stream.userData`), or a new one. */
    static from(stream: unknown): Protomux;
    /**
     * `null` when the stream is destroyed, or when a channel for (protocol, id) is already
     * open on this mux (`unique`, the default).
     */
    createChannel(opts: ChannelOptions): ProtomuxChannel | null;
    /**
     * `notify(id)` runs when the remote opens a channel of `protocol` that is not open here
     * (`id: null` = any id without a pairing of its own). It is awaited; if it creates no
     * channel for that id, the remote's open is rejected.
     */
    pair(
      opts: { readonly protocol: string; readonly id?: Uint8Array | null },
      notify: (id: Uint8Array | null) => unknown,
    ): void;
    /** Batch the messages sent until `uncork` into one stream write (tests: one arrival). */
    cork(): void;
    uncork(): void;
  }
  export default Protomux;
}

declare module 'hyperdht/testnet.js' {
  export interface Testnet {
    readonly bootstrap: readonly { host: string; port: number }[];
    destroy(): Promise<void>;
  }
  function createTestnet(size?: number): Promise<Testnet>;
  export default createTestnet;
}
