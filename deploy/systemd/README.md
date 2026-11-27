# deploy/systemd — seeder and gateway units

| File | Purpose |
|------|---------|
| `nutflix-seeder.service` | Seeder daemon: Corestore + Hyperblobs over Hyperswarm, pay/1 server side |
| `nutflix-gateway.service` | Gateway: the seeder plus WS bridge + Blossom HTTP (inbound listener) |
| `nutflix.sysusers.conf` | `sysusers.d` fragment creating the two dedicated no-login accounts |
| `test-hardening.sh` | User-scope (`systemd-run --user`) test of MDWE + seccomp directives against Node 22 and the native modules |
| `MDWE-RESULTS.md` | The measured result behind `MemoryDenyWriteExecute=yes` + `--jitless`, and the `AF_NETLINK` finding |

Install (as root on the host):

```sh
install -m 0644 nutflix.sysusers.conf /etc/sysusers.d/nutflix.conf && systemd-sysusers
install -m 0644 nutflix-seeder.service nutflix-gateway.service /etc/systemd/system/
mkdir -p /etc/nutflix && install -m 0640 -o root -g nutflix-seeder seeder.json /etc/nutflix/
systemctl daemon-reload
# seeder only: the key passphrase credential and the key file, once — see "Seeder key file and passphrase"
systemctl enable --now nutflix-seeder            # and/or nutflix-gateway
systemd-analyze security nutflix-seeder          # sanity: should sit in the "SAFE" band
```

The application tree is expected at `/opt/nutflix` (a `git checkout` + `npm ci --ignore-scripts` + `npm run build`, owned by root, read-only to the service users — `ProtectSystem=strict` enforces the read-only part regardless of ownership).

## Entry points and exit codes

