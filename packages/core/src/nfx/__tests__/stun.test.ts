/**
 * NFX-10 §1 ("the creator's, or the fallback", nfx ADR 0107): which STUN servers a client uses.
 * Its own come first, then those the video's creator names in its own beacons: global unicast,
 * port 1024 or above, 4 in all. No other key's server, however many keys name it.
 * `vectors.test.ts` runs nfx's `stun-select.json`; these are the edges around it. The addresses
 * below are never contacted: everything here is a pure function.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';

import type { NfxVideo, NostrEvent, NostrPubkey } from '../../contracts/index.js';
import { MAX_AVAILABILITY_EVENTS, MAX_AVAILABILITY_SEEDERS } from '../availability.js';
import { beaconContentText, beaconTags, type Endpoint } from '../beacon.js';
import { VideoAddr } from '../namespace.js';
import {
  MAX_STUN_CLAIMS,
  MIN_STUN_PORT,
  beaconStunClaims,
  creatorStunServers,
  isAskableStunAddr,
  isGlobalStunAddr,
  selectStunServers,
  stunClaimsOfBeacon,
  stunServerKey,
  type StunClaim,
} from '../stun.js';

const claim = (key: string, addr: string): StunClaim => ({ key, addr });
// Global unicast addresses in canonical form.
const A = '185.147.157.180:3478';
const B = '8.8.8.8:3478';
const C = '[2a01:4f8::1]:3478';
const D = '1.1.1.1:3478';
const E = '9.9.9.9:3478';
const F = '1.2.3.4:19302';
/** A server of the user's own, as Settings holds one (a name). */
const OWN = 'relay.nutflix.xyz:3478';

describe('isGlobalStunAddr', () => {
  it('takes a canonical ip:port at a global unicast address', () => {
    for (const a of [
      A,
      B,
      C,
      '1.2.3.4:1',
      '223.255.255.255:65535',
      // Just outside the blocks refused below.
      '100.63.255.255:3478',
      '100.128.0.0:3478',
      '172.15.255.255:3478',
      '172.32.0.0:3478',
      '192.0.1.255:3478',
      '198.17.255.255:3478',
      '198.20.0.0:3478',
      '[2001:4860::8888]:3478',
      '[3fef:ffff::1]:3478',
      // Only 3fff::/20 is documentation (RFC 9637); the rest of 3ff0::/12 is global unicast.
      '[3ff0::1]:3478',
      '[3fff:1000::1]:3478',
      '[3fff:ffff::1]:3478',
      '[2001:db9::1]:3478',
    ])
      expect(isGlobalStunAddr(a), a).toBe(true);
  });

  it('refuses every class that is not global unicast, and anything not canonical', () => {
    const refused: Record<string, readonly string[]> = {
      private: ['10.0.0.1:3478', '172.16.0.1:3478', '172.31.255.255:3478', '192.168.1.1:3478'],
      loopback: ['127.0.0.1:3478', '127.255.0.1:3478', '[::1]:3478'],
      'link-local': ['169.254.169.254:80', '[fe80::1]:3478', '[febf::1]:3478'],
      'CGNAT 100.64/10': ['100.64.0.1:3478', '100.127.255.255:3478'],
      'ULA fc00::/7': ['[fc00::1]:3478', '[fd12:3456::1]:3478'],
      multicast: ['224.0.0.1:3478', '239.255.255.250:1900', '[ff02::1]:3478'],
      unspecified: ['0.0.0.0:3478', '[::]:3478'],
      '"this network"': ['0.1.2.3:3478'],
      documentation: [
        '192.0.2.1:3478',
        '198.51.100.7:3478',
        '203.0.113.10:3478',
        '[2001:db8::1]:3478',
        '[3fff::1]:3478',
        '[3fff:fff::1]:3478',
      ],
      'benchmarking, IETF': ['198.18.0.1:3478', '198.19.255.255:3478', '192.0.0.8:3478'],
      'reserved, broadcast': ['240.0.0.1:3478', '255.255.255.255:3478', '[4000::1]:3478'],
      'IPv4 inside IPv6': [
        '[::ffff:a00:1]:3478',
        '[::ffff:7f00:1]:3478',
        '[::ffff:808:808]:3478',
        '[::ffff:8.8.8.8]:3478',
        '[::a00:1]:3478',
      ],
      'not canonical': [
        '185.147.157.018:3478',
        '[2A01:4F8::1]:3478',
        '[2a01:4f8:0:0:0:0:0:1]:3478',
        '1.2.3.4:03478',
        '1.2.3.4:0',
        '1.2.3.4:65536',
        '1.2.3.4',
      ],
      'a name or a URL': [
        'stun.example:3478',
        'localhost:3478',
        'stun:1.2.3.4:3478',
        '[2a01:4f8::1%eth0]:3478',
        '',
      ],
    };
    for (const [why, list] of Object.entries(refused))
      for (const a of list) expect(isGlobalStunAddr(a), `${why}: ${a}`).toBe(false);
  });
});

