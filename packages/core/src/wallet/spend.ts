/**
 * The wallet's spend operations — NUT-11 P2PK send, NUT-03 receive, NUT-05 melt, NUT-04 mint —
 * thin over `@cashu/cashu-ts` (SECURITY.md §locked; build-plan §3 "wallet surface = mint quote,
 * P2PK send, swap, melt"; contract `Wallet`).
 *
 * Rules this file keeps (each has a test):
 *
 *   - **One operation per mint at a time.** Proof selection and the swap run under a per-mint
 *     lock, so two concurrent sends can never select the same proof.
 *   - **State before result.** Every swap's transition (inputs spent, change / received proofs
 *     added) is committed to the `ProofStore` before the caller sees the result — a crash can lose
 *     a result the caller never saw, never proofs the wallet forgot it holds.
 *   - **Never trust the mint's output shape.** A P2PK send's outputs must add up to exactly the
 *     amount, carry a DLEQ that verifies against the keyset (with the blinding factor, so the
 *     recipient can verify it too — threat T7), and be locked the way `payment/lock.ts` requires
 *     (plain lock to the recipient, the requested binding tags, nothing else).
 *   - **An ambiguous failure is reconciled, not guessed.** If a swap fails after it may have
 *     reached the mint, the inputs' state is asked (NUT-07): unspent inputs stay in the wallet,
 *     spent ones are dropped and the loss is reported by count and amount.
 *   - **A lost response loses nothing (ADR 0014, security review F31).** Where the store keeps a
 *     journal and the mint supports NUT-09, a send, receive, mint or melt writes its outputs to
 *     the store BEFORE the request goes out; if the answer never arrives, the outputs the mint
 *     signed are restored (NUT-09) and committed as if it had. A retry of the same receive or mint
 *     reuses the journaled outputs, so a mint that did execute answers "already signed", never
 *     twice. A melt's journaled outputs are its NUT-08 change blanks (ADR 0014 amendment).
 *   - **Held inputs are nobody's.** While a journaled send or melt is unresolved, its inputs stay
 *     out of every new selection (and out of the balance, `wallet.ts`) until the mint says what
 *     became of them — they are neither spent twice nor forgotten.
 *   - **Nothing secret in an error.** Messages carry a code and amounts, never a proof.
 *
 * With a recovery phrase (NUT-13, ADR 0016; `MintConnections.seeding`):
 *
 *   - **Output types are explicit per operation**, never cashu-ts's `'auto'`: a send's change and
 *     the outputs of receive, mint, melt and reissue are deterministic (counters from the shared
 *     `DurableCounterSource`) at a mint that can restore them (NUT-09, a hex v1/v2 keyset);
 *     random elsewhere. A send's P2PK outputs stay `p2pk`: NUT-13 derives no NUT-10 secret.
 *   - **A restore counts as executed only when the mint shows it ran** (NUT-07: a swap's or a
 *     melt's inputs SPENT; a mint quote ISSUED). Signatures on our outputs without that are a
 *     COUNTER COLLISION — another wallet derived the same counters from this phrase — never our
 *     operation: the entry is dropped (its outputs are someone else's, so it can never run), the
 *     counters move past what the mint signed, and a live operation is retried ONCE with fresh
 *     counters. Committing them instead would drop inputs that are still unspent.
 *   - **Restore from a phrase** (`restoreFromSeed`, ADR 0016 §5): under the mint's lock, after its
 *     journal settles; every hex `sat` keyset, active or not, at most 32; batches of 100 until
 *     three in a row come back empty, at most 200 per keyset; each signature's keyset and amount
 *     checked, its DLEQ REQUIRED at a NUT-12 mint and checked against the key of the amount the
 *     mint CLAIMS (so an amount lie fails), and at a mint without NUT-12 the proofs are swapped
 *     into fresh outputs before they count; SPENT proofs dropped (NUT-07); what is already held
 *     (by secret) not added twice. Another device's phrase is only read: nothing is derived from
 *     it afterwards.
 *   - **Closing** refuses new operations and waits until every per-mint lock is idle, so the
 *     wallet (`wallet.ts` `close`) wipes the seed only when nothing derives from it.
 *   - **A deadline-bound send** (`SendBound`, a PAY build the worker waits a fixed time for; lane
 *     W8a) asks its caller at its turn — after every operation queued ahead of it at the mint — and
 *     is refused there with nothing spent; it is never run a second time after a counter
 *     collision, and the skip-ahead past one is capped at one batch (a NUT-12 mint's 200 would be
 *     200 more round trips). The caller retries it later, past the moved counters.
 *
 * No cryptography here: blinding, signatures, DLEQ, P2PK witnesses and NUT-13 derivation are
 * cashu-ts calls, and a witness is signed by the injected `WalletKey` (the signer's `signSecret`,
 * or a wallet key held in secure memory).
 */
import {
  Amount,
  getP2PKExpectedWitnessPubkeys,
  hasValidDleq,
  OutputData,
  schnorrVerifyMessage,
  StaleKeysetError,
  type HasKeysetKeys,
  type Keyset,
  type MeltPreview,
  type MeltQuoteBolt11Response,
  type MintQuoteBolt11Response,
  type OutputConfig,
  type OutputDataCreator,
  type OutputDataLike,
  type OutputType,
  type P2PKTag,
  type Proof,
  type SerializedBlindedSignature,
  type Wallet as CashuTsWallet,
} from '@cashu/cashu-ts';

import type {
  CashuP2pkPubkey,
  CashuProof,
  LockedProofSet,
  MeltQuote,
  MintQuote,
  MintUrl,
  Sats,
  UnixSeconds,
} from '../contracts/index.js';
import { checkPayLock, PAY1_TAG } from '../payment/lock.js';
import type {
  RecoverySeed,
  ReissuePlan,
  ReissueResult,
  RestoreOutcome,
  RestoreReport,
} from './recovery-api.js';
import {
  COUNTER_LIMIT,
  COUNTER_PROBE_SPAN,
  RecoverySeedError,
  sameSeed,
  seedBytes,
  seededWith,
  type CounterProbe,
  type DurableCounterSource,
  type UnpublishedRange,
} from './seed.js';
import {
  heldSecrets,
  proofTotal,
  type PendingOp,
  type PendingOutput,
  type ProofStore,
  type WalletTx,
} from './store.js';

// ---------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------

/** This device's recovery phrase, as the wallets derive from it (ADR 0016). */
export interface Seeding {
  /** The seed every cashu-ts wallet was built with (`bip39seed`, by reference). */
  readonly seed: RecoverySeed;
  /** The one counter source every cashu-ts wallet shares. */
  readonly counters: DurableCounterSource;
}

/** A loaded `@cashu/cashu-ts` wallet per mint (the host builds it with its HTTP / test transport). */
export interface MintConnections {
  wallet(mint: MintUrl): Promise<CashuTsWallet>;
  /**
   * Present when the wallets derive NUT-13 outputs (`CashuMintConnections` given `seed`). A
   * wrapper around connections MUST forward it: without it the wallet makes random outputs,
   * exposes no `seeded`, and `close` wipes nothing.
   */
  readonly seeding?: Seeding;
}

/** NUT-13: blinded messages per restore request (the spec's recommended batch). */
export const RESTORE_BATCH = 100;
/** NUT-13: a scan ends after this many empty batches in a row (a gap of 300). */
export const RESTORE_EMPTY_BATCHES = 3;
/** ADR 0016 §5: at most this many batches per keyset (a hostile mint signing everything). */
export const RESTORE_MAX_BATCHES = 200;
/**
 * ADR 0016 §5: at most this many keysets per mint per call; the rest are reported in
 * `RestoreDetail.resume` (fix round 7: they used to be dropped silently).
 */
export const RESTORE_MAX_KEYSETS = 32;
/** NUT-07 states asked per request. */
const CHECK_CHUNK = 100;

/**
 * A mint's restore report (the seam's `RestoreReport`) and, when a scan did not reach its end at
 * every keyset, where to continue (independent review 2026-09-27, finding 1: a scan the batch cap
 * ended used to read as complete). Outside the frozen seam, which has no field for it
 * (docs/contract-requests/N1-nut13-core.md item 7).
 */
export interface RestoreDetail extends RestoreReport {
  /**
   * Keyset id → the counter to continue from, for `CashuWallet.seeded.restoreFromSeed(…,
   * { resume })`, which scans each named keyset UPWARD from its counter (and only the named ones).
   * Present only when some keyset was not scanned to its end: the batch cap stopped it, a keyset
   * or batch could not be asked, or the keyset cap left it out (named at the counter it would have
   * started from — 0 for a first call). Absent: every restorable keyset was scanned to three empty
   * batches past what it found (and, for this device's own phrase, past its counters file's
   * high-water mark).
   *
   * On a startup restore's report (`CashuWallet.restoreUnpublished`) it names the LOW end of each
   * `[published, next)` range left unfinished, whatever part of it was scanned (that scan runs
   * newest first): a `restoreFromSeed` of THIS device's phrase from there covers the whole range
   * (fix round 7: it used to name where the downward scan stopped, and continuing upward from
   * there skipped what was left).
   */
  readonly resume?: Readonly<Record<string, number>>;
}

/** The NIP-60 wallet key: its public half, and a NUT-11 witness signer for the private half. */
export interface WalletKey {
  readonly pubkey: CashuP2pkPubkey;
  /** BIP-340 over SHA-256(secret) — `Signer.signSecret`, or cashu-ts `schnorrSignMessage`. */
  sign(secret: string): Promise<string>;
  /**
   * Lend the key, hex-encoded, to ONE cashu-ts call that needs it as a string (NUT-20 locked mint
   * quotes: cashu-ts signs the domain-separated quote message itself and exports no way to sign it
   * elsewhere). Only a key held in this process has it; a JS string cannot be wiped, so it is
   * used for nothing else. A signer-held key (`signSecret`) has none: its wallet takes unlocked
   * quotes.
   */
  withSecretHex?<T>(use: (hex: string) => Promise<T>): Promise<T>;
}

/**
 * A send whose caller waits for it a fixed time and cannot cancel it (lane W8a: a PAY build; the
 * worker gives up after `WORKER_HOST_REQUEST_TIMEOUT_MS`, and P2PK sets made after that are lost).
 * With it, the send is bounded: `onTurn` is awaited when the send's turn at its mint comes —
 * after every operation queued ahead of it there, before anything is selected, derived or asked —
 * and a throw (or rejection) refuses the send with nothing spent and nothing journaled; a NUT-13
 * counter collision is reported instead of run again with fresh counters; and the skip-ahead past
 * a collision (its own, or one the journal settle finds) asks at most one batch, like a mint
 * without NUT-12. The caller's retry then derives past the moved counters.
 */
export interface SendBound {
  /** Awaited holding the mint's turn: it must answer at once (read local state, then decide). */
  readonly onTurn: () => void | Promise<void>;
}

export interface SpendContext {
  readonly mints: MintConnections;
  readonly store: ProofStore;
  readonly key?: WalletKey;
  /** Clock for journaled operations (ADR 0014). Default: the system clock. */
  readonly now?: () => UnixSeconds;
  /**
   * Tests: smaller restore bounds. Clamped to `RESTORE_MAX_BATCHES` / `RESTORE_MAX_KEYSETS`, so a
   * caller can only tighten them.
   */
  readonly restoreLimits?: { readonly maxBatches?: number; readonly maxKeysets?: number };
}

/**
 * A journaled operation the mint shows no trace of is dropped only after this many seconds: until
 * then its request may still be in flight (ADR 0014). A retry of the same receive or mint reuses
 * its outputs meanwhile; a send's inputs are kept out of new selections.
 */
export const PENDING_SETTLE_AFTER_S = 600;

export type WalletErrorCode =
  | 'invalid-argument'
  | 'insufficient-funds'
  | 'spent'
  | 'not-ours'
  | 'mint-error'
  | 'bad-mint-response';

