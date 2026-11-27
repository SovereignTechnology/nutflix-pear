# L6 desktop shell — design (2026-09-23)

Produced by a read-only design pass over the repo, `node_modules` and the dev laptop; reviewed
and accepted by the orchestrator. **(v)** = verified against code or by running something.
Binding inputs: ADR 0003 (Electron + `pear-runtime` Bare worker, not `pear-electron`), contracts
v4 (ADR 0007), `docs/archive/reviews/2026-09-23-pre-push-l5-v4.md` SE-1…SE-5, the "Shell contract the
screens expect" section of `docs/status.md` (now in `docs/archive/status-2026-10-04.md`).

## Orchestrator decisions

- **D1 — Stage 1 exit uses an in-process loopback `PayProtocol` pairing** behind `--dev-mocks`,
  over real UDX replication on a local hyperdht testnet. There is no cross-process `pay/1` wire
  until Stage 2 (`pay-protocol/` is locked; L3's dev `PayProtocol` sends nothing). A documented
  dev-only double, fenced like L3's `--dev-mocks` (refuses a non-loopback swarm bootstrap).
- **D2 — Never construct `new PearRuntime()` in Stage 1** (it joins the updater topic on the
  public DHT). **Amended after L6-0:** the host spawns the worker with **`bare-sidecar`
  directly** (pinned `0.5.4`) — exactly what `PearRuntime.run()` does internally — because
  `import 'pear-runtime'` in the Node host loads corestore, hyperswarm and three native addons
  (239 modules) that `run` never uses. `pear-runtime` stays a dependency for Stage 3 OTA.
- **D5 (after L6-0) — `wallet.p2pkPubkey` and `wallet.keyset` stay unbridged** with `send`/
  `receive` (`EXCLUDED_METHODS`): the UI never calls them; least privilege.
- **D6 — the worker entry's first import is `bare-encoding/global`** (Bare has no
  `TextEncoder`/`TextDecoder`; core's media pipeline, the seeder's json-store and L8's Bare
  process runner all use them).
- **D3 — The renderer never receives `wallet.send` / `wallet.receive`**: the bridge exposes stubs
  that reject `forbidden:` (a compromised renderer could otherwise mint locked proofs).
- **D4 — Never `--no-sandbox`.** Electron cannot launch on the dev laptop until Cameron applies a
  root-side fix (AppArmor `userns` profile for the pinned binary, or root-owned 4755
  `chrome-sandbox`); only the Electron e2e (§5b) needs it. Everything else runs under Node/jsdom.

## 0. Findings that shape the design

1. Electron 44.2.0 (Node 24.20.0, Chrome 152) is installed but aborts on start here:
   `kernel.apparmor_restrict_unprivileged_userns=1` + a non-root `chrome-sandbox` (v). No
   `xvfb-run`, no DISPLAY in agent shells; Cameron's GNOME session exposes Wayland/Xwayland.
2. `@sovit/seeder`'s root barrel could not load under Bare (it re-exported `adapters/node/*`;
   Bare resolves `node:fs` as an npm package) (v). **Fixed on main `7a6103c`:** `bare` export
   condition → `dist/portable.js`; `@sovit/gateway/upstream` subpath for `UpstreamPayer`.
3. `hypercore-blob-server` breaks "buffer = money" (v): `ByteStream` prefetches the whole
   requested range (`<video>` sends `bytes=0-` → the whole rendition is downloaded and paid for);
   `_getCore` opens any key unless `resolve` returns null; one static token in the query string;
   Content-Type from a `type=` URL param.
4. No cross-process `pay/1` in Stage 1 → D1.
5. `pear-runtime` 1.3.1 (v): under Node, `PearRuntime.run()` = `bare-sidecar` spawning its
   prebuilt `bare` 1.31.0 with a pipe on fd 3; `new PearRuntime()` joins the public DHT → D2;
   `index.d.ts` is declared but not shipped → ambient types needed.
