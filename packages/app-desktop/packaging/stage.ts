/**
 * Stages the packaged app (issue #6, ADR 0017): a standalone directory Electron Forge packages
 * as-is (asar on, packager's prune off). Layout — the same as `dist/`, so main's path logic is
 * unchanged, except the worker:
 *
 *   package.json              name, productName, version, main, "type": "module"
 *   main/main.js              Electron main, bundled (src/main + src/ipc only; `electron` external)
 *   host/main.js              the host utilityProcess, bundled WITH its npm code (@sovit/core,
 *                             cashu-ts, nostr-tools…) so the money and signer code the host runs
 *                             lives inside app.asar; only native packages stay external
 *   preload.cjs, prompt-preload.cjs, renderer/, prompt/   copied from scripts/bundle.ts output
 *   worker/boot.mjs           UNBUNDLED boot module: `bare-encoding/global` first (D6), then…
 *   worker/worker.mjs         the worker bundle (our sources only; every npm package stays an
 *                             import that Bare resolves itself — export conditions, addons)
 *   worker/pay/dleq-thread-entry.mjs   the DLEQ thread's entry (issue #8 d), bundled on its own
 *                             (src/worker/pay + src/ipc only; core and bare-encoding stay imports
 *                             Bare resolves from worker/pay/ up to node_modules/). The worker
 *                             bundle finds it at `./pay/` from itself (src/worker/worker-root.ts)
 *   node_modules/             the lockfile runtime closure (closure.ts), native prebuilds for the
 *                             target platform only, workspace packages as real directories
 *   iroh/nutflix-iroh-helper  the iroh helper the worker spawns (slice 5e-5, ADR 0021), built for
 *                             the target and checked to be one (`stageIrohHelper`); only when
 *                             `irohHelper` is given
 *
 * `worker/`, `node_modules/` and `iroh/` are unpacked from the asar (identity.ts `UNPACKED_DIRS`).
 * Needs `npm run build` first (tsc, ui css, scripts/bundle.ts), and refuses to stage when that
 * build is older than its sources (`assertCurrentBuild`). Never writes outside `out`.
 *
 *   node packaging/stage.ts [--out <dir>] [--platform <p>] [--arch <a>]
 *                           (--iroh-helper <file> | --without-iroh-helper)
 */
import { build, type Metafile, type Plugin } from 'esbuild';
import ts from 'typescript';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  keepPrebuild,
  resolveFrom,
  runtimeClosure,
  type ClosureEntry,
  type Lockfile,
} from './closure.ts';
import {
  APP,
  NOT_SHIPPED,
  PACKAGED_DLEQ_THREAD_ENTRY,
  PACKAGED_WORKER_BUNDLE,
  PACKAGED_WORKER_ENTRY,
  PRELOAD_FILES,
  PROMPT_FILES,
  RENDERER_FILES,
  packagedIrohHelper,
} from './identity.ts';
import { PROMPT_NPM_IMPORTS } from './prompt-npm.ts';

export const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(PKG_DIR, '..', '..');

/**
 * D6: the worker's first module, never bundled. A bundle hoists every external import of every
 * module to its top, in the bundler's order, so an inlined globals module could run after
 * `@sovit/core` (which builds a `TextDecoder` at load). This module evaluates
 * `bare-encoding/global` before the bundle is even requested. A failed load rejects, which
 * Bare reports and exits on — the host then restarts it with back-off, then gives up.
 */
export const WORKER_BOOT_SOURCE =
  "import 'bare-encoding/global'\nimport('./worker.mjs').catch((e) => {\n  throw e\n})\n";

/** Electron 44.2.0: Chromium 152, Node 24.20. */
const NODE_TARGET = 'node24';

/**
 * The DLEQ thread's entry source. `.mts`, and built to `.mjs`: a `Bare.Thread` entry takes its
 * module type from the extension alone (see the file).
 */
export const DLEQ_THREAD_SOURCE = 'src/worker/pay/dleq-thread-entry.mts';

export interface StageOptions {
  readonly out: string;
  readonly platform: string;
  readonly arch: string;
  /**
   * Slice 5e-5: the iroh helper built for this target (`crates/iroh-helper`), staged as
   * `PACKAGED_IROH_HELPER`; absent, the app ships none and its worker speaks HyperDHT only.
   * `cli.ts` makes the choice explicit (`--iroh-helper <file>` or `--without-iroh-helper`).
   */
  readonly irohHelper?: string;
  /** Defaults: this package and the repo root it belongs to. */
  readonly pkgDir?: string;
  readonly repoRoot?: string;
}

/** The most bytes a staged iroh helper may have (the release build is about 11 MB). */
export const MAX_IROH_HELPER_BYTES = 64 * 1024 * 1024;

/**
 * Why `head` (a file's first 64 bytes) is not an executable for `platform`-`arch`, or `null`:
 * an ELF64 little-endian of the right machine on Linux, a 64-bit Mach-O of the right CPU (or a
 * universal one) on macOS, a PE (`MZ`) on Windows. Catches a helper built for the build
 * machine instead of the target, which would only fail on a user's computer.
 */
