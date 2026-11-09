# 22. A web client for NFX videos

Date: 2026-11-09

## Status

Accepted (Cameron, 2026-11-09). Reverses [ADR 0019](0019-scope-pear-desktop-only.md)'s web-portal
ruling for one kind of web client: one that lists and plays NFX videos only. Amends
[ADR 0020](0020-speak-nfx.md), which repeated that ruling ("ADR 0019 still holds otherwise").
Restores threat T13 and invariant 8 of `SECURITY.md` for that client. The nfx side, that nfx ships
its web player as a library this client uses and does not import this repository, belongs in
nfx's [ADR 0101](https://github.com/SovereignTechnology/nfx/blob/main/docs/decisions/0101-nutflix-pear-interop.md).

## Context

ADR 0019 ruled the web portal out. The portal of the early plans (ADR 0002, ADR 0003) ran Hypercore
in the page over a WebSocket to a gateway, so the gateway's operator sat in every session's path,
and the page carried shims that every Hypercore bump could break. Nothing of it was built, and
ADR 0019 said that a browser shell, if one were wanted, belonged to nfx.

Since then this app has learned to speak NFX (ADR 0020, ADR 0021), and nfx has built a browser
player for NFX-10: hls.js with p2p-media-loader, one WebRTC swarm per rendition, every file checked
in WebAssembly before the media stack sees it. The test network `nfx:testnet:1` has public relays.

Cameron (2026-11-09) asked for web.nutflix.xyz to have the same interface as this desktop app, to
work like a Nostr client, and to get its videos over WebRTC from other NFX nodes.

A client that does only that avoids every reason ADR 0019 gave:

- **No Hypercore in the page.** It lists and plays NFX videos only. NIP-71 videos, Hyperblobs and
  `pay/1` stay desktop-only, so nothing of the in-page Hypercore stack or its shims is needed.
- **No gateway.** Nothing of ours relays the page's traffic or serves it a view of the network.
  `packages/gateway` is not used.
- **Discovery over ordinary Nostr relays.** Manifests (kind 38504) are read from public relays,
  where NFX-04 §4 mirrors them, and from the network's scoped relay; beacons (kind 20464) live on
  the scoped relay. Any relay that speaks NIP-01 works. NIP-50 search is used only where a relay
  offers it.
- **Delivery over WebRTC.** Segments come from other viewers and from bridge seeders (NFX-10 §2:
  nodes that serve both the iroh mesh and the browser mesh), signalled through WebTorrent trackers.
- **Verification in wasm.** The manifest's signature is checked again, the hash list against the
  manifest's root, and every segment against the hash list, whatever its source, a peer or an
  HTTPS origin (NFX-10 §1). A peer or an origin can withhold a file but cannot change it.

## Decision

1. **`packages/app-web` becomes an NFX-only web client**, served at web.nutflix.xyz.
   - It renders `@sovit/ui`'s screens (Home, Search, Channel, the NFX watch page, Settings) in the
     desktop app's shell, which moves into `@sovit/ui` for both apps to use.
   - Its `NetworkAdapter` reports `platform: 'web'`. It lists and plays free NFX videos, reads
     profiles, and shows images only when they match a hash their publisher signed. Calls it cannot
     serve reject `unsupported`, and the shell hides the screens and actions that need them: Shorts,
     Library, Studio, Wallet, Subscriptions and Trending, and every action that signs (reacting,
     commenting, following, reporting).
   - No wallet, no seeding, no Studio, and no Hypercore.
2. **nfx's player, as a library.** The page does not reimplement NFX-10. nfx ships its web player as
   a library (`init`, `resolveManifest`, `open(element, …)`), built reproducibly as a tar file named
   by its commit. This repository pins it by commit and sha256 in `packages/app-web/nfx-web.lock`.
   nfx never imports this repository. ADR 0020's rule that this app is written from the NFX specs
   alone still holds for the desktop app, which stays the second, independent implementation. The
   web client runs nfx's player code and does not count as one.
3. **The mesh is on, and the page says what it costs.** A viewer's browser uploads the segments it
   holds to other viewers of the same rendition (NFX-10 §2). It uses the trackers in its settings
   (by default `wss://web.nutflix.xyz/tracker`) and the trackers named in seeders' beacons
   (`webrtc` endpoints) without asking. Every tracker URL is checked as nfx's player checks it:
   `wss:`, or `ws:` to a loopback host; no credentials, query or fragment. At most 4 are used. The
   page says plainly that trackers and peers see the viewer's IP address.
