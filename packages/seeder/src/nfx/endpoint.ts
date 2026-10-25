/**
 * Dial and listen (NFX-12 §1, §3) on a HyperDHT node the caller owns: the worker's swarm DHT
 * or one of its own, built with the network's bootstrap nodes from local configuration. This
 * module only ever dials a key it is given; it never takes an address from received data.
 *
 * - The seeder listens on its per-network peer key pair; the watcher dials with its own
 *   per-network key pair (§1: never the same pair, never shared with another protocol).
 * - The Noise IK handshake authenticates the dialed key; the dialer still closes a connection
 *   whose remote key is not the one it dialed (§3).
 * - Local policy (§9: keys are free, so per-connection limits bound one connection, not one
 *   attacker): the listener caps connections in total and per remote key, in the DHT firewall
 *   before the handshake completes and again when a connection arrives.
 */
import type NoiseSecretStream from '@hyperswarm/secret-stream';
import type { ConnectOptions, Server, ServerOptions } from 'hyperdht';

import type { SeederCrypto } from '../adapters/crypto.js';
import { bytesEqual, toHex } from '../util/hex.js';
import type { PeerKeyPair } from './bind.js';
import { NfxConnection, type NfxLimits, type NfxServeOptions } from './connection.js';

/** The HyperDHT surface used here (`hyperdht` 6). */
export interface NfxDht {
  createServer(opts: ServerOptions, onconnection: (socket: NoiseSecretStream) => void): Server;
  connect(remotePublicKey: Uint8Array, opts?: ConnectOptions): NoiseSecretStream;
}

export const DEFAULT_MAX_CONNECTIONS = 64;
export const DEFAULT_MAX_CONNECTIONS_PER_PEER = 2;
export const DEFAULT_DIAL_TIMEOUT_MS = 30_000;

export interface NfxListenOptions extends NfxServeOptions {
  /** This network's peer key pair, the one its beacons' `hyperdht` endpoint names. */
  readonly keyPair: PeerKeyPair;
  /** `true` REJECTS a dialer's Noise key before the handshake completes (a ban list). */
  readonly firewall?: (remotePublicKey: Uint8Array) => boolean;
  readonly maxConnections?: number;
  readonly maxConnectionsPerPeer?: number;
  readonly limits?: Partial<NfxLimits>;
  readonly onConnection?: (connection: NfxConnection) => void;
}

export interface NfxListener {
  readonly publicKey: Uint8Array;
  readonly connections: number;
  /** Stop listening and close every connection. */
  close(): Promise<void>;
}

export async function listenNfx(dht: NfxDht, o: NfxListenOptions): Promise<NfxListener> {
  const maxConnections = o.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const maxPerPeer = o.maxConnectionsPerPeer ?? DEFAULT_MAX_CONNECTIONS_PER_PEER;
  const live = new Set<NfxConnection>();
  const perPeer = new Map<string, number>();
  let closing = false;

  const full = (key: string): boolean =>
    live.size >= maxConnections || (perPeer.get(key) ?? 0) >= maxPerPeer;

  const accept = (socket: NoiseSecretStream): void => {
    socket.on('error', () => undefined); // NfxConnection records why; this one is for early exits
    const remote = socket.remotePublicKey;
    const key = remote === null ? '' : toHex(remote);
    // Re-checked: the firewall ran before the handshake finished, and others may have come since.
    if (closing || remote === null || full(key)) {
      socket.destroy();
      return;
    }
    const release = (): void => {
      const n = (perPeer.get(key) ?? 1) - 1;
      if (n <= 0) perPeer.delete(key);
      else perPeer.set(key, n);
    };
    let connection: NfxConnection;
    try {
      connection = new NfxConnection(socket, {
        serve: o,
        ...(o.limits !== undefined ? { limits: o.limits } : {}),
        onClose: () => {
          if (live.delete(connection)) release();
        },
      });
    } catch {
      socket.destroy();
      return;
    }
    live.add(connection);
    perPeer.set(key, (perPeer.get(key) ?? 0) + 1);
    o.onConnection?.(connection);
  };

  const server = dht.createServer(
    {
      firewall: (remotePublicKey) =>
        closing || o.firewall?.(remotePublicKey) === true || full(toHex(remotePublicKey)),
    },
    accept,
  );
  await server.listen(o.keyPair);

  return {
    publicKey: o.keyPair.publicKey,
    get connections(): number {
      return live.size;
    },
    async close(): Promise<void> {
      closing = true;
      for (const c of [...live]) c.destroy('the listener closed');
      await server.close();
    },
  };
}

export interface NfxDialOptions {
  /** This network's watcher key pair: its public key is the NFX-07 §3 peer of the account. */
  readonly keyPair: PeerKeyPair;
  /** sha256 for fetched files (the platform library). */
  readonly crypto: SeederCrypto;
  readonly limits?: Partial<NfxLimits>;
  /** Give up if the connection is not open by then. */
  readonly timeoutMs?: number;
  readonly onClose?: (reason: string) => void;
}

export type DialResult =
  | { readonly ok: true; readonly connection: NfxConnection }
  | {
      readonly ok: false;
      readonly reason: 'invalid-argument' | 'unreachable' | 'timeout' | 'wrong-key';
    };

/** Dial `peer` (a 32-byte peer key from a valid beacon, NFX-12 §3). Never throws. */
export async function dialNfx(
  dht: NfxDht,
  peer: Uint8Array,
  o: NfxDialOptions,
): Promise<DialResult> {
  if (peer.byteLength !== 32) return { ok: false, reason: 'invalid-argument' };
  let socket: NoiseSecretStream;
  try {
    socket = dht.connect(peer, { keyPair: o.keyPair });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  socket.on('error', () => undefined); // a refusal or timeout surfaces as `opened === false`

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, o.timeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS);
  });
  const outcome = await Promise.race([socket.opened, deadline]);
  clearTimeout(timer);

  if (outcome !== true) {
    socket.destroy();
    return { ok: false, reason: outcome === 'timeout' ? 'timeout' : 'unreachable' };
  }
  const remote = socket.remotePublicKey;
  if (remote === null || !bytesEqual(remote, peer)) {
    socket.destroy();
    return { ok: false, reason: 'wrong-key' };
  }
  try {
    const connection = new NfxConnection(socket, {
      crypto: o.crypto,
      ...(o.limits !== undefined ? { limits: o.limits } : {}),
      ...(o.onClose !== undefined ? { onClose: o.onClose } : {}),
    });
    return { ok: true, connection };
  } catch {
    socket.destroy();
    return { ok: false, reason: 'unreachable' };
  }
}
