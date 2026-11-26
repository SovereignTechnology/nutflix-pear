# Documentation

Start with the [project README](../README.md). This page indexes everything else by what you are
trying to do.

## Project status

- [`status.md`](status.md): the current status: what is released, what CI checks, what has not
  been checked, and the open work.
- [`CHANGELOG.md`](../CHANGELOG.md): what each release contains.

## Use the app

- [Releases](https://github.com/SovereignTechnology/nutflix-pear/releases): the downloads, with
  checksums and the signed release notice.
- [README: Install](../README.md#install) covers installing and verifying a release.
- Open the [playback budget worksheet](playback-budget.html) from a local checkout in your browser
  to try different block prices and see the creator and seeder shares. It works offline.

## Run a seeder or gateway

- [`deploy/systemd/README.md`](../deploy/systemd/README.md): the hardened systemd units for the
  seeder and gateway daemons, the config keys, and what each hardening directive does.
- [`deploy/systemd/MDWE-RESULTS.md`](../deploy/systemd/MDWE-RESULTS.md): the measured result for
  `MemoryDenyWriteExecute`.

## Contribute

- [`CONTRIBUTING.md`](../CONTRIBUTING.md) and the [Code of Conduct](../CODE_OF_CONDUCT.md).
- [`decisions/`](decisions/): architecture decision records (ADRs). Each one records a decision
  and why it was made. Code comments cite them by number, so they are never renumbered.
- [`plan/build-plan.md`](plan/build-plan.md): the original build plan. It is a historical input:
  where it disagrees with the ADRs or the code, those win.
- [`spikes/`](spikes/): the three early research spikes that ADRs 0002 and 0003 rest on.
- [`development.md`](development.md): running the Electron end-to-end suites.
- [`native-modules.txt`](native-modules.txt): the reviewed list of native modules. CI fails if the
  installed set differs; `scripts/native-module-inventory.sh --check` runs the same test.

## Review the security

- [`SECURITY.md`](../SECURITY.md): how to report a vulnerability, the threat model, the
  money-path invariants and the audit surface.
- [`security-review.md`](security-review.md): the security review: every finding, its state and
  its residual risk.
- [`archive/reviews/`](archive/reviews/): the per-change review records written before each
  push. They are self-review by the session that made the change, not independent audits.

## Reference

- [`vendor/`](vendor/): pinned copies of the upstream specs and library docs the code is written
  against (Nostr NIPs, Cashu NUTs, Blossom BUDs, Hypercore and Pear). They are other projects'
  documents, not covered by this repository's licence grant.
- [`design/README.md`](design/README.md): the brief the UI was designed to.

## Project history

[`archive/`](archive/README.md) holds the working records of the build: the old status log, the
execution plan, the lane reports, the contract requests, the pre-push security reviews and the
prompts. They are kept for provenance and are not current documentation; commit hashes and branch
names in them may not exist in this repository. The design review of the desktop shell,
[`plan/L6-design.md`](plan/L6-design.md), is also from before it was built.
