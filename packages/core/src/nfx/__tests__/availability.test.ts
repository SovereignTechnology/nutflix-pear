/**
 * Pear #97: which renditions a video's live beacons say are held, by how many seeders, and the
 * order a player tries them in. Mixed holders (per-rendition iroh tickets, `webrtc` and `https`
 * lists, `hyperdht` whole videos), absent = all, the newest beacon per seeder, stale and expired
 * beacons, other videos, transports a player cannot use, and the bounds.
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
/** NFX-12 §2: a HyperDHT peer key bound to the seeder `sk` on this network (the bind verifies). */
function hyperdht(sk: Uint8Array): Endpoint {
  const peerSk = ed25519.utils.randomSecretKey();
  const peer = bytesToHex(ed25519.getPublicKey(peerSk));
  const msg = new TextEncoder().encode(hyperdhtBindMessage(getPublicKey(sk), NS));
  return { t: 'hyperdht', peer, bind: bytesToHex(ed25519.sign(msg, peerSk)) };
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
    for (const bad of ['"720p"', '[""]', '["meta"]', '[7]', '{}']) {
      const text = `{"v":1,"video":"${D}","endpoints":[{"t":"https","url":"https://o.example","renditions":${bad}}],"chunks":"all","price_hint":0,"free":true}`;
      expect(parseBeaconContent(text, 'a'.repeat(64)).ok, bad).toBe(false);
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

  it('a `hyperdht` seeder holds every rendition (NFX-12 serves whole videos)', () => {
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

  it('absent or empty means every rendition', () => {
    const a = renditionAvailability(
      VIDEO,
      [beacon([https()]), beacon([https([])]), beacon([webrtc([])])],
      NOW,
    );
    expect(a).toEqual({ seeders: 3, all: 3, named: new Map() });
    expect(availabilityVaries(a)).toBe(false);
    // A seeder whose endpoints mix "all" and a list holds everything.
    const mixed = renditionAvailability(VIDEO, [beacon([iroh('a', ['720p']), https()])], NOW);
    expect(mixed).toEqual({ seeders: 1, all: 1, named: new Map() });
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
