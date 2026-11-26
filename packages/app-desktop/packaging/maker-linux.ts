/**
 * The .deb and .rpm makers (ADR 0017 §5, amendment 2026-11-26): Forge's `MakerDeb` and
 * `MakerRpm`, with `make()` replaced so the package is built by a subclass of the same installer
 * (electron-installer-debian / -redhat, pinned) that
 *   - installs the desktop entry, the AppStream metainfo and the hicolor icon under the app id
 *     (freedesktop.ts), where the installers would name them after the package (`nutflix.desktop`,
 *     `/usr/share/pixmaps/nutflix.png`) and write no metainfo;
 *   - (rpm) writes its own spec and calls rpmbuild itself, reproducibly (`RPMBUILD_DEFINES`);
 *   - (rpm) names the file with rpm's arch names, `nutflix-<v>-1.x86_64.rpm` and
 *     `nutflix-<v>-1.aarch64.rpm`: Forge's MakerRpm renames aarch64 to `arm64` after the
 *     config, so its own `make()` cannot be configured to keep it.
 * Everything else is the installers' own code: the copy of the packaged app, chrome-sandbox made
 * setuid root (4755, electron-installer-common), the /usr/bin link, the copyright file, the
 * dependencies Electron needs, dpkg-deb. Each `make()` follows the steps of its installer's
 * default export at the pinned version.
 */
import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { MakerOptions } from '@electron-forge/maker-base';
import MakerDeb, { debianArch } from '@electron-forge/maker-deb';
import type { MakerDebConfig } from '@electron-forge/maker-deb';
import MakerRpm, { rpmArch } from '@electron-forge/maker-rpm';
import type { MakerRpmConfig } from '@electron-forge/maker-rpm';

import { SHARE_PATHS, desktopEntry, type FreedesktopFiles } from './freedesktop.ts';
import { APP } from './identity.ts';

const run = promisify(execFile);

/** The installers log through `debug`; their output is not wanted in the build log. */
const quiet = (): void => undefined;

/** Writes the three freedesktop files under `usr` (the package's `/usr`), 0644 in 0755 dirs. */
export function installFreedesktop(
  usr: string,
  files: FreedesktopFiles,
  which: 'desktop' | 'metainfo' | 'icon',
): void {
  const dest = join(usr, SHARE_PATHS[which]);
  mkdirSync(dirname(dest), { recursive: true, mode: 0o755 });
  if (which === 'icon') copyFileSync(files.icon, dest);
  else writeFileSync(dest, which === 'desktop' ? desktopEntry() : files.metainfo);
  chmodSync(dest, 0o644);
}

/** electron-installer-debian's default file name (its `defaultRename`): no revision is set. */
const debRename = (dest: string): string =>
  join(
    dest,
    '<%= name %>_<%= version %><% if (revision) { %>-<%= revision %><% } %>_<%= arch %>.deb',
  );

export class LinuxDebMaker extends MakerDeb {
  readonly freedesktop: FreedesktopFiles;

  constructor(config: MakerDebConfig, freedesktop: FreedesktopFiles) {
    super(config);
    this.freedesktop = freedesktop;
  }

  override async make({ dir, makeDir, targetArch }: MakerOptions): Promise<string[]> {
    const { Installer } = await import('electron-installer-debian');
    const files = this.freedesktop;
    class DebInstaller extends Installer {
      override get contentFunctions(): string[] {
        return [...super.contentFunctions, 'createMetainfo'];
      }
      override copyLinuxIcons(): Promise<void> {
        installFreedesktop(join(this.stagingDir, this.baseAppDir), files, 'icon');
        return Promise.resolve();
      }
      override createDesktopFile(): Promise<void> {
        installFreedesktop(join(this.stagingDir, this.baseAppDir), files, 'desktop');
        return Promise.resolve();
      }
      createMetainfo(): Promise<void> {
        installFreedesktop(join(this.stagingDir, this.baseAppDir), files, 'metainfo');
        return Promise.resolve();
      }
    }
    const outDir = resolve(makeDir, 'deb', targetArch);
    await this.ensureDirectory(outDir);
    const installer = new DebInstaller({
      options: {},
      ...this.config,
      arch: debianArch(targetArch),
      src: dir,
      dest: outDir,
      rename: debRename,
      logger: quiet,
    });
    await installer.generateDefaults();
    installer.generateOptions();
    await installer.createStagingDir();
    await installer.createContents();
    await installer.createPackage();
    await installer.movePackage();
    return installer.options.packagePaths ?? [];
  }
}

