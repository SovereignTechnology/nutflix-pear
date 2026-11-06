/**
 * The host `utilityProcess` entry (design §1): main does
 *
 *   utilityProcess.fork(<dist/host/main.js>, ['--user-data-dir=<abs>', '--worker-entry=<abs>',
 *     …dev flags], { serviceName: 'nutflix-host', stdio: 'pipe' })
 *
 * and talks to it with `postMessage(HostIn)` / `'message'` (`HostOut`). Logs are JSON lines on
 * stderr, already redacted. The worker is spawned with `bare-sidecar` (D2 amended).
 */
import { QUIT_FLUSH_MS, createHost } from './host.js';
import type { Host } from './host.js';
import { HostArgsError, IROH_HELPER_ENV, irohHelperFromEnv, parseHostArgs } from './flags.js';
import { createLogger } from './log.js';
import type { Logger } from './log.js';
import { spawnBareSidecar } from './worker/sidecar.js';
import type { SpawnWorker } from './worker/supervisor.js';

// Lane R6-reconcile: this entry module exports `runHost` (and types) only — the packaged host
// bundle is pinned to exactly that (packaging `stage.test.ts`), so constants live in `host.ts`
// (`QUIT_FLUSH_MS`).

/** Electron's `process.parentPort` in a utility process, structurally. */
export interface ParentPortLike {
  on(event: 'message', listener: (e: { readonly data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
}

export interface RunOptions {
  readonly parentPort: ParentPortLike;
  readonly argv: readonly string[];
  /** Slice 5e-3: the process environment (only `NUTFLIX_IROH_HELPER` is read). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log: Logger;
  readonly spawn?: SpawnWorker;
}

/** Wires a host to a parent port. Rejects on bad arguments (the process should then exit 2). */
export async function runHost(o: RunOptions): Promise<Host> {
  const args = parseHostArgs(o.argv);
  const irohHelper = irohHelperFromEnv(o.env?.[IROH_HELPER_ENV]);
  const host = await createHost({
    userData: args.userData,
    workerEntry: args.workerEntry,
    flags: args.flags,
    irohHelper,
    log: o.log,
    spawn: o.spawn ?? spawnBareSidecar,
    post: (out) => {
      o.parentPort.postMessage(out);
    },
  });
  o.parentPort.on('message', (e) => {
    host.handle(e.data);
  });
  return host;
}

interface ProcessLike {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly parentPort?: ParentPortLike;
  readonly stderr: { write(s: string): unknown };
  exit(code: number): never;
  on(event: 'SIGTERM', listener: () => void): unknown;
}

const proc = process as unknown as ProcessLike;
// Only when actually running as Electron's utility process (never on import in tests).
if (proc.parentPort !== undefined) {
  const port = proc.parentPort;
  const log = createLogger((line) => {
    proc.stderr.write(`${line}\n`);
  });
  runHost({ parentPort: port, argv: proc.argv.slice(2), env: proc.env, log }).then(
    (host) => {
      let quitting = false;
      proc.on('SIGTERM', () => {
        if (quitting) return;
        quitting = true;
        // Fix round 4: the open play sessions' tails are paid before the worker goes (bounded;
        // main waits for this process a little longer, `QUIT_GRACE_MS`).
        void host.shutdown(QUIT_FLUSH_MS).finally(() => {
          proc.exit(0);
        });
      });
    },
    (e: unknown) => {
      log.error(e instanceof HostArgsError ? e.message : 'host failed to start');
      proc.exit(2);
    },
  );
}
