/**
 * The real `PaymentEngine` (SECURITY.md invariants 1–6, threats T3–T8; contracts v5, ADR 0010).
 *
 * SEEDER SIDE — `verify` decides a PAY fully offline, before `ACK` (invariant 4), in the
 * contract's reason precedence: cheap structural and accounting checks first, the DLEQ math
 * last. Every check that matters is re-run synchronously in the same tick as the state change
 * it gates, so no interleaving — another peer's PAY, an upload, a `rebind` — can slip between a
 * check and its commit. PAYs from one peer are decided in arrival order (the carry chains them).
 *
 *   structure, range, core, carry     → malformed
 *   empty set whose share is > 0       → missing-seeder-set / missing-creator-set
 *   mint ∉ accepted ∩ policy           → mint-not-accepted          (T8)
 *   envelope not to own key / creator  → wrong-p2pk-target          (T4, T6)
 *   sums ≠ the carry-aware split       → overpay / wrong-amount     (invariant 2)
 *   a block not sent / already paid    → range-not-uploaded / range-already-paid (inv. 1)
 *   a proof without DLEQ               → missing-dleq
 *   DLEQ fails vs the cached keyset    → bad-dleq                   (T7)
 *   lock in the SECRET not a plain one
 *   to the recipient, or the creator
 *   set not bound to this seeder       → wrong-p2pk-target          (T4, T6, ADR 0010 §6)
 *   a secret already accepted          → double-spend + ban         (T5, invariant 6)
 *
 * `recordUpload` / `rebind` enforce the window synchronously (invariant 5): the crossing update
 * bans and fires `onWindowExceeded` before it returns. `flush` redeems the seeder sets at the mint
 * (a spent proof there is a double-spend: ban) and publishes the creator sets as NIP-61 nutzaps; a
 * mint or relay failure keeps the item for the next flush — the creator's money is never dropped.
 *
 * VIEWER SIDE — `pay` builds both locked sets through `Wallet.send` with the carry-aware split,
 * the creator set bound to the seeder (`['pay1', seeder P2PK]`). If the creator set cannot be
 * made after the seeder set was, the seeder set is kept and used first in the next PAY to that
 * seeder (it is locked to the seeder and cannot be taken back; this turns a loss into a delay).
 *
 * No cryptography here: DLEQ is cashu-ts `hasValidDleq`, secrets are parsed by cashu-ts, proofs
 * are made by the wallet. No proof material ever reaches a result, a detail, a callback or a
 * window snapshot (invariant 7).
 */
import { Amount, hasValidDleq } from '@cashu/cashu-ts';

import type {
  BanEntry,
  BlockRange,
  CashuP2pkPubkey,
  CashuProof,
  CoreKeyHex,
  LockedProofSet,
  MintKeyset,
  MintUrl,
  NostrPubkey,
  OwedRange,
  PayMessage,
  PaymentEngine,
  PaymentEngineConfig,
  PeerWindow,
  PricePolicy,
  RejectReason,
  Sats,
  UnixSeconds,
  VerifyResult,
  Wallet,
} from '../contracts/index.js';
import { checkPayLock, PAY1_TAG } from './lock.js';
import {
  OWED_LIMITS,
  boundOwed,
  type OwedCore,
  type OwedLimits,
  type UnpaidLedger,
} from './owed.js';
import { RangeSet } from './range-set.js';
import { SeenSecrets } from './seen.js';
import {
  MAX_PAY_SATS,
  effectiveWindowBlocks,
  isValidCarry,
  isValidSplit,
  splitPay,
} from './split.js';

// ---------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------

export interface PaymentEngineDeps {
  readonly config: PaymentEngineConfig;
  readonly now?: () => UnixSeconds;
  /** Viewer side: the wallet that makes the locked sets. */
  readonly wallet?: Pick<Wallet, 'send'>;
  /**
   * Seeder side: a CACHED keyset for offline DLEQ verification (T7). Called only for mints the
   * PAY may use (accepted ∩ policy). Whether a miss triggers a fetch is the host's policy — keep
   * it rate-limited: a peer can name any keyset id.
   */
  readonly keyset?: (mint: MintUrl, keysetId: string) => Promise<MintKeyset | undefined>;
  /**
   * Seeder side: swap a seeder set into the node's own wallet (`Wallet.receive`). Must reject
   * with an error whose `code` is `'spent'` when the mint reports a proof already spent.
   */
  readonly redeem?: (set: {
    readonly mint: MintUrl;
    readonly proofs: readonly CashuProof[];
  }) => Promise<Sats>;
  /**
   * Seeder side: publish creator proofs as ONE NIP-61 nutzap (kind 9321). The engine batches every
   * creator set of a flush that shares creator key × mint × core into one call — at a real mint's
   * input fee a lone 1-sat creator set is worthless, a batch is worth its sum less one fee
   * (security review F34). `peers` are the viewers whose PAYs it forwards, `pays` how many.
   */
  readonly nutzap?: (
    set: LockedProofSet,
    ctx: {
      readonly core: CoreKeyHex;
      readonly peers: readonly NostrPubkey[];
      readonly pays: number;
    },
  ) => Promise<void>;
  /** Seeder side: accepted proof secrets (restore from disk at start; persists new ones). */
  readonly seen?: SeenSecrets;
  /**
   * Seeder side: NUT-07 spent flags for a proof set (`CashuWallet.checkSpent`). Given, the
   * creator set is checked before its first nutzap and a spent proof is a double-spend of the
   * creator's share: ban, no nutzap (security review F11). A failed check does not block the nutzap.
   */
  readonly checkSpent?: (set: {
    readonly mint: MintUrl;
    readonly proofs: readonly CashuProof[];
  }) => Promise<readonly boolean[]>;
  /**
   * Seeder side: whether every proof of a seeder set was spent with OUR key (`CashuWallet.
   * spentByUs`). Given, a redeem the mint answers "spent" is first checked: our own swap whose
   * response was lost is not a double-spend — no ban, and the creator set is still nutzapped
   * (security review F31).
   */
  readonly spentByUs?: (set: {
    readonly mint: MintUrl;
    readonly proofs: readonly CashuProof[];
  }) => Promise<boolean>;
  /**
   * Seeder side: called synchronously with a snapshot of every accepted-but-unflushed PAY
   * whenever that queue changes — in the same tick as the acceptance, before `verify` resolves
   * (so before the ACK). The proofs in it are spendable by this seeder (and the creator): store
   * them like wallet proofs (0600, or the encrypted NIP-60 store). `restorePending` reloads them
   * at start (security review F12).
   */
  readonly persistPending?: (items: readonly PendingPay[]) => void;
  /**
   * Seeder side: run the DLEQ checks off the event loop (security review F5: ~20 ms per proof
   * under `--jitless`, and one event loop serves every session). Given, each PAY's checks go out
   * as ONE call once every cheaper check passed; answer `proofDleqOk(check.proof, check.keyset)`
   * for each, in order. A verifier that throws, or answers with the wrong length, falls back to
   * the synchronous check — never to acceptance.
   */
  readonly dleq?: (checks: readonly DleqCheck[]) => Promise<readonly boolean[]>;
}

