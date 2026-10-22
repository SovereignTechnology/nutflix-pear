# @sovit/seeder

A headless seeder daemon: it serves videos from a Corestore of Hyperblobs over Hyperswarm and runs
the server side of `pay/1`, checking each payment before it acknowledges and banning peers that
cheat. It batches the proofs it earns, applies rate limits, and can send its earnings to the
owner's wallet as a NIP-61 nutzap. It is internal to this workspace and is not part of the desktop
release.

```sh
npm run build
node packages/seeder/dist/index.js --config seeder.json --check   # validate the config and exit
```

`--check`, `--keygen` and the config keys, the key file and passphrase handling, the exit codes
and the hardened systemd unit are documented in
[`deploy/systemd/README.md`](../../deploy/systemd/README.md).

The standalone daemon serves the core it already holds. The command line has no option to load a
video into it yet, so for now it is of use mainly as a building block: the desktop app embeds the
same code in its worker.

It also carries the NFX-12 HyperDHT transport (`src/nfx/`, ADR 0020): `listenNfx` serves whole
files by sha256 on a per-network peer key, `dialNfx` fetches them and checks each one. It is free
mode only for now, runs beside the Hypercore path above and shares no keys or stores with it.
