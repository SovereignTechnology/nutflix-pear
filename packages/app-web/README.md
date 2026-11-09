# @sovit/app-web

The web client for NFX videos, to be served at web.nutflix.xyz. It is being built and nothing ships
from it yet. [ADR 0022](../../docs/decisions/0022-a-web-client-for-nfx.md) records the decision
and its reasons; this file says what is coming.

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

## How it will be built

A static site from `scripts/build-site.ts` (esbuild): one page with SRI on every script and on the
wasm and a CSP with nothing inline, the `@sovit/ui` styles, nfx's player and its wasm, and a
`source.json` naming the exact source (AGPL-3.0 §13). The bundle is checked against a deny list:
no Cashu, sodium, Hypercore, Bare, Electron, wallet, payment or signer code.
