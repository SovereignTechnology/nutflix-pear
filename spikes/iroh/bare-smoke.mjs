// Spike S-D check 7: the iroh helper under the REAL Bare runtime, through bare-subprocess with a
// stdin pipe (the transcode path never writes to a child, so this was unproven). Two helpers on
// loopback: A imports a file and forms a collection, B decodes the ticket, dials A and gets the
// collection and the file; B is SIGKILLed and the supervisor restarts it; both close cleanly on
// stdin EOF. Prints one JSON line and exits 0 only if every step held.
//
// Bundled by esbuild (npm packages external) and started by a boot module that loads
// bare-encoding's globals first, as packages/app-desktop/src/worker/__tests__/helpers/bare.ts
// does. CI only: .github/workflows/spike-iroh.yml.
//
//   bare boot.mjs <helper binary> <work dir>
import fs from 'bare-fs';
import { spawn } from 'bare-subprocess';

import {
  IrohHelper,
  bareHelperSpawn,
  dialTarget,
} from '../../packages/app-desktop/dist/worker/iroh/index.js';

const [helperFile, work] = Bare.argv.slice(-2);
const result = { ok: false, steps: [] };
const step = (name, detail = {}) => result.steps.push({ name, ...detail });

function helper(name, children, events) {
  const base = bareHelperSpawn(spawn);
  return new IrohHelper({
    spawn: (file, args) => {
      const c = base(file, args);
      children.push(c);
      return c;
    },
    file: helperFile,
    stateDir: `${work}/${name}`,
    init: { relays: [] },
    restart: { minMs: 50, maxMs: 200 },
    onEvent: (e) => events.push({ helper: name, ...e }),
  });
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
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
  const data = new Uint8Array(300 * 1024);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 31 + 7) & 0xff;
  fs.writeFileSync(`${work}/file.bin`, data);

  const reachA = await a.start();
  step('a-init', { node: reachA.node.slice(0, 8), addrs: reachA.addrs.length });
  const imported = await a.import(`${work}/file.bin`);
  if (imported.size !== data.length) throw new Error('import size');
  const seq = await a.seq([imported.hash], 'smoke/one');
  step('a-import-seq');

  await b.start();
  const ticket = await b.ticket(seq.ticket);
  const target = dialTarget(ticket, reachA.node, []);
  if (target === null || ticket.hash !== seq.hash) throw new Error('ticket');
  // Loopback only: the addresses A reported, narrowed to 127.0.0.1 when it has one.
  const local = target.addrs.filter((x) => x.startsWith('127.0.0.1:'));
  const conn = await b.dial({ ...target, addrs: local.length > 0 ? local : target.addrs });
  const members = await b.get(conn, ticket.hash, 32);
  if (members.length !== 32) throw new Error('collection size');
  const got = await b.get(conn, imported.hash, data.length);
  if (!equal(got, data)) throw new Error('bytes differ');
  step('b-get', { bytes: got.length });

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
console.log(JSON.stringify(result));
Bare.exit(result.ok ? 0 : 1);
