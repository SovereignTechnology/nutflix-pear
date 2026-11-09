/**
 * The page's hash ⇄ the shell's route: links to a video (`#/watch/<addr>`, and `?a=<addr>`), a
 * channel, a search and Settings; anything else, or anything the page does not offer, is Home.
 */
import { describe, expect, it } from 'vitest';

import type { NostrEventId, NostrPubkey } from '@sovit/core';
import type { Route } from '@sovit/ui';

import { hashOf, routeFromLocation } from '../routes.js';

const PK = 'ab'.repeat(32);
const ADDR = `38504:${PK}:nfx:testnet:1:free-video-1`;
const at = (hash: string, search = ''): Route => routeFromLocation({ hash, search });

describe('routeFromLocation', () => {
  it.each([
    ['', { name: 'home' }],
    ['#', { name: 'home' }],
    ['#/', { name: 'home' }],
    [`#/watch/${ADDR}`, { name: 'watch', videoId: ADDR }],
    [`#/watch/${encodeURIComponent(ADDR)}`, { name: 'watch', videoId: ADDR }],
    [`#/channel/${PK}`, { name: 'channel', pubkey: PK }],
    ['#/search/orbits%20of%20jupiter', { name: 'search', q: 'orbits of jupiter' }],
    ['#/settings', { name: 'settings' }],
  ])('%s', (hash, route) => {
    expect(at(hash)).toEqual(route);
  });

  it('`?a=<addr>` when the hash names nothing', () => {
    expect(at('', `?a=${encodeURIComponent(ADDR)}`)).toEqual({ name: 'watch', videoId: ADDR });
    expect(at('#/', `?a=${ADDR}`)).toEqual({ name: 'watch', videoId: ADDR });
    expect(at('#/settings', `?a=${ADDR}`)).toEqual({ name: 'settings' });
  });

  it.each([
    ['#/wallet', 'a screen the page does not offer'],
    ['#/studio', 'a screen the page does not offer'],
    ['#/shorts', 'a screen the page does not offer'],
    [`#/watch/${'ee'.repeat(32)}`, 'a NIP-71 event id (no Hypercore here)'],
    [`#/watch/38504:${PK}:nfx:mainnet:1:v`, 'another network'],
    [`#/watch/38504:${PK.toUpperCase()}:nfx:testnet:1:v`, 'a non-canonical address'],
    [`#/watch/${ADDR}%`, 'a bad escape'],
    ['#/channel/alice', 'not a pubkey'],
    ['#/search/%20%20', 'an empty search'],
    [`#/watch/${'x'.repeat(3000)}`, 'too long'],
    ['#/watch/', 'nothing'],
  ])('%s is Home (%s)', (hash) => {
    expect(at(hash)).toEqual({ name: 'home' });
  });

  it('a bad `?a=` is Home', () => {
    expect(at('', '?a=38504:nope')).toEqual({ name: 'home' });
    expect(at('', `?a=${'x'.repeat(3000)}`)).toEqual({ name: 'home' });
  });
});

describe('hashOf', () => {
  it('round-trips every route the page links to', () => {
    for (const r of [
      { name: 'home' },
      { name: 'watch', videoId: ADDR },
      { name: 'channel', pubkey: PK as NostrPubkey },
      { name: 'search', q: 'orbits of jupiter & co' },
      { name: 'settings' },
    ] as Route[]) {
      const hash = hashOf(r);
      expect(at(hash), hash).toEqual(r);
    }
    expect(hashOf({ name: 'watch', videoId: ADDR as never })).toBe(`#/watch/${ADDR}`);
  });

  it('a route the page does not link to is Home', () => {
    for (const r of [
      { name: 'wallet' },
      { name: 'library' },
      { name: 'studio' },
      { name: 'shorts' },
      { name: 'home', tab: 'network' },
      { name: 'watch', videoId: 'ee'.repeat(32) as NostrEventId },
      { name: 'search', q: '  ' },
    ] as Route[]) {
      expect(hashOf(r)).toBe('#/');
    }
  });
});
