/**
 * The worker's WebRTC node (ADR 0023, #89): ONE helper process that runs only its WebRTC side
 * (`IrohHelper` with `init: { rtc }`), for trading segments with browsers in NFX-10 web swarms.
 *
 * - **Apart from the iroh nodes** (`./iroh.ts`): a fault here cannot stop iroh seeding, and its
 *   long poll holds none of their request slots. It has no iroh endpoint and no key.
 * - **Off until the host turns it on** (`set(config)`, with the network's STUN servers); `set(null)`
 *   stops it. Nothing here signals: the host carries offers and answers (over Nostr, nfx #71).
 * - **It serves only from the NFX store.** `rtc-init` names the store as `root`, so the helper
 *   refuses any file outside it, whatever `./rtc-seeding.ts` names.
 * - **Generations**, as `NfxIrohNode`'s: every start, restart and stop bumps `generation`; what the
 *   helper was serving is then to be served again (`onGeneration`).
 * - **Connections.** One long poll drains the helper's events into a table of connections (their
 *   swarm, direction, and what each peer last announced), which `./rtc-fetcher.ts` reads; `onPeer`
 *   hears each open and close. A restart empties it; a `lost` poll rebuilds it from `rtc-status`.
 * - A helper that cannot start is tried again at most once every `RTC_START_RETRY_MS`.
 */
import type { Logger } from '@sovit/seeder';

import type { HelperEvent, HelperRtcEvent, HelperRtcRanges, HelperSpawn } from '../iroh/helper.js';
import { IrohHelper } from '../iroh/helper.js';

/** Under `<storage>/tmp` (wiped at every worker start): the helper's `--state` (unused by WebRTC). */
export const NFX_RTC_DIR = 'nfx-rtc';
export const RTC_START_RETRY_MS = 60_000;
/** One poll's wait; the helper caps it at 30 s and the client's deadline is 60 s. */
export const RTC_POLL_WAIT_MS = 25_000;
/** The helper holds at most 32 connections; this table never holds more than twice that. */
const MAX_TABLE = 64;

/** What the host turns WebRTC on with. */
export interface NfxRtcConfig {
  /** STUN servers, `host:port`, 1 to 4: the network's own first (NFX-10 §1). */
  readonly stun: readonly string[];
  /** Tests and same-LAN runs only. */
  readonly bind?: string;
  readonly allowPrivate?: boolean;
}

export interface NfxRtcNodeDeps {
  /** The helper executable (`WorkerInit.irohHelper`), absolute. */
  readonly file: string;
  readonly spawn: HelperSpawn;
  readonly isExecutable: (path: string) => Promise<boolean>;
  /** Absolute: `<storage>/tmp/nfx-rtc`. */
  readonly stateDir: string;
  readonly rmTree: (path: string) => Promise<void>;
  /** Absolute: the NFX store, the only place the helper may read a served file from. */
  readonly root: string;
  readonly logger: Logger;
  readonly now?: () => number;
  /** Tests: the wait between polls after a failed one. */
  readonly retryMs?: number;
}

/** One connection, as the helper reported it. */
export interface NfxRtcConnection {
  readonly peer: number;
  readonly swarm: string;
  readonly dir: 'in' | 'out';
  /** What the peer last announced it holds (segment ids, inclusive ranges). */
  readonly have: HelperRtcRanges;
}

export type NfxRtcPeerEvent =
  | {
      readonly t: 'open';
      readonly peer: number;
      readonly swarm: string;
      readonly dir: 'in' | 'out';
    }
  | { readonly t: 'closed'; readonly peer: number; readonly swarm: string };

function sameConfig(a: NfxRtcConfig | null, b: NfxRtcConfig | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.stun.length === b.stun.length &&
    a.stun.every((s, i) => s === b.stun[i]) &&
    a.bind === b.bind &&
    a.allowPrivate === b.allowPrivate
  );
}

/** Whether segment `id` lies in `ranges`. */
export function holds(ranges: HelperRtcRanges, id: number): boolean {
  return ranges.some(([a, b]) => a <= id && id <= b);
}

