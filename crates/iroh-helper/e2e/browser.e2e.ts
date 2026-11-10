/**
 * The iroh helper's WebRTC side (ADR 0023, #89) against a real browser: headless Chromium, its
 * sandbox on, running nfx's web player library (the tar packages/app-web/nfx-web.lock pins), and
 * nfxd built from that commit. Everything runs on this machine: loopback, throwaway keys, a
 * generated clip.
 *
 * Signaling goes through nfxd's embedded WebTorrent tracker, the only signaling today's player
 * speaks. The tracker client below acts for the helper and exists only in this test: the app
 * never ships one (ADR 0023 §3; its signaling will be Nostr, nfx #71). nfxd seeds the video, so
 * its tracker admits the video's swarms, and it runs WITHOUT `--bridge`: the helper is the only
 * native WebRTC peer, and the browser is the only browser.
 *
 *  1. Seed. The helper serves the lowest rendition's segments from nfxd's store (with `root` =
 *     the store, as the worker will) and answers the browser's offers. The browser plays that
 *     rendition through a gate that refuses every segment once playback has passed 3 s. Playback
 *     must go on 15 s more with nothing rejected: those bytes came from the helper, over WebRTC.
 *  2. Fetch. The helper's tracker identity leaves, a new one offers to the same browser, and the
 *     helper fetches every segment the browser announces. Each one's sha256 must be the one its
 *     playlist names (the check the worker makes, NFX-05 §4).
 *
 * Usage (from the repository root, after `npm ci`): node crates/iroh-helper/e2e/browser.e2e.ts
 *   NUTFLIX_IROH_HELPER  the helper binary (required)
 *   NFX_BIN    directory with nfxd and nfx-package built from the lock's nfx commit (required)
 *   NFX_LIB    directory with the library tar's files: player.js, wasm/nfx_wasm_bg.wasm (required)
 *   CHROMIUM   a Chromium to run instead of Playwright's
 *   E2E_OUT    where results.json and the logs go (default: none kept)
 *   FFMPEG     the tool (default from PATH)
 * Every process it starts runs in its own process group, and only those are killed.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, type Browser } from 'playwright-core';

const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v === undefined || v === '' ? undefined : v;
};
const need = (k: string): string => {
  const v = env(k);
  if (v === undefined) throw new Error(`set ${k}`);
  return v;
};

const HELPER = resolve(need('NUTFLIX_IROH_HELPER'));
const NFX_BIN = resolve(need('NFX_BIN'));
const NFX_LIB = resolve(need('NFX_LIB'));
const FFMPEG = env('FFMPEG') ?? 'ffmpeg';
const OUT = env('E2E_OUT');
const CHROMIUM = env('CHROMIUM');

const work = mkdtempSync(join(tmpdir(), 'helper-webrtc-e2e-'));
chmodSync(work, 0o700);
const children: ChildProcess[] = [];
const servers: Server[] = [];
const sockets: WebSocket[] = [];
const timers: ReturnType<typeof setInterval>[] = [];
const results: Record<string, unknown> = {};
const logs: Record<string, () => string> = {};

const bin = (name: string): string => join(NFX_BIN, name);
const sleep = (ms: number): Promise<void> =>
  new Promise((ok) => {
    setTimeout(ok, ms);
  });

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args[0] ?? ''} failed (${String(r.status)}): ${r.stderr.slice(-2000)}`,
    );
  }
  return r.stdout;
}

interface Started {
  readonly child: ChildProcess;
  readonly matches: RegExpExecArray[];
  readonly text: () => string;
}

/** A child in its own process group, once its stderr has matched every pattern. */
function start(cmd: string, args: string[], waitFor: RegExp[]): Promise<Started> {
  const child = spawn(cmd, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child);
  let text = '';
  child.stderr.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });
  return new Promise((ok, fail) => {
    const timer = setInterval(() => {
      const matches = waitFor.map((re) => re.exec(text));
      if (matches.every((m) => m !== null)) {
        clearInterval(timer);
        clearTimeout(limit);
        ok({ child, matches, text: () => text });
      }
    }, 100);
    const limit = setTimeout(() => {
      clearInterval(timer);
      fail(new Error(`${cmd} never printed ${waitFor.join(', ')}:\n${text.slice(-4000)}`));
    }, 60_000);
    child.on('exit', (code) => {
      clearInterval(timer);
      clearTimeout(limit);
      fail(new Error(`${cmd} exited ${String(code)}:\n${text.slice(-4000)}`));
    });
  });
}

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => {
      ok((server.address() as AddressInfo).port);
    }),
  );
}

