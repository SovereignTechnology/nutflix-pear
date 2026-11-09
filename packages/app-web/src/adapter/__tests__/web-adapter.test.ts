/**
 * The web adapter (ADR 0022) against per-relay fake relays (core's `FakeRelayPool`), fake NIP-11
 * documents and the fake player: the method table (served, read-only, empty, `unsupported`), the
 * network feed's merge, NIP-50 routing by NIP-11, images by signed sha256 only, and `playNfx`
 * handing the player exactly the endpoints it resolved.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type {
  NetworkAdapter,
  NfxAddress,
  NostrEventId,
  NostrPubkey,
  Sha256Hex,
  TrackerUrl,
} from '@sovit/core';

import {
  Key,
  NS,
  READ_A,
  READ_B,
  SCOPED,
  T,
  addrOf,
  beacon,
  https,
  manifest,
  put,
  rig,
  settingsWith,
  storeWith,
  tick,
  webrtc,
  type Rig,
} from '../../__tests__/support/nfx.js';
import { WebAdapterError } from '../../errors.js';
import { WEB_FALLBACK_ORIGIN, WEB_TRACKER } from '../../settings/defaults.js';
import type { FetchFn } from '../http.js';
import { AUTO_RENDITION, WebNfxSession } from '../session.js';
import { WebNetworkAdapter } from '../web-adapter.js';

const rigs: Rig[] = [];
function make(o: Parameters<typeof rig>[0] = {}): Rig {
  const r = rig(o);
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.adapter.close();
});

async function rejection(p: Promise<unknown>): Promise<WebAdapterError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WebAdapterError) return e;
    throw e;
  }
  throw new Error('resolved');
}

const ID = 'ee'.repeat(32) as NostrEventId;
const PK = 'dd'.repeat(32) as NostrPubkey;

describe('the method table (ADR 0022)', () => {
  it("platform 'web', signed out", async () => {
    const { adapter } = make();
    expect(adapter.platform).toBe('web');
    expect(await adapter.me()).toBeNull();
    expect(await adapter.signer()).toMatchObject({ pubkey: null, locked: false });
  });

  it('what has nothing to show here resolves empty', async () => {
    const r = make();
    const relays = r.relays;
    const adapter: NetworkAdapter = r.adapter;
    for (const source of ['subscriptions', 'trending', 'shorts'] as const) {
      expect(await adapter.feed({ source })).toEqual({ items: [] });
    }
    expect(relays.asked).toEqual([]);
    expect(await adapter.related(ID)).toEqual([]);
    expect(await adapter.stats(ID)).toEqual({
      paidViews: 0,
      satsToCreator: 0,
      reactions: 0,
      likes: 0,
      dislikes: 0,
      comments: 0,
    });
    expect((await adapter.stats(ID)).seedersOnline).toBeUndefined();
    expect(await adapter.subscriptions()).toEqual([]);
    expect(await adapter.library.history()).toEqual({ items: [] });
    expect(await adapter.library.watchLater()).toEqual([]);
    expect(await adapter.library.playlists()).toEqual([]);
    expect(await adapter.library.liked()).toEqual([]);
    await expect(adapter.library.recordProgress(ID, 3)).resolves.toBeUndefined();
    const off = adapter.notifications(() => {
      throw new Error('never');
    });
    off();
    adapter.seeder.onStatus(() => {
      throw new Error('never');
    })();
    adapter.wallet.onChange(() => {
      throw new Error('never');
    })();
  });

  it('every call that needs a wallet, a signer, Hypercore or Studio rejects unsupported', async () => {
    const a: NetworkAdapter = make().adapter;
    const MINT = 'https://mint.example' as never;
    const calls: [string, () => Promise<unknown>][] = [
      ['play', () => a.play(ID)],
      [
        'setProfilePicture',
        () => a.setProfilePicture({ bytes: new Uint8Array(1), type: 'image/png' }),
      ],
      ['comment', () => a.comment(ID, 'hi')],
      ['react', () => a.react(ID, '+')],
      ['unreact', () => a.unreact(ID)],
      ['nutzap', () => a.nutzap(ID, 21 as never, MINT)],
      ['subscribe', () => a.subscribe(PK)],
      ['unsubscribe', () => a.unsubscribe(PK)],
      ['report', () => a.report(ID, 'spam')],
      ['studio.upload', () => a.studio.upload({} as never, () => undefined)],
      ['studio.myVideos', () => a.studio.myVideos()],
      ['studio.analytics', () => a.studio.analytics(ID)],
      ['seeder.status', () => a.seeder.status()],
      ['seeder.setEnabled', () => a.seeder.setEnabled(true)],
      ['seeder.melt', () => a.seeder.melt(MINT, 'lnbc1')],
      ['seeder.unban', () => a.seeder.unban(PK)],
      ['library.setWatchLater', () => a.library.setWatchLater(ID, true)],
      [
        'library.savePlaylist',
        () => a.library.savePlaylist({ title: 'x', videoIds: [], isPrivate: false }),
      ],
      ['wallet.mints', () => a.wallet.mints()],
      ['wallet.balance', () => a.wallet.balance(MINT)],
      ['wallet.inputFeePpk', () => a.wallet.inputFeePpk(MINT)],
      ['wallet.balances', () => a.wallet.balances()],
      ['wallet.p2pkPubkey', () => a.wallet.p2pkPubkey()],
      ['wallet.mintQuote', () => a.wallet.mintQuote(MINT, 1 as never)],
      ['wallet.pollQuote', () => a.wallet.pollQuote({} as never)],
      ['wallet.send', () => a.wallet.send(1 as never, { p2pk: '02' as never, mint: MINT })],
      ['wallet.receive', () => a.wallet.receive({ mint: MINT, proofs: [] })],
      ['wallet.meltQuote', () => a.wallet.meltQuote(MINT, 'lnbc1')],
      ['wallet.melt', () => a.wallet.melt({} as never)],
      ['wallet.keyset', () => a.wallet.keyset(MINT, '00')],
      ['wallet.history', () => a.wallet.history()],
    ];
    for (const [name, call] of calls) {
      const e = await rejection(call());
      expect(e.code, name).toBe('unsupported');
      expect(e.message, name).toMatch(/^unsupported: /);
    }
  });

  it('arguments are checked whatever their type says', async () => {
    const { adapter } = make();
    expect((await rejection(adapter.profile('nope' as NostrPubkey))).code).toBe('invalid-argument');
    expect(await adapter.video('nope' as NostrEventId)).toBeNull();
    expect(await adapter.nfxVideo('38504:nope' as NfxAddress)).toBeNull();
    expect((await rejection(adapter.feed({ source: 'network', limit: 10_000 }))).code).toBe(
      'invalid-argument',
    );
    expect(
      (await rejection(adapter.feed({ source: 'network', cursor: 'x'.repeat(5000) }))).code,
    ).toBe('invalid-argument');
    expect(
      (await rejection(adapter.feed({ source: 'author', author: PK.slice(2) as NostrPubkey })))
        .code,
    ).toBe('invalid-argument');
    expect((await rejection(adapter.feed({ source: 'nope' } as never))).code).toBe(
      'invalid-argument',
    );
    expect((await rejection(adapter.search({ text: 1 } as never))).code).toBe('invalid-argument');
    expect((await rejection(adapter.comments(ID, 'hot' as never))).code).toBe('invalid-argument');
    expect((await rejection(adapter.comments('x' as NostrEventId, 'new'))).code).toBe(
      'invalid-argument',
    );
    // Another network's address, and a non-canonical spelling of ours.
    const creator = new Key();
    expect(
      await adapter.nfxVideo(`38504:${creator.pubkey}:nfx:mainnet:1:v` as NfxAddress),
    ).toBeNull();
    expect(
      await adapter.nfxVideo(`38504:${creator.pubkey.toUpperCase()}:${NS}:v` as NfxAddress),
    ).toBeNull();
  });

  it('no relay at all is relay-down', async () => {
    const r = make({ read: [], scoped: [] });
    expect((await rejection(r.adapter.feed({ source: 'network' }))).code).toBe('relay-down');
    expect((await rejection(r.adapter.profile(PK))).code).toBe('relay-down');
  });

  it('a relay that fails is relay-down, with nothing of the relay in the message', async () => {
    const r = make();
    const failing = {
      ...r.relays.pool,
      query: () => Promise.reject(new Error('ECONNRESET at 10.0.0.1')),
    };
    const store = storeWith(settingsWith([READ_A], []));
    const a = new WebNetworkAdapter({
      pool: failing,
      settings: store,
      player: r.player,
      fetch: () => Promise.reject(new Error('offline')),
      createObjectURL: () => 'blob:x',
      revokeObjectURL: () => undefined,
      now: () => T,
    });
    const e = await rejection(a.feed({ source: 'network' }));
    expect(e.message).toBe('relay-down: relay request failed');
  });
});

describe('feeds through core’s catalogue', () => {
  it('the network feed: scoped and read relays merged by address, the newest revision, newest first', async () => {
    const r = make({ read: [READ_A], scoped: [SCOPED] });
    const c = new Key();
    const v1old = manifest(c, 'video-01', { title: 'Old title', createdAt: T - 7200 });
    const v1new = manifest(c, 'video-01', { title: 'New title', createdAt: T - 600 });
    const v2 = manifest(c, 'video-02', { createdAt: T - 3600 });
    const v3 = manifest(new Key(), 'video-03', { createdAt: T - 100 });
    put(r.relays, [READ_A], v1old, v2);
    put(r.relays, [SCOPED], v1new, v3);
    const page = await r.adapter.feed({ source: 'network', limit: 10 });
    expect(page.items.map((v) => [v.id, v.title])).toEqual([
      [addrOf(v3.pubkey, 'video-03'), 'video-03'],
      [addrOf(c, 'video-01'), 'New title'],
      [addrOf(c, 'video-02'), 'video-02'],
    ]);
    expect(new Set(r.relays.asked.map((q) => q.relay))).toEqual(new Set([READ_A, SCOPED]));
  });

  it('author and tag feeds read the read relays first, the scoped relays when they have nothing', async () => {
    const r = make({ read: [READ_A], scoped: [SCOPED] });
    const c = new Key();
    put(r.relays, [SCOPED], manifest(c, 'only-scoped', { tags: ['space'] }));
    expect(
      (await r.adapter.feed({ source: 'author', author: c.pubkey as NostrPubkey })).items,
    ).toHaveLength(1);
    expect((await r.adapter.feed({ source: 'tags', tags: ['space'] })).items).toHaveLength(1);
    expect(r.relays.asked[0]?.relay).toBe(READ_A);
    expect(r.relays.asked.some((q) => q.relay === SCOPED)).toBe(true);
  });

  it('nfxVideo: the current revision, and the video’s beacons watched from then on', async () => {
    const r = make();
    const c = new Key();
    put(r.relays, [READ_A], manifest(c, 'video-01', { title: 'Watch me' }));
    const v = await r.adapter.nfxVideo(addrOf(c, 'video-01'));
    expect(v?.title).toBe('Watch me');
    expect(await r.adapter.nfxVideo(addrOf(c, 'missing'))).toBeNull();
  });
});

describe('search: NIP-50 only where NIP-11 lists it (ADR 0022)', () => {
  it('a NIP-50 relay gets `search`; a stock relay a plain query matched here; merged by address', async () => {
    const r = make({
      read: [READ_A, READ_B],
      scoped: [SCOPED],
      nip11: {
        [READ_A]: { name: 'searching', supported_nips: [1, 11, 50] },
        [READ_B]: { name: 'stock', supported_nips: [1, 11] },
      },
    });
    const c = new Key();
    const both = manifest(c, 'jupiter', { title: 'Orbits of Jupiter' });
    put(r.relays, [READ_A], both, manifest(c, 'cooking-a', { title: 'Cooking' }));
    put(
      r.relays,
      [READ_B],
      both,
      manifest(c, 'dusk-video', { title: 'Dusk', description: 'Long orbits at dusk.' }),
      manifest(c, 'cooking-b', { title: 'More cooking' }),
      manifest(c, 'tagged-video', { title: 'Tagged', tags: ['orbits'] }),
    );
    const page = await r.adapter.search({ text: 'orbits' });
    expect(page.items.map((v) => v.id).sort()).toEqual(
      [addrOf(c, 'jupiter'), addrOf(c, 'dusk-video'), addrOf(c, 'tagged-video')].sort(),
    );
    // Manifest reads (kind 38504); the deletion reads that follow carry no `search` anywhere.
    const manifests = r.relays.asked.filter((q) => q.filter.kinds?.includes(38504) === true);
    const toA = manifests.filter((q) => q.relay === READ_A);
    const toB = manifests.filter((q) => q.relay === READ_B);
    expect(
      r.relays.asked.filter((q) => q.filter.search !== undefined).every((q) => q.relay === READ_A),
    ).toBe(true);
    expect(toA.length).toBeGreaterThan(0);
    expect(toA.every((q) => q.filter.search === 'orbits')).toBe(true);
    expect(toB.length).toBeGreaterThan(0);
    expect(toB.every((q) => q.filter.search === undefined)).toBe(true);
    expect(toB[0]?.filter).toMatchObject({ kinds: [38504], '#n': [NS] });
    // The NIP-11 requests: the relays' https addresses, as the spec asks, and nothing more.
    const urls = r.fetches.map((f) => f.url).sort();
    expect(urls).toEqual(['https://read-a.example', 'https://read-b.example']);
    for (const f of r.fetches) {
      expect(f.init).toMatchObject({
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { accept: 'application/nostr+json' },
      });
    }
    // Asked once per relay: the answers are cached.
    await r.adapter.search({ text: 'dusk' });
    expect(r.fetches).toHaveLength(2);
  });

  it('a relay whose NIP-11 is missing, not JSON or too large is never sent `search`', async () => {
    const big = new Uint8Array(70 * 1024).fill(0x20);
    const fetchFn: FetchFn = (url) =>
      Promise.resolve(
        url === 'https://read-a.example'
          ? new Response('{not json', { status: 200 })
          : new Response(big, { status: 200 }),
      );
    const r = make({ read: [READ_A, READ_B], scoped: [], fetch: fetchFn });
    const c = new Key();
    put(r.relays, [READ_A, READ_B], manifest(c, 'jupiter', { title: 'Orbits of Jupiter' }));
    const page = await r.adapter.search({ text: 'jupiter' });
    expect(page.items).toHaveLength(1);
    expect(r.relays.asked.every((q) => q.filter.search === undefined)).toBe(true);
  });
});

describe('profiles, NIP-71 reads', () => {
  it('a profile from the read relays, signature checked; a NIP-71 video and its thread read-only', async () => {
    const r = make();
    const k = new Key();
    put(
      r.relays,
      [READ_A],
      k.sign({ kind: 0, created_at: T - 10, tags: [], content: JSON.stringify({ name: 'Alice' }) }),
    );
    expect((await r.adapter.profile(k.pubkey as NostrPubkey))?.name).toBe('Alice');
    expect(await r.adapter.profile(PK)).toBeNull();
    expect(await r.adapter.video(ID)).toBeNull();
    expect(await r.adapter.comments(ID, 'new')).toEqual({ items: [] });
  });
});

describe('image(): https only, sha256-verified, then a blob: URL', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
  const sha = async (b: Uint8Array): Promise<Sha256Hex> =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource)), (x) =>
      x.toString(16).padStart(2, '0'),
    ).join('') as Sha256Hex;

  function serving(
    body: Uint8Array,
    headers: Record<string, string> = {},
  ): {
    readonly fetch: FetchFn;
    readonly calls: { url: string; init: RequestInit }[];
  } {
    const calls: { url: string; init: RequestInit }[] = [];
    return {
      calls,
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(
          new Response(body as BodyInit, {
            status: 200,
            headers: { 'content-type': 'image/svg+xml', ...headers },
          }),
        );
      },
    };
  }

  it('bytes that match: a blob: URL of the sniffed type (never the server’s), cached by hash', async () => {
    const s = serving(PNG);
    const r = make({ fetch: s.fetch });
    const h = await sha(PNG);
    const url = await r.adapter.image('https://img.example/a.png?w=64', h);
    expect(url).toBe('blob:test/1');
    expect(r.blobs[0]?.type).toBe('image/png');
    expect(s.calls[0]?.init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    expect(await r.adapter.image('https://other.example/b.png', h)).toBe(url);
    expect(s.calls).toHaveLength(1);
    expect(await r.adapter.image('https://img.example/a.png', h, PNG.length)).toBe(url);
  });

  it('a hash mismatch: forbidden, and no blob', async () => {
    const s = serving(PNG);
    const r = make({ fetch: s.fetch });
    const e = await rejection(
      r.adapter.image('https://img.example/a.png', 'ab'.repeat(32) as Sha256Hex),
    );
    expect(e.code).toBe('forbidden');
    expect(e.message).toBe('forbidden: image hash mismatch');
    expect(r.blobs).toHaveLength(0);
  });

  it('matching bytes that are SVG (or anything else not a raster image): forbidden', async () => {
    const r = make({ fetch: serving(SVG).fetch });
    const e = await rejection(r.adapter.image('https://img.example/a.svg', await sha(SVG)));
    expect(e.message).toMatch(/^forbidden: not a JPEG, PNG, WebP or GIF/);
    expect(r.blobs).toHaveLength(0);
  });

  it('a signed size that does not match, or over the cap: forbidden', async () => {
    const r = make({ fetch: serving(PNG).fetch });
    const h = await sha(PNG);
    expect(
      (await rejection(r.adapter.image('https://img.example/a.png', h, PNG.length + 1))).code,
    ).toBe('forbidden');
    expect(
      (await rejection(r.adapter.image('https://img.example/a.png', h, 6 * 1024 * 1024))).code,
    ).toBe('forbidden');
    expect((await rejection(r.adapter.image('https://img.example/a.png', h, -1))).code).toBe(
      'invalid-argument',
    );
  });

  it('a body over the cap is cut off, not read: not-found', async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    const r = make({ fetch: serving(big).fetch });
    expect(
      (await rejection(r.adapter.image('https://img.example/a.png', 'ab'.repeat(32) as Sha256Hex)))
        .code,
    ).toBe('not-found');
  });

  it('nothing is fetched without a signed hash, over http, from a private host or Pear', async () => {
    const s = serving(PNG);
    const r = make({ fetch: s.fetch });
    const h = await sha(PNG);
    for (const [url, hash, code] of [
      ['https://img.example/a.png', undefined, 'forbidden'],
      ['https://img.example/a.png', 'AB'.repeat(32), 'invalid-argument'],
      ['http://img.example/a.png', h, 'forbidden'],
      ['https://192.168.1.1/a.png', h, 'forbidden'],
      ['https://localhost/a.png', h, 'forbidden'],
      ['https://user@img.example/a.png', h, 'forbidden'],
      [`hyper://${'a'.repeat(64)}/0-1`, h, 'forbidden'],
      ['data:image/png;base64,AAAA', h, 'forbidden'],
    ] as const) {
      const e = await rejection(r.adapter.image(url, hash as Sha256Hex | undefined));
      expect(e.code, url).toBe(code);
    }
    expect(s.calls).toHaveLength(0);
  });

  it('a server error or a refused request: not-found', async () => {
    const r = make({ fetch: () => Promise.resolve(new Response('x', { status: 500 })) });
    expect(
      (await rejection(r.adapter.image('https://img.example/a.png', 'ab'.repeat(32) as Sha256Hex)))
        .code,
    ).toBe('not-found');
    const r2 = make({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
    expect(
      (await rejection(r2.adapter.image('https://img.example/a.png', 'ab'.repeat(32) as Sha256Hex)))
        .message,
    ).toBe('not-found: image unavailable (request failed)');
  });
});

describe('settings through the adapter', () => {
  it('reads and writes; NFX stays on', async () => {
    const { adapter } = make();
    expect((await adapter.settings()).nfx?.enabled).toBe(true);
    expect((await adapter.updateSettings({ theme: 'dark' })).theme).toBe('dark');
    const e = await rejection(
      adapter.updateSettings({ nfx: { enabled: false, network: NS, scopedRelays: [] } }),
    );
    expect(e.code).toBe('invalid-argument');
    expect((await adapter.settings()).nfx?.enabled).toBe(true);
  });
});

describe('playNfx: beacons → endpoints → nfx’s player', () => {
  async function playable(r: Rig): Promise<{ addr: NfxAddress; creator: Key }> {
    const creator = new Key();
    put(r.relays, [READ_A], manifest(creator, 'free-video'));
    const addr = addrOf(creator, 'free-video');
    // The Watch page loads the video first, which opens its beacon subscription.
    await r.adapter.nfxVideo(addr);
    return { addr, creator };
  }

  it('hands the player exactly the resolved origins, trackers and ICE servers', async () => {
    const r = make();
    const { addr } = await playable(r);
    await r.adapter.updateSettings({
      nfx: {
        enabled: true,
        network: NS,
        scopedRelays: [SCOPED],
        trackers: [WEB_TRACKER, 'ws://127.0.0.1:8000/announce' as TrackerUrl],
      },
    });
    put(
      r.relays,
      [SCOPED],
      beacon(new Key(), addr, [
        https('https://seed-1.example/o/'),
        https('https://10.0.0.5/o'),
        webrtc('wss://bridge-1.example/announce', 'ws://bridge-1.example/announce'),
      ]),
      beacon(new Key(), addr, [
        https('https://seed-2.example/o'),
        webrtc('wss://bridge-2.example/announce', 'wss://bridge-3.example/announce'),
      ]),
    );
    const session = await r.adapter.playNfx(addr);
    expect(session.videoId).toBe(addr);
    expect(session.source.kind).toBe('element');
    expect(session.rendition).toBe(AUTO_RENDITION);
    expect(session.renditions).toEqual([]);
    const el = document.createElement('video');
    if (session.source.kind !== 'element') throw new Error('not an element source');
    const detach = session.source.attach(el);
    await tick();
    expect(r.player.inits).toEqual([{ wasmUrl: '/nfx/wasm/nfx_wasm_bg.wasm' }]);
    expect(r.player.opens).toHaveLength(1);
    const { el: given, options } = r.player.last;
    expect(given).toBe(el);
    const { onEvent, signal, manifestJson, ...rest } = options;
    expect(rest).toEqual({
      origins: ['https://seed-1.example/o', 'https://seed-2.example/o', WEB_FALLBACK_ORIGIN],
      signaling: {
        kind: 'trackers',
        urls: [
          WEB_TRACKER,
          'ws://127.0.0.1:8000/announce',
          'wss://bridge-1.example/announce',
          'wss://bridge-2.example/announce',
        ],
      },
      iceServers: [{ urls: ['stun:web.nutflix.xyz:3478'] }],
    });
    expect(typeof onEvent).toBe('function');
    expect(signal?.aborted).toBe(false);
    const signed = JSON.parse(manifestJson) as { kind: number; pubkey: string; sig: string };
    expect(signed.kind).toBe(38504);
    expect(signed.sig).toMatch(/^[0-9a-f]{128}$/);
    detach();
    expect(signal?.aborted).toBe(true);
    expect(r.player.last.session.destroyed).toBe(1);
    await session.close();
  });

  it('with no tracker anywhere the player gets no signalling (every byte from an origin)', async () => {
    const r = make();
    const { addr } = await playable(r);
    await r.adapter.updateSettings({ nfx: { enabled: true, network: NS, scopedRelays: [SCOPED] } });
    put(r.relays, [SCOPED], beacon(new Key(), addr, [https('https://seed.example/o')]));
    const session = await r.adapter.playNfx(addr);
    if (session.source.kind !== 'element') throw new Error('not an element source');
    session.source.attach(document.createElement('video'));
    await tick();
    expect(r.player.last.options.signaling).toBeUndefined();
    expect(r.player.last.options.origins).toEqual(['https://seed.example/o', WEB_FALLBACK_ORIGIN]);
    await session.close();
    expect(r.player.last.session.destroyed).toBe(1);
  });

  it('a beacon that arrives while the play waits opens it (beacons are never stored)', async () => {
    const r = make({ beaconWaitMs: 5_000 });
    const { addr } = await playable(r);
    const pending = r.adapter.playNfx(addr);
    await tick(20);
    put(r.relays, [SCOPED], beacon(new Key(), addr, [webrtc('wss://bridge.example/a')]));
    const session = await pending;
    if (session.source.kind !== 'element') throw new Error('not an element source');
    session.source.attach(document.createElement('video'));
    await tick();
    expect(r.player.last.options.signaling?.urls).toEqual([WEB_TRACKER, 'wss://bridge.example/a']);
    expect(r.player.last.options.origins).toEqual([WEB_FALLBACK_ORIGIN]);
  });

  it('no free beacon for this address: no-seeders (a paid one, another creator’s, another video’s)', async () => {
    const r = make({ beaconWaitMs: 50 });
    const { addr } = await playable(r);
    const other = new Key();
    put(
      r.relays,
      [SCOPED],
      beacon(new Key(), addr, [https('https://paid.example/o')], { free: false }),
      beacon(new Key(), addrOf(other, 'free-video'), [https('https://other.example/o')]),
    );
    const e = await rejection(r.adapter.playNfx(addr));
    expect(e.code).toBe('no-seeders');
    expect(e.message).toMatch(/^no-seeders: /);
    expect(r.adapter.openSessions).toBe(0);
  });

  it('a seeder this page cannot reach directly still means a play, from the fallback origin', async () => {
    const r = make({ beaconWaitMs: 50 });
    const { addr } = await playable(r);
    put(r.relays, [SCOPED], beacon(new Key(), addr, [https('https://192.168.0.9/o')]));
    const session = await r.adapter.playNfx(addr);
    if (session.source.kind !== 'element') throw new Error('not an element source');
    session.source.attach(document.createElement('video'));
    await tick();
    expect(r.player.last.options.origins).toEqual([WEB_FALLBACK_ORIGIN]);
  });

  it('beacons are read from the read relays when there is no scoped relay', async () => {
    const r = make({ scoped: [] });
    const { addr } = await playable(r);
    put(r.relays, [READ_A], beacon(new Key(), addr, [https('https://seed.example/o')]));
    const session = await r.adapter.playNfx(addr);
    expect(session.videoId).toBe(addr);
  });

  it('an unknown video is not-found; a bad address or rendition invalid-argument', async () => {
    const r = make();
    const c = new Key();
    expect((await rejection(r.adapter.playNfx(addrOf(c, 'missing')))).code).toBe('not-found');
    expect((await rejection(r.adapter.playNfx('38504:x' as NfxAddress))).code).toBe(
      'invalid-argument',
    );
    expect((await rejection(r.adapter.playNfx(addrOf(c, 'missing'), '720p'))).code).toBe(
      'invalid-argument',
    );
  });

  it('renditions are the player’s levels; setRendition is setLevel; a reopen starts on its level', async () => {
    const r = make();
    const { addr } = await playable(r);
    put(r.relays, [SCOPED], beacon(new Key(), addr, [https('https://seed.example/o')]));
    const session = await r.adapter.playNfx(addr);
    if (session.source.kind !== 'element') throw new Error('not an element source');
    session.source.attach(document.createElement('video'));
    await tick();
    const lib = r.player.last.session;
    lib.parsed([
      { index: 0, width: 640, height: 360, bitrate: 800_000 },
      { index: 1, width: 1280, height: 720, bitrate: 2_500_000 },
    ]);
    expect(session.renditions).toEqual([
      { id: 'l0', bandwidth: 800_000, resolution: '640x360' },
      { id: 'l1', bandwidth: 2_500_000, resolution: '1280x720' },
    ]);
    await session.setRendition?.('l1');
    expect(lib.setLevelCalls).toEqual([1]);
    expect(session.rendition).toBe('l1');
    expect((await rejection(session.setRendition!('l7'))).code).toBe('invalid-argument');
    expect((await rejection(session.setRendition!('720p'))).code).toBe('invalid-argument');
    await session.close();
    expect((await rejection(session.setRendition!('l0'))).code).toBe('session-closed');
    // NfxWatch's fallback: close and reopen on the rendition.
    put(r.relays, [SCOPED], beacon(new Key(), addr, [https('https://seed.example/o')]));
    const again = await r.adapter.playNfx(addr, 'l1');
    expect(again.rendition).toBe('l1');
    if (again.source.kind !== 'element') throw new Error('not an element source');
    again.source.attach(document.createElement('video'));
    await tick();
    expect(r.player.last.options.level).toBe(1);
    expect(again).toBeInstanceOf(WebNfxSession);
  });

  it('close() of the adapter closes every play', async () => {
    const r = make();
    const { addr } = await playable(r);
    put(r.relays, [SCOPED], beacon(new Key(), addr, [https('https://seed.example/o')]));
    await r.adapter.playNfx(addr);
    await r.adapter.playNfx(addr);
    expect(r.adapter.openSessions).toBe(2);
    await r.adapter.close();
    expect(r.adapter.openSessions).toBe(0);
  });
});
