/**
 * Spike S-E — Electron main (bundled to `main.mjs` by `e2e/nfx-playback.e2e.ts`; ESM,
 * `electron` external). The real shell's playback path and nothing else: privileged `app:` and
 * `nf-media:` schemes, the CSP as a response header, `protocol.handle('nf-media')` proxying a
 * single Range through `net.fetch` to a loopback server (the test's, as the worker's blob server
 * is the real one's), and a sandboxed window with one `<video>`. The test drives the element.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, net, protocol } from 'electron';

const here = dirname(fileURLToPath(import.meta.url));
/** Each layout's upstream (the test's servers, one per layout so their pools are separate). */
const bases = JSON.parse(process.env['NUTFLIX_NFX_PLAYBACK_BASES'] ?? '{}') as Record<
  string,
  string
>;
// The app's CSP (main/csp.ts, pinned by app-protocol.test.ts), as fidelity/main.ts copies it.
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' nf-media: data:; media-src nf-media:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'";

/** Every nf-media request and what came of it, for the test to read (`app.evaluate`). */
const proxied: { url: string; range: string | null; status: number | string }[] = [];
(globalThis as Record<string, unknown>)['__nfxProxied'] = proxied;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, stream: true } },
  { scheme: 'nf-media', privileges: { standard: true, secure: true, stream: true } },
]);

void app.whenReady().then(async () => {
  protocol.handle('app', async (req) => {
    if (new URL(req.url).pathname !== '/index.html') return new Response(null, { status: 404 });
    return new Response(await readFile(join(here, 'index.html')), {
      headers: { 'content-type': 'text/html', 'content-security-policy': CSP },
    });
  });
  protocol.handle('nf-media', async (req) => {
    // As main/media.ts: `nf-media://play/<id>` only, one Range header passed on, nothing else.
    const m = /^nf-media:\/\/play\/([A-Za-z0-9_-]{1,32})$/.exec(req.url);
    const range = req.headers.get('range');
    const base = m === null ? undefined : bases[m[1] ?? ''];
    if (m === null || base === undefined) {
      proxied.push({ url: req.url, range, status: m === null ? 'no match' : 'no base' });
      return new Response(null, { status: 404 });
    }
    const headers: Record<string, string> = {};
    if (range !== null) headers['range'] = range;
    let up: Response;
    try {
      up = await net.fetch(`${base}/${m[1] ?? ''}`, { headers, redirect: 'error' });
    } catch (e: unknown) {
      proxied.push({
        url: req.url,
        range,
        status: `fetch: ${e instanceof Error ? e.message : String(e)}`,
      });
      return new Response(null, { status: 502 });
    }
    proxied.push({ url: req.url, range, status: up.status });
    const out = new Headers({ 'content-type': 'video/mp4', 'accept-ranges': 'bytes' });
    for (const h of ['content-length', 'content-range']) {
      const v = up.headers.get(h);
      if (v !== null) out.set(h, v);
    }
    return new Response(up.body, { status: up.status, headers: out });
  });
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  await win.loadURL('app://nfx/index.html');
});
