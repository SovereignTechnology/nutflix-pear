/**
 * Issue #6 (ADR 0017): the Forge config, its two hooks (flip fuses + strip the staging-only
 * devDependencies after copy; read the fuses back + check the layout after packaging), the
 * layout rules, the CLI's argument parser, and the constants that must agree with the app.
 */
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPackageWithOptions } from '@electron/asar';
import type { ResolvedForgeConfig } from '@electron-forge/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { madeList, parseCli, writeMadeList } from '../cli.ts';
import { LINUX_ICON, TARGETS, forgeConfig, makers } from '../forge-config.ts';
import { assertAppFuses } from '../fuses.ts';
import {
  MADE_LIST_SCHEMA,
  MADE_LIST_SUFFIX,
  NOT_SHIPPED,
  PACKAGED_DLEQ_THREAD_ENTRY,
  PACKAGED_IROH_HELPER,
  PACKAGED_WORKER_BUNDLE,
  PACKAGED_WORKER_ENTRY,
  PRELOAD_FILES,
  PROMPT_FILES,
  RENDERER_FILES,
  UNPACKED_DIRS,
  UNPACKED_FILES,
  packagedIrohHelper,
} from '../identity.ts';
import { PACKED, layoutProblems } from '../layout.ts';
import { PKG_DIR } from '../stage.ts';

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const fakeElectron = (): Buffer =>
  Buffer.concat([
    Buffer.alloc(64),
    Buffer.from(SENTINEL),
    Buffer.from([1, 9, 49, 48, 49, 49, 48, 48, 48, 49, 49]),
    Buffer.alloc(64),
  ]);

