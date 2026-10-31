/**
 * This implementation's NFX address for a video it publishes both ways (ADR 0020 Phase 1): a
 * legacy NIP-71 event and its NFX copy. Not part of any NFX spec; another implementation's video
 * ids are its own.
 *
 * Here so the worker, which packages and stores the video under it, and the host, which checks the
 * stored video is the one it published before announcing it, share one derivation. Each process
 * bundles `@sovit/core`, but neither may bundle the other's code.
 */
import { fail, type NfxResult } from './errors.js';
import { type Namespace, VideoAddr } from './namespace.js';

/** Prefix of the video ids derived here (`nutflix-<32 hex>`, 40 characters). */
export const LEGACY_VIDEO_ID_PREFIX = 'nutflix-';

/**
 * `<namespace>:nutflix-<first 32 hex of the legacy event id>`. Deterministic: the same legacy
 * video always maps to the same address, and its manifest links back to the legacy event with
 * `["e", …]`. Inside NFX-02's `[a-z0-9][a-z0-9-]{6,62}`. 128 bits of the id keep two of a node's
 * videos from colliding.
 */
export function legacyVideoAddr(namespace: Namespace, legacyEventId: string): NfxResult<VideoAddr> {
  if (!/^[0-9a-f]{64}$/.test(legacyEventId)) {
    return fail('video-id', 'a legacy event id is 64 lowercase hex');
  }
  return VideoAddr.of(namespace, `${LEGACY_VIDEO_ID_PREFIX}${legacyEventId.slice(0, 32)}`);
}
