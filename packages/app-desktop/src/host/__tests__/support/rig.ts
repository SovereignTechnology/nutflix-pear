/**
 * Test support (not a suite): a complete host — `createHost` with a FakeWorker, L1's
 * `FakeRelayPool`, a temp userData directory and an in-memory `HostOut` log — under plain Node.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NfxSettings, RelayUrl, UnixSeconds } from '@sovit/core';
import type { signer as signerMod } from '@sovit/core';
import { nostr } from '@sovit/core';

import type { HostOut } from '../../../ipc/protocol.js';
import type { HostFlags } from '../../flags.js';
import type { Host, HostOptions } from '../../host.js';
import { createHost } from '../../host.js';
import type { IdentityProvider } from '../../identity.js';
import type { ImageTransport } from '../../images/net.js';
import type { RestartPolicy } from '../../worker/supervisor.js';
import { memoryLogger } from '../../log.js';
import type { FakeWorker, FakeWorkerOptions } from './fake-worker.js';
import { FakeWorker as FakeWorkerClass, fakeSpawner } from './fake-worker.js';

export const RELAY_A = 'wss://a.test' as RelayUrl;
export const RELAY_B = 'wss://b.test' as RelayUrl;

export interface Rig {
  readonly host: Host;
  readonly pool: nostr.FakeRelayPool;
  readonly out: HostOut[];
  readonly worker: () => FakeWorker;
  readonly spawned: FakeWorker[];
  readonly log: ReturnType<typeof memoryLogger>;
  readonly userData: string;
  /** Resolves once the (current) worker is ready. */
  ready(): Promise<void>;
  /** Waits (bounded, default 3 s) until `pred` holds over `out`. */
  until<T extends HostOut>(pred: (o: HostOut) => o is T, what: string, ms?: number): Promise<T>;
  close(): Promise<void>;
}

export interface RigOptions {
  readonly flags?: Partial<HostFlags>;
  readonly identity?: IdentityProvider;
  readonly worker?: FakeWorkerOptions;
  readonly imageTransport?: ImageTransport;
  readonly now?: () => UnixSeconds;
  readonly restart?: RestartPolicy;
  /** ADR 0012/0013: the money plane's mint transport, the signer's KDF floor and NIP-46. */
  readonly mintRequest?: HostOptions['mintRequest'];
  readonly signerCost?: signerMod.KdfCost;
  readonly nip46?: HostOptions['nip46'];
  /** Plays main: sees every HostOut after it is recorded (answer prompts with `host.handle`). */
  readonly onOut?: (o: HostOut, host: () => Host) => void;
  /** A relay pool prepared beforehand (e.g. holding the user's NIP-60 wallet event). */
  readonly pool?: nostr.FakeRelayPool;
  /** Issue #2: the auto top-up's clock and target polling. */
  readonly topUp?: HostOptions['topUp'];
  /**
   * ADR 0016: lane N1's NUT-13 code — default core's real one (`recoveryCore()`); the recovery
   * suites pass a pass-through spy of it (`support/real-recovery.ts`).
   */
  readonly recoveryCore?: HostOptions['recoveryCore'];
  /** Contracts v10: `Settings.nfx`, set with the test relays at start. */
  readonly nfx?: NfxSettings;
}

/** Polls `check` every few ms until it returns a value, or fails with `what` after `ms`. */
export async function eventually<T>(
  check: () => T | undefined | null | false,
  what: string,
  ms = 3000,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

export async function rig(o: RigOptions = {}): Promise<Rig> {
  const userData = await mkdtemp(join(tmpdir(), 'nf-l6b-'));
  const pool = o.pool ?? new nostr.FakeRelayPool();
  const out: HostOut[] = [];
  const log = memoryLogger('debug');
  const spawner = fakeSpawner(() => new FakeWorkerClass(o.worker));
  let tick = 1_757_000_000;
  const late: { host?: Host } = {};
  const host = await createHost({
    userData,
    flags: { devMocks: false, devFixtures: false, ...o.flags },
    post: (m) => {
      out.push(m);
      if (o.onOut !== undefined && late.host !== undefined) {
        const h = late.host;
        o.onOut(m, () => h);
      }
    },
    log,
    workerEntry: '/nonexistent/worker.js',
    spawn: spawner.spawn,
    pool,
    // A strictly increasing clock: replaceable sets never share a second (see L1's rig).
    now: o.now ?? (() => tick++ as UnixSeconds),
    ...(o.identity === undefined ? {} : { identity: o.identity }),
    ...(o.restart === undefined ? {} : { restart: o.restart }),
    ...(o.mintRequest === undefined ? {} : { mintRequest: o.mintRequest }),
    ...(o.signerCost === undefined ? {} : { signerCost: o.signerCost }),
    ...(o.nip46 === undefined ? {} : { nip46: o.nip46 }),
    ...(o.topUp === undefined ? {} : { topUp: o.topUp }),
    ...(o.recoveryCore === undefined ? {} : { recoveryCore: o.recoveryCore }),
    imageTransport: o.imageTransport ?? (() => Promise.reject(new Error('no network in tests'))),
  });
  late.host = host;
  // Point the relay list at the fake pool's test relays (defaults are public relays).
  await host.adapter.updateSettings({
    relays: [
      { url: RELAY_A, read: true, write: true },
      { url: RELAY_B, read: true, write: false },
    ],
    ...(o.nfx === undefined ? {} : { nfx: o.nfx }),
  });
  return {
    host,
    pool,
    out,
    worker: spawner.last,
    spawned: spawner.spawned,
    log,
    userData,
    ready: async () => {
      await eventually(() => host.worker.state === 'ready', 'worker ready');
    },
    until: <T extends HostOut>(pred: (o: HostOut) => o is T, what: string, ms?: number) =>
      eventually(() => out.find(pred), what, ms),
    close: async () => {
      host.stop();
      // Lane P2-owed-viewer: sessions dropped by `stop` keep their tails on disk (as a quit does:
      // `Host.shutdown` waits for these writes) — let them land before the directory goes.
      await host.adapter.flushTails().catch(() => undefined);
      await rm(userData, { recursive: true, force: true });
    },
  };
}
