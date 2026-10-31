# 20. Speak NFX beside the legacy protocol

Date: 2026-10-21

## Status

Accepted (Cameron, 2026-10-19). Amends ADR 0019's scope. The matching record on the nfx side is
its [ADR 0101](https://github.com/SovereignTechnology/nfx/blob/main/docs/decisions/0101-nutflix-pear-interop.md).
Amended 2026-10-29 by [ADR 0021](0021-speak-iroh-through-a-helper.md): the app also speaks iroh
(NFX-06), through a thin helper process, because nfx will not speak HyperDHT. Amended 2026-10-30
(Phase 1 slice 4a): the identity change is contracts version 9; a manifest links back to its legacy
event with an `e` tag; the beacon publisher and its seeder key live in the host. Amended 2026-10-31
(Phase 1 slice 4b): how NFX videos are listed, below.

## Context

This app and [nfx](https://github.com/SovereignTechnology/nfx) are two peer-to-peer,
pay-per-chunk video implementations that share nothing on the wire. This app announces with NIP-71
(kinds 21 and 22) on public relays, moves faststart MP4 in a shared Hyperblobs core, and pays with
a binary `pay/1` per 64 KiB block with two P2PK-locked proof sets. nfx speaks the NFX suite: kind
38504 manifests and kind 20464 beacons on scoped relays, CMAF files named by sha256, iroh, and
NFX-07 `nfx/pay/1` per file with one unlocked token. Each side rejects the other's events, so a
viewer on one never sees a video on the other.

ADR 0019 kept this repository to the Hypercore stack and left the multi-network design to nfx.

## Decision

**The app becomes a second, independent NFX implementation, beside its legacy protocol.**

- **NFX runs beside the legacy protocol; it does not replace it.** NIP-71, Hyperblobs and the
  binary `pay/1` stay as they are, so existing videos, seeders and payments keep working.
- **It is written from the NFX specs and their test vectors**, not from nfx's Rust code: NFX-01 to
  NFX-05 (namespaces, manifests, beacons, scoped relays, segments and hash lists), NFX-07
  (payments) and NFX-12 (the HyperDHT transport). The vectors are vendored and pinned by sha256.
- **The transport is NFX-12, files over Protomux on HyperDHT.** The app dials a seeder by its Noise
  public key and requests whole files by sha256 over `nfx/files/1`; NFX-07 rides the same
  connection as `nfx/pay/1`. There is no Hypercore or Hyperdrive in that path. The app does not
  speak iroh: it reaches nfx seeders that advertise `hyperdht`, and an nfx seeder that speaks both
  carries its videos onward to iroh. *(Amended 2026-10-29, ADR 0021: nfx speaks no HyperDHT after
  its spike S5′, so the app also speaks iroh, NFX-06, through a helper; NFX-12 stays the profile
  between this app's own peers.)*
- **NFX files have a store of their own**, keyed by sha256 and counted in the disk cap. They never
  go into the shared `blobs` core, which is priced and joined to the legacy swarm.
- **Phase 1 is free videos only.** Only videos their creator marks free are published to NFX, so
  the free path never undercuts a paid legacy video. Paid NFX follows once NFX-07 is frozen and
  nfx's M2.1 lands, in this repository's locked money directories with a security stage of its
  own; a creator share on NFX follows nfx's ADR 0102 after that.
- ADR 0019 still holds otherwise: Pear/desktop only, no web portal.

## Consequences

- `VideoManifest` gains an address identity (`a` of kind 38504) beside the event id of kinds 21
  and 22: a contracts change, version 7 to 8. *(Amended 2026-10-30: version 8 went to
  `UploadInput.nfx`, so the identity is version 9.)*
- The studio encodes once in H.264 and packages CMAF, playlists and a hash list for NFX; the VP9 to
  WebM ladder stays legacy-only.
- The worker gains a HyperDHT server (only while seeding) with keys per NFX network, separate from
  the legacy swarm's, a `files/1` server and client, and a beacon publisher signed by a local
  seeder key, not the user's (possibly NIP-46) key. *(Amended 2026-10-30: the beacon publisher
  and its seeder key live in the host, because the worker has no relay access (Bare has no
  WebSocket; nostr runs in Node). The worker supplies the endpoints it serves. Beacons are
  published only once a transport serves the files, with slice 5's wiring.)*
- The catalog merges an NFX source with the NIP-71 one, de-duplicating a video published both ways
  only when the two events have the same author. *(Amended 2026-10-30: the kind-38504 manifest
  carries `["e", <legacy event id>]`, which nfx ignores (NFX-02 §3, unknown tags). NFX-02's
  Annex A links the other way, with an `a` tag on a NIP-71 mirror, but this app publishes the
  legacy event first and derives the NFX address from its id.)*
- The creator signs a free upload's manifest with the same user signer as its legacy event, and it
  goes to the user's write relays (NFX-04 §4: manifests are mirrored to public relays) and the
  network's scoped relays.
- A video published both ways is stored twice, in two containers.
- The README's "How it works" describes the legacy protocol; NFX is added to it as it ships.

## Amendment 2026-10-31: listing NFX videos (slice 4b)

Cameron delegated these choices to "the best options for the core values of the project, a p2p
video streaming platform": interop on open standards, honesty about what plays, and users'
data surviving.

1. **A union, not optional fields.** `VideoManifest` stays the NIP-71 type. `NfxVideo` and
   `CatalogVideo = VideoManifest | NfxVideo` are used only where NFX videos can appear: `feed`
   and `search`. The compiler then finds every consumer, so an NFX video cannot reach pricing,
   payment or the player by accident.
2. **The identity is the NIP-01 address** `38504:<author>:<d>`. It is stable across revisions
   and is the coordinate other Nostr clients use. It has a method of its own, `nfxVideo(addr)`.
   Comments, reactions, zaps, reports and library sets stay keyed by event id until NFX play.
   They need `a`/`A` tags, and builds before that change drop `a` items from NIP-51 sets on read
   and erase them on the next save, so that change needs its own upgrade path.
3. **Phase 1 lists free NFX videos only:** `license open`, with `price_hint` absent or `0`.
   This app cannot pay on NFX yet, so a priced video would be listed and unplayable.
4. **Twins:** when a manifest's `e` names a NIP-71 event by the same author, the NIP-71 entry
   is shown and the NFX one dropped, because the NIP-71 one plays today. A link to another
   author's event is ignored.
5. **Dormant until a network is chosen.** The NFX catalog source runs only when the host is
   given a namespace. Today's NFX videos are on `nfx:testnet:1` and none can play before slice
   5, so production lists none.
6. **Merged feeds:** subscriptions, tags, author and search. Trending ranks by nutzaps, which
   NFX has none of; shorts has no NFX kind; related, notifications and Studio stay NIP-71.
7. **No new image fetches.** An NFX thumbnail is a file in the NFX store, reachable once a
   transport is (slice 5); until then the card shows its placeholder, and nothing is fetched
   by URL.

Readers follow NFX-02 §4 (the current revision; one more than 15 minutes ahead is ignored),
NFX-02 §6 (a valid deletion by the author withdraws the manifest), and NFX-04 §4 (public relays
first, scoped relays as the fallback).
