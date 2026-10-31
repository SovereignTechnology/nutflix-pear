/**
 * The NFX seeder key (ADR 0020 slice 5c): a Nostr key of this node's own, per network and per
 * user, that signs its kind-20464 beacons and nothing else. NFX-03 names the seeder by its key,
 * not the creator's, and a NIP-46 user could not approve a signature every minute anyway.
 *
 * Custody follows the rules for every key here:
 * - **Held by core's `LocalSigner`**, the only code that holds a Nostr private key.
 * - **At rest in a `LocalSigner` key file** (argon2id plus XChaCha20-Poly1305), 0600 in the 0700
 *   `<userData>/nfx/`, written through `private-file.ts`.
 * - **The passphrase is 32 random bytes**, sealed NIP-44-to-self by the user's own signer (the
 *   recovery-file pattern), so the key opens only for the user who made it. A NIP-46 user
 *   approves one decryption per launch.
 * - **It signs kind 20464 only.** It is never an `IdentityProvider` and never signs as the user.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { NostrEvent, NostrPubkey, Signer } from '@sovit/core';
import { NFX_NETWORKS, nfx, signer as signerMod } from '@sovit/core';

import { ensurePrivateDir, readPrivateFile, writePrivateFile } from '../signer/private-file.js';

/** The directory under userData. */
export const NFX_DIR = 'nfx';
const MAX_KEY_FILE_BYTES = 4096;
const MAX_SEALED_FILE_BYTES = 8192;

/** What the user's signer is asked for: sealing the passphrase to the user's own key. */
export type SealingSigner = Pick<Signer, 'nip44Encrypt' | 'nip44Decrypt'>;

/** A kind-20464 draft; anything else is refused. */
export interface BeaconDraft {
  readonly kind: typeof nfx.KIND_BEACON;
  readonly created_at: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
}

export interface OpenSeederKey {
  /** `<userData>/nfx`. */
  readonly dir: string;
  readonly network: string;
  /** The user whose signer seals the passphrase. */
  readonly user: NostrPubkey;
  readonly seal: SealingSigner;
  /** Key-file KDF cost; the passphrase is 256 random bits, so the floor is plenty. */
  readonly cost?: signerMod.KdfCost;
  /** A warning to log (fixed strings, never key material). */
  readonly warn?: (msg: string) => void;
}

function fileBase(network: string, user: NostrPubkey): string {
  if (!(NFX_NETWORKS as readonly string[]).includes(network)) {
    throw new Error('invalid-argument: not an NFX network this build speaks');
  }
  if (!/^[0-9a-f]{64}$/.test(user)) throw new Error('invalid-argument: not a pubkey');
  return `seeder-${network.replace(/:/g, '-')}-${user.slice(0, 16)}`;
}

function parseSealed(bytes: Uint8Array, user: NostrPubkey): string | null {
  try {
    const raw = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (r['v'] !== 1 || r['user'] !== user || typeof r['sealed'] !== 'string') return null;
    return r['sealed'].length > 0 && r['sealed'].length < MAX_SEALED_FILE_BYTES
      ? r['sealed']
      : null;
  } catch {
    return null;
  }
}

export class NfxSeederKey {
  readonly pubkey: NostrPubkey;
  private readonly signer: signerMod.LocalSigner;

  private constructor(signer: signerMod.LocalSigner, pubkey: NostrPubkey) {
    this.signer = signer;
    this.pubkey = pubkey;
  }

  /**
   * Opens this user's seeder key for `network`, creating it on first use. A missing or unreadable
   * pair of files means a new key (beacons simply name a new seeder). A failure of the user's
   * signer (locked, a bunker offline) is thrown, and never replaces a key.
   */
  static async open(o: OpenSeederKey): Promise<NfxSeederKey> {
    const base = fileBase(o.network, o.user);
    await ensurePrivateDir(o.dir, 'the NFX directory');
    const keyPath = join(o.dir, `${base}.key`);
    const sealedPath = join(o.dir, `${base}.pass.json`);
    const keyFile = await readPrivateFile(keyPath, MAX_KEY_FILE_BYTES);
    const sealedFile = await readPrivateFile(sealedPath, MAX_SEALED_FILE_BYTES);
    const sealed = sealedFile === null ? null : parseSealed(sealedFile, o.user);
    if (keyFile !== null && sealed !== null) {
      const passphrase = new TextEncoder().encode(await o.seal.nip44Decrypt(o.user, sealed));
      try {
        const signer = await signerMod.LocalSigner.unlock(keyFile, passphrase);
        return new NfxSeederKey(signer, await signer.getPublicKey());
      } catch {
        o.warn?.('nfx: the seeder key did not open; making a new one');
      } finally {
        passphrase.fill(0);
      }
    } else if (keyFile !== null) {
      o.warn?.('nfx: the seeder key has no readable sealed passphrase; making a new one');
    }
    return NfxSeederKey.create(o, keyPath, sealedPath);
  }

  private static async create(
    o: OpenSeederKey,
    keyPath: string,
    sealedPath: string,
  ): Promise<NfxSeederKey> {
    const secret = randomBytes(32);
    const text = secret.toString('hex');
    secret.fill(0);
    const passphrase = new TextEncoder().encode(text);
    try {
      const sealed = await o.seal.nip44Encrypt(o.user, text);
      const { signer, file } = await signerMod.LocalSigner.create({
        passphrase,
        cost: o.cost ?? signerMod.minimumCost(),
      });
      // The sealed passphrase first: a key file without it could never open again.
      await writePrivateFile(
        sealedPath,
        new TextEncoder().encode(JSON.stringify({ v: 1, user: o.user, sealed })),
      );
      await writePrivateFile(keyPath, file);
      return new NfxSeederKey(signer, await signer.getPublicKey());
    } finally {
      passphrase.fill(0);
    }
  }

  /** Signs a beacon (kind 20464) and refuses every other kind. */
  async signBeacon(draft: BeaconDraft): Promise<NostrEvent> {
    if (draft.kind !== nfx.KIND_BEACON)
      throw new Error('invalid-argument: the seeder key signs beacons only');
    return this.signer.signEvent({
      kind: draft.kind,
      created_at: draft.created_at,
      tags: draft.tags,
      content: draft.content,
    });
  }

  lock(): Promise<void> {
    return this.signer.lock();
  }
}
