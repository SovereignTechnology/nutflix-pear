/**
 * Worker supervision (design §1 Host row, §2 "Host ⇄ worker", D2 amended): spawns the Bare
 * worker through a `SpawnWorker` (production: `bare-sidecar` directly — `./sidecar.ts`),
 * frames every message (`src/ipc/framing.ts`), guards everything the worker sends
 * (`isWorkerToHost` + `validateWorkerResult`), drains the child's stdout/stderr through the
 * redacting logger (an undrained pipe blocks the worker at ~64 KiB), and restarts it with
 * back-off when it dies. While the worker is not ready, calls fail fast with `backend-down:`
 * (or wait, bounded, while it is starting).
 */
import type { WireError } from '../../ipc/protocol.js';
import { fromWireError, toWireError, wireError } from '../../ipc/errors.js';
import { isMsgId } from '../../ipc/guards.js';
import { FrameDecoder, encodeFrame } from '../../ipc/framing.js';
import {
  isWorkerToHost,
  validateWorkerArgs,
  validateWorkerResult,
} from '../../ipc/worker-guards.js';
import type {
  HostMethod,
  HostMethodTable,
  WorkerEvent,
  WorkerInit,
  WorkerMethod,
  WorkerMethodTable,
  WorkerToHost,
} from '../../ipc/worker-protocol.js';
import { hostError } from '../errors.js';
import type { Logger } from '../log.js';
import { redact } from '../log.js';

/** A readable stdio pipe of the child (Node `net.Socket` under Node/Electron). */
export interface StdioLike {
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  resume?(): unknown;
}

/** What the host needs from a spawned worker — the surface of a `bare-sidecar` `Sidecar`. */
export interface WorkerProcess {
  write(chunk: Uint8Array): boolean;
  /** Kills the child. */
  destroy(): void;
  readonly stdout: StdioLike | null;
  readonly stderr: StdioLike | null;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'close' | 'end', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type SpawnWorker = (entry: string, args: readonly string[]) => WorkerProcess;

/**
 * The packaged Bare runtime cannot be used as installed (never repaired at runtime; thrown by
 * `loadSidecar`, issue #6). Its message is a constant sentence of ours with no path in it, so
 * the supervisor logs it when a spawn fails — the one error text it lets through.
 */
export class WorkerRuntimeError extends Error {
  override readonly name = 'WorkerRuntimeError' as const;
}

export type WorkerState = 'idle' | 'starting' | 'ready' | 'down' | 'failed' | 'stopped';

type HostHandler<M extends HostMethod> = (
  a: HostMethodTable[M][0],
) => Promise<HostMethodTable[M][1]>;

/**
 * Handlers for requests the worker makes of the host. `studio.publish` always; the money calls
 * (`pay.*`, `seller.*`, ADR 0012) only while the money plane is live — a request without a
 * handler is answered `payments-unavailable`, never dropped.
 */
export type HostRequestHandlers = { readonly 'studio.publish': HostHandler<'studio.publish'> } & {
  readonly [M in Exclude<HostMethod, 'studio.publish'>]?: HostHandler<M>;
};

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

export interface RestartPolicy {
  /** First back-off, doubled per consecutive failure up to `maxMs`. */
  readonly baseMs: number;
  readonly maxMs: number;
  /** More than this many (re)starts inside `windowMs` → give up (`failed`). */
  readonly maxRestarts: number;
  readonly windowMs: number;
}

export const DEFAULT_RESTART: RestartPolicy = {
  baseMs: 250,
  maxMs: 30_000,
  maxRestarts: 5,
  windowMs: 60_000,
};

export interface SupervisorOptions {
  readonly spawn: SpawnWorker;
  readonly entry: string;
  readonly args?: readonly string[];
  /** Built fresh for every (re)start, so it carries the current settings. */
  readonly init: () => WorkerInit;
  readonly log: Logger;
  readonly onEvent: (ev: WorkerEvent) => void;
  /**
   * The worker's requests. A function is read per request, so the money handlers can follow the
   * signer (ADR 0013: they change when it connects, locks or signs out).
   */
  readonly handlers: HostRequestHandlers | (() => HostRequestHandlers);
  /** Called on every state change (the host closes sessions on `down`). */
  readonly onState?: (state: WorkerState) => void;
  readonly restart?: RestartPolicy;
  readonly timers?: Timers;
  readonly now?: () => number;
  /** How long a call may wait for a starting worker, and init may take, ms. */
  readonly startTimeoutMs?: number;
  /** Per-call timeout (ms) by method; `0` = none. */
  readonly callTimeoutMs?: Partial<Record<WorkerMethod, number>>;
  /** stdout/stderr lines logged per second before the rest are counted and dropped. */
  readonly stdioLinesPerSecond?: number;
}

interface Pending {
  readonly m: WorkerMethod;
  readonly resolve: (r: unknown) => void;
  readonly reject: (e: Error) => void;
  timer: unknown;
}

interface Queued {
  readonly m: WorkerMethod;
  readonly a: unknown;
  readonly resolve: (r: unknown) => void;
  readonly reject: (e: Error) => void;
  readonly timer: unknown;
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUTS: Partial<Record<WorkerMethod, number>> = {
  'studio.upload': 0, // transcodes run for minutes; progress events show liveness
  'seeder.melt': 120_000,
  'studio.ffmpeg': 60_000,
  // Contracts v16: one ffprobe of a local file (it reads a few MB at most).
  'studio.probe': 60_000,
};
const MAX_QUEUED = 256;
const MAX_LINE = 1024;

export class WorkerSupervisor {
  private readonly o: SupervisorOptions;
  private readonly log: Logger;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly policy: RestartPolicy;
  private proc: WorkerProcess | null = null;
  /** Incremented per spawn; callbacks from an older child are ignored. */
  private gen = 0;
  private stateValue: WorkerState = 'idle';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private queue: Queued[] = [];
  private initAcked = false;
  private readySeen = false;
  private port: number | null = null;
  private startTimer: unknown = null;
  private restartTimer: unknown = null;
  private readonly starts: number[] = [];
  private failures = 0;
  /** Per stream, so a chatty stdout cannot starve stderr. */
  private readonly stdioBudget = {
    stdout: { windowStart: 0, lines: 0, dropped: 0 },
    stderr: { windowStart: 0, lines: 0, dropped: 0 },
  };