export function irohHelperFormatProblem(
  head: Uint8Array,
  platform: string,
  arch: string,
): string | null {
  const u16 = (o: number): number => (head[o] ?? 0) | ((head[o + 1] ?? 0) << 8);
  const u32 = (o: number): number => (u16(o) | (u16(o + 2) << 16)) >>> 0;
  if (platform === 'linux') {
    const elf = head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
    if (!elf) return 'not an ELF executable';
    if (head[4] !== 2 || head[5] !== 1) return 'not a 64-bit little-endian ELF';
    const machine = u16(18);
    const want = arch === 'x64' ? 62 : arch === 'arm64' ? 183 : -1;
    return machine === want ? null : `an ELF for machine ${String(machine)}, not ${arch}`;
  }
  if (platform === 'darwin') {
    if (u32(0) === 0xbebafeca) return null; // universal (fat), big-endian magic read LE
    if (u32(0) !== 0xfeedfacf) return 'not a 64-bit Mach-O';
    const cpu = u32(4);
    const want = arch === 'x64' ? 0x01000007 : arch === 'arm64' ? 0x0100000c : -1;
    return cpu === want ? null : `a Mach-O for CPU ${cpu.toString(16)}, not ${arch}`;
  }
  if (platform === 'win32') return head[0] === 0x4d && head[1] === 0x5a ? null : 'not a PE';
  return `no iroh helper format for ${platform}`;
}

/**
 * Copy the iroh helper to `<out>/<packagedIrohHelper(platform)>` (0755), after checking it is a
 * regular file (never a symlink), executable here, at most `MAX_IROH_HELPER_BYTES`, and built
 * for the target.
 */
export function stageIrohHelper(src: string, out: string, platform: string, arch: string): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(src);
  } catch {
    fail(`the iroh helper ${src} does not exist`);
  }
  if (st.isSymbolicLink()) fail(`the iroh helper ${src} is a symlink; give the file itself`);
  if (!st.isFile()) fail(`the iroh helper ${src} is not a regular file`);
  if (st.size > MAX_IROH_HELPER_BYTES)
    fail(
      `the iroh helper ${src} is ${String(st.size)} bytes, over ${String(MAX_IROH_HELPER_BYTES)}`,
    );
  if ((st.mode & 0o100) === 0) fail(`the iroh helper ${src} is not executable`);
  const head = readFileSync(src).subarray(0, 64);
  const problem = irohHelperFormatProblem(head, platform, arch);
  if (problem !== null) fail(`the iroh helper ${src} is ${problem} (target ${platform}-${arch})`);
  const dst = join(out, packagedIrohHelper(platform));
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  chmodSync(dst, 0o755);
}

export interface StageReport {
  readonly out: string;
  readonly packages: readonly ClosureEntry[];
  readonly files: number;
  readonly bytes: number;
  /** Slice 5e-5: whether the iroh helper was staged (`StageOptions.irohHelper`). */
  readonly irohHelper: boolean;
  /** Bare specifiers the bundles import (each resolves in `node_modules/`). */
  readonly externals: {
    readonly host: readonly string[];
    readonly worker: readonly string[];
    /** The DLEQ thread entry's (resolved by Bare from `worker/pay/` up). */
    readonly dleqThread: readonly string[];
  };
}

export class StageError extends Error {
  override readonly name = 'StageError' as const;
}

function fail(msg: string): never {
  throw new StageError(msg);
}

/** Metafile inputs as absolute paths. */
function inputsOf(meta: Metafile, cwd: string): string[] {
  return Object.keys(meta.inputs).map((p) => (p.includes(':') ? p : resolve(cwd, p)));
}

/** The bare package names an output imports as externals (`@a/b/sub` → `@a/b`). */
function externalPackages(meta: Metafile): string[] {
  const names = new Set<string>();
  for (const out of Object.values(meta.outputs))
    for (const imp of out.imports)
      if (imp.external && !imp.path.startsWith('node:') && !imp.path.startsWith('.')) {
        const parts = imp.path.split('/');
        names.add(imp.path.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? ''));
      }
  return [...names].sort();
}

/** Inside the worker bundle, `bare-globals.js` becomes the (idempotent) external global module. */
const d6FirstImport: Plugin = {
  name: 'd6-first-import',
  setup(b) {
    b.onResolve({ filter: /[\\/]bare-globals\.js$/ }, () => ({
      path: 'bare-encoding/global',
      external: true,
    }));
  },
};

/**
 * Cross-lane review (round 4, INFO): core's test doubles stay out of the PACKAGED host bundle,
 * the process that holds the wallet. core's barrel re-exports them (`export * as mocks`,
 * `nostr.FakeRelayPool`), so the bundler cannot drop them; the host reaches them only behind
 * `--dev-mocks` / `--dev-fixtures`, which a packaged main refuses (exit 78). Each module here
 * (a path in core's dist/) is bundled as a stub with the same export names, every one a value
 * that throws when touched. The dev host (tsc output, run from dist/) keeps the real ones, and
 * so does the worker's copy of core in node_modules/.
 */
export const HOST_TEST_DOUBLES = ['mocks/index.js', 'nostr/fake-relay.js'] as const;
const TEST_DOUBLE_NS = 'nutflix-packaged-test-double';

/** The stub module for a test double that exports `names`. */
export function testDoubleStub(names: readonly string[]): string {
  const bad = names.filter(
    (n) => !/^[A-Za-z_$][\w$]*$/.test(n) || n === 'default' || n === '__nfRefused',
  );
  if (bad.length > 0) fail(`cannot stub a test double exporting ${bad.join(', ')}`);
  return [
    "// packaging/stage.ts: core's test doubles are not in a packaged build (reached only behind",
    '// --dev-mocks / --dev-fixtures, which a packaged build refuses). Touching one throws.',
    'const __nfRefused = (name) => {',
    '  const fail = () => {',
    "    throw new Error(`${name}: core's test doubles are not in a packaged build`);",
    '  };',
    '  const traps = { get: fail, set: fail, has: fail, deleteProperty: fail, ownKeys: fail,',
    '    defineProperty: fail, getOwnPropertyDescriptor: fail, apply: fail, construct: fail };',
    '  return new Proxy(function () {}, traps);',
    '};',
    ...[...names].sort().map((n) => `export const ${n} = __nfRefused(${JSON.stringify(n)});`),
    '',
  ].join('\n');
}