/** One proof-side DLEQ check (NUT-12) an off-thread verifier runs with `proofDleqOk`. */
export interface DleqCheck {
  readonly proof: CashuProof;
  /** The mint keyset, reduced to the key for the proof's amount. */
  readonly keyset: MintKeyset;
}

/** An accepted PAY not yet redeemed (`redeem`) or not yet forwarded to the creator (`nutzap`). */
export interface PendingPay {
  readonly peer: NostrPubkey;
  readonly msg: PayMessage;
  readonly stage: 'redeem' | 'nutzap';
  /** The creator set was checked at the mint already (F11: never re-checked after a restart). */
  readonly creatorChecked?: boolean;
  /**
   * A redeem of this seeder set was sent to the mint before (persisted BEFORE each attempt). Only
   * then can a "spent" answer be our own lost swap (F31); on a first attempt it is a double-spend
   * whatever the witness says — the witness of a replayed, already-redeemed set is ours too.
   */
  readonly redeemTried?: boolean;
}

// ---------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------

const CORE_RE = /^[0-9a-f]{64}$/;
const COMPRESSED = /^0[23][0-9a-f]{64}$/;
const KEYSET_ID = /^[0-9a-f]{16}$|^[0-9a-f]{66}$/;
const HEX = /^[0-9a-f]+$/;
/** Hypercore block indexes are array positions; 2^40 is a 64 PiB core. */
const MAX_BLOCK = 2 ** 40;
/**
 * Most proofs one set may carry. A P2PK send splits into powers of two (≤ 41 proofs for any
 * amount up to 2^40) plus a few reused ones; every proof costs a DLEQ check (~14 ms in pure JS),
 * so an uncapped set is a CPU lever for any peer (T11).
 */
export const MAX_PROOFS_PER_SET = 64;
/**
 * Most distinct keyset ids one set may name. A P2PK send's outputs all come from the mint's
 * active keyset; a reused orphan set can add an older one. Every id the seeder has not cached
 * may cost a keyset lookup (the host's policy), so a set naming dozens is refused unread.
 */
export const MAX_KEYSETS_PER_SET = 3;
/** Orphaned seeder proofs (see `pay`) one PAY may reuse — keeps honest sets under the cap below. */
export const MAX_REUSED_PROOFS = 6;

/**
 * Most proofs a set worth `sats` may carry (security review F5). A P2PK send splits into
 * distinct powers of two — at most `bitLength(sats)` proofs — and a reused orphan set adds up to
 * `MAX_REUSED_PROOFS`. A set split finer is refused before any DLEQ runs: splitting 64 sats into
 * 64 one-sat proofs would otherwise buy 64 curve checks for the price of 64 sats.
 */
export function maxProofsFor(sats: number): number {
  const bits = sats > 0 ? sats.toString(2).length : 0;
  return Math.min(MAX_PROOFS_PER_SET, bits + MAX_REUSED_PROOFS);
}

function isProofShape(x: unknown): x is CashuProof {
  if (typeof x !== 'object' || x === null) return false;
  const p = x as Record<string, unknown>;
  if (typeof p['id'] !== 'string' || typeof p['secret'] !== 'string' || typeof p['C'] !== 'string')
    return false;
  if (!Number.isSafeInteger(p['amount']) || (p['amount'] as number) <= 0) return false;
  const d = p['dleq'];
  if (d !== undefined) {
    if (typeof d !== 'object' || d === null) return false;
    const q = d as Record<string, unknown>;
    if (typeof q['s'] !== 'string' || typeof q['e'] !== 'string') return false;
    if (q['r'] !== undefined && typeof q['r'] !== 'string') return false;
  }
  return p['witness'] === undefined || typeof p['witness'] === 'string';
}

function isSetShape(x: unknown): x is LockedProofSet {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as Record<string, unknown>;
  return (
    typeof s['mint'] === 'string' &&
    typeof s['lockedTo'] === 'string' &&
    s['unit'] === 'sat' &&
    Array.isArray(s['proofs']) &&
    s['proofs'].length <= MAX_PROOFS_PER_SET &&
    s['proofs'].every(isProofShape) &&
    new Set(s['proofs'].map((p) => p.id)).size <= MAX_KEYSETS_PER_SET
  );
}

/** Structural guard — `verify` never throws, never reads a field it has not checked. */
export function isPayMessageV5(x: unknown): x is PayMessage {
  if (typeof x !== 'object' || x === null) return false;
  const m = x as Record<string, unknown>;
  const r = m['range'];
  if (typeof r !== 'object' || r === null) return false;
  const rr = r as Record<string, unknown>;
  const from = rr['fromBlock'];
  const to = rr['toBlock'];
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return false;
  if ((from as number) < 0 || (to as number) < (from as number) || (to as number) > MAX_BLOCK)
    return false;
  if (typeof rr['core'] !== 'string' || !CORE_RE.test(rr['core'])) return false;
  if (!isValidCarry(m['carryIn'])) return false;
  return isSetShape(m['seederProofs']) && isSetShape(m['creatorProofs']);
}

