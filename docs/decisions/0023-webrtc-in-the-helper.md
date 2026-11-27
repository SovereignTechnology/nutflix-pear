# 23. Trade segments with browsers over WebRTC, through the helper

Date: 2026-11-09

## Status

Proposed. Asked for by Cameron (2026-11-09, issue #89: "can pear get data from browser seeders and
seed to them via webrtc?"), with two decisions he made the same day: the app does not ship tracker
signaling (signaling goes over Nostr, per nfx #71), and the WebRTC side is on by default with a
disclosure and an off switch. Amends [ADR 0021](0021-speak-iroh-through-a-helper.md) §2 ("opens no
socket besides iroh's") and its helper README's rule 5.

## Context

The app reaches NFX peers over iroh (NFX-06, through the helper, ADR 0021) and HyperDHT (NFX-12).
Browsers reach them only over WebRTC: nfx's web player, and this repository's web client (ADR 0022),
use p2p-media-loader 4.0.0, one swarm per rendition (NFX-10 §2), segments over a data channel in the
library's own binary protocol. So the two meshes meet only at an nfxd bridge (`--bridge`), which
serves browsers from the iroh mesh. A video only the app seeds never reaches a browser unless an
nfxd fetches it first, and segments a browser holds never reach the app.

nfxd's bridge (str0m 0.24.1) is ICE lite with one public host candidate, answers only, and only
uploads. That is right for a server with a public address and wrong for a desktop behind a home
router: it needs full ICE, a server-reflexive candidate learned before it answers (browsers do not
trickle candidates), and both directions.

## Decision

1. **The helper gets a WebRTC side** (`crates/iroh-helper/src/rtc/`, the `rtc-*` requests in its
   README). It is the same process, not a second one: the worker already spawns, supervises and
   speaks to it, and packaging already ships it. The side starts only on `rtc-init`.
2. **One UDP socket, full ICE, str0m.** str0m at the version and crypto backend nfx's bridge
   builds (`=0.24.1`, `rust-crypto`). That backend still compiles aws-lc (a C library) through
   dimpl's certificate generation; avoiding it would mean forking about 540 lines of
   `str0m-rust-crypto` to generate the DTLS certificate with ring, so the helper takes what nfx
   ships and carries nfx's advisory row for it (RUSTSEC-2026-0387). The socket also sends STUN
   Binding requests (RFC 8489, request and success only) to the servers `rtc-init` names, so the
   mapping is the WebRTC socket's own.
3. **No signaling in the helper.** It takes an offer and returns an answer, or makes an offer and
   takes the answer. How they travel is the host's: over Nostr, as NFX-10 §6 (`nfx-mesh/1`, nfx
   #71) defines it. The app never ships tracker signaling; a tracker appears only in the helper's
   own browser test, which predates §6.
   - The host's signaler (`host/nfx/mesh-signaler.ts`) joins the room of each rendition it plays
     and of each swarm the worker serves (at most 32), announces presence, and follows §6.6: the
     lower key offers, timeouts, backoff, and §6.5's bounds. The wire and its checks are
     `@sovit/core`'s, written from the spec and pinned by its vectors (ADR 0020).
   - **Session keys are random and never the user's key or the seeder key:** one per run for the
     rooms of what the app seeds, and a separate one for each play session, so a reader of the
     relays cannot tie what the user watches to what they seed or to their other plays.
   - **An open room is treated as hostile.** Anyone can derive a room and sign valid events in
     it with any number of keys. So every negotiation that ends unopened costs its peer a
     backoff; worker calls come from token buckets, one set for this side's offers and one for
     its answers, so a flood of offers cannot starve its own; and each relay is subscribed on
     its own, so one relay cannot hide another's events.
   - **Signaling relays are general relays the user lists** (contracts v18, `meshRelays`; the
     maintainer, 2026-11-15): the scoped relay refuses kind 25050. The default is two of the
     app's default public relays, picked by `scripts/mesh-relay-soak.mjs`; the web client uses
     the same pair, so the two meet. An empty list leaves WebRTC off.
     **Note 2026-11-18 (the maintainer):** NFX-04 §1, amended that day as an exception to its
     freeze, lets a scoped relay accept kind 25050 `nfx-mesh/1` as an ephemeral (never stored),
     within §2's rate and size limits; one that does says so in its NIP-11 `nfx.kinds` (§3). The
     network's own relay, `wss://relay.nutflix.xyz`, now comes first, ahead of those two; the web
     client's list is the same.
4. **It moves bytes and decides nothing,** as ADR 0021 §3. It serves the files the worker names
   (`rtc-serve`, only files the worker's verified hash list includes), reads a file only when asked
   and refuses it if its size changed, and hands fetched bytes back unchecked; the worker checks
   their sha256 (NFX-05 §4). The browser checks every segment it receives anyway (NFX-10 §1).
5. **It talks only to addresses it may reach, and shows none it should not.** A full ICE agent
   sends checks to every candidate an offer lists; nfx's audit (M1, finding M3) is why nfxd's
   bridge went ICE lite. The helper keeps only UDP candidates at global unicast addresses other
   than the user's own public one from a remote SDP (at most 16; mDNS names dropped; each line read
   exactly as str0m reads it), so an offer cannot point it at the user's LAN, loopback, router or
   a cloud metadata address, and it holds every datagram it sends or accepts to the same rule
   whatever str0m learned. Global unicast still admits IPv6 hosts in the user's own /64. A browser
   behind a NAT is still reached through its server-reflexive candidate and the peer-reflexive
   address its checks reveal (at most 8 per connection). The helper's own host candidate is kept
   for str0m but left out of the SDP when private; a server-reflexive `raddr` is zeroed and its
   foundation, which str0m derives from the base address, renumbered, as browsers hide their LAN
   addresses behind mDNS names. `allow_private` lifts this for tests and same-LAN runs only. Data
   channels only: no codecs, so an audio or video section is refused. **No TURN** (nfx #71): a
   pair that cannot be punched fails.
6. **The protocol is written from the library.** `src/rtc/p2pml.rs` implements p2p-media-loader
   4.0.0's commands from its source, not from another NFX implementation, as ADR 0020 wants for the
   NFX specs: NFX-10 names the library and pins its version, and defines no bytes of its own.
7. **Bounds** (nfx's audit M2, M5, I1, I2, and an adversarial review of this change): 32
   connections, 8 per swarm, one data channel each (a second drops the peer); open within 20 s,
   closed after 60 s idle; per-peer and global request budgets, and a newer request voids any read
   for an older one; 4 file reads at once and 256 MiB of segment bytes held; announcements of at
   most 255 blocks; a per-peer budget on the events announcements cause; no message of segment
   bytes that looks like a command.

## Consequences

- The helper is larger (str0m, DTLS, SCTP, aws-lc). Its size is measured in CI beside the iroh-only
  build.
- The worker gains a WebRTC client and the host a signaling path (the next steps of #89): the
  worker builds serve tables from its verified store and a fetcher that places segments by playlist
  position; the host adds the Nostr signaling once nfx #71 defines it.
- Settings gain a WebRTC switch, on by default, with a disclosure: browser peers see the user's
  IP address, and so does the network's STUN server, which the helper asks every 25 s while its
  WebRTC side runs (contracts v17: `NfxSettings.webrtc?`, `stunServers?`). The side starts only
  with a helper to run it and a relay to signal on: without signaling nobody could reach it.
- The signaling relays learn which videos the user seeds or watches (a room key maps back to a
  rendition for anyone with the catalogue) and the user's IP address. They never see an SDP: it
  is encrypted to its receiver. Anyone who can derive a room can join it and, by offering or
  answering, learn its members' addresses, as a tracker's swarm lets them (NFX-10 §6.7). They
  can also fill a room's answer slots and keep honest offers out for as long as they keep at it;
  this side's own offers still go out. Settings says so beside the switch.
- Same-LAN peers do not see each other's LAN address, so they connect through the router's public
  mapping (hairpin) or not at all, unless a test or LAN run sets `allow_private`.

## Note, 2026-11-19: STUN servers named over Nostr (the maintainer; its selection superseded by the note of 2026-11-24)

The maintainer's plan for decentralized STUN (2026-11-19, step 5): the app also asks the STUN
servers that seeders name over Nostr, as the nfx web library already does. Only the beacon half is
built here. The second source, a signed STUN announcement, waits for nfx to assign its kind.

- **Source.** The `stun` endpoints (NFX-10 §1) of the live beacons of each video the app plays,
  each named by the beacon's signer, newest beacon per seeder (core's `nfx.beaconStunClaims`). A
  play's servers are used while it is open. An announcement will name a server by its operator's
  key, and its claims go into the same ranking.
- **Selection** (core's `nfx.selectStunServers`). These are the rules of the nfx STUN draft
  (branch `stun/decentralized`, 1ae4068, pending), the same for every NFX client:
  - the configured `stunServers` come first, each once, and are never dropped;
  - then the named servers that are global unicast, ranked by the number of distinct keys that
    name each;
  - a server named by one key only when the client has none of its own and no named server has
    two keys;
  - at most 4 in all.

  "Global unicast" is the helper's own rule for ICE candidates (§5): IP literals only, never a
  name. Documentation blocks are refused, as the nfx draft will refuse them. Since WebRTC needs a
  configured server, a lone key never adds one: in practice two seeders must name the same server.
- **An empty `stunServers` stays "none".** It leaves WebRTC off, as before, so Nostr never hands a
  STUN server to a user who listed none.
- **How it reaches the helper: a new request, `rtc-stun`, not a restart.** `rtc-init` fixes the
  configured servers for the helper's life, and restarting it would drop every connection at each
  play. So `rtc-stun` replaces the named servers on the running side and touches no connection.
  The worker sends it again after every `rtc-init`; the host sends `nfx.rtc.stun` when its pick
  changes.
  - The helper checks each named server itself: global unicast, a port, at most 4 servers with the
    configured ones.
  - It sends to a named server only where it may send an ICE check (§5).
  - It keeps each named server's mapping apart. The configured servers' mapping stays the
    mapping, offered first. A named server's is offered only as one more server-reflexive
    candidate, and only if global unicast. So a lying server costs at most one candidate that
    fails. It can never replace the configured mapping, or make peers check a private address.
- **Privacy.** Each named server learns the user's IP address and when they watch, as the
  configured one does. Keys are free to make, so "two keys" is a stranger's to fake; the bound
  that holds whatever Nostr says is at most 4 STUN servers in all, never a non-public address.

## Note, 2026-11-24: the creator's STUN servers, or the fallback (the maintainer)

The maintainer decided on 2026-11-24 that counting keys proves nothing, since keys are free: two
fresh keys could make every client ask a server of their choice. nfx ADR 0107 amends NFX-10 §1 in
place, and `stun-select.json` (vendored at nfx PR #117's head, 2389fc4) pins the new rules. This
replaces the 2026-11-19 note's **Source** and **Selection**. Everything about `rtc-stun` and how
the helper keeps a named mapping apart stands.

- **Selection** (core's `nfx.selectStunServers(own, creator)`, nfx-proto's `stun::select`): the
  configured servers first, each once, on any port; then the servers in the `stun` endpoint of the
  creator's own live beacon for each open play (`nfx.creatorStunServers`: a beacon whose signer is
  the creator its `a` tag names), in the order heard, each once, global unicast, port 1024 or above,
  not one of the configured; at most 4 in all. No key counting, and no lone-key rule. The creator
  signs the manifest, so the user already trusts that key with what they play.
- **The port floor.** The worker (`isAskableStunAddr`) and the helper (`rtc-stun`,
  `MIN_NAMED_STUN_PORT`) each refuse a named server below port 1024, so a beacon cannot aim the
  app at a well-known service.
- **Announcements (kind 33478) are a directory.** The app never subscribes to them and never uses
  one by itself. The 2026-11-19 note's plan to feed them into the ranking is dropped.
- **Any other seeder's server only through NFX-10 §1's fallback**: when no server the app asks
  returned a mapping, for one peer it already signals with whose SDP names that server's IP, one
  per seeder, port 1024 or above, 4 in all. Not built yet: it needs the helper to ask a server for
  one connection only, and comes as its own change.
- **Before it ships:** re-vendor the vectors at #117's merge commit.