- **`ExecStart`**: `node --jitless --no-experimental-websocket <package main> --config /etc/nutflix/<svc>.json` in both units. Keep `--jitless` (see below); on Node 22 it also needs `--no-experimental-websocket` (`MDWE-RESULTS.md` §6).
  - **Gateway.** `packages/gateway/dist/index.js` self-runs only as the main module, takes `--config`, exits 78 (`EX_CONFIG`) on a bad config so `Restart=on-failure` + `StartLimitBurst` fail fast, and `STATE_DIRECTORY` fills a missing `dataDir`. `Type=simple` is right (`sdNotify` is a no-op without `NOTIFY_SOCKET`).
  - **Seeder.** `packages/seeder/dist/index.js` self-runs only when it is the process's main module (`isMainModule`, symlinks resolved; importing `@sovit/seeder`, as the gateway does, runs nothing), takes `--config <path>` (fallback `NUTFLIX_SEEDER_CONFIG`) and `--check`, and exits **0** clean, **1** on a runtime failure, **78** (`EX_CONFIG`) on bad arguments, a missing/unreadable/invalid config, or missing runtime providers. `STATE_DIRECTORY` fills a missing `dataDir`, so `StateDirectory=nutflix-seeder` works unchanged; `Type=simple` fits (`sdNotify` is a no-op without `NOTIFY_SOCKET`); SIGTERM/SIGINT/SIGHUP → one graceful `Seeder.close()` (hard exit 1 after 25 s, under `TimeoutStopSec=30s`).
    - **It runs for real** (ADR 0011): `cli/providers.ts` unlocks the key file with the `seeder-key-passphrase` credential, opens the wallet, builds the real payment engine and attaches `pay/1` + HELLO to every swarm session. Without the key file or the credential it logs `runtime providers failed — refusing to start` + the reason and exits 78 before creating anything; with `Restart=on-failure` + `StartLimitBurst=5` the unit gives up after 5 tries in 5 minutes rather than looping.
    - **`--check`**: `sudo -u nutflix-seeder node --jitless --no-experimental-websocket /opt/nutflix/packages/seeder/dist/index.js --check --config /etc/nutflix/seeder.json` validates the file (and the env overrides) and exits 0/78 without touching state. `sudo` does not set `STATE_DIRECTORY`: if the file relies on it for `dataDir`, prefix the command with `STATE_DIRECTORY=/var/lib/nutflix-seeder` (via `sudo -u nutflix-seeder env …`). Errors name JSON paths (`$.policy.creatorP2pk: …`), never values, so the output is safe to paste.
    - **Why `ExecStart` has `--no-experimental-websocket`.** Without it the real entry dies one tick after start on Node 22 (`ReferenceError: WebAssembly is not defined`, from Node's own `undici`, which `--jitless` cannot run) — see `MDWE-RESULTS.md` §6. The flag is accepted and harmless on Node 24.
    - This directory is the only source of the units.
  - **Gateway under Node 22 + `--jitless`** (security review F16, fixed). The same `undici` crash had two triggers: the global `WebSocket` (now removed by `--no-experimental-websocket` in the unit) and the gateway's ESM `import … from 'node:http'`, which no flag fixes — the gateway now loads `node:http` through `createRequire` (`packages/gateway/src/gateway.ts`). Guarded by `packages/gateway/src/__tests__/cli.test.ts`, which runs the built entry with the node flags read from the unit.

### Seeder configuration (`/etc/nutflix/seeder.json`)

Every key is checked (`packages/seeder/src/cli/config-file.ts`); an unknown key at any level is an error, so a typo cannot silently fall back to a default. ★ = required. The file is strict JSON: the comments below are for this README only.

```jsonc
{
  "dataDir": "/var/lib/nutflix-seeder",   // ★ unless NUTFLIX_SEEDER_DATA_DIR or STATE_DIRECTORY (the unit's StateDirectory=) supplies it
  "storageDir": "/var/lib/nutflix-seeder/corestore", // default <dataDir>/corestore
  "blockSize": 65536,                     // integer in [1024, 16 MiB]; default 65536
  "diskCapBytes": 53687091200,            // payload-byte cap; default 50 GiB
  "rateLimits": { "maxStreams": 64, "maxStreamsPerKey": 2, "connectsPerWindow": 10, "windowMs": 60000 }, // any subset
  "swarm": { "maxPeers": 64, "server": true, "client": false },
                                          // default {} = ON; null = OFF (no peers at all). "bootstrap": [{ "host", "port" }]
                                          // only for a private DHT (omit it for hyperdht's public nodes).
                                          // keyPair / seed are REFUSED: key material never goes in this file
  "policy": {                             // ★ the price every PAY is verified against (one per seeder)
    "satsPerBlock": 1,                    // ★ integer ≥ 0
    "mints": ["https://mint.example"],    // ★ ≥ 1, normalised (lower-case host, no trailing slash), no duplicates
    "split": { "seeder": 50, "creator": 50 }, // default 50/50; must sum to 100
    "creatorP2pk": "02…64 hex…",          // ★ creator's Cashu P2PK pubkey (02/03 + 64 lower-case hex)
    "creatorPubkey": "…64 hex…",          // ★ creator's Nostr pubkey: the `p` of its nutzaps (never the creatorP2pk key)
    "blockSize": 65536                    // optional; must equal the top-level blockSize
  },
  "relays": ["wss://relay.example"],      // ★ 1–8: where nutzaps (kind 9321) and the node's kind 10019 go; wss:// (ws:// only to loopback)
  "identity": { "keyFile": "/var/lib/nutflix-seeder/identity.key" }, // default <dataDir>/identity.key; absolute path.
                                          // passphrase / nsec / secretKey are REFUSED: the passphrase is a systemd credential
  "videoEvents": { "<core key hex>": "<video event id hex>" }, // optional: the nutzap `e` tag per core
  "payout": {                             // optional (recommended): where the earnings go — see "Payout" below
    "pubkey": "…64 hex…",                 // ★ your wallet's Nostr pubkey (a dedicated one keeps your main identity out)
    "p2pk": "02…64 hex…",                 // ★ your wallet's P2PK key: the `pubkey` of your kind 10019
    "thresholdSats": 1000,                // pay out when a mint's balance reaches this (default 1000)
    "relays": ["wss://relay.example"]     // relays your wallet reads (default: the top-level relays)
  },
  "flushEveryBlocks": 64, "flushEveryMs": 60000, // default: the engine's config, else 64 / 60 s
  "logLevel": "info"                      // debug | info | warn | error
}
```

### Seeder key file and passphrase

The daemon's identity is one encrypted key file (argon2id + XChaCha20-Poly1305; the node's Nostr key and a separate wallet key) whose passphrase arrives as the encrypted systemd credential `seeder-key-passphrase` (`LoadCredentialEncrypted=` in the unit; systemd ≥ 250). PID 1 decrypts it into a private ramfs only the service sees; it is never in the environment, the config or argv (ADR 0011 §1). Once, as root:

