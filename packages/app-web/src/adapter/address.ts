/**
 * NFX addresses as this client takes them from a link, a screen or a relay: canonical (NFX-02 §2,
 * core's `parseATag`, written back the same) and on the one network this build speaks.
 */
import type { NfxAddress } from '@sovit/core';
import { parseATag } from '@sovit/core/nfx';

import { WEB_NFX_NETWORK } from '../settings/defaults.js';

/** `addr`, when it is a canonical NFX address on this client's network; `null` otherwise. */
export function canonicalNfxAddress(addr: unknown): NfxAddress | null {
  if (typeof addr !== 'string' || addr.length > 512) return null;
  const parsed = parseATag(addr);
  if (!parsed.ok) return null;
  const { creator, addr: video } = parsed.value;
  if (video.namespace.toString() !== WEB_NFX_NETWORK) return null;
  return `38504:${creator}:${video.toString()}` === addr ? (addr as NfxAddress) : null;
}
