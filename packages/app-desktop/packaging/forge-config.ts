/**
 * The Electron Forge configuration (issue #6, ADR 0017), registered by `cli.ts` for the staged
 * app directory (Forge's virtual-config API) — the staged tree carries no config of its own.
 *
 * Targets (Cameron, 2026-09-24):
 *   win32   Squirrel.Windows `Setup.exe`   @electron-forge/maker-squirrel   (Windows host or wine+mono)
 *   darwin  `.dmg`                          ./maker-dmg.ts (ditto + hdiutil) (macOS host)
 *   linux   `.deb`                          @electron-forge/maker-deb        (dpkg + fakeroot)
 *   linux   `.AppImage`                     ./maker-appimage.ts (pinned runtime + mksquashfs)
 *   pear:// the same artifacts, staged into a Hyperdrive by the Pear CLI (ADR 0017; not here)
 *
 * Nothing is signed by the platform (Gatekeeper / SmartScreen warnings accepted for now); the
 * release is signed by the SovTech Nostr key over a manifest of sha256 sums
 * (scripts/release-manifest.mjs), outside this build.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import MakerDeb from '@electron-forge/maker-deb';
import MakerSquirrel from '@electron-forge/maker-squirrel';
import type { ForgeConfig, ForgeConfigMaker } from '@electron-forge/shared-types';

import { assertAppFuses, flipAppFuses, packagedBinary, type TargetPlatform } from './fuses.ts';
import { APP, UNPACKED_DIRS } from './identity.ts';
import { assertLayout } from './layout.ts';
import { MakerAppImage } from './maker-appimage.ts';
import { MakerDmg } from './maker-dmg.ts';

export const TARGETS = ['squirrel', 'dmg', 'deb', 'appimage'] as const;

/**
 * The Linux desktop icon (512×512 PNG): a neutral PLACEHOLDER until a brand icon exists
 * (Cameron, 2026-10-02, ADR 0017 Q2). Replacing this file is the whole change.
 */
export const LINUX_ICON = fileURLToPath(new URL('./icons/nutflix.png', import.meta.url));
export type Target = (typeof TARGETS)[number];

export interface ForgeConfigOptions {
  /**
   * The app version being built (the staged package.json's). Every artifact name carries it,
   * the Squirrel `Setup.exe` included, so scripts/release-manifest.mjs can refuse a stale
   * artifact of another version left in `out/make` (independent review of the packaging lane).
   */
  readonly version: string;
  /** Electron's own sha256 list (node_modules/electron/checksums.json): every zip is checked. */
  readonly electronChecksums: Readonly<Record<string, string>>;
  /** Where the pinned AppImage runtime file(s) are. */
  readonly appImageRuntimeDir: string;
  /** Which makers to include (default all; each still only runs on its own platform). */
  readonly targets?: readonly Target[];
  /** Slice 5e-5: the staged app has the iroh helper, so every package must too (layout.ts). */
  readonly irohHelper?: boolean;
}

/** The packaged copy's package.json: the staging-only `devDependencies` (Forge reads it) goes. */
function stripDevDependencies(buildPath: string): void {
  const file = join(buildPath, 'package.json');
  const pj = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  delete pj['devDependencies'];
  writeFileSync(file, `${JSON.stringify(pj, null, 2)}\n`);
}

/** A version as artifact names carry it (no separators, spaces or shell characters). */
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

export function makers(o: ForgeConfigOptions): ForgeConfigMaker[] {
  if (!VERSION.test(o.version))
    throw new Error(`not a plain version: ${JSON.stringify(o.version)}`);
  const want = new Set<Target>(o.targets ?? TARGETS);
  const all: Record<Target, ForgeConfigMaker> = {
    squirrel: new MakerSquirrel({
      name: APP.name,
      authors: APP.author,
      description: APP.description,
      exe: `${APP.name}.exe`,
      // Forge's default (`Nutflix-<v> Setup.exe`) has a space, which a release name may not.
      setupExe: `${APP.productName}-${o.version}-Setup.exe`,
      noMsi: true,
    }),
    dmg: new MakerDmg({ productName: APP.productName }),
    deb: new MakerDeb({
      options: {
        name: APP.name,
        productName: APP.productName,
        genericName: 'Video player',
        description: APP.description,
        productDescription: `${APP.description}.`,
        section: 'video',
        priority: 'optional',
        maintainer: APP.maintainer,
        bin: APP.name,
        icon: LINUX_ICON,
        categories: ['AudioVideo', 'Video', 'Network'],
        // Studio uploads transcode with the system ffmpeg (worker/ffmpeg.ts).
        recommends: ['ffmpeg'],
        // No maintainer scripts. Chromium's sandbox starts on Ubuntu ≥ 24 because the package
        // itself ships `/usr/lib/nutflix/chrome-sandbox` setuid root (4755):
        // electron-installer-common sets that mode while staging, and dpkg installs it as
        // packaged. That SUID helper is Chromium's standard Linux layout, and an open question
        // for Cameron (ADR 0017 §7). Never --no-sandbox.
      },
    }),
    appimage: new MakerAppImage({
      runtimeDir: o.appImageRuntimeDir,
      executableName: APP.name,
      productName: APP.productName,
      comment: APP.description,
      categories: ['AudioVideo', 'Video', 'Network'],
      icon: LINUX_ICON,
    }),
  };
  return TARGETS.filter((t) => want.has(t)).map((t) => all[t]);
}

export function forgeConfig(o: ForgeConfigOptions): ForgeConfig {
  return {
    packagerConfig: {
      name: APP.productName,
      executableName: APP.name,
      appBundleId: APP.appId,
      appCategoryType: 'public.app-category.video',
      appCopyright: `Copyright (C) ${APP.author}`,
      win32metadata: { CompanyName: APP.author, ProductName: APP.productName },
      // app.asar with its header hash (embedded on macOS/Windows by packager); the worker and
      // every package it loads stay real files beside it (identity.ts UNPACKED_DIRS).
      asar: { unpackDir: `{${UNPACKED_DIRS.join(',')}}` },
      // The staged tree IS the app: no pruning (it would walk a workspace), no ignores needed.
      prune: false,
      derefSymlinks: false,
      junk: true,
      overwrite: true,
      // Every Electron zip is checked against the sha256 list the lockfile-pinned `electron`
      // package ships (a cache hit is re-checked; nothing is fetched when the zip is cached).
      download: { checksums: { ...o.electronChecksums } },
      // Unsigned by design for now: no osxSign / osxNotarize / windowsSign (ADR 0017).
    },
    // Every native module ships N-API or Bare prebuilds; nothing is compiled.
    rebuildConfig: { onlyModules: [] },
    makers: makers(o),
    plugins: [],
    hooks: {
      packageAfterCopy: async (resolvedCfg, buildPath, _electron, platform, arch) => {
        stripDevDependencies(buildPath);
        // Signed or not follows the config (as @electron-forge/plugin-fuses does): an unsigned
        // arm64 macOS build gets its ad-hoc signature back; a signed one is signed after this.
        const osxSign: unknown = resolvedCfg.packagerConfig.osxSign;
        await flipAppFuses(buildPath, platform, arch, Boolean(osxSign));
      },
      postPackage: async (_cfg, { platform, arch, outputPaths }) => {
        const p: TargetPlatform = platform;
        for (const out of outputPaths) {
          await assertAppFuses(packagedBinary(out, p, APP.name, APP.productName));
          assertLayout(out, p, arch, APP.productName, o.irohHelper === true);
        }
      },
    },
  };
}
