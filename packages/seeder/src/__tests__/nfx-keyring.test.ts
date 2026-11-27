/**
 * The key-only keyring (`nfx-keep/keyring.ts`) derives the seeder's keys: a Corestore opened on
 * the seeder's directory gives the pair the seeder's own store (`BlobStore`, a `GatedCorestore`)
 * gives for the same name, before and after, so a beacon made without a mint names the key a
 * later run with one listens on.
 */
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BlobStore } from '../blobs/blob-store.js';
import { keyringOf, MAX_KEY_NAME, openCorestoreKeyring } from '../nfx-keep/keyring.js';
import { CasIndex } from '../store/cas-index.js';
import { DiskCap } from '../store/disk-cap.js';
import { adapters, capturedLogger, tmpDir } from './helpers.js';

const dirs: { rm(): Promise<void> }[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await d.rm();
});

async function seederStore(dir: string): Promise<BlobStore> {
  const index = new CasIndex({ ...adapters, dataDir: dir });
  await index.load();
  const store = new BlobStore({
    storageDir: path.join(dir, 'corestore'),
    blockSize: 64 * 1024,
    ...adapters,
    index,
    diskCap: new DiskCap(1024 * 1024, 0),
    logger: capturedLogger().logger,
  });
  await store.ready();
  return store;
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('the key-only keyring', () => {
  it("gives the seeder's pair for a name, from the seeder's directory, either way round", async () => {
    const t = await tmpDir('nf-keyring-');
    dirs.push(t);
    const name = 'nfx:regtest:1:seeder';

    // Keyring first (an app with no mint), then the seeder.
    const first = await openCorestoreKeyring(path.join(t.dir, 'corestore'));
    const a = await first.keyPair(name);
    expect(await first.keyPair(name)).toBe(a);
    await first.close();
    await expect(first.keyPair(name)).rejects.toThrow(/^backend-down/);

    const seeder = await seederStore(t.dir);
    const b = await seeder.store.createKeyPair(name);
    expect(hex(b.publicKey)).toBe(hex(a.publicKey));
    expect(hex(b.secretKey)).toBe(hex(a.secretKey));
    const other = await seeder.store.createKeyPair('nfx:regtest:2:seeder');
    expect(hex(other.publicKey)).not.toBe(hex(a.publicKey));

    // Over the seeder's own store: the same pair, and closing it leaves the store open.
    const over = keyringOf(seeder.store);
    expect(hex((await over.keyPair(name)).publicKey)).toBe(hex(a.publicKey));
    await over.close();
    expect(hex((await seeder.store.createKeyPair(name)).publicKey)).toBe(hex(a.publicKey));
    await seeder.close();

    // Again after the seeder.
    const again = await openCorestoreKeyring(path.join(t.dir, 'corestore'));
    expect(hex((await again.keyPair(name)).publicKey)).toBe(hex(a.publicKey));
    await again.close();
  });

  it('another directory is another key, and a name must be 1..160 characters', async () => {
    const t = await tmpDir('nf-keyring-');
    dirs.push(t);
    const one = await openCorestoreKeyring(path.join(t.dir, 'one'));
    const two = await openCorestoreKeyring(path.join(t.dir, 'two'));
    const name = 'nfx:regtest:1:seeder';
    expect(hex((await one.keyPair(name)).publicKey)).not.toBe(
      hex((await two.keyPair(name)).publicKey),
    );
    await expect(one.keyPair('')).rejects.toThrow(/^invalid-argument/);
    await expect(one.keyPair('x'.repeat(MAX_KEY_NAME + 1))).rejects.toThrow(/^invalid-argument/);
    expect((await one.keyPair('x'.repeat(MAX_KEY_NAME))).publicKey.byteLength).toBe(32);
    await one.close();
    await two.close();
  });
});
