/**
 * The worker's iroh node (ADR 0021, slice 5e-3): ONE iroh helper process, started when NFX
 * serving needs it and stopped when nothing does. `./iroh-seeding.ts` serves through it; the
 * fetch over iroh (slice 5e-4) will dial through it.
 *
 * - **A stable node id.** The helper's secret is the Ed25519 seed of a key pair derived by name
 *   from the worker's Corestore primary key, `nfx:<namespace>:iroh` (beside the HyperDHT
 *   listener's `nfx:<namespace>:seeder`, `./seeding.ts`, and never the same key), so the node a
 *   beacon names survives restarts. The seed goes to the helper in `init` and nowhere else: never
 *   logged, never kept here. The helper must then report exactly the key's public half as its
 *   node; one that reports another is stopped (an untrusted pipe, ADR 0021 §3).
 * - **The network's relays only**, as the host last said (`Settings.nfx.irohRelays`). A change
 *   stops the running helper, and the next `start` uses the new ones.
 * - **Its store is a cache** (spike S-D finding 8) under the worker's `tmp/`, which every worker
 *   start wipes, and it is emptied whenever this module stops the helper: what a helper serves is
 *   only ever what this run imported into it.
 * - **Generations.** `IrohHelper`'s supervisor restarts a helper that exits. Every start and
 *   restart bumps `generation`: what was imported and ticketed before is to be done again (a
 *   restarted node keeps its id, not its ports).
 * - A helper that cannot start (the file is not an executable, `init` fails) is tried again at
 *   most once every `IROH_START_RETRY_MS`.
 */
import type { IrohRelayUrl } from '@sovit/core';
import type { Logger, PeerKeyPair } from '@sovit/seeder';
import { toHex } from '@sovit/seeder';

import type { HelperEvent, HelperSpawn } from '../iroh/helper.js';
import { IrohHelper } from '../iroh/helper.js';

/** Under `<storage>/tmp` (wiped at every worker start): the helper's iroh-blobs store. */
export const NFX_IROH_DIR = 'nfx-iroh';
/** How long after a failed start the next one may be tried. */
export const IROH_START_RETRY_MS = 60_000;

/** The key pair name for `namespace`'s iroh node (beside `seederKeyName`, `./seeding.ts`). */
export const irohKeyName = (namespace: string): string => `nfx:${namespace}:iroh`;

