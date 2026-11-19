/**
 * Contracts v19 (ADR 0024, pear #123): stats for nerds on a web play. The library's `stats()`
 * becomes the contract's sources (the origin, then each mesh peer), totals only from a library
 * pinned before nfx #99, and addresses only from `addresses()`, asked only when called.
 */
import { describe, expect, it } from 'vitest';

import type { NfxAddress } from '@sovit/core';

import { FakeNfxPlayer } from '../../__tests__/support/fake-nfx-lib.js';
import { tick } from '../../__tests__/support/nfx.js';
import { WebNfxSession, playAddress, playStats } from '../session.js';

const ADDR = `38504:${'a'.repeat(64)}:nfx:testnet:1:v` as NfxAddress;
const KEY = 'cd'.repeat(32);

function open(player: FakeNfxPlayer): WebNfxSession {
  const s = new WebNfxSession({
    videoId: ADDR,
    manifestJson: '{}',
    origins: [{ url: 'https://o.example/o' }],
    renditions: undefined,
    meshRelays: ['wss://relay.example'],
    iceServers: [],
    player: () => Promise.resolve(player),
  });
  s.source.attach(document.createElement('video'));
  return s;
}

const MESH = {
  signaling: 'nostr' as const,
  trackers: [],
  relays: ['wss://relay.example', 'wss://r2.example/path'],
  bytes: { http: 1000, p2p: 3000 },
  uploaded: 500,
  peers: 3,
  rejected: ['p2p:x'],
};

describe('stats for nerds on a web play (contracts v19)', () => {
  it('ranks the combined sources before retaining the best 64', () => {
    const stats = playStats({
      engine: 'test',
      origin: 'https://o.example',
      verified: 0,
      rejected: [],
      originBytes: 1,
      mesh: {
        ...MESH,
        bytes: { http: 0, p2p: 0 },
        peerList: Array.from({ length: 70 }, (_, i) => ({
          id: `p${i}`,
          via: 'nostr:',
          down: i + 2,
          up: 0,
          segments: 0,
          connected: i !== 69,
        })),
      },
    });
    expect(stats.sources).toHaveLength(64);
    expect(stats.sources[0]?.id).toBe('p68');
    expect(stats.sources.at(-1)?.id).toBe('p5');
    expect(stats.sources.some((s) => s.kind === 'origin')).toBe(false);
  });

  it('maps the origin and each mesh peer, open first as the library ordered them', () => {
    const s = playStats({
      engine: 'hls.js 1.7.4 + p2p-media-loader 4.0.0',
      origin: 'https://o.example/o',
      verified: 7,
      rejected: [{}],
      originBytes: 4096,
      bandwidthEstimate: 9_000_000,
      mesh: {
        ...MESH,
        connected: 1,
        segments: { http: 2, p2p: 5 },
        peerList: [
          {
            id: KEY,
            via: 'nostr:wss://relay.example',
            down: 3000,
            up: 0,
            segments: 5,
            connected: true,
          },
          {
            id: '-NX0100-abc\u0007',
            via: 'wss://tracker.example/announce',
            down: 0,
            up: 500,
            segments: 0,
            connected: false,
          },
        ],
        signal: { open: 2 },
      },
    });
    expect(s.sources).toEqual([
      {
        kind: 'origin',
        id: 'o.example',
        via: 'beacon',
        bytesDown: 5096,
        bytesUp: 0,
        files: 2,
        connected: true,
      },
      {
        kind: 'webrtc',
        id: KEY,
        via: 'nostr',
        bytesDown: 3000,
        bytesUp: 0,
        files: 5,
        connected: true,
      },
      {
        kind: 'webrtc',
        id: '-NX0100-abc?',
        via: 'tracker.example',
        bytesDown: 0,
        bytesUp: 500,
        files: 0,
        connected: false,
        label: 'nfxd bridge?',
      },
    ]);
    expect(s.peers).toEqual({ connected: 1, total: 3 });
    expect(s.signaling).toEqual({
      kind: 'nostr',
      endpoints: ['relay.example', 'r2.example'],
      open: 2,
    });
    expect([s.verified, s.refused, s.bandwidthEstimate]).toEqual([7, 2, 9_000_000]);
  });

  it('a library pinned before nfx #99: one row of peer totals, no peer count', () => {
    const s = playStats({
      engine: 'e',
      origin: 'https://o.example',
      verified: 3,
      rejected: [],
      mesh: MESH,
    });
    expect(s.sources.map((x) => [x.kind, x.id, x.bytesDown, x.bytesUp])).toEqual([
      ['webrtc', 'all peers', 3000, 500],
      ['origin', 'o.example', 1000, 0],
    ]);
    expect(s.peers).toBeUndefined();
    expect(s.signaling).toEqual({ kind: 'nostr', endpoints: ['relay.example', 'r2.example'] });
  });

  it('no mesh: the origin alone', () => {
    const s = playStats({
      engine: 'e',
      origin: 'https://o.example',
      verified: 3,
      rejected: [],
      mesh: null,
      originBytes: 10,
    });
    expect(s.sources).toEqual([
      {
        kind: 'origin',
        id: 'o.example',
        via: 'beacon',
        bytesDown: 10,
        bytesUp: 0,
        files: 3,
        connected: true,
      },
    ]);
    expect(s.signaling).toBeUndefined();
  });

  it('addresses: IPv4, IPv6 bracketed, hidden ones blank, the rest bounded', () => {
    const base = {
      id: KEY,
      port: 61234,
      remoteType: 'srflx',
      localType: 'host',
      protocol: 'udp',
      path: 'direct' as const,
      rttMs: 23,
    };
    expect(playAddress({ ...base, address: '203.0.113.9' })).toEqual({
      kind: 'webrtc',
      id: KEY,
      address: '203.0.113.9:61234',
      path: 'direct',
      rttMs: 23,
      detail: 'srflx/udp',
    });
    expect(playAddress({ ...base, address: '2001:db8::1' }).address).toBe('[2001:db8::1]:61234');
    expect(playAddress({ ...base, address: 'abcd.local' }).address).toBe('');
    expect(
      playAddress({ ...base, address: '', rttMs: null, remoteType: '', protocol: '' }),
    ).toEqual({
      kind: 'webrtc',
      id: KEY,
      address: '',
      path: 'direct',
    });
  });

  it('the session: stats from the attached player, addresses only when asked', async () => {
    const player = new FakeNfxPlayer();
    const s = open(player);
    expect(await s.stats()).toEqual({ sources: [] }); // not open yet
    await tick();
    const lib = player.last.session;
    lib.libStats = {
      engine: 'e',
      origin: 'https://o.example/o',
      verified: 1,
      rejected: [],
      mesh: null,
      originBytes: 5,
    };
    expect((await s.stats()).sources[0]?.bytesDown).toBe(5);
    // A library before nfx #99 has no addresses to give.
    expect(await s.addresses()).toEqual([]);
    lib.withAddresses([
      {
        id: KEY,
        address: '203.0.113.9',
        port: 1,
        remoteType: 'host',
        localType: 'host',
        protocol: 'udp',
        path: 'direct',
        rttMs: null,
      },
    ]);
    await s.stats();
    expect(lib.addressCalls).toBe(0);
    expect((await s.addresses()).map((a) => a.address)).toEqual(['203.0.113.9:1']);
    expect(lib.addressCalls).toBe(1);
    await s.close();
    expect(await s.stats()).toEqual({ sources: [] });
    expect(await s.addresses()).toEqual([]);
  });
});