/** Every name a module exports (its `export *` followed), as esbuild sees it. */
async function exportNames(file: string): Promise<string[]> {
  const r = await build({
    entryPoints: [file],
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'neutral',
    packages: 'external',
    outfile: 'exports.js',
    logLevel: 'silent',
  });
  return [...(Object.values(r.metafile.outputs)[0]?.exports ?? [])];
}

/**
 * Bundles each of `coreDist`'s HOST_TEST_DOUBLES as its stub (see there). The stub's module
 * path is the relative name (`mocks/index.js`), never the build machine's absolute path: it
 * appears in the bundle as a path comment, and the staged tree must not depend on where the
 * repo is checked out.
 */
function stubTestDoubles(coreDist: string): Plugin {
  const targets = new Map<string, string>();
  for (const m of HOST_TEST_DOUBLES) {
    const p = join(coreDist, m);
    if (existsSync(p)) targets.set(realpathSync(p), m);
  }
  return {
    name: 'packaged-host-no-test-doubles',
    setup(b) {
      b.onResolve({ filter: /^\.{1,2}\// }, (args) => {
        const abs = resolve(args.resolveDir, args.path);
        const m = targets.get(abs);
        return m === undefined
          ? undefined
          : { path: m, namespace: TEST_DOUBLE_NS, pluginData: { file: abs } };
      });
      b.onLoad({ filter: /.*/, namespace: TEST_DOUBLE_NS }, async (args) => ({
        contents: testDoubleStub(await exportNames((args.pluginData as { file: string }).file)),
        loader: 'js',
      }));
    },
  };
}

/** Whether an installed package carries native code (then the host bundle leaves it external). */
function isNative(dir: string): boolean {
  if (existsSync(join(dir, 'prebuilds')) || existsSync(join(dir, 'binding.gyp'))) return true;
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    addon?: unknown;
    gypfile?: unknown;
  };
  return pj.addon === true || pj.gypfile === true;
}

interface CopyStats {
  files: number;
  bytes: number;
}

/**
 * Copies one package directory. Symlinks are refused (their content would come from outside
 * the reviewed tree); nested `node_modules` are separate closure entries; `prebuilds/` keeps
 * the target platform only. Modes are preserved (`copyFileSync` copies permission bits), so the
 * `bare` runtime stays executable — the host refuses it otherwise (src/host/worker/sidecar.ts).
 */
export function copyPackage(
  src: string,
  dst: string,
  keep: (rel: string, isDir: boolean) => boolean,
  stats: CopyStats,
): void {
  const walk = (rel: string): void => {
    const from = join(src, rel);
    const st = lstatSync(from);
    if (st.isSymbolicLink()) fail(`symlink in a shipped package is refused: ${from}`);
    if (st.isDirectory()) {
      mkdirSync(join(dst, rel), { recursive: true });
      for (const name of readdirSync(from).sort()) {
        const child = rel === '' ? name : `${rel}/${name}`;
        const childSt = lstatSync(join(src, child));
        if (keep(child, childSt.isDirectory())) walk(child);
      }
      return;
    }
    if (!st.isFile()) fail(`unsupported entry in a shipped package: ${from}`);
    copyFileSync(from, join(dst, rel));
    stats.files++;
    stats.bytes += st.size;
  };
  walk('');
}

/** npm package filter: no nested node_modules, other platforms' prebuilds dropped. */
export function npmFilter(
  platform: string,
  arch: string,
): (rel: string, isDir: boolean) => boolean {
  return (rel, isDir) => {
    const parts = rel.split('/');
    if (parts.includes('node_modules')) return false;
    if (isDir && parts.length === 2 && parts[0] === 'prebuilds')
      return keepPrebuild(parts[1] ?? '', platform, arch);
    return true;
  };
}

/** Workspace package filter: package.json + its `files`, without tests, maps or declarations. */
export function workspaceFilter(
  files: readonly string[],
): (rel: string, isDir: boolean) => boolean {
  return (rel, isDir) => {
    const parts = rel.split('/');
    const top = parts[0] ?? '';
    if (parts.length === 1 && !isDir) return top === 'package.json' || files.includes(top);
    if (!files.includes(top)) return false;
    if (parts.includes('__tests__') || parts.includes('node_modules')) return false;
    if (isDir) return true;
    return !/\.(?:map|d\.ts|tsbuildinfo)$/.test(rel) && !rel.endsWith('.test.js');
  };
}

/**
 * Every staged directory 0755, every file 0644 — or 0755 if it was executable (the Electron
 * helpers are not here; the `bare` runtime and any package script are). Installs (a `.deb`
 * under /usr/lib, an AppImage) then never ship group-writable files, whatever the build
 * machine's umask or npm's extraction left.
 */
export function normalizeModes(root: string): void {
  const walk = (p: string): void => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) fail(`symlink in the staged tree: ${p}`);
    if (st.isDirectory()) {
      chmodSync(p, 0o755);
      for (const e of readdirSync(p)) walk(join(p, e));
    } else chmodSync(p, (st.mode & 0o111) !== 0 ? 0o755 : 0o644);
  };
  walk(root);
}

