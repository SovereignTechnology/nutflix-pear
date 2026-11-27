/**
 * ADR 0017, amendment 2026-11-26: the app id, the desktop entry, the AppStream metainfo and the
 * icon every Linux package installs (freedesktop.ts), and the .deb and .rpm makers that install
 * them (maker-linux.ts). The real makers run over a minimal packaged app when dpkg + fakeroot and
 * rpmbuild + rpm are present: the .rpm twice, to show that one commit makes the same bytes.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MakerOptions } from '@electron-forge/maker-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CHANGELOG, freedesktopFiles, makers } from '../forge-config.ts';
import {
  CATEGORIES,
  DESKTOP_FILE,
  FreedesktopError,
  SHARE_PATHS,
  changelogReleases,
  desktopEntry,
  metainfoXml,
} from '../freedesktop.ts';
import { APP } from '../identity.ts';
import {
  LinuxDebMaker,
  LinuxRpmMaker,
  RPMBUILD_DEFINES,
  rpmRequires,
  rpmSpec,
} from '../maker-linux.ts';
import { PKG_DIR, REPO_ROOT } from '../stage.ts';

const has = (bin: string): boolean => spawnSync('which', [bin]).status === 0;
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

let root = '';
let savedTmp: string | undefined;
let hadTmp = false;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nf-linux-'));
  // electron-installer-common stages in tmp.dir() and removes it only at process exit: point
  // TMPDIR into this test's dir so the cleanup below removes the staging too.
  hadTmp = Object.hasOwn(process.env, 'TMPDIR');
  savedTmp = process.env['TMPDIR'];
  mkdirSync(join(root, 'tmp'));
  process.env['TMPDIR'] = join(root, 'tmp');
});
afterEach(() => {
  if (hadTmp) process.env['TMPDIR'] = savedTmp;
  else delete process.env['TMPDIR'];
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('the app id and the release identity (the maintainer, 2026-11-26; ADR 0017 Q1)', () => {
  it('pro.sovtech.Nutflix, maintained by the release key UID, under the repo licence', () => {
    expect(APP.appId).toBe('pro.sovtech.Nutflix');
    expect(APP.maintainer).toBe('SovTech <git@sovtech.pro>');
    expect(APP.developerId).toBe('pro.sovtech');
    expect(DESKTOP_FILE).toBe('pro.sovtech.Nutflix.desktop');
    expect(SHARE_PATHS).toEqual({
      desktop: 'share/applications/pro.sovtech.Nutflix.desktop',
      metainfo: 'share/metainfo/pro.sovtech.Nutflix.metainfo.xml',
      icon: 'share/icons/hicolor/512x512/apps/pro.sovtech.Nutflix.png',
    });
    // The licence the packages declare is the repository's.
    const pj = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
      license: string;
    };
    expect(APP.license).toBe(pj.license);
    expect(APP.license).toBe('AGPL-3.0-or-later');
    expect(readFileSync(join(REPO_ROOT, 'LICENSE'), 'utf8')).toMatch(
      /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/,
    );
  });
});

describe('desktopEntry', () => {
  it('runs the binary itself and names the icon and the window class after the app id', () => {
    expect(desktopEntry()).toBe(
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Nutflix',
        'GenericName=Video player',
        `Comment=${APP.description}`,
        'Exec=nutflix %U',
        'Icon=pro.sovtech.Nutflix',
        'Terminal=false',
        'StartupNotify=true',
        // Electron 45 sets WM_CLASS (and the Wayland app_id) from the staged desktopName.
        'StartupWMClass=pro.sovtech.Nutflix',
        'Categories=AudioVideo;Video;Network;',
        '',
      ].join('\n'),
    );
    expect(CATEGORIES).toEqual(['AudioVideo', 'Video', 'Network']);
    expect(desktopEntry()).not.toMatch(/no-sandbox|--/);
    expect(() => desktopEntry(['X-Evil=1\nExec=evil'])).toThrow(FreedesktopError);
  });
});

describe('the metainfo (AppStream)', () => {
  it("lists CHANGELOG.md's dated releases, newest first; the app's version is the newest", () => {
    const releases = changelogReleases(readFileSync(CHANGELOG, 'utf8'));
    const pj = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
      version: string;
    };
    // A release commit dates its version in the CHANGELOG, so every tag's build lists itself.
    expect(releases[0]?.version).toBe(pj.version);
    expect(releases).toContainEqual({ version: '0.1.4', date: '2026-11-26' });
    expect(releases.at(-1)).toEqual({ version: '0.1.0', date: '2026-10-05' });
    for (const r of releases) expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(changelogReleases('## [Unreleased]\n\n## [1.2.3] - 2026-01-02\n')).toEqual([
      { version: '1.2.3', date: '2026-01-02' },
    ]);
    expect(() => changelogReleases('## [Unreleased]\n')).toThrow(FreedesktopError);
  });

  it('names the id, licences, developer, launchable, OARS rating and releases', () => {
    const text = freedesktopFiles().metainfo;
    const has1 = (line: string): void => {
      expect(
        text.split('\n').filter((l) => l.trim() === line),
        line,
      ).toHaveLength(1);
    };
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    has1('<component type="desktop-application">');
    has1('<id>pro.sovtech.Nutflix</id>');
    has1('<metadata_license>CC0-1.0</metadata_license>');
    has1('<project_license>AGPL-3.0-or-later</project_license>');
    has1(`<summary>${APP.description}</summary>`);
    has1('<developer id="pro.sovtech">');
    has1('<launchable type="desktop-id">pro.sovtech.Nutflix.desktop</launchable>');
    has1(`<url type="homepage">${APP.homepage}</url>`);
    has1('<content_rating type="oars-1.1">');
    has1('<binary>nutflix</binary>');
    expect(text.trimEnd().endsWith('</component>')).toBe(true);
    const releases = [...text.matchAll(/<release version="([^"]+)" date="([^"]+)"\/>/g)].map(
      (m) => ({ version: m[1], date: m[2] }),
    );
    expect(releases).toEqual(changelogReleases(readFileSync(CHANGELOG, 'utf8')));
    expect(releases).toContainEqual({ version: '0.1.4', date: '2026-11-26' });
    expect(() => metainfoXml([])).toThrow(FreedesktopError);
    // Values are escaped, never markup.
    expect(metainfoXml([{ version: '1"<&', date: '2026-01-01' }])).toContain(
      '<release version="1&quot;&lt;&amp;" date="2026-01-01"/>',
    );
  });

  // The real validators, where installed (the Kata check of this change installs both).
  it.runIf(['appstreamcli', 'desktop-file-validate'].every(has))(
    'appstreamcli and desktop-file-validate accept the metainfo and the desktop entry',
    () => {
      const usr = join(root, 'usr');
      for (const [rel, body] of [
        [SHARE_PATHS.desktop, desktopEntry()],
        [SHARE_PATHS.metainfo, freedesktopFiles().metainfo],
      ] as const) {
        mkdirSync(join(usr, rel, '..'), { recursive: true });
        writeFileSync(join(usr, rel), body);
      }
      const as = spawnSync(
        'appstreamcli',
        ['validate', '--no-net', '--explain', join(usr, SHARE_PATHS.metainfo)],
        { encoding: 'utf8' },
      );
      expect(as.status, as.stdout + as.stderr).toBe(0);
      const df = spawnSync('desktop-file-validate', [join(usr, SHARE_PATHS.desktop)], {
        encoding: 'utf8',
      });
      expect(df.status, df.stdout + df.stderr).toBe(0);
      expect(df.stdout + df.stderr).not.toMatch(/error/i);
    },
  );
});

describe("the makers survive Forge's clone() (pear #165: desktop-linux arm64)", () => {
  // Forge's make step clones every maker: `new this.constructor(config, platformsToMakeOn)`.
  const files = { metainfo: '<component/>', icon: '/nonexistent/icon.png' };
  it.each([
    ['deb', () => new LinuxDebMaker({ options: { name: APP.name } }, files)],
    ['rpm', () => new LinuxRpmMaker({ options: { name: APP.name } }, files)],
  ] as const)('%s: the clone keeps the freedesktop files, the config and its class', (_, make) => {
    const maker = make();
    const copy = maker.clone();
    expect(copy).toBeInstanceOf(maker.constructor);
    expect(copy).not.toBe(maker);
    expect(copy.freedesktop).toBe(files);
    expect(copy.freedesktop.icon).toBe('/nonexistent/icon.png');
  });
});

describe('the .rpm spec and rpmbuild macros', () => {
  const spec = rpmSpec({
    name: 'nutflix',
    version: '0.1.0',
    revision: 1,
    summary: APP.description,
    description: `${APP.description}.`,
    license: APP.license,
    url: APP.homepage,
    packager: APP.maintainer,
    requires: rpmRequires(['gtk3', '(nss or mozilla-nss)', 'libsecret']),
  });

  it('chrome-sandbox setuid root by file mode, no scriptlet; ffmpeg recommended; the three files', () => {
    expect(spec).toContain('\nchmod 4755 %{buildroot}/usr/lib/nutflix/chrome-sandbox\n');
    expect(spec).not.toMatch(/^%(pre|post|preun|postun|pretrans|posttrans)\b/m);
    expect(spec).toContain('\nRecommends: /usr/bin/ffmpeg\n');
    expect(spec).toContain('\nAutoReqProv: no\n');
    expect(spec).toContain('\nPackager: SovTech <git@sovtech.pro>\n');
    expect(spec).toContain('\nLicense: AGPL-3.0-or-later\n');
    expect(spec).toContain(
      '\nRequires: (gtk3 or libgtk-3-0), (nss or mozilla-nss), (libsecret or libsecret-1-0)\n',
    );
    const files = spec.slice(spec.indexOf('%files\n')).trim().split('\n').slice(1);
    expect(files).toEqual([
      '/usr/bin/nutflix',
      '/usr/lib/nutflix/',
      '/usr/share/applications/pro.sovtech.Nutflix.desktop',
      '/usr/share/metainfo/pro.sovtech.Nutflix.metainfo.xml',
      '/usr/share/icons/hicolor/512x512/apps/pro.sovtech.Nutflix.png',
      '/usr/share/doc/nutflix/',
    ]);
  });

  it('a field cannot add a line or expand a macro', () => {
    const base = {
      name: 'nutflix',
      version: '0.1.0',
      revision: 1,
      summary: 's',
      description: 'd',
      license: 'l',
      url: 'u',
      packager: 'p',
      requires: [],
    };
    expect(() => rpmSpec({ ...base, summary: 'x\n%post\nrm -rf /' })).toThrow(/one line/);
    expect(rpmSpec({ ...base, summary: '%{buildroot}' })).toContain('\nSummary: %%{buildroot}\n');
    expect(rpmSpec({ ...base, description: '100% %(id)' })).toContain('\n100%% %%(id)\n');
  });

  it('builds reproducibly: fixed host and time, clamped mtimes, no build-id links or post-processing', () => {
    expect(RPMBUILD_DEFINES).toEqual([
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
    expect(rpmRequires(['gtk3', 'libsecret', 'xdg-utils'])).toEqual([
      '(gtk3 or libgtk-3-0)',
      '(libsecret or libsecret-1-0)',
      'xdg-utils',
    ]);
  });
});

/** A minimal packaged app (what packager leaves in out/Nutflix-linux-<arch>). */
function fixtureApp(): string {
  const app = join(root, 'Nutflix-linux');
  mkdirSync(join(app, 'resources', 'app'), { recursive: true });
  writeFileSync(join(app, 'nutflix'), '#!/bin/sh\n');
  chmodSync(join(app, 'nutflix'), 0o755);
  // Chromium's SUID sandbox helper: both installers make it 4755.
  writeFileSync(join(app, 'chrome-sandbox'), 'helper');
  chmodSync(join(app, 'chrome-sandbox'), 0o755);
  writeFileSync(join(app, 'version'), '45.3.1');
  writeFileSync(join(app, 'LICENSE'), 'license');
  writeFileSync(join(app, 'LICENSES.chromium.html'), 'licenses');
  writeFileSync(
    join(app, 'resources', 'app', 'package.json'),
    JSON.stringify({
      name: APP.name,
      productName: APP.productName,
      version: '0.1.0',
      description: APP.description,
      author: APP.author,
      license: APP.license,
      main: 'main/main.js',
      type: 'module',
    }),
  );
  return app;
}

