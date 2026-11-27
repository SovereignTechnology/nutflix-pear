# 17. Packaging: Electron Forge, fuses, asar and Nostr-signed releases

Date: 2026-09-25

## Status

Accepted for Stage 3 (issue #6, security review F21). The maintainer's decisions, 2026-09-24:

- Electron Forge plus Pear makers.
- Targets: Windows `.exe`, macOS `.dmg`, Linux `.deb`, Linux AppImage, and a `pear://` address.
- Fuses: `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments`
  off; `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` on. On 2026-09-26
  The maintainer added a sixth: `GrantFileProtocolExtraPrivileges` off (§4; open question 8).
- Every release is signed with the SovTech ngit Nostr key through Bunker46, as a Nostr-signed
  manifest of sha256 sums. The nsec is never written anywhere.
- Gatekeeper and SmartScreen warnings are accepted for now.

Implemented, and shipped as desktop 0.1.0 on 2026-10-05: a Linux `.deb` and AppImage. The Windows
`.exe`, the macOS `.dmg` and a `pear://` address are configured but were never built or released.

One part of the decision differs from what was asked, with the maintainer's approval (open
question 9, answered 2026-10-02): no Pear maker is used. The makers are Forge's own plus two
in-repo ones, because Holepunch's AppImage maker adds `--no-sandbox` (§5).

**Amended 2026-11-26 (the maintainer):** packages for Linux package managers.

- The app id is `pro.sovtech.Nutflix` and the package maintainer `SovTech <git@sovtech.pro>`, the
  UID planned for the key that will sign the package repositories (open question 1, revised).
  The user's data stays in `~/.config/Nutflix`: Electron names that directory after the product
  name, not the app id, so nothing migrates.
- Every Linux package installs one desktop entry, one AppStream metainfo file and one icon, each
  named after the app id, and the app's windows carry that id as their Wayland app_id and X11
  `WM_CLASS` (§5, "Desktop integration").
- A Linux `.rpm` joins the `.deb` and the AppImage, and all three are also built for arm64, each
  arch natively on its own runner (§5, §9).
- Studio also looks for ffmpeg in `/app/bin`, where a Flatpak build of the app would ship it.
  No Flatpak or Snap is built yet.

## Context

Nothing packaged the app before this. The dev build runs `dist/` through the `electron` npm
binary, so four things had to be settled:

- **The fuses.** They act before main's first line runs (`NODE_OPTIONS`, `--inspect`,
  `ELECTRON_RUN_AS_NODE`), so only the packaged binary can carry them. F21 recorded them as open.
- **Bare cannot read an asar archive.** The worker and every npm package it loads must stay
  real files. So must bare-sidecar's prebuilt `bare`, because a binary inside an archive cannot
  be spawned.
- **The npm workspace.** Dependencies are hoisted to the repo root and the workspace packages
  are symlinks. Forge's packager prunes by walking the app's own `node_modules`, so it cannot
  build the app's dependency tree by itself.
- **Two leftovers from Stage 1:**
  - a bundled worker needs an unbundled boot module that imports `bare-encoding/global`
    first (D6);
  - bare-sidecar `chmod`s its binary at require time, which throws on a read-only install.

## Decision

### 1. Toolchain

- Electron Forge **8.0.0-alpha.10**, pinned exactly. It is driven by `packaging/cli.ts`
  through Forge's API: the staged directory (§2) gets a virtual config
  (`utils.registerForgeConfigForDirectory`), so the staged tree carries no config file.
- **Why an alpha.** Forge 7.11.2's dependency tree brings high and critical advisories that
  CI's `npm audit --audit-level=high` gate refuses:
  - critical `tar` through `@electron/rebuild` → `node-gyp`;
  - `extract-zip` through `@electron/packager` 18, which has no fixed version;
  - `image-size` through `maker-dmg` → `appdmg`.

  8.0.0-alpha.10 moves to `@electron/packager` 20 and `@electron/rebuild` 4. With it the lockfile
  audits clean: 0 vulnerabilities, 147 packages added, no existing entry changed.
- Move to 8.0.0 when it is released. Holepunch's `hello-pear-electron` is waiting on the same
  release.
- Commands: `npm run -w packages/app-desktop stage|package|make`. Options: `--platform`,
  `--arch`, `--targets deb,appimage,squirrel,dmg`. Output goes to `packages/app-desktop/out/`,
  which is gitignored. `npm run build` must run first, and staging refuses a build older than
  its sources (§2, "The build it copies must be current").
- **Electron download.** Every Electron zip is checked against `checksums.json` from the
  lockfile-pinned `electron` package (`download.checksums`). `@electron/get` re-checks a cached
  zip against it, so nothing is fetched when the zip is already cached.
- **No native rebuild** (`rebuildConfig.onlyModules: []`). Every native module ships N-API or
  Bare prebuilds.

### 2. What is packaged: a staged app

`packaging/stage.ts` writes a standalone app directory. Its layout is the same as `dist/`, so
main's path logic is unchanged.

| Path | What | In the asar? |
|---|---|---|
| `package.json` | name `nutflix`, productName `Nutflix`, `main: main/main.js`, `type: module` | packed |
| `main/main.js` | Electron main, bundled. Allowed inputs: `src/main` and `src/ipc` only | packed |
| `host/main.js` | the host utilityProcess, bundled **with its npm code** (`@sovit/core`, cashu-ts, nostr-tools, @noble…). Only native packages stay external (sodium-native; bare-sidecar is loaded at runtime) | packed |
| `renderer/`, `prompt/`, `preload.cjs`, `prompt-preload.cjs` | copied from `scripts/bundle.ts` output | packed |
| `worker/boot.mjs` | the **unbundled boot module**: `import 'bare-encoding/global'`, then `import('./worker.mjs')` (D6) | unpacked |
| `worker/worker.mjs` | the worker bundle: our sources only. Every npm package stays an import that Bare resolves itself (export conditions, addons). This is the same shape the Stage 1 tests already ran under real Bare | unpacked |
| `worker/pay/dleq-thread-entry.mjs` | the DLEQ thread's entry (issue #8 d; added by lane I1), a bundle of its own: `src/worker/pay` and `src/ipc` only, every import dynamic and inside its `try`, `@sovit/core` and `bare-encoding/global` resolved by Bare from `node_modules/`. The worker finds it at `./pay/` from its root module (`src/worker/worker-root.ts`, inlined at the bundle's root), so it resolves inside `worker/` in both layouts | unpacked |
| `node_modules/` | the **lockfile runtime closure** (`packaging/closure.ts`), described below | unpacked |

