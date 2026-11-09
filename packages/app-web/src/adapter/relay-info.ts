/**
 * The page's NIP-11 request (ADR 0022): what core's `RelaySearchSupport` asks to learn whether a
 * relay answers NIP-50 search, so `search` goes only to relays that list it and stock relays are
 * matched in the page instead. Only the viewer's own relays are asked (the read relays and the
 * network's scoped relays), the hosts the page already holds WebSockets to. One GET with
 * `Accept: application/nostr+json` (a CORS-safelisted header: no preflight), at most
 * `NIP11_MAX_BYTES`, a whole-request timeout; nothing is logged.
 */
import type { RelayInfoFetch } from '@sovit/core/nostr';

import { type FetchFn, getBounded } from './http.js';

/** The most a NIP-11 document may be (a real one is a few hundred bytes). */
export const NIP11_MAX_BYTES = 64 * 1024;
/** First byte to last, ms. */
export const NIP11_TIMEOUT_MS = 5_000;

/** `RelayInfoFetch` over the page's `fetch`: resolves to the parsed document, rejects otherwise. */
export function browserRelayInfoFetch(
  fetchFn: FetchFn,
  o: { readonly timeoutMs?: number; readonly maxBytes?: number } = {},
): RelayInfoFetch {
  return async (url) => {
    if (!/^https?:\/\//.test(url)) throw new Error('NIP-11: not http(s)');
    const bytes = await getBounded(fetchFn, url, {
      maxBytes: o.maxBytes ?? NIP11_MAX_BYTES,
      timeoutMs: o.timeoutMs ?? NIP11_TIMEOUT_MS,
      accept: 'application/nostr+json',
    });
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  };
}
