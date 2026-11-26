/**
 * Secure-memory helpers for key material (SECURITY.md T14; build-plan §7 "In memory:
 * `sodium-native` secure buffers, zeroed on logout").
 *
 * Every private key, passphrase and derived key the signer holds lives in a buffer from
 * `secureAlloc` and is zeroed with `sodium_memzero` the moment it is no longer needed.
 * JavaScript cannot promise more: a library that takes a `Uint8Array` (noble's schnorr, NIP-44)
 * may copy it into its own memory, and those copies are the library's to clear. What this module
 * guarantees is that the signer's OWN copies are wiped on lock.
 *
 * Where that buffer comes from depends on the runtime:
 *
 *   Node, Bare    `sodium_malloc` (guard pages, `mlock`ed, excluded from core dumps where the OS
 *                 allows): the seeder, the gateway and every unit test. A `sodium_malloc` that
 *                 fails there is an error, as it always was: nothing falls back silently.
 *   Electron      an ordinary zeroed buffer. Electron (21 and later) refuses the external
 *                 ArrayBuffer `sodium_malloc` returns (the V8 memory cage): sodium-native's
 *                 binding hands back nothing and its wrapper throws a TypeError
 *                 (holepunchto/sodium-native#185, "not fixable"). The desktop app's keys are
 *                 therefore in ordinary process memory: wiped on lock, but with no guard pages,
 *                 not locked against swap and not kept out of a core dump. They are NOT `mlock`ed
 *                 by hand either: those pages belong to V8's allocator, and the kernel refuses
 *                 `madvise(MADV_DONTNEED)` on a locked page, which an allocator uses to give
 *                 memory back.
 *   a browser     `sodium-javascript` has no secure allocator: its `sodium_malloc` is an ordinary
 *                 zeroed buffer, and the local signer (which also needs argon2id) refuses to run
 *                 at all; the web shell uses NIP-07 / NIP-46 only (build-plan §4).
 */
import sodium from 'sodium-universal';

/** A 32-byte (or other) key buffer: secure memory where the runtime has it (see above). */
export type SecureBuffer = Uint8Array;

/** Inside Electron (main, a utility process, or its binary run as Node). */
function inElectron(): boolean {
  // Read through `globalThis`: a browser bundle may have no `process`, or one without `versions`.
  const versions = (globalThis as { process?: { versions?: Record<string, string | undefined> } })
    .process?.versions;
  return typeof versions?.['electron'] === 'string';
}

/** `undefined` until asked. */
let refused: boolean | undefined;

/**
 * True when this is Electron and it refuses `sodium_malloc`'s memory. Asked once: a
 * `sodium_malloc` that fails there has already taken its guarded pages from libsodium and never
 * gives them back. Outside Electron it is never asked and the answer is no.
 */
function guardedMemoryRefused(): boolean {
  if (refused === undefined) {
    if (!inElectron()) refused = false;
    else
      try {
        const b = sodium.sodium_malloc(1) as Uint8Array | undefined;
        refused = !(b instanceof Uint8Array && b.length === 1);
      } catch {
        refused = true;
      }
  }
  return refused;
}

/** Allocate `n` zero-filled bytes for key material: secure memory where the runtime has it. */
export function secureAlloc(n: number): SecureBuffer {
  // Over an explicit ArrayBuffer, never `new Uint8Array(n)`: V8 keeps a small typed array made
  // from a length inside the JavaScript heap, where the collector may move it and leave the old
  // bytes behind. An ArrayBuffer's store is outside that heap and stays where it is, so `wipe`
  // zeroes the only copy.
  if (guardedMemoryRefused()) return new Uint8Array(new ArrayBuffer(n));
  const b = sodium.sodium_malloc(n);
  sodium.sodium_memzero(b);
  return b;
}

/** Copy `src` into a fresh `secureAlloc` buffer. The caller wipes `src` if it held a secret. */
export function secureCopy(src: Uint8Array): SecureBuffer {
  const b = secureAlloc(src.length);
  b.set(src);
  return b;
}

/** Zero a buffer in place (secure or not). Safe to call twice. */
export function wipe(b: Uint8Array | null | undefined): void {
  if (b !== null && b !== undefined && b.length > 0) sodium.sodium_memzero(b);
}

/** Fill `b` with cryptographically secure random bytes. */
export function randomFill(b: Uint8Array): void {
  sodium.randombytes_buf(b);
}

/**
 * True when `secureAlloc` returns libsodium's guarded memory (sodium-native outside Electron).
 * False in Electron and in a browser, where it is an ordinary buffer. Never throws.
 */
export function hasSecureMemory(): boolean {
  if (guardedMemoryRefused()) return false;
  try {
    const probe = sodium.sodium_malloc(1) as Uint8Array & { secure?: boolean };
    return probe.secure === true;
  } catch {
    return false;
  }
}

/** Constant-time comparison (libsodium `sodium_memcmp`); false for different lengths. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && sodium.sodium_memcmp(a, b);
}
