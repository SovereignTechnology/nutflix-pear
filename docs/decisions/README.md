# Architecture decision records

Each file here records one decision that is expensive to reverse: the context that forced it, the
decision, and its consequences, including the bad ones. The format is the one in
[ADR 0001](0001-record-architecture-decisions.md).

Code comments cite these records by number, so **an ADR is never renumbered or renamed**. To change
an accepted decision, add a dated amendment and say so in its Status line, or write a new ADR that
supersedes it.

## Index

| ADR                                                  | Decision                                                                  | Status                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------- |
| [0001](0001-record-architecture-decisions.md)        | Record architecture decisions                                             | Accepted                                                  |
| [0002](0002-stack-and-architecture.md)               | Stack: Hypercore transport, Nostr catalog, Cashu payment, one React UI    | Accepted; the web shell and portal parts amended by 0019  |
| [0003](0003-stage-0-spike-resolutions.md)            | Early spike resolutions: A4, A8, A9, the transcode path, the desktop shell | Accepted; amended by 0019 (the browser-Hypercore result) |
| [0004](0004-contracts-v3.md)                         | Contracts v3: release-notice kind, `hyper://` grammar, per-core PAY       | Accepted                                                  |
| [0005](0005-open-questions.md)                       | Open questions of the build plan, resolved                                | Accepted; Q1 amended by 0007                              |
| [0007](0007-contracts-v4-reactions-and-pay-split.md) | Contracts v4 (reactions); the per-PAY split with a minimum and a carry    | Accepted; amends 0005 Q1; amended in part by 0010         |
| [0009](0009-first-run-relays.md)                     | First-run relays: keep the three public defaults                          | Accepted                                                  |
| [0010](0010-contracts-v5.md)                         | Contracts v5: per-block uploads, connection-bound HELLO, local double-spend check | Accepted; amends 0007 (a)                              |
| [0011](0011-seeder-daemon-runtime.md)                | The seeder daemon's runtime: key delivery, wallet storage, nutzaps        | Proposed in the file; implemented                         |
| [0012](0012-desktop-money-plane.md)                  | The desktop money plane: the host spends, the worker asks                 | Accepted; one part superseded 2026-09-26 (see its inline note) |
| [0013](0013-desktop-signer-connect.md)               | The desktop signer: the user picks how it unlocks                         | Accepted                                                  |
| [0014](0014-wallet-journal-nut09.md)                 | A lost mint answer loses nothing: a write-ahead journal and NUT-09 restore | Accepted                                                 |
| [0015](0015-images-over-pear.md)                     | Thumbnails and avatars over Pear                                          | Accepted                                                  |
| [0016](0016-nut13-seed-backup.md)                    | A wallet rebuilt from twelve words: NUT-13 seed backup                    | Accepted                                                  |
| [0017](0017-packaging.md)                            | Packaging: Electron Forge, fuses, asar and Nostr-signed releases          | Accepted; shipped as desktop 0.1.0 (.deb and AppImage)    |
| [0018](0018-one-peer-routing.md)                     | One seeder per block, credit per seeder window                            | Accepted                                                  |
| [0019](0019-scope-pear-desktop-only.md)              | Scope: Pear/desktop only; the web portal is out                           | Accepted; scope amended by 0020                           |
| [0020](0020-speak-nfx.md)                            | Speak NFX beside the legacy protocol                                      | Accepted                                                  |

## Numbering

The next free number is **0020**. Numbers **0006** and **0008** are not
missing: the sibling [nfx](https://github.com/SovereignTechnology/nfx) repository uses them
([0006, the standardisation suite](https://github.com/SovereignTechnology/nfx/blob/main/docs/decisions/0006-standardization-suite-nfx.md)
and
[0008, the multi-network master plan](https://github.com/SovereignTechnology/nfx/blob/main/docs/decisions/0008-multi-network-master-plan.md)),
so this repository never uses them. ADRs 0001 to 0005 and 0007 are shared between the two
repositories.

## Statuses

`Proposed`, `Accepted`, and `Superseded by NNNN`, as in ADR 0001. In practice an accepted ADR is
also amended in place with a dated note when a later decision changes part of it; the Status line
says so, and the index above repeats it.

Several records mention "lanes", "stage-3" branches and numbered issues. Those are the internal
build process that produced them: the lanes were units of parallel work, and the branches and the
issue numbers belonged to a private tracker, so they do not exist in this repository. "The
maintainer" is whoever answered the open questions. The decisions stand on their own text.