  constructor(opts: SupervisorOptions) {
    this.o = opts;
    this.log = opts.log.child('worker');
    this.timers = opts.timers ?? realTimers;
    this.now = opts.now ?? Date.now;
    this.policy = opts.restart ?? DEFAULT_RESTART;
  }

  get state(): WorkerState {
    return this.stateValue;
  }

  /** The playback server's port from the last `ready` (informational). */
  get readyPort(): number | null {
    return this.port;
  }

  start(): void {
    if (this.stateValue !== 'idle') return;
    this.spawn();
  }

  /**
   * A deliberate restart (ADR 0013: the signer changed): kill the worker, fail everything
   * outstanding (`backend-down`; the state goes `down`, so the host closes play sessions), run
   * `between` — the host swaps the money plane while no worker can talk to either plane — and
   * spawn a fresh one, whose init then carries the new state. It does not count against the crash
   * budget, and works from `failed` too (a new signer is a reason to try again). Stopped or never
   * started: only runs `between`.
   */
  async restart(between: () => Promise<void>): Promise<void> {
    const live = this.stateValue !== 'idle' && this.stateValue !== 'stopped';
    if (live) {
      this.gen++;
      this.clearTimers();
      this.teardown('restarting');
      this.setState('down');
    }
    let failure: { readonly e: unknown } | undefined;
    try {
      await between();
    } catch (e) {
      failure = { e };
    }
    if (live && this.stateValue !== 'stopped') {
      this.failures = 0;
      this.starts.length = 0;
      this.spawn();
    }
    if (failure !== undefined) throw failure.e;
  }

  /** Kills the worker and fails everything outstanding; no restart afterwards. */
  stop(): void {
    this.gen++;
    this.setState('stopped');
    this.clearTimers();
    this.teardown('worker stopped');
  }

