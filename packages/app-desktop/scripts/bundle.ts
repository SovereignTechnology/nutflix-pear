/**
 * Bundles the two browser-side parts of the desktop shell (design §4 "Bundling") after `tsc -b`
 * has type-checked them:
 *
 *   src/renderer/main.tsx  → dist/renderer/app.js   ESM, browser, minified, production React
 *   src/preload/preload.ts → dist/preload.cjs       CJS (a sandboxed preload cannot load ESM or
 *                                                   workspace modules), `electron` external
 *   static/index.html      → dist/renderer/index.html
 *   @sovit/ui/ui.css       → dist/renderer/ui.css    copied, linked with <link rel=stylesheet>
 *   @sovit/ui/shell.css    → dist/renderer/shell.css (nothing is injected: CSP style-src 'self';
 *                                                   the shell moved into @sovit/ui, ADR 0022)
 *
 * Those four files are exactly `APP_FILES` in src/main/app-protocol.ts — all the `app:`
 * protocol serves at `app://nutflix`. ADR 0013 adds main's trusted prompt window, served at its
 * own origin `app://prompt` from its own directory (`PROMPT_FILES`):
 *
 *   src/renderer/prompt/prompt.ts  → dist/prompt/prompt.js     ESM, plain DOM; imports only
 *                                   `@scure/bip39` (ADR 0016: its English wordlist and checksum
 *                                   check, with the audited `@noble/hashes` / `@scure/base` they
 *                                   need), bundled in — no new file at runtime
 *   static/prompt.html             → dist/prompt/prompt.html
 *   src/renderer/prompt/prompt.css → dist/prompt/prompt.css
 *   src/preload/prompt-preload.ts  → dist/prompt-preload.cjs   CJS, only itself + src/ipc
 * The build fails if the renderer bundle pulled in `@sovit/core` runtime code
 * (nostr-tools, cashu-ts), Electron or a Node builtin, if the preload bundle contains
 * anything but src/preload + src/ipc, or if the prompt page contains anything but its own
 * directory and the npm files `packaging/prompt-npm.ts` allows.
 *
 * Usage (from packages/app-desktop): `node scripts/bundle.ts [--out <dir>]` — requires `tsc -b`
 * and `@sovit/ui`'s `build:css` first (the root `npm run build` does both). `--out` (default
 * `dist`) exists for the test that bundles into a temp directory.
 */
import { build, type Metafile } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROMPT_NPM, isPromptNpmInput } from '../packaging/prompt-npm.ts';

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
/** The repo root: npm workspaces install into its node_modules (or into this package's). */
const repo = resolve(pkg, '..', '..');
const outFlag = process.argv.indexOf('--out');
const outArg = outFlag === -1 ? undefined : process.argv[outFlag + 1];
const dist = outArg === undefined ? join(pkg, 'dist') : resolve(outArg);
const rendererOut = join(dist, 'renderer');
const promptOut = join(dist, 'prompt');
/** Electron 44.2.0 ships Chromium 152. */
const TARGET = 'chrome152';

/** The bundle's inputs as absolute paths (metafile paths are relative to `absWorkingDir`). */
function inputsOf(meta: Metafile): string[] {
  return Object.keys(meta.inputs).map((p) => (p.includes(':') ? p : resolve(pkg, p)));
}

function fail(msg: string): never {
  process.stderr.write(`bundle: ${msg}\n`);
  process.exit(1);
}