export class WalletError extends Error {
  override readonly name = 'WalletError';
  constructor(
    readonly code: WalletErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

// ---------------------------------------------------------------------------------------
// Conversions between the contracts' wire shape and cashu-ts'
// ---------------------------------------------------------------------------------------

export function toCashu(p: CashuProof): Proof {
  return {
    id: p.id,
    amount: Amount.from(p.amount),
    secret: p.secret,
    C: p.C,
    ...(p.dleq === undefined ? {} : { dleq: { ...p.dleq } }),
    ...(p.witness === undefined ? {} : { witness: p.witness }),
  };
}

export function fromCashu(p: Proof): CashuProof {
  const amount = p.amount.toNumber();
  const witness =
    p.witness === undefined
      ? undefined
      : typeof p.witness === 'string'
        ? p.witness
        : JSON.stringify(p.witness);
  return {
    id: p.id,
    amount,
    secret: p.secret,
    C: p.C,
    ...(p.dleq === undefined
      ? {}
      : { dleq: { s: p.dleq.s, e: p.dleq.e, ...(p.dleq.r === undefined ? {} : { r: p.dleq.r }) } }),
    ...(witness === undefined ? {} : { witness }),
  };
}

const COMPRESSED = /^0[23][0-9a-f]{64}$/;
/** NUT-10/11 tag keys with spending semantics — never accepted as "extra" tags on a send. */
const RESERVED_TAGS = new Set([
  'locktime',
  'refund',
  'pubkeys',
  'n_sigs',
  'n_sigs_refund',
  'sigflag',
]);

function checkAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 1)
    throw new WalletError('invalid-argument', 'amount must be a positive integer of sats');
}

