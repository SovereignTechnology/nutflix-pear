# Spike S-D — the iroh helper against nfxd, through S5′'s NAT matrix

Date: 2026-10-29 · Under test: `crates/iroh-helper` (iroh 1.2.0, iroh-blobs 0.103.1, noq 1.3.0,
Rust 1.98.0), its worker client `packages/app-desktop/src/worker/iroh/`, against nfxd at nfx
`29019d2` · Host: GitHub Actions `ubuntu-24.04` (workflow `spike-iroh`), linux-x64 only ·
Decision: [ADR 0021](../decisions/0021-speak-iroh-through-a-helper.md), nfx ADR 0103 §3 step 1

**Verdict: PARTIAL.** Everything ADR 0103 §3 step 1 asks **passes**: the helper fetches a video from
nfxd and serves one to it over iroh-blobs, both directions, through every cell of S5′'s NAT matrix,
at 11.3 MB and about 20 MB of memory. The one check this spike added, **the client driving the
helper under the real Bare runtime through `bare-subprocess`, fails** and is open for slice 5
(finding 10): the Bare process tears itself down mid-run.

Runs: the matrix and its numbers are run
[40971458433](https://github.com/SovereignTechnology/nutflix-pear/actions/runs/40971458433)
(24 of 24 checks), the build gates and sizes run
[40959492555](https://github.com/SovereignTechnology/nutflix-pear/actions/runs/40959492555);
earlier runs agree. The Bare check: runs 3–8, traced in
[40976375382](https://github.com/SovereignTechnology/nutflix-pear/actions/runs/40976375382).

## Question

Can a thin Rust iroh helper, spawned by the Bare worker and driven over framed stdio, serve and
fetch an NFX video to and from nfxd over iroh-blobs (NFX-06), through the NAT matrix nfx's spike S5′
used? How large is it, how much memory does it use, and does a file need two stores on disk?

## Method

- **The helper** (`crates/iroh-helper/`): `presets::Minimal`, the network's relays only, an
  iroh-blobs `FsStore`; imports by `ImportMode::TryReference`; `get` is nfx-node's capped ranged
  request. Locked at nfx's versions of the wire crates (iroh, iroh-base, iroh-relay 1.2.0; noq
  1.3.0; iroh-blobs 0.103.1).
- **The worker's side** (`spikes/iroh/harness.mjs`, Node 22): the production `NfxStore`, the `core`
  NFX codec and the new client. `serve` verifies the package into the store, has the helper import
  the store's files and form the NFX-06 collections, and publishes signed beacons; `fetch` reads
  the manifest and beacons from the scoped relay and runs NFX-06's fetch through `getSeq` /
  `getFile` (each file returned only under the sha256 the hash list gives) before `putVideo`.
- **The matrix** (`spikes/iroh/nat/run.sh`): S5′'s namespaces and routers (lifted from nfx), an
  iroh relay and nfxd's embedded scoped relay in the public namespace, one 30 s 720p clip packaged
  by `nfx-package` (37 files, 13.16 MB). Pairings server ∈ {nfxd, helper} × client ∈ {nfxd,
  helper}, each with a fresh scoped relay and only its own seeder alive; the path is read from byte
  counters on the client's router.
- **Under Bare** (`spikes/iroh/bare-smoke.mjs`): the client through `bare-subprocess` with a stdin
  pipe; two helpers on loopback.

## Findings

1. **Both directions work against nfxd, in every cell.** nfxd → helper and helper → nfxd, plus
   helper ⇄ helper and the nfxd ⇄ nfxd control, through open/open, consistent/consistent,
   symmetric/symmetric and consistent/symmetric: 20 of 20, every file sha256-checked by the
   receiver. nfxd's strict parsers accepted this app's beacons (kind 20464, the `iroh` endpoint, a
   ticket per rendition plus `meta`) and its NFX-06 collections; this app's codec accepted nfxd's.
2. **The path, read from the routers.** open/open goes direct. Behind an HTTP relay (QUIC address
   discovery off, as nfx's Phase A ran it), every NATed cell goes through the relay; nothing is
   holepunched. The negative control (symmetric/symmetric, no relay on either side) moves 0 bytes
   and fails in all four pairings, as it must.
3. **Holepunching needs the relay's QUIC address discovery, and with it iroh punches through.**
   Behind a TLS relay with address discovery (a CI CA, given to the helper as `relay_cas`):
   helper ⇄ helper consistent/consistent goes **direct** (13.6 MB direct, 18 KB relayed,
   506–542 Mbit/s, two runs); consistent/symmetric uses the relay (iroh does not punch a symmetric
   NAT). **nfxd cannot use such a relay**: iroh-relay's default trust is its embedded Mozilla
   roots (`CaTlsConfig::default()`), nfxd has no CA option at `29019d2`, and the pairing stays
   `Fetching`. So nfxd ⇄ helper holepunching is provable only behind a relay with a publicly
   trusted certificate: the Phase 1 exit run's two-host run, or an nfx-side CA flag (a note for
   nfx's owner, not a change here).
4. **sha256 is structural.** A seeder that served one segment with a flipped byte (its collection
   built from the bad bytes, so BLAKE3 and iroh accepted them) was refused `poisoned` at that
   file, after 0.72 MB; the source was dropped and the video not stored. The client has no way to
   return a file's bytes without the sha256 they must have.
5. **Size.** Stripped release (lto fat, codegen-units 1, `panic = abort`): **11.26 MB**; at
   `opt-level = "s"`: **8.16 MB**; gzip -9 of the release: **4.95 MB**. 422 crates in the lock.
   Dynamically linked to glibc (libc, libm, libgcc_s), a packaging point for older distributions.
   ADR 0103 guessed 20 MB or more. (nfxd's release binary, unstripped: 47.5 MB.)
6. **Memory.** Peak resident (VmHWM): the helper **18–19 MB** serving, **19.7–21.0 MB**
   fetching a 13 MB video; nfxd **28–38 MB** in the same roles.
7. **Throughput** (the helper fetching, from the first dial to the last file, one runner, no
   shaping): direct **469–507 Mbit/s**, relayed **426–449 Mbit/s**, holepunched (QAD) **506–542
   Mbit/s**. S5′'s HyperDHT numbers on the same matrix were 579 (open), 493 (holepunched) and 417
   (relayed) Mbit/s node ← node. (nfxd's fetch times include its 2 s state reporting and are not
   throughput.)
8. **Disk: the helper's store is a cache, not a second store.** Serving 37 files by reference left
   the helper's store at **1.06 MB** (its index and outboards) for 13.16 MB of video:
   `TryReference` was honoured, no copy. Right after a fetch it held **14.26 MB** (the fetched
   blobs, owned until handed over); one collection later (10 s) **1.11 MB**. So: count about
   1 MB per node, plus a transient copy of what is being fetched, bounded by the gets in flight
   (256 MiB in the helper, 128 MiB in the worker). Slice 5 may delete a fetched blob on hand-off
   instead of waiting for the collector. A test (`node.rs`) proves the collector never deletes a
   file imported by reference when its tags go.
9. **Build and supply chain.** `cargo fmt`, `clippy -D warnings`, 6 unit tests (frame bounds, the
   collector), `cargo deny check` (advisories, bans, licences, sources: all ok, with nfx's two
   iroh "unmaintained" ignores). First compile in CI built ~800 crates in about 12 minutes; cached
   runs take minutes.
10. **Under Bare, the process tears itself down mid-run (FAIL, open).** Bare 1.31 (bare-sidecar
    0.5.4's prebuilt `bare`), `bare-subprocess` 6.1.0 spawning the helper with three pipes, the
    client bundled as the worker would load it, no other handle open:
    - The first exchanges work: `init`, then `import`/`seq` or `ticket`, replies read off the pipe
      and validated. Then, 0.2–0.7 s in, with requests pending and no error printed, the main
      thread starts the exit teardown: it SIGTERMs both helpers and closes handles, among them
      fd 3, the epoll descriptor of another of its threads' event loops (strace, run 8).
    - The process then either exits 0 without finishing (no result, no `exit` line) or deadlocks:
      that thread spins on `epoll_pwait(3) = EBADF` and the main thread waits on it. Its timers
      never fire (a 5 s heartbeat never ticked; a 100 s watchdog never ran). Six runs, both
      outcomes; libuv's io_uring off (`UV_USE_IO_URING=0`) changes nothing.
    - The same client and helper, spawned by Node, ran the whole matrix (24 checks, thousands of
      exchanges) without a fault, so the protocol and the supervisor are not the cause.
    - What looks like the cause: Bare saw its event loop as empty while the subprocess's pipes and
      several timers were live. Not proven. The real worker always holds a referenced IPC socket
      (bare-sidecar's, on fd 3), which this test does not, so production may or may not show it.
    - Three earlier "passes" were not: run 2 (0.4 s, exit 0, nothing printed) and runs 7 and 8
      counted Bare's exit 0 as a pass. The check now passes only on a result that says `ok`.

## Decision

- ADR 0103's mechanism holds on linux-x64: a thin helper meets nfxd over NFX-06 in both
  directions, small and light enough to ship beside the app. Step 2 (macOS, Windows) can start.
- The Phase 1 exit run's cross pairs must run behind a relay with a publicly trusted certificate
  (or nfx gains a relay CA option) to cover holepunching between the implementations; on a private
  HTTP relay they are relay-only.
- Slice 5 takes over the client as built here (`getFile`/`getSeq`/`dialTicket`, bounded
  buffering, kill and restart on a violation) and the helper store as a cache (≈1 MB plus
  transient fetches). **Before it wires the helper into the worker** it reproduces finding 10 in
  the real worker (started by bare-sidecar, with its IPC socket) and in a minimal Bare script
  (`bare-subprocess` ping-pong with `cat`), and takes it upstream if it is Bare's. If the worker
  cannot hold a long-lived child, the fallback is for the host (Node, which runs this client
  without fault) to spawn the helper and hand the worker a pipe.

## Open questions

- Other targets (ADR 0103 §3 step 2), and signing.
- `nfx/pay/1` through the helper (Phase 2).
- Holepunching between nfxd and the helper behind a publicly trusted relay (the exit run).
- What the helper serves to whom (admission, rate limits), and loopback / link-local direct
  addresses from tickets (spec-level; nfx dials them too): slice 5 with the review notes.
- A soak, IPv6, and packaging as a `prebuilds/` package (slice 5).
- Finding 10: why Bare tears down with a live subprocess, and whether the real worker does.
