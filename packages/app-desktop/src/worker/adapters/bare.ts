/**
 * The Bare runtime for `WorkerHost` (design §1: "`@sovit/seeder` with Bare adapters
 * (`bare-fs`, `sodium-native` sha256)"). The ONLY worker module that imports `bare-*` addons,
 * which cannot load under Node (S-C finding 8) — it is imported by `../entry.ts` alone, and
 * exercised under the real `bare` by `__tests__/bare-worker.test.ts` and
 * `scripts/bare-probe.ts`.
 */
import type { FsAdapter } from '@sovit/core';
import type { FileStat, SeederFs } from '@sovit/seeder';
import fs from 'bare-fs';
import hrtime from 'bare-hrtime';
import os from 'bare-os';
import path from 'bare-path';
import { spawn } from 'bare-subprocess';

import type { OsName } from '../ffmpeg.js';
import { utf8 } from '../../ipc/codec.js';
import type { SpawnDleqThread } from '../pay/dleq-thread.js';
import type { HttpRequestHandler, HttpServerLike, StateFs, WorkerRuntime } from '../runtime.js';
import type { BareSpawn } from '../transcode/index.js';
import { createBareProcessRunner } from '../transcode/index.js';
import { DLEQ_THREAD_ENTRY } from '../worker-root.js';

function errno(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** bare-fs types `readFile` as `string | Buffer`; without an encoding it is always a Buffer. */
function bytes(b: unknown): Uint8Array {
  if (!(b instanceof Uint8Array)) throw new TypeError('readFile returned text');
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

export const bareSeederFs: SeederFs = {
  readFile: async (p) => bytes(await fs.promises.readFile(p)),
  writeFile: (p, data) => fs.promises.writeFile(p, data),
  rename: (from, to) => fs.promises.rename(from, to),
  unlink: (p) => fs.promises.unlink(p),
  mkdir: async (p, opts) => {
    await fs.promises.mkdir(p, { recursive: opts?.recursive ?? false });
  },
  stat: async (p): Promise<FileStat | null> => {
    try {
      const s = await fs.promises.stat(p);
      return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() };
    } catch (err) {
      if (errno(err) === 'ENOENT') return null;
      throw err;
    }
  },
  readStream: (p) => fs.createReadStream(p) as AsyncIterable<Uint8Array>,
  readRange: async (p, offset, length) => {
    if (length === 0) return new Uint8Array(0);
    const parts: Uint8Array[] = [];
    // `end` is inclusive (bare-fs `ReadStreamOptions`).
    const stream = fs.createReadStream(p, { start: offset, end: offset + length - 1 });
    for await (const chunk of stream as AsyncIterable<Uint8Array>) parts.push(chunk);
    let n = 0;
    for (const part of parts) n += part.byteLength;
    const out = new Uint8Array(n);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  },
  join: (...parts) => path.join(...parts),
};

/** `@sovit/core/media`'s filesystem; temp dirs under `tmpDir` (the worker's storage). */
export function bareMediaFs(tmpDir: string): FsAdapter {
  return {
    readFile: async (p) => bytes(await fs.promises.readFile(p)),
    writeFile: (p, data) => fs.promises.writeFile(p, data),
    stat: async (p) => ({ size: (await fs.promises.stat(p)).size }),
    mkdtemp: (prefix) => fs.promises.mkdtemp(path.join(tmpDir, prefix)),
    rm: (p, opts) => fs.promises.rm(p, { recursive: opts?.recursive ?? false, force: true }),
    // Chunk size is only a hint (hashing and the seeder's re-chunking do not depend on it).
    readChunks: (p) => fs.createReadStream(p) as AsyncIterable<Uint8Array>,
  };
}

function osName(): OsName {
  const p = os.platform();
  if (p === 'darwin' || p === 'ios') return 'macos';
  if (p === 'win32') return 'windows';
  return 'linux';
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.X_OK);
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * R9: a rename, or a file's creation, is durable only once the directory holding it is synced.
 * Best effort, as in the Node twin (`@sovit/seeder`'s `runtime/files.ts`): some filesystems, and
 * Windows, refuse to open or fsync a directory; the file's own bytes are already synced.
 */
function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // refused here; the file itself is durable
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** `StateFs` on bare-fs's synchronous calls (see `../runtime.ts`). */
export const bareStateFs: StateFs = {
  readText: (p) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch (err) {
      if (errno(err) === 'ENOENT') return null;
      throw err;
    }
  },
  writeAtomic: (p, data) => {
    const tmp = `${p}.tmp`;
    try {
      fs.unlinkSync(tmp);
    } catch {
      // none left over
    }
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      // No global Buffer in Bare: the shared codec (TextEncoder under Bare, see bare-globals).
      const bytes = utf8.encode(data);
      let off = 0;
      while (off < bytes.byteLength) off += fs.writeSync(fd, bytes, off, bytes.byteLength - off);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, p);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // nothing to clean up
      }
      throw err;
    }
    fsyncDir(path.dirname(p));
  },
  append: (p, data) => {
    fs.appendFileSync(p, data, { mode: 0o600 });
  },
  appendDurable: (p, data) => {
    // One writer (the worker's thread), so this tells whether the open below creates the file.
    const created = !fs.existsSync(p);
    const fd = fs.openSync(p, 'a', 0o600);
    try {
      const bytes = utf8.encode(data);
      let off = 0;
      while (off < bytes.byteLength) off += fs.writeSync(fd, bytes, off, bytes.byteLength - off);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // A new file's directory entry, once; later appends need only the file's own fsync.
    if (created) fsyncDir(path.dirname(p));
  },
  remove: (p) => {
    try {
      fs.unlinkSync(p);
    } catch (err) {
      if (errno(err) !== 'ENOENT') throw err;
    }
  },
  rename: (from, to) => {
    fs.renameSync(from, to);
  },
  mkdirp: (p) => {
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  },
};