interface MakerLike {
  prepareConfig(arch: string): Promise<void>;
  make(o: MakerOptions): Promise<string[]>;
}

async function makeWith(
  target: 'deb' | 'rpm',
  arch: 'x64' | 'arm64',
  app: string,
): Promise<string> {
  const [maker] = makers({
    version: '0.1.0',
    electronChecksums: {},
    appImageRuntimeDir: root,
    targets: [target],
  }) as unknown as MakerLike[];
  if (maker === undefined) throw new Error('no maker');
  await maker.prepareConfig(arch);
  const [out, ...more] = await maker.make({
    dir: app,
    makeDir: join(root, 'make'),
    appName: APP.productName,
    targetPlatform: 'linux',
    targetArch: arch,
    forgeConfig: {} as MakerOptions['forgeConfig'],
    packageJSON: { version: '0.1.0' },
  });
  expect(more).toEqual([]);
  if (out === undefined) throw new Error('the maker returned no package');
  return out;
}

const realDeb = process.platform === 'linux' && ['dpkg-deb', 'fakeroot'].every(has);
const realRpm = process.platform === 'linux' && ['rpmbuild', 'rpm'].every(has);
const out = (cmd: string, args: string[]): string => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
};

describe('the real makers over a packaged-app fixture', () => {
  it.runIf(realDeb)(
    '.deb: the desktop entry, metainfo and icon under the app id; chrome-sandbox 4755 root',
    async () => {
      vi.stubEnv('SOURCE_DATE_EPOCH', '1700000000');
      const deb = await makeWith('deb', 'x64', fixtureApp());
      expect(deb).toBe(join(root, 'make', 'deb', 'x64', 'nutflix_0.1.0_amd64.deb'));
      const list = out('dpkg-deb', ['-c', deb]);
      for (const f of Object.values(SHARE_PATHS))
        expect(list).toMatch(new RegExp(`-rw-r--r-- root/root .* \\./usr/${f}\\n`));
      expect(list).toMatch(/-rwsr-xr-x root\/root .* \.\/usr\/lib\/nutflix\/chrome-sandbox\n/);
      expect(list).not.toMatch(/pixmaps|applications\/nutflix\.desktop/);
      const control = out('dpkg-deb', ['-f', deb]);
      expect(control).toMatch(/^Maintainer: SovTech <git@sovtech\.pro>$/m);
      expect(control).toMatch(
        /^Homepage: https:\/\/github\.com\/SovereignTechnology\/nutflix-pear$/m,
      );
      // electron-installer-debian's own sound recommendation, then ffmpeg (forge-config.ts).
      expect(control).toMatch(/^Recommends: libasound2t64 \| libasound2 \| pulseaudio, ffmpeg$/m);
      // The installed desktop entry is freedesktop.ts's.
      const x = join(root, 'x');
      out('dpkg-deb', ['-x', deb, x]);
      expect(readFileSync(join(x, 'usr', SHARE_PATHS.desktop), 'utf8')).toBe(desktopEntry());
      expect(readFileSync(join(x, 'usr', SHARE_PATHS.metainfo), 'utf8')).toBe(
        freedesktopFiles().metainfo,
      );
    },
    120_000,
  );

  it.runIf(realRpm)(
    '.rpm: rpm arch names, the same files, chrome-sandbox 4755 root, and the same bytes twice',
    async () => {
      vi.stubEnv('SOURCE_DATE_EPOCH', '1700000000');
      const app = fixtureApp();
      const first = await makeWith('rpm', 'x64', app);
      expect(first).toBe(join(root, 'make', 'rpm', 'x64', 'nutflix-0.1.0-1.x86_64.rpm'));
      const kept = join(root, 'first.rpm');
      renameSync(first, kept);
      const second = await makeWith('rpm', 'x64', app);
      expect(sha256(readFileSync(second))).toBe(sha256(readFileSync(kept)));
      const q = (fmt: string): string => out('rpm', ['-qp', '--qf', fmt, second]);
      expect(q('%{NAME} %{VERSION} %{RELEASE} %{ARCH}')).toBe('nutflix 0.1.0 1 x86_64');
      expect(q('%{BUILDHOST} %{BUILDTIME}')).toBe('reproducible 1700000000');
      expect(q('%{PACKAGER}|%{LICENSE}|%{URL}')).toBe(
        `SovTech <git@sovtech.pro>|AGPL-3.0-or-later|${APP.homepage}`,
      );
      const files = q('[%{FILEMODES:perms} %{FILEUSERNAME} %{FILEGROUPNAME} %{FILENAMES}\\n]');
      for (const f of Object.values(SHARE_PATHS))
        expect(files).toContain(`-rw-r--r-- root root /usr/${f}\n`);
      expect(files).toContain('-rwsr-xr-x root root /usr/lib/nutflix/chrome-sandbox\n');
      expect(files).toContain('lrwxrwxrwx root root /usr/bin/nutflix\n');
      expect(files).not.toContain('.build-id');
      // Every mtime is clamped to SOURCE_DATE_EPOCH.
      for (const t of q('[%{FILEMTIMES}\\n]').trim().split('\n'))
        expect(Number(t)).toBeLessThanOrEqual(1700000000);
      expect(out('rpm', ['-qp', '--recommends', second]).trim()).toBe('/usr/bin/ffmpeg');
      expect(out('rpm', ['-qp', '--requires', second])).toMatch(/^\(gtk3 or libgtk-3-0\)$/m);
      expect(out('rpm', ['-qp', '--scripts', second]).trim()).toBe('');
      // arm64 keeps rpm's arch name in the file name and the header.
      const arm = await makeWith('rpm', 'arm64', app);
      expect(arm).toBe(join(root, 'make', 'rpm', 'arm64', 'nutflix-0.1.0-1.aarch64.rpm'));
      expect(out('rpm', ['-qp', '--qf', '%{ARCH}', arm])).toBe('aarch64');
      // Nothing staged is left outside this test's dir.
      expect(readdirSync(join(root, 'tmp')).every((n) => n.startsWith('electron-installer-'))).toBe(
        true,
      );
    },
    180_000,
  );
});
