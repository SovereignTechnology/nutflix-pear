/**
 * Pear #97 in the web client: which renditions this page can reach seeders for, the start level
 * (the most-held held rendition, as an index into hls.js's levels), and reading the hash list
 * only when the seeders hold different renditions.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { NfxVideo, NostrEvent } from '@sovit/core';
import { countHolders, renderHashList, type Endpoint, type HashList } from '@sovit/core/nfx';

import { Key, NS, T, addrOf, beacon, https, webrtc } from '../../__tests__/support/nfx.js';
import type { FetchFn } from '../http.js';
import {
  chooseStart,
  levelOrder,
  startFor,
  webAvailability,
  webUsable,
  type PlayRendition,
} from '../renditions.js';

const LADDER: PlayRendition[] = [
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
      resolution: `${String(Math.round((r.height ?? 0) * (16 / 9)))}x${String(r.height)}`,
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

describe('the start level', () => {
  it("levelOrder is hls.js's: height, then bitrate; bitrate alone without resolutions", () => {
    expect(levelOrder(LADDER).map((r) => r.id)).toEqual(['360p', '720p', '1080p']);
    const same = [
      { id: 'hi', bandwidth: 3, height: 720 },
      { id: 'lo', bandwidth: 1, height: 720 },
    ];
    expect(levelOrder(same).map((r) => r.id)).toEqual(['lo', 'hi']);
    expect(
      levelOrder([
        { id: 'a', bandwidth: 9 },
        { id: 'b', bandwidth: 2, height: 1080 },
      ]).map((r) => r.id),
    ).toEqual(['b', 'a']);
  });

  it('chooseStart: nothing to pin when everyone holds everything; else the most-held', () => {
    expect(chooseStart(LADDER, countHolders(['all', 'all']))).toBeUndefined();
    const start = chooseStart(LADDER, countHolders([['720p'], ['720p', '360p'], ['1080p']]));
    expect(start).toEqual({
      level: 1,
      rendition: LADDER[1],
      allowed: ['720p', '1080p', '360p'],
    });
    // An origin holding everything plus seeders of 360p: 360p is held by the most.
    expect(chooseStart(LADDER, countHolders(['all', ['360p'], ['360p']]))?.rendition.id).toBe(
      '360p',
    );
    // Held renditions this hash list does not have: nothing to start on.
    expect(chooseStart(LADDER, countHolders([['2160p']]))).toBeUndefined();
  });

  it('startFor reads the hash list only when needed, from the first origin that verifies', async () => {
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
    const origins = ['https://gone.example', 'https://bad.example', 'https://good.example/o'];
    const start = await startFor(o.fetch, video, origins, varied);
    expect(start).toMatchObject({ level: 0, rendition: { id: '360p', height: 360 } });
    expect(o.asked).toEqual(origins.map((x) => `${x}/${root}`));
    // Everyone holds everything: no request at all.
    const quiet = origin({});
    expect(await startFor(quiet.fetch, video, origins, countHolders(['all']))).toBeUndefined();
    expect(quiet.asked).toEqual([]);
    // No origin serves one that verifies: hls.js picks.
    expect(await startFor(origin({}).fetch, video, origins, varied)).toBeUndefined();
    // At most three origins are asked, within one deadline for all of them.
    const many = origin({});
    await startFor(many.fetch, video, ['https://a.example', ...origins], varied);
    expect(many.asked).toHaveLength(3);
    let clock = 0;
    const slow = origin({});
    const late = await startFor(
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
