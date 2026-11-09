# nutflix-iroh-helper

The thin iroh process the desktop worker spawns ([ADR 0021](../../docs/decisions/0021-speak-iroh-through-a-helper.md),
nfx [ADR 0103](https://github.com/SovereignTechnology/nfx/blob/main/docs/decisions/0103-meet-over-iroh.md) §2).
It is how this app meets nfx peers over NFX-06: iroh connections and iroh-blobs, from n0's own
crates at the series NFX-11 §4 pins (iroh 1.x, iroh-blobs 0.103.x, locked here at the versions
nfx builds).

**It moves bytes and decides nothing.** It dials and accepts iroh connections, imports files,
forms HashSeqs from hashes it is given, and fetches blobs capped at the size it is given. Which
files, in which order, and whether the bytes are right are the worker's: NFX-05 parsing, every
sha256 check before a file is used, the NFX file store, beacons and, in Phase 2, every money
decision stay in JavaScript.

Since [ADR 0023](../../docs/decisions/0023-webrtc-in-the-helper.md) it also has a **WebRTC side**
(`rtc-*` requests, below): data-channel connections with browsers in an NFX web swarm (NFX-10 §2),
speaking p2p-media-loader 4.0.0's peer protocol, so the app and web viewers trade segments
directly. Same rule: it serves the files the worker names and hands fetched bytes back unchecked.
It does not signal: offers and answers come and go through the worker.

Status: from **spike S-D** (`docs/spikes/S-D-iroh-helper.md`). Since slice 5e-3 the worker runs
one to serve its NFX videos (`packages/app-desktop/src/worker/nfx/iroh.ts` and `iroh-seeding.ts`);
fetching through it is slice 5e-4. Since slice 5e-5 a packaged app ships one, built for its
target by the release job (`.github/workflows/release.yml`) and staged as
`app.asar.unpacked/iroh/nutflix-iroh-helper` (`packaging/stage.ts` checks it is an executable
for the target); the worker then never reads `NUTFLIX_IROH_HELPER`. Built and tested only in CI.

## How the worker uses it (slice 5e-3)

- **One process per worker,** spawned while NFX seeding is on and a stored video is to be served,
  `--state <storage>/tmp/nfx-iroh` (a cache, emptied at every worker start and every stop).
- **`init`:** the network's iroh relays (`Settings.nfx.irohRelays`), and as `secret` the Ed25519
  seed of a key the worker derives from its Corestore primary key (`nfx:<namespace>:iroh`), so
  the node id is the same at every start. The worker checks that the `node` it reports is that
  key's public half.
- **Serving:** `import` of each file by its path in the NFX store, then one `seq` per NFX-06 §2
  collection, tagged `nfx/<root>/meta` and `nfx/<root>/r<n>`. Each ticket is decoded once with
  `ticket` and must name this node and that collection. `untag` when a video is no longer stored;
  `addr` at every pass, and the tickets are made again when the addresses change.

## Rules it keeps

1. **No "verified" flag, anywhere.** A reply states facts: a hash, a size, an address. iroh-blobs
   checks BLAKE3 on the wire, which proves only that the bytes match the *seeder's* HashSeq. The
   anchor is the hash list's sha256 (NFX-05 §4), and the worker checks it. Nothing this process
   says can stand in for that check (nfx ADR 0103, sharp edge 1).
2. **Bounded frames.** A frame is at most `4 + 65541` bytes; a longer length prefix is refused
   before a byte of its body is read, and a bad frame is fatal on both sides (sharp edge 2).
3. **An untrusted pipe.** The worker treats everything this process sends as untrusted input:
   a faulty or compromised helper can drop, reorder or repeat bytes. When `nfx/pay/1` passes
   through it (Phase 2), the money code treats it as a pipe, never an authority (sharp edge 3).
4. **The network's relays only.** `presets::Minimal` (no n0 discovery), a custom relay map from
   `init`, and a dial filter: a relay URL not in that map is dropped, whoever named it (NFX-06
   §2), so a ticket cannot make this process contact a host of a peer's choosing.
5. **No socket of its own** besides iroh's and, after `rtc-init`, the one WebRTC UDP socket (it
   also carries the STUN requests); no secret in argv or the environment (the iroh key, if any,
   arrives in `init`), and nothing printed but short diagnostics on stderr.
6. **The worker's client makes the safe path the only one** (`worker/iroh/helper.ts`): `getFile`
   needs the sha256 a file must have and returns its bytes only if they match; `getSeq` returns
   member hashes, good only for asking; a dial goes through `dialTarget`.
7. **WebRTC talks only to addresses it may reach** (ADR 0023): a remote SDP keeps only UDP
   candidates at global unicast addresses other than the user's own public one (at most 16; no
   `*.local` names), each line read exactly as str0m reads it, so an offer cannot point it at the
   user's LAN, loopback, router or a cloud metadata address. The same rule holds every datagram
   it sends or accepts (an egress and ingress check), whatever str0m learned. It shows no
   private address of its own: its host candidate stays out of the SDP it hands out when private,
   a server-reflexive candidate's `raddr` is zeroed and its foundation (a hash of the base
   address) renumbered. Data channels only (no codecs), one per connection. No TURN.

