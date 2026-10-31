# Changelog

All notable changes to the Nutflix desktop app are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are desktop releases: release
`X.Y.Z` is the tag `desktop-vX.Y.Z`, and its downloads and signed notice are on the
[Releases page](https://github.com/SovereignTechnology/nutflix-pear/releases). Dates are UTC.

## [Unreleased]

### Added

- The worker seeds its NFX videos over iroh too, NFX-06 through the iroh helper (ADR 0020 slice
  5e-3, ADR 0021), beside HyperDHT and only while seeding and the NFX setting are both on.
  - **The helper:** one per worker, started when a stored video is to be served and stopped when
    serving goes off. Dev and CI name it in `NUTFLIX_IROH_HELPER`; a packaged build's own copy
    comes with slice 5e-5. Without one the worker speaks HyperDHT only.
  - **A stable node:** its iroh key is derived from the worker's Corestore primary key
    (`nfx:<namespace>:iroh`), so the node id survives restarts. The network's own iroh relays
    only; a change of them restarts the helper.
  - **What it serves:** each file is imported by its path in the NFX store, only for a file of a
    stored video's verified hash list. The collections are NFX-06 §2's: `meta`, then one per
    rendition in its playlist's order (moved out of spike S-D into `worker/iroh/collections.ts`).
  - **Beacons:** `nfx.endpoint` is per video now and answers an `iroh` endpoint (node, network
    relay, addresses, a ticket per collection) beside the `hyperdht` one. Core writes the tickets
    in key order.
  - **Seams:** `WorkerRuntime.spawnHelper` (`bare-subprocess` under Bare, `node:child_process` in
    tests) and `NfxStore.path`.
  - **CI:** a job builds the helper (pinned toolchain, `--locked`) for the test job, and the
    worker's iroh suite fetches every file back through a second helper. It fails there, never
    skips, without one.
- Settings › NFX network lists the network's own iroh relays (contracts version 12, ADR 0020
  slice 5e-2, ADR 0021).
  - **What they are:** every NFX network runs its own iroh relays (NFX-06 §1). They are the only
    relays the app's iroh helper will use, and the only ones its beacons will name.
  - **A local setting:** the list is set here and never taken from a beacon; a relay a ticket
    names that is not on it is dropped.
  - **The form:** `https://host[:port]/`, as iroh writes it (the field normalises what is typed),
    or `http://` to this computer only, for a local relay. At most 4, and no duplicates.
  - **Without one:** iroh connects directly or not at all.
  - **Stored settings:** an NFX setting from an earlier build stays valid. A bad iroh relay list
    turns NFX off and leaves every other setting standing.
  - **Not used yet:** the worker hands them to the iroh helper with slice 5e-3.
- Free uploads go to NFX (ADR 0020 slice 5d-4).
  - **In Studio:** while the NFX setting is on, a video can be free (a price of 0), and a free
    video always goes to the NFX network too.
  - **One card per video:** when the network can play here (scoped relays set), a free NIP-71
    video and its NFX copy show as one card, the NFX one, which plays without a wallet. A priced
    video keeps its card, and its free copy is never listed.
  - **Core:** `nostr.nfxTwinsOf` finds the same-author NFX copies of NIP-71 events in one
    bounded query.
- Free NFX videos play (contracts version 11, ADR 0020 slice 5d-3).
  - **Finding seeders:** `playNfx(addr)` reads the video's live beacons from the network's scoped
    relays. Each must pass core's `parseBeacon`, name this manifest's author and address, and be
    free, and only each seeder's newest counts.
  - **Opening:** the host passes those seeders to the worker's `nfx.play.open` and hands main the
    media link.
  - **No money:** there is no balance check, and the session never reaches the money plane.
  - **On the Watch page:** NfxWatch has *Play — free*, the video with a quality picker, and
    *No seeders online* with Retry.
  - **Closing:** a session closes with the page, its webContents, or the worker.
- The worker plays a free NFX video (ADR 0020 slice 5d-2), as `nfx.play.open` / `nfx.play.close`.
  - **What it does:** it dials the seeders it is given over HyperDHT and fetches the hash list,
    the playlist, the init and the first segment, each file sha256-checked. It then plans layout C
    and serves it from a loopback range server, while fetching the rest ahead of the player.
  - **Checking:** each later segment is held to the plan.
  - **Connections:** one refcounted connection per seeder, shared by every session of a run.
  - **Without a wallet:** this works without payment providers too, from a DHT node of its own.
  - **Not yet reachable:** the host and the player come with slice 5d-3.
