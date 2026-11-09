# @sovit/app-web

The web client for NFX videos, to be served at web.nutflix.xyz. It is being built and nothing ships
from it yet. [ADR 0022](../../docs/decisions/0022-a-web-client-for-nfx.md) records the decision
and its reasons; this file says what is coming and what is here.

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

## How it will be built

A static site from `scripts/build-site.ts` (esbuild): one page with SRI on every script and on the
wasm and a CSP with nothing inline, the `@sovit/ui` styles, nfx's player and its wasm, and a
`source.json` naming the exact source (AGPL-3.0 §13). The bundle is checked against a deny list:
no Cashu, sodium, Hypercore, Bare, Electron, wallet, payment or signer code.