const cfg = forgeConfig({
  version: '0.1.0',
  electronChecksums: { 'electron-v44.2.0-linux-x64.zip': 'ab'.repeat(32) },
  appImageRuntimeDir: '/rt',
});
const resolved = cfg as unknown as ResolvedForgeConfig;

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nf-forge-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('forgeConfig', () => {
  it('packages from app.asar with the worker, node_modules and the iroh helper unpacked, unsigned, nothing rebuilt', () => {
    const p = cfg.packagerConfig ?? {};
    expect(p.asar).toEqual({ unpackDir: '{worker,node_modules,iroh}' });
    expect(UNPACKED_DIRS).toEqual(['worker', 'node_modules', 'iroh']);
    expect(p.prune).toBe(false);
    expect(p.executableName).toBe('nutflix');
    expect(p.name).toBe('Nutflix');
    // Every Electron zip checked against the lockfile-pinned electron package's sha256 list.
    expect(p.download).toEqual({
      checksums: { 'electron-v44.2.0-linux-x64.zip': 'ab'.repeat(32) },
    });
    // Platform signing is deliberately absent (ADR 0017): releases are Nostr-signed instead.
    for (const k of ['osxSign', 'osxNotarize', 'windowsSign']) expect(p).not.toHaveProperty(k);
    expect(cfg.rebuildConfig).toEqual({ onlyModules: [] });
    expect(cfg.plugins).toEqual([]);
  });

  it('has one maker per target, each on its own platform', () => {
    const m = makers({
      version: '0.1.0',
      electronChecksums: {},
      appImageRuntimeDir: '/rt',
    }) as unknown as {
      name: string;
      platforms: string[];
    }[];
    expect(m.map((x) => [x.name, x.platforms])).toEqual([
      ['squirrel', ['win32']],
      ['dmg', ['darwin']],
      ['deb', ['linux']],
      ['appimage', ['linux']],
    ]);
    expect(TARGETS).toEqual(['squirrel', 'dmg', 'deb', 'appimage']);
    const only = makers({
      version: '0.1.0',
      electronChecksums: {},
      appImageRuntimeDir: '/rt',
      targets: ['deb'],
    }) as unknown as { name: string }[];
    expect(only.map((x) => x.name)).toEqual(['deb']);
  });

  it('the Squirrel Setup.exe carries the version (a stale one of another version is refused by the manifest)', async () => {
    const [sq] = makers({
      version: '0.1.0',
      electronChecksums: {},
      appImageRuntimeDir: '/rt',
      targets: ['squirrel'],
    }) as unknown as {
      config: { setupExe: string; exe: string; noMsi: boolean };
      prepareConfig(a: string): Promise<void>;
    }[];
    await sq?.prepareConfig('x64');
    expect(sq?.config).toMatchObject({
      setupExe: 'Nutflix-0.1.0-Setup.exe',
      exe: 'nutflix.exe',
      noMsi: true,
    });
    for (const bad of ['', '0.1.0 beta', '../1', '1/2'])
      expect(() =>
        makers({ version: bad, electronChecksums: {}, appImageRuntimeDir: '/rt' }),
      ).toThrow(/not a plain version/);
  });

  // ADR 0017 Q2 (Cameron, 2026-10-02): a neutral placeholder icon until a brand one exists.
  it('both Linux makers carry the placeholder icon, a 512x512 PNG', async () => {
    interface Prepared {
      prepareConfig(a: string): Promise<void>;
    }
    const [deb, appimage] = makers({
      version: '0.1.0',
      electronChecksums: {},
      appImageRuntimeDir: '/rt',
      targets: ['deb', 'appimage'],
    }) as unknown as [
      Prepared & { config: { options: Record<string, unknown> } },
      Prepared & { config: Record<string, unknown> },
    ];
    await deb.prepareConfig('x64');
    await appimage.prepareConfig('x64');
    expect(deb.config.options['icon']).toBe(LINUX_ICON);
    expect(appimage.config['icon']).toBe(LINUX_ICON);
    const png = readFileSync(LINUX_ICON);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.toString('latin1', 12, 16)).toBe('IHDR');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([512, 512]);
  });

  // Independent review: the old name said the sandbox setup was left to a decision; in fact the
  // package ships chrome-sandbox setuid root through its file modes (no maintainer script).
  it('the .deb has no maintainer scripts; its chrome-sandbox is setuid root by file mode (ADR 0017 §7)', async () => {
    const deb = makers({
      version: '0.1.0',
      electronChecksums: {},
      appImageRuntimeDir: '/rt',
      targets: ['deb'],
    })[0] as unknown as {
      config: { options: Record<string, unknown> };
    };
    await (deb as unknown as { prepareConfig(a: string): Promise<void> }).prepareConfig('x64');
    expect(deb.config.options).not.toHaveProperty('scripts');
    expect(deb.config.options['bin']).toBe('nutflix');
    // What electron-installer-debian does to the staged helper (via electron-installer-common):
    // 4755. dpkg then installs it root-owned with that mode — the Linux sandbox's SUID route.
    const common = createRequire(
      createRequire(import.meta.url).resolve('electron-installer-debian'),
    )('electron-installer-common') as {
      updateSandboxHelperPermissions(dir: string): Promise<unknown>;
    };
    writeFileSync(join(root, 'chrome-sandbox'), 'helper');
    chmodSync(join(root, 'chrome-sandbox'), 0o755);
    await common.updateSandboxHelperPermissions(root);
    expect(statSync(join(root, 'chrome-sandbox')).mode & 0o7777).toBe(0o4755);
  });

  it('packageAfterCopy flips the six fuses and drops the staging-only devDependencies', async () => {
    const app = join(root, 'Nutflix-linux-x64');
    const buildPath = join(app, 'resources', 'app');
    mkdirSync(buildPath, { recursive: true });
    writeFileSync(join(app, 'electron'), fakeElectron());
    writeFileSync(
      join(buildPath, 'package.json'),
      JSON.stringify({
        name: 'nutflix',
        main: 'main/main.js',
        devDependencies: { electron: '44.2.0' },
      }),
    );
    const hook = cfg.hooks?.packageAfterCopy;
    await hook?.(resolved, buildPath, '44.2.0', 'linux', 'x64');
    expect(JSON.parse(readFileSync(join(buildPath, 'package.json'), 'utf8'))).toEqual({
      name: 'nutflix',
      main: 'main/main.js',
    });
    await expect(assertAppFuses(join(app, 'electron'))).resolves.toBeUndefined();
    // …and postPackage accepts that binary in a correctly laid-out package.
    const out = await fakeOutput();
    copyFileSync(join(app, 'electron'), join(out, 'nutflix'));
    await expect(
      cfg.hooks?.postPackage?.(resolved, { platform: 'linux', arch: 'x64', outputPaths: [out] }),
    ).resolves.toBeUndefined();
  });

  it('postPackage refuses a binary whose fuses were never flipped', async () => {
    const out = join(root, 'Nutflix-linux-x64');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'nutflix'), fakeElectron());
    await expect(
      cfg.hooks?.postPackage?.(resolved, { platform: 'linux', arch: 'x64', outputPaths: [out] }),
    ).rejects.toThrow(/fuses wrong/);
  });
});

