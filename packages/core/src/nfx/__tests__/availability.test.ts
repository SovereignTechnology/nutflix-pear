/**
 * Pear #97: which renditions a video's live beacons say are held, by how many seeders, and the
 * order a player tries them in. Mixed holders (per-rendition iroh tickets, `webrtc` and `https`
 * lists, `hyperdht` whole videos or lists), absent = all, an `https` list empty or repeating (the beacon is
 * invalid, pear #104), the newest beacon per seeder, stale and expired beacons, other videos,
 * transports a player cannot use, and the bounds.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { describe, expect, it } from 'vitest';

import type { NfxVideo, NostrEvent } from '../../contracts/index.js';
import {
  MAX_AVAILABILITY_EVENTS,
  MAX_AVAILABILITY_RENDITIONS,
  MAX_AVAILABILITY_SEEDERS,
  availabilityVaries,
  countHolders,
  holders,
  preferRenditions,
  renditionAvailability,
} from '../availability.js';
import {
  beaconContentText,
  beaconTags,
  hyperdhtBindMessage,
  parseBeaconContent,
  type Endpoint,
} from '../beacon.js';
import { VideoAddr } from '../namespace.js';

const NS = 'nfx:testnet:1';
const NOW = 1_800_000_000;
const CREATOR_SK = generateSecretKey();
const CREATOR = getPublicKey(CREATOR_SK);
const D = `${NS}:held-video`;
const VIDEO = { id: `38504:${CREATOR}:${D}`, author: CREATOR } as Pick<NfxVideo, 'id' | 'author'>;

const ticket = (c: string): string => `blob${c.repeat(60)}`;
const iroh = (node: string, ids: readonly string[], meta = true): Endpoint => ({
  t: 'iroh',
  node: node.repeat(64).slice(0, 64),
  relay: '',
  addrs: [],
  tickets: new Map([
    ...(meta ? ([['meta', ticket('m')]] as const) : []),
    ...ids.map((id) => [id, ticket(id.charAt(0))] as const),
  ]),
});
const https = (renditions?: readonly string[]): Endpoint => ({
  t: 'https',
  url: 'https://origin.example/nfx',
  ...(renditions === undefined ? {} : { renditions }),
});
const webrtc = (renditions: readonly string[]): Endpoint => ({
  t: 'webrtc',
  trackerUrls: ['wss://tracker.example'],
  renditions,
});
/**
 * NFX-12 §2: a HyperDHT peer key bound to the seeder `sk` on this network (the bind verifies),
 * serving `renditions` (absent: every rendition).
 */
function hyperdht(sk: Uint8Array, renditions?: readonly string[]): Endpoint {
  const peerSk = ed25519.utils.randomSecretKey();
  const peer = bytesToHex(ed25519.getPublicKey(peerSk));
  const msg = new TextEncoder().encode(hyperdhtBindMessage(getPublicKey(sk), NS));
  const bind = bytesToHex(ed25519.sign(msg, peerSk));
  return renditions === undefined
    ? { t: 'hyperdht', peer, bind }
    : { t: 'hyperdht', peer, bind, renditions };
}

function beacon(
  endpoints: readonly Endpoint[],
  o: {
    readonly sk?: Uint8Array;
    readonly at?: number;
    readonly ttl?: number;
    readonly d?: string;
    readonly creator?: string;
    readonly free?: boolean;
  } = {},
): NostrEvent {
  const at = o.at ?? NOW - 10;
  const d = o.d ?? D;
  const addr = VideoAddr.parse(d);
  const tags = beaconTags(`38504:${o.creator ?? CREATOR}:${d}`, at, o.ttl ?? 120);
  if (!addr.ok || !tags.ok) throw new Error('bad test beacon');
  const free = o.free ?? true;
  const content = beaconContentText({
    v: 1,
    video: addr.value,
    endpoints,
    skipped: [],
    chunks: 'all',
    priceHint: free ? 0n : 1n,
    acceptsMints: free ? [] : ['https://mint.example'],
    free,
  });
  return finalizeEvent(
    { kind: 20464, created_at: at, tags: tags.value, content },
    o.sk ?? generateSecretKey(),
  ) as unknown as NostrEvent;
}

/** Beacon content naming `endpoints`, given as raw JSON (what a wire may carry, not what we write). */
const rawContent = (endpoints: string): string =>
  `{"v":1,"video":"${D}","endpoints":[${endpoints}],"chunks":"all","price_hint":0,"free":true}`;