export interface NfxIrohNodeDeps {
  /** The helper executable (`WorkerInit.irohHelper`), absolute. */
  readonly file: string;
  readonly spawn: HelperSpawn;
  /** Exists, is a regular file, and is executable by us (checked before every start). */
  readonly isExecutable: (path: string) => Promise<boolean>;
  /** Absolute: `<storage>/tmp/nfx-iroh`. */
  readonly stateDir: string;
  /** Remove a directory and everything in it; a missing one is fine. */
  readonly rmTree: (path: string) => Promise<void>;
  /** A key pair derived by name from the worker's primary key (`Corestore.createKeyPair`). */
  readonly keyPair: (name: string) => Promise<PeerKeyPair>;
  readonly logger: Logger;
  readonly now?: () => number;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export class NfxIrohNode {
  readonly namespace: string;
  private readonly d: NfxIrohNodeDeps;
  private helper: IrohHelper | null = null;
  private relays: readonly IrohRelayUrl[] = [];
  private failedAt: number | null = null;
  private closed = false;
  /** Starts and stops run one after the other, in call order. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  /** Bumped at every start, restart and stop of the helper: what an older one held is gone. */
  generation = 0;

  constructor(d: NfxIrohNodeDeps, namespace: string) {
    this.d = d;
    this.namespace = namespace;
  }

  /** The network's relays the helper runs, or will run, with. */
  get networkRelays(): readonly IrohRelayUrl[] {
    return this.relays;
  }

  /** `cb` after every change of `generation`; returns the unsubscribe. */
  onGeneration(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Use `relays` from now on: a helper running with others is stopped. */
  setRelays(relays: readonly IrohRelayUrl[]): Promise<void> {
    return this.serial(async () => {
      if (sameList(relays, this.relays)) return;
      this.relays = [...relays];
      this.failedAt = null;
      await this.doStop();
    });
  }

  /**
   * The helper, started on first need (it may be restarting: its requests then fail
   * `not-ready`); `null` when there is none, and why was logged. Never throws.
   */
  start(): Promise<IrohHelper | null> {
    return this.serial(() => this.doStart());
  }

  /** Stop the helper and empty its store. */
  stop(): Promise<void> {
    return this.serial(() => this.doStop());
  }

  /** Stop for good. */
  close(): Promise<void> {
    this.closed = true;
    return this.stop();
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doStart(): Promise<IrohHelper | null> {
    if (this.closed) return null;
    if (this.helper !== null) return this.helper;
    const now = (this.d.now ?? Date.now)();
    if (this.failedAt !== null && now - this.failedAt < IROH_START_RETRY_MS) return null;
    try {
      if (!(await this.d.isExecutable(this.d.file)))
        throw new Error('the iroh helper is not an executable file');
      const keyPair = await this.d.keyPair(irohKeyName(this.namespace));
      if (keyPair.publicKey.byteLength !== 32 || keyPair.secretKey.byteLength !== 64)
        throw new Error('the iroh key pair is not an Ed25519 pair');
      const node = toHex(keyPair.publicKey);
      const helper: IrohHelper = new IrohHelper({
        spawn: this.d.spawn,
        file: this.d.file,
        stateDir: this.d.stateDir,
        // libsodium's secret key is seed ‖ public key; iroh's is the seed. Only `init` carries it.
        init: { relays: [...this.relays], secret: toHex(keyPair.secretKey.subarray(0, 32)) },
        onEvent: (e) => {
          this.onEvent(helper, node, e);
        },
      });
      const reach = await helper.start();
      if (reach.node !== node) {
        await helper.close();
        throw new Error('the iroh helper reported a node id that is not its key');
      }
      this.helper = helper;
      this.failedAt = null;
      this.bump();
      this.d.logger.info('nfx: the iroh helper is up', {
        namespace: this.namespace,
        relays: this.relays.length,
        relayReached: reach.relay !== '',
      });
      return helper;
    } catch (err) {
      this.failedAt = now;
      this.d.logger.error('nfx: the iroh helper did not start; iroh is off', { error: err });
      return null;
    }
  }

  private async doStop(): Promise<void> {
    const helper = this.helper;
    if (helper === null) return;
    this.helper = null;
    this.bump();
    try {
      await helper.close();
    } catch {
      // gone either way
    }
    try {
      await this.d.rmTree(this.d.stateDir);
    } catch (err) {
      this.d.logger.warn('nfx: the iroh helper store could not be emptied', { error: err });
    }
    this.d.logger.info('nfx: the iroh helper is stopped', { namespace: this.namespace });
  }

  private bump(): void {
    this.generation += 1;
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch {
        // a listener's failure is its own
      }
    }
  }

  private onEvent(helper: IrohHelper, node: string, e: HelperEvent): void {
    // A helper being stopped says it exited; that is not news.
    if (this.helper !== helper) return;
    switch (e.type) {
      case 'stderr':
        this.d.logger.debug('nfx: iroh helper', { line: e.line });
        return;
      case 'violation':
        this.d.logger.warn('nfx: the iroh helper broke the protocol and was killed', {
          reason: e.reason,
        });
        return;
      case 'exit':
        this.d.logger.warn('nfx: the iroh helper exited; restarting it', {
          code: e.code,
          signal: e.signal,
        });
        return;
      case 'restarted':
        if (e.reach.node !== node) {
          this.d.logger.error('nfx: the restarted iroh helper reported another node id');
          void this.stop();
          return;
        }
        this.d.logger.info('nfx: the iroh helper restarted', { attempt: e.attempt });
        this.bump();
        return;
      case 'restart-failed':
        this.d.logger.warn('nfx: the iroh helper did not restart', { attempt: e.attempt });
        return;
    }
  }
}
