/**
 * Issue #6 (ADR 0017): the in-repo AppImage and .dmg makers. The AppImage maker refuses any
 * runtime but the pinned one and writes an AppDir whose AppRun IS the Electron binary (no
 * wrapper, no `--no-sandbox`); its whole pipeline runs here with a fixture runtime and the
 * system `mksquashfs`. The .dmg maker is macOS-only: its argv is pinned here.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MakerOptions } from '@electron-forge/maker-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FreedesktopError } from '../freedesktop.ts';
import {
  APPIMAGE_RUNTIMES,
  AppImageError,
  MakerAppImage,
  appImageDesktopEntry,
  mksquashfsArgs,
  pinnedRuntime,
} from '../maker-appimage.ts';
import { MakerDmg, dmgCommands } from '../maker-dmg.ts';

const has = (bin: string): boolean => spawnSync('which', [bin]).status === 0;

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nf-makers-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('pinnedRuntime', () => {
  it('pins the dated type2-runtime release for x64 and arm64', () => {
    expect(Object.keys(APPIMAGE_RUNTIMES).sort()).toEqual(['arm64', 'x64']);
    for (const p of Object.values(APPIMAGE_RUNTIMES)) expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(APPIMAGE_RUNTIMES['x64']?.asset).toBe('runtime-x86_64');
  });

  it('refuses a missing runtime (with instructions), a wrong one, and an unknown arch; accepts the pinned bytes', () => {
    expect(() => pinnedRuntime(root, 'x64')).toThrow(/runtime missing.*Nothing is downloaded/s);
    writeFileSync(join(root, 'runtime-x86_64'), 'not the runtime');
    expect(() => pinnedRuntime(root, 'x64')).toThrow(/refused/);
    expect(() => pinnedRuntime(root, 'ia32')).toThrow(AppImageError);
    const bytes = Buffer.from('fixture runtime');
    writeFileSync(join(root, 'fixture'), bytes);
    const pins = {
      x64: { asset: 'fixture', sha256: createHash('sha256').update(bytes).digest('hex') },
    };
    expect(Buffer.from(pinnedRuntime(root, 'x64', pins))).toEqual(bytes);
  });
});

describe('appImageDesktopEntry / mksquashfsArgs', () => {
  it('runs the binary itself: no wrapper, no sandbox switch; named and classed by the app id', () => {
    const d = appImageDesktopEntry('0.1.0');
    expect(d).toContain('Exec=nutflix %U\n');
    expect(d).not.toMatch(/no-sandbox|disable-setuid|--/);
    expect(d).toContain('Icon=pro.sovtech.Nutflix\n');
    expect(d).toContain('StartupWMClass=pro.sovtech.Nutflix\n');
    expect(d).toContain('Categories=AudioVideo;Video;Network;\n');
    expect(d.endsWith('X-AppImage-Version=0.1.0\n')).toBe(true);
  });

  it('refuses a value that would inject a line', () => {
    expect(() => appImageDesktopEntry('0.1.0\nExec=evil')).toThrow(FreedesktopError);
  });

  it('squashes root-owned, without xattrs, with fixed times when SOURCE_DATE_EPOCH is set', () => {
    expect(mksquashfsArgs('/a', '/b', undefined)).toEqual([
      '/a',
      '/b',
      '-root-owned',
      '-noappend',
      '-no-xattrs',
      '-comp',
      'gzip',
      '-quiet',
      '-no-progress',
    ]);
    expect(mksquashfsArgs('/a', '/b', '1790000000').slice(-4)).toEqual([
      '-mkfs-time',
      '1790000000',
      '-all-time',
      '1790000000',
    ]);
    expect(mksquashfsArgs('/a', '/b', '17; rm -rf /')).not.toContain('-all-time');
  });
});

/** A packaged-app fixture made into an AppImage with a fixture runtime (real mksquashfs). */
async function makeFixtureAppImage(): Promise<{ out: string; runtime: Buffer; makeDir: string }> {
  const runtime = Buffer.from('#fixture-runtime#'.repeat(64));
  writeFileSync(join(root, 'rt'), runtime);
  const app = join(root, 'Nutflix-linux-x64');
  mkdirSync(join(app, 'resources', 'app.asar.unpacked', 'worker'), { recursive: true });
  writeFileSync(join(app, 'nutflix'), '#!/bin/sh\n');
  chmodSync(join(app, 'nutflix'), 0o755);
  writeFileSync(join(app, 'resources', 'app.asar'), 'asar');
  writeFileSync(join(app, 'resources', 'app.asar.unpacked', 'worker', 'boot.mjs'), 'x');
  writeFileSync(join(root, 'icon.png'), 'png');
  chmodSync(join(root, 'icon.png'), 0o664);
  const maker = new MakerAppImage({
    runtimeDir: root,
    executableName: 'nutflix',
    productName: 'Nutflix',
    freedesktop: { metainfo: '<component/>\n', icon: join(root, 'icon.png') },
    runtimes: {
      x64: { asset: 'rt', sha256: createHash('sha256').update(runtime).digest('hex') },
    },
  });
  await maker.prepareConfig('x64');
  const makeDir = join(root, 'make');
  const [out] = await maker.make({
    dir: app,
    makeDir,
    appName: 'Nutflix',
    targetPlatform: 'linux',
    targetArch: 'x64',
    forgeConfig: {} as MakerOptions['forgeConfig'],
    packageJSON: { version: '0.1.0' },
  });
  if (out === undefined) throw new Error('the maker returned no artifact');
  return { out, runtime, makeDir };
}

