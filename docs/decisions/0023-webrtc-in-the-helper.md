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
   takes the answer. How they travel is the host's: over Nostr, once nfx #71 defines the event.
   The app never ships tracker signaling; trackers appear only in CI tests, because today's browser
   player speaks nothing else.
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
- Settings gain a WebRTC switch, on by default, with the disclosure the web client gives: browser
  peers see your IP address, and a STUN server learns when you watch.
- Same-LAN peers do not see each other's LAN address, so they connect through the router's public
  mapping (hairpin) or not at all, unless a test or LAN run sets `allow_private`.
