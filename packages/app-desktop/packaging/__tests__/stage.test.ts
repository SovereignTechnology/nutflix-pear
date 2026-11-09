/**
 * Issue #6 (ADR 0017): the staged app — what Forge packs into app.asar and what it leaves
 * unpacked. (The staged worker actually booting under the real Bare, through the staged
 * bare-sidecar and the host's supervisor, is src/host/__tests__/packaged-worker.integration.test.ts.)
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PACKAGED_DLEQ_THREAD_ENTRY,
  PACKAGED_WORKER_BUNDLE,
  PACKAGED_WORKER_ENTRY,
  PRELOAD_FILES,
  PROMPT_FILES,
  RENDERER_FILES,
} from '../identity.ts';
import { nameAt, runtimeClosure, type Lockfile } from '../closure.ts';
import { NOT_SHIPPED } from '../identity.ts';
import { PROMPT_NPM } from '../prompt-npm.ts';
import {
  BUNDLE_CONFIG,
  BUNDLE_CONFIG_ROOT,
  BUNDLE_SOURCES,
  PKG_DIR,
  REPO_ROOT,
  StageError,
  WORKER_BOOT_SOURCE,
  assertReplaceable,
  builtFromWorkspaces,
  bundleInputDirs,
  copyPackage,
  normalizeModes,
  npmFilter,
  promptNpmDirs,
  stageApp,
  workspaceFilter,
  type StageReport,
} from '../stage.ts';

let tmp = '';
let a: StageReport;
let b: StageReport;
/** src/worker/worker-root.ts's path (this build-time project cannot import app sources). */
let DLEQ_THREAD_ENTRY_PATH = '';

function walk(root: string): string[] {
  const out: string[] = [];
  const go = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) go(p);
      else out.push(relative(root, p).split('\\').join('/'));
    }
  };
  go(root);
  return out.sort();
}

function treeHash(root: string): string {
  const h = createHash('sha256');
  for (const f of walk(root)) {
    h.update(`${f}\0${(statSync(join(root, f)).mode & 0o777).toString(8)}\0`);
    h.update(readFileSync(join(root, f)));
  }
  return h.digest('hex');
}

beforeAll(async () => {
  const root = join(PKG_DIR, 'src', 'worker', 'worker-root.ts');
  ({ DLEQ_THREAD_ENTRY_PATH } = (await import(/* @vite-ignore */ root)) as {
    DLEQ_THREAD_ENTRY_PATH: string;
  });
  tmp = mkdtempSync(join(tmpdir(), 'nf-stage-'));
  a = await stageApp({ out: join(tmp, 'a'), platform: 'linux', arch: 'x64' });
  b = await stageApp({ out: join(tmp, 'b'), platform: 'linux', arch: 'x64' });
}, 120_000);

afterAll(() => {
  if (tmp !== '') rmSync(tmp, { recursive: true, force: true });
});

