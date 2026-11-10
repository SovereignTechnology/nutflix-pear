/**
 * The web client, end to end (ADR 0022, M4): the built site (`dist/site`, served with the headers
 * the build wrote, the production CSP among them) in headless Chromium, against nfxd built from the
 * nfx commit `nfx-web.lock` pins and a stock Nostr relay without NIP-50 (strfry). Modelled on nfx's
 * `web/player/e2e-mesh.ts`. Everything runs on this machine: loopback, throwaway keys, generated
 * clips; the browser resolves `*.e2e.test` to 127.0.0.1 and nothing else, so it reaches no other
 * host (not web.nutflix.xyz, not the default relays).
 *
 * The page's rules for endpoints are the production ones: beacons may name only `https:` origins
 * and `wss:` trackers on public names, and read relays are `wss:`. So every service sits behind a
 * TLS front with a `*.e2e.test` name and a throwaway certificate (in the work directory, deleted
 * with it); the browser context ignores certificate errors, as nfx's e2e does.
 *
 *   relay.e2e.test    nfxd A's embedded scoped relay (NIP-50)  strfry.e2e.test  strfry (no NIP-50)
 *   seed.e2e.test     a gate in front of nfxd A's origin       tracker.e2e.test nfxd A's tracker
 *   liar.e2e.test     a lying proxy in front of nfxd B's origin web.e2e.test     the site
 *   held.e2e.test     a recorder in front of nfxd C's origin
 *
 * nfxd A seeds the lead video (720p and 360p) with `--bridge` (a native WebRTC peer in its
 * tracker's swarms), and its beacons name `https://seed.e2e.test:…` and `wss://tracker.e2e.test:…`.
 * nfxd B seeds a second video, its beacons naming only the liar. A third video is published and
 * deleted, a fourth published and seeded by nobody. nfxd C seeds a fifth, made in 720p and 360p,
 * in 360p only (`--seed <a>#360p`, nfx #77): its origin answers 404 for 720p's files, and its
 * beacons' `https` endpoint names `renditions: ["360p"]`.
 *
 * Checks, in one page (the beacon watch lives as long as the page):
 *  1. Home's Network feed lists the videos (not the deleted one).
 *  2. Search finds the lead video through strfry (no NIP-50: a plain query matched in the page,
 *     and no `search` filter is sent to it), and through nfxd's relay alone, in a fresh start of
 *     the app (its NIP-11 document, listing 50, is read with CORS; then `search` is sent there).
 *  3. The lead video plays past 5 s with nothing refused and nothing stopped, and its quality
 *     picker appears once the player knows the renditions, offering them by their hash-list ids
 *     (`720p`, `360p`: the library's `Level.id`).
 *  4. The origin then refuses every segment, and playback goes on 15 s more, past the end of the
 *     last segment the origin served: those bytes came over WebRTC, from the bridge.
 *  5. Held renditions (pear #97, nfx #83): the fifth video plays past 5 s with nothing refused, as
 *     360p alone (no quality picker), and the page never asks nfxd C's origin for a 720p file
 *     (playlist, init or segment), so it never gets a 404.
 *  6. The liar flips a byte of every segment: the page says files were refused, and the video
 *     does not move. Then, in a new play, it lies about the hash list: the page says the origin
 *     was skipped, and the play stops because no origin served a hash list that verifies.
 *  7. The deleted video's page says "Video not found".
 *  8. The unseeded video's Play ends in "No seeders online".
 *  9. Settings shows the line about IP addresses, and the link to source.json, whose hashes are
 *     the files served.
 * 10. No `securitypolicyviolation` event and no uncaught error, on any page, all along.
 *
 * Usage (from packages/app-web, after the site build): node e2e/web.e2e.ts
 *   NFX_BIN       directory with nfxd and nfx-package built from the lock's nfx commit (required)
 *   STRFRY        the strfry binary; STRFRY_CONF its own default strfry.conf (required)
 *   SITE          the site (default dist/site); SITE_HEADERS its headers (default dist/site-headers.txt)
 *   CHROMIUM      a Chromium to run instead of Playwright's
 *   E2E_OUT       where results.json (and failure screenshots) go (default: none kept)
 *   FFMPEG, OPENSSL  the tools (default from PATH)
 * Every process it starts runs in its own process group, and only those are killed.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as tcpConnect, createServer as createTcpServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { fileURLToPath } from 'node:url';

import { chromium, type BrowserContext, type Page } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v === undefined || v === '' ? undefined : v;
};
const need = (k: string): string => {
  const v = env(k);
  if (v === undefined) throw new Error(`set ${k}`);
  return v;
};

const NFX_BIN = resolve(need('NFX_BIN'));
const STRFRY = resolve(need('STRFRY'));
const STRFRY_CONF = resolve(need('STRFRY_CONF'));
const SITE = resolve(env('SITE') ?? join(pkg, 'dist', 'site'));
const SITE_HEADERS = resolve(env('SITE_HEADERS') ?? join(pkg, 'dist', 'site-headers.txt'));
const FFMPEG = env('FFMPEG') ?? 'ffmpeg';
const OPENSSL = env('OPENSSL') ?? 'openssl';
const OUT = env('E2E_OUT');
const CHROMIUM = env('CHROMIUM');
const NS = 'nfx:testnet:1';
const SETTINGS_KEY = 'nutflix.web.settings.v1';

const work = mkdtempSync(join(tmpdir(), 'nfx-web-e2e-'));
chmodSync(work, 0o700);
const children: ChildProcess[] = [];
const servers: (Server | TlsServer)[] = [];
const results: Record<string, unknown> = {};

const bin = (name: string): string => join(NFX_BIN, name);

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
  text(): string;
}

/** A child in its own process group, once its stderr has matched every pattern. */
function start(
  cmd: string,
  args: string[],
  waitFor: RegExp[],
  timeoutMs = 60_000,
): Promise<Started> {
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
    }, timeoutMs);
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