/**
 * `out` is deleted and rewritten, so it must be something this step made: absent, empty, or a
 * previous stage (its package.json names the app and it has the worker boot module). A mistyped
 * `--out ~/Projects` fails here instead of being wiped.
 */
export function assertReplaceable(out: string): void {
  if (!existsSync(out)) return;
  const st = lstatSync(out);
  if (!st.isDirectory() || st.isSymbolicLink()) fail(`${out} exists and is not a directory`);
  if (readdirSync(out).length === 0) return;
  let name: unknown;
  try {
    name = (JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')) as { name?: unknown }).name;
  } catch {
    name = undefined;
  }
  if (name !== APP.name || !existsSync(join(out, PACKAGED_WORKER_ENTRY)))
    fail(`${out} is not empty and is not a previous stage: refusing to delete it`);
}

// ---- the build the stage copies must be current (cross-lane review, round 4) -------------
//
// The stage compiles main, the host and the worker glue from src/, but it SHIPS two things it
// never compiles: every workspace package's dist/ (tsc output: copied into node_modules/ for the
// worker, and inlined into the host bundle through the package exports) and scripts/bundle.ts's
// output (renderer, prompt, preloads). With core's melt timeout changed in src/ and no rebuild,
// staging succeeded and both copies carried the old value (the reviewer's mutation). So staging
// refuses a build older than its sources; it never runs the build, so it writes only `out`.

/** TypeScript's "A non-dry build would build project '{0}'" (diagnostic 6357). */
export const TSC_WOULD_BUILD = 6357;

/**
 * What scripts/bundle.ts reads from this package: the trees of its four entry points
 * (src/renderer/main.tsx, src/renderer/prompt/prompt.ts, src/preload/{preload,prompt-preload}.ts,
 * with the src/ipc they import) and the pages and stylesheets it copies. Pinned against the
 * script by a test.
 */
export const BUNDLE_SOURCES = ['src/renderer', 'src/preload', 'src/ipc', 'static'] as const;

/**
 * Every directory scripts/bundle.ts reads, so every one its outputs must be at least as new as:
 * this package's BUNDLE_SOURCES, and each bundled workspace's dist/ and src/. The bundle reads a
 * bundled workspace through its package exports, i.e. its BUILD: `@sovit/ui` resolves to
 * dist/*.js and the copied stylesheet is dist/ui.css (cross-lane review, round 5: a bundle made
 * from an old ui/dist, with ui rebuilt afterwards, staged the old renderer). Pinned against the
 * real renderer bundle's inputs by a test.
 *
 * What watching a workspace's src/ adds (lane R6-reconcile: the round-5 verifier asked for the
 * old "second, stricter check" claim to be stated exactly or tested; both are done). src/ reaches
 * the bundle only through dist/, and an edit there is already refused by rule 1 (tsc would
 * rebuild) or rule 2 (a stylesheet older than its source), so for a real edit it refuses the same
 * stale build a second time — a belt for rule 1, whose dry run trusts its `.tsbuildinfo`. On its
 * own it refuses only a bundle older than a src/ file whose content cannot have changed what the
 * bundle reads: a source only touched (a checkout rewriting it unchanged; rule 1 calls that
 * current), or a file that is neither a tsc input nor a stylesheet. Those refusals are false
 * alarms, cleared by `npm run build`. A test pins that it fires on its own (a touched source).
 */
export function bundleInputDirs(pkg: string, root: string, bundled: readonly string[]): string[] {
  return [
    ...BUNDLE_SOURCES.map((d) => join(pkg, d)),
    ...bundled.flatMap((w) => [join(root, w, 'dist'), join(root, w, 'src')]),
  ];
}

/**
 * Lane R6-reconcile (the round-5 verifier): the bundle's own configuration shapes its output as
 * much as its sources — the script (entry points, format, target, what it copies and refuses),
 * the modules it imports (round 8: the prompt page's npm allow-list) and the tsconfigs its
 * esbuild builds name (JSX, `paths`, the target they inherit), package-relative. Pinned against
 * the script by a test.
 */
export const BUNDLE_CONFIG = [
  'scripts/bundle.ts',
  'packaging/prompt-npm.ts',
  'tsconfig.renderer.json',
  'tsconfig.preload.json',
] as const;
/** What those tsconfigs extend, repo-relative (pinned against their `extends` by the same test). */
export const BUNDLE_CONFIG_ROOT = ['tsconfig.base.json'] as const;

/** The files of BUNDLE_CONFIG and BUNDLE_CONFIG_ROOT, absolute. */
export function bundleConfigFiles(pkg: string, root: string): string[] {
  return [
    ...BUNDLE_CONFIG.map((f) => join(pkg, f)),
    ...BUNDLE_CONFIG_ROOT.map((f) => join(root, f)),
  ];
}

/**
 * Round 8 (the final panel): the npm code scripts/bundle.ts inlines into the prompt page — its
 * install directories, repo-relative, read from the lockfile: `PROMPT_NPM_IMPORTS` as npm
 * resolves them from this package, then their dependencies, transitively, as each resolves them
 * (`node_modules/@scure/bip39`, and wherever npm put `@noble/hashes` and `@scure/base` for it).
 * Refuses one the lockfile does not list: the rule could not be checked. Pinned against the real
 * prompt bundle's inputs by a test.
 */
export function promptNpmDirs(lock: Lockfile, workspace: string): string[] {
  const seen = new Set<string>();
  const visit = (from: string, name: string, optional: boolean): void => {
    const at = resolveFrom(lock, from, name);
    if (at === undefined) {
      if (optional) return;
      fail(
        `${name} (bundled into the prompt page) is not in the lockfile: cannot tell whether the bundle is current`,
      );
    }
    if (seen.has(at)) return;
    seen.add(at);
    const e = lock.packages[at];
    for (const d of Object.keys(e?.dependencies ?? {})) visit(at, d, false);
    for (const d of Object.keys(e?.optionalDependencies ?? {})) visit(at, d, true);
    for (const d of Object.keys(e?.peerDependencies ?? {}))
      visit(at, d, e?.peerDependenciesMeta?.[d]?.optional === true);
  };
  for (const name of PROMPT_NPM_IMPORTS) visit(workspace, name, false);
  return [...seen].sort();
}

/**
 * The workspace packages the staged app is built from, repo-relative: `shipped` are the
 * closure's (their dist/ is copied into node_modules/ and inlined into the host bundle),
 * `bundled` the NOT_SHIPPED roots that are workspace links (inlined into renderer/app.js by
 * scripts/bundle.ts, with the stylesheet it copies: @sovit/ui).
 */
export function builtFromWorkspaces(
  lock: Lockfile,
  workspace: string,
  packages: readonly ClosureEntry[],
): { readonly shipped: string[]; readonly bundled: string[] } {
  const shipped = new Set(packages.filter((p) => p.workspace).map((p) => p.source));
  const bundled = new Set<string>();
  for (const name of Object.keys(NOT_SHIPPED)) {
    const at = resolveFrom(lock, workspace, name);
    const e = at === undefined ? undefined : lock.packages[at];
    if (e?.link === true && e.resolved !== undefined) bundled.add(e.resolved);
  }
  return { shipped: [...shipped].sort(), bundled: [...bundled].sort() };
}

/**
 * `tsc -b --dry` over `configs` through TypeScript's own API (nothing is written): the status
 * lines of the projects a real build would REBUILD — its dist/ is not the output of its current
 * sources, or its last build had errors. A project whose sources were only touched ("would
 * update timestamps") is current. A config that cannot be read fails.
 */
export function staleTscProjects(configs: readonly string[]): string[] {
  if (configs.length === 0) return [];
  const stale: string[] = [];
  const errors: string[] = [];
  const text = (d: ts.Diagnostic): string => ts.flattenDiagnosticMessageText(d.messageText, ' ');
  const host = ts.createSolutionBuilderHost(
    ts.sys,
    undefined,
    (d) => {
      errors.push(text(d));
    },
    (d) => {
      if (d.code === TSC_WOULD_BUILD) stale.push(text(d));
    },
  );
  const status = ts.createSolutionBuilder(host, [...configs], { dry: true }).build();
  if (errors.length > 0 || status !== ts.ExitStatus.Success)
    fail(
      `cannot tell whether the workspace builds are current: ${errors.join('; ') || `tsc -b --dry exited ${String(status)}`}`,
    );
  return stale;
}

/** Every file a package.json points at: `main`, and each string target under `exports`. */
export function entryTargets(pj: {
  readonly main?: unknown;
  readonly exports?: unknown;
}): string[] {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') out.add(v);
    else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  if (typeof pj.main === 'string') out.add(pj.main);
  walk(pj.exports);
  return [...out].sort();
}

/** Not an input of any build output: tests, snapshots, stories. */
function isBuildInput(rel: string): boolean {
  const parts = rel.split('/');
  if (parts.includes('__tests__') || parts.includes('node_modules')) return false;
  return !/\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(parts.at(-1) ?? '');
}

interface Newest {
  readonly path: string;
  readonly mtimeMs: number;
}

/**
 * The most recently modified build input under `dir` (optionally only `*<ext>`), or undefined
 * when there is none or `dir` is absent. Symlinks are not followed.
 */
export function newestInput(dir: string, ext?: string): Newest | undefined {
  let best: Newest | undefined;
  const walk = (rel: string): void => {
    const p = rel === '' ? dir : join(dir, rel);
    const st = lstatSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p).sort()) {
        const child = rel === '' ? name : `${rel}/${name}`;
        if (isBuildInput(child)) walk(child);
      }
    } else if (st.isFile() && (ext === undefined || rel.endsWith(ext))) {
      if (best === undefined || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs };
    }
  };
  if (existsSync(dir)) walk('');
  return best;
}

