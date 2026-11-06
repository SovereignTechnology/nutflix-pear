import { join } from 'node:path';

import { asarUnpacked } from '../ipc/asar-path.js';

/**
 * Main's command line. Only these flags mean anything; everything else is ignored (Chromium
 * switches are Electron's business — except the sandbox bypasses, which `security.ts` refuses).
 *
 *   --dev-mocks        mock wallet/engine + loopback pay hub (D1); forwarded to the host
 *   --dev-fixtures     fixture catalogue (design §5a); forwarded to the host
 *   --user-data-dir D  (or `=D`) userData directory — the e2e runs against a temp dir
 *   --e2e-hooks        expose counters (never tokens or URLs) to the e2e harness, main process only
 */
export interface MainOptions {
  readonly devMocks: boolean;
  readonly devFixtures: boolean;
  readonly userDataDir: string | undefined;
  readonly e2eHooks: boolean;
}

/**
 * The flags a PACKAGED build refuses to start with (security review F21): a shipped binary is
 * never a dev build, so its command line cannot switch on mocks, fixtures or the e2e hooks.
 */
export const DEV_FLAGS = ['--dev-mocks', '--dev-fixtures', '--e2e-hooks'] as const;

/** The first dev flag in `argv`, if any. */
export function devFlagIn(argv: readonly string[]): string | undefined {
  return argv.find((a) => (DEV_FLAGS as readonly string[]).includes(a));
}

export function parseMainArgs(argv: readonly string[]): MainOptions {
  let devMocks = false;
  let devFixtures = false;
  let e2eHooks = false;
  let userDataDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--dev-mocks') devMocks = true;
    else if (a === '--dev-fixtures') devFixtures = true;
    else if (a === '--e2e-hooks') e2eHooks = true;
    else if (a === '--user-data-dir') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        userDataDir = next;
        i++;
      }
    } else if (a.startsWith('--user-data-dir=')) {
      userDataDir = a.slice('--user-data-dir='.length);
    }
  }
  if (
    userDataDir !== undefined &&
    !userDataDir.startsWith('/') &&
    !/^[A-Za-z]:[\\/]/.test(userDataDir)
  ) {
    userDataDir = undefined; // relative paths are refused: they depend on the launcher's cwd
  }
  return { devMocks, devFixtures, userDataDir, e2eHooks };
}

/** Relative to `dist/`: the host `utilityProcess` entry (lane L6-B). */
export const HOST_ENTRY = 'host/main.js';

/**
 * Relative to `dist/`: the worker entry the host spawns with `bare-sidecar`. It is the `tsc`
 * output, never a bundle: a bundle hoists `@sovit/core` above `bare-encoding/global` and the
 * worker dies at load (D6, docs/archive/lanes/L6-C.md).
 */
export const WORKER_ENTRY = 'worker/entry.js';

/**
 * Relative to `app.asar.unpacked/`: the PACKAGED worker's entry (issue #6, ADR 0017). The
 * packaged worker is a bundle (`worker/worker.mjs`, our sources only; npm packages stay imports
 * Bare resolves from `app.asar.unpacked/node_modules`), so it is started by an unbundled boot
 * module whose first import is `bare-encoding/global` (D6) and whose second loads the bundle.
 */
export const PACKAGED_WORKER_ENTRY = 'worker/boot.mjs';

/**
 * The worker entry main hands the host, from main's own `dist/` directory. In a dev build that
 * is the `tsc` output next to main. In a packaged build `distDir` IS the app's archive
 * (`resources/app.asar`), which Bare cannot read, so the entry is the boot module in the
 * unpacked tree beside it. `archive` is the app's own archive (`appArchive(process.resourcesPath)`),
 * `undefined` outside Electron.
 */
export function workerEntryFor(distDir: string, archive: string | undefined): string {
  const unpacked = asarUnpacked(distDir, archive);
  return unpacked === undefined
    ? join(distDir, WORKER_ENTRY)
    : join(unpacked, PACKAGED_WORKER_ENTRY);
}

/**
 * Relative to `app.asar.unpacked/`: the PACKAGED iroh helper (slice 5e-5, ADR 0021), `.exe` on
 * Windows. Must equal `PACKAGED_IROH_HELPER` in packaging/identity.ts; a test pins the two.
 */
export const PACKAGED_IROH_HELPER = 'iroh/nutflix-iroh-helper';

/**
 * The iroh helper main hands the host: in a packaged build the copy beside the archive (even if
 * that build shipped none: the worker then finds no executable and speaks HyperDHT only, which
 * it logs), so `NUTFLIX_IROH_HELPER` can never swap it; `undefined` in a dev build, where the
 * host reads that variable instead.
 */
export function irohHelperFor(
  distDir: string,
  archive: string | undefined,
  platform: string,
): string | undefined {
  const unpacked = asarUnpacked(distDir, archive);
  if (unpacked === undefined) return undefined;
  return join(
    unpacked,
    platform === 'win32' ? `${PACKAGED_IROH_HELPER}.exe` : PACKAGED_IROH_HELPER,
  );
}

/** The absolute paths main hands the host. */
export interface HostPaths {
  /** Electron's `userData` directory. */
  readonly userData: string;
  /** `<dist>/` + `WORKER_ENTRY`, resolved from main's own location. */
  readonly workerEntry: string;
  /** Slice 5e-5: a packaged build's own iroh helper (`irohHelperFor`). */
  readonly irohHelper?: string;
  /** ADR 0013: main found a real OS keychain (`keychainUsable`); the host may offer it. */
  readonly keychain?: boolean;
}

/**
 * The host's argv: exactly what the host's strict `parseHostArgs` (`src/host/flags.ts`)
 * accepts — `--user-data-dir=<abs>`, `--worker-entry=<abs>`, a packaged build's
 * `--iroh-helper=<abs>`, then only the dev flags. Anything
 * else makes the host exit 2 and main respawn it until its budget is spent (every respawn
 * reloads the window), so `host-link.test.ts` round-trips this through the host's real parser.
 */
export function hostArgs(opts: MainOptions, paths: HostPaths): string[] {
  const args = [`--user-data-dir=${paths.userData}`, `--worker-entry=${paths.workerEntry}`];
  if (paths.irohHelper !== undefined) args.push(`--iroh-helper=${paths.irohHelper}`);
  if (paths.keychain === true) args.push('--keychain');
  if (opts.devMocks) args.push('--dev-mocks');
  if (opts.devFixtures) args.push('--dev-fixtures');
  return args;
}
