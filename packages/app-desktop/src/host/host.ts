/**
 * The host process glue (design §1 Host row, §2, §4): `HostIn` from main → re-validate →
 * dispatch → `HostOut`. Runs unchanged under Electron's `utilityProcess` (`./main.ts` binds it to
 * `process.parentPort`) and under plain Node in tests.
 *
 * Defense in depth: main already checked the sender frame and ran the guards; the host runs
 * `isHostIn` (which re-validates every call's arguments and every sub) again and answers
 * anything malformed with `invalid-argument` instead of acting on it. Every call gets exactly
 * one reply; errors travel as `WireError`s (`toWireError`), never thrown across the hop.
 */
import { join } from 'node:path';

import type { Signer, UnixSeconds } from '@sovit/core';
import { mocks, nostr, signer as signerMod } from '@sovit/core';

import { fromHex } from '../ipc/codec.js';
import { toWireError, wireError } from '../ipc/errors.js';
import { isConfirmForm, isHostIn, isMsgId, isWcId } from '../ipc/guards.js';
import type { AnyCallMsg, HostIn, HostOut, PromptAnswer, ReplyMsg } from '../ipc/protocol.js';
import { IPC_V, LIMITS } from '../ipc/protocol.js';
import { dehydrate } from '../ipc/wiremap.js';
import type { WorkerInit } from '../ipc/worker-protocol.js';
import { WORKER_V } from '../ipc/worker-protocol.js';
import { hostError } from './errors.js';
import { DesktopNetworkAdapter } from './adapter.js';
import { FixtureCatalog } from './catalog/fixture-catalog.js';
import type { HandlerTable } from './dispatch.js';
import { handlers } from './dispatch.js';
import type { HostFlags } from './flags.js';
import { HostArgsError } from './flags.js';
import type { IdentityProvider } from './identity.js';
import { DevViewerIdentity, NoIdentity } from './identity.js';
import { ImageService } from './images/images.js';
import type { ImageTransport } from './images/net.js';
import { httpsTransport } from './images/net.js';
import type { Logger } from './log.js';
import { SettingsStore, loadDesktopConfig } from './settings/settings.js';
import type { RestartPolicy, SpawnWorker, Timers, WorkerState } from './worker/supervisor.js';
import { WorkerSupervisor } from './worker/supervisor.js';
import { MoneyPlane } from './money.js';
import type { MoneyPlaneOptions } from './money.js';
import type { WalletProvider } from './wallet.js';
import {
  JOURNAL_UNREADABLE,
  SwitchingWallet,
  UnavailableWallet,
  createWalletProvider,
  unavailableReason,
} from './wallet.js';
import { WALLET_DIR } from './wallet-journal.js';
import { TAIL_DIR } from './tails.js';
import type { Nip46Connector } from './signer/desktop-signer.js';
import { DesktopSigner } from './signer/desktop-signer.js';
import { MainBridge } from './signer/main-bridge.js';
import type { RecoveryCore } from './recovery/core.js';
import { recoveryCore } from './recovery/core.js';
import { RecoveryService } from './recovery/service.js';
import { TopicRegistry } from './topics.js';
import { AutoTopUp } from './topup/auto-topup.js';
import type { AutoTopUpOptions } from './topup/auto-topup.js';
import { TopUpLedger } from './topup/ledger.js';