  /** One request. Rejects `backend-down:` unless the worker is (or becomes, in time) ready. */
  request<M extends WorkerMethod>(
    m: M,
    a: WorkerMethodTable[M][0],
  ): Promise<WorkerMethodTable[M][1]> {
    if (!(validateWorkerArgs[m] as (x: unknown) => boolean)(a))
      return Promise.reject(hostError('invalid-argument', `bad arguments for worker ${m}`));
    return new Promise<unknown>((resolve, reject) => {
      if (this.stateValue === 'ready') {
        this.send(m, a, resolve, reject);
        return;
      }
      if (this.stateValue !== 'starting' || this.queue.length >= MAX_QUEUED) {
        reject(hostError('backend-down', `the media worker is ${this.describeState()}`));
        return;
      }
      const timer = this.timers.setTimeout(() => {
        this.queue = this.queue.filter((q) => q.timer !== timer);
        reject(hostError('backend-down', 'the media worker did not start in time'));
      }, this.o.startTimeoutMs ?? 20_000);
      this.queue.push({ m, a, resolve, reject, timer });
    }) as Promise<WorkerMethodTable[M][1]>;
  }

  // ---- lifecycle -------------------------------------------------------------------------

  private spawn(): void {
    const gen = ++this.gen;
    this.initAcked = false;
    this.readySeen = false;
    this.starts.push(this.now());
    this.setState('starting');
    let proc: WorkerProcess;
    try {
      proc = this.o.spawn(this.o.entry, this.o.args ?? []);
    } catch (err) {
      // Allow-list: only a WorkerRuntimeError's reason is logged (a constant sentence of ours,
      // e.g. "reinstall the app"); any other error's text could carry a path and is dropped.
      if (err instanceof WorkerRuntimeError)
        this.log.error('could not spawn the media worker', {
          error: err.name,
          reason: err.message,
        });
      else this.log.error('could not spawn the media worker');
      this.onDeath(gen, 'spawn failed');
      return;
    }
    this.proc = proc;
    const decoder = new FrameDecoder((msg) => {
      this.onMessage(gen, msg);
    });
    proc.on('data', (chunk) => {
      if (gen !== this.gen) return;
      try {
        decoder.push(chunk);
      } catch {
        // No resync after a corrupt frame (framing.ts): kill and restart.
        this.log.error('corrupt frame from the media worker; restarting it');
        this.onDeath(gen, 'corrupt frame');
      }
    });
    proc.on('exit', (code, signal) => {
      this.log.warn('media worker exited', { code, signal });
      this.onDeath(gen, 'worker exited');
    });
    proc.on('close', () => {
      this.onDeath(gen, 'worker pipe closed');
    });
    proc.on('error', () => {
      this.onDeath(gen, 'worker pipe error');
    });
    this.drain(gen, proc.stdout, 'stdout');
    this.drain(gen, proc.stderr, 'stderr');

    this.startTimer = this.timers.setTimeout(() => {
      if (gen !== this.gen || this.stateValue !== 'starting') return;
      this.log.error('media worker did not become ready in time; restarting it');
      this.onDeath(gen, 'start timeout');
    }, this.o.startTimeoutMs ?? 20_000);

    let init: WorkerInit;
    try {
      init = this.o.init();
    } catch {
      this.log.error('could not build the worker init message');
      this.onDeath(gen, 'init failed');
      return;
    }
    if (!validateWorkerArgs.init(init)) {
      // A configuration error (e.g. a dev bootstrap without --dev-mocks): restarting cannot
      // fix it, so fail at once instead of crash-looping.
      this.log.error('worker init invalid (the media worker stays down)');
      this.gen++;
      this.teardown('invalid init');
      this.setState('failed');
      return;
    }
    this.send(
      'init',
      init,
      () => {
        if (gen !== this.gen) return;
        this.initAcked = true;
        this.maybeReady();
      },
      () => {
        if (gen !== this.gen) return;
        this.log.error('media worker refused init');
        this.onDeath(gen, 'init refused');
      },
    );
  }