6. nostr-tools needs a global `WebSocket`; Bare has none (no `bare-ws`/`bare-tls` installed) →
   nostr runs in Node, not the worker (v).
7. `wallet.send`/`receive` are on the contract but never used by the UI (v) → D3.
8. Screens classify errors by message prefix (`no-seeders:`, `no-balance:`, `no-signer`,
   `relay-down`, `ffmpeg-not-found`) and Studio reads `.code`; `contextBridge` copies Errors but
   drops custom props, and `ipcMain.handle` rewrites thrown messages → errors travel as an
   envelope and the renderer rebuilds `new Error("<code>: …")` with `.code`.

## 1. Process split

| Process | Runs | Why |
|---|---|---|
| **Main** (Electron, Node 24) — thin | lifecycle; the one `BrowserWindow`; security handlers; `app:` protocol (renderer files + CSP header); `nf-media:` protocol (video/image proxy); SE-1 file-token registry; IPC gate (sender check → shape check); supervises host | "main = shell + IPC" |
| **Host** (Electron `utilityProcess`, Node 24) | `DesktopNetworkAdapter` (the contract): L1 `NostrClient` over `SimplePoolAdapter` (global WebSocket); catalogue/social; `unreact` (SE-5); settings store (atomic JSON in userData); `image()` fetch + sha256 (T16); wallet provider (`MockWallet` behind `--dev-mocks`); signer seam (none in Stage 1 → writes reject `no-signer:`); session-registry backstop. Spawns the worker with `PearRuntime.run` | nostr needs WebSocket (§0.6); Schnorr-verifying pages of events must not block the UI thread; the Stage 2 wallet (cashu-ts + fetch) fits here |
| **Worker** (Bare via pear-runtime/bare-sidecar) | one Corestore + one Hyperswarm (firewall = `seeder.banList.firewall`); `@sovit/seeder` (bare condition) with Bare adapters (`bare-fs`, `sodium-native` sha256); viewer payer (`UpstreamPayer` shape); `MockPaymentEngine('honest')` behind a provider seam; pay/1 factory (D1 loopback in dev); playback HTTP server; ffmpeg probe; L8 transcode (`worker/transcode/` + `runStudioUpload`) | data plane: native addons and peers stay out of Node and the renderer (ADR 0003) |
| **Renderer** (sandboxed) | `@sovit/ui` screens, router, playback coordinator, mini-player, theme, toasts; **no network** (`connect-src 'none'`) | T15 |

**Settings:** the host owns `settings.json` (atomic temp+rename), pushes seeding/disk-cap to the
worker; the ffmpeg path lives in `desktop.json` until contracts v5 adds `Settings.ffmpegPath`.

**Wallet and engine:** in Stage 1 the worker's engine mints mock proofs and emits `spend`; the
host debits `MockWallet` from those events so the WalletChip moves. Make the worker's payer take
an injected `pay(range, seeder, policy)` so Stage 2 can move `PaymentEngineViewer` to the host
or keep a wallet-RPC stub in the worker.

**`PlaySession` across processes:** the host mints `sid` (128-bit hex, bound to the
webContents); the worker opens the core and returns a blob-server link; the host gives the link
to **main**, never the renderer; the renderer gets `source = {kind:'url', url:'nf-media://play/<mediaToken>'}`
and main's `protocol.handle('nf-media')` forwards `Range` via `net.fetch` and streams the 206
back (renderer never learns port/token; CSP stays static; no loopback fetch from the page). The
**preload** builds a real `PlaySession` whose methods close over `sid`; `onPeers`/`onSpend`
subscribe to `session.peers`/`session.spend`; `pause`/`resume`/`setPrefetchSeconds`/
`switchRendition`/`close` → `session.*` calls.

