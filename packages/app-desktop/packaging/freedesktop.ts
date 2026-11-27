/**
 * What every Linux package installs beside the app (ADR 0017, amendment 2026-11-26): one desktop
 * entry, one AppStream metainfo file and one hicolor icon, each named after the app id
 * (`identity.ts` `APP.appId`, `pro.sovtech.Nutflix`). The .deb, the .rpm and the AppImage carry
 * the same three files, made here, so the three cannot drift apart.
 *
 * Why the names matter. Electron 45 sets both the Wayland app_id and the X11 WM_CLASS from the
 * app package's `desktopName`, minus `.desktop` (app_package.cc → `CHROME_DESKTOP`,
 * native_window_views.cc: "Set the WM_CLASS and XDG App ID to the same value"). The staged
 * package.json carries `desktopName: DESKTOP_FILE` (stage.ts), so a window's app_id and WM_CLASS
 * class are `pro.sovtech.Nutflix`, the desktop file's id; `StartupWMClass` says the same for
 * shells that match on it. Without `desktopName`, Electron 45 would derive `nutflix` from the
 * product name, which no desktop file is named after.
 */
import { APP } from './identity.ts';

/** The desktop-file id, `pro.sovtech.Nutflix.desktop`; also the staged package.json's `desktopName`. */
export const DESKTOP_FILE = `${APP.appId}.desktop`;
/** The AppStream metainfo file, named after the component id. */
export const METAINFO_FILE = `${APP.appId}.metainfo.xml`;
/** The icon file; `Icon=` names it without `.png`. The icon is a 512 px PNG (forge-config.ts). */
export const ICON_FILE = `${APP.appId}.png`;
export const ICON_SIZE = '512x512';

/**
 * Where the three files go, relative to the install prefix: `/usr` in the .deb and the .rpm,
 * `usr/` inside the AppImage's AppDir.
 */
export const SHARE_PATHS = Object.freeze({
  desktop: `share/applications/${DESKTOP_FILE}`,
  metainfo: `share/metainfo/${METAINFO_FILE}`,
  icon: `share/icons/hicolor/${ICON_SIZE}/apps/${ICON_FILE}`,
});

/** The menu categories (one entry, the same in every package). */
export const CATEGORIES = Object.freeze(['AudioVideo', 'Video', 'Network']);
export const GENERIC_NAME = 'Video player';

export class FreedesktopError extends Error {
  override readonly name = 'FreedesktopError' as const;
}

/**
 * The desktop entry. `Exec` is the binary itself (`nutflix`: `/usr/bin/nutflix` in the .deb and
 * .rpm, the AppImage's own binary when an integrator rewrites it): no wrapper and no extra
 * switches, so never `--no-sandbox` (D4). `extra` adds AppImage-only keys.
 */
export function desktopEntry(extra: readonly string[] = []): string {
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${APP.productName}`,
    `GenericName=${GENERIC_NAME}`,
    `Comment=${APP.description}`,
    `Exec=${APP.name} %U`,
    `Icon=${APP.appId}`,
    'Terminal=false',
    'StartupNotify=true',
    `StartupWMClass=${APP.appId}`,
    `Categories=${CATEGORIES.map((c) => `${c};`).join('')}`,
    ...extra,
  ];
  for (const l of lines)
    if (/[\r\n]/.test(l)) throw new FreedesktopError('desktop entry values must be single lines');
  return `${lines.join('\n')}\n`;
}

export interface Release {
  readonly version: string;
  /** `YYYY-MM-DD` (UTC). */
  readonly date: string;
}

const RELEASE_HEADING = /^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\] - (\d{4}-\d{2}-\d{2})$/;

/**
 * The dated releases of CHANGELOG.md (`## [X.Y.Z] - YYYY-MM-DD`), newest first, as the file
 * lists them. `[Unreleased]` has no date and is not one. The release commit dates the version it
 * releases, so every tag's build lists itself (a test pins the app's version to the newest).
 */
export function changelogReleases(markdown: string): Release[] {
  const out: Release[] = [];
  for (const line of markdown.split('\n')) {
    const m = RELEASE_HEADING.exec(line.trimEnd());
    if (m?.[1] !== undefined && m[2] !== undefined) out.push({ version: m[1], date: m[2] });
  }
  if (out.length === 0) throw new FreedesktopError('CHANGELOG.md lists no dated release');
  return out;
}

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The AppStream component (https://www.freedesktop.org/software/appstream/docs/), checked with
 * `appstreamcli validate`. The content rating (OARS 1.1) declares what the app lets people do:
 * comments from anyone on Nostr, unmoderated (`social-chat`); a public key, and an IP address
 * that relays and peers see (`social-info`); real money spent per block (`money-purchasing`).
 */
export function metainfoXml(releases: readonly Release[]): string {
  if (releases.length === 0) throw new FreedesktopError('the metainfo needs at least one release');
  const rel = releases.map(
    (r) => `    <release version="${xml(r.version)}" date="${xml(r.date)}"/>`,
  );
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- Copyright (C) ${xml(APP.author)}. Made by packaging/freedesktop.ts. -->`,
    '<component type="desktop-application">',
    `  <id>${xml(APP.appId)}</id>`,
    '  <metadata_license>CC0-1.0</metadata_license>',
    `  <project_license>${xml(APP.license)}</project_license>`,
    `  <name>${xml(APP.productName)}</name>`,
    `  <summary>${xml(APP.description)}</summary>`,
    '  <description>',
    '    <p>',
    '      Peer-to-peer video where the people who seed a video are paid by the people who watch',
    "      it. Videos are announced on Nostr, streamed from other people's computers, and paid",
    '      for block by block in Cashu ecash. Free videos play over the NFX network, shared with',
    '      other apps and with web browsers.',
    '    </p>',
    '    <p>',
    '      Nutflix is experimental: do not trust it with money you cannot afford to lose.',
    '    </p>',
    '  </description>',
    `  <developer id="${xml(APP.developerId)}">`,
    `    <name>${xml(APP.author)}</name>`,
    '  </developer>',
    `  <url type="homepage">${xml(APP.homepage)}</url>`,
    `  <url type="bugtracker">${xml(APP.homepage)}/issues</url>`,
    `  <url type="vcs-browser">${xml(APP.homepage)}</url>`,
    `  <launchable type="desktop-id">${xml(DESKTOP_FILE)}</launchable>`,
    '  <provides>',
    `    <binary>${xml(APP.name)}</binary>`,
    '  </provides>',
    '  <content_rating type="oars-1.1">',
    '    <content_attribute id="social-chat">intense</content_attribute>',
    '    <content_attribute id="social-info">moderate</content_attribute>',
    '    <content_attribute id="money-purchasing">intense</content_attribute>',
    '  </content_rating>',
    '  <releases>',
    ...rel,
    '  </releases>',
    '</component>',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * What every Linux maker installs besides the desktop entry (which each writes with
 * `desktopEntry`, the AppImage adding its version): built once per make by forge-config.ts.
 */
export interface FreedesktopFiles {
  /** `metainfoXml(...)`. */
  readonly metainfo: string;
  /** Path of the PNG icon to install. */
  readonly icon: string;
}
