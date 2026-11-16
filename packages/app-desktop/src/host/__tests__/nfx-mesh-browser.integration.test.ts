/**
 * #89 (ADR 0023): this app and a real browser trade a video, with a stock Nostr relay as the only
 * signaling path. The app's side is what ships, short of Electron: the real worker under Node,
 * the real iroh helper running its WebRTC side, and the host's `NfxMeshSignaler` on the real
 * relay pool. The browser is headless Chromium, its sandbox on, running nfx's web player library
 * (the tar `packages/app-web/nfx-web.lock` pins) with `signaling: { kind: 'nostr' }`. The relay
 * is strfry at its pinned commit with its default configuration: it knows nothing about NFX.
 *
 *  1. **Seed.** The app packages a clip the way Studio does, publishes it, and seeds it; nfxd
 *     fetches it over iroh and is the browser's HTTPS-less origin for the hash list, playlists
 *     and inits (NFX-10: those never travel over the mesh). The browser plays the lowest
 *     rendition through a gate that refuses every segment once the app and the browser are
 *     connected. Playback must go on 15 s more with nothing rejected: those bytes came from the
 *     app, over WebRTC.
 *  2. **Fetch.** The seeding app leaves the rooms, so the browser is the only one in them. A
 *     second app (a watcher with an empty store) joins the room of the rendition the browser
 *     played, connects to it, and plays that rendition with the first app as its only other
 *     source, over HyperDHT, which a session asks AFTER WebRTC. The whole rendition must come
 *     out byte for byte, and the browser must have uploaded segment bytes meanwhile.
 *  3. **The relay** carried nothing but kind-25050 `nfx-mesh/1` events, and no SDP in the clear.
 *
 * No tracker, no nfxd bridge and no nfxd mesh endpoint runs. Everything is on 127.0.0.1 with
 * throwaway keys. The helper filters loopback addresses out of ICE unless it is told otherwise,
 * and the worker's protocol has no way to tell it (by design: the app never should), so this
 * suite wraps the helper's spawn and adds `allow_private` and a loopback `bind` to its
 * `rtc-init`. Nothing else differs from what ships.
 *
 * Runs only with `NUTFLIX_MESH_RUN=1` (`.github/workflows/nfx-exit.yml`, job `mesh-browser`);
 * then a missing binary or file FAILS it, never skips it:
 *   NFXD, IROH_RELAY, NUTFLIX_IROH_HELPER   as the exit run
 *   STRFRY, STRFRY_CONF   the relay's binary and its own default strfry.conf
 *   NFX_LIB    the library tar's files: player.js, wasm/nfx_wasm_bg.wasm
 *   CHROMIUM   a Chromium to run instead of Playwright's (optional)
 *   NUTFLIX_EXIT_LOGS   where every process's log and the page's console go
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import type {
  IrohRelayUrl,
  NfxVideo,
  NostrEvent,
  NostrFilter,
  NostrPubkey,
  RelayUrl,
  VideoManifest,
} from '@sovit/core';
import { media, nfx, nostr } from '@sovit/core';
import { nodeFsAdapter, nodeProcessRunner, nodeSha256 } from '@sovit/core/media/node';
import { silentLogger } from '@sovit/seeder';
import { type Browser, chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { WorkerEvent } from '../../ipc/worker-protocol.js';
import { devMockProviders } from '../../worker/dev/dev-mocks.js';
import type { DevTestnet } from '../../worker/dev/fixtures-net.js';
import { startDevTestnet } from '../../worker/dev/fixtures-net.js';
import { LoopbackPayHub } from '../../worker/dev/loopback-pay.js';
import { encodeCtl } from '../../worker/iroh/frames.js';
import type { HelperSpawn } from '../../worker/iroh/helper.js';
import { packageUploadForNfx } from '../../worker/studio/nfx.js';
import type { WorkerClient } from '../../worker/__tests__/helpers/harness.js';
import {
  httpGet,
  nodeHelperSpawn,
  nodeRuntime,
  sleep,
  startWorker,
  tempDir,
  within,
} from '../../worker/__tests__/helpers/harness.js';
import { memoryLogger } from '../log.js';
import { NfxBeacons } from '../nfx/beacons.js';
import { NfxMeshSignaler } from '../nfx/mesh-signaler.js';
import { isSignedManifest, nfxManifestFor } from '../nfx/publish.js';
import { NfxSeederKey } from '../nfx/seeder-key.js';
import { coreTestKit } from './support/core-helpers.js';
import {
  BIN,
  freePort,
  hex,
  layoutC,
  listening,
  makeClip,
  mustRun,
  nowS,
  setLogDir,
  sha256,
  sid,
  start,
  stopAll,
  storeFiles,
  tail,
  waitFor,
} from './support/nfx-exit-kit.js';

vi.setConfig({ testTimeout: 1_500_000, hookTimeout: 300_000 });
// At module level: the kit's module declares a suite of its own, which vitest refuses inside a test.
const kit = await coreTestKit();

const RUN = process.env['NUTFLIX_MESH_RUN'] === '1';
const NS = 'nfx:testnet:1';
const STRFRY = process.env['STRFRY'] ?? '';
const STRFRY_CONF = process.env['STRFRY_CONF'] ?? '';
const NFX_LIB = process.env['NFX_LIB'] ?? '';
const CHROMIUM = process.env['CHROMIUM'];
/**
 * Long enough for the two sides to meet (up to a round of presence, 30 s), and then to play 15 s
 * more without the origin.
 */