const realSquashfs = process.platform === 'linux' && has('mksquashfs') && has('unsquashfs');

describe('MakerAppImage.make (fixture runtime, real mksquashfs)', () => {
  // The release build exports SOURCE_DATE_EPOCH (fixed squashfs times). mksquashfs >= 4.6 reads
  // it too, and refuses it together with -mkfs-time/-all-time: the maker must pass the times as
  // flags only (found by the first real Linux make, 2026-10-03).
  it.runIf(realSquashfs)(
    'with SOURCE_DATE_EPOCH set, every entry and the image carry that time',
    async () => {
      vi.stubEnv('SOURCE_DATE_EPOCH', '1700000000');
      try {
        const { out, runtime } = await makeFixtureAppImage();
        const stat = spawnSync('unsquashfs', ['-o', String(runtime.length), '-s', out], {
          encoding: 'utf8',
        });
        expect(stat.status, stat.stderr).toBe(0);
        expect(stat.stdout).toMatch(/Creation or last append time Tue Nov 14 22:13:20 2023/);
        const list = spawnSync('unsquashfs', ['-o', String(runtime.length), '-lls', out], {
          encoding: 'utf8',
          env: { ...process.env, TZ: 'UTC' },
        });
        expect(list.status, list.stderr).toBe(0);
        const entries = list.stdout.split('\n').filter((l) => l.includes('squashfs-root'));
        expect(entries.length).toBeGreaterThan(3);
        for (const e of entries) expect(e).toContain('2023-11-14 22:13');
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.runIf(realSquashfs)(
    'writes runtime + squashfs; AppRun links to the Electron binary; modes kept',
    async () => {
      const { out, runtime, makeDir } = await makeFixtureAppImage();
      expect(out).toBe(join(makeDir, 'appimage', 'x64', 'Nutflix-0.1.0-x64.AppImage'));
      const bytes = readFileSync(out);
      expect(bytes.subarray(0, runtime.length).equals(runtime)).toBe(true);
      // squashfs magic right after the runtime.
      expect(bytes.subarray(runtime.length, runtime.length + 4).toString('latin1')).toBe('hsqs');
      const list = spawnSync('unsquashfs', ['-o', String(runtime.length), '-lls', out], {
        encoding: 'utf8',
      });
      expect(list.status, list.stderr).toBe(0);
      expect(list.stdout).toMatch(
        /lrwxrwxrwx root\/root .* squashfs-root\/AppRun -> usr\/lib\/nutflix\/nutflix/,
      );
      expect(list.stdout).toMatch(
        /-rwxr-xr-x root\/root .* squashfs-root\/usr\/lib\/nutflix\/nutflix\n/,
      );
      // The desktop entry, the metainfo and the icon, named after the app id (freedesktop.ts),
      // where the AppImage spec puts them and where integration tools look; files 0644.
      for (const f of [
        'pro.sovtech.Nutflix.desktop',
        'pro.sovtech.Nutflix.png',
        'usr/share/applications/pro.sovtech.Nutflix.desktop',
        'usr/share/metainfo/pro.sovtech.Nutflix.metainfo.xml',
        'usr/share/icons/hicolor/512x512/apps/pro.sovtech.Nutflix.png',
      ])
        expect(list.stdout).toMatch(new RegExp(`-rw-r--r-- root/root .* squashfs-root/${f}\n`));
      expect(list.stdout).toMatch(
        /lrwxrwxrwx root\/root .* squashfs-root\/\.DirIcon -> pro\.sovtech\.Nutflix\.png/,
      );
      expect(list.stdout).not.toContain('squashfs-root/nutflix.desktop');
      expect(list.stdout).toContain(
        'squashfs-root/usr/lib/nutflix/resources/app.asar.unpacked/worker/boot.mjs',
      );
      // The AppDir scratch space is gone.
      expect(existsSync(join(makeDir, 'appimage', 'x64', 'AppDir'))).toBe(false);
    },
  );

  it('refuses before doing anything when the runtime is not the pinned one', async () => {
    const maker = new MakerAppImage({
      runtimeDir: root,
      executableName: 'nutflix',
      productName: 'Nutflix',
      freedesktop: { metainfo: '', icon: join(root, 'icon.png') },
    });
    await maker.prepareConfig('x64');
    await expect(
      maker.make({
        dir: join(root, 'nothing'),
        makeDir: join(root, 'make'),
        appName: 'Nutflix',
        targetPlatform: 'linux',
        targetArch: 'x64',
        forgeConfig: {} as MakerOptions['forgeConfig'],
        packageJSON: { version: '0.1.0' },
      }),
    ).rejects.toThrow(/runtime missing/);
    expect(existsSync(join(root, 'make'))).toBe(false);
  });
});

describe('MakerDmg', () => {
  it('copies the bundle with ditto, then one compressed hdiutil image (argv, no shell)', () => {
    expect(
      dmgCommands({
        app: '/o/Nutflix.app',
        srcFolder: '/t/src',
        volumeName: 'Nutflix',
        out: '/m/N.dmg',
      }),
    ).toEqual([
      { cmd: 'ditto', args: ['/o/Nutflix.app', join('/t/src', 'Nutflix.app')] },
      {
        cmd: 'hdiutil',
        args: [
          'create',
          '-volname',
          'Nutflix',
          '-srcfolder',
          '/t/src',
          '-fs',
          'HFS+',
          '-format',
          'UDZO',
          '-ov',
          '/m/N.dmg',
        ],
      },
    ]);
    expect(() =>
      dmgCommands({ app: '/a', srcFolder: '/s', volumeName: '../x', out: '/o' }),
    ).toThrow();
  });

  it('empties its output directory first, then runs ditto and hdiutil (independent review)', async () => {
    const makeDir = join(root, 'make');
    const outDir = join(makeDir, 'dmg', 'arm64');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'Nutflix-0.0.9-arm64.dmg'), 'stale');
    const ran: { cmd: string; args: readonly string[] }[] = [];
    const m = new MakerDmg({
      productName: 'Nutflix',
      exec: (cmd, args) => {
        ran.push({ cmd, args });
        return Promise.resolve();
      },
    });
    await m.prepareConfig('arm64');
    const [out] = await m.make({
      dir: join(root, 'packaged'),
      makeDir,
      appName: 'Nutflix',
      targetPlatform: 'darwin',
      targetArch: 'arm64',
      forgeConfig: {} as MakerOptions['forgeConfig'],
      packageJSON: { version: '0.1.0' },
    });
    expect(out).toBe(join(outDir, 'Nutflix-0.1.0-arm64.dmg'));
    expect(existsSync(join(outDir, 'Nutflix-0.0.9-arm64.dmg'))).toBe(false);
    expect(ran.map((r) => r.cmd)).toEqual(['ditto', 'hdiutil']);
    expect(ran[0]?.args[0]).toBe(join(root, 'packaged', 'Nutflix.app'));
    expect(ran[1]?.args.at(-1)).toBe(out);
    // The scratch source folder is gone.
    expect(readdirSync(outDir)).toEqual([]);
  });

  it('only runs on macOS', () => {
    const m = new MakerDmg({ productName: 'Nutflix' });
    expect(m.defaultPlatforms).toEqual(['darwin']);
    expect(m.isSupportedOnCurrentPlatform()).toBe(process.platform === 'darwin');
    expect(m.requiredExternalBinaries).toEqual(['ditto', 'hdiutil']);
  });
});
