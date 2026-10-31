/**
 * Slice 5e-1 (spike S-D finding 10): the real Bare runtime holding long-lived children with a
 * stdin pipe, as the iroh helper needs (ADR 0021). S-D saw Bare tear itself down mid-run with a
 * live subprocess and timers; it ran without `Bare.IPC`, which the real worker always holds.
 *
 * `subprocess-probe-entry.ts` runs two `cat` children through `bare-subprocess` (small and 64 KiB
 * echoes, a timer between, a heartbeat), three times each way:
 * - started by bare-sidecar, as the host starts the worker (IPC held);
 * - started by the plain `bare` binary, as the spike did (no IPC).
 */
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WorkerToHost } from '../../ipc/worker-protocol.js';
import {
  SUBPROCESS_PROBE_CHILDREN,
  SUBPROCESS_PROBE_ROUNDS,
  type SubprocessProbeReport,
} from '../subprocess-probe.js';
import { WORKER_SRC, bundleForBare, spawnBare } from './helpers/bare.js';

const require = createRequire(import.meta.url);
const BARE = join(
  dirname(require.resolve('bare-sidecar/package')),
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'bare',
);
const EXCHANGES = SUBPROCESS_PROBE_ROUNDS * SUBPROCESS_PROBE_CHILDREN;
const RUN_MS = 50_000;

let bundle: { readonly file: string; cleanup(): Promise<void> };
let work: string;

beforeAll(async () => {
  bundle = await bundleForBare(join(WORKER_SRC, 'subprocess-probe-entry.ts'));
  work = await mkdtemp(join(tmpdir(), 'nf-bare-subprocess-'));
});
afterAll(async () => {
  await bundle.cleanup();
  await rm(work, { recursive: true, force: true });
});

const isLog = (m: WorkerToHost): m is Extract<WorkerToHost, { e: 'log' }> =>
  m.op === 'ev' && m.e === 'log';

/** The plain `bare` on the bundle: its exit code (null when killed at the deadline), stderr. */
function plainBare(
  args: readonly string[],
): Promise<{ readonly code: number | null; readonly stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(BARE, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    const deadline = setTimeout(() => {
      p.kill('SIGKILL');
    }, RUN_MS);
    p.on('exit', (code) => {
      clearTimeout(deadline);
      resolve({ code, stderr: stderr.slice(-2000) });
    });
  });
}

describe('slice 5e-1: long-lived children with a stdin pipe under the real bare', () => {
  it.each([1, 2, 3])(
    'started by bare-sidecar, holding Bare.IPC (run %i)',
    async () => {
      const w = spawnBare(bundle.file);
      const log = await w.next(isLog, RUN_MS, 'the probe report');
      const report = JSON.parse(log.msg) as SubprocessProbeReport;
      expect({ report, stderr: w.stderr.join('').slice(-2000) }).toMatchObject({
        report: { ok: true, mode: 'ipc', exchanges: EXCHANGES, exits: [0, 0], beforeExit: [] },
      });
      expect(await w.exited).toBe(0);
      expect(w.invalid).toEqual([]);
    },
    RUN_MS + 10_000,
  );

  it.each([1, 2, 3])(
    'started by the plain bare, without IPC (run %i)',
    async (run) => {
      await access(BARE);
      const out = join(work, `report-${String(run)}.json`);
      const { code, stderr } = await plainBare([bundle.file, out]);
      const report = await readFile(out, 'utf8').then(
        (t) => JSON.parse(t) as SubprocessProbeReport,
        () => null,
      );
      expect({ code, report, stderr }).toMatchObject({
        code: 0,
        report: { ok: true, mode: 'file', exchanges: EXCHANGES, exits: [0, 0], beforeExit: [] },
      });
    },
    RUN_MS + 10_000,
  );
});
