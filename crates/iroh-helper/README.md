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

Status: **spike S-D** (`docs/spikes/S-D-iroh-helper.md`). Built and tested only in CI
(`.github/workflows/spike-iroh.yml`); nothing in the app runs it yet.

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
5. **No socket of its own** besides iroh's, no secret in argv or the environment (the iroh key,
   if any, arrives in `init`), and nothing printed but short diagnostics on stderr.
6. **The worker's client makes the safe path the only one** (`worker/iroh/helper.ts`): `getFile`
   needs the sha256 a file must have and returns its bytes only if they match; `getSeq` returns
   member hashes, good only for asking; a dial goes through `dialTarget`.

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
of `get`s.

**Backpressure:** the helper writes frames through one bounded queue (16 frames). A worker that
stops reading stalls it there, and so every transfer behind it. The worker bounds what it buffers:
at most one partial frame, and per `get` at most the `max` it asked for.

## Requests

Every request is `{"id": <u32, not 0>, "op": "<op>", …}` and gets exactly one reply with the same
`id`: `{"id", "ok": true, …}` or `{"id", "ok": false, "err": "<code>", "msg": "<text>"}`. Requests
run concurrently (at most 16; one more gets `busy`), except `init`, which runs alone and first.

| op | fields | reply |
|---|---|---|
| `init` | `secret?` (64 hex), `relays` (http(s) URLs), `relay_only?`, `portmapper?` | `node`, `relay`, `addrs` |
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
  comes back in an error.
- `dial` keeps the given direct addresses (none with `relay_only`) and only the relays in its own
  map; with nothing left it fails `dial-failed`. Connections time out after 15 s.
- `get` makes one ranged request for at most `ceil(max / 1024)` chunks, as nfx-node does: a blob
  larger than `max` never completes and is refused `too-large`. A blob that does not arrive within
  30 s fails `timeout`. The fetched blob is held by a temp tag while it is read, then left to the
  collector: the worker's store keeps the copy that counts.
- Error codes: `bad-request`, `not-ready`, `busy`, `io`, `dial-failed`, `no-conn`, `timeout`,
  `too-large`, `transfer-failed`, `internal`.

## Exit codes

`0` stdin ended (the worker closed it, or went away) · `2` usage · `65` the worker broke the
protocol (bad frame, a request without an id, a data frame) · `70` internal · `74` stdin/stdout
failed.

## Building

CI only (`.github/workflows/spike-iroh.yml`): Rust 1.98.0 (`rust-toolchain.toml`),
`cargo build --release --locked`, `cargo clippy --locked -- -D warnings`, `cargo test --locked`,
`cargo deny check` (`deny.toml`).
