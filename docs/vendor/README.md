# Vendored upstream documentation

Pinned copies of the specifications and library documentation that the code is written against, so
a reader can check an implementation against the exact text offline, at the versions this
repository pins. They are **other projects' documents**. They are not part of this project's work
and are **not covered by its AGPL-3.0-or-later grant**; each keeps the terms below.

`MANIFEST.txt` records, per file, a short sha256, the fetch date and the source URL.
`versions.txt` pins the npm versions whose READMEs are vendored.

## Provenance and licences

| Files                                        | Upstream                                            | Ref                                     | Licence                                                                                   |
| -------------------------------------------- | --------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------- |
| `NIP-*.md` (16)                              | [nostr-protocol/nips](https://github.com/nostr-protocol/nips) | `master`, fetched 2026-09-04   | Public domain ("All NIPs are public domain", README, section License)                     |
| `NUT-*.md` (11)                              | [cashubtc/nuts](https://github.com/cashubtc/nuts)   | `main`; NUT-07, 09, 13 and 13-tests pinned to commit `8bde3c0` (2026-09-26) | MIT                                |
| `BUD-*.md` (6)                               | [hzrd149/blossom](https://github.com/hzrd149/blossom) | `master`, fetched 2026-09-04          | The Unlicense                                                                             |
| Package READMEs (14, listed below)           | npm, at the versions in `versions.txt`              | exact version                           | The licence of each package, as declared on npm                                           |
| Pear documentation and examples (33: `pear-*.md`, `bare-modules.md`, `bare-subprocess-reference.md`, `examples/`) | [holepunchto/pear-docs](https://github.com/holepunchto/pear-docs) | `published` and `preview` branches, fetched 2026-09-04 | **Not stated by the upstream repository** (see below) |
| `nfx-test-vectors/` (12 JSON files)          | [SovereignTechnology/nfx](https://github.com/SovereignTechnology/nfx) `spec/test-vectors/` | commit `47cb059` (PR #2), pinned by `nfx-test-vectors/SHA256SUMS` | Public domain (CC0), per the nfx `spec/README.md` |

Package READMEs and their declared licences: Apache-2.0 for `bare-ffmpeg`, `bare-media`,
`bare-subprocess`, `compact-encoding`, `hyperblobs`, `hypercore-blob-server` and `pear-electron`;
MIT for `corestore`, `hypercore`, `hyperswarm`, `protomux` and `sodium-native`;
MIT OR Apache-2.0 for `@cashu/cashu-ts`; the Unlicense for `nostr-tools`.

### The Pear documentation

The `holepunchto/pear-docs` repository contains no licence file and its README states no terms, so
the licence of that text and of the example code taken from it is **unstated**. The example
`package.json` files declare Apache-2.0 (`examples/video-stream`) and ISC
(`examples/hyperblobs-reader` and `-writer`). These 33 files are here for reference. If the
upstream states other terms, or objects, they should be removed; `scripts/vendor-docs.sh` can
fetch them into a working tree again.

## Refreshing

```sh
scripts/vendor-docs.sh          # needs network access; rewrites the files and MANIFEST.txt
```

Two caveats about the script as it stands:

- It fetches NUT-00, 03, 04, 05, 10, 11 and 12 from `main`. The four files pinned to commit
  `8bde3c0` (NUT-07, NUT-09, NUT-13 and NUT-13-tests) are not in the script, so a refresh would
  drop their `MANIFEST.txt` rows. Add them to the script, with the same commit pin, before
  refreshing.
- The NIP, BUD and Pear sources are branch heads, not commits, so a refresh can change them.
  Review the diff before committing it.

When a package pinned in `versions.txt` is bumped in a `package.json`, bump it here as well and
refresh that README.