export interface CurrentBuildOptions {
  readonly pkg: string;
  readonly root: string;
  /** Repo-relative workspace directories (`builtFromWorkspaces`). */
  readonly shipped: readonly string[];
  readonly bundled: readonly string[];
  /** Repo-relative install directories of the prompt page's npm code (`promptNpmDirs`). */
  readonly npm: readonly string[];
}

/**
 * Refuses (StageError) unless the build the stage copies is at least as new as its sources:
 *
 *   1. every workspace package the app is built from: `tsc -b --dry` would rebuild none of them,
 *      and each shipped one has the files its package.json points at;
 *   2. their CSS built beside tsc (@sovit/ui's build:css, dist/*.css): each file at least as new
 *      as the package's newest src CSS;
 *   3. scripts/bundle.ts's output that the stage copies: each file at least as new as the newest
 *      file the bundle reads (`bundleInputDirs`: BUNDLE_SOURCES and the bundled packages' dist/
 *      and src/; tests and stories excluded), the bundle's own configuration
 *      (`bundleConfigFiles`: the script, its tsconfigs and what they extend; lane R6-reconcile),
 *      and the npm code it inlines into the prompt page (`promptNpmDirs`: every installed file
 *      of those packages and each package directory itself, whose mtime moves when npm adds or
 *      removes an entry in it; round 8). A configuration file or one of those packages that is
 *      missing is refused: the rule could not be checked.
 *
 * (2) and (3) compare mtimes: `npm run build` rewrites every one of those files each run, so a
 * refusal clears after it. The remedy is `npm run build` (for outputs deleted by hand,
 * `npx tsc -b --force` first).
 */
