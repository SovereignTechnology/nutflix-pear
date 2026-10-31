# 21. Speak iroh as well, through a thin helper process

Date: 2026-10-29

## Status

Accepted (Cameron, 2026-10-27, as nfx
[ADR 0103](https://github.com/SovereignTechnology/nfx/blob/main/docs/decisions/0103-meet-over-iroh.md),
accepted at nfx `29019d2`). This record carries that decision into this repository and adds the
rules it needs here. Amends [ADR 0020](0020-speak-nfx.md) ("The app does not speak iroh") and
`SECURITY.md`'s "No model writes crypto". The first step, spike S-D, is recorded in
[`docs/spikes/S-D-iroh-helper.md`](../spikes/S-D-iroh-helper.md).

## Context

ADR 0020 had this app reach nfx seeders over NFX-12, HyperDHT, which nfx was to speak in Rust.
nfx's spike S5′ found no Rust HyperDHT that works (peeroxide 1.7.3 does not serve Node peers, fails
behind NATs and drops Rust peers), so nfx revisited the question. Cameron chose (2026-10-25) that
this app **also speaks iroh, beside what it has, and stays a Pear app**: on the Pear runtime and
HyperDHT, installable from its `pear://` address (ADR 0017 §6). nfx meets it over iroh (NFX-06,
iroh-blobs) and never speaks HyperDHT. nfx ADR 0103 records the course, the mechanism and the order;
Cameron accepted all three on 2026-10-27.

A Pear app cannot run iroh in its Bare worker today: n0's JavaScript binding has no iroh-blobs and
no known napi-rs addon runs under Bare, a Rust Bare addon (`bare-rust`) is young, and iroh in wasm is
relay-only. A small Rust program the worker spawns can use n0's crates as they are.

## Decision

1. **The app speaks NFX-06 beside NFX-12 and the legacy protocol.** It advertises an `iroh` endpoint
   in its beacons (NFX-03), serves and fetches over iroh-blobs (one HashSeq per rendition, NFX-06
   §2), and in Phase 2 carries `nfx/pay/1` over iroh. NFX-12 stays the profile between this app's
   own peers; the legacy NIP-71 / Hyperblobs path stays as it is.
2. **Through a thin helper, not nfxd.** `crates/iroh-helper/` is a Rust program in this repository on
   n0's `iroh` 1.x and `iroh-blobs` 0.103.x (NFX-11 §4), configured as nfx's node is: the network's
   own relays (a custom relay map), no n0 discovery, the iroh-blobs ALPN. Running nfxd would run
   nfx's NFX code here, against ADR 0020's "written from the specs alone", and would hash and store
   files where the worker cannot check them. The worker spawns it with `bare-subprocess` and talks
   to it in framed messages over stdio (`packages/app-desktop/src/worker/iroh/`, protocol in the
   crate's README); it opens no socket of its own besides iroh's. A supervisor restarts it.
3. **It moves bytes; the worker decides.** These are rules, not habits (nfx ADR 0103's sharp edges):
   - **sha256 stays structural.** The helper never hands the worker a "verified" flag: iroh-blobs
     checks BLAKE3, which proves only that the bytes match the seeder's own collection. Every file is
     checked against the hash list's sha256 in JavaScript (NFX-05 §4) before it is used or stored,
     and the NFX file store admits nothing without that check.
   - **Bounded frames.** A frame has a maximum length, checked before a body byte is read, and a bad
     frame kills the helper. The worker bounds what it buffers: one partial frame, a cap on requests
     in flight and on the bytes the `get`s in flight may bring.
   - **An untrusted pipe.** A faulty or compromised helper can drop, reorder or repeat bytes, so
     everything it says is validated, and `nfx/pay/1` through it (Phase 2) is a pipe to the money
     code, never an authority.
   - **The network's relays only.** A relay URL a ticket names that the network does not run is
     dropped, in the worker and again in the helper (NFX-06 §2).
   - **Two stores per file** (the helper's iroh-blobs store and the NFX file store) is a disk-cap
     question; spike S-D measures it.
4. **Rust in this repository.** Each crate under `crates/` is its own Cargo workspace, outside the
   npm workspaces. Its toolchain is pinned (`rust-toolchain.toml`, the version nfx builds with), its
   `Cargo.lock` is committed and honoured (`--locked`), and `cargo deny` checks advisories, licences
   and sources (crates.io only). CI uses first-party actions pinned by SHA and the runner's own
   rustup; every other download is checked against a pinned sha256. Rust is built and tested in CI
   only, like everything else here.
5. **Packaging follows `bare-sidecar`** (ADR 0017): a `prebuilds/<platform>-<arch>/` package,
   executable at build time and never `chmod`ed at run time, listed by the native-module inventory,
   staged one per target, and signed with the rest of the app once the app has certificates. That
   is slice 5's and ADR 0103 §3 step 2's work, not the spike's.
6. **Order (ADR 0103 §3):** spike S-D in CI first (linux-x64; both directions against nfxd; S5′'s
   NAT matrix; size and memory), then the other targets, then the slices that publish and fetch
   over iroh and the Phase 1 exit run's cross pairs over NFX-06.

## Consequences

- **`SECURITY.md`'s "No model writes crypto" gains a source:** the helper's BLAKE3 (iroh-blobs) and
  its QUIC/TLS (iroh) come from n0's crates. Neither is a trust anchor for content, and no code here
  implements a primitive; sha256 through sodium still decides what a file is.
- **A second process per node and a Rust build per target**, of a size the spike measures (nfx
  guessed 20 MB or more), signed like the rest.
- **The helper is a new attack surface** that parses network input in Rust; its frames are its only
  interface to the worker, and the worker trusts nothing it says.
- **Beacons carry an iroh endpoint** whose `node` is the helper's; without a persistent key it
  changes at every restart, so the beacon publisher (slice 4) re-issues tickets when it does.
- **Spike S-D (2026-10-29):** both directions against nfxd pass through every cell of S5′'s NAT
  matrix; the helper is 11.3 MB and uses about 20 MB of memory; its store is a cache (≈ 1 MB, plus
  what is being fetched until the collector runs). Holepunching needs a relay with QUIC address
  discovery, which nfxd can use only with a publicly trusted certificate. Driving the helper from
  Bare through `bare-subprocess` failed (finding 10): slice 5 reproduces that in the real worker
  before it depends on it, with the host spawning the helper as the fallback.
- **Slice 5e-1 (2026-10-31):** finding 10 reproduces with `cat` under the plain `bare`, and
  not under bare-sidecar holding `Bare.IPC` (3 of 3 each way). The worker spawns the helper;
  the host fallback is not needed.
- **Not decided here:** an in-process Rust addon (once `bare-rust` is proven), Windows on `pear://`
  (ADR 0017 open question 3), and whether the helper's store is a cache handed off and evicted or
  counted in the disk cap (the spike's finding settles it).