4. **Our own STUN server.** `iceServers` lists `stun:web.nutflix.xyz:3478` and nothing else: a
   Binding responder that SovTech runs (nfxd's `--stun`, built on the nfx side), with no TURN and no
   third party. A Nostr relay cannot do this job. It is a WebSocket over TCP, so it never sees the
   browser's UDP mapping, and browsers gather server-reflexive candidates only from the STUN
   servers in `iceServers`. Nostr stays the discovery path.
5. **In v1, an HTTPS origin serves the hash list, playlists and init segments.** Origins come from
   the beacons first, by nfx's player's rules, then `https://web.nutflix.xyz/o` as a fallback.
   Media segments come from peers over WebRTC where they can, and from the origin otherwise;
   playlists and inits never travel over the mesh (NFX-10 §1). Everything an origin serves is
   checked as above.
6. **Default relays.** The read relays are ADR 0009's four, with its 2026-11-07 amendment
   (`relay.damus.io`, `nos.lol`, `relay.primal.net`, `relay.ditto.pub`). The network's scoped relay
   is `wss://relay.nutflix.xyz`, as in the desktop app's `DEFAULT_NFX`. NFX is always on in this
   client, on `nfx:testnet:1`, because it is the only thing the client does. The iroh relay is not
   used: no iroh runs in the browser.
7. **Signed out in v1. NIP-07 comes later.** v1 has no signer, so the page never holds a key. NIP-07
   sign-in follows v1, and the key then stays in the browser extension. No NIP-46 runs in the page
   in v1. Free videos only.
8. **Settings stay in the browser.** They are stored in Web Storage, under one key
   (`nutflix.web.settings.v1`), and checked on read as the desktop host checks `settings.json`. An
   unreadable value means defaults. Nothing secret is stored.
9. **The old test player stays.** nfx's single-video test page moves to `/player/` on the same
   site.

## T13 and invariant 8, restored

ADR 0019 kept threat T13 (malicious portal JavaScript) and invariant 8 (no browser persistence of
proofs or keys) for a future browser shell. This client is one, so both apply again.

- **T13.** Whoever controls web.nutflix.xyz can serve a page that lies: one that shows other
  videos, skips the checks, or reports the viewer's activity. The controls are the threat table's:
  open source, SRI on every script and on the wasm, a CSP with nothing inline and nothing from
  other origins, a reproducible build, and the build's hash in a signed Nostr event (kind 30071,
  as for desktop releases). The page links to the exact source it was built from (AGPL-3.0 §13).
  As T13 says, this is not fully fixable in a browser, and the page says so. In v1 the page holds
  no key and no money, so what is at risk is the web session: what the viewer is shown and plays,
  and the viewer's IP address.
- **Invariant 8.** The page keeps no key, proof, token or wallet state in browser storage. v1 has
  no wallet and no signer at all. A later version holds NIP-60 state in memory only, and with
  NIP-07 the key stays in the extension. Web Storage holds the settings and nothing else. The
  invariant's test forbids every browser storage API in `packages/app-web/src` today; the web
  adapter (M3) relaxes it for its settings module only.

## Consequences

- `packages/app-web` stops being a placeholder. ADR 0019's follow-up (delete it, and the web-only
  tooling) is withdrawn: `scripts/csp-sri.mjs` and `scripts/reproducible-web-build.sh` get a
  shipping target again.
- The gateway-and-Hypercore portal of the early plans stays out. A web client that plays NIP-71
  videos would need a new decision.
- **Who sees what.** A viewer's IP address reaches the four read relays, `relay.nutflix.xyz`,
  web.nutflix.xyz (the page, the fallback origin, the default tracker and STUN), the beacons'
  origins and trackers, and the peers the browser meets. Of these, SovTech runs `relay.nutflix.xyz`
  and web.nutflix.xyz.
- **Contracts version 14** (additive): a `PlaySource` of kind `element`, whose `attach(element)`
  plays into a media element the screen owns, for a player the adapter drives itself; an optional
  `NfxPlaySession.setRendition`, which switches rendition without a new session; and
  `NfxSettings.trackers`, the NFX-10 §1 tracker list, checked as in item 3.
- **`@sovit/ui`** takes the shell (header, sidebar, router, playback coordinator, mini-player) with a
  filter for which sections a shell offers, and Settings takes a list of the sections it shows. The
  desktop app passes everything and renders as before.
- **`@sovit/core`** gains the subpath exports `@sovit/core/nostr` and `@sovit/core/nfx`, so a page
  can import the Nostr and NFX code without the wallet and Cashu. The NFX catalogue and the live
  beacon watch move from the desktop host into core, with their transports passed in.
- **Search on stock relays.** A relay's NIP-11 document says whether it supports NIP-50. Only those
  relays get a `search` filter; the others get a plain kind-38504 query for the network, matched in
  the client on title, description and tags, and the results are merged by address. The desktop app
  searches the same way.
- **The order of work:** this record (M0); nfx's player as a library (M1) and its STUN responder
  (M1b); the preparation above (M2); the web adapter and its tests (M3); the site build, with SRI,
  CSP and a bundle deny list (no Cashu, sodium, Hypercore, Bare, Electron, wallet, payment or
  signer code), and an end-to-end test against nfxd and a stock relay (M4); deployment (M5).
- **After v1:** NIP-07 sign-in, verified NFX thumbnails, the design system's player controls on NFX
  videos, and paying in the browser (NFX-10 §3).