/** `check`'s first value other than undefined, polled every 200 ms; fails naming `what`. */
async function until<T>(
  what: string,
  ms: number,
  check: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await sleep(200);
  }
}

// ---- the helper, over its framed stdio (crates/iroh-helper/README.md, "Frames", "Requests") ----

type Reply = Record<string, unknown> & { bytes: Buffer };

class HelperError extends Error {
  readonly code: string;
  constructor(code: string, msg: string) {
    super(`${code}: ${msg}`);
    this.code = code;
  }
}

interface Pending {
  ok: (r: Reply) => void;
  fail: (e: Error) => void;
  data: Buffer[];
}

class Helper {
  readonly child: ChildProcess;
  private buf = Buffer.alloc(0);
  private next = 1;
  private readonly pending = new Map<number, Pending>();
  private err = '';
  private broken: Error | undefined;

  constructor(state: string) {
    this.child = spawn(HELPER, ['--state', state], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(this.child);
    this.child.stderr?.on('data', (c: Buffer) => {
      this.err += c.toString();
    });
    this.child.stdout?.on('data', (c: Buffer) => {
      try {
        this.feed(c);
      } catch (e) {
        this.fail(e instanceof Error ? e : new Error(String(e)));
      }
    });
    this.child.on('exit', (code) => {
      this.fail(new Error(`the helper exited ${String(code)}:\n${this.err.slice(-4000)}`));
    });
    logs['helper.log'] = () => this.err;
  }

  private fail(e: Error): void {
    this.broken ??= e;
    for (const p of this.pending.values()) p.fail(e);
    this.pending.clear();
  }

  private feed(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len < 2 || len > 1 + 4 + 65536)
        throw new Error(`the helper sent a ${String(len)} B frame`);
      if (this.buf.length < 4 + len) return;
      const kind = this.buf[4];
      const body = this.buf.subarray(5, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      if (kind === 1) {
        const msg = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        const id = Number(msg['id']);
        const p = this.pending.get(id);
        if (p === undefined) continue;
        this.pending.delete(id);
        if (msg['ok'] === true) p.ok({ ...msg, bytes: Buffer.concat(p.data) });
        else p.fail(new HelperError(String(msg['err']), String(msg['msg'])));
      } else if (kind === 2 && body.length > 4) {
        this.pending.get(body.readUInt32BE(0))?.data.push(Buffer.from(body.subarray(4)));
      } else {
        throw new Error(`the helper sent a frame of kind ${String(kind)}`);
      }
    }
  }

  call(op: string, fields: Record<string, unknown> = {}): Promise<Reply> {
    if (this.broken !== undefined) return Promise.reject(this.broken);
    const id = this.next++;
    const json = Buffer.from(JSON.stringify({ id, op, ...fields }), 'utf8');
    if (json.length > 65536) return Promise.reject(new Error(`${op}: request over 64 KiB`));
    const head = Buffer.alloc(5);
    head.writeUInt32BE(1 + json.length, 0);
    head[4] = 1;
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail, data: [] });
      this.child.stdin?.write(Buffer.concat([head, json]));
    });
  }
}

type Event = Record<string, unknown>;

/** The helper's events, drained by one long poll at a time and kept for the waits below. */
class HelperEvents {
  readonly all: Event[] = [];
  lost = false;
  private stopped = false;
  private readonly helper: Helper;

