#!/usr/bin/env node
/**
 * Component screenshots (execution plan §0 rule 8): one PNG per story per theme into
 * artifacts/screens/components/<Component>--<state>--<theme>.png for `Components/*` stories and
 * artifacts/screens/<screen>/<Screen>--<state>--<theme>.png for `Screens/*` stories (L5).
 *
 *   npm run -w packages/ui screenshots            # storybook build → static server → capture
 *   … screenshots -- --static <dir>               # reuse an existing storybook-static
 *   … screenshots -- --filter videocard           # only stories whose id contains the text
 *   … screenshots -- --themes light               # default: light,dark
 *
 * Uses playwright-core against a LOCAL Chromium (ADR 0005 dependency approval): no browser
 * download, no `--no-sandbox`. The binary is NUTFLIX_CHROMIUM when set, else the newest
 * already-installed `~/.cache/ms-playwright/chromium-*` build. It is always a plain `launch()`
 * with Playwright's own throwaway profile — never a real browser profile.
 *
 * Pruning is per FILE: a PNG is deleted only when no story in the current index produces it, so
 * a `--filter` / `--themes` run never deletes PNGs it did not regenerate. Lazy images get a
 * bounded wait (IMAGE_WAIT_MS per story, then the PNG is taken anyway with a warning).
 */
import { spawnSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const repoRoot = resolve(pkgDir, '..', '..');
const SCREENS_ROOT = join(repoRoot, 'artifacts', 'screens');

/** `Components/VideoCard` → components/; `Screens/Watch` → watch/ (one dir per screen). */
function outDirFor(title: string): string {
  const [group, ...rest] = title.split('/');
  const leaf = (rest[rest.length - 1] ?? group ?? 'misc').toLowerCase();
  return join(SCREENS_ROOT, group?.toLowerCase() === 'screens' ? leaf : 'components');
}
/** Upper bound on waiting for fonts + images per story; a hung lazy image cannot stall the run. */
const IMAGE_WAIT_MS = 10_000;
/** Themes a PNG may carry; used to recognise our own files when pruning. */
const KNOWN_THEMES: readonly string[] = ['light', 'dark'];

/**
 * NUTFLIX_CHROMIUM wins. Otherwise the newest Playwright build already on disk
 * (`~/.cache/ms-playwright/chromium-<revision>/chrome-linux64/chrome`, highest revision first).
 * Nothing is downloaded.
 */
function findChromium(): string {
  const fromEnv = process.env['NUTFLIX_CHROMIUM'];
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!existsSync(fromEnv)) throw new Error(`NUTFLIX_CHROMIUM=${fromEnv} does not exist`);
    return fromEnv;
  }
  const cache = join(homedir(), '.cache', 'ms-playwright');
  const builds = existsSync(cache)
    ? readdirSync(cache)
        .map((d) => /^chromium-(\d+)$/.exec(d))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ rev: Number(m[1]), bin: join(cache, m[0], 'chrome-linux64', 'chrome') }))
        .filter((b) => existsSync(b.bin))
        .sort((a, b) => b.rev - a.rev)
    : [];
  const newest = builds[0];
  if (newest === undefined) {
    throw new Error(
      `no chromium: ${cache} has no chromium-*/chrome-linux64/chrome; set NUTFLIX_CHROMIUM`,
    );
  }
  log(`using ${newest.bin}`);
  return newest.bin;
}

interface StoryEntry {
  readonly type: string;
  readonly id: string;
  readonly name: string;
  readonly title: string;
}

interface Args {
  readonly staticDir: string | undefined;
  readonly filter: string | undefined;
  readonly themes: readonly string[];
}

function parseArgs(argv: readonly string[]): Args {
  let staticDir: string | undefined;
  let filter: string | undefined;
  let themes: readonly string[] = ['light', 'dark'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a ?? ''} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--static') staticDir = resolve(next());
    else if (a === '--filter') filter = next().toLowerCase();
    else if (a === '--themes')
      themes = next()
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    else if (a !== undefined) throw new Error(`unknown argument ${a}`);
  }
  return { staticDir, filter, themes };
}

function log(msg: string): void {
  process.stderr.write(`screenshots: ${msg}\n`);
}