const rawHttps = (renditions?: string): string =>
  `{"t":"https","url":"https://origin.example/nfx"${renditions === undefined ? '' : `,"renditions":${renditions}`}}`;
const rawWebrtc = (renditions?: string): string =>
  `{"t":"webrtc","tracker_urls":["wss://tracker.example"]${renditions === undefined ? '' : `,"renditions":${renditions}`}}`;
/** An iroh endpoint holding 720p (and `meta`), as raw JSON. */
const RAW_IROH = `{"t":"iroh","node":"${'a'.repeat(64)}","relay":"","addrs":[],"tickets":{"720p":"${ticket('7')}","meta":"${ticket('m')}"}}`;

/** A free beacon for VIDEO whose content is `rawContent(endpoints)`, signed by `sk` at `at`. */
function rawBeacon(endpoints: string, sk = generateSecretKey(), at = NOW - 10): NostrEvent {
  const tags = beaconTags(`38504:${CREATOR}:${D}`, at, 120);
  if (!tags.ok) throw new Error('bad test beacon');
  const content = rawContent(endpoints);
  return finalizeEvent(
    { kind: 20464, created_at: at, tags: tags.value, content },
    sk,
  ) as unknown as NostrEvent;
}

const named = (a: ReturnType<typeof renditionAvailability>): Record<string, number> =>
  Object.fromEntries([...a.named].sort(([x], [y]) => x.localeCompare(y)));

describe('beacon `https` endpoints: optional renditions (pear #97, nfx `--renditions`)', () => {
  it('parses a list, keeps it on the way out, and treats a missing one as absent', () => {
    const text = `{"v":1,"video":"${D}","endpoints":[{"t":"https","url":"https://o.example","renditions":["720p","360p"]},{"t":"https","url":"https://p.example"}],"chunks":"all","price_hint":0,"free":true}`;
    const parsed = parseBeaconContent(text, 'a'.repeat(64));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.endpoints).toEqual([
      { t: 'https', url: 'https://o.example', renditions: ['720p', '360p'] },
      { t: 'https', url: 'https://p.example' },
    ]);
    expect(beaconContentText(parsed.value)).toBe(text);
  });

  it('refuses a list that is not one of rendition ids, as for `webrtc`', () => {
    for (const bad of ['"720p"', '[""]', '["meta"]', '[7]', '{}', 'null']) {
      const text = `{"v":1,"video":"${D}","endpoints":[{"t":"https","url":"https://o.example","renditions":${bad}}],"chunks":"all","price_hint":0,"free":true}`;
      expect(parseBeaconContent(text, 'a'.repeat(64)).ok, bad).toBe(false);
    }
  });

  it('pear #104: refuses an empty list and a repeated id, whatever else the beacon names', () => {
    // NFX-03 §4: present, a non-empty list of distinct ids. nfx's `beacon-renditions.json` has
    // `renditions-empty` (beside an iroh endpoint, as here) and `renditions-repeated` invalid whole.
    for (const bad of ['[]', '["720p","720p"]', '["720p","360p","720p"]']) {
      for (const endpoints of [rawHttps(bad), `${RAW_IROH},${rawHttps(bad)}`]) {
        const parsed = parseBeaconContent(rawContent(endpoints), 'a'.repeat(64));
        expect(parsed.ok, endpoints).toBe(false);
        if (!parsed.ok) expect(parsed.error.reason).toMatch(/^https `renditions` must /);
      }
    }
    // The same beacon with its iroh endpoint alone is fine.
    expect(parseBeaconContent(rawContent(RAW_IROH), 'a'.repeat(64)).ok).toBe(true);
  });
});

