# 26. No single relay: read the network's relay and the read relays together

Date: 2026-11-26

## Status

Accepted (Cameron, 2026-11-26: "how do we fix this, make it more decentralized, the whole nutflix
stack"). Amends [ADR 0020](0020-speak-nfx.md)'s 2026-11-19 amendment ("catalog reads go to the
network's own relay first") and its "beacons on the scoped relays only". The matching change on
the nfx side is NFX-03 §5/§7 and NFX-04 §4, amended in place by its decision record
[0111](https://github.com/SovereignTechnology/nfx/blob/main/docs/decisions/0111-no-single-relay-or-host.md)
(the NFX spec is not locked; its Frozen text may be amended).

## Context

On 2026-11-26 the path from the home network to alpha, the host that runs `relay.nutflix.xyz`,
dropped twice (07:08Z to 07:52Z, and about 08:20Z to 08:51Z). Alpha itself stayed up. The nsite
still loaded, from public Blossom servers, but:

- **The Network page loaded slowly, then listed nothing.** Every catalog read asked the scoped
  relay first and the read relays only after it failed. An unreachable relay fails only at the
  WebSocket connect timeout (about 7 s), so every read paid that before the read relays were even
  asked, and the feeds that wait on a full page paid it again per page.
- **No seeder was found.** Beacons were read from the scoped relay only (ADR 0020, after NFX-03
  §7), so with it unreachable no beacon could arrive, wherever seeders announced.
- **It did not recover by itself.** The Watch page's beacon subscription covered every relay in
  one subscription and was never reopened, so a relay that dropped stayed unheard until the page
  was reloaded.
- **A dead relay read as an empty one.** The empty state said "Nothing has been published … or the
  relays could not be reached", the same words for both.

## Decision

1. **Catalog reads ask the scoped relays and the read relays at once, and merge.** `NfxCatalog`
   (core, shared by the app and the web client) replaces "scoped first, read relays as the
   fallback" with `bothAtOnce`: both reads start together; when the first answer is already enough
   (a full page, or the video asked for), the other gets `NFX_MERGE_GRACE_MS` (1.5 s) more and is
   left out if it is still not in; otherwise both are awaited. Pages merge as before (`mergePages`:
   one video per address, the newest revision, the scoped copy on a tie, newest first, the limit).
   `nfxVideo(addr)` takes the newest revision either side holds, the scoped copy on a tie. Search
   does the same when every scoped relay lists NIP-50; otherwise it keeps the read relays first, as
   before (a scoped relay whose NIP-11 document cannot be fetched counts as one without). Twins are
   unchanged.
2. **Beacons are read from the scoped relays and the read relays together** (web and desktop).
   This app's own beacons still go to the scoped relays only; seeders such as nfxd announce on
   general relays within NFX-03 §7's amended bounds.
3. **One beacon subscription per relay, reopened when it closes.** `NfxBeaconWatch` opens one per
   relay; when the relay closes it, cannot be reached or drops the socket, it is reopened after
   1 s, doubling to 30 s, back to 1 s once that relay has sent a beacon, for as long as the video
   is watched. The pool now pings (nostr-tools `enablePing`), so a silently dead socket closes and
   is reopened instead of hanging.
4. **A relay that failed to connect is skipped for a while** (`RelayHealth` in
   `SimplePoolAdapter`, on nostr-tools' own connection hooks): 30 s after a failure, doubling to
   5 minutes per failure in a row, cleared by the next successful connect. A dead relay then costs
   its connect timeout once per skip, not once per read.
5. **"Relay down" is told apart from "no videos".** An empty catalog page while every relay the
   web client reads failed its last connection attempt is the `relay-down` error ("Relay down …
   Check your connection or your relay list"), and the Network tab's empty state no longer
   mentions unreachable relays.

## Consequences

- With the scoped relay unreachable, the Network, author and tag feeds list what the read relays
  hold within about one connect timeout the first time and at once after that, and a seeder that
  announces on a read relay is found. This is what nfxd on booty does from 2026-11-26.
- **Nothing plays without alpha yet.** Start-up files (the hash list, playlists, inits) still come
  from one HTTPS origin on alpha; that is W2 of the WebRTC-first plan.
- **The cost:** every catalog read now reaches the read relays too, so they see which authors a
  feed follows, the tags and the videos opened, not only when the scoped relay falls short (ADR
  0020's 2026-11-19 cost note). Beacon subscriptions open one socket per relay and video watched;
  they are bounded by the watcher's 16 videos.
- A relay skipped by `RelayHealth` is not asked for up to 5 minutes after repeated failures; a
  relay that comes back is used again within one skip.