/** The runtime's own `Bare.Thread` (no package): an entry file on its own OS thread. */
type BareThreadClass = new (
  filename: string,
  opts: { readonly data: unknown },
) => { terminate(): void; join(): void };

/**
 * The DLEQ thread's entry: resolved from the worker ROOT (`../worker-root.ts`), never from this
 * module — `adapters/` is one level down in dev but inlined into the root bundle when packaged,
 * so a path relative to it pointed outside the worker directory there (ADR 0017).
 */
export { DLEQ_THREAD_ENTRY };

/**
 * `WorkerRuntime.dleqThread` on `Bare.Thread` (issue #8 d), or `undefined` where there is none.
 * An exception that escapes a Bare thread aborts the whole process — a missing entry file
 * included — so a thread is only ever started from an entry that exists as a regular file (a
 * bundled test worker has none: its checks run inline, chunked). `lstat`, not `stat`: a symlink
 * there is refused like a missing file, so the entry cannot lead out of the worker directory
 * (packaging/layout.ts refuses one in a package too).
 */
export function bareDleqThread(entry: URL = DLEQ_THREAD_ENTRY): SpawnDleqThread | undefined {
  const Thread = (globalThis as { Bare?: { Thread?: BareThreadClass } }).Bare?.Thread;
  if (Thread === undefined) return undefined;
  return (mailbox) => {
    try {
      // Under Bare the global URL is bare-url's, which bare-fs takes as a file URL.
      if (!fs.lstatSync(entry as unknown as Parameters<typeof fs.lstatSync>[0]).isFile())
        return null;
    } catch {
      return null;
    }
    const t = new Thread(entry.href, { data: mailbox });
    return {
      terminate: () => {
        t.terminate();
      },
      join: () => {
        t.join();
      },
    };
  };
}

/**
 * `WorkerRuntime.createHttpServer` on bare-http1 (slice 5d), whose server, request and response
 * mirror node:http's — the shapes `../runtime.ts` names. Imported on the first call, not at the
 * top: it loads bare-tcp and bare-dns, native addons that cannot load under Node, which imports
 * this module in tests (`bare-state-fs.test.ts`).
 */
async function bareHttpServer(onRequest: HttpRequestHandler): Promise<HttpServerLike> {
  const http = (await import('bare-http1')).default;
  return http.createServer({}, (req, res) => {
    onRequest(req, res);
  });
}

export function bareRuntime(): WorkerRuntime {
  const dleqThread = bareDleqThread();
  return {
    stateFs: bareStateFs,
    seederFs: bareSeederFs,
    mediaFs: bareMediaFs,
    createHttpServer: bareHttpServer,
    runner: createBareProcessRunner(spawn as unknown as BareSpawn),
    env: (name) => os.getEnv(name),
    isExecutable,
    os: osName(),
    // Whole microseconds before Number(): exact for centuries of uptime.
    monotonicNow: () => Number(hrtime.bigint() / 1000n) / 1000,
    ...(dleqThread === undefined ? {} : { dleqThread }),
  };
}