function isPolicyShape(p: unknown): p is PricePolicy {
  if (typeof p !== 'object' || p === null) return false;
  const q = p as Record<string, unknown>;
  return (
    Number.isSafeInteger(q['satsPerBlock']) &&
    (q['satsPerBlock'] as number) >= 0 &&
    isValidSplit(q['split']) &&
    Array.isArray(q['mints']) &&
    typeof q['creatorP2pk'] === 'string' &&
    COMPRESSED.test(q['creatorP2pk'].toLowerCase())
  );
}

function sum(proofs: readonly CashuProof[]): number {
  let n = 0;
  for (const p of proofs) n += p.amount;
  return n;
}

function blocksIn(r: BlockRange): number {
  return r.toBlock - r.fromBlock + 1;
}

// ---------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------

interface CoreState {
  readonly sent: RangeSet;
  readonly paid: RangeSet;
  window: number;
  carry: number;
}

interface PeerState {
  readonly peer: NostrPubkey;
  banned: boolean;
  lastActivity: UnixSeconds;
  readonly cores: Map<CoreKeyHex, CoreState>;
}

interface Pending {
  peer: NostrPubkey;
  readonly msg: PayMessage;
  stage: 'redeem' | 'nutzap';
  /** The creator set was checked at the mint already (F11: only before its FIRST nutzap). */
  creatorChecked?: boolean;
  /** A redeem was sent to the mint before (F31; see `PendingPay.redeemTried`). */
  redeemTried?: boolean;
}

type Decision =
  | { readonly kind: 'result'; readonly result: VerifyResult }
  | { readonly kind: 'need-keysets'; readonly keys: readonly (readonly [MintUrl, string])[] }
  | {
      readonly kind: 'need-dleq';
      readonly checks: readonly { readonly key: string; readonly check: DleqCheck }[];
    };

/** Which proof a DLEQ answer belongs to (a secret is unique within an accepted PAY). */
function dleqKey(mint: MintUrl, p: CashuProof): string {
  return `${mint}|${p.id}|${String(p.amount)}|${p.C}|${p.secret}`;
}

export class RealPaymentEngine implements PaymentEngine, UnpaidLedger {
  readonly config: PaymentEngineConfig;
  private readonly now: () => UnixSeconds;
  private readonly seen: SeenSecrets;
  private readonly peers = new Map<NostrPubkey, PeerState>();
  private readonly banMap = new Map<NostrPubkey, BanEntry>();
  private readonly pending: Pending[] = [];
  private readonly verifyChains = new Map<NostrPubkey, Promise<unknown>>();
  /**
   * Per account, how many times a new `pay/1` channel was bound to it (`rebind`). A PAY carries the
   * epoch it was queued under; one from a channel that has since been replaced is refused, never
   * committed — the new channel restarted the carry at 0, and a late commit from the old one would
   * move it under the new channel's feet (found by the real-mint lane's network-drop test).
   */
  private readonly epochs = new Map<NostrPubkey, number>();
  private readonly windowListeners = new Set<(w: PeerWindow) => void>();
  private readonly doubleSpendListeners = new Set<
    (peer: NostrPubkey, d: { readonly mint: MintUrl; readonly amount: Sats }) => void
  >();
  private flushing: Promise<{ swapped: Sats; nutzapped: Sats; failed: number }> | null = null;

  // viewer side
  private readonly viewerCarry = new Map<string, number>();
  private readonly spentPerPeer = new Map<NostrPubkey, number>();
  /** Seeder sets made for a PAY that never went out, by `seeder|p2pk|mint`: reused first. */
  private readonly orphans = new Map<string, CashuProof[]>();