async function bundleRenderer(): Promise<void> {
  const r = await build({
    absWorkingDir: pkg,
    entryPoints: ['src/renderer/main.tsx'],
    outfile: join(rendererOut, 'app.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: TARGET,
    minify: true,
    sourcemap: false,
    jsx: 'automatic',
    tsconfig: 'tsconfig.renderer.json',
    define: { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'eof',
    metafile: true,
    logLevel: 'warning',
  });
  const core = resolve(pkg, '..', 'core') + sep;
  const bad = inputsOf(r.metafile).filter(
    (p) =>
      p.startsWith(core) ||
      /[\\/]node_modules[\\/](nostr-tools|@cashu|electron|@noble|@scure)[\\/]/.test(p) ||
      p.startsWith('node:'),
  );
  if (bad.length > 0) fail(`renderer bundle must not contain:\n  ${bad.join('\n  ')}`);
}

async function bundlePreload(): Promise<void> {
  const r = await build({
    absWorkingDir: pkg,
    entryPoints: ['src/preload/preload.ts'],
    outfile: join(dist, 'preload.cjs'),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: TARGET,
    external: ['electron'],
    minify: false,
    sourcemap: false,
    tsconfig: 'tsconfig.preload.json',
    metafile: true,
    logLevel: 'warning',
  });
  const allowed = [join(pkg, 'src', 'preload') + sep, join(pkg, 'src', 'ipc') + sep];
  const bad = inputsOf(r.metafile).filter((p) => !allowed.some((a) => p.startsWith(a)));
  if (bad.length > 0)
    fail(`preload bundle may only contain src/preload and src/ipc:\n  ${bad.join('\n  ')}`);
}

/**
 * ADR 0013: the prompt page may contain nothing but itself (no UI kit, no core, no ipc code) —
 * and, since ADR 0016, the files of `PROMPT_NPM` (the BIP-39 library and the two audited
 * packages it is built on), installed under this package's or the repo's node_modules with
 * nothing but those packages on the way (round 8: `isPromptNpmInput`, not a name anywhere in
 * the path).
 */
async function bundlePrompt(): Promise<void> {
  const r = await build({
    absWorkingDir: pkg,
    entryPoints: ['src/renderer/prompt/prompt.ts'],
    outfile: join(promptOut, 'prompt.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: TARGET,
    minify: true,
    sourcemap: false,
    tsconfig: 'tsconfig.renderer.json',
    legalComments: 'eof',
    metafile: true,
    logLevel: 'warning',
  });
  const own = join(pkg, 'src', 'renderer', 'prompt') + sep;
  const inputs = inputsOf(r.metafile);
  const bad = inputs.filter((p) => !p.startsWith(own) && !isPromptNpmInput(p, [pkg, repo]));
  if (bad.length > 0)
    fail(
      `prompt bundle may only contain src/renderer/prompt and ${PROMPT_NPM.join(', ')}:\n  ${bad.join('\n  ')}`,
    );
  // One wordlist only: the English one the host's phrases index into.
  const lists = inputs.filter((p) => /[\\/]@scure[\\/]bip39[\\/]wordlists[\\/]/.test(p));
  if (lists.length !== 1 || !/[\\/]english\.js$/.test(lists[0] ?? ''))
    fail(`prompt bundle must carry exactly the English wordlist:\n  ${lists.join('\n  ')}`);
}

async function bundlePromptPreload(): Promise<void> {
  const r = await build({
    absWorkingDir: pkg,
    entryPoints: ['src/preload/prompt-preload.ts'],
    outfile: join(dist, 'prompt-preload.cjs'),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: TARGET,
    external: ['electron'],
    minify: false,
    sourcemap: false,
    tsconfig: 'tsconfig.preload.json',
    metafile: true,
    logLevel: 'warning',
  });
  const self = join(pkg, 'src', 'preload', 'prompt-preload.ts');
  const ipc = join(pkg, 'src', 'ipc') + sep;
  const bad = inputsOf(r.metafile).filter((p) => p !== self && !p.startsWith(ipc));
  if (bad.length > 0)
    fail(`prompt preload may only contain itself and src/ipc:\n  ${bad.join('\n  ')}`);
}

async function copyStatic(): Promise<void> {
  const require = createRequire(import.meta.url);
  let uiCss: string;
  let shellCss: string;
  try {
    uiCss = require.resolve('@sovit/ui/ui.css');
    shellCss = require.resolve('@sovit/ui/shell.css');
  } catch {
    fail('@sovit/ui/ui.css or shell.css not found — run `npm run -w packages/ui build:css` first');
  }
  await mkdir(rendererOut, { recursive: true });
  await copyFile(join(pkg, 'static', 'index.html'), join(rendererOut, 'index.html'));
  await copyFile(uiCss, join(rendererOut, 'ui.css'));
  await copyFile(shellCss, join(rendererOut, 'shell.css'));
  await mkdir(promptOut, { recursive: true });
  await copyFile(join(pkg, 'static', 'prompt.html'), join(promptOut, 'prompt.html'));
  await copyFile(
    join(pkg, 'src', 'renderer', 'prompt', 'prompt.css'),
    join(promptOut, 'prompt.css'),
  );
}

await mkdir(rendererOut, { recursive: true });
await mkdir(promptOut, { recursive: true });
await Promise.all([
  bundleRenderer(),
  bundlePreload(),
  bundlePrompt(),
  bundlePromptPreload(),
  copyStatic(),
]);
process.stdout.write(
  `bundle: ${relative(process.cwd(), rendererOut) || '.'}/{index.html,app.js,ui.css,shell.css} + ${relative(process.cwd(), join(dist, 'preload.cjs'))}\n`,
);