/**
 * Macros for every rpmbuild run, on its command line so no `~/.rpmmacros` and no spec can change
 * them. With SOURCE_DATE_EPOCH set (the release job sets it to the commit's time), two builds of
 * one commit make the same bytes:
 *   - the build host and build time are fixed, and every file's mtime is clamped to the epoch;
 *   - the build time never comes from a %changelog (the spec has none);
 *   - no /usr/lib/.build-id links (Electron's binaries would clash with any other Electron app's
 *     on install), no debuginfo package, and no post-install processing (no strip, no shebang or
 *     mode rewrites): the package carries the app exactly as packaged, as the .deb does;
 *   - the payload is xz at level 6 (dpkg-deb's default for the .deb), single-threaded.
 */
export const RPMBUILD_DEFINES: readonly string[] = Object.freeze([
  '_buildhost reproducible',
  'source_date_epoch_from_changelog 0',
  'use_source_date_epoch_as_buildtime 1',
  'clamp_mtime_to_source_date_epoch 1',
  '_build_id_links none',
  'debug_package %{nil}',
  '__os_install_post %{nil}',
  '__arch_install_post %{nil}',
  '_binary_payload w6.xzdio',
]);

/**
 * electron-installer-redhat's Electron dependencies with the two names openSUSE lacks given an
 * alternative (rpm boolean dependencies, as upstream writes the others): `gtk3` is openSUSE's
 * `libgtk-3-0` and `libsecret` its `libsecret-1-0`.
 */
export function rpmRequires(requires: readonly string[]): string[] {
  const alt: Readonly<Record<string, string>> = {
    gtk3: '(gtk3 or libgtk-3-0)',
    libsecret: '(libsecret or libsecret-1-0)',
  };
  return requires.map((r) => alt[r] ?? r);
}

/** A spec field value: one line, no macro expansion. */
function field(v: string): string {
  if (/[\r\n]/.test(v)) throw new Error(`an rpm spec field must be one line: ${JSON.stringify(v)}`);
  return v.replace(/%/g, '%%');
}

export interface RpmSpecInput {
  readonly name: string;
  readonly version: string;
  readonly revision: string | number;
  readonly summary: string;
  readonly description: string;
  readonly license: string;
  readonly url: string;
  readonly packager: string;
  readonly requires: readonly string[];
}

/**
 * The spec rpmbuild builds from. `%install` copies the tree electron-installer-redhat staged
 * (`<_topdir>/BUILD/usr`) with its modes, then sets Chromium's SUID sandbox helper to 4755 again:
 * the .rpm installs it setuid root exactly as the .deb does (ADR 0017 §7, open question 10),
 * with no scriptlet. `Recommends:` names the file Studio needs (worker/ffmpeg.ts), so it matches
 * whichever package ships it: Fedora's `ffmpeg-free`, RPM Fusion's `ffmpeg`, openSUSE's
 * `ffmpeg-N`.
 */