  private maybeReady(): void {
    if (!this.initAcked || !this.readySeen || this.stateValue !== 'starting') return;
    this.timers.clearTimeout(this.startTimer);
    this.startTimer = null;
    this.failures = 0;
    this.setState('ready');
    const q = this.queue;
    this.queue = [];
    for (const item of q) {
      this.timers.clearTimeout(item.timer);
      this.send(item.m, item.a, item.resolve, item.reject);
    }
  }

  private onDeath(gen: number, reason: string): void {
    if (gen !== this.gen) return;
    this.gen++; // ignore anything else the dead child says
    this.teardown(reason);
    if (this.stateValue === 'stopped') return;
    // Drop starts outside the window; too many inside it → give up.
    const cutoff = this.now() - this.policy.windowMs;
    while (this.starts.length > 0 && (this.starts[0] ?? 0) < cutoff) this.starts.shift();
    if (this.starts.length > this.policy.maxRestarts) {
      this.log.error('media worker keeps dying; giving up', { restarts: this.starts.length });
      this.setState('failed');
      return;
    }
    this.setState('down');
    const delay = Math.min(this.policy.maxMs, this.policy.baseMs * 2 ** this.failures);
    this.failures++;
    this.restartTimer = this.timers.setTimeout(() => {
      this.restartTimer = null;
      if (this.stateValue === 'down') this.spawn();
    }, delay);
  }

  private teardown(reason: string): void {
    const proc = this.proc;
    this.proc = null;
    this.timers.clearTimeout(this.startTimer);
    this.startTimer = null;
    if (proc) {
      try {
        proc.destroy();
      } catch {
        // already gone
      }
    }
    const err = (): Error => hostError('backend-down', `the media worker went away (${reason})`);
    for (const [, p] of this.pending) {
      this.timers.clearTimeout(p.timer);
      p.reject(err());
    }
    this.pending.clear();
    for (const q of this.queue) {
      this.timers.clearTimeout(q.timer);
      q.reject(err());
    }
    this.queue = [];
  }