export class NfxRtcNode {
  private readonly d: NfxRtcNodeDeps;
  private helper: IrohHelper | null = null;
  private config: NfxRtcConfig | null = null;
  private failedAt: number | null = null;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly generationListeners = new Set<() => void>();
  private readonly peerListeners = new Set<(e: NfxRtcPeerEvent) => void>();
  private readonly table = new Map<number, NfxRtcConnection>();
  generation = 0;

  constructor(d: NfxRtcNodeDeps) {
    this.d = d;
  }

  /** Whether WebRTC is on (a helper may still be starting or restarting). */
  get on(): boolean {
    return this.config !== null && !this.closed;
  }

  /** `cb` after every change of `generation`; returns the unsubscribe. */
  onGeneration(cb: () => void): () => void {
    this.generationListeners.add(cb);
    return () => this.generationListeners.delete(cb);
  }

  /** `cb` at every connection that opens or closes; returns the unsubscribe. */
  onPeer(cb: (e: NfxRtcPeerEvent) => void): () => void {
    this.peerListeners.add(cb);
    return () => this.peerListeners.delete(cb);
  }

  /** Turn WebRTC on with `config`, or off (`null`). A change of config restarts the helper. */
  set(config: NfxRtcConfig | null): Promise<void> {
    return this.serial(async () => {
      if (this.closed || sameConfig(config, this.config)) return;
      this.config = config === null ? null : { ...config, stun: [...config.stun] };
      this.failedAt = null;
      await this.doStop();
    });
  }

  /**
   * The running helper, started on first need while WebRTC is on (it may be restarting: its
   * requests then fail `not-ready`); `null` when off or it could not start (logged). Never throws.
   */
  start(): Promise<IrohHelper | null> {
    return this.serial(() => this.doStart());
  }

  /** The running helper, if any: never starts one. */
  current(): IrohHelper | null {
    return this.helper;
  }

  /** The open connections in `swarm`. */
  connections(swarm: string): NfxRtcConnection[] {
    return [...this.table.values()].filter((c) => c.swarm === swarm);
  }

  connection(peer: number): NfxRtcConnection | undefined {
    return this.table.get(peer);
  }

