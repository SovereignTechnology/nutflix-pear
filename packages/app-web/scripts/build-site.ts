/**
 * The web client's static site (ADR 0022, M4), after `tsc -b` and `@sovit/ui`'s `build:css`:
 *
 *   dist/site/index.html                  site/index.html, with a CSP <meta> and SRI on every script,
 *                                         module and stylesheet (scripts/csp-sri.mjs)
 *   dist/site/app.js                      site/entry.ts, bundled (esbuild, minified, production React)
 *   dist/site/ui.css, shell.css           @sovit/ui's styles
 *   dist/site/nfx/player.js               nfx's player library, byte for byte from the pinned tar
 *   dist/site/nfx/wasm/nfx_wasm_bg.wasm   its verifier, byte for byte from the tar
 *   dist/site/source.json                 the commits, the lock and every file's sha256 (AGPL-3.0 §13)
 *
 * and beside the site, `dist/site-headers.txt` (the CSP and the other headers the page is served
 * with) and `dist/nutflix-web-site-<pear commit, 12 hex>.tar` (the site as a reproducible tar).
 *
 * It refuses to build when:
 * - the library tar is not the one `nfx-web.lock` pins (sha256), or holds other files;
 * - the tar's own `player.d.ts` and `api.d.ts` no longer fit `src/nfx-lib.ts` (site/lib-check.ts);
 * - the bundle loaded anything on the deny list (`DENY` in ./site.ts: Cashu, sodium, Hypercore,
 *   Bare, Electron, core's wallet, payment and signer code, …), whether or not it was tree-shaken;
 * - the page has anything inline, or anything from another origin (csp-sri.mjs);
 * - the pear tree has uncommitted changes (unless --allow-dirty: source.json then says so).
 *
 * Built twice from the same commit, the site is the same bytes: nothing here reads a clock, a
 * path or the host, and the tar is written with fixed metadata.
 *
 * Usage (from packages/app-web): node scripts/build-site.ts [--nfx-lib <tar>] [--out <dir>]
 *   [--pear-commit <40 hex>] [--allow-dirty]
 *   --nfx-lib      default .cache/nfx/nfx-web-lib-<commit, 12 hex>.tar (scripts/nfx-lib.sh build)
 *   --out          the site directory, default dist/site (headers and tar go beside it)
 *   --pear-commit  needed when this is not a git checkout (e.g. a GitHub archive)
 */
import { build, type Plugin } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIB_FILES,
  SITE_FILES,
  deniedInputs,
  hashTree,
  listFiles,
  npmPackages,
  parseLock,
  sha256Hex,
  sourceRecord,
  sri384,
} from './site.ts';

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = resolve(pkg, '..', '..');
const require = createRequire(import.meta.url);

function fail(msg: string): never {
  process.stderr.write(`build-site: ${msg}\n`);
  process.exit(1);
}

function say(msg: string): void {
  process.stderr.write(`build-site: ${msg}\n`);
}

function args(argv: readonly string[]): {
  nfxLib: string | null;
  out: string;
  pearCommit: string | null;
  allowDirty: boolean;
} {
  let nfxLib: string | null = null;
  let out = join(pkg, 'dist', 'site');
  let pearCommit: string | null = null;
  let allowDirty = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) fail(`${String(a)} needs a value`);
      return v;
    };
    switch (a) {
      case '--nfx-lib':
        nfxLib = resolve(value());
        break;
      case '--out':
        out = resolve(value());
        break;
      case '--pear-commit':
        pearCommit = value();
        break;
      case '--allow-dirty':
        allowDirty = true;
        break;
      default:
        fail(`unknown argument ${String(a)}`);
    }
  }
  // `out` is emptied first: never the checkout, the package, or a directory holding either.
  if (`${repo}${sep}`.startsWith(`${out}${sep}`) || `${pkg}${sep}`.startsWith(`${out}${sep}`))
    fail(`--out ${out} would empty the checkout`);
  return { nfxLib, out, pearCommit, allowDirty };
}

