/**
 * Beacon endpoint filtering (ADR 0022 items 3 and 5): which origins and trackers from seeders'
 * beacons a play may use, what each origin serves (pear #97: absent all, empty none, several claims
 * intersected), and how they merge with the client's own. Beacons are really signed.
 */
import { describe, expect, it } from 'vitest';

import type { NfxVideo, TrackerUrl } from '@sovit/core';

import { Key, NS, T, addrOf, beacon, https, webrtc } from '../../__tests__/support/nfx.js';
import { WEB_FALLBACK_ORIGIN, WEB_TRACKER } from '../../settings/defaults.js';
import {
  MAX_BEACON_ORIGINS,
  MAX_CLAIMED_RENDITIONS,
  beaconEndpoints,
  beaconOrigin,
  beaconTracker,
  narrowClaim,
  originClaim,
  playEndpoints,
} from '../endpoints.js';
import { isPublicHost } from '../hosts.js';

const creator = new Key();
const VIDEO = 'free-video-1';
const video = {
  id: addrOf(creator, VIDEO),
  author: creator.pubkey,
} as unknown as Pick<NfxVideo, 'id' | 'author'>;

describe('beaconOrigin: https only, no query, fragment or credentials, a public host', () => {
  it.each([
    ['https://cdn.example/o', 'https://cdn.example/o'],
    ['https://cdn.example/o/', 'https://cdn.example/o'],
    ['https://cdn.example', 'https://cdn.example'],
    ['https://CDN.Example:8443/a/b//', 'https://cdn.example:8443/a/b'],
    ['https://cdn.example:443/o', 'https://cdn.example/o'],
    ['https://93.184.215.14/o', 'https://93.184.215.14/o'],
  ])('%s → %s', (raw, base) => {
    expect(beaconOrigin(raw)).toBe(base);
  });

  it.each([
    ['http://cdn.example/o', 'not https'],
    ['wss://cdn.example/o', 'not https'],
    ['https://cdn.example/o?x=1', 'a query'],
    ['https://cdn.example/o?', 'an empty query'],
    ['https://cdn.example/o#x', 'a fragment'],
    ['https://cdn.example/o#', 'an empty fragment'],
    ['https://user:pw@cdn.example/o', 'credentials'],
    ['https://@cdn.example/o', 'an empty user-info'],
    ['https://evil.example\\@cdn.example/o', 'a backslash'],
    ['https://cdn.exa\tmple/o', 'a tab the parser would drop'],
    ['https://localhost/o', 'localhost'],
    ['https://127.0.0.1/o', 'loopback'],
    ['https://0x7f.1/o', 'loopback, spelt in hex'],
    ['https://2130706433/o', 'loopback, as one number'],
    ['https://192.168.1.1/o', 'a LAN address'],
    ['https://10.0.0.8/o', 'a private address'],
    ['https://100.100.12.34/o', 'CGNAT'],
    ['https://169.254.169.254/o', 'link-local (cloud metadata)'],
    ['https://[::1]/o', 'IPv6 loopback'],
    ['https://[fd00::1]/o', 'IPv6 unique-local'],
    ['https://[::ffff:127.0.0.1]/o', 'IPv4-mapped loopback'],
    ['https://router/o', 'a single label'],
    ['https://nas.local/o', 'mDNS'],
    ['https://printer.home.arpa/o', 'home.arpa'],
    [`https://cdn.example/${'a'.repeat(600)}`, 'too long'],
    ['not a url', 'not a URL'],
  ])('%s is refused (%s)', (raw) => {
    expect(beaconOrigin(raw)).toBeNull();
  });
});