function checkTags(tags: readonly (readonly string[])[] | undefined): P2PKTag[] {
  if (tags === undefined) return [];
  const out: P2PKTag[] = [];
  for (const tag of tags as readonly unknown[]) {
    const t: readonly unknown[] = Array.isArray(tag) ? (tag as readonly unknown[]) : [];
    if (t.length < 2 || !t.every((v): v is string => typeof v === 'string' && v.length > 0))
      throw new WalletError(
        'invalid-argument',
        'tags must be [key, value, …] of non-empty strings',
      );
    const [key = '', ...rest] = t;
    if (RESERVED_TAGS.has(key))
      throw new WalletError(
        'invalid-argument',
        `tag "${key}" has spending semantics and is refused`,
      );
    out.push([key, ...rest]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------------------

export class Spender {
  private readonly locks = new Map<MintUrl, Promise<unknown>>();
  /** Operations started and not yet finished, queued ones included (`idle`). */
  private running = 0;
  /**
   * Mints where a bounded send (`SendBound`) holds the lock right now: a skip-ahead past a counter
   * collision asks at most one batch there. Ops at one mint run one at a time, so the set names the
   * running op's mint exactly.
   */
  private readonly bounded = new Set<MintUrl>();
  private isClosed = false;
  /** The last reissue plan per mint and the exact proofs it covered (ADR 0016 D5). */
  private readonly plans = new Map<
    MintUrl,
    {
      readonly amount: number;
      readonly inputs: number;
      readonly feeSats: number;
      readonly secrets: string;
    }
  >();

  constructor(private readonly ctx: SpendContext) {}

  /** Run `f` with `mint` locked (FIFO). Refused once `close` has run. */
  private exclusive<T>(mint: MintUrl, f: () => Promise<T>): Promise<T> {
    this.running++;
    const guarded = async (): Promise<T> => {
      try {
        if (this.isClosed) throw new WalletError('invalid-argument', 'the wallet is closed');
        return await f();
      } finally {
        this.running--;
      }
    };
    const prev = this.locks.get(mint) ?? Promise.resolve();
    const run = prev.then(guarded, guarded);
    const settled = run.catch(() => undefined);
    this.locks.set(mint, settled);
    void settled.then(() => {
      if (this.locks.get(mint) === settled) this.locks.delete(mint);
    });
    return run;
  }

  /** No operation is running or queued at any mint. */
  idle(): boolean {
    return this.running === 0;
  }

  /**
   * Refuse every new operation and wait until every per-mint lock is idle (ADR 0016 §2): the
   * caller may then wipe the seed — nothing derives from it any more. Idempotent.
   */
  async close(): Promise<void> {
    this.isClosed = true;
    while (this.locks.size > 0) await Promise.all([...this.locks.values()]);
  }

  /**
   * Run `f`; on a NUT-13 counter collision (its entry dropped, the counters moved past it) run it
   * ONCE more with fresh counters (ADR 0016 §4). A second collision is an error: another wallet is
   * using this phrase right now.
   */
  private async twice<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (!(e instanceof CounterCollision)) throw e;
    }
    try {
      return await f();
    } catch (e) {
      if (e instanceof CounterCollision)
        throw new WalletError(
          'mint-error',
          'another wallet derives from this recovery phrase (NUT-13 counter collision)',
        );
      throw e;
    }
  }

  /**
   * Run `f` once (a bounded send, `SendBound`): a NUT-13 counter collision — its entry already
   * dropped and the counters moved past it — is reported, never run again here: the caller's
   * deadline does not cover a second attempt. Its retry derives past the moved counters.
   */
  private async once<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof CounterCollision)
        throw new WalletError(
          'mint-error',
          'NUT-13 counter collision: the counters moved past it, retry the payment later',
        );
      throw e;
    }
  }

  /**
   * Get `mint` ready for a bounded send (`SendBound`; lane W8a): its wallet loaded and, where this
   * wallet derives NUT-13 outputs, the active keyset known to the counters — probed at this mint
   * (one NUT-09 batch) when the counters file does not know it. Spends, derives and journals
   * nothing. Not under the mint's lock: the counter source serialises the probe, and nothing
   * derives under a keyset before it is probed.
   */
  async prepare(mint: MintUrl): Promise<void> {
    if (this.isClosed) throw new WalletError('invalid-argument', 'the wallet is closed');
    const w = await this.ctx.mints.wallet(mint);
    await this.own(w);
  }

  /**
   * Whether this wallet's own new outputs at `w` are deterministic (ADR 0016 §4): seeded, and the
   * mint can restore them — NUT-09, and an output keyset NUT-13 derives for (hex, v1 or v2).
   */
  private seededAt(w: CashuTsWallet): boolean {
    const seeding = this.ctx.mints.seeding;
    const built = seededWith(w);
    if (built !== undefined && built !== seeding?.seed)
      throw new WalletError(
        'invalid-argument',
        'these connections derive NUT-13 outputs but did not pass on `seeding` (a MintConnections wrapper must forward it)',
      );
    if (seeding === undefined || !supports(w, 9)) return false;
    try {
      const k = w.getKeyset();
      return k.hasHexId && (k.version === 0 || k.version === 1);
    } catch {
      return false;
    }
  }

  /**
   * The output type of this wallet's own new outputs at `w`: explicit, never cashu-ts's 'auto'.
   * Deterministic ones are derived only once the counter source knows the keyset — probed HERE, at
   * the mint this operation runs at, and nowhere else (independent review 2026-09-27, finding 2).
   * A probe that cannot run fails the operation before anything is sent.
   */
  private async own(w: CashuTsWallet): Promise<OutputType> {
    // `seededAt` first: it is what refuses a wrapper that dropped `seeding` (ADR 0016 §2).
    if (!this.seededAt(w)) return { type: 'random' };
    const seeding = this.ctx.mints.seeding;
    if (seeding === undefined) return { type: 'random' }; // unreachable: seededAt checked it
    try {
      await seeding.counters.ensureProbed(w.getKeyset().id, counterProbe(w, seeding.seed));
    } catch (e) {
      throw new WalletError('mint-error', `the NUT-13 counters cannot be used (${errorName(e)})`);
    }
    return { type: 'deterministic', counter: 0 };
  }

  /**
   * NUT-11 P2PK send of exactly `amount` sats at `mint`, locked to `p2pk`, every proof with a
   * DLEQ the recipient can verify. The swap fee is the SENDER's (the recipient receives exactly
   * `amount` in locked proofs). Change is committed before the set is returned.
   */
  send(
    amount: Sats,
    opts: {
      readonly p2pk: CashuP2pkPubkey;
      readonly mint: MintUrl;
      readonly tags?: readonly (readonly string[])[];
      readonly memo?: string;
      /** A deadline-bound send (a PAY build): see `SendBound`. */
      readonly bound?: SendBound;
    },
  ): Promise<LockedProofSet> {
    checkAmount(amount);
    if (typeof opts.p2pk !== 'string' || !COMPRESSED.test(opts.p2pk.toLowerCase()))
      return Promise.reject(
        new WalletError('invalid-argument', 'p2pk must be a 33-byte compressed key (hex)'),
      );
    const bound = opts.bound;
    if (bound !== undefined && typeof (bound as { onTurn?: unknown }).onTurn !== 'function')
      return Promise.reject(new WalletError('invalid-argument', 'a send bound needs onTurn'));
    let tags: P2PKTag[];
    try {
      tags = checkTags(opts.tags);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    return this.exclusive(opts.mint, async () => {
      if (bound === undefined) {
        const w = await this.ctx.mints.wallet(opts.mint);
        return this.twice(() => this.sendOnce(w, amount, opts, tags));
      }
      // The turn came: the caller's deadline decides before anything is selected or asked.
      await bound.onTurn();
      this.bounded.add(opts.mint);
      try {
        const w = await this.ctx.mints.wallet(opts.mint);
        return await this.once(() => this.sendOnce(w, amount, opts, tags));
      } finally {
        this.bounded.delete(opts.mint);
      }
    });
  }

  private async sendOnce(
    w: CashuTsWallet,
    amount: Sats,
    opts: {
      readonly p2pk: CashuP2pkPubkey;
      readonly mint: MintUrl;
      readonly memo?: string;
    },
    tags: P2PKTag[],
  ): Promise<LockedProofSet> {
    const journal = this.journaling(w);
    // Proofs a pending send or melt may have spent stay out of the selection until it is settled.
    const busy = journal ? heldSecrets((await this.settle(opts.mint, w)).left) : new Set<string>();
    const held = (await this.ctx.store.proofs(opts.mint))
      .filter((p) => !busy.has(p.secret))
      .map(toCashu);
    let selected: Proof[];
    try {
      selected = w.selectProofsToSend(held, amount, true).send;
    } catch {
      throw new WalletError('insufficient-funds', `cannot cover ${amount} sat at this mint`);
    }
    if (selected.length === 0 || proofTotal(selected.map(fromCashu)) < amount)
      throw new WalletError('insufficient-funds', `cannot cover ${amount} sat at this mint`);

    // The change is ours: deterministic when seeded (ADR 0016 §4).
    const keep = await this.own(w);
    const outputs: OutputConfig = {
      send: {
        type: 'p2pk',
        options: { pubkey: opts.p2pk, ...(tags.length > 0 ? { additionalTags: tags } : {}) },
      },
      keep,
    };
    const memo = opts.memo ?? `P2PK send ${String(amount)} sat`;
    let result: { send: Proof[]; keep: Proof[] };
    if (!journal) {
      try {
        result = await w.send(amount, selected, { includeFees: false }, outputs);
      } catch (e) {
        await this.reconcile(opts.mint, w, selected);
        await this.collided(w, e, opts.mint);
        throw new WalletError('mint-error', `P2PK swap failed (${errorName(e)})`);
      }
      await this.ctx.store.commit(sendTx(opts.mint, selected, result, amount, memo));
    } else {
      let preview: Awaited<ReturnType<CashuTsWallet['prepareSwapToSend']>>;
      try {
        preview = await w.prepareSwapToSend(amount, selected, { includeFees: false }, outputs);
      } catch (e) {
        throw new WalletError('mint-error', `P2PK swap failed (${errorName(e)})`);
      }
      const op = this.newOp(
        'send',
        opts.mint,
        preview.inputs.map((p) => p.secret),
        preview.keepOutputs ?? [],
        preview.sendOutputs ?? [],
        preview.inputs.map(fromCashu),
        keep.type === 'deterministic',
      );
      await this.ctx.store.commit({ mint: opts.mint, spent: [], added: [], begin: op });
      let recovered = false;
      try {
        result = await w.completeSwap(preview);
      } catch (e) {
        if (await this.refused(w, op, e)) {
          await this.drop(op);
          await this.reconcile(opts.mint, w, selected);
          throw new WalletError('mint-error', `P2PK swap failed (${errorName(e)})`);
        }
        // Maybe executed with the answer lost: the change is ours, the locked outputs the
        // recipient's — restored, committed, and the send completes after all. Or a counter
        // collision (ADR 0016 §4): the entry is gone and the send runs again.
        const r = await this.resolveSafe(w, op, true, memo);
        if (r.state === 'collision') throw new CounterCollision();
        if (r.state !== 'executed')
          throw new WalletError('mint-error', `P2PK swap failed (${errorName(e)})`);
        result = { send: r.send, keep: r.keep };
        recovered = true;
      }
      if (!recovered)
        await this.ctx.store.commit({
          ...sendTx(opts.mint, selected, result, amount, memo),
          settle: [op.id],
        });
    }

    const sent = result.send.map(fromCashu);

    // Post-conditions on what the mint handed back (the inputs are gone either way).
    const binding = tags.find((t) => t[0] === PAY1_TAG)?.[1];
    if (proofTotal(sent) !== amount)
      throw new WalletError('bad-mint-response', 'locked outputs do not add up to the amount');
    const keys = w.getKeyset(sent[0]?.id);
    for (const p of result.send) {
      // Sync `hasValidDleq`, deprecated in cashu-ts 4.11 for the async `verifyMintSignatures` and removed
      // in v5; kept on purpose, with payment/engine.ts's `dleqOk` (same reason, same follow-up).
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
      if (p.dleq?.r === undefined || !hasValidDleq(p, keys))
        throw new WalletError('bad-mint-response', 'a locked output has no valid DLEQ');
      const lock = checkPayLock(p.secret, opts.p2pk, binding === undefined ? {} : { binding });
      if (!lock.ok)
        throw new WalletError(
          'bad-mint-response',
          `a locked output is not a plain lock (${lock.reason})`,
        );
    }
    return { mint: opts.mint, unit: 'sat', lockedTo: opts.p2pk, proofs: sent };
  }

  /**
   * Receive proofs into fresh, unlocked ones (NUT-03 swap). Proofs P2PK-locked to the wallet key
   * are signed with it first. Returns the sats added (after the mint's input fee).
   * `spent` = the mint says a proof was already spent (a double-spend, T5).
   */
  receive(set: { readonly mint: MintUrl; readonly proofs: readonly CashuProof[] }): Promise<Sats> {
    if (!Array.isArray(set.proofs) || set.proofs.length === 0)
      return Promise.reject(new WalletError('invalid-argument', 'nothing to receive'));
    return this.exclusive(set.mint, async () => {
      const w = await this.ctx.mints.wallet(set.mint);
      const inputs: Proof[] = [];
      for (const p of set.proofs) {
        const proof = toCashu(p);
        if (p.secret.startsWith('[')) {
          let signers: string[];
          try {
            signers = getP2PKExpectedWitnessPubkeys(p.secret);
          } catch {
            throw new WalletError('not-ours', 'a proof has a malformed spending condition');
          }
          const key = this.ctx.key;
          if (key === undefined || !signers.some((k) => sameKey(k, key.pubkey)))
            throw new WalletError(
              'not-ours',
              'a proof is locked to a key this wallet does not hold',
            );
          const sig = await key.sign(p.secret);
          inputs.push({ ...proof, witness: JSON.stringify({ signatures: [sig] }) });
        } else inputs.push(proof);
      }
      return this.swapIn(w, set.mint, inputs, 'received ecash');
    });
  }

  /** Swap `inputs` (not this wallet's proofs) into fresh outputs of its own; commit them. */
  private async swapIn(
    w: CashuTsWallet,
    mint: MintUrl,
    inputs: Proof[],
    memo: string,
  ): Promise<Sats> {
    if (!this.journaling(w)) {
      return this.twice(async () => {
        let fresh: Proof[];
        try {
          fresh = await w.receive(inputs, undefined, await this.own(w));
        } catch (e) {
          await this.collided(w, e, mint);
          throw receiveError(e);
        }
        return this.commitIn(mint, fresh, memo);
      });
    }
    return this.twice(() => this.receiveOnce(w, mint, inputs, memo));
  }

  /**
   * Journaled (ADR 0014): a retry of a receive whose answer was lost is recovered, or reuses the
   * same outputs.
   */
  private async receiveOnce(
    w: CashuTsWallet,
    mint: MintUrl,
    inputs: Proof[],
    memo: string,
  ): Promise<Sats> {
    const key = inputs.map((p) => p.secret);
    const { left, recovered } = await this.settle(mint, w);
    const done = recovered.get(opKey('receive', key));
    if (done !== undefined) return done as Sats;
    const prior = left.find((o) => o.kind === 'receive' && keyOf(o.key) === keyOf(key));
    const output = reuse(prior) ?? (await this.own(w));
    let preview: Awaited<ReturnType<CashuTsWallet['prepareSwapToReceive']>>;
    try {
      preview = await w.prepareSwapToReceive(inputs, undefined, output);
    } catch (e) {
      throw receiveError(e);
    }
    const op =
      prior ??
      this.newOp(
        'receive',
        mint,
        key,
        preview.keepOutputs ?? [],
        [],
        [],
        output.type === 'deterministic',
      );
    if (prior === undefined) await this.ctx.store.commit({ mint, spent: [], added: [], begin: op });
    let fresh: Proof[];
    try {
      fresh = (await w.completeSwap(preview)).keep;
    } catch (e) {
      const r = await this.afterFailure(w, op, e, memo);
      if (r !== null) return proofTotal(r.keep.map(fromCashu)) as Sats;
      throw receiveError(e);
    }
    return this.commitIn(mint, fresh, memo, op.id);
  }

  /**
   * NUT-05 melt: pay `quote` from the wallet's proofs at its mint. Change (NUT-08) comes back as
   * fresh proofs. The quote is re-read from the mint, so the amount paid is the mint's own.
   *
   * Journaled (ADR 0014 amendment, issue #8) where the store keeps a journal, the mint supports
   * NUT-09 and there is change to come back: the inputs and the NUT-08 blanks are written before
   * the request. An answer that never arrives, or a melt the mint reports PENDING, leaves the
   * inputs held and the blanks journaled; a later settle restores the change the mint signed.
   */
  melt(quote: MeltQuote): Promise<{ paid: boolean; preimage?: string; change: Sats }> {
    return this.exclusive(quote.mint, async () => {
      const w = await this.ctx.mints.wallet(quote.mint);
      return this.twice(() => this.meltOnce(w, quote));
    });
  }

  private async meltOnce(
    w: CashuTsWallet,
    quote: MeltQuote,
  ): Promise<{ paid: boolean; preimage?: string; change: Sats }> {
    let q: MeltQuoteBolt11Response;
    try {
      q = await w.checkMeltQuoteBolt11(quote.quoteId);
    } catch (e) {
      throw new WalletError('mint-error', `melt quote lookup failed (${errorName(e)})`);
    }
    if (q.amount.toNumber() !== quote.amount)
      throw new WalletError(
        'bad-mint-response',
        'the mint changed the melt amount since the quote was shown',
      );
    // The confirm dialog (security review F8) shows `quote.feeReserve`; never let the mint's
    // reserve exceed what the user agreed to.
    if (q.fee_reserve.toNumber() > quote.feeReserve)
      throw new WalletError(
        'bad-mint-response',
        'the mint asks a larger fee reserve than the quote that was shown',
      );
    const need = q.amount.add(q.fee_reserve);
    const journal = this.journaling(w);
    const memo = 'melt to Lightning';
    let busy = new Set<string>();
    if (journal) {
      const { left, recovered } = await this.settle(quote.mint, w);
      // An earlier melt of this quote whose answer was lost, recovered by this settle (a melt
      // entry only: another kind's key never answers for a melt).
      const done = recovered.get(opKey('melt', [quote.quoteId]));
      if (done !== undefined) return { paid: true, change: done as Sats };
      if (left.some((o) => o.kind === 'melt' && keyOf(o.key) === keyOf([quote.quoteId])))
        throw new WalletError(
          'mint-error',
          'an earlier melt of this quote is still unresolved at the mint',
        );
      busy = heldSecrets(left);
    }
    // Already paid (by an earlier melt of ours whose change an earlier settle restored, e.g.
    // the startup one): the invoice IS paid — say so, never "melt failed", and send nothing.
    // Its change, if any, is already in the wallet; the history has its line.
    if (q.state === 'PAID') {
      const preimage = q.payment_preimage;
      return {
        paid: true,
        ...(typeof preimage === 'string' && preimage.length > 0 ? { preimage } : {}),
        change: 0 as Sats,
      };
    }
    const held = (await this.ctx.store.proofs(quote.mint))
      .filter((p) => !busy.has(p.secret))
      .map(toCashu);
    let selected: Proof[];
    try {
      selected = w.selectProofsToSend(held, need, true).send;
    } catch {
      throw new WalletError(
        'insufficient-funds',
        'not enough sats at this mint for amount + fee reserve',
      );
    }
    if (selected.length === 0)
      throw new WalletError('insufficient-funds', 'not enough sats at this mint');
    let res: Awaited<ReturnType<CashuTsWallet['meltProofsBolt11']>>;
    let op: PendingOp | undefined;
    const blanks = await this.own(w);
    if (!journal) {
      try {
        res = await w.meltProofsBolt11(q, selected, undefined, blanks);
      } catch (e) {
        await this.reconcile(quote.mint, w, selected);
        await this.collided(w, e, quote.mint);
        throw new WalletError('mint-error', `melt failed (${errorName(e)})`);
      }
    } else {
      let preview: MeltPreview<MeltQuoteBolt11Response>;
      try {
        preview = await w.prepareMelt('bolt11', q, selected, undefined, blanks);
      } catch (e) {
        throw new WalletError('mint-error', `melt failed (${errorName(e)})`);
      }
      // No blanks (no change can come back): nothing to restore, so nothing to journal.
      if (preview.outputData.length > 0) {
        op = this.newOp(
          'melt',
          quote.mint,
          [quote.quoteId],
          preview.outputData,
          [],
          preview.inputs.map(fromCashu),
          blanks.type === 'deterministic',
        );
        await this.ctx.store.commit({ mint: quote.mint, spent: [], added: [], begin: op });
      }
      try {
        res = await w.completeMelt(preview);
      } catch (e) {
        if (op === undefined || (await this.refused(w, op, e))) {
          // Refused by the mint (or not journaled): what is still unspent stays.
          if (op !== undefined) await this.drop(op);
          await this.reconcile(quote.mint, w, selected);
          throw new WalletError('mint-error', `melt failed (${errorName(e)})`);
        }
        // Maybe executed with the answer lost: the change the mint signed is restored now; if
        // none is yet, the inputs stay held and a later settle finds out (ADR 0014 amendment).
        // A counter collision on the blanks (ADR 0016 §4): the melt runs again.
        const r = await this.resolveSafe(w, op, true, memo);
        if (r.state === 'collision') throw new CounterCollision();
        if (r.state === 'executed')
          return { paid: true, change: proofTotal(r.keep.map(fromCashu)) as Sats };
        throw new WalletError(
          'mint-error',
          `melt outcome unknown (${errorName(e)}): its inputs are held until the mint answers`,
        );
      }
    }
    const change = res.change.map(fromCashu);
    const paid = res.quote.state === 'PAID';
    if (!paid) {
      // In flight (PENDING): the inputs are the mint's until it settles; the change it will
      // sign then is journaled, so the entry stays and a later settle resolves it.
      if (op !== undefined && res.quote.state === 'PENDING')
        return { paid: false, change: 0 as Sats };
      // Not paid: the mint may or may not have invalidated the inputs (pending, failed).
      // Keep what is still unspent, drop what is gone, pay nothing out of the history.
      if (op !== undefined) await this.drop(op);
      await this.reconcile(quote.mint, w, selected);
      return { paid: false, change: 0 as Sats };
    }
    const spentTotal = proofTotal(selected.map(fromCashu)) - proofTotal(change);
    await this.ctx.store.commit({
      mint: quote.mint,
      spent: selected.map(fromCashu),
      added: change,
      history: { direction: 'out', amount: spentTotal as Sats, memo },
      ...(op === undefined ? {} : { settle: [op.id] }),
    });
    const preimage = res.quote.payment_preimage;
    return {
      paid,
      ...(typeof preimage === 'string' && preimage.length > 0 ? { preimage } : {}),
      change: proofTotal(change) as Sats,
    };
  }

  /**
   * NUT-04: mint the proofs of a PAID quote into the wallet. Returns the sats minted. A NUT-20
   * locked quote (`locked`: the mint's quote answer, naming its `pubkey`) is signed with this
   * wallet's key; a quote locked to any other key is refused.
   */
  mint(quote: MintQuote, locked?: MintQuoteBolt11Response): Promise<Sats> {
    return this.exclusive(quote.mint, async () => {
      const w = await this.ctx.mints.wallet(quote.mint);
      // A real mint (Nutshell) answers an UNLOCKED quote with `"pubkey": null`, whatever the
      // cashu-ts type says: only a non-empty string is a lock.
      const pk: unknown = locked?.pubkey;
      const lockedTo = typeof pk === 'string' && pk !== '' ? pk : undefined;
      const key = this.ctx.key;
      if (lockedTo !== undefined) {
        if (key?.withSecretHex === undefined || lockedTo.toLowerCase() !== key.pubkey.toLowerCase())
          throw new WalletError(
            'invalid-argument',
            'the quote is locked to a key this wallet cannot sign with',
          );
      }
      return this.twice(() => this.mintOnce(w, quote, locked, lockedTo));
    });
  }

  private async mintOnce(
    w: CashuTsWallet,
    quote: MintQuote,
    locked: MintQuoteBolt11Response | undefined,
    lockedTo: string | undefined,
  ): Promise<Sats> {
    const key = this.ctx.key;
    const memo = 'top-up';
    const journal = this.journaling(w);
    let prior: PendingOp | undefined;
    if (journal) {
      // A quote whose mint answer was lost is recovered, or minted again with the same outputs.
      const { left, recovered } = await this.settle(quote.mint, w);
      const done = recovered.get(opKey('mint', [quote.quoteId]));
      if (done !== undefined) return done as Sats;
      prior = left.find((o) => o.kind === 'mint' && keyOf(o.key) === keyOf([quote.quoteId]));
    }
    const output = reuse(prior) ?? (await this.own(w));
    let preview: Awaited<ReturnType<CashuTsWallet['prepareMint']>>;
    try {
      // The key is lent to the prepare step only: it computes the NUT-20 signatures.
      preview =
        lockedTo !== undefined && key?.withSecretHex !== undefined && locked !== undefined
          ? await key.withSecretHex((privkey) =>
              w.prepareMint('bolt11', quote.amount, locked, { privkey }, output),
            )
          : await w.prepareMint(
              'bolt11',
              quote.amount,
              { quote: quote.quoteId },
              undefined,
              output,
            );
    } catch (e) {
      throw new WalletError('mint-error', `minting failed (${errorName(e)})`);
    }
    const op = !journal
      ? undefined
      : (prior ??
        this.newOp(
          'mint',
          quote.mint,
          [quote.quoteId],
          preview.outputData,
          [],
          [],
          output.type === 'deterministic',
        ));
    if (op !== undefined && prior === undefined)
      await this.ctx.store.commit({ mint: quote.mint, spent: [], added: [], begin: op });
    let proofs: Proof[];
    try {
      proofs = await w.completeMint(preview);
    } catch (e) {
      if (op === undefined) await this.collided(w, e, quote.mint);
      const r = op === undefined ? null : await this.afterFailure(w, op, e, memo);
      if (r !== null) return proofTotal(r.keep.map(fromCashu)) as Sats;
      throw new WalletError('mint-error', `minting failed (${errorName(e)})`);
    }
    return this.commitIn(quote.mint, proofs, memo, op?.id);
  }

  /**
   * NUT-07: which of `set`'s proofs the mint reports SPENT, in order. Needs no ownership — the
   * seeder uses it on the creator set it forwards (security review F11). Rejects if the mint
   * cannot be asked.
   */
  checkSpent(set: {
    readonly mint: MintUrl;
    readonly proofs: readonly CashuProof[];
  }): Promise<readonly boolean[]> {
    return this.exclusive(set.mint, async () => {
      const w = await this.ctx.mints.wallet(set.mint);
      const states = await w.checkProofsStates(
        set.proofs.map((p) => ({ secret: p.secret, id: p.id })),
      );
      if (states.length !== set.proofs.length)
        throw new WalletError('bad-mint-response', 'checkstate answered for the wrong proofs');
      return states.map((st) => st.state === 'SPENT');
    });
  }

  /**
   * Whether EVERY proof of `set` was spent with a witness signed by this wallet's key — i.e. by
   * us, in a swap whose response was lost (security review F31), not by a double-spender, who
   * cannot sign with our key. `false` when any proof is unspent, lacks a witness, or the mint
   * cannot be asked.
   */
  async spentByUs(set: {
    readonly mint: MintUrl;
    readonly proofs: readonly CashuProof[];
  }): Promise<boolean> {
    const key = this.ctx.key;
    if (key === undefined || set.proofs.length === 0) return false;
    try {
      return await this.exclusive(set.mint, async () => {
        const w = await this.ctx.mints.wallet(set.mint);
        const states = await w.checkProofsStates(
          set.proofs.map((p) => ({ secret: p.secret, id: p.id })),
        );
        if (states.length !== set.proofs.length) return false;
        return set.proofs.every((p, i) => {
          const st = states[i];
          if (st?.state !== 'SPENT' || typeof st.witness !== 'string') return false;
          let sigs: unknown;
          try {
            sigs = (JSON.parse(st.witness) as { signatures?: unknown }).signatures;
          } catch {
            return false;
          }
          return (
            Array.isArray(sigs) &&
            sigs.some(
              (sig) => typeof sig === 'string' && schnorrVerifyMessage(sig, p.secret, key.pubkey),
            )
          );
        });
      });
    } catch {
      return false;
    }
  }

  /**
   * Settle the journal at `mint` (ADR 0014): recover what the mint signed for operations whose
   * answer was lost, drop those it never executed. Run at startup; every operation at a mint also
   * settles it first. Never throws for a mint that cannot be asked (the journal stays).
   */
  recover(mint: MintUrl): Promise<{ recovered: number; left: number }> {
    return this.exclusive(mint, async () => {
      const w = await this.ctx.mints.wallet(mint);
      if (!this.journaling(w)) return { recovered: 0, left: 0 };
      const { left, recovered } = await this.settle(mint, w);
      return { recovered: recovered.size, left: left.length };
    });
  }

  /**
   * What a journaled mint of `quote` added, if its answer was lost and the mint signed it — for a
   * quote the mint already reports ISSUED. `null` when there is nothing to recover.
   */
  recoverMint(quote: MintQuote): Promise<Sats | null> {
    return this.exclusive(quote.mint, async () => {
      const w = await this.ctx.mints.wallet(quote.mint);
      if (!this.journaling(w)) return null;
      const got = (await this.settle(quote.mint, w)).recovered.get(opKey('mint', [quote.quoteId]));
      return got === undefined ? null : (got as Sats);
    });
  }

  // ---- NUT-13 (ADR 0016) ----------------------------------------------------------------

  /**
   * ADR 0016 §5: scan `seed` at `mint` and add what is unspent and not already held — every
   * restorable keyset from counter 0, or with `resume` (keyset id → counter, a report's
   * `RestoreDetail.resume`) only the keysets it names, each from its counter: a continuation. At
   * most `RESTORE_MAX_KEYSETS` keysets per call, active first; the rest are reported in `resume` at
   * the counter they would have started from (fix round 7: they used to be dropped silently). `seed`
   * may be another device's phrase: it is read here, and nothing is derived from it later. When it
   * is this device's own, every keyset scanned is scanned at least to its counters file's `next`
   * whatever the gaps or the batch cap — this device may have used all of it — and its counters
   * move past the last signature. A keyset scan the batch cap (or a failure) stopped early is
   * REPORTED: the result then carries `resume` (independent review 2026-09-27, finding 1). Never
   * throws for a mint (its outcome says what happened); throws for a seed that is wiped or not
   * core's, or a `resume` that is malformed or empty.
   */
  restoreFromSeed(
    seed: RecoverySeed,
    mint: MintUrl,
    onKeyset?: (done: number, total: number) => void,
    resume?: Readonly<Record<string, number>>,
  ): Promise<RestoreDetail> {
    try {
      seedBytes(seed);
    } catch {
      return Promise.reject(new WalletError('invalid-argument', 'the recovery seed is not usable'));
    }
    if (resume !== undefined && !isResume(resume))
      return Promise.reject(new WalletError('invalid-argument', 'a restore resume is malformed'));
    return this.exclusive(mint, async () => {
      const w = await this.restorable(mint);
      if (typeof w === 'string') return report(mint, w, 0);
      const wanted = restorableKeysets(w).filter(
        (k) => resume === undefined || Object.hasOwn(resume, k.id),
      );
      const max = this.limit('maxKeysets');
      const keysets = wanted.slice(0, max);
      const s = this.ctx.mints.seeding;
      const own = s !== undefined && sameSeed(seed, s.seed) ? s : undefined;
      let floors: Record<string, number> = {};
      if (own !== undefined) {
        try {
          floors = await own.counters.leases();
        } catch {
          floors = {}; // an unreadable counters file: the plain gap rule, like another phrase
        }
      }
      const found: Found[] = [];
      const last = new Map<string, number>();
      const stopped: Record<string, number> = {};
      // Past the keyset cap: not scanned in this call, so named where a resumed call starts them.
      for (const ks of wanted.slice(max)) stopped[ks.id] = resume?.[ks.id] ?? 0;
      let failed = false;
      for (const [i, ks] of keysets.entries()) {
        const from = resume?.[ks.id] ?? 0;
        try {
          const keyset = ks.hasKeys ? ks : await w.keyChain.ensureKeysetKeys(ks.id);
          const r = await this.scan(w, seed, keyset, from, floors[ks.id] ?? 0);
          found.push(...r.found);
          if (r.last !== undefined) last.set(ks.id, r.last);
          if (r.stopped !== undefined) stopped[ks.id] = r.stopped;
          if (r.failed) failed = true;
        } catch (e) {
          if (e instanceof RecoverySeedError)
            throw new WalletError(
              'invalid-argument',
              'the recovery seed was wiped during a restore',
            );
          // A dishonest answer taints the mint: nothing from it counts (ADR 0016 §5).
          if (e instanceof RestoreRefused) return report(mint, 'refused', 0);
          // This keyset could not be asked (its keys could not be fetched): what the other keysets
          // brought back still counts (independent review 2026-09-27, finding 7).
          stopped[ks.id] = from;
          failed = true;
        }
        try {
          onKeyset?.(i + 1, keysets.length);
        } catch {
          // a progress listener's failure is its own
        }
      }
      if (own !== undefined)
        for (const [id, c] of last) await own.counters.advanceToAtLeast(id, c + 1);
      const r = await this.adopt(w, mint, found, 'restored from recovery phrase');
      return incomplete(r, mint, stopped, failed);
    });
  }

  /**
   * ADR 0016 §3: restore this device's own `[published, next)` ranges at `mint` (those of its
   * keysets) — outputs made but maybe never published to NIP-60 (a crash with the outbox or the
   * journal in memory). Every range is scanned WHOLE and NEWEST FIRST (independent review
   * 2026-09-27, finding 1): the range is this device's own counters file, so no mint can stretch
   * it, and the latest outputs are the ones most likely lost with the outbox. Same checks as
   * `restoreFromSeed`; a range that could not be finished leaves the outcome `unreachable` unless
   * something was restored, and its `resume` entry is the range's LOW end `from` — what an upward
   * `restoreFromSeed` of this phrase must start at to cover what the downward scan left (fix
   * round 7; `RestoreDetail.resume`).
   */
  restoreUnpublished(
    mint: MintUrl,
    ranges: readonly UnpublishedRange[],
    onDone?: (keysetIds: readonly string[]) => void,
  ): Promise<RestoreDetail> {
    const s = this.ctx.mints.seeding;
    if (s === undefined || ranges.length === 0) return Promise.resolve(report(mint, 'nothing', 0));
    return this.exclusive(mint, async () => {
      const w = await this.restorable(mint);
      if (typeof w === 'string') return report(mint, w, 0);
      const found: Found[] = [];
      const stopped: Record<string, number> = {};
      const scanned: string[] = [];
      for (const r of ranges) {
        if (!w.keyChain.hasKeyset(r.keysetId)) continue;
        try {
          const keyset = await w.keyChain.ensureKeysetKeys(r.keysetId);
          const got = await this.scanRange(w, s.seed, keyset, r.from, r.to);
          found.push(...got.found);
          if (got.stopped !== undefined) stopped[r.keysetId] = got.stopped;
          else scanned.push(r.keysetId);
        } catch (e) {
          if (e instanceof RecoverySeedError)
            throw new WalletError(
              'invalid-argument',
              'the recovery seed was wiped during a restore',
            );
          if (e instanceof RestoreRefused) return report(mint, 'refused', 0);
          stopped[r.keysetId] = r.from;
        }
      }
      const r = await this.adopt(w, mint, found, 'recovered from recovery phrase after a restart');
      // The keysets whose whole range was scanned AND whose finds were added: their watermark may
      // move again (`CashuWallet.restoreUnpublished`).
      if (r.outcome !== 'unreachable' && r.outcome !== 'refused') {
        try {
          onDone?.(scanned);
        } catch {
          // the listener's failure is its own
        }
      }
      return incomplete(r, mint, stopped, true);
    });
  }

  /**
   * ADR 0016 D5: what swapping everything spendable at `mint` into seeded outputs would cost (the
   * mint's input fee, shown to the user before `reissue`). Remembers exactly which proofs it
   * covered.
   */
  reissuePlan(mint: MintUrl): Promise<ReissuePlan> {
    return this.exclusive(mint, async () => {
      const w = await this.ctx.mints.wallet(mint);
      const held = await this.spendable(mint, w);
      const plan: ReissuePlan = {
        mint,
        amount: proofTotal(held) as Sats,
        inputs: held.length,
        feeSats: feeOf(w, held) as Sats,
      };
      this.plans.set(mint, {
        amount: plan.amount,
        inputs: plan.inputs,
        feeSats: plan.feeSats,
        secrets: keyOf(held.map((p) => p.secret)),
      });
      return plan;
    });
  }

  /**
   * ADR 0016 D5: swap everything the plan covered into seeded outputs. Refused unless the plan is
   * this wallet's latest for the mint and the spendable proofs are exactly the ones it covered —
   * the user confirmed that fee for those proofs. A plan is used once.
   */
  reissue(plan: ReissuePlan): Promise<ReissueResult> {
    return this.exclusive(plan.mint, async () => {
      const w = await this.ctx.mints.wallet(plan.mint);
      if (!this.seededAt(w))
        throw new WalletError(
          'invalid-argument',
          'no recovery phrase is loaded, or this mint cannot restore seeded outputs (NUT-09)',
        );
      const held = await this.spendable(plan.mint, w);
      const was = this.plans.get(plan.mint);
      const fee = feeOf(w, held);
      if (
        was?.amount !== plan.amount ||
        was.inputs !== plan.inputs ||
        was.feeSats !== plan.feeSats ||
        was.secrets !== keyOf(held.map((p) => p.secret)) ||
        fee !== plan.feeSats
      )
        throw new WalletError(
          'invalid-argument',
          'the holdings at this mint changed since the plan: make a new plan',
        );
      this.plans.delete(plan.mint);
      if (held.length === 0 || plan.amount - plan.feeSats < 1)
        throw new WalletError('insufficient-funds', 'nothing to reissue after the mint fee');
      return this.twice(() => this.reissueOnce(w, plan, held));
    });
  }

  private async reissueOnce(
    w: CashuTsWallet,
    plan: ReissuePlan,
    held: readonly CashuProof[],
  ): Promise<ReissueResult> {
    const inputs = held.map(toCashu);
    const output = await this.own(w);
    let preview: Awaited<ReturnType<CashuTsWallet['prepareSwapToReceive']>>;
    try {
      preview = await w.prepareSwapToReceive(inputs, undefined, output);
    } catch (e) {
      throw new WalletError('mint-error', `reissue failed (${errorName(e)})`);
    }
    const history =
      plan.feeSats > 0
        ? { direction: 'out' as const, amount: plan.feeSats, memo: REISSUE_MEMO }
        : undefined;
    const done = (keep: Proof[]): ReissueResult => ({
      mint: plan.mint,
      reissued: proofTotal(keep.map(fromCashu)) as Sats,
      feeSats: plan.feeSats,
    });
    if (!this.journaling(w)) {
      let keep: Proof[];
      try {
        keep = (await w.completeSwap(preview)).keep;
      } catch (e) {
        await this.reconcile(plan.mint, w, inputs);
        await this.collided(w, e, plan.mint);
        throw new WalletError('mint-error', `reissue failed (${errorName(e)})`);
      }
      await this.ctx.store.commit({
        mint: plan.mint,
        spent: [...held],
        added: keep.map(fromCashu),
        ...(history === undefined ? {} : { history }),
      });
      return done(keep);
    }
    // Journaled like a send without locked outputs: the inputs are held until the mint answers.
    const op = this.newOp(
      'send',
      plan.mint,
      inputs.map((p) => p.secret),
      preview.keepOutputs ?? [],
      [],
      held,
      output.type === 'deterministic',
    );
    await this.ctx.store.commit({ mint: plan.mint, spent: [], added: [], begin: op });
    let keep: Proof[];
    try {
      keep = (await w.completeSwap(preview)).keep;
    } catch (e) {
      if (await this.refused(w, op, e)) {
        await this.drop(op);
        await this.reconcile(plan.mint, w, inputs);
        throw new WalletError('mint-error', `reissue failed (${errorName(e)})`);
      }
      const r = await this.resolveSafe(w, op, true, REISSUE_MEMO);
      if (r.state === 'collision') throw new CounterCollision();
      if (r.state === 'executed') return done(r.keep);
      throw new WalletError(
        'mint-error',
        `reissue outcome unknown (${errorName(e)}): its inputs are held until the mint answers`,
      );
    }
    await this.ctx.store.commit({
      mint: plan.mint,
      spent: [...held],
      added: keep.map(fromCashu),
      ...(history === undefined ? {} : { history }),
      settle: [op.id],
    });
    return done(keep);
  }

  /** The proofs at `mint` no unresolved journaled operation holds (its journal settled first). */
  private async spendable(mint: MintUrl, w: CashuTsWallet): Promise<readonly CashuProof[]> {
    const busy = this.journaling(w)
      ? heldSecrets((await this.settle(mint, w)).left)
      : new Set<string>();
    return (await this.ctx.store.proofs(mint)).filter((p) => !busy.has(p.secret));
  }

  private limit(which: 'maxBatches' | 'maxKeysets'): number {
    const max = which === 'maxBatches' ? RESTORE_MAX_BATCHES : RESTORE_MAX_KEYSETS;
    const asked = this.ctx.restoreLimits?.[which];
    return asked !== undefined && Number.isSafeInteger(asked) && asked >= 1 && asked < max
      ? asked
      : max;
  }

  /** The loaded wallet of a mint a restore can run at (its journal settled), or why not. */
  private async restorable(mint: MintUrl): Promise<CashuTsWallet | 'unreachable' | 'unsupported'> {
    let w: CashuTsWallet;
    try {
      w = await this.ctx.mints.wallet(mint);
    } catch {
      return 'unreachable';
    }
    if (!supports(w, 9)) return 'unsupported';
    if (this.journaling(w)) await this.settle(mint, w);
    return w;
  }

  /**
   * Restore `seed` under one keyset from `from` until `RESTORE_EMPTY_BATCHES` batches in a row come
   * back empty (NUT-13: a gap of 300, what cashu-ts `batchRestore(300, 100)` does). Below `floor`
   * (this device's own counters file's `next`) nothing ends the scan — neither empty batches nor
   * the cap; past it, at most `maxBatches` batches (ADR 0016 §5, a hostile mint signing something
   * in every batch), and a scan the cap ends says where it `stopped`. A batch that cannot be asked
   * ends it too (`failed`), keeping what was found. A dishonest answer throws `RestoreRefused`.
   * `last` is the last DLEQ-verified signature (what may move this device's counters).
   */
  private async scan(
    w: CashuTsWallet,
    seed: RecoverySeed,
    keyset: Keyset,
    from: number,
    floor: number,
  ): Promise<Scanned> {
    const found: Found[] = [];
    let last: number | undefined;
    let empty = 0;
    let beyond = 0;
    const max = this.limit('maxBatches');
    for (let at = from; at < COUNTER_LIMIT;) {
      const past = at >= floor;
      if (past && empty >= RESTORE_EMPTY_BATCHES) break;
      if (past && beyond >= max) return { found, last, stopped: at, failed: false };
      const count = Math.min(RESTORE_BATCH, COUNTER_LIMIT - at);
      let got: Found[];
      try {
        got = await restoreBatch(w, seed, keyset, at, count);
      } catch (e) {
        if (e instanceof RestoreRefused || e instanceof RecoverySeedError) throw e;
        return { found, last, stopped: at, failed: true };
      }
      if (past) beyond++;
      if (got.length === 0) {
        if (past) empty++;
      } else {
        empty = 0;
        found.push(...got);
        // Only a signature the mint PROVED (NUT-12 DLEQ) may move this device's counters: a mint
        // without NUT-12 announcing another mint's keyset id could otherwise push them ~20 000
        // ahead from a restore (the analog of independent review finding 2, found fixing it).
        for (const g of got) if (g.verified) last = Math.max(last ?? g.counter, g.counter);
      }
      at += count;
    }
    return { found, last, failed: false };
  }

  /**
   * Restore `seed` under one keyset over exactly `[from, to)`, newest batch first (the startup
   * restore of this device's own unpublished range). No cap: the range comes from this device's
   * counters file, not from a mint. A batch that cannot be asked ends it, keeping what was found;
   * it then says it `stopped` at `from`, the range's low end — a continuation scans UPWARD
   * (`restoreFromSeed`), so starting where this downward scan broke off would skip everything
   * below it (fix round 7).
   */
  private async scanRange(
    w: CashuTsWallet,
    seed: RecoverySeed,
    keyset: Keyset,
    from: number,
    to: number,
  ): Promise<Scanned> {
    const found: Found[] = [];
    for (let top = Math.min(to, COUNTER_LIMIT); top > from;) {
      const at = Math.max(from, top - RESTORE_BATCH);
      try {
        found.push(...(await restoreBatch(w, seed, keyset, at, top - at)));
      } catch (e) {
        if (e instanceof RestoreRefused || e instanceof RecoverySeedError) throw e;
        return { found, last: undefined, stopped: from, failed: true };
      }
      top = at;
    }
    return { found, last: undefined, failed: false };
  }

  /**
   * Add what a restore found (ADR 0016 §5, steps 5–6): SPENT proofs dropped (NUT-07; PENDING ones
   * left out too — a melt in flight decides them, and a later restore finds them if it failed),
   * held ones matched by secret and not added twice (a held one the mint reports SPENT leaves the
   * store). At a NUT-12 mint every restored proof carries a DLEQ checked against the claimed
   * amount's key (`restoreBatch`), so it counts as it is: ONE transition, one history line. At a
   * mint without NUT-12 nothing proves an amount, so what is unspent is swapped into fresh outputs
   * of this wallet first (the mint verifies every input): again one history line, the swap's.
   */
  private async adopt(
    w: CashuTsWallet,
    mint: MintUrl,
    found: readonly Found[],
    memo: string,
  ): Promise<RestoreReport> {
    const bySecret = new Map<string, Found>();
    for (const f of found) if (!bySecret.has(f.proof.secret)) bySecret.set(f.proof.secret, f);
    const list = [...bySecret.values()];
    if (list.length === 0) return report(mint, 'nothing', 0);
    const states: string[] = [];
    try {
      for (let i = 0; i < list.length; i += CHECK_CHUNK) {
        const chunk = list.slice(i, i + CHECK_CHUNK);
        const st = await w.checkProofsStates(
          chunk.map((f) => ({ secret: f.proof.secret, id: f.proof.id })),
        );
        if (st.length !== chunk.length) return report(mint, 'refused', 0);
        states.push(...st.map((x) => x.state));
      }
    } catch {
      return report(mint, 'unreachable', 0);
    }
    const held = new Map((await this.ctx.store.proofs(mint)).map((p) => [p.secret, p]));
    const proven = supports(w, 12);
    const spentHeld: CashuProof[] = [];
    const verified: CashuProof[] = [];
    const unverified: Proof[] = [];
    list.forEach((f, i) => {
      const mine = held.get(f.proof.secret);
      if (states[i] === 'SPENT') {
        if (mine !== undefined) spentHeld.push(mine);
      } else if (states[i] === 'UNSPENT' && mine === undefined) {
        if (proven && f.verified) verified.push(fromCashu(f.proof));
        else unverified.push(f.proof);
      }
    });
    let added = proofTotal(verified);
    if (verified.length > 0 || spentHeld.length > 0)
      await this.ctx.store.commit({
        mint,
        spent: spentHeld,
        added: verified,
        ...(verified.length > 0
          ? { history: { direction: 'in' as const, amount: added as Sats, memo } }
          : {}),
      });
    let refused = false;
    if (unverified.length > 0) {
      const total = proofTotal(unverified.map(fromCashu));
      // Dust the mint's input fee would eat entirely is left where it is (not a refusal).
      if (total - feeOf(w, unverified.map(fromCashu)) >= 1) {
        try {
          added += await this.swapIn(w, mint, unverified, memo);
        } catch {
          // The mint refused them (an amount it lied about does not verify), or they were spent
          // meanwhile: they count for nothing.
          refused = true;
        }
      }
    }
    return report(mint, added > 0 ? 'restored' : refused ? 'refused' : 'nothing', added);
  }

  // ---- the journal (ADR 0014) -----------------------------------------------------------

  /** Journal only where the store keeps one and the mint can restore (NUT-09). */
  private journaling(w: CashuTsWallet): boolean {
    return this.ctx.store.pending !== undefined && supports(w, 9);
  }

  private now(): UnixSeconds {
    return this.ctx.now?.() ?? (Math.floor(Date.now() / 1000) as UnixSeconds);
  }

  private newOp(
    kind: PendingOp['kind'],
    mint: MintUrl,
    key: readonly string[],
    keep: readonly OutputDataLike[],
    send: readonly OutputDataLike[],
    spends: readonly CashuProof[],
    seeded: boolean,
  ): PendingOp {
    const first = keep[0] ?? send[0];
    if (first === undefined)
      throw new WalletError('bad-mint-response', 'an operation without outputs');
    return {
      id: first.blindedMessage.B_,
      kind,
      mint,
      key: [...key].sort(),
      keep: keep.map((o) => OutputData.serialize(o)),
      send: send.map((o) => OutputData.serialize(o)),
      spends: [...spends],
      created: this.now(),
      // Only when true, so an unseeded wallet's entries stay exactly as ADR 0014 wrote them.
      ...(seeded ? { seeded: true } : {}),
    };
  }

  private async drop(op: PendingOp): Promise<void> {
    await this.ctx.store.commit({ mint: op.mint, spent: [], added: [], settle: [op.id] });
  }

  /** Commit proofs that came in (receive, mint), settling `op` with them. */
  private async commitIn(mint: MintUrl, fresh: Proof[], memo: string, op?: string): Promise<Sats> {
    const added = fresh.map(fromCashu);
    const got = proofTotal(added) as Sats;
    await this.ctx.store.commit({
      mint,
      spent: [],
      added,
      history: { direction: 'in', amount: got, memo },
      ...(op === undefined ? {} : { settle: [op] }),
    });
    return got;
  }

  /**
   * A journaled request failed. Refused by the mint: nothing executed, the journal entry goes.
   * Otherwise (no answer, or "already signed"): recover what the mint signed; `null` when it
   * signed nothing (yet) — the entry stays, for a retry or a later settle. A counter collision
   * (ADR 0016 §4) throws `CounterCollision` (the entry is gone) for `twice` to run it again.
   */
  private async afterFailure(
    w: CashuTsWallet,
    op: PendingOp,
    e: unknown,
    memo: string,
  ): Promise<Restored | null> {
    if (await this.refused(w, op, e)) {
      await this.drop(op);
      return null;
    }
    const r = await this.resolveSafe(w, op, true, memo);
    if (r.state === 'collision') throw new CounterCollision();
    return r.state === 'executed' ? r : null;
  }

  /**
   * A journaled request failed: was it a plain refusal (nothing executed; the entry can go)? A
   * coded answer other than "already signed" is one — unless the outputs were seeded and the mint
   * holds signatures on them: then another wallet on this phrase signed our counters first
   * (ADR 0016 §4), whatever code the mint uses for that. Found on the real-mint lane: cdk-mintd
   * 0.18.1 answers such a mint or melt request 20006 "Invoice already paid or pending", Nutshell
   * 0.21 answers 11003; only 10002 is the spec's. So seeded outputs are checked by NUT-09 (one
   * request, only on a refusal), and signatures send the failure through `resolve`, which tells a
   * collision (the operation never ran) from our own earlier attempt (it ran).
   */
  private async refused(w: CashuTsWallet, op: PendingOp, e: unknown): Promise<boolean> {
    if (!isDefinitive(e) || isAlreadySigned(e)) return false;
    // Random outputs cannot collide: a coded refusal is a refusal (ADR 0014).
    if (!this.mayCollide(op)) return true;
    try {
      const got = await this.restoreOp(w, op);
      return got === null || (got.keep.length === 0 && got.send.length === 0 && got.foreign === 0);
    } catch {
      return false; // a malformed restore answer: not proof of a plain refusal — resolve decides
    }
  }

  /**
   * Whether signatures on `op`'s outputs may be another wallet's (a NUT-13 collision), so NUT-07
   * must also show it ran: its outputs were derived from a phrase (`PendingOp.seeded`), or this
   * wallet derives from one now — failing closed if a store ever drops the flag. Only an unseeded
   * wallet's unmarked entry (random outputs) is decided on its signatures alone, as in ADR 0014
   * (independent review 2026-09-27, finding 4: the daemons and unseeded wallets).
   */
  private mayCollide(op: PendingOp): boolean {
    return op.seeded === true || this.ctx.mints.seeding !== undefined;
  }

  private async settle(
    mint: MintUrl,
    w: CashuTsWallet,
  ): Promise<{ left: PendingOp[]; recovered: Map<string, number> }> {
    const left: PendingOp[] = [];
    const recovered = new Map<string, number>();
    const ops = this.ctx.store.pending === undefined ? [] : await this.ctx.store.pending(mint);
    for (const op of ops) {
      const r = await this.resolveSafe(w, op, false);
      if (r.state === 'executed')
        recovered.set(opKey(op.kind, op.key), proofTotal(r.keep.map(fromCashu)));
      else if (r.state !== 'absent' && r.state !== 'collision') left.push(op);
    }
    return { left, recovered };
  }

  private async resolveSafe(
    w: CashuTsWallet,
    op: PendingOp,
    fresh: boolean,
    memo?: string,
  ): Promise<Resolution> {
    try {
      return await this.resolve(w, op, fresh, memo);
    } catch {
      return { state: 'unknown' };
    }
  }

  /**
   * One journaled operation: `executed` (what the mint signed is committed now), `waiting`
   * (no trace yet, too young to drop), `absent` (no trace after the wait: dropped, a send's
   * inputs reconciled by NUT-07), `collision` (the mint signed its outputs for another wallet
   * on this phrase, and it never ran: dropped, the counters moved on — ADR 0016 §4) or `unknown`
   * (the mint could not be asked).
   */
  private async resolve(
    w: CashuTsWallet,
    op: PendingOp,
    fresh: boolean,
    memo?: string,
  ): Promise<Resolution> {
    const got = await this.restoreOp(w, op);
    if (got === null) return { state: 'unknown' };
    if (got.keep.length > 0 || got.send.length > 0 || got.foreign > 0) {
      if (this.mayCollide(op)) {
        // Signed outputs prove nothing alone once outputs are derived from a phrase: the mint
        // must also show the operation ran, or those signatures are another wallet's (ADR 0016
        // §4). Random outputs cannot collide, so an unseeded entry skips this and is decided on
        // its signatures alone, as in ADR 0014 — a mint without a working NUT-07 does not strand
        // it (independent review 2026-09-27, finding 4).
        const ran = await this.ran(w, op);
        if (ran === 'unknown') return { state: 'unknown' };
        if (ran === 'pending') return { state: 'waiting' };
        if (ran === 'no') {
          // It never ran and never can (its outputs are signed already): the entry goes, a
          // send's or melt's inputs come back — the mint says they are unspent.
          await this.drop(op);
          await this.advancePast(w, op);
          return { state: 'collision' };
        }
      }
      // It ran, so every output it signed is ours, for the amounts we asked: a signature for
      // another amount or keyset under one of them is a lie (ADR 0014) — the entry is kept for
      // an honest answer (`resolveSafe` reads this as unknown).
      if (got.foreign > 0)
        throw new WalletError('bad-mint-response', 'a restored signature does not match');
      // A restore from the phrase may have added some of these outputs already (this entry was
      // left unresolved then): they are not added, or written into the history, twice
      // (independent review 2026-09-27, finding 8).
      const already = new Set((await this.ctx.store.proofs(op.mint)).map((p) => p.secret));
      const keep = got.keep.map(fromCashu).filter((p) => !already.has(p.secret));
      const kept = proofTotal(keep);
      const out = op.kind === 'send' || op.kind === 'melt';
      await this.ctx.store.commit({
        mint: op.mint,
        spent: [...op.spends],
        added: keep,
        settle: [op.id],
        ...(out
          ? {
              history: {
                direction: 'out' as const,
                amount: Math.max(0, proofTotal(op.spends) - kept) as Sats,
                memo:
                  memo ??
                  (op.kind === 'melt'
                    ? 'melt to Lightning (change recovered)'
                    : op.send.length === 0
                      ? `${REISSUE_MEMO} (recovered)`
                      : 'P2PK send (answer lost, change recovered)'),
              },
            }
          : kept > 0
            ? {
                history: {
                  direction: 'in' as const,
                  amount: kept as Sats,
                  memo: `${memo ?? (op.kind === 'mint' ? 'top-up' : 'received ecash')} (recovered)`,
                },
              }
            : {}),
      });
      return { state: 'executed', keep: got.keep, send: got.send };
    }
    if (fresh) return { state: 'waiting' };
    const young = this.now() - op.created < PENDING_SETTLE_AFTER_S;
    if (op.kind === 'melt') return this.resolveMelt(w, op, young);
    if (young) return { state: 'waiting' };
    if (op.spends.length === 0) {
      await this.drop(op);
      return { state: 'absent' };
    }
    const states = await w.checkProofsStates(
      op.spends.map((p) => ({ secret: p.secret, id: p.id })),
    );
    if (states.length !== op.spends.length) return { state: 'unknown' };
    const gone = op.spends.filter((_p, i) => states[i]?.state === 'SPENT');
    await this.ctx.store.commit({
      mint: op.mint,
      spent: gone,
      added: [],
      settle: [op.id],
      ...(gone.length === 0
        ? {}
        : {
            history: {
              direction: 'out' as const,
              amount: proofTotal(gone) as Sats,
              memo: `lost in a failed mint operation (${String(gone.length)} proofs)`,
            },
          }),
    });
    return { state: 'absent' };
  }

  /**
   * Whether the mint shows `op` ran (ADR 0016 §4): a mint quote ISSUED; a swap's or a melt's
   * inputs all SPENT (a receive's inputs are its key's secrets). `no`: it did not — an atomic
   * operation of ours spends every input — so signatures on its outputs are a collision.
   * `pending`: an input is in flight (a melt paying). `unknown`: the mint could not be asked.
   */
  private async ran(
    w: CashuTsWallet,
    op: PendingOp,
  ): Promise<'yes' | 'no' | 'pending' | 'unknown'> {
    try {
      if (op.kind === 'mint') {
        const [quote] = op.key;
        if (quote === undefined) return 'unknown';
        return (await w.checkMintQuoteBolt11(quote)).state === 'ISSUED' ? 'yes' : 'no';
      }
      // A receive's inputs are not this wallet's proofs: their secrets are the entry's key. The
      // keyset id only picks the hash-to-curve variant (cashu-ts v5); this mint's is secp256k1.
      const id = op.keep[0]?.blindedMessage.id ?? '';
      const inputs =
        op.kind === 'receive'
          ? op.key.map((secret) => ({ secret, id }))
          : op.spends.map((p) => ({ secret: p.secret, id: p.id }));
      if (inputs.length === 0) return 'unknown';
      const states = await w.checkProofsStates(inputs);
      if (states.length !== inputs.length) return 'unknown';
      if (states.every((st) => st.state === 'SPENT')) return 'yes';
      if (states.some((st) => st.state === 'PENDING')) return 'pending';
      return 'no';
    } catch {
      return 'unknown';
    }
  }

  /**
   * After a collision: move this device's counters past whatever the mint signed beyond them
   * (another wallet on this phrase may be ahead). Best effort — a second collision fails the
   * operation instead.
   */
  private async advancePast(w: CashuTsWallet, op: PendingOp): Promise<void> {
    await this.advanceKeysets(
      w,
      op.keep.map((o) => o.blindedMessage.id),
      this.bounded.has(op.mint),
    );
  }

  /**
   * A NON-journaled operation (a store without a journal) was answered "outputs already signed"
   * while its outputs were seeded: every attempt there derives fresh counters (nothing is reused
   * without a journal), so it is never our own earlier attempt — it is a NUT-13 counter collision
   * (ADR 0016 §4). The counters move past what the mint signed and `twice` runs it again; the mint
   * refused the request, so its inputs are unspent (the caller reconciled them). Returns for any
   * other failure.
   */
  private async collided(w: CashuTsWallet, e: unknown, mint: MintUrl): Promise<void> {
    if (!this.seededAt(w) || !isOutputSigned(e)) return;
    let id: string;
    try {
      id = w.getKeyset().id;
    } catch {
      return;
    }
    await this.advanceKeysets(w, [id], this.bounded.has(mint));
    throw new CounterCollision();
  }

  /**
   * Move this device's counters for `ids` past whatever the mint signed beyond them. `capped`
   * (a bounded send holds the mint, `SendBound`): at most one batch, whatever the mint proves.
   */
  private async advanceKeysets(
    w: CashuTsWallet,
    ids: readonly string[],
    capped: boolean,
  ): Promise<void> {
    const s = this.ctx.mints.seeding;
    if (s === undefined) return;
    for (const id of new Set(ids)) {
      try {
        if (!w.keyChain.hasKeyset(id)) continue;
        const keyset = await w.keyChain.ensureKeysetKeys(id);
        const from = (await s.counters.snapshot())[id] ?? 0;
        // Without NUT-12 nothing a mint answers is proven: it may skip at most one batch (the
        // probe's bound, under a restore's gap), never open a gap a later restore stops at. A
        // bounded send asks one batch too: its caller's deadline does not cover 200 (lane W8a).
        const batches =
          supports(w, 12) && !capped
            ? RESTORE_MAX_BATCHES
            : Math.ceil(COUNTER_PROBE_SPAN / RESTORE_BATCH);
        const past = await signedPast(w, s.seed, keyset, from, batches);
        if (past > from) await s.counters.advanceToAtLeast(id, past);
      } catch {
        // the retry reserves fresh counters anyway; a second collision is reported
      }
    }
  }

  /**
   * A journaled melt of which the mint signed no change (yet): its inputs say what happened
   * (NUT-07). PENDING — the payment is in flight: wait, however long. All SPENT after the wait —
   * it paid and no change was signed (none was due): committed as paid. Otherwise, after the wait,
   * like a send the mint never saw: the entry goes, what is still unspent stays.
   */
  private async resolveMelt(w: CashuTsWallet, op: PendingOp, young: boolean): Promise<Resolution> {
    const states = await w.checkProofsStates(
      op.spends.map((p) => ({ secret: p.secret, id: p.id })),
    );
    if (states.length !== op.spends.length) return { state: 'unknown' };
    if (states.some((st) => st.state === 'PENDING') || young) return { state: 'waiting' };
    const gone = op.spends.filter((_p, i) => states[i]?.state === 'SPENT');
    const paid = gone.length === op.spends.length && gone.length > 0;
    await this.ctx.store.commit({
      mint: op.mint,
      spent: gone,
      added: [],
      settle: [op.id],
      ...(gone.length === 0
        ? {}
        : {
            history: {
              direction: 'out' as const,
              amount: proofTotal(gone) as Sats,
              memo: paid
                ? 'melt to Lightning (settled after the answer, no change)'
                : `lost in a failed mint operation (${String(gone.length)} proofs)`,
            },
          }),
    });
    return paid ? { state: 'executed', keep: [], send: [] } : { state: 'absent' };
  }

  /**
   * NUT-09: the proofs the mint signed of `op`'s outputs (cashu-ts unblinds them and checks the
   * DLEQ where the mint sent one). `null` when the mint cannot be asked. A melt's outputs are
   * NUT-08 blanks: the mint assigns their amounts, so a signature's amount is the mint's (its
   * key for that amount checks the DLEQ and unblinds it), where every other output's must match.
   */
  private async restoreOp(
    w: CashuTsWallet,
    op: PendingOp,
  ): Promise<(Restored & { readonly foreign: number }) | null> {
    const outs = [...op.keep, ...op.send].map(fromPending);
    let res: { outputs: { B_: string }[]; signatures: SerializedBlindedSignature[] };
    try {
      res = await w.mint.restore({ outputs: outs.map((o) => o.blindedMessage) });
    } catch {
      return null;
    }
    if (
      !Array.isArray(res.outputs) ||
      !Array.isArray(res.signatures) ||
      res.outputs.length !== res.signatures.length
    )
      throw new WalletError('bad-mint-response', 'restore answered a malformed list');
    // The live answers' rule (cashu-ts `requireSigDleq`): a NUT-12 mint signs with a DLEQ.
    const dleq = supports(w, 12);
    const blanks = op.kind === 'melt';
    const byB = new Map<string, SerializedBlindedSignature>();
    res.outputs.forEach((o, i) => {
      const sig = res.signatures[i];
      if (sig !== undefined) byB.set(o.B_, sig);
    });
    let foreign = 0;
    const proofs = outs.map((o): Proof | null => {
      const sig = byB.get(o.blindedMessage.B_);
      if (sig === undefined) return null;
      if (dleq && sig.dleq === undefined)
        throw new WalletError('bad-mint-response', 'a restored signature has no DLEQ');
      // Signed under another keyset or for another amount than we asked: not OUR operation's
      // signature — another wallet's on the same NUT-13 counters (ADR 0016 §4), or a lie. `resolve`
      // tells the two apart by whether the operation ran.
      if (
        sig.id !== o.blindedMessage.id ||
        (!blanks &&
          Amount.from(sig.amount).toNumber() !== Amount.from(o.blindedMessage.amount).toNumber())
      ) {
        foreign++;
        return null;
      }
      return o.toProof(sig, w.getKeyset(sig.id));
    });
    const n = op.keep.length;
    return {
      keep: proofs.slice(0, n).filter((p): p is Proof => p !== null),
      send: proofs.slice(n).filter((p): p is Proof => p !== null),
      foreign,
    };
  }

  /**
   * After a swap/melt that failed ambiguously: ask the mint which inputs are spent (NUT-07).
   * Unspent inputs stay; spent ones are dropped from the store (they are gone), recorded as a
   * loss. If the state cannot be read either, nothing changes and the inputs are kept.
   */
  private async reconcile(mint: MintUrl, w: CashuTsWallet, inputs: Proof[]): Promise<void> {
    let states: { state: string }[];
    try {
      states = await w.checkProofsStates(inputs);
    } catch {
      return;
    }
    const gone = inputs.filter((_p, i) => states[i]?.state === 'SPENT').map(fromCashu);
    if (gone.length === 0) return;
    await this.ctx.store.commit({
      mint,
      spent: gone,
      added: [],
      history: {
        direction: 'out',
        amount: proofTotal(gone) as Sats,
        memo: `lost in a failed mint operation (${String(gone.length)} proofs)`,
      },
    });
  }
}

