# Changelog

All notable changes to the Nutflix desktop app are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are desktop releases: release
`X.Y.Z` is the tag `desktop-vX.Y.Z`, and its downloads and signed notice are on the
[Releases page](https://github.com/SovereignTechnology/nutflix-pear/releases). Dates are UTC.

## [Unreleased]

### Added

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

### Changed

- The repository is renamed `nutflix-pear` (was `nutflix-demo`): the GitHub repo, every README
  badge and clone URL, the package metadata, docs, CI, issue templates and the desktop release
  notes now point at `SovereignTechnology/nutflix-pear`. The 0.1.0 downloads and their signed
  notice are unchanged.

### Fixed

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
