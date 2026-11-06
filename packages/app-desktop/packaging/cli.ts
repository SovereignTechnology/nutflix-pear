/**
 * Packaging driver (issue #6, ADR 0017). Stages the app (stage.ts), registers the Forge config
 * for the staged directory, and runs Electron Forge. Everything lands under
 * `packages/app-desktop/out/` (gitignored). Needs `npm run build` first: staging refuses a
 * build older than its sources (stage.ts `assertCurrentBuild`, cross-lane review round 4).
 *
 *   node packaging/cli.ts stage   [--platform p] [--arch a] HELPER
 *   node packaging/cli.ts package [--platform p] [--arch a] HELPER
 *   node packaging/cli.ts make    [--platform p] [--arch a] [--targets deb,appimage,…] HELPER
 *
 * Options: `--out <dir>` (default out/), `--appimage-runtime-dir <dir>` (default
 * out/appimage-runtime; holds the pinned runtime file, placed by hand — maker-appimage.ts).
 * HELPER (slice 5e-5, required) is `--iroh-helper <file>`, the iroh helper built for the target
 * (`crates/iroh-helper`), or `--without-iroh-helper`: a build without it speaks HyperDHT only,
 * so that is a choice, never an omission.
 *
 * After `package`/`make`: the fuses of every packaged binary were read back and match
 * fuses.ts, and the layout matches layout.ts (a mismatch fails the run). `make` also writes
 * `out/make/<platform>-<arch>.artifacts.json`, the list of what it produced. Then run
 * `node ../../scripts/release-manifest.mjs --made out/make/<platform>-<arch>.artifacts.json …`
 * for the sha256 manifest and the UNSIGNED Nostr event (signed later through Bunker46 — never
 * here).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { api, utils } from '@electron-forge/core';
import type { ForgeArch, ForgePlatform } from '@electron-forge/shared-types';

import { TARGETS, forgeConfig, type Target } from './forge-config.ts';
import { BUILD_ARCHES, MADE_LIST_SCHEMA, MADE_LIST_SUFFIX } from './identity.ts';
import { pinnedRuntime } from './maker-appimage.ts';
import { PKG_DIR, REPO_ROOT, irohHelperArg, stageApp } from './stage.ts';

const PLATFORMS: readonly ForgePlatform[] = ['linux', 'win32', 'darwin'];
const ARCHES: readonly ForgeArch[] = BUILD_ARCHES;

export interface CliOptions {
  readonly command: 'stage' | 'package' | 'make';
  readonly platform: ForgePlatform;
  readonly arch: ForgeArch;
  readonly out: string;
  readonly appImageRuntimeDir: string;
  readonly targets: readonly Target[] | undefined;
  /** Slice 5e-5: the iroh helper for the target, or `null` (`--without-iroh-helper`). */
  readonly irohHelper: string | null;
}

export function parseCli(argv: readonly string[]): CliOptions {
  const [command, ...rest] = argv;
  if (command !== 'stage' && command !== 'package' && command !== 'make')
    throw new Error('usage: cli.ts <stage|package|make> [--platform p] [--arch a] [--targets t,…]');
  const opts = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i] ?? '';
    if (k === '--without-iroh-helper') {
      i -= 1; // a flag: no value
      continue;
    }
    const v = rest[i + 1];
    if (
      ![
        '--platform',
        '--arch',
        '--out',
        '--appimage-runtime-dir',
        '--targets',
        '--iroh-helper',
      ].includes(k) ||
      v === undefined
    )
      throw new Error(`unknown or incomplete option ${k}`);
    opts.set(k, v);
  }
  const platform = (opts.get('--platform') ?? process.platform) as ForgePlatform;
  const arch = (opts.get('--arch') ?? process.arch) as ForgeArch;
  if (!PLATFORMS.includes(platform))
    throw new Error(`--platform must be one of ${PLATFORMS.join(', ')}`);
  if (!ARCHES.includes(arch)) throw new Error(`--arch must be one of ${ARCHES.join(', ')}`);
  const out = resolve(opts.get('--out') ?? join(PKG_DIR, 'out'));
  const targetsArg = opts.get('--targets');
  let targets: Target[] | undefined;
  if (targetsArg !== undefined) {
    targets = [];
    for (const t of targetsArg.split(',')) {
      if (!(TARGETS as readonly string[]).includes(t))
        throw new Error(`unknown target ${t} (known: ${TARGETS.join(', ')})`);
      targets.push(t as Target);
    }
  }
  // Last, so a bad platform, arch or target is reported as such.
  const irohHelper = irohHelperArg(rest);
  return {
    command,
    platform,
    arch,
    out,
    appImageRuntimeDir: resolve(
      opts.get('--appimage-runtime-dir') ?? join(out, 'appimage-runtime'),
    ),
    targets,
    irohHelper,
  };
}