describe('STUN address boundaries', () => {
  it.each([
    ['[1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]:3478', false],
    ['[2000::]:3478', true],
    ['[3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff]:3478', false],
    ['[3fff:1000::]:3478', true],
    ['[3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]:3478', true],
    ['[4000::]:3478', false],
  ])('classifies %s at the global-unicast and documentation boundaries', (addr, allowed) => {
    expect(isGlobalStunAddr(addr)).toBe(allowed);
  });
});

describe('stunServerKey', () => {
  it('compares hosts case-blind, IPv6 in RFC 5952 form, ports without leading zeros', () => {
    expect(stunServerKey('WEB.Nutflix.XYZ:3478')).toBe('web.nutflix.xyz:3478');
    expect(stunServerKey('[2A01:04F8:0:0::1]:3478')).toBe(C);
    expect(stunServerKey('1.2.3.4:03478')).toBe('1.2.3.4:3478');
    for (const a of [A, B, C, D]) expect(stunServerKey(a)).toBe(a);
  });
});

describe('isAskableStunAddr: global unicast, on port 1024 or above', () => {
  it('takes a global address on a port from MIN_STUN_PORT up', () => {
    expect(MIN_STUN_PORT).toBe(1024);
    for (const a of [A, C, F, '1.1.1.1:1024', '1.1.1.1:65535'])
      expect(isAskableStunAddr(a)).toBe(true);
  });

  it('refuses a well-known port, and whatever isGlobalStunAddr refuses', () => {
    for (const a of ['1.1.1.1:53', '1.1.1.1:123', '1.1.1.1:1023', '[2a01:4f8::1]:443', '1.1.1.1:0'])
      expect(isAskableStunAddr(a), a).toBe(false);
    for (const a of ['10.0.0.1:3478', '192.0.2.1:3478', 'stun.example:3478', OWN])
      expect(isAskableStunAddr(a), a).toBe(false);
  });
});

