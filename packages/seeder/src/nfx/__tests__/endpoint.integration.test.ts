/**
 * NFX-12 over a real HyperDHT: a seeder listens on its peer key, a watcher dials that key and
 * fetches a file over `nfx/files/1`, on a LOCAL `hyperdht` testnet (`hyperdht/testnet.js`,
 * bootstrap on 127.0.0.1, as the swarm integration tests do). Nothing leaves loopback.
 */
import { nfx } from '@sovit/core';
import DHT from 'hyperdht';
import createTestnet from 'hyperdht/testnet.js';
import type { Testnet } from 'hyperdht/testnet.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeCrypto } from '../../adapters/node/crypto.js';
import { bytesEqual } from '../../util/hex.js';
import type { NfxConnection } from '../connection.js';
import { dialNfx, listenNfx, type NfxListener } from '../endpoint.js';
import { MemorySink, MemorySource, bytes, keyPair, sha256Hex, video } from './helpers.js';

vi.setConfig({ testTimeout: 60_000 });

const V = video('nfx-dht-video');
const SEEDER = keyPair(11);
const WATCHER = keyPair(12);
const BANNED = keyPair(13);

describe('NFX-12 over a local hyperdht testnet', () => {
  let testnet: Testnet;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    testnet = await createTestnet(3);
  });
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    await testnet.destroy();
  });

  function dht(): DHT {
    const node = new DHT({ bootstrap: testnet.bootstrap });
    cleanups.push(() => node.destroy());
    return node;
  }

  async function seeder(
    source: MemorySource,
    onConnection?: (c: NfxConnection) => void,
  ): Promise<NfxListener> {
    const node = dht();
    await node.fullyBootstrapped();
    const listener = await listenNfx(node, {
      keyPair: SEEDER,
      source,
      firewall: (remote) => bytesEqual(remote, BANNED.publicKey),
      maxConnectionsPerPeer: 1,
      ...(onConnection !== undefined ? { onConnection } : {}),
    });
    cleanups.push(() => listener.close());
    return listener;
  }

  it('dials the seeder by key and fetches a file byte for byte', async () => {
    const source = new MemorySource();
    const data = bytes(5 * nfx.MAX_DATA_PAYLOAD + 999, 21);
    const sha = source.add(V, data);
    const served: NfxConnection[] = [];
    await seeder(source, (c) => served.push(c));

    const watcher = dht();
    await watcher.fullyBootstrapped();
    const dialed = await dialNfx(watcher, SEEDER.publicKey, {
      keyPair: WATCHER,
      crypto: nodeCrypto,
      timeoutMs: 20_000,
    });
    if (!dialed.ok) throw new Error(`dial failed: ${dialed.reason}`);
    cleanups.push(() => {
      dialed.connection.destroy('test over');
      return Promise.resolve();
    });
    expect(bytesEqual(dialed.connection.remotePublicKey, SEEDER.publicKey)).toBe(true);

    const sink = new MemorySink();
    const r = await dialed.connection.files(V)!.fetch({ sha, size: data.byteLength, sink });
    expect(r).toEqual({ ok: true, bytes: data.byteLength });
    expect(sha256Hex(sink.bytes())).toBe(sha);

    // The seeder saw the watcher's dialing key: its account's peer (NFX-12 §1).
    expect(served).toHaveLength(1);
    expect(bytesEqual(served[0]!.remotePublicKey, WATCHER.publicKey)).toBe(true);
    expect(served[0]!.pump.stats.maxQueuedBytes).toBeLessThanOrEqual(nfx.MAX_QUEUED_FILE_BYTES);
  });

  it('refuses a dialer its firewall rejects, and a second connection from one key', async () => {
    const source = new MemorySource();
    source.add(V, bytes(10));
    const served: NfxConnection[] = [];
    await seeder(source, (c) => served.push(c));

    const banned = dht();
    await banned.fullyBootstrapped();
    const refused = await dialNfx(banned, SEEDER.publicKey, {
      keyPair: BANNED,
      crypto: nodeCrypto,
      timeoutMs: 15_000,
    });
    expect(refused.ok).toBe(false);

    const watcher = dht();
    await watcher.fullyBootstrapped();
    const first = await dialNfx(watcher, SEEDER.publicKey, {
      keyPair: WATCHER,
      crypto: nodeCrypto,
      timeoutMs: 20_000,
    });
    if (!first.ok) throw new Error(`dial failed: ${first.reason}`);
    cleanups.push(() => {
      first.connection.destroy('test over');
      return Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(served).toHaveLength(1);
    });

    const again = dht();
    await again.fullyBootstrapped();
    const second = await dialNfx(again, SEEDER.publicKey, {
      keyPair: WATCHER,
      crypto: nodeCrypto,
      timeoutMs: 15_000,
    });
    if (second.ok) second.connection.destroy('test over');
    expect(second.ok).toBe(false);
    expect(served).toHaveLength(1);
  });

  it('refuses a peer key that is not 32 bytes', async () => {
    const watcher = dht();
    expect(
      await dialNfx(watcher, new Uint8Array(31), { keyPair: WATCHER, crypto: nodeCrypto }),
    ).toEqual({ ok: false, reason: 'invalid-argument' });
  });
});
