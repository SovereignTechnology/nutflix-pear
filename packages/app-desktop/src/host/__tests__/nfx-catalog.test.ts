/**
 * Slice 4b-2 (ADR 0020, contracts v9): the NFX catalogue beside the NIP-71 one. Real signed
 * events in `FakeRelayPool`s, read through L1 as from relays.
 *
 * - Dormant: without `Settings.nfx` enabled the host never asks for an NFX event.
 * - Merged feeds: newest first under one time cursor, nothing lost or repeated across pages.
 * - Twins: a same-author NFX copy of a NIP-71 video is dropped, also across pages; slice 5d-4,
 *   when the network can play (scoped relays): a free NIP-71 video gives way to its copy instead.
 * - ADR 0026 (2026-11-26; NFX-04 §4 as amended): the scoped and the read relays at once, merged
 *   (one per address, the newest revision, the scoped copy on a tie); a full answer from one waits
 *   at most a short grace for the other, so a relay that never answers holds no read.
 * - An NFX failure lists the NIP-71 videos alone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CatalogVideo,
  FeedQuery,
  NfxAddress,
  NostrEvent,
  NostrEventId,
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
import { DEFAULT_NFX } from '../settings/settings.js';
import { seedVideos } from './support/catalog.js';
import { coreTestKit, type TestSignerLike } from './support/core-helpers.js';
import type { Rig } from './support/rig.js';
import { rig } from './support/rig.js';

// ADR 0022: the NFX catalogue lives in core now; the desktop builds it in the adapter.
const { NfxCatalog } = nostr;
type NfxCatalog = nostr.NfxCatalog;
type NfxSource = nostr.NfxSource;

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

describe('dormant while Settings.nfx is off (contracts v10)', () => {
  it.each([
    ['switched off', { ...NFX_ON, enabled: false }],
    // ADR 0020 2026-11-08: the public relays pre-filled, but the user switched NFX off.
    ['the default, switched off', { ...DEFAULT_NFX, enabled: false }],
  ] as const)('%s: never asks for kind 38504, an `n` or an `a`', async (_name, nfx) => {
    const creator = new kit.TestSigner();
    r = await rig({ identity: new SignerIdentity(creator), nfx });
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

  it("absent (a fresh install): the default, NFX on, on the test network's public relays (ADR 0020 2026-11-08)", async () => {
    const creator = new kit.TestSigner();
    r = await rig({ identity: new SignerIdentity(creator) });
    await seedVideos(kit, r.pool, creator, [fixture('hohmann')]);
    await storeNfx(r.pool, creator, 'lagrange-points', 1);
    const a = r.host.adapter;
    expect((await a.settings()).nfx).toEqual(DEFAULT_NFX);
    const kinds = (await a.feed({ source: 'tags', tags: ['space'] })).items.map((v) => v.kind);
    expect(kinds).toEqual([38504, 21]);
  });

  it('switching NFX on and off takes effect on the next read', async () => {
    const creator = new kit.TestSigner();
    r = await rig({ identity: new SignerIdentity(creator), nfx: { ...NFX_ON, enabled: false } });
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

describe('NfxCatalog: the scoped and public relays at once (ADR 0026, 2026-11-26)', () => {
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

  const scopedCatalog = (t: ReturnType<typeof twoPools>, mergeGraceMs?: number): NfxCatalog =>
    new NfxCatalog(
      () => t.client,
      NS,
      () => [SCOPED],
      mergeGraceMs === undefined ? {} : { mergeGraceMs },
    );
  const askedScoped = (t: ReturnType<typeof twoPools>): boolean =>
    t.asked.some((relays) => relays.includes(SCOPED));
  const titles = (p: { readonly items: readonly { readonly title: string }[] }): string[] =>
    p.items.map((v) => v.title);
  const askedPublic = (t: ReturnType<typeof twoPools>): boolean =>
    t.asked.some((relays) => !relays.includes(SCOPED));
  /** A second revision of `first`'s address at the same second whose id sorts BELOW it. */
  async function lowerIdTwin(
    by: TestSignerLike,
    first: NostrEvent,
    videoId: string,
    ageHours: number,
  ): Promise<NostrEvent> {
    for (let i = 0; i < 256; i++) {
      const ev = await kit.sign(by, nfxDraft(videoId, ageHours, [['t', `variant${String(i)}`]]));
      if (ev.id < first.id) return ev;
    }
    throw new Error('no lower id in 256 tries');
  }

  it('asks the scoped and the public relays at once, and merges: a full scoped page still takes a newer public video', async () => {
    const t = twoPools();
    const creator = new kit.TestSigner();
    t.scoped.store(await kit.sign(creator, nfxDraft('scoped-one', 1)));
    t.scoped.store(await kit.sign(creator, nfxDraft('scoped-two', 2)));
    t.pub.store(await kit.sign(creator, nfxDraft('public-only', 0.5)));
    const cat = scopedCatalog(t);
    const page = await cat.feed({ source: 'author', author: creator.pubkey, limit: 2 }, null);
    expect(titles(page)).toEqual(['NFX public-only', 'NFX scoped-one']);
    expect(page.next).toBeDefined();
    const tags = await cat.feed({ source: 'tags', tags: ['space'], limit: 1 }, null);
    expect(titles(tags)).toEqual(['NFX public-only']);
    expect(askedScoped(t)).toBe(true);
    expect(askedPublic(t)).toBe(true);
  });

  it('a deletion on one relay set withdraws the copy the other set kept (CodeRabbit, #157)', async () => {
    const t = twoPools();
    const creator = new kit.TestSigner();
    // The author deleted `gone-video` on the scoped relay, which then dropped the manifest too; a
    // public relay never got the deletion and still has it, newer than everything else listed.
    t.scoped.store(await kit.sign(creator, nfxDraft('live-video', 2)));
    t.pub.store(await kit.sign(creator, nfxDraft('gone-video', 1)));
    t.scoped.store(
      await kit.sign(creator, {
        kind: 5,
        created_at: mocks.FIXTURE_NOW - 0.5 * HOUR,
        content: '',
        tags: [['a', addr(creator.pubkey, 'gone-video')]],
      }),
    );
    const cat = scopedCatalog(t);
    const one = await cat.feed({ source: 'author', author: creator.pubkey, limit: 1 }, null);
    expect(titles(one)).toEqual(['NFX live-video']);
    expect(titles(await cat.feed({ source: 'tags', tags: ['space'] }, null))).toEqual([
      'NFX live-video',
    ]);
    expect(await cat.video(addr(creator.pubkey, 'gone-video'))).toBeNull();
    expect(titles(await cat.feed({ source: 'network' }, null))).toEqual(['NFX live-video']);
    // A revision newer than the deletion republishes the video, wherever it was read.
    t.pub.store(await kit.sign(creator, nfxDraft('gone-video', 0.25, [['t', 'recut']])));
    expect((await cat.video(addr(creator.pubkey, 'gone-video')))?.title).toBe('NFX gone-video');
    expect(titles(await cat.feed({ source: 'author', author: creator.pubkey }, null))).toEqual([
      'NFX gone-video',
      'NFX live-video',
    ]);
    expect(titles(await cat.feed({ source: 'network' }, null))).toEqual([
      'NFX gone-video',
      'NFX live-video',
    ]);
  });

  it('a withdrawn copy never moves the cursor past a relay set’s unread videos (CodeRabbit, #157)', async () => {
    const t = twoPools();
    const creator = new kit.TestSigner();
    // Scoped: W (3 h) and the deletion of X. Read: X (1 h, deleted) and Z (2 h, live), so one
    // video a page leaves Z beyond the read set's first page.
    t.scoped.store(await kit.sign(creator, nfxDraft('w-video', 3)));
    t.pub.store(await kit.sign(creator, nfxDraft('x-video', 1)));
    t.pub.store(await kit.sign(creator, nfxDraft('z-video', 2)));
    t.scoped.store(
      await kit.sign(creator, {
        kind: 5,
        created_at: mocks.FIXTURE_NOW - 0.5 * HOUR,
        content: '',
        tags: [['a', addr(creator.pubkey, 'x-video')]],
      }),
    );
    const cat = scopedCatalog(t);
    for (const source of ['network', 'author'] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 8; i++) {
        const q =
          source === 'network'
            ? { source, limit: 1, ...(cursor === undefined ? {} : { cursor }) }
            : {
                source,
                author: creator.pubkey,
                limit: 1,
                ...(cursor === undefined ? {} : { cursor }),
              };
        const page = await cat.feed(q, null);
        seen.push(...titles(page));
        if (page.next === undefined) break;
        cursor = page.next;
      }
      expect(seen, source).toEqual(['NFX z-video', 'NFX w-video']);
    }
  });

  it('a deletion check that stalls withdraws nothing and holds nothing past the grace (CodeRabbit, #157)', async () => {
    const t = twoPools();
    const a = new kit.TestSigner();
    t.scoped.store(await kit.sign(a, nfxDraft('scoped-clip', 2)));
    t.pub.store(await kit.sign(a, nfxDraft('public-clip', 1)));
    const query = t.scoped.query.bind(t.scoped);
    // The scoped relay answers its own reads, but never the check for the public relays' video.
    vi.spyOn(t.scoped, 'query').mockImplementation((relays, filter) =>
      (filter as { readonly '#a'?: readonly string[] })['#a']?.includes(
        addr(a.pubkey, 'public-clip'),
      ) === true
        ? new Promise<never>(() => undefined)
        : query(relays, filter),
    );
    const cat = scopedCatalog(t, 20);
    expect(titles(await cat.feed({ source: 'author', author: a.pubkey }, null))).toEqual([
      'NFX public-clip',
      'NFX scoped-clip',
    ]);
    expect(titles(await cat.feed({ source: 'network' }, null))).toEqual([
      'NFX public-clip',
      'NFX scoped-clip',
    ]);
    expect((await cat.video(addr(a.pubkey, 'public-clip')))?.title).toBe('NFX public-clip');
  });

  it('a relay set that never answers does not hold a read the other already answered in full (the grace)', async () => {
    const hang = (): Promise<never> => new Promise<never>(() => undefined);
    // The public relays hang (an unreachable relay before its connect timeout): a full scoped page answers.
    const t = twoPools();
    const a = new kit.TestSigner();
    t.scoped.store(await kit.sign(a, nfxDraft('scoped-clip', 1)));
    vi.spyOn(t.pub, 'query').mockImplementation(hang);
    const cat = scopedCatalog(t, 20);
    expect(titles(await cat.feed({ source: 'author', author: a.pubkey, limit: 1 }, null))).toEqual([
      'NFX scoped-clip',
    ]);
    expect((await cat.video(addr(a.pubkey, 'scoped-clip')))?.title).toBe('NFX scoped-clip');
    // The scoped relay hangs (its host unreachable, 2026-11-26): the public relays answer alone.
    const u = twoPools();
    u.pub.store(await kit.sign(a, nfxDraft('public-clip', 1)));
    vi.spyOn(u.scoped, 'query').mockImplementation(hang);
    const cat2 = scopedCatalog(u, 20);
    expect(titles(await cat2.feed({ source: 'author', author: a.pubkey, limit: 1 }, null))).toEqual(
      ['NFX public-clip'],
    );
    expect((await cat2.video(addr(a.pubkey, 'public-clip')))?.title).toBe('NFX public-clip');
  });

  it('the scoped relays down or timing out with an error: the public relays answer alone', async () => {
    const t = twoPools();
    const creator = new kit.TestSigner();
    t.pub.store(await kit.sign(creator, nfxDraft('public-copy', 1)));
    const down = vi.spyOn(t.scoped, 'query').mockRejectedValue(new Error('timed out'));
    const cat = scopedCatalog(t);
    expect(titles(await cat.feed({ source: 'author', author: creator.pubkey }, null))).toEqual([
      'NFX public-copy',
    ]);
    expect(titles(await cat.feed({ source: 'tags', tags: ['space'] }, null))).toEqual([
      'NFX public-copy',
    ]);
    expect((await cat.video(addr(creator.pubkey, 'public-copy')))?.title).toBe('NFX public-copy');
    expect(down).toHaveBeenCalled();
    expect(askedScoped(t)).toBe(true);
  });

  it('the scoped relays empty (restarted in-memory, or nothing before the wait ran out): the public pages, cursor and all', async () => {
    const t = twoPools();
    const creator = new kit.TestSigner();
    t.pub.store(await kit.sign(creator, nfxDraft('public-one', 1)));
    t.pub.store(await kit.sign(creator, nfxDraft('public-two', 2)));
    const cat = scopedCatalog(t);
    const first = await cat.feed({ source: 'tags', tags: ['space'], limit: 1 }, null);
    expect(titles(first)).toEqual(['NFX public-one']);
    expect(first.next).toBeDefined();
    const second = await cat.feed(
      { source: 'tags', tags: ['space'], limit: 1, cursor: first.next! },
      null,
    );
    expect(titles(second)).toEqual(['NFX public-two']);
    expect(askedScoped(t)).toBe(true);
    expect(askedPublic(t)).toBe(true);
  });

  it('a short scoped page (a relay partly refilled) is merged with the public one: one per address, the newest revision, newest first, the limit kept', async () => {
    const t = twoPools();
    const a = new kit.TestSigner();
    t.scoped.store(await kit.sign(a, nfxDraft('clip-one', 1)));
    t.scoped.store(await kit.sign(a, nfxDraft('clip-three', 3))); // an older revision
    t.pub.store(await kit.sign(a, nfxDraft('clip-two', 2)));
    t.pub.store(await kit.sign(a, nfxDraft('clip-three', 2.5))); // the newer one
    t.pub.store(await kit.sign(a, nfxDraft('clip-four', 4)));
    const page = await scopedCatalog(t).feed(
      { source: 'author', author: a.pubkey, limit: 3 },
      null,
    );
    expect(titles(page)).toEqual(['NFX clip-one', 'NFX clip-two', 'NFX clip-three']);
    expect(page.items[2]!.event.created_at).toBe(mocks.FIXTURE_NOW - 2.5 * HOUR);
    expect(page.next).toBeDefined(); // clip-four is still to come
    expect(askedScoped(t)).toBe(true);
    expect(askedPublic(t)).toBe(true);
  });

  it('pages across a partly refilled scoped relay lose and repeat nothing', async () => {
    const t = twoPools();
    const a = new kit.TestSigner();
    // The scoped relay holds the newest three again; the public relays hold all but the newest.
    const clips = ['clip-one', 'clip-two', 'clip-three', 'clip-four', 'clip-five'];
    for (const [i, id] of clips.entries()) {
      const ev = await kit.sign(a, nfxDraft(id, i + 1));
      if (i < 3) t.scoped.store(ev);
      if (i > 0) t.pub.store(ev);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 8; i++) {
      const page = await scopedCatalog(t).feed(
        {
          source: 'author',
          author: a.pubkey,
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        },
        null,
      );
      seen.push(...titles(page));
      cursor = page.next;
      if (cursor === undefined) break;
    }
    expect(seen).toEqual(clips.map((id) => `NFX ${id}`));
  });

  it('the scoped copy wins a tie: the same address and second on both, even with the higher id', async () => {
    const t = twoPools();
    const a = new kit.TestSigner();
    const scopedCopy = await kit.sign(a, nfxDraft('tie-clip', 2));
    t.scoped.store(scopedCopy);
    t.pub.store(await lowerIdTwin(a, scopedCopy, 'tie-clip', 2));
    t.pub.store(await kit.sign(a, nfxDraft('public-clip', 3)));
    const page = await scopedCatalog(t).feed({ source: 'author', author: a.pubkey }, null);
    expect(titles(page)).toEqual(['NFX tie-clip', 'NFX public-clip']);
    expect(page.items[0]!.eventId).toBe(scopedCopy.id);
  });

  it('the public relays failing too: a short scoped page stands; with nothing scoped, their error', async () => {
    const t = twoPools();
    const a = new kit.TestSigner();
    t.scoped.store(await kit.sign(a, nfxDraft('scoped-clip', 1)));
    vi.spyOn(t.pub, 'query').mockRejectedValue(new Error('public down'));
    const cat = scopedCatalog(t);
    expect(titles(await cat.feed({ source: 'author', author: a.pubkey }, null))).toEqual([
      'NFX scoped-clip',
    ]);
    const nobody = new kit.TestSigner();
    await expect(cat.feed({ source: 'author', author: nobody.pubkey }, null)).rejects.toThrow(
      'public down',
    );
    await expect(cat.video(addr(nobody.pubkey, 'missing'))).rejects.toThrow('public down');
  });

  it('video(): both relay sets at once; the newest revision either holds, the scoped copy on a tie', async () => {
    const t = twoPools();
    const a = new kit.TestSigner();
    const both = await kit.sign(a, nfxDraft('on-both', 1));
    t.scoped.store(both);
    t.pub.store(both);
    t.pub.store(await kit.sign(a, nfxDraft('public-only', 2)));
    t.scoped.store(await kit.sign(a, nfxDraft('newer-public', 3)));
    const newer = await kit.sign(a, nfxDraft('newer-public', 1));
    t.pub.store(newer);
    const cat = scopedCatalog(t);
    expect((await cat.video(addr(a.pubkey, 'on-both')))?.eventId).toBe(both.id);
    expect(askedScoped(t)).toBe(true);
    expect(askedPublic(t)).toBe(true);
    expect((await cat.video(addr(a.pubkey, 'public-only')))?.title).toBe('NFX public-only');
    expect((await cat.video(addr(a.pubkey, 'newer-public')))?.eventId).toBe(newer.id);
    expect(await cat.video(addr(a.pubkey, 'nowhere'))).toBeNull();
  });

  it('twinsOf asks the scoped relays only, which every feed page reads; without any, the read relays', async () => {
    const t = twoPools();
    const a = new kit.TestSigner();
    const legacyId = 'ab'.repeat(32) as NostrEventId;
    t.scoped.store(await kit.sign(a, nfxDraft('scoped-twin', 1, [['e', legacyId]])));
    t.pub.store(await kit.sign(a, nfxDraft('public-twin', 1, [['e', legacyId]])));
    const legacy = [{ id: legacyId, author: a.pubkey }];
    expect(titles({ items: await scopedCatalog(t).twinsOf(legacy) })).toEqual(['NFX scoped-twin']);
    expect(askedPublic(t)).toBe(false);
    const unscoped = new NfxCatalog(
      () => t.client,
      NS,
      () => [],
    );
    expect(titles({ items: await unscoped.twinsOf(legacy) })).toEqual(['NFX public-twin']);
  });

  it('reads only: it never publishes or subscribes (beacons and manifest publishing are unchanged, elsewhere)', async () => {
    const t = twoPools();
    const a = new kit.TestSigner();
    t.scoped.store(await kit.sign(a, nfxDraft('scoped-clip', 1)));
    const spies = [t.pub, t.scoped].flatMap((p) => [
      vi.spyOn(p, 'publish'),
      vi.spyOn(p, 'subscribe'),
    ]);
    const cat = scopedCatalog(t);
    await cat.feed({ source: 'author', author: a.pubkey }, null);
    await cat.feed({ source: 'tags', tags: ['space'] }, null);
    await cat.feed({ source: 'network' }, null);
    await cat.search({ text: 'scoped' });
    await cat.video(addr(a.pubkey, 'scoped-clip'));
    await cat.twinsOf([{ id: 'cd'.repeat(32) as NostrEventId, author: a.pubkey }]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
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

    it('the scoped copy wins a tie, even with the higher id', async () => {
      const t = twoPools();
      const a = new kit.TestSigner();
      const scopedCopy = await kit.sign(a, nfxDraft('tie-clip', 2));
      t.scoped.store(scopedCopy);
      t.pub.store(await lowerIdTwin(a, scopedCopy, 'tie-clip', 2));
      const page = await catalog(t).feed({ source: 'network' }, null);
      expect(page.items.map((v) => v.eventId)).toEqual([scopedCopy.id]);
    });

    it('two short pages longer together than the limit keep a cursor: nothing is dropped', async () => {
      const t = twoPools();
      const a = new kit.TestSigner();
      for (const [id, hours, pool] of [
        ['clip-one', 1, t.scoped],
        ['clip-two', 2, t.pub],
        ['clip-three', 3, t.scoped],
        ['clip-four', 4, t.pub],
        ['clip-five', 5, t.pub],
      ] as const)
        pool.store(await kit.sign(a, nfxDraft(id, hours)));
      expect(await pages(catalog(t), 4)).toEqual([
        ['NFX clip-one', 'NFX clip-two', 'NFX clip-three', 'NFX clip-four'],
        ['NFX clip-five'],
      ]);
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
