**Nutflix desktop for Linux (x86_64).** A peer-to-peer video player that pays seeders in Cashu ecash, and plays free videos over the NFX network (off until you set it up: see the known limitations). It is experimental: read the [known limitations](https://github.com/SovereignTechnology/nutflix-pear#known-limitations) first.

| File                             | For                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `nutflix_<version>_amd64.deb`    | Debian and Ubuntu, including Ubuntu 24.04 and later (recommended)                                                           |
| `Nutflix-<version>-x64.AppImage` | Other distributions. **Not for Ubuntu 24.04 or later**: it cannot start there without a user-namespace grant, so use the `.deb` |

Install the `.deb` with `sudo apt install ./nutflix_<version>_amd64.deb` (the `./` matters), then run `nutflix`. Studio needs `ffmpeg` and `ffprobe` to transcode uploads (`sudo apt install ffmpeg`). There is no automatic update: install a new release by hand, and verify it first.

## Verify before you install

These files are **not signed by an operating-system vendor**: your system may warn about that. Their integrity rests on two things published with this release:

- `SHA256SUMS`: check a download with `sha256sum -c SHA256SUMS --ignore-missing`. This shows a file is intact; it does not show who made it.
- `release-event.json`: a Nostr release notice (kind 30071, `d` = `nutflix-desktop`) signed by the SovTech key `npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx`. The same notice is published to Nostr relays.

To check the signature you need a checkout of this repository and Node 22.18 or newer:

```sh
git clone https://github.com/SovereignTechnology/nutflix-pear.git && cd nutflix-pear
npm ci --ignore-scripts
node scripts/release-verify.mjs release-event.json nutflix_<version>_amd64.deb   # each file you downloaded
node scripts/release-verify.mjs release-event.json --all <download-dir>           # needs both files
```

It checks the signature, that the key is SovTech's, and every file's size and sha256. Keep the original file names. An older genuine release also verifies, so compare its version and date with the current notice on the relays.

`release-manifest.json` and `release-event.unsigned.json` are attached for reference: the unsigned notice is not proof of anything until the signed one exists.