describe('beaconTracker: wss only, a public host, in the player’s form', () => {
  it.each([
    ['wss://tracker.example', 'wss://tracker.example'],
    ['wss://tracker.example/', 'wss://tracker.example'],
    ['wss://Tracker.Example:8443/announce', 'wss://tracker.example:8443/announce'],
  ])('%s → %s', (raw, t) => {
    expect(beaconTracker(raw)).toBe(t);
  });

  it.each([
    'ws://tracker.example/announce',
    'ws://127.0.0.1:8000/announce',
    'ws://localhost/announce',
    'https://tracker.example/announce',
    'wss://tracker.example/announce?info_hash=x',
    'wss://tracker.example/announce#x',
    'wss://u:p@tracker.example/announce',
    'wss://127.0.0.1/announce',
    'wss://192.168.0.2/announce',
    'wss://tracker/announce',
  ])('%s is refused', (raw) => {
    expect(beaconTracker(raw)).toBeNull();
  });
});

describe('isPublicHost', () => {
  it.each(['cdn.example', 'xn--bcher-kva.example', '93.184.215.14', '[2606:4700::6810:84e5]'])(
    '%s is public',
    (h) => {
      expect(isPublicHost(h)).toBe(true);
    },
  );
  it.each([
    '',
    'localhost',
    'a.localhost',
    'box.internal',
    'pc.lan',
    'host',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '198.18.0.1',
    '[::]',
    '[fe80::1]',
    '[ff02::1]',
    '[2001:db8::1]',
    '[64:ff9b::7f00:1]',
    '[2002:7f00:1::]',
    '[::1',
  ])('%s is not', (h) => {
    expect(isPublicHost(h)).toBe(false);
  });
});

describe('beaconEndpoints: free beacons for this address only, newest per seeder', () => {
  it('takes https origins and wss trackers, drops the rest, ranks by how many seeders name each', () => {
    const s1 = new Key();
    const s2 = new Key();
    const events = [
      beacon(s1, video.id, [
        https('https://a.example/o'),
        https('https://b.example/o?steer=1'),
        webrtc('wss://t1.example/announce', 'ws://t2.example/announce', 'wss://127.0.0.1/x'),
        { t: 'iroh', node: 'a'.repeat(64), relay: '', addrs: [], tickets: {} },
      ]),
      beacon(s2, video.id, [
        https('https://c.example/o'),
        https('https://a.example/o/'),
        webrtc('wss://t3.example/announce', 'wss://t1.example/announce'),
      ]),
    ];
    const found = beaconEndpoints(video, events, T);
    expect(found).toEqual({
      origins: [{ url: 'https://a.example/o' }, { url: 'https://c.example/o' }],
      trackers: ['wss://t1.example/announce', 'wss://t3.example/announce'],
      seeders: 2,
      reachable: 2,
    });
  });

  it('at most 4 of each from one beacon and 8 origins in all', () => {
    const many = (k: number, n: number): ReturnType<typeof https>[] =>
      Array.from({ length: n }, (_, i) => https(`https://o${String(k)}-${String(i)}.example/o`));
    const trackers = Array.from({ length: 6 }, (_, i) => `wss://t${String(i)}.example/a`);
    const events = [0, 1, 2].map((k) =>
      beacon(new Key(), video.id, [...many(k, 6), webrtc(...trackers)]),
    );
    const found = beaconEndpoints(video, events, T);
    expect(found.origins).toHaveLength(MAX_BEACON_ORIGINS);
    expect(found.trackers).toEqual(trackers.slice(0, 4));
    // The first four of each beacon: twelve in all, eight kept.
    expect(found.origins.every((o) => /o[0-2]-[0-3]\./.test(o.url))).toBe(true);
  });

  it('a paid beacon, another creator’s video of the same id, another video: none counts', () => {
    const other = new Key();
    const events = [
      beacon(new Key(), video.id, [https('https://paid.example/o')], { free: false }),
      beacon(new Key(), addrOf(other, VIDEO), [https('https://other-creator.example/o')]),
      beacon(new Key(), addrOf(creator, 'another-video'), [https('https://other.example/o')]),
    ];
    expect(beaconEndpoints(video, events, T)).toEqual({
      origins: [],
      trackers: [],
      seeders: 0,
      reachable: 0,
    });
  });

  it('a beacon whose content names another video than its `a` tag is invalid', () => {
    const ev = beacon(new Key(), video.id, [https('https://x.example/o')], {
      videoId: `${NS}:another-video`,
    });
    expect(beaconEndpoints(video, [ev], T).seeders).toBe(0);
  });

  it('only a seeder’s newest beacon counts: it can withdraw an endpoint', () => {
    const s = new Key();
    const events = [
      beacon(s, video.id, [https('https://old.example/o')], { createdAt: T - 30 }),
      beacon(s, video.id, [https('https://new.example/o')], { createdAt: T - 5 }),
    ];
    expect(beaconEndpoints(video, events, T).origins).toEqual([{ url: 'https://new.example/o' }]);
  });

  it('expired, tampered and unsigned beacons are dropped', () => {
    const s = new Key();
    const expired = beacon(s, video.id, [https('https://expired.example/o')], {
      createdAt: T - 200,
    });
    const good = beacon(new Key(), video.id, [https('https://good.example/o')]);
    const tampered = { ...good, content: good.content.replace('good.example', 'evil.example') };
    expect(beaconEndpoints(video, [expired, tampered], T).seeders).toBe(0);
  });

  it('a seeder naming nothing usable here still counts as a seeder, not as reachable', () => {
    const ev = beacon(new Key(), video.id, [
      https('https://127.0.0.1/o'),
      webrtc('ws://t.example/a'),
    ]);
    expect(beaconEndpoints(video, [ev], T)).toMatchObject({ seeders: 1, reachable: 0 });
  });
});