  constructor(helper: Helper) {
    this.helper = helper;
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const r = await this.helper.call('rtc-poll', { wait_ms: 1000 });
        this.all.push(...(r['events'] as Event[]));
        if (r['lost'] === true) this.lost = true;
      } catch {
        await sleep(200); // the loop's condition ends it once stopped
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  wait(what: string, ms: number, want: (e: Event) => boolean): Promise<Event> {
    return until(what, ms, () => this.all.find(want));
  }
}

// ---- a test-only tracker client, acting for the helper (never shipped: ADR 0023 §3) ----

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const token = (n: number): string => Array.from(randomBytes(n), (b) => ALNUM[b % 62]).join('');

/** NFX-10 §2: a stream swarm's tracker info hash, base64(sha1(id)) cut to 20 characters. */
const infoHash = (swarm: string): string =>
  createHash('sha1').update(swarm).digest().subarray(0, 15).toString('base64');

interface Sdp {
  type: string;
  sdp: string;
}

interface TrackerMessage {
  offer?: Sdp;
  answer?: Sdp;
  offer_id?: string;
  peer_id?: string;
  'failure reason'?: string;
  [k: string]: unknown;
}

class TrackerPeer {
  readonly peerId = `-NH0100-${token(12)}`;
  readonly replies: TrackerMessage[] = [];
  onOffer: ((m: TrackerMessage) => void) | undefined;
  private readonly ws: WebSocket;
  private readonly hash: string;
  private readonly answers = new Map<string, TrackerMessage>();

  constructor(url: string, hash: string) {
    this.hash = hash;
    this.ws = new WebSocket(url);
    sockets.push(this.ws);
    this.ws.onmessage = (m: MessageEvent) => {
      const msg = JSON.parse(String(m.data)) as TrackerMessage;
      if (msg.offer !== undefined && msg.offer_id !== undefined) this.onOffer?.(msg);
      else if (msg.answer !== undefined && msg.offer_id !== undefined)
        this.answers.set(msg.offer_id, msg);
      else this.replies.push(msg);
    };
  }

  open(): Promise<void> {
    return new Promise((ok, fail) => {
      this.ws.onopen = () => {
        ok();
      };
      this.ws.onerror = () => {
        fail(new Error('tracker socket error'));
      };
    });
  }

  send(fields: Record<string, unknown>): void {
    this.ws.send(
      JSON.stringify({ action: 'announce', info_hash: this.hash, peer_id: this.peerId, ...fields }),
    );
  }

  /** The tracker's first reply to an announce: refused if it names a failure. */
  async joined(): Promise<TrackerMessage> {
    const r = await until('the tracker answering an announce', 10_000, () => this.replies[0]);
    if (r['failure reason'] !== undefined)
      throw new Error(`the tracker refused the swarm: ${JSON.stringify(r)}`);
    return r;
  }

  answer(to: TrackerMessage, sdp: string): void {
    this.send({
      to_peer_id: to.peer_id,
      offer_id: to.offer_id,
      answer: { type: 'answer', sdp },
    });
  }

  answerTo(offerId: string, ms: number): Promise<TrackerMessage | undefined> {
    return until('an answer', ms, () => this.answers.get(offerId)).catch(() => undefined);
  }

  close(): void {
    this.ws.close();
  }
}

// ---- the page: nfx's library, driven as nfx's own e2e-lib.ts fixture drives it ----

const PAGE =
  '<!doctype html><meta charset="utf-8"><title>helper e2e</title>' +
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
      t: video.currentTime, playing: st.playing, errors: st.errors,
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
    signaling: { kind: 'trackers', urls: [q.get('tracker')] },
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
  const port = await listen(
    createServer((req, res) => {
      const f = files[new URL(req.url ?? '/', 'http://x').pathname];
      if (f === undefined) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-store' }).end(f[0]());
    }),
  );
  return `http://127.0.0.1:${String(port)}`;
}

/**
 * The origin behind a switch: once `block` is on, every segment is refused. It forwards only an
 * origin-form path (`/…`) to nfxd's fixed host and port, so no request target can point it
 * anywhere else.
 */
async function gate(
  upstream: string,
): Promise<{ url: string; block: () => void; refused: () => number }> {
  const to = new URL(upstream);
  let blocked = false;
  let refused = 0;
  const port = await listen(
    createServer((req, res) => {
      const path = req.url ?? '';
      if (!path.startsWith('/') || path.startsWith('//')) return res.writeHead(400).end();
      if (blocked && path.endsWith('.m4s')) {
        refused += 1;
        return res.writeHead(503, { 'cache-control': 'no-store' }).end();
      }
      const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
      const up = httpRequest({ hostname: to.hostname, port: to.port, path, method }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => res.writeHead(502).end());
      up.end();
    }),
  );
  return {
    url: `http://127.0.0.1:${String(port)}`,
    block: () => {
      blocked = true;
    },
    refused: () => refused,
  };
}

