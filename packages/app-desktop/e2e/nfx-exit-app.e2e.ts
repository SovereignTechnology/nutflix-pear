/**
 * Slice 5f tier 3 (ADR 0020; nfx ADR 0101 §6, ADR 0103 §3): the exit run through the app a user
 * runs. Tier 1 (`src/host/__tests__/nfx-exit.integration.test.ts`) drove the worker under Node;
 * here everything is the shipping runtime — Electron main and its `nf-media:` proxy, the host
 * utility process, the REAL Bare worker (bare-sidecar) spawning the REAL iroh helper, and the
 * renderer — and the video is nfx's: packaged by `nfx-package`, published and seeded by `nfxd`,
 * reached over iroh only (nfxd speaks no HyperDHT). NEVER part of `npm test` or `test:e2e`:
 *
 *   NUTFLIX_EXIT_RUN=1 NFXD=… NFX_PACKAGE=… IROH_RELAY=… NUTFLIX_IROH_HELPER=… \
 *     xvfb-run -a node --test e2e/nfx-exit-app.e2e.ts
 *
 * (`.github/workflows/nfx-exit.yml`, job `exit-app`.) With `NUTFLIX_EXIT_RUN=1` every missing
 * binary or prerequisite FAILS, never skips.
 *
 * The network, all on 127.0.0.1: the stock iroh-relay (plain HTTP on loopback, which the app's
 * `irohRelays` setting allows), and nfxd's embedded scoped relay (NFX-04: it checks every event).
 * The app's settings are written before it starts: NFX on, that scoped relay and that iroh
 * relay, and ONE read relay that nothing answers (`wss://127.0.0.1:<closed>`), so nothing here
 * depends on public relays: every read relay comes back empty and the NFX catalogue falls back to
 * the scoped relay (`host/catalog/nfx-catalog.ts`), as it does for a video no public relay holds.
 * The viewer finds the video the way a user would: the header search, whose NFX side is a NIP-50
 * search on the scoped relay (nfxd's in-memory store matches `content`), so the manifest carries
 * a unique word in its description.
 *
 * Asserts: Play — free → the `<video>` plays past 3 s with no error and a picture, main's media
 * proxy answered with bytes and holds one link; switching quality opens the other rendition, which
 * plays too, still one link. On failure the window is screenshotted and every process's log kept
 * in `NUTFLIX_EXIT_LOGS` (the workflow uploads it).
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  type WriteStream,
  accessSync,
  constants,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ElectronApplication, Page } from 'playwright-core';

import { PKG, electronBinary, launch, sandboxReady } from './support.ts';

const EXIT = process.env['NUTFLIX_EXIT_RUN'] === '1';
const NS = 'nfx:testnet:1';
/** nfxd resolves its own manifest and starts seeding (a beacon round included). */
const SEED_WITHIN_MS = 180_000;
/**
 * Play opens on a live beacon (NFX-04: never stored), so up to one republish interval (the
 * host waits 62 s), then the worker's helper dials, fetches the hash list, the playlist, the
 * init and the first segment.
 */
const PLAY_WITHIN_MS = 150_000;

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
  ffmpeg: onPath('ffmpeg'),
};

const hex = (n: number): string => randomBytes(n).toString('hex');
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

// ---- processes this suite starts (only these are ever signalled) -----------------------------

interface Proc {
  readonly name: string;
  readonly child: ChildProcess;
  readonly log: WriteStream;
  text: string;
  exit: string | null;
}

const procs: Proc[] = [];
let logDir = '';

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

const tail = (text: string, n = 40): string => text.split('\n').slice(-n).join('\n');

async function waitFor(p: Proc, pattern: RegExp, ms: number, what: string): Promise<string[]> {
  const end = Date.now() + ms;
  for (;;) {
    const m = pattern.exec(p.text);
    if (m !== null) return [...m];
    if (p.exit !== null)
      throw new Error(`${what}: ${p.name} exited (${p.exit}) first; it said:\n${tail(p.text)}`);
    if (Date.now() > end)
      throw new Error(`${what}: not within ${String(ms)} ms; ${p.name} said:\n${tail(p.text)}`);
    await sleep(200);
  }
}

/** A short command, to its end; throws with its output unless it exits 0. */
function mustRun(what: string, file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 300_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`${what}: spawn failed: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${what} exited ${String(code)}:\n${tail(`${out}\n${err}`)}`));
    });
  });
}

