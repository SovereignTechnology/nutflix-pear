/**
 * Pear #97 in the web client: which renditions this page can reach seeders for, the list nfx's
 * library is given (the held ids of the hash list, the most-held first), and reading the hash list
 * only when the seeders hold different renditions.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { NfxVideo, NostrEvent } from '@sovit/core';
import { countHolders, renderHashList, type Endpoint, type HashList } from '@sovit/core/nfx';

import { Key, NS, T, addrOf, beacon, https, webrtc } from '../../__tests__/support/nfx.js';
import type { FetchFn } from '../http.js';
import {
  MAX_ALLOWED_RENDITIONS,
  allowedRenditions,
  preferring,
  renditionsFor,
  webAvailability,
  webUsable,
  type PlayRendition,
} from '../renditions.js';

const LADDER: (PlayRendition & { readonly height: number })[] = [
  { id: '1080p', bandwidth: 5_400_000, height: 1080 },
  { id: '720p', bandwidth: 2_800_000, height: 720 },
  { id: '360p', bandwidth: 950_000, height: 360 },
];

/** A hash list with these renditions (playlists only: enough to verify), and its root. */
function hashList(id: string): { readonly bytes: Uint8Array; readonly root: string } {
  const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
  const list: HashList = {
    v: 1,
    video: `${NS}:${id}`,
    files: [
      {
        name: 'master.m3u8',
        role: 'playlist-master',
        sha256: sha('m'),
        size: 1n,
        durMs: undefined,
      },
      ...LADDER.map((r) => ({
        name: `r${r.id}.m3u8`,
        role: 'playlist' as const,
        sha256: sha(r.id),
        size: 1n,
        durMs: undefined,
      })),
    ],
    renditions: LADDER.map((r) => ({
      id: r.id,
      playlist: `r${r.id}.m3u8`,
      bandwidth: BigInt(r.bandwidth),
      codecs: 'avc1.64001f,mp4a.40.2',
      resolution: `${String(Math.round(r.height * (16 / 9)))}x${String(r.height)}`,
    })),
  };
  const bytes = renderHashList(list);
  return { bytes, root: createHash('sha256').update(bytes).digest('hex') };
}

/** A fake origin: `files` by URL; anything else 404. Every request is recorded. */
function origin(files: Readonly<Record<string, Uint8Array>>): {
  readonly fetch: FetchFn;
  readonly asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    fetch: (url) => {
      asked.push(url);
      const body = files[url];
      return Promise.resolve(
        body === undefined
          ? new Response('no', { status: 404 })
          : new Response(new Uint8Array(body), { status: 200 }),
      );
    },
  };
}

describe('webAvailability: what this page can reach', () => {
  it('counts https origins it may fetch from and webrtc bridges with a usable tracker only', () => {
    expect(webUsable({ t: 'https', url: 'https://seed.example/o' })).toBe(true);
    expect(webUsable({ t: 'https', url: 'https://seed.example/o', renditions: ['360p'] })).toBe(
      true,
    );
    // An origin that says it serves nothing: nothing to fetch from it (nfx's library skips it).
    expect(webUsable({ t: 'https', url: 'https://seed.example/o', renditions: [] })).toBe(false);
    expect(webUsable({ t: 'https', url: 'https://10.0.0.5/o' })).toBe(false);
    expect(webUsable({ t: 'webrtc', trackerUrls: ['wss://t.example/a'], renditions: [] })).toBe(
      true,
    );
    expect(webUsable({ t: 'webrtc', trackerUrls: ['ws://t.example/a'], renditions: [] })).toBe(
      false,
    );
    const irohEndpoint: Endpoint = {
      t: 'iroh',
      node: 'a'.repeat(64),
      relay: '',
      addrs: [],
      tickets: new Map([['meta', 'blob'.repeat(4)]]),
    };
    expect(webUsable(irohEndpoint)).toBe(false);
  });

  it('mixed holders: a list held by name, an origin without one holds every rendition', () => {
    const creator = new Key();
    const addr = addrOf(creator, 'held-video');
    const video = { id: addr, author: creator.pubkey } as Pick<NfxVideo, 'id' | 'author'>;
    const events: NostrEvent[] = [
      beacon(new Key(), addr, [{ ...https('https://a.example/o'), renditions: ['360p'] }]),
      beacon(new Key(), addr, [{ ...webrtc('wss://t.example/a'), renditions: ['360p', '720p'] }]),
      beacon(new Key(), addr, [https('https://b.example/o')]),
      // Nothing this page can use: not counted.
      beacon(new Key(), addr, [{ ...https('https://10.0.0.5/o'), renditions: ['1080p'] }]),
      // An origin that serves nothing: not counted as holding everything.
      beacon(new Key(), addr, [{ ...https('https://c.example/o'), renditions: [] }]),
    ];
    const a = webAvailability(video, events, T);
    expect(a.seeders).toBe(3);
    expect(a.all).toBe(1);
    expect([...a.named].sort()).toEqual([
      ['360p', 2],
      ['720p', 1],
    ]);
  });
});

