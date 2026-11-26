/**
 * `secure.ts` where libsodium's guarded allocator cannot be used.
 *
 * Electron refuses the external ArrayBuffer `sodium_malloc` hands back (the V8 memory cage,
 * Electron 21 and later): sodium-native's binding returns nothing, and its wrapper throws a
 * TypeError. Every key path starts with `secureAlloc`, so in the desktop app creating, importing
 * and unlocking a local key all failed, and so did opening the wallet's journal (#150). These
 * tests name the runtime Electron (`process.versions.electron`), swap the allocator for one that
 * fails the ways it can (a throw, no buffer, a wrong buffer) and run the real key file, signer
 * and recovery-entropy code over it. `e2e/secure-memory.e2e.ts` in app-desktop runs the same
 * paths inside the real Electron binary.
 *
 * The fallback is Electron's alone: on Node a failing `sodium_malloc` stays an error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import type sodium from 'sodium-universal';

type Sodium = typeof sodium;

const enc = new TextEncoder();
const SK = new Uint8Array(32).fill(7);
const PUB = getPublicKey(SK);

function nameRuntimeElectron(): void {
  Object.defineProperty(process.versions, 'electron', {
    value: '45.3.1',
    configurable: true,
    enumerable: true,
  });
}

/** Load `secure.ts` (and what is imported after it) over this `sodium_malloc`. */
function withAllocator(malloc: (n: number, real: Sodium['sodium_malloc']) => Uint8Array): {
  readonly calls: () => number;
} {
  let calls = 0;
  vi.resetModules();
  vi.doMock('sodium-universal', async () => {
    const real = (await vi.importActual<{ default: Sodium }>('sodium-universal')).default;
    return {
      default: {
        ...real,
        sodium_malloc: (n: number): Uint8Array => {
          calls++;
          return malloc(n, (m) => real.sodium_malloc(m));
        },
      },
    };
  });
  return { calls: () => calls };
}

afterEach(() => {
  Reflect.deleteProperty(process.versions, 'electron');
  vi.doUnmock('sodium-universal');
  vi.resetModules();
});

const REFUSALS: readonly (readonly [string, () => Uint8Array])[] = [
  [
    'throws, as in Electron',
    (): Uint8Array => {
      throw new TypeError('The first argument must be of type string … Received undefined');
    },
  ],
  ['returns no buffer', (): Uint8Array => undefined as unknown as Uint8Array],
  ['returns a buffer of the wrong length', (): Uint8Array => new Uint8Array(0)],
];

describe('secure memory on Node', () => {
  it('comes from the guarded allocator, zero-filled', async () => {
    vi.resetModules();
    const { hasSecureMemory, secureAlloc } = await import('../secure.js');
    expect(hasSecureMemory()).toBe(true);
    const b = secureAlloc(32) as Uint8Array & { secure?: boolean };
    expect(b.secure).toBe(true);
    expect(b.length).toBe(32);
    expect(b.every((x) => x === 0)).toBe(true);
  });

  // The wrong-length case is Electron's probe only: on Node the allocator's answer is used as is.
  it.each(REFUSALS.slice(0, 2))(
    'a sodium_malloc that %s stays an error: no silent fallback',
    async (_name, malloc) => {
      const alloc = withAllocator(malloc);
      const { hasSecureMemory, secureAlloc } = await import('../secure.js');
      expect(() => secureAlloc(32)).toThrow();
      expect(() => secureAlloc(32)).toThrow();
      // Not remembered either: the next call asks the allocator again.
      expect(alloc.calls()).toBe(2);
      expect(hasSecureMemory()).toBe(false);
    },
  );
});

describe('secure memory in Electron', () => {
  it('uses the guarded allocator when Electron allows it', async () => {
    nameRuntimeElectron();
    withAllocator((n, real) => real(n));
    const { hasSecureMemory, secureAlloc } = await import('../secure.js');
    expect(hasSecureMemory()).toBe(true);
    expect((secureAlloc(32) as Uint8Array & { secure?: boolean }).secure).toBe(true);
  });
});

describe.each(REFUSALS)('secure memory in Electron, where sodium_malloc %s', (_name, malloc) => {
  it('is an ordinary zeroed buffer outside the JS heap; the allocator is asked once', async () => {
    nameRuntimeElectron();
    const alloc = withAllocator(malloc);
    const { hasSecureMemory, secureAlloc, secureCopy, wipe } = await import('../secure.js');

    expect(hasSecureMemory()).toBe(false);
    const a = secureAlloc(32);
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.length).toBe(32);
    expect(a.byteOffset).toBe(0);
    expect(a.buffer.byteLength).toBe(32);
    expect(a.every((x) => x === 0)).toBe(true);
    expect(secureAlloc(0).length).toBe(0);

    const c = secureCopy(SK);
    expect(Array.from(c)).toEqual(Array.from(SK));
    expect(c.buffer).not.toBe(SK.buffer);
    wipe(c);
    expect(c.every((x) => x === 0)).toBe(true);
    expect(SK.every((x) => x === 7)).toBe(true);

    for (let i = 0; i < 20; i++) secureAlloc(64);
    // Each failed sodium_malloc leaves its guarded pages allocated: the probe runs once.
    expect(alloc.calls()).toBe(1);
  });

  it('seals and reopens a key file', async () => {
    nameRuntimeElectron();
    withAllocator(malloc);
    const { minimumCost, openKeyFile, sealKeyFile } = await import('../keyfile.js');
    const file = await sealKeyFile({
      secretKey: SK,
      pubkey: PUB,
      passphrase: enc.encode('correct horse battery staple'),
      cost: minimumCost(),
    });
    const opened = await openKeyFile(file, enc.encode('correct horse battery staple'));
    expect(Array.from(opened.secretKey)).toEqual(Array.from(SK));
    await expect(openKeyFile(file, enc.encode('wrong horse battery staple'))).rejects.toThrow(
      /^bad-passphrase/,
    );
  });

  it('creates a local signer from a new key and unlocks it again', async () => {
    nameRuntimeElectron();
    withAllocator(malloc);
    const { minimumCost } = await import('../keyfile.js');
    const { LocalSigner } = await import('../local.js');
    const pw = (): Uint8Array => enc.encode('correct horse battery staple');
    const { signer, file } = await LocalSigner.create({ passphrase: pw(), cost: minimumCost() });
    const pubkey = await signer.getPublicKey();
    await signer.lock();
    const again = await LocalSigner.unlock(file, pw());
    expect(await again.getPublicKey()).toBe(pubkey);
    await again.lock();
  });

  it('makes a mesh session key', async () => {
    nameRuntimeElectron();
    withAllocator(malloc);
    const { MeshSessionKey } = await import('../mesh-key.js');
    const key = MeshSessionKey.create();
    expect(key.pubkey).toMatch(/^[0-9a-f]{64}$/);
    key.destroy();
  });

  it('holds recovery entropy (seed.ts no longer calls sodium_malloc itself)', async () => {
    nameRuntimeElectron();
    const alloc = withAllocator(malloc);
    const { entropyFromBytes, entropyFromHex, entropyToHex } = await import('../../wallet/seed.js');
    const hex = '000102030405060708090a0b0c0d0e0f';
    expect(entropyToHex(entropyFromHex(hex))).toBe(hex);
    expect(entropyToHex(entropyFromBytes(new Uint8Array(16).fill(1)))).toBe('01'.repeat(16));
    expect(alloc.calls()).toBe(1);
  });
});