  private clearTimers(): void {
    this.timers.clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private setState(s: WorkerState): void {
    if (this.stateValue === s) return;
    if (this.stateValue === 'stopped') return;
    this.stateValue = s;
    try {
      this.o.onState?.(s);
    } catch {
      this.log.warn('worker state listener threw');
    }
  }

  private describeState(): string {
    switch (this.stateValue) {
      case 'idle':
        return 'not started';
      case 'starting':
        return 'starting (queue full)';
      case 'ready':
        return 'ready';
      case 'down':
        return 'restarting';
      case 'failed':
        return 'down (it kept crashing)';
      case 'stopped':
        return 'stopped';
    }
  }

  // ---- wire ------------------------------------------------------------------------------

  private send(
    m: WorkerMethod,
    a: unknown,
    resolve: (r: unknown) => void,
    reject: (e: Error) => void,
  ): void {
    const proc = this.proc;
    if (!proc) {
      reject(hostError('backend-down', 'the media worker is not running'));
      return;
    }
    const id = this.nextId;
    this.nextId = this.nextId >= 0x7fffffff ? 1 : this.nextId + 1;
    let frame: Uint8Array;
    try {
      frame = encodeFrame({ op: 'req', id, m, a });
    } catch {
      reject(hostError('invalid-argument', `worker ${m} arguments are not serialisable`));
      return;
    }
    const ms = this.o.callTimeoutMs?.[m] ?? DEFAULT_CALL_TIMEOUTS[m] ?? DEFAULT_CALL_TIMEOUT_MS;
    const pending: Pending = { m, resolve, reject, timer: null };
    if (ms > 0 && m !== 'init')
      pending.timer = this.timers.setTimeout(() => {
        if (this.pending.get(id) !== pending) return;
        this.pending.delete(id);
        reject(hostError('backend-down', `the media worker did not answer ${m} in time`));
      }, ms);
    this.pending.set(id, pending);
    try {
      proc.write(frame);
    } catch {
      this.pending.delete(id);
      this.timers.clearTimeout(pending.timer);
      reject(hostError('backend-down', 'could not write to the media worker'));
    }
  }

  private reply(id: number, ok: true, r: unknown): void;
  private reply(id: number, ok: false, e: WireError): void;
  private reply(id: number, ok: boolean, payload: unknown): void {
    const proc = this.proc;
    if (!proc) return;
    const msg = ok
      ? { op: 'res', id, ok: true, r: payload }
      : { op: 'res', id, ok: false, e: payload };
    try {
      proc.write(encodeFrame(msg));
    } catch {
      this.log.warn('could not answer a worker request');
    }
  }

  private onMessage(gen: number, raw: unknown): void {
    if (gen !== this.gen) return;
    if (!isWorkerToHost(raw)) {
      this.log.warn('dropped an invalid message from the media worker');
      // A request we can identify still gets an answer, so the worker does not hang on it.
      const r = raw as { op?: unknown; id?: unknown };
      if (r.op === 'req' && isMsgId(r.id))
        this.reply(r.id, false, wireError('invalid-argument', 'request failed validation'));
      return;
    }
    const msg: WorkerToHost = raw;
    if (msg.op === 'res') {
      const p = this.pending.get(msg.id);
      if (p === undefined) {
        this.log.debug('response for an unknown request id');
        return;
      }
      this.pending.delete(msg.id);
      this.timers.clearTimeout(p.timer);
      if (!msg.ok) {
        p.reject(fromWireError(msg.e));
        return;
      }
      const r = (msg as { r?: unknown }).r;
      if (!(validateWorkerResult[p.m] as (x: unknown) => boolean)(r)) {
        this.log.warn('media worker returned a malformed result', { method: p.m });
        p.reject(hostError('internal', 'malformed worker result'));
        return;
      }
      p.resolve(r);
      return;
    }
    if (msg.op === 'req') {
      void this.onRequest(msg.id, msg.m, msg.a);
      return;
    }
    if (msg.e === 'ready') {
      this.port = msg.port;
      this.readySeen = true;
      this.maybeReady();
      return;
    }
    if (msg.e === 'log') {
      const level = msg.level;
      this.log[level]('worker log', { line: redact(msg.msg) });
      return;
    }
    try {
      this.o.onEvent(msg);
    } catch {
      this.log.warn('worker event handler threw', { event: msg.e });
    }
  }

  private async onRequest(id: number, m: HostMethod, a: unknown): Promise<void> {
    const gen = this.gen;
    try {
      const table = typeof this.o.handlers === 'function' ? this.o.handlers() : this.o.handlers;
      const handler = table[m] as ((x: unknown) => Promise<unknown>) | undefined;
      if (handler === undefined)
        throw hostError('payments-unavailable', 'no money plane: connect a signer first');
      const r = await handler(a);
      if (gen === this.gen) this.reply(id, true, r);
    } catch (e) {
      if (gen === this.gen) this.reply(id, false, toWireError(e));
    }
  }

  private drain(gen: number, pipe: StdioLike | null, name: 'stdout' | 'stderr'): void {
    if (!pipe) return;
    let partial = '';
    const emit = (line: string): void => {
      if (gen !== this.gen || line.trim() === '') return;
      const b = this.stdioBudget[name];
      const t = this.now();
      if (t - b.windowStart >= 1000) {
        if (b.dropped > 0)
          this.log.warn('worker output lines dropped', { stream: name, dropped: b.dropped });
        b.windowStart = t;
        b.lines = 0;
        b.dropped = 0;
      }
      if (b.lines >= (this.o.stdioLinesPerSecond ?? 50)) {
        b.dropped++;
        return;
      }
      b.lines++;
      if (name === 'stderr') this.log.warn('worker stderr', { line: redact(line) });
      else this.log.debug('worker stdout', { line: redact(line) });
    };
    pipe.on('data', (chunk) => {
      // Decoding for the log only; a split multi-byte character just shows as U+FFFD.
      partial += Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8');
      let nl = partial.indexOf('\n');
      while (nl !== -1) {
        emit(partial.slice(0, Math.min(nl, MAX_LINE)));
        partial = partial.slice(nl + 1);
        nl = partial.indexOf('\n');
      }
      if (partial.length > MAX_LINE) {
        emit(partial.slice(0, MAX_LINE));
        partial = '';
      }
    });
    pipe.on('error', () => undefined);
    pipe.resume?.();
  }
}