describe('the renditions nfx’s library is given', () => {
  it('allowedRenditions: none when everyone holds everything; else the held ones, most-held first', () => {
    expect(allowedRenditions(LADDER, countHolders(['all', 'all']))).toBeUndefined();
    expect(
      allowedRenditions(LADDER, countHolders([['720p'], ['720p', '360p'], ['1080p']])),
    ).toEqual(['720p', '1080p', '360p']);
    // An origin holding everything plus seeders of 360p: every rendition is held, 360p by the most.
    expect(allowedRenditions(LADDER, countHolders(['all', ['360p'], ['360p']]))).toEqual([
      '360p',
      '1080p',
      '720p',
    ]);
    // Never one nobody holds.
    expect(allowedRenditions(LADDER, countHolders([['360p'], ['360p', '720p']]))).toEqual([
      '360p',
      '720p',
    ]);
    // Held renditions this hash list does not have: no list (the library would refuse one).
    expect(allowedRenditions(LADDER, countHolders([['2160p']]))).toBeUndefined();
    expect(allowedRenditions(LADDER, countHolders([['2160p'], ['360p']]))).toEqual(['360p']);
  });

  it('at most 32 ids, each once', () => {
    const many: PlayRendition[] = Array.from({ length: 40 }, (_, i) => ({
      id: `r${String(i)}`,
      bandwidth: 1_000 + i,
    }));
    const held = countHolders(['all', ['r0']]);
    const got = allowedRenditions(many, held);
    expect(got).toHaveLength(MAX_ALLOWED_RENDITIONS);
    expect(got?.[0]).toBe('r0');
    expect(new Set(got).size).toBe(got?.length);
  });

  it('preferring: a viewer’s pick first when it is allowed, else the list as it was', () => {
    expect(preferring(['720p', '1080p', '360p'], '360p')).toEqual(['360p', '720p', '1080p']);
    expect(preferring(['720p', '360p'], '720p')).toEqual(['720p', '360p']);
    expect(preferring(['720p', '360p'], '1080p')).toEqual(['720p', '360p']);
  });

  it('renditionsFor reads the hash list only when needed, from the first origin that verifies', async () => {
    const creator = new Key();
    const { bytes, root } = hashList('held-video');
    const video = {
      id: addrOf(creator, 'held-video'),
      root,
      segs: 4,
    } as Pick<NfxVideo, 'id' | 'root' | 'segs'>;
    const varied = countHolders([['360p'], ['360p'], ['720p']]);
    const o = origin({
      [`https://good.example/o/${root}`]: bytes,
      [`https://bad.example/${root}`]: new TextEncoder().encode('{"v":1}'),
    });
    const origins = [
      { url: 'https://gone.example' },
      // It serves nothing: never asked.
      { url: 'https://none.example', renditions: [] },
      { url: 'https://bad.example', renditions: ['360p'] },
      { url: 'https://good.example/o' },
    ];
    expect(await renditionsFor(o.fetch, video, origins, varied)).toEqual(['360p', '720p']);
    expect(o.asked).toEqual(
      ['https://gone.example', 'https://bad.example', 'https://good.example/o'].map(
        (x) => `${x}/${root}`,
      ),
    );
    // Everyone holds everything: no request at all.
    const quiet = origin({});
    expect(await renditionsFor(quiet.fetch, video, origins, countHolders(['all']))).toBeUndefined();
    expect(quiet.asked).toEqual([]);
    // No origin serves one that verifies: no list (every rendition its origin serves).
    expect(await renditionsFor(origin({}).fetch, video, origins, varied)).toBeUndefined();
    // At most three origins are asked, within one deadline for all of them.
    const many = origin({});
    await renditionsFor(many.fetch, video, [{ url: 'https://a.example' }, ...origins], varied);
    expect(many.asked).toHaveLength(3);
    let clock = 0;
    const slow = origin({});
    const late = await renditionsFor(
      (url, init) => {
        clock += 6_000;
        return slow.fetch(url, init);
      },
      video,
      origins,
      varied,
      () => clock,
    );
    expect(late).toBeUndefined();
    expect(slow.asked).toHaveLength(2);
  });
});
