/**
 * The `nf-media:` proxy lets go of what the player lets go of. NEVER part of `npm test`; CI runs
 * it in the e2e job:
 *
 *   NUTFLIX_E2E=1 node --test packages/app-desktop/e2e/proxy-abort.e2e.ts
 *
 * The app's own handler (`src/main/media.ts`, bundled by `proxy-abort/main.ts`) in front of a
 * loopback server that answers every request with 206 headers and then no bytes, so each
 * `<video>` holds its request open, as a player that has stopped reading does. Main's
 * `net.fetch` pools at most 6 connections per host:port; spike S-E (finding 6) saw requests
 * outlive the page that made them and starve the next source. Here, after a reload drops every
 * element, each upstream request must close, and a new source on the same server must reach it.
 * The findings print as JSON.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { build } from 'esbuild';
import type { ElectronApplication, Page } from 'playwright-core';

import { E2E, PKG, electronBinary, launch, sandboxReady } from './support.ts';

/** What the upstream claims to hold: large enough that no element ever has it all. */
const SIZE = 64 * 1024 * 1024;
/** Elements holding a request open: more than the pool's 6. */
const HELD = 8;
/** How soon after the reload the upstream must see each request close, and a new one arrive. */
const PROMPT_MS = 5_000;
const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>proxy abort</title></head>
<body><div id="box"></div></body></html>`;

const step = (what: string): void => {
  process.stdout.write(`proxy-abort: ${what}\n`);
};
/** No await in this suite may outlast a bound. */
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, no) =>
      setTimeout(() => {
        no(new Error(`timed out after ${String(ms)} ms: ${what}`));
      }, ms),
    ),
  ]);
/** Polls `test` every 100 ms until it holds (the ms it took) or `ms` pass (null). */
async function until(test: () => boolean, ms: number): Promise<number | null> {
  const t0 = Date.now();
  for (;;) {
    if (test()) return Date.now() - t0;
    if (Date.now() - t0 >= ms) return null;
    await new Promise((ok) => setTimeout(ok, 100));
  }
}

interface Upstream {
  readonly token: string;
  readonly at: number;
  closedAt: number | null;
}

void describe(
  'nf-media proxy: a request the player drops lets go of its upstream',
  { skip: E2E ? false : 'set NUTFLIX_E2E=1 to run (Electron)' },
  () => {
    let dir = '';
    let app: ElectronApplication | undefined;
    let page: Page;
    let base = '';
    const upstream: Upstream[] = [];
    const server = createServer((req, res) => {
      const rec: Upstream = {
        token: /^\/([A-Za-z0-9_-]{1,32})$/.exec(req.url ?? '')?.[1] ?? '?',
        at: Date.now(),
        closedAt: null,
      };
      upstream.push(rec);
      // The response never ends, so this is the connection closing under it.
      res.on('close', () => {
        rec.closedAt = Date.now();
      });
      const range = req.headers.range;
      const start = Number(/^bytes=(\d{1,15})-/.exec(range ?? '')?.[1] ?? '0');
      if (start >= SIZE) {
        res.writeHead(416, { 'content-range': `bytes */${String(SIZE)}` }).end();
        return;
      }
      res.writeHead(range === undefined ? 200 : 206, {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        'content-length': String(SIZE - start),
        ...(range === undefined
          ? {}
          : { 'content-range': `bytes ${String(start)}-${String(SIZE - 1)}/${String(SIZE)}` }),
      });
      res.flushHeaders();
      // And no body, ever.
    });

    const link = (token: string): Promise<boolean> =>
      app === undefined
        ? Promise.resolve(false)
        : app.evaluate(
            (_e, a: { token: string; url: string }) =>
              (
                globalThis as unknown as {
                  __proxyAbort: { link: (t: string, u: string) => boolean };
                }
              ).__proxyAbort.link(a.token, a.url),
            { token, url: `${base}/${token}` },
          );
    const hold = (tokens: string[]): Promise<void> =>
      page.evaluate((ts: string[]) => {
        for (const t of ts) {
          const v = document.createElement('video');
          v.muted = true;
          v.preload = 'auto';
          v.src = `nf-media://play/${t}`;
          document.getElementById('box')?.append(v);
        }
      }, tokens);

    before(
      async () => {
        const sandbox = sandboxReady(electronBinary());
        assert.ok(sandbox.ok, sandbox.why);
        dir = mkdtempSync(join(tmpdir(), 'nf-proxy-abort-'));
        await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
        base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
        await build({
          bundle: true,
          absWorkingDir: PKG,
          logLevel: 'warning',
          target: 'chrome152',
          entryPoints: [join(PKG, 'e2e', 'proxy-abort', 'main.ts')],
          outfile: join(dir, 'main.mjs'),
          format: 'esm',
          platform: 'node',
          external: ['electron'],
        });
        writeFileSync(join(dir, 'index.html'), HTML);
        const launched = await within(launch(join(dir, 'main.mjs'), []), 120_000, 'launch');
        app = launched.app;
        page = launched.page;
        await page.waitForSelector('#box', { state: 'attached', timeout: 20_000 });
        step(`Electron up, upstream ${base}`);
      },
      { timeout: 5 * 60_000 },
    );

    after(async () => {
      if (app !== undefined)
        await within(app.close(), 20_000, 'Electron close').catch(() => undefined);
      server.closeAllConnections();
      server.close();
      if (dir !== '') rmSync(dir, { recursive: true, force: true });
    });

    void it(
      'after a reload every held upstream request closes, and a new source gets through',
      { timeout: 2 * 60_000 },
      async () => {
        const held = Array.from({ length: HELD }, (_x, i) => `held-${String(i)}`);
        for (const t of [...held, 'fresh']) assert.ok(await link(t), `link ${t}`);

        await hold(held);
        const reachedMs = await until(() => upstream.length >= 6, 20_000);
        // Time for a 7th and 8th to arrive, if the pool lets them.
        await new Promise((ok) => setTimeout(ok, 1_000));
        const reached = upstream.length;
        step(`${String(reached)} of ${String(HELD)} held requests reached the upstream`);

        const reloadAt = Date.now();
        await within(page.reload(), 30_000, 'reload');
        await page.waitForSelector('#box', { state: 'attached', timeout: 20_000 });
        const old = (): Upstream[] => upstream.filter((u) => u.token !== 'fresh');
        const closedMs = await until(() => old().every((u) => u.closedAt !== null), PROMPT_MS);

        await hold(['fresh']);
        const freshMs = await until(() => upstream.some((u) => u.token === 'fresh'), PROMPT_MS);

        const findings = {
          electron: await app?.evaluate(() => process.versions.electron),
          reached,
          reachedMs,
          closedMs,
          closedAfterReloadMs: old().map((u) =>
            u.closedAt === null ? null : u.closedAt - reloadAt,
          ),
          arrivedAfterReload: old().filter((u) => u.at > reloadAt).length,
          stillOpen: old().filter((u) => u.closedAt === null).length,
          freshMs,
          signalsAborted: await app?.evaluate(
            () =>
              (globalThis as unknown as { __proxyAbort: { aborted: number } }).__proxyAbort.aborted,
          ),
        };
        process.stdout.write(`\nPROXY-ABORT FINDINGS ${JSON.stringify(findings)}\n`);

        assert.ok(reached > 0, 'no held request reached the upstream');
        assert.notEqual(
          closedMs,
          null,
          `held upstream requests still open ${String(PROMPT_MS)} ms after the reload`,
        );
        assert.notEqual(
          freshMs,
          null,
          `a new source did not reach the upstream within ${String(PROMPT_MS)} ms`,
        );
        assert.equal(findings.stillOpen, 0, 'an upstream request from the old page is still open');
      },
    );
  },
);
