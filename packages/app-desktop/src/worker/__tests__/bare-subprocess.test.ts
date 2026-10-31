/**
 * Slice 5e-1 (spike S-D finding 10): the real Bare runtime holding long-lived children with a
 * stdin pipe, as the iroh helper needs (ADR 0021). S-D saw Bare tear itself down mid-run with a
 * live subprocess and timers; it ran without `Bare.IPC`, which the real worker always holds.
 *
 * `subprocess-probe-entry.ts` runs two `cat` children through `bare-subprocess` (small and 64 KiB
 * echoes, a timer between, a heartbeat), started by bare-sidecar as the host starts the worker.
 *
 * Run 41189554679 measured both ways, three runs each: under bare-sidecar all three passed; under
 * the plain `bare` without IPC (the spike's way) all three failed as S-D's did, two hanging with
 * every timer dead and one exiting 0 after 173 ms with no report. So finding 10 is Bare's (it
 * happens with `cat`) and does not reach the worker; the plain-`bare` runs are not kept here (each
 * failure costs a 50 s hang). `docs/spikes/S-D-iroh-helper.md` records it.
 */
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WorkerToHost } from '../../ipc/worker-protocol.js';
import {
  SUBPROCESS_PROBE_CHILDREN,
  SUBPROCESS_PROBE_ROUNDS,
  type SubprocessProbeReport,
} from '../subprocess-probe.js';
import { WORKER_SRC, bundleForBare, spawnBare } from './helpers/bare.js';

const EXCHANGES = SUBPROCESS_PROBE_ROUNDS * SUBPROCESS_PROBE_CHILDREN;
const RUN_MS = 50_000;

let bundle: { readonly file: string; cleanup(): Promise<void> };

beforeAll(async () => {
  bundle = await bundleForBare(join(WORKER_SRC, 'subprocess-probe-entry.ts'));
});
afterAll(async () => {
  await bundle.cleanup();
});

const isLog = (m: WorkerToHost): m is Extract<WorkerToHost, { e: 'log' }> =>
  m.op === 'ev' && m.e === 'log';

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
});
