/**
 * Test support (not a suite): an in-memory stand-in for the Bare worker that speaks the REAL
 * host ⇄ worker protocol — frames (`src/ipc/framing.ts`), guards (`isHostToWorker`) and
 * `WireError`s — through the same `WorkerProcess` surface `bare-sidecar` gives the supervisor.
 * Responses and events are delivered asynchronously (a macrotask later), like a pipe.
 */
import { EventEmitter } from 'node:events';

import type { MintUrl, PeerSpend, Sats, VideoManifest } from '@sovit/core';

import { toWireError, wireError } from '../../../ipc/errors.js';
import { FrameDecoder, encodeFrame } from '../../../ipc/framing.js';
import type { SeederStatusWire, SessionId, UploadId, WireError } from '../../../ipc/protocol.js';
import { isHostToWorker } from '../../../ipc/worker-guards.js';
import type {
  HostMethod,
  HostMethodTable,
  HostToWorker,
  PlayOpenArgs,
  WorkerMethod,
  WorkerMethodTable,
} from '../../../ipc/worker-protocol.js';
import { WORKER_V } from '../../../ipc/worker-protocol.js';
import type { WorkerProcess } from '../../worker/supervisor.js';

type Handler<M extends WorkerMethod> = (
  a: WorkerMethodTable[M][0],
  w: FakeWorker,
) => Promise<WorkerMethodTable[M][1]> | WorkerMethodTable[M][1];

export interface FakeWorkerOptions {
  /** Per-method overrides; throwing `Error('<code>: …')` answers with that code. */
  readonly handlers?: { readonly [M in WorkerMethod]?: Handler<M> };
  readonly port?: number;
  /** Do not answer `init` / announce `ready` (start-timeout tests). */
  readonly silent?: boolean;
}

class FakeStdio extends EventEmitter {
  resumed = false;
  resume(): this {
    this.resumed = true;
    return this;
  }
}

export const FAKE_SEEDER_STATUS: SeederStatusWire = {
  enabled: false,
  pubkey: 'a'.repeat(64) as SeederStatusWire['pubkey'],
  videos: 0,
  bytesStored: 0,
  diskCapBytes: 10 * 1024 ** 3,
  peers: [],
  earned: {
    total: 0 as Sats,
    unswapped: 0 as Sats,
    byMint: { $map: [['https://mint.fixture-a.example' as MintUrl, 0 as Sats]] },
  },
  banned: [],
};

/** Every request the fake received, in order. */
export interface Received {
  readonly m: WorkerMethod;
  readonly a: unknown;
}