How `node_modules/` is built:

- It holds the runtime closure of `@sovit/app-desktop`'s `dependencies`, resolved with npm's
  own nearest-`node_modules` rule. The versions are exactly what package-lock.json pins; nothing
  is re-resolved against the registry.
- Workspace packages become real directories holding `package.json` and their `files` list,
  without tests, source maps or `.d.ts` files.
- Native prebuilds are kept for the target platform only. bare-sidecar alone ships six runtimes
  of about 70 MB each.
- Symlinks are refused. File modes are normalised (0644, or 0755 if executable), and staging
  twice produces a byte- and mode-identical tree.
- Not shipped:
  - `react`, `react-dom` and `@sovit/ui` are already in the renderer bundle;
  - `pear-runtime`: the host spawns the worker with bare-sidecar directly (D2) and never
    constructs `PearRuntime`. Dropping it also removes `pear-runtime-updater`, `hyperdrive`,
    `msix-manager` and `bare-worker` from the install.

Why the host is bundled into the asar: the wallet and signer code then sit inside the archive.
On macOS and Windows, the integrity fuse covers that code.

**core's test doubles are not in the packaged host bundle** (cross-lane review, round 4). core's
barrel re-exports them (`export * as mocks`: TestMint, MockWallet, MockPaymentEngine, the
fixtures; and `nostr.FakeRelayPool`), so the bundler cannot drop them, although the host reaches
them only behind `--dev-mocks` / `--dev-fixtures`, which a packaged main refuses. The staging
step bundles those two modules (`HOST_TEST_DOUBLES`) as stubs with the same export names, each
a value that throws when touched, and fails if any other module of core's `mocks/` reaches the
host bundle. The dev host (tsc output) and the worker's copy of core keep the real modules. A
test loads the staged host bundle in plain Node, so no stub is touched at load time.

**The build it copies must be current** (cross-lane review, round 4). The staging step compiles
main, the host and the worker glue from `src/`, but it ships two things it never compiles:
every workspace package's `dist/` (copied into `node_modules/` and inlined into the host bundle
through the package exports) and `scripts/bundle.ts`'s output. The reviewer changed core's melt
timeout in `src/` and staged without rebuilding: staging succeeded, and both the host bundle and
the worker's copy of core carried the old value. Before touching `out`, `assertCurrentBuild`
refuses when:

1. `tsc -b --dry`, run through TypeScript's API over every workspace package the app is built
   from (core, gateway, seeder shipped; `@sovit/ui` bundled), would rebuild one of them. A
   project whose sources were only touched ("would update timestamps") counts as current;
2. a stylesheet a workspace builds beside tsc (`@sovit/ui`'s `dist/*.css`) is older than the
   package's newest `src/` stylesheet;
3. a bundle output the stage copies is older than the newest file the bundle reads: under
   `src/renderer`, `src/preload`, `src/ipc`, `static/`, `@sovit/ui`'s `dist/` or its `src/`
   (tests and stories excluded), or the bundle's own configuration — `scripts/bundle.ts`, the
   two tsconfigs its esbuild builds name (`tsconfig.renderer.json`, `tsconfig.preload.json`) and
   `tsconfig.base.json`, which both extend (lane R6-reconcile: a changed target, JSX setting or
   entry point changes the output as much as a source does; a configuration file that is missing
   or not a regular file is refused, since the rule could not be checked). The bundle reads the
   UI through its package exports, so from its `dist/` (`dist/*.js` and the copied `dist/ui.css`),
   never its `src/`: round 5 added `dist/` after a bundle made before `tsc` rebuilt the UI staged
   the old renderer. Tests pin the watched set (`bundleInputDirs`) against the real renderer
   bundle's inputs, and the configuration (`BUNDLE_CONFIG`, `BUNDLE_CONFIG_ROOT`) against the
   script and the tsconfigs' `extends` chain.

   What watching `@sovit/ui`'s `src/` adds (round 5 called it "a second, stricter check"; lane
   R6-reconcile states it exactly, and a test pins it). A real edit there is refused first by
   rule 1 (tsc would rebuild) or rule 2 (a stylesheet older than its source), so the `src/` watch
   refuses that same stale build a second time: a belt for rule 1, whose dry run trusts its
   `.tsbuildinfo`. On its own it refuses only a bundle older than a `src/` file whose content
   cannot have changed what the bundle reads — a source only touched (rule 1 calls that current),
   or a file that is neither a tsc input nor a stylesheet. Those refusals are false alarms,
   cleared by `npm run build`.

(2) and (3) compare mtimes; `npm run build` rewrites each of those files on every run, so the
remedy is always `npm run build`. The stage never runs the build itself, so it still writes
nothing outside its output directory. The Stage tests (`stage.test.ts`, the packaged-worker
integration test) now need a current build too, including after `npx tsc -b --force`, which
rewrites the UI's `dist/` (round 5).

Asar settings: `asar: { unpackDir: '{worker,node_modules}' }`, `prune: false`. The staged tree
is the whole app.

For the linux-x64 build: 134 packages, 2,105 files, 128 MB staged. The `.deb` is 121 MB and
installs 405 MiB, most of it Electron itself.

### 3. The worker and read-only installs

**Worker entry.** In a packaged build, main's `dist` directory is `resources/app.asar`.
`workerEntryFor` in `src/main/args.ts` hands the host
`resources/app.asar.unpacked/worker/boot.mjs`. A dev build still spawns the `tsc` output
`dist/worker/entry.js`. `src/ipc/asar-path.ts` holds the shared string mapping.

