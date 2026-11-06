/**
 * What the packaged app is called, and where its pieces live (issue #6, ADR 0017). One place, so
 * the Forge config, the makers, the staging step and the release manifest agree.
 */

export const APP = {
  /** Package, executable and Linux binary name. */
  name: 'nutflix',
  /** Human-facing name: window class, bundle, installer, artifact prefix. */
  productName: 'Nutflix',
  /** macOS bundle id / Windows AppUserModelID base (ADR 0017: a question for Cameron). */
  appId: 'xyz.sovit.nutflix',
  description: 'Nostr-native peer-to-peer video, paid per block with Cashu ecash',
  author: 'SovTech',
  /** Debian `Maintainer:` (the repo's commit identity; ADR 0017 open question). */
  maintainer: 'SovTech <git@sovit.xyz>',
  license: 'AGPL-3.0-or-later',
} as const;

/**
 * The only architectures `cli.ts` builds (each has a pinned AppImage runtime). Every artifact
 * name carries one of them, so scripts/release-manifest.mjs accepts exactly these (its
 * `ARTIFACT_SHAPES`, pinned to this list and to the makers by a test).
 */
export const BUILD_ARCHES = ['x64', 'arm64'] as const;

/** The Nostr `d` tag of the desktop release notice (kind 30071, `NostrKind.ReleaseNotice`). */
export const RELEASE_D_TAG = 'nutflix-desktop';

/**
 * After `make`, cli.ts writes `out/make/<platform>-<arch>.artifacts.json`: the artifacts THAT
 * make produced (Forge's own list), relative to `out/make`, with the version. The release
 * manifest is built from these lists (`scripts/release-manifest.mjs --made`), never from
 * whatever else is lying in `out/make` (independent review of the packaging lane). The schema
 * string and suffix are pinned against the script by a test.
 */
export const MADE_LIST_SUFFIX = '.artifacts.json';
export const MADE_LIST_SCHEMA = 'nutflix-made/1';

/**
 * Relative to `app.asar.unpacked/`: the packaged worker's unbundled boot module. Must equal
 * `PACKAGED_WORKER_ENTRY` in src/main/args.ts (main hands this path to the host); a test pins
 * the two together, since this build-time code cannot import the app's sources at runtime.
 */
export const PACKAGED_WORKER_ENTRY = 'worker/boot.mjs';
/** The bundle the boot module loads (our sources only; npm packages stay imports). */
export const PACKAGED_WORKER_BUNDLE = 'worker/worker.mjs';
/**
 * The DLEQ thread's entry (issue #8 d), a bundle of its own beside the worker's. The worker
 * resolves it from its root module (src/worker/worker-root.ts `DLEQ_THREAD_ENTRY_PATH`,
 * `./pay/dleq-thread-entry.mjs`), which the worker bundle inlines, so it must sit exactly here
 * relative to `PACKAGED_WORKER_BUNDLE` (a test pins the two together). Without it the worker
 * runs every DLEQ check inline, chunked, on its event loop.
 */
export const PACKAGED_DLEQ_THREAD_ENTRY = 'worker/pay/dleq-thread-entry.mjs';
/** The files Bare loads by path from `app.asar.unpacked/`: each must be a regular file there. */
export const UNPACKED_FILES = [
  PACKAGED_WORKER_ENTRY,
  PACKAGED_WORKER_BUNDLE,
  PACKAGED_DLEQ_THREAD_ENTRY,
] as const;

/**
 * Slice 5e-5 (ADR 0021): relative to `app.asar.unpacked/`, the iroh helper the worker spawns
 * (`crates/iroh-helper`, built for the target by the release job). Must equal
 * `PACKAGED_IROH_HELPER` in src/main/args.ts (main hands the host this path); a test pins the
 * two together. Windows adds `.exe` (`packagedIrohHelper`).
 */
export const PACKAGED_IROH_HELPER = 'iroh/nutflix-iroh-helper';

/** `PACKAGED_IROH_HELPER` for `platform`. */
export function packagedIrohHelper(platform: string): string {
  return platform === 'win32' ? `${PACKAGED_IROH_HELPER}.exe` : PACKAGED_IROH_HELPER;
}

/**
 * Directories of the staged app that `asar` must leave as real files in `app.asar.unpacked/`:
 * the Bare worker and everything it loads (Bare cannot read an archive), which includes
 * `bare-sidecar`'s prebuilt `bare`, and the iroh helper (a spawned binary cannot live in one
 * either).
 */
export const UNPACKED_DIRS = ['worker', 'node_modules', 'iroh'] as const;

/**
 * Runtime dependencies of @sovit/app-desktop that are NOT copied into the packaged
 * `node_modules`, with the reason. Everything else in `dependencies` is, with its closure.
 */
export const NOT_SHIPPED: Readonly<Record<string, string>> = {
  react: 'bundled into renderer/app.js (scripts/bundle.ts)',
  'react-dom': 'bundled into renderer/app.js (scripts/bundle.ts)',
  '@sovit/ui': 'bundled into renderer/app.js (scripts/bundle.ts)',
  'pear-runtime':
    'types only: the host spawns the worker with bare-sidecar directly (D2) and never constructs PearRuntime (no OTA, ADR 0017)',
};

/**
 * The files the renderer bundles leave in `dist/` (scripts/bundle.ts) and main serves: must
 * equal `APP_FILES` / `PROMPT_FILES` in src/main/app-protocol.ts (pinned by a test).
 */
export const RENDERER_FILES = ['index.html', 'app.js', 'ui.css', 'shell.css'] as const;
export const PROMPT_FILES = ['prompt.html', 'prompt.js', 'prompt.css'] as const;
export const PRELOAD_FILES = ['preload.cjs', 'prompt-preload.cjs'] as const;