export interface HostOptions {
  /** Electron's userData directory (absolute). */
  readonly userData: string;
  readonly flags: HostFlags;
  /** Delivers `HostOut` to main (`parentPort.postMessage`). */
  readonly post: (out: HostOut) => void;
  readonly log: Logger;
  /** The worker's entry script (absolute) and how to spawn it (`spawnBareSidecar`). */
  readonly workerEntry: string;
  readonly spawn: SpawnWorker;
  /** Relay port; default `SimplePoolAdapter` (or an offline `FakeRelayPool` with fixtures). */
  readonly pool?: nostr.PoolLike;
  readonly imageTransport?: ImageTransport;
  /**
   * Signer seam. Default: the desktop signer flow (ADR 0013) — `DevViewerIdentity` with
   * `--dev-mocks`. A test that injects one gets a fixed signer (no connect flow).
   */
  readonly identity?: IdentityProvider;
  /** Tests: the desktop signer's NIP-46 connector and KDF floor. */
  readonly nip46?: Nip46Connector;
  readonly signerCost?: signerMod.KdfCost;
  /**
   * Tests: the mint transport of the money plane (the in-process `TestMint`). Default: the money
   * plane's own single-attempt `node:http(s)` transport (`mint-transport.ts`).
   */
  readonly mintRequest?: MoneyPlaneOptions['mintRequest'];
  readonly timers?: Timers;
  readonly restart?: RestartPolicy;
  readonly random?: (n: number) => Uint8Array;
  readonly now?: () => UnixSeconds;
  readonly workerStartTimeoutMs?: number;
  /** Tests: the auto top-up's wall clock (ms, shared with its ledger) and target polling. */
  readonly topUp?: Pick<
    AutoTopUpOptions,
    'now' | 'sleep' | 'pollAttempts' | 'pollIntervalMs' | 'playWaitMs'
  >;
  /**
   * ADR 0016: core's NUT-13 code. Default: the wiring point `recoveryCore()` (lane N1; `undefined`
   * before it merges). Tests inject fakes; `null` = explicitly none.
   */
  readonly recoveryCore?: RecoveryCore | null;
}

/**
 * Fix round 4: how long an app quit waits, at most, for the open play sessions' tails to be paid
 * (the worker drains each session for up to its `CLOSE_DRAIN_MS`, 5 s, in parallel) before the
 * worker is stopped (`Host.shutdown`, run by the entry `main.ts` on SIGTERM). Main waits a little
 * longer for this process to exit (`QUIT_GRACE_MS`, main.ts). Here, not in the entry module, whose
 * exports the packaged bundle pins to `runHost` (lane R6-reconcile).
 */
export const QUIT_FLUSH_MS = 7000;

export class Host {
  readonly adapter: DesktopNetworkAdapter;
  readonly worker: WorkerSupervisor;
  readonly topics: TopicRegistry;
  /** ADR 0013: main's prompt window and keychain, and the signer flow using them. */
  readonly bridge: MainBridge | undefined;
  readonly signerFlow: DesktopSigner | undefined;
  /** ADR 0016: the recovery phrase (with the signer flow only). */
  readonly recovery: RecoveryService | undefined;
  private readonly images: ImageService;
  /** Posts to main (dropped once stopped; a throwing transport is logged, never rethrown). */
  readonly post: (out: HostOut) => void;
  private readonly log: Logger;
  private readonly table: HandlerTable;
  private readonly inflight = new Map<number, number>();
  private stopped = false;

  constructor(parts: {
    readonly adapter: DesktopNetworkAdapter;
    readonly worker: WorkerSupervisor;
    readonly images: ImageService;
    readonly post: (out: HostOut) => void;
    readonly log: Logger;
    readonly bridge?: MainBridge;
    readonly signerFlow?: DesktopSigner;
    readonly recovery?: RecoveryService;
  }) {
    this.adapter = parts.adapter;
    this.worker = parts.worker;
    this.images = parts.images;
    this.bridge = parts.bridge;
    this.signerFlow = parts.signerFlow;
    this.recovery = parts.recovery;
    this.post = (out) => {
      if (this.stopped) return;
      try {
        parts.post(out);
      } catch {
        this.log.error('could not post to main');
      }
    };
    this.log = parts.log;
    this.table = handlers(this.adapter);
    this.topics = new TopicRegistry(this.adapter, this.post, this.log);
  }