interface Restored {
  readonly keep: Proof[];
  readonly send: Proof[];
}

type Resolution =
  | ({ readonly state: 'executed' } & Restored)
  | { readonly state: 'waiting' | 'absent' | 'unknown' | 'collision' };

/**
 * A live operation met a NUT-13 counter collision; its journal entry is gone and the counters
 * moved on. Never leaves the `Spender`: `twice` runs the operation again, or reports it.
 */
class CounterCollision extends Error {
  override readonly name = 'CounterCollision';
}

/** A restore answer that cannot be honest (ADR 0016 §5): nothing from that mint is trusted. */
class RestoreRefused extends Error {
  override readonly name = 'RestoreRefused';
}

/** The history line of a reissue (ADR 0016 D5). */
const REISSUE_MEMO = 'reissued under the recovery phrase';

/** A proof one restore batch recovered, and whether its DLEQ was checked. */
interface Found {
  readonly counter: number;
  readonly proof: Proof;
  readonly verified: boolean;
}

/** One keyset's scan: what it found, its last signed counter, and where it stopped early. */
interface Scanned {
  readonly found: Found[];
  readonly last: number | undefined;
  /** The counter an UPWARD continuation starts from, when the scan did not reach its end. */
  readonly stopped?: number;
  /** It stopped because a batch could not be asked (not the cap). */
  readonly failed: boolean;
}

