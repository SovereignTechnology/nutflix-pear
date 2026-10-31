/**
 * Slice 5c: the NFX seeder key's custody — a LocalSigner key file per network and user, its
 * passphrase sealed NIP-44-to-self by the user's signer, private files, beacons only.
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NostrPubkey } from '@sovit/core';
import { nfx } from '@sovit/core';
import { afterEach, describe, expect, it } from 'vitest';

import { NfxSeederKey } from '../nfx/seeder-key.js';
import { coreTestKit } from './support/core-helpers.js';

const kit = await coreTestKit();
const NS = 'nfx:testnet:1';
const POSIX = process.platform !== 'win32';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'nf-nfx-key-'));
  dirs.push(d);
  return join(d, 'nfx');
}

describe('NfxSeederKey', () => {
  it('makes a key on first use, in private files, and opens the same key again', async () => {
    const d = await dir();
    const user = new kit.TestSigner();
    const first = await NfxSeederKey.open({ dir: d, network: NS, user: user.pubkey, seal: user });
    expect(first.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(first.pubkey).not.toBe(user.pubkey);
    const files = (await readdir(d)).sort();
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.startsWith('seeder-nfx-testnet-1-'))).toBe(true);
    if (POSIX) {
      expect((await stat(d)).mode & 0o777).toBe(0o700);
      for (const f of files) expect((await stat(join(d, f))).mode & 0o777).toBe(0o600);
    }
    // The passphrase is sealed: no file holds it in the clear.
    const sealed = await readFile(
      join(
        d,
        files.find((f) => f.endsWith('.pass.json'))!,
      ),
      'utf8',
    );
    expect(JSON.parse(sealed)).toMatchObject({ v: 1, user: user.pubkey });
    expect(user.calls.filter((c) => c.method === 'nip44Encrypt')).toHaveLength(1);
    await first.lock();

    const again = await NfxSeederKey.open({ dir: d, network: NS, user: user.pubkey, seal: user });
    expect(again.pubkey).toBe(first.pubkey);
    expect(user.calls.filter((c) => c.method === 'nip44Decrypt')).toHaveLength(1);
  });

  it('is per user: another account gets a key of its own', async () => {
    const d = await dir();
    const a = new kit.TestSigner();
    const b = new kit.TestSigner();
    const ka = await NfxSeederKey.open({ dir: d, network: NS, user: a.pubkey, seal: a });
    const kb = await NfxSeederKey.open({ dir: d, network: NS, user: b.pubkey, seal: b });
    expect(ka.pubkey).not.toBe(kb.pubkey);
    expect(await readdir(d)).toHaveLength(4);
  });

  it('signs kind-20464 beacons, and nothing else', async () => {
    const d = await dir();
    const user = new kit.TestSigner();
    const key = await NfxSeederKey.open({ dir: d, network: NS, user: user.pubkey, seal: user });
    const ev = await key.signBeacon({
      kind: nfx.KIND_BEACON,
      created_at: 1_790_000_000,
      tags: [['n', NS]],
      content: '{}',
    });
    expect(ev.pubkey).toBe(key.pubkey);
    expect(ev.kind).toBe(20464);
    await expect(
      key.signBeacon({ kind: 1, created_at: 1, tags: [], content: 'hi' }),
    ).rejects.toThrow(/beacons only/);
  });

  it('refuses a network this build does not speak, and a malformed user', async () => {
    const d = await dir();
    const user = new kit.TestSigner();
    await expect(
      NfxSeederKey.open({ dir: d, network: 'nfx:mainnet:1', user: user.pubkey, seal: user }),
    ).rejects.toThrow(/network/);
    await expect(
      NfxSeederKey.open({ dir: d, network: NS, user: 'x' as NostrPubkey, seal: user }),
    ).rejects.toThrow(/pubkey/);
  });

  it('a damaged seal makes a new key; a signer that says no makes none', async () => {
    const d = await dir();
    const user = new kit.TestSigner();
    const first = await NfxSeederKey.open({ dir: d, network: NS, user: user.pubkey, seal: user });
    const sealedName = (await readdir(d)).find((f) => f.endsWith('.pass.json'))!;
    await writeFile(join(d, sealedName), '{"v":1}', { mode: 0o600 });
    const warnings: string[] = [];
    const second = await NfxSeederKey.open({
      dir: d,
      network: NS,
      user: user.pubkey,
      seal: user,
      warn: (m) => warnings.push(m),
    });
    expect(second.pubkey).not.toBe(first.pubkey);
    expect(warnings).toEqual([
      'nfx: the seeder key has no readable sealed passphrase; making a new one',
    ]);

    const before = await readFile(join(d, sealedName), 'utf8');
    const refusing = {
      nip44Encrypt: () => Promise.reject(new Error('locked')),
      nip44Decrypt: () => Promise.reject(new Error('locked')),
    };
    await expect(
      NfxSeederKey.open({ dir: d, network: NS, user: user.pubkey, seal: refusing }),
    ).rejects.toThrow('locked');
    // Nothing was replaced: the key survives a signer that was only unavailable.
    expect(await readFile(join(d, sealedName), 'utf8')).toBe(before);
  });
});