  constructor(private readonly deps: PaymentEngineDeps) {
    const c = deps.config;
    if (!Number.isSafeInteger(c.windowBlocks) || c.windowBlocks < 1)
      throw new RangeError('PaymentEngine: windowBlocks must be a positive integer');
    if (!COMPRESSED.test(c.ownP2pk.toLowerCase()))
      throw new RangeError('PaymentEngine: ownP2pk must be a 33-byte compressed key (hex)');
    this.config = { ...c, acceptedMints: [...c.acceptedMints] };
    this.now = deps.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds);
    this.seen = deps.seen ?? new SeenSecrets();
  }

  // ===================================================================== viewer side

  async pay(
    range: BlockRange,
    seeder: {
      readonly pubkey: NostrPubkey;
      readonly p2pk: CashuP2pkPubkey;
      readonly mint: MintUrl;
    },
    policy: PricePolicy,
    opts?: { readonly carryIn?: number },
  ): Promise<PayMessage> {
    const wallet = this.deps.wallet;
    if (wallet === undefined) throw new Error('unsupported: this engine has no wallet to pay with');
    if (
      typeof range.core !== 'string' ||
      !CORE_RE.test(range.core) ||
      !Number.isSafeInteger(range.fromBlock) ||
      !Number.isSafeInteger(range.toBlock) ||
      range.fromBlock < 0 ||
      range.toBlock < range.fromBlock
    )
      throw new RangeError('pay: bad range');
    if (!isPolicyShape(policy)) throw new RangeError('pay: bad policy');
    if (!policy.mints.includes(seeder.mint))
      throw new RangeError('pay: the video does not accept this mint');
    if (!COMPRESSED.test(seeder.p2pk.toLowerCase()))
      throw new RangeError('pay: bad seeder P2PK key');

    const carryKey = `${seeder.pubkey}|${range.core}`;
    const carryIn = opts?.carryIn ?? this.viewerCarry.get(carryKey) ?? 0;
    const amount = blocksIn(range) * policy.satsPerBlock;
    if (amount > MAX_PAY_SATS) throw new RangeError('pay: amount too large');
    const split = splitPay(amount, policy.split, carryIn);
    const memo = `pay/1 ${String(blocksIn(range))} blocks`;

    const orphanKey = `${seeder.pubkey}|${seeder.p2pk}|${seeder.mint}`;
    const seederProofs = await this.seederShare(wallet, orphanKey, split.seederSats, seeder, memo);
    let creatorProofs: CashuProof[] = [];
    if (split.creatorSats > 0) {
      try {
        const set = await wallet.send(split.creatorSats as Sats, {
          p2pk: policy.creatorP2pk,
          mint: seeder.mint,
          tags: [[PAY1_TAG, seeder.p2pk]],
          memo,
        });
        creatorProofs = [...set.proofs];
      } catch (e) {
        // The seeder set exists and is locked to the seeder: keep it for the next PAY.
        if (seederProofs.length > 0)
          this.orphans.set(orphanKey, [...(this.orphans.get(orphanKey) ?? []), ...seederProofs]);
        throw e;
      }
    }
    this.viewerCarry.set(carryKey, split.carryOut);
    const paid = sum(seederProofs) + sum(creatorProofs);
    this.spentPerPeer.set(seeder.pubkey, (this.spentPerPeer.get(seeder.pubkey) ?? 0) + paid);
    return {
      range: { core: range.core, fromBlock: range.fromBlock, toBlock: range.toBlock },
      carryIn,
      seederProofs: { mint: seeder.mint, unit: 'sat', lockedTo: seeder.p2pk, proofs: seederProofs },
      creatorProofs: {
        mint: seeder.mint,
        unit: 'sat',
        lockedTo: policy.creatorP2pk,
        proofs: creatorProofs,
      },
    };
  }

  /** The seeder share: orphaned proofs first (exact subset-sum not needed — use whole orphans ≤ share). */
  private async seederShare(
    wallet: Pick<Wallet, 'send'>,
    orphanKey: string,
    share: number,
    seeder: { readonly p2pk: CashuP2pkPubkey; readonly mint: MintUrl },
    memo: string,
  ): Promise<CashuProof[]> {
    if (share === 0) return [];
    const orphans = this.orphans.get(orphanKey) ?? [];
    const use: CashuProof[] = [];
    const keep: CashuProof[] = [];
    let covered = 0;
    for (const p of [...orphans].sort((a, b) => b.amount - a.amount)) {
      if (use.length < MAX_REUSED_PROOFS && covered + p.amount <= share) {
        use.push(p);
        covered += p.amount;
      } else keep.push(p);
    }
    if (covered < share) {
      const set = await wallet.send((share - covered) as Sats, {
        p2pk: seeder.p2pk,
        mint: seeder.mint,
        memo,
      });
      use.push(...set.proofs);
    }
    if (keep.length > 0) this.orphans.set(orphanKey, keep);
    else this.orphans.delete(orphanKey);
    return use;
  }

  spent(): { readonly total: Sats; readonly perPeer: ReadonlyMap<NostrPubkey, Sats> } {
    let total = 0;
    const perPeer = new Map<NostrPubkey, Sats>();
    for (const [k, v] of this.spentPerPeer) {
      total += v;
      perPeer.set(k, v as Sats);
    }
    return { total: total as Sats, perPeer };
  }

  // ===================================================================== seeder side

  verify(peer: NostrPubkey, msg: PayMessage, policy: PricePolicy): Promise<VerifyResult> {
    const epoch = this.epochs.get(peer) ?? 0;
    const prev = this.verifyChains.get(peer) ?? Promise.resolve();
    const run = prev.then(
      () => this.verifyOne(peer, msg, policy, epoch),
      () => this.verifyOne(peer, msg, policy, epoch),
    );
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.verifyChains.set(peer, settled);
    void settled.then(() => {
      if (this.verifyChains.get(peer) === settled) this.verifyChains.delete(peer);
    });
    return run;
  }

  private async verifyOne(
    peer: NostrPubkey,
    msg: PayMessage,
    policy: PricePolicy,
    epoch: number,
  ): Promise<VerifyResult> {
    try {
      const first = this.decide(peer, msg, policy, null, epoch);
      if (first.kind === 'result') return first.result;
      // Without keysets the decision can only ask for them.
      if (first.kind !== 'need-keysets') return reject('malformed');
      const keysets = new Map<string, MintKeyset>();
      const lookup = this.deps.keyset;
      if (lookup !== undefined) {
        for (const [mint, id] of first.keys) {
          let ks: MintKeyset | undefined;
          try {
            ks = await lookup(mint, id);
          } catch {
            ks = undefined;
          }
          if (ks !== undefined) keysets.set(`${mint}|${id}`, ks);
        }
      }
      let second = this.decide(peer, msg, policy, keysets, epoch, null);
      if (second.kind === 'need-dleq') {
        // Off the event loop (F5). Every other check runs again on the answers: state may move.
        const answers = new Map<string, boolean>();
        const verifier = this.deps.dleq;
        if (verifier !== undefined) {
          try {
            const r = await verifier(second.checks.map((c) => c.check));
            if (Array.isArray(r) && r.length === second.checks.length)
              second.checks.forEach((c, i) => answers.set(c.key, r[i] === true));
          } catch {
            // falls back to the synchronous check for every proof (an empty answer map)
          }
        }
        second = this.decide(peer, msg, policy, keysets, epoch, answers);
      }
      return second.kind === 'result' ? second.result : reject('bad-dleq', 'keyset unavailable');
    } catch {
      return reject('malformed');
    }
  }

  /**
   * The whole decision, synchronous. With `keysets === null` it stops before the DLEQ stage and
   * asks for the keysets it needs; with keysets it runs every check again (state may have moved
   * while they loaded). With an off-thread verifier (`deps.dleq`) and `dleq === null` it stops
   * again and asks for the DLEQ answers; with them (a missing answer = the synchronous check) it
   * runs everything once more and, on acceptance, commits in the same tick.
   */
  private decide(
    peer: NostrPubkey,
    msg: PayMessage,
    policy: PricePolicy,
    keysets: ReadonlyMap<string, MintKeyset> | null,
    epoch: number,
    dleq: ReadonlyMap<string, boolean> | null = null,
  ): Decision {
    const out = (reason: RejectReason, detail?: string): Decision => ({
      kind: 'result',
      result: reject(reason, detail),
    });
    if (this.banMap.has(peer)) return out('peer-banned');
    if ((this.epochs.get(peer) ?? 0) !== epoch)
      return out('malformed', 'sent on a channel that has since been replaced');
    if (!isPayMessageV5(msg)) return out('malformed');
    if (!isPolicyShape(policy)) return out('malformed', 'policy');
    const { range, carryIn, seederProofs, creatorProofs } = msg;
    const st = this.peers.get(peer);
    const cs = st?.cores.get(range.core);
    const carry = cs?.carry ?? 0;
    if (carryIn !== carry) return out('malformed', 'carryIn does not match');

    const blocks = blocksIn(range);
    const amount = blocks * policy.satsPerBlock;
    if (amount > MAX_PAY_SATS) return out('malformed', 'amount too large');
    const owed = splitPay(amount, policy.split, carryIn);
    if (
      seederProofs.proofs.length > maxProofsFor(owed.seederSats) ||
      creatorProofs.proofs.length > maxProofsFor(owed.creatorSats)
    )
      return out('malformed', 'more proofs than the amount needs');
    if (seederProofs.proofs.length === 0 && owed.seederSats > 0) return out('missing-seeder-set');
    if (creatorProofs.proofs.length === 0 && owed.creatorSats > 0)
      return out('missing-creator-set');

    for (const set of [seederProofs, creatorProofs]) {
      if (!this.config.acceptedMints.includes(set.mint) || !policy.mints.includes(set.mint))
        return out('mint-not-accepted');
    }
    const own = this.config.ownP2pk.toLowerCase();
    const creator = policy.creatorP2pk.toLowerCase();
    if (seederProofs.lockedTo.toLowerCase() !== own) return out('wrong-p2pk-target', 'seeder set');
    if (creatorProofs.lockedTo.toLowerCase() !== creator)
      return out('wrong-p2pk-target', 'creator set');

    const gotSeeder = sum(seederProofs.proofs);
    const gotCreator = sum(creatorProofs.proofs);
    if (gotSeeder > owed.seederSats || gotCreator > owed.creatorSats) return out('overpay');
    if (gotSeeder !== owed.seederSats || gotCreator !== owed.creatorSats)
      return out('wrong-amount');

    if (st === undefined || !cs?.sent.hasAll(range.fromBlock, range.toBlock))
      return out('range-not-uploaded');
    if (cs.paid.hasAny(range.fromBlock, range.toBlock)) return out('range-already-paid');

    const all = [...seederProofs.proofs, ...creatorProofs.proofs];
    for (const p of all) if (p.dleq === undefined) return out('missing-dleq');

    // DLEQ against the cached keyset of the set's mint (T7).
    const needed: [MintUrl, string][] = [];
    for (const set of [seederProofs, creatorProofs]) {
      for (const p of set.proofs) {
        if (!KEYSET_ID.test(p.id)) return out('bad-dleq', 'keyset id');
        if (!needed.some(([m, id]) => m === set.mint && id === p.id)) needed.push([set.mint, p.id]);
      }
    }
    if (keysets === null) return { kind: 'need-keysets', keys: needed };
    const checks: { key: string; check: DleqCheck }[] = [];
    for (const set of [seederProofs, creatorProofs]) {
      for (const p of set.proofs) {
        const ks = keysets.get(`${set.mint}|${p.id}`);
        // An unknown keyset may be the seeder's stale cache (a rotation): refuse, never ban.
        if (ks?.unit !== 'sat' || ks.id !== p.id) return out('bad-dleq', 'unknown keyset');
        const key = ks.keys[p.amount];
        checks.push({
          key: dleqKey(set.mint, p),
          check: {
            proof: p,
            keyset: { ...ks, keys: key === undefined ? {} : { [p.amount]: key } },
          },
        });
      }
    }
    if (this.deps.dleq !== undefined && dleq === null) return { kind: 'need-dleq', checks };
    for (const set of [seederProofs, creatorProofs]) {
      for (const p of set.proofs) {
        const ks = keysets.get(`${set.mint}|${p.id}`);
        if (ks === undefined) return out('bad-dleq', 'unknown keyset');
        if (!(dleq?.get(dleqKey(set.mint, p)) ?? dleqOk(p, ks))) {
          // A DLEQ that fails against a KNOWN keyset is a forgery, never an honest mistake — and
          // every attempt costs this seeder real CPU. Ban (T7, T11).
          if (!this.banMap.has(peer)) this.ban(peer, 'forged-proof');
          return out('bad-dleq');
        }
      }
    }

    // The lock inside each secret (the envelope is untrusted input).
    for (const p of seederProofs.proofs) {
      const v = checkPayLock(p.secret, own);
      if (!v.ok) return out('wrong-p2pk-target', `seeder secret: ${v.reason}`);
    }
    for (const p of creatorProofs.proofs) {
      const v = checkPayLock(p.secret, creator, { binding: own });
      if (!v.ok) return out('wrong-p2pk-target', `creator secret: ${v.reason}`);
    }

    // Local double-spend: a secret this seeder already accepted, or one repeated in this PAY.
    const secrets = all.map((p) => p.secret);
    if (new Set(secrets).size !== secrets.length || secrets.some((s) => this.seen.has(s))) {
      this.doubleSpend(peer, seederProofs.mint, amount);
      return out('double-spend');
    }

    // Accept — every state change in this tick.
    this.seen.add(secrets);
    cs.paid.add(range.fromBlock, range.toBlock);
    cs.carry = owed.carryOut;
    st.lastActivity = this.now();
    this.pending.push({ peer, msg, stage: 'redeem' });
    this.persist();
    return { kind: 'result', result: { ok: true, credited: amount as Sats, blocks } };
  }

  recordUpload(
    peer: NostrPubkey,
    blocks: BlockRange,
    policy: Pick<PricePolicy, 'satsPerBlock' | 'minPaySats'>,
  ): PeerWindow {
    if (
      typeof blocks.core !== 'string' ||
      !CORE_RE.test(blocks.core) ||
      !Number.isSafeInteger(blocks.fromBlock) ||
      !Number.isSafeInteger(blocks.toBlock) ||
      blocks.fromBlock < 0 ||
      blocks.toBlock < blocks.fromBlock
    )
      throw new RangeError('recordUpload: bad block range');
    const st = this.peerFor(peer);
    const cs = this.coreFor(st, blocks.core);
    cs.window = effectiveWindowBlocks(this.config.windowBlocks, policy);
    cs.sent.add(blocks.fromBlock, blocks.toBlock);
    st.lastActivity = this.now();
    return this.enforceWindow(st);
  }

  rebind(from: NostrPubkey, to: NostrPubkey): PeerWindow {
    if (from === to) return this.snapshot(this.peerFor(to));
    this.epochs.set(to, (this.epochs.get(to) ?? 0) + 1);
    const src = this.peers.get(from);
    const srcBan = this.banMap.get(from);
    const dst = this.peerFor(to);
    // A new pay/1 channel for `to`: its carries restart from `from`'s (0 where `from` has none).
    for (const cs of dst.cores.values()) cs.carry = 0;
    if (src === undefined && srcBan === undefined) return this.snapshot(dst);
    if (src !== undefined) {
      for (const [core, s] of src.cores) {
        const d = this.coreFor(dst, core);
        d.sent.merge(s.sent);
        d.paid.merge(s.paid);
        d.window = Math.max(d.window, s.window);
        d.carry = s.carry;
      }
      this.peers.delete(from);
    }
    dst.lastActivity = this.now();
    if (srcBan !== undefined) {
      this.banMap.delete(from);
      if (!this.banMap.has(to)) this.ban(to, srcBan.reason, srcBan.noiseKey);
    }
    let moved = false;
    for (const p of this.pending)
      if (p.peer === from) {
        p.peer = to;
        moved = true;
      }
    if (moved) this.persist();
    return this.enforceWindow(dst);
  }

  private enforceWindow(st: PeerState): PeerWindow {
    const snap = this.snapshot(st);
    if (snap.outstanding > snap.windowBlocks && !st.banned) {
      this.ban(st.peer, 'window-exceeded');
      const after = this.snapshot(st);
      for (const cb of this.windowListeners)
        safeCall(() => {
          cb(after);
        });
      return after;
    }
    return snap;
  }

  window(peer: NostrPubkey): PeerWindow | undefined {
    const st = this.peers.get(peer);
    return st === undefined ? undefined : this.snapshot(st);
  }

  /** `UnpaidLedger` (pay/1 `ACK.outstanding`): what `peer` still owes on `core`. */
  outstandingOn(peer: NostrPubkey, core: CoreKeyHex): number {
    const cs = this.peers.get(peer)?.cores.get(core);
    // `paid` ⊆ `sent`: a PAY is accepted only for blocks all sent (`range-not-uploaded`).
    return cs === undefined ? 0 : cs.sent.size - cs.paid.size;
  }

  /** `UnpaidLedger` (pay/1 `OWED`): per core, oldest first, the blocks `peer` has not paid. */
  unpaid(peer: NostrPubkey, limits: OwedLimits = OWED_LIMITS): readonly OwedCore[] {
    const st = this.peers.get(peer);
    if (st === undefined) return [];
    // Lazily, core by core: `boundOwed` stops at the caps, so the cores past them are never walked.
    const byCore = st.cores;
    function* cores(): Generator<readonly [CoreKeyHex, readonly OwedRange[]]> {
      for (const [core, cs] of byCore) yield [core, cs.sent.difference(cs.paid)];
    }
    return boundOwed(cores(), limits);
  }

  windows(): readonly PeerWindow[] {
    return [...this.peers.values()].map((st) => this.snapshot(st));
  }

  onWindowExceeded(cb: (w: PeerWindow) => void): () => void {
    this.windowListeners.add(cb);
    return () => this.windowListeners.delete(cb);
  }

  onDoubleSpend(
    cb: (peer: NostrPubkey, detail: { readonly mint: MintUrl; readonly amount: Sats }) => void,
  ): () => void {
    this.doubleSpendListeners.add(cb);
    return () => this.doubleSpendListeners.delete(cb);
  }

  /**
   * Redeem the accepted seeder sets and publish the creator sets. One flush at a time; a
   * concurrent call waits for (and returns) the running one. A PAY whose seeder set the mint
   * reports spent is a double-spend: the peer is banned and its creator set is not published.
   * A mint or relay failure keeps the item for the next flush.
   */
  flush(): Promise<{ readonly swapped: Sats; readonly nutzapped: Sats; readonly failed: number }> {
    if (this.flushing !== null) return this.flushing;
    const run = this.flushOnce().finally(() => {
      this.flushing = null;
    });
    this.flushing = run;
    return run;
  }

  private async flushOnce(): Promise<{ swapped: Sats; nutzapped: Sats; failed: number }> {
    let swapped = 0;
    let nutzapped = 0;
    let failed = 0;
    const batch = this.pending.splice(0);
    const retry: Pending[] = [];

    // Redeem stage: ONE swap per mint for every accepted seeder set (a real mint charges an input
    // fee per swap — at 100 ppk a 1-sat set alone can never be redeemed; together they can).
    const outcome = await this.redeemAll(batch, retry);
    const forward: Pending[] = [];
    for (const item of batch) {
      const { seederProofs, creatorProofs } = item.msg;
      const o = outcome.get(item);
      if (o === 'retry') {
        retry.push(item);
        continue;
      }
      if (o === 'double-spend') {
        failed++;
        this.doubleSpend(
          item.peer,
          seederProofs.mint,
          sum(seederProofs.proofs) + sum(creatorProofs.proofs),
        );
        continue;
      }
      if (o === 'redeemed') swapped += sum(seederProofs.proofs);
      item.stage = 'nutzap';
      if (creatorProofs.proofs.length > 0) forward.push(item);
    }
    const fwd = await this.forwardAll(forward, retry);
    nutzapped += fwd.nutzapped;
    failed += fwd.failed;
    this.pending.unshift(...retry);
    this.persist();
    return { swapped: swapped as Sats, nutzapped: nutzapped as Sats, failed };
  }

  /**
   * Redeem every seeder set of `batch` still at the redeem stage: grouped by mint, one `redeem`
   * per group. Returns, per item, `redeemed`, `retry` (mint outage, dust below the fee, no
   * redeemer) or `double-spend`. Items with nothing to redeem get no entry.
   */
  private async redeemAll(
    batch: readonly Pending[],
    retry: readonly Pending[],
  ): Promise<Map<Pending, 'redeemed' | 'retry' | 'double-spend'>> {
    const out = new Map<Pending, 'redeemed' | 'retry' | 'double-spend'>();
    const todo = batch.filter((i) => i.stage === 'redeem' && i.msg.seederProofs.proofs.length > 0);
    if (todo.length === 0) return out;
    if (this.deps.redeem === undefined) {
      for (const i of todo) out.set(i, 'retry');
      return out;
    }
    // Record every attempt before making it: a crash mid-swap must restore as "tried" (F31).
    const retried = new Set(todo.filter((i) => i.redeemTried === true));
    if (retried.size < todo.length) {
      for (const i of todo) i.redeemTried = true;
      this.persist([...this.pending, ...batch, ...retry]);
    }
    const byMint = new Map<MintUrl, Pending[]>();
    for (const i of todo) {
      const m = i.msg.seederProofs.mint;
      byMint.set(m, [...(byMint.get(m) ?? []), i]);
    }
    for (const [mint, items] of byMint) await this.redeemGroup(mint, items, retried, out);
    return out;
  }

  private async redeemGroup(
    mint: MintUrl,
    items: readonly Pending[],
    retried: ReadonlySet<Pending>,
    out: Map<Pending, 'redeemed' | 'retry' | 'double-spend'>,
  ): Promise<void> {
    const redeem = this.deps.redeem;
    if (redeem === undefined) return;
    const proofs = items.flatMap((i) => i.msg.seederProofs.proofs);
    try {
      await redeem({ mint, proofs });
      for (const i of items) out.set(i, 'redeemed');
      return;
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code !== 'spent') {
        for (const i of items) out.set(i, 'retry');
        return;
      }
    }
    // "Spent": which PAY? Spent by a double-spender — or by us, in an earlier attempt whose
    // response was lost (F31)? Only a RETRY can be the latter: a replay of a set we redeemed long
    // ago (before a restart that lost the seen set) carries our witness too.
    const verdict = async (i: Pending): Promise<'redeemed' | 'double-spend'> =>
      retried.has(i) && (await this.ownSpend(i.msg.seederProofs)) ? 'redeemed' : 'double-spend';
    if (items.length === 1) {
      const [only] = items;
      if (only !== undefined) out.set(only, await verdict(only));
      return;
    }
    const check = this.deps.checkSpent;
    if (check === undefined) {
      // No NUT-07 to attribute it: redeem one PAY at a time (the old, per-PAY behaviour).
      for (const i of items) await this.redeemGroup(mint, [i], retried, out);
      return;
    }
    let flags: readonly boolean[];
    try {
      flags = await check({ mint, proofs });
    } catch {
      for (const i of items) out.set(i, 'retry');
      return;
    }
    const clean: Pending[] = [];
    let k = 0;
    for (const i of items) {
      const n = i.msg.seederProofs.proofs.length;
      const spent = flags.slice(k, k + n).some(Boolean);
      k += n;
      if (spent) out.set(i, await verdict(i));
      else clean.push(i);
    }
    // The rest were not spent: redeem them together now (no recursion into another "spent"
    // split unless the mint changes its mind — then they come back next flush).
    if (clean.length > 0) {
      try {
        await redeem({ mint, proofs: clean.flatMap((i) => i.msg.seederProofs.proofs) });
        for (const i of clean) out.set(i, 'redeemed');
      } catch {
        for (const i of clean) out.set(i, 'retry');
      }
    }
  }

  /**
   * Forward the creator sets of `items` (all at the nutzap stage): grouped by creator key × mint ×
   * core, one `nutzap` per group (F34). Before a set's FIRST nutzap its proofs are checked at the
   * mint (F11): a spent one is a double-spend of the creator's share — ban, not forwarded. Only
   * once: a retry after a nutzap that may have landed (and been redeemed by the creator) must not
   * read the creator's own spend as fraud.
   */
  private async forwardAll(
    items: readonly Pending[],
    retry: Pending[],
  ): Promise<{ nutzapped: number; failed: number }> {
    let nutzapped = 0;
    let failed = 0;
    const nutzap = this.deps.nutzap;
    if (nutzap === undefined) {
      retry.push(...items);
      return { nutzapped, failed };
    }
    const groups = new Map<string, Pending[]>();
    for (const i of items) {
      const c = i.msg.creatorProofs;
      const k = `${c.lockedTo.toLowerCase()}|${c.mint}|${i.msg.range.core}`;
      groups.set(k, [...(groups.get(k) ?? []), i]);
    }
    for (const group of groups.values()) {
      let send = group;
      const unchecked = group.filter((i) => i.creatorChecked !== true);
      const check = this.deps.checkSpent;
      if (check !== undefined && unchecked.length > 0) {
        for (const i of unchecked) i.creatorChecked = true;
        const first = unchecked[0];
        let flags: readonly boolean[] | null = null;
        if (first !== undefined)
          try {
            flags = await check({
              mint: first.msg.creatorProofs.mint,
              proofs: unchecked.flatMap((i) => i.msg.creatorProofs.proofs),
            });
          } catch {
            flags = null; // a failed check does not block the nutzap
          }
        if (flags !== null) {
          const spent = new Set<Pending>();
          let k = 0;
          for (const i of unchecked) {
            const n = i.msg.creatorProofs.proofs.length;
            if (flags.slice(k, k + n).some(Boolean)) spent.add(i);
            k += n;
          }
          for (const i of spent) {
            failed++;
            this.doubleSpend(i.peer, i.msg.creatorProofs.mint, sum(i.msg.creatorProofs.proofs));
          }
          send = group.filter((i) => !spent.has(i));
        }
      }
      const head = send[0];
      if (head === undefined) continue;
      const proofs = send.flatMap((i) => i.msg.creatorProofs.proofs);
      try {
        await nutzap(
          {
            mint: head.msg.creatorProofs.mint,
            unit: 'sat',
            lockedTo: head.msg.creatorProofs.lockedTo,
            proofs,
          },
          {
            core: head.msg.range.core,
            peers: [...new Set(send.map((i) => i.peer))],
            pays: send.length,
          },
        );
        nutzapped += sum(proofs);
      } catch {
        retry.push(...send);
      }
    }
    return { nutzapped, failed };
  }

  /** F31: whether a "spent" seeder set was spent by this seeder itself (never throws). */
  private async ownSpend(set: LockedProofSet): Promise<boolean> {
    const check = this.deps.spentByUs;
    if (check === undefined) return false;
    try {
      return await check({ mint: set.mint, proofs: set.proofs });
    } catch {
      return false;
    }
  }

  /**
   * F12: hand the queue to the host's persistence hook (a failing hook never stops the engine).
   * During a flush the queue is split between `pending` and the batch in hand, so the caller may
   * pass the full list.
   */
  private persist(queue: readonly Pending[] = this.pending): void {
    const hook = this.deps.persistPending;
    if (hook === undefined) return;
    const items: PendingPay[] = queue.map((p) => ({
      peer: p.peer,
      msg: p.msg,
      stage: p.stage,
      ...(p.creatorChecked === true ? { creatorChecked: true } : {}),
      ...(p.redeemTried === true ? { redeemTried: true } : {}),
    }));
    safeCall(() => {
      hook(items);
    });
  }

  /**
   * F12: reload accepted-but-unflushed PAYs saved by `persistPending` (at start, before any PAY
   * arrives). Their secrets join the seen set, so a replay of them is still a double-spend.
   */
  restorePending(items: readonly PendingPay[]): void {
    for (const it of items) {
      // Read back from the host's storage: checked like any untrusted input.
      const stage: unknown = it.stage;
      if (!isPayMessageV5(it.msg) || (stage !== 'redeem' && stage !== 'nutzap')) continue;
      this.seen.restore(
        [...it.msg.seederProofs.proofs, ...it.msg.creatorProofs.proofs].map((p) => p.secret),
      );
      this.pending.push({
        peer: it.peer,
        msg: it.msg,
        stage,
        ...(it.creatorChecked === true ? { creatorChecked: true } : {}),
        ...(it.redeemTried === true ? { redeemTried: true } : {}),
      });
    }
  }

  /** Accepted PAYs whose redemption or nutzap has not completed yet. */
  pendingCount(): number {
    return this.pending.length;
  }

  ban(peer: NostrPubkey, reason: string, noiseKey?: Uint8Array): void {
    const entry: BanEntry =
      noiseKey === undefined
        ? { pubkey: peer, reason, at: this.now() }
        : { pubkey: peer, noiseKey, reason, at: this.now() };
    this.banMap.set(peer, entry);
    const st = this.peers.get(peer);
    if (st !== undefined) st.banned = true;
  }

  unban(peer: NostrPubkey): void {
    this.banMap.delete(peer);
    const st = this.peers.get(peer);
    if (st !== undefined) st.banned = false;
  }

  isBanned(peer: NostrPubkey): boolean {
    return this.banMap.has(peer);
  }

  bans(): readonly BanEntry[] {
    return [...this.banMap.values()];
  }

  // ------------------------------------------------------------------ internals

  private doubleSpend(peer: NostrPubkey, mint: MintUrl, amount: number): void {
    if (!this.banMap.has(peer)) this.ban(peer, 'double-spend');
    for (const cb of this.doubleSpendListeners)
      safeCall(() => {
        cb(peer, { mint, amount: amount as Sats });
      });
  }

  private peerFor(peer: NostrPubkey): PeerState {
    let st = this.peers.get(peer);
    if (st === undefined) {
      st = { peer, banned: this.banMap.has(peer), lastActivity: this.now(), cores: new Map() };
      this.peers.set(peer, st);
    }
    return st;
  }

  private coreFor(st: PeerState, core: CoreKeyHex): CoreState {
    let cs = st.cores.get(core);
    if (cs === undefined) {
      cs = {
        sent: new RangeSet(),
        paid: new RangeSet(),
        window: this.config.windowBlocks,
        carry: 0,
      };
      st.cores.set(core, cs);
    }
    return cs;
  }

  private snapshot(st: PeerState): PeerWindow {
    let uploaded = 0;
    let paid = 0;
    let windowBlocks = this.config.windowBlocks;
    for (const cs of st.cores.values()) {
      uploaded += cs.sent.size;
      paid += cs.paid.size;
      windowBlocks = Math.max(windowBlocks, cs.window);
    }
    return {
      peer: st.peer,
      uploaded,
      paid,
      outstanding: uploaded - paid,
      windowBlocks,
      banned: st.banned,
      lastActivity: st.lastActivity,
    };
  }
}