  /** One message from main. Never throws. */
  handle(raw: unknown): void {
    if (this.stopped) return;
    if (!isHostIn(raw)) {
      this.refuse(raw);
      return;
    }
    const msg: HostIn = raw;
    switch (msg.kind) {
      case 'call':
        void this.call(msg.wc, msg.msg, msg.file);
        return;
      case 'sub':
        this.sub(msg.wc, msg.msg);
        return;
      case 'wc-gone':
        void this.wcGone(msg.wc);
        return;
      case 'image':
        void this.serveImage(msg.req, msg.id);
        return;
      case 'prompt-answer':
        if (this.bridge === undefined) signerMod.wipe(secretOf(msg.answer));
        else this.bridge.onPromptAnswer(msg.req, msg.answer);
        return;
      case 'keychain-result':
        if (this.bridge === undefined) signerMod.wipe(msg.value);
        else this.bridge.onKeychainResult(msg.req, msg.ok, msg.value);
        return;
      case 'confirm-result':
        this.bridge?.onConfirmResult(msg.req, msg.ok);
        return;
    }
  }

  /**
   * Fix round 4 (quit): close every play session through the worker first — it pays each
   * session's tail before it answers, and only then is the session revoked — bounded by `ms`;
   * then `stop()`. What the SIGTERM of an app quit runs.
   */
  async shutdown(ms: number): Promise<void> {
    if (!this.stopped) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.adapter.closeAllSessions().catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, ms));
        }),
      ]);
      clearTimeout(timer);
    }
    this.stop();
    // Lane P2-owed-viewer: the sessions just closed (or dropped by `stop`) keep their tails on
    // disk before the process exits. A private-file write: bounded by the disk, not the network.
    // `stop` has dropped the signer flow's plane by now: the adapter also waits for the writes of
    // planes the flow closed (independent review, MEDIUM).
    await this.adapter.flushTails().catch(() => undefined);
  }

  stop(): void {
    this.bridge?.cancelAll();
    // W8a: no relay copy retry after the stop.
    this.recovery?.stop();
    void this.signerFlow?.close();
    this.worker.stop();
    this.adapter.onWorkerDown();
    this.stopped = true;
  }

  // ---- calls -----------------------------------------------------------------------------

  private async call(
    wc: number,
    msg: AnyCallMsg,
    file: { readonly path: string; readonly name: string; readonly size: number } | undefined,
  ): Promise<void> {
    const reply = (r: ReplyMsg): void => {
      this.post({ kind: 'reply', wc, msg: r });
    };
    const n = this.inflight.get(wc) ?? 0;
    if (n >= LIMITS.inflightPerWc) {
      reply({
        v: IPC_V,
        id: msg.id,
        ok: false,
        error: wireError('rate-limited', 'too many calls'),
      });
      return;
    }
    if (file !== undefined && msg.method !== 'studio.upload') {
      reply({
        v: IPC_V,
        id: msg.id,
        ok: false,
        error: wireError('invalid-argument', 'a file may only accompany studio.upload'),
      });
      return;
    }
    this.inflight.set(wc, n + 1);
    try {
      const handler = this.table[msg.method] as (
        ctx: { wc: number; file?: typeof file },
        args: unknown,
      ) => Promise<unknown>;
      const result = await handler(file === undefined ? { wc } : { wc, file }, msg.args);
      reply({ v: IPC_V, id: msg.id, ok: true, result: dehydrate(result) });
    } catch (e) {
      reply({ v: IPC_V, id: msg.id, ok: false, error: toWireError(e) });
    } finally {
      const left = (this.inflight.get(wc) ?? 1) - 1;
      if (left <= 0) this.inflight.delete(wc);
      else this.inflight.set(wc, left);
    }
  }

  // ---- subscriptions ---------------------------------------------------------------------

  private sub(wc: number, msg: Extract<HostIn, { kind: 'sub' }>['msg']): void {
    const ack = (r: ReplyMsg): void => {
      this.post({ kind: 'sub-reply', wc, msg: r });
    };
    try {
      if (msg.op === 'sub') this.topics.sub(wc, msg.subId, msg.topic);
      else this.topics.unsub(wc, msg.subId);
      ack({ v: IPC_V, id: msg.subId, ok: true, result: undefined });
    } catch (e) {
      ack({ v: IPC_V, id: msg.subId, ok: false, error: toWireError(e) });
    }
  }

  private async wcGone(wc: number): Promise<void> {
    this.topics.dropWc(wc);
    this.inflight.delete(wc);
    await this.adapter.sessions.closeOwner(wc);
  }

  private async serveImage(req: number, id: string): Promise<void> {
    const img = await this.images.serve(id).catch(() => null);
    this.post({ kind: 'image', req, bytes: img?.bytes ?? null, type: img?.type ?? null });
  }

  /** A message that failed `isHostIn`: answer it if it can be answered, else just log it. */
  private refuse(raw: unknown): void {
    this.log.warn('refused a malformed message from main');
    if (typeof raw !== 'object' || raw === null) return;
    const r = raw as { kind?: unknown; wc?: unknown; msg?: unknown; req?: unknown };
    const inner = (typeof r.msg === 'object' && r.msg !== null ? r.msg : {}) as {
      id?: unknown;
      subId?: unknown;
    };
    const error = wireError('invalid-argument', 'malformed message');
    if (r.kind === 'call' && isWcId(r.wc) && isMsgId(inner.id))
      this.post({ kind: 'reply', wc: r.wc, msg: { v: IPC_V, id: inner.id, ok: false, error } });
    else if (r.kind === 'sub' && isWcId(r.wc) && isMsgId(inner.subId))
      this.post({
        kind: 'sub-reply',
        wc: r.wc,
        msg: { v: IPC_V, id: inner.subId, ok: false, error },
      });
    else if (r.kind === 'image' && isMsgId(r.req))
      this.post({ kind: 'image', req: r.req, bytes: null, type: null });
  }
}

