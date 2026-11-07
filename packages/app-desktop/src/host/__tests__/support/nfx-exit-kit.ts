/**
 * Test support (not a suite): the building blocks of the slice 5f exit runs, shared by the
 * one-machine run (`../nfx-exit.integration.test.ts`, tier 1) and the two-host run
 * (`../nfx-exit-two-host.integration.test.ts`): the binaries, the processes a suite starts (logged,
 * recorded, stopped), layout C of a rendition from its files, the test clip, and, for the two-host
 * run, the relays it is given and the identities both machines derive from one run id.
 */
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import type { WriteStream } from 'node:fs';
import { accessSync, constants, createWriteStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { delimiter, join } from 'node:path';

import type { IrohRelayUrl, NostrPubkey, RelayUrl, UnixSeconds } from '@sovit/core';
import { media, nfx, signer as signerMod } from '@sovit/core';

import type { SessionId } from '../../../ipc/protocol.js';
import { sleep } from '../../../worker/__tests__/helpers/harness.js';

/** An executable on PATH, or `''`. */
export function onPath(name: string): string {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // next
    }
  }
  return '';
}

/** The binaries the exit runs drive, from the workflow's environment. */
export const BIN = {
  nfxd: process.env['NFXD'] ?? '',
  nfxPackage: process.env['NFX_PACKAGE'] ?? '',
  irohRelay: process.env['IROH_RELAY'] ?? '',
  helper: process.env['NUTFLIX_IROH_HELPER'] ?? '',
  ffmpeg: process.env['FFMPEG'] ?? onPath('ffmpeg'),
  ffprobe: process.env['FFPROBE'] ?? onPath('ffprobe'),
};

export const hex = (n: number): string => randomBytes(n).toString('hex');
export const sha256 = (b: Uint8Array | string): string =>
  createHash('sha256').update(b).digest('hex');
export const nowS = (): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds;
export const sid = (): SessionId => hex(16) as SessionId;

// ---- processes ------------------------------------------------------------------------------

export interface Proc {
  readonly name: string;
  readonly child: ChildProcess;
  readonly log: WriteStream;
  /** stdout and stderr as they came, the last 1 MB. */
  text: string;
  exit: string | null;
}

const procs: Proc[] = [];
let logDir = '';

/** Where `start` writes each process's log (the suite's `beforeAll` sets it). */
export function setLogDir(dir: string): void {
  logDir = dir;
}

/** A long-running process the suite started; its pid is recorded for teardown. */
export function start(name: string, file: string, args: readonly string[]): Proc {
  const child = spawn(file, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(logDir, `${name}.log`));
  const p: Proc = { name, child, log, text: '', exit: null };
  const take = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    log.write(text);
    p.text = (p.text + text).slice(-1_000_000);
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  child.on('exit', (code, signal) => {
    p.exit = signal ?? String(code);
  });
  child.on('error', (e) => {
    p.exit = `spawn failed: ${e.message}`;
  });
  procs.push(p);
  return p;
}

export function tail(text: string, n = 40): string {
  return text.split('\n').slice(-n).join('\n');
}

/** Waits until `p`'s output matches `pattern`; fails with its last lines otherwise. */
export async function waitFor(
  p: Proc,
  pattern: RegExp,
  ms: number,
  what: string,
): Promise<RegExpMatchArray> {
  const end = Date.now() + ms;
  for (;;) {
    const m = pattern.exec(p.text);
    if (m !== null) return m;
    if (p.exit !== null)
      throw new Error(`${what}: ${p.name} exited (${p.exit}) first; it said:\n${tail(p.text)}`);
    if (Date.now() > end)
      throw new Error(`${what}: not within ${String(ms)} ms; ${p.name} said:\n${tail(p.text)}`);
    await sleep(200);
  }
}

export interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A short command, to its end (killed after `ms`). */
export function runOnce(file: string, args: readonly string[], ms = 300_000): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(file, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, ms);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\nspawn failed: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function mustRun(what: string, file: string, args: readonly string[]): Promise<Ran> {
  const r = await runOnce(file, args);
  if (r.code !== 0)
    throw new Error(`${what} exited ${String(r.code)}:\n${tail(`${r.stdout}\n${r.stderr}`)}`);
  return r;
}

