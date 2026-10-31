/**
 * The desktop's NUT-13 recovery phrase (ADR 0016, issue #3): one phrase per device, sealed here
 * and copied to the user's relays NIP-44-encrypted to self; the balance held before it reissued
 * once into seeded outputs, the fee shown first; a restore scans every phrase the identity can
 * reach. Core's phrase, seed and restore code (lane N1) is taken by injection (`./core.ts`).
 *
 * Flows (each started by the renderer naming an ACTION, throttled like the signer's connect —
 * a page that keeps re-opening dismissed prompts is paused — and one at a time):
 *
 *   setup    no phrase yet: generate → show it in main's prompt window (`recovery-show`, word
 *            INDICES) → nothing is kept unless the user answers "I wrote them down" or "Later"
 *            (a closed window discards it) → seal it (NIP-44 to self) while no money plane holds
 *            the wallet, and reopen the plane, which now derives from it → publish the relay
 *            copy → confirm three random words (`recovery-confirm`; "Later" leaves it
 *            unconfirmed) → plan the reissue per mint → main's NATIVE dialog shows amounts and
 *            fees → reissue.
 *            A phrase whose reissue did not finish: only the reissue runs again, for the mints
 *            not yet reissued under it (each one recorded in the envelope as it moves).
 *            A finished phrase: rotation — re-authenticate first, then as above; the old phrase
 *            is kept on this device as `.retired` (restore reads it) and its relay copy retired
 *            once the reissue under the new one completed (`replaces`, kept until a relay took
 *            the retirement; the next setup retries it first).
 *   show     re-authenticate (the local key's passphrase in the prompt window; a native confirm
 *            for a remote signer), then show the words again; an unconfirmed backup may be
 *            confirmed then.
 *   restore  requires this device's own phrase in use (the seam's restore lives on the seeded
 *            wallet, docs/archive/contract-requests/N2-nut13-desktop.md item 2); an optional typed phrase
 *            and mint addresses (`recovery-restore`, checksum re-checked here by core), this
 *            device's phrases (current and retired) and every relay copy the identity decrypts —
 *            read ONLY here — each scanned from counter 0 at the wallet's mints and the typed
 *            ones, with progress, and one report row per mint. Lane W8a: a scan core's batch cap
 *            stopped is CONTINUED from where it stopped (core's `resume`), call after call, up to
 *            `RESTORE_ROUNDS` calls per phrase and mint per restore; one still unfinished keeps its
 *            cursor in this process, so the next restore goes on from there.
 *
 * Lane W8a also: nothing moves at a mint while an operation is journaled there, and such a mint —
 * whatever is spendable there, dust or nothing included — keeps the reissue pending while the
 * operation is young and the mint answers; once every entry there is overdue, it counts done — as
 * does any balance at a mint that cannot be asked — but WATCHED: remembered in the envelope
 * (`watchedMints`), and the backup reopens once such a mint shows a spendable balance worth moving;
 * a replaced phrase's relay copy is retired only once nothing at all is left outside the new phrase
 * (the rule: `reissueAll`, `watchCheck`, `outsideLeft`; fix rounds 8 and 9); the relay copy is
 * retried, with a bounded backoff, until a relay took it (`relayCopy` in the envelope is the
 * persisted "pending" flag, and the status reads it), and so are a replaced phrase's retirement and
 * the watched mints — outside the flows' lock, which a flow waits for (bounded) instead of being
 * refused; the play sessions are closed through the worker before a reopen, so their tails carry
 * what the worker reported unpaid.
 *
 * Secrets: the entropy exists as bytes (zeroed after use), inside the NIP-44 plaintext (a JS
 * string, which cannot be wiped: ADR 0016 §2 residual) and as word indices in the prompt form
 * and answer (numbers, zeroed as far as JS allows). No word, index or entropy is ever logged,
 * returned to the renderer or put in an error: the renderer gets states, counts, amounts and its
 * own mint URLs; errors are codes and fixed sentences (anything else becomes `internal`), and
 * log fields are allow-listed reason codes.
 */
import { randomBytes, randomInt } from 'node:crypto';

import type { MintUrl, NostrPubkey, Sats, Signer, UnixSeconds } from '@sovit/core';
import type { wallet as walletMod } from '@sovit/core';
import { nostr, signer as signerMod } from '@sovit/core';

import { RELAY_PUBLISH_WORST_MS } from '../../ipc/deadlines.js';
import { IpcError } from '../../ipc/errors.js';
import { isConfirmForm, isMintUrl, isReissuePlanWire } from '../../ipc/guards.js';
import type {
  ConfirmForm,
  RecoveryProgressWire,
  RecoveryRestoreWire,
  RecoverySetupWire,
  RecoveryStatusWire,
  RestoreOutcomeWire,
} from '../../ipc/protocol.js';
import {
  ERROR_CODES,
  MAX_REISSUE_PLANS,
  RECOVERY_CONFIRM_WORDS,
  RECOVERY_WORDS,
} from '../../ipc/protocol.js';
import { fail, hostError } from '../errors.js';
import type { Logger } from '../log.js';
import type { MoneyPlane } from '../money.js';
import { GateRefusal } from '../pay-melt-gate.js';
import type { MainBridge } from '../signer/main-bridge.js';
import { wipeAnswer } from '../signer/main-bridge.js';
import {
  CANCEL_COOLDOWN_MS,
  CANCEL_LIMIT,
  CANCEL_WINDOW_MS,
  UNLOCK_ATTEMPTS,
} from '../signer/desktop-signer.js';
import type { RecoveryCore } from './core.js';
import { entropyFromHex, entropyHex, sameEntropy, uniqueMints } from './core.js';
import type { RecoveryEnvelope } from './files.js';
import {
  FileCounterStore,
  MAX_REISSUED_MINTS,
  listRetired,
  readEnvelope,
  recoveryPath,
  retireCounters,
  retiredPath,
  unretireCounters,
  writeEnvelope,
} from './files.js';
import type { RecoveryRelays } from './relay-copy.js';
import {
  parseRelayCopy,
  publishRelayCopy,
  readRelayCopies,
  retireRelayCopy,
} from './relay-copy.js';

/** Tries at the three-word confirmation before it counts as "not confirmed". */
export const CONFIRM_ATTEMPTS = 3;

/**
 * Lane W8a: core calls a restore makes per phrase and mint, each bounded by core (at most
 * `RESTORE_MAX_BATCHES` batches of 100 per keyset past this device's own counters), following the
 * `resume` the previous one returned: 10 × 20 000 = 200 000 counters per keyset per restore (about
 * twelve hours of heavy streaming, by lane N1's count). A scan still unfinished keeps its cursor,
 * so the next restore goes on from there. The bound is what a hostile mint that signs everything
 * can add: it holds the restore — and, through the gate, the PAYs at that mint — at most ten times
 * as long as core's own cap did.
 */
export const RESTORE_ROUNDS = 10;

/** Lane W8a: the relay copy's retry backoff — the first wait, doubled up to the last (ms). */
export const RELAY_RETRY_FIRST_MS = 30_000;
export const RELAY_RETRY_MAX_MS = 60 * 60_000;

/**
 * Fix round 9: the retry's longest wait while a finished backup watches a mint (`watchedMints`) —
 * the wallet's own settle loop's longest wait (core's `PENDING_SETTLE_AFTER_S`, 600 s), so inputs
 * an entry gave back reopen the backup at most about that much after the settle that returned them.
 */
export const WATCH_RETRY_MAX_MS = 10 * 60_000;

/**
 * Fix round 9: how long a renderer-started flow waits for a relay copy retry running now before it
 * is refused. The retry's relay work at its worst is three publishes one after another — the copy,
 * then a replaced copy's blank and its deletion — each `RELAY_PUBLISH_WORST_MS`. Past that the
 * retry is stuck: a NIP-46 bunker that never answers its signing request (core's `Nip46Signer` sets
 * no timeout), or a watched mint that does not answer; the flow then answers with a refusal naming
 * the wait, instead of hanging.
 */
export const RELAY_RUN_WAIT_MS = 3 * RELAY_PUBLISH_WORST_MS;

