# Nutflix

> **Source of truth:** [`nostr://npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx/git.sovit.xyz/nutflix-pear`](https://gitworkshop.dev/npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx/git.sovit.xyz/nutflix-pear) — issues and pull requests live there. This GitHub repository is a mirror; push to the Nostr remote, not here.

[![CI](https://github.com/SovereignTechnology/nutflix-pear/actions/workflows/ci.yml/badge.svg)](https://github.com/SovereignTechnology/nutflix-pear/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/SovereignTechnology/nutflix-pear)](https://github.com/SovereignTechnology/nutflix-pear/releases/latest)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

**Peer-to-peer video where the people who seed a video are paid by the people who watch it.**
Videos are announced on [Nostr](https://nostr.com), streamed from other people's computers over
[Hypercore](https://docs.pears.com), and paid for block by block in [Cashu](https://cashu.space)
ecash. The creator chooses the mint and sets the price, and the price is shown before you press
Play.

<!-- Screenshots go here (docs/images/), once the screenshots workflow has produced them. -->

This repository, `nutflix-pear`, is the JavaScript implementation: an Electron desktop app with a
[Bare](https://github.com/holepunchto/bare) worker, plus the seeder and gateway daemons. A Rust
implementation built on iroh lives in [nfx](https://github.com/SovereignTechnology/nfx).

> **Status: experimental.** Desktop 0.1.0 for Linux x86_64 was released on 2026-10-05. It is a
> demo, not a product you should trust with money you cannot afford to lose. Read
> [Known limitations](#known-limitations) before you install it.

## Contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Known limitations](#known-limitations)
- [Install](#install)
- [Run from source](#run-from-source)
- [Run a seeder or gateway](#run-a-seeder-or-gateway)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)
- [Contributing](#contributing) · [Security](#security) · [Licence](#licence)

## What it does

- **Watch.** Home (your subscriptions, and Trending), search, Shorts, channel pages, and a watch page
  with a quality menu that shows each rendition's price, a mini-player, likes, comments and reports.
  Opening a video does not start it: you see the price first.
- **Pay per block.** Seeders send the video in blocks (64 KiB by default) and are paid as they go.
  Pausing stops the payments. Auto top-up is off until you turn it on.
- **Publish.** Studio transcodes an upload to 1080p, 720p and 360p (never upscaled), signs a Nostr
  video event with your key, and lets you set the price per block, the mints you accept and how
  each payment is split between the seeder and you (50/50 by default).
- **Seed.** Turn seeding on to serve videos from your own disk and earn the seeder's share. It is
  off by default, with a 10 GiB cap.
- **Wallet.** A NIP-60 Cashu wallet with a balance per mint. Fund it by paying a Lightning invoice;
  withdraw by pasting one. A 12-word recovery phrase (NUT-13) is shown once so you can restore it.
- **Library.** History, watch later, playlists and likes, stored as Nostr lists encrypted to
  yourself (a playlist can be made public).
- **Sign in** with a local key (kept encrypted on disk) or a NIP-46 remote signer such as a bunker.

Defaults are chosen for privacy and safety: no default mint, seeding off, remote images off, and
three public relays (`relay.damus.io`, `nos.lol`, `relay.primal.net`) that see your IP address and
what you ask them for. You can change the relays and mints in Settings.

## How it works

1. **Discovery.** A video is a signed Nostr event (NIP-71, kinds 21 and 22). It names the Hypercore
   that holds the video, lists the renditions, and states the price per block and the mints the
   creator accepts.
2. **Transport.** Your app joins the swarm for that Hypercore with Hyperswarm and reads Hyperblobs
   from the peers that have it. Hypercore checks every block against its Merkle tree before the
   block counts.
3. **Payment.** `pay/1` runs on the same encrypted connection. A seeder lets a small window of
   blocks go out unpaid (4 by default, wider when the creator's minimum payment needs it). The
   viewer then pays for the blocks it has received. A viewer that does not pay is cut off and its
   key is banned.
4. **Money.** Each payment carries two sets of Cashu proofs, one for the seeder and one for the
   creator, each locked to its recipient (NUT-11) and carrying a DLEQ proof (NUT-12). The seeder
   checks them offline before it acknowledges.
5. **The mint.** The creator picks the mints. A viewer pays only at a mint that is in the video's
   list, in the seeder's list and in the viewer's own wallet. Neither side is ever more than the
   unpaid window of blocks ahead of the other, which bounds what a cheat can gain.

That is the protocol the app speaks today. It is also becoming an implementation of
[NFX](https://github.com/SovereignTechnology/nfx), the protocol suite nfx speaks, so the two share
one network: NFX videos over HyperDHT, beside the protocol above, which stays as it is
([ADR 0020](docs/decisions/0020-speak-nfx.md)). None of it has shipped yet.

The threat model, the money-path invariants and the review of the implementation are in
[SECURITY.md](SECURITY.md) and [docs/security-review.md](docs/security-review.md).

## Known limitations

These are the things you would otherwise find out by trying them. Release 0.1.0:

- **Playback does not start on real relays.** The desktop app reports zero seeders for every video
  it finds on a relay, and the watch page treats zero seeders as "Nobody is seeding this video right
  now", so a signed-in viewer sees that message instead of a Play control. The offline demo
  (`npm start`, below) uses fixture data and is not affected. Fixed on `main` for the next
  release ([#23](https://github.com/SovereignTechnology/nutflix-pear/issues/23)).
- **It has not been run end to end against real relays, real peers and a real mint.** The
  real-mint tests use two mint implementations (Nutshell 0.21.0 and cdk-mintd 0.18.1) on a local
  machine with a fake Lightning backend. No real payment is on record. Cashu ecash is bearer money
  and a mint can lose or withhold it, so keep balances small.
- **Not independently audited.** The security review was done in-house with AI assistance. The
  repository has an adversary test suite and a [fuzz workflow](.github/workflows/fuzz.yml), but no
  outside party has reviewed it.
- **Some screens are unfinished.** The "Your tags" tab on Home is always empty, the Zap button does
  nothing, and nobody's NIP-05 name is ever looked up, so there are no "verified" badges. A creator
  who is not the seeder is paid with a Nostr nutzap, and the app has no code to find and redeem
  incoming ones.
- **Linux x86_64 only.** There is no Windows, macOS or arm64 build, no automatic update, and no
  operating-system code signing. You verify downloads yourself ([below](#verify-a-download)).
- **The web app is a placeholder.** `packages/app-web` is an empty scaffold. The web portal that
  the early plans described is not part of this repository.

## Install

Download the files for the latest release from the
[Releases page](https://github.com/SovereignTechnology/nutflix-pear/releases/latest).

| File                             | Use it on                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `nutflix_<version>_amd64.deb`    | Debian and Ubuntu, including Ubuntu 24.04 and later (recommended)                            |
| `Nutflix-<version>-x64.AppImage` | Other distributions. **Not Ubuntu 24.04 or later**: it cannot start there, so use the `.deb` |

```sh
sudo apt install ./nutflix_0.1.0_amd64.deb      # the ./ matters
nutflix                                          # or start Nutflix from your menu
```

`sudo apt remove nutflix` uninstalls it and keeps your data. Studio needs `ffmpeg` and `ffprobe` on
your `PATH` to transcode uploads (`sudo apt install ffmpeg`); the package only recommends them.

### Verify a download

The files are not signed by an operating-system vendor, so your system may warn about them. Their
integrity rests on two things published with every release:

- `SHA256SUMS`. Check a download with `sha256sum -c SHA256SUMS --ignore-missing`. This shows the
  file is intact; it does not show who made it, because it comes from the same page.
- A signed Nostr release notice (kind 30071, `d` tag `nutflix-desktop`), attached to the release as
  `release-event.json` and signed by the SovTech key
  `npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx`.

To check the signature, use a checkout of this repository (Node 22.18 or newer; see
[Run from source](#run-from-source)):

```sh
git clone https://github.com/SovereignTechnology/nutflix-pear.git && cd nutflix-pear
npm ci --ignore-scripts
node scripts/release-verify.mjs release-event.json nutflix_0.1.0_amd64.deb   # one or more files
node scripts/release-verify.mjs release-event.json --all ~/Downloads          # needs both files
```

It checks the signature, that the key is SovTech's, and each file's size and sha256. Keep the
original file names. An older genuine release also verifies, so compare the version and date it
prints with the current notice on the relays.

## Run from source

You need Node 22.18 or newer (`package.json` declares 22.12, but the build scripts run TypeScript
files directly, which needs 22.18) and a Linux machine.

```sh
git clone https://github.com/SovereignTechnology/nutflix-pear.git
cd nutflix-pear
npm ci --ignore-scripts                          # .npmrc turns lifecycle scripts off
node node_modules/electron/install.js            # so fetch Electron's binary explicitly
npm run build
npm start -w packages/app-desktop
```

`npm start` runs an **offline demo**: a mock wallet with fake sats, fixture videos, in-memory
relays and a local test DHT. Nothing leaves your machine. A packaged build refuses these flags and
always uses the real network.

Chromium's sandbox has to be able to start, and Nutflix refuses to run without it. On Ubuntu 24.04
and later, which restricts unprivileged user namespaces, give your checkout's sandbox helper the
setuid bit:

```sh
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

## Run a seeder or gateway

The repository also holds a headless **seeder** daemon and a **gateway** (a seeder plus a WebSocket
bridge and a Blossom HTTP server), each with a hardened systemd unit. They are not part of the
desktop release. [`deploy/systemd/README.md`](deploy/systemd/README.md) covers the config, the key
file, the exit codes and what each hardening directive does. The gateway is a network service, so
the AGPL's section 13 applies: users who interact with a modified version are entitled to its source.

## Repository layout

| Package                | Name                 | What it is                                                                         |
| ---------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| `packages/core`        | `@sovit/core`        | Protocol library: contracts, Nostr, manifests, media, payments, wallet, `pay/1`    |
| `packages/seeder`      | `@sovit/seeder`      | Seeder daemon (Corestore and Hyperblobs, the `pay/1` server side)                  |
| `packages/gateway`     | `@sovit/gateway`     | Seeder plus a WebSocket bridge and Blossom HTTP                                    |
| `packages/ui`          | `@sovit/ui`          | React design system and screens; talks only to the `NetworkAdapter` contract       |
| `packages/app-desktop` | `@sovit/app-desktop` | The Electron app: main process, host process, Bare worker, packaging               |
| `packages/app-web`     | `@sovit/app-web`     | Placeholder scaffold, not shipped                                                  |

The packages are internal to this workspace and are not published to npm. "Nutflix" is the brand
name. The package scope is `@sovit/*` and the wire protocol is `pay/1`, but a few persisted
formats embed the brand (the release notice's `d` tag, the key-file and wallet-journal formats, the
`NUTFLIX_*` environment variables), so the name is not purely cosmetic.

`packages/core/src/contracts/` is the frozen interface surface, versioned by `CONTRACTS_VERSION`.
The payment, signer, `pay/1` and auth code is the **audit surface**: nothing there logs, and it
imports only the audited libraries (`scripts/check-locked-dirs.sh`, [SECURITY.md](SECURITY.md)).

## Documentation

[`docs/README.md`](docs/README.md) indexes everything. The ones most readers want:

- [`SECURITY.md`](SECURITY.md): reporting a vulnerability, the threat model and the invariants.
- [`docs/decisions/`](docs/decisions/): architecture decision records, with the reasons for each
  choice. [ADR 0017](docs/decisions/0017-packaging.md) covers packaging and release.
- [`docs/security-review.md`](docs/security-review.md): every security finding, its state and its
  residual risk.
- [`deploy/systemd/README.md`](deploy/systemd/README.md): running the daemons.

## Contributing

Open an issue, or a pull request on GitHub; see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). CI runs on GitHub Actions
([`ci.yml`](.github/workflows/ci.yml)) for every pull request. The canonical copy of the repository
is on Nostr (NIP-34), and the maintainer syncs `main` to it; to clone from there, install
[ngit](https://ngit.dev) and run:

```sh
git clone nostr://npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx/git.sovit.xyz/nutflix-pear
```

Much of this code was written with AI assistance.

## Security

Please do not open a public issue for a vulnerability. [SECURITY.md](SECURITY.md) says how to
report one.

## Licence

Copyright (C) 2026 Sovereign Technology. [AGPL-3.0-or-later](LICENSE). The documents under
`docs/vendor/` are copies of other projects' specifications and documentation and keep their own
licences.
