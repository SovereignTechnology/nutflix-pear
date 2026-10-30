// Spike S-D check 7: the iroh helper under the REAL Bare runtime, through bare-subprocess with a
// stdin pipe (the transcode path never writes to a child, so this was unproven). Two helpers on
// loopback: A imports a file and forms a collection; B dials A's ticket, gets the collection and
// the file (checked against its sha256 under Bare, through sodium), and refuses the same bytes
// under a wrong sha256; B is SIGKILLed and the supervisor restarts it; both close cleanly on
// stdin EOF. Prints one JSON line and exits 0 only if every step held.
//
// Bundled by esbuild (npm packages external) and started by a boot module that loads
// bare-encoding's globals first, as packages/app-desktop/src/worker/__tests__/helpers/bare.ts
// does. CI only: .github/workflows/spike-iroh.yml.
//
//   bare boot.mjs <helper binary> <work dir> <data file> <its sha256> <result file>
//
// The result is written to <result file> synchronously before exiting: Bare.exit does not wait
// for stdout to drain into a pipe, so a console.log just before it can be lost. Every step and
// every helper event is appended to <result file>.progress as it happens, and a watchdog ends a
// run that stalls with a result naming the last step reached.
import fs from 'bare-fs';
import { spawn } from 'bare-subprocess';

import {
  IrohHelper,
  PoisonedError,
  bareHelperSpawn,
} from '../../packages/app-desktop/dist/worker/iroh/index.js';

const [helperFile, work, dataFile, dataSha, resultFile] = Bare.argv.slice(-5);
const result = { ok: false, steps: [] };
const progress = (line) => fs.appendFileSync(`${resultFile}.progress`, `${Date.now()} ${line}\n`);
const step = (name, detail = {}) => {
  result.steps.push({ name, ...detail });
  progress(`step ${name} ${JSON.stringify(detail)}`);
};
const finish = (code) => {
  fs.writeFileSync(resultFile, `${JSON.stringify(result)}\n`);
  progress(`exit ${code}`);
  Bare.exit(code);
};
progress('smoke loaded');
// Shows whether the event loop is still turning when nothing else happens.
const heartbeat = setInterval(() => progress('tick'), 5_000);
const watchdog = setTimeout(() => {
  result.error = `watchdog: stalled after ${result.steps.at(-1)?.name ?? 'start'}`;
  finish(2);
}, 100_000);

function helper(name, children, events) {
  const base = bareHelperSpawn(spawn);
  return new IrohHelper({
    spawn: (file, args) => {
      const c = base(file, args);
      children.push(c);
      // The pipe traffic, by size: where a stalled exchange stopped.
      const write = c.stdin.write.bind(c.stdin);
      c.stdin.write = (chunk) => {
        progress(`stdin ${name} ${chunk.length}`);
        return write(chunk);
      };
      c.stdout.on('data', (chunk) => progress(`stdout ${name} ${chunk.length}`));
      return c;
    },
    file: helperFile,
    stateDir: `${work}/${name}`,
    init: { relays: [] },
    restart: { minMs: 50, maxMs: 200 },
    onEvent: (e) => {
      events.push({ helper: name, ...e });
      progress(`event ${name} ${JSON.stringify(e)}`);
    },
  });
}

const until = async (test, ms, what) => {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

const events = [];
const childrenA = [];
const childrenB = [];
const a = helper('a', childrenA, events);
const b = helper('b', childrenB, events);
try {
  fs.mkdirSync(`${work}/a`, { recursive: true });
  fs.mkdirSync(`${work}/b`, { recursive: true });
  const size = fs.statSync(dataFile).size;

  const reachA = await a.start();
  step('a-init', { node: reachA.node.slice(0, 8), addrs: reachA.addrs.length });
  const imported = await a.import(dataFile);
  if (imported.size !== size) throw new Error('import size');
  const seq = await a.seq([imported.hash], 'smoke/one');
  step('a-import-seq');

  await b.start();
  const dialed = await b.dialTicket(seq.ticket, reachA.node, []);
  if (dialed === null || dialed.hash !== seq.hash) throw new Error('ticket');
  if ((await b.dialTicket(seq.ticket, 'ff'.repeat(32), [])) !== null)
    throw new Error('a ticket naming another node was dialled');
  const members = await b.getSeq(dialed.conn, dialed.hash, { maxMembers: 1, exact: true });
  if (members[0] !== imported.hash) throw new Error('collection member');
  const got = await b.getFile(dialed.conn, imported.hash, { sha256: dataSha, maxBytes: size });
  if (got.length !== size) throw new Error('size');
  let refused = false;
  try {
    await b.getFile(dialed.conn, imported.hash, { sha256: '00'.repeat(32), maxBytes: size });
  } catch (e) {
    refused = e instanceof PoisonedError;
  }
  if (!refused) throw new Error('bytes under a wrong sha256 were returned');
  step('b-get', { bytes: got.length, wrong_sha256_refused: refused });

  childrenB[childrenB.length - 1].kill('SIGKILL');
  await until(() => b.restarts === 1, 10_000, 'the restart');
  await b.addr();
  step('b-restarted');

  await a.close();
  await b.close();
  const exits = events.filter((e) => e.type === 'exit');
  const clean = exits
    .filter((e) => e.code === 0)
    .map((e) => e.helper)
    .sort();
  if (clean.join() !== 'a,b') throw new Error(`clean exits: ${clean.join()}`);
  step('closed', { exits: exits.map((e) => `${e.helper}:${e.code ?? e.signal}`) });
  result.ok = true;
} catch (e) {
  result.error = e instanceof Error ? e.message : String(e);
  result.events = events.slice(-20);
  await a.close().catch(() => undefined);
  await b.close().catch(() => undefined);
}
clearTimeout(watchdog);
clearInterval(heartbeat);
finish(result.ok ? 0 : 1);
