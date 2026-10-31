/**
 * Test harness (not a suite): the worker under Node, driven through the REAL wire — a
 * `WorkerRpc` fed framed bytes and a host-side `FrameDecoder` + `isWorkerToHost`, exactly
 * what L6-B's host does — plus a Node `WorkerRuntime` and small HTTP / wait helpers.
 */
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { mkdtemp, rm, access, stat, constants } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nodeFsAdapter, nodeProcessRunner } from '@sovit/core/media/node';
import { nodeFs } from '@sovit/seeder';

import { FrameDecoder, encodeFrame } from '../../../ipc/framing.js';
import { fromWireError, toWireError } from '../../../ipc/errors.js';
import type { Guard } from '../../../ipc/protocol.js';
import { isWorkerToHost, validateWorkerResult } from '../../../ipc/worker-guards.js';
import type {
  HostMethod,
  HostMethodTable,
  WorkerEvent,
  WorkerMethod,
  WorkerMethodTable,
} from '../../../ipc/worker-protocol.js';
import type { LoopbackPayHub } from '../../dev/loopback-pay.js';
import type { WorkerHostOptions } from '../../host.js';
import { WorkerHost } from '../../host.js';
import type {
  HttpRequestHandler,
  HttpRequestLike,
  HttpResponseLike,
  HttpServerLike,
  StateFs,
  WorkerRuntime,
} from '../../runtime.js';
import { WorkerRpc } from '../../rpc.js';

