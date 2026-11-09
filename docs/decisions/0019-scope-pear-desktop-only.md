# 19. Scope: Pear/desktop only; the web portal is out

Date: 2026-10-02

## Status

Accepted. Amends ADR 0002 and ADR 0003, which describe a web portal as part of the design.
Scope amended by [ADR 0020](0020-speak-nfx.md) (the app speaks NFX). The web-portal ruling is
reversed in part by [ADR 0022](0022-a-web-client-for-nfx.md) (2026-11-09): an NFX-only web client
lives in `packages/app-web`. The portal described here, with Hypercore in the page and a gateway,
stays out.

## Context

The early plans (ADR 0002, the build plan) described two shells over one protocol library: a
desktop app and a static web portal that would talk to a gateway over WebSockets and run Hypercore
in the page. Only the desktop half was ever built. The web lane (L7) never started, and
`packages/app-web` is an empty scaffold.

In parallel, the sibling repository [nfx](https://github.com/SovereignTechnology/nfx) took on the
multi-network design: a standardised protocol suite over iroh, content-addressed segments and a
broader reach (its ADRs 0006 and 0008). That left this repository as the JavaScript implementation
on the Hypercore stack: a working demonstration of pay-per-block video, which is what shipped as
desktop 0.1.0.

## Decision

**This repository is Pear/desktop only.** It ships the Electron desktop app, and keeps the seeder
and gateway daemons as the building blocks the app embeds and that an operator can run. The web
portal is out of scope here: build-plan Phase 5 and lane L7 are not built. A browser shell, if one
is wanted, belongs to nfx.

`packages/app-web` stays in the workspace as a labelled placeholder rather than being deleted in
the same change, because the TypeScript project references and a few tests enumerate it.

## Consequences

- ADR 0002's web shell and ADR 0003's browser-Hypercore result (spike A8) stand as research, but
  nothing is built on them.
- Threat T13 (malicious portal JavaScript) and invariant 8 in `SECURITY.md` describe a browser shell.
  They are kept for a future one and annotated as not applicable to 0.1.0. *(2026-11-09, ADR 0022:
  both apply again, to the NFX web client.)*
- The web-only tooling (`scripts/reproducible-web-build.sh`, `scripts/csp-sri.mjs`) has no shipping
  target in this repository. *(2026-11-09, ADR 0022: the NFX web client is one.)*
- Numbers 0006 and 0008 are used by the nfx repository and are not used here. This is why the
  sequence skips them.
- Follow-up, not done by this decision: delete `packages/app-web` and the web-only tooling. That is
  a code change that also touches the TypeScript references and the tests that enumerate packages.
  *(Withdrawn 2026-11-09 by ADR 0022: `packages/app-web` holds the NFX web client.)*