export function rpmSpec(s: RpmSpecInput): string {
  const lines = [
    '# Made by packages/app-desktop/packaging/maker-linux.ts (ADR 0017 §5).',
    `Name: ${field(s.name)}`,
    `Version: ${field(s.version)}`,
    `Release: ${field(String(s.revision))}`,
    `Summary: ${field(s.summary)}`,
    `License: ${field(s.license)}`,
    `URL: ${field(s.url)}`,
    `Vendor: ${field(APP.author)}`,
    `Packager: ${field(s.packager)}`,
    `Requires: ${s.requires.map(field).join(', ')}`,
    'Recommends: /usr/bin/ffmpeg',
    'AutoReqProv: no',
    '',
    '%description',
    ...s.description.split('\n').map((l) => l.replace(/%/g, '%%')),
    '',
    '%install',
    'mkdir -p %{buildroot}/usr',
    'cp -a %{_topdir}/BUILD/usr/. %{buildroot}/usr/',
    `chmod 4755 %{buildroot}/usr/lib/${field(s.name)}/chrome-sandbox`,
    '',
    '%files',
    `/usr/bin/${field(s.name)}`,
    `/usr/lib/${field(s.name)}/`,
    `/usr/${SHARE_PATHS.desktop}`,
    `/usr/${SHARE_PATHS.metainfo}`,
    `/usr/${SHARE_PATHS.icon}`,
    `/usr/share/doc/${field(s.name)}/`,
  ];
  return `${lines.join('\n')}\n`;
}

/** The arm64 rpm keeps rpm's own arch name, aarch64 (Forge's MakerRpm would write `arm64`). */
const rpmRename = (dest: string): string =>
  join(dest, '<%= name %>-<%= version %>-<%= revision %>.<%= arch %>.rpm');

export class LinuxRpmMaker extends MakerRpm {
  readonly freedesktop: FreedesktopFiles;

  constructor(config: MakerRpmConfig, freedesktop: FreedesktopFiles) {
    super(config);
    this.freedesktop = freedesktop;
  }

  override async make({ dir, makeDir, targetArch }: MakerOptions): Promise<string[]> {
    const { Installer } = await import('electron-installer-redhat');
    const files = this.freedesktop;
    class RpmInstaller extends Installer {
      override get contentFunctions(): string[] {
        return [...super.contentFunctions, 'createMetainfo'];
      }
      override copyLinuxIcons(): Promise<void> {
        installFreedesktop(join(this.stagingDir, this.baseAppDir), files, 'icon');
        return Promise.resolve();
      }
      override createDesktopFile(): Promise<void> {
        installFreedesktop(join(this.stagingDir, this.baseAppDir), files, 'desktop');
        return Promise.resolve();
      }
      createMetainfo(): Promise<void> {
        installFreedesktop(join(this.stagingDir, this.baseAppDir), files, 'metainfo');
        return Promise.resolve();
      }
      override createSpec(): Promise<void> {
        const o = this.options;
        mkdirSync(dirname(this.specPath), { recursive: true, mode: 0o755 });
        writeFileSync(
          this.specPath,
          rpmSpec({
            name: o.name,
            version: o.version,
            revision: o.revision,
            summary: o.description ?? APP.description,
            description: o.productDescription ?? o.description ?? APP.description,
            license: o.license ?? APP.license,
            url: o.homepage ?? APP.homepage,
            packager: APP.maintainer,
            requires: rpmRequires(o.requires),
          }),
        );
        return Promise.resolve();
      }
      override async createPackage(): Promise<void> {
        const o = this.options;
        const args = [
          '-bb',
          this.specPath,
          '--target',
          `${o.arch}-none-linux`,
          '--define',
          `_topdir ${this.stagingDir}`,
          ...RPMBUILD_DEFINES.flatMap((d) => ['--define', d]),
        ];
        await run('rpmbuild', args, { maxBuffer: 64 * 1024 * 1024 });
      }
    }
    const outDir = resolve(makeDir, 'rpm', targetArch);
    await this.ensureDirectory(outDir);
    const installer = new RpmInstaller({
      ...this.config,
      arch: rpmArch(targetArch),
      src: dir,
      dest: outDir,
      rename: rpmRename,
      logger: quiet,
    });
    await installer.generateDefaults();
    installer.generateOptions();
    await installer.generateScripts();
    await installer.createStagingDir();
    await installer.createContents();
    await installer.createPackage();
    await installer.movePackage();
    return installer.options.packagePaths ?? [];
  }
}
