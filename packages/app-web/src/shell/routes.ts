/**
 * The page's address ⇄ the shell's route (ADR 0022). `@sovit/ui`'s router keeps its own history in
 * memory; the page mirrors the route it shows into the URL's hash, so a video can be linked to and
 * a reload lands where it was:
 *
 * | Hash | Route |
 * |---|---|
 * | `#/` (or none) | Home |
 * | `#/watch/<NFX address>` | an NFX video (also `?a=<NFX address>`, the test player's form) |
 * | `#/channel/<pubkey>` | a channel |
 * | `#/search/<text>` | a search |
 * | `#/settings` | Settings |
 *
 * Anything else, and a watch address that is not a canonical NFX address on this client's network,
 * is Home: the page never opens a screen it does not offer from a link.
 */
import type { NostrPubkey } from '@sovit/core';
import type { Route } from '@sovit/ui';

import { canonicalNfxAddress } from '../adapter/address.js';

const HOME: Route = Object.freeze({ name: 'home' });
/** A link longer than this is not read. */
export const MAX_LINK = 2048;

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** The route `location` (its `hash`, then `?a=`) names. */
export function routeFromLocation(loc: { readonly hash: string; readonly search: string }): Route {
  if (loc.hash.length > MAX_LINK || loc.search.length > MAX_LINK) return HOME;
  const path = loc.hash.startsWith('#') ? loc.hash.slice(1) : loc.hash;
  if (path === '' || path === '/') {
    const a = new URLSearchParams(loc.search).get('a');
    const addr = a === null ? null : canonicalNfxAddress(a);
    return addr === null ? HOME : { name: 'watch', videoId: addr };
  }
  const m = /^\/(watch|channel|search)\/(.+)$/.exec(path);
  if (m === null) return path === '/settings' ? { name: 'settings' } : HOME;
  const value = decode(m[2] ?? '');
  if (value === null) return HOME;
  if (m[1] === 'watch') {
    const addr = canonicalNfxAddress(value);
    return addr === null ? HOME : { name: 'watch', videoId: addr };
  }
  if (m[1] === 'channel') {
    return /^[0-9a-f]{64}$/.test(value) ? { name: 'channel', pubkey: value as NostrPubkey } : HOME;
  }
  const q = value.trim();
  return q === '' ? HOME : { name: 'search', q };
}

/** NFX addresses are `[a-z0-9:._-]`; anything else is percent-encoded. */
function encode(s: string): string {
  return /^[A-Za-z0-9:._~-]+$/.test(s) ? s : encodeURIComponent(s);
}

/** The hash that names `route` (Home for a route the page does not link to). */
export function hashOf(route: Route): string {
  if (route.name === 'watch') {
    return route.videoId.startsWith('38504:') ? `#/watch/${encode(route.videoId)}` : '#/';
  }
  if (route.name === 'channel') return `#/channel/${route.pubkey}`;
  if (route.name === 'search') {
    return route.q.trim() === '' ? '#/' : `#/search/${encodeURIComponent(route.q)}`;
  }
  return route.name === 'settings' ? '#/settings' : '#/';
}
