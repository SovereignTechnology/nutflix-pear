# Status

Last updated 2026-11-17 (UTC). For what each release contains, see the [CHANGELOG](../CHANGELOG.md);
for what does not work yet, see the README's [known limitations](../README.md#known-limitations).

## Release

- **Desktop 0.1.3** is the current release: tag `desktop-v0.1.3`, 2026-11-17 (UTC), as a Linux
  x86_64 `.deb` and AppImage. Free video works with no setup: NFX is on by default, on
  `nfx:testnet:1`'s public relays (`wss://relay.nutflix.xyz`, `https://iroh.nutflix.xyz/`), with
  `relay.ditto.pub` as a fourth default relay so Search answers; the app trades video with web
  browsers over WebRTC, signaled over Nostr (ADR 0023); Studio makes one size by default and the
  creator picks the others (issue #97). Before the release it was checked against nfx 0.1.2 (nfx
  491d35e, the nfxd booty and the public testnet run): the exit run both ways, the real app over
  iroh (tier 3), the NAT matrix (69 of 69 cells), the app trading a video with headless Chromium
  over a stock Nostr relay, and, over the internet, a fresh install's settings finding booty's
  Big Buck Bunny on the default relays and playing its 1080p end to end (403 MB at 19 Mbit/s,
  `host/__tests__/nfx-live.integration.test.ts` in a Kata VM). 0.1.2 (2026-11-07) added Home's
  Network tab; 0.1.1 (2026-11-06) brought free video over NFX, tested in both directions against
  nfxd on one machine, behind simulated NATs and on two machines over the internet; 0.1.0 was
  published 2026-10-05. Downloads, checksums and the signed release notice are on the
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
- **package**: stages the packaged app and runs its gates (no installer is built).

A fuzz campaign over the `pay/1` codec and the payment parsers runs on demand
([`fuzz.yml`](../.github/workflows/fuzz.yml)), and its targets also run briefly in every test run.
The real-mint suites (`scripts/real-mint/`) run against a local Nutshell or cdk-mintd with a fake
Lightning backend; they are opt-in and not part of CI.

## What has not been checked

- The packaged app has not been run end to end against real relays, real peers and a real mint,
  and there is no recorded install-and-launch of the `.deb` or AppImage on a clean machine. The
  end-to-end suites run the development layout with fixtures and mock money.
- No real payment is on record, and no independent party has audited the code.
  [`security-review.md`](security-review.md) is an in-house review.
- Where the signed release notice is published on Nostr relays has not been re-checked since the
  release.

## Open work

In no order of priority, and not scheduled:

- The problems listed under the README's known limitations, starting with the playback gate.
- Windows, macOS and arm64 builds, and a way to update the app.
- The web client for NFX videos at web.nutflix.xyz, in `packages/app-web` (see
  [ADR 0022](decisions/0022-a-web-client-for-nfx.md)).
- Open issue: [free (zero-price) videos](https://github.com/SovereignTechnology/nutflix-pear/issues/15).

## Elsewhere

- Decisions and their reasons: [`decisions/`](decisions/).
- Security: [`../SECURITY.md`](../SECURITY.md) and [`security-review.md`](security-review.md).
- The old build log: [`archive/status-2026-10-04.md`](archive/status-2026-10-04.md).
