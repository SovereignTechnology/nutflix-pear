# 24. Stats for nerds: show where a play's bytes come from

Date: 2026-11-18

## Status

Accepted. Asked for by Cameron (2026-11-18, issue #123): "for all the nutflix implementations we
need to put a nerd stats in the video player that one could open, to see stats on where they are
receiving the video data from". He decided the same day how much it shows: each source by a short
id by default, and peers' IP addresses only behind a switch in the panel. nfx's own players get the
same panel (SovereignTechnology/nfx#99).

## Context

A play takes its bytes from several places at once. The web client (ADR 0022) uses an HTTPS
origin and WebRTC peers (NFX-10). The desktop app uses iroh seeders (ADR 0021), WebRTC peers
through the helper (ADR 0023), and HyperDHT seeders (NFX-12). Paid videos use Hypercore seeders
over Hyperswarm. Nothing on screen says which of them a play is using. The peer panel on the paid
path shows money, not transport.

Who sent the bytes is a privacy matter. Peers see each other's IP addresses once connected (the
Settings disclosures say so), but a panel that shows them turns every screenshot into a list of
other viewers' addresses. ADR 0023 rule 5 already keeps the helper from showing addresses it should
not. Showing the user their own connections is allowed, provided the user asks.

## Decision

1. **Every player has a "stats for nerds" overlay.** There are three ways to open it: right-click
   the video (our menu replaces the browser's there), use the player's own control (a button on a
   free NFX video, a settings menu item on a paid one), or press `n`. It closes with its ×, with
   `n` again, or with the same menu item. It reads the session once a second while open, and not
   at all while closed.
   - **Shorts** opens it by right-clicking the short (buttons, links and the panel's own text keep
     the browser's menu), by its controls' "Stats for nerds" button, or by `n`; Escape closes the
     menu and then the panel, and moving to another short closes it with the played one.
   - **The mini-player** has no `n` (it sits over every screen, where Watch and Shorts own that
     key). It opens by its bar's "Stats for nerds" button or by right-clicking its video, and the
     panel opens above the mini-player, where it has room; Escape closes it. A new hand-off is
     a new session, so it starts closed with the address switch off.
   - Both hear the paid seeders (`onPeers`, which does not replay) for the session's whole life
     but redraw only while the panel is open.
2. **What it shows**, sources first (a small player scrolls the panel, and the sources are what it
   is for; found by playing a video on the live web client in a 1280 px window, where the
   player's own numbers filled the visible part and the sources sat below the fold).
   - **Sources:** one row per source, with its kind (HTTPS origin, WebRTC peer, iroh, HyperDHT or
     Hypercore seeder), a short id (a key cut to 8 hex, an origin's host whole), what it was found
     through, bytes each way, files, and whether its connection is open.
   - **Totals:** the share from peers, peers connected now and since the start, signaling and
     relays open, files verified and refused, and the bandwidth estimate.
   - **Playback**, read from the element: resolution, buffer ahead, and dropped frames.
3. **Addresses only behind "Show addresses".**
   - The switch is off each time the panel opens, and it is never remembered.
   - Addresses are asked for (`addresses()`) only while the switch is on, never as part of the poll.
   - While they are shown, a banner says whose addresses they are.
   - Copy includes them only while they are shown. Nothing logs, stores or sends them.
   - A transport that hides an address (a browser's mDNS name or a redacted candidate) shows
     "hidden"; nothing is guessed.
4. **Contracts v19.** These are optional session members, so a shell reports what it can:
   - `NfxPlaySession.stats?()` returns `NfxPlayStats` (with no addresses).
   - `NfxPlaySession.addresses?()` and `PlaySession.addresses?()` return `PlaySourceAddress[]`.
   - Also new: `PlaySourceStat`, `PlaySourceKind` and `MAX_PLAY_SOURCES`.
   - The paid path's sources are its `onPeers` seeders.
5. **Network-chosen strings are text.** Peer ids, tracker and relay names, and labels are cut and
   made printable before they are shown, and are rendered as React text only. A label such as
   "nfxd bridge?" (taken from a peer id prefix anyone can copy) is a hint, never trust.

## Consequences

- The web client's numbers come from nfx's player library (`Session.stats()`, and per-peer rows
  and `addresses()` from nfx #99 on). A library pinned before that shows peers as one row of totals
  and has no addresses. `nfx-web.lock` moving to a commit with nfx #99 turns both on.
- The desktop app counts bytes per transport in the worker, and reads each connection's path when
  asked: iroh's selected path, the helper's last WebRTC datagram source, and a HyperDHT stream's
  remote address. All of it crosses the IPC bridge only as replies to `stats` and `addresses`.
- A screenshot of the panel with the switch off names no address. With the switch on, it does,
  and the banner says so.
