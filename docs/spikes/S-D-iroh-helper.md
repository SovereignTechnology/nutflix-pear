# Spike S-D — the iroh helper against nfxd, through S5′'s NAT matrix

Date: 2026-10-29 (running) · Under test: `crates/iroh-helper` (iroh 1.2.0, iroh-blobs 0.103.1,
noq 1.3.0, Rust 1.98.0), its worker client `packages/app-desktop/src/worker/iroh/`, against nfxd
at nfx `29019d2` · Host: GitHub Actions `ubuntu-24.04` (workflow `spike-iroh`), linux-x64 only ·
Decision: [ADR 0021](../decisions/0021-speak-iroh-through-a-helper.md), nfx ADR 0103 §3 step 1

**Status: in progress. The verdict and the numbers below are filled in from the CI run they quote.**

## Question

Can a thin Rust iroh helper, spawned by the Bare worker and driven over framed stdio, serve and
fetch an NFX video to and from nfxd over iroh-blobs (NFX-06), through the NAT matrix nfx's spike S5′
used? How large is it, how much memory does it use, and does a file need two stores on disk?

## Method

- **The helper** (`crates/iroh-helper/`): `presets::Minimal`, the network's relays only, an
  iroh-blobs `FsStore`; imports by `ImportMode::TryReference`; `get` is nfx-node's capped ranged
  request. Locked at nfx's versions of the wire crates.
- **The worker's side** (`spikes/iroh/harness.mjs`, Node 22): the production `NfxStore`, the
  `core` NFX codec and the new helper client. `serve` verifies the package into the store, has the
  helper import the store's files and form the NFX-06 collections, and publishes signed beacons;
  `fetch` reads the manifest and beacons from the scoped relay and runs NFX-06's fetch (HashSeq
  alone and capped, hash list against root, exact member counts, every member capped at its size
  and sha256-checked) before `putVideo`.
- **The matrix** (`spikes/iroh/nat/run.sh`): S5′'s namespaces and routers (lifted from nfx), an
  iroh relay over HTTP and nfxd's embedded scoped relay in the public namespace, one 30 s 720p
  test clip packaged by `nfx-package`. Pairings server ∈ {nfxd, helper} × client ∈ {nfxd, helper},
  each with a fresh relay and only its own seeder alive; the path is read from byte counters on the
  client's router.
- **Under Bare** (`spikes/iroh/bare-smoke.mjs`): the client through `bare-subprocess` with a stdin
  pipe, two helpers on loopback, a get, a SIGKILL and restart, clean exits.

## Findings

To be written from the final run: the verdict table per check, sizes (release, release-small,
gzip), peak RSS of the helper as server and client next to nfxd's, throughput per cell next to
S5′'s HyperDHT numbers, and the disk-cap answer (the helper store after serving by reference and
after a fetch's hand-off and eviction).

## Decision

Pending the run.

## Open questions

Pending the run. Known to be out of this spike: other targets (ADR 0103 §3 step 2), `nfx/pay/1`
through the helper (Phase 2), a soak, IPv6, and packaging as a `prebuilds/` package (slice 5).