export function assertCurrentBuild(o: CurrentBuildOptions): void {
  const rel = (p: string): string => relative(o.root, p).split(sep).join('/');
  const remedy = 'run `npm run build` (tsc, ui css, bundle) first';
  const workspaces = [...new Set([...o.shipped, ...o.bundled])].sort();
  const configs = workspaces.map((w) => {
    const c = join(o.root, w, 'tsconfig.json');
    if (!existsSync(c)) fail(`${w} has no tsconfig.json: cannot tell whether its dist/ is current`);
    return c;
  });
  const stale = staleTscProjects(configs);
  if (stale.length > 0)
    fail(`a workspace build is older than its sources (${stale.join('; ')}): ${remedy}`);
  // tsc's dry run trusts its .tsbuildinfo and does not notice outputs deleted by hand (it
  // reports "up to date", and so would `tsc -b`); a shipped package must have its entry points.
  for (const w of o.shipped) {
    const pj = JSON.parse(readFileSync(join(o.root, w, 'package.json'), 'utf8')) as {
      main?: unknown;
      exports?: unknown;
    };
    for (const t of entryTargets(pj))
      if (!existsSync(join(o.root, w, t)))
        fail(
          `${w}/${t.replace(/^\.\//, '')} is missing: run \`npx tsc -b --force\`, then \`npm run build\``,
        );
  }
  for (const w of workspaces) {
    const css = newestInput(join(o.root, w, 'src'), '.css');
    const dist = join(o.root, w, 'dist');
    if (css === undefined || !existsSync(dist)) continue;
    for (const f of readdirSync(dist).sort())
      if (f.endsWith('.css') && statSync(join(dist, f)).mtimeMs < css.mtimeMs)
        fail(`${w}/dist/${f} is older than ${rel(css.path)}: ${remedy}`);
  }
  let newest: Newest | undefined;
  for (const dir of bundleInputDirs(o.pkg, o.root, o.bundled)) {
    const n = newestInput(dir);
    if (n !== undefined && (newest === undefined || n.mtimeMs > newest.mtimeMs)) newest = n;
  }
  for (const path of bundleConfigFiles(o.pkg, o.root)) {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch {
      fail(`${rel(path)} is missing: cannot tell whether the bundle is current`);
    }
    if (!st.isFile())
      fail(`${rel(path)} is not a regular file: cannot tell whether the bundle is current`);
    if (newest === undefined || st.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: st.mtimeMs };
  }
  // Round 8: an npm install rewrites a package's files (install-time mtimes), so a bump or a
  // reinstall after the build is newer than the prompt bundle that inlined the old code.
  for (const d of o.npm) {
    const dir = join(o.root, d);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(dir);
    } catch {
      fail(`${d} is in the lockfile but not installed: cannot tell whether the bundle is current`);
    }
    if (!st.isDirectory())
      fail(`${d} is not a directory: cannot tell whether the bundle is current`);
    if (newest === undefined || st.mtimeMs > newest.mtimeMs)
      newest = { path: dir, mtimeMs: st.mtimeMs };
    const n = newestInput(dir);
    if (n !== undefined && n.mtimeMs > newest.mtimeMs) newest = n;
  }
  if (newest === undefined) return;
  for (const f of [
    ...RENDERER_FILES.map((n) => `renderer/${n}`),
    ...PROMPT_FILES.map((n) => `prompt/${n}`),
    ...PRELOAD_FILES,
  ])
    if (statSync(join(o.pkg, 'dist', f)).mtimeMs < newest.mtimeMs)
      fail(`dist/${f} is older than ${rel(newest.path)}: ${remedy}`);
}