describe('selectStunServers (NFX-10 §1, the creator’s)', () => {
  const pick = (
    own: readonly string[],
    creator: readonly string[],
    max?: number,
  ): readonly string[] => {
    const s = selectStunServers(own, creator, max);
    return [...s.own, ...s.named];
  };

  it('nothing of its own and nothing named: none', () => {
    expect(selectStunServers([], [])).toEqual({ own: [], named: [] });
  });

  it('its own servers as given, each once, at most 4, on any port', () => {
    expect(pick([OWN, A], [])).toEqual([OWN, A]);
    expect(pick([OWN, 'RELAY.nutflix.xyz:3478', C, '[2A01:4F8::1]:3478'], [])).toEqual([OWN, C]);
    expect(pick([A, B, C, D, E], [])).toEqual([A, B, C, D]);
    expect(pick(['9.9.9.9:53'], [])).toEqual(['9.9.9.9:53']);
  });

  it('its own first, then the creator’s in the order heard, each once, never dropping its own', () => {
    expect(selectStunServers([OWN], [D, E, D])).toEqual({ own: [OWN], named: [D, E] });
    expect(selectStunServers([OWN, A, B], [D, E])).toEqual({ own: [OWN, A, B], named: [D] });
    expect(selectStunServers([OWN, A, B, C], [D, E])).toEqual({ own: [OWN, A, B, C], named: [] });
  });

  it('takes the creator’s alone when the client has none of its own', () => {
    expect(pick([], [A])).toEqual([A]);
  });

  it('never takes an address that is not askable, nor a name', () => {
    const bad = [
      '10.0.0.1:3478',
      '127.0.0.1:3478',
      '[fd00::1]:3478',
      '203.0.113.1:3478',
      '1.1.1.1:53',
    ];
    expect(pick([], bad)).toEqual([]);
    expect(pick([], [...bad, A])).toEqual([A]);
    expect(pick([], ['stun.example:3478'])).toEqual([]);
  });

  it('dedupes the creator’s against its own, by normalized host:port', () => {
    expect(selectStunServers(['[2A01:4F8:0::1]:3478'], [C, A])).toEqual({
      own: ['[2A01:4F8:0::1]:3478'],
      named: [A],
    });
  });

  it('takes at most 4 in all, and at most `max` when it is lower', () => {
    const six = [A, B, C, D, E, F];
    expect(pick([OWN], six)).toEqual([OWN, A, B, C]);
    expect(pick([], six)).toEqual([A, B, C, D]);
    expect(pick([OWN], six, 2)).toEqual([OWN, A]);
    expect(pick([OWN], six, 99)).toHaveLength(4);
    expect(pick([OWN], six, 0)).toEqual([]);
  });

  it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'selects nothing for an invalid capacity %s',
    (max) => {
      expect(selectStunServers([OWN], [A], max)).toEqual({ own: [], named: [] });
    },
  );

  it('distinguishes ports on the same host while deduping configured spellings', () => {
    const otherPort = '185.147.157.180:19302';
    expect(selectStunServers(['185.147.157.180:03478', A], [A, otherPort])).toEqual({
      own: ['185.147.157.180:03478'],
      named: [otherPort],
    });
  });

  it('accepts a one-shot iterable and leaves caller-owned inputs unchanged', () => {
    const own = Object.freeze([OWN]);
    const creator = Object.freeze([B]);
    expect(selectStunServers(own, creator.values())).toEqual({ own: [OWN], named: [B] });
    expect(own).toEqual([OWN]);
    expect(creator).toEqual([B]);
  });

  it(`reads at most ${String(MAX_STUN_CLAIMS)} named servers`, () => {
    const junk = Array.from({ length: MAX_STUN_CLAIMS }, () => '10.0.0.1:3478');
    expect(pick([], [...junk, A])).toEqual([]);
    expect(pick([], [...junk.slice(1), A])).toEqual([A]);
  });
});