export interface RecoveryTimers {
  /** `fn` returns the work it started (tests' manual timers await it; real timers ignore it). */
  setTimeout(fn: () => unknown, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: RecoveryTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

export interface RecoveryServiceOptions {
  /** Lane N1's code (the wiring point), or `undefined`: no phrase on this build. */
  readonly core: RecoveryCore | undefined;
  /** `<userData>/wallet` (0700). */
  readonly dir: string;
  readonly bridge: MainBridge;
  /** The unlocked signer (`undefined` while signed out or locked). */
  readonly signer: () => Signer | undefined;
  /** That signer's money plane, if its wallet opened. */
  readonly plane: () => MoneyPlane | undefined;
  /**
   * Close the money plane, run `beforeOpen` (no plane holds the wallet then), open it again — it
   * then derives from the phrase `beforeOpen` saved (`DesktopSigner.reopenMoney`). A failure of
   * `beforeOpen` is rethrown once the plane is open again.
   */
  readonly reopenMoney: (beforeOpen?: () => Promise<void>) => Promise<void>;
  /** Re-authentication of a local key: does `passphrase` open `pubkey`'s key file? */
  readonly checkPassphrase: (passphrase: Uint8Array, pubkey: NostrPubkey) => Promise<boolean>;
  readonly relays: RecoveryRelays;
  readonly log: Logger;
  readonly now?: () => UnixSeconds;
  /** The throttle's clock (ms). */
  readonly clock?: () => number;
  /** Tests: randomness for device ids and confirmation positions (default `node:crypto`). */
  readonly random?: {
    readonly bytes: (n: number) => Uint8Array;
    readonly int: (max: number) => number;
  };
  /**
   * Lane W8a (info item): close every play session through the worker before the money plane
   * reopens (setup, rotation, "Finish backup"), bounded by the caller — the worker pays each
   * session's tail and reports what is left unpaid, so the tail authorisation it leaves is that
   * count, not the session's whole remaining budget. Default: nothing to close.
   */
  readonly closeSessions?: () => Promise<void>;
  /** Tests: the relay copy retry's timers (default: `setTimeout`, unref'd). */
  readonly timers?: RecoveryTimers;
}

/** What the money plane opens with when this device has a phrase (`seedFor`). */
export interface PlaneSeed {
  readonly material: walletMod.SeedMaterial;
  readonly core: Pick<RecoveryCore, 'seedOption' | 'seeded'>;
}

const UNAVAILABLE: RecoveryStatusWire = {
  state: 'unavailable',
  reissuePending: false,
  relayCopy: false,
};

/** Outcome precedence when several phrases report on one mint. */
const RANK: Readonly<Record<RestoreOutcomeWire, number>> = {
  nothing: 0,
  unsupported: 1,
  unreachable: 2,
  refused: 3,
  restored: 4,
};

/** Reason codes a log line may carry (allow-list: anything else is logged as `error`). */
const REASONS: ReadonlySet<string> = new Set<string>([
  ...ERROR_CODES,
  'recovery-unreadable',
  'counters-unreadable',
  'journal-unreadable',
  'no-wallet',
]);

/** The allow-listed code of an error — never its message. */
export function reasonOf(e: unknown): string {
  if (e instanceof IpcError) return e.code;
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const p = /^([a-z][a-z0-9-]{0,40}):/.exec(m)?.[1];
  if (p !== undefined && REASONS.has(p)) return p;
  const name = e instanceof Error ? e.name : '';
  return /^[A-Z][A-Za-z]{0,40}Error$/.test(name) ? name : 'error';
}

function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/**
 * Whether a restore call moved the scan on (W8a): a keyset finished (gone from `now`), or one's
 * counter went up. `was` undefined: the first call of this scan, which always counts.
 */
function moved(
  was: Readonly<Record<string, number>> | undefined,
  now: Readonly<Record<string, number>>,
): boolean {
  if (was === undefined) return true;
  for (const [k, c] of Object.entries(was)) {
    const n = now[k];
    if (n === undefined || n > c) return true;
  }
  return false;
}

/** Fix round 9: the mints `env`'s FINISHED backup watches (none while its reissue is pending). */
function watchedOf(env: RecoveryEnvelope): readonly MintUrl[] {
  return env.reissued ? (env.watchedMints ?? []) : [];
}

/** `env` watching exactly `mints` (the field left out when there are none: never empty on disk). */
function withWatched(env: RecoveryEnvelope, mints: readonly MintUrl[]): RecoveryEnvelope {
  const { watchedMints: _dropped, ...rest } = env;
  return mints.length === 0 ? rest : { ...rest, watchedMints: [...mints] };
}

/** A seam `RecoveryPhraseError`'s problem (`length` / `word` / `checksum`), never a word. */
function problemOf(e: unknown): string {
  const p = (e as { problem?: unknown } | null)?.problem;
  return p === 'length' || p === 'word' || p === 'checksum' ? p : 'invalid';
}

export class RecoveryService {
  private readonly o: RecoveryServiceOptions;
  private readonly log: Logger;
  private readonly now: () => UnixSeconds;
  private readonly clock: () => number;
  private readonly random: NonNullable<RecoveryServiceOptions['random']>;
  /** Identities whose phrase file is here but did not open when their plane did. */
  private readonly unreadable = new Set<NostrPubkey>();
  private readonly progress = new Set<(p: RecoveryProgressWire) => void>();
  private busy = false;
  private cancels: number[] = [];
  private coolUntil = 0;
  /**
   * Lane W8a: ONE counters store object per identity in this process (core keeps one live counter
   * source per store object, and refuses a second phrase's while one is open over it).
   */
  private readonly counters = new Map<NostrPubkey, FileCounterStore>();
  /**
   * Lane W8a: where an unfinished restore stopped, per identity, phrase (core's `phraseTag`) and
   * mint — the next restore continues from there. In memory only.
   */
  private readonly resumeAt = new Map<string, Readonly<Record<string, number>>>();
  private readonly timers: RecoveryTimers;
  /** Lane W8a: the relay copy retry, if one is scheduled or running. */
  private retry: { pubkey: NostrPubkey; attempt: number; timer: unknown } | undefined;
  /**
   * Fix round 8 (info item): the relay copy retry running now, if one is. It never takes the flows'
   * lock (`busy`): a flow started meanwhile waits for it (`exclusive`) instead of being refused.
   */
  private relayRun: Promise<unknown> | undefined;
  private stopped = false;

  constructor(o: RecoveryServiceOptions) {
    this.o = o;
    this.log = o.log.child('recovery');
    this.now = o.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds);
    this.clock = o.clock ?? Date.now;
    this.random = o.random ?? {
      bytes: (n) => new Uint8Array(randomBytes(n)),
      int: (max) => randomInt(max),
    };
    this.timers = o.timers ?? realTimers;
  }

  /** Host shutdown: no more relay copy retries. */
  stop(): void {
    this.stopped = true;
    if (this.retry !== undefined) this.timers.clearTimeout(this.retry.timer);
    this.retry = undefined;
  }

  /** This identity's counters store (one object per identity per process; W8a). */
  private countersFor(pubkey: NostrPubkey): FileCounterStore {
    let c = this.counters.get(pubkey);
    if (c === undefined) {
      c = new FileCounterStore(this.o.dir, pubkey);
      this.counters.set(pubkey, c);
    }
    return c;
  }

  // ---- the money plane's seed ------------------------------------------------------------

  /**
   * Called before a money plane opens for `pubkey`: this device's phrase as seed material (the
   * seed in core's secure memory, the counters file), or `undefined` — no phrase support, no
   * phrase, or a phrase file that does not open (then the wallet derives nothing from it: its
   * outputs are random, as without a phrase; the status says `unreadable`, the file is kept, and
   * setup refuses to replace it).
   */
  async seedFor(signer: Signer, pubkey: NostrPubkey): Promise<PlaneSeed | undefined> {
    this.unreadable.delete(pubkey);
    const core = this.o.core;
    if (core === undefined) return undefined;
    let entropy: walletMod.RecoveryEntropy | undefined;
    try {
      const env = await readEnvelope(recoveryPath(this.o.dir, pubkey));
      if (env === null) return undefined;
      entropy = await this.unseal(signer, pubkey, env);
      const seed = await core.phrases.toSeed(entropy);
      // W8a: a relay copy still to publish, or a replaced one still to retire, is retried.
      if (this.relayWorkLeft(env)) this.scheduleRelayRetry(pubkey, false);
      return {
        material: { seed, counters: this.countersFor(pubkey) },
        core,
      };
    } catch (e) {
      this.unreadable.add(pubkey);
      this.log.error(
        'the recovery phrase on this device did not open: new ecash is not covered, and the file is kept',
        { reason: reasonOf(e) },
      );
      return undefined;
    } finally {
      entropy?.fill(0);
    }
  }

  // ---- the renderer's calls --------------------------------------------------------------

  async status(): Promise<RecoveryStatusWire> {
    const plane = this.o.plane();
    if (this.o.core === undefined || plane === undefined || this.o.signer() === undefined)
      return UNAVAILABLE;
    let env: RecoveryEnvelope | null;
    try {
      env = await readEnvelope(recoveryPath(this.o.dir, plane.pubkey));
    } catch {
      return { state: 'unreadable', reissuePending: false, relayCopy: false };
    }
    if (env === null) return { state: 'not-on-device', reissuePending: false, relayCopy: false };
    // W8a: a copy still to publish is being retried (the status says so until a relay took it).
    if (this.relayWorkLeft(env)) this.scheduleRelayRetry(plane.pubkey, false);
    const inUse = !this.unreadable.has(plane.pubkey) && plane.seeded !== undefined;
    return {
      state: !inUse ? 'unreadable' : env.confirmed ? 'covered' : 'not-confirmed',
      reissuePending: !env.reissued,
      relayCopy: env.relayCopy,
    };
  }

  /** New phrase, finish its reissue, or rotate (see the module comment). */
  setup(): Promise<RecoverySetupWire> {
    return this.flow(() => this.setupNow());
  }

  /** Show this device's phrase again, after re-authentication. */
  show(): Promise<undefined> {
    return this.flow(() => this.showNow());
  }

  /** Scan every phrase the identity reaches and add what is unspent and not held. */
  restore(): Promise<RecoveryRestoreWire> {
    return this.flow(() => this.restoreNow());
  }

  /** Topic `recovery.progress`. */
  onProgress(cb: (p: RecoveryProgressWire) => void): () => void {
    this.progress.add(cb);
    return () => {
      this.progress.delete(cb);
    };
  }

  // ---- flows -----------------------------------------------------------------------------

  /** Throttled, one at a time, and nothing but our own coded refusals reaches the renderer. */
  private flow<T>(f: () => Promise<T>): Promise<T> {
    return this.throttled(() => this.exclusive(() => this.guarded(f)));
  }

  private ready(): {
    core: RecoveryCore;
    signer: Signer;
    plane: MoneyPlane;
    pubkey: NostrPubkey;
  } {
    const core = this.o.core;
    if (core === undefined)
      fail('payments-unavailable', 'this build of Nutflix has no recovery phrase support yet');
    const signer = this.o.signer();
    const plane = this.o.plane();
    if (signer === undefined || plane === undefined)
      fail('payments-unavailable', 'connect and unlock a signer with a wallet first');
    return { core, signer, plane, pubkey: plane.pubkey };
  }

  /** This identity's envelope; a file that does not open is `forbidden` (kept, never replaced). */
  private async envelope(pubkey: NostrPubkey): Promise<RecoveryEnvelope | null> {
    try {
      return await readEnvelope(recoveryPath(this.o.dir, pubkey));
    } catch (e) {
      this.log.error('the recovery phrase file on this device cannot be read', {
        reason: reasonOf(e),
      });
      fail(
        'forbidden',
        'the recovery phrase file on this device cannot be read: it is kept and not replaced (see the log)',
      );
    }
  }

  private async setupNow(): Promise<RecoverySetupWire> {
    const { core, signer, pubkey } = this.ready();
    const path = recoveryPath(this.o.dir, pubkey);
    let old = await this.envelope(pubkey);
    if (old !== null && this.unreadable.has(pubkey))
      fail(
        'forbidden',
        'the recovery phrase on this device did not open: it is kept and not replaced (see the log)',
      );
    // A phrase whose reissue did not finish: finish it (nothing is revealed or replaced).
    if (old !== null && !old.reissued) return await this.finishReissue(pubkey, old);
    // A replaced phrase's relay copy whose retirement did not land yet: try again first (best
    // effort, idempotent; only once nothing is left outside the current phrase — `outsideLeft`).
    if (old !== null && old.replaces !== null) old = await this.retireReplaced(pubkey, old);
    // Rotation replaces a working phrase: the user proves it is them first.
    if (old !== null) await this.reauth(signer, pubkey, 'rotate');

    const entropy = core.phrases.generate();
    let words: number[] = [];
    /** The copy handed to main (posted as a structured clone), zeroed once answered. */
    let posted: number[] = [];
    let env: RecoveryEnvelope;
    try {
      words = [...core.phrases.toIndices(entropy)];
      if (words.length !== RECOVERY_WORDS) fail('internal', 'the phrase has the wrong length');
      posted = [...words];
      const shown = await this.o.bridge.ask({ kind: 'recovery-show', words: posted, again: false });
      posted.fill(0);
      if (shown?.kind !== 'recovery-show')
        fail('cancelled', 'the new recovery phrase was discarded (nothing was saved)');
      // From here the phrase is kept: sealed on this device, copied to the relays.
      const created = this.now();
      const sealed = await signer.nip44Encrypt(
        pubkey,
        JSON.stringify({ v: 1, entropy: entropyHex(entropy), created }),
      );
      const fresh: RecoveryEnvelope = {
        v: 1,
        device: hex(this.random.bytes(16)),
        created,
        confirmed: false,
        reissued: false,
        // Every mint's balance is still to be moved under THIS phrase (a rotation included).
        reissuedMints: [],
        relayCopy: false,
        // A replaced phrase's relay copy is retired once the reissue under this one completed and
        // nothing is left outside it. (`old` is a finished phrase here; should ITS replaced copy
        // still be pending — the retry above did not land, or dust or an entry still keeps it
        // (F56) — that older copy is not tracked any more and stays on the relays: a residual.)
        replaces: old === null ? null : old.device,
        sealed,
      };
      await this.closeSessions();
      await this.o.reopenMoney(() => this.saveNew(pubkey, old, fresh));
      const saved = await readEnvelope(path).catch(() => null);
      if (saved?.device !== fresh.device)
        fail('internal', 'the recovery phrase could not be saved (nothing was changed)');
      this.log.info(
        old === null ? 'recovery phrase saved on this device' : 'recovery phrase replaced',
      );
      env = fresh;
      const published = await publishRelayCopy({
        signer,
        relays: this.o.relays,
        device: fresh.device,
        sealed: fresh.sealed,
        now: this.now,
      }).catch(() => false);
      if (published) {
        env = { ...env, relayCopy: true };
        await writeEnvelope(this.o.dir, path, env);
      } else {
        this.log.warn(
          'the recovery phrase copy reached no relay: it is sealed on this device only (retried)',
        );
        // W8a: retried with a backoff until a relay takes it (`relayCopy: false` persists it).
        this.scheduleRelayRetry(pubkey, true);
      }
      if (shown.done && (await this.confirmWords(words))) {
        env = { ...env, confirmed: true };
        await writeEnvelope(this.o.dir, path, env);
      }
    } finally {
      entropy.fill(0);
      words.fill(0);
      posted.fill(0);
    }
    return await this.finishReissue(pubkey, env);
  }

  /**
   * While no plane holds the wallet: keep a replaced phrase as `.retired` (restore still reads
   * it), move its counters aside (the new phrase derives from counter 0), then write the new
   * phrase — putting the counters back if that last write fails, so the old phrase never loses
   * them while it stays current.
   */
  private async saveNew(
    pubkey: NostrPubkey,
    old: RecoveryEnvelope | null,
    fresh: RecoveryEnvelope,
  ): Promise<void> {
    const dir = this.o.dir;
    if (old !== null) await writeEnvelope(dir, retiredPath(dir, pubkey, old.device), old);
    const tag = old?.device ?? hex(this.random.bytes(16));
    const moved = await retireCounters(dir, pubkey, tag);
    try {
      await writeEnvelope(dir, recoveryPath(dir, pubkey), fresh);
    } catch (e) {
      if (moved)
        await unretireCounters(dir, pubkey, tag).catch((u: unknown) => {
          this.log.error('the counters file could not be put back: it is kept aside', {
            reason: reasonOf(u),
          });
        });
      throw e;
    }
  }

  /** D5: move the balance under the phrase (native confirm with the fees); record the outcome. */
  private async finishReissue(
    pubkey: NostrPubkey,
    env: RecoveryEnvelope,
  ): Promise<RecoverySetupWire> {
    // A plane that is not deriving from the phrase yet (its reopen failed, or never ran) opens
    // again first: the reissue must land in seeded outputs.
    const plane = this.o.plane();
    if (plane !== undefined && plane.seeded === undefined) {
      await this.closeSessions();
      await this.o.reopenMoney().catch((e: unknown) => {
        this.log.warn('reopen with the recovery phrase failed', {
          reason: reasonOf(e),
        });
      });
    }
    // Each mint reissued is recorded at once, so a retry (a mint refused or unreachable this
    // time, a plan the dialog cannot show) never moves a covered mint again nor charges its fee
    // twice (fix round 7).
    let cur = env;
    const r = await this.reissueAll(pubkey, env.reissuedMints, async (mint) => {
      cur = { ...cur, reissuedMints: [...cur.reissuedMints, mint] };
      await writeEnvelope(this.o.dir, recoveryPath(this.o.dir, pubkey), cur);
    });
    if (r.complete) {
      // Once the replaced phrase restores nothing held any more — nothing is left outside this
      // one (dust, an overdue entry, a mint that cannot be asked: they finish the backup but keep
      // the copy) — its relay copy goes (best effort, idempotent: a crash before the write below
      // only repeats it), then ONE write records it, the finished reissue and the mints it
      // watches (fix round 9). A copy kept, or a retirement that did not land, keeps `replaces`,
      // so the next setup — and the relay copy retry — tries again (independent review IR7).
      const kept = cur.replaces !== null && (await this.outsideLeft(pubkey, cur));
      if (kept)
        this.log.info(
          'the replaced phrase’s relay copy is kept: dust or an operation in flight is still outside the new phrase',
        );
      const retired =
        cur.replaces === null || (!kept && (await this.retireCopy(pubkey, cur.replaces)));
      await writeEnvelope(
        this.o.dir,
        recoveryPath(this.o.dir, pubkey),
        withWatched({ ...cur, reissued: true, replaces: retired ? null : cur.replaces }, r.watch),
      );
      // W8a: a copy kept or not retired is retried with the relay copy's backoff; fix round 9: so
      // are the watched mints (`watchCheck`).
      if (!retired || r.watch.length > 0) this.scheduleRelayRetry(pubkey, true);
    }
    return {
      status: await this.status(),
      reissuedSats: r.sats as Sats,
      feeSats: r.fee as Sats,
      reissueFailed: r.failed,
    };
  }

  /** Blank and NIP-09-delete a replaced phrase's relay copy; `true` once a relay took both. */
  private async retireCopy(pubkey: NostrPubkey, device: string): Promise<boolean> {
    const signer = this.o.signer();
    const retired =
      signer !== undefined &&
      (await retireRelayCopy({ signer, pubkey, relays: this.o.relays, device, now: this.now }));
    if (!retired) this.log.warn('the replaced phrase’s relay copy may still be on a relay');
    return retired;
  }

  /**
   * Whether anything may still be outside `env`'s phrase (fix round 8, F56): a mint it did not
   * record that holds a spendable balance (dust, inputs an operation gave back, a balance at a
   * mint that could not be asked) or a journal entry — a watched mint (fix round 9) is one of them
   * while it holds either. A mint it recorded was clean when it moved (F55), so what is journaled
   * there since was begun under this phrase. Store reads only, no mint asked; no plane of this
   * identity, or a read that fails, counts as something left.
   */
  private async outsideLeft(pubkey: NostrPubkey, env: RecoveryEnvelope): Promise<boolean> {
    const plane = this.o.plane();
    if (plane?.pubkey !== pubkey) return true;
    try {
      for (const [mint, amount] of await plane.wallet.balances()) {
        if (env.reissuedMints.includes(mint)) continue;
        if (amount > 0 || (await plane.pendingAt(mint)) > 0) return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  /** A finished phrase whose replaced copy is still to be retired: retry, record the outcome. */
  private async retireReplaced(
    pubkey: NostrPubkey,
    env: RecoveryEnvelope,
  ): Promise<RecoveryEnvelope> {
    if (
      env.replaces === null ||
      (await this.outsideLeft(pubkey, env)) ||
      !(await this.retireCopy(pubkey, env.replaces))
    )
      return env;
    const done: RecoveryEnvelope = { ...env, replaces: null };
    await writeEnvelope(this.o.dir, recoveryPath(this.o.dir, pubkey), done);
    this.log.info('the replaced phrase’s relay copy was retired on a retry');
    return done;
  }

  /**
   * Plan and (after the native dialog) reissue every mint's balance not in `done` — the mints
   * already reissued under this phrase — calling `record` after each mint that moved; `watch` is
   * what the backup, once complete, keeps watching (fix round 9).
   *
   * The rule (lane W8a, fix rounds 8 and 9), for each mint of the wallet:
   *   - recorded under this phrase: done, never planned again (fix round 7);
   *   - nothing spendable and nothing journaled: done, not asked;
   *   - the plan fails — the mint cannot be asked (unreachable): done but WATCHED, whatever it
   *     holds, dust included — an entry there never settles while it is down, and it must not keep
   *     the backup (and the next rotation) pending for good (F56, round 9). A balance there still
   *     counts in `reissueFailed` (it is not covered). A plan the PAY/melt gate refused (a PAY
   *     there still building) is not that: it keeps the reissue pending, as before;
   *   - an operation journaled there, after the plan settled what it could: NOTHING moves there
   *     (F55) — a send or melt whose answer is unknown holds inputs the plan leaves out, and a
   *     pending operation's change derives from the phrase it was made under; moved now, the mint
   *     could not be recorded, and every "Finish backup" would move it — and charge its fee —
   *     again (core plans every proof held there, the seeded ones included). And what the entry
   *     holds (a PENDING melt's inputs, a lost send's inputs or change) may come back HERE, under
   *     the phrase it was made under, however little is spendable there now (round 9: F56 counted
   *     dust and empty mints done, and nothing ever moved what came back). A YOUNG entry (under
   *     `PENDING_SETTLE_AFTER_S`: it settles within that, or the mint reports it pending) keeps the
   *     reissue pending (`blocked`); once every entry there is overdue — a melt the mint still
   *     reports PENDING, a mint the settle cannot ask — done but WATCHED, and a balance worth
   *     moving there still counts in `reissueFailed`;
   *   - nothing journaled, nothing worth moving (nothing spendable, or dust: the mint's fee eats
   *     the whole balance): done — never asked, never recorded (F56);
   *   - otherwise planned, asked, moved and recorded.
   * A watched mint keeps "Replace phrase" available and is remembered in the envelope
   * (`watchedMints`): the backup reopens once it shows a spendable balance worth moving
   * (`watchCheck`). What the backup leaves out — dust, a watched mint — keeps a replaced phrase's
   * relay copy (`outsideLeft`). A mint the envelope cannot watch (not https, or the list full)
   * keeps the reissue pending instead, as before.
   */
  private async reissueAll(
    pubkey: NostrPubkey,
    done: readonly MintUrl[],
    record: (mint: MintUrl) => Promise<void>,
  ): Promise<{
    sats: number;
    fee: number;
    failed: number;
    complete: boolean;
    watch: readonly MintUrl[];
  }> {
    const plane = this.o.plane();
    const seeded = plane?.pubkey === pubkey ? plane.seeded : undefined;
    if (plane === undefined || seeded === undefined) {
      this.log.warn('recovery phrase not in use by the wallet yet: nothing reissued');
      return { sats: 0, fee: 0, failed: 0, complete: false, watch: [] };
    }
    let failed = 0;
    const plans: walletMod.ReissuePlan[] = [];
    let balances: ReadonlyMap<MintUrl, Sats>;
    try {
      balances = await plane.wallet.balances();
    } catch (e) {
      this.log.warn('the balances could not be read: nothing was reissued', {
        reason: reasonOf(e),
      });
      return { sats: 0, fee: 0, failed: 0, complete: false, watch: [] };
    }
    let covered = 0;
    let blocked = 0;
    let dust = 0;
    /**
     * Watched mints whose balance stays where it is (a mint that cannot be asked, one worth moving
     * with overdue entries): counted in `reissueFailed` — not covered — but not in `complete`.
     */
    let uncovered = 0;
    const watch: MintUrl[] = [];
    /**
     * The journal entries at `mint`, and how many of them are young (fix round 9). A read that
     * fails counts as one young entry: the mint then keeps the reissue pending, as a live one does.
     */
    const journal = async (mint: MintUrl): Promise<{ entries: number; young: number }> => {
      try {
        const entries = await plane.pendingAt(mint);
        return { entries, young: entries === 0 ? 0 : await plane.youngPendingAt(mint) };
      } catch {
        return { entries: 1, young: 1 };
      }
    };
    /** Watch `mint` (fix round 9); `false` when the envelope cannot record it. */
    const watched = (mint: MintUrl): boolean => {
      if (!isMintUrl(mint) || watch.length >= MAX_REISSUED_MINTS) return false;
      watch.push(mint);
      return true;
    };
    for (const [mint, amount] of balances) {
      // Already under this phrase: its balance is seeded outputs now (fix round 7); it was
      // recorded as it moved, clean (F55).
      if (done.includes(mint)) {
        if (amount > 0) covered++;
        continue;
      }
      // Nothing spendable and nothing journaled: nothing there.
      if (amount <= 0 && (await journal(mint)).entries === 0) continue;
      let p: walletMod.ReissuePlan;
      try {
        p = await seeded.reissuePlan(mint);
      } catch (e) {
        // Cannot be asked: done but watched, whatever it holds (round 9). Not a turn the PAY/melt
        // gate refused (a PAY at this mint still building): that mint answers, so the reissue
        // stays pending, as before — the next "Finish backup" asks it again.
        this.log.warn('no reissue plan at a mint', { reason: reasonOf(e) });
        if (e instanceof GateRefusal || !watched(mint)) failed++;
        else if (amount > 0) uncovered++;
        continue;
      }
      if (p.mint !== mint) continue;
      // Worth moving: the fee below the amount. Otherwise nothing spendable, or dust whose fee
      // would eat it all (never asked).
      const worth = p.amount > 0 && p.feeSats < p.amount;
      if (!worth && p.amount > 0) dust++;
      // An operation still journaled here once the plan settled what it could: nothing moves until
      // it settles (F55), and what it holds may come back here under the phrase it was made under
      // (round 9). A young one keeps the reissue pending; every one overdue, done but watched — a
      // balance worth moving there still counts as not covered.
      const j = await journal(mint);
      if (j.entries > 0) {
        if (j.young > 0 || !watched(mint)) blocked++;
        else if (worth) uncovered++;
        continue;
      }
      // Nothing journaled: dust or nothing is done for the backup (F56)...
      if (!worth) continue;
      // ...and a balance worth moving is asked. Each plan must be one main's dialog can show (an
      // https mint, bounded inputs): one that is not — an http dev mint, say — is left out and
      // counted, and never sinks the question for every other mint (independent review IR1).
      const wire = { mint: p.mint, amount: p.amount, inputs: p.inputs, feeSats: p.feeSats };
      if (isReissuePlanWire(wire)) plans.push(p);
      else {
        failed++;
        this.log.warn(
          'a reissue plan main’s dialog cannot show (not an https mint, or too many inputs): that balance stays uncovered',
        );
      }
    }
    // No more than the envelope has room to record: a mint moved but not recorded would be
    // planned, and charged, again. What is left out is counted (asked on a later retry).
    const room = Math.max(0, MAX_REISSUED_MINTS - done.length);
    const asked = plans.slice(0, Math.min(MAX_REISSUE_PLANS, room));
    failed += plans.length - asked.length;
    if (blocked > 0)
      this.log.info(
        'reissue not complete at some mints: an operation in flight there (Finish backup moves it once it settles)',
        { mints: blocked },
      );
    if (dust > 0)
      this.log.info('dust the mint fee would eat is left outside the recovery phrase', {
        mints: dust,
      });
    if (watch.length > 0)
      this.log.info(
        'some mints count as done for the backup but are watched: an operation there is overdue, or the mint cannot be asked (the backup reopens if a balance worth moving shows there)',
        { mints: watch.length },
      );
    if (asked.length === 0)
      return {
        sats: 0,
        fee: 0,
        failed: failed + blocked + uncovered,
        complete: failed === 0 && blocked === 0,
        watch,
      };
    const ok = await this.confirm({
      kind: 'recovery-reissue',
      plans: asked.map((p) => ({
        mint: p.mint,
        amount: p.amount,
        inputs: p.inputs,
        feeSats: p.feeSats,
      })),
    });
    if (!ok) {
      this.log.info('reissue not confirmed by the user: the balance stays uncovered for now');
      // A declined fee dialog is a dismissed prompt: a renderer that keeps reopening it is
      // paused like any other (independent review IR2). The result still reports the state.
      this.dismissed();
      return {
        sats: 0,
        fee: 0,
        failed: failed + blocked + uncovered + asked.length,
        complete: false,
        watch,
      };
    }
    let sats = 0;
    let fee = 0;
    for (const p of asked) {
      let moved: walletMod.ReissueResult;
      try {
        moved = await seeded.reissue(p);
      } catch (e) {
        failed++;
        this.log.warn('the reissue failed at a mint (its balance stays uncovered)', {
          reason: reasonOf(e),
        });
        continue;
      }
      sats += moved.reissued;
      fee += moved.feeSats;
      // Recorded at once, with no second look at the journal (F55: a mint moved and not recorded
      // is moved, and charged, again). The plan was taken clean, and core's reissue refuses
      // holdings that changed since the plan: an entry there now was begun since, without the
      // planned proofs, on the seeded wallet — under this phrase. The balance is under the phrase
      // whatever happens next; a record that did not land only lets a later retry move this mint
      // once more.
      await record(p.mint).catch((e: unknown) => {
        this.log.warn('a reissued mint could not be recorded: a retry may move it again', {
          reason: reasonOf(e),
        });
      });
    }
    this.log.info('balance reissued under the recovery phrase', {
      mints: asked.length,
      failed,
      blocked,
      covered,
      watched: watch.length,
    });
    return {
      sats,
      fee,
      failed: failed + blocked + uncovered,
      complete: failed === 0 && blocked === 0,
      watch,
    };
  }

  private async showNow(): Promise<undefined> {
    const { core, signer, pubkey } = this.ready();
    const env = await this.envelope(pubkey);
    if (env === null) fail('not-found', 'there is no recovery phrase on this device');
    await this.reauth(signer, pubkey, 'reveal');
    let words: number[] = [];
    let posted: number[] = [];
    let entropy: walletMod.RecoveryEntropy | undefined;
    try {
      try {
        entropy = await this.unseal(signer, pubkey, env);
      } catch (e) {
        this.log.error('the recovery phrase file on this device cannot be read', {
          reason: reasonOf(e),
        });
        fail('forbidden', 'the recovery phrase file on this device cannot be read (see the log)');
      }
      words = [...core.phrases.toIndices(entropy)];
      entropy.fill(0);
      if (words.length !== RECOVERY_WORDS) fail('internal', 'the phrase has the wrong length');
      posted = [...words];
      const a = await this.o.bridge.ask({ kind: 'recovery-show', words: posted, again: true });
      posted.fill(0);
      if (
        a?.kind === 'recovery-show' &&
        a.done &&
        !env.confirmed &&
        (await this.confirmWords(words))
      ) {
        // Re-read: only the confirmation changes (a concurrent write is not expected, but the
        // file is the record).
        const cur = await this.envelope(pubkey);
        if (cur?.device === env.device)
          await writeEnvelope(this.o.dir, recoveryPath(this.o.dir, pubkey), {
            ...cur,
            confirmed: true,
          });
      }
      return undefined;
    } finally {
      entropy?.fill(0);
      words.fill(0);
      posted.fill(0);
    }
  }

  private async restoreNow(): Promise<RecoveryRestoreWire> {
    const { core, signer, plane, pubkey } = this.ready();
    const seeded = plane.seeded;
    if (seeded === undefined)
      fail(
        'invalid-argument',
        'set up this device’s recovery phrase first: a restore runs through the wallet it seeds',
      );
    const a = await this.o.bridge.ask({ kind: 'recovery-restore' });
    if (a?.kind !== 'recovery-restore') fail('cancelled', 'the restore was not started');
    const found: walletMod.RecoveryEntropy[] = [];
    const add = (e: walletMod.RecoveryEntropy): void => {
      if (found.some((f) => sameEntropy(f, e))) e.fill(0);
      else found.push(e);
    };
    try {
      if (a.words.length > 0) {
        let typed: walletMod.RecoveryEntropy;
        try {
          typed = core.phrases.fromIndices(a.words);
        } catch (e) {
          fail('invalid-argument', `the typed words are not a recovery phrase (${problemOf(e)})`);
        } finally {
          (a.words as number[]).fill(0);
        }
        // W8a (info item): the all-zero phrase ("abandon … about") passes the checksum, but its
        // outputs are anyone's and core refuses to use it — said so here, instead of every mint
        // row reading "could not be reached".
        if (typed.every((b) => b === 0)) {
          typed.fill(0);
          fail(
            'invalid-argument',
            'the typed words are the public example phrase: nothing of yours can be restored with it',
          );
        }
        add(typed);
      }
      let localUnreadable = 0;
      const paths = [
        recoveryPath(this.o.dir, pubkey),
        ...(await listRetired(this.o.dir, pubkey).catch(() => [])),
      ];
      for (const p of paths) {
        try {
          const env = await readEnvelope(p);
          if (env !== null) add(await this.unseal(signer, pubkey, env));
        } catch {
          localUnreadable++;
        }
      }
      // ADR 0016 D2: the relay copies are read HERE only — an explicit restore — never at startup.
      let relayUnreadable = 0;
      let relayOmitted = 0;
      try {
        const r = await readRelayCopies({ signer, pubkey, relays: this.o.relays });
        relayUnreadable = r.unreadable;
        relayOmitted = r.omitted;
        for (const c of r.copies) add(entropyFromHex(c.entropy));
      } catch (e) {
        this.log.warn('the relay copies could not be read', { reason: reasonOf(e) });
      }
      const listed = await plane.wallet.mints().catch((): readonly MintUrl[] => []);
      // ADR 0016 §5.1: mints typed in the restore window (main checked them with the same
      // guard; checked again here, https only, normalised like the wallet's own).
      const typed = uniqueMints(
        (a.mints ?? []).flatMap((m) => {
          const n = isMintUrl(m) ? nostr.normalizeMintUrl(m) : null;
          return n?.startsWith('https://') === true ? [n] : [];
        }),
      );
      const mints = uniqueMints([...plane.mints, ...listed, ...typed]);
      const phrases = found.length;
      this.log.info('restoring from recovery phrases', {
        phrases,
        mints: mints.length,
        typedMints: typed.length,
        localUnreadable,
        relayUnreadable,
        relayOmitted,
      });
      const rows = new Map<MintUrl, { outcome: RestoreOutcomeWire; restoredSats: number }>();
      for (const m of mints) rows.set(m, { outcome: 'nothing', restoredSats: 0 });
      let unfinished = 0;
      for (let i = 0; i < found.length; i++) {
        const entropy = found[i];
        if (entropy === undefined) continue;
        const phrase = i + 1;
        let seed: walletMod.RecoverySeed | undefined;
        try {
          seed = await core.phrases.toSeed(entropy);
          entropy.fill(0);
          const pass = await this.restorePass(core, seeded, seed, pubkey, mints, (p) => {
            if (!rows.has(p.mint)) return;
            this.emit({
              phrase,
              phrases,
              mint: p.mint,
              keysetsDone: p.keysetsDone,
              keysets: p.keysets,
            });
          });
          for (const [mint, r] of pass) {
            const row = rows.get(mint);
            if (row === undefined) continue;
            if (Number.isSafeInteger(r.restoredSats) && r.restoredSats > 0)
              row.restoredSats += r.restoredSats;
            if (r.unfinished) unfinished++;
            if (RANK[r.outcome] > RANK[row.outcome]) row.outcome = r.outcome;
          }
        } catch (e) {
          this.log.warn('a restore pass failed', { pass: phrase, reason: reasonOf(e) });
          for (const row of rows.values())
            if (RANK[row.outcome] < RANK.unreachable) row.outcome = 'unreachable';
        } finally {
          entropy.fill(0);
          seed?.wipe();
        }
      }
      if (unfinished > 0)
        this.log.info('a restore is not finished at some mints: the next restore continues it', {
          unfinished,
        });
      const reports = [...rows].map(([mint, r]) => ({
        mint,
        outcome: r.outcome,
        restoredSats: r.restoredSats as Sats,
      }));
      this.log.info('restore finished', {
        phrases,
        restoredMints: reports.filter((r) => r.outcome === 'restored').length,
      });
      return { phrases, reports };
    } finally {
      for (const e of found) e.fill(0);
    }
  }

  /**
   * One phrase at `mints` (W8a): core's restore, CONTINUED from where each mint's scan stopped
   * (`RestoreDetail.resume`) until it is complete — at most `RESTORE_ROUNDS` calls, and only while
   * each call moves the scan on. A mint still unfinished keeps its cursor for the next restore of
   * this identity (and starts from a kept one now). Per mint: the sats added, the outcome — a scan
   * left unfinished with nothing added reads `unreachable` (the wire has no "not finished" yet:
   * docs/archive/contract-requests/W8a-money.md), never core's `refused` for a batch cap it could go on
   * past — and whether it is unfinished.
   */
  private async restorePass(
    core: RecoveryCore,
    seeded: walletMod.CoreSeededWallet,
    seed: walletMod.RecoverySeed,
    pubkey: NostrPubkey,
    mints: readonly MintUrl[],
    onProgress: (p: walletMod.RestoreProgress) => void,
  ): Promise<
    Map<MintUrl, { outcome: RestoreOutcomeWire; restoredSats: number; unfinished: boolean }>
  > {
    const tag = core.phraseTag(seed);
    const key = (m: MintUrl): string => `${pubkey}|${tag}|${m}`;
    const cursors = new Map<MintUrl, Readonly<Record<string, number>>>();
    for (const m of mints) {
      const c = this.resumeAt.get(key(m));
      if (c !== undefined) cursors.set(m, c);
    }
    const out = new Map<
      MintUrl,
      { outcome: RestoreOutcomeWire; restoredSats: number; unfinished: boolean }
    >();
    let todo = [...mints];
    for (let round = 0; round < RESTORE_ROUNDS && todo.length > 0; round++) {
      const resume = new Map([...cursors].filter(([m]) => todo.includes(m)));
      const reports = await seeded.restoreFromSeed(
        seed,
        todo,
        onProgress,
        resume.size > 0 ? { resume } : undefined,
      );
      const next: MintUrl[] = [];
      for (const r of reports) {
        if (!todo.includes(r.mint)) continue;
        const acc = out.get(r.mint) ?? { outcome: 'nothing', restoredSats: 0, unfinished: false };
        if (Number.isSafeInteger(r.restoredSats) && r.restoredSats > 0)
          acc.restoredSats += r.restoredSats;
        const was = cursors.get(r.mint);
        if (r.resume === undefined) {
          // Complete: this call's outcome is the scan's (a tail call's `nothing` does not hide
          // what an earlier call restored: sats decide below).
          cursors.delete(r.mint);
          acc.unfinished = false;
          acc.outcome = r.outcome;
        } else {
          cursors.set(r.mint, r.resume);
          acc.unfinished = true;
          acc.outcome =
            r.outcome === 'refused' || r.outcome === 'nothing' ? 'unreachable' : r.outcome;
          // Go on only while a call moves the scan on (a batch that cannot be asked stops it).
          if (moved(was, r.resume)) next.push(r.mint);
        }
        out.set(r.mint, acc);
      }
      todo = next;
    }
    for (const m of mints) {
      const c = cursors.get(m);
      if (c === undefined) this.resumeAt.delete(key(m));
      else this.resumeAt.set(key(m), c);
    }
    for (const acc of out.values()) if (acc.restoredSats > 0) acc.outcome = 'restored';
    return out;
  }

  /**
   * Lane W8a: close the play sessions through the worker before a reopen (`closeSessions`), so
   * their tails carry what the worker reported unpaid. Best effort: a failure is logged.
   */
  private async closeSessions(): Promise<void> {
    try {
      await this.o.closeSessions?.();
    } catch (e) {
      this.log.warn('the play sessions could not be closed before the reopen', {
        reason: reasonOf(e),
      });
    }
  }

  // ---- the relay copy retry (W8a) ---------------------------------------------------------

  /**
   * A relay copy still to publish, or a replaced one still to retire after the reissue (including
   * one kept while dust or an entry is outside the new phrase: F56, looked at again each retry), or
   * a mint the finished backup watches (fix round 9: `watchCheck`, looked at each retry).
   */
  private relayWorkLeft(env: RecoveryEnvelope): boolean {
    return !env.relayCopy || (env.reissued && (env.replaces !== null || watchedOf(env).length > 0));
  }

  /**
   * Retry the relay copy of `pubkey`'s phrase (and a replaced copy's retirement, and the watched
   * mints) after a bounded backoff: `RELAY_RETRY_FIRST_MS`, doubled per `attempt` up to `maxMs`
   * (`RELAY_RETRY_MAX_MS`; `WATCH_RETRY_MAX_MS` while a mint is watched), for as long as this
   * process runs, until nothing is left. Not `fresh`: nothing changes while a retry of this
   * identity is already scheduled or running. One retry at a time, for the identity asked last.
   */
  private scheduleRelayRetry(
    pubkey: NostrPubkey,
    fresh: boolean,
    attempt = 0,
    maxMs = RELAY_RETRY_MAX_MS,
  ): void {
    if (this.stopped) return;
    const cur = this.retry;
    if (!fresh && cur?.pubkey === pubkey) return;
    if (cur !== undefined && cur.timer !== null) this.timers.clearTimeout(cur.timer);
    const delay = Math.min(maxMs, RELAY_RETRY_FIRST_MS * 2 ** Math.min(attempt, 16));
    const r = { pubkey, attempt, timer: null as unknown };
    r.timer = this.timers.setTimeout(() => {
      r.timer = null;
      return this.relayRetryNow(r);
    }, delay);
    this.retry = r;
  }

  private async relayRetryNow(r: { pubkey: NostrPubkey; attempt: number }): Promise<void> {
    if (this.stopped || this.retry !== r) return;
    const signer = this.o.signer();
    const plane = this.o.plane();
    // Signed out, locked or another identity: the next plane open of this one schedules again.
    if (signer === undefined || plane?.pubkey !== r.pubkey) {
      this.retry = undefined;
      return;
    }
    // A flow is writing the envelope now (or another identity's retry still runs): try again after
    // the next wait.
    if (this.busy || this.relayRun !== undefined) {
      this.scheduleRelayRetry(r.pubkey, true, r.attempt + 1);
      return;
    }
    // Not the flows' lock (fix round 8, info item): a Settings action started during this retry
    // waits for it (`exclusive`, at most `RELAY_RUN_WAIT_MS`: fix round 9) instead of being
    // refused as if a phrase window were open. Set before anything is awaited, so no flow starts
    // between the check above and this line.
    const run = this.relayRetryOnce(signer, r.pubkey);
    this.relayRun = run;
    let next: number | null = RELAY_RETRY_MAX_MS;
    try {
      next = await run;
    } catch (e) {
      this.log.warn('the relay copy retry failed', { reason: reasonOf(e) });
    } finally {
      if (this.relayRun === run) this.relayRun = undefined;
    }
    if (this.retry !== r) return;
    this.retry = undefined;
    if (next !== null) this.scheduleRelayRetry(r.pubkey, true, r.attempt + 1, next);
  }

  /**
   * One retry; while something is still left to do, the longest wait before the next
   * (`WATCH_RETRY_MAX_MS` while a mint is watched, else `RELAY_RETRY_MAX_MS`), `null` once nothing
   * is.
   */
  private async relayRetryOnce(signer: Signer, pubkey: NostrPubkey): Promise<number | null> {
    const path = recoveryPath(this.o.dir, pubkey);
    const env = await readEnvelope(path);
    if (env === null || !this.relayWorkLeft(env)) return null;
    let next = env;
    if (!env.relayCopy) {
      const published = await publishRelayCopy({
        signer,
        relays: this.o.relays,
        device: env.device,
        sealed: env.sealed,
        now: this.now,
      }).catch(() => false);
      if (published) {
        next = { ...next, relayCopy: true };
        this.log.info('the recovery phrase copy reached a relay on a retry');
      }
    }
    // Fix round 9: the mints the finished backup watches — one showing a balance worth moving
    // reopens it (`reissued: false`), and the replaced copy then stays until it completes again.
    if (watchedOf(next).length > 0) next = await this.watchCheck(pubkey, next);
    // A replaced copy goes only once nothing is left outside this phrase (F56: dust spent, entries
    // settled); until then it stays, and is looked at again after the next wait.
    if (
      next.replaces !== null &&
      next.reissued &&
      !(await this.outsideLeft(pubkey, next)) &&
      (await this.retireCopy(pubkey, next.replaces))
    ) {
      next = { ...next, replaces: null };
      this.log.info('the replaced phrase’s relay copy was retired on a retry');
    }
    if (next !== env) await writeEnvelope(this.o.dir, path, next);
    if (!this.relayWorkLeft(next)) return null;
    return watchedOf(next).length > 0 ? WATCH_RETRY_MAX_MS : RELAY_RETRY_MAX_MS;
  }

  /**
   * Fix round 9: look at the mints `env`'s finished backup watches (`watchedMints`), each counted
   * done while an overdue entry there, or a mint that could not be asked, may still give a balance
   * back under the phrase it was made under.
   *   - An entry still journaled there: still watched, nothing asked — nothing can move there until
   *     it settles (F55), so reopening now would only offer a "Finish backup" that moves nothing
   *     and hide "Replace phrase" behind the entry for as long as it lasts (F56's harm).
   *   - No entry and nothing spendable: nothing came back — no longer watched.
   *   - No entry and a spendable balance: planned (the mint asked). Worth moving (the fee below
   *     the amount): the backup REOPENS — `reissued: false`, the list dropped — so the status
   *     offers "Finish backup" again (which re-evaluates every mint not recorded) and a replaced
   *     relay copy stays until it completes. Dust: done, as any dust (F56) — no longer watched. A
   *     plan that fails (still unreachable): still watched.
   * No plane of this identity, or no seeded wallet, or a read that fails: nothing changes. Returns
   * `env` itself when nothing changed.
   */
  private async watchCheck(pubkey: NostrPubkey, env: RecoveryEnvelope): Promise<RecoveryEnvelope> {
    const plane = this.o.plane();
    const seeded = plane?.pubkey === pubkey ? plane.seeded : undefined;
    const mints = watchedOf(env);
    if (plane === undefined || seeded === undefined || mints.length === 0) return env;
    let balances: ReadonlyMap<MintUrl, Sats>;
    try {
      balances = await plane.wallet.balances();
    } catch {
      return env;
    }
    const keep: MintUrl[] = [];
    for (const mint of mints) {
      try {
        if ((await plane.pendingAt(mint)) > 0) {
          keep.push(mint);
          continue;
        }
        if ((balances.get(mint) ?? 0) <= 0) continue;
        const p = await seeded.reissuePlan(mint);
        if (p.mint === mint && p.amount > 0 && p.feeSats < p.amount) {
          this.log.info(
            'a balance worth moving is back at a mint the backup had counted as done: the backup is open again (Finish backup moves it)',
          );
          return withWatched({ ...env, reissued: false }, []);
        }
      } catch {
        keep.push(mint);
      }
    }
    return keep.length === mints.length ? env : withWatched(env, keep);
  }

  // ---- helpers ---------------------------------------------------------------------------

  /** The envelope's entropy, through the signer (NIP-44 to self). */
  private async unseal(
    signer: Signer,
    pubkey: NostrPubkey,
    env: RecoveryEnvelope,
  ): Promise<walletMod.RecoveryEntropy> {
    let text: string;
    try {
      text = await signer.nip44Decrypt(pubkey, env.sealed);
    } catch {
      throw new Error('recovery-unreadable: the phrase does not decrypt with this identity');
    }
    const copy = parseRelayCopy(text);
    if (copy === null) throw new Error('recovery-unreadable: the phrase file is damaged');
    return entropyFromHex(copy.entropy);
  }

  /**
   * Before the phrase is revealed or replaced: the local key's passphrase (`UNLOCK_ATTEMPTS`
   * tries, checked against the key file), or main's native confirm for a remote signer, worded
   * for what follows (`recovery-reveal` / `recovery-rotate`).
   */
  private async reauth(
    signer: Signer,
    pubkey: NostrPubkey,
    purpose: 'reveal' | 'rotate',
  ): Promise<void> {
    if (signer.kind === 'local') {
      for (let attempt = 1; attempt <= UNLOCK_ATTEMPTS; attempt++) {
        const a = await this.o.bridge.ask({ kind: 'recovery-reauth', retry: attempt > 1 });
        if (a?.kind !== 'secret') {
          wipeAnswer(a);
          fail('cancelled', 'the passphrase was not given');
        }
        let ok = false;
        try {
          ok = await this.o.checkPassphrase(a.value, pubkey);
        } catch {
          // A check that failed is a wrong passphrase.
        } finally {
          signerMod.wipe(a.value);
        }
        if (ok) return;
      }
      this.log.warn('re-authentication for the recovery phrase failed (wrong passphrase)');
      fail('forbidden', 'wrong passphrase');
    }
    if (purpose === 'rotate') {
      if (!(await this.confirm({ kind: 'recovery-rotate' })))
        fail('cancelled', 'replacing the recovery phrase was not confirmed');
      return;
    }
    if (!(await this.confirm({ kind: 'recovery-reveal' })))
      fail('cancelled', 'showing the recovery phrase was not confirmed');
  }

  /** Three random positions; `true` when the words typed there match (a few tries). */
  private async confirmWords(words: readonly number[]): Promise<boolean> {
    const pool = Array.from({ length: RECOVERY_WORDS }, (_, i) => i);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = this.random.int(i + 1);
      [pool[i], pool[j]] = [pool[j] ?? 0, pool[i] ?? 0];
    }
    const positions = pool.slice(0, RECOVERY_CONFIRM_WORDS).sort((a, b) => a - b);
    for (let attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt++) {
      const a = await this.o.bridge.ask({
        kind: 'recovery-confirm',
        positions,
        retry: attempt > 1,
      });
      if (a?.kind !== 'recovery-confirm') return false;
      const ok =
        a.words.length === positions.length && positions.every((p, k) => a.words[k] === words[p]);
      (a.words as number[]).fill(0);
      if (ok) {
        this.log.info('recovery phrase backup confirmed');
        return true;
      }
    }
    this.log.info('recovery phrase backup not confirmed (the words did not match)');
    return false;
  }

  /** Main's native dialog, for a form checked like main will check it (never a silent drop). */
  private confirm(form: ConfirmForm): Promise<boolean> {
    if (!isConfirmForm(form)) {
      this.log.warn('a confirm question did not pass the IPC guard: not asked');
      return Promise.resolve(false);
    }
    return this.o.bridge.confirm(form);
  }

  private emit(p: RecoveryProgressWire): void {
    for (const cb of this.progress) {
      try {
        cb(p);
      } catch {
        // a listener's failure is its own
      }
    }
  }

  /**
   * Our own coded refusals (`IpcError`s with fixed sentences) pass; anything else — a library's
   * or core's message, which this code does not control — becomes `internal`, its allow-listed
   * reason logged.
   */
  private async guarded<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof IpcError) throw e;
      this.log.warn('a recovery phrase step failed', { reason: reasonOf(e) });
      throw hostError('internal', 'the recovery phrase step did not finish (see the log)');
    }
  }