  /** Stop for good. */
  close(): Promise<void> {
    this.closed = true;
    return this.serial(() => this.doStop());
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doStart(): Promise<IrohHelper | null> {
    const config = this.config;
    if (this.closed || config === null) return null;
    if (this.helper !== null) return this.helper;
    const now = (this.d.now ?? Date.now)();
    if (this.failedAt !== null && now - this.failedAt < RTC_START_RETRY_MS) return null;
    try {
      if (!(await this.d.isExecutable(this.d.file)))
        throw new Error('the iroh helper is not an executable file');
      const helper: IrohHelper = new IrohHelper({
        spawn: this.d.spawn,
        file: this.d.file,
        stateDir: this.d.stateDir,
        init: {
          rtc: {
            stun: config.stun,
            root: this.d.root,
            ...(config.bind === undefined ? {} : { bind: config.bind }),
            ...(config.allowPrivate === true ? { allowPrivate: true } : {}),
          },
        },
        onEvent: (e) => {
          this.onEvent(helper, e);
        },
      });
      const reach = await helper.startRtc();
      this.helper = helper;
      this.failedAt = null;
      this.bump();
      void this.pump(helper);
      this.d.logger.info('nfx: the WebRTC side is up', {
        stun: config.stun.length,
        mapped: reach.mapped !== null,
      });
      return helper;
    } catch (err) {
      this.failedAt = now;
      this.d.logger.error('nfx: the WebRTC side did not start; WebRTC is off', { error: err });
      return null;
    }
  }

  private async doStop(): Promise<void> {
    const helper = this.helper;
    if (helper === null) return;
    this.helper = null;
    this.clearTable();
    this.bump();
    try {
      await helper.close();
    } catch {
      // gone either way
    }
    try {
      await this.d.rmTree(this.d.stateDir);
    } catch (err) {
      this.d.logger.warn('nfx: the WebRTC helper state could not be emptied', { error: err });
    }
    this.d.logger.info('nfx: the WebRTC side is stopped');
  }

  /** Drain `helper`'s events while it is this node's. */
  private async pump(helper: IrohHelper): Promise<void> {
    const retry = this.d.retryMs ?? 500;
    while (this.helper === helper) {
      try {
        const { events, lost } = await helper.rtcPoll(RTC_POLL_WAIT_MS);
        if (this.helper !== helper) return;
        for (const e of events) this.apply(e);
        if (lost) await this.resync(helper);
      } catch {
        // Restarting (`not-ready`), stopped, or a violation that killed it: wait, then ask again.
        if (this.helper !== helper) return;
        await new Promise((resolve) => setTimeout(resolve, retry));
      }
    }
  }

  private apply(e: HelperRtcEvent): void {
    switch (e.t) {
      case 'open':
        if (this.table.size >= MAX_TABLE) return;
        this.table.set(e.peer, { peer: e.peer, swarm: e.swarm, dir: e.dir, have: [] });
        this.emit({ t: 'open', peer: e.peer, swarm: e.swarm, dir: e.dir });
        return;
      case 'have': {
        const c = this.table.get(e.peer);
        if (c !== undefined) this.table.set(e.peer, { ...c, have: e.ranges });
        return;
      }
      case 'closed': {
        const c = this.table.get(e.peer);
        if (c === undefined) return;
        this.table.delete(e.peer);
        this.emit({ t: 'closed', peer: e.peer, swarm: c.swarm });
        return;
      }
    }
  }

  /** After lost events: the live connections and what each holds, from the helper itself. */
  private async resync(helper: IrohHelper): Promise<void> {
    const live = await helper.rtcStatus();
    const open = new Set(live.filter((p) => p.open).map((p) => p.peer));
    for (const [peer, c] of [...this.table]) {
      if (open.has(peer)) continue;
      this.table.delete(peer);
      this.emit({ t: 'closed', peer, swarm: c.swarm });
    }
    for (const p of live) {
      if (!p.open || this.table.size >= MAX_TABLE) continue;
      const { ranges } = await helper.rtcHave(p.peer).catch(() => ({ ranges: [] }));
      const known = this.table.has(p.peer);
      this.table.set(p.peer, { peer: p.peer, swarm: p.swarm, dir: p.dir, have: ranges });
      if (!known) this.emit({ t: 'open', peer: p.peer, swarm: p.swarm, dir: p.dir });
    }
  }

  private clearTable(): void {
    const gone = [...this.table.values()];
    this.table.clear();
    for (const c of gone) this.emit({ t: 'closed', peer: c.peer, swarm: c.swarm });
  }

  private emit(e: NfxRtcPeerEvent): void {
    for (const cb of [...this.peerListeners]) {
      try {
        cb(e);
      } catch {
        // a listener's failure is its own
      }
    }
  }

  private bump(): void {
    this.generation += 1;
    for (const cb of [...this.generationListeners]) {
      try {
        cb();
      } catch {
        // a listener's failure is its own
      }
    }
  }

  private onEvent(helper: IrohHelper, e: HelperEvent): void {
    if (this.helper !== helper) return;
    switch (e.type) {
      case 'stderr':
        this.d.logger.debug('nfx: WebRTC helper', { line: e.line });
        return;
      case 'violation':
        this.d.logger.warn('nfx: the WebRTC helper broke the protocol and was killed', {
          reason: e.reason,
        });
        return;
      case 'exit':
        // Its connections died with it.
        this.clearTable();
        this.d.logger.warn('nfx: the WebRTC helper exited; restarting it', {
          code: e.code,
          signal: e.signal,
        });
        return;
      case 'restarted':
        this.d.logger.info('nfx: the WebRTC helper restarted', { attempt: e.attempt });
        this.bump();
        return;
      case 'restart-failed':
        this.d.logger.warn('nfx: the WebRTC helper did not restart', { attempt: e.attempt });
        return;
    }
  }
}