describe('beaconStunClaims: the servers live beacons name, by their seeders', () => {
  const NS = 'nfx:testnet:1';
  const NOW = 1_800_000_000;
  const CREATOR_SK = generateSecretKey();
  const CREATOR = getPublicKey(CREATOR_SK);
  const DTAG = `${NS}:stun-video`;
  const VIDEO = { id: `38504:${CREATOR}:${DTAG}`, author: CREATOR } as Pick<
    NfxVideo,
    'id' | 'author'
  >;
  const stun = (...addrs: string[]): Endpoint => ({ t: 'stun', addrs });

  function beacon(
    endpoints: readonly Endpoint[],
    o: {
      readonly sk?: Uint8Array;
      readonly at?: number;
      readonly d?: string;
      readonly free?: boolean;
    } = {},
  ): NostrEvent {
    const at = o.at ?? NOW - 10;
    const d = o.d ?? DTAG;
    const addr = VideoAddr.parse(d);
    const tags = beaconTags(`38504:${CREATOR}:${d}`, at, 120);
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

  it('names each server once per beacon, by its signer, the global ones only, at most 4', () => {
    const sk = generateSecretKey();
    const ev = beacon([stun('10.0.0.1:3478', A, B), stun(B, C, D, E)], { sk });
    expect(beaconStunClaims(VIDEO, [ev], NOW)).toEqual(
      [A, B, C, D].map((a) => claim(getPublicKey(sk), a)),
    );
  });

  it("counts each seeder's newest beacon only, for this video, free, live", () => {
    const one = generateSecretKey();
    const two = generateSecretKey();
    const events = [
      // Seeder one withdrew A in its newer beacon.
      beacon([stun(A)], { sk: one, at: NOW - 60 }),
      beacon([stun(B)], { sk: one, at: NOW - 5 }),
      beacon([stun(B)], { sk: two }),
      // Another video, a paid beacon, an expired one: none count.
      beacon([stun(C)], { d: `${NS}:other-video` }),
      beacon([stun(C)], { free: false }),
      beacon([stun(C)], { at: NOW - 600 }),
    ];
    const claims = beaconStunClaims(VIDEO, events, NOW);
    expect(claims).toEqual([claim(getPublicKey(one), B), claim(getPublicKey(two), B)]);
    // Two keys name B, and neither is the creator: none of it is used routinely.
    expect(creatorStunServers(VIDEO, events, NOW)).toEqual([]);
  });

  it("creatorStunServers: only the creator's own beacon, however many other keys name a server", () => {
    const strangers = [1, 2, 3].map(() => beacon([stun(A)]));
    const own = beacon([stun(B, '1.1.1.1:53', C)], { sk: CREATOR_SK, at: NOW - 1 });
    const events = [...strangers, own];
    expect(beaconStunClaims(VIDEO, events, NOW).filter((c) => c.addr === A)).toHaveLength(3);
    // The creator's servers in the order heard; the port check is the selection's.
    expect(creatorStunServers(VIDEO, events, NOW)).toEqual([B, '1.1.1.1:53', C]);
    expect(selectStunServers([OWN], creatorStunServers(VIDEO, events, NOW))).toEqual({
      own: [OWN],
      named: [B, C],
    });
    // A creator's beacon for another video names nothing for this one.
    const elsewhere = beacon([stun(D)], { sk: CREATOR_SK, d: `${NS}:other-video` });
    expect(creatorStunServers(VIDEO, [...strangers, elsewhere], NOW)).toEqual([]);
  });

  it('withdraws an older claim when the newest beacon has no STUN endpoint or is paid', () => {
    const sk = generateSecretKey();
    const old = beacon([stun(A)], { sk, at: NOW - 60 });
    const https: Endpoint = { t: 'https', url: 'https://origin.example/nfx' };
    for (const latest of [
      beacon([https], { sk, at: NOW - 1 }),
      beacon([stun(B)], { sk, at: NOW - 1, free: false }),
    ])
      expect(beaconStunClaims(VIDEO, [old, latest], NOW)).toEqual([]);
  });

  it('ignores a newer forged beacon without suppressing the valid older claim', () => {
    const sk = generateSecretKey();
    const old = beacon([stun(A)], { sk, at: NOW - 60 });
    const forged = { ...beacon([stun(B)], { sk, at: NOW - 1 }), sig: '00'.repeat(64) };
    expect(beaconStunClaims(VIDEO, [old, forged], NOW)).toEqual([claim(getPublicKey(sk), A)]);
  });

  it('requires the manifest author as well as the video address to match', () => {
    expect(
      beaconStunClaims(
        { ...VIDEO, author: getPublicKey(generateSecretKey()) as NostrPubkey },
        [beacon([stun(A)])],
        NOW,
      ),
    ).toEqual([]);
  });

  it('limits distinct seeders after sorting by newest beacon', () => {
    const events = Array.from({ length: MAX_AVAILABILITY_SEEDERS + 1 }, (_, i) =>
      beacon([stun(A)], { at: NOW - i }),
    );
    const original = [...events].reverse();
    expect(beaconStunClaims(VIDEO, original, NOW)).toEqual(
      events.slice(0, MAX_AVAILABILITY_SEEDERS).map((ev) => claim(ev.pubkey, A)),
    );
    expect(original).toEqual([...events].reverse());
  });

  it('does not fall back to a valid event beyond the newest-event bound', () => {
    const old = beacon([stun(A)], { at: NOW - 60 });
    const invalid = { ...beacon([stun(B)], { at: NOW - 1 }), sig: '00'.repeat(64) };
    expect(
      beaconStunClaims(
        VIDEO,
        [old, ...Array.from({ length: MAX_AVAILABILITY_EVENTS }, () => invalid)],
        NOW,
      ),
    ).toEqual([]);
    expect(
      beaconStunClaims(
        VIDEO,
        [old, ...Array.from({ length: MAX_AVAILABILITY_EVENTS - 1 }, () => invalid)],
        NOW,
      ),
    ).toEqual([claim(old.pubkey, A)]);
  });

  it('a beacon without a stun endpoint names none', () => {
    const https: Endpoint = { t: 'https', url: 'https://origin.example/nfx' };
    expect(beaconStunClaims(VIDEO, [beacon([https])], NOW)).toEqual([]);
    expect(
      stunClaimsOfBeacon({ seeder: 'a'.repeat(64), content: { endpoints: [] } as never }),
    ).toEqual([]);
  });
});
