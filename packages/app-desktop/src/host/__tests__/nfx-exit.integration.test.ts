/**
 * Slice 5f (ADR 0020; nfx ADR 0101 §6, ADR 0103 §3): the exit run. Free videos cross between
 * the two implementations over iroh-blobs (NFX-06) on `nfx:testnet:1`, every file sha256-checked,
 * with nothing mocked on the wire:
 *
 * - **nfx's side:** `nfxd` and `nfx-package` built from nfx (`.github/workflows/nfx-exit.yml`
 *   pins the commit), nfxd's embedded scoped relay (NFX-04) as the network's Nostr relay, and the
 *   stock `iroh-relay` as the network's iroh relay, both on 127.0.0.1.
 * - **This app's side:** the real worker (`startWorker`, the real wire) with the real iroh
 *   helper, and the host's own NFX code: the catalogue (`nfx.listNfxVideos`), the beacon reader
 *   (`NfxBeaconWatch`, `beaconPeers`), the manifest builder (`nfxManifestFor`), the beacon publisher
 *   (`NfxBeacons`) with a real seeder key (`NfxSeederKey`), and the Nostr pool the host uses
 *   (`nostr.SimplePoolAdapter`).
 *
 * The pairs:
 *   A. nfxd packages, publishes and seeds; this app lists it, reads its beacon, and plays every
 *      rendition over iroh only: layout C byte for byte, a mid-file Range, and ffmpeg decodes it.
 *   B. this app packages the way Studio does (transcode, then `packageUploadForNfx`), publishes
 *      the manifest and beacons; a second nfxd fetches it (its own verification passes, it seeds),
 *      holds every file under its sha256, and its origin serves HLS that ffmpeg decodes.
 *   E. without a helper, an nfxd-only video is refused at once (`no-seeders`), never hangs.
 *
 * nfxd's embedded relay checks every manifest and beacon with nfx-proto, so each publish of this
 * app's being accepted is itself an interoperability check.
 *
 * Runs only with `NUTFLIX_EXIT_RUN=1` (the exit workflow); then every missing binary FAILS it,
 * never skips it. Process logs go to `NUTFLIX_EXIT_LOGS` (uploaded by the workflow).
 */
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import type { WriteStream } from 'node:fs';
import { accessSync, constants, createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { delimiter, join } from 'node:path';

import type {
  IrohRelayUrl,
  NfxVideo,
  NostrEvent,
  NostrFilter,
  NostrPubkey,
  RelayUrl,
  UnixSeconds,
  VideoManifest,
} from '@sovit/core';
import { media, nfx, nostr } from '@sovit/core';
import { nodeFsAdapter, nodeProcessRunner, nodeSha256 } from '@sovit/core/media/node';
import { silentLogger } from '@sovit/seeder';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SessionId } from '../../ipc/protocol.js';
import type { NfxIrohEndpointWire, WorkerEvent } from '../../ipc/worker-protocol.js';
import { devMockProviders } from '../../worker/dev/dev-mocks.js';
import type { DevTestnet } from '../../worker/dev/fixtures-net.js';
import { startDevTestnet } from '../../worker/dev/fixtures-net.js';
import { LoopbackPayHub } from '../../worker/dev/loopback-pay.js';
import { packageUploadForNfx } from '../../worker/studio/nfx.js';
import type { WorkerClient } from '../../worker/__tests__/helpers/harness.js';
import {
  httpGet,
  sleep,
  startWorker,
  tempDir,
  within,
} from '../../worker/__tests__/helpers/harness.js';
import { memoryLogger } from '../log.js';
import { NfxBeacons } from '../nfx/beacons.js';
import { NfxBeaconWatch } from '../nfx/beacon-watch.js';
import { beaconPeers, videoOf } from '../nfx/play.js';
import { isSignedManifest, nfxManifestFor } from '../nfx/publish.js';
import { NfxSeederKey } from '../nfx/seeder-key.js';
import { coreTestKit } from './support/core-helpers.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });

const EXIT = process.env['NUTFLIX_EXIT_RUN'] === '1';
const NS = 'nfx:testnet:1';
/** How long nfxd may take to resolve, fetch and announce a video. */
const NFXD_WITHIN_MS = 180_000;
/** How long the seeding worker may take to import and ticket a video over iroh. */
const SERVE_WITHIN_MS = 90_000;