export async function stageApp(o: StageOptions): Promise<StageReport> {
  const pkg = o.pkgDir ?? PKG_DIR;
  const root = o.repoRoot ?? REPO_ROOT;
  const dist = join(pkg, 'dist');
  const out = resolve(o.out);
  for (const f of [
    ...RENDERER_FILES.map((n) => join('renderer', n)),
    ...PROMPT_FILES.map((n) => join('prompt', n)),
    ...PRELOAD_FILES,
  ])
    if (!existsSync(join(dist, f)))
      fail(`dist/${f} is missing: run \`npm run build\` (tsc, ui css, bundle) first`);

  // The closure decides what ships (and, below, what the host may leave external).
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as Lockfile;
  const workspace = relative(root, pkg).split(sep).join('/');
  const packages = runtimeClosure(lock, {
    workspace,
    exclude: Object.keys(NOT_SHIPPED),
    platform: o.platform,
    arch: o.arch,
  });
  // Before `out` is touched: a refused stage leaves the previous one in place.
  assertCurrentBuild({
    pkg,
    root,
    ...builtFromWorkspaces(lock, workspace, packages),
    npm: promptNpmDirs(lock, workspace),
  });

  assertReplaceable(out);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const pj = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { version: string };
  const electron = JSON.parse(
    readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8'),
  ) as { version: string };
  writeFileSync(
    join(out, 'package.json'),
    `${JSON.stringify(
      {
        name: APP.name,
        productName: APP.productName,
        version: pj.version,
        description: APP.description,
        author: APP.author,
        license: APP.license,
        main: 'main/main.js',
        type: 'module',
        // Read by Forge to pick the Electron version; dropped from the packaged copy.
        devDependencies: { electron: electron.version },
      },
      null,
      2,
    )}\n`,
  );

  // ---- main ----------------------------------------------------------------------------
  const mainBuild = await build({
    absWorkingDir: pkg,
    entryPoints: ['src/main/main.ts'],
    outfile: join(out, 'main', 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: NODE_TARGET,
    external: ['electron'],
    tsconfig: 'tsconfig.main.json',
    sourcemap: false,
    minify: false,
    legalComments: 'eof',
    metafile: true,
    logLevel: 'warning',
  });
  const mainAllowed = [join(pkg, 'src', 'main') + sep, join(pkg, 'src', 'ipc') + sep];
  const mainBad = inputsOf(mainBuild.metafile, pkg).filter(
    (p) => !mainAllowed.some((a) => p.startsWith(a)),
  );
  if (mainBad.length > 0)
    fail(`main bundle may only contain src/main and src/ipc:\n  ${mainBad.join('\n  ')}`);

  // ---- node_modules (the closure decides what the host may leave external) ---------------
  const stats: CopyStats = { files: 0, bytes: 0 };
  const natives = new Set<string>();
  for (const p of packages) {
    const src = join(root, p.source);
    if (!existsSync(join(src, 'package.json')))
      fail(`${p.source} is in the lockfile but not installed`);
    const dst = join(out, p.target);
    if (p.workspace) {
      const wpj = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')) as {
        files?: string[];
      };
      copyPackage(src, dst, workspaceFilter(wpj.files ?? []), stats);
    } else {
      copyPackage(src, dst, npmFilter(o.platform, o.arch), stats);
      if (isNative(src)) natives.add(p.name);
    }
  }

  // ---- host ----------------------------------------------------------------------------
  const core = packages.find((p) => p.workspace && p.name === '@sovit/core');
  const coreDist = core === undefined ? undefined : join(root, core.source, 'dist');
  const hostBuild = await build({
    absWorkingDir: pkg,
    entryPoints: ['src/host/main.ts'],
    outfile: join(out, 'host', 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: NODE_TARGET,
    // Native packages stay real packages (their addons load from app.asar.unpacked); bare-sidecar
    // is loaded at runtime by src/host/worker/sidecar.ts from the unpacked tree.
    external: ['electron', ...natives],
    // CJS code inlined into an ESM bundle still `require`s its externals (sodium-native).
    banner: {
      js: "import { createRequire as __nfCreateRequire } from 'node:module';\nconst require = __nfCreateRequire(import.meta.url);",
    },
    tsconfig: 'tsconfig.host.json',
    sourcemap: false,
    minify: false,
    legalComments: 'eof',
    metafile: true,
    logLevel: 'warning',
    plugins: coreDist === undefined ? [] : [stubTestDoubles(coreDist)],
  });
  const hostInputs = inputsOf(hostBuild.metafile, pkg);
  const hostBad = hostInputs.filter(
    (p) =>
      p.startsWith(join(pkg, 'src', 'worker') + sep) ||
      p.startsWith(join(pkg, 'src', 'main') + sep) ||
      p.startsWith(join(pkg, 'src', 'renderer') + sep) ||
      [...natives].some((n) => p.includes(`${sep}node_modules${sep}${n}${sep}`)),
  );
  if (hostBad.length > 0)
    fail(
      `host bundle may not contain worker/main/renderer code or native packages:\n  ${hostBad.join('\n  ')}`,
    );
  // Fail closed if a test double got in anyway (another import path, a renamed module).
  if (coreDist !== undefined) {
    const doubles = hostInputs.filter(
      (p) =>
        p.startsWith(join(coreDist, 'mocks') + sep) ||
        HOST_TEST_DOUBLES.some((m) => p === join(coreDist, m)),
    );
    if (doubles.length > 0)
      fail(`host bundle may not contain core's test doubles:\n  ${doubles.join('\n  ')}`);
  }

  // ---- renderer, prompt, preloads (scripts/bundle.ts output) -----------------------------
  mkdirSync(join(out, 'renderer'), { recursive: true });
  mkdirSync(join(out, 'prompt'), { recursive: true });
  for (const f of RENDERER_FILES) copyFileSync(join(dist, 'renderer', f), join(out, 'renderer', f));
  for (const f of PROMPT_FILES) copyFileSync(join(dist, 'prompt', f), join(out, 'prompt', f));
  for (const f of PRELOAD_FILES) copyFileSync(join(dist, f), join(out, f));

  // ---- worker --------------------------------------------------------------------------
  const workerBuild = await build({
    absWorkingDir: pkg,
    entryPoints: ['src/worker/entry.ts'],
    outfile: join(out, PACKAGED_WORKER_BUNDLE),
    bundle: true,
    packages: 'external',
    platform: 'neutral',
    format: 'esm',
    target: 'es2022',
    tsconfig: 'tsconfig.worker.json',
    sourcemap: false,
    minify: false,
    legalComments: 'eof',
    metafile: true,
    logLevel: 'warning',
    plugins: [d6FirstImport],
  });
  const workerAllowed = [join(pkg, 'src', 'worker') + sep, join(pkg, 'src', 'ipc') + sep];
  const workerBad = inputsOf(workerBuild.metafile, pkg).filter(
    (p) => !workerAllowed.some((a) => p.startsWith(a)),
  );
  if (workerBad.length > 0)
    fail(`worker bundle may only contain src/worker and src/ipc:\n  ${workerBad.join('\n  ')}`);
  writeFileSync(join(out, PACKAGED_WORKER_ENTRY), WORKER_BOOT_SOURCE);

  // ---- the DLEQ thread's entry (issue #8 d) ----------------------------------------------
  // Its own bundle: the dev entry imports ../bare-globals.js and ./dleq-thread.js, neither of
  // which exists in worker/pay/ once the worker is one file. Every import in it is dynamic,
  // inside its try (an exception escaping a Bare thread aborts the worker): esbuild inlines the
  // local ones as lazily-run modules, so that still holds, and bare-globals becomes
  // `bare-encoding/global` as in the worker bundle (D6). Nothing here is loaded from outside
  // the worker directory: our sources inline, npm packages resolved from node_modules/.
  if (!existsSync(join(pkg, DLEQ_THREAD_SOURCE)))
    fail(`${DLEQ_THREAD_SOURCE} is missing: the worker's DLEQ thread would have no entry`);
  const dleqBuild = await build({
    absWorkingDir: pkg,
    entryPoints: [DLEQ_THREAD_SOURCE],
    outfile: join(out, PACKAGED_DLEQ_THREAD_ENTRY),
    bundle: true,
    packages: 'external',
    platform: 'neutral',
    format: 'esm',
    target: 'es2022',
    tsconfig: 'tsconfig.worker.json',
    sourcemap: false,
    minify: false,
    legalComments: 'eof',
    metafile: true,
    logLevel: 'warning',
    plugins: [d6FirstImport],
  });
  const dleqAllowed = [join(pkg, 'src', 'worker', 'pay') + sep, join(pkg, 'src', 'ipc') + sep];
  const dleqBad = inputsOf(dleqBuild.metafile, pkg).filter(
    (p) => !dleqAllowed.some((a) => p.startsWith(a)),
  );
  if (dleqBad.length > 0)
    fail(
      `DLEQ thread bundle may only contain src/worker/pay and src/ipc:\n  ${dleqBad.join('\n  ')}`,
    );

  // ---- the iroh helper (slice 5e-5) ------------------------------------------------------
  if (o.irohHelper !== undefined) stageIrohHelper(o.irohHelper, out, o.platform, o.arch);

  // ---- every external the bundles import must be a shipped package ----------------------
  const externals = {
    host: externalPackages(hostBuild.metafile).filter((n) => n !== 'electron'),
    worker: [...new Set([...externalPackages(workerBuild.metafile), 'bare-encoding'])].sort(),
    dleqThread: externalPackages(dleqBuild.metafile),
  };
  const missing = [...externals.host, ...externals.worker, ...externals.dleqThread].filter(
    (n) => !existsSync(join(out, 'node_modules', n, 'package.json')),
  );
  if (missing.length > 0)
    fail(`bundles import packages the closure does not ship: ${[...new Set(missing)].join(', ')}`);
  // The host loads bare-sidecar at runtime (createRequire), invisible to esbuild.
  if (!existsSync(join(out, 'node_modules', 'bare-sidecar', 'package.json')))
    fail('bare-sidecar is not shipped');

  normalizeModes(out);

  let files = stats.files;
  let bytes = stats.bytes;
  const count = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (p !== join(out, 'node_modules')) count(p);
      } else {
        files++;
        bytes += statSync(p).size;
      }
    }
  };
  count(out);
  return { out, packages, files, bytes, irohHelper: o.irohHelper !== undefined, externals };
}

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * Slice 5e-5: `--iroh-helper <file>` (resolved), or `null` for `--without-iroh-helper`. Exactly
 * one of them: an app staged without the helper speaks HyperDHT only, which must be a choice,
 * never an omission.
 */