/**
 * A `resume` from the caller: hex keyset ids → counters inside the counter space, at least one (an
 * empty one would continue nothing and read as "nothing to restore").
 */
function isResume(x: unknown): x is Readonly<Record<string, number>> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const entries = Object.entries(x);
  return (
    entries.length > 0 &&
    entries.every(
      ([k, v]) =>
        /^[0-9a-f]{2,128}$/.test(k) &&
        typeof v === 'number' &&
        Number.isSafeInteger(v) &&
        v >= 0 &&
        v < COUNTER_LIMIT,
    )
  );
}

/** A retry's identity: its sorted keys, unambiguous. */
function keyOf(key: readonly string[]): string {
  return JSON.stringify([...key].sort());
}

/** A recovered operation's identity: its kind and its keys (a mint quote never answers a melt). */
function opKey(kind: PendingOp['kind'], key: readonly string[]): string {
  return `${kind}:${keyOf(key)}`;
}

function fromPending(o: PendingOutput): OutputData {
  return OutputData.deserialize({ ...o, blindedMessage: { ...o.blindedMessage } });
}

/** The journaled outputs of a prior attempt, reused by its retry. */
function reuse(prior: PendingOp | undefined): OutputType | undefined {
  return prior === undefined ? undefined : { type: 'custom', data: prior.keep.map(fromPending) };
}

