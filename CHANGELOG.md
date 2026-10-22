# Changelog

All notable changes to the Nutflix desktop app are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are desktop releases: release
`X.Y.Z` is the tag `desktop-vX.Y.Z`, and its downloads and signed notice are on the
[Releases page](https://github.com/SovereignTechnology/nutflix-pear/releases). Dates are UTC.

## [Unreleased]

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
