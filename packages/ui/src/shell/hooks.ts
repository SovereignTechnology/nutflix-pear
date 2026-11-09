/**
 * Small React hooks for the shell: external stores (router, coordinator), the header's wallet
 * total and identity. Every effect is cancellable; nothing logs.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { MintUrl, NetworkAdapter, NostrPubkey, Profile, Sats } from '@sovit/core';
import type { CoordinatorSnapshot, PlaybackCoordinator } from './coordinator.js';
import type { Router, RouterState } from './router.js';

export function useRouterState(router: Router): RouterState {
  return useSyncExternalStore(
    (l) => router.subscribe(l),
    () => router.snapshot(),
  );
}

export function useCoordinator(c: PlaybackCoordinator): CoordinatorSnapshot {
  return useSyncExternalStore(
    (l) => c.subscribe(l),
    () => c.snapshot(),
  );
}

export type Identity =
  | { readonly status: 'pending' }
  | { readonly status: 'signed-out' }
  | {
      readonly status: 'signed-in';
      readonly pubkey: NostrPubkey;
      readonly profile: Profile | null;
      readonly avatarSrc: string | undefined;
      /** ADR 0013: the signer names this key but cannot sign until it is unlocked. */
      readonly locked?: boolean;
    };

/**
 * `me()` → `profile()` → `image(picture)` (T16: the adapter hash-checks/proxies it), and whether
 * the signer is locked (`signer()`). Re-read whenever `gen` changes (ADR 0013: the shell bumps it
 * on every `signer.status` event).
 */
export function useIdentity(adapter: NetworkAdapter, gen = 0): Identity {
  const [id, setId] = useState<Identity>({ status: 'pending' });
  useEffect(() => {
    let alive = true;
    // A call, not a variable read: TypeScript would otherwise keep `alive` narrowed across awaits.
    const isAlive = (): boolean => alive;
    void (async (): Promise<void> => {
      try {
        const [me, st] = await Promise.all([adapter.me(), adapter.signer().catch(() => null)]);
        if (!isAlive()) return;
        if (me === null) {
          setId({ status: 'signed-out' });
          return;
        }
        const locked = st?.pubkey === me && st.locked;
        setId({ status: 'signed-in', pubkey: me, profile: null, avatarSrc: undefined, locked });
        const profile = await adapter.profile(me).catch(() => null);
        if (!isAlive()) return;
        setId({ status: 'signed-in', pubkey: me, profile, avatarSrc: undefined, locked });
        const pic = profile?.picture;
        if (pic === undefined || pic === '') return;
        const src = await adapter.image(pic).catch(() => undefined);
        if (isAlive() && src !== undefined) {
          setId({ status: 'signed-in', pubkey: me, profile, avatarSrc: src, locked });
        }
      } catch {
        if (isAlive()) setId({ status: 'signed-out' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [adapter, gen]);
  return id;
}

/**
 * The header chip's total: `wallet.balances()` once, then `wallet.onChange` balance events
 * (per mint) re-summed. `undefined` while loading or when there is no wallet to ask (signed
 * out: no wallet call is ever made, as on the Wallet screen).
 */
export function useWalletTotal(
  adapter: NetworkAdapter,
  enabled: boolean,
  /** Re-read when this changes (the signer, and so the wallet behind it, changed). */
  gen = 0,
): Sats | undefined {
  const [total, setTotal] = useState<Sats | undefined>(undefined);
  useEffect(() => {
    if (!enabled) {
      setTotal(undefined);
      return undefined;
    }
    let alive = true;
    let loaded = false;
    const balances = new Map<MintUrl, number>();
    const pending = new Map<MintUrl, number>();
    const publish = (): void => {
      let sum = 0;
      for (const v of balances.values()) sum += v;
      if (alive) setTotal(sum as Sats);
    };
    const unsubscribe = adapter.wallet.onChange((e) => {
      if (e.type !== 'balance') return;
      if (!loaded) {
        pending.set(e.mint, Number(e.balance));
        return;
      }
      balances.set(e.mint, Number(e.balance));
      publish();
    });
    adapter.wallet.balances().then(
      (m) => {
        if (!alive) return;
        for (const [mint, v] of m) balances.set(mint, Number(v));
        // Events that arrived while the first read was in flight are newer.
        for (const [mint, v] of pending) balances.set(mint, v);
        loaded = true;
        publish();
      },
      () => undefined,
    );
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [adapter, enabled, gen]);
  return total;
}