function sendTx(
  mint: MintUrl,
  selected: Proof[],
  result: { send: Proof[]; keep: Proof[] },
  amount: Sats,
  memo: string,
): WalletTx {
  const sent = result.send.map(fromCashu);
  const keep = result.keep.map(fromCashu);
  const fee = proofTotal(selected.map(fromCashu)) - proofTotal(sent) - proofTotal(keep);
  return {
    mint,
    spent: selected.map(fromCashu),
    added: keep,
    history: { direction: 'out', amount: (amount + Math.max(0, fee)) as Sats, memo },
  };
}

function receiveError(e: unknown): WalletError {
  return isSpentError(e)
    ? new WalletError('spent', 'the mint reports a proof as already spent')
    : new WalletError('mint-error', `receive failed (${errorName(e)})`);
}

/** A NUT in the mint's info (loaded with the mint). Never throws. */
function supports(w: CashuTsWallet, nut: 9 | 12): boolean {
  try {
    return w.getMintInfo().isSupported(nut).supported;
  } catch {
    return false;
  }
}

/**
 * The mint refused the request; nothing executed: it answered with an error code; or cashu-ts
 * wrapped that coded answer — a keyset refusal (12xxx) comes back as a `StaleKeysetError` whose
 * `cause` is the coded error. Only that wrapper: a coded `cause` under any other error is NOT a
 * refusal (cashu-ts's `MeltChangeError` means the melt completed).
 *
 * A coded answer is the mint's answer to OUR request only when the transport sends each request
 * once. Every production transport does (issue #8, fix round 2): the desktop money plane's and the
 * daemons' are `cashuRequestFn` over Node http(s), which never retries, and cashu-ts itself sends a
 * swap, melt or mint once over a custom transport (`withStaleKeysetRepair` does not resend; the
 * NUT-20 legacy fallback resends only after a coded 20008 refusal). cashu-ts's OWN fetch transport
 * retries NUT-19 cached endpoints, and a retry's answer says nothing about the first attempt — it
 * is used by no production wallet.
 *
 * A 429 (`RateLimitError`) is NOT a refusal: a rate limiter may answer the retry of a request that
 * executed, its answer lost (fix round 2: funds lost on cdk-mintd, where a retrying transport met a
 * 429 after the swap had run). It is resolved like any lost answer — held, then NUT-09 / NUT-07.
 */
