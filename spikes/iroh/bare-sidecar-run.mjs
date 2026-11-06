// Starts a Bare program the way the host starts the worker (D2): through bare-sidecar, so the
// program holds `Bare.IPC` (fd 3). Spike S-D's finding 10 is the plain `bare` binary, without that
// pipe, tearing itself down mid-run while it holds a subprocess; slice 5e-1 reproduced it with
// `cat` and showed it never happens in the worker's configuration (run 41189554679). The spike's
// Bare check therefore starts its smoke test here. CI only: .github/workflows/spike-iroh.yml.
//
//   node bare-sidecar-run.mjs <program> [args…]
//
// Bare's stdout and stderr pass through; the IPC pipe is held open and drained, never written.
// Exits with Bare's exit code, or 128 + the signal's number when Bare dies of one (as a shell
// reports it). A SIGTERM or SIGINT here (the workflow's `timeout`) kills Bare first, so no run
// outlives its time limit.
import { constants } from 'node:os';

import Sidecar from 'bare-sidecar';

const [program, ...args] = process.argv.slice(2);
if (program === undefined) {
  process.stderr.write('usage: node bare-sidecar-run.mjs <program> [args…]\n');
  process.exit(64);
}

const sidecar = new Sidecar(program, args);
sidecar.stdout.pipe(process.stdout);
sidecar.stderr.pipe(process.stderr);
// Hold and drain the IPC pipe: the smoke reports through its result file, not here.
sidecar.on('data', () => undefined);
sidecar.on('error', (e) => {
  process.stderr.write(`bare-sidecar-run: ipc: ${e instanceof Error ? e.message : String(e)}\n`);
});

let status = 1;
sidecar.once('exit', (code, signal) => {
  status = code ?? 128 + (constants.signals[signal] ?? 0);
});
// The child's `close` (its stdio drained) destroys the sidecar stream, which then closes.
sidecar.once('close', () => {
  process.exit(status);
});

for (const name of ['SIGTERM', 'SIGINT'])
  process.once(name, () => {
    process.stderr.write(`bare-sidecar-run: ${name}, killing Bare\n`);
    sidecar.destroy();
  });