/** `StateFs` on node:fs (tests; production is `adapters/bare.ts`). */
export const nodeStateFs: StateFs = {
  readText: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') return null;
      throw err;
    }
  },
  writeAtomic: (p, data) => {
    const tmp = `${p}.tmp`;
    try {
      unlinkSync(tmp);
    } catch {
      // none left over
    }
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      const bytes = Buffer.from(data, 'utf8');
      let off = 0;
      while (off < bytes.byteLength) off += writeSync(fd, bytes, off, bytes.byteLength - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, p);
  },
  append: (p, data) => {
    appendFileSync(p, data, { mode: 0o600 });
  },
  appendDurable: (p, data) => {
    const fd = openSync(p, 'a', 0o600);
    try {
      const bytes = Buffer.from(data, 'utf8');
      let off = 0;
      while (off < bytes.byteLength) off += writeSync(fd, bytes, off, bytes.byteLength - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  remove: (p) => {
    try {
      unlinkSync(p);
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'ENOENT') throw err;
    }
  },
  rename: (from, to) => {
    renameSync(from, to);
  },
  mkdirp: (p) => {
    mkdirSync(p, { recursive: true, mode: 0o700 });
  },
};

/** `WorkerRuntime.createHttpServer` on node:http (tests; production is bare-http1). */
export function nodeHttpServer(onRequest: HttpRequestHandler): HttpServerLike {
  const server = http.createServer((req, res) => {
    onRequest(req as unknown as HttpRequestLike, res as unknown as HttpResponseLike);
  });
  return server as unknown as HttpServerLike;
}

export function nodeRuntime(): WorkerRuntime {
  return {
    stateFs: nodeStateFs,
    seederFs: nodeFs,
    mediaFs: (tmpDir) => nodeFsAdapter({ tmpDir }),
    createHttpServer: nodeHttpServer,
    runner: nodeProcessRunner(),
    env: (name) => process.env[name],
    monotonicNow: () => performance.now(),
    isExecutable: async (p) => {
      try {
        await access(p, constants.X_OK);
        return (await stat(p)).isFile();
      } catch {
        return false;
      }
    },
    os:
      process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
  };
}

export async function tempDir(prefix: string): Promise<{ dir: string; rm: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return {
    dir,
    rm: async () => {
      for (let i = 0; ; i++) {
        try {
          await rm(dir, { recursive: true, force: true });
          return;
        } catch (err) {
          if (i >= 20) throw err;
          await new Promise((r) => setTimeout(r, 25));
        }
      }
    },
  };
}

export type HostHandlers = {
  readonly [M in HostMethod]?: (a: HostMethodTable[M][0]) => Promise<HostMethodTable[M][1]>;
};

export interface WorkerClient {
  readonly host: WorkerHost;
  readonly rpc: WorkerRpc;
  readonly events: WorkerEvent[];
  /** Frames the host-side guard refused (must stay empty). */
  readonly invalid: unknown[];
  call<M extends WorkerMethod>(m: M, a: WorkerMethodTable[M][0]): Promise<WorkerMethodTable[M][1]>;
  /** Raw frame to the worker (fuzzing). */
  pushRaw(bytes: Uint8Array): void;
  /** The next event matching `pred` (already received or future), bounded. */
  event<E extends WorkerEvent>(
    pred: (e: WorkerEvent) => e is E,
    ms?: number,
    what?: string,
  ): Promise<E>;
  close(): Promise<void>;
}

export function startWorker(
  opts: {
    readonly hub?: LoopbackPayHub;
    readonly handlers?: HostHandlers;
    readonly runtime?: WorkerRuntime;
  } & Partial<
    Pick<
      WorkerHostOptions,
      | 'uploadPreset'
      | 'logLevel'
      | 'providers'
      | 'testBootstrap'
      | 'imageTimeoutMs'
      | 'reportWaitMs'
      | 'unpaidFlushMs'
    >
  > = {},
): WorkerClient {
  const events: WorkerEvent[] = [];
  const invalid: unknown[] = [];
  const pending = new Map<
    number,
    { m: WorkerMethod; resolve: (r: unknown) => void; reject: (e: Error) => void }
  >();
  const waiters: { pred: (e: WorkerEvent) => boolean; resolve: (e: WorkerEvent) => void }[] = [];
  let nextId = 1;
  // eslint-disable-next-line prefer-const -- assigned after the rpc that closes over it
  let rpc: WorkerRpc;

  const onFromWorker = (msg: unknown): void => {
    if (!isWorkerToHost(msg)) {
      invalid.push(msg);
      return;
    }
    const m = msg;
    if (m.op === 'res') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (!m.ok) p.reject(fromWireError(m.e));
      else if (!(validateWorkerResult[p.m] as Guard<unknown>)(m.r))
        p.reject(new Error(`invalid ${p.m} result`));
      else p.resolve(m.r);
      return;
    }
    if (m.op === 'req') {
      const h = opts.handlers?.[m.m] as ((a: unknown) => Promise<unknown>) | undefined;
      const reply = (x: object): void => {
        rpc.push(encodeFrame(x));
      };
      if (!h) {
        reply({
          op: 'res',
          id: m.id,
          ok: false,
          e: { code: 'not-found', message: 'not-found: no handler' },
        });
        return;
      }
      h(m.a).then(
        (r) => {
          reply({ op: 'res', id: m.id, ok: true, r });
        },
        (e: unknown) => {
          // As the host's supervisor answers (`onRequest`): a coded refusal keeps its code — the
          // money plane's 'forbidden' / 'session-closed' decide whether the worker's payer gives
          // blocks up (fix round 5: this harness used to turn every one into 'internal').
          reply({ op: 'res', id: m.id, ok: false, e: toWireError(e) });
        },
      );
      return;
    }
    events.push(m);
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  };
  const decoder = new FrameDecoder(onFromWorker);
  const host = new WorkerHost({
    runtime: opts.runtime ?? nodeRuntime(),
    emit: (ev) => {
      rpc.emit(ev);
    },
    request: (m, a) => rpc.request(m, a),
    ...(opts.hub ? { hub: opts.hub } : {}),
    ...(opts.uploadPreset !== undefined ? { uploadPreset: opts.uploadPreset } : {}),
    ...(opts.logLevel !== undefined ? { logLevel: opts.logLevel } : {}),
    ...(opts.providers !== undefined ? { providers: opts.providers } : {}),
    ...(opts.testBootstrap !== undefined ? { testBootstrap: opts.testBootstrap } : {}),
    ...(opts.imageTimeoutMs !== undefined ? { imageTimeoutMs: opts.imageTimeoutMs } : {}),
    ...(opts.reportWaitMs !== undefined ? { reportWaitMs: opts.reportWaitMs } : {}),
    ...(opts.unpaidFlushMs !== undefined ? { unpaidFlushMs: opts.unpaidFlushMs } : {}),
  });
  rpc = new WorkerRpc({
    write: (bytes) => {
      decoder.push(bytes);
    },
    handler: host,
    onFatal: () => undefined,
  });

  return {
    host,
    rpc,
    events,
    invalid,
    call: (m, a) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { m, resolve: resolve as (r: unknown) => void, reject });
        rpc.push(encodeFrame({ op: 'req', id, m, a }));
      }),
    pushRaw: (bytes) => {
      rpc.push(bytes);
    },
    event: <E extends WorkerEvent>(
      pred: (e: WorkerEvent) => e is E,
      ms = 20_000,
      what = 'event',
    ) => {
      const found = events.find(pred);
      if (found) return Promise.resolve(found);
      return within(
        new Promise<E>((resolve) => {
          waiters.push({ pred, resolve: resolve as (e: WorkerEvent) => void });
        }),
        ms,
        what,
      );
    },
    close: () => host.close(),
  };
}

/** `p`, or a clear failure after `ms`. */
export function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`timed out after ${String(ms)} ms waiting for ${what}`));
      }, ms);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

/** Resolves once `cond()` holds, re-checked on every `subscribe` notification; bounded. */
export function until(
  cond: () => boolean,
  subscribe: (cb: () => void) => () => void,
  ms: number,
  what: string,
): Promise<void> {
  if (cond()) return Promise.resolve();
  let off: () => void = () => undefined;
  return within(
    new Promise<void>((resolve) => {
      off = subscribe(() => {
        if (cond()) resolve();
      });
    }),
    ms,
    what,
  ).finally(() => {
    off();
  });
}

export interface HttpResult {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

/** GET with a fresh connection; the whole body. */
export function httpGet(url: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

/** Start a GET and hold the response PAUSED (a player that has buffered enough). */
export function httpHold(
  url: string,
  headers: Record<string, string>,
): Promise<{ res: http.IncomingMessage; readAll: () => Promise<Buffer>; destroy: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, agent: false }, (res) => {
      res.pause();
      resolve({
        res,
        readAll: () =>
          new Promise<Buffer>((done, fail) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              done(Buffer.concat(chunks));
            });
            res.on('error', fail);
            res.resume();
          }),
        destroy: () => {
          req.destroy();
        },
      });
    });
    req.on('error', reject);
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