function reject(reason: RejectReason, detail?: string): VerifyResult {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

/**
 * NUT-12 proof-side DLEQ (needs `r`) against `ks`; any parse or curve error is a failure. The one
 * DLEQ rule: the engine runs it inline, an off-thread `PaymentEngineDeps.dleq` runs this same
 * function. Never throws.
 */
export function proofDleqOk(p: CashuProof, ks: MintKeyset): boolean {
  return dleqOk(p, ks);
}

function dleqOk(p: CashuProof, ks: MintKeyset): boolean {
  const d = p.dleq;
  if (d?.r === undefined || !HEX.test(d.s) || !HEX.test(d.e) || !HEX.test(d.r)) return false;
  try {
    // cashu-ts 4.11 deprecates the sync `hasValidDleq` for the async `verifyMintSignatures` (the
    // same NUT-12 proof-side check; its `require: true` is this function's default) and v5 removes
    // it. This stays the sync call on purpose: the engine's inline check is a synchronous decision
    // step (`deps.dleq`, off-thread, is the async path), so moving to v5 means making that step
    // async, which is designed work and not a drop-in swap. The tests run the new API on the same
    // proofs.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
    return hasValidDleq(
      {
        id: p.id,
        amount: Amount.from(p.amount),
        secret: p.secret,
        C: p.C,
        dleq: { s: d.s, e: d.e, r: d.r },
      },
      { id: ks.id, keys: { ...ks.keys } },
    );
  } catch {
    return false;
  }
}

function safeCall(f: () => void): void {
  try {
    f();
  } catch {
    // a listener's failure is its own; the engine's state change already happened
  }
}