/** The pear commit, and whether the tree has tracked changes it does not hold. */
function pearState(given: string | null): { commit: string; modified: boolean } {
  const git = (...a: string[]): string =>
    execFileSync('git', ['-C', repo, ...a], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  let head: string | null = null;
  let modified = false;
  try {
    head = git('rev-parse', 'HEAD');
    modified = git('status', '--porcelain', '--untracked-files=no') !== '';
  } catch {
    // Not a git checkout: --pear-commit says which commit this is.
  }
  const commit = given ?? head;
  if (commit === null) fail('not a git checkout: pass --pear-commit <40 hex>');
  if (!/^[0-9a-f]{40}$/.test(commit)) fail('the pear commit must be 40 lowercase hex');
  if (head !== null && given !== null && given !== head)
    fail(`--pear-commit ${given} is not HEAD (${head})`);
  return { commit, modified };
}

/** The library tar's four files, checked, in a fresh directory. */
function unpackLib(tar: string, libSha256: string): string {
  if (!existsSync(tar)) fail(`no library tar at ${tar}: run scripts/nfx-lib.sh build first`);
  const got = sha256Hex(readFileSync(tar));
  if (got !== libSha256) fail(`${tar}: sha256 ${got}, not the lock's ${libSha256}`);
  const listed = execFileSync('tar', ['-tf', tar], { encoding: 'utf8' }).trim().split('\n');
  if (JSON.stringify(listed) !== JSON.stringify(LIB_FILES))
    fail(`the library tar holds ${JSON.stringify(listed)}, not ${JSON.stringify(LIB_FILES)}`);
  const stage = mkdtempSync(join(tmpdir(), 'nfx-web-lib-'));
  execFileSync('tar', ['-xf', tar, '-C', stage, '--no-same-owner', '--no-same-permissions']);
  for (const f of LIB_FILES) {
    const st = lstatSync(join(stage, f));
    if (!st.isFile()) fail(`${f} in the library tar is not a regular file`);
  }
  return stage;
}

/** site/lib-check.ts (and the entry) against the tar's own declarations: no drift. */
function checkDrift(stage: string): void {
  const config = join(stage, 'tsconfig.check.json');
  writeFileSync(
    config,
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          verbatimModuleSyntax: true,
          isolatedModules: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ES2023', 'DOM', 'DOM.Iterable'],
          types: [],
          noEmit: true,
          skipLibCheck: true,
          paths: { 'nfx-web-lib': [join(stage, 'player.d.ts')] },
        },
        files: [join(pkg, 'site', 'lib-check.ts'), join(pkg, 'site', 'entry.ts')],
      },
      null,
      2,
    ),
  );
  const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
  const r = spawnSync(process.execPath, [tsc, '-p', config, '--pretty', 'false'], {
    cwd: pkg,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    fail(
      `nfx's library no longer fits src/nfx-lib.ts (site/lib-check.ts against the tar's player.d.ts):\n${r.stdout}${r.stderr}`,
    );
  }
  say("the library's player.d.ts and api.d.ts fit src/nfx-lib.ts");
}

/** `nfx-web-lib` is the pinned library, kept a separate file: `./nfx/player.js`, beside app.js. */
const nfxExternal: Plugin = {
  name: 'nfx-web-lib',
  setup(b) {
    b.onResolve({ filter: /^nfx-web-lib$/ }, () => ({ path: './nfx/player.js', external: true }));
  },
};