**Pause/prefetch in the worker:** serve with `hypercore-blob-server` but give it a **wrapper
store** whose `get()` returns a gated core adapter (`opened`/`ready`/`seek`/`get`/`close`,
deliberately **no `.core`**, which disables ByteStream's bulk prefetch). `get(i)` waits while
paused and keeps a bounded lookahead `core.download({start:i, end:i+prefetchBlocks})`,
`prefetchBlocks = ceil(prefetchSec × bitrate / 8 / blockSize)`. `resolve()` admits only
`(core, blob)` pairs of open sessions; 404 once closed. Received blocks are still paid
(invariant 1); pause stops *requesting*. Fallback: an ~80-line `bare-http1` range server reusing
L3's `blossom/range.ts` semantics.

## 2. IPC protocol (L6-0 foundation lane writes it; frozen for L6-A/B/C)

`packages/app-desktop/src/ipc/protocol.ts` — pure TS, no electron/bare/node imports:

```ts
export const IPC_V = 1 as const;
export const CHANNEL = { call: 'nf:call', sub: 'nf:sub', event: 'nf:event', grant: 'nf:grant-file' } as const;
export type SessionId = string & { readonly __b: 'sid' };      // host-minted, 32 hex
export type FileToken = `nf-file:${string}`;                   // main-minted, single-use, per-webContents, 10-min TTL
export type WireMap<K extends string, V> = { readonly $map: readonly (readonly [K, V])[] };

/** Exhaustive: [args, result]. wallet.send/receive deliberately absent (D3). */
export interface MethodTable {
  signer: [[], SignerStatus]; me: [[], NostrPubkey | null]; profile: [[NostrPubkey], Profile | null];
  feed: [[FeedQuery], Page<VideoManifest>]; video: [[NostrEventId], VideoManifest | null];
  stats: [[NostrEventId], VideoStats]; /* …every NetworkAdapter method, dotted: 'library.history', … */
  'wallet.balances': [[], WireMap<MintUrl, Sats>]; 'wallet.melt': [[MeltQuote], { paid: boolean; change: Sats }];
  play: [[NostrEventId, string?], PlaySessionWire];
  'session.pause': [[SessionId], void]; 'session.resume': [[SessionId], void];
  'session.setPrefetchSeconds': [[SessionId, number], void];
  'session.switchRendition': [[SessionId, string], PlaySessionWire]; 'session.close': [[SessionId], void];
  'studio.upload': [[UploadInputWire], VideoManifest];          // progress on topic upload.progress
  'studio.analytics': [[NostrEventId], VideoStats & { satsByRendition: WireMap<string, Sats> }];
  'desktop.ffmpeg': [[{ readonly recheck: boolean }], FfmpegStatus];  // pre-v5 stand-in for studio.ffmpeg()
}
export type Method = keyof MethodTable;
export interface PlaySessionWire { readonly sid: SessionId; readonly videoId: NostrEventId; readonly rendition: string;
  readonly source: { readonly kind: 'url'; readonly url: `nf-media://play/${string}` }; readonly policy: PricePolicy }
export interface UploadInputWire extends Omit<UploadInput, 'file' | 'thumbnailChoice'> {
  readonly uploadId: string; readonly file: FileToken;           // SE-1: never a path
  readonly thumbnailChoice?: number | { readonly bytes: Uint8Array; readonly type: string } }
export type ErrorCode = 'no-seeders' | 'no-balance' | 'no-signer' | 'relay-down' | 'not-found' | 'invalid-argument'
  | 'forbidden' | 'file-token-invalid' | 'payments-unavailable' | 'session-closed' | 'backend-down' | 'rate-limited'
  | 'internal' | MediaErrorCode;
export interface WireError { readonly code: ErrorCode; readonly message: string }   // message starts `${code}: `
export interface CallMsg<M extends Method = Method> { readonly v: 1; readonly id: number; readonly method: M; readonly args: MethodTable[M][0] }
export type ReplyMsg = { readonly v: 1; readonly id: number } &
  ({ readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: WireError });
export type Topic = { t: 'seeder.status' } | { t: 'notifications' } | { t: 'wallet.change' }
  | { t: 'session.peers' | 'session.spend'; sid: SessionId } | { t: 'upload.progress'; uploadId: string };
export type SubMsg = { v: 1; op: 'sub'; subId: number; topic: Topic } | { v: 1; op: 'unsub'; subId: number };
export interface EventMsg { readonly v: 1; readonly subId: number; readonly payload: unknown }
// main ⇄ host (utilityProcess parentPort, structured clone)
export type HostIn = { kind: 'call'; wc: number; msg: CallMsg; file?: { path: string; name: string; size: number } }
  | { kind: 'sub'; wc: number; msg: SubMsg } | { kind: 'wc-gone'; wc: number } | { kind: 'image'; req: number; id: string };
export type HostOut = { kind: 'reply' | 'event'; wc: number; msg: ReplyMsg | EventMsg }
  | { kind: 'media-link'; token: string; url: string | null } | { kind: 'image'; req: number; bytes: Uint8Array | null; type: string };
export type Guard<T> = (x: unknown) => x is T;
export declare const validateArgs: { readonly [M in Method]: Guard<MethodTable[M][0]> };  // missing entry = compile error
export const LIMITS = { maxString: 4096, maxBody: 16384, maxArray: 256, inflightPerWc: 64, subsPerWc: 256 } as const;
```

The sketch is the intent, not the letter: the foundation lane makes it compile against the real
contracts (exact method list, `wallet.*` read methods the UI uses — `balances`, `history`,
`mints`, `mintQuote`, `pollQuote`, `meltQuote`, `melt`, `onChange` — Maps as `WireMap`,
`MediaErrorCode` from core) and documents every deviation.

**Rules:** handlers never throw across `ipcMain.handle` — always resolve a `ReplyMsg`.
Validation = hand-written guards in `src/ipc/guards.ts`, no new deps: primitives (`hex64`,
bounded int, bounded string, enum, `arrayOf(max)`, exact-keys object) composed into
`validateArgs`; main runs them on every renderer message after checking `event.senderFrame` is
the top frame at `app://nutflix/`, the host runs them again; each guard gets a fast-check fuzz
test (never throws, rejects unknown keys). **SE-1:** the renderer passes the DOM `File` as the
upload's `FileLike` (Studio's `resolveFile` = identity); the preload calls
`webUtils.getPathForFile` then `invoke('nf:grant-file')` → `FileToken`; main swaps the token for
`{path}` only when relaying `studio.upload`, any other string → `file-token-invalid`; Studio
thumbnail candidates come back as `nf-media://img/<id>`. **Renderer rebuild:**
`renderer/adapter/rehydrate.ts` restores `Error.code` from the prefix and Maps from `$map`
(unless the day-1 spike shows `contextBridge` passes Maps).