describe('beacon `hyperdht` endpoints: optional renditions (NFX-12 §2, NFX-18)', () => {
  const sk = generateSecretKey();
  const seeder = getPublicKey(sk);
  const raw = (e: Endpoint, renditions?: string): string => {
    if (e.t !== 'hyperdht') throw new Error('not hyperdht');
    return `{"t":"hyperdht","peer":"${e.peer}","bind":"${e.bind}"${renditions === undefined ? '' : `,"renditions":${renditions}`}}`;
  };

  it('parses a list after `bind`, keeps it on the way out, and treats a missing one as absent', () => {
    const one = hyperdht(sk, ['720p']);
    const all = hyperdht(sk);
    const text = rawContent(`${raw(one, '["720p"]')},${raw(all)}`);
    const parsed = parseBeaconContent(text, seeder);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.endpoints).toEqual([one, all]);
    expect(beaconContentText(parsed.value)).toBe(text);
  });

  it('refuses a list that is not one of distinct rendition ids, whatever else the beacon names', () => {
    const e = hyperdht(sk);
    for (const bad of [
      '"720p"',
      '[""]',
      '["meta"]',
      '[7]',
      '{}',
      'null',
      '[]',
      '["720p","720p"]',
    ]) {
      for (const endpoints of [raw(e, bad), `${RAW_IROH},${raw(e, bad)}`]) {
        expect(parseBeaconContent(rawContent(endpoints), seeder).ok, endpoints).toBe(false);
      }
    }
    const repeated = parseBeaconContent(rawContent(raw(e, '["720p","720p"]')), seeder);
    if (!repeated.ok) expect(repeated.error.reason).toMatch(/^hyperdht `renditions` must /);
  });
});

describe('beacon `webrtc` endpoints: a present but empty list (pear #104)', () => {
  it('reads it as absent, every rendition, as nfx-proto does (NFX-10 §2 is silent)', () => {
    for (const endpoints of [rawWebrtc('[]'), rawWebrtc()]) {
      const parsed = parseBeaconContent(rawContent(endpoints), 'a'.repeat(64));
      expect(parsed.ok, endpoints).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.endpoints).toEqual([
        { t: 'webrtc', trackerUrls: ['wss://tracker.example'], renditions: [] },
      ]);
    }
  });
});