/** A port nobody holds right now (strfry takes its port from its config). */
function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createTcpServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => {
        ok(port);
      });
    });
  });
}

/** Until something accepts a TCP connection on `port`. */
async function waitPort(port: number, log: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const open = await new Promise<boolean>((ok) => {
      const sock = tcpConnect(port, '127.0.0.1');
      sock.once('connect', () => {
        sock.destroy();
        ok(true);
      });
      sock.once('error', () => {
        ok(false);
      });
    });
    if (open) return;
    if (Date.now() > deadline)
      throw new Error(`nothing listens on ${String(port)}:\n${log().slice(-4000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function until(what: string, ms: number, test: () => boolean): Promise<void> {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** The throwaway certificate every front and the site use: `*.e2e.test` and 127.0.0.1. */
function certificate(): { key: Buffer; cert: Buffer } {
  const key = join(work, 'tls.key');
  const cert = join(work, 'tls.crt');
  run(OPENSSL, [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '1',
    '-subj',
    '/CN=e2e.test',
    '-addext',
    'subjectAltName=DNS:*.e2e.test,IP:127.0.0.1',
  ]);
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

/** TLS in front of a plain TCP service, set once it is known: it carries https and wss alike. */
async function tlsFront(tls: { key: Buffer; cert: Buffer }): Promise<{
  port: number;
  setUpstream: (port: number) => void;
}> {
  let upstream = 0;
  const server = createTlsServer(tls, (sock) => {
    if (upstream === 0) {
      sock.destroy();
      return;
    }
    const up = tcpConnect(upstream, '127.0.0.1');
    sock.pipe(up);
    up.pipe(sock);
    sock.on('error', () => up.destroy());
    up.on('error', () => sock.destroy());
    sock.on('close', () => up.destroy());
    up.on('close', () => sock.destroy());
  });
  servers.push(server);
  const port = await new Promise<number>((ok) =>
    server.listen(0, '127.0.0.1', () => {
      ok((server.address() as AddressInfo).port);
    }),
  );
  return {
    port,
    setUpstream: (p) => {
      upstream = p;
    },
  };
}

/**
 * Where a front forwards `reqUrl`: `upstream`'s scheme, host and port, always, with only the
 * request's path and query. Concatenating `upstream + req.url` let a request target such as
 * `@other.host/x` move the host (userinfo) or `//other.host/x` make it protocol-relative.
 */
function forwardUrl(upstream: string, reqUrl: string | undefined): URL {
  const asked = new URL(reqUrl ?? '/', 'http://front.invalid');
  const to = new URL(upstream);
  to.pathname = to.pathname.replace(/\/$/, '') + asked.pathname;
  to.search = asked.search;
  return to;
}

/** `req` to `upstream` as the browser sent it (a Range included); `edit` may change a 200's body. */
function proxy(
  upstream: string,
  req: IncomingMessage,
  res: ServerResponse,
  edit?: (body: Buffer) => void,
): void {
  const headers = { ...req.headers };
  delete headers.host;
  const up = httpRequest(forwardUrl(upstream, req.url), { method: req.method, headers }, (r) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.on('end', () => {
      const body = Buffer.concat(chunks);
      if (edit !== undefined && body.length > 0 && (r.statusCode ?? 0) === 200) edit(body);
      const headers = { ...r.headers };
      delete headers['content-length'];
      res.writeHead(r.statusCode ?? 502, headers).end(body);
    });
  });
  up.on('error', () => res.writeHead(502).end());
  up.end();
}

const SEGMENT = /\/([0-9a-f]{64})\.m4s$/;

/** The honest origin behind a switch: once blocked, every segment is refused. Records what it served. */
async function gate(upstream: string): Promise<{
  port: number;
  block: () => void;
  served: Set<string>;
  refused: () => number;
}> {
  let blocked = false;
  let refused = 0;
  const served = new Set<string>();
  const port = await listen(
    createServer((req, res) => {
      const seg = SEGMENT.exec(req.url ?? '');
      if (seg !== null && blocked) {
        refused += 1;
        res
          .writeHead(503, { 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
          .end();
        return;
      }
      if (seg?.[1] !== undefined) served.add(seg[1]);
      proxy(upstream, req, res);
    }),
  );
  return {
    port,
    block: () => {
      blocked = true;
    },
    served,
    refused: () => refused,
  };
}

/** A lying origin: flips the first byte of every segment, or of the hash list. */
async function liar(
  upstream: string,
): Promise<{ port: number; lie: (what: 'segments' | 'hashlist') => void }> {
  let lie: 'segments' | 'hashlist' = 'segments';
  const port = await listen(
    createServer((req, res) => {
      const path = req.url ?? '';
      const target = lie === 'segments' ? SEGMENT.test(path) : /^\/[0-9a-f]{64}$/.test(path);
      const flip = (body: Buffer): void => {
        body[0] = (body[0] ?? 0) ^ 0xff;
      };
      proxy(upstream, req, res, target ? flip : undefined);
    }),
  );
  return {
    port,
    lie: (what) => {
      lie = what;
    },
  };
}

/** A front that records every request it passes on: the file it names, and its answer's status. */
async function recorder(upstream: string): Promise<{
  port: number;
  requests: { path: string; sha: string | null; status: number }[];
}> {
  const requests: { path: string; sha: string | null; status: number }[] = [];
  const port = await listen(
    createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const sha = /\/([0-9a-f]{64})(?:\.[a-z0-9]+)?$/.exec(path)?.[1] ?? null;
      const headers = { ...req.headers };
      delete headers.host;
      const up = httpRequest(
        forwardUrl(upstream, req.url),
        { method: req.method, headers },
        (r) => {
          requests.push({ path, sha, status: r.statusCode ?? 502 });
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      up.on('error', () => {
        requests.push({ path, sha, status: 502 });
        res.writeHead(502).end();
      });
      up.end();
    }),
  );
  return { port, requests };
}

/** The status `url` (plain http, loopback) answers a GET with. */
function statusOf(url: string): Promise<number> {
  return new Promise((ok, fail) => {
    const r = httpRequest(url, { method: 'GET' }, (res) => {
      res.resume();
      ok(res.statusCode ?? 0);
    });
    r.on('error', fail);
    r.end();
  });
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

/** The site, over https, with exactly the headers the build wrote (the production CSP). */
function siteServer(tls: { key: Buffer; cert: Buffer }): Promise<number> {
  const headers: Record<string, string> = {};
  for (const line of readFileSync(SITE_HEADERS, 'utf8').split('\n')) {
    const i = line.indexOf(': ');
    if (i > 0) headers[line.slice(0, i)] = line.slice(i + 2);
  }
  if (headers['Content-Security-Policy'] === undefined)
    throw new Error('no CSP in the site headers');
  results['csp'] = headers['Content-Security-Policy'];
  const server = createHttpsServer(tls, (req, res) => {
    const path = new URL(req.url ?? '/', 'https://x').pathname;
    const rel = path === '/' ? 'index.html' : path.slice(1);
    const file = resolve(SITE, rel);
    if (!file.startsWith(`${SITE}/`) || !existsSync(file)) {
      res.writeHead(404, headers).end();
      return;
    }
    res
      .writeHead(200, {
        ...headers,
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      })
      .end(readFileSync(file));
  });
  servers.push(server);
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => {
      ok((server.address() as AddressInfo).port);
    }),
  );
}

interface Pkg {
  readonly dir: string;
  readonly store: string;
  readonly video: string;
  readonly root: string;
}

function clip(name: string, size: string, seconds: number): string {
  const file = join(work, `${name}.mp4`);
  run(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${size}:rate=30`,
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
  return file;
}

/** `input` packaged as NFX; `renditions` as `nfx-package --renditions` takes them (default: one). */
function packageClip(input: string, id: string, maxHeight: number, renditions?: string): Pkg {
  const dir = join(work, `pkg-${id}`);
  run(bin('nfx-package'), [
    input,
    '--video',
    `${NS}:${id}`,
    '--out',
    dir,
    '--max-height',
    String(maxHeight),
    ...(renditions === undefined ? [] : ['--renditions', renditions]),
    '--preset',
    'veryfast',
    '--no-thumb',
  ]);
  const meta = JSON.parse(readFileSync(join(dir, 'nfx.json'), 'utf8')) as {
    root: string;
    video: string;
  };
  return { dir, store: join(dir, 'store'), video: meta.video, root: meta.root };
}

/** Each segment's [start, end) in seconds, by sha256, from the package's own playlists. */
function segmentTimes(p: Pkg): Map<string, [number, number]> {
  const list = JSON.parse(readFileSync(join(p.store, p.root), 'utf8')) as {
    files: { name: string; sha256: string }[];
    renditions: { playlist: string }[];
  };
  const times = new Map<string, [number, number]>();
  for (const r of list.renditions) {
    const f = list.files.find((x) => x.name === r.playlist);
    if (f === undefined) continue;
    let t = 0;
    let dur = 0;
    for (const line of readFileSync(join(p.store, f.sha256), 'utf8').split('\n')) {
      const inf = /^#EXTINF:([0-9.]+)/.exec(line);
      if (inf?.[1] !== undefined) dur = Number(inf[1]);
      const seg = /^([0-9a-f]{64})\.m4s$/.exec(line.trim());
      if (seg?.[1] !== undefined) {
        times.set(seg[1], [t, t + dur]);
        t += dur;
      }
    }
  }
  return times;
}

/**
 * Rendition `id`'s files in package `p`, by sha256: its media playlist, and the init and segments
 * that playlist lists.
 */
function renditionFiles(p: Pkg, id: string): Set<string> {
  const list = JSON.parse(readFileSync(join(p.store, p.root), 'utf8')) as {
    files: { name: string; sha256: string }[];
    renditions: { id: string; playlist: string }[];
  };
  const r = list.renditions.find((x) => x.id === id);
  const playlist = list.files.find((f) => f.name === r?.playlist);
  if (playlist === undefined) throw new Error(`${p.video} has no rendition ${id}`);
  const text = readFileSync(join(p.store, playlist.sha256), 'utf8');
  const shas = new Set([playlist.sha256]);
  for (const m of text.matchAll(/([0-9a-f]{64})\.(?:m4s|mp4)/g))
    if (m[1] !== undefined) shas.add(m[1]);
  if (shas.size < 3)
    throw new Error(`rendition ${id} of ${p.video} lists ${String(shas.size - 1)} files`);
  return shas;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ---- the page ------------------------------------------------------------------------------

interface Watch {
  readonly csp: string[];
  readonly errors: string[];
  readonly frames: { url: string; payload: string }[];
  /** The NIP-11 requests (https to a relay's name) and how each ended: `200 acao=*`, or why not. */
  readonly nip11: { url: string; outcome: string }[];
  /** The page's console errors and warnings (the last `CONSOLE_KEEP`), for a failure's report. */
  readonly console: string[];
}

const CONSOLE_KEEP = 200;
const RELAY_HTTPS = /^https:\/\/(?:relay|strfry)\.e2e\.test[:/]/;

/** Everything the run must not see, from every page of the context. */
async function watch(context: BrowserContext): Promise<Watch> {
  const w: Watch = { csp: [], errors: [], frames: [], nip11: [], console: [] };
  await context.exposeBinding('__e2eCsp', (_source, v: string) => {
    w.csp.push(v);
  });
  context.on('response', (r) => {
    if (!RELAY_HTTPS.test(r.url())) return;
    const acao = r.headers()['access-control-allow-origin'] ?? '(none)';
    w.nip11.push({ url: r.url(), outcome: `${String(r.status())} acao=${acao}` });
  });
  context.on('requestfailed', (r) => {
    if (RELAY_HTTPS.test(r.url()))
      w.nip11.push({ url: r.url(), outcome: `failed: ${r.failure()?.errorText ?? '?'}` });
  });
  await context.addInitScript({
    content: `document.addEventListener('securitypolicyviolation', (e) => {
      window.__e2eCsp(JSON.stringify({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber }));
    }, true);`,
  });
  context.on('page', (page) => {
    page.on('pageerror', (e) => w.errors.push(e.message));
    page.on('console', (m) => {
      if (/Content.Security.Policy/i.test(m.text())) w.csp.push(`console: ${m.text()}`);
      if (m.type() === 'error' || m.type() === 'warning') {
        w.console.push(`${m.type()}: ${m.text()}`);
        if (w.console.length > CONSOLE_KEEP) w.console.shift();
      }
    });
    page.on('websocket', (ws) => {
      ws.on('framesent', (f) => {
        w.frames.push({ url: ws.url(), payload: typeof f.payload === 'string' ? f.payload : '' });
      });
    });
  });
  return w;
}

async function go(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
}

async function text(page: Page, selector: string): Promise<string> {
  return (await page.locator(selector).first().textContent()) ?? '';
}

function videoTime(page: Page): Promise<number> {
  return page.evaluate(() => {
    const v = document.querySelector('video.nf-nfxwatch__video');
    return v instanceof HTMLVideoElement ? v.currentTime : -1;
  });
}

async function waitTime(page: Page, past: number, ms: number): Promise<void> {
  await page.waitForFunction(
    (t) => {
      const v = document.querySelector('video.nf-nfxwatch__video');
      const stopped = document.querySelector('.nf-nfxwatch__problem--stopped');
      return stopped !== null || (v instanceof HTMLVideoElement && v.currentTime > t);
    },
    past,
    { timeout: ms, polling: 250 },
  );
}

/**
 * Off the app (to `source.json`, same origin) and then these settings, so the next `goto` starts
 * the app afresh with them. The store reads its settings when the app starts (a `storage` event
 * reaches only other pages), and a `goto` that changes only the hash, or nothing, stays in the
 * same document: the app would go on with the settings it started with.
 */
async function offApp(page: Page, site: string, relays: string[], scoped: string[]): Promise<void> {
  await page.goto(`${site}/source.json`);
  await settings(page, relays, scoped);
}

async function settings(page: Page, relays: string[], scoped: string[]): Promise<void> {
  const value = JSON.stringify({
    v: 1,
    settings: {
      relays: relays.map((url) => ({ url, read: true, write: true })),
      nfx: { enabled: true, network: NS, scopedRelays: scoped, trackers: [] },
    },
  });
  await page.evaluate(
    ([k, v]) => {
      localStorage.setItem(k ?? '', v ?? '');
    },
    [SETTINGS_KEY, value],
  );
}

async function main(): Promise<void> {
  for (const f of ['nfxd', 'nfx-package']) {
    if (!existsSync(bin(f))) throw new Error(`no ${bin(f)}`);
  }
  if (!existsSync(join(SITE, 'index.html'))) throw new Error(`no site at ${SITE}: build it first`);
  const tls = certificate();

  // ---- content: five videos by one creator ----------------------------------------------------
  // nfx-package makes one rendition by default since nfx #76: the lead and the held video name two.
  const lead = packageClip(clip('lead', '1280x720', 60), 'web-e2e-lead', 720, '720p,360p');
  const lies = packageClip(clip('lies', '640x360', 20), 'web-e2e-liar', 360);
  const gone = packageClip(clip('gone', '640x360', 4), 'web-e2e-deleted', 360);
  const lone = packageClip(clip('lone', '640x360', 4), 'web-e2e-unseeded', 360);
  const held = packageClip(clip('held', '1280x720', 20), 'web-e2e-held', 720, '720p,360p');
  const files720 = renditionFiles(held, '720p');
  const files360 = renditionFiles(held, '360p');
  const keyA = join(work, 'a.key');
  const keyB = join(work, 'b.key');
  const keyC = join(work, 'c.key');
  const creator = run(bin('nfxd'), ['key', 'new', keyA]).split('\n')[0] ?? '';
  run(bin('nfxd'), ['key', 'new', keyB]);
  run(bin('nfxd'), ['key', 'new', keyC]);
  const addr = (p: Pkg): string => `38504:${creator}:${p.video}`;
  results['videos'] = {
    lead: addr(lead),
    liar: addr(lies),
    deleted: addr(gone),
    unseeded: addr(lone),
    held: addr(held),
  };

  // ---- the stock relay ------------------------------------------------------------------------
  const strfryPort = await freePort();
  mkdirSync(join(work, 'strfry-db'));
  const conf = readFileSync(STRFRY_CONF, 'utf8')
    .replace(/^db = "\.\/strfry-db\/"$/m, `db = "${join(work, 'strfry-db')}/"`)
    .replace(/^(\s*)port = 7777$/m, `$1port = ${String(strfryPort)}`)
    // As the CI user, not root: leave the open-files limit as it is (0 = do not set it).
    .replace(/^(\s*)nofiles = [0-9]+$/m, '$1nofiles = 0');
  if (!conf.includes(`port = ${String(strfryPort)}`) || !conf.includes(join(work, 'strfry-db'))) {
    throw new Error('strfry.conf: db or port not found');
  }
  writeFileSync(join(work, 'strfry.conf'), conf);
  const strfry = await start(STRFRY, [`--config=${join(work, 'strfry.conf')}`, 'relay'], []);
  await waitPort(strfryPort, () => strfry.text());
  const strfryWs = `ws://127.0.0.1:${String(strfryPort)}`;

  // ---- fronts, then nfxd A (the bridge) -------------------------------------------------------
  const relayFront = await tlsFront(tls);
  const strfryFront = await tlsFront(tls);
  const seedFront = await tlsFront(tls);
  const trackerFront = await tlsFront(tls);
  const liarFront = await tlsFront(tls);
  const heldFront = await tlsFront(tls);
  strfryFront.setUpstream(strfryPort);
  const a = await start(
    bin('nfxd'),
    [
      'run',
      '--key',
      keyA,
      '--store',
      lead.store,
      '--state',
      join(work, 'state-a'),
      '--seed',
      addr(lead),
      '--embed-relay',
      '127.0.0.1:0',
      '--origin',
      '127.0.0.1:0',
      '--embed-tracker',
      '127.0.0.1:0',
      '--bridge',
      '127.0.0.1:0',
      '--https-url',
      `https://seed.e2e.test:${String(seedFront.port)}`,
      '--tracker-url',
      `wss://tracker.e2e.test:${String(trackerFront.port)}`,
    ],
    [
      /embedded relay: (ws:\/\/\S+)/,
      /origin: (http:\/\/\S+?)\/?\s/,
      /embedded tracker: (ws:\/\/\S+)/,
      /bridge: udp (\S+)/,
    ],
  );
  const relayWs = a.matches[0]?.[1] ?? '';
  const originA = (a.matches[1]?.[1] ?? '').replace(/\/$/, '');
  const trackerWs = a.matches[2]?.[1] ?? '';
  relayFront.setUpstream(Number(new URL(relayWs).port));
  trackerFront.setUpstream(Number(new URL(trackerWs).port));
  const g = await gate(originA);
  seedFront.setUpstream(g.port);

  for (const [p, title] of [
    [lead, 'Lighthouse web e2e'],
    [lies, 'Liar web e2e'],
    [gone, 'Withdrawn web e2e'],
    [lone, 'Unseeded web e2e'],
    [held, 'Held renditions web e2e'],
  ] as const) {
    run(bin('nfxd'), [
      'publish',
      '--key',
      keyA,
      '--relay',
      relayWs,
      '--relay',
      strfryWs,
      '--package',
      p.dir,
      '--title',
      title,
      '--tag',
      'e2e',
    ]);
  }
  run(bin('nfxd'), [
    'delete',
    '--key',
    keyA,
    '--relay',
    relayWs,
    '--relay',
    strfryWs,
    '--a',
    addr(gone),
  ]);
  await until('nfxd A seeding the lead video', 60_000, () =>
    a.text().includes(`${addr(lead)}: Seeding`),
  );

  // ---- nfxd B: the liar's seeder --------------------------------------------------------------
  const b = await start(
    bin('nfxd'),
    [
      'run',
      '--key',
      keyB,
      '--store',
      lies.store,
      '--state',
      join(work, 'state-b'),
      '--seed',
      addr(lies),
      '--relay',
      relayWs,
      '--origin',
      '127.0.0.1:0',
      '--https-url',
      `https://liar.e2e.test:${String(liarFront.port)}`,
    ],
    [/origin: (http:\/\/\S+?)\/?\s/],
  );
  const l = await liar((b.matches[0]?.[1] ?? '').replace(/\/$/, ''));
  liarFront.setUpstream(l.port);
  await until('nfxd B seeding the liar video', 60_000, () =>
    b.text().includes(`${addr(lies)}: Seeding`),
  );

  // ---- nfxd C: the held video, in 360p only ---------------------------------------------------
  const nodeC = await start(
    bin('nfxd'),
    [
      'run',
      '--key',
      keyC,
      '--store',
      held.store,
      '--state',
      join(work, 'state-c'),
      '--seed',
      `${addr(held)}#360p`,
      '--relay',
      relayWs,
      '--origin',
      '127.0.0.1:0',
      '--https-url',
      `https://held.e2e.test:${String(heldFront.port)}`,
    ],
    [/origin: (http:\/\/\S+?)\/?\s/],
  );
  const originC = (nodeC.matches[0]?.[1] ?? '').replace(/\/$/, '');
  const h = await recorder(originC);
  heldFront.setUpstream(h.port);
  await until('nfxd C seeding the held video', 60_000, () =>
    nodeC.text().includes(`${addr(held)}: Seeding`),
  );
  // What the test rests on: nfxd C serves 360p's files and 720p's playlist (a meta file), and
  // answers 404 for 720p's init and segments.
  const fileOf = (shas: Set<string>, ext: string): string => {
    const list = readFileSync(join(held.store, [...shas][0] ?? ''), 'utf8');
    const m = new RegExp(`([0-9a-f]{64})\\.${ext}`).exec(list);
    if (m?.[1] === undefined) throw new Error(`no .${ext} in a playlist of the held video`);
    return `${originC}/${held.root}/${m[1]}.${ext}`;
  };
  const originAnswers = {
    playlist720: await statusOf(`${originC}/${held.root}/${[...files720][0] ?? ''}.m3u8`),
    init720: await statusOf(fileOf(files720, 'mp4')),
    segment720: await statusOf(fileOf(files720, 'm4s')),
    segment360: await statusOf(fileOf(files360, 'm4s')),
  };
  results['heldOrigin'] = originAnswers;
  if (
    originAnswers.playlist720 !== 200 ||
    originAnswers.init720 !== 404 ||
    originAnswers.segment720 !== 404 ||
    originAnswers.segment360 !== 200
  ) {
    throw new Error(`nfxd C's origin for the held video: ${JSON.stringify(originAnswers)}`);
  }

  const sitePort = await siteServer(tls);
  const site = `https://web.e2e.test:${String(sitePort)}`;
  const relay = `wss://relay.e2e.test:${String(relayFront.port)}`;
  const stock = `wss://strfry.e2e.test:${String(strfryFront.port)}`;

  // ---- the browser ----------------------------------------------------------------------------
  const browser = await chromium.launch({
    headless: true,
    // Chromium's own sandbox, as pear's other browser runs keep it (E2E_NO_SANDBOX=1 drops it, for
    // a host whose kernel refuses its user namespaces).
    chromiumSandbox: env('E2E_NO_SANDBOX') === undefined,
    ...(CHROMIUM === undefined ? {} : { executablePath: CHROMIUM }),
    args: [
      // *.e2e.test is this machine; every other name fails, so the page reaches nobody else.
      '--host-resolver-rules=MAP *.e2e.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true }); // throwaway certificate
  const w = await watch(context);
  const page = await context.newPage();
  try {
    // Settings before the app first runs: strfry the read relay, nfxd A's relay the scoped one.
    await offApp(page, site, [stock], [relay]);
    await page.goto(`${site}/#/`);

    // 1. The Network feed.
    await page.getByText('Lighthouse web e2e').first().waitFor({ timeout: 60_000 });
    await page.getByText('Unseeded web e2e').first().waitFor({ timeout: 30_000 });
    const home = (await page.locator('body').textContent()) ?? '';
    if (home.includes('Withdrawn web e2e')) throw new Error('the deleted video is listed');
    results['feed'] = 'listed';

    // 2. Search: through strfry (matched in the page), then through nfxd's relay alone (NIP-50).
    const searches = (): { url: string; search: boolean }[] =>
      w.frames
        .filter((f) => f.payload.startsWith('["REQ"'))
        .map((f) => ({ url: f.url, search: f.payload.includes('"search"') }));
    w.frames.length = 0;
    await go(page, '#/search/lighthouse');
    await page
      .locator('.nf-search')
      .getByText('Lighthouse web e2e')
      .first()
      .waitFor({ timeout: 60_000 });
    const viaStock = searches();
    if (viaStock.some((s) => s.search && s.url.startsWith(stock)))
      throw new Error('a NIP-50 search filter went to strfry, which does not list NIP-50');
    if (!viaStock.some((s) => s.url.startsWith(stock))) throw new Error('strfry was never asked');
    const stockInfo = w.nip11.filter((n) => n.url.startsWith(stock.replace(/^wss:/, 'https:')));
    // nfxd's relay alone, in a fresh start of the app (a new adapter, so a new NIP-11 probe).
    await offApp(page, site, [], [relay]);
    w.frames.length = 0;
    w.nip11.length = 0;
    await page.goto(`${site}/#/search/lighthouse`);
    await page
      .locator('.nf-search')
      .getByText('Lighthouse web e2e')
      .first()
      .waitFor({ timeout: 60_000 });
    const relayInfo = w.nip11.filter((n) => n.url.startsWith(relay.replace(/^wss:/, 'https:')));
    if (!relayInfo.some((n) => n.outcome === '200 acao=*'))
      throw new Error(`nfxd’s relay did not answer the NIP-11 probe: ${JSON.stringify(w.nip11)}`);
    if (!searches().some((s) => s.search && s.url.startsWith(relay)))
      throw new Error(
        `no NIP-50 search went to nfxd’s relay (NIP-11: ${JSON.stringify(relayInfo)}; ` +
          `REQs: ${JSON.stringify(searches())})`,
      );
    results['search'] = {
      stock: 'matched in the page',
      stockNip11: stockInfo.map((n) => n.outcome),
      scoped: 'NIP-50',
      scopedNip11: relayInfo.map((n) => n.outcome),
    };
    await offApp(page, site, [stock], [relay]);
    await page.goto(`${site}/#/`);
    await page.getByText('Lighthouse web e2e').first().waitFor({ timeout: 60_000 });

    // 3. Play the lead video past 5 s: nothing refused, and the quality picker once levels arrive.
    await go(page, `#/watch/${addr(lead)}`);
    await page.locator('.nf-nfxwatch__start button').click({ timeout: 60_000 });
    // Up to one beacon interval to find the seeder (the page was reloaded), then the play.
    await waitTime(page, 5, 180_000);
    if ((await page.locator('.nf-nfxwatch__problems').count()) > 0)
      throw new Error(`problems while playing: ${await text(page, '.nf-nfxwatch__problems')}`);
    await page.locator('.nf-nfxwatch__quality select').waitFor({ timeout: 30_000 });
    const levels = await page.locator('.nf-nfxwatch__quality option').allTextContents();
    // The menu's values are the renditions' hash-list ids (Level.id), not level indexes.
    const ids = (
      await page
        .locator('.nf-nfxwatch__quality option')
        .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))
    ).filter((v) => v !== '');
    results['play'] = { pastFive: await videoTime(page), quality: levels, ids };
    if (JSON.stringify([...ids].sort()) !== '["360p","720p"]')
      throw new Error(`the quality menu offers ${JSON.stringify(ids)}, not 360p and 720p by id`);

    // 4. The origin refuses every segment from now on; the rest comes from the bridge.
    const times = segmentTimes(lead);
    g.block();
    const t0 = await videoTime(page);
    // What the origin had served when it went: nothing after this point can come from it.
    const servedEnd = Math.max(0, ...[...g.served].map((s) => times.get(s)?.[1] ?? 0));
    const unknown = [...g.served].filter((s) => !times.has(s));
    await waitTime(page, Math.max(t0 + 15, servedEnd + 4), 150_000);
    if ((await page.locator('.nf-nfxwatch__problem--stopped').count()) > 0)
      throw new Error(
        `the play stopped when the origin went: ${await text(page, '.nf-nfxwatch__problems')}`,
      );
    const t1 = await videoTime(page);
    results['bridge'] = {
      blockedAt: t0,
      playedTo: t1,
      originServedUpTo: servedEnd,
      originRefused: g.refused(),
      unknown,
    };
    if (unknown.length > 0)
      throw new Error(`the origin served segments no playlist lists: ${unknown.join(' ')}`);
    if (!(t1 > servedEnd + 1))
      throw new Error(
        `played to ${String(t1)} s, but the origin served up to ${String(servedEnd)} s: nothing came from the bridge`,
      );
    if ((await page.locator('.nf-nfxwatch__problems').count()) > 0)
      throw new Error(
        `problems after the origin went: ${await text(page, '.nf-nfxwatch__problems')}`,
      );

    // 5. Held renditions: nfxd C holds the held video in 360p only, and its beacon says so.
    await go(page, `#/watch/${addr(held)}`);
    await page.locator('.nf-nfxwatch__start button').click({ timeout: 60_000 });
    // Up to one beacon interval to find nfxd C's beacon, then the play.
    await waitTime(page, 5, 180_000);
    if ((await page.locator('.nf-nfxwatch__problems').count()) > 0)
      throw new Error(
        `problems playing held renditions: ${await text(page, '.nf-nfxwatch__problems')}`,
      );
    const heldAt = await videoTime(page);
    // One level only, so no quality picker (both would be listed without the held cut).
    const picker = await page.locator('.nf-nfxwatch__quality').count();
    const asked720 = h.requests.filter((r) => r.sha !== null && files720.has(r.sha));
    const asked360 = h.requests.filter((r) => r.sha !== null && files360.has(r.sha));
    const failed = h.requests.filter((r) => r.status >= 400);
    results['held'] = {
      playedTo: heldAt,
      picker,
      requests: h.requests.length,
      r720: asked720.map((r) => r.path),
      r360: asked360.length,
      failed: failed.map((r) => `${String(r.status)} ${r.path}`),
    };
    if (!(heldAt > 5)) throw new Error(`the held video played to ${String(heldAt)} s`);
    if (picker !== 0) throw new Error('a quality picker for a video held in one rendition');
    if (asked720.length > 0)
      throw new Error(`the page asked for 720p files: ${JSON.stringify(results['held'])}`);
    if (asked360.length < 3)
      throw new Error(`360p came from elsewhere: ${JSON.stringify(results['held'])}`);
    if (failed.length > 0)
      throw new Error(`nfxd C's origin failed requests: ${JSON.stringify(results['held'])}`);

    // 6. The liar: a byte of every segment, then of the hash list.
    await go(page, `#/watch/${addr(lies)}`);
    await page.locator('.nf-nfxwatch__start button').click({ timeout: 60_000 });
    await page
      .locator('.nf-nfxwatch__problems')
      .getByText(/did not match the video’s hash list/)
      .first()
      .waitFor({ timeout: 120_000 });
    await page.waitForTimeout(8_000);
    const lied = { refused: await text(page, '.nf-nfxwatch__problems'), at: await videoTime(page) };
    if (lied.at > 0.5) throw new Error(`the tampered video played to ${String(lied.at)} s`);
    // A new play (away and back), now with a hash list that does not match the manifest's root.
    l.lie('hashlist');
    await go(page, '#/');
    await go(page, `#/watch/${addr(lies)}`);
    await page.locator('.nf-nfxwatch__start button').click({ timeout: 60_000 });
    await page
      .locator('.nf-nfxwatch__problem--stopped')
      .getByText(/no origin served a hash list that verifies/)
      .first()
      .waitFor({ timeout: 120_000 });
    await page
      .locator('.nf-nfxwatch__problems')
      .getByText(/did not serve a hash list that verifies, so (it was|they were) skipped/)
      .first()
      .waitFor({ timeout: 10_000 });
    if ((await videoTime(page)) > 0.5) throw new Error('a video played from a hash list that lied');
    results['liar'] = { segments: lied, hashlist: await text(page, '.nf-nfxwatch__problems') };

    // 7. The deleted video.
    await go(page, `#/watch/${addr(gone)}`);
    await page.getByText('Video not found').first().waitFor({ timeout: 60_000 });
    results['deleted'] = 'Video not found';

    // 8. Nobody seeds this one: Play waits out one beacon interval, then says so.
    await go(page, `#/watch/${addr(lone)}`);
    await page.locator('.nf-nfxwatch__start button').click({ timeout: 60_000 });
    await page.getByText('No seeders online').first().waitFor({ timeout: 120_000 });
    results['unseeded'] = 'No seeders online';

    // 9. Settings: the IP address line, and source.json, whose hashes are the files served.
    await go(page, '#/settings');
    await page
      .getByText('Trackers and the peers you meet see your IP address.')
      .first()
      .waitFor({ timeout: 30_000 });
    const href = await page.locator('.nf-settings__source a').getAttribute('href');
    if (href !== 'source.json') throw new Error(`the source link is ${String(href)}`);
    const source = (await page.evaluate(() =>
      fetch('source.json').then((r) => r.json() as Promise<unknown>),
    )) as { files: { path: string; sha256: string }[] };
    const servedFiles = readdirSync(SITE, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name).slice(SITE.length + 1))
      .filter((p) => p !== 'source.json')
      .sort();
    const listed = source.files.map((f) => f.path).sort();
    if (JSON.stringify(listed) !== JSON.stringify(servedFiles))
      throw new Error(
        `source.json lists ${JSON.stringify(listed)}, the site has ${JSON.stringify(servedFiles)}`,
      );
    for (const f of source.files) {
      if (sha256File(join(SITE, f.path)) !== f.sha256)
        throw new Error(`source.json: ${f.path} differs`);
    }
    results['settings'] = { ipNotice: true, source: href };

    // 10. Nothing the CSP refused, nothing thrown.
    results['csp_violations'] = w.csp;
    results['page_errors'] = w.errors;
    if (w.csp.length > 0) throw new Error(`CSP violations: ${w.csp.join('; ')}`);
    if (w.errors.length > 0) throw new Error(`page errors: ${w.errors.join('; ')}`);
  } catch (e) {
    if (OUT !== undefined) {
      mkdirSync(OUT, { recursive: true });
      await page
        .screenshot({ path: join(OUT, 'failure.png'), fullPage: true })
        .catch(() => undefined);
      writeFileSync(join(OUT, 'nfxd-a.log'), a.text());
      writeFileSync(join(OUT, 'nfxd-b.log'), b.text());
      writeFileSync(join(OUT, 'nfxd-c.log'), nodeC.text());
      writeFileSync(join(OUT, 'console.txt'), `${w.console.join('\n')}\n`);
    }
    results['csp_violations'] = w.csp;
    results['page_errors'] = w.errors;
    results['nip11'] = w.nip11;
    throw e;
  } finally {
    await browser.close();
  }
}

function cleanup(): void {
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
  rmSync(work, { recursive: true, force: true }); // the throwaway keys and certificate too
}

function report(): void {
  const text = JSON.stringify(results, null, 2);
  process.stdout.write(`${text}\n`);
  if (OUT !== undefined) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'results.json'), `${text}\n`);
  }
}

main().then(
  () => {
    cleanup();
    report();
    process.stdout.write('web e2e: PASS\n');
    process.exit(0);
  },
  (e: unknown) => {
    cleanup();
    report();
    process.stderr.write(
      `web e2e: FAIL\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    );
    process.exit(1);
  },
);