The mapping is keyed on the app's **own** archive: `appArchive(process.resourcesPath,
realpathSync)`, which main and the host utilityProcess both compute (Electron gives the utility
process `resourcesPath` too; checked on Electron 44.2.0). Only a path that is that archive or
lies inside it is mapped. The archive path is resolved through symlinks, because the module
loader has already resolved `import.meta.url`: a symlinked install, or macOS app translocation
under `/var` → `/private/var`, would otherwise never match. It used to key on the first `*.asar`
segment of the path, so an install under any directory named `x.asar` mapped into the wrong tree
(independent review).

**bare-sidecar.** In a packaged build, `loadSidecar` in `src/host/worker/sidecar.ts`:

- loads bare-sidecar from `app.asar.unpacked/node_modules`, so the binary it resolves is a real
  file that can be spawned;
- first resolves the binary with bare-sidecar's own `require-asset` call, and refuses to
  continue unless that binary is **already** executable (`WorkerRuntimeError`, "reinstall the
  app").

So bare-sidecar's `chmod` never runs: a read-only `.deb`, AppImage or signed bundle is never
modified. The build keeps the binary's mode, and `layout.ts` checks that it is executable. A dev
build keeps upstream behaviour. The supervisor logs a `WorkerRuntimeError`'s reason when a spawn
fails, so "reinstall the app" reaches the log; any other spawn error's text (which could name a
path) is still dropped.

### 4. Fuses

- `packaging/fuses.ts` holds exactly six settings: the five of the decision, and
  `GrantFileProtocolExtraPrivileges` **off** (the maintainer, 2026-09-26, answering open question 8).
  The app never loads `file://` (it serves everything over its own `app:` scheme), so taking
  `file:` pages' extra privileges away is defence in depth only; Electron's security guidance
  recommends it. Every other fuse keeps Electron's default, `EnableCookieEncryption` (off)
  included: the 2026-09-26 decision named only the `file:` fuse.
- They are flipped with `@electron/fuses` 2.1.3 (Electron org, zero dependencies, SLSA
  provenance) in Forge's `packageAfterCopy` hook. That is before packager renames and signs
  the binary, following the same rule as `@electron-forge/plugin-fuses`. That plugin is not
  used: 7.11.2 pins `@electron/fuses` ^1.
- They are **read back from every packaged binary** in `postPackage` — all six: a binary that
  still grants `file://` its privileges fails the build like one with `RunAsNode` on — together
  with a layout check (`layout.ts`):
  - main, the host, both preloads, and every file of the app window and the prompt window are
    packed (derived from the staging step's file lists, so a file added there is checked too);
  - the worker and the runtime are unpacked, and the worker's three files (boot module,
    bundle, DLEQ thread entry: `identity.ts` `UNPACKED_FILES`) are regular files, not symlinks
    and not under a symlinked directory (lane I1). A package without the thread entry would
    still start, but its worker would run every DLEQ check on its event loop;
  - the runtime is executable;
  - no other platform's runtime is present;
  - there is no `resources/app/` folder.

  Any mismatch fails the build.
- **Chromium's DevTools protocol.** The fuses close Node's `--inspect` and `NODE_OPTIONS`, but
  not `--remote-debugging-port` or `--remote-debugging-pipe`. With either, a wrapper script or
  an edited `.desktop` line exposes CDP, which drives the renderer holding the preload API and
  the prompt window. A packaged build refuses both (exit 78, `security.ts`); main runs before
  the DevTools server starts. A dev build keeps them, because the e2e harness attaches through
  them (independent review).