describe('renditionAvailability', () => {
  it('counts mixed holders: iroh tickets, lists, and endpoints that hold everything', () => {
    const a = renditionAvailability(
      VIDEO,
      [
        beacon([iroh('a', ['720p'])]),
        beacon([iroh('b', ['720p', '1080p'])]),
        beacon([https()]),
        beacon([webrtc(['360p'])]),
        beacon([https(['480p']), webrtc(['360p'])]),
      ],
      NOW,
    );
    expect(a.seeders).toBe(5);
    expect(a.all).toBe(1);
    expect(named(a)).toEqual({ '1080p': 1, '360p': 2, '480p': 1, '720p': 2 });
    expect(holders(a, '720p')).toBe(3);
    expect(holders(a, '1080p')).toBe(2);
    expect(holders(a, '2160p')).toBe(1);
    expect(availabilityVaries(a)).toBe(true);
  });

  it('a `hyperdht` seeder with no list holds every rendition', () => {
    const sk = generateSecretKey();
    const a = renditionAvailability(
      VIDEO,
      [beacon([hyperdht(sk), iroh('a', ['720p'])], { sk }), beacon([iroh('b', ['360p'])])],
      NOW,
    );
    expect(a).toEqual({ seeders: 2, all: 1, named: new Map([['360p', 1]]) });
    // A player that does not speak HyperDHT sees the same seeder through its iroh tickets only.
    const irohOnly = renditionAvailability(
      VIDEO,
      [beacon([hyperdht(sk), iroh('a', ['720p'])], { sk })],
      NOW,
      { transports: ['iroh'] },
    );
    expect(named(irohOnly)).toEqual({ '720p': 1 });
  });

  it('a `hyperdht` seeder that names renditions holds those only (NFX-18 keeps some)', () => {
    const sk = generateSecretKey();
    const a = renditionAvailability(
      VIDEO,
      [beacon([hyperdht(sk, ['720p'])], { sk }), beacon([hyperdht(generateSecretKey())])],
      NOW,
    );
    // The second beacon's bind is for another seeder: invalid whole, not counted.
    expect(a).toEqual({ seeders: 1, all: 0, named: new Map([['720p', 1]]) });
    const sk2 = generateSecretKey();
    const b = renditionAvailability(
      VIDEO,
      [
        beacon([hyperdht(sk, ['720p']), iroh('a', ['360p'])], { sk }),
        beacon([hyperdht(sk2)], { sk: sk2 }),
      ],
      NOW,
    );
    expect(b.all).toBe(1);
    expect(named(b)).toEqual({ '360p': 1, '720p': 1 });
    expect(holders(b, '720p')).toBe(2);
    expect(holders(b, '1080p')).toBe(1);
  });

  it('absent means every rendition; a `webrtc` list present but empty too, as nfx-proto reads it', () => {
    const a = renditionAvailability(
      VIDEO,
      [beacon([https()]), rawBeacon(rawWebrtc()), rawBeacon(rawWebrtc('[]'))],
      NOW,
    );
    expect(a).toEqual({ seeders: 3, all: 3, named: new Map() });
    expect(availabilityVaries(a)).toBe(false);
    // A seeder whose endpoints mix "all" and a list holds everything.
    const mixed = renditionAvailability(VIDEO, [beacon([iroh('a', ['720p']), https()])], NOW);
    expect(mixed).toEqual({ seeders: 1, all: 1, named: new Map() });
  });

  it('non-empty `https` and `webrtc` lists hold the renditions they name', () => {
    const a = renditionAvailability(
      VIDEO,
      [rawBeacon(rawHttps('["720p","360p"]')), rawBeacon(rawWebrtc('["360p"]'))],
      NOW,
    );
    expect(a).toEqual({
      seeders: 2,
      all: 0,
      named: new Map([
        ['720p', 1],
        ['360p', 2],
      ]),
    });
  });

  it('pear #104: an `https` list empty or repeating holds nothing, nor does the rest of its beacon', () => {
    const none = { seeders: 0, all: 0, named: new Map() };
    for (const bad of ['[]', '["720p","720p"]']) {
      // Its only endpoint: that seeder is no holder (never one holding every rendition).
      expect(renditionAvailability(VIDEO, [rawBeacon(rawHttps(bad))], NOW), bad).toEqual(none);
      // Beside an iroh endpoint that holds 720p: NFX-03 §4 rejects the beacon whole.
      const beside = rawBeacon(`${RAW_IROH},${rawHttps(bad)}`);
      expect(renditionAvailability(VIDEO, [beside], NOW), bad).toEqual(none);
    }
    expect(named(renditionAvailability(VIDEO, [rawBeacon(RAW_IROH)], NOW))).toEqual({ '720p': 1 });
    // Other seeders still count; and an invalid beacon withdraws nothing, so the seeder's newest
    // valid one does.
    const sk = generateSecretKey();
    const a = renditionAvailability(
      VIDEO,
      [
        beacon([https(['360p'])], { sk, at: NOW - 70 }),
        rawBeacon(rawHttps('[]'), sk, NOW - 10),
        beacon([https(['1080p'])]),
      ],
      NOW,
    );
    expect(a).toEqual({
      seeders: 2,
      all: 0,
      named: new Map([
        ['1080p', 1],
        ['360p', 1],
      ]),
    });
  });

  it('an iroh endpoint without a `meta` ticket holds nothing; nor does one with no rendition', () => {
    const a = renditionAvailability(
      VIDEO,
      [beacon([iroh('a', ['720p'], false)]), beacon([iroh('b', [])])],
      NOW,
    );
    expect(a).toEqual({ seeders: 0, all: 0, named: new Map() });
  });

  it("only each seeder's newest valid beacon counts", () => {
    const sk = generateSecretKey();
    const a = renditionAvailability(
      VIDEO,
      [
        beacon([iroh('a', ['1080p'])], { sk, at: NOW - 70 }),
        beacon([iroh('a', ['720p'])], { sk, at: NOW - 10 }),
      ],
      NOW,
    );
    expect(named(a)).toEqual({ '720p': 1 });
    // The newest one stopped holding anything: the seeder withdrew, it is not counted.
    const withdrew = renditionAvailability(
      VIDEO,
      [
        beacon([iroh('a', ['720p'])], { sk, at: NOW - 70 }),
        beacon([iroh('a', [], false)], { sk, at: NOW - 10 }),
      ],
      NOW,
    );
    expect(withdrew.seeders).toBe(0);
  });

  it('expired, stale and future beacons do not count', () => {
    const a = renditionAvailability(
      VIDEO,
      [
        beacon([iroh('a', ['720p'])], { at: NOW - 121 }), // expired (TTL 120)
        beacon([iroh('b', ['720p'])], { at: NOW - 3600, ttl: 120 }), // long gone
        beacon([iroh('c', ['720p'])], { at: NOW + 20 * 60 }), // 20 min ahead: clock skew
        beacon([iroh('d', ['360p'])], { at: NOW - 60 }),
      ],
      NOW,
    );
    expect(a.seeders).toBe(1);
    expect(named(a)).toEqual({ '360p': 1 });
  });

  it('other videos, other creators and paying seeders do not count', () => {
    const a = renditionAvailability(
      VIDEO,
      [
        beacon([https()], { d: `${NS}:other-video` }),
        beacon([https()], { creator: 'e'.repeat(64) }),
        beacon([https()], { free: false }),
        { ...beacon([https()]), sig: '0'.repeat(128) },
      ],
      NOW,
    );
    expect(a.seeders).toBe(0);
  });

  it('counts only the transports and endpoints the player can use', () => {
    const events = [beacon([iroh('a', ['720p'])]), beacon([webrtc(['360p'])]), beacon([https()])];
    expect(
      named(renditionAvailability(VIDEO, events, NOW, { transports: ['https', 'webrtc'] })),
    ).toEqual({ '360p': 1 });
    const noOrigins = renditionAvailability(VIDEO, events, NOW, {
      usable: (e) => e.t !== 'https',
    });
    expect(noOrigins).toMatchObject({ seeders: 2, all: 0 });
  });

  it('is bounded: seeders, named ids, id length and the events read', () => {
    const many = Array.from({ length: MAX_AVAILABILITY_SEEDERS + 6 }, () => beacon([https()]));
    expect(renditionAvailability(VIDEO, many, NOW).seeders).toBe(MAX_AVAILABILITY_SEEDERS);

    const ids = Array.from({ length: MAX_AVAILABILITY_RENDITIONS + 8 }, (_, i) => `r${String(i)}`);
    const wide = renditionAvailability(VIDEO, [beacon([webrtc(ids)])], NOW);
    expect(wide.named.size).toBe(MAX_AVAILABILITY_RENDITIONS);
    expect(holders(wide, `r${String(MAX_AVAILABILITY_RENDITIONS + 7)}`)).toBe(0);

    const long = renditionAvailability(VIDEO, [beacon([webrtc(['x'.repeat(65), '720p'])])], NOW);
    expect(named(long)).toEqual({ '720p': 1 });

    // Only the newest MAX_AVAILABILITY_EVENTS events are read: older ones are never parsed.
    const base = beacon([https()], { at: NOW - 5 });
    const junk = Array.from({ length: MAX_AVAILABILITY_EVENTS }, (_, i) => ({
      ...base,
      sig: i.toString(16).padStart(128, '0'),
    }));
    const old = beacon([https()], { at: NOW - 30 });
    expect(renditionAvailability(VIDEO, [...junk, old], NOW).seeders).toBe(0);
    expect(renditionAvailability(VIDEO, [old], NOW).seeders).toBe(1);
  });
});

