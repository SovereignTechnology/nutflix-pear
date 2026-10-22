/**
 * `bind` (NFX-12 §2) made here verifies with the codec's verifier, and reproduces the vendored
 * vector's signature byte for byte (Ed25519 is deterministic; the vector's throwaway peer
 * seed is the key pair `hyperdht` derives from it).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { nfx } from '@sovit/core';
import DHT from 'hyperdht';
import { describe, expect, it } from 'vitest';

import { fromHex, toHex } from '../../util/hex.js';
import { hyperdhtBind, hyperdhtEndpoint } from '../bind.js';

const VECTORS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'docs',
  'vendor',
  'nfx-test-vectors',
);

interface BindVector {
  readonly secret_keys_DO_NOT_USE: Readonly<Record<string, string>>;
  readonly bind: {
    readonly seeder: string;
    readonly namespace: string;
    readonly peer: string;
    readonly sig: string;
  };
}

const v = JSON.parse(
  readFileSync(path.join(VECTORS, 'beacon-hyperdht.json'), 'utf8'),
) as BindVector;
const SEEDER = 'a'.repeat(64);
const NS = 'nfx:testnet:1';

describe('hyperdht bind', () => {
  it('reproduces the vector byte for byte', () => {
    const seed = v.secret_keys_DO_NOT_USE['hyperdht_peer'];
    if (seed === undefined) throw new Error('vector has no hyperdht_peer seed');
    const keyPair = DHT.keyPair(fromHex(seed));
    expect(toHex(keyPair.publicKey)).toBe(v.bind.peer);
    expect(hyperdhtBind(keyPair, v.bind.seeder, v.bind.namespace)).toBe(v.bind.sig);
    expect(hyperdhtEndpoint(keyPair, v.bind.seeder, v.bind.namespace)).toEqual({
      t: 'hyperdht',
      peer: v.bind.peer,
      bind: v.bind.sig,
    });
  });

  it('verifies for its seeder and network only', () => {
    const keyPair = DHT.keyPair(new Uint8Array(32).fill(3));
    const e = hyperdhtEndpoint(keyPair, SEEDER, NS);
    expect(nfx.verifyHyperdhtBind(e.peer, e.bind, SEEDER, NS)).toBe(true);
    expect(nfx.verifyHyperdhtBind(e.peer, e.bind, 'b'.repeat(64), NS)).toBe(false);
    expect(nfx.verifyHyperdhtBind(e.peer, e.bind, SEEDER, 'nfx:regtest:1')).toBe(false);
    const other = DHT.keyPair(new Uint8Array(32).fill(4));
    expect(nfx.verifyHyperdhtBind(toHex(other.publicKey), e.bind, SEEDER, NS)).toBe(false);
  });

  it('refuses a malformed seeder, namespace or key pair', () => {
    const keyPair = DHT.keyPair(new Uint8Array(32).fill(5));
    expect(() => hyperdhtBind(keyPair, 'A'.repeat(64), NS)).toThrow(/invalid-argument/);
    expect(() => hyperdhtBind(keyPair, SEEDER, 'nfx:Testnet:1')).toThrow(/invalid-argument/);
    expect(() => hyperdhtBind(keyPair, SEEDER, 'not-a-namespace')).toThrow(/invalid-argument/);
    const mismatched = {
      publicKey: DHT.keyPair(new Uint8Array(32).fill(6)).publicKey,
      secretKey: keyPair.secretKey,
    };
    expect(() => hyperdhtBind(mismatched, SEEDER, NS)).toThrow(/invalid-argument/);
  });
});
