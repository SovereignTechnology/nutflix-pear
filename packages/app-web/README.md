# @sovit/app-web

The web client for NFX videos, to be served at web.nutflix.xyz. Its static site builds here and is
tested end to end; it is not deployed yet. [ADR 0022](../../docs/decisions/0022-a-web-client-for-nfx.md)
records the decision and its reasons; this file says what it is, what is here and how it is built.

## What it will be

The desktop app's interface in a browser, working like a Nostr client, for free NFX videos only:

- **The same screens.** Home (Network and tags), Search, Channel, the NFX watch page and Settings,
  from `@sovit/ui`, in the shell the desktop app uses. Screens that need a wallet, a signer or
  Hypercore (Shorts, Library, Studio, Wallet, Subscriptions, Trending) are not offered.
- **Discovery over ordinary Nostr relays.** Manifests (kind 38504) from the read relays and the
  network's scoped relay, beacons (kind 20464) from the scoped relay. Search uses NIP-50 only on
  relays whose NIP-11 document lists it, and matches a plain query in the page elsewhere.
- **Video over WebRTC.** nfx's web player, as a library pinned by commit and sha256 in
  `nfx-web.lock`, plays a video with hls.js and p2p-media-loader: segments come from other viewers
  and from bridge seeders, signalled through WebTorrent trackers, with SovTech's own STUN server.
  In the first version the hash list, playlists and init segments come over HTTPS, and so do
  segments no peer has.
- **Checked in WebAssembly.** The manifest's signature, the hash list against the manifest, and
  every segment against the hash list, whichever peer or origin sent it.
- **Signed out.** No key, no wallet and no payment. NIP-07 sign-in comes after the first version.

## What it costs a viewer

The page says so too: relays, trackers, the STUN server, origins and the peers a browser meets all
see the viewer's IP address. A viewer's browser uploads the segments it holds to other viewers of
the same video. Whoever serves the page can change it; a browser cannot fully protect against that
(threat T13 in [`SECURITY.md`](../../SECURITY.md)).

## What is here

- **`src/adapter/`: the `NetworkAdapter`** (`platform: 'web'`). Feeds, search and the NFX watch page
  go through core's NFX catalogue, with search routed by each relay's NIP-11 document; plays wait
  for seeders' live beacons (core's beacon watch) and hand nfx's player the origins and trackers
  they name, checked (`https:` and `wss:` only, no query or user-info, public hosts), then the
  fallback origin `https://web.nutflix.xyz/o` and the configured trackers, 4 in all. Images load
  only when their publisher signed their sha256, and reach the screens as `blob:` URLs of bytes
  that match it. Calls that need a wallet, a signer, Hypercore or Studio reject `unsupported`.
- **`src/nfx-lib.ts`: the part of nfx's player library the adapter calls** (`init`, `open`), so the
  site build can wire in the pinned library and the tests a fake.
- **`src/settings/`: settings in Web Storage** under `nutflix.web.settings.v1`, checked on every
  read and write like the desktop host's `settings.json`; an unreadable value means defaults, and a
  `storage` event keeps open tabs in step. NFX is always on. The only module here that may use
  browser storage (SECURITY.md invariant 8).
- **`src/main.tsx`: `startWebClient`**, `@sovit/ui`'s shell with the web's offer (Home and Settings
  in the sidebar; Settings' Appearance, Playback, Relays and NFX), the route mirrored in the hash
  (`#/watch/<address>`, also `?a=<address>`).

## How it is built

A static site, `dist/site/`, from `scripts/build-site.ts` (esbuild), with nfx's player library
pinned in [`nfx-web.lock`](nfx-web.lock):

| File                                         | What                                                                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`                                 | `site/index.html` with a CSP `<meta>` and SRI on every script, module and stylesheet (`scripts/csp-sri.mjs`)                                                            |
| `app.js`                                     | `site/entry.ts` bundled: `startWebClient` over nfx's library                                                                                                            |
| `ui.css`, `shell.css`                        | `@sovit/ui`'s styles                                                                                                                                                    |
| `nfx/player.js`, `nfx/wasm/nfx_wasm_bg.wasm` | nfx's library and its WASM verifier, byte for byte from the pinned tar; `index.html` preloads the library with its SRI hash, and `app.js` fetches the WASM with its own |
| `source.json`                                | the pear and nfx commits, the lock, the CSP and the sha256 of every file (AGPL-3.0 §13), linked from Settings                                                           |

Beside it, `dist/site-headers.txt` (the `Content-Security-Policy` and the other headers to serve the
page with) and `dist/nutflix-web-site-<pear commit, 12 hex>.tar` (the site as a tar with fixed
metadata). From a clean checkout, with nfx-web.lock's tools on `PATH` for the library tar:

```sh
npm ci --ignore-scripts && npx tsc -b && npm run -w packages/ui build:css
bash packages/app-web/scripts/nfx-lib.sh build    # the library tar, refused unless it is the lock's
npm run -w packages/app-web build:site            # dist/site, its headers and its tar
```

The build refuses a library tar that is not the lock's, a library whose `player.d.ts` and
`api.d.ts` no longer fit `src/nfx-lib.ts` (`site/lib-check.ts`), a bundle that loaded anything on
its deny list (Cashu, sodium, Hypercore, Bare, Electron, Pear, BIP-39, core's wallet, payment,
signer and main entry, the gateway, the seeder, the desktop app, Node built-ins), a page with
anything inline or from another origin, and a pear tree with uncommitted changes. It prints every
file's sha256, the tree hash (`scripts/reproducible-build.mjs`'s definition) and the tar's sha256;
built twice from the same commit, at any path, they are the same.

The page's CSP: `default-src 'none'`; scripts, styles and fonts from the page's own origin only,
plus `'wasm-unsafe-eval'` so that the WASM compiles (never `'unsafe-eval'`); `connect-src 'self'
https: wss: blob:`, because relays, origins and trackers can be anywhere, and the verified WASM
reaches nfx's `init` as a `blob:` URL; media and images from the page or `blob:`; no frames,
objects, forms or base URI.

Re-pinning nfx is one line of `nfx-web.lock`: `bash scripts/nfx-lib.sh pin <commit>` (or the
`web-site` workflow dispatched with `repin`) prints it.

## Tests

- `npm test`: the adapter, settings and shell (jsdom), and the site build's rules
  (`scripts/__tests__`: the lock, the deny list, the tree hash, `source.json`).
- `e2e/web.e2e.ts`: the built site in headless Chromium under its own headers, against nfxd built
  from the lock's nfx commit (scoped relay, origin, tracker and a WebRTC bridge) and a stock relay
  without NIP-50 (strfry), all on loopback. It checks the feed, search on both relays, playback,
  playback from the bridge once the origin refuses every segment, a lying origin refused, a deleted
  video, a video nobody seeds, the Settings notices and `source.json`, and that the CSP refused
  nothing. `.github/workflows/web-site.yml` runs it on every change to the client.
