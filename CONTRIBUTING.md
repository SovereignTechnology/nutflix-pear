# Contributing to Nutflix

Thanks for taking an interest. Nutflix is experimental (see the
[known limitations](README.md#known-limitations)), so the most useful contributions today are bug
reports with steps to reproduce, fixes that come with a test, and corrections to the docs.

## Ground rules

- By contributing you agree your work is licensed under **AGPL-3.0-or-later**, the same licence as
  the project. There is no CLA and copyright stays with you.
- Be civil. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Never commit secrets: API tokens, private keys, `.env` files, credentials of any kind.
  `.gitignore` blocks the common cases, but it is not a safety net you should rely on.
- Do not report a vulnerability in a public issue. See [SECURITY.md](SECURITY.md).

## Where things happen

Issues and pull requests are on GitHub. The canonical copy of the repository is on Nostr (NIP-34),
and the maintainer syncs `main` to it, so you do not need ngit to contribute.

## Set up

You need Node 22.18 or newer on Linux. `package.json` declares 22.12, but the build scripts run
TypeScript files directly, which needs 22.18.

```sh
git clone https://github.com/SovereignTechnology/nutflix-pear.git
cd nutflix-pear
npm ci --ignore-scripts       # .npmrc turns lifecycle scripts off and pins exact versions
npm run build
npm test
```

To run the app itself, see [Run from source](README.md#run-from-source).

| Command                 | What it does                                                           |
| ----------------------- | ---------------------------------------------------------------------- |
| `npm run lint`          | ESLint and Prettier (Markdown is not checked)                           |
| `npm run typecheck`     | `tsc -b`                                                                |
| `npm test`              | The unit and integration suites (run `npm run build` first)             |
| `npm run check:locked`  | The audit-surface rules below                                           |
| `npm run check:contracts` | Fails if the contracts changed without a `CONTRACTS_VERSION` bump     |
| `npm run check:native`  | Compares the installed native modules with `docs/native-modules.txt`    |
| `npm run lint:electron` | The Electron security lint                                              |
| `npm run ci`            | Lint, build, test, `check:locked`, `check:native` and `lint:electron`   |

`npm run ci` leaves out `check:contracts`, the lockfile and advisory gates, the Electron end-to-end
suite and the packaging check. **GitHub Actions runs all of them on every pull request and is the
authoritative result.** Two things to know when you run tests yourself:

- Run `npm run build` before `npm test`. Without it, two suites that need the built worker are
  skipped silently; set `NUTFLIX_REQUIRE_BUILT=1` to make them fail instead.
- A few suites start a local DHT testnet on loopback and fail in containers without it, or when run
  as root.

The Electron end-to-end suite (`npm run -w packages/app-desktop test:e2e`) needs Electron's binary,
a Chromium sandbox that can start, `ffmpeg`, and a display (CI wraps it in `xvfb-run -a`). The
README's [Run from source](README.md#run-from-source) explains the first two.

`npm run hooks:install` installs an optional pre-commit hook. It runs `check:locked` when your
staged files touch the audit surface. (It also has a path allowlist for the maintainers' parallel
workflow; that only applies when a `.lane` file exists, so you can ignore it.)

## Making a change

1. Open an issue first for anything non-trivial, so design discussion happens before the code.
2. Branch off `main` with a descriptive name: `feat/media-indexer`, `fix/thumbnail-race`,
   `docs/readme-setup`.
3. Keep commits focused and the history readable. Rebase rather than merge `main` into your branch.
4. Open a pull request against `main`. Explain *why*, not just *what*; the diff shows what.
5. CI must pass. The maintainer merges with a merge commit titled `merge: <branch> — <what it does>`.

## The rules for sensitive code

- **Locked directories.** The code that handles money, keys and the `pay/1` wire format is the audit
  surface (listed in [SECURITY.md](SECURITY.md#locked-directories)). Nothing there logs, and it
  imports only the audited libraries; `npm run check:locked` fails otherwise. Write the failing
  test first, and keep the diff small. Do not implement a cryptographic primitive.
- **Contracts.** `packages/core/src/contracts/` is the frozen interface surface. A change there
  must bump `CONTRACTS_VERSION` and should come with an ADR.
- **Dependencies.** Versions are pinned exactly, installs use `npm ci --ignore-scripts`, and CI
  checks registry signatures and advisories. A new dependency needs a reason in the pull request.
  A new or changed native module also changes `docs/native-modules.txt`, which is reviewed by hand
  (`scripts/native-module-inventory.sh --check`, then `--accept` once reviewed).

## Architecture decisions

Anything that constrains the project long-term (language, framework, datastore, protocol) gets a
short record in `docs/decisions/NNNN-title.md` with a Status, the Context, the Decision and the
Consequences, as in [ADR 0001](docs/decisions/0001-record-architecture-decisions.md). The next
number is **0022**. Numbers 0006 and 0008 belong to the sibling nfx repository and are not used
here. Never renumber or rename an ADR: code comments cite them by number. To change an accepted
decision, add a dated amendment and say so in its Status line, or write a new ADR that supersedes it.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <short imperative summary>

<optional body explaining motivation and context>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `chore`.

Subject line: imperative mood, no trailing full stop, ideally under 72 characters. Commits do not
carry `Co-Authored-By` trailers or tool-attribution lines.

## How this project is built

Much of the code, the tests and the documentation here was written with AI assistance: AI coding
agents working under the maintainer's direction. The security review was done by internal,
AI-assisted sessions, not by an independent auditor. You may use AI help for a contribution on the
same terms as anyone else: you are responsible for what you submit, it must pass CI, and it must
follow the rules above. This paragraph is the disclosure; individual commits carry no attribution.