/** Every process the suite started, by recorded child: SIGTERM, then SIGKILL after 5 s. */
export async function stopAll(): Promise<void> {
  await Promise.all(
    procs.splice(0).map(async (p) => {
      // Read through a call: `exit` is set by the child's event, across the awaits.
      const running = (): boolean => p.exit === null;
      if (running()) {
        p.child.kill('SIGTERM');
        const end = Date.now() + 5000;
        while (running() && Date.now() < end) await sleep(100);
        if (running()) p.child.kill('SIGKILL');
      }
      p.log.end();
    }),
  );
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a !== null ? a.port : 0;
      s.close(() => {
        resolve(port);
      });
    });
  });
}

export async function listening(port: number, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const c = net.connect(port, '127.0.0.1');
      c.once('connect', () => {
        c.destroy();
        resolve(true);
      });
      c.once('error', () => {
        resolve(false);
      });
    });
    if (ok) return;
    if (Date.now() > end) throw new Error(`${what}: nothing listens on ${String(port)}`);
    await sleep(200);
  }
}

// ---- media ----------------------------------------------------------------------------------

/** Every `<sha256>`-named file of an nfx-style store directory. */
export async function storeFiles(dir: string): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const name of await readdir(dir))
    if (/^[0-9a-f]{64}$/.test(name)) out.set(name, new Uint8Array(await readFile(join(dir, name))));
  return out;
}

