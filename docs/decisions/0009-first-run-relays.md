# 9. First-run relays: keep the three public defaults

Date: 2026-09-23

## Status

Accepted (decision by the maintainer, 2026-09-23, answering the open question in
the Stage 1 exit handoff §3.5, an internal session note, not published).

## Context

The desktop host (L6-B) ships first-run `Settings.relays` of `wss://relay.damus.io`,
`wss://nos.lol` and `wss://relay.primal.net`, all read + write
(`packages/app-desktop/src/host/settings/settings.ts`, `DEFAULT_SETTINGS`). A fresh install
therefore contacts three third-party relay operators as soon as it loads a feed. Each one sees
the client's IP address and the subscription filters it sends, which reveal what is being
browsed. Once a signer exists (Stage 2) they also receive the events the user publishes.

There were three options:

- keep the three defaults: the app works out of the box;
- start with none: nothing leaves the machine until the user adds a relay, but the app is empty
  on first run;
- one SovTech-run relay only.

## Decision

**Keep the three defaults.** The first run shows content with no setup. Users change the list in
Settings (read/write per relay), and the stored list replaces the defaults.

## Consequences

- Nothing changes in code. `DEFAULT_SETTINGS` stays as it is.
- The privacy cost above is accepted for v0. The app makes no claim of private first-run
  browsing, and nothing in the UI should imply it does.
- Revisit this in Stage 3 (packaging and first-run polish). A first-run notice naming the relays,
  or adding a SovTech relay to the list, would not reverse this decision.
- `docs/status.md` records the answer under the the maintainer inputs table.

## Amendment 2026-11-07: a fourth default, relay.ditto.pub

Decision by the maintainer, 2026-11-07, answering a measurement.

The app's Search is a NIP-50 text query to the read relays. None of the three defaults answers
NIP-50, so on a first run Search found nothing, for NIP-71 and NFX videos alike. A read-only probe of
sixteen public relays that day found one free, open relay that answers search and also held our
NFX manifests: `wss://relay.ditto.pub`. (The others that advertise search were paid and
write-restricted, empty, or a bridge relay for another network.)

- **Decision: add `relay.ditto.pub`** to the defaults, read and write. `DEFAULT_SETTINGS.relays` has
  four entries. A stored list still replaces the defaults, so existing installs with saved relays
  are unchanged.
- **The privacy cost grows by one operator.** A fresh install now contacts four third-party relay
  operators, and each sees its IP address and the filters it sends. The decision above stands: the
  app makes no claim of private first-run browsing, and `README.md` and `SECURITY.md` name all
  four.
- It does not reverse the rest of this ADR: no SovTech relay among these general Nostr relays, no
  empty start. (NFX's own two relays, which SovTech runs, are a separate list: ADR 0020's
  2026-11-08 amendment.)
