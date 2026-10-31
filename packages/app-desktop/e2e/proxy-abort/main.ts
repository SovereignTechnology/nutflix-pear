/**
 * proxy-abort — Electron main (bundled to `main.mjs` by `e2e/proxy-abort.e2e.ts`; ESM, `electron`
 * external). The app's own `nf-media:` handler (`src/main/media.ts`), schemes and CSP, with
 * `net.fetch` injected exactly as `main.ts` injects it, in front of the test's loopback server.
 * The test registers links through `__proxyAbort.link` (`app.evaluate`) and drives the `<video>`
 * elements of a sandboxed window.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, net, protocol } from 'electron';

import { APP_RESPONSE_HEADERS } from '../../src/main/csp.ts';
import { ImageRequests, MediaLinks, createMediaProtocolHandler } from '../../src/main/media.ts';
import { APP_SCHEME, APP_URL, MEDIA_SCHEME, privilegedSchemes } from '../../src/main/schemes.ts';

const here = dirname(fileURLToPath(import.meta.url));
const links = new MediaLinks();
/** For the test: register a link, and count the requests whose `signal` Electron aborted. */
const hooks = {
  link: (token: string, url: string): boolean => links.set(token, url),
  aborted: 0,
};
(globalThis as Record<string, unknown>)['__proxyAbort'] = hooks;

protocol.registerSchemesAsPrivileged(privilegedSchemes());

void app.whenReady().then(async () => {
  const media = createMediaProtocolHandler({
    links,
    images: new ImageRequests(() => false),
    fetch: (url, init) => net.fetch(url, { ...init, headers: { ...init.headers } }),
  });
  protocol.handle(APP_SCHEME, async (req) => {
    if (new URL(req.url).pathname !== '/index.html') return new Response(null, { status: 404 });
    return new Response(await readFile(join(here, 'index.html')), {
      headers: { ...APP_RESPONSE_HEADERS, 'content-type': 'text/html' },
    });
  });
  protocol.handle(MEDIA_SCHEME, (req) => {
    // Observation only: whether Electron aborts a request's signal when the page drops it.
    req.signal.addEventListener(
      'abort',
      () => {
        hooks.aborted += 1;
      },
      { once: true },
    );
    return media(req);
  });
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  await win.loadURL(APP_URL);
});
