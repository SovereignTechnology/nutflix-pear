# 25. The web client takes its segments from peers first

Date: 2026-11-26

## Status

Accepted. Decided by the maintainer (2026-11-26): on web.nutflix.xyz and on the nsite, the video
comes from the network's peers over WebRTC, and an HTTPS origin is the exception: a rescue now,
and nothing at all later. It amends ADR 0022 item 5 (an origin serves every play) for segments;
the hash list, playlists and init segments still come from an origin until nfx can deliver them
over the mesh.

## Context

- The web client (ADR 0022) plays with nfx's player library, which fetched from an HTTPS origin
  first: the segment playback wants and the next 15 s came over HTTPS, and peers filled in only
  further ahead. With a healthy origin, stats for nerds (ADR 0024) showed the origin carrying
  nearly everything.
- A browser whose WebRTC is switched off or kept to a proxy (a setting, a hardened build's
  default, an extension) connects to no peer. The page said nothing: such a viewer saw "HTTPS
  origin" as the only source and "0 connected, 0 since start", with no reason.
- nfx decision record 0109 adds the choice to the library: `segmentSource`, with
  `peers-then-https` (peers first, HTTPS as a counted rescue) and `peers-only`, a check of
  whether the browser's WebRTC gathers a UDP candidate, and events for a wait and a rescue.

## Decision

1. **Peers first, an origin as the rescue.** Every play with signaling relays passes
   `segmentSource: 'peers-then-https'` (`WEB_SEGMENT_SOURCE`). A segment comes from a peer that
   holds it. It comes over HTTPS only when no connected peer holds the segment playback is
   asking for once peers have had 4 s to connect, or when a peer holds it but playback is about
   to need it. With no signaling relays there is no mesh, and the play is from origins as before.
2. **One switch, in stats for nerds: "No HTTPS".** The maintainer's decision of 2026-11-26. On,
   the play takes its segments from peers only (`segmentSource: 'peers-only'`): nothing more is
   asked of an origin for a segment, and the play waits when no peer delivers. It applies at once
   to the play in hand (`NfxPlaySession.setPeersOnly`) and is kept for later plays in this
   browser (`NfxSettings.peersOnly`). Off, the default, is peers first with the rescue. The panel
   says what it does not cover: the start of each video still loads a few small files (the hash
   list, playlists, init segments) over HTTPS. There is no other setting: an empty list of
   signaling relays in Settings still turns the mesh off, and with it the switch.
3. **The page says what it found** (contracts v20):
   - stats for nerds gains "Segments from" (peers first and how many segments were rescued, peers
     only with HTTPS off, or HTTPS first) and, when it applies, "WebRTC: blocked in this browser";
   - a play whose browser cannot reach peers shows a notice under the player, once
     (`NfxPlayProblem.kind: 'peers'`);
   - a play that has nothing to play and waits for a peer says "Waiting for peers…"
     (`NfxPlaySession.waiting`).
4. **Strict comes later, on numbers.** `WEB_SEGMENT_SOURCE` becomes `'peers-only'`, and the
   origins leave the web client, when measured plays from peers alone are reliable (the
   maintainer's go). Until nfx carries the hash list, playlists and init segments over the mesh,
   those still need an origin.

## Consequences

- The load moves from origins to the peers that hold a video: seeders' mesh endpoints and other
  viewers. A video with one reachable seeder depends on it, and on what one WebRTC connection
  carries.
- A viewer with no peer in reach waits 4 s at the start of a play before the origin steps in. A
  browser found to have WebRTC blocked does not wait.
- The STUN server the client names is asked once at the start of every play, not only when a peer
  appears.
- The desktop app is unchanged: it never fetched from origins.
