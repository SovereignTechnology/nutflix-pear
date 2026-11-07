# Status

Last updated 2026-11-06 (UTC). For what each release contains, see the [CHANGELOG](../CHANGELOG.md);
for what does not work yet, see the README's [known limitations](../README.md#known-limitations).

## Release

- **Desktop 0.1.2** is the current release: tag `desktop-v0.1.2`, 2026-11-07 (UTC), as a Linux
  x86_64 `.deb` and AppImage. It adds Home's Network tab, every free video on the NFX network
  (contracts v13). 0.1.1 (2026-11-06) brought free video over NFX (nfx 0.1.0's network, iroh
  through the bundled helper, HyperDHT between Nutflix apps), tested in both directions against
  nfxd: on one machine (the exit run, the app itself included), behind simulated NATs (33 of 33),
  and on two separate machines over the internet (run 42300979880, where the peers holepunched
  and went direct); a person pressed play on it with booty's nfxd as the seeder, on two machines.
  0.1.0 was published 2026-10-05. Downloads, checksums and the signed release notice are on the
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
- Removing the empty `packages/app-web` scaffold (see [ADR 0019](decisions/0019-scope-pear-desktop-only.md)).
- Open issue: [free (zero-price) videos](https://github.com/SovereignTechnology/nutflix-pear/issues/15).

## Elsewhere

- Decisions and their reasons: [`decisions/`](decisions/).
- Security: [`../SECURITY.md`](../SECURITY.md) and [`security-review.md`](security-review.md).
- The old build log: [`archive/status-2026-10-04.md`](archive/status-2026-10-04.md).
