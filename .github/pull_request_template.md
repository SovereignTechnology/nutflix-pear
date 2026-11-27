## What and why

<!-- The diff shows what changed. Say why. -->

## Checklist

- [ ] CI is green (`verify`, `iroh-helper`, `rust-advisories`, `rust-forward`, `test`, `e2e`, `package`).
- [ ] Behaviour changes come with a test (write the failing test first in the locked directories).
- [ ] If this touches the locked directories (see SECURITY.md): nothing logs, and imports stay on the allow-list (`npm run check:locked`).
- [ ] If this touches `packages/core/src/contracts/`: `CONTRACTS_VERSION` is bumped and an ADR explains why.
- [ ] If this adds or changes a dependency or native module: the reason is above, and `docs/native-modules.txt` is updated.
- [ ] Docs are updated where behaviour or setup changed.
- [ ] No secrets, keys, tokens or personal data in the diff.