- Core plans how a remote NFX rendition plays (ADR 0020 slice 5d, spike S-E's layout C):
  `media.planNfxPlayback` predicts the global `sidx`, and every segment's `tfdt` and served size,
  from the verified hash list, the init and the first segment alone.
  - `media.checkNfxSegment` holds each later segment to that prediction on arrival.
  - A progressive file part can start `skip` bytes into the stored file, so a segment is served
    from its `moof` without a copy.
  - Nothing plays NFX yet; the worker and the player come next.
- The worker seeds its NFX videos over HyperDHT, NFX-12 `nfx/files/1` in free mode (ADR 0020
  slice 5b).
  - It serves only while seeding and the NFX setting are both on.
  - It listens on the swarm's DHT with a key pair of its own per network, derived from the
    worker's key and never the legacy swarm's.
  - It answers only for files a stored video's verified hash list names.
  - Two new worker messages give the host what beacons need: the `hyperdht` endpoint with its
    `bind` for a seeder key, and the list of stored videos.
- NFX beacons (NFX-03, ADR 0020 slice 5c). While the worker serves, the host publishes one
  kind-20464 beacon per seeded video every minute.
  - **The beacon:** TTL 120 s, free (`price_hint` 0, no mints), `chunks: "all"`, with the
    worker's `hyperdht` endpoint.
  - **Where it goes:** the network's scoped relays, and nowhere else.
  - **Which videos:** only those whose current manifest, by the recorded author, names the root
    the store verified, and that the author has not deleted. This is rechecked every 10 minutes.
  - **Signing:** each beacon is signed by an NFX seeder key, one per network and user, held by
    core's `LocalSigner` and kept in a key file in `<userData>/nfx/`. The key file's random
    passphrase is sealed NIP-44-to-self by the user's signer. The key signs beacons and nothing
    else.
  - **Which author:** the host records whose manifest each seeded video is when it publishes the
    user's own.
- Settings › NFX network (contracts version 10, ADR 0020 slice 5a): taking part in nfx's testnet
  is now a setting, off by default.
  - When on, the catalogue lists the network's free videos beside the Nostr ones. A free upload's
    NFX announcement also goes to the network's scoped relays (NFX-04), which the section lists.
  - Scoped relays are `wss://`, or `ws://` to this computer only (a local node's embedded relay).
    There are at most 8, and no duplicates.
  - A stored NFX setting this build does not understand turns NFX off and leaves every other
    setting standing.
  - This replaces the host options the earlier slices used in tests.
- The NFX catalogue (ADR 0020, slice 4b-2). Given an NFX network, the host lists that network's
  free videos beside the NIP-71 ones. They appear in the subscriptions, tags and author feeds and
  in search, newest first under one cursor. `nfxVideo(addr)` finds one by address.
  - Reads go to the read relays first and to the network's scoped relays only as the fallback
    (NFX-04 §4).
  - A listing shows each address's current revision, ignoring one more than 15 minutes ahead
    (NFX-02 §4). It drops a manifest its author deleted (NFX-02 §6), so every page asks for the
    deletions of the addresses it shows.
  - It shows free videos only: `license open`, no price hint.
  - When an NFX manifest's `e` names a NIP-71 event by the same author that still exists, the
    NFX copy is dropped.
  - If the NFX side fails, the NIP-71 videos are listed alone.
  - No network is chosen yet, so production makes no NFX query; slice 5's settings choose one.
    `--dev-fixtures` lists two mock NFX videos.
- Contracts version 9: an NFX video's identity (ADR 0020). `NfxAddress` (`38504:<author>:<d>`)
  names an NFX manifest across its revisions. `NfxVideo` is a free kind-38504 manifest for
  listing, with no price and no Hyperblob renditions. `feed` and `search` return `CatalogVideo`,
  either kind of video, and a new `nfxVideo(addr)` fetches one by address. The screens narrow on
  `kind`, so an NFX video never reaches the player, the price panel, zaps, reactions, comments or
  the library. Its card says "Free" and offers no preview. Its page, `NfxWatch`, says it cannot
  play yet. Nothing lists NFX videos yet: the catalog source is slice 4b-2, and stays off until
  an NFX network is chosen.
- A free upload packaged for NFX is announced with its kind-38504 manifest (NFX-02). The creator
  signs it with the same signer as the legacy event, and it goes to the write relays and the NFX
  network's scoped relays. It carries the hash list's `root`, the thumbnail, and an `e` tag back
  to the legacy event. The host signs only the creator's own upload: the stored video must be the
  one the legacy event derives (`nfx.legacyVideoAddr`, the one derivation the worker and the host
  share), and the signer must be its author. In practice nothing is
  announced yet, because Studio still refuses a price of 0 (#15); beacons come with slice 5's
  transport.
- Spike S-E: an NFX rendition as one progressive fMP4 (`nfx.renditionMembers`,
  `nfx.progressiveLayout`, `nfx.locate`; `media.buildSidx` and friends for a global `sidx`),
  played by Electron's Chromium through the app's own `nf-media:` proxy and CSP in a new e2e
  suite: the init, one global `sidx` and the segments without their own index play with their
  exact duration and seek by Range; the files as written never start, because the player walks
  every segment first (`docs/spikes/S-E-nfx-progressive-playback.md`). Nothing in the app plays
  NFX yet.
- Spike S-D: the app will also speak iroh (NFX-06) through a thin Rust helper process (ADR 0021,
  nfx ADR 0103). `crates/iroh-helper/` moves bytes over iroh and iroh-blobs and decides nothing;
  the worker's client for it (`worker/iroh/`) frames requests over stdio with a maximum frame
  length, validates every reply, bounds what it buffers, and kills and restarts a helper that
  breaks the protocol. The helper never says bytes are "verified": every NFX file is still checked
  against its sha256 in JavaScript. The `spike-iroh` workflow builds it (11.3 MB) and judges it
  against nfxd in both directions through S5′'s NAT matrix: every cell passes, and with a TLS relay
  offering address discovery two NATed helpers holepunch. Driving it from the real Bare runtime
  through `bare-subprocess` fails (Bare tears itself down mid-run), and is open for slice 5
  (`docs/spikes/S-D-iroh-helper.md`). Nothing in the app starts the helper yet.
- `@sovit/core` reads and writes the NFX wire formats (`nfx/`, ADR 0020): namespaces, kind-38504
  manifests and their deletions, kind-20464 beacons including the NFX-12 `hyperdht` endpoint and
  its `bind`, hash lists and playlists, canonical JSON, and the `nfx/files/1` and `nfx/pay/1`
  message layouts. Every case of the suite's vectors runs in the tests, against copies pinned by
  sha256 in `docs/vendor/nfx-test-vectors/`. Nothing in the app uses it yet.
- `@sovit/seeder` speaks the NFX-12 HyperDHT transport (`nfx/`): a seeder listens on its
  per-network peer key and serves whole files over `nfx/files/1`, a watcher dials that key and
  fetches them, each file capped at its size and checked against its sha256 before it counts.
  Flow control keeps at most one 64 KiB frame queued on top of the stream's buffer, and the
  per-connection limits, keepalives and the 60-second idle rule are enforced. It also signs the
  beacon's `hyperdht` `bind` and carries `nfx/pay/1` messages without acting on them. Free mode
  only, and nothing in the app uses it yet.
- `@sovit/core` packages a video as NFX-05 content (`media.packageNfx`): the H.264 renditions the
  studio already encodes are remuxed by stream copy, with no second encode, into CMAF (an init
  segment and 2 s fMP4 segments each). Every file is named by its sha256, playlists name content
  only, the CODECS strings come from the init segments' bytes, and the hash list is checked as a
  consumer would check it before it is returned. Nothing in the app calls it yet.
- Studio can also package a free video for NFX (contracts v8 `UploadInput.nfx`, ADR 0020): after
  the legacy upload publishes, the worker packages its renditions and keeps the files in a new
  NFX file store beside the legacy one, in the same disk cap and joined to no swarm, and reports
  the result as its own `upload.nfx` status. Every boundary refuses it for a priced video, and an
  NFX failure never fails the legacy upload. The Studio choice appears once free videos can be
  uploaded (#15); nothing is published to NFX yet.

### Changed

- The repository is renamed `nutflix-pear` (was `nutflix-demo`): the GitHub repo, every README
  badge and clone URL, the package metadata, docs, CI, issue templates and the desktop release
  notes now point at `SovereignTechnology/nutflix-pear`. The 0.1.0 downloads and their signed
  notice are unchanged.

### Fixed

- Merged NIP-71 and NFX feeds no longer skip a video when twins are dropped mid-page. A page
  stops at the oldest item of a side that has more, and a page left empty steps on.
- A video request the player drops now ends main's fetch from the worker too. Before, after a
  reload or a quick switch of video, those requests stayed open, holding the 6 connections main
  keeps to the worker, so the next video's requests never reached it and the worker's paid
  stream stayed open. A new e2e suite (`proxy-abort`) holds 8 requests open through the app's
  own handler: after a reload all of them close within 30 ms, and a new source gets through
  (spike S-E, finding 6).
- The NFX file store refuses a hash list that gives a file two sizes, or another size than the
  one it already stores. Before, such a list (from a peer, once seeders fetch NFX videos)
  skewed the disk cap and could delete another video's files at the next start. It also cleans
  up after a crash mid-write, checks every recorded file's size on disk when it loads, drops a
  damaged record on its own instead of the whole list, refuses hash lists over 16 MiB, and no
  longer stops the seeder from starting when it cannot load.
- Playback on real relays: the desktop app no longer reports zero seeders for every video it finds
  on a relay. It has no seeder count for those videos, so it reports the count as unknown. The
  watch page and Shorts no longer replace Play with "Nobody is seeding this video right now", and
  a channel's About tab no longer says no seeders are online
  ([#23](https://github.com/SovereignTechnology/nutflix-pear/issues/23)).

### Security

- Electron 44.9.3 (was 44.2.0). It fixes GHSA-fw47-9c62-h3vw, where `hid` and `usb` permission
  checks from a subframe were attributed to the top-level origin (fixed in 44.3.0), and carries
  the later backported ANGLE, Chromium, PDFium, Skia and V8 fixes. Chromium 152.0.7977.167 (was
  .76) and Node 24.22.0 (was 24.20.0); the native-module ABI is unchanged (149).

## [0.1.0] - 2026-10-05

The first release of the desktop app, for Linux x86_64. It is experimental: read the
[known limitations](README.md#known-limitations) before relying on it.

### Added

- The desktop app: Home, Search, Shorts, channel pages, Library, Watch, Studio, Wallet and
  Settings, on Electron with a Bare worker for the peer-to-peer parts.
- Peer-to-peer streaming over Hypercore, Hyperblobs and Hyperswarm, with videos announced as signed
  Nostr events (NIP-71).
- Per-block payment in Cashu ecash over the `pay/1` protocol: an unpaid window enforced by the
  seeder, two locked proof sets per payment (seeder and creator) with DLEQ proofs, creator-chosen
  mints, and one seeder paid per block.
- A NIP-60 wallet with a journal that recovers from crashes, a 12-word recovery phrase (NUT-13),
  Lightning funding and withdrawal, and an optional auto top-up that is off by default.
- Studio: transcode an upload to 1080p, 720p and 360p, set a price per block and a seeder/creator
  split, and publish. Seeding is off by default, with a 10 GiB cap.
- Sign-in with an encrypted local key or a NIP-46 remote signer.
- Linux packages: a `.deb` for Debian and Ubuntu, and an AppImage for other distributions (not for
  Ubuntu 24.04 or later). Chromium's sandbox is always on, and a packaged build refuses the
  development flags.
- Release integrity: `SHA256SUMS`, a signed Nostr release notice (kind 30071) signed by the SovTech
  key, and `scripts/release-verify.mjs` to check a download against it.
- A headless seeder daemon and a gateway with hardened systemd units (not part of the desktop
  release), and a fuzz workflow for the `pay/1` codec and the payment parsers.

### Not included

- Windows, macOS and arm64 builds, automatic updates and operating-system code signing.
- A web app: `packages/app-web` is an empty scaffold.

[Unreleased]: https://github.com/SovereignTechnology/nutflix-pear/compare/desktop-v0.1.0...HEAD
[0.1.0]: https://github.com/SovereignTechnology/nutflix-pear/releases/tag/desktop-v0.1.0