  /**
   * A renderer-started flow: refused while cooling down; a dismissed prompt counts (a closed
   * window — a `cancelled` refusal — or a declined native dialog, `dismissed()`).
   */
  private async throttled<T>(f: () => Promise<T>): Promise<T> {
    if (this.clock() < this.coolUntil)
      fail('rate-limited', 'too many dismissed prompts: try again in a minute');
    try {
      return await f();
    } catch (e) {
      if (e instanceof IpcError && e.code === 'cancelled') this.dismissed();
      throw e;
    }
  }

  /** One dismissed prompt: `CANCEL_LIMIT` in `CANCEL_WINDOW_MS` pause every flow a while. */
  private dismissed(): void {
    const t = this.clock();
    this.cancels = [...this.cancels.filter((c) => t - c < CANCEL_WINDOW_MS), t];
    if (this.cancels.length >= CANCEL_LIMIT) {
      this.coolUntil = t + CANCEL_COOLDOWN_MS;
      this.cancels = [];
      this.log.warn('recovery prompts dismissed repeatedly: paused for a minute');
    }
  }

  private async exclusive<T>(f: () => Promise<T>): Promise<T> {
    if (this.busy) fail('rate-limited', 'a recovery phrase window is already open');
    this.busy = true;
    try {
      // Fix round 8 (info item): a relay copy retry writing the envelope now finishes first (a
      // retry never takes `busy`, and never starts while it is set) — fix round 9: for at most
      // `RELAY_RUN_WAIT_MS`, then the flow is refused (`busy` released) instead of hanging.
      const running = this.relayRun;
      if (running !== undefined) await this.awaitRelayRun(running);
      return await f();
    } finally {
      this.busy = false;
    }
  }