**Host ⇄ worker:** `src/ipc/worker-protocol.ts` (types) + `src/ipc/framing.ts` (4-byte BE
length + UTF-8 JSON, 16 MiB cap; keys/blob ids as hex). Requests both ways
`{op:'req',id,m,a}` / `{op:'res',id,ok,r|e}`; events `{op:'ev',e,…}`. Host→worker: `init`,
`play.open` (→ `{key, link}`), `play.pause`, `play.resume`, `play.prefetch`, `play.close`,
`seeder.*`, `studio.ffmpeg`, `studio.upload`. Worker→host request: `studio.publish(draft)` (the
host builds + signs the NIP-71 event). Worker events: `ready{port}`, `spend`, `peers`,
`seeder.status`, `upload.progress`, `dev.fixtures`, `log` (already redacted). The host guards
worker messages too.

## 3. Security checklist

| Control | Where | Test |
|---|---|---|
| `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` (literals) | `main/window.ts` | `scripts/electron-security-lint.mjs`; e2e reads `webContents.getLastWebPreferences()`; page sees no `require`/`process`; `!app.commandLine.hasSwitch('no-sandbox')` |
| Preload surface = NetworkAdapter shape + `desktop.ffmpeg` only | `preload/bridge.ts` | exposed key tree equals the allowlist; `wallet.send/receive` reject `forbidden` |
| CSP response header from the `app:` handler: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' nf-media: data:; media-src nf-media:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'` | `main/csp.ts`, `main/protocols.ts` | header test; e2e no violations |
| `setWindowOpenHandler` deny; `will-navigate`/`will-redirect`/`will-frame-navigate`/`will-attach-webview` `preventDefault` via `app.on('web-contents-created')` | `main/security.ts` | fake-webContents unit tests; e2e: a Markdown `_blank` link opens nothing |
| Permissions: deny all except `fullscreen` and `clipboard-sanitized-write`, top-frame `app:` origin only | `main/security.ts` | unit |
| Privileged schemes `app`, `nf-media` (standard, secure, stream); traversal guard; files only from `dist/renderer/` | `main/protocols.ts` | `..`, encoded slash, unknown extension |
| IPC gate: sender frame, method allowlist, guards, inflight/sub caps per webContents | `main/ipc-gate.ts` | wrong frame, unknown method, bad args, raw path, flood |
| Worker playback server: 127.0.0.1, random token, `resolve` allowlist of live sessions, `CSP: sandbox`, no CORS, fixed `video/mp4` | `worker/playback/*` | unknown core → 404 and never opened; closed session → 404 |
| No remote content in the window; images proxied + checked in the host (https only, no creds, 5 MiB cap, image MIME, ≤ 3 re-validated redirects, loopback/private literals refused, sha256 when given) | `host/images.ts` | hash mismatch, `http:`, `127.0.0.1`, oversize |
| Stage 2 hook: native confirm dialog in main before `wallet.melt` / `seeder.melt` / `nutzap` | `main/money-gate.ts` (stub) | — |

Loopback exposure: with the `nf-media:` proxy and a 256-bit token, other web pages can't reach
the bytes; another same-user process is outside the threat model. Acceptable **only with** the
`resolve` allowlist — without it a leaked token spends the user's sats.

## 4. Renderer

- **Bundling:** `scripts/bundle.ts` (node + esbuild API): `src/renderer/main.tsx` →
  `dist/renderer/app.js` (ESM, browser, minified); `src/preload/preload.ts` → `dist/preload.cjs`
  (CJS, `electron` external — sandboxed preloads can't use ESM or workspace `require`);
  `@sovit/ui/dist/ui.css` + `src/renderer/shell.css` **copied** next to a static `index.html`
  and loaded with `<link rel=stylesheet>`. Nothing injected.
- **Router:** in-memory history of `{route, extras}` (extras: search filters, wallet `intent`,
  Library `playlistId`, Studio tab, Watch playlist); back/forward (Alt+←/→, mouse buttons);
  Studio stays mounted across `studio` tabs; Watch is **not** re-keyed on `videoId`.
- **Chrome:** `shell/Header.tsx` (search, `WalletChip` — balance from `wallet.onChange`/
  `balances`, rate from the coordinator's live session `onSpend`, click → `wallet`; avatar),
  `shell/Sidebar.tsx`, one `ToastStack` fed by Settings/Library/Studio `onToast`. (L4 has no
  header/sidebar; move them into `@sovit/ui` later.)
- **Playback coordinator** (`renderer/coordinator.ts`, SE-2/SE-3) wraps the adapter **once**
  (stable identity): `play`/`switchRendition` register sessions; a wrapped `resume` pauses all
  others; Watch `onMiniPlayer` hands to the mini-player and the coordinator closes what the
  mini-player held; a hand-off whose `videoId` differs from the new watch route (watch→watch
  remount) is closed; Shorts `onPlaybackStart` pauses the mini-player; dismissing the
  mini-player closes it; expanding navigates with `resumeSession`; after each route commit any
  registered session owned by neither the mounted screen nor the mini-player is closed. Host
  backstop: ≤ 1 unpaused session per webContents; `wc-gone` closes all.
- **Theme:** `applyTheme((await adapter.settings()).theme)` at boot and on Settings'
  `onSettingsChange`. `import type { Settings as SettingsData }` to dodge the component name.
- **Other props:** Studio `ffmpeg`/`onRecheckFfmpeg` from `desktop.ffmpeg`; Home `hoverPreview`
  from settings; Channel `seedingVideos` undefined in Stage 1 (v5 `seederAnnouncement`);
  Settings `onChangeSigner` omitted (no signer yet).

## 5. Stage 1 exit test plan

**(a) Node integration test (in `npm test`)** — `worker/__tests__/two-seeders.integration.test.ts`:
`hyperdht/testnet.js` in-process network; S1 writes a deterministic ~2 MiB blob (32 × 64 KiB);
S2 mirrors it as a paying viewer over the loopback hub; S1 then `core.clear()`s blocks [16, 32)
so the viewer **must** fetch from both seeders (deterministic). The desktop `WorkerHost` runs
under Node with injected `node:http` + node adapters, `MockPaymentEngine('honest')` for every
role, and `LoopbackPayHub`. Assert: `play.open`; exact bytes over HTTP range (full, mid-file
206, 416); `download` events attributed to both seeders' Noise keys; viewer spend = blocks ×
price; each seeder engine `paid == uploaded` (within one window after flush), no bans; after
`bytes=0-` + 1 s, downloaded blocks ≤ prefetch window; after pause no new `download`; after
close 404; unknown core 404 and never opened. Fixtures via a provider seam:
`host/catalog/fixture-catalog.ts` behind `--dev-fixtures` (mock fixtures + live manifests from
the worker's `dev.fixtures` event; unsigned, loudly logged; no dev Signer — signer dir is
locked). Real nostr tested separately with L1's `FakeRelayPool`. Fence: `--dev-mocks` refuses a
non-loopback swarm bootstrap.

**(b) Electron e2e** — `e2e/stage1.e2e.ts`, only with `NUTFLIX_E2E=1`, never in `npm test`:
playwright-core `_electron.launch` of `dist/main/main.js --dev-mocks --dev-fixtures
--user-data-dir <tmp>`; fixture MP4 from system ffmpeg (`lavfi testsrc`, x264, `+faststart`,
6 s; skip if no ffmpeg). Assert: price shown → Play; `video.currentTime > 1`, `videoWidth > 0`,
a seek (206 via `nf-media:`); WalletChip rate > 0; webPreferences + `window.nutflix` key
allowlist; Watch→Home mini-player; Watch→Watch leaves exactly one open session (main's
`nf-media` token count is 1). Prerequisites: D4 (Cameron's root step) + a display (try
`--ozone-platform=headless`, then Wayland, else `xvfb`).

## 6. Lanes

**L6-0 foundation (first, alone):** `src/ipc/{protocol,worker-protocol,guards,framing}.ts` +
tests; ambient types `src/types/{pear-runtime,bare}.d.ts`; `src/index.ts` exports `PACKAGE`,
`transcode`, `ipc`; tsconfig solution + `main`/`preload`/`renderer` (DOM + JSX)/`worker` (no
DOM)/`host` configs; `vitest.config.ts` (`src/**/__tests__/**/*.test.ts(x)`, exclude `e2e/`,
node environment by default with per-file jsdom docblocks). Merged and frozen before A/B/C.

| Lane | Allowlist (under `packages/app-desktop/`) | Done when |
|---|---|---|
| **L6-C worker** | `src/worker/**` except `transcode/`, `scripts/bare-probe.ts` | **Day 1:** a Bare probe under bare-sidecar's `bare` loads `@sovit/seeder` (bare condition) + `@sovit/core`, does a Seeder put/get, and the gated blob server answers a Range request. Then `WorkerHost` (runtime-neutral, injected adapters), Bare adapters, own swarm, viewer payer, playback server, `providers.ts` (undefined like L3's) + `dev/{dev-mocks,loopback-pay,fixtures-net}.ts`, ffmpeg probe, `studio/upload.ts` (L8 runner, `studio.publish` request). §5(a) green; worker-protocol guards fuzzed; no `console` (redacting logger) |
| **L6-B host** | `src/host/**` | `DesktopNetworkAdapter` over a `FakeWorker`; a conformance suite checks error prefixes/codes against `MockNetworkAdapter`'s; reads via L1; `unreact` publishes a kind-5 with only the viewer's own kind-7 ids and never a `-` (SE-5); `autoTopUpDue()` false when `belowSats <= 0`, tested (SE-4), nothing executes a top-up in Stage 1; `image()` rules; atomic settings; session backstop; runs under plain Node in tests and under `utilityProcess` |
| **L6-A shell** | `src/{main,preload,renderer}/**`, `scripts/bundle.ts`, `e2e/**`, `static/**` | **Day 1:** fidelity spike (risk 5). Then §3 fully tested against a `FakeHost` (IPC dispatch backed by `MockNetworkAdapter`); §4 in jsdom — coordinator tests for Watch→Watch, Watch→Home, Shorts-over-mini (≤ 1 unpaused, none leaked), theme at boot and on change, every prop wired. Finally §5(b) after rebasing onto merged C and B |

**Merge order:** L6-0 → **L6-C → L6-B → L6-A** (A last: it owns the integrated e2e).

**Not in Stage 1:** real signer / `onChangeSigner` / NIP-46; real engine, pay/1 codec, NIP-60
wallet; executing auto top-up; OTA (`new PearRuntime`); packaging (forge/pear makers), fuses,
asar integrity; `nutflix://` deep links; opening external links (Stage 3: https only + confirm);
Blossom mirroring + thumbnail upload; Channel `seedingVideos`; real `satsByRendition`; the money
confirm dialog (Stage 2).

## 7. Risks, ranked

1. **Electron can't launch here** (v) → D4; spike ozone headless; tests assert no `no-sandbox`.
2. **No cross-process pay/1** → D1.
3. **Blob server prefetches the whole range** (v) → L6-C builds the gated wrapper first and tests
   "downloaded ≤ window"; fallback: own `bare-http1` range server.
4. **Code under Bare 1.31** — **mostly retired 2026-09-23 by an orchestrator probe** with the
   real `bare` (bare-sidecar prebuild): Bare has `URL`, `Buffer`, `queueMicrotask`, timers, but
   **no `TextEncoder`/`TextDecoder`, `crypto`, `AbortController`, `process`**. nostr-tools and
   core's media pipeline construct a `TextDecoder` at module load, so `@sovit/core` (and the
   seeder, which imports core) crash on import. With **`bare-encoding/global` imported first**
   (pinned `bare-encoding@1.0.3`, holepunch, zero deps, audited) all of `@sovit/core` (incl.
   `MockPaymentEngine`), `@sovit/seeder` (bare entry, no Node adapters),
   `@sovit/gateway/upstream` and `hyperdht/testnet.js` load under Bare, ESM workspace symlinks
   included. **The worker entry's first import must be `bare-encoding/global`.** Still open for
   L6-C: runtime use of `crypto`/`AbortController` (pin `bare-crypto`/`bare-abort-controller` if
   hit — both holepunch). Worker-side `src/ipc/` code uses `b4a`, never the globals.
5. **`contextBridge` fidelity / Electron 44 specifics** (Maps; `File` → `webUtils` in a
   sandboxed preload; seeking through `protocol.handle` + `net.fetch`; ESM `utilityProcess`;
   `utilityProcess` spawning bare-sidecar) → L6-A day-1 fidelity page; fallback: run the host
   module in main (it takes an injected transport).
6. **Loopback exposure / paid-core abuse** → `resolve` allowlist + `nf-media:` proxy.
7. **Wallet exfiltration through the bridge** → D3 now; money-gate dialog in Stage 2.
8. **Toolchain rough edges:** `pear-runtime` experimental, types missing; `bare-sidecar` chmods
   its binary at require time (fails on a read-only packaged install) — packaging-time only.
9. **Load:** Electron + Bare + host + vitest are heavy; run e2e serially. (the dev laptop has
   30 GB RAM / 8 cores; parallel lanes pushed load to ~20 today — timing-sensitive tests in
   seeder/gateway notice.)
