/**
 * No local addresses to strangers (moved from nutflix-runtime, NFX-18 §4): ADR 0023 rule 5 (no LAN candidates to a WebRTC
 * peer), applied to HyperDHT. Left to its defaults, hyperdht tells the other side of every
 * connection each local IPv4 address of this machine, LAN, VPN and container bridges included:
 *
 *   - a dialer sends them in its first handshake (`localConnection`, `lib/connect.js`);
 *   - a server sends them in every handshake reply (`shareLocalAddress`, `lib/server.js`).
 *
 * Two ways to turn both off, the same options either way:
 *   - `localAddressesByBind`: a view of a node, for the worker's play pool and seeds, which hides
 *     unless the node's socket is really bound to 127.0.0.1 (below);
 *   - `hideLocalAddressesOn`: the node itself, always hidden, for a library that needs all of it
 *     (shape (a)'s updater hands one to Hyperswarm on a release root).
 * The cost: two peers behind one router without NAT loopback, or two apps on one machine, may fail
 * to connect, because neither learns the other's local address.
 *
 * On one host, hyperdht 6.36.0 carries data between two peers only through their local addresses,
 * and only when both bind alike: both to every interface (they meet on a LAN address) or both to
 * 127.0.0.1. Measured in a Kata VM on a loopback testnet: with hiding on either side, or with one
 * peer bound to 127.0.0.1 and the other to every interface, the Noise stream opened and then
 * carried nothing until it timed out. So peers that are all this machine's own processes (the
 * tests, the e2e suites, the `pear run` proof) need the defaults, and the same bind.
 *
 * Hence one exception: a node whose UDP socket is bound to 127.0.0.1. The worker asks for that
 * bind when every bootstrap is `127.0.0.1` (`isLoopbackTestnet`, `DhtNode`'s `loopbackOnly`; the
 * test peers bind there too), but the exception reads the address the socket is actually bound
 * to (`boundHost`), at each dial and when each listener starts, not the option it asked for. Such a
 * node can reach only this machine, and its defaults leak nothing: hyperdht's `localAddresses()` of
 * a socket bound to 127.0.0.1 is that address alone (`lib/holepuncher.js`). A `127.0.0.1` bootstrap
 * bridged to the public DHT therefore gets a node that cannot reach a public peer, rather than one
 * that shares local addresses with it; and a node that ended up bound anywhere else, or whose
 * address cannot be read yet, hides.
 */
import type { ConnectOptions, KeyPair, Server, ServerOptions } from 'hyperdht';
import type NoiseSecretStream from '@hyperswarm/secret-stream';

import type { NfxDht } from '../nfx/endpoint.js';

/** A DHT bootstrap node, as a node is configured with one. */
export interface BootstrapNode {
  readonly host: string;
  readonly port: number;
}

/** The two methods of a hyperdht node that the views here call or replace. */
export interface HyperdhtNode {
  connect(remotePublicKey: Uint8Array, opts?: ConnectOptions): NoiseSecretStream;
  createServer(opts: ServerOptions, onconnection: (socket: NoiseSecretStream) => void): Server;
}

/** A hyperdht node whose bound address `localAddressesByBind` reads (dht-rpc's own methods). */
export interface BindableNode extends HyperdhtNode {
  /** The address its UDP socket is bound to; `null` before it is bound. */
  address(): { readonly host: string } | null;
  /** Binds its sockets, once; resolves when they are bound. */
  bind(): Promise<unknown>;
}

/** The host `node`'s socket is bound to now; `null` before it is bound, or if it cannot say. */
export function boundHost(node: BindableNode): string | null {
  try {
    return node.address()?.host ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether a node's connections hide local addresses: always, unless its socket is bound to
 * 127.0.0.1 (`boundHost`). `force` (tests) can only turn hiding on. Named fields, so that the two
 * cannot swap.
 */
export function hidesLocalAddresses(o: {
  readonly boundHost: string | null;
  readonly force?: boolean;
}): boolean {
  return o.force === true || o.boundHost !== '127.0.0.1';
}

/**
 * The worker's view of its node. A dial decides when it is made: hyperdht's defaults only if the
 * socket is bound to 127.0.0.1 then (and `force` is off), hidden otherwise, including before the
 * bind. A listener decides when it starts listening, after waiting for the bind, so it never
 * decides on an address it cannot read. Hiding sets both options last, so no caller can turn
 * them back on.
 */
export function localAddressesByBind(
  node: BindableNode,
  o: { readonly force?: boolean } = {},
): NfxDht {
  const hide = (): boolean =>
    hidesLocalAddresses({ boundHost: boundHost(node), force: o.force === true });
  return {
    connect: (remotePublicKey, opts) =>
      node.connect(remotePublicKey, hide() ? { ...opts, localConnection: false } : opts),
    createServer: (opts, onconnection) => {
      let real: Server | null = null;
      let closed = false;
      return {
        get publicKey(): Uint8Array | null {
          return real?.publicKey ?? null;
        },
        listen: async (keyPair: KeyPair): Promise<void> => {
          if (real !== null) throw new Error('invalid-argument: already listening');
          await node.bind();
          if (closed) throw new Error('backend-down: the listener was closed');
          real = node.createServer(
            hide() ? { ...opts, shareLocalAddress: false } : opts,
            onconnection,
          );
          await real.listen(keyPair);
        },
        close: async (): Promise<void> => {
          closed = true;
          await real?.close();
        },
      };
    },
  };
}

/**
 * Turns both off on `node` itself, for every later caller: its own `connect` and `createServer`
 * are replaced by ones that set the two options last, so no caller can turn them back on. For a
 * library that takes a whole node (Hyperswarm's `dht` option). Returns `node`.
 */
export function hideLocalAddressesOn<T extends HyperdhtNode>(node: T): T {
  const n: HyperdhtNode = node;
  const connect = n.connect.bind(n);
  const createServer = n.createServer.bind(n);
  n.connect = (remotePublicKey, opts) =>
    connect(remotePublicKey, { ...opts, localConnection: false });
  n.createServer = (opts, onconnection) => {
    // hyperdht also takes `createServer(onconnection)`: that form stays working, and hidden.
    if (typeof opts === 'function') return createServer({ shareLocalAddress: false }, opts);
    return createServer({ ...opts, shareLocalAddress: false }, onconnection);
  };
  return node;
}

/**
 * Every bootstrap node is `127.0.0.1`: a test network on this machine, whose node then asks to be
 * bound to 127.0.0.1 (`DhtNode`'s `loopbackOnly`). `null` is the public network.
 */
export function isLoopbackTestnet(bootstrap: readonly BootstrapNode[] | null): boolean {
  return (
    bootstrap !== null && bootstrap.length > 0 && bootstrap.every((b) => b.host === '127.0.0.1')
  );
}