export class FakeWorker extends EventEmitter implements WorkerProcess {
  readonly stdout = new FakeStdio();
  readonly stderr = new FakeStdio();
  readonly received: Received[] = [];
  /** Open play sessions (sid → args). */
  readonly sessions = new Map<string, PlayOpenArgs>();
  destroyed = false;
  private readonly o: FakeWorkerOptions;
  private readonly decoder: FrameDecoder;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (r: unknown) => void; reject: (e: WireError) => void }
  >();

  constructor(opts: FakeWorkerOptions = {}) {
    super();
    this.o = opts;
    this.decoder = new FrameDecoder((m) => {
      this.onFrame(m);
    });
  }

  // ---- WorkerProcess (host side) ---------------------------------------------------------

  write(chunk: Uint8Array): boolean {
    if (this.destroyed) throw new Error('write after destroy');
    try {
      this.decoder.push(chunk);
    } catch {
      this.crash(3);
    }
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    setTimeout(() => {
      this.emit('exit', null, 'SIGTERM');
      this.emit('close');
    }, 0);
  }

  // ---- test controls (worker side) -------------------------------------------------------

  /** Sends one raw message (bypassing nothing: the host guards it). */
  send(msg: object): void {
    const frame = encodeFrame(msg);
    setTimeout(() => {
      if (!this.destroyed) this.emit('data', frame);
    }, 0);
  }

  /** Raw bytes to the host (corrupt-frame tests). */
  sendBytes(b: Uint8Array): void {
    setTimeout(() => {
      if (!this.destroyed) this.emit('data', b);
    }, 0);
  }

  event(ev: object): void {
    this.send({ op: 'ev', ...ev });
  }

  spend(sid: SessionId | string, mint: MintUrl | string, amount: number, total: number): void {
    this.event({ e: 'spend', sid, mint, amount, total, ratePerMin: amount * 60 });
  }

  peers(sid: SessionId | string, peers: readonly PeerSpend[]): void {
    this.event({ e: 'peers', sid, peers });
  }

  fixtures(videos: readonly VideoManifest[]): void {
    this.event({ e: 'dev.fixtures', videos });
  }

  progress(uploadId: UploadId | string, progress: object): void {
    this.event({ e: 'upload.progress', uploadId, progress });
  }

  /** Worker → host request (`studio.publish`, and the ADR 0012 money calls). */
  request<M extends HostMethod>(m: M, a: HostMethodTable[M][0]): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ op: 'req', id, m, a });
    });
  }

  /** The child dies (exit code `code`). */
  crash(code = 1): void {
    if (this.destroyed) return;
    this.destroyed = true;
    setTimeout(() => {
      this.emit('exit', code, null);
      this.emit('close');
    }, 0);
  }

  calls(m: WorkerMethod): unknown[] {
    return this.received.filter((r) => r.m === m).map((r) => r.a);
  }

  // ---- protocol --------------------------------------------------------------------------

  private onFrame(msg: unknown): void {
    if (!isHostToWorker(msg)) {
      const id = (msg as { id?: unknown }).id;
      this.send({
        op: 'res',
        id: typeof id === 'number' ? id : 0,
        ok: false,
        e: wireError('invalid-argument', 'fake worker: message failed validation'),
      });
      return;
    }
    const m: HostToWorker = msg;
    if (m.op === 'res') {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.ok) p?.resolve((m as { r?: unknown }).r);
      else p?.reject(m.e);
      return;
    }
    this.received.push({ m: m.m, a: m.a });
    if (m.m === 'init' && this.o.silent === true) return;
    void this.answer(m.id, m.m, m.a);
  }

  private async answer(id: number, m: WorkerMethod, a: unknown): Promise<void> {
    try {
      const custom = this.o.handlers?.[m] as Handler<WorkerMethod> | undefined;
      const r = custom ? await custom(a as never, this) : await this.defaultAnswer(m, a);
      this.send(r === undefined ? { op: 'res', id, ok: true } : { op: 'res', id, ok: true, r });
      if (m === 'init') this.event({ e: 'ready', v: WORKER_V, port: this.o.port ?? 45_000 });
    } catch (e) {
      this.send({ op: 'res', id, ok: false, e: toWireError(e) });
    }
  }

  private defaultAnswer(m: WorkerMethod, a: unknown): Promise<unknown> {
    switch (m) {
      case 'init':
      case 'play.pause':
      case 'play.resume':
      case 'play.prefetch':
      case 'seeder.configure':
      case 'seeder.unban':
      case 'nfx.configure':
        return Promise.resolve(undefined);
      // Slice 5b: not seeding NFX, nothing stored, unless a test sets a handler.
      case 'nfx.endpoint':
        return Promise.resolve({ endpoint: null });
      case 'nfx.videos':
        return Promise.resolve({ videos: [] });
      case 'play.open': {
        const args = a as PlayOpenArgs;
        this.sessions.set(args.sid, args);
        return Promise.resolve({
          key: args.rendition.hyper.core,
          link: `http://127.0.0.1:${String(this.o.port ?? 45_000)}/${'t'.repeat(64)}/${args.sid}`,
        });
      }
      case 'play.close':
        this.sessions.delete((a as { sid: string }).sid);
        // Lane P2-owed-viewer: the session's unpaid tail (none, unless a test sets a handler).
        return Promise.resolve({ unpaid: 0 });
      case 'seeder.status':
        return Promise.resolve(FAKE_SEEDER_STATUS);
      case 'seeder.melt':
        return Promise.resolve({ paid: true });
      case 'studio.ffmpeg':
        return Promise.resolve({
          found: true,
          path: '/usr/bin/ffmpeg',
          version: '7.1',
          os: 'linux',
        });
      case 'studio.upload':
        return Promise.reject(
          new Error('not-found: the fake worker needs a studio.upload handler'),
        );
      case 'image.fetch':
        return Promise.reject(new Error('not-found: the fake worker needs an image.fetch handler'));
      case 'profile.putImage':
        return Promise.reject(
          new Error('not-found: the fake worker needs a profile.putImage handler'),
        );
    }
  }
}

/** A `SpawnWorker` that hands out FakeWorkers and remembers them. */
export function fakeSpawner(make: () => FakeWorker = () => new FakeWorker()): {
  readonly spawn: (entry: string, args: readonly string[]) => FakeWorker;
  readonly spawned: FakeWorker[];
  readonly last: () => FakeWorker;
} {
  const spawned: FakeWorker[] = [];
  return {
    spawn: () => {
      const w = make();
      spawned.push(w);
      return w;
    },
    spawned,
    last: () => {
      const w = spawned.at(-1);
      if (!w) throw new Error('no worker spawned yet');
      return w;
    },
  };
}