function isDefinitive(e: unknown): boolean {
  if (hasCode(e)) return true;
  return e instanceof StaleKeysetError && hasCode(e.cause);
}

function hasCode(e: unknown): boolean {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'number';
}

/**
 * The mint already signed these outputs or issued this quote: maybe our own earlier attempt, or a
 * NUT-13 counter collision (`resolve` tells them apart). 11003 is Nutshell 0.21's code for
 * outputs already signed (`isOutputSigned`).
 */
function isAlreadySigned(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const code = (e as { code?: unknown }).code;
  const msg = e instanceof Error ? e.message : '';
  return (
    isOutputSigned(e) ||
    code === 20002 ||
    /already (been )?(signed|issued)|signed before/i.test(msg)
  );
}

/**
 * The mint already signed one of these OUTPUTS — not a quote already issued (20002). The spec's
 * code is 10002; Nutshell 0.21 answers 11003 "outputs have already been signed before." (found on
 * the real-mint lane). Without a journal nothing reuses outputs, so on seeded outputs this is a
 * collision.
 */
function isOutputSigned(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const code = (e as { code?: unknown }).code;
  const msg = e instanceof Error ? e.message : '';
  return code === 10002 || code === 11003 || /already (been )?signed|signed before/i.test(msg);
}

function sameKey(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  // An x-only (32-byte) key matches either compressed form of itself (NIP-61 locks use 02…).
  const strip = (k: string): string => (k.length === 66 ? k.slice(2) : k);
  return strip(x) === strip(y);
}