export function irohHelperArg(argv: readonly string[]): string | null {
  const file = arg(argv, '--iroh-helper');
  const without = argv.includes('--without-iroh-helper');
  if (argv.includes('--iroh-helper') && (file === undefined || file.startsWith('--')))
    throw new StageError('--iroh-helper needs a file');
  if (file !== undefined && without)
    throw new StageError('give --iroh-helper <file> or --without-iroh-helper, not both');
  if (file === undefined && !without)
    throw new StageError(
      'give --iroh-helper <file> (crates/iroh-helper, built for the target) or --without-iroh-helper',
    );
  return file === undefined ? null : resolve(file);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const platform = arg(argv, '--platform') ?? process.platform;
  const arch = arg(argv, '--arch') ?? process.arch;
  const out = arg(argv, '--out') ?? join(PKG_DIR, 'out', `stage-${platform}-${arch}`);
  let irohHelper: string | null;
  try {
    irohHelper = irohHelperArg(argv);
  } catch (err) {
    process.stderr.write(`stage: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  stageApp({ out, platform, arch, ...(irohHelper === null ? {} : { irohHelper }) }).then(
    (r) => {
      process.stdout.write(
        `stage: ${r.out}: ${String(r.packages.length)} packages, ${String(r.files)} files, ${(r.bytes / 1e6).toFixed(1)} MB\n`,
      );
    },
    (err: unknown) => {
      process.stderr.write(`stage: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