async function stopAll(): Promise<void> {
  await Promise.all(
    procs.splice(0).map(async (p) => {
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

// ---- the app's own counters (`--e2e-hooks`: numbers only, never tokens or URLs) -------------

interface E2eHooks {
  mediaLinks(): number;
  mediaStatuses(): Record<number, number>;
}

const mediaLinks = (app: ElectronApplication): Promise<number> =>
  app.evaluate(() =>
    ((globalThis as Record<symbol, unknown>)[Symbol.for('nutflix.e2e')] as E2eHooks).mediaLinks(),
  );
/** Media requests main's proxy answered with bytes (200 or 206). */
const mediaAnswered = (app: ElectronApplication): Promise<number> =>
  app.evaluate(() => {
    const s = (
      (globalThis as Record<symbol, unknown>)[Symbol.for('nutflix.e2e')] as E2eHooks
    ).mediaStatuses();
    return (s[200] ?? 0) + (s[206] ?? 0);
  });

interface VideoState {
  readonly t: number;
  readonly w: number;
  readonly h: number;
  readonly error: number | null;
}

const videoState = (page: Page): Promise<VideoState | null> =>
  page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('.nf-nfxwatch__video');
    return v === null
      ? null
      : { t: v.currentTime, w: v.videoWidth, h: v.videoHeight, error: v.error?.code ?? null };
  });

async function untilVideo(
  page: Page,
  ok: (s: VideoState) => boolean,
  ms: number,
  what: string,
): Promise<VideoState> {
  const end = Date.now() + ms;
  for (;;) {
    const last = await videoState(page);
    if (last !== null && last.error !== null)
      throw new Error(`${what}: the video failed (MediaError ${String(last.error)})`);
    if (last !== null && ok(last)) return last;
    if (Date.now() > end)
      throw new Error(`${what}: not within ${String(ms)} ms (last ${JSON.stringify(last)})`);
    await sleep(250);
  }
}

void describe(
  'slice 5f tier 3: the app plays a free video nfxd seeds, over iroh',
  { skip: EXIT ? false : 'set NUTFLIX_EXIT_RUN=1 (CI: nfx-exit.yml exit-app)' },
  () => {
    let work = '';
    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    const the = (): { readonly app: ElectronApplication; readonly page: Page } => {
      if (app === undefined || page === undefined) throw new Error('the app did not start');
      return { app, page };
    };
    const title = `exit app ${hex(4)}`;
    const word = `nfxexitapp${hex(6)}`;

    /** A screenshot and the app's log tail on failure, then the failure itself. */
    async function evidence<T>(name: string, step: () => Promise<T>): Promise<T> {
      try {
        return await step();
      } catch (e) {
        await page?.screenshot({ path: join(logDir, `${name}.png`) }).catch(() => undefined);
        throw e;
      }
    }

    before(async () => {
      const missing = Object.entries(BIN)
        .filter(([, p]) => p === '' || !existsSync(p))
        .map(([k]) => k);
      assert.deepEqual(missing, [], `tier 3 needs every binary; missing: ${missing.join(', ')}`);
      const sandbox = sandboxReady(electronBinary());
      assert.ok(sandbox.ok, sandbox.why);
      assert.ok(
        existsSync(join(PKG, 'dist', 'main', 'main.js')),
        'run `npm run build` first (dist/main/main.js)',
      );
      work = mkdtempSync(join(tmpdir(), 'nf-exit-app-'));
      logDir = process.env['NUTFLIX_EXIT_LOGS'] ?? join(work, 'logs');
      mkdirSync(logDir, { recursive: true });

      // The network's iroh relay (HTTP on loopback; QUIC address discovery off).
      const q = await freePort();
      const toml = join(work, 'iroh-relay.toml');
      writeFileSync(
        toml,
        `enable_relay = true\nhttp_bind_addr = "127.0.0.1:${String(q)}"\nenable_quic_addr_discovery = false\nenable_metrics = false\n`,
      );
      start('iroh-relay', BIN.irohRelay, ['--config-path', toml]);
      await listening(q, 30_000, 'the iroh relay');
      const irohRelay = `http://127.0.0.1:${String(q)}/`;

      // The network's scoped relay: nfxd's embedded one.
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
      const [, scoped = ''] = await waitFor(
        relay,
        /embedded relay: (ws:\/\/\S+)/,
        60_000,
        'the scoped relay',
      );

      // nfx's side: 20 s of 1280x720 and a tone, packaged by nfx-package, published, seeded.
      const clip = join(work, 'clip.mp4');
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
        '20',
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
      const videoId = `exit-app-${hex(6)}`;
      const pkg = join(work, 'pkg');
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
      const key = join(work, 'creator.key');
      const creator = (await mustRun('nfxd key new', BIN.nfxd, ['key', 'new', key]))
        .split('\n')[0]
        ?.trim();
      assert.match(creator ?? '', /^[0-9a-f]{64}$/);
      const address = (
        await mustRun('nfxd publish', BIN.nfxd, [
          'publish',
          '--key',
          key,
          '--relay',
          scoped,
          '--package',
          pkg,
          '--title',
          title,
          '--description',
          `Tier 3 of the exit run: ${word}.`,
        ])
      ).trim();
      assert.equal(address, `38504:${creator ?? ''}:${NS}:${videoId}`);
      const store = join(work, 'seed-store');
      cpSync(join(pkg, 'store'), store, { recursive: true });
      const seeder = start('nfxd-seed', BIN.nfxd, [
        'run',
        '--key',
        key,
        '--store',
        store,
        '--state',
        join(work, 'seed-state'),
        '--relay',
        scoped,
        '--seed',
        address,
        '--iroh-relay',
        irohRelay,
      ]);
      await waitFor(seeder, new RegExp(`${address}: Seeding`), SEED_WITHIN_MS, 'nfxd seeding');

      // The app's settings (contracts v12), written before it starts: NFX on with this
      // network's relays, and one read relay nothing answers (see the module comment).
      const userData = join(work, 'user-data');
      mkdirSync(userData, { recursive: true });
      const dead = await freePort();
      writeFileSync(
        join(userData, 'settings.json'),
        JSON.stringify({
          v: 1,
          settings: {
            relays: [{ url: `wss://127.0.0.1:${String(dead)}`, read: true, write: true }],
            nfx: {
              enabled: true,
              network: NS,
              scopedRelays: [scoped],
              irohRelays: [irohRelay],
            },
          },
        }),
      );

      const launched = await launch(
        join(PKG, 'dist', 'main', 'main.js'),
        ['--dev-mocks', '--user-data-dir', userData, '--e2e-hooks'],
        {
          // Dev builds take the helper from here (host/flags.ts); the worker spawns it under Bare.
          NUTFLIX_IROH_HELPER: BIN.helper,
          NUTFLIX_E2E_LOG: join(logDir, 'app.log'),
        },
      );
      app = launched.app;
      page = launched.page;
      await launched.page.waitForSelector('.nf-shell', { timeout: 30_000 });
    });

    after(async () => {
      await app?.close().catch(() => undefined);
      await stopAll();
      if (work !== '' && process.env['NUTFLIX_EXIT_LOGS'] !== undefined)
        rmSync(work, { recursive: true, force: true });
    });

    void it('finds nfxd’s video by search and opens its NFX page', async () => {
      const { page } = the();
      await evidence('search', async () => {
        await page.locator('input[aria-label="Search videos"]').fill(word);
        await page.locator('input[aria-label="Search videos"]').press('Enter');
        const card = page.getByText(title, { exact: true }).first();
        await card.waitFor({ timeout: 60_000 });
        await card.click();
        await page.getByRole('button', { name: 'Play — free' }).waitFor({ timeout: 30_000 });
      });
    });

    void it('Play — free: the real Bare worker fetches over iroh and the video plays', async () => {
      const { app, page } = the();
      await evidence('play', async () => {
        await page.getByRole('button', { name: 'Play — free' }).click();
        const s = await untilVideo(
          page,
          (v) => v.t > 3 && v.w > 0,
          PLAY_WITHIN_MS,
          'the video playing past 3 s',
        );
        assert.ok(s.h > 0, 'a picture');
        assert.ok((await mediaAnswered(app)) > 0, 'main proxied bytes');
        assert.equal(await mediaLinks(app), 1);
      });
    });

    void it('switching quality opens the other rendition, which plays too', async () => {
      const { app, page } = the();
      await evidence('quality', async () => {
        const select = page.locator('.nf-nfxwatch__quality select');
        assert.equal(await select.count(), 1, 'nfx-package made more than one rendition');
        const options = await select
          .locator('option')
          .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
        const current = await select.inputValue();
        const other = options.find((v) => v !== current);
        assert.ok(other !== undefined, `another rendition than ${current} (${options.join(', ')})`);
        const before = (await videoState(page))?.h ?? 0;
        await select.selectOption(other);
        const s = await untilVideo(
          page,
          (v) => v.h > 0 && v.h !== before && v.t > 1,
          PLAY_WITHIN_MS,
          `rendition ${other} playing`,
        );
        assert.notEqual(s.h, before);
        // The first session closed: main holds one link, the new one's.
        const end = Date.now() + 15_000;
        while ((await mediaLinks(app)) !== 1 && Date.now() < end) await sleep(250);
        assert.equal(await mediaLinks(app), 1);
      });
    });
  },
);
