# Real-mint tests

Opt-in integration tests against real Cashu mints (security review F6 and §0a).
They never run in plain `npm test` — CI stays offline — and nothing real moves: both mints use a
FakeWallet Lightning backend on loopback.

| Script | Mint | Default port |
|---|---|---|
| `nutshell.sh` | Nutshell 0.21.0 (Python reference) | 3399 (second instance: 3398) |
| `cdk-mintd.sh` | cdk-mintd 0.18.1 (Rust) | 3397 |

Both run with a real 100 ppk input fee and v2 keyset ids — the conditions that exposed F34 (dust)
and that the in-process `TestMint` does not reproduce by default.

```sh
# once: NUTSHELL_VENV (see nutshell.sh), CDK_MINTD_BIN (see cdk-mintd.sh)
NUTSHELL_VENV=/path/to/venv scripts/real-mint/nutshell.sh start 3399
NUTSHELL_VENV=/path/to/venv scripts/real-mint/nutshell.sh start 3398   # external invoices for the melt test
CDK_MINTD_BIN=/path/to/cdk-mintd MNEMONIC_PYTHON=$NUTSHELL_VENV/bin/python scripts/real-mint/cdk-mintd.sh start 3397

for m in 3399 3397; do
  NUTFLIX_REAL_MINT_URL=http://127.0.0.1:$m NUTFLIX_REAL_MINT_URL_2=http://127.0.0.1:3398 \
    npx vitest run packages/core/src/__tests__/real-mint.integration.test.ts \
                   packages/gateway/src/__tests__/real-mint-swarm.integration.test.ts
done
```

Six more suites read `NUTFLIX_REAL_MINT_URL`: the wallet journal and NUT-13 suites in
`packages/core/src/wallet/__tests__/`, the recovery, top-up and owed suites in
`packages/app-desktop/src/host/__tests__/`, and
`packages/seeder/src/__tests__/owed.integration.test.ts`.

What they cover: the `pay1` NUT-10 tag (accepted, lock still enforced); DLEQ on real signatures;
the whole pay/1 money path with real fees; three seeders and a viewer over real replication; a
creator set re-used at another seeder (refused by the binding); a replayed PAY (double-spend,
ban); a replay after a restart (banned at the mint); a network drop mid-PAY; melt of an external
invoice. Results are recorded in `docs/security-review.md` §0a.