/** An executable on PATH, or `''`. */
function onPath(name: string): string {
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

const BIN = {
  nfxd: process.env['NFXD'] ?? '',
  nfxPackage: process.env['NFX_PACKAGE'] ?? '',
  irohRelay: process.env['IROH_RELAY'] ?? '',
  helper: process.env['NUTFLIX_IROH_HELPER'] ?? '',
  ffmpeg: process.env['FFMPEG'] ?? onPath('ffmpeg'),
  ffprobe: process.env['FFPROBE'] ?? onPath('ffprobe'),
};

const hex = (n: number): string => randomBytes(n).toString('hex');
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const nowS = (): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds;
const sid = (): SessionId => hex(16) as SessionId;

// ---- processes ------------------------------------------------------------------------------

interface Proc {
  readonly name: string;
  readonly child: ChildProcess;
  readonly log: WriteStream;
  /** stdout and stderr as they came, the last 1 MB. */
  text: string;
  exit: string | null;
}

const procs: Proc[] = [];
let logDir = '';

/** A long-running process this suite started; its pid is recorded for teardown. */
function start(name: string, file: string, args: readonly string[]): Proc {
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

function tail(text: string, n = 40): string {
  return text.split('\n').slice(-n).join('\n');
}

/** Waits until `p`'s output matches `pattern`; fails with its last lines otherwise. */
async function waitFor(
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

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A short command, to its end (killed after `ms`). */
function runOnce(file: string, args: readonly string[], ms = 300_000): Promise<Ran> {
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

async function mustRun(what: string, file: string, args: readonly string[]): Promise<Ran> {
  const r = await runOnce(file, args);
  if (r.code !== 0)
    throw new Error(`${what} exited ${String(r.code)}:\n${tail(`${r.stdout}\n${r.stderr}`)}`);
  return r;
}

/** Every process this suite started, by recorded child: SIGTERM, then SIGKILL after 5 s. */
async function stopAll(): Promise<void> {
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

function freePort(): Promise<number> {
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

async function listening(port: number, ms: number, what: string): Promise<void> {
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

/** Every `<sha256>`-named file of an nfx-style store directory. */
async function storeFiles(dir: string): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const name of await readdir(dir))
    if (/^[0-9a-f]{64}$/.test(name)) out.set(name, new Uint8Array(await readFile(join(dir, name))));
  return out;
}

/** Layout C of `rendition` (init, global sidx, segments from their moof), from the files. */
function layoutC(
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

// ---- the suite --------------------------------------------------------------------------------

describe.skipIf(!EXIT)('slice 5f: the exit run, nutflix-pear ⇄ nfxd over iroh', () => {
  const teardown: (() => Promise<void>)[] = [];
  const pool = new nostr.SimplePoolAdapter();
  let work = '';
  let clip = '';
  let scoped = '' as RelayUrl;
  let irohRelay = '' as IrohRelayUrl;
  let testnet: DevTestnet;
  /** Pair A's video and the iroh endpoint its nfxd beacons (E reuses them). */
  let videoA: NfxVideo | null = null;
  let endpointA: NfxIrohEndpointWire | null = null;

  beforeAll(async () => {
    const missing = Object.entries(BIN)
      .filter(([, p]) => p === '' || !existsSync(p))
      .map(([k]) => k);
    if (missing.length > 0)
      throw new Error(`the exit run needs every binary; missing: ${missing.join(', ')}`);
    const d = await tempDir('nf-exit-');
    teardown.push(() => d.rm());
    work = d.dir;
    logDir = process.env['NUTFLIX_EXIT_LOGS'] ?? join(work, 'logs');
    await mkdir(logDir, { recursive: true });

    // The network's iroh relay: the stock binary, plain HTTP on loopback (this app's setting
    // allows http:// to this computer only), no QUIC address discovery.
    const q = await freePort();
    const toml = join(work, 'iroh-relay.toml');
    await writeFile(
      toml,
      `enable_relay = true\nhttp_bind_addr = "127.0.0.1:${String(q)}"\nenable_quic_addr_discovery = false\nenable_metrics = false\n`,
    );
    start('iroh-relay', BIN.irohRelay, ['--config-path', toml]);
    await listening(q, 30_000, 'the iroh relay');
    irohRelay = `http://127.0.0.1:${String(q)}/` as IrohRelayUrl;

    // The network's scoped Nostr relay: nfxd's embedded one, which checks every event it takes.
    const p = await freePort();
    const relay = start('nostr-relay', BIN.nfxd, [
      'run',
      '--store',
      join(work, 'relay-store'),
      '--embed-relay',
      `127.0.0.1:${String(p)}`,
      '--namespace',
      NS,
    ]);
    const m = await waitFor(relay, /embedded relay: (ws:\/\/\S+)/, 60_000, 'the scoped relay');
    scoped = (m[1] ?? '') as RelayUrl;

    testnet = await startDevTestnet();
    teardown.push(() => testnet.destroy());

    // Real media: 8 s of 1280x720 test pattern and a tone.
    clip = join(work, 'clip.mp4');
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
      '8',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      clip,
    ]);
  });

  afterAll(async () => {
    pool.close();
    for (const t of teardown.splice(0).reverse()) await t().catch(() => undefined);
    await stopAll();
  });

  /** Verified events on the scoped relay matching `filter`. */
  async function query(filter: NostrFilter): Promise<NostrEvent[]> {
    const raw = await pool.query([scoped], filter, { maxWaitMs: 4000 });
    return raw.flatMap((r) => {
      const ev = nostr.verifyIncoming(r);
      return ev === null ? [] : [ev];
    });
  }

  /** The current free NFX video at `address` as this app's catalogue lists it, or `null`. */
  async function listed(address: string): Promise<NfxVideo | null> {
    const events = await query({ kinds: [nfx.KIND_MANIFEST], '#n': [NS] });
    return nfx.listNfxVideos(NS, events, [], nowS()).find((v) => v.id === address) ?? null;
  }

  type LogEvent = Extract<WorkerEvent, { e: 'log' }>;
  const logs = (w: WorkerClient): string =>
    tail(
      w.events
        .filter((e): e is LogEvent => e.e === 'log')
        .map((e) => `${e.level}: ${e.msg}`)
        .join('\n'),
    );

  /** A watcher: no payment providers, NFX on with the network's iroh relay, a helper or none. */
  async function watcher(helper: string | null): Promise<WorkerClient> {
    const d = await tempDir('nf-exit-watch-');
    teardown.push(() => d.rm());
    const w = startWorker({ logLevel: 'info', testBootstrap: testnet.bootstrap });
    teardown.push(() => w.close());
    await w.call('init', {
      v: 1,
      storage: d.dir,
      seeding: { enabled: false, diskCapBytes: 1024 ** 3 },
      prefetchSeconds: 30,
      nfx: { enabled: true, irohRelays: [irohRelay] },
      ...(helper === null ? {} : { irohHelper: helper }),
    });
    return w;
  }

  it('A: nfxd packages and seeds; this app lists it and plays every rendition over iroh', async () => {
    // nfx's side: package, publish, seed.
    const videoId = `exit-a-${hex(6)}`;
    const pkg = join(work, 'pkg-a');
    await mustRun('nfx-package', BIN.nfxPackage, [
      clip,
      '--video',
      `${NS}:${videoId}`,
      '--out',
      pkg,
      '--max-height',
      '720',
      '--preset',
      'veryfast',
    ]);
    const key = join(work, 'creator-a.key');
    const creator = (await mustRun('nfxd key new', BIN.nfxd, ['key', 'new', key])).stdout
      .split('\n')[0]
      ?.trim();
    expect(creator).toMatch(/^[0-9a-f]{64}$/);
    const published = await mustRun('nfxd publish', BIN.nfxd, [
      'publish',
      '--key',
      key,
      '--relay',
      scoped,
      '--package',
      pkg,
      '--title',
      'exit run A',
    ]);
    const address = published.stdout.trim();
    expect(address).toBe(`${String(nfx.KIND_MANIFEST)}:${creator ?? ''}:${NS}:${videoId}`);
    const seedStore = join(work, 'seed-a-store');
    await cp(join(pkg, 'store'), seedStore, { recursive: true });
    const seeder = start('nfxd-seed-a', BIN.nfxd, [
      'run',
      '--key',
      key,
      '--store',
      seedStore,
      '--state',
      join(work, 'seed-a-state'),
      '--relay',
      scoped,
      '--seed',
      address,
      '--iroh-relay',
      irohRelay,
    ]);
    await waitFor(seeder, new RegExp(`${address}: Seeding`), NFXD_WITHIN_MS, 'nfxd seeding A');

    // This app's catalogue lists it, free, with the package's root.
    const files = await storeFiles(join(pkg, 'store'));
    const video = await listed(address);
    expect(video, 'the catalogue lists nfxd’s manifest').not.toBeNull();
    if (video === null) return;
    videoA = video;
    const addr = nfx.VideoAddr.parse(`${NS}:${videoId}`);
    if (!addr.ok) throw new Error('bad address');
    const verified = nfx.verifyHashList(
      files.get(video.root) ?? new Uint8Array(0),
      video.root,
      addr.value,
      BigInt(video.segs),
    );
    expect(verified.ok, 'the package’s hash list is the manifest’s').toBe(true);
    if (!verified.ok) return;
    const list = verified.value;
    expect(list.renditions.length).toBeGreaterThanOrEqual(2);

    // Its beacon, read as the host reads it: live (NFX-04: a scoped relay never stores one; the
    // first exit run found the host's one-shot query), so within one republish interval. One iroh
    // endpoint, no HyperDHT one (nfxd speaks iroh only), the relay ours.
    const watch = new NfxBeaconWatch({
      subscribe: (filter, relays, onEvent) =>
        pool.subscribe(relays, [filter], {
          onevent: (raw) => {
            const ev = nostr.verifyIncoming(raw);
            if (ev !== null) onEvent(ev);
          },
        }),
      now: nowS,
    });
    teardown.push(() => {
      watch.close();
      return Promise.resolve();
    });
    const events = await watch.wait(
      video,
      [scoped],
      (evs) => beaconPeers(video, evs, nowS(), [irohRelay]).iroh.length > 0,
      75_000,
    );
    const sources = beaconPeers(video, events, nowS(), [irohRelay]);
    expect(sources.hyperdht).toEqual([]);
    expect(sources.iroh, `nfxd said:\n${tail(seeder.text)}`).toHaveLength(1);
    const endpoint = sources.iroh[0];
    if (endpoint === undefined) return;
    endpointA = endpoint;

    // This app plays it: every rendition over iroh only, byte for byte, and decodable.
    const w = await watcher(BIN.helper);
    for (const r of list.renditions) {
      const expected = layoutC(list, files, r);
      const open = {
        sid: sid(),
        video: `${NS}:${videoId}`,
        root: video.root,
        segs: video.segs,
        rendition: r.id,
        peers: [],
        iroh: [endpoint],
        prefetchSeconds: 30,
      };
      const opened = await within(w.call('nfx.play.open', open), 120_000, `open ${r.id}`).catch(
        (e: unknown) => {
          throw new Error(`${r.id}: ${String(e)}\nthe worker said:\n${logs(w)}`);
        },
      );
      expect(opened.rendition).toBe(r.id);
      const whole = await httpGet(opened.link);
      expect(whole.status).toBe(200);
      expect(whole.body.length, `${r.id}: the whole view`).toBe(expected.length);
      expect(sha256(whole.body), `${r.id}: layout C, byte for byte`).toBe(sha256(expected));
      const at = Math.floor(expected.length / 2);
      const range = await httpGet(opened.link, {
        range: `bytes=${String(at)}-${String(at + 65_535)}`,
      });
      expect(range.status).toBe(206);
      expect(range.body.equals(Buffer.from(expected.subarray(at, at + 65_536)))).toBe(true);
      const decoded = await runOnce(BIN.ffmpeg, [
        '-v',
        'error',
        '-i',
        opened.link,
        '-f',
        'null',
        '-',
      ]);
      expect(decoded.code, `${r.id}: ffmpeg decodes it:\n${tail(decoded.stderr)}`).toBe(0);
      expect(decoded.stderr.trim(), `${r.id}: ffmpeg reports no error`).toBe('');
      await w.call('nfx.play.close', { sid: open.sid });
    }
  });

  it('B: this app packages like Studio and seeds; nfxd fetches, verifies, seeds and serves it', async () => {
    // This app's side: a seeding worker (mock payment providers give it a seeder), the network's
    // iroh relay, the helper.
    const hub = new LoopbackPayHub();
    const d = await tempDir('nf-exit-seed-');
    teardown.push(() => d.rm());
    const w = startWorker({
      hub,
      logLevel: 'info',
      testBootstrap: testnet.bootstrap,
      providers: () => devMockProviders({ hub, label: `exit-${hex(4)}` }),
    });
    teardown.push(() => w.close());
    await w.call('init', {
      v: 1,
      storage: d.dir,
      seeding: { enabled: true, diskCapBytes: 1024 ** 3 },
      prefetchSeconds: 30,
      nfx: { enabled: true, irohRelays: [irohRelay] },
      irohHelper: BIN.helper,
    });
    await w.event((e): e is Extract<WorkerEvent, { e: 'ready' }> => e.e === 'ready', 20_000);
    const seeder = w.host.internals.seeder;
    if (seeder === null) throw new Error('the seeding worker has no seeder');

    // Studio's path: transcode the H.264 ladder, then package it for NFX into the worker's store.
    const fs = nodeFsAdapter({ tmpDir: work });
    const runner = nodeProcessRunner();
    const binaries = { ffmpeg: BIN.ffmpeg, ffprobe: BIN.ffprobe };
    const pipeline = media.createMediaPipeline({ runner, fs, sha256: nodeSha256, binaries });
    const plan = pipeline.plan(await pipeline.probe(clip), { codec: 'h264' });
    // The caller makes the work directory, as Studio's upload does (the first run had none).
    await mkdir(join(work, 'transcode-b'), { recursive: true });
    const output = await pipeline.transcode(clip, plan, () => undefined, {
      workDir: join(work, 'transcode-b'),
    });
    const legacyId = hex(32);
    const status = await packageUploadForNfx(
      { legacyEventId: legacyId, satsPerBlock: 0, output },
      { store: seeder.nfx, runner, fs, sha256: nodeSha256, binaries, logger: silentLogger },
    );
    expect(status.state, JSON.stringify(status)).toBe('stored');
    if (status.state !== 'stored') return;

    // The manifest the host builds for a free upload, signed by the user, accepted by nfx's relay.
    const kit = await coreTestKit();
    const user = new kit.TestSigner();
    const legacy = {
      id: legacyId,
      kind: 21,
      author: user.pubkey,
      title: 'exit run B',
      description: 'Packaged by nutflix-pear, fetched by nfxd.',
      publishedAt: nowS(),
      durationSec: 8,
      tags: ['exit-run'],
      renditions: [],
      price: {} as never,
      blossomServers: [],
      event: {} as never,
    } as unknown as VideoManifest;
    const built = nfxManifestFor(legacy, status, nowS());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const manifest = await user.signEvent({
      ...built.draft.event,
      tags: built.draft.event.tags.map((t) => [...t]),
    });
    expect(isSignedManifest(manifest, built.draft, user.pubkey)).toBe(true);
    const sent = await pool.publish([scoped], manifest);
    expect(
      sent.map((r) => r.ok),
      `nfx's relay takes this app's manifest: ${JSON.stringify(sent)}`,
    ).toEqual([true]);
    const address = `${String(nfx.KIND_MANIFEST)}:${user.pubkey}:${status.video}`;
    expect((await listed(address))?.root).toBe(status.root);

    // Served over iroh, then beaconed by the host's own publisher with a real seeder key.
    const deadline = Date.now() + SERVE_WITHIN_MS;
    for (;;) {
      const r = await w.call('nfx.endpoint', { seeder: user.pubkey, video: status.video });
      if (r.iroh !== null) break;
      if (Date.now() > deadline) throw new Error(`no iroh endpoint in time:\n${logs(w)}`);
      await sleep(500);
    }
    const keyDir = await tempDir('nf-exit-key-');
    teardown.push(() => keyDir.rm());
    const seederKey = await NfxSeederKey.open({
      dir: join(keyDir.dir, 'nfx'),
      network: NS,
      user: user.pubkey,
      seal: user,
    });
    const refused: string[] = [];
    const beacons = new NfxBeacons({
      scopedRelays: () => [scoped],
      key: () => Promise.resolve(seederKey),
      endpoint: (s: NostrPubkey, video: string) => w.call('nfx.endpoint', { seeder: s, video }),
      irohRelays: () => [irohRelay],
      stored: async () => (await w.call('nfx.videos', {})).videos,
      seeded: () => [{ video: status.video, author: user.pubkey, root: status.root }],
      manifest: (a) => listed(a),
      send: async (event, relays) => {
        const r = await pool.publish(relays, event);
        for (const x of r) if (!x.ok) refused.push(x.reason ?? 'refused');
        return r.filter((x) => x.ok).length;
      },
      now: nowS,
      log: memoryLogger(),
    });
    const round = await beacons.round();
    expect(refused, 'nfx’s relay takes this app’s beacon').toEqual([]);
    expect(round.published).toBe(1);

    // nfx's side: a fresh nfxd fetches it from this app, checks it and seeds it.
    const key = join(work, 'fetcher-b.key');
    await mustRun('nfxd key new', BIN.nfxd, ['key', 'new', key]);
    const store = join(work, 'fetch-b-store');
    const o = await freePort();
    const fetcher = start('nfxd-fetch-b', BIN.nfxd, [
      'run',
      '--key',
      key,
      '--store',
      store,
      '--state',
      join(work, 'fetch-b-state'),
      '--relay',
      scoped,
      '--fetch',
      address,
      '--iroh-relay',
      irohRelay,
      '--origin',
      `127.0.0.1:${String(o)}`,
    ]);
    // Keep this app's beacon fresh while nfxd works (TTL 120 s).
    const refresh = setInterval(() => {
      void beacons.round();
    }, 30_000);
    try {
      await waitFor(
        fetcher,
        new RegExp(`${address}: Seeding`),
        NFXD_WITHIN_MS,
        'nfxd fetching B',
      ).catch((e: unknown) => {
        throw new Error(`${String(e)}\nthis app's worker said:\n${logs(w)}`);
      });
    } finally {
      clearInterval(refresh);
    }

    // Every file of the hash list is in nfxd's store, under its sha256.
    const fetched = await storeFiles(store);
    const listBytes = fetched.get(status.root);
    expect(listBytes, 'nfxd holds the hash list').toBeDefined();
    const addr = nfx.VideoAddr.parse(status.video);
    if (listBytes === undefined || !addr.ok) return;
    const verified = nfx.verifyHashList(listBytes, status.root, addr.value, BigInt(status.segs));
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    for (const f of verified.value.files) {
      const b = fetched.get(f.sha256);
      expect(b, `nfxd holds ${f.name}`).toBeDefined();
      if (b !== undefined) expect(sha256(b), f.name).toBe(f.sha256);
    }

    // nfxd's origin serves it as HLS, and ffmpeg decodes it.
    await listening(o, 30_000, 'the nfxd origin');
    const decoded = await runOnce(BIN.ffmpeg, [
      '-v',
      'error',
      '-i',
      `http://127.0.0.1:${String(o)}/${status.root}/master.m3u8`,
      '-f',
      'null',
      '-',
    ]);
    expect(decoded.code, `ffmpeg decodes nfxd's HLS:\n${tail(decoded.stderr)}`).toBe(0);
  });

  it('E: without a helper, an nfxd-only video is refused at once, never hangs', async () => {
    if (videoA === null || endpointA === null) throw new Error('pair A did not get this far');
    const w = await watcher(null);
    const video = videoA;
    await expect(
      within(
        w.call('nfx.play.open', {
          sid: sid(),
          video: videoOf(video.id) ?? '',
          root: video.root,
          segs: video.segs,
          peers: [],
          iroh: [endpointA],
          prefetchSeconds: 30,
        }),
        15_000,
        'the refusal',
      ),
    ).rejects.toMatchObject({ code: 'no-seeders' });
  });
});