/** `out/make/<platform>-<arch>.artifacts.json` (identity.ts MADE_LIST_*). */
export interface MadeList {
  readonly schema: typeof MADE_LIST_SCHEMA;
  readonly platform: string;
  readonly arch: string;
  readonly version: string;
  /** Relative to the list's directory (`out/make`), `/`-separated, sorted. */
  readonly artifacts: readonly string[];
}

/** The list of what one `make` produced; refuses an artifact outside `makeDir`. */
export function madeList(
  makeDir: string,
  platform: string,
  arch: string,
  version: string,
  artifacts: readonly string[],
): MadeList {
  const rel = artifacts.map((a) => {
    const r = relative(makeDir, resolve(a));
    if (r === '' || isAbsolute(r) || r.split(sep)[0] === '..')
      throw new Error(`an artifact outside ${makeDir}: ${a}`);
    return r.split(sep).join('/');
  });
  return {
    schema: MADE_LIST_SCHEMA,
    platform,
    arch,
    version,
    artifacts: [...rel].sort(),
  };
}

/** Writes (replaces) the list for this platform-arch; returns its path. */
export function writeMadeList(makeDir: string, list: MadeList): string {
  const file = join(makeDir, `${list.platform}-${list.arch}${MADE_LIST_SUFFIX}`);
  writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
  return file;
}

export async function runCli(o: CliOptions): Promise<string[]> {
  // Fail before minutes of packaging when the AppImage maker would refuse anyway.
  if (o.command === 'make' && o.platform === 'linux' && (o.targets ?? TARGETS).includes('appimage'))
    pinnedRuntime(o.appImageRuntimeDir, o.arch);
  const stageDir = join(o.out, `stage-${o.platform}-${o.arch}`);
  const staged = await stageApp({
    out: stageDir,
    platform: o.platform,
    arch: o.arch,
    ...(o.irohHelper === null ? {} : { irohHelper: o.irohHelper }),
  });
  process.stdout.write(
    `staged ${staged.out}: ${String(staged.packages.length)} packages, ${String(staged.files)} files, ${(staged.bytes / 1e6).toFixed(1)} MB\n`,
  );
  if (o.command === 'stage') return [staged.out];
  const checksums = JSON.parse(
    readFileSync(join(REPO_ROOT, 'node_modules', 'electron', 'checksums.json'), 'utf8'),
  ) as Record<string, string>;
  const { version } = JSON.parse(readFileSync(join(stageDir, 'package.json'), 'utf8')) as {
    version: string;
  };
  utils.registerForgeConfigForDirectory(
    stageDir,
    forgeConfig({
      version,
      electronChecksums: checksums,
      appImageRuntimeDir: o.appImageRuntimeDir,
      irohHelper: staged.irohHelper,
      ...(o.targets === undefined ? {} : { targets: o.targets }),
    }),
  );
  try {
    if (o.command === 'package') {
      const r = await api.package({
        dir: stageDir,
        interactive: false,
        platform: o.platform,
        arch: o.arch,
        outDir: o.out,
      });
      return r.map((x) => x.packagedPath);
    }
    const made = await api.make({
      dir: stageDir,
      interactive: false,
      platform: o.platform,
      arch: o.arch,
      outDir: o.out,
    });
    const artifacts = made.flatMap((m) => m.artifacts);
    const makeDir = join(o.out, 'make');
    const list = writeMadeList(makeDir, madeList(makeDir, o.platform, o.arch, version, artifacts));
    return [...artifacts, list];
  } finally {
    utils.unregisterForgeConfigForDirectory(stageDir);
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(PKG_DIR, 'packaging', 'cli.ts')
) {
  // Whatever the caller's umask, created files are 0644 and directories 0755 (app.asar, the
  // installers); stage.ts normalises what it copies.
  process.umask(0o022);
  let o: CliOptions;
  try {
    o = parseCli(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`packaging: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  runCli(o).then(
    (paths) => {
      for (const p of paths) process.stdout.write(`${p}\n`);
    },
    (err: unknown) => {
      process.stderr.write(`packaging: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
