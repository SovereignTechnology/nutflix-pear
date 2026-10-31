/**
 * Bare program for slice 5e-1 (spike S-D finding 10): does Bare keep long-lived children with a
 * stdin pipe, as the iroh helper needs? Two `cat` children through `bare-subprocess`, each fed
 * `ROUNDS` writes (small ones and 64 KiB ones, with a timer between) whose echo must come back
 * byte for byte, while a heartbeat interval counts; then stdin EOF, and both must exit 0.
 *
 * - Started by `bare-sidecar` (the worker's way, holding `Bare.IPC`): it reports one `log`
 *   event whose `msg` is the JSON `SubprocessProbeReport`.
 * - Started by the plain `bare` binary (no IPC, the spike's case): it writes that JSON to the
 *   file named by its last argument.
 *
 * A Bare `beforeExit` while exchanges are pending is recorded: it is the teardown S-D saw. Exits
 * 0 only on a report that says `ok`. Driven by `__tests__/bare-subprocess.test.ts` (CI).
 */
import './bare-globals.js';

import fs from 'bare-fs';
import { spawn as bareSpawn } from 'bare-subprocess';

import { encodeFrame } from '../ipc/framing.js';
import { SUBPROCESS_PROBE_ROUNDS, type SubprocessProbeReport } from './subprocess-probe.js';
import type { BareSpawn, BareSubprocessHandle } from './transcode/bare-subprocess-types.js';

// Its own typings drag in bare-pipe's; the slice used is `BareSpawn` (as in `adapters/bare.ts`).
const spawn = bareSpawn as unknown as BareSpawn;

const ROUNDS = SUBPROCESS_PROBE_ROUNDS;
const GAP_MS = 10;
const BIG = 64 * 1024;
const TICK_MS = 100;
const WATCHDOG_MS = 45_000;

const started = Date.now();
const ipc = Bare.IPC;
const resultFile = ipc === null ? Bare.argv.at(-1) : undefined;
let exchanges = 0;
let ticks = 0;
let pending = true;
const beforeExit: number[] = [];
const exits: (number | null)[] = [];

const heartbeat = setInterval(() => {
  ticks += 1;
}, TICK_MS);

function report(ok: boolean, error?: string): void {
  pending = false;
  clearInterval(heartbeat);
  const r: SubprocessProbeReport = {
    ok,
    mode: ipc === null ? 'file' : 'ipc',
    exchanges,
    ticks,
    elapsedMs: Date.now() - started,
    exits,
    beforeExit,
    ...(error === undefined ? {} : { error }),
  };
  const code = ok ? 0 : 1;
  if (ipc === null) {
    // Written synchronously: Bare.exit does not wait for a pipe to drain (spike S-D).
    if (resultFile !== undefined) fs.writeFileSync(resultFile, `${JSON.stringify(r)}\n`);
    Bare.exit(code);
  }
  ipc.write(encodeFrame({ op: 'ev', e: 'log', level: 'info', msg: JSON.stringify(r) }), () => {
    Bare.exit(code);
  });
}

Bare.on('beforeExit', () => {
  if (!pending) return;
  beforeExit.push(Date.now() - started);
  // Still pending at teardown: say so now, while the process can.
  report(false, `beforeExit with ${String(exchanges)} exchanges done`);
});

const watchdog = setTimeout(() => {
  report(false, `watchdog after ${String(exchanges)} exchanges`);
}, WATCHDOG_MS);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A `cat` child and a reader that waits for exactly `n` echoed bytes. */
function catChild(): {
  readonly c: BareSubprocessHandle;
  readonly exited: Promise<number | null>;
  read(n: number): Promise<Uint8Array>;
} {
  const c = spawn('cat', [], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  const chunks: Uint8Array[] = [];
  let held = 0;
  let want: { readonly n: number; readonly resolve: (b: Uint8Array) => void } | null = null;
  const take = (): void => {
    if (want === null || held < want.n) return;
    const out = new Uint8Array(want.n);
    let off = 0;
    while (off < want.n) {
      const head = chunks[0];
      if (head === undefined) break;
      const k = Math.min(head.byteLength, want.n - off);
      out.set(head.subarray(0, k), off);
      off += k;
      if (k === head.byteLength) chunks.shift();
      else chunks[0] = head.subarray(k);
    }
    held -= want.n;
    const done = want.resolve;
    want = null;
    done(out);
  };
  c.stdout?.on('data', (chunk) => {
    chunks.push(chunk);
    held += chunk.byteLength;
    take();
  });
  const exited = new Promise<number | null>((resolve) => {
    c.on('exit', (code) => {
      resolve(code);
    });
  });
  return {
    c,
    exited,
    read: (n) =>
      new Promise((resolve) => {
        want = { n, resolve };
        take();
      }),
  };
}

function payload(round: number): Uint8Array {
  const n = round % 5 === 4 ? BIG : 16;
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (round + i) & 0xff;
  return b;
}

async function pingPong(child: ReturnType<typeof catChild>): Promise<void> {
  const stdin = child.c.stdin;
  if (stdin === null || stdin === undefined) throw new Error('no stdin pipe');
  for (let round = 0; round < ROUNDS; round++) {
    const sent = payload(round);
    stdin.write(sent);
    const got = await child.read(sent.byteLength);
    for (let i = 0; i < sent.byteLength; i++) {
      if (got[i] !== sent[i]) throw new Error(`round ${String(round)}: byte ${String(i)} differs`);
    }
    exchanges += 1;
    await sleep(GAP_MS);
  }
  stdin.end();
}

void (async () => {
  try {
    const a = catChild();
    const b = catChild();
    await Promise.all([pingPong(a), pingPong(b)]);
    exits.push(await a.exited, await b.exited);
    clearTimeout(watchdog);
    const allExited = exits.every((code) => code === 0);
    // The heartbeat kept turning: at least half the ticks the run's length allows.
    const turning = ticks >= Math.floor((Date.now() - started) / TICK_MS / 2);
    report(
      allExited && turning && exchanges === 2 * ROUNDS,
      allExited ? (turning ? undefined : 'the heartbeat stalled') : 'a child did not exit 0',
    );
  } catch (e: unknown) {
    clearTimeout(watchdog);
    report(false, e instanceof Error ? e.message : 'failed');
  }
})();
