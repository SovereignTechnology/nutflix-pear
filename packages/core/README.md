# @sovit/core

The protocol library behind Nutflix: the interface contracts, the Nostr data layer, video
manifests, media helpers, and the payment, signer, wallet and `pay/1` code. Every other package
builds on it. It is internal to this workspace and is not published to npm.

| Directory       | What it holds                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `contracts/`    | The frozen interfaces (network adapter, signer, wallet, payment engine, `pay/1`, manifest, media) and `CONTRACTS_VERSION` |
| `nostr/`        | The relay data layer: feeds, follows, profiles, reactions, comments, reports, trending           |
| `manifest/`     | Parsing and building the signed video events (NIP-71)                                            |
| `nfx/`          | The NFX wire formats (ADR 0020): manifests, beacons, hash lists, canonical JSON, the NFX-12 messages; pinned by `docs/vendor/nfx-test-vectors` |
| `media/`        | The rendition ladder and the ffmpeg helpers                                                      |
| `payment/`      | The payment engine: the seeder/creator split, P2PK locks, seen proofs, unpaid-block records      |
| `pay-protocol/` | The `pay/1` wire format                                                                          |
| `signer/`       | The local-key signer and the NIP-46 remote signer                                                |
| `wallet/`       | The NIP-60 wallet: spending, the crash-recovery journal and the recovery phrase (NUT-13)         |
| `mocks/`        | Test doubles: a mock payment engine, wallet and network adapter. Not shipped in the packaged app |
| `fuzz/`         | Fuzz targets for the `pay/1` codec and the payment parsers                                       |

`contracts/` is frozen: a change there must bump `CONTRACTS_VERSION` and come with an ADR
(`npm run check:contracts`). `payment/`, `signer/`, `pay-protocol/`, `wallet/spend.ts` and
`wallet/seed.ts` are the audit surface: nothing there logs and it imports only the audited
libraries (`npm run check:locked`, [SECURITY.md](../../SECURITY.md#locked-directories)).

Build with `npm run build` at the repository root. Tests sit in `__tests__` directories and run
with `npm test`.
