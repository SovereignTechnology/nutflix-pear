# Changelog

All notable changes to the Nutflix desktop app are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are desktop releases: release
`X.Y.Z` is the tag `desktop-vX.Y.Z`, and its downloads and signed notice are on the
[Releases page](https://github.com/SovereignTechnology/nutflix-pear/releases). Dates are UTC.

## [Unreleased]

### Changed

- **The web client takes its video from peers first** (ADR 0025, the maintainer's decision of
  2026-11-26). On web.nutflix.xyz and the nsite, each segment comes over WebRTC from a peer that
  holds it, and over HTTPS only as a rescue, when no peer delivers it in time. Stats for nerds
  says where segments come from and how many were rescued. A browser that cannot connect to
  peers (its WebRTC is off or kept to a proxy) is told so under the player, and a play that waits
  for a peer says "Waiting for peers…". The desktop app is unchanged.

### Added

- **A "No HTTPS" switch in stats for nerds, on the web client** (ADR 0025). On, the video comes
  from peers only: nothing more is fetched over HTTPS for it, and playback waits when no peer
  delivers. It takes effect at once and is remembered in that browser. The start of each video
  still loads a few small files over HTTPS; that goes away when nfx can send them over WebRTC.

## [0.1.4] - 2026-11-26

A local key can be created in the desktop app at last, stats for nerds in every player, free
videos found through the network's own relay first, and new default relays.

### Added

- **Stats for nerds in the video player** (#123, ADR 0024). Right-click the video, use its menu or
  press `n` to see where the video is coming from, source by source. Peers show by short ID.
  Their addresses appear only behind a "Show addresses" switch, which is off every time the panel
  opens and is never saved.
- **Stats for nerds in Shorts and the mini-player.** The same panel, opened by a "Stats for nerds"
  button or by right-clicking the video (in Shorts also with `n`). Addresses stay behind the same
  switch.

### Changed

- **Free videos (NFX) are found through the network's own relay first** (ADR 0020, the
  maintainer's decision of 2026-11-19), in the app and the web client. The Subscriptions, tags and
  author feeds, search and opening a video ask the network's scoped relay (`relay.nutflix.xyz` by
  default) first, and your read relays only as the fallback: when the scoped relay fails or times
  out, has nothing, or returns a short page, which is then merged with theirs (one entry per
  video, its newest revision, the scoped relay's copy on a tie). An outage, or a scoped relay that
  restarted and is still empty or refilling, never blanks or shrinks the catalogue. This departs
  on purpose from NFX-04 §4, which says public relays first.
  - Search asks the scoped relay first only when it answers NIP-50 text search
    (`relay.nutflix.xyz` does); otherwise your read relays first, as before.
  - The scoped relay now sees which authors your Subscriptions feed follows, the tags and search
    text you use and the videos you open; your read relays see them only when it falls short.
  - Unchanged: beacons (the scoped relays only), where a free upload's announcement goes (your
    write relays and the scoped relays), and the Network tab, which asks both at once.
- **New default relays** (the maintainer's decisions of 2026-11-18), in the app and the web client
  alike:
  - **Signaling** goes first to the network's own relay, `wss://relay.nutflix.xyz`, which SovTech
    runs, then to `relay.primal.net` and `relay.ditto.pub`. NFX-04 §1, amended that day, lets the
    network's scoped relay carry signaling (kind 25050 `nfx-mesh/1`, ephemeral and never stored).
    Like the other signaling relays, it learns which videos you seed or watch; it already saw your
    IP address.
  - **The read relays** are now `relay.primal.net` and `relay.ditto.pub`: `relay.damus.io` refuses
    this project's address and `nos.lol` has rate-limited it. Comments, reactions, profiles and the
    other social events stay off `relay.nutflix.xyz`, which keeps NFX's own events only.
  - **STUN** is named `relay.nutflix.xyz:3478` (was `web.nutflix.xyz:3478`): the same server and
    address, under the network's own relay name.
  - **Saved settings are kept.** Only an install or a browser that has never saved a setting picks
    up the new lists; any change in Settings saves the relay lists as they were. Settings › Relays
    and Settings › NFX network are where to change them.
  - **Release notices** (`scripts/release-publish.mjs`) go to `nos.lol`, `relay.primal.net` and
    `relay.ditto.pub`; the 0.1.3 notice failed on relay.damus.io.
- **The web client is built with nfx's player library at 4b6095c** (`packages/app-web/nfx-web.lock`,
  nfx #102, #117, #118 and #119). Its stats for nerds panel lists each WebRTC peer by short ID,
  with what it sent and received, and shows a peer's address only behind the panel's "Show
  addresses" switch. It fetches every file from all the sources it knows, one source's bytes per
  file, and leaves one that stalls, runs slow or sends bytes that do not verify (NFX-17 §4.3). It
  ranks origins in tiers (NFX-17 §4.2): the video creator's own beacon first, other seeders'
  next, and this site's fallback last. Origins are no longer ranked by how many seeders name them,
  since keys are free (#147). The desktop app is unchanged by it.
- **Dependencies.** Electron 45.3.1 (from 44.9.3; #127, #134), the iroh helper's lock at iroh 1.4.1
  (iroh-blobs stays at 0.103.x, which NFX-11 §4 pins; #121) and `url` 2.5.9 (RUSTSEC-2026-0592,
  a stack overflow in `Url::origin()` that the helper's code never calls; #139),
  `@cashu/cashu-ts` 4.13.0 (the money path keeps its synchronous DLEQ check; #133), jsdom 30 for
  the tests, and the patch and minor groups of that week. Building from source now needs Node
  22.22.2 or newer (`engines`; #134). There is no change to what the app does with money.

### Fixed

- **A local key can be created, imported and unlocked** (#150, reported on Nostr). In every
  earlier release, 0.1.0 to 0.1.3, "Create a new key" always answered "internal error". The app
  asked libsodium for guarded memory (`sodium_malloc`) for every key it holds, and Electron
  refuses that memory (the V8 memory cage; holepunchto/sodium-native#185), so the call threw
  before a key was made. The same call comes first when the wallet's journal is opened and when
  a WebRTC signaling key is made (0.1.3), which therefore cannot have worked in the packaged app
  either. Inside Electron, keys are now in ordinary process memory, wiped on lock; the seeder and
  gateway, on Node, keep guarded memory. [SECURITY.md](SECURITY.md#what-010-does-not-protect-against)
  states the limit. The unit tests run in Node and the Electron suites ran with mocks, so nothing
  had allocated key memory inside Electron: a new suite, `e2e/secure-memory.e2e.ts`, makes,
  unlocks and uses a key, derives the wallet seed and makes a signaling key inside the Electron
  binary.
- **An "internal error" from the signer or from any host call now leaves a line in the host's
  log** with the call's name and the error's code or class, never its message. Before, nothing
  recorded why.
- **The Network tab no longer drops videos** when the scoped relay's page and your read relays'
  page are each short of a full page but longer together: the rest now comes on the next page.

### CI

- **Release notices for nutflix-runtime** (`scripts/release-publish.mjs`, #144) can be drafted,
  verified and published with `d=nutflix-runtime`, only for the exact version, verlink and
  per-target sha256s that project's update gate checks. Nothing about the desktop notice changed.
- **`npm audit signatures`** keeps npm's cache of the attestation documents from the last passing
  run (#145): a runner that reached a wrong copy of one on the registry's CDN failed with
  `EMISSINGSIGNATUREKEY` or `FETCH_ERROR`. Every signature is still verified on each run.
- **`rust-advisories`** ignores RUSTSEC-2026-0543 (chrono is unmaintained; every version, no patched
  release), which reaches the iroh helper through iroh-blobs and netwatch's Windows watcher. It is a
  maintenance notice, not a vulnerability; the ignore is dated like the helper's others (revisit by
  2026-12-31, and at every iroh bump).

## [0.1.3] - 2026-11-17

Free video with no setup: NFX is on by default, on the test network's public relays, and the app
trades video with web browsers over WebRTC, signaled over Nostr.

### Added

- **The app trades video with web browsers, directly** (issue #89, ADR 0023; the maintainer's
  decisions of 2026-11-09 and 2026-11-15). With NFX on, the app fetches parts of a free video you
  watch from people watching it in a web browser and, while seeding is on, seeds the free videos
  it keeps to them, over WebRTC: no nfxd bridge in between, and no tracker. It is **on by
  default**, in builds that ship the iroh helper (the packaged app). What that means for you:
  - **Who sees your IP address:** the peers you connect to; the network's STUN server
    (`web.nutflix.xyz:3478`, which the app asks for its public address every 25 s while this
    runs); and the signaling relays.
  - **Signaling relays** are ordinary Nostr relays where the app and web viewers find each other
    (NFX-10 §6). The default is two of the app's default public relays, `relay.primal.net` and
    `relay.ditto.pub`, picked by a soak test (`scripts/mesh-relay-soak.mjs`). They learn your IP
    address and which videos you seed or watch, never how you connect: connection details are
    encrypted to the peer. NFX's own scoped relay does not carry signaling.
  - **What anyone can see there:** that some app is in a video's room, under a random key. The
    app uses a new key for each video you watch, and another for what it seeds (which its
    beacons already announce), never your own key. Anyone who knows a video can join its room
    and, by connecting, learn the IP addresses of the peers in it, as with any swarm.
  - **Settings › NFX network** has the switch ("Trade video with web browsers") and the list of
    signaling relays. Switch it off, or empty the list, and the app does no WebRTC at all.
  - Every part of a video that arrives this way is checked against the video's signed hash list,
    as from any other source. No relay server carries video (no TURN): two peers that cannot
    reach each other directly simply do not connect.
  - Contracts v17 and v18 (`NfxSettings.webrtc?`, `stunServers?`, `meshRelays?`).
- **The web client signals over Nostr too** (issue #89; the maintainer, 2026-11-15). The page at
  web.nutflix.xyz finds its WebRTC peers on the same two signaling relays as the desktop app, so
  a browser and the app meet, and it no longer speaks to a WebTorrent tracker. Settings › NFX
  network lists the signaling relays instead of trackers; a saved tracker list is dropped. This
  reaches the public site only when it is next deployed, together with the seeder's own mesh
  endpoint (`nfxd --mesh-relay`).

### Changed

- **Uploads make one rendition by default, and the creator picks the sizes** (issue #97, the
  maintainer's decisions of 2026-11-09). Until the network grows, Studio pre-selects one size:
  720p, or the file's own size when it is smaller. A size is the lines of the picture's short
  side, so a portrait 1080x1920 phone video is a 1080 file and its 720p is 720x1280. The Upload
  form's new **Sizes** field offers every size the file can make, never upscaled: 2160p, 1440p,
  1080p, 720p, 480p and 360p at or below the file, plus the file's own size ("Original") when it
  is none of those. Tick one or more; "1080p + 720p + 360p" picks the old ladder in one click.
  Each extra size is a full copy: it adds storage for you and for every seeder that keeps it. Studio reads the file's size with
  ffprobe before anything is uploaded (`studio.probe`, a single-use file token like the upload's
  own, no confirmation: it publishes nothing), and remembers the sizes you picked as your default
  for the next upload. The NIP-71 event and the NFX copy carry the same renditions (one encode
  serves both). The labels and bitrates are nfx's (`ladder.rs`): 2160p 16 Mbit/s, 1440p 8, 1080p
  5, 720p 2.5, 480p 1.2, 360p 0.8, an original between two sizes interpolated (contracts v16).
- **NFX play picks only renditions seeders hold, the best-seeded first** (issue #97). The
  beacons say which renditions each seeder holds (an iroh ticket per rendition; a `webrtc` or
  `https` endpoint's `renditions`, absent meaning all; a HyperDHT seeder holds whole videos).
  The desktop app never plays a rendition nobody it can reach holds, lists only those in the
  quality menu, and by default starts on the one most seeders hold (at equal holders, the higher
  bandwidth, as before). The web client does the same: when its seeders hold different
  renditions, it reads the video's hash list from an origin first (checked against the manifest)
  and nfx's player plays only the held ones, starting on the most-held and adapting among them,
  with only those in the quality menu; each origin is asked only for the renditions its beacons
  say it serves, so a partial seeder never answers it with a 404. When every seeder holds every
  rendition, nothing changes.
- **NFX's SHA-256 and the NFX-12 `hyperdht` bind check come from `@noble/hashes` and
  `@noble/curves`** instead of libsodium, so that the same code runs in the web client (ADR 0022).
  The digests are the same bytes. The bind check gives libsodium's answers, except for a signature
  by a public key with a small-order part, which no key generator makes: refused now, where
  libsodium accepted about one in eight. Files are still checked through libsodium in the worker.
- **The web client is built with nfx 0.1.2's player library** (`packages/app-web/nfx-web.lock`,
  nfx 491d35e). The library now asks each origin which renditions it holds before playing from
  it; what seeders' beacons claim is only a hint, so a stranger's beacon can no longer keep an
  origin out of play (nfx #85). It also takes hls.js 1.7.4. The desktop app is unchanged by it.
- **NFX is on by default, on the test network's public relays** (ADR 0020's 2026-11-08
  amendment): `wss://relay.nutflix.xyz` to find videos and `https://iroh.nutflix.xyz/` to reach
  seeders behind home routers, both run by SovTech. Free videos show up with no setup. Everything
  stays yours to change in Settings › NFX network (switch it off, replace or remove either relay);
  a saved NFX setting is never overwritten, and one this version cannot read turns NFX off. An
  install that never touched NFX gets the new default when it updates. Both relays see the app's
  IP address (README, SECURITY.md).
- **A fourth default relay, `relay.ditto.pub`** (ADR 0009's 2026-11-07 amendment). Search is a
  NIP-50 query and none of the three old defaults answers it, so on a first run Search found
  nothing; this relay is free, open and does. It also means one more relay operator sees a fresh
  install's IP address and queries (README, SECURITY.md). A saved relay list still replaces the
  defaults, so existing installs are unchanged.

### CI

- **`web-site`** builds nfx's web player library from the source `packages/app-web/nfx-web.lock`
  pins and fails unless it is the pinned tar, builds the web client's site twice (from two
  checkouts at two paths) and fails unless they are the same bytes, and runs the site end to end in
  headless Chromium against nfxd and a stock relay (strfry). The desktop app is unchanged by it.

- **`nfx-exit-two-host` takes a `relay_only` input** (default false). Set, nfxd runs with
  `--relay-only`, so every byte it moves goes through the iroh relays, to exercise a relay's own
  path such as the public one. The suite fails at once if it is set without iroh relays, and passes
  nfxd no gossip flag, which nfxd refuses with it. Dispatch only; the app and its tests are
  unchanged.

- **The interop runs judge the app against nfx 0.1.2** (nfx 491d35e, its release commit):
  `nfx-exit`, `nfx-exit-two-host`, `spike-iroh` and `nfx-web-e2e` build nfxd from it, where they
  built 0.1.0's (5d628db) or the 0.1.1 candidate (20f78ac). At this nfxd the NAT matrix's
  port-forwarded seeder cells (nfx N1, `--iroh-bind`/`--iroh-external`) run instead of skipping
  (69 of 69 cells pass), and `nfx-web-e2e` uses wasm-pack 0.15.1, the release nfx's own CI pins.
  nfx-package makes one size by default since nfx #76, so the exit runs ask it for two
  (`--renditions 720p,360p`). `nfx-web-e2e` builds the player library too, keeps no cache, and
  no longer takes an nfx commit as a dispatch input: it builds its pinned one, and another is
  tried by moving the pin in a pull request (CodeQL `actions/cache-poisoning`).

- **A live testnet check for releases** (`host/__tests__/nfx-live.integration.test.ts`, only with
  `NUTFLIX_LIVE_RUN=1`): the real worker and iroh helper, with a fresh install's settings and the
  host's catalogue and beacon reader, find a video somebody seeds on `nfx:testnet:1` (Network tab,
  search, by address) and play it end to end over the internet. It publishes and seeds nothing.
  No workflow runs it; it is run by hand before a release.

## [0.1.2] - 2026-11-07

A Network tab: every free video on the NFX network, in one place.

### Added

- **Home › Network** lists every free video on the NFX network you pointed the app at, newest
  first, with no sign-in (contracts v13; ADR 0020's 2026-11-07 amendment). Until now a free NFX
  video showed up only through Search, a followed channel or a followed tag, so a network full
  of free videos looked empty. The tab reads the network's own scoped relays and your read
  relays, merges them and shows each video once, at its newest revision; it fails only when both
  sets of relays do. It appears only while NFX is turned on in Settings; with NFX off a link to
  it lands on Trending.

## [0.1.1] - 2026-11-06

Free video over NFX, and playback that starts on real relays. NFX is off until you turn it on in
Settings and give it the network's scoped and iroh relays (see the README's known limitations).

### Added

- The exit run: free NFX videos cross between nfx and this app over iroh, in CI (ADR 0020 slice
  5f; nfx ADR 0101 §6, ADR 0103 §3). The `nfx-exit` workflow builds nfxd and nfx-package at a
  pinned nfx commit, the stock iroh-relay and the iroh helper, and runs this app's real worker
  and host NFX code against them on 127.0.0.1, with nothing mocked on the wire.
  - **nfx seeds, this app plays:** nfxd packages, publishes and seeds a clip. The catalogue lists
    it, the beacon reader finds its iroh endpoint, and every rendition plays over iroh only:
    layout C byte for byte, a mid-file range, and ffmpeg decodes it.
  - **This app seeds, nfx fetches:** a clip packaged the way Studio does, with the host's
    manifest and beacons, all accepted by nfxd's own relay. A second nfxd fetches it, passes its
    own checks, holds every file under its sha256, and its origin serves HLS that ffmpeg decodes.
  - **Without a helper,** an nfxd-only video is refused at once (`no-seeders`).
  - **The app itself (tier 3, job `exit-app`):** Electron under xvfb, with its sandbox on, runs the
    host, main's media proxy and the real Bare worker spawning the real helper. It finds nfxd's
    video through the header search, presses Play — free, and the video plays past 3 s with a
    picture; switching quality opens the other rendition, which plays too.
  - **The two-host run:** the same two directions with nfxd and this app on two separate machines
    over the internet (`nfx-exit-two-host`, dispatch only), each runner behind its own NAT,
    meeting on relays given as inputs (by default a public Nostr relay and n0's iroh relays);
    throwaway keys and video ids derive from the run id, and each runner counts the bytes it got
    over a relay against those that came direct. **Passed 2026-11-06** (run 42300979880): both
    directions, every file checked, and the peers holepunched (about 3.7 MB direct, 55 KB
    relayed, on each side).
- The packaged app ships the iroh helper (ADR 0020 slice 5e-5, ADR 0021).
  - **Where:** `resources/app.asar.unpacked/iroh/nutflix-iroh-helper`, unpacked beside the
    worker. Main hands it to the host as `--iroh-helper`, and a packaged build then never reads
    `NUTFLIX_IROH_HELPER`, so an environment variable cannot swap the binary a release ships.
  - **Built for the release:** the release job builds it from the tagged commit with the
    crate's pinned toolchain and `--locked`, never from a cache.
  - **Checked when staged:** a regular file, executable, at most 64 MiB, and an executable for
    the target (an x64 ELF for linux-x64), so a helper built for the wrong machine cannot ship.
    The packaged layout check then requires it unpacked and executable.
  - **A choice:** `packaging/cli.ts` needs `--iroh-helper <file>` or `--without-iroh-helper`.
    The inactive GitLab release jobs build none yet; those apps speak HyperDHT only.
- NFX play fetches over iroh too, NFX-06 through a watching iroh helper (ADR 0020 slice 5e-4, ADR
  0021), so a seeder that speaks iroh only (nfxd) can be watched.
  - **Sources:** the host passes each beacon's `iroh` endpoints beside its `hyperdht` ones (the
    relay kept only when it is one of the network's), and the worker tries iroh first, then
    HyperDHT, file by file.
  - **A watching node:** a second helper with an ephemeral id, never the serving one, started on
    the first fetch that needs it and stopped when no session uses it. Without a helper, an
    iroh-only session is refused (`no-seeders`).
  - **The fetch:** NFX-06 §2 on demand. The hash list and playlists place each file in its
    collection, a file not placed yet is never guessed, and every file comes back only under its
    hash-list sha256. A source that lies, stalls or breaks the counts is dropped for the session.
  - **CI:** a worker with no payment providers plays the test video from one that serves it over
    iroh only, byte for byte, against the real helper.
- The worker seeds its NFX videos over iroh too, NFX-06 through the iroh helper (ADR 0020 slice
  5e-3, ADR 0021), beside HyperDHT and only while seeding and the NFX setting are both on.
  - **The helper:** one per worker, started when a stored video is to be served and stopped when
    serving goes off. Dev and CI name it in `NUTFLIX_IROH_HELPER`; a packaged build's own copy
    comes with slice 5e-5 (below). Without one the worker speaks HyperDHT only.
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
  - **spike-iroh:** its Bare smoke test starts through bare-sidecar, as the host starts the
    worker. The plain `bare` it used tears down mid-run (spike S-D finding 10, Bare's own).
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
  - **On the Watch page:** NfxWatch has _Play — free_, the video with a quality picker, and
    _No seeders online_ with Retry.
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

- NFX play finds its seeders on a real scoped relay. Beacons are ephemeral (NFX-04): a scoped
  relay forwards them to live subscribers and never stores them, so the one-shot query the play
  used found no seeder on nfxd's relay or any other, whoever was seeding. Found by the exit run
  against nfxd (slice 5f).
  - **Live:** a play holds a subscription on the scoped relays and opens as soon as a beacon names
    a source, waiting at most one republish interval (62 s; seeders republish at TTL/2, NFX-03 §3).
  - **Ahead of the click:** the Watch page's `nfxVideo` opens it when the page loads, and what
    arrives is kept for a beacon's lifetime (bounded), so Play usually opens at once.
  - **Tests:** core's `FakeRelayPool` now treats kinds 20000–29999 as NIP-01 says, forwarded to
    live subscriptions and never stored; storing them is what hid this.
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

[Unreleased]: https://github.com/SovereignTechnology/nutflix-pear/compare/desktop-v0.1.4...HEAD
[0.1.4]: https://github.com/SovereignTechnology/nutflix-pear/compare/desktop-v0.1.3...desktop-v0.1.4
[0.1.3]: https://github.com/SovereignTechnology/nutflix-pear/compare/desktop-v0.1.2...desktop-v0.1.3
[0.1.2]: https://github.com/SovereignTechnology/nutflix-pear/compare/desktop-v0.1.1...desktop-v0.1.2
[0.1.1]: https://github.com/SovereignTechnology/nutflix-pear/compare/desktop-v0.1.0...desktop-v0.1.1
[0.1.0]: https://github.com/SovereignTechnology/nutflix-pear/releases/tag/desktop-v0.1.0