const CLIP_SECONDS = 90;
/** How long nfxd may take to resolve, fetch and announce the video. */
const NFXD_WITHIN_MS = 240_000;
/** How long the seeding worker may take to import and ticket the video over iroh. */
const SERVE_WITHIN_MS = 120_000;
/** A STUN server nobody runs: the worker's protocol wants one, and loopback needs none. */
const NO_STUN = '127.0.0.1:3478';

type PeerEvent = Extract<WorkerEvent, { e: 'nfx.rtc.peer' }>;
type LogEvent = Extract<WorkerEvent, { e: 'log' }>;

/**
 * The helper as the worker spawns it, except that its WebRTC side may use loopback: `rtc-init`
 * (one ctl frame per write: u32 length, u8 kind 1, JSON) gains `allow_private` and a loopback
 * `bind`. Every other frame passes untouched.
 */
const loopbackHelperSpawn: HelperSpawn = (file, args) => {
  const child = nodeHelperSpawn(file, args);
  const stdin = child.stdin;
  if (stdin === null || stdin === undefined) return child;
  return {
    stdin: {
      write: (chunk: Uint8Array): unknown => {
        if (chunk.length > 5 && chunk[4] === 1) {
          try {
            const msg = JSON.parse(Buffer.from(chunk.subarray(5)).toString('utf8')) as Record<
              string,
              unknown
            >;
            if (msg['op'] === 'rtc-init')
              return stdin.write(encodeCtl({ ...msg, bind: '127.0.0.1:0', allow_private: true }));
          } catch {
            // not JSON: passed on as it is
          }
        }
        return stdin.write(chunk);
      },
      end: (): unknown => stdin.end(),
    },
    stdout: child.stdout,
    stderr: child.stderr,
    on: child.on.bind(child),
    kill: (signal?: 'SIGKILL' | 'SIGTERM'): unknown => child.kill(signal),
  };
};

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function poll<T>(
  check: () => Promise<T | null> | T | null,
  ms: number,
  what: string,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v !== null) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

// ---- the page: nfx's library, driven as crates/iroh-helper/e2e/browser.e2e.ts drives it ----

const PAGE =
  '<!doctype html><meta charset="utf-8"><title>mesh e2e</title>' +
  '<video id="v" muted playsinline></video><script type="module" src="/t.js"></script>';