/**
 * A small packaged output: app.asar (+ .unpacked) laid out the way the real one is. Every
 * `PACKED` file is written (independent review: the list now covers the prompt window, both
 * preloads and renderer/index.html, so the fixture follows it instead of a fixed five).
 */
async function fakeOutput(
  mutate: (src: string) => void = () => undefined,
  name = 'Nutflix-linux-x64',
): Promise<string> {
  const src = join(root, 'src');
  // Lane I1: every unpacked file the layout requires (the DLEQ thread entry joined the two).
  for (const f of [...PACKED, ...UNPACKED_FILES]) {
    mkdirSync(join(src, f, '..'), { recursive: true });
    writeFileSync(join(src, f), f);
  }
  const bin = join(src, 'node_modules', 'bare-sidecar', 'prebuilds', 'linux-x64');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'bare'), '#!/bin/sh\n');
  chmodSync(join(bin, 'bare'), 0o755);
  mutate(src);
  const out = join(root, 'packaged', name);
  mkdirSync(join(out, 'resources'), { recursive: true });
  await createPackageWithOptions(src, join(out, 'resources', 'app.asar'), {
    unpackDir: '{worker,node_modules,iroh}',
  });
  return out;
}

/** `fakeOutput` reuses one source tree per test: a helper an earlier call staged goes. */
function noHelper(src: string): void {
  rmSync(join(src, 'iroh'), { recursive: true, force: true });
}

/** Slice 5e-5: a staged iroh helper (any executable will do for the layout). */
function withHelper(src: string): void {
  mkdirSync(join(src, 'iroh'), { recursive: true });
  writeFileSync(join(src, PACKAGED_IROH_HELPER), '#!/bin/sh\n');
  chmodSync(join(src, PACKAGED_IROH_HELPER), 0o755);
}