## Running

```
nutflix-iroh-helper --state <absolute dir>
```

`<dir>/iroh-blobs/` holds iroh-blobs' store: its index, the outboards of imported files (which
are referenced in place, `ImportMode::TryReference`, not copied, when the store honours the hint)
and fetched blobs until they are collected (untagged blobs are deleted every 10 s).

## Frames

```
u32 BE length            bytes after this field: 1 ..= 65541
u8  kind                 1 = ctl, 2 = data
    ctl:  a UTF-8 JSON object, 1 ..= 65536 bytes
    data: u32 BE id (the get it answers), then 1 ..= 65536 bytes
```

The worker sends only `ctl` frames; `data` from the worker is reserved for `nfx/pay/1` streams in
Phase 2 and is a protocol violation today. The helper sends `ctl` replies and the `data` frames
of `get`s and `rtc-get`s.

**Backpressure:** the helper writes frames through one bounded queue (16 frames). A worker that
stops reading stalls it there, and so every transfer behind it. The worker bounds what it buffers:
at most one partial frame, and per `get` at most the `max` it asked for.

## Requests

Every request is `{"id": <u32, not 0>, "op": "<op>", …}` and gets exactly one reply with the same
`id`: `{"id", "ok": true, …}` or `{"id", "ok": false, "err": "<code>", "msg": "<text>"}`. Requests
run concurrently (at most 16; one more gets `busy`), except `init`, which runs alone and first.

| op | fields | reply |
|---|---|---|
| `init` | `secret?` (64 hex), `relays` (http(s) URLs), `relay_only?`, `portmapper?`, `relay_cas?` (≤ 4 DER CAs, hex) | `node`, `relay`, `addrs` |
| `addr` | | `node`, `relay`, `addrs` |
| `import` | `path` (absolute) | `hash` (BLAKE3, 64 hex), `size` |
| `seq` | `members` (BLAKE3 hashes, each stored here), `tag` | `hash`, `ticket` (a HashSeq `BlobTicket` naming this node) |
| `untag` | `tag` | `deleted` |
| `ticket` | `ticket` | `node`, `hash`, `format` (`raw`/`hash_seq`), `relays`, `addrs`: a decoding, no network use |
| `dial` | `node`, `relays`, `addrs` | `conn` |
| `get` | `conn`, `hash`, `max` (1 ..= 64 MiB) | `data` frames, then `size` |
| `hangup` | `conn` | `closed` |
| `stats` | | `rss_hwm_kib`, `store_bytes` |