describe('what an origin serves (pear #97, nfx’s `originSources`)', () => {
  const held = (url: string, renditions: readonly string[]): Readonly<Record<string, unknown>> => ({
    ...https(url),
    renditions,
  });

  it('absent is every rendition, a list those, an empty list none', () => {
    const events = [
      beacon(new Key(), video.id, [https('https://all.example/o')]),
      beacon(new Key(), video.id, [held('https://some.example/o', ['360p', '720p'])]),
      beacon(new Key(), video.id, [held('https://none.example/o', [])]),
    ];
    expect(beaconEndpoints(video, events, T).origins).toEqual([
      { url: 'https://all.example/o' },
      { url: 'https://some.example/o', renditions: ['360p', '720p'] },
      { url: 'https://none.example/o', renditions: [] },
    ]);
  });

  it('several seeders naming one origin: only what every one of them says it serves', () => {
    const events = [
      beacon(new Key(), video.id, [held('https://o.example/o', ['360p', '720p', '1080p'])]),
      beacon(new Key(), video.id, [held('https://o.example/o/', ['720p', '360p'])]),
      // A claim of every rendition narrows nothing.
      beacon(new Key(), video.id, [https('https://o.example/o')]),
      beacon(new Key(), video.id, [https('https://wide.example/o')]),
      beacon(new Key(), video.id, [held('https://wide.example/o', ['480p'])]),
    ];
    expect(beaconEndpoints(video, events, T).origins).toEqual([
      { url: 'https://o.example/o', renditions: ['360p', '720p'] },
      { url: 'https://wide.example/o', renditions: ['480p'] },
    ]);
    // Claims that share nothing leave nothing: the player skips that origin.
    const disjoint = [
      beacon(new Key(), video.id, [held('https://o.example/o', ['360p'])]),
      beacon(new Key(), video.id, [held('https://o.example/o', ['720p'])]),
    ];
    expect(beaconEndpoints(video, disjoint, T).origins).toEqual([
      { url: 'https://o.example/o', renditions: [] },
    ]);
  });

  it('one beacon naming an origin twice narrows it as well, and counts it once', () => {
    const events = [
      beacon(new Key(), video.id, [
        held('https://o.example/o', ['360p', '720p']),
        held('https://o.example/o/', ['720p']),
        https('https://p.example/o'),
        https('https://p.example/o'),
      ]),
      beacon(new Key(), video.id, [https('https://p.example/o')]),
    ];
    expect(beaconEndpoints(video, events, T).origins).toEqual([
      { url: 'https://p.example/o' },
      { url: 'https://o.example/o', renditions: ['720p'] },
    ]);
  });

  it('an origin serving nothing makes no seeder reachable, but still narrows the others’ claims', () => {
    const empty = beacon(new Key(), video.id, [held('https://o.example/o', [])]);
    expect(beaconEndpoints(video, [empty], T)).toMatchObject({ seeders: 1, reachable: 0 });
    const other = beacon(new Key(), video.id, [https('https://o.example/o')]);
    expect(beaconEndpoints(video, [empty, other], T)).toMatchObject({
      origins: [{ url: 'https://o.example/o', renditions: [] }],
      seeders: 2,
      reachable: 1,
    });
  });

  it('originClaim: ids of at most 64 characters, each once, the first 32; narrowClaim intersects', () => {
    expect(originClaim(undefined)).toBeNull();
    expect(originClaim([])).toEqual([]);
    expect(originClaim(['720p', '720p', 'x'.repeat(65), '360p'])).toEqual(['720p', '360p']);
    const many = Array.from({ length: 40 }, (_, i) => `r${String(i)}`);
    expect(originClaim(many)).toEqual(many.slice(0, MAX_CLAIMED_RENDITIONS));
    expect(narrowClaim(null, null)).toBeNull();
    expect(narrowClaim(null, ['a'])).toEqual(['a']);
    expect(narrowClaim(['a', 'b'], null)).toEqual(['a', 'b']);
    expect(narrowClaim(['a', 'b', 'c'], ['c', 'a'])).toEqual(['a', 'c']);
    expect(narrowClaim(['a'], [])).toEqual([]);
  });
});