describe('layoutProblems', () => {
  it('accepts code packed, worker + runtime unpacked and executable', async () => {
    expect(layoutProblems(await fakeOutput(), 'linux', 'x64', 'Nutflix')).toEqual([]);
  });

  it('slice 5e-5: a build staged with the iroh helper must ship it unpacked and executable', async () => {
    expect(PACKAGED_IROH_HELPER).toBe('iroh/nutflix-iroh-helper');
    expect(packagedIrohHelper('win32')).toBe('iroh/nutflix-iroh-helper.exe');
    expect(packagedIrohHelper('linux')).toBe(PACKAGED_IROH_HELPER);
    const good = await fakeOutput(withHelper, 'Good');
    expect(layoutProblems(good, 'linux', 'x64', 'Nutflix', true)).toEqual([]);
    // Without the helper expected, its absence is fine (a --without-iroh-helper build)…
    expect(layoutProblems(await fakeOutput(noHelper, 'None'), 'linux', 'x64', 'Nutflix')).toEqual(
      [],
    );
    // …but a build that staged it may not lose it, nor ship it unusable.
    expect(
      layoutProblems(await fakeOutput(noHelper, 'Lost'), 'linux', 'x64', 'Nutflix', true),
    ).toEqual(['iroh/nutflix-iroh-helper is not unpacked']);
    const plain = await fakeOutput((src) => {
      withHelper(src);
      chmodSync(join(src, PACKAGED_IROH_HELPER), 0o644);
    }, 'Plain');
    expect(layoutProblems(plain, 'linux', 'x64', 'Nutflix', true)).toEqual([
      'iroh/nutflix-iroh-helper is not executable',
    ]);
    const linked = await fakeOutput(withHelper, 'Linked');
    const shipped = join(linked, 'resources', 'app.asar.unpacked', PACKAGED_IROH_HELPER);
    const outside = join(root, 'outside-helper');
    writeFileSync(outside, '#!/bin/sh\n');
    chmodSync(outside, 0o755);
    rmSync(shipped);
    symlinkSync(outside, shipped);
    expect(layoutProblems(linked, 'linux', 'x64', 'Nutflix', true)).toEqual([
      'iroh/nutflix-iroh-helper is a symlink; it must be a regular file',
    ]);
  });

  it('flags a non-executable runtime, another platform’s runtime, a missing boot module, an app/ folder', async () => {
    const out = await fakeOutput((src) => {
      chmodSync(join(src, 'node_modules', 'bare-sidecar', 'prebuilds', 'linux-x64', 'bare'), 0o644);
      mkdirSync(join(src, 'node_modules', 'bare-sidecar', 'prebuilds', 'win32-x64'));
      writeFileSync(
        join(src, 'node_modules', 'bare-sidecar', 'prebuilds', 'win32-x64', 'bare.exe'),
        'x',
      );
      rmSync(join(src, 'worker', 'boot.mjs'));
    });
    mkdirSync(join(out, 'resources', 'app'));
    const p = layoutProblems(out, 'linux', 'x64', 'Nutflix').join('\n');
    expect(p).toMatch(/not executable/);
    expect(p).toMatch(/other platforms' Bare runtimes shipped: win32-x64/);
    expect(p).toMatch(/worker\/boot\.mjs is not unpacked/);
    expect(p).toMatch(/resources[\\/]app exists/);
  });

  it('requires the DLEQ thread entry unpacked as a regular file: missing, a symlink or a directory is refused (lane I1)', async () => {
    expect(UNPACKED_FILES).toEqual([
      PACKAGED_WORKER_ENTRY,
      PACKAGED_WORKER_BUNDLE,
      PACKAGED_DLEQ_THREAD_ENTRY,
    ]);
    const missing = await fakeOutput((src) => {
      rmSync(join(src, PACKAGED_DLEQ_THREAD_ENTRY));
    }, 'Missing');
    expect(layoutProblems(missing, 'linux', 'x64', 'Nutflix')).toEqual([
      'worker/pay/dleq-thread-entry.mjs is not unpacked',
    ]);
    // Swapped in after packing (asar would otherwise record the link in its header).
    const unpackedEntry = (out: string): string =>
      join(out, 'resources', 'app.asar.unpacked', PACKAGED_DLEQ_THREAD_ENTRY);
    const linked = await fakeOutput(undefined, 'Linked');
    const outside = join(root, 'outside.mjs');
    writeFileSync(outside, 'x');
    rmSync(unpackedEntry(linked));
    symlinkSync(outside, unpackedEntry(linked));
    expect(layoutProblems(linked, 'linux', 'x64', 'Nutflix')).toEqual([
      'worker/pay/dleq-thread-entry.mjs is a symlink; it must be a regular file',
    ]);
    const dir = await fakeOutput(undefined, 'Dir');
    rmSync(unpackedEntry(dir));
    mkdirSync(unpackedEntry(dir));
    expect(layoutProblems(dir, 'linux', 'x64', 'Nutflix')).toEqual([
      'worker/pay/dleq-thread-entry.mjs is not a regular file',
    ]);
    // A symlinked directory on the way leads out as surely as a symlinked file.
    const linkedDir = await fakeOutput(undefined, 'LinkedDir');
    const pay = join(linkedDir, 'resources', 'app.asar.unpacked', 'worker', 'pay');
    const elsewhere = join(root, 'elsewhere-pay');
    mkdirSync(elsewhere);
    copyFileSync(join(pay, 'dleq-thread-entry.mjs'), join(elsewhere, 'dleq-thread-entry.mjs'));
    rmSync(pay, { recursive: true });
    symlinkSync(elsewhere, pay);
    expect(layoutProblems(linkedDir, 'linux', 'x64', 'Nutflix')).toEqual([
      'worker/pay/dleq-thread-entry.mjs: worker/pay/ is a symlink; it must be a real directory',
    ]);
    // The boot module and the bundle are held to the same rule.
    const linkedBoot = await fakeOutput(undefined, 'LinkedBoot');
    const boot = join(linkedBoot, 'resources', 'app.asar.unpacked', PACKAGED_WORKER_ENTRY);
    rmSync(boot);
    symlinkSync(outside, boot);
    expect(layoutProblems(linkedBoot, 'linux', 'x64', 'Nutflix')).toEqual([
      'worker/boot.mjs is a symlink; it must be a regular file',
    ]);
  });

  it('PACKED covers main, host, both preloads, and every app-window and prompt-window file', () => {
    expect([...PACKED].sort()).toEqual(
      [
        'package.json',
        'main/main.js',
        'host/main.js',
        ...PRELOAD_FILES,
        ...RENDERER_FILES.map((f) => `renderer/${f}`),
        ...PROMPT_FILES.map((f) => `prompt/${f}`),
      ].sort(),
    );
    for (const f of ['renderer/index.html', 'prompt/prompt.html', 'prompt-preload.cjs'])
      expect(PACKED).toContain(f);
  });

  it('flags a prompt-window or app-window file missing from the archive', async () => {
    const out = await fakeOutput((src) => {
      rmSync(join(src, 'prompt', 'prompt.html'));
      rmSync(join(src, 'renderer', 'index.html'));
      rmSync(join(src, 'prompt-preload.cjs'));
    });
    const p = layoutProblems(out, 'linux', 'x64', 'Nutflix').join('\n');
    expect(p).toMatch(/prompt\/prompt\.html is not in app\.asar/);
    expect(p).toMatch(/renderer\/index\.html is not in app\.asar/);
    expect(p).toMatch(/prompt-preload\.cjs is not in app\.asar/);
  });

  it('flags host code outside the archive', async () => {
    const src = join(root, 'src2');
    mkdirSync(join(src, 'host'), { recursive: true });
    writeFileSync(join(src, 'host', 'main.js'), 'x');
    const out = join(root, 'Out');
    mkdirSync(join(out, 'resources'), { recursive: true });
    await createPackageWithOptions(src, join(out, 'resources', 'app.asar'), { unpackDir: 'host' });
    const p = layoutProblems(out, 'linux', 'x64', 'Nutflix').join('\n');
    expect(p).toMatch(/host\/main\.js is unpacked; it must be inside app\.asar/);
    expect(p).toMatch(/main\/main\.js is not in app\.asar/);
    expect(layoutProblems(join(root, 'none'), 'linux', 'x64', 'Nutflix')[0]).toMatch(
      /app\.asar is missing/,
    );
  });
});

describe('parseCli', () => {
  it('parses the three commands and defaults to this machine', () => {
    const o = parseCli([
      'make',
      '--targets',
      'deb,appimage',
      '--platform',
      'linux',
      '--iroh-helper',
      'bin/helper',
      '--arch',
      'x64',
    ]);
    expect(o).toMatchObject({
      command: 'make',
      platform: 'linux',
      arch: 'x64',
      targets: ['deb', 'appimage'],
      irohHelper: resolve('bin/helper'),
    });
    expect(o.out).toBe(join(PKG_DIR, 'out'));
    expect(o.appImageRuntimeDir).toBe(join(PKG_DIR, 'out', 'appimage-runtime'));
    const bare = parseCli(['stage', '--without-iroh-helper']);
    expect(bare.targets).toBeUndefined();
    expect(bare.irohHelper).toBeNull();
    expect(parseCli(['make', '--without-iroh-helper', '--arch', 'x64']).arch).toBe('x64');
  });

  it('slice 5e-5: the iroh helper is a choice, never an omission', () => {
    expect(() => parseCli(['stage'])).toThrow(/--iroh-helper <file>.*or --without-iroh-helper/);
    expect(() => parseCli(['stage', '--iroh-helper', 'h', '--without-iroh-helper'])).toThrow(
      /not both/,
    );
    expect(() => parseCli(['stage', '--iroh-helper'])).toThrow(/incomplete|needs a file/);
    expect(() => parseCli(['stage', '--iroh-helper', '--without-iroh-helper'])).toThrow();
  });

  it('refuses unknown commands, options, platforms, arches and targets', () => {
    expect(() => parseCli([])).toThrow(/usage/);
    expect(() => parseCli(['publish'])).toThrow(/usage/);
    expect(() => parseCli(['make', '--without-iroh-helper', '--sign', 'yes'])).toThrow(
      /unknown or incomplete option --sign/,
    );
    expect(() => parseCli(['make', '--platform'])).toThrow(/incomplete/);
    expect(() => parseCli(['make', '--platform', 'freebsd'])).toThrow(/--platform/);
    expect(() => parseCli(['make', '--arch', 'ia32'])).toThrow(/--arch/);
    expect(() => parseCli(['make', '--targets', 'deb,snap'])).toThrow(/unknown target snap/);
  });
});

describe('madeList / writeMadeList (what one make produced, for release-manifest --made)', () => {
  it('lists the artifacts relative to out/make, sorted, with platform, arch and version', () => {
    const make = join(root, 'out', 'make');
    const list = madeList(make, 'linux', 'x64', '0.1.0', [
      join(make, 'deb', 'x64', 'nutflix_0.1.0_amd64.deb'),
      join(make, 'appimage', 'x64', 'Nutflix-0.1.0-x64.AppImage'),
    ]);
    expect(list).toEqual({
      schema: MADE_LIST_SCHEMA,
      platform: 'linux',
      arch: 'x64',
      version: '0.1.0',
      artifacts: ['appimage/x64/Nutflix-0.1.0-x64.AppImage', 'deb/x64/nutflix_0.1.0_amd64.deb'],
    });
    mkdirSync(make, { recursive: true });
    const file = writeMadeList(make, list);
    expect(file).toBe(join(make, `linux-x64${MADE_LIST_SUFFIX}`));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(list);
  });

  it('refuses an artifact outside out/make', () => {
    const make = join(root, 'out', 'make');
    for (const bad of [join(root, 'elsewhere.deb'), make, join(make, '..', 'x.deb')])
      expect(() => madeList(make, 'linux', 'x64', '0.1.0', [bad]), bad).toThrow(/outside/);
  });
});

describe('constants that must agree with the app (this code cannot import it at runtime)', () => {
  it('the packaged worker entry, the renderer/prompt file lists', async () => {
    const argsPath = join(PKG_DIR, 'src', 'main', 'args.ts');
    const args = (await import(/* @vite-ignore */ argsPath)) as {
      PACKAGED_WORKER_ENTRY: string;
      PACKAGED_IROH_HELPER: string;
    };
    expect(PACKAGED_WORKER_ENTRY).toBe(args.PACKAGED_WORKER_ENTRY);
    expect(PACKAGED_IROH_HELPER).toBe(args.PACKAGED_IROH_HELPER);
    const protoPath = join(PKG_DIR, 'src', 'main', 'app-protocol.ts');
    const proto = (await import(/* @vite-ignore */ protoPath)) as {
      APP_FILES: readonly string[];
      PROMPT_FILES: readonly string[];
    };
    expect([...RENDERER_FILES]).toEqual([...proto.APP_FILES]);
    expect([...PROMPT_FILES]).toEqual([...proto.PROMPT_FILES]);
    expect(PRELOAD_FILES).toEqual(['preload.cjs', 'prompt-preload.cjs']);
  });

  it('the DLEQ thread entry: where the worker bundle resolves it from its root module (lane I1)', async () => {
    const rootPath = join(PKG_DIR, 'src', 'worker', 'worker-root.ts');
    const wr = (await import(/* @vite-ignore */ rootPath)) as {
      DLEQ_THREAD_ENTRY_PATH: string;
      DLEQ_THREAD_ENTRY: URL;
      WORKER_ROOT: URL;
    };
    // The packaged bundle inlines worker-root.ts, so its import.meta.url is the bundle's.
    const app = join(root, 'app.asar.unpacked');
    const bundle = pathToFileURL(join(app, PACKAGED_WORKER_BUNDLE));
    expect(new URL(wr.DLEQ_THREAD_ENTRY_PATH, bundle).href).toBe(
      pathToFileURL(join(app, PACKAGED_DLEQ_THREAD_ENTRY)).href,
    );
    // Only paths under the worker root: the entry can never resolve outside its directory.
    expect(wr.DLEQ_THREAD_ENTRY_PATH.startsWith('./')).toBe(true);
    expect(wr.DLEQ_THREAD_ENTRY_PATH).not.toMatch(/\.\.|\\|^\/|:/);
    expect(wr.DLEQ_THREAD_ENTRY.href.startsWith(wr.WORKER_ROOT.href)).toBe(true);
    // Unbundled (tsc output, and vitest's own src/ run), the same relation holds.
    expect(wr.WORKER_ROOT.href).toBe(pathToFileURL(join(PKG_DIR, 'src', 'worker') + '/').href);
    expect(wr.DLEQ_THREAD_ENTRY.href).toBe(
      pathToFileURL(join(PKG_DIR, 'src', 'worker', 'pay', 'dleq-thread-entry.mjs')).href,
    );
  });

  it('NOT_SHIPPED names real dependencies, and no runtime source imports pear-runtime', () => {
    const pj = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    for (const n of Object.keys(NOT_SHIPPED)) expect(pj.dependencies, n).toHaveProperty([n]);
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== '__tests__') walk(p);
        } else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) {
          if (/(?:from|import\(|require\()\s*['"]pear-runtime['"]/.test(readFileSync(p, 'utf8')))
            offenders.push(p);
        }
      }
    };
    walk(join(PKG_DIR, 'src'));
    expect(offenders).toEqual([]);
  });
});