const SCRIPT = `
const q = new URLSearchParams(location.search);
const video = document.getElementById('v');
const st = { ready: false, playing: false, errors: [] };
let session = null;
window.__t = {
  st,
  state() {
    const s = session === null ? null : session.stats();
    return {
      t: video.currentTime, ended: video.ended, playing: st.playing, errors: st.errors,
      mesh: s === null ? null : s.mesh, verified: s === null ? 0 : s.verified,
      rejected: s === null ? [] : s.rejected,
    };
  },
};
try {
  const lib = await import('/lib/player.js');
  await lib.init();
  session = await lib.open(video, {
    root: q.get('root'), video: q.get('video'), origins: [q.get('origin')],
    signaling: { kind: 'nostr', relays: [q.get('relay')] },
    httpWindow: Number(q.get('httpWindow')), level: Number(q.get('level')),
    onEvent: (e) => {
      if (e.type === 'playing') st.playing = true;
      if (e.type === 'error') st.errors.push(e.message);
    },
  });
} catch (e) {
  st.errors.push(String(e && e.message ? e.message : e));
}
st.ready = true;
`;

interface PageState {
  t: number;
  ended: boolean;
  playing: boolean;
  errors: string[];
  mesh: {
    signaling?: string;
    swarms: { rendition: string | null; swarm: string }[];
    bytes: { http: number; p2p: number };
    uploaded: number;
    peers: number;
    rejected: string[];
  } | null;
  verified: number;
  rejected: unknown[];
}

// ---- the suite --------------------------------------------------------------------------------