- **The other switches a wrapper could add** (cross-lane review, round 4). Main's refusals run
  in this order (main.ts; pinned by main-wiring's refusal-order test): Squirrel's lifecycle
  launch, the sandbox switches (`SANDBOX_BYPASS_SWITCHES`, the first list below), the dev
  flags, the remote-debugging switches, and last `PACKAGED_REFUSED_SWITCHES` (the second list).
  Round 4 extended the first list and added the second:
  - `SANDBOX_BYPASS_SWITCHES`, refused in **every** build (D4), second after Squirrel, now
    thirteen: D4's `no-sandbox`, `disable-gpu-sandbox` and `no-zygote`, plus
    `no-zygote-sandbox`, `disable-seccomp-filter-sandbox`, `disable-namespace-sandbox`,
    `disable-setuid-sandbox`, `disable-landlock-sandbox`, `allow-sandbox-debugging`,
    `gpu-sandbox-allow-sysv-shm`, `disable-webnn-compiler-sandbox`, `single-process` and
    `in-process-gpu`;
  - `PACKAGED_REFUSED_SWITCHES`, refused in **packaged** builds, last: the process wrappers
    `renderer-cmd-prefix`, `utility-cmd-prefix` (the host is a utility process),
    `gpu-launcher`, `zygote-cmd-prefix` and `browser-subprocess-path`, V8's `js-flags`, and
    `disable-site-isolation-trials` and `disable-web-security`. A dev build keeps them for
    debugging.

  Every name is a string in Electron 44.2.0's Linux binary. Chromium may already have started
  its zygote and GPU process when main runs, so a prefix on those has run once; the refusal
  means the app never goes on (no window, host or worker). Not refused: the debug pauses
  (`*-startup-dialog`, `wait-for-debugger*`), and `--enable-features`/`--disable-features`
  (open question 11). No Electron was launched with these switches: this box cannot start the
  Chromium sandbox without the maintainer's grant (e2e/support.ts), so the refusals are tested through
  main's fake-Electron wiring tests.
- Platform notes:
  - Electron implements `EnableEmbeddedAsarIntegrityValidation` on **macOS and Windows only**.
    On Linux the fuse is set but has no effect.
  - The macOS integrity digest is written into the framework binary only on a macOS host
    (packager 20). If the slot is left empty, Electron does not check.
  - On macOS, the ad-hoc signature is reset only for unsigned arm64 builds. Whether a build is
    signed follows `packagerConfig.osxSign`.

### 5. Makers

| Target | Maker | Build host |
|---|---|---|
| Windows `.exe` | `@electron-forge/maker-squirrel` (Squirrel.Windows `Nutflix-<version>-Setup.exe`, `noMsi`) | Windows (or wine + mono) |
| macOS `.dmg` | **in-repo** `packaging/maker-dmg.ts`: empty `out/make/dmg/<arch>`, `ditto` the `.app`, add an `/Applications` link, `hdiutil create -format UDZO`. The argv is built without a shell | macOS |
| Linux `.deb` | `@electron-forge/maker-deb` (electron-installer-debian) with its `make()` replaced: **in-repo** `packaging/maker-linux.ts` `LinuxDebMaker` (amendment 2026-11-26) | Linux with `dpkg` and `fakeroot` |
| Linux `.rpm` | `@electron-forge/maker-rpm` (electron-installer-redhat) with its `make()` replaced: **in-repo** `packaging/maker-linux.ts` `LinuxRpmMaker` (amendment 2026-11-26) | Linux with `rpmbuild` |
| Linux AppImage | **in-repo** `packaging/maker-appimage.ts` | Linux with `mksquashfs` |
| `pear://` | the Pear CLI, from the artifacts above (§6) | any |

Why the in-repo makers:

- **AppImage.**
  - Holepunch's `pear-electron-forge-maker-appimage` 2.0.1 writes an `AppRun` that adds
    **`--no-sandbox` on Ubuntu ≥ 24**. Main refuses that switch (D4), so the app would not
    start, and the sandbox is not negotiable. It also pulls electron-builder's
    `app-builder-lib`.
  - `@reforged/maker-appimage` 5.3.1 downloads the AppImage runtime from a **moving** tag
    (`continuous`) at build time, unverified. It also depends on Forge 7's `maker-base`, which
    brings back the advisories above.

  Ours builds the AppDir with `AppRun` as a symlink to the Electron binary itself: no wrapper
  and no switches. It then runs `mksquashfs` (root-owned, no xattrs, fixed times under
  `SOURCE_DATE_EPOCH`) and prepends the **pinned** type-2 runtime: release `20251108`,
  `runtime-x86_64` sha256
  `2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d`, and `runtime-aarch64`
  sha256 `00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444`. The runtime file is
  placed by hand in `out/appimage-runtime/`; the build downloads nothing and refuses any other
  bytes.
- **dmg.** `maker-dmg` → `electron-installer-dmg` → `appdmg` brings the `image-size`
  advisory. Under `ignore-scripts` it would also need two native modules (`macos-alias`,
  `fs-xattr`) built by hand. A compressed image holding the app and an `/Applications` link is
  all the release needs.
- **`.deb` and `.rpm` (amendment 2026-11-26).** The installers name the desktop entry and the
  icon after the package (`nutflix.desktop`, `/usr/share/pixmaps/nutflix.png`) and write no
  metainfo, and Forge's rpm maker renames `aarch64` to `arm64` after its config is applied. So
  `maker-linux.ts` runs the same pinned installers through subclasses that install the files of
  "Desktop integration" below instead. Everything else is the installers' own code: the copy of
  the packaged app, the setuid sandbox helper (§7), the `/usr/bin` link, the copyright file and
  the dependencies Electron needs. The `.rpm` subclass writes its own spec and runs `rpmbuild`
  itself, with these macros on its command line so no `~/.rpmmacros` can change them: a fixed
  build host (`reproducible`), the build time and every file's mtime from `SOURCE_DATE_EPOCH`
  (`use_source_date_epoch_as_buildtime`, `clamp_mtime_to_source_date_epoch`,
  `source_date_epoch_from_changelog 0`), no `/usr/lib/.build-id` links, no debuginfo package, no
  post-install processing (no strip), and an xz level 6 payload. It requires what
  electron-installer-redhat lists for Electron, with openSUSE's names as alternatives for GTK 3
  and libsecret, and recommends `/usr/bin/ffmpeg` (a file, so Fedora's `ffmpeg-free`, RPM
  Fusion's `ffmpeg` and openSUSE's packages all satisfy it). It has no scriptlets.

**Desktop integration (amendment 2026-11-26).** `packaging/freedesktop.ts` makes three files, and
the `.deb`, the `.rpm` and the AppImage install the same three:

| File | Path (`/usr` in the `.deb` and `.rpm`, `usr/` in the AppImage) |
|---|---|
| desktop entry | `share/applications/pro.sovtech.Nutflix.desktop` |
| AppStream metainfo | `share/metainfo/pro.sovtech.Nutflix.metainfo.xml` |
| icon (the 512 px placeholder, open question 2) | `share/icons/hicolor/512x512/apps/pro.sovtech.Nutflix.png` |

- The desktop entry runs `nutflix %U` with no switches, names its icon `pro.sovtech.Nutflix` and
  sets `StartupWMClass=pro.sovtech.Nutflix`. The AppImage adds `X-AppImage-Version` and also
  carries the entry and the icon at its root, with `.DirIcon`, as the AppImage spec asks.
- Electron 45 sets the Wayland app_id and the X11 `WM_CLASS` from the app's `desktopName`, minus
  `.desktop`. The staged `package.json` carries `desktopName: "pro.sovtech.Nutflix.desktop"`, so
  shells match the windows to the entry. Without it Electron 45 would use `nutflix`.
- The metainfo (checked with `appstreamcli validate`) carries the id, CC0-1.0 metadata and the
  repository's AGPL-3.0-or-later licence, the developer id `pro.sovtech`, the homepage, a
  `desktop-id` launchable, an OARS 1.1 rating (`social-chat` intense, `social-info` moderate,
  `money-purchasing` intense) and every dated release in `CHANGELOG.md`.
- The `.deb` renames the entry and the icon of 0.1.4 and earlier (`nutflix.desktop`,
  `/usr/share/pixmaps/nutflix.png`): an upgrade removes those, so a launcher pinned to the old
  entry must be pinned again.

Every artifact name carries the version, in one fixed shape per maker:
`nutflix_<v>_<amd64|arm64>.deb`, `nutflix-<v>-1.<x86_64|aarch64>.rpm` (amendment 2026-11-26),
`Nutflix-<v>-<x64|arm64>.AppImage`, `Nutflix-<v>-<x64|arm64>.dmg` and `Nutflix-<v>-Setup.exe`.
The release manifest accepts exactly these names and refuses any other (§8). A prerelease's
`.deb` (`0.1.0~rc.1`) and `.rpm` (`0.1.0.rc.1`) carry the installers' forms of the version, and
the manifest refuses both. So a stale artifact of **another version**, a
prerelease one included, cannot be signed by accident. A name cannot tell two builds of the
**same** version apart; only `--made` keeps an older same-version build out (§8).

**Deviation from "Pear makers".** The maintainer's decision named Pear makers. None is used:

- Holepunch's `pear-electron-forge-maker-appimage` writes an `AppRun` that adds `--no-sandbox`
  on Ubuntu ≥ 24. Main refuses that switch (D4), so the app would not start there, and the
  sandbox is not negotiable.
- Pear's Windows format is `.msix`, and the maintainer asked for an `.exe` (Squirrel).

The in-repo makers above take their place. This is put to the maintainer as open question 9 rather
than decided here.

**Squirrel.Windows lifecycle** (`src/main/squirrel.ts`). Squirrel starts the installed app
with `--squirrel-install`, `--squirrel-updated`, `--squirrel-uninstall` or
`--squirrel-obsolete` as its first argument and expects it to do its part and exit. Without
handling, the installer would start the whole app (window, host, worker, DHT), create no
shortcut, and uninstall would launch the app instead of cleaning up (independent review). Main
now handles these **first**, before the sandbox and dev-flag refusals and before any window,
host or worker exists, on packaged win32 builds only:

| Argument | Action |
|---|---|
| `--squirrel-install`, `--squirrel-updated` | `..\Update.exe --createShortcut=nutflix.exe`, then exit 0 |
| `--squirrel-uninstall` | `..\Update.exe --removeShortcut=nutflix.exe`, then exit 0 |
| `--squirrel-obsolete` | exit 0 |
| `--squirrel-firstrun` | start normally |

- Update.exe runs through `execFileSync` with a fixed argv, no shell, hidden, and a 10 s bound
  (Squirrel kills a hook after 15 s). If it fails, main still exits.
- It runs only when the executable sits in Squirrel's `app-<version>` directory: a copied or
  unzipped build never runs whatever `Update.exe` might sit in the folder above it.
- The module is pure (the runner is injected), so it is unit-tested on Linux; the wiring is
  tested against the fake `electron` in `main-wiring.test.ts`. It has not run on Windows.
- `scripts/electron-security-lint.mjs` does not restrict `child_process`, so nothing there
  needed an exception.

### 6. `pear://`

The Pear flow for Electron apps today (`hello-pear-electron`, docs.pears.com "Ship your app"):

1. `forge make` runs on each OS.
2. `pear build --package=… --linux-x64-app X.AppImage --darwin-arm64-app X.app
   --win32-x64-app X.msix --target nutflix-<v>` assembles a deployment directory
   (`by-arch/<platform-arch>/app/…`).
3. `pear stage <link> <dir>` puts it in a Hyperdrive on a link made with `pear touch`.
4. `pear provision` copies it to a lean link, and `pear seed` keeps it online.

Decided here:

- The `pear://` address is a **P2P download channel for the same artifacts**. Their
  authenticity comes from the Nostr-signed manifest (§8), not from the Hypercore writer key.
- **No OTA.** Pear's in-app updater (`new PearRuntime({ upgrade })`) would replace the binary on
  the Hypercore key's authority alone, which bypasses the SovTech signature. The app never
  constructs it (D2), and `pear-runtime` is not even shipped.
- Pear expects **`.msix`** for Windows, not a Squirrel `.exe`. So Windows is on `pear://` only
  if an msix maker is added (open question).
- Not done here: `pear touch/stage/seed` need the Pear CLI and write keys, and they contact the
  DHT. This lane contacts nothing outside the npm registry.
- No CI job yet. What `pear build` is given depends on open questions 3 and 9, the Pear CLI
  would need an exact pin reviewed like any other dependency, and the link's write key stays on
  The maintainer's machine, never on a runner. The commands above are the recipe.

### 7. The Chromium sandbox on Linux (never `--no-sandbox`)

- **`.deb`.** electron-installer-common makes `/usr/lib/nutflix/chrome-sandbox` **setuid root
  (4755)** while staging, and dpkg installs it that way. No maintainer script is involved. This
  is Chromium's audited helper and the standard Electron/Chrome `.deb` layout, so the sandbox
  starts on Ubuntu 24.04 without an AppArmor profile. A setuid-root binary is still a choice
  worth the maintainer's explicit yes (open question 10).
- **`.rpm` (amendment 2026-11-26).** The same helper, setuid root (4755) by the spec's own
  `%install`, again with no scriptlet (open question 10's answer covers it).
- **AppImage.** FUSE mounts the image `nosuid`, so the SUID helper cannot work. The sandbox then
  needs unprivileged user namespaces:
  - Debian, Fedora and Arch allow them;
  - Ubuntu ≥ 24.04 restricts them (`kernel.apparmor_restrict_unprivileged_userns=1`). There the
    AppImage refuses to start: Chromium aborts, and main would refuse `--no-sandbox` anyway.
- **Recommendation for Ubuntu ≥ 24.04: install the `.deb`.**
- **Never attach a userns profile to the AppImage's mount point.** The runtime mounts the image
  under `/tmp/.mount_<name><random>`, and `/tmp` is writable by every local user. A userns
  profile attached to a pattern under that mount point lets **any** local user create a
  matching path, copy any binary there and get unprivileged user namespaces. That defeats
  `apparmor_restrict_unprivileged_userns` for the whole machine. The mount name also follows
  the AppImage's *file* name, so a renamed download would not even match. (An earlier draft of
  this ADR proposed exactly that profile; independent review.)
- **If the AppImage route is kept on Ubuntu ≥ 24.04**, it goes through a root-owned copy with a
  profile on that exact path:

  ```
  ./Nutflix-<v>-x64.AppImage --appimage-extract          # after release-verify.mjs on the file
  sudo mv squashfs-root /opt/nutflix
  sudo chown -R root:root /opt/nutflix
  sudo chmod -R go-w /opt/nutflix
  ```

  ```
  abi <abi/4.0>,
  include <tunables/global>
  profile nutflix-opt /opt/nutflix/usr/lib/nutflix/nutflix flags=(unconfined) {
    userns,
  }
  ```

  Only root can put a binary at that path, so the profile grants nothing to other users. At that
  point the extracted tree is a manual install, and the `.deb` does the same job with updates
  and removal handled by dpkg. Open question 4 asks whether to document this route at all.
- **The packaged binary on this dev box.** The D4 profile `/etc/apparmor.d/nutflix-electron`
  names only `…/node_modules/electron/dist/electron`, and the packaged `chrome-sandbox` is not
  root-owned. So `out/Nutflix-linux-x64/nutflix` aborts before any JavaScript runs:
  `FATAL:setuid_sandbox_host.cc:166 The SUID sandbox helper binary was found, but is not
  configured correctly`. To run it, and so prove the dev-flag refusal (exit 78) on a real
  packaged binary, the maintainer would change the D4 profile's attachment to:

  ```
  profile nutflix-electron /home/<you>/nutflix/{,.worktrees/*/}{node_modules/electron/dist/electron,packages/app-desktop/out/Nutflix-linux-*/nutflix} flags=(unconfined) {
  ```

  The alternative is the SUID route (`chown root:root` + `chmod 4755` on
  `out/Nutflix-linux-x64/chrome-sandbox`), redone after every build. Like the D4 line it
  extends, that attachment is a developer-box grant: it lets whoever can write under
  `/home/<you>/nutflix` (its owner alone) run a binary there with user namespaces. It
  is never a pattern to ship to users (see the AppImage bullet above).

### 8. Release signing: a Nostr-signed manifest of sha256 sums

`scripts/release-manifest.mjs --made out/make/<platform>-<arch>.artifacts.json …` writes three
files to `packages/app-desktop/out/release/` (gitignored; `--out` overrides it):

- `SHA256SUMS`, in `sha256sum -c` format;
- `release-manifest.json`, with name, bytes and sha256 per artifact, plus version and commit;
- `release-event.unsigned.json`, an **unsigned** NIP-01 event:

| Field | Value |
|---|---|
| `kind` | 30071 (`NostrKind.ReleaseNotice`, contracts v3, the same kind as the web build's T13 notice) |
| `pubkey` | the SovTech key `npub1s0vtech…9adx` (hex `83d8bce2…3434`) |
| `tags` | `["d","nutflix-desktop"]`, `["version",v]`, `["commit",sha]`, `["x",sha256(content)]`, `["files",n]`, `["size",total]`, then `["artifact",name,sha256,bytes]` for each file |
| `content` | the `SHA256SUMS` text |
| `id`, `sig` | empty |

Inputs and rules:

- **One manifest per release.** Kind 30071 is addressable: relays keep one event per key, kind
  and `d`. Per-platform events would overwrite each other, and a Linux user comparing a download
  with "the current notice" would find no `.deb` in it (independent review). So the manifest is
  made once over every platform's artifacts (§9).
- **Only what the make produced.** `packaging/cli.ts make` writes
  `out/make/<platform>-<arch>.artifacts.json`: Forge's own list of the artifacts that make
  produced, relative to `out/make`, with the version. `--made` reads these lists. A list made
  for another version is refused, and so is any path in it that is absolute, uses backslashes or
  climbs out with `..`. Positional files and directories are still accepted for ad-hoc use.
- **Every artifact name is exactly one that a maker writes for this version:**
  `Nutflix-<v>-<x64|arm64>.AppImage`, `Nutflix-<v>-<x64|arm64>.dmg`,
  `nutflix_<v>_<amd64|arm64>.deb` or `Nutflix-<v>-Setup.exe`. The script's `ARTIFACT_SHAPES`
  is pinned by a test to the Forge config, to `BUILD_ARCHES` (the arches `cli.ts` builds) and
  to what the real deb and AppImage makers write. No prefix starts another and no tail ends
  another, so a name matches only an artifact made for exactly this version. Anything else is
  refused, in every mode. For release 0.1.0 that includes an older
  `Nutflix-0.0.9-x64.AppImage` left in `out/make`, a prerelease
  `Nutflix-0.1.0-rc.1-x64.AppImage` or `nutflix_0.1.0-rc1_amd64.deb`,
  `Nutflix-0.1.0.1-x64.AppImage`, and Squirrel's `nutflix-0.1.0-full.nupkg`. The first rule
  took the version followed by any `-`, `_` or `.`, so it accepted the last four (verifier,
  round 2).
- **What a name cannot show.**
  - A name cannot tell two builds of the *same* version apart. In positional mode, a stale
    artifact of the same version is still accepted. `--made` is the safe path, and the only
    one CI uses.
  - A prerelease cannot ship its `.deb` yet. electron-installer-debian writes the Debian form
    (`nutflix_0.1.0~rc.1_amd64.deb`), and `~` is not allowed in an artifact name, so the
    manifest refuses that file (fails closed).
- **`created_at` is the time the manifest is made**, never the commit time (`SOURCE_DATE_EPOCH`).
  A corrected manifest for the same commit must be newer than the event it replaces on the
  relays. `--created-at` overrides it.

Nothing in the repo holds a key. The maintainer signs the event with the SovTech key through Bunker46
(NIP-46 `sign_event`). The nsec never leaves the bunker, and no job, script or agent holds it.

**`scripts/release-publish.mjs` (2026-10-03, the maintainer's choice of a repo script)** runs that last
step on the maintainer's machine:

1. **Before the network:** the unsigned template must be a SovTech kind 30071 release whose
   tags agree (`release-verify.mjs` `checkUnsignedRelease`), and every file in `--dir` must
   match it.
2. **The bunker URI** is read from the terminal with echo off, never from argv. It is used for
   one connection and never written or logged.
3. **The bunker must sign for the SovTech key**, or nothing is asked of it. The signature is
   requested through `@sovit/core`'s `Nip46Signer`, which refuses any returned event that is
   not exactly the template signed by that key.
4. **The result is checked by the same `verifyRelease`** users run, and saved as
   `release-event.json`, never over an existing file.
5. **Publishing** happens only after typing `publish`, to `wss://relay.damus.io`,
   `wss://nos.lol` and `wss://relay.primal.net`, and each relay's answer is reported. (Since
   2026-11-18: `wss://nos.lol`, `wss://relay.primal.net` and `wss://relay.ditto.pub`; see open
   question 6.)

An already signed event skips the signing (verify, confirm, publish: a retry), and `--dry-run`
stops before publishing. Every relay socket uses `ws`: under Node 22's built-in WebSocket,
nostr-tools 2.25.2 overflows the stack on an unreachable relay (reproduced; not on Electron 44's
Node 24.20, which the app runs on).

`scripts/release-verify.mjs <signed-event.json> <file>…` (or `--all <dir>`) accepts only an
event that passes all of these:

- nostr-tools `verifyEvent` verifies it (library crypto only). The event is first reduced to
  plain JSON, because nostr-tools trusts a cached "verified" symbol that object spread copies;
- its pubkey **is the SovTech key**. There is no option to trust any other key;
- it is kind 30071 with `d` = `nutflix-desktop`;
- its artifact tags, content, `x`, `files` (the count) and `size` (the total) tags agree with
  each other, and a `commit` tag, when present, is a full 40-hex sha;
- every named file is listed, and its size and sha256 match.

Artifact names may not contain path separators or whitespace. The event file is read through
one descriptor: a regular file of at most 256 KiB, counted in bytes actually read. It is opened
non-blocking, so a FIFO is refused at once instead of waiting for a writer (verifier, round 2). A download
that is a symlink is refused. The verifier also prints the release's version, commit and
**creation** date (`created_at`: when the manifest was made, before signing). An **older**
genuine release verifies as well, so these should be compared with the current notice on the
relays.

### 9. CI

`packages/app-desktop/packaging/ci/release.gitlab-ci.yml` defines manual jobs that run on
`desktop-v*` tags:

- `desktop-linux` (deb and AppImage), `desktop-macos` (runner tag `macos`, dmg for arm64 and
  x64) and `desktop-windows` (runner tag `windows`, Squirrel) only build. Each publishes
  `out/make/`, which includes its `<platform>-<arch>.artifacts.json`.
- `desktop-release-manifest` needs all three, receives their `out/make/` trees, and runs
  `release-manifest.mjs` **once** with the four lists. It publishes the artifacts, SHA256SUMS,
  the manifest and the one unsigned event.

The file is **not active**. `ci/gitlab-ci.yml` is parked (no runner yet) and is outside this
lane's allowlist. Enabling it takes one `include:` line, proposed in `docs/archive/lanes/S3-pack.md`.

**Active since 2026-10-03: `.github/workflows/release.yml`** (the maintainer, 2026-10-02: 0.1.0 is
Linux only, released as a draft GitHub release). It ports `desktop-linux` and
`desktop-release-manifest` (with the Linux list only) and adds `draft-release`: on a
`desktop-v*` tag that names `@sovit/app-desktop`'s version, it attaches the `.deb`, the
AppImage, SHA256SUMS, the manifest and the unsigned event to a **draft** release, which the maintainer
publishes once the notice is signed. Only that job can write (`contents: write`), only on a
tag, and it runs no project code. A PR that touches the packaging runs the build and manifest
as a dry run. The Windows and macOS jobs stay in the GitLab file for later.

**Amended 2026-11-26:** `desktop-linux` is a matrix of two jobs, x64 on `ubuntu-24.04` and arm64
on `ubuntu-24.04-arm`. Each builds the iroh helper natively for its own arch (never
cross-compiled), fetches its own pinned AppImage runtime, and makes the `.deb`, the `.rpm` and
the AppImage under `SOURCE_DATE_EPOCH` = the commit's time. The manifest job receives both
trees and runs `release-manifest.mjs` once with both lists, so `SHA256SUMS`, the manifest and the
draft release cover all six files.

## Consequences

- F21's fuse half is closed for packaged builds, and the fuses are verified on every build.
  EnableEmbeddedAsarIntegrityValidation protects only on macOS and Windows.
- Unpacked files (the worker, `node_modules` and the native addons the host loads) are not
  covered by asar integrity on any platform. Once macOS builds are code-signed, the bundle
  signature will cover them there. On Windows and Linux, protection depends on the install
  location: `/usr/lib` for the `.deb`, the squashfs for the AppImage, and `%LocalAppData%` for
  Squirrel, which the user can write to.
- The packaged host bundle is exercised by a smoke run: the dev Electron loads the packaged
  `app.asar`, and the host and worker reach `ready` with the dev fixtures. The Electron e2e
  still runs the dev layout.
- Builds are not claimed reproducible. The staged tree is deterministic; the packager, asar
  and deb outputs were not checked.
- A Squirrel-installed Windows build makes and removes its own shortcuts; that path has only
  been exercised in unit tests.
- `app.isPackaged` keys on the executable's name. A same-user copy of the install renamed to
  `electron` counts as a dev build, which lifts the dev-flag and remote-debugging refusals. That
  copy is user-writable anyway (its `app.asar` can simply be edited), so this gives nothing
  beyond what the copy already allows.

## Open questions (the maintainer)

1. App id `xyz.sovit.nutflix` and the `.deb` maintainer `SovTech <git@sovit.xyz>`. Keep them?
   **Answered 2026-10-02 (the maintainer): keep both.**
   **Revised 2026-11-26 (the maintainer):** the app id is `pro.sovtech.Nutflix` (the reverse of
   sovtech.pro, the form Flathub and AppStream expect) and the maintainer `SovTech
   <git@sovtech.pro>` (the UID planned for the package-repository signing key), for the `.deb`'s
   `Maintainer` and the `.rpm`'s `Packager`. userData stays `~/.config/Nutflix` (Electron keys it on the product name), so
   nothing migrates; the desktop entry and icon are renamed (§5, "Desktop integration").
2. Brand icons: none exist in the repo. The installers currently show Electron's default icon.
   **Answered 2026-10-02 (the maintainer): a neutral placeholder icon** for 0.1.0, replaceable later
   without other changes.
3. `pear://` for Windows: add an msix maker (Pear's Windows format), or keep Windows
   `.exe`-only (then Windows is not on `pear://`)?
   **Answered 2026-10-02 (the maintainer): `.exe`-only for 0.1.0**; no msix, so Windows is not on
   `pear://` yet. 0.1.0 builds Linux only (`.deb` + AppImage): Windows and macOS have never been
   built and are not OS-signed (no Apple Developer ID or Windows certificate for 0.1.0).
4. AppImage on Ubuntu ≥ 24.04: it cannot start there without a user-namespace grant, and a
   profile on its `/tmp` mount point would open user namespaces to every local user (§7). The
   recommendation is the `.deb`. Should the extract-to-root-owned-`/opt` route be documented for
   users, or should the AppImage simply be marked "not for Ubuntu ≥ 24.04"?
   **Answered 2026-10-02 (the maintainer): mark it "not for Ubuntu ≥ 24.04"**; the release notes
   point those users to the `.deb`. No `/opt` route is documented.
5. Should the host check the digests of the unpacked files it loads (bare-sidecar's JS,
   sodium-native's `.node`, the worker tree) against a list inside the asar before spawning, or
   is waiting for code signing enough?
   **Revised 2026-10-03 (the maintainer): deferred until OS code signing exists.** The first answer
   (add the check) rested on a claim that it would catch tampering; it would not. The list
   would live in `app.asar`, which is no harder to rewrite than the unpacked files: the asar
   integrity fuse does nothing on Linux (§4), and without code signing nothing anchors the
   Electron binary either. For the Linux-only 0.1.0, the `.deb` is root-owned (whoever can
   change the files can change the list) and the AppImage is a read-only squashfs (tampering
   means repacking the whole image, list included). What remains is detecting corruption, at
   a measured 0.2–0.5 s per launch (2,105 files, 121 MB, 79 MB of it the Bare binary), plus an
   ordering problem (the host loads sodium-native before a host-side check could run). Revisit
   when OS code signing anchors the list.
6. `d` = `nutflix-desktop` keeps one replaceable "latest release" notice on relays, now one per
   release covering every platform. Use a per-version `d` instead, to keep history?
   **Answered 2026-10-02 (the maintainer): one `d` = `nutflix-desktop`** (relays keep the latest
   only). History stays in git tags and the GitHub releases; the update check reads one event.
   The signed notice goes to the app's default relays: `wss://relay.damus.io`, `wss://nos.lol`,
   `wss://relay.primal.net`.
   **Note 2026-11-18:** the notice relays are now `wss://nos.lol`, `wss://relay.primal.net` and
   `wss://relay.ditto.pub` (`RELEASE_RELAYS`): relay.damus.io refuses this project's address and
   the 0.1.3 notice failed there.
7. Confirm the pinned AppImage runtime digests, for example with
   `gh release view 20251108 -R AppImage/type2-runtime` or by checking the `.sig` files. They
   were read from GitHub's release listing. A wrong pin fails closed.
   **Checked 2026-10-02:** both files downloaded from the `20251108` release hash to exactly the
   pinned digests (x86_64 `2fca8b44…260d`, aarch64 `00cbdfcf…7444`). That confirms the pins match
   what GitHub serves for the tag; the `.sig` files (AppImage's own key) were not checked.
8. **Answered 2026-09-26:** `GrantFileProtocolExtraPrivileges` is turned off as well (§4). The
   decision did not name `EnableCookieEncryption`, which keeps its default. (The question was
   whether to flip the two fuses left at their defaults because only five were asked for. The
   cross-lane review, round 4, had read the packaged binary back with `@electron/fuses read`:
   the five chosen fuses as intended, `GrantFileProtocolExtraPrivileges` Enabled,
   `EnableCookieEncryption` Disabled.)
9. **The makers.** The decision said "Electron Forge plus Pear makers". This lane uses Forge's
   Squirrel and deb makers plus two in-repo makers (AppImage, dmg) instead, because Holepunch's
   AppImage maker adds `--no-sandbox` on Ubuntu ≥ 24 (main refuses it, D4) and pulls
   electron-builder's `app-builder-lib`, and the maintained dmg maker brings a high advisory.
   Approve the substitution, or name the Pear makers to use and accept what they bring?
   **Answered 2026-10-02 (the maintainer): substitution approved.** The in-repo makers stay (Forge
   Squirrel and deb, `maker-appimage.ts`, `maker-dmg.ts`); the Pear steps (`pear touch`,
   `build`, `stage`, `provision`, `seed`) stay a separate manual step on the offline-key machine.
10. **The setuid-root `chrome-sandbox` in the `.deb`** (§7). It is Chromium's standard Linux
    sandbox helper and what makes the sandbox start on Ubuntu 24.04 without a profile. Accept
    it, or ship an AppArmor userns profile for `/usr/lib/nutflix/nutflix` instead (a maintainer
    script that runs as root at install)?
    **Answered 2026-10-02 (the maintainer): accept the setuid helper.** It is what Chromium-based apps
    ship; the sandbox starts on Ubuntu 24.04 with no maintainer script, and an AppArmor profile
    would cover only AppArmor systems while adding a root postinst.
    **Note 2026-11-26:** the `.rpm` installs the same helper the same way (§7).
11. **`--enable-features` / `--disable-features` in a packaged build** (cross-lane review,
    round 4). Some Chromium features are sandbox layers (the network service's sandbox, for
    one), so `--disable-features=…` or `--enable-features=NetworkServiceInProcess…` on an
    edited `.desktop` line could weaken a packaged build. Main does not refuse these switches:
    they carry a list, refusing them outright breaks Wayland users
    (`--enable-features=UseOzonePlatform,WaylandWindowDecorations`), and a list of dangerous
    feature names is specific to each Chromium version and cannot be checked here without
    launching Electron. Refuse named features (which list?), refuse the switches outright, or
    leave them?

    **Answered 2026-10-02 (the maintainer): an allow-list.** A packaged build accepts the two switches
    only when every feature they name is in `PACKAGED_ALLOWED_FEATURES` (`src/main/security.ts`:
    `UseOzonePlatform`, `WaylandWindowDecorations`); anything else is refused in main (exit 78,
    `app.feature-switch-refused`), after the process switches. Fails closed: each comma-separated
    entry must be exactly an allowed name (a field-trial suffix, a `*` override or an empty entry
    is refused), and every occurrence in argv is read as well as the value Chromium reports, so a
    repeated switch cannot slip a name past. A dev build keeps them all. The list is reviewed with
    each Electron bump; a Wayland user who needs another feature asks for it to be added.
12. **Other ways to switch a Chromium feature** (raised with question 11's answer, 2026-10-02).
    Not covered by the allow-list: `--enable-blink-features` / `--disable-blink-features` (web
    platform features, not process or sandbox layers) and `--force-fieldtrials` /
    `--force-fieldtrial-params` (whether a forced trial can turn a feature on in a packaged
    Electron build without `--enable-features` was not checked here: no Electron is launched).
    Refuse them in a packaged build as well, or leave them?

    **Answered 2026-10-03 (the maintainer): refuse them.** `enable-blink-features`,
    `disable-blink-features`, `force-fieldtrials` and `force-fieldtrial-params` joined
    `PACKAGED_REFUSED_SWITCHES` (`src/main/security.ts`): a packaged build exits 78
    (`app.process-switch-refused`) before anything starts; a dev build keeps them. No packaged
    user needs them; one who does asks, and an allow-list follows, as for question 11.