function isSpentError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const code = (e as { code?: unknown }).code;
  const msg = e instanceof Error ? e.message : '';
  return code === 11001 || /already spent/i.test(msg);
}

function report(mint: MintUrl, outcome: RestoreOutcome, sats: number): RestoreReport {
  return { mint, outcome, restoredSats: sats as Sats };
}

/**
 * A restore's report (what `adopt` added), said to be INCOMPLETE when `stopped` (keyset id →
 * counter) lists keysets a scan did not finish (or the keyset cap left out): the result then
 * carries it as `resume`, and with nothing restored the outcome is never `nothing` — `unreachable`
 * when something could not be asked (`failed`), `refused` when only a cap stopped it (ADR 0016 §5:
 * what a hostile mint looks like, or a history longer than one call scans; independent review
 * 2026-09-27, finding 1; the keyset cap: fix round 7).
 * When what was found could not be added (NUT-07 unreachable, a refused swap) no `resume` is
 * offered: continuing from it would skip what was found, so the caller starts over.
 */
function incomplete(
  r: RestoreReport,
  mint: MintUrl,
  stopped: Readonly<Record<string, number>>,
  failed: boolean,
): RestoreDetail {
  if (Object.keys(stopped).length === 0) return r;
  if (r.outcome === 'unreachable' || r.outcome === 'refused') return r;
  const outcome: RestoreOutcome =
    r.outcome === 'restored' ? 'restored' : failed ? 'unreachable' : 'refused';
  return { ...report(mint, outcome, r.restoredSats), resume: { ...stopped } };
}

/** The mint's input fee for spending `proofs` (cashu-ts: ceil of the summed ppk). */
function feeOf(w: CashuTsWallet, proofs: readonly CashuProof[]): number {
  return proofs.length === 0 ? 0 : w.getFeesForProofs(proofs.map(toCashu)).toNumber();
}

/**
 * The keysets a restore may scan (ADR 0016 §5): the mint's `sat` keysets with a hex v1 or v2 id —
 * those NUT-13 derives for — active ones first. The caller applies the keyset cap and reports what
 * it leaves out.
 */
function restorableKeysets(w: CashuTsWallet): Keyset[] {
  let all: Keyset[];
  try {
    all = w.keyChain.getKeysets();
  } catch {
    return [];
  }
  return all
    .filter((k) => k.unit === 'sat' && k.hasHexId && (k.version === 0 || k.version === 1))
    .sort((a, b) => Number(b.isActive) - Number(a.isActive));
}

/** `count` deterministic outputs of `seed` under `keyset` from `start` (amounts left to the mint). */
function derived(
  seed: RecoverySeed,
  keyset: HasKeysetKeys,
  start: number,
  count: number,
): OutputData[] {
  return OutputData.createDeterministicData(
    0,
    seedBytes(seed),
    start,
    keyset,
    new Array<number>(count).fill(0),
  );
}

/**
 * One NUT-09 batch of `seed`'s outputs `[start, start + count)` under `keyset` (ADR 0016 §5,
 * step 4). Every signature must answer one of OUR blinded messages once, under this keyset, for
 * an amount the keyset has a key for; at a NUT-12 mint it must carry a DLEQ, which cashu-ts
 * checks against the key of the amount the mint CLAIMS — an amount lie fails. Anything else
 * throws `RestoreRefused`; a mint that cannot be asked rejects as the transport does.
 */
async function restoreBatch(
  w: CashuTsWallet,
  seed: RecoverySeed,
  keyset: Keyset,
  start: number,
  count: number,
): Promise<Found[]> {
  const outs = derived(seed, keyset, start, count);
  const res = await w.mint.restore({ outputs: outs.map((o) => o.blindedMessage) });
  if (res.outputs.length !== res.signatures.length || res.outputs.length > outs.length)
    throw new RestoreRefused();
  const index = new Map(outs.map((o, i) => [o.blindedMessage.B_, i]));
  const dleq = supports(w, 12);
  const seen = new Set<number>();
  const found: Found[] = [];
  res.outputs.forEach((o, n) => {
    const sig = res.signatures[n];
    const i = index.get(o.B_);
    const out = i === undefined ? undefined : outs[i];
    if (sig === undefined || i === undefined || out === undefined || seen.has(i))
      throw new RestoreRefused();
    seen.add(i);
    let amount: Amount;
    try {
      amount = Amount.from(sig.amount);
    } catch {
      throw new RestoreRefused();
    }
    const n2 = amount.toNumber();
    if (
      sig.id !== keyset.id ||
      !Number.isSafeInteger(n2) ||
      n2 < 1 ||
      keyset.keys[n2] === undefined ||
      (dleq && sig.dleq === undefined)
    )
      throw new RestoreRefused();
    out.blindedMessage.amount = amount;
    let proof: Proof;
    try {
      proof = out.toProof(sig, keyset); // verifies a DLEQ present against the claimed amount's key
    } catch {
      throw new RestoreRefused();
    }
    found.push({ counter: start + i, proof, verified: sig.dleq !== undefined });
  });
  return found;
}

/**
 * The indices of `outs` a NUT-09 answer shows signed — counting only a signature that answers one
 * of OUR blinded messages, under `keyset`, for an amount the keyset has a key for, and, at a NUT-12
 * mint, carries a DLEQ that verifies against that amount's key (cashu-ts `toProof`). Anything else
 * is skipped, not counted: a mint that copied another mint's public keys (to announce its keyset
 * id) cannot sign under them, so it cannot move a cursor at a NUT-12 mint (independent review
 * 2026-09-27, finding 2). A malformed answer throws.
 */
function signedIndices(
  w: CashuTsWallet,
  keyset: HasKeysetKeys,
  outs: readonly OutputData[],
  res: { outputs: { B_: string }[]; signatures: SerializedBlindedSignature[] },
): number[] {
  if (
    !Array.isArray(res.outputs) ||
    !Array.isArray(res.signatures) ||
    res.outputs.length !== res.signatures.length
  )
    throw new WalletError('bad-mint-response', 'restore answered a malformed list');
  const index = new Map(outs.map((o, i) => [o.blindedMessage.B_, i]));
  const dleq = supports(w, 12);
  const hits: number[] = [];
  res.outputs.forEach((o, n) => {
    const sig = res.signatures[n];
    const i = index.get(o.B_);
    const out = i === undefined ? undefined : outs[i];
    if (sig === undefined || i === undefined || out === undefined || sig.id !== keyset.id) return;
    if (dleq) {
      if (sig.dleq === undefined) return;
      try {
        const a = Amount.from(sig.amount).toNumber();
        if (!Number.isSafeInteger(a) || a < 1 || keyset.keys[a] === undefined) return;
        out.toProof(sig, keyset); // throws unless the DLEQ verifies for the claimed amount
      } catch {
        return;
      }
    }
    hits.push(i);
  });
  return hits;
}

/**
 * The first counter past every one `seed` has signed under `keyset` from `start` on (verified as
 * `signedIndices` says): batches of 100 until one comes back empty, at most `maxBatches`. It
 * trusts the mint only to SKIP counters — one that claims more than it signed just burns them;
 * one that hides some leaves a collision the guard handles.
 */
async function signedPast(
  w: CashuTsWallet,
  seed: RecoverySeed,
  keyset: HasKeysetKeys,
  start: number,
  maxBatches: number,
): Promise<number> {
  let next = start;
  for (let b = 0, at = start; b < maxBatches && at < COUNTER_LIMIT; b++) {
    const count = Math.min(RESTORE_BATCH, COUNTER_LIMIT - at);
    const outs = derived(seed, keyset, at, count);
    const res = await w.mint.restore({ outputs: outs.map((o) => o.blindedMessage) });
    const hits = signedIndices(w, keyset, outs, res);
    if (hits.length === 0) return next;
    next = at + Math.max(...hits) + 1;
    at += count;
  }
  return next;
}

/**
 * The counter source's probe at ONE mint's wallet (`seed.ts` `DurableCounterSource.ensureProbed`,
 * run by the `Spender` for the mint an operation is about to use): what this seed already signed
 * there under a keyset the stored counters do not know — ONE batch of `COUNTER_PROBE_SPAN` (ADR 0016
 * §3), verified signatures only. `undefined` when this mint does not serve the keyset or cannot
 * restore (NUT-09).
 */
export function counterProbe(w: CashuTsWallet, seed: RecoverySeed): CounterProbe {
  return async (keysetId, start) => {
    if (!supports(w, 9) || !w.keyChain.hasKeyset(keysetId)) return undefined;
    const keyset = await w.keyChain.ensureKeysetKeys(keysetId);
    return signedPast(w, seed, keyset, start, Math.ceil(COUNTER_PROBE_SPAN / RESTORE_BATCH));
  };
}

/**
 * cashu-ts's own output construction (`OutputData.create*`), with every deterministic derivation
 * refused unless it is from `seed`'s own live buffer and inside the counter space: cashu-ts holds
 * `bip39seed` by reference, and a wiped seed is zeros — outputs anyone could restore (ADR 0016).
 */
export function seedGuardedOutputs(seed: RecoverySeed): OutputDataCreator {
  // Before deriving: the buffer is this seed's own and live, the counter in range.
  const check = (bytes: Uint8Array, counter: number): void => {
    if (bytes !== seedBytes(seed)) throw new RecoverySeedError('foreign');
    if (!Number.isSafeInteger(counter) || counter < 0 || counter >= COUNTER_LIMIT)
      throw new WalletError('invalid-argument', 'a NUT-13 counter is out of range');
  };
  // After: the whole range stays below 2^31 (a v1 keyset's counter is a hardened index).
  const inRange = (counter: number, n: number): void => {
    if (counter + n > COUNTER_LIMIT)
      throw new WalletError('invalid-argument', 'a NUT-13 counter is out of range');
  };
  return {
    createP2PKData: (p2pk, amount, keyset, split) =>
      OutputData.createP2PKData(p2pk, amount, keyset, split),
    createSingleP2PKData: (p2pk, amount, keysetId) =>
      OutputData.createSingleP2PKData(p2pk, amount, keysetId),
    createRandomData: (amount, keyset, split) => OutputData.createRandomData(amount, keyset, split),
    createSingleRandomData: (amount, keysetId) =>
      OutputData.createSingleRandomData(amount, keysetId),
    createDeterministicData: (amount, bytes, counter, keyset, split) => {
      check(bytes, counter);
      const outs = OutputData.createDeterministicData(amount, bytes, counter, keyset, split);
      inRange(counter, outs.length);
      return outs;
    },
    createSingleDeterministicData: (amount, bytes, counter, keysetId) => {
      check(bytes, counter);
      return OutputData.createSingleDeterministicData(amount, bytes, counter, keysetId);
    },
  };
}

/** A class name for an error message — never the error's own text, which may quote inputs. */
function errorName(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'number' ? `${e.name} ${String(code)}` : e.name;
  }
  return 'unknown error';
}
