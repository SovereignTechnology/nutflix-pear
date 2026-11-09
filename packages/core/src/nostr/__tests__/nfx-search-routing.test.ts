/**
 * Search on stock relays (ADR 0022): NIP-11 decides where `search` goes. A relay that lists NIP-50
 * gets the `search` filter; any other gets a plain `kinds: [38504], #n` query, matched here on
 * title, description and tags, and the two are merged by address. Each relay is a FakeRelayPool of
 * its own, so what each one was asked is on record.
 */
import { describe, expect, it, vi } from 'vitest';

import type { NostrEvent, NostrFilter, RelayUrl, UnixSeconds } from '../../contracts/index.js';
import { NostrClient } from '../client.js';
import { FakeRelayPool } from '../fake-relay.js';
import { NfxCatalog } from '../nfx-catalog.js';
import { nfxVideoMatchesText, scanNfxVideos, searchNfxVideosRouted } from '../nfx-feeds.js';
import { RelaySearchSupport, nip11Url, relayInfoSupportsSearch } from '../relay-info.js';
import type { PoolLike } from '../types.js';
import { T0, TestSigner, sign } from './helpers.js';

const NS = 'nfx:testnet:1';
const SEARCHING = 'wss://search.test' as RelayUrl;
const STOCK = 'wss://stock.test' as RelayUrl;
const SCOPED = 'wss://scoped.test' as RelayUrl;

function manifest(
  videoId: string,
  createdAt: number,
  title: string,
  description = `About ${title}.`,
  tags: readonly string[] = ['space'],
) {
  return {
    kind: 38504,
    created_at: createdAt,
    content: description,
    tags: [
      ['d', `${NS}:${videoId}`],
      ['n', NS],
      ['title', title],
      ['published_at', String(createdAt)],
      ['license', 'open'],
      ['root', 'ab'.repeat(32)],
      ['segs', '4'],
      ['duration', '61'],
      ...tags.map((t) => ['t', t]),
    ],
  };
}

/** One FakeRelayPool per relay URL; every query is recorded with the relay it went to. */
function relays(urls: readonly RelayUrl[]): {
  readonly pool: PoolLike;
  readonly of: (url: RelayUrl) => FakeRelayPool;
  readonly asked: { readonly relay: RelayUrl; readonly filter: NostrFilter }[];
} {
  const pools = new Map(urls.map((u) => [u, new FakeRelayPool()]));
  const asked: { relay: RelayUrl; filter: NostrFilter }[] = [];
  const of = (url: RelayUrl): FakeRelayPool => {
    const p = pools.get(url);
    if (p === undefined) throw new Error(`no relay ${url}`);
    return p;
  };
  const pool: PoolLike = {
    async query(rs, filter) {
      const out: unknown[] = [];
      for (const r of rs) {
        asked.push({ relay: r, filter });
        out.push(...(await of(r).query([r], filter)));
      }
      return out;
    },
    subscribe: () => () => undefined,
    publish: () => Promise.resolve([]),
    close: () => undefined,
  };
  return { pool, of, asked };
}

function client(pool: PoolLike, read: readonly RelayUrl[]): NostrClient {
  return new NostrClient({
    pool,
    relays: read.map((url) => ({ url, read: true, write: false })),
    now: () => (T0 + 10) as UnixSeconds,
  });
}

const nip50 =
  (yes: readonly RelayUrl[]) =>
  (relay: RelayUrl): Promise<boolean> =>
    Promise.resolve(yes.includes(relay));

async function store(pool: FakeRelayPool, signer: TestSigner, draft: ReturnType<typeof manifest>) {
  const ev: NostrEvent = await sign(signer, draft);
  pool.store(ev);
  return ev;
}

