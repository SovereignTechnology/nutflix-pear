# Security Policy

## Supported versions

| Version                               | Supported                                          |
| ------------------------------------- | -------------------------------------------------- |
| Desktop 0.1.x (Linux x86_64)          | Yes: a fix ships as a new tagged release           |
| `main` and the unreleased daemons     | Best effort (the seeder and gateway are not released) |
| Anything older than the latest 0.1.x  | No                                                 |

The desktop app has no automatic update (ADR 0017). A fix ships as a new tagged release with a
new signed release notice, and users have to download and
[verify](README.md#verify-a-download) it themselves.

## Reporting a vulnerability

**Do not open a public issue.** Report it privately, either on GitHub (the Security tab, then
[Report a vulnerability](https://github.com/SovereignTechnology/nutflix-pear/security/advisories/new))
or by email to <services@sovtech.pro>, with:

- a description of the issue and its impact
- steps to reproduce, or a proof of concept
- affected commit or version
- any suggested remediation

You should get an acknowledgement within 7 days. Please allow a reasonable window for a
fix to be prepared and released before disclosing publicly. Reporters are credited in the
release notes unless they ask not to be.

## Scope

In scope: anything in this repository, including the released builds. Out of scope: the hosting
infrastructure, and issues that require an already-compromised machine or physical access. A
Cashu mint that loses or withholds funds is a risk the design limits but cannot remove (T8 below),
so report it only if this code makes it worse.

## How this has been reviewed

The design and the implementation were reviewed in-house, with AI assistance, and the findings,
fixes and residual risks are recorded in [`docs/security-review.md`](docs/security-review.md). **No
independent third party has audited this code.** The real-mint tests ran against two mint
implementations with a fake Lightning backend, and no real payment is on record.

What is enforced for every change, in CI on GitHub Actions:

- the adversary tests, one named test per threat row and per invariant below;
- `scripts/check-locked-dirs.sh`, which fails any change to the locked directories that logs or
  imports from outside the audited libraries;
- `scripts/check-contracts-version.sh`, which fails a change to the interface contracts that does
  not bump `CONTRACTS_VERSION`;
- lockfile, registry and advisory gates, and a frozen inventory of native modules.

GitHub does not currently require a second reviewer on a pull request, including one that touches
the locked directories.

## What 0.1.0 does not protect against

These are known limits of the released app, not bugs awaiting a report:

- **Relays see you.** The three default relays learn your IP address and what you ask them for
  (ADR 0009). The app makes no private-browsing claim.
- **Images can reveal your IP.** With remote images off (the default), an `https` image is fetched
  only when its publisher signed its hash, and the host it comes from still sees your address.
- **Builds are signed by key, not by a vendor.** There is no operating-system code signing and no
  claim that the builds are reproducible. Integrity rests on `SHA256SUMS` and a signed Nostr
  notice, and a signature cannot show that a release is the latest one (ADR 0017).
- **Electron's asar integrity check is not active on Linux.** It protects only macOS and Windows
  builds (ADR 0017).
- **The `.deb` installs a setuid helper.** `/usr/lib/nutflix/chrome-sandbox` is Chromium's standard
  setuid-root sandbox helper; the app refuses to run without Chromium's sandbox (ADR 0017).
- **The recovery phrase is not screen-capture protected on Linux.** The window that shows it says
  so (ADR 0016).
- **No NIP-05 check.** The desktop app never looks up a creator's NIP-05 name, so it establishes
  only the signed event's public key (T9).
- **Mint risk.** Funds held at a mint are the mint's to lose or withhold (T8).

---

## Guiding rule

**Bound the loss of any single interaction to a block's worth of sats, verify before you
pay, and never trust a peer or a server for anything you can check yourself.**

## Threat model

This table is the normative source for the adversary test suite
(`packages/core/src/payment/__tests__/`, `packages/core/src/pay-protocol/__tests__/`,
`packages/gateway/src/auth/__tests__/`). Every row has a named test. It began as section 1 of the
original build plan (`docs/plan/build-plan.md`, now a historical document) and is maintained here.

| # | Actor | Attack | Control | Residual loss |
|---|-------|--------|---------|---------------|
| T1 | Malicious seeder | Serves wrong bytes | Hypercore Merkle proof per block, before `download` fires | 0 |
| T2 | Malicious seeder | Stalls | Hypercore already multi-sources; per-peer timeout, drop | Time |
| T3 | Malicious viewer | Downloads, never pays | Window (4 blocks), then stream destroy + ban | ~4 blocks of sats |
| T4 | Malicious viewer | Pays seeder, stiffs creator | Seeder requires both proof sets; creator set bound to the seeder (`pay1` tag, ADR 0010) | 0 |
| T5 | Malicious viewer | Double-spends | DLEQ offline check; seen-secret check at verify (ADR 0010); async swap at mint; ban on failure | ≤ window |
| T6 | MITM | Steals proofs in flight | Noise secret-stream + P2PK lock to recipient | 0 |
| T7 | Any peer | Forged proofs | NUT-12 DLEQ against cached mint keyset | 0 |
| T8 | Mint | Rug / compromise | Small balances, creator-chosen mint, one-click melt-out, mint shown in UI | Balance at that mint |
| T9 | Impostor creator | Fake video under real title | Signed NIP-71 event; UI shows verified pubkey/NIP-05, not just display name | Reputation |
| T10 | Sybil seeders | Join topic, serve nothing | Pay-after-verify makes them unprofitable; peer reputation | Time |
| T11 | Internet | DoS seeder/gateway | Per-pubkey rate limits, max streams, OS hardening | Availability |
| T12 | npm | Compromised dep | Lockfile, `npm ci --ignore-scripts`, exact pins, native module audit | Depends |
| T13 | Portal operator | Malicious JS | Open source, reproducible build, hash in signed Nostr event, SRI, CSP. **Not fully fixable in a browser — say so in the UI.** | Web session |
| T14 | Host | Keys read from disk/logs | Encrypted at rest, secure memory, log redaction | Keys on host |
| T15 | Content | XSS via titles/descriptions/comments | Render as text or sanitized markdown; CSP no-inline; Electron `contextIsolation`, no `nodeIntegration`, sandboxed renderer | 0 |
| T16 | Content | Malicious thumbnail/blob | Thumbnails are Blossom blobs with `x` hash in imeta; verify before display; images decoded in renderer only | 0 |

Two rows describe the original plan more than the released app:

- **T13** is about a web portal. No web shell ships in 0.1.0 (`packages/app-web` is an empty
  scaffold), so the row is kept for a future one.
- **T16** now works through ADR 0015: an image is shown only if it matches a hash its publisher
  signed. If the user turns on remote images, any `https` image loads without that check.

## Non-negotiable invariants of the money path

Specified in `docs/plan/build-plan.md` §1–§3 and enforced by the adversary tests:

1. **Pay after verify.** A viewer pays only for blocks Hypercore has emitted `download`
   for from that specific peer. Hypercore does not emit `download` for a block that failed
   its Merkle proof.
2. **Exact amounts.** A `PAY` must cover exactly `blocks × price` split per the video's
   `split` tag, with the creator's fractional share carried across PAYs on the channel
   (`payment/split.ts`, ADR 0007/0010). Underpayment and overpayment are both rejected.
3. **Two locked sets.** Every `PAY` carries a seeder proof set and a creator proof set,
   each P2PK-locked (NUT-11) to its recipient, each carrying DLEQ (NUT-12); the creator set
   is bound to the seeder it pays through. A set is empty only when its share is 0 sats.
4. **Offline verification before `ACK`.** DLEQ against the cached mint keyset, P2PK target
   check, amount check, mint allowlist — all before the seeder acknowledges.
5. **Window then cut.** `uploaded − paid` per peer may not exceed the window (default 4
   blocks). Past it the seeder destroys the stream and bans the pubkey.
6. **Ban on double-spend.** A PAY re-presenting a proof the seeder already accepted is
   refused at `verify`, and an async swap at the mint that reports an already-spent proof
   bans the paying pubkey; either way the ban list is persisted.
7. **No key or proof in a log, ever.** A redaction layer sits in front of every logger.
8. **No browser persistence of proofs or keys.** The web shell holds NIP-60 state in memory
   only.

Invariant 8 is about a browser shell, which does not ship in 0.1.0; it applies to any future one.

## Locked directories

These directories are the audit surface: the code that handles money, keys and the `pay/1` wire
format (`MockPaymentEngine` lives in `packages/core/src/mocks/`, outside the lock).
`.github/CODEOWNERS` asks the maintainer to review every change to them, and
`scripts/check-locked-dirs.sh` runs in CI and fails any change that makes them log anything or
import from outside the audited libraries (`@cashu/cashu-ts`, `nostr-tools`,
`sodium-universal`, `compact-encoding`, `@sovit/core`, and `@scure/bip39` for the NUT-13
recovery phrase, ADR 0016 D4). Write the failing test first.

```
packages/core/src/payment/
packages/core/src/signer/
packages/core/src/pay-protocol/
packages/core/src/wallet/spend.ts
packages/core/src/wallet/seed.ts
packages/gateway/src/auth/
```

## No model writes crypto

Hashing, signatures, blinding, DLEQ, key derivation and secure memory come from
`@cashu/cashu-ts`, `sodium-native` / `sodium-universal`, `nostr-tools` and `hypercore`.
No code in this project, whether a person or an AI model wrote it, implements a cryptographic
primitive. A contributor who finds that a change needs one stops and opens an issue.

The iroh helper (`crates/iroh-helper/`, ADR 0021) adds n0's `iroh` (QUIC and its TLS) and
`iroh-blobs` (BLAKE3) as sources, in a separate process. Neither is a trust anchor for content:
the helper never says bytes are "verified", and every NFX file is checked against its sha256,
through sodium, in the worker before it is used or stored (NFX-05 §4).