describe('playEndpoints: beacons’ origins then the fallback; configured trackers then beacons’, 4 in all', () => {
  it('orders, dedupes and caps', () => {
    const configured = [WEB_TRACKER, 'ws://127.0.0.1:8000/announce' as TrackerUrl];
    const got = playEndpoints(
      {
        origins: [
          { url: 'https://a.example/o' },
          { url: WEB_FALLBACK_ORIGIN },
          { url: 'https://b.example/o', renditions: ['360p'] },
        ],
        trackers: [
          'wss://t1.example/a' as TrackerUrl,
          WEB_TRACKER,
          'wss://t2.example/a' as TrackerUrl,
          'wss://t3.example/a' as TrackerUrl,
        ],
      },
      configured,
      WEB_FALLBACK_ORIGIN,
    );
    expect(got).toEqual({
      origins: [
        { url: 'https://a.example/o' },
        { url: WEB_FALLBACK_ORIGIN },
        { url: 'https://b.example/o', renditions: ['360p'] },
      ],
      trackers: [
        WEB_TRACKER,
        'ws://127.0.0.1:8000/announce',
        'wss://t1.example/a',
        'wss://t2.example/a',
      ],
    });
  });

  it('with no beacon endpoints: the fallback origin and the configured trackers', () => {
    expect(
      playEndpoints({ origins: [], trackers: [] }, [WEB_TRACKER], WEB_FALLBACK_ORIGIN),
    ).toEqual({
      origins: [{ url: WEB_FALLBACK_ORIGIN }],
      trackers: [WEB_TRACKER],
    });
  });

  it('the fallback origin serves every rendition, unless a beacon says what it serves', () => {
    const fromBeacon = playEndpoints(
      {
        origins: [
          { url: 'https://a.example/o', renditions: ['720p'] },
          { url: WEB_FALLBACK_ORIGIN, renditions: ['360p'] },
        ],
        trackers: [],
      },
      [],
      WEB_FALLBACK_ORIGIN,
    );
    expect(fromBeacon.origins).toEqual([
      { url: 'https://a.example/o', renditions: ['720p'] },
      { url: WEB_FALLBACK_ORIGIN, renditions: ['360p'] },
    ]);
    // End to end: a seeder of 360p only, naming the fallback origin.
    const events = [
      beacon(new Key(), video.id, [{ ...https(`${WEB_FALLBACK_ORIGIN}/`), renditions: ['360p'] }]),
    ];
    expect(
      playEndpoints(beaconEndpoints(video, events, T), [], WEB_FALLBACK_ORIGIN).origins,
    ).toEqual([{ url: WEB_FALLBACK_ORIGIN, renditions: ['360p'] }]);
  });
});