describe.skipIf(!RUN)('#89: the app and a browser trade a video, signaled over strfry only', () => {
  const teardown: (() => Promise<void>)[] = [];
  const pool = new nostr.SimplePoolAdapter();
  const servers: Server[] = [];
  /** Every event strfry delivered during the run, verified. */
  const carried: NostrEvent[] = [];
  let work = '';
  let logDir = '';
  let clip = '';
  let scoped = '' as RelayUrl;
  let irohRelay = '' as IrohRelayUrl;
  let signal = '' as RelayUrl;
  let testnet: DevTestnet;
  let browser: Browser | undefined;
  const consoleLines: string[] = [];

  beforeAll(async () => {
    const need: Record<string, string> = {
      NFXD: BIN.nfxd,
      IROH_RELAY: BIN.irohRelay,
      NUTFLIX_IROH_HELPER: BIN.helper,
      ffmpeg: BIN.ffmpeg,
      ffprobe: BIN.ffprobe,
      STRFRY,
      STRFRY_CONF,
      'NFX_LIB/player.js': NFX_LIB === '' ? '' : join(NFX_LIB, 'player.js'),
      'NFX_LIB/wasm': NFX_LIB === '' ? '' : join(NFX_LIB, 'wasm', 'nfx_wasm_bg.wasm'),
    };
    const missing = Object.entries(need)
      .filter(([, p]) => p === '' || !existsSync(p))
      .map(([k]) => k);
    if (missing.length > 0) throw new Error(`the mesh run needs: ${missing.join(', ')}`);
    const d = await tempDir('nf-mesh-');
    teardown.push(() => d.rm());
    work = d.dir;
    logDir = process.env['NUTFLIX_EXIT_LOGS'] ?? join(work, 'logs');
    await mkdir(logDir, { recursive: true });
    setLogDir(logDir);

    // The network's iroh relay and scoped Nostr relay, as the exit run starts them.
    const q = await freePort();
    const toml = join(work, 'iroh-relay.toml');
    await writeFile(
      toml,
      `enable_relay = true\nhttp_bind_addr = "127.0.0.1:${String(q)}"\nenable_quic_addr_discovery = false\nenable_metrics = false\n`,
    );
    start('iroh-relay', BIN.irohRelay, ['--config-path', toml]);
    await listening(q, 30_000, 'the iroh relay');
    irohRelay = `http://127.0.0.1:${String(q)}/` as IrohRelayUrl;
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

    // The signaling relay: stock strfry, its own default configuration but for where it keeps
    // its database and which loopback port it takes.
    const s = await freePort();
    await mkdir(join(work, 'strfry-db'));
    const conf = (await readFile(STRFRY_CONF, 'utf8'))
      .replace(/^db = "\.\/strfry-db\/"$/m, `db = "${join(work, 'strfry-db')}/"`)
      .replace(/^(\s*)port = 7777$/m, `$1port = ${String(s)}`)
      .replace(/^(\s*)bind = "0\.0\.0\.0"$/m, '$1bind = "127.0.0.1"')
      // As the CI user, not root: leave the open-files limit as it is (0 = do not set it).
      .replace(/^(\s*)nofiles = [0-9]+$/m, '$1nofiles = 0');
    if (!conf.includes(`port = ${String(s)}`) || !conf.includes(join(work, 'strfry-db')))
      throw new Error('strfry.conf: db or port not found');
    await writeFile(join(work, 'strfry.conf'), conf);
    start('strfry', STRFRY, [`--config=${join(work, 'strfry.conf')}`, 'relay']);
    await listening(s, 30_000, 'strfry');
    signal = `ws://127.0.0.1:${String(s)}` as RelayUrl;
    // Everything it delivers from now on, whatever its kind.
    const off = pool.subscribe([signal], [{ since: nowS() }], {
      onevent: (raw) => {
        const ev = nostr.verifyIncoming(raw);
        if (ev !== null) carried.push(ev);
      },
    });
    teardown.push(() => {
      off();
      return Promise.resolve();
    });

    testnet = await startDevTestnet();
    teardown.push(() => testnet.destroy());
    clip = join(work, 'clip.mp4');
    await makeClip(clip, CLIP_SECONDS);
  });

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await writeFile(join(logDir, 'console.txt'), consoleLines.join('\n')).catch(() => undefined);
    await writeFile(
      join(logDir, 'relay-events.json'),
      JSON.stringify(
        carried.map((e) => ({
          kind: e.kind,
          pubkey: e.pubkey,
          tags: e.tags,
          bytes: e.content.length,
        })),
        null,
        1,
      ),
    ).catch(() => undefined);
    for (const srv of servers) srv.close();
    pool.close();
    for (const t of teardown.splice(0).reverse()) await t().catch(() => undefined);
    await stopAll();
  });

  const logs = (w: WorkerClient): string =>
    tail(
      w.events
        .filter((e): e is LogEvent => e.e === 'log')
        .map((e) => `${e.level}: ${e.msg}`)
        .join('\n'),
    );

  /** Verified events on the scoped relay matching `filter`. */
  async function query(filter: NostrFilter): Promise<NostrEvent[]> {
    const raw = await pool.query([scoped], filter, { maxWaitMs: 4000 });
    return raw.flatMap((r) => {
      const ev = nostr.verifyIncoming(r);
      return ev === null ? [] : [ev];
    });
  }

  async function listed(address: string): Promise<NfxVideo | null> {
    const events = await query({ kinds: [nfx.KIND_MANIFEST], '#n': [NS] });
    return nfx.listNfxVideos(NS, events, [], nowS()).find((v) => v.id === address) ?? null;
  }

  /** A worker whose helper may use loopback for WebRTC, with NFX and its WebRTC side on. */
  async function worker(seeding: boolean): Promise<WorkerClient> {
    const d = await tempDir('nf-mesh-worker-');
    teardown.push(() => d.rm());
    const hub = new LoopbackPayHub();
    const w = startWorker({
      logLevel: 'info',
      testBootstrap: testnet.bootstrap,
      runtime: { ...nodeRuntime(), spawnHelper: loopbackHelperSpawn },
      ...(seeding
        ? { hub, providers: () => devMockProviders({ hub, label: `mesh-${hex(4)}` }) }
        : {}),
    });
    teardown.push(() => w.close());
    await w.call('init', {
      v: 1,
      storage: d.dir,
      seeding: { enabled: seeding, diskCapBytes: 1024 ** 3 },
      prefetchSeconds: 30,
      nfx: { enabled: true, irohRelays: [irohRelay], rtc: { stun: [NO_STUN] } },
      irohHelper: BIN.helper,
    });
    if (seeding)
      await w.event((e): e is Extract<WorkerEvent, { e: 'ready' }> => e.e === 'ready', 20_000);
    return w;
  }

  /** The host's signaler for `w`, wired as `host/adapter.ts` wires it, on strfry alone. */
  function signaler(w: WorkerClient): { s: NfxMeshSignaler; stop: () => void } {
    const s = new NfxMeshSignaler({
      relays: () => [signal],
      subscribe: (relay, filter, onEvent, onClose) =>
        pool.subscribe([relay], [filter], {
          onevent: onEvent,
          onclose: () => {
            onClose();
          },
        }),
      publish: async (relays, event) =>
        (await pool.publish(relays, event)).filter((r) => r.ok).length,
      rtc: {
        offer: (swarm) => w.call('nfx.rtc.offer', { swarm }),
        answer: (swarm, offer) => w.call('nfx.rtc.answer', { swarm, offer }),
        accept: async (peer, answer) => {
          await w.call('nfx.rtc.accept', { peer, answer });
        },
        hangup: async (peer) => {
          await w.call('nfx.rtc.hangup', { peer });
        },
        swarms: async () => (await w.call('nfx.rtc.swarms', {})).swarms,
      },
      now: nowS,
      log: memoryLogger(),
    });
    // The worker's events, as the adapter's `onWorkerEvent` hands them on.
    let seen = 0;
    const pump = setInterval(() => {
      for (; seen < w.events.length; seen++) {
        const e = w.events[seen];
        if (e?.e === 'nfx.rtc.peer') s.onPeer(e);
        else if (e?.e === 'nfx.rtc.reset') s.reset();
      }
    }, 50);
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(pump);
      s.stop();
    };
    teardown.push(() => {
      stop();
      return Promise.resolve();
    });
    return { s, stop };
  }

  const opened = (w: WorkerClient, swarm: string): PeerEvent[] =>
    w.events.filter((e): e is PeerEvent => e.e === 'nfx.rtc.peer' && e.open && e.swarm === swarm);

  async function pageServer(): Promise<string> {
    const files: Record<string, [() => Buffer | string, string]> = {
      '/': [() => PAGE, 'text/html; charset=utf-8'],
      '/t.js': [() => SCRIPT, 'text/javascript'],
      '/lib/player.js': [() => readFileSync(join(NFX_LIB, 'player.js')), 'text/javascript'],
      '/lib/wasm/nfx_wasm_bg.wasm': [
        () => readFileSync(join(NFX_LIB, 'wasm', 'nfx_wasm_bg.wasm')),
        'application/wasm',
      ],
    };
    const server = createServer((req, res) => {
      const f = files[new URL(req.url ?? '/', 'http://x').pathname];
      if (f === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-store' }).end(f[0]());
    });
    servers.push(server);
    return `http://127.0.0.1:${String(await listen(server))}`;
  }

  /**
   * nfxd's origin behind a switch: once `block` is on, every segment is refused. It forwards
   * only an origin-form path to nfxd's fixed host and port, so no request can point it elsewhere.
   */
  async function gate(
    port: number,
  ): Promise<{ url: string; block: () => void; refused: () => number; segments: () => number }> {
    let blocked = false;
    let refused = 0;
    /** Segments the origin served before it was blocked. */
    let segments = 0;
    // The page is another origin (another port): the gate answers CORS itself, whatever nfxd does.
    const cors = { 'access-control-allow-origin': '*' };
    const server = createServer((req, res) => {
      const path = req.url ?? '';
      if (!path.startsWith('/') || path.startsWith('//')) {
        res.writeHead(400).end();
        return;
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...cors, 'access-control-allow-headers': 'range' }).end();
        return;
      }
      if (blocked && path.endsWith('.m4s')) {
        refused += 1;
        res.writeHead(503, { ...cors, 'cache-control': 'no-store' }).end();
        return;
      }
      if (path.endsWith('.m4s')) segments += 1;
      const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
      const range = req.headers.range;
      const up = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          ...(range === undefined ? {} : { headers: { range } }),
        },
        (r) => {
          res.writeHead(r.statusCode ?? 502, { ...r.headers, ...cors });
          r.pipe(res);
        },
      );
      up.on('error', () => res.writeHead(502, cors).end());
      up.end();
    });
    servers.push(server);
    return {
      url: `http://127.0.0.1:${String(await listen(server))}`,
      block: () => {
        blocked = true;
      },
      refused: () => refused,
      segments: () => segments,
    };
  }

  it('seeds a browser and fetches from it, and the relay carries only nfx-mesh/1 signaling', async () => {
    // ---- the app packages, publishes and seeds a clip (the exit run's direction B) ----
    const w1 = await worker(true);
    const seeder = w1.host.internals.seeder;
    if (seeder === null) throw new Error('the seeding worker has no seeder');
    const fs = nodeFsAdapter({ tmpDir: work });
    const runner = nodeProcessRunner();
    const binaries = { ffmpeg: BIN.ffmpeg, ffprobe: BIN.ffprobe };
    const pipeline = media.createMediaPipeline({ runner, fs, sha256: nodeSha256, binaries });
    const plan = pipeline.plan(await pipeline.probe(clip), { codec: 'h264', sizes: 'all' });
    await mkdir(join(work, 'transcode'), { recursive: true });
    const output = await pipeline.transcode(clip, plan, () => undefined, {
      workDir: join(work, 'transcode'),
    });
    const legacyId = hex(32);
    const status = await packageUploadForNfx(
      { legacyEventId: legacyId, satsPerBlock: 0, output },
      { store: seeder.nfx, runner, fs, sha256: nodeSha256, binaries, logger: silentLogger },
    );
    expect(status.state, JSON.stringify(status)).toBe('stored');
    if (status.state !== 'stored') return;

    const user = new kit.TestSigner();
    const legacy = {
      id: legacyId,
      kind: 21,
      author: user.pubkey,
      title: 'mesh run',
      description: 'Packaged by nutflix-pear, seeded to a browser.',
      publishedAt: nowS(),
      durationSec: CLIP_SECONDS,
      tags: ['mesh-run'],
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
    expect((await pool.publish([scoped], manifest)).map((r) => r.ok)).toEqual([true]);
    const address = `${String(nfx.KIND_MANIFEST)}:${user.pubkey}:${status.video}`;
    const video = await listed(address);
    expect(video?.root, 'the catalogue lists the manifest').toBe(status.root);
    if (video === null) return;

    const endpoints = await poll(
      async () => {
        const r = await w1.call('nfx.endpoint', { seeder: user.pubkey, video: status.video });
        return r.iroh !== null && r.hyperdht !== null ? r : null;
      },
      SERVE_WITHIN_MS,
      `the seeding worker's endpoints:\n${logs(w1)}`,
    );
    const keyDir = await tempDir('nf-mesh-key-');
    teardown.push(() => keyDir.rm());
    const seederKey = await NfxSeederKey.open({
      dir: join(keyDir.dir, 'nfx'),
      network: NS,
      user: user.pubkey,
      seal: user,
    });
    const beacons = new NfxBeacons({
      scopedRelays: () => [scoped],
      key: () => Promise.resolve(seederKey),
      endpoint: (s: NostrPubkey, v: string) => w1.call('nfx.endpoint', { seeder: s, video: v }),
      irohRelays: () => [irohRelay],
      stored: async () => (await w1.call('nfx.videos', {})).videos,
      seeded: () => [{ video: status.video, author: user.pubkey, root: status.root }],
      manifest: (a) => listed(a),
      send: async (event, relays) => (await pool.publish(relays, event)).filter((x) => x.ok).length,
      now: nowS,
      log: memoryLogger(),
    });
    expect((await beacons.round()).published).toBe(1);

    // nfxd fetches it from the app over iroh and becomes the browser's origin. No bridge, no
    // tracker, no mesh endpoint: it is not in any signaling room.
    const key = join(work, 'origin.key');
    await mustRun('nfxd key new', BIN.nfxd, ['key', 'new', key]);
    const store = join(work, 'origin-store');
    const o = await freePort();
    const origin = start('nfxd-origin', BIN.nfxd, [
      'run',
      '--key',
      key,
      '--store',
      store,
      '--state',
      join(work, 'origin-state'),
      '--relay',
      scoped,
      '--fetch',
      address,
      '--iroh-relay',
      irohRelay,
      '--origin',
      `127.0.0.1:${String(o)}`,
    ]);
    const refresh = setInterval(() => {
      void beacons.round();
    }, 30_000);
    try {
      await waitFor(
        origin,
        new RegExp(`${address}: Seeding`),
        NFXD_WITHIN_MS,
        'nfxd fetching',
      ).catch((e: unknown) => {
        throw new Error(`${String(e)}\nthe seeding worker said:\n${logs(w1)}`);
      });
    } finally {
      clearInterval(refresh);
    }
    await listening(o, 30_000, 'the nfxd origin');

    // The rendition the browser will play (level 0: the lowest), and its bytes as one file.
    const files = await storeFiles(store);
    const addr = nfx.VideoAddr.parse(status.video);
    if (!addr.ok) throw new Error('bad address');
    const verified = nfx.verifyHashList(
      files.get(status.root) ?? new Uint8Array(0),
      status.root,
      addr.value,
      BigInt(status.segs),
    );
    expect(verified.ok, 'nfxd holds the hash list').toBe(true);
    if (!verified.ok) return;
    const list = verified.value;

    // ---- 1. seed: the app's signaler meets the browser on strfry ----
    const served = await poll(
      async () => {
        await beacons.round(); // the beacon round is WebRTC seeding's clock
        const { swarms } = await w1.call('nfx.rtc.swarms', {});
        return swarms.length >= list.renditions.length ? swarms : null;
      },
      SERVE_WITHIN_MS,
      `the worker's WebRTC side to serve the video:\n${logs(w1)}`,
    );
    const s1 = signaler(w1);
    s1.s.start();
    const seedKey = s1.s.pubkey ?? '';

    const pages = await pageServer();
    const g = await gate(o);
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(CHROMIUM === undefined || CHROMIUM === '' ? {} : { executablePath: CHROMIUM }),
    });
    const page = await (await browser.newContext()).newPage();
    page.on('console', (msg) => {
      if (consoleLines.length < 4000) consoleLines.push(`${msg.type()}: ${msg.text()}`);
    });
    page.on('pageerror', (e) => {
      consoleLines.push(`pageerror: ${e.message}`);
    });
    const q = new URLSearchParams({
      origin: g.url,
      root: status.root,
      video: status.video,
      relay: signal,
      httpWindow: '2',
      level: '0',
    });
    await page.goto(`${pages}/?${q.toString()}`);
    // Page-side code goes over as text: this package is not compiled against the DOM.
    const view = (): Promise<PageState> => page.evaluate<PageState>('window.__t.state()');
    await page.waitForFunction(
      "window.__t !== undefined && (window.__t.st.errors.length > 0 || (window.__t.st.playing && document.getElementById('v').currentTime > 3))",
      null,
      { timeout: 120_000 },
    );
    expect((await view()).errors, 'the page plays through the origin').toEqual([]);
    // The two meet on the relay (within a round of presence), and only then does the origin go.
    await poll(
      () => (w1.events.some((e) => e.e === 'nfx.rtc.peer' && e.open) ? true : null),
      90_000,
      `the seeding app to connect to the browser:\n${logs(w1)}`,
    );
    const before = await view();
    expect(before.errors, 'the page still plays').toEqual([]);
    g.block();
    const t0 = before.t;
    expect(t0, 'enough of the clip is left').toBeLessThan(CLIP_SECONDS - 20);
    await page.waitForFunction(
      `window.__t.st.errors.length > 0 || document.getElementById('v').currentTime > ${String(t0 + 15)}`,
      null,
      { timeout: 180_000 },
    );
    const seeded = await view();
    // The page may be in several renditions' swarms: the one it is connected to the app in is the
    // one it played from the app (and the one the second app fetches below).
    const played =
      seeded.mesh?.swarms.find((s) => s.rendition !== null && opened(w1, s.swarm).length > 0) ??
      seeded.mesh?.swarms.find((s) => s.rendition !== null);
    const detail = `page: ${JSON.stringify(seeded)}\nthe worker said:\n${logs(w1)}`;
    expect(seeded.errors, detail).toEqual([]);
    expect(seeded.t, `playback went on without the origin\n${detail}`).toBeGreaterThan(t0 + 15);
    // The gate is on the segments' path (it served some before it closed), so closing it took
    // the origin away. Once connected, the player may never ask it again: no refusal is required.
    expect(g.segments(), 'the origin served segments before it closed').toBeGreaterThan(0);
    expect(
      seeded.mesh?.bytes.p2p ?? 0,
      `segment bytes came over WebRTC\n${detail}`,
    ).toBeGreaterThan(0);
    expect([seeded.rejected, seeded.mesh?.rejected ?? []], 'nothing was rejected').toEqual([
      [],
      [],
    ]);
    expect(played, 'the page joined a rendition swarm').toBeDefined();
    if (played?.rendition === null || played === undefined) return;
    expect(served, 'the worker serves the swarm the page joined').toContain(played.swarm);
    expect(
      opened(w1, played.swarm).length,
      `a connection opened in the seeding app, in a swarm the page is in\n${detail}\nthe app's peers: ${JSON.stringify(w1.events.filter((e) => e.e === 'nfx.rtc.peer'))}`,
    ).toBeGreaterThan(0);

    // ---- 2. fetch: another app gets that rendition from the browser ----
    // The seeding app leaves every room (its connections end): only the browser is left in them.
    s1.stop();
    const rendition = list.renditions.find((r) => r.id === played.rendition);
    expect(rendition, `the hash list has ${played.rendition}`).toBeDefined();
    if (rendition === undefined) return;
    const expected = layoutC(list, files, rendition);
    const w2 = await worker(false);
    const s2 = signaler(w2);
    const play = sid();
    s2.s.play(play, played.swarm);
    s2.s.start();
    expect(s2.s.keyIn(played.swarm), 'a play has a key of its own').not.toBe(s2.s.pubkey);
    await poll(
      () => (opened(w2, played.swarm).length > 0 ? true : null),
      120_000,
      `the watching app to connect to the browser:\n${logs(w2)}`,
    );
    const uploadedBefore = (await view()).mesh?.uploaded ?? 0;
    // The first app is the session's only other source, over HyperDHT: a session asks the
    // WebRTC peers first, so what the browser holds comes from the browser.
    const open = await within(
      w2.call('nfx.play.open', {
        sid: play,
        video: status.video,
        root: video.root,
        segs: video.segs,
        rendition: rendition.id,
        peers: endpoints.hyperdht === null ? [] : [endpoints.hyperdht],
        iroh: [],
        prefetchSeconds: 30,
      }),
      180_000,
      'the play to open',
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}\nthe watching worker said:\n${logs(w2)}`);
    });
    expect(open.rendition).toBe(rendition.id);
    const whole = await httpGet(open.link);
    expect(whole.status).toBe(200);
    expect(whole.body.length, 'the whole rendition').toBe(expected.length);
    expect(sha256(whole.body), 'byte for byte').toBe(sha256(expected));
    const after = await view();
    const uploaded = (after.mesh?.uploaded ?? 0) - uploadedBefore;
    expect(
      uploaded,
      `the browser uploaded segment bytes to the app\npage: ${JSON.stringify(after)}\nthe worker said:\n${logs(w2)}`,
    ).toBeGreaterThan(0);
    await w2.call('nfx.play.close', { sid: play });
    const playKey = s2.s.keyIn(played.swarm) ?? '';
    s2.stop();
    await sleep(1500); // the goodbyes reach the recorder

    // ---- 3. the relay carried signaling and nothing else ----
    expect(carried.length).toBeGreaterThan(0);
    const types = new Set<string>();
    for (const e of carried) {
      expect(e.kind, 'only kind 25050').toBe(nfx.KIND_MESH_SIGNAL);
      expect(e.tags, 'only nfx-mesh/1').toContainEqual(['i', 'nfx-mesh/1']);
      expect(e.content, 'no SDP in the clear').not.toMatch(/v=0|candidate|fingerprint/);
      types.add(e.tags.find((t) => t[0] === 't')?.[1] ?? '');
    }
    expect([...types].sort()).toEqual(['answer', 'connect', 'disconnect', 'offer']);
    const signers = new Set<string>(carried.map((e) => e.pubkey));
    expect(signers.has(seedKey), 'the seeding session announced').toBe(true);
    expect(signers.has(playKey), 'the play session announced').toBe(true);
    expect(signers.has(user.pubkey), 'the user’s key never signs signaling').toBe(false);
    expect(signers.has(seederKey.pubkey), 'nor does the seeder key').toBe(false);
  });
});