function buildStorybook(): string {
  const out = join(pkgDir, 'storybook-static'); // gitignored
  log('building storybook (storybook build --quiet)…');
  const bin = join(pkgDir, 'node_modules', '.bin', 'storybook');
  const r = spawnSync(bin, ['build', '-o', out, '--quiet'], { cwd: pkgDir, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`storybook build failed (exit ${r.status ?? 'signal'})`);
  return out;
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
};

/** Tiny loopback static server — enough for storybook-static, refuses path escapes. */
function serve(root: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(root, rel));
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      ok({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

function kebab(s: string): string {
  return s
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** Where a story's PNG goes for a theme: `<dir>/<Component>--<state>--<theme>.png`. */
function pngPath(story: StoryEntry, theme: string): string {
  const component = story.title.split('/').pop() ?? story.title;
  const state = kebab(story.id.slice(story.id.lastIndexOf('--') + 2));
  return join(outDirFor(story.title), `${component}--${state}--${theme}.png`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const executablePath = findChromium();

  const staticDir = args.staticDir ?? buildStorybook();
  const indexPath = join(staticDir, 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
    entries: Record<string, StoryEntry>;
  };
  const allStories = Object.values(index.entries).filter((e) => e.type === 'story');
  const stories = allStories
    .filter((e) => (args.filter ? e.id.includes(args.filter) : true))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (stories.length === 0) throw new Error('no stories in index.json');

  const { server, origin } = await serve(staticDir);
  log(
    `serving ${staticDir} at ${origin}; ${stories.length} stories × ${args.themes.length} themes`,
  );

  const browser = await chromium.launch({ executablePath, headless: true });
  const written = new Set<string>();
  const dirs = new Set<string>();
  try {
    for (const theme of args.themes) {
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
        colorScheme: theme === 'dark' ? 'dark' : 'light',
      });
      const p = await ctx.newPage();
      p.on('pageerror', (err) => {
        log(`page error: ${err.message}`);
      });
      for (const story of stories) {
        const target = pngPath(story, theme);
        const file = target.slice(target.lastIndexOf(sep) + 1);
        const url = `${origin}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story&globals=theme:${theme}`;
        await p.goto(url, { waitUntil: 'load' });
        const frame = p.locator('[data-nf-story]').first();
        await frame.waitFor({ state: 'visible', timeout: 15_000 });
        // Freeze motion and let fonts/images settle so PNGs are diffable.
        await p.addStyleTag({
          content:
            '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }',
        });
        // Lazy images below the fold would never load on their own; ask for them now, and
        // never wait longer than IMAGE_WAIT_MS — a stuck image must not hang the run.
        const pending = await p.evaluate(async (limitMs: number): Promise<number> => {
          const imgs = Array.from(document.images);
          for (const img of imgs) if (img.loading === 'lazy') img.loading = 'eager';
          const settled = Promise.all([
            document.fonts.ready,
            ...imgs.map(
              (img) =>
                new Promise<void>((done) => {
                  if (img.complete) {
                    done();
                    return;
                  }
                  img.addEventListener('load', () => {
                    done();
                  });
                  img.addEventListener('error', () => {
                    done();
                  });
                }),
            ),
          ]).then(() => 0);
          const timeout = new Promise<number>((done) => {
            setTimeout(() => {
              done(imgs.filter((img) => !img.complete).length);
            }, limitMs);
          });
          return Promise.race([settled, timeout]);
        }, IMAGE_WAIT_MS);
        if (pending > 0) {
          log(`  warning: ${file}: ${pending} image(s) still loading after ${IMAGE_WAIT_MS} ms`);
        }
        await p.waitForTimeout(120);
        const dir = outDirFor(story.title);
        mkdirSync(dir, { recursive: true });
        dirs.add(dir);
        await frame.screenshot({ path: target, type: 'png' });
        written.add(target);
        log(`  ${file}`);
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  // Prune per FILE: delete a PNG (our own `A--b--<theme>.png` naming, only in directories this
  // run wrote to) only when NO story in the whole index produces it for any theme — i.e. its
  // story was renamed or removed. PNGs of stories a `--filter` or `--themes` run skipped stay.
  const expected = new Set<string>();
  for (const story of allStories) {
    for (const theme of new Set([...KNOWN_THEMES, ...args.themes])) {
      expected.add(pngPath(story, theme));
    }
  }
  let pruned = 0;
  for (const dir of dirs) {
    for (const f of readdirSync(dir)) {
      const path = join(dir, f);
      if (f.endsWith('.png') && f.includes('--') && !expected.has(path)) {
        unlinkSync(path);
        pruned += 1;
      }
    }
  }
  log(
    `wrote ${written.size} PNGs under ${SCREENS_ROOT} (${[...dirs].map((d) => d.slice(SCREENS_ROOT.length + 1)).join(', ')})${pruned > 0 ? ` (pruned ${pruned} stale)` : ''}`,
  );
  process.stdout.write(`${written.size}\n`);
}

main().catch((err: unknown) => {
  log(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
