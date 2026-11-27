# NFX test vectors

Byte-for-byte copies of seventeen files from the NFX suite's `spec/test-vectors/`, at nfx commit
`4b6095c2aea7f05e7ee384c478fb59857b4eac1d` (SovereignTechnology/nutflix `main`, the repository
once named nfx; the squash merge of PR #119, the commit `packages/app-web/nfx-web.lock` pins; the
fifteen files vendored before, at `b5fe5e4`, are unchanged there). They are the golden fixtures `packages/core/src/nfx/` is written against (NFX-11 §4:
the wire is pinned by its fixtures, not by a library version).

| File                                                     | What it pins                                     |
| -------------------------------------------------------- | ------------------------------------------------ |
| `canon.json`                                             | canonical JSON (NFX-11 §9)                       |
| `manifest.json`, `manifest-open.json`, `manifest-invalid.json` | kind-38504 manifests (NFX-02)              |
| `deletion.json`                                          | manifest deletions (NFX-02 §6)                   |
| `derived.json`                                           | namespaces, video ids and derived topics (NFX-01) |
| `beacon.json`, `beacon-invalid.json`                     | kind-20464 beacons (NFX-03)                      |
| `beacon-hyperdht.json`                                   | the `hyperdht` endpoint and its `bind` (NFX-12 §2) |
| `hashlist.json`, `hashlist-invalid.json`                 | hash lists and playlists (NFX-05)                |
| `files1.json`                                            | `nfx/files/1` and `nfx/pay/1` messages (NFX-12 §§4–5) |
| `beacon-stun.json`                                       | the `stun` endpoint (NFX-10 §1)                  |
| `mesh-signal.json`, `mesh-signal-invalid.json`           | signaling over Nostr, kind 25050 `nfx-mesh/1` (NFX-10 §6) |
| `lookup.json`, `lookup-invalid.json`                     | seeder lookup, kind 20465 ask and tell (NFX-17)  |

`SHA256SUMS` pins every file. `packages/core/src/nfx/__tests__/vectors.test.ts` recomputes the
hashes and fails on a changed, missing or unpinned file, then runs every case.

The `secret_keys_DO_NOT_USE` members are the suite's published throwaway keys, there so the
signed fixtures can be reproduced. They sign nothing real.

## Refreshing

Copy the files again from an nfx checkout at the new commit (`git show <commit>:spec/test-vectors/<file>`),
regenerate `SHA256SUMS` with `sha256sum -- *.json | sort -k2` under the two comment lines, name
the commit here and in `SHA256SUMS`, and review the diff: a changed vector is a changed wire.

## Licence

The NFX specification text in `spec/` is public domain (CC0), per the nfx repository's
`spec/README.md`. The vectors are copied from that directory.
