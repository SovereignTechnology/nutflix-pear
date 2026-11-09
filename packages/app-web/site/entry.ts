/**
 * The page's script (ADR 0022), bundled to `app.js` by `scripts/build-site.ts`: `startWebClient`
 * over nfx's pinned player library.
 *
 * - **The library** is `nfx/player.js`, byte for byte the file in the tar `nfx-web.lock` pins. The
 *   bundle imports it as a separate module (`nfx-web-lib` is rewritten to `./nfx/player.js`), and
 *   `index.html` preloads it with its SRI hash, so the browser runs no other bytes under that name.
 * - **The WASM** (nfx's verifier) is fetched here with its SRI hash, which the build writes into this
 *   bundle (`__NFX_WASM_INTEGRITY__`), and handed to the library's `init` as a `blob:` URL of the
 *   bytes that matched. The library's own `fetch` cannot carry an integrity check.
 */
import * as nfx from 'nfx-web-lib';
import { startWebClient, type NfxPlayerLib } from '@sovit/app-web';

/** `sha384-…` of `nfx/wasm/nfx_wasm_bg.wasm`, written in by the build. */
declare const __NFX_WASM_INTEGRITY__: string;

const WASM_PATH = 'nfx/wasm/nfx_wasm_bg.wasm';

/** The WASM's bytes, refused by the browser unless they match the build's hash, as a `blob:` URL. */
async function verifiedWasm(): Promise<string> {
  const res = await fetch(new URL(WASM_PATH, document.baseURI).href, {
    integrity: __NFX_WASM_INTEGRITY__,
    credentials: 'same-origin',
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`nfx: the verifier did not load (HTTP ${String(res.status)})`);
  const bytes = await res.arrayBuffer();
  return URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));
}

let ready: Promise<void> | null = null;

/** nfx's library, with `init` loading the verified WASM once (again after a failure). */
const player: NfxPlayerLib = {
  init: () => {
    ready ??= (async (): Promise<void> => {
      const url = await verifiedWasm();
      try {
        await nfx.init({ wasmUrl: url });
      } finally {
        URL.revokeObjectURL(url);
      }
    })().catch((e: unknown) => {
      ready = null;
      throw e;
    });
    return ready;
  },
  open: (el, options) => nfx.open(el, options),
};

const root = document.getElementById('root');
if (root !== null) {
  try {
    startWebClient({ container: root, player });
  } catch (e) {
    root.textContent = `Nutflix could not start: ${e instanceof Error ? e.message : String(e)}`;
  }
}
