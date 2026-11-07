/**
 * Slice 4b-2 (ADR 0020, contracts v9): the NFX catalogue beside the NIP-71 one. Real signed
 * events in `FakeRelayPool`s, read through L1 as from relays.
 *
 * - Dormant: without `Settings.nfx` enabled the host never asks for an NFX event.
 * - Merged feeds: newest first under one time cursor, nothing lost or repeated across pages.
 * - Twins: a same-author NFX copy of a NIP-71 video is dropped, also across pages; slice 5d-4,
 *   when the network can play (scoped relays): a free NIP-71 video gives way to its copy instead.
 * - NFX-04 §4: the read relays first, the scoped relays only as the fallback.
 * - An NFX failure lists the NIP-71 videos alone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CatalogVideo,
  FeedQuery,
  NfxAddress,
  NostrEvent,
  NostrFilter,
  NetworkAdapter,
  RelayUrl,
  Sats,
  VideoManifest,
} from '@sovit/core';
import { mocks, nostr } from '@sovit/core';

import { SignerIdentity } from '../identity.js';
import { memoryLogger } from '../log.js';
import { NostrCatalog } from '../catalog/catalog.js';
import { MergedCatalog } from '../catalog/merged-catalog.js';
import { NfxCatalog, type NfxSource } from '../catalog/nfx-catalog.js';
import { seedVideos } from './support/catalog.js';
import { coreTestKit, type TestSignerLike } from './support/core-helpers.js';
import type { Rig } from './support/rig.js';
import { rig } from './support/rig.js';

const kit = await coreTestKit();
const NS = 'nfx:testnet:1';
const NFX_ON = { enabled: true, network: NS, scopedRelays: [] } as const;
const HOUR = 3600;

let r: Rig | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

const fixture = (slug: string): (typeof mocks.VIDEOS)[number] => {
  const v = mocks.VIDEOS.find((x) => x.id === mocks.asEventId(slug));
  if (v === undefined) throw new Error(`no fixture ${slug}`);
  return v;
};

function nfxDraft(videoId: string, ageHours: number, extra: string[][] = []): nostr.EventDraft {
  const at = mocks.FIXTURE_NOW - ageHours * HOUR;
  return {
    kind: 38504,
    created_at: at,
    content: `NFX copy: ${videoId}.`,
    tags: [
      ['d', `${NS}:${videoId}`],
      ['n', NS],
      ['title', `NFX ${videoId}`],
      ['published_at', String(at)],
      ['license', 'open'],
      ['root', 'ab'.repeat(32)],
      ['segs', '4'],
      ['t', 'space'],
      ...extra,
    ],
  };
}

async function storeNfx(
  pool: nostr.FakeRelayPool,
  by: TestSignerLike,
  videoId: string,
  ageHours: number,
  extra: string[][] = [],
): Promise<NostrEvent> {
  const ev = await kit.sign(by, nfxDraft(videoId, ageHours, extra));
  pool.store(ev);
  return ev;
}

const addr = (author: string, videoId: string): NfxAddress =>
  `38504:${author}:${NS}:${videoId}` as NfxAddress;

async function allPages(a: NetworkAdapter, q: FeedQuery, max = 10): Promise<CatalogVideo[]> {
  const out: CatalogVideo[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < max; i++) {
    const page = await a.feed(cursor === undefined ? q : { ...q, cursor });
    out.push(...page.items);
    cursor = page.next;
    if (cursor === undefined) return out;
  }
  throw new Error('too many pages');
}

const filtersOf = (spy: { mock: { calls: unknown[][] } }): NostrFilter[] =>
  spy.mock.calls.map((c) => c[1] as NostrFilter);

describe('dormant until Settings.nfx is enabled (contracts v10)', () => {
  it.each([
    ['absent', undefined],
    ['present but off', { ...NFX_ON, enabled: false }],
  ] as const)('%s: never asks for kind 38504, an `n` or an `a`', async (_name, nfx) => {
    const creator = new kit.TestSigner();
    r = await rig({
      identity: new SignerIdentity(creator),
      ...(nfx === undefined ? {} : { nfx }),
    });
    await seedVideos(kit, r.pool, creator, [fixture('hohmann')]);
    await storeNfx(r.pool, creator, 'lagrange-points', 1);
    const query = vi.spyOn(r.pool, 'query');
    const a = r.host.adapter;
    const tags = await a.feed({ source: 'tags', tags: ['space'] });
    await a.feed({ source: 'author', author: creator.pubkey });
    await a.search({ text: 'lagrange' });
    expect(await a.nfxVideo(addr(creator.pubkey, 'lagrange-points'))).toBeNull();
    expect(tags.items.every((v) => v.kind !== 38504)).toBe(true);
    for (const f of filtersOf(query)) {
      expect(f.kinds ?? []).not.toContain(38504);
      expect(f['#n']).toBeUndefined();
      expect(f['#a']).toBeUndefined();
    }
  });

  it('switching NFX on and off takes effect on the next read', async () => {
    const creator = new kit.TestSigner();
    r = await rig({ identity: new SignerIdentity(creator) });
    await seedVideos(kit, r.pool, creator, [fixture('hohmann')]);
    await storeNfx(r.pool, creator, 'lagrange-points', 1);
    const a = r.host.adapter;
    const kinds = async (): Promise<number[]> =>
      (await a.feed({ source: 'tags', tags: ['space'] })).items.map((v) => v.kind);
    expect(await kinds()).toEqual([21]);
    await a.updateSettings({ nfx: NFX_ON });
    expect(await kinds()).toEqual([38504, 21]);
    await a.updateSettings({ nfx: { ...NFX_ON, enabled: false } });
    expect(await kinds()).toEqual([21]);
  });
});

describe('merged feeds (Settings.nfx enabled)', () => {
  it('pages NIP-71 and NFX videos newest first, nothing lost or repeated', async () => {
    const creator = new kit.TestSigner();
    r = await rig({ identity: new SignerIdentity(creator), nfx: NFX_ON });
    // NIP-71 'space': hohmann (3 h), short-launch (12 h), orbit-decay (100 h).
    const legacy = await seedVideos(kit, r.pool, creator, [
      fixture('hohmann'),
      fixture('short-launch'),
      fixture('orbit-decay'),
    ]);
    const nfx = [
      await storeNfx(r.pool, creator, 'nfx-one-hour', 1),
      await storeNfx(r.pool, creator, 'nfx-six-hours', 6),
      await storeNfx(r.pool, creator, 'nfx-fifty-hours', 50),
      await storeNfx(r.pool, creator, 'nfx-two-hundred', 200),
    ];
    const expected = [...legacy.map((s) => s.event), ...nfx].sort(nostr.byNewest).map((e) => e.id);
    const got = await allPages(r.host.adapter, { source: 'tags', tags: ['space'], limit: 2 });
    const ids = got.map((v) => (v.kind === 38504 ? v.eventId : v.id));
    expect(ids).toEqual(expected);
    expect(got.filter((v) => v.kind === 38504)).toHaveLength(4);
  });

  it('nfxVideo finds a manifest by address, and nothing outside the network', async () => {
    const creator = new kit.TestSigner();
    r = await rig({ nfx: NFX_ON });
    const ev = await storeNfx(r.pool, creator, 'lagrange-points', 1);
    const a = r.host.adapter;
    expect((await a.nfxVideo(addr(creator.pubkey, 'lagrange-points')))?.eventId).toBe(ev.id);
    const mainnet = `38504:${creator.pubkey}:nfx:mainnet:1:lagrange-points` as NfxAddress;
    expect(await a.nfxVideo(mainnet)).toBeNull();
  });

  it('Studio lists the creator’s NIP-71 uploads only', async () => {
    const creator = new kit.TestSigner();
    r = await rig({ identity: new SignerIdentity(creator), nfx: NFX_ON });
    await seedVideos(kit, r.pool, creator, [fixture('hohmann')]);
    await storeNfx(r.pool, creator, 'lagrange-points', 1);
    const mine = await r.host.adapter.studio.myVideos();
    expect(mine.items.map((v) => v.kind)).toEqual([21]);
  });
});

describe('twins (ADR 0020: same author only)', () => {
  it('drops an NFX copy whose NIP-71 event exists, also when that event is on a later page', async () => {
    const creator = new kit.TestSigner();
    r = await rig({ identity: new SignerIdentity(creator), nfx: NFX_ON });
    const [hohmann, raku] = await seedVideos(kit, r.pool, creator, [
      fixture('hohmann'),
      fixture('raku'),
    ]);
    // Newer than both NIP-71 videos, linking to the older one (raku, 9 h).
    await storeNfx(r.pool, creator, 'raku-on-nfx', 1, [['e', raku!.event.id]]);
    const got = await allPages(r.host.adapter, {
      source: 'author',
      author: creator.pubkey,
      limit: 1,
    });
    expect(got.map((v) => v.id)).toEqual([hohmann!.video.id, raku!.video.id]);
  });

  it('keeps an NFX video linking to another author’s event', async () => {
    const creator = new kit.TestSigner();
    const other = new kit.TestSigner();
    r = await rig({ identity: new SignerIdentity(creator), nfx: NFX_ON });
    const [raku] = await seedVideos(kit, r.pool, creator, [fixture('raku')]);
    await storeNfx(r.pool, other, 'not-a-twin', 1, [['e', raku!.event.id]]);
    const got = await allPages(r.host.adapter, { source: 'tags', tags: ['space', 'ceramics'] });
    expect(got.map((v) => v.id)).toEqual([addr(other.pubkey, 'not-a-twin'), raku!.video.id]);
  });
});

describe('twins when the network can play (slice 5d-4)', () => {
  const PLAYABLE = { ...NFX_ON, scopedRelays: ['wss://scoped.test' as RelayUrl] };
  const free = (v: VideoManifest): VideoManifest => ({
    ...v,
    price: { ...v.price, satsPerBlock: 0 as Sats },
  });

  it('a free NIP-71 video lists as its NFX copy, also when the two are pages apart', async () => {
    const creator = new kit.TestSigner();
    r = await rig({ identity: new SignerIdentity(creator), nfx: PLAYABLE });
    const [hohmann, raku] = await seedVideos(kit, r.pool, creator, [
      fixture('hohmann'),
      free(fixture('raku')),
    ]);
    await storeNfx(r.pool, creator, 'raku-on-nfx', 1, [['e', raku!.event.id]]);
    const got = await allPages(r.host.adapter, {
      source: 'author',
      author: creator.pubkey,
      limit: 1,
    });
    expect(got.map((v) => v.id)).toEqual([addr(creator.pubkey, 'raku-on-nfx'), hohmann!.video.id]);
    const one = await r.host.adapter.feed({ source: 'author', author: creator.pubkey });
    expect(one.items.map((v) => v.id)).toEqual([
      addr(creator.pubkey, 'raku-on-nfx'),
      hohmann!.video.id,
    ]);
  });

  it('a priced NIP-71 video keeps its card; its free copy is dropped', async () => {
    const creator = new kit.TestSigner();
    r = await rig({ identity: new SignerIdentity(creator), nfx: PLAYABLE });
    const [hohmann] = await seedVideos(kit, r.pool, creator, [fixture('hohmann')]);
    await storeNfx(r.pool, creator, 'hohmann-on-nfx', 1, [['e', hohmann!.event.id]]);
    const got = await allPages(r.host.adapter, { source: 'tags', tags: ['space'], limit: 1 });
    expect(got.map((v) => v.id)).toEqual([hohmann!.video.id]);
  });

  it('a tag feed drops a free NIP-71 video only for a copy the same feed lists', async () => {
    const creator = new kit.TestSigner();
    r = await rig({ identity: new SignerIdentity(creator), nfx: PLAYABLE });
    const [raku] = await seedVideos(kit, r.pool, creator, [free(fixture('raku'))]);
    // The copy is tagged `space` only: a `ceramics` feed never lists it, so raku stays there.
    await storeNfx(r.pool, creator, 'raku-on-nfx', 1, [['e', raku!.event.id]]);
    const ceramics = await allPages(r.host.adapter, { source: 'tags', tags: ['ceramics'] });
    expect(ceramics.map((v) => v.id)).toEqual([raku!.video.id]);
    const either = await allPages(r.host.adapter, { source: 'tags', tags: ['ceramics', 'space'] });
    expect(either.map((v) => v.id)).toEqual([addr(creator.pubkey, 'raku-on-nfx')]);
  });

  it('dropped twins lose and repeat nothing across short pages', async () => {
    const creator = new kit.TestSigner();
    r = await rig({ identity: new SignerIdentity(creator), nfx: PLAYABLE });
    // Priced 'space' videos at 3 h, 12 h and 100 h, each with a newer free copy (dropped), and
    // two NFX-only videos between them.
    const legacy = await seedVideos(kit, r.pool, creator, [
      fixture('hohmann'),
      fixture('short-launch'),
      fixture('orbit-decay'),
    ]);
    for (const [i, s] of legacy.entries()) {
      const ageHours = (mocks.FIXTURE_NOW - s.event.created_at) / HOUR;
      await storeNfx(r.pool, creator, `twin-copy-${String(i)}`, ageHours - 0.5, [
        ['e', s.event.id],
      ]);
    }
    const only = [
      await storeNfx(r.pool, creator, 'nfx-only-six', 6),
      await storeNfx(r.pool, creator, 'nfx-only-fifty', 50),
    ];
    const expected = [...legacy.map((s) => s.event), ...only].sort(nostr.byNewest).map((e) => e.id);
    // The copies are real, listable NFX videos: only the twin rule keeps them off the pages.
    expect(await r.host.adapter.nfxVideo(addr(creator.pubkey, 'twin-copy-0'))).not.toBeNull();
    for (const limit of [1, 2, 3]) {
      const got = await allPages(r.host.adapter, { source: 'tags', tags: ['space'], limit });
      expect(got.map((v) => (v.kind === 38504 ? v.eventId : v.id))).toEqual(expected);
    }
  });
});

describe('NfxCatalog (NFX-04 §4)', () => {
  const PUBLIC = 'wss://public.test' as RelayUrl;
  const SCOPED = 'wss://scoped.test' as RelayUrl;

  function twoPools(): {
    readonly pub: nostr.FakeRelayPool;
    readonly scoped: nostr.FakeRelayPool;
    readonly client: nostr.NostrClient;
    readonly asked: RelayUrl[][];
  } {
    const pub = new nostr.FakeRelayPool();
    const scoped = new nostr.FakeRelayPool();
    const asked: RelayUrl[][] = [];
    const pool: nostr.PoolLike = {
      query: (relays, filter) => {
        asked.push([...relays]);
        return (relays.includes(SCOPED) ? scoped : pub).query(relays, filter);
      },
      subscribe: (relays, filters, handlers) => pub.subscribe(relays, filters, handlers),
      publish: (relays, event) => pub.publish(relays, event),
      close: () => undefined,
    };
    const client = new nostr.NostrClient({
      pool,
      relays: [{ url: PUBLIC, read: true, write: true }],
      now: () => mocks.FIXTURE_NOW,
    });
    return { pub, scoped, client, asked };
  }

  it('reads the public relays first; the scoped relays only when they have nothing', async () => {
    const t = twoPools();
    const creator = new kit.TestSigner();
    const cat = new NfxCatalog(
      () => t.client,
      NS,
      () => [SCOPED],
    );
    t.scoped.store(await kit.sign(creator, nfxDraft('scoped-only', 2)));
    const fromScoped = await cat.feed({ source: 'author', author: creator.pubkey }, null);
    expect(fromScoped.items.map((v) => v.title)).toEqual(['NFX scoped-only']);
    expect(t.asked.some((relays) => relays.includes(SCOPED))).toBe(true);

    t.asked.length = 0;
    t.pub.store(await kit.sign(creator, nfxDraft('public-copy', 1)));
    const fromPublic = await cat.feed({ source: 'author', author: creator.pubkey }, null);
    expect(fromPublic.items.map((v) => v.title)).toEqual(['NFX public-copy']);
    expect(t.asked.every((relays) => !relays.includes(SCOPED))).toBe(true);
  });

  it('without scoped relays, asks the public relays only', async () => {
    const t = twoPools();
    const cat = new NfxCatalog(
      () => t.client,
      NS,
      () => [],
    );
    expect((await cat.feed({ source: 'tags', tags: ['space'] }, null)).items).toEqual([]);
    expect(t.asked.length).toBeGreaterThan(0);
    expect(t.asked.every((relays) => !relays.includes(SCOPED))).toBe(true);
  });

  describe('the network feed (contracts v13)', () => {
    const catalog = (t: ReturnType<typeof twoPools>): NfxCatalog =>
      new NfxCatalog(
        () => t.client,
        NS,
        () => [SCOPED],
      );
    const pages = async (cat: NfxCatalog, limit: number): Promise<string[][]> => {
      const out: string[][] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 8; i++) {
        const page = await cat.feed(
          { source: 'network', limit, ...(cursor === undefined ? {} : { cursor }) },
          null,
        );
        out.push(page.items.map((v) => v.title));
        cursor = page.next;
        if (cursor === undefined) return out;
      }
      throw new Error('too many pages');
    };

    it('lists every video on the scoped AND the public relays, newest first, one per address', async () => {
      const t = twoPools();
      const a = new kit.TestSigner();
      const b = new kit.TestSigner();
      const both = await kit.sign(a, nfxDraft('on-both', 5));
      t.pub.store(both);
      t.scoped.store(both); // the same manifest on both relay sets: one video
      t.pub.store(await kit.sign(b, nfxDraft('public-only', 3)));
      t.scoped.store(await kit.sign(a, nfxDraft('scoped-only', 1)));
      // A newer revision of `on-both`, on the scoped relays only: still one video, and the newest.
      t.scoped.store(await kit.sign(a, nfxDraft('on-both', 0.5)));
      const page = await catalog(t).feed({ source: 'network' }, null);
      expect(page.items.map((v) => v.title)).toEqual([
        'NFX on-both',
        'NFX scoped-only',
        'NFX public-only',
      ]);
      expect(new Set(page.items.map((v) => v.id)).size).toBe(3);
      expect(page.items[0]!.event.created_at).toBe(mocks.FIXTURE_NOW - 0.5 * HOUR);
      expect(t.asked.some((relays) => relays.includes(SCOPED))).toBe(true);
      expect(t.asked.some((relays) => !relays.includes(SCOPED))).toBe(true);
    });

    it('needs no viewer, and without scoped relays asks the public relays alone', async () => {
      const t = twoPools();
      t.pub.store(await kit.sign(new kit.TestSigner(), nfxDraft('only-public', 2)));
      const cat = new NfxCatalog(
        () => t.client,
        NS,
        () => [],
      );
      expect((await cat.feed({ source: 'network' }, null)).items.map((v) => v.title)).toEqual([
        'NFX only-public',
      ]);
      expect(t.asked.every((relays) => !relays.includes(SCOPED))).toBe(true);
    });

    it('pages newest first across both relay sets, losing and repeating nothing', async () => {
      const t = twoPools();
      const a = new kit.TestSigner();
      for (const [id, hours, pool] of [
        ['clip-one', 1, t.scoped],
        ['clip-two', 2, t.pub],
        ['clip-three', 3, t.scoped],
        ['clip-four', 4, t.pub],
        ['clip-five', 5, t.scoped],
      ] as const)
        pool.store(await kit.sign(a, nfxDraft(id, hours)));
      const got = await pages(catalog(t), 2);
      const flat = got.flat();
      expect(flat).toEqual([
        'NFX clip-one',
        'NFX clip-two',
        'NFX clip-three',
        'NFX clip-four',
        'NFX clip-five',
      ]);
      expect(new Set(flat).size).toBe(flat.length);
      expect(got.length).toBeGreaterThan(1);
    });

    it('survives one relay set being down, and fails only when both are', async () => {
      const t = twoPools();
      t.pub.store(await kit.sign(new kit.TestSigner(), nfxDraft('still-here', 1)));
      const scopedDown = vi.spyOn(t.scoped, 'query').mockRejectedValue(new Error('scoped down'));
      const cat = catalog(t);
      expect((await cat.feed({ source: 'network' }, null)).items.map((v) => v.title)).toEqual([
        'NFX still-here',
      ]);
      expect(scopedDown).toHaveBeenCalled();
      vi.spyOn(t.pub, 'query').mockRejectedValue(new Error('public down'));
      await expect(cat.feed({ source: 'network' }, null)).rejects.toThrow(/down/);
    });
  });

  it('runs on a canonical namespace only, and has nothing for trending or shorts', async () => {
    const t = twoPools();
    for (const bad of ['nutflix:testnet:1', 'nfx:testnet:01', 'nfx:Testnet:1', '']) {
      expect(
        () =>
          new NfxCatalog(
            () => t.client,
            bad,
            () => [],
          ),
      ).toThrow();
    }
    const cat = new NfxCatalog(
      () => t.client,
      NS,
      () => [],
    );
    expect(await cat.feed({ source: 'trending' }, null)).toEqual({ items: [] });
    expect(await cat.feed({ source: 'shorts' }, null)).toEqual({ items: [] });
    expect(t.asked).toEqual([]);
    // The NIP-71 catalogue alone has no NFX network to list (`MergedCatalog` routes `network`).
    expect(await new NostrCatalog(() => t.client).feed({ source: 'network' }, null)).toEqual({
      items: [],
    });
    expect(t.asked).toEqual([]);
  });
});

describe('MergedCatalog', () => {
  it('an NFX failure lists the NIP-71 videos alone, and is logged', async () => {
    const pool = new nostr.FakeRelayPool();
    const creator = new kit.TestSigner();
    const client = new nostr.NostrClient({
      pool,
      relays: [{ url: 'wss://a.test' as RelayUrl, read: true, write: true }],
    });
    const seeded = await seedVideos(kit, pool, creator, [fixture('hohmann')]);
    const down = (): Promise<never> => Promise.reject(new Error('relay down'));
    const failing: NfxSource = {
      feed: down,
      search: down,
      video: down,
      twinsOf: down,
      playable: () => true,
    };
    const log = memoryLogger('debug');
    const merged = new MergedCatalog(new NostrCatalog(() => client), failing, log);
    const page = await merged.feed({ source: 'tags', tags: ['space'] }, null);
    expect(page.items.map((v) => v.id)).toEqual([seeded[0]!.video.id]);
    expect(log.lines.some((l) => l.msg.includes('nfx catalog read failed'))).toBe(true);
  });

  it('the network feed is the NFX side alone: the NIP-71 catalogue is never asked', async () => {
    const pool = new nostr.FakeRelayPool();
    const client = new nostr.NostrClient({
      pool,
      relays: [{ url: 'wss://a.test' as RelayUrl, read: true, write: true }],
    });
    const legacy = new NostrCatalog(() => client);
    const legacyFeed = vi.spyOn(legacy, 'feed');
    const nfxFeed = vi.fn<NfxSource['feed']>(() => Promise.resolve({ items: [] }));
    const nfx: NfxSource = {
      feed: nfxFeed,
      search: () => Promise.resolve({ items: [] }),
      video: () => Promise.resolve(null),
      twinsOf: () => Promise.resolve([]),
      playable: () => true,
    };
    const merged = new MergedCatalog(legacy, nfx, memoryLogger('debug'));
    expect(await merged.feed({ source: 'network', limit: 5 }, null)).toEqual({ items: [] });
    expect(nfxFeed).toHaveBeenCalledWith({ source: 'network', limit: 5 }, null);
    expect(legacyFeed).not.toHaveBeenCalled();
  });

  it('the network feed lists nothing, and logs, when the NFX side fails', async () => {
    const pool = new nostr.FakeRelayPool();
    const client = new nostr.NostrClient({
      pool,
      relays: [{ url: 'wss://a.test' as RelayUrl, read: true, write: true }],
    });
    const down = (): Promise<never> => Promise.reject(new Error('relay down'));
    const log = memoryLogger('debug');
    const merged = new MergedCatalog(
      new NostrCatalog(() => client),
      { feed: down, search: down, video: down, twinsOf: down, playable: () => true },
      log,
    );
    expect(await merged.feed({ source: 'network' }, null)).toEqual({ items: [] });
    expect(log.lines.some((l) => l.msg.includes('nfx catalog read failed'))).toBe(true);
  });
});
