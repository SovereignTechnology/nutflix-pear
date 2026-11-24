/**
 * Stage 1 exit — Electron end to end (design §5b). NEVER part of `npm test`.
 *
 *   NUTFLIX_E2E=1 node --test packages/app-desktop/e2e/stage1.e2e.ts
 *
 * Needs D4 (Cameron's AppArmor `userns` profile: run with NUTFLIX_E2E_APPARMOR_PROFILE=1), an
 * X11 display (support.ts `displayStrategies`), `npm run build` and the system ffmpeg — see
 * docs/development.md "Running the Electron end-to-end suites". Prerequisites are checked first and
 * reported, never worked around.
 *
 * Launches `dist/main/main.js --dev-mocks --dev-fixtures --user-data-dir <tmp> --e2e-hooks`
 * with two lavfi fixture MP4s and asserts: the security posture (webPreferences, no
 * `--no-sandbox`, no Node in the page, the `window.nutflix` key allowlist, no CSP violation, a
 * `_blank` link opens nothing); price shown → Play; `currentTime > 1`, `videoWidth > 0`; a seek
 * answered 206 through `nf-media:`; the WalletChip rate > 0; stats for nerds names a seeder, its
 * loopback address only behind the switch (`checkNerdStats`); Watch → Home mini-player;
 * Watch → Watch leaves exactly one open session (main's media-link count is 1).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ElectronApplication, Page } from 'playwright-core';
import {
  E2E,
  FIXTURE,
  KEY_TREE_SOURCE,
  PKG,
  checkNerdStats,
  electronBinary,
  hasFfmpeg,
  launch,
  makeFixtureMp4,
  sandboxReady,
} from './support.ts';

/**
 * The dev-fixture seam (design §5a `host/catalog/fixture-catalog.ts` + worker
 * `dev/fixtures-net.ts`, as merged): with `--dev-fixtures`, the worker publishes each entry as a
 * playable video served by its in-process seeders S1 (first half) + S2 (second half).
 */
const FIXTURE_ENV = 'NUTFLIX_DEV_FIXTURES_JSON';
const A = { title: 'E2E fixture A', description: 'See [the docs](https://example.com/docs).' };
const B = { title: 'E2E fixture B', description: 'The second fixture.' };

/**
 * Where the seek lands: past the gate's lookahead from `bytes=0-` (the default 30 s prefetch
 * window plus the paced allowance, L6-C deviation 1) and past Chromium's own read-ahead, so the
 * seek needs a NEW Range request answered 206 — and early enough that the video is still
 * playing through the mini-player steps that follow.
 */
const SEEK_TO = Math.round(FIXTURE.seconds * 0.55);

interface E2eHooks {
  mediaLinks(): number;
  mediaStatuses(): Record<number, number>;
  mediaRangeStarts(): number[];
  hostRunning(): boolean;
  externalOpens(): number;
}

/** Main-process counters behind `--e2e-hooks` (numbers only, never tokens or URLs). */
const mediaLinks = (app: ElectronApplication): Promise<number> =>
  app.evaluate(() =>
    ((globalThis as Record<symbol, unknown>)[Symbol.for('nutflix.e2e')] as E2eHooks).mediaLinks(),
  );
const media206 = (app: ElectronApplication): Promise<number> =>
  app.evaluate(
    () =>
      (
        (globalThis as Record<symbol, unknown>)[Symbol.for('nutflix.e2e')] as E2eHooks
      ).mediaStatuses()[206] ?? 0,
  );
const rangeStarts = (app: ElectronApplication): Promise<number[]> =>
  app.evaluate(() =>
    (
      (globalThis as Record<symbol, unknown>)[Symbol.for('nutflix.e2e')] as E2eHooks
    ).mediaRangeStarts(),
  );
const externalOpens = (app: ElectronApplication): Promise<number> =>
  app.evaluate(() =>
    (
      (globalThis as Record<symbol, unknown>)[Symbol.for('nutflix.e2e')] as E2eHooks
    ).externalOpens(),
  );
const hostRunning = (app: ElectronApplication): Promise<boolean> =>
  app.evaluate(() =>
    ((globalThis as Record<symbol, unknown>)[Symbol.for('nutflix.e2e')] as E2eHooks).hostRunning(),
  );