/** Layout C of `rendition` (init, global sidx, segments from their moof), from the files. */
export function layoutC(
  list: nfx.HashList,
  files: ReadonlyMap<string, Uint8Array>,
  rendition: nfx.Rendition,
): Uint8Array {
  const file = (s: string): Uint8Array => {
    const b = files.get(s);
    if (b === undefined) throw new Error(`the package lacks ${s}`);
    return b;
  };
  const playlist = list.files.find((f) => f.role === 'playlist' && f.name === rendition.playlist);
  if (playlist === undefined) throw new Error(`no playlist for ${rendition.id}`);
  const members = nfx.renditionMembers(list, file(playlist.sha256));
  if (!members.ok) throw new Error(`${rendition.id}: ${members.error.reason}`);
  const { init } = members.value;
  const segments = members.value.segments.map((s) => ({
    sha256: s.sha256,
    size: Number(s.size),
    durMs: s.durMs === undefined ? 0 : Number(s.durMs),
  }));
  const head = segments[0];
  if (head === undefined) throw new Error(`${rendition.id} has no segments`);
  const planned = media.planNfxPlayback({
    init: { sha256: init.sha256, size: Number(init.size) },
    initBytes: file(init.sha256),
    segments,
    first: file(head.sha256),
  });
  if (!planned.ok) throw new Error(`${rendition.id}: ${planned.reason}`);
  const parts = planned.plan.layout.parts.map(({ part, size }) => {
    if (part.kind === 'bytes') return part.bytes;
    const skip = part.skip ?? 0;
    return file(part.sha256).subarray(skip, skip + size);
  });
  const out = new Uint8Array(planned.plan.layout.size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Real media: `seconds` of 1280x720 test pattern and a tone, H.264 + AAC. */
export async function makeClip(file: string, seconds = 8): Promise<void> {
  await mustRun('ffmpeg (the clip)', BIN.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1280x720:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    String(seconds),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    file,
  ]);
}

// ---- the two-host run: given relays, derived identities -------------------------------------

/** At most this many relays of each kind come in (`NFX_SCOPED_RELAYS`, `NFX_IROH_RELAYS`). */
export const MAX_GIVEN_RELAYS = 4;

export interface GivenRelays {
  /** The scoped Nostr relays (NFX-04) both machines meet on: `wss://` only. */
  readonly scoped: readonly RelayUrl[];
  /** The iroh relays (NFX-06 §1): `https://host[:port]/`, as the app's settings take them. */
  readonly iroh: readonly IrohRelayUrl[];
  /** A PEM file of CA certificates the iroh relays chain to (a private CA), or `null`. */
  readonly irohCa: string | null;
  /**
   * `NFX_RELAY_ONLY=true`: nfxd runs with `--relay-only`, so every byte it moves goes through the
   * iroh relays and none direct. The pear role is not changed by it (nfxd offers no direct path
   * for it to take).
   */
  readonly relayOnly: boolean;
}

const WSS_RE = /^wss:\/\/[a-z0-9.-]{1,253}(?::[1-9][0-9]{0,4})?\/?$/;
// The app's iroh relay form (ipc/guards.ts `isIrohRelayUrl`): lower-case, no trailing-dot host,
// exactly `/` for a path. iroh's own defaults print a trailing dot, which the app refuses.
const IROH_HTTPS_RE =
  /^https:\/\/[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*(?::[1-9][0-9]{0,4})?\/$/;

function list(name: string, re: RegExp): string[] {
  const raw = (process.env[name] ?? '').trim();
  const items = raw === '' ? [] : raw.split(/[\s,]+/);
  if (items.length > MAX_GIVEN_RELAYS)
    throw new Error(`${name}: at most ${String(MAX_GIVEN_RELAYS)} relays`);
  for (const u of items)
    if (!re.test(u)) throw new Error(`${name}: not a relay this run takes (${u.slice(0, 80)})`);
  if (new Set(items).size !== items.length) throw new Error(`${name}: a relay given twice`);
  return items;
}

/** `NFX_RELAY_ONLY`: unset or empty is false; otherwise exactly `true` or `false`. */
function relayOnlyFlag(): boolean {
  const raw = (process.env['NFX_RELAY_ONLY'] ?? '').trim();
  if (raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error('NFX_RELAY_ONLY: must be true or false');
}

/**
 * The relays the two-host run is given, validated: `wss://` scoped relays and `https://` iroh
 * relays, at most `MAX_GIVEN_RELAYS` each, at least one of each; `NFX_IROH_RELAY_CA` an optional
 * PEM path (option 1's private CA; a public relay needs none); `NFX_RELAY_ONLY` an optional
 * boolean that needs the iroh relays (nfxd refuses `--relay-only` without an `--iroh-relay`).
 */
export function givenRelays(): GivenRelays {
  const scoped = list('NFX_SCOPED_RELAYS', WSS_RE).map((u) => u.replace(/\/$/, '') as RelayUrl);
  const iroh = list('NFX_IROH_RELAYS', IROH_HTTPS_RE) as IrohRelayUrl[];
  const relayOnly = relayOnlyFlag();
  if (relayOnly && iroh.length === 0)
    throw new Error(
      'NFX_RELAY_ONLY=true needs NFX_IROH_RELAYS: nfxd --relay-only refuses to start without an --iroh-relay',
    );
  if (scoped.length === 0) throw new Error('NFX_SCOPED_RELAYS: at least one wss:// relay');
  if (iroh.length === 0) throw new Error('NFX_IROH_RELAYS: at least one https:// iroh relay');
  const ca = (process.env['NFX_IROH_RELAY_CA'] ?? '').trim();
  return { scoped, iroh, irohCa: ca === '' ? null : ca, relayOnly };
}

/**
 * The relay flags of an `nfxd run` for the given relays. With `relayOnly`, nfxd also gets
 * `--relay-only` (every byte through the iroh relays); it refuses that flag without an
 * `--iroh-relay` and together with `--gossip`, so the one is checked here and the other is never
 * passed: this function and the suite pass no gossip flag.
 */
export function nfxdRelayArgs(relays: GivenRelays): string[] {
  if (relays.relayOnly && relays.iroh.length === 0)
    throw new Error('relay-only needs at least one iroh relay');
  return [
    ...relays.scoped.flatMap((r) => ['--relay', r]),
    ...relays.iroh.flatMap((r) => ['--iroh-relay', r]),
    ...(relays.irohCa === null ? [] : ['--iroh-relay-ca', relays.irohCa]),
    ...(relays.relayOnly ? ['--relay-only'] : []),
  ];
}

/**
 * The two-host run's identities, the same on both machines from one run id: a throwaway secret
 * per role is sha256(`nfx-exit-two-host/<run id>/<role>`), so each side knows the other's pubkey
 * (and the address it publishes) without any inbound connection. Throwaway by construction:
 * anyone who knows the run id can derive them.
 */
export function derivedSecret(runId: string, role: string): string {
  if (!/^[0-9]{1,20}$/.test(runId)) throw new Error('the run id must be digits');
  return sha256(`nfx-exit-two-host/${runId}/${role}`);
}

/** A local signer for a derived secret (cheap KDF: the key file is never kept). */
export async function derivedSigner(secretHex: string): Promise<signerMod.LocalSigner> {
  const secretKey = Uint8Array.from(Buffer.from(secretHex, 'hex'));
  const { signer } = await signerMod.LocalSigner.create({
    passphrase: randomBytes(16),
    secretKey,
    cost: signerMod.minimumCost(),
  });
  secretKey.fill(0);
  return signer;
}

/** An nfxd key file (one line of hex, mode 0600) for a derived secret; its pubkey back. */
export async function writeNfxdKey(file: string, secretHex: string): Promise<NostrPubkey> {
  await writeFile(file, `${secretHex}\n`, { mode: 0o600 });
  const signer = await derivedSigner(secretHex);
  return signer.getPublicKey();
}
