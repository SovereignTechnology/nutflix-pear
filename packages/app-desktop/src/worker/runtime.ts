/**
 * What the runtime-neutral `WorkerHost` needs from its runtime (design §6 L6-C: "runtime-
 * neutral, adapters injected — runs under Node in tests and Bare in production"). Bare's
 * implementation is `adapters/bare.ts` (bare-fs, bare-os, bare-subprocess, bare-http1); tests
 * build a Node one from `@sovit/seeder`'s and `@sovit/core/media/node`'s adapters. Hashing and
 * randomness are NOT here: `./crypto.ts` (libsodium) loads under both runtimes.
 */
import type { FsAdapter, ProcessRunner } from '@sovit/core';
import type { SeederFs } from '@sovit/seeder';

import type { OsName } from './ffmpeg.js';
import type { SpawnDleqThread } from './pay/dleq-thread.js';

/**
 * Small durable state files, SYNCHRONOUS — the payment engine's pending PAYs are written before
 * the ACK goes out (its `persistPending` hook is synchronous) and its seen secrets as they are
 * accepted (ADR 0012). Every write is 0600.
 */
export interface StateFs {
  /** The file's text, or `null` when it does not exist (other errors throw). */
  readText(path: string): string | null;
  /**
   * `<path>.tmp` (created exclusively, a leftover removed first) + fsync + rename, then the
   * directory's fsync (R9; best effort where a filesystem refuses one).
   */
  writeAtomic(path: string, data: string): void;
  append(path: string, data: string): void;
  /**
   * Append, then fsync, before returning (the pending-PAY journal: written before the ACK); a
   * file this call creates also gets its directory's fsync (R9).
   */
  appendDurable(path: string, data: string): void;
  /** Delete the file; a missing one is fine. */
  remove(path: string): void;
  rename(from: string, to: string): void;
  mkdirp(path: string): void;
}

/**
 * Slice 5d: one request to a loopback HTTP server the worker owns — the part of node:http's and
 * bare-http1's `IncomingMessage` that `nfx/range-server.ts` reads (bare-http1 mirrors node:http).
 */
export interface HttpRequestLike {
  readonly method?: string | undefined;
  /** The request target as sent: the path (and query). */
  readonly url?: string | undefined;
  /** By lowercase name. */
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

/** Its response: the part of `ServerResponse` (a writable stream in both) used here. */
export interface HttpResponseLike {
  /** The response was destroyed or the client went away. */
  readonly destroyed: boolean;
  writeHead(status: number, headers: Readonly<Record<string, string>>): unknown;
  /** `false`: buffered past the high-water mark; wait for `drain`. */
  write(chunk: Uint8Array): boolean;
  end(): unknown;
  destroy(): unknown;
  on(event: 'drain' | 'close', listener: () => void): unknown;
  off(event: 'drain' | 'close', listener: () => void): unknown;
}

/** The server, created but not listening. */
export interface HttpServerLike {
  listen(port: number, host: string, onListening: () => void): unknown;
  /** `{ port, … }` once listening, else `null`. */
  address(): unknown;
  /** Stop accepting; `onClose` runs once every connection is gone. */
  close(onClose: () => void): unknown;
  /** Destroy every connection, in flight or not (both runtimes have it). */
  closeAllConnections?(): void;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type HttpRequestHandler = (req: HttpRequestLike, res: HttpResponseLike) => void;

export interface WorkerRuntime {
  /** `@sovit/seeder`'s filesystem (Corestore dir, CAS index, ban list, fixture dirs). */
  readonly seederFs: SeederFs;
  /** `@sovit/core/media`'s filesystem; `mkdtemp(prefix)` creates under `tmpDir`. */
  mediaFs(tmpDir: string): FsAdapter;
  /** ffmpeg / ffprobe (argv only, never a shell). */
  readonly runner: ProcessRunner;
  /** An environment variable (only `PATH` is read). */
  env(name: string): string | undefined;
  /** Exists, is a regular file, and is executable by us. */
  isExecutable(path: string): Promise<boolean>;
  readonly os: OsName;
  readonly stateFs: StateFs;
  /**
   * RR-1: a monotonic clock in ms for the payer's streaks, backoffs and give-up. Bare has no
   * `performance`, so without this the payer fell back to a steadied wall clock, where a forward
   * step of the system clock still counted toward a give-up.
   */
  readonly monotonicNow: () => number;
  /**
   * Slice 5d: an HTTP/1 server for the worker's own loopback endpoints (the NFX range server):
   * bare-http1 under Bare (`adapters/bare.ts`), node:http in tests. The legacy playback server
   * gets its HTTP from `hypercore-blob-server`'s own `imports` map instead.
   */
  readonly createHttpServer: (onRequest: HttpRequestHandler) => HttpServerLike;
  /**
   * Start the DLEQ thread (issue #8 d: F5's checks off this event loop). Bare's is `Bare.Thread`
   * (`adapters/bare.ts`); absent, the checks run inline in small chunks.
   */
  readonly dleqThread?: SpawnDleqThread;
}
