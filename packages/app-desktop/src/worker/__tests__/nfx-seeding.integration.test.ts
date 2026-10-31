/**
 * Slice 5b: the worker's NFX-12 seeding over a local hyperdht testnet. It serves while on and only
 * then, names its listener in a beacon endpoint whose `bind` verifies for the seeder's key, and a
 * watcher fetches a stored file byte for byte through `@sovit/seeder`'s client.
 */
import { createHash } from 'node:crypto';

import { nfx } from '@sovit/core';
import { dialNfx, nodeCrypto, silentLogger } from '@sovit/seeder';
import type { Logger, NfxFileSource, PeerKeyPair } from '@sovit/seeder';
import DHT from 'hyperdht';
import createTestnet from 'hyperdht/testnet.js';
import type { Testnet } from 'hyperdht/testnet.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NfxSeeding, seederKeyName } from '../nfx/seeding.js';

vi.setConfig({ testTimeout: 60_000 });

const NS = 'nfx:testnet:1';
const VIDEO = `${NS}:nutflix-${'c'.repeat(32)}`;
const SEEDER_NOSTR = 'ab'.repeat(32);
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** One video's files in memory, as the store answers (only that video, only listed files). */
function memorySource(files: readonly Uint8Array[]): { source: NfxFileSource; shas: string[] } {
  const bySha = new Map(files.map((f) => [sha256(f), f]));
  return {
    shas: [...bySha.keys()],
    source: {
      hasVideo: (v) => v.toString() === VIDEO,
      file: (v, sha) => {
        const data = v.toString() === VIDEO ? bySha.get(sha) : undefined;
        if (data === undefined) return undefined;
        return {
          size: data.byteLength,
          read: (offset, length) => Promise.resolve(data.subarray(offset, offset + length)),
        };
      },
    },
  };
}

describe('NfxSeeding (NFX-12 over HyperDHT)', () => {
  let testnet: Testnet;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    testnet = await createTestnet(3);
  });
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    await testnet.destroy();
  });

  async function node(): Promise<DHT> {
    const n = new DHT({ bootstrap: testnet.bootstrap });
    cleanups.push(() => n.destroy());
    await n.fullyBootstrapped();
    return n;
  }

  async function seeding(files: readonly Uint8Array[]): Promise<{
    s: NfxSeeding;
    shas: string[];
    names: string[];
  }> {
    const dht = await node();
    const names: string[] = [];
    const keys = new Map<string, PeerKeyPair>();
    const { source, shas } = memorySource(files);
    const s = new NfxSeeding(
      {
        dht: () => dht,
        keyPair: (name) => {
          names.push(name);
          let kp = keys.get(name);
          if (kp === undefined) {
            kp = DHT.keyPair();
            keys.set(name, kp);
          }
          return Promise.resolve(kp);
        },
        source,
        logger: silentLogger,
      },
      NS,
    );
    cleanups.push(() => s.close());
    return { s, shas, names };
  }

  it('serves only while on; its endpoint binds the listener to the seeder key', async () => {
    const data = new Uint8Array(3 * nfx.MAX_DATA_PAYLOAD + 17).fill(7);
    const { s, shas, names } = await seeding([data]);
    expect(s.serving).toBe(false);
    expect(await s.endpoint(SEEDER_NOSTR)).toBeNull();

    await s.set(true);
    expect(s.serving).toBe(true);
    const endpoint = await s.endpoint(SEEDER_NOSTR);
    expect(endpoint?.t).toBe('hyperdht');
    expect(nfx.verifyHyperdhtBind(endpoint!.peer, endpoint!.bind, SEEDER_NOSTR, NS)).toBe(true);
    // One key per network, never the legacy swarm's.
    expect(new Set(names)).toEqual(new Set([seederKeyName(NS)]));
    expect(seederKeyName(NS)).not.toBe('nutflix-desktop-swarm');

    const watcher = await node();
    const dialed = await dialNfx(watcher, Buffer.from(endpoint!.peer, 'hex'), {
      keyPair: DHT.keyPair(),
      crypto: nodeCrypto,
      timeoutMs: 20_000,
    });
    if (!dialed.ok) throw new Error(`dial failed: ${dialed.reason}`);
    cleanups.push(() => {
      dialed.connection.destroy('test over');
      return Promise.resolve();
    });
    const video = nfx.VideoAddr.parse(VIDEO);
    if (!video.ok) throw new Error('bad test video');
    const chunks: Uint8Array[] = [];
    const r = await dialed.connection.files(video.value)!.fetch({
      sha: shas[0]!,
      size: data.byteLength,
      sink: { write: (c) => void chunks.push(c) },
    });
    expect(r).toEqual({ ok: true, bytes: data.byteLength });
    expect(sha256(Buffer.concat(chunks))).toBe(shas[0]);

    await s.set(false);
    expect(s.serving).toBe(false);
    expect(await s.endpoint(SEEDER_NOSTR)).toBeNull();
  });

  it('settles on/off races in call order and stays off once closed', async () => {
    const { s } = await seeding([new Uint8Array(10)]);
    void s.set(true);
    void s.set(false);
    await s.set(true);
    expect(s.serving).toBe(true);
    await s.close();
    expect(s.serving).toBe(false);
    await s.set(true);
    expect(s.serving).toBe(false);
  });

  it('without a DHT it does not serve, and says so', async () => {
    const warn = vi.fn();
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn,
      error: () => undefined,
      child: () => logger,
    };
    const s = new NfxSeeding(
      {
        dht: () => null,
        keyPair: () => Promise.resolve(DHT.keyPair()),
        source: memorySource([]).source,
        logger,
      },
      NS,
    );
    await s.set(true);
    expect(s.serving).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
