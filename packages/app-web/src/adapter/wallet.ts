/**
 * The web client's `wallet` (ADR 0022 item 7: free videos only, no wallet in v1): every call
 * rejects `unsupported` and the shell hides the Wallet screen and every money action. `onChange`
 * never fires. Nothing here holds or stores a proof, a key or a balance (SECURITY.md invariant 8).
 */
import type {
  CashuP2pkPubkey,
  LockedProofSet,
  MeltQuote,
  MintKeyset,
  MintQuote,
  MintUrl,
  Sats,
  Wallet,
  WalletChangeEvent,
  WalletHistoryEntry,
} from '@sovit/core';

import { unsupported } from '../errors.js';

export class WebWallet implements Wallet {
  mints(): Promise<readonly MintUrl[]> {
    return unsupported('the wallet');
  }
  balance(): Promise<Sats> {
    return unsupported('the wallet');
  }
  inputFeePpk(): Promise<number> {
    return unsupported('the wallet');
  }
  balances(): Promise<ReadonlyMap<MintUrl, Sats>> {
    return unsupported('the wallet');
  }
  p2pkPubkey(): Promise<CashuP2pkPubkey> {
    return unsupported('the wallet');
  }
  mintQuote(): Promise<MintQuote> {
    return unsupported('the wallet');
  }
  pollQuote(): Promise<{ state: MintQuote['state']; minted?: Sats }> {
    return unsupported('the wallet');
  }
  send(): Promise<LockedProofSet> {
    return unsupported('the wallet');
  }
  receive(): Promise<Sats> {
    return unsupported('the wallet');
  }
  meltQuote(): Promise<MeltQuote> {
    return unsupported('the wallet');
  }
  melt(): Promise<{ paid: boolean; preimage?: string; change: Sats }> {
    return unsupported('the wallet');
  }
  keyset(): Promise<MintKeyset> {
    return unsupported('the wallet');
  }
  history(): Promise<readonly WalletHistoryEntry[]> {
    return unsupported('the wallet');
  }
  onChange(_cb: (e: WalletChangeEvent) => void): () => void {
    return () => undefined;
  }
}