interface PageState {
  t: number;
  playing: boolean;
  errors: string[];
  mesh: {
    swarms: { rendition: string | null; swarm: string }[];
    bytes: { http: number; p2p: number };
    uploaded: number;
    peers: number;
    rejected: string[];
  } | null;
  verified: number;
  rejected: unknown[];
}

// ---- the run ----------------------------------------------------------------------------------

async function main(): Promise<void> {
  for (const f of [bin('nfxd'), bin('nfx-package'), HELPER]) statSync(f);
  for (const f of ['player.js', 'wasm/nfx_wasm_bg.wasm']) statSync(join(NFX_LIB, f));

  // A 60 s clip, packaged at 360p and below.
  const clip = join(work, 'clip.mp4');
  // prettier-ignore
  run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    clip,
  ]);
  const pkg = join(work, 'pkg');
  // prettier-ignore
  run(bin('nfx-package'), [
    clip, '--video', 'nfx:testnet:1:helper-webrtc', '--out', pkg,
    '--max-height', '360', '--preset', 'veryfast', '--no-thumb',
  ]);
  const meta = JSON.parse(readFileSync(join(pkg, 'nfx.json'), 'utf8')) as {
    root: string;
    video: string;
  };
  const store = join(pkg, 'store');
  const list = JSON.parse(readFileSync(join(store, meta.root), 'utf8')) as {
    files: { name: string; sha256: string }[];
    renditions: { id: string; playlist: string; bandwidth: number }[];
  };
  // The lowest rendition, level 0 in hls.js: the one the page pins.
  const low = [...list.renditions].sort((x, y) => x.bandwidth - y.bandwidth)[0];
  const playlist = list.files.find((f) => f.name === low?.playlist);
  if (low === undefined || playlist === undefined) throw new Error('no rendition playlist');
  // Segment ids are positions after #EXTINF (NFX-10 §2); each names its file by sha256.
  const shas = readFileSync(join(store, playlist.sha256), 'utf8')
    .split('\n')
    .map((l) => /^([0-9a-f]{64})\.m4s$/.exec(l.trim())?.[1])
    .filter((s): s is string => s !== undefined);
  const swarm = `nfx/1/web/${meta.video}/${low.id}`;
  const hash = infoHash(swarm);
  Object.assign(results, { video: meta.video, rendition: low.id, segments: shas.length, swarm });

  // nfxd: relay, origin, tracker, seeding the video. No --bridge.
  const key = join(work, 'node.key');
  const pubkey = run(bin('nfxd'), ['key', 'new', key]).split('\n')[0] ?? '';
  const a = `38504:${pubkey}:${meta.video}`;
  // prettier-ignore
  const node = await start(
    bin('nfxd'),
    ['run', '--key', key, '--store', store, '--seed', a,
      '--embed-relay', '127.0.0.1:0', '--origin', '127.0.0.1:0', '--embed-tracker', '127.0.0.1:0'],
    [/embedded relay: (ws:\/\/\S+)/, /origin: (http:\/\/\S+?)\/?\s/, /embedded tracker: (ws:\/\/\S+)/],
  );
  logs['nfxd.log'] = node.text;
  const relay = node.matches[0]?.[1] ?? '';
  const origin = (node.matches[1]?.[1] ?? '').replace(/\/$/, '');
  const tracker = node.matches[2]?.[1] ?? '';
  run(bin('nfxd'), [
    'publish',
    '--key',
    key,
    '--relay',
    relay,
    '--package',
    pkg,
    '--title',
    'Helper e2e',
  ]);
  await until('nfxd seeding the video', 60_000, () =>
    node.text().includes(`${a}: Seeding`) ? true : undefined,
  );

  // The helper's WebRTC side, serving the rendition from nfxd's store.
  const state = join(work, 'helper-state');
  mkdirSync(state, { mode: 0o700 });
  const helper = new Helper(state);
  const init = await helper.call('rtc-init', {
    bind: '127.0.0.1:0',
    stun: [],
    allow_private: true,
    root: store,
  });
  results['helper'] = { local: init['local'], mapped: init['mapped'] };
  const served = await helper.call('rtc-serve', {
    swarm,
    segments: shas.map((sha, id) => ({
      id,
      path: join(store, sha),
      size: statSync(join(store, sha)).size,
    })),
  });
  if (served['segments'] !== shas.length) throw new Error(`rtc-serve: ${JSON.stringify(served)}`);
  const events = new HelperEvents(helper);

  // 1. Seed: the helper joins the swarm first (the tracker relays offers only to members),
  // then answers whatever offers the tracker relays to it.
  const seeder = new TrackerPeer(tracker, hash);
  await seeder.open();
  const answered: number[] = [];
  const answerErrors: string[] = [];
  seeder.onOffer = (m) => {
    helper.call('rtc-answer', { swarm, offer: m.offer?.sdp ?? '' }).then(
      (r) => {
        answered.push(Number(r['peer']));
        seeder.answer(m, String(r['sdp']));
      },
      (e: unknown) => {
        answerErrors.push(String(e));
      },
    );
  };
  seeder.send({ numwant: 0, offers: [], event: 'started' });
  await seeder.joined();
  timers.push(
    setInterval(() => {
      seeder.send({ numwant: 0, offers: [], event: 'update' });
    }, 20_000),
  );

  const pages = await pageServer();
  const g = await gate(origin);
  let browser: Browser | undefined;
  const consoleLines: string[] = [];
  logs['console.txt'] = () => consoleLines.join('\n');
  try {
    // Chromium's sandbox stays on (the workflow lifts Ubuntu's user-namespace restriction).
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(CHROMIUM === undefined ? {} : { executablePath: CHROMIUM }),
    });
    const page = await (await browser.newContext()).newPage();
    page.on('console', (m) => {
      if (consoleLines.length < 2000) consoleLines.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => {
      consoleLines.push(`pageerror: ${e.message}`);
    });
    const q = new URLSearchParams({
      origin: g.url,
      root: meta.root,
      video: meta.video,
      tracker,
      httpWindow: '2',
      level: '0',
    });
    await page.goto(`${pages}/?${q.toString()}`);
    const view = (): Promise<PageState> =>
      page.evaluate(() => (window as unknown as { __t: { state(): PageState } }).__t.state());
    await page.waitForFunction(
      () => {
        const t = (window as unknown as { __t?: { st: { errors: string[]; playing: boolean } } })
          .__t;
        const v = document.getElementById('v') as HTMLVideoElement;
        return t !== undefined && (t.st.errors.length > 0 || (t.st.playing && v.currentTime > 3));
      },
      null,
      { timeout: 90_000 },
    );
    const before = await view();
    if (before.errors.length > 0) throw new Error(`the page failed: ${before.errors.join('; ')}`);
    g.block();
    const t0 = before.t;
    await page.waitForFunction(
      (from: number) => {
        const t = (window as unknown as { __t: { st: { errors: string[] } } }).__t;
        const v = document.getElementById('v') as HTMLVideoElement;
        return t.st.errors.length > 0 || v.currentTime > from + 15;
      },
      t0,
      { timeout: 120_000 },
    );
    const seeded = await view();
    const opened = events.all.filter((e) => e['t'] === 'open' && e['dir'] === 'in');
    results['seed'] = {
      blockedAt: t0,
      t: seeded.t,
      originRefused: g.refused(),
      mesh: seeded.mesh,
      verified: seeded.verified,
      answered,
      answerErrors,
      helperOpened: opened.length,
    };
    const seedProblems = [
      seeded.errors.length > 0 ? `page errors ${JSON.stringify(seeded.errors)}` : '',
      !(seeded.t > t0 + 15) ? 'playback stopped when the origin went away' : '',
      !((seeded.mesh?.bytes.p2p ?? 0) > 0) ? 'no segment bytes came over WebRTC' : '',
      seeded.rejected.length > 0 || (seeded.mesh?.rejected.length ?? 0) > 0
        ? 'the page rejected a segment'
        : '',
      !(seeded.mesh?.swarms ?? []).some((s) => s.swarm === swarm)
        ? `the page never joined ${swarm}`
        : '',
      answered.length === 0 ? 'the helper answered no offer' : '',
      opened.length === 0 ? 'no connection to the browser opened in the helper' : '',
    ].filter(Boolean);
    if (seedProblems.length > 0) throw new Error(`seed: ${seedProblems.join('; ')}`);

    // 2. Fetch: a fresh tracker identity (the seeder one gone, so the tracker can relay the
    // offer only to the browser) offers to the browser, and the helper fetches what it holds.
    for (const t of timers.splice(0)) clearInterval(t);
    seeder.send({ numwant: 0, offers: [], event: 'stopped' });
    seeder.close();
    await sleep(1000);
    const fetcher = new TrackerPeer(tracker, hash);
    await fetcher.open();
    let peer: number | undefined;
    for (let attempt = 1; attempt <= 3 && peer === undefined; attempt++) {
      const offer = await helper.call('rtc-offer', { swarm });
      const offerId = token(20);
      fetcher.send({
        numwant: 1,
        offers: [{ offer_id: offerId, offer: { type: 'offer', sdp: offer['sdp'] } }],
        event: attempt === 1 ? 'started' : 'update',
      });
      const answer = await fetcher.answerTo(offerId, 15_000);
      if (answer?.answer === undefined) {
        await helper.call('rtc-hangup', { peer: offer['peer'] });
        continue;
      }
      await helper.call('rtc-accept', { peer: offer['peer'], answer: answer.answer.sdp });
      peer = Number(offer['peer']);
    }
    if (peer === undefined) throw new Error('fetch: the browser answered none of 3 offers');
    await events.wait(
      'the fetch connection opening',
      30_000,
      (e) => e['t'] === 'open' && e['peer'] === peer,
    );
    const have = await events.wait(
      'the browser announcing segments',
      30_000,
      (e) => e['t'] === 'have' && e['peer'] === peer && (e['ranges'] as unknown[]).length > 0,
    );
    const ids: number[] = [];
    for (const [lo, hi] of have['ranges'] as [number, number][]) {
      for (let id = lo; id <= hi && ids.length < 1000; id++) ids.push(id);
    }
    const fetched: number[] = [];
    const fetchProblems: string[] = [];
    for (const id of ids) {
      const want = shas[id];
      if (want === undefined) {
        fetchProblems.push(`the browser announced segment ${String(id)}, which the playlist lacks`);
        continue;
      }
      const r = await helper.call('rtc-get', { peer, segment: id, max: 16 * 1024 * 1024 });
      const got = createHash('sha256').update(r.bytes).digest('hex');
      if (got !== want || r['size'] !== r.bytes.length) {
        fetchProblems.push(`segment ${String(id)}: sha256 ${got}, the playlist names ${want}`);
      } else fetched.push(id);
    }
    results['fetch'] = { peer, announced: have['ranges'], fetched: fetched.length, fetchProblems };
    if (fetched.length < 3) fetchProblems.push(`only ${String(fetched.length)} segments fetched`);
    if (fetchProblems.length > 0) throw new Error(`fetch: ${fetchProblems.join('; ')}`);
    fetcher.close();
    await helper.call('rtc-hangup', { peer });
    results['helperEvents'] = events.all.length;
    results['helperLost'] = events.lost;
    events.stop();
    await helper.call('rtc-stop');
  } finally {
    await browser?.close();
  }
}

function keepLogs(): void {
  if (OUT === undefined) return;
  mkdirSync(OUT, { recursive: true });
  for (const [name, text] of Object.entries(logs)) writeFileSync(join(OUT, name), text());
  writeFileSync(join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
}

function cleanup(): void {
  for (const t of timers) clearInterval(t);
  for (const w of sockets) w.close();
  for (const s of servers) s.close();
  for (const c of children) {
    if (c.pid !== undefined && c.exitCode === null) {
      try {
        process.kill(-c.pid, 'SIGTERM'); // our own process group only
      } catch {
        // already gone
      }
    }
  }
  rmSync(work, { recursive: true, force: true }); // the throwaway key too
}

main().then(
  () => {
    keepLogs();
    cleanup();
    process.stdout.write(`${JSON.stringify(results, null, 2)}\nhelper webrtc e2e: PASS\n`);
    process.exit(0);
  },
  (e: unknown) => {
    keepLogs();
    cleanup();
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    process.stderr.write(
      `helper webrtc e2e: FAIL\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    );
    process.exit(1);
  },
);
