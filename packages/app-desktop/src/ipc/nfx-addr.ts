/**
 * The NFX address this app gives a free video it publishes both ways (ADR 0020 Phase 1). The
 * worker packages and stores the video under it; the host checks the stored video is the one it
 * published and announces its manifest (kind 38504). One function, so the two cannot derive
 * different addresses.
 *
 * Host and worker only: it loads `@sovit/core`, which the preload and renderer bundles refuse
 * (`scripts/bundle.ts`).
 */
import { nfx } from '@sovit/core';

/**
 * The one NFX network this build packages for, until Settings choose one (slice 5). NFX-01:
 * `nfx:<network>:<specver>`.
 */
export const NFX_DEFAULT_NAMESPACE = 'nfx:testnet:1' as const;

/** Prefix of the video ids this app derives (`nutflix-<32 hex>`, 40 characters). */
const VIDEO_ID_PREFIX = 'nutflix-';

/**
 * The NFX address of the video a legacy NIP-71 event published: `<namespace>:nutflix-<first 32
 * hex of the event id>`. Deterministic (the same legacy video always maps to the same address;
 * its manifest links back to the legacy event with `["e", …]`), and inside NFX-02's
 * `[a-z0-9][a-z0-9-]{6,62}`. 128 bits of the id keep two of this node's videos from colliding.
 */
export function nfxVideoAddrFor(
  legacyEventId: string,
  namespace: string = NFX_DEFAULT_NAMESPACE,
): nfx.VideoAddr {
  if (!/^[0-9a-f]{64}$/.test(legacyEventId)) {
    throw new TypeError('nfx: a legacy event id is 64 lowercase hex');
  }
  const ns = nfx.Namespace.parse(namespace);
  if (!ns.ok) throw new TypeError('nfx: not an NFX-01 namespace');
  const addr = nfx.VideoAddr.of(ns.value, `${VIDEO_ID_PREFIX}${legacyEventId.slice(0, 32)}`);
  if (!addr.ok) throw new TypeError('nfx: the derived video id is invalid');
  return addr.value;
}