- `init` waits up to 10 s for the home relay when relays are given. Without `secret` the node has
  a fresh key, so its id changes at every start (as nfxd's does). Empty `relays` means no relay
  at all, never n0's. The portmapper (UPnP, PCP, NAT-PMP) is off unless `portmapper` is true. A
  malformed `init` is answered "malformed init" and nothing more, so no field's value (the secret)
  comes back in an error. `relay_cas` adds trust anchors for the relays' TLS beside iroh's
  embedded (Mozilla) roots, for a network whose relays use a private CA; iroh never uses them for
  its own connections, which the endpoint keys authenticate.
- `dial` keeps the given direct addresses (none with `relay_only`) and only the relays in its own
  map; with nothing left it fails `dial-failed`. Connections time out after 15 s.
- `get` makes one ranged request for at most `ceil(max / 1024)` chunks, as nfx-node does: a blob
  larger than `max` never completes and is refused `too-large`. A blob that does not arrive within
  30 s fails `timeout`. The fetched blob is held by a temp tag while it is read, then left to the
  collector: the worker's store keeps the copy that counts.
- Error codes: `bad-request`, `not-ready`, `busy`, `io`, `dial-failed`, `no-conn`, `timeout`,
  `too-large`, `transfer-failed`, `internal`, and for `rtc-*` also `no-peer`, `not-open`, `absent`.

## WebRTC with browsers (ADR 0023)

One UDP socket, full ICE ([str0m](https://github.com/algesten/str0m) 0.24.1, the version and
crypto backend nfx's bridge builds), one data channel per connection carrying p2p-media-loader
4.0.0's binary commands (`src/rtc/p2pml.rs`, written from the library's source). A connection
belongs to one swarm, the NFX-10 §2 stream swarm id the worker gives. The `rtc-*` requests need no
`init`; they need `rtc-init` first.

| op | fields | reply |
|---|---|---|
| `rtc-init` | `bind?` (`ip:port`), `stun` (≤ 4 `host:port`), `root?` (absolute dir), `allow_private?` | `local`, `mapped` (the public address STUN saw, or null) |
| `rtc-stop` | | `stopped` |
| `rtc-serve` | `swarm`, `segments` (`[{id, path, size}]`), `append?` | `segments` (how many the swarm serves now) |
| `rtc-unserve` | `swarm` | `removed` |
| `rtc-answer` | `swarm`, `offer` (SDP, ≤ 16 KiB) | `peer`, `sdp`, `candidates` |
| `rtc-offer` | `swarm` | `peer`, `sdp`, `candidates` |
| `rtc-accept` | `peer`, `answer` (SDP) | `candidates` (remote ones kept) |
| `rtc-get` | `peer`, `segment`, `max` (1 ..= 64 MiB) | `data` frames, then `size` |
| `rtc-poll` | `wait_ms` (≤ 30000) | `events`, `lost` |
| `rtc-have` | `peer` | `ranges`, `more`: what the peer last announced |
| `rtc-hangup` | `peer` | `closed` |
| `rtc-status` | | `local`, `mapped`, `peers` (`[{peer, swarm, dir, open}]`), `swarms`, `held` |

- **`rtc-init`** binds `bind`, or, without a specific IP there, the address the default route to
  the first STUN server leaves from (found without sending anything). It sends one Binding request
  to each STUN server from that socket and waits up to 3 s for an answer; the mapping is refreshed
  every 25 s (every 3 s while unknown). A STUN name that does not resolve in 3 s is skipped.
  `rtc-stop` closes every connection at once; requests still in flight then fail `not-ready`.
- **Serving.** `rtc-serve` names, per segment id (its position after `#EXTINF` in the rendition
  playlist, NFX-10 §2), the file that holds it and its size; page a long table with `append`
  (one frame is 64 KiB). With `root` (the worker passes its NFX store), every file must lie
  under it once symlinks are resolved, checked when named and again when read, so no slip in the
  worker can hand a peer another file. The helper reads a file only when a peer asks, from the offset it asks
  for, refuses it (`Absent`) if it is not a regular file of the size named, and never computes or
  claims a hash: the worker names only files its verified hash list includes, and the browser
  checks every segment anyway. At most 64 swarms of 100 000 segments (a request over that changes
  nothing). Open peers of the swarm get a new announcement on every change.
- **Connecting.** `rtc-answer` takes a browser's offer and returns the answer to send back;
  `rtc-offer` returns an offer, and `rtc-accept` completes it with the answer. Both wait for
  nothing: candidates are in the SDP (browsers do not trickle). At most 32 connections, 8 per
  swarm; a channel not open in 20 s, or idle 60 s, is closed.
- **Fetching.** `rtc-get` sends a `Request` for `segment` (not `id`, which is the request's own)
  and returns the bytes the peer sends after its `Data`
  command, once its `Completed` arrives and their count matches. One fetch per peer at a time.
  Fails `absent` (the peer does not hold it), `too-large` (above `max`), `timeout` (no `Data` in
  5 s, a 5 s stall, or 30 s in all), `transfer-failed`, `not-open`, `no-peer`. The bytes are
  unchecked: the worker checks their sha256.
- **Events** (`rtc-poll`, one poll at a time, at most 256 queued; `lost` says older ones were
  dropped): `{"t":"open","peer","swarm","dir":"in"|"out"}`, `{"t":"have","peer","ranges":[[a,b],…],
  "more"}` (what the peer announced, as at most 512 inclusive ranges; at most 30, then 5 a second,
  per peer: the newest state waits for the budget), `{"t":"closed","peer","why"}`. After `lost`,
  `rtc-status` lists the live connections and `rtc-have` what each holds.
- **Bounds:** 4 file reads at once and 64 waiting, 256 MiB of segment bytes held for uploads, 4 MiB
  of queued commands per peer, 60 requests a peer then 20/s (above it the peer is dropped), 400
  then 200/s for all (above it, `Absent`), 8 remote addresses learned per connection, one data
  channel (a second drops the peer), error text cut to 200 bytes.

## Exit codes

`0` stdin ended (the worker closed it, or went away) · `2` usage · `65` the worker broke the
protocol (bad frame, a request without an id, a data frame) · `70` internal · `74` stdin/stdout
failed.

## Building

CI only (`.github/workflows/spike-iroh.yml`): Rust 1.98.0 (`rust-toolchain.toml`),
`cargo build --release --locked`, `cargo clippy --locked -- -D warnings`, `cargo test --locked`,
`cargo deny check` (`deny.toml`). `.github/workflows/ci.yml` builds the release binary on every
run (job `iroh-helper`, same toolchain, `--locked`) for the worker's tests, which find it in
`NUTFLIX_IROH_HELPER`.