async function waitFor(what: string, fn: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out after ${String(ms)} ms waiting for: ${what}`);
}

void describe(
  'Stage 1 exit (§5b)',
  { skip: E2E ? false : 'set NUTFLIX_E2E=1 to run (Electron, D4)' },
  () => {
    let dir = '';
    let app: ElectronApplication;
    let page: Page;
    /** Bytes per second of fixture A (it is CBR): where a seek's Range must start. */
    let bytesPerSecA = 0;
    const cspViolations: string[] = [];

    before(async () => {
      const binary = electronBinary();
      const sandbox = sandboxReady(binary);
      assert.ok(sandbox.ok, sandbox.why);
      assert.ok(hasFfmpeg(), 'system ffmpeg is required to make the fixture MP4s');
      dir = mkdtempSync(join(tmpdir(), 'nf-e2e-'));
      makeFixtureMp4(join(dir, 'a.mp4'), 'testsrc');
      makeFixtureMp4(join(dir, 'b.mp4'), 'testsrc2');
      bytesPerSecA = statSync(join(dir, 'a.mp4')).size / FIXTURE.seconds;
      const fixtures = [
        { path: join(dir, 'a.mp4'), ...A },
        { path: join(dir, 'b.mp4'), ...B },
      ];
      const launched = await launch(
        join(PKG, 'dist', 'main', 'main.js'),
        ['--dev-mocks', '--dev-fixtures', '--user-data-dir', join(dir, 'user-data'), '--e2e-hooks'],
        { [FIXTURE_ENV]: JSON.stringify(fixtures) },
      );
      app = launched.app;
      page = launched.page;
      page.on('console', (m) => {
        if (/Content[- ]Security[- ]Policy/i.test(m.text())) cspViolations.push(m.text());
      });
      await page.waitForSelector('.nf-shell', { timeout: 30_000 });
    });

    after(async () => {
      await app.close().catch(() => undefined);
      if (dir !== '') rmSync(dir, { recursive: true, force: true });
    });

    void it('webPreferences are the literal posture, and there is no --no-sandbox', async () => {
      // `getLastWebPreferences` is not in Electron 44's typings but is still on webContents at
      // runtime (Electron's own specs use it); reached through a structural cast.
      const wp = await app.evaluate(({ BrowserWindow }) => {
        const wc = BrowserWindow.getAllWindows()[0]?.webContents as unknown as
          { getLastWebPreferences?: () => Record<string, unknown> | null } | undefined;
        return wc?.getLastWebPreferences?.() ?? null;
      });
      assert.ok(wp !== null, 'webContents.getLastWebPreferences() is available');
      assert.equal(wp['contextIsolation'], true);
      assert.equal(wp['sandbox'], true);
      assert.equal(wp['nodeIntegration'], false);
      assert.notEqual(wp['webSecurity'], false);
      assert.notEqual(wp['webviewTag'], true);
      assert.equal(
        await app.evaluate(({ app: a }) => a.commandLine.hasSwitch('no-sandbox')),
        false,
      );
      assert.equal(await hostRunning(app), true);
    });

    void it('the page has no Node and exactly the allowlisted bridge', async () => {
      const globals = await page.evaluate(() => {
        const g = globalThis as Record<string, unknown>;
        return [typeof g['require'], typeof g['process'], typeof g['module'], typeof g['Buffer']];
      });
      assert.deepEqual(globals, ['undefined', 'undefined', 'undefined', 'undefined']);
      const ipcPath = join(PKG, 'dist', 'ipc', 'index.js');
      const ipc = (await import(ipcPath)) as {
        METHODS: readonly string[];
        EXCLUDED_METHODS: Record<string, string>;
        TOPIC_METHODS: Record<string, string>;
        SHELL_TOPIC_METHODS: Record<string, string>;
      };
      const expected = new Set<string>(['platform']);
      for (const m of [
        ...ipc.METHODS.filter((x) => !x.startsWith('session.')),
        ...Object.keys(ipc.EXCLUDED_METHODS),
        ...Object.keys(ipc.TOPIC_METHODS),
        ...Object.keys(ipc.SHELL_TOPIC_METHODS),
      ]) {
        // Every dotted prefix is an object key too (`desktop`, `desktop.signer`, …).
        const parts = m.split('.');
        for (let i = 1; i <= parts.length; i++) expected.add(parts.slice(0, i).join('.'));
      }
      const tree: string[] = await page.evaluate(KEY_TREE_SOURCE);
      assert.deepEqual(tree, [...expected].sort());
    });

    void it('price shown → Play; the video plays; a seek is a 206 through nf-media:', async () => {
      await page.getByText(A.title, { exact: true }).first().click();
      const play = page.locator('button[aria-label^="Play — costs"]');
      await play.waitFor({ timeout: 20_000 });
      const priceFirst = await page.evaluate(() => {
        const badge = document.querySelector('.nf-watch .nf-sats');
        const btn = document.querySelector('button[aria-label^="Play — costs"]');
        return (
          badge !== null &&
          btn !== null &&
          (badge.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        );
      });
      assert.ok(priceFirst, 'the price is shown before the play affordance');
      await play.click();
      await page.waitForFunction(
        () => {
          const v = document.querySelector<HTMLVideoElement>('.nf-watch video');
          return v !== null && v.currentTime > 1 && v.videoWidth > 0;
        },
        undefined,
        { timeout: 30_000 },
      );
      const before206 = await media206(app);
      const beforeRanges = (await rangeStarts(app)).length;
      await page.evaluate((t) => {
        const v = document.querySelector<HTMLVideoElement>('.nf-watch video');
        if (v) v.currentTime = t;
      }, SEEK_TO);
      await page.waitForFunction(
        (t) => (document.querySelector<HTMLVideoElement>('.nf-watch video')?.currentTime ?? 0) >= t,
        SEEK_TO,
        { timeout: 30_000 },
      );
      await waitFor('a 206 after the seek', async () => (await media206(app)) > before206);
      // …and it is the SEEK's: a new Range starting near SEEK_TO (keyframes every 2 s; Chromium
      // also re-requests near the start on its own, which must not satisfy this).
      const from = Math.floor((SEEK_TO - 4) * bytesPerSecA);
      await waitFor(`a 206 Range starting at ≥ ${String(from)} after the seek`, async () =>
        (await rangeStarts(app)).slice(beforeRanges).some((s) => s >= from),
      );
    });

    void it('the WalletChip shows a streaming rate > 0', async () => {
      await waitFor('a sats/min rate in the header', async () => {
        const t = await page.locator('.nf-shell__header-end').innerText();
        const m = /([\d,]+)\s*sats\/min/.exec(t);
        return m !== null && Number((m[1] ?? '0').replace(/,/g, '')) > 0;
      });
    });

    // Security review F25: a Markdown _blank link opens nothing by itself — main asks in its
    // trusted prompt window, which shows the link's real host; Cancel leaves everything as it was.
    void it('stats for nerds names a seeder, its address only behind the switch', async () => {
      await checkNerdStats(page, {
        video: '.nf-watch video',
        kind: 'hypercore',
        route: (address, path) => /^127\.0\.0\.1:\d+$/.test(address) && path.startsWith('direct'),
      });
    });

    void it('a Markdown _blank link opens nothing by itself: main asks, showing the real host', async () => {
      // Fixture A's description carries the link; Watch renders it through `Markdown` as
      // `<a target="_blank">`. It must exist — a missing link would make this pass vacuously.
      const link = page.locator('.nf-watch a[href^="https://example.com"][target="_blank"]');
      assert.equal(await link.count(), 1, 'the Markdown link is rendered');
      const asked = app.waitForEvent('window', { timeout: 20_000 });
      await link.first().click({ modifiers: [] });
      const prompt = await asked;
      await prompt.waitForSelector('form', { timeout: 20_000 });
      assert.equal(prompt.url(), 'app://prompt/prompt.html');
      assert.equal(await prompt.locator('.host code').textContent(), 'example.com');
      await prompt.keyboard.press('Escape').catch(() => undefined);
      await waitFor('the prompt window closing', () => Promise.resolve(app.windows().length === 1));
      assert.equal(await externalOpens(app), 0);
      assert.equal(await page.evaluate(() => location.href), 'app://nutflix/index.html');
    });

    void it('Watch → Home: the mini-player keeps playing the one session', async () => {
      await page.locator('.nf-shell__brand').click();
      await page.locator('aside[aria-label="Mini-player"] video').waitFor({ timeout: 10_000 });
      const t0 = await page.evaluate(
        () => document.querySelector<HTMLVideoElement>('.nf-shell__mini video')?.currentTime ?? 0,
      );
      await waitFor(
        'the mini-player advancing',
        async () =>
          (await page.evaluate(
            () =>
              document.querySelector<HTMLVideoElement>('.nf-shell__mini video')?.currentTime ?? 0,
          )) > t0,
      );
      assert.equal(await mediaLinks(app), 1);
    });

    void it('Watch → Watch leaves exactly one open session', async () => {
      await page.locator('aside[aria-label="Mini-player"] button[aria-label="Expand"]').click();
      await page.locator('.nf-watch').waitFor();
      await page.getByText(B.title, { exact: true }).first().click();
      await page.locator('button[aria-label^="Play — costs"]').click();
      await page.waitForFunction(
        () => (document.querySelector<HTMLVideoElement>('.nf-watch video')?.currentTime ?? 0) > 1,
        undefined,
        {
          timeout: 30_000,
        },
      );
      await waitFor('exactly one media link', async () => (await mediaLinks(app)) === 1);
      assert.equal(await page.locator('aside[aria-label="Mini-player"]').count(), 0);
    });

    void it('no CSP violation was reported', () => {
      assert.deepEqual(cspViolations, []);
    });
  },
);