describe('stageApp', () => {
  it('is deterministic: two stagings are byte- and mode-identical', () => {
    expect(treeHash(a.out)).toBe(treeHash(b.out));
  });

  it('lays out main, host, renderer, prompt, preloads and the worker like dist/', () => {
    const top = readdirSync(a.out).sort();
    expect(top).toEqual(
      [
        'host',
        'main',
        'node_modules',
        'package.json',
        ...PRELOAD_FILES,
        'prompt',
        'renderer',
        'worker',
      ].sort(),
    );
    expect(readdirSync(join(a.out, 'renderer')).sort()).toEqual([...RENDERER_FILES].sort());
    expect(readdirSync(join(a.out, 'prompt')).sort()).toEqual([...PROMPT_FILES].sort());
    expect(readdirSync(join(a.out, 'main'))).toEqual(['main.js']);
    expect(readdirSync(join(a.out, 'host'))).toEqual(['main.js']);
    // Lane I1: `pay/` joined the worker dir (the DLEQ thread's entry); nothing else did.
    expect(readdirSync(join(a.out, 'worker')).sort()).toEqual(['boot.mjs', 'pay', 'worker.mjs']);
    expect(readdirSync(join(a.out, 'worker', 'pay'))).toEqual(['dleq-thread-entry.mjs']);
    expect(PACKAGED_WORKER_ENTRY).toBe('worker/boot.mjs');
    expect(PACKAGED_WORKER_BUNDLE).toBe('worker/worker.mjs');
    expect(PACKAGED_DLEQ_THREAD_ENTRY).toBe('worker/pay/dleq-thread-entry.mjs');
  });

  it('the DLEQ thread entry is staged where the worker bundle resolves it, inside worker/ (lane I1)', () => {
    const entry = join(a.out, PACKAGED_DLEQ_THREAD_ENTRY);
    expect(lstatSync(entry).isFile()).toBe(true);
    // The bundle resolves it from its own URL (src/worker/worker-root.ts, inlined at its root)…
    const w = readFileSync(join(a.out, PACKAGED_WORKER_BUNDLE), 'utf8');
    expect(w).toContain(`= ${JSON.stringify(DLEQ_THREAD_ENTRY_PATH)};`);
    expect(w).toMatch(/new URL\(DLEQ_THREAD_ENTRY_PATH, import\.meta\.url\)/);
    // …never from a path that climbs out of the worker directory (the gap lane I1 closed).
    expect(w).not.toMatch(/\.\.\/pay\/dleq-thread-entry/);
    const bundleUrl = pathToFileURL(join(a.out, PACKAGED_WORKER_BUNDLE));
    const resolved = fileURLToPath(new URL(DLEQ_THREAD_ENTRY_PATH, bundleUrl));
    expect(resolved).toBe(entry);
    expect(resolved.startsWith(join(a.out, 'worker') + '/')).toBe(true);
  });

  it('the DLEQ thread entry is its own bundle: every import dynamic, npm ones shipped and resolved from node_modules/', () => {
    const e = readFileSync(join(a.out, PACKAGED_DLEQ_THREAD_ENTRY), 'utf8');
    // An exception escaping a Bare thread aborts the worker: nothing may load before its try.
    expect(e).not.toMatch(/^\s*import\s/m);
    expect(e).not.toMatch(/^\s*export\s/m);
    // Our sources inlined (dleq-thread.ts, ipc/codec.ts); no relative load left to miss.
    expect(e).toMatch(/function serveDleqMailbox\(/);
    expect(e).not.toMatch(/import\(\s*["']\.{1,2}\//);
    expect(e).not.toMatch(/node_modules/);
    // D6 first in the thread's own isolate, then core.
    const g = e.indexOf('await import("bare-encoding/global")');
    const c = e.indexOf('await import("@sovit/core")');
    expect(g).toBeGreaterThan(0);
    expect(c).toBeGreaterThan(g);
    expect(a.externals.dleqThread).toEqual(['@sovit/core', 'bare-encoding']);
    // Bare resolves them by walking up from worker/pay/: the first node_modules it meets is the
    // shipped closure at the stage root (none in worker/ or worker/pay/).
    for (const n of a.externals.dleqThread) {
      let dir = dirname(join(a.out, PACKAGED_DLEQ_THREAD_ENTRY));
      let hit: string | undefined;
      for (;;) {
        if (lstatSync(dir).isDirectory() && readdirSync(dir).includes('node_modules')) {
          hit = join(dir, 'node_modules');
          break;
        }
        if (dir === a.out) break;
        dir = dirname(dir);
      }
      expect(hit, n).toBe(join(a.out, 'node_modules'));
      expect(lstatSync(join(a.out, 'node_modules', n, 'package.json')).isFile(), n).toBe(true);
    }
  });

  it('writes a minimal package.json (the Electron version only for Forge; no scripts, no deps)', () => {
    const pj = JSON.parse(readFileSync(join(a.out, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const electron = (
      JSON.parse(
        readFileSync(join(REPO_ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'),
      ) as {
        version: string;
      }
    ).version;
    expect(Object.keys(pj).sort()).toEqual([
      'author',
      'description',
      'devDependencies',
      'license',
      'main',
      'name',
      'productName',
      'type',
      'version',
    ]);
    expect(pj).toMatchObject({
      name: 'nutflix',
      productName: 'Nutflix',
      main: 'main/main.js',
      type: 'module',
    });
    expect(pj['devDependencies']).toEqual({ electron });
  });

  it('the boot module is unbundled and imports bare-encoding/global FIRST (D6), then the bundle', () => {
    const boot = readFileSync(join(a.out, PACKAGED_WORKER_ENTRY), 'utf8');
    expect(boot).toBe(WORKER_BOOT_SOURCE);
    const lines = boot.split('\n').filter((l) => l.trim() !== '');
    expect(lines[0]).toBe("import 'bare-encoding/global'");
    expect(lines[1]).toBe("import('./worker.mjs').catch((e) => {");
  });

  it('the worker bundle holds our sources only; npm packages stay imports Bare resolves', () => {
    const w = readFileSync(join(a.out, PACKAGED_WORKER_BUNDLE), 'utf8');
    expect(w).toMatch(/from "@sovit\/seeder"/);
    expect(w).toMatch(/from "sodium-native"/);
    expect(w).not.toMatch(/node_modules/);
    expect(a.externals.worker).toContain('bare-encoding');
    expect(a.externals.worker).toContain('@sovit/core');
  });

  it('the host bundle inlines its npm code (inside app.asar) but leaves native packages and electron external', () => {
    const h = readFileSync(join(a.out, 'host', 'main.js'), 'utf8');
    expect(h).toMatch(/^import \{ createRequire as __nfCreateRequire \} from 'node:module';/);
    expect(h).toMatch(/node_modules\/nostr-tools\//); // esbuild's path comments of inlined code
    expect(a.externals.host).toEqual(expect.arrayContaining(['sodium-native']));
    expect(a.externals.host).not.toContain('nostr-tools');
    expect(a.externals.host).not.toContain('@sovit/core');
    const m = readFileSync(join(a.out, 'main', 'main.js'), 'utf8');
    expect(m).not.toMatch(/node_modules/);
  });

  it("the host bundle carries none of core's test doubles, stubs in their place, and loads in plain Node (round 4)", () => {
    const h = readFileSync(join(a.out, 'host', 'main.js'), 'utf8');
    // Real core is inlined (the money plane)…
    expect(h).toMatch(/^\/\/ \.\.\/core\/dist\/wallet\/transport\.js$/m);
    // …its test doubles are not: no module of core's mocks/, no FakeRelayPool, only the stubs.
    expect(h).not.toMatch(/^\/\/ \.\.\/core\/dist\/(?:mocks\/|nostr\/fake-relay\.js)/m);
    for (const c of [
      'TestMint',
      'TestLightning',
      'MockWallet',
      'MockPaymentEngine',
      'MockNetworkAdapter',
      'FakeRelayPool',
    ]) {
      expect(h, c).not.toMatch(new RegExp(`\\bclass ${c}\\b`));
      // (esbuild renames the second stub's helper to `__nfRefused2`.)
      expect(h, c).toMatch(new RegExp(`\\bvar ${c} = __nfRefused\\d*\\("${c}"\\);`));
    }
    expect(h).toContain('// nutflix-packaged-test-double:mocks/index.js');
    expect(h).toContain('// nutflix-packaged-test-double:nostr/fake-relay.js');
    expect(h).not.toContain(REPO_ROOT);
    // Its top level runs (no stub is touched at load) and exports the entry main.ts has.
    const url = JSON.stringify(pathToFileURL(join(a.out, 'host', 'main.js')).href);
    const r = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${url}); console.log(Object.keys(m).join());`,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('runHost');
  });

  it('node_modules: workspace packages as real dirs without tests/maps/types; one platform’s prebuilds; no pear-runtime', () => {
    const files = walk(join(a.out, 'node_modules'));
    const sovit = files.filter((f) => f.startsWith('@sovit/'));
    expect(sovit.length).toBeGreaterThan(10);
    for (const f of sovit) {
      expect(f).toMatch(/^@sovit\/(core|seeder|gateway)\/(package\.json|dist\/)/);
      expect(f).not.toMatch(/__tests__|\.map$|\.d\.ts$|\.tsbuildinfo$|\.test\.js$/);
    }
    const prebuildDirs = new Set(
      files.map((f) => /(?:^|\/)prebuilds\/([^/]+)\//.exec(f)?.[1]).filter(Boolean),
    );
    expect([...prebuildDirs]).toEqual(['linux-x64']);
    expect(files.some((f) => f.startsWith('pear-runtime/'))).toBe(false);
    expect(files.some((f) => f.startsWith('electron/') || f.startsWith('typescript/'))).toBe(false);
    expect(a.packages.length).toBeGreaterThan(100);
  });

  it('modes are normalised: dirs 0755, files 0644 or 0755 (the bare runtime stays executable)', () => {
    const bad: string[] = [];
    const go = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        const m = lstatSync(p).mode & 0o7777;
        if (e.isSymbolicLink()) bad.push(`symlink ${p}`);
        else if (e.isDirectory()) {
          if (m !== 0o755) bad.push(`${p} ${m.toString(8)}`);
          go(p);
        } else if (m !== 0o644 && m !== 0o755) bad.push(`${p} ${m.toString(8)}`);
      }
    };
    go(a.out);
    expect(bad).toEqual([]);
    expect(
      statSync(join(a.out, 'node_modules', 'bare-sidecar', 'prebuilds', 'linux-x64', 'bare')).mode &
        0o777,
    ).toBe(0o755);
  });

  it('never deletes a directory it did not make (absent, empty or a previous stage only)', async () => {
    const victim = join(tmp, 'precious');
    mkdirSync(victim);
    writeFileSync(join(victim, 'thesis.txt'), 'years of work');
    await expect(stageApp({ out: victim, platform: 'linux', arch: 'x64' })).rejects.toThrow(
      /refusing to delete/,
    );
    expect(readFileSync(join(victim, 'thesis.txt'), 'utf8')).toBe('years of work');
    expect(() => {
      assertReplaceable(join(tmp, 'absent'));
    }).not.toThrow();
    expect(() => {
      assertReplaceable(a.out);
    }).not.toThrow();
    writeFileSync(join(tmp, 'afile'), 'x');
    expect(() => {
      assertReplaceable(join(tmp, 'afile'));
    }).toThrow(/not a directory/);
  });

  it('refuses to stage without the renderer bundles', async () => {
    const pkg = mkdtempSync(join(tmp, 'pkg-'));
    await expect(
      stageApp({ out: join(tmp, 'c'), platform: 'linux', arch: 'x64', pkgDir: pkg }),
    ).rejects.toThrow(/npm run build/);
  });
});

describe('the build the stage copies must be current (cross-lane review, round 4)', () => {
  it('checks every workspace package the app is built from: core, gateway, seeder shipped; ui bundled', () => {
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8')) as Lockfile;
    const workspace = 'packages/app-desktop';
    const packages = runtimeClosure(lock, {
      workspace,
      exclude: Object.keys(NOT_SHIPPED),
      platform: 'linux',
      arch: 'x64',
    });
    expect(builtFromWorkspaces(lock, workspace, packages)).toEqual({
      shipped: ['packages/core', 'packages/gateway', 'packages/seeder'],
      bundled: ['packages/ui'],
    });
  });

  it('BUNDLE_SOURCES covers every entry point and every file scripts/bundle.ts copies from this package', () => {
    const script = readFileSync(join(PKG_DIR, 'scripts', 'bundle.ts'), 'utf8');
    const entries = [...script.matchAll(/entryPoints:\s*\['([^']+)'\]/g)].map((m) => m[1] ?? '');
    const copies = [...script.matchAll(/copyFile\(\s*join\(pkg,\s*((?:'[^']+',?\s*)+)\)/g)].map(
      (m) => [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]).join('/'),
    );
    expect(entries.sort()).toEqual([
      'src/preload/preload.ts',
      'src/preload/prompt-preload.ts',
      'src/renderer/main.tsx',
      'src/renderer/prompt/prompt.ts',
    ]);
    expect(copies.length).toBe(3); // index.html, prompt.html, prompt.css
    for (const f of [...entries, ...copies])
      expect(
        BUNDLE_SOURCES.some((d) => f.startsWith(`${d}/`)),
        f,
      ).toBe(true);
    // The other two copies are @sovit/ui's stylesheets (ui.css, and shell.css since ADR 0022): a
    // bundled workspace, checked as one.
    expect(script).toMatch(/require\.resolve\('@sovit\/ui\/ui\.css'\)/);
    expect(script).toMatch(/require\.resolve\('@sovit\/ui\/shell\.css'\)/);
  });

  // Lane R6-reconcile (the round-5 verifier): the freshness rule watches the bundle's own
  // configuration too. Every tsconfig the script's builds name is watched, and so is every file
  // those configs extend, followed to the end of the chain. Round 8: and every module the script
  // imports by a relative path (the prompt page's npm allow-list), followed to the end too.
  it('BUNDLE_CONFIG covers scripts/bundle.ts, the modules it imports, every tsconfig it names and everything they extend', () => {
    const script = readFileSync(join(PKG_DIR, 'scripts', 'bundle.ts'), 'utf8');
    const modules: string[] = [];
    for (let queue = [join(PKG_DIR, 'scripts', 'bundle.ts')]; queue.length > 0;) {
      const from = queue.shift() ?? '';
      const text = readFileSync(from, 'utf8');
      for (const m of text.matchAll(/^import\s[^;]*?from\s+'(\.{1,2}\/[^']+)'/gm)) {
        const dep = resolve(dirname(from), m[1] ?? '');
        if (!modules.includes(dep)) {
          modules.push(dep);
          queue.push(dep);
        }
      }
    }
    expect(modules).toEqual([join(PKG_DIR, 'packaging', 'prompt-npm.ts')]);
    const named = [
      ...new Set([...script.matchAll(/tsconfig:\s*'([^']+)'/g)].map((m) => m[1] ?? '')),
    ];
    expect(named.sort()).toEqual(['tsconfig.preload.json', 'tsconfig.renderer.json']);
    const watched = new Set([
      ...BUNDLE_CONFIG.map((f) => join(PKG_DIR, f)),
      ...BUNDLE_CONFIG_ROOT.map((f) => join(REPO_ROOT, f)),
    ]);
    expect(watched.has(join(PKG_DIR, 'scripts', 'bundle.ts'))).toBe(true);
    const chain: string[] = [];
    for (let next of named.map((f) => join(PKG_DIR, f))) {
      for (;;) {
        chain.push(next);
        const read = ts.readConfigFile(next, (f) => ts.sys.readFile(f));
        expect(read.error).toBeUndefined();
        const ext = (read.config as { extends?: unknown }).extends;
        if (ext === undefined) break;
        expect(typeof ext).toBe('string'); // one parent, a relative path
        next = resolve(dirname(next), ext as string);
      }
    }
    for (const f of [...chain, ...modules])
      expect(watched.has(f), relative(REPO_ROOT, f)).toBe(true);
    expect(chain).toContain(join(REPO_ROOT, 'tsconfig.base.json'));
    // Nothing watched that the bundle does not read.
    expect([...watched].sort()).toEqual(
      [...new Set([join(PKG_DIR, 'scripts', 'bundle.ts'), ...modules, ...chain])].sort(),
    );
  });

  // Cross-lane review round 5: the freshness rule watched ui's src/, but the bundle reads ui's
  // dist/ (74 inputs under packages/ui/dist, none under src/), so a bundle made from an old
  // ui/dist staged. This pins the watched set against what the renderer bundle actually reads.
  it('bundleInputDirs covers every workspace file the renderer bundle reads and the ui stylesheet it copies', async () => {
    const script = readFileSync(join(PKG_DIR, 'scripts', 'bundle.ts'), 'utf8');
    // The build below resolves as scripts/bundle.ts's renderer build does: same entry, tsconfig
    // and platform, and no resolution overrides in the script.
    const renderer = /async function bundleRenderer\(\)[\s\S]*?\n\}\n/.exec(script)?.[0] ?? '';
    expect(renderer).toContain("entryPoints: ['src/renderer/main.tsx']");
    expect(renderer).toContain("platform: 'browser'");
    expect(renderer).toContain("tsconfig: 'tsconfig.renderer.json'");
    expect(script).not.toMatch(/\b(?:conditions|mainFields|alias|nodePaths|preserveSymlinks):/);
    const r = await build({
      absWorkingDir: PKG_DIR,
      entryPoints: ['src/renderer/main.tsx'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      jsx: 'automatic',
      tsconfig: 'tsconfig.renderer.json',
      metafile: true,
      logLevel: 'silent',
    });
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8')) as Lockfile;
    const packages = runtimeClosure(lock, {
      workspace: 'packages/app-desktop',
      exclude: Object.keys(NOT_SHIPPED),
      platform: 'linux',
      arch: 'x64',
    });
    const { bundled } = builtFromWorkspaces(lock, 'packages/app-desktop', packages);
    const dirs = bundleInputDirs(PKG_DIR, REPO_ROOT, bundled);
    const covered = (p: string): boolean => dirs.some((d) => p.startsWith(d + sep));
    const ours = Object.keys(r.metafile.inputs)
      .map((p) => resolve(PKG_DIR, p))
      .filter((p) => !p.split(sep).includes('node_modules'));
    const uiDist = join(REPO_ROOT, 'packages', 'ui', 'dist') + sep;
    expect(ours.filter((p) => p.startsWith(uiDist)).length).toBeGreaterThan(0);
    expect(ours.filter((p) => !covered(p))).toEqual([]);
    // The copied stylesheet, resolved as scripts/bundle.ts resolves it.
    const css = realpathSync(
      createRequire(join(PKG_DIR, 'scripts', 'bundle.ts')).resolve('@sovit/ui/ui.css'),
    );
    expect(css).toBe(join(uiDist, 'ui.css'));
    expect(covered(css)).toBe(true);
  });

  // Round 8 (final panel, packaging): the prompt page inlines @scure/bip39 and the two packages
  // it is built on, and rule 3 did not watch them (this file's other pins filter node_modules
  // out on purpose). The watched directories are pinned against what the real prompt bundle
  // reads: every npm input lies in one of them, at no deeper node_modules, and each is read.
  it('promptNpmDirs covers every npm file the real prompt bundle reads, and nothing it does not', async () => {
    const script = readFileSync(join(PKG_DIR, 'scripts', 'bundle.ts'), 'utf8');
    const prompt = /async function bundlePrompt\(\)[\s\S]*?\n\}\n/.exec(script)?.[0] ?? '';
    expect(prompt).toContain("entryPoints: ['src/renderer/prompt/prompt.ts']");
    expect(prompt).toContain("platform: 'browser'");
    expect(prompt).toContain("tsconfig: 'tsconfig.renderer.json'");
    const r = await build({
      absWorkingDir: PKG_DIR,
      entryPoints: ['src/renderer/prompt/prompt.ts'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      tsconfig: 'tsconfig.renderer.json',
      metafile: true,
      logLevel: 'silent',
    });
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8')) as Lockfile;
    const dirs = promptNpmDirs(lock, 'packages/app-desktop');
    expect(dirs.map(nameAt).sort()).toEqual([...PROMPT_NPM].sort());
    const abs = dirs.map((d) => join(REPO_ROOT, d) + sep);
    const npm = Object.keys(r.metafile.inputs)
      .map((p) => resolve(PKG_DIR, p))
      .filter((p) => p.split(sep).includes('node_modules'));
    expect(npm.length).toBeGreaterThan(0);
    const read = new Set<string>();
    for (const p of npm) {
      // The deepest watched directory holding it, with no node_modules below that.
      const home = abs.filter((d) => p.startsWith(d)).sort((x, y) => y.length - x.length)[0];
      expect(home, relative(REPO_ROOT, p)).toBeDefined();
      expect(p.slice(home?.length ?? 0).split(sep), relative(REPO_ROOT, p)).not.toContain(
        'node_modules',
      );
      read.add(home ?? '');
    }
    expect([...read].sort()).toEqual([...abs].sort());
  });
});

describe('copyPackage / filters / normalizeModes', () => {
  it('refuses a symlink inside a shipped package', () => {
    const src = join(tmp, 'pkg-with-link');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'package.json'), '{}');
    symlinkSync('/etc/passwd', join(src, 'evil'));
    expect(() => {
      copyPackage(src, join(tmp, 'dst-link'), () => true, { files: 0, bytes: 0 });
    }).toThrow(StageError);
    expect(() => {
      copyPackage(src, join(tmp, 'dst-link2'), () => true, { files: 0, bytes: 0 });
    }).toThrow(/symlink in a shipped package is refused/);
  });

  it('npmFilter drops nested node_modules and other platforms’ prebuilds', () => {
    const f = npmFilter('linux', 'x64');
    expect(f('node_modules', true)).toBe(false);
    expect(f('lib/node_modules/x.js', false)).toBe(false);
    expect(f('prebuilds/linux-x64', true)).toBe(true);
    expect(f('prebuilds/win32-x64', true)).toBe(false);
    expect(f('prebuilds', true)).toBe(true);
    expect(f('index.js', false)).toBe(true);
  });

  it('workspaceFilter keeps package.json and `files`, never tests, maps or declarations', () => {
    const f = workspaceFilter(['dist']);
    expect(f('package.json', false)).toBe(true);
    expect(f('src', true)).toBe(false);
    expect(f('tsconfig.json', false)).toBe(false);
    expect(f('dist', true)).toBe(true);
    expect(f('dist/index.js', false)).toBe(true);
    for (const x of [
      'dist/__tests__',
      'dist/index.js.map',
      'dist/index.d.ts',
      'dist/a.test.js',
      'dist/node_modules',
    ])
      expect(f(x, x.endsWith('__tests__') || x.endsWith('node_modules')), x).toBe(false);
  });

  it('normalizeModes: 0775 dir → 0755, 0664 file → 0644, 0775 file → 0755', () => {
    const d = join(tmp, 'modes');
    mkdirSync(join(d, 'sub'), { recursive: true });
    writeFileSync(join(d, 'sub', 'f'), 'x');
    writeFileSync(join(d, 'sub', 'x'), 'x');
    chmodSync(join(d, 'sub'), 0o775);
    chmodSync(join(d, 'sub', 'f'), 0o664);
    chmodSync(join(d, 'sub', 'x'), 0o775);
    normalizeModes(d);
    expect(statSync(join(d, 'sub')).mode & 0o777).toBe(0o755);
    expect(statSync(join(d, 'sub', 'f')).mode & 0o777).toBe(0o644);
    expect(statSync(join(d, 'sub', 'x')).mode & 0o777).toBe(0o755);
  });
});