/**
 * Builds and starts the host: settings + desktop config from userData, the relay pool, the
 * wallet provider, images, the adapter, and the supervised worker (spawned immediately).
 */
export async function createHost(o: HostOptions): Promise<Host> {
  const log = o.log;
  const flags = o.flags;
  // The dev fences hold for programmatic callers too, not only for parseHostArgs (design §5a, D1).
  if (flags.devFixtures && !flags.devMocks)
    throw new HostArgsError('--dev-fixtures is refused without --dev-mocks');
  if (flags.devBootstrap !== undefined && !flags.devMocks)
    throw new HostArgsError('--dev-bootstrap is refused without --dev-mocks');
  if (flags.devMocks)
    log.warn('DEV MOCKS ON: fake sats, fixture viewer identity (never in production)');
  const settings = new SettingsStore(o.userData, log);
  await settings.load();
  const desktop = await loadDesktopConfig(o.userData, log.child('desktop'));
  const storage = join(o.userData, 'worker');
  const fixtures = flags.devFixtures
    ? new FixtureCatalog(log, o.timers === undefined ? {} : { timers: o.timers })
    : undefined;
  // --dev-fixtures runs the relay layer OFFLINE (in-memory), so a dev/e2e run never touches the
  // public network; FakeRelayPool is L1's offline pool.
  const pool =
    o.pool ?? (flags.devFixtures ? new nostr.FakeRelayPool() : new nostr.SimplePoolAdapter());
  // The supervisor, the adapter, main's link and the signer refer to each other; bound once built.
  const late: {
    adapter?: DesktopNetworkAdapter;
    post?: (out: HostOut) => void;
    worker?: WorkerSupervisor;
    autoTopUp?: AutoTopUp;
    recovery?: RecoveryService;
  } = {};
  const walletDir = join(o.userData, WALLET_DIR);
  const openMoney = async (signer: Signer, create: boolean): Promise<MoneyPlane> => {
    // ADR 0016: this device's recovery phrase, when it has one (the plane owns the seed).
    const seed =
      late.recovery === undefined
        ? undefined
        : await late.recovery.seedFor(signer, await signer.getPublicKey());
    try {
      return await openPlane(signer, create, seed);
    } catch (e) {
      seed?.material.seed.wipe();
      throw e;
    }
  };
  const openPlane = (
    signer: Signer,
    create: boolean,
    seed: Awaited<ReturnType<RecoveryService['seedFor']>>,
  ): Promise<MoneyPlane> =>
    MoneyPlane.open({
      signer,
      pool,
      relays: () => settings.get().relays,
      defaultMints: () => settings.get().defaultMints,
      log: log.child('money'),
      // ADR 0014 amendment (issue #8): the wallet journal, sealed, per identity.
      journalDir: walletDir,
      // Lane P2-owed-viewer: closed sessions' tail authorisations, per identity.
      tailDir: join(o.userData, TAIL_DIR),
      ...(create ? { createWallet: true } : {}),
      ...(seed === undefined ? {} : { seed }),
      ...(o.mintRequest === undefined ? {} : { mintRequest: o.mintRequest }),
      ...(o.now === undefined ? {} : { now: o.now }),
      // Issue #2: a PAY for an open play session is what an auto top-up follows (never a mere
      // balance change — independent review, finding 1).
      onPayment: (mint) => {
        void late.autoTopUp?.paymentAt(mint);
      },
    });

  // ADR 0013: without an injected signer and without --dev-mocks, the user connects one through
  // main's trusted prompt window, and the money plane follows it. Issue #2: the prompt window
  // also asks before the first auto top-up into a mint, so it exists whenever real money can
  // move (an injected signer too), never with --dev-mocks.
  const switching = new SwitchingWallet();
  const bridge: MainBridge | undefined = flags.devMocks
    ? undefined
    : new MainBridge({
        post: (out) => late.post?.(out),
        ...(o.timers === undefined ? {} : { timers: o.timers }),
      });
  let signerFlow: DesktopSigner | undefined;
  if (o.identity === undefined && bridge !== undefined) {
    const flow: DesktopSigner = new DesktopSigner({
      dir: join(o.userData, 'signer'),
      bridge,
      keychain: flags.keychain === true,
      log,
      openMoney,
      swap: async (change) => {
        const run = async (): Promise<void> => {
          await change();
          switching.set(flow.money()?.wallet, unavailableReason(flow.moneyError()));
          if ((flow.money()?.mints.length ?? 1) === 0)
            log.warn('the wallet lists no mints: payments stay off until one is added in Settings');
          // Round 4: the new plane's identity finishes its open top-ups (an unlock, a swap).
          void late.autoTopUp?.resume();
        };
        await (late.worker === undefined ? run() : late.worker.restart(run));
      },
      ...(o.nip46 === undefined ? {} : { nip46: o.nip46 }),
      ...(o.signerCost === undefined ? {} : { cost: o.signerCost }),
    });
    signerFlow = flow;
  }
  // ADR 0016: the recovery phrase follows the signer flow (it reopens that flow's money plane).
  let recovery: RecoveryService | undefined;
  if (signerFlow !== undefined && bridge !== undefined) {
    const flow = signerFlow;
    recovery = new RecoveryService({
      core: o.recoveryCore === undefined ? recoveryCore() : (o.recoveryCore ?? undefined),
      dir: walletDir,
      bridge,
      signer: () => flow.signer(),
      plane: () => flow.money(),
      reopenMoney: (beforeOpen) => flow.reopenMoney(beforeOpen),
      checkPassphrase: async (passphrase, pubkey) => {
        const file = await flow.keyStore.read();
        if (file === null) return false;
        try {
          const k = await signerMod.openKeyFile(file, passphrase);
          signerMod.wipe(k.secretKey);
          signerMod.wipe(k.walletKey);
          return k.header.pubkey === pubkey;
        } catch {
          return false;
        }
      },
      relays: {
        pool,
        write: () =>
          settings
            .get()
            .relays.filter((r) => r.write)
            .map((r) => r.url),
        read: () =>
          settings
            .get()
            .relays.filter((r) => r.read)
            .map((r) => r.url),
      },
      log,
      ...(o.now === undefined ? {} : { now: o.now }),
      // W8a (final review, info): before the plane reopens, the play sessions close through the
      // worker — it pays each tail and says what is left unpaid, which the tail then carries (not
      // the session's whole remaining budget) — bounded like a quit's.
      closeSessions: async () => {
        const adapter = late.adapter;
        if (adapter === undefined) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          adapter.closeAllSessions().catch(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, QUIT_FLUSH_MS);
          }),
        ]);
        clearTimeout(timer);
      },
    });
    late.recovery = recovery;
  }
  const identity: IdentityProvider =
    signerFlow ??
    o.identity ??
    (flags.devMocks ? new DevViewerIdentity(mocks.ME) : new NoIdentity());

  // An injected signer (tests; never with --dev-mocks) opens its money plane once, here.
  const injected = flags.devMocks || signerFlow !== undefined ? undefined : identity.signer();
  let fixedMoney: MoneyPlane | undefined;
  let fixedMoneyError: string | null = null;
  if (injected !== undefined)
    try {
      fixedMoney = await openMoney(injected, false);
    } catch (err) {
      // The code prefix only (`wallet-unreadable`, `relay-down`, …): never a key or a proof.
      const reason =
        err instanceof Error ? (/^[a-z-]+(?=:)/.exec(err.message)?.[0] ?? err.name) : 'unknown';
      fixedMoneyError = reason;
      log.error('the wallet could not be opened: payments stay unavailable', { reason });
    }
  if (fixedMoney?.mints.length === 0)
    log.warn(
      'the wallet lists no mints: streaming payments stay off until one is added in Settings',
    );
  const money = (): MoneyPlane | undefined => signerFlow?.money() ?? fixedMoney;
  const walletProvider: WalletProvider =
    signerFlow !== undefined
      ? { kind: 'real', wallet: switching }
      : fixedMoney === undefined
        ? fixedMoneyError === 'journal-unreadable'
          ? { kind: 'unavailable', wallet: new UnavailableWallet(JOURNAL_UNREADABLE) }
          : createWalletProvider(flags.devMocks)
        : { kind: 'real', wallet: fixedMoney.wallet };
  // Issue #2: auto top-ups execute with the user's REAL wallet only, behind the persisted
  // ledger's caps and the first-funding question in main's prompt window.
  const topUpNow = o.topUp?.now ?? Date.now;
  const autoTopUp =
    walletProvider.kind === 'real'
      ? new AutoTopUp({
          settings: () => settings.get(),
          // The money plane's own wallet (per signer), never the switching facade: a run stays
          // with the wallet it started with. A closed plane (signed out, locked) is no wallet: a
          // run in flight then stops before the melt.
          wallet: () => money()?.liveWallet,
          // Round 4: the same plane's identity, sealing and journal — for its live wallet only
          // (an open top-up is finished by its own identity, whichever wallet instance).
          vault: (w) => {
            const m = money();
            return m?.liveWallet === w ? m.topUpVault() : undefined;
          },
          ledger: await TopUpLedger.open(o.userData, log, topUpNow),
          ...(bridge === undefined
            ? {}
            : {
                askFirstFunding: async (q) => {
                  const a = await bridge.ask({ kind: 'top-up-first', ...q });
                  return a?.kind === 'top-up-first' && a.confirm;
                },
                // R5-R1: main's native dialog; a form main would refuse is never asked.
                confirmResume: async (q) => {
                  const form = { kind: 'topup-resume' as const, ...q };
                  return isConfirmForm(form) && (await bridge.confirm(form));
                },
              }),
          log,
          // Picked, never spread: a test hook must not be able to replace the question, the
          // wallet or the settings the top-up is checked against.
          now: topUpNow,
          ...(o.topUp?.sleep === undefined ? {} : { sleep: o.topUp.sleep }),
          ...(o.topUp?.pollAttempts === undefined ? {} : { pollAttempts: o.topUp.pollAttempts }),
          ...(o.topUp?.pollIntervalMs === undefined
            ? {}
            : { pollIntervalMs: o.topUp.pollIntervalMs }),
          ...(o.topUp?.playWaitMs === undefined ? {} : { playWaitMs: o.topUp.playWaitMs }),
        })
      : undefined;
  if (autoTopUp !== undefined) {
    late.autoTopUp = autoTopUp;
    // An injected signer's plane opened above: finish its open top-ups (after its settle).
    void autoTopUp.resume();
  }
  const images = new ImageService({
    transport: o.imageTransport ?? httpsTransport(),
    log,
    fileRoot: storage,
    // Security review F18: unsigned images only when the user opted in (Settings).
    remoteImages: () => settings.get().loadRemoteImages,
    // ADR 0015: a creator's profile-core image, read over Pear by the worker.
    fetchHyper: async (url, sha256, size) => {
      const w = late.worker;
      if (w === undefined) throw hostError('backend-down', 'worker is not running');
      const { hex } = await w.request('image.fetch', { url, sha256, size });
      return fromHex(hex);
    },
    ...(o.random === undefined ? {} : { random: o.random }),
  });

  const worker = new WorkerSupervisor({
    spawn: o.spawn,
    entry: o.workerEntry,
    log,
    init: (): WorkerInit => {
      const s = settings.get();
      return {
        v: WORKER_V,
        storage,
        seeding: s.seeding,
        prefetchSeconds: s.prefetchSeconds,
        ...(desktop.ffmpeg === undefined ? {} : { ffmpeg: desktop.ffmpeg }),
        // Payments need at least one mint to pay at and be paid at (Settings → mints).
        ...paymentsInit(money()),
        ...(flags.devMocks || flags.devFixtures
          ? {
              dev: {
                mocks: flags.devMocks,
                fixtures: flags.devFixtures,
                ...(flags.devBootstrap === undefined ? {} : { bootstrap: flags.devBootstrap }),
              },
            }
          : {}),
      };
    },
    onEvent: (ev) => late.adapter?.onWorkerEvent(ev),
    onState: (s: WorkerState) => {
      log.info('media worker state', { state: s });
      if (s === 'down' || s === 'failed' || s === 'stopped') late.adapter?.onWorkerDown();
      // `down` restarts (and re-announces); `failed`/`stopped` never will: stop the catalogue
      // waiting for fixtures that are not coming.
      if (s === 'failed' || s === 'stopped') fixtures?.workerGone();
    },
    // Read per request: the money handlers follow the signer (ADR 0013).
    handlers: () => ({
      ...(money()?.handlers() ?? {}),
      'studio.publish': (draft) => {
        if (late.adapter === undefined) return Promise.reject(new Error('host not ready'));
        return late.adapter.publishUpload(draft);
      },
    }),
    ...(o.timers === undefined ? {} : { timers: o.timers }),
    ...(o.restart === undefined ? {} : { restart: o.restart }),
    ...(o.workerStartTimeoutMs === undefined ? {} : { startTimeoutMs: o.workerStartTimeoutMs }),
  });

  const adapter = new DesktopNetworkAdapter({
    settings,
    desktop,
    pool,
    identity,
    ...(signerFlow === undefined ? {} : { signerFlow }),
    ...(recovery === undefined ? {} : { recovery }),
    wallet: walletProvider,
    money,
    ...(autoTopUp === undefined ? {} : { autoTopUp }),
    images,
    worker: (m, a) => worker.request(m, a),
    mediaLink: (token, url) => {
      late.post?.({ kind: 'media-link', token, url });
    },
    log,
    ...(fixtures === undefined ? {} : { fixtures }),
    ...(o.random === undefined ? {} : { random: o.random }),
    ...(o.now === undefined ? {} : { now: o.now }),
  });
  const host = new Host({
    adapter,
    worker,
    images,
    post: o.post,
    log,
    ...(bridge === undefined ? {} : { bridge }),
    ...(signerFlow === undefined ? {} : { signerFlow }),
    ...(recovery === undefined ? {} : { recovery }),
  });
  late.adapter = adapter;
  late.post = host.post;
  late.worker = worker;
  worker.start();
  // Unlock by the chosen method (the keychain silently, a passphrase in main's window). In the
  // background: the host answers main at once, and a dismissed prompt just leaves it locked.
  void signerFlow?.start();
  return host;
}

/** `WorkerInit.payments` for a money plane with at least one mint (public values only). */
function paymentsInit(m: MoneyPlane | undefined): Pick<WorkerInit, 'payments'> {
  return m === undefined || m.mints.length === 0 ? {} : { payments: m.payments() };
}

/** The secret a prompt answer carries, to wipe when nobody asked. */
function secretOf(a: PromptAnswer | null): Uint8Array | null {
  if (a?.kind === 'secret') return a.value;
  if (a?.kind === 'bunker') return a.uri;
  return null;
}
