/**
 * Key pairs derived by name from a Corestore's primary key, without the seeder (moved from
 * nutflix-runtime's `keys.ts`, NFX-18 §4). An app with no mint has no `Seeder`, but its NFX-12
 * listener still needs the key its beacons name, and it has to be the same key a later run with a
 * mint derives. `Corestore.createKeyPair(name)` depends only on the store's primary key, which
 * lives in its storage directory, so a Corestore opened on the seeder's directory
 * (`<dataDir>/corestore`) gives the seeder's keys.
 *
 * Only one Corestore may have a directory open at a time: close this keyring before a `Seeder`
 * opens the same directory, or take the seeder's own store (`keyringOf`).
 *
 * Each name is a role on one network (`nfx:<namespace>:seeder`, NFX-12 §1), never a key shared
 * with another protocol. A viewer's dial key is not derived here: it is random per run.
 */
import Corestore from 'corestore';

import type { PeerKeyPair } from '../nfx/bind.js';

export interface Keyring {
  /** The pair named `name`: the same pair for the same name, every run. */
  keyPair(name: string): Promise<PeerKeyPair>;
  close(): Promise<void>;
}

/** The longest name derived (a namespace is short; this bounds the cache). */
export const MAX_KEY_NAME = 160;

/** What `keyringOf` needs of a store. */
export interface KeyDeriver {
  createKeyPair(name: string): Promise<PeerKeyPair>;
}

/** A keyring over a store already open (the seeder's). `close` leaves the store open. */
export function keyringOf(store: KeyDeriver): Keyring {
  return cached(
    (name) => store.createKeyPair(name),
    () => Promise.resolve(),
  );
}

/** A Corestore under `dir` (created if missing), used only for its primary key. */
export async function openCorestoreKeyring(dir: string): Promise<Keyring> {
  const store = new Corestore(dir);
  await store.ready();
  return cached(
    (name) => store.createKeyPair(name),
    () => store.close(),
  );
}

function cached(
  derive: (name: string) => Promise<PeerKeyPair>,
  closeStore: () => Promise<void>,
): Keyring {
  const cache = new Map<string, Promise<PeerKeyPair>>();
  let closing: Promise<void> | undefined;
  return {
    keyPair: (name) => {
      if (closing !== undefined)
        return Promise.reject(new Error('backend-down: the keyring is closed'));
      if (name.length === 0 || name.length > MAX_KEY_NAME)
        return Promise.reject(new Error('invalid-argument: not a key name'));
      let kp = cache.get(name);
      if (kp === undefined) {
        kp = derive(name);
        cache.set(name, kp);
        void kp.catch(() => {
          cache.delete(name);
        });
      }
      return kp;
    },
    close: () => {
      if (closing === undefined) {
        cache.clear();
        closing = Promise.resolve().then(closeStore);
      }
      return closing;
    },
  };
}