```sh
# 1. A random passphrase, straight into the encrypted credential (never on disk in clear).
#    --name must be the credential id the unit loads, not the file name.
install -d -m 0700 /etc/credstore.encrypted
head -c 32 /dev/urandom | base64 -w0 \
  | systemd-creds encrypt --name=seeder-key-passphrase - /etc/credstore.encrypted/nutflix-seeder-key-passphrase
# 2. The key file, sealed under the same bytes, owned by the service user (0600, never overwritten).
install -d -m 0700 -o nutflix-seeder -g nutflix-seeder /var/lib/nutflix-seeder
systemd-creds decrypt --name=seeder-key-passphrase /etc/credstore.encrypted/nutflix-seeder-key-passphrase - \
  | sudo -u nutflix-seeder env STATE_DIRECTORY=/var/lib/nutflix-seeder \
      node --jitless --no-experimental-websocket /opt/nutflix/packages/seeder/dist/index.js \
      --keygen --config /etc/nutflix/seeder.json
```

`--keygen` reads the passphrase from stdin (a terminal is refused: it would echo), writes `keyFile` and logs the node's public key and its wallet's P2PK key (both public; the gateway's config needs both, as `identity.pubkey` and `identity.p2pk`). Keep a copy of the passphrase somewhere offline (a password manager) and back up `identity.key` (it is encrypted); without both the wallet key is gone. On a host without `LoadCredentialEncrypted=` (systemd < 250) use `LoadCredential=seeder-key-passphrase:/etc/nutflix/seeder-key-passphrase` with a root-owned 0600 file — protected by file mode only.

What the daemon keeps under `<dataDir>/wallet/` (0700; every file 0600):

- `proofs.json` — the seeder's ecash, NIP-44 encrypted to the node's key (it opens only with the key file and its passphrase). Inside it is bearer money: let payout move it off the server rather than copying the file around.
- `pending.jsonl` — PAYs accepted but not yet redeemed or nutzapped, as an append-only journal (a restart finishes them; an older `pending.json` is migrated at start); its proofs are still locked to the seeder's or the creator's key.
  **A PAY is only as durable as its journal write.** If a write to this file fails (a full or failing disk), the daemon logs `pending-PAY write failed: accepted payments are in memory only` and keeps serving: that PAY is still acknowledged and is redeemed if the daemon stays up, but it is not in the journal, and a later write does not add it, so a restart before it is redeemed loses it. Treat that log line as an alarm: free the disk and let the queue drain before restarting.
- `payouts.jsonl` — every payout's proofs (locked to your wallet key) and whether a relay took it; one no relay accepted is published again.
- `seen.jsonl` (+ `.1`) — accepted proof secrets, a replay cache, rotated.
- `lock` — one daemon per data directory.

A `proofs.json` or `pending.jsonl` that does not open stops the daemon instead of being overwritten: recover what it holds before moving it aside.

### Payout

With a `payout` block, whenever a mint's balance reaches `thresholdSats` (checked at start and after every flush), the daemon sends the whole balance, less the mint's swap fee, to your wallet: P2PK proofs locked to `payout.p2pk`, published as a NIP-61 nutzap to `payout.pubkey`. Your NIP-60/61 wallet picks it up, and you melt to Lightning from there — the daemon itself never melts, holds only a small balance, and cannot take back what it paid out.

- **Nothing leaves until your wallet's own kind 10019 confirms `payout.p2pk`.** The daemon looks it up on the payout relays. If it names a different key, payouts stop until you fix the config and restart (`payouts stopped` in the journal); if none is found, the money stays on the server and the daemon asks again after the next flush (`payout waits`).
- **Payouts are public** nutzaps: anyone can see that this seeder paid that pubkey, and how much. Use a dedicated wallet pubkey if that matters.
- Without a `payout` block the earnings stay in `proofs.json` (the daemon logs a warning at start).

Precedence, per value: **`NUTFLIX_SEEDER_*` env > file > `STATE_DIRECTORY` (fills `dataDir` only) > default**; config path: **`--config` > `NUTFLIX_SEEDER_CONFIG`**. Env overrides: `NUTFLIX_SEEDER_DATA_DIR`, `NUTFLIX_SEEDER_DISK_CAP_BYTES`, `NUTFLIX_SEEDER_MAX_STREAMS` (→ `rateLimits.maxStreams`), `NUTFLIX_SEEDER_LOG_LEVEL`. An empty assignment (`Environment=NAME=`) counts as unset; numbers must be plain decimal digits. None of these is secret, so `Environment=` is acceptable for them — nothing secret belongs in this file or the environment. The file is not secret either (the policy is published in every video manifest); `0640 root:nutflix-seeder` as in the install block keeps it read-only to the daemon.

### Gateway configuration the unit does NOT set (operator must)

- **Public URL.** Blossom blob descriptors (`PUT /upload` → `url`, `GET /list/<pubkey>`) are built from `blossom.publicUrl`. With the default it points at `http://127.0.0.1` (no port), which is useless to any client behind the reverse proxy. Set it to the proxy's public origin either in `/etc/nutflix/gateway.json` (`"blossom": { "publicUrl": "https://cdn.example" }`) or in the unit via `Environment=NUTFLIX_GATEWAY_PUBLIC_URL=https://cdn.example` (env always wins). It is not a secret, so `Environment=` is acceptable here.
- **`http.trustProxy`.** Default `false`. Set `"http": { "trustProxy": true }` in the JSON **only when the listener is reachable solely through the reverse proxy** (loopback bind, or a firewall that admits only the proxy). With it on, the gateway takes the client address for rate-limit buckets from the LAST `X-Forwarded-For` entry — the one the proxy appends; the earlier entries are whatever the client sent (security review F14). This assumes exactly one proxy that appends (nginx `proxy_add_x_forwarded_for`; Caddy replaces the header, which also works). If anything other than the proxy can reach the port, a client can choose its own bucket by sending that header. The gateway never reads `X-Forwarded-Proto` (descriptor URLs come from `publicUrl` above).
- **Proxy requirements** (from L3): forward `/`-rooted paths unchanged (Blossom endpoints must live at the root, BUD-01); pass `Upgrade`/`Connection` for `ws.path` (default `/ws`); disable request buffering and raise the proxy body limit to ≥ `http.maxUploadBytes` for `PUT /upload`; forward `Range` untouched.
- **Paths**: state in `/var/lib/nutflix-<svc>` (`$STATE_DIRECTORY`), a runtime directory at `/run/nutflix-<svc>` (`$RUNTIME_DIRECTORY`, unused today), config in `/etc/nutflix` (`$CONFIGURATION_DIRECTORY`, read-only). The daemons should read those environment variables rather than hard-code paths.
- **Key at rest** (§7: argon2id-derived passphrase key, never env vars): both daemons use an encrypted key file under the state directory with its passphrase as a systemd credential — `seeder-key-passphrase` / `gateway-key-passphrase`. `Environment=` is deliberately not used for anything secret.
- **TLS**: the gateway binds an unprivileged port on loopback/LAN and a reverse proxy terminates TLS. The proxy is where `_headers.txt` from `scripts/csp-sri.mjs` goes.

### Gateway key file and identity

The gateway runs on the same runtime as the seeder (ADR 0011 §9): an encrypted key file, the passphrase as the credential `gateway-key-passphrase`, a NIP-44 sealed wallet, nutzaps and optional `payout`. Its config names its identity publicly (`identity.pubkey`, `identity.p2pk`: the HELLO carries them), so `--keygen` prints both, and a start whose config does not match the key file is refused (viewers would lock payment to a key the gateway cannot redeem with).

```sh
install -d -m 0700 /etc/credstore.encrypted
head -c 32 /dev/urandom | base64 -w0 \
  | systemd-creds encrypt --name=gateway-key-passphrase - /etc/credstore.encrypted/nutflix-gateway-key-passphrase
install -d -m 0700 -o nutflix-gateway -g nutflix-gateway /var/lib/nutflix-gateway
# --keygen accepts a gateway.json without identity.pubkey/p2pk (they are what it prints)
systemd-creds decrypt --name=gateway-key-passphrase /etc/credstore.encrypted/nutflix-gateway-key-passphrase - \
  | sudo -u nutflix-gateway env STATE_DIRECTORY=/var/lib/nutflix-gateway \
      node --jitless --no-experimental-websocket /opt/nutflix/packages/gateway/dist/index.js \
      --keygen --config /etc/nutflix/gateway.json
# → "key file created" … "publicKey":"…", "ownP2pk":"02…": put both into gateway.json's identity
```

New keys in `gateway.json` (same rules as the seeder's): `relays` ★ (1–8, `wss://`), `policy.creatorPubkey` ★, `identity.keyFile` (default `<dataDir>/identity.key`), `payout`, `videoEvents`.

**Upstream fetching (security review F37):** the gateway serves the blobs it holds (uploads, mirrors); nothing in it fetches from upstream seeders on its own yet. An embedder that fetches upstream must read through `Gateway.readUpstreamBlob`, which paces its requests to the seeders' unpaid window (credit settled by ACKs); a plain `core.get()` loop on a core from `Gateway.openUpstreamCore` is not paced and gets the gateway cut and banned upstream.

## Directive-by-directive

Both units share the same block; the gateway differs only in resource caps.

### Identity and filesystem

| Directive | Why |
|-----------|-----|
| `User=`/`Group=nutflix-<svc>` | §7 "dedicated user". Separate accounts per daemon so a compromised gateway cannot read seeder state. Created by `nutflix.sysusers.conf`, `nologin` shell, home set to its state directory. |
| `WorkingDirectory=/opt/nutflix` | The read-only application tree. |
| `StateDirectory=` + `StateDirectoryMode=0700` | The **only** persistent writable location: corestore, key-at-rest blob, ban list. systemd creates it, chowns it, and adds it to the read-write set under `ProtectSystem=strict`. |
| `RuntimeDirectory=` (0700) | `/run/nutflix-<svc>`; wiped on stop. Unused today: no daemon code reads `$RUNTIME_DIRECTORY` or opens a control socket. |
| `LoadCredentialEncrypted=seeder-key-passphrase:…` (seeder) | The key file's passphrase (§7 "never env vars"). PID 1 decrypts it before exec — TPM2 and/or the host key — into `$CREDENTIALS_DIRECTORY`, a private ramfs no other unit sees, so the sandbox directives below do not need to allow TPM or credstore access. A missing credential fails the start. The gateway unit has the same line for `gateway-key-passphrase`. |
| `ConfigurationDirectory=nutflix` | `/etc/nutflix` exists and is readable; it is **not** added to `ReadWritePaths`, so config stays read-only to the daemon. |
| `UMask=0077` | Anything the daemon creates (corestore files, key blobs) is private by default. Verified the process sees `077`. |
| `ProtectSystem=strict` | §7. Entire filesystem read-only except the directories systemd carved out above. A compromised process cannot modify its own code, `/etc`, or `/usr`. |
| `ProtectHome=yes` | §7. `/home`, `/root`, `/run/user` are empty/inaccessible. |
| `PrivateTmp=yes` | §7. Private `/tmp` and `/var/tmp`; no symlink races or leaks via shared tmp. |
| `PrivateDevices=yes` + `DevicePolicy=closed` | Minimal `/dev` (null, zero, random, urandom…), no physical devices. Node needs only `/dev/urandom`. |
| `ProtectProc=invisible` + `ProcSubset=pid` | Other processes are invisible in `/proc`; non-PID `/proc` files hidden. Reduces information available to an attacker inside. |
| `ProtectKernelTunables/Modules/Logs=yes`, `ProtectControlGroups=yes`, `ProtectClock=yes`, `ProtectHostname=yes` | No writes to `/proc/sys`, `/sys`, no module loading, no `dmesg`, no cgroup edits, no clock or hostname changes. All redundant with an empty capability set, kept as belt-and-braces and because `systemd-analyze security` scores them. |
| `RemoveIPC=yes` | SysV IPC / POSIX message queues owned by the user are removed on stop. |

### Privilege and syscall surface

| Directive | Why |
|-----------|-----|
| `NoNewPrivileges=yes` | §7. No setuid/setgid/fscaps escalation via `execve`, ever. Also a prerequisite for the seccomp filters to apply to unprivileged users. |
| `CapabilityBoundingSet=` + `AmbientCapabilities=` (empty) | The daemon needs no capability: unprivileged ports only, no raw sockets. An empty bounding set means even a root-in-namespace bug cannot regain them. |
| `RestrictSUIDSGID=yes` | Cannot create setuid/setgid files. |
| `LockPersonality=yes` | Locks the execution domain (`personality(2)`); blocks a historic ASLR-disable trick. |
| `RestrictRealtime=yes` | No realtime scheduling → cannot starve the host (T11). |
| `RestrictNamespaces=yes` | No user/mount/net namespaces from inside the service — closes the largest class of container-escape primitives. |
| `SystemCallArchitectures=native` | Only x86-64 syscalls; kills the 32-bit-ABI seccomp-bypass class. |
| `SystemCallFilter=@system-service` then `~@privileged @resources @obsolete @mount @reboot @swap @cpu-emulation @debug @module @raw-io` | Allowlist of what a normal service needs, minus groups a Node daemon never uses. **Verified** (test-hardening.sh) that Node 22 `--jitless` + `sodium-native` (`mlock`, `mprotect`), `udx-native`, `rocksdb-native`, `hyperdht`, `http`, `worker_threads` all run under it. `@resources` removal is safe: `mlock` lives in `@memlock`, which `@system-service` includes. |
| `SystemCallErrorNumber=EPERM` | A filtered syscall returns `EPERM` instead of `SIGSYS`-killing the process, so a stray call in a dependency surfaces as a logged error rather than a silent crash loop. |
| `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK` | §7 says the first three. **`AF_NETLINK` is added and required**: `getifaddrs(3)` (libuv `uv_interface_addresses`, called by `udx-native` → `dht-rpc` → `hyperdht` at construction) opens a `NETLINK_ROUTE` socket; without it the swarm throws `EAFNOSUPPORT` before binding. Verified both ways in `MDWE-RESULTS.md` §3. Netlink here is read-only enumeration; with an empty capability set no `NET_ADMIN` operation is possible over it. |
| `MemoryDenyWriteExecute=yes` + `ExecStart=… --jitless …` | §7 "test against the JS engine's JIT" — tested, see `MDWE-RESULTS.md`. Node 22's default JIT **aborts at startup** under MDWE; with `--jitless` V8 never creates executable memory and everything works, at a measured ~1.7× cost on the secp256k1 (DLEQ) JS path and no cost to native hashing. The pair must be changed **together**. **`--jitless` also removes WebAssembly, which Node 22's built-in `undici` needs**: both units therefore add `--no-experimental-websocket`, and the gateway loads `node:http` via `createRequire` (MDWE-RESULTS.md §6). |

### Environment (T12 supply chain at runtime)

| Directive | Why |
|-----------|-----|
| `Environment=NODE_OPTIONS=` (pinned empty) | `NODE_OPTIONS=--require …` from a poisoned host environment is the standard way to inject code into a Node service; pinning it empty in the unit makes the host environment irrelevant. |
| `UnsetEnvironment=NODE_EXTRA_CA_CERTS NODE_PATH NODE_DEBUG NODE_PENDING_DEPRECATION` | Same class: extra CA roots, module-resolution overrides, debug leakage. |
| `Environment=NODE_ENV=production` | Conventional; libraries disable dev-only diagnostics. |

### Availability (T11)

| Directive | Why |
|-----------|-----|
| `Restart=on-failure`, `RestartSec=5s` | Come back after a crash, not instantly. |
| `StartLimitIntervalSec=300`, `StartLimitBurst=5` | A crash loop stops after 5 attempts in 5 minutes instead of pegging a core. |
| `TimeoutStopSec=30s` | Enough for corestore to flush; then SIGKILL. |
| `LimitNOFILE=65536` | Many peers = many sockets; the default 1024 is too low for a seeder. |
| `LimitCORE=0` | No core dumps: a core would contain decrypted key material (T14). |
| `TasksMax=` | Caps threads + child processes (libuv pool, workers). |
| `MemoryHigh=`/`MemoryMax=` | Throttle, then OOM-kill only this unit, never the host. Size per host. |
| `CPUQuota=` | The seeder cannot take the whole box during a DoS. Size per host. |
| `StandardOutput/Error=journal` | Journald handles rotation; the application-level redaction layer (§7) sits in front of every logger so nothing secret reaches it. |

### Considered and not set (say so, rather than pretend)

- `DynamicUser=yes` — would replace the sysusers accounts and implies most of the above. Rejected for now: persistent state under `/var/lib/private` plus the operator-facing key-at-rest file is easier to reason about with a stable UID. Revisit if the operator story changes.
- `PrivateUsers=yes` — maps the service user into a private user namespace; hardens further but is known to interact badly with `StateDirectory` ownership on some systemd versions and could not be tested without a system manager here.
- `PrivateNetwork=yes` / `IPAddressDeny=` — the seeder must talk to arbitrary peers; a gateway that only ever sees a reverse proxy could add `IPAddressAllow=localhost` + `IPAddressDeny=any` for its *inbound* side, but the embedded seeder's outbound swarm traffic makes a blanket deny wrong.
- `ExecPaths=`/`NoExecPaths=` — `ProtectSystem=strict` plus MDWE already prevents executing anything written at runtime; explicit `NoExecPaths=/var/lib/nutflix-*` would be a cheap extra once state layout is fixed.

## Verifying on a real host

```sh
systemd-analyze security nutflix-seeder      # expect a low exposure score
systemd-analyze verify /etc/systemd/system/nutflix-seeder.service
journalctl -u nutflix-seeder -b              # EPERM lines here = a syscall the filter blocked
```