  /**
   * Fix round 9: wait for the relay copy retry running now, at most `RELAY_RUN_WAIT_MS`; past that
   * the retry is stuck — a NIP-46 bunker that has not answered its signing request (core's
   * `Nip46Signer` and nostr-tools' `BunkerSigner` set no timeout: a phone asleep or offline, a
   * per-kind approval waiting), or a relay or watched mint that has not — and the flow is refused
   * with a sentence naming that wait, never left hanging. The retry itself runs on (its writes stay
   * serialised: a flow never runs beside it).
   */
  private async awaitRelayRun(running: Promise<unknown>): Promise<void> {
    let timer: unknown;
    const late = await Promise.race([
      running.then(
        () => false,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = this.timers.setTimeout(() => {
          resolve(true);
        }, RELAY_RUN_WAIT_MS);
      }),
    ]);
    this.timers.clearTimeout(timer);
    if (!late) return;
    this.log.warn('a recovery phrase action was refused, as the relay copy retry is still running');
    if (this.o.signer()?.kind === 'nip46')
      fail(
        'remote-signer',
        'your remote signer has not answered the recovery phrase’s relay copy yet (it may be asleep, offline or waiting for your approval): approve it or try again in a minute',
      );
    fail(
      'relay-down',
      'the recovery phrase’s relay copy is still waiting for a relay or a mint to answer: try again in a minute',
    );
  }
}