describe('NIP-11', () => {
  it('maps a relay to its NIP-11 address, and reads NIP-50 from supported_nips', () => {
    expect(nip11Url('wss://relay.example')).toBe('https://relay.example');
    expect(nip11Url('wss://relay.example:444/path')).toBe('https://relay.example:444/path');
    expect(nip11Url('ws://127.0.0.1:7777')).toBe('http://127.0.0.1:7777');
    expect(nip11Url('https://relay.example')).toBeNull();
    expect(relayInfoSupportsSearch({ supported_nips: [1, 11, 50] })).toBe(true);
    expect(relayInfoSupportsSearch({ supported_nips: [1, 11] })).toBe(false);
    expect(relayInfoSupportsSearch({ supported_nips: ['50'] })).toBe(false);
    expect(relayInfoSupportsSearch({ supported_nips: 50 })).toBe(false);
    expect(relayInfoSupportsSearch(null)).toBe(false);
    expect(relayInfoSupportsSearch([50])).toBe(false);
  });

  it('asks each relay once while its answer lasts, shares a probe in flight, and counts failure as no', async () => {
    let t = 0;
    const docs: Record<string, unknown> = {
      'https://search.test': { supported_nips: [1, 50] },
      'https://stock.test': { supported_nips: [1, 11] },
    };
    const fetchInfo = vi.fn((url: string) =>
      url in docs ? Promise.resolve(docs[url]) : Promise.reject(new Error('refused')),
    );
    const s = new RelaySearchSupport(fetchInfo, { ttlMs: 1000, failureTtlMs: 100, now: () => t });
    const [a, b] = await Promise.all([s.supports(SEARCHING), s.supports(SEARCHING)]);
    expect([a, b]).toEqual([true, true]);
    expect(await s.supports(STOCK)).toBe(false);
    expect(await s.supports('wss://down.test' as RelayUrl)).toBe(false);
    expect(fetchInfo).toHaveBeenCalledTimes(3);
    t = 500;
    await s.supports(SEARCHING);
    await s.supports('wss://down.test' as RelayUrl); // the failure has expired: asked again
    expect(fetchInfo).toHaveBeenCalledTimes(4);
    t = 1500;
    await s.supports(SEARCHING);
    expect(fetchInfo).toHaveBeenCalledTimes(5);
  });

  it('a probe that never answers counts as no after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const s = new RelaySearchSupport(() => new Promise(() => undefined), { timeoutMs: 50 });
      const answer = s.supports(SEARCHING);
      await vi.advanceTimersByTimeAsync(60);
      await expect(answer).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('search routed by NIP-50 support', () => {
  it('sends `search` only to NIP-50 relays; a stock relay gets kinds + #n and is matched here', async () => {
    const r = relays([SEARCHING, STOCK]);
    const creator = new TestSigner();
    const onSearch = await store(
      r.of(SEARCHING),
      creator,
      manifest('video-0001', T0 - 30, 'Lagrange points'),
    );
    const onStock = await store(
      r.of(STOCK),
      creator,
      manifest('video-0002', T0 - 20, 'Orbits', 'Where Lagrange put the points.'),
    );
    await store(r.of(STOCK), creator, manifest('video-0003', T0 - 10, 'Cooking'));
    const c = client(r.pool, [SEARCHING, STOCK]);
    const page = await searchNfxVideosRouted(
      c,
      NS,
      'lagrange',
      {},
      { supports: nip50([SEARCHING]) },
    );
    expect(page.items.map((v) => v.eventId)).toEqual([onStock.id, onSearch.id]);
    const manifests = r.asked.filter((a) => a.filter.kinds?.includes(38504) === true);
    for (const a of manifests.filter((x) => x.relay === STOCK)) {
      expect(a.filter.search).toBeUndefined();
      expect(a.filter['#n']).toEqual([NS]);
    }
    expect(
      manifests.filter((x) => x.relay === SEARCHING).every((a) => a.filter.search === 'lagrange'),
    ).toBe(true);
  });

  it('merges by address, the newest revision winning, whichever relay held it', async () => {
    const r = relays([SEARCHING, STOCK]);
    const creator = new TestSigner();
    await store(r.of(SEARCHING), creator, manifest('video-0001', T0 - 30, 'Lagrange, first cut'));
    const newer = await store(
      r.of(STOCK),
      creator,
      manifest('video-0001', T0 - 5, 'Lagrange, recut'),
    );
    const c = client(r.pool, [SEARCHING, STOCK]);
    const page = await searchNfxVideosRouted(
      c,
      NS,
      'Lagrange',
      {},
      { supports: nip50([SEARCHING]) },
    );
    expect(page.items.map((v) => v.eventId)).toEqual([newer.id]);
  });

  it('matches every word, case-insensitively, in the title, the description or a tag', async () => {
    const r = relays([STOCK]);
    const creator = new TestSigner();
    const byTag = await store(
      r.of(STOCK),
      creator,
      manifest('video-0001', T0 - 3, 'Untitled', 'x', ['orbital', 'mechanics']),
    );
    const byText = await store(
      r.of(STOCK),
      creator,
      manifest('video-0002', T0 - 2, 'ORBITAL', 'Some mechanics.'),
    );
    await store(r.of(STOCK), creator, manifest('video-0003', T0 - 1, 'Orbital only'));
    const c = client(r.pool, [STOCK]);
    const page = await searchNfxVideosRouted(
      c,
      NS,
      '  orbital   MECHANICS ',
      {},
      { supports: nip50([]) },
    );
    expect(page.items.map((v) => v.eventId)).toEqual([byText.id, byTag.id]);
    expect(r.asked.every((a) => a.filter.search === undefined)).toBe(true);
    const v = page.items[0]!;
    expect(nfxVideoMatchesText(v, '')).toBe(false);
  });

  it('a stock relay page with few matches still leads on to older ones', async () => {
    const r = relays([STOCK]);
    const creator = new TestSigner();
    const old = await store(r.of(STOCK), creator, manifest('video-old0001', T0 - 5000, 'Needle'));
    for (let i = 0; i < 100; i++)
      await store(
        r.of(STOCK),
        creator,
        manifest(`video-hay${String(i).padStart(4, '0')}`, T0 - 1000 + i, 'Hay'),
      );
    const c = client(r.pool, [STOCK]);
    const first = await scanNfxVideos(c, NS, 'needle', {}, { limit: 5 });
    expect(first.items).toEqual([]);
    expect(first.next).toBeDefined();
    const second = await scanNfxVideos(c, NS, 'needle', {}, { limit: 5, cursor: first.next });
    expect(second.items.map((v) => v.eventId)).toEqual([old.id]);
    expect(second.next).toBeUndefined();
  });

  it("fails only when every relay set does; one that fails leaves the other's results", async () => {
    const r = relays([SEARCHING, STOCK]);
    const creator = new TestSigner();
    const hit = await store(r.of(STOCK), creator, manifest('video-0001', T0 - 5, 'Lagrange'));
    const broken: PoolLike = {
      ...r.pool,
      query: (rs, f) =>
        rs.includes(SEARCHING) ? Promise.reject(new Error('relay-down')) : r.pool.query(rs, f),
    };
    const page = await searchNfxVideosRouted(
      client(broken, [SEARCHING, STOCK]),
      NS,
      'lagrange',
      {},
      {
        supports: nip50([SEARCHING]),
      },
    );
    expect(page.items.map((v) => v.eventId)).toEqual([hit.id]);
    const down: PoolLike = { ...r.pool, query: () => Promise.reject(new Error('relay-down')) };
    await expect(
      searchNfxVideosRouted(
        client(down, [SEARCHING, STOCK]),
        NS,
        'lagrange',
        {},
        { supports: nip50([SEARCHING]) },
      ),
    ).rejects.toThrow('relay-down');
  });

  it('NfxCatalog routes search the same way on the read relays, then on the scoped relays', async () => {
    const r = relays([SEARCHING, STOCK, SCOPED]);
    const creator = new TestSigner();
    const onScoped = await store(r.of(SCOPED), creator, manifest('video-0001', T0 - 5, 'Lagrange'));
    const supports = vi.fn(nip50([SEARCHING]));
    const c = client(r.pool, [SEARCHING, STOCK]);
    const cat = new NfxCatalog(
      () => c,
      NS,
      () => [SCOPED],
      { searchSupport: supports },
    );
    const page = await cat.search({ text: 'lagrange' });
    expect(page.items.map((v) => v.eventId)).toEqual([onScoped.id]);
    expect(supports.mock.calls.map(([u]) => u).sort()).toEqual([SCOPED, SEARCHING, STOCK].sort());
    expect(
      r.asked
        .filter((a) => a.relay !== SEARCHING && a.filter.kinds?.includes(38504) === true)
        .every((a) => a.filter.search === undefined),
    ).toBe(true);
  });

  it('without searchSupport, NfxCatalog sends `search` everywhere, as before', async () => {
    const r = relays([SEARCHING, STOCK]);
    const c = client(r.pool, [SEARCHING, STOCK]);
    await new NfxCatalog(
      () => c,
      NS,
      () => [],
    ).search({ text: 'lagrange' });
    const manifests = r.asked.filter((a) => a.filter.kinds?.includes(38504) === true);
    expect(manifests.map((a) => a.relay).sort()).toEqual([SEARCHING, STOCK].sort());
    expect(manifests.every((a) => a.filter.search === 'lagrange')).toBe(true);
  });
});
