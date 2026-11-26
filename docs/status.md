# Status

Last updated 2026-11-26 (UTC). For what each release contains, see the [CHANGELOG](../CHANGELOG.md);
for what does not work yet, see the README's [known limitations](../README.md#known-limitations).

## Release

- **Desktop 0.1.4** is the current release: tag `desktop-v0.1.4`, 2026-11-26 (UTC), as a Linux
  x86_64 `.deb` and AppImage. It fixes local keys, which no earlier release could create, import
  or unlock (#150). It adds stats for nerds in every player (where a video's bytes come
  from, source by source; peers by short ID, addresses only behind a switch that is off every
  time), finds free videos through the network's own relay (`relay.nutflix.xyz`) before your read
  relays, and changes the default relays (`relay.damus.io` and `nos.lol` leave the read relays;
  signaling goes to `relay.nutflix.xyz` first). Electron is 45.3.1 and the iroh helper's lock is
  iroh 1.4.1. The interop jobs (exit, NAT matrix, the app trading with headless Chromium) still
  judge the app against nfx 0.1.2's nfxd (nfx 491d35e), as for 0.1.3; they have not been moved to
  nfx 0.1.4's. 0.1.3 (2026-11-17) made free video work with no setup: NFX on by default on
  `nfx:testnet:1`'s public relays, trading video with web browsers over WebRTC signaled over Nostr
  (ADR 0023), one size by default with the creator picking others (issue #97). 0.1.2
  (2026-11-07) added Home's Network tab; 0.1.1 (2026-11-06) brought free video over NFX; 0.1.0
  was published 2026-10-05. Downloads, checksums and the signed release notice are on the
  [Releases page](https://github.com/SovereignTechnology/nutflix-pear/releases/latest).
- It is **experimental**. There is no Windows, macOS or arm64 build, no automatic update and no
  operating-system code signing.

## What is checked

Every pull request runs these on GitHub Actions ([`ci.yml`](../.github/workflows/ci.yml)):

- **verify**: lockfile drift, registry-only resolutions, registry signatures and provenance, advisories
  (high and above), lint, typecheck, the audit-surface and contracts-version checks, the native-module
  inventory and the Electron security lint.
- **test**: the unit and integration suites. On the release commit's run (2026-10-05) that was 248
  test files, 4,065 tests passed and 36 skipped.
- **e2e**: the Electron end-to-end suites, with Chromium's sandbox on, under a virtual display.
  One of them (`secure-memory.e2e.ts`, since 0.1.4) runs inside the Electron binary without
  mocks: it makes, unlocks and uses a local key, derives the wallet seed and makes a signaling key.
- **package**: stages the packaged app and runs its gates (no installer is built).

A fuzz campaign over the `pay/1` codec and the payment parsers runs on demand
([`fuzz.yml`](../.github/workflows/fuzz.yml)), and its targets also run briefly in every test run.
The real-mint suites (`scripts/real-mint/`) run against a local Nutshell or cdk-mintd with a fake
Lightning backend; they are opt-in and not part of CI.

## What has not been checked

- The packaged app has not been run end to end against real relays, real peers and a real mint,
  and there is no recorded install-and-launch of the `.deb` or AppImage on a clean machine. The
  end-to-end suites run the development layout with fixtures and mock money. That is how every
  release up to 0.1.3 shipped unable to create a local key (#150): no suite had run the signer
  inside Electron. The sign-in flow itself, through the prompt window to a stored key, is still
  not run end to end.
- No real payment is on record, and no independent party has audited the code.
  [`security-review.md`](security-review.md) is an in-house review.
- Where the signed release notice is published on Nostr relays has not been re-checked since the
  release.

## Open work

In no order of priority, and not scheduled:

- The problems listed under the README's known limitations, starting with the playback gate.
- Windows and macOS builds, and a way to update the app. Linux arm64 builds and an `.rpm` are
  configured but not yet released ([ADR 0017](decisions/0017-packaging.md), amended 2026-11-26).
- The web client for NFX videos at web.nutflix.xyz, in `packages/app-web` (see
  [ADR 0022](decisions/0022-a-web-client-for-nfx.md)).
- Open issue: [free (zero-price) videos](https://github.com/SovereignTechnology/nutflix-pear/issues/15).

## Elsewhere

- Decisions and their reasons: [`decisions/`](decisions/).
- Security: [`../SECURITY.md`](../SECURITY.md) and [`security-review.md`](security-review.md).
- The old build log: [`archive/status-2026-10-04.md`](archive/status-2026-10-04.md).
