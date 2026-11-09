# Spike S-D harness: the iroh helper against nfxd

CI only (`.github/workflows/spike-iroh.yml`): nothing here runs on a developer's machine, and none
of it ships. The record, with the verdict and the numbers, is
[`docs/spikes/S-D-iroh-helper.md`](../../docs/spikes/S-D-iroh-helper.md); the decision is
[ADR 0021](../../docs/decisions/0021-speak-iroh-through-a-helper.md).

| File | What it is |
|---|---|
| `harness.mjs` | The worker's side of the helper under Node 22: `serve` (the NfxStore, the helper's imports and collections, signed beacons) and `fetch` (beacons, the NFX-06 fetch through the helper, sha256 on every file, the NfxStore). |
| `nfx06.mjs` | NFX-06 §2 in JavaScript: collection membership from a verified hash list and its playlists, and the capped, re-anchoring fetch (as nfx-node's `video.rs` and `fetch.rs`). |
| `bare-smoke.mjs` | The helper client under the real Bare runtime through `bare-subprocess` with a stdin pipe: two helpers on loopback, a get, a SIGKILL and restart, clean exits. |
| `bare-sidecar-run.mjs` | Starts the smoke through bare-sidecar, as the host starts the worker (holding `Bare.IPC`); the plain `bare` without it tears down mid-run (finding 10, Bare's own). |
| `nat/run.sh` | S5′'s NAT matrix (network namespaces, nft masquerade, `fully-random` for symmetric), lifted from nfx at `29019d2`, with an iroh relay and a scoped Nostr relay in the public namespace and a byte meter on the client's router. Since nfx #30's groundwork it also runs Nostr-only cells (no iroh relay), a public seeder and a port-forwarded one, and the same through a stock Nostr relay (strfry). |
| `two-host/meter.sh` | The two-host run's path meter (bytes from the iroh relays vs direct), with or without iroh relays (`nostr_only`). |

The harness imports the built packages (`npm run build` first) and the worker's helper client from
`packages/app-desktop/dist/worker/iroh/`.