describe('countHolders and preferRenditions', () => {
  const R = [
    { id: '1080p', bandwidth: 5_400_000 },
    { id: '720p', bandwidth: 2_800_000 },
    { id: '480p', bandwidth: 1_400_000 },
    { id: '360p', bandwidth: 950_000 },
  ];

  it('counts per seeder, ignoring seeders that hold nothing and ids that are not ids', () => {
    expect(countHolders(['all', ['720p', '720p', 'meta', ''], [], ['360p']])).toEqual({
      seeders: 3,
      all: 1,
      named: new Map([
        ['720p', 1],
        ['360p', 1],
      ]),
    });
  });

  it('never offers a rendition nobody holds; the most-held first, then the higher bandwidth', () => {
    const held = countHolders([['720p'], ['720p', '360p'], ['1080p'], ['360p']]);
    expect(preferRenditions(R, held).map((r) => r.id)).toEqual(['720p', '360p', '1080p']);
    // Everyone holds everything: the bandwidth decides.
    expect(preferRenditions(R, countHolders(['all', 'all'])).map((r) => r.id)).toEqual([
      '1080p',
      '720p',
      '480p',
      '360p',
    ]);
    expect(preferRenditions(R, countHolders([]))).toEqual([]);
  });

  it('within the bandwidth first (most-held), then the held ones above it, lowest first', () => {
    const held = countHolders([['1080p'], ['1080p'], ['1080p'], ['480p'], ['360p'], ['720p']]);
    expect(preferRenditions(R, held, { maxBandwidth: 2_000_000 }).map((r) => r.id)).toEqual([
      '480p',
      '360p',
      '720p',
      '1080p',
    ]);
    expect(preferRenditions(R, held).map((r) => r.id)).toEqual(['1080p', '720p', '480p', '360p']);
    expect(
      preferRenditions(R, countHolders([['1080p']]), { maxBandwidth: 1 }).map((r) => r.id),
    ).toEqual(['1080p']);
  });
});