async function bundle(out: string, wasmIntegrity: string): Promise<void> {
  const r = await build({
    absWorkingDir: pkg,
    entryPoints: ['site/entry.ts'],
    outfile: join(out, 'app.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    sourcemap: false,
    legalComments: 'eof',
    tsconfig: 'site/tsconfig.json',
    define: {
      'process.env.NODE_ENV': '"production"',
      __NFX_WASM_INTEGRITY__: JSON.stringify(wasmIntegrity),
    },
    plugins: [nfxExternal],
    metafile: true,
    logLevel: 'warning',
  });
  const inputs = Object.keys(r.metafile.inputs).map((p) =>
    /^[a-z-]+:/.test(p) ? p : resolve(pkg, p),
  );
  const denied = deniedInputs(inputs);
  if (denied.length > 0) fail(`the bundle may not contain:\n  ${denied.join('\n  ')}`);
  const imports = Object.values(r.metafile.outputs).flatMap((o) =>
    o.imports.filter((i) => i.external).map((i) => i.path),
  );
  if (JSON.stringify(imports) !== JSON.stringify(['./nfx/player.js']))
    fail(`app.js may import nothing but ./nfx/player.js, not ${JSON.stringify(imports)}`);
  say(`app.js: ${String(inputs.length)} inputs; npm: ${npmPackages(inputs).join(' ')}`);
}

async function main(): Promise<void> {
  const o = args(process.argv.slice(2));
  const lock = parseLock(readFileSync(join(pkg, 'nfx-web.lock'), 'utf8'));
  const pear = pearState(o.pearCommit);
  if (pear.modified && !o.allowDirty)
    fail(
      'the pear tree has uncommitted changes: commit them, or pass --allow-dirty for a test build',
    );
  const tar = o.nfxLib ?? join(pkg, '.cache', 'nfx', `nfx-web-lib-${lock.commit.slice(0, 12)}.tar`);
  const stage = unpackLib(tar, lock.libSha256);
  try {
    checkDrift(stage);
    const out = o.out;
    const dist = dirname(out);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(join(out, 'nfx', 'wasm'), { recursive: true });

    const wasm = readFileSync(join(stage, 'wasm', 'nfx_wasm_bg.wasm'));
    await bundle(out, sri384(wasm));
    copyFileSync(join(stage, 'player.js'), join(out, 'nfx', 'player.js'));
    copyFileSync(
      join(stage, 'wasm', 'nfx_wasm_bg.wasm'),
      join(out, 'nfx', 'wasm', 'nfx_wasm_bg.wasm'),
    );
    copyFileSync(require.resolve('@sovit/ui/ui.css'), join(out, 'ui.css'));
    copyFileSync(require.resolve('@sovit/ui/shell.css'), join(out, 'shell.css'));
    copyFileSync(join(pkg, 'site', 'index.html'), join(out, 'index.html'));

    // SRI and the CSP: WASM may compile ('wasm-unsafe-eval'); the page talks to relays, origins and
    // trackers anywhere (https:, wss:), and hands the verified WASM to nfx's init as a blob: URL.
    const headers = join(dist, 'site-headers.txt');
    const csp = spawnSync(
      process.execPath,
      [
        join(repo, 'scripts', 'csp-sri.mjs'),
        join(out, 'index.html'),
        '--wasm',
        '--connect',
        'https:',
        '--connect',
        'wss:',
        '--connect',
        'blob:',
        '--headers',
        headers,
      ],
      { encoding: 'utf8' },
    );
    if (csp.status !== 0) fail(`csp-sri.mjs refused the page:\n${csp.stderr}`);
    const policy = /^Content-Security-Policy: (.*)$/m.exec(readFileSync(headers, 'utf8'))?.[1];
    if (policy === undefined) fail('csp-sri.mjs wrote no Content-Security-Policy header');

    const libFiles = LIB_FILES.map((path) => {
      const buf = readFileSync(join(stage, path));
      return { path, sha256: sha256Hex(buf), bytes: buf.length };
    });
    writeFileSync(
      join(out, 'source.json'),
      sourceRecord({
        lock,
        pearCommit: pear.commit,
        modified: pear.modified,
        libFiles,
        csp: policy,
        files: hashTree(out).files,
      }),
    );

    const listed = listFiles(out);
    if (JSON.stringify(listed) !== JSON.stringify(SITE_FILES))
      fail(`dist/site holds ${JSON.stringify(listed)}, not ${JSON.stringify(SITE_FILES)}`);
    const tree = hashTree(out);
    const siteTar = join(dist, `nutflix-web-site-${pear.commit.slice(0, 12)}.tar`);
    // As nfx's lib-tar.sh packs its tar: fixed metadata, no directory entries, so the same files
    // give the same bytes on any host (GNU tar).
    execFileSync('tar', [
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '--mode=u=rw,go=r',
      '--format=posix',
      '--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime',
      '-cf',
      siteTar,
      '-C',
      out,
      ...SITE_FILES,
    ]);
    const tarSha = sha256Hex(readFileSync(siteTar));
    writeFileSync(`${siteTar}.sha256`, `${tarSha}  ${siteTar.slice(dist.length + 1)}\n`);
    for (const f of tree.files) {
      process.stdout.write(`SITE_FILE ${f.sha256} ${String(f.bytes)} ${f.path}\n`);
    }
    process.stdout.write(
      [
        `SITE_PEAR_COMMIT=${pear.commit}${pear.modified ? ' (modified)' : ''}`,
        `SITE_NFX_COMMIT=${lock.commit}`,
        `SITE_TREE_SHA256=${tree.treeHash}`,
        `SITE_TAR=${siteTar}`,
        `SITE_TAR_SHA256=${tarSha}`,
        `SITE_HEADERS=${headers}`,
        '',
      ].join('\n'),
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

await main();
