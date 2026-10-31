/**
 * Conformance (design §6 L6-B): the SAME scenario list against core's `MockNetworkAdapter` (what
 * every screen was built and screenshotted against) and against `DesktopNetworkAdapter` (over a
 * FakeWorker + L1's FakeRelayPool, `--dev-mocks` wallet). For each screen-relevant path:
 *
 *   happy        both resolve, and both results — after the trip the renderer sees (dehydrate →
 *                structured clone) — pass the SAME exact-keys wire guard;
 *   failWith-≡   both reject with the same `WireError` code after `toWireError`, and the REAL
 *                screen classifiers (imported from @sovit/ui source) classify both alike.
 *
 * Deliberate differences are asserted too, each with its reason, at the bottom.
 */
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  NetworkAdapter,
  NfxAddress,
  NostrEventId,
  NostrPubkey,
  Sha256Hex,
  VideoManifest,
} from '@sovit/core';
import { NostrKind, mocks, nostr } from '@sovit/core';

import { fromWireError, toWireError } from '../../ipc/errors.js';
import type { IpcError } from '../../ipc/errors.js';
import type { Guard } from '../../ipc/guards.js';
import {
  arrayOf,
  bool,
  int,
  isCount,
  isEventId,
  isMintUrl,
  isPeerSpend,
  isPricePolicy,
  isPubkey,
  isRelayUrl,
  isSats,
  isSeederStatusWire,
  isUnixSeconds,
  isVideoManifest,
  literal,
  nullable,
  num,
  obj,
  oneOf,
  text,
  wireMap,
} from '../../ipc/guards.js';
import { dehydrate } from '../../ipc/wiremap.js';
import type { StudioUploadArgs } from '../../ipc/worker-protocol.js';
import { NoIdentity, SignerIdentity } from '../identity.js';
import type { ImageTransport } from '../images/net.js';
import { seedVideos } from './support/catalog.js';
import { coreTestKit } from './support/core-helpers.js';
import type { FakeWorkerOptions } from './support/fake-worker.js';
import type { Rig } from './support/rig.js';
import { rig } from './support/rig.js';

type MockNetworkAdapterOptions = mocks.MockNetworkAdapterOptions;
type MockOpts = Omit<MockNetworkAdapterOptions, 'failWith'> & {
  failWith?: MockNetworkAdapterOptions['failWith'];
};

const kit = await coreTestKit();

/** The real screen classifiers, from @sovit/ui source (as L6-0's errors test does). */
const ui = await (async () => {
  const load = async (rel: string): Promise<Record<string, unknown>> =>
    (await import(
      /* @vite-ignore */ new URL(`../../../../ui/src/screens/${rel}`, import.meta.url).href
    )) as Record<string, unknown>;
  const watch = await load('Watch/model.ts');
  const shorts = await load('Shorts/Shorts.tsx');
  const studio = await load('Studio/model.ts');
  return {
    playErrorKind: watch['playErrorKind'] as (e: unknown) => string,
    shortsPlayErrorKind: shorts['shortsPlayErrorKind'] as (e: unknown) => string,
    classifyStudioError: studio['classifyStudioError'] as (e: unknown) => string,
  };
})();

// ---- wire guards for results (what the renderer receives) ---------------------------------

const isPage = <T>(g: Guard<T>): Guard<unknown> =>
  obj({ items: arrayOf(g, 1000) }, { next: text(1, 64) });
const isProfile = obj(
  {
    pubkey: isPubkey,
    nip05Status: oneOf(['none', 'unverified', 'verified', 'failed'] as const),
    fetchedAt: isUnixSeconds,
  },
  {
    name: text(0, 4096),
    displayName: text(0, 4096),
    about: text(0, 16384, { multiline: true }),
    picture: text(0, 4096),
    banner: text(0, 4096),
    nip05: text(0, 4096),
    lud16: text(0, 4096),
  },
);
const isSignerStatus = obj(
  {
    kind: oneOf(['local', 'nip46', 'nip07'] as const),
    pubkey: nullable(isPubkey),
    locked: bool,
    supportsSignSecret: bool,
  },
  { detail: text(0, 4096) },
);
const isStats = obj(
  {
    paidViews: isCount,
    satsToCreator: isSats,
    reactions: isCount,
    likes: isCount,
    dislikes: isCount,
    comments: isCount,
  },
  { myReaction: oneOf(['like', 'dislike'] as const), seedersOnline: isCount },
);
const isNostrEventLike = obj({
  id: isEventId,
  pubkey: isPubkey,
  kind: int(0, 65535),
  created_at: isUnixSeconds,
  tags: arrayOf(arrayOf(text(0, 16384), 64), 4096),
  content: text(0, 16384, { multiline: true }),
  sig: text(128, 128),
});
const isComment = obj(
  {
    id: isEventId,
    author: isPubkey,
    content: text(0, 16384, { multiline: true }),
    createdAt: isUnixSeconds,
    reactions: isCount,
    event: isNostrEventLike,
  },
  { parent: isEventId },
);
const isPlaylist = obj(
  {
    id: text(1, 256),
    author: isPubkey,
    title: text(1, 4096),
    videoIds: arrayOf(isEventId, 1000),
    isPrivate: bool,
  },
  { description: text(0, 16384, { multiline: true }) },
);
const isHistory = isPage(
  obj({ video: isVideoManifest, positionSec: num(0, 1e7), at: isUnixSeconds }),
);
const isSettings = obj(
  {
    relays: arrayOf(obj({ url: isRelayUrl, read: bool, write: bool }), 256),
    defaultMints: arrayOf(isMintUrl, 256),
    seeding: obj({ enabled: bool, diskCapBytes: isCount }, { serveImages: bool }),
    prefetchSeconds: num(0, 600),
    hoverPreview: bool,
    loadRemoteImages: bool,
    theme: oneOf(['dark', 'light', 'system'] as const),
  },
  // v6 / issue #2: `amountSats` (1 … AUTO_TOP_UP_MAX_SATS) may be present.
  { autoTopUp: obj({ belowSats: isSats, fromMint: isMintUrl }, { amountSats: int(1, 10_000) }) },
);
const isMintQuote = obj({
  mint: isMintUrl,
  quoteId: text(1, 256),
  amount: isSats,
  bolt11: text(1, 4096),
  expiry: isUnixSeconds,
  state: oneOf(['UNPAID', 'PAID', 'ISSUED'] as const),
});
const isMeltQuote = obj({
  mint: isMintUrl,
  quoteId: text(1, 256),
  amount: isSats,
  feeReserve: isSats,
  expiry: isUnixSeconds,
  state: oneOf(['UNPAID', 'PENDING', 'PAID'] as const),
});
const isHistoryEntry = obj(
  {
    id: isEventId,
    direction: oneOf(['in', 'out'] as const),
    amount: isSats,
    mint: isMintUrl,
    at: isUnixSeconds,
    created: arrayOf(isEventId, 64),
    destroyed: arrayOf(isEventId, 64),
  },
  { memo: text(0, 4096) },
);
const isVoid = (x: unknown): x is undefined => x === undefined;
const isVideos = arrayOf(isVideoManifest, 1000);
const isAnalytics = (x: unknown): x is unknown => {
  if (typeof x !== 'object' || x === null) return false;
  const { satsByRendition, ...rest } = x as Record<string, unknown>;
  return isStats(rest) && wireMap(text(1, 256), isSats)(satsByRendition);
};
const isPlayData = obj({
  videoId: isEventId,
  rendition: text(1, 256),
  source: obj({ kind: literal('url'), url: text(1, 4096) }),
  policy: isPricePolicy,
});
const PLAY_METHODS = [
  'onPeers',
  'onSpend',
  'setPrefetchSeconds',
  'pause',
  'resume',
  'switchRendition',
  'close',
];

// ---- the two sides -------------------------------------------------------------------------

interface Side {
  readonly name: 'mock' | 'desktop';
  readonly a: NetworkAdapter;
  /** The i-th fixture video's id on this side. */
  id(i: number): NostrEventId;
  /** A channel with videos and a profile on this side. */
  readonly channel: NostrPubkey;
  readonly imageUrl: string;
  close(): Promise<void>;
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
/** F18: the fixture image is hash-addressed, so it loads with remote images off (the default). */
const PNG_SHA = createHash('sha256').update(PNG).digest('hex') as Sha256Hex;
/** ADR 0015: a thumbnail in the creator's profile core, as the worker hands it over. */
const PROFILE_THUMB = {
  url: `hyper://${'ab'.repeat(32)}/0-1`,
  sha256: 'e'.repeat(64) as Sha256Hex,
  size: 1000,
};
const images: ImageTransport = (url) =>
  url.href === 'https://img.example/p.png'
    ? Promise.resolve({
        status: 200,
        location: undefined,
        contentType: 'image/png',
        contentLength: PNG.byteLength,
        body: {
          [Symbol.asyncIterator]: () => {
            let sent = false;
            return {
              next: () => {
                const done = sent;
                sent = true;
                return Promise.resolve(
                  done ? { value: undefined, done: true as const } : { value: PNG, done: false },
                );
              },
            };
          },
        },
        cancel: () => undefined,
      })
    : Promise.reject(new Error('offline'));

function mockSide(opts: MockOpts = {}): Side {
  const a = new mocks.MockNetworkAdapter({
    setInterval: () => () => undefined,
    ...(opts as MockNetworkAdapterOptions),
  });
  return {
    name: 'mock',
    a,
    id: (i) => mocks.VIDEOS[i]!.id,
    channel: mocks.CHANNELS[0]!.pubkey,
    imageUrl: 'https://img.example/p.png',
    close: () => Promise.resolve(),
  };
}

type DeskFailure = 'relay-down' | 'no-seeders' | 'no-balance';

async function desktopSide(o: { signedIn?: boolean; failWith?: DeskFailure } = {}): Promise<Side> {
  const signedIn = o.signedIn ?? true;
  const viewer = new kit.TestSigner();
  const creator = new kit.TestSigner();
  const worker: FakeWorkerOptions = {
    handlers: {
      ...(o.failWith === 'no-seeders'
        ? {
            'play.open': () => {
              throw new Error('no-seeders: nobody is seeding this video right now');
            },
          }
        : {}),
      'studio.upload': async (a: StudioUploadArgs, w) =>
        (await w.request('studio.publish', {
          uploadId: a.uploadId,
          meta: a.meta,
          durationSec: 6,
          blockSize: 65536,
          renditions: [mocks.VIDEOS[0]!.renditions[0]!].map(
            ({ image: _i, captions: _c, storyboard: _s, placeholder: _p, ...r }) => r,
          ),
          thumbnail: { kind: 'custom', sha256: 'e'.repeat(64) as never, type: 'image/jpeg' },
          codec: 'h264',
          // ADR 0015: the worker wrote the thumbnail into the creator's profile core.
          thumbnailImage: PROFILE_THUMB,
        })) as VideoManifest,
    },
  };
  const r: Rig = await rig({
    flags: { devMocks: true },
    identity: signedIn ? new SignerIdentity(viewer) : new NoIdentity(),
    worker,
    imageTransport: images,
  });
  await r.ready();
  const seeded = await seedVideos(kit, r.pool, creator);
  // A profile for the channel, a paid view (kind 9321) and a comment, so reads are not empty.
  r.pool.store(
    await kit.sign(
      creator,
      nostr.buildProfileEvent(
        { name: 'Creator', picture: 'https://img.example/p.png' },
        1_757_000_000 as never,
      ),
    ),
  );
  const v0 = seeded[0]!.video;
  r.pool.store(
    await kit.sign(new kit.TestSigner(), {
      kind: NostrKind.NutzapPayout,
      created_at: 1_756_999_000,
      tags: [
        ['p', creator.pubkey],
        ['e', v0.id],
        ['k', '21'],
        ['u', mocks.MINTS.a],
        ['unit', 'sat'],
        ['proof', JSON.stringify({ amount: 21, id: 'k', secret: 's', C: 'c' })],
      ],
      content: '',
    }),
  );
  const commenter = new kit.TestSigner();
  r.pool.store(
    await kit.sign(
      commenter,
      nostr.buildCommentEvent(
        { video: { id: v0.id, pubkey: v0.author, kind: 21 }, content: 'nice' },
        1_757_000_001 as never,
      ),
    ),
  );
  if (o.failWith === 'relay-down') r.pool.query = () => Promise.reject(new Error('ECONNREFUSED'));
  if (o.failWith === 'no-balance') {
    const w = r.host.adapter.wallet as mocks.MockWallet;
    for (const m of [mocks.MINTS.a, mocks.MINTS.b])
      w.credit(m, -Number(await w.balance(m)), 'out', 'drain');
  }
  return {
    name: 'desktop',
    a: r.host.adapter,
    id: (i) => seeded[i]!.video.id,
    channel: creator.pubkey,
    imageUrl: 'https://img.example/p.png',
    close: () => r.close(),
  };
}

const open: Side[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});

async function pair(
  mockOpts: MockOpts = {},
  deskOpts: Parameters<typeof desktopSide>[0] = {},
): Promise<[Side, Side]> {
  const m = mockSide(mockOpts);
  const d = await desktopSide(deskOpts);
  open.push(m, d);
  return [m, d];
}

/** What the renderer receives: Maps as WireMaps, then a structured clone. */
const wire = (x: unknown): unknown => structuredClone(dehydrate(x));

async function outcome(
  p: Promise<unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; err: IpcError }> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    return { ok: false, err: fromWireError(structuredClone(toWireError(e))) };
  }
}

// ---- scenarios ---------------------------------------------------------------------------

interface Happy {
  readonly name: string;
  readonly guard: Guard<unknown>;
  readonly run: (s: Side) => Promise<unknown>;
}

const U = (i: number) => (s: Side) => s.id(i);
const HAPPY: Happy[] = [
  { name: 'signer', guard: isSignerStatus, run: (s) => s.a.signer() },
  { name: 'me', guard: isPubkey, run: (s) => s.a.me() },
  { name: 'profile', guard: nullable(isProfile), run: (s) => s.a.profile(s.channel) },
  {
    name: 'feed trending',
    guard: isPage(isVideoManifest),
    run: (s) => s.a.feed({ source: 'trending' }),
  },
  {
    name: 'feed tags',
    guard: isPage(isVideoManifest),
    run: (s) => s.a.feed({ source: 'tags', tags: ['space'] }),
  },
  {
    name: 'feed author',
    guard: isPage(isVideoManifest),
    run: (s) => s.a.feed({ source: 'author', author: s.channel }),
  },
  {
    name: 'feed shorts',
    guard: isPage(isVideoManifest),
    run: (s) => s.a.feed({ source: 'shorts' }),
  },
  {
    name: 'feed subscriptions',
    guard: isPage(isVideoManifest),
    run: async (s) => {
      await s.a.subscribe(s.channel);
      return s.a.feed({ source: 'subscriptions' });
    },
  },
  { name: 'video', guard: isVideoManifest, run: (s) => s.a.video(U(0)(s)) },
  {
    name: 'video (unknown)',
    guard: literal(null),
    run: (s) => s.a.video('9'.repeat(64) as NostrEventId),
  },
  {
    name: 'nfxVideo (unknown)',
    guard: literal(null),
    run: (s) => s.a.nfxVideo(`38504:${'9'.repeat(64)}:nfx:testnet:1:unknown-video` as NfxAddress),
  },
  { name: 'stats', guard: isStats, run: (s) => s.a.stats(U(0)(s)) },
  { name: 'related', guard: isVideos, run: (s) => s.a.related(U(0)(s)) },
  { name: 'search', guard: isPage(isVideoManifest), run: (s) => s.a.search({ text: 'hohmann' }) },
  { name: 'comments', guard: isPage(isComment), run: (s) => s.a.comments(U(0)(s), 'new') },
  { name: 'comment', guard: isComment, run: (s) => s.a.comment(U(0)(s), 'hello') },
  { name: 'react', guard: isVoid, run: (s) => s.a.react(U(1)(s), '+') },
  {
    name: 'react → stats.myReaction = like',
    guard: isStats,
    run: async (s) => {
      await s.a.react(U(1)(s), '+');
      const st = await s.a.stats(U(1)(s));
      expect(st.myReaction, s.name).toBe('like');
      return st;
    },
  },
  {
    name: 'unreact → neutral',
    guard: isStats,
    run: async (s) => {
      await s.a.react(U(1)(s), '-');
      await s.a.unreact(U(1)(s));
      const st = await s.a.stats(U(1)(s));
      expect(st.myReaction, s.name).toBeUndefined();
      return st;
    },
  },
  { name: 'subscribe', guard: isVoid, run: (s) => s.a.subscribe(s.channel) },
  { name: 'unsubscribe', guard: isVoid, run: (s) => s.a.unsubscribe(s.channel) },
  { name: 'subscriptions', guard: arrayOf(isPubkey, 256), run: (s) => s.a.subscriptions() },
  { name: 'report', guard: isVoid, run: (s) => s.a.report(U(0)(s), 'spam') },
  {
    name: 'library.history',
    guard: isHistory,
    run: async (s) => {
      await s.a.library.recordProgress(U(0)(s), 30);
      return s.a.library.history();
    },
  },
  {
    name: 'library.recordProgress',
    guard: isVoid,
    run: (s) => s.a.library.recordProgress(U(0)(s), 12),
  },
  { name: 'library.watchLater', guard: isVideos, run: (s) => s.a.library.watchLater() },
  {
    name: 'library.setWatchLater',
    guard: isVoid,
    run: (s) => s.a.library.setWatchLater(U(2)(s), true),
  },
  {
    name: 'library.playlists',
    guard: arrayOf(isPlaylist, 256),
    run: (s) => s.a.library.playlists(),
  },
  {
    name: 'library.savePlaylist',
    guard: isPlaylist,
    run: (s) =>
      s.a.library.savePlaylist({ title: 'Mix', videoIds: [U(0)(s), U(1)(s)], isPrivate: false }),
  },
  { name: 'library.liked', guard: isVideos, run: (s) => s.a.library.liked() },
  {
    name: 'play (PlaySession data + methods)',
    guard: isPlayData,
    run: async (s) => {
      const ps = await s.a.play(U(0)(s));
      for (const m of PLAY_METHODS)
        expect(typeof (ps as unknown as Record<string, unknown>)[m], `${s.name} ${m}`).toBe(
          'function',
        );
      ps.pause();
      ps.resume();
      ps.setPrefetchSeconds(10);
      const next = await ps.switchRendition(ps.rendition);
      expect(isPlayData(pickData(next)), s.name).toBe(true);
      await next.close();
      return pickData(ps);
    },
  },
  { name: 'image', guard: text(1, 4096), run: (s) => s.a.image(s.imageUrl, PNG_SHA) },
  { name: 'wallet.mints', guard: arrayOf(isMintUrl, 64), run: (s) => s.a.wallet.mints() },
  { name: 'wallet.balance', guard: isSats, run: (s) => s.a.wallet.balance(mocks.MINTS.a) },
  { name: 'wallet.balances', guard: wireMap(isMintUrl, isSats), run: (s) => s.a.wallet.balances() },
  {
    name: 'wallet.mintQuote',
    guard: isMintQuote,
    run: (s) => s.a.wallet.mintQuote(mocks.MINTS.a, 100 as never),
  },
  {
    name: 'wallet.pollQuote',
    guard: obj({ state: oneOf(['UNPAID', 'PAID', 'ISSUED'] as const) }, { minted: isSats }),
    run: async (s) => s.a.wallet.pollQuote(await s.a.wallet.mintQuote(mocks.MINTS.a, 100 as never)),
  },
  {
    name: 'wallet.meltQuote',
    guard: isMeltQuote,
    run: (s) => s.a.wallet.meltQuote(mocks.MINTS.a, 'lnbc100n1x'),
  },
  {
    name: 'wallet.melt',
    guard: obj({ paid: bool, change: isSats }, { preimage: text(0, 256) }),
    run: async (s) => s.a.wallet.melt(await s.a.wallet.meltQuote(mocks.MINTS.a, 'lnbc100n1x')),
  },
  {
    name: 'wallet.history',
    guard: arrayOf(isHistoryEntry, 1000),
    run: async (s) => {
      await s.a.wallet.pollQuote(await s.a.wallet.mintQuote(mocks.MINTS.a, 5 as never));
      return s.a.wallet.history({ limit: 5 });
    },
  },
  { name: 'studio.myVideos', guard: isPage(isVideoManifest), run: (s) => s.a.studio.myVideos() },
  { name: 'studio.analytics', guard: isAnalytics, run: (s) => s.a.studio.analytics(U(0)(s)) },
  {
    name: 'studio.upload',
    guard: isVideoManifest,
    run: (s) =>
      s.a.studio.upload(
        {
          file: '/tmp/clip.mp4',
          title: 'Upload',
          description: '',
          tags: ['t'],
          kind: 21,
          mints: [mocks.MINTS.a],
          satsPerBlock: 1 as never,
          split: { seeder: 50, creator: 50 },
        },
        () => undefined,
      ),
  },
  { name: 'seeder.status', guard: isSeederStatusWire, run: (s) => s.a.seeder.status() },
  { name: 'seeder.setEnabled', guard: isVoid, run: (s) => s.a.seeder.setEnabled(false) },
  {
    name: 'seeder.melt',
    guard: obj({ paid: bool }),
    run: (s) => s.a.seeder.melt(mocks.MINTS.a, 'lnbc10n1x'),
  },
  { name: 'seeder.unban', guard: isVoid, run: (s) => s.a.seeder.unban('d'.repeat(64) as never) },
  { name: 'settings', guard: isSettings, run: (s) => s.a.settings() },
  {
    name: 'updateSettings',
    guard: isSettings,
    run: (s) => s.a.updateSettings({ theme: 'light', prefetchSeconds: 15 }),
  },
  {
    name: 'updateSettings (issue #2: auto top-up with an amount)',
    guard: isSettings,
    run: (s) =>
      s.a.updateSettings({
        autoTopUp: { belowSats: 500 as never, fromMint: mocks.MINTS.b, amountSats: 2_000 as never },
      }),
  },
];

function pickData(ps: {
  videoId: unknown;
  rendition: unknown;
  source: unknown;
  policy: unknown;
}): unknown {
  return { videoId: ps.videoId, rendition: ps.rendition, source: ps.source, policy: ps.policy };
}

describe('conformance: happy paths resolve to the same wire shapes', () => {
  it.each(HAPPY.map((h) => [h.name, h] as const))('%s', async (_n, h) => {
    const sides = await pair();
    for (const s of sides) {
      const o = await outcome(h.run(s));
      if (!o.ok) throw new Error(`${s.name} rejected: ${o.err.message}`);
      const w = wire(o.value);
      expect(h.guard(w), `${s.name}: ${JSON.stringify(w ?? null).slice(0, 400)}`).toBe(true);
    }
  });

  it('peer + spend payloads (PlaySession.onPeers/onSpend) have the same shape', async () => {
    const [m, d] = await pair();
    const spends: unknown[][] = [[], []];
    const peers: unknown[][] = [[], []];
    let tick: () => void = () => undefined;
    const mock = new mocks.MockNetworkAdapter({
      setInterval: (fn) => {
        tick = fn;
        return () => undefined;
      },
    });
    const ms = await mock.play(m.id(0));
    ms.onSpend((x) => spends[0]!.push(wire(x)));
    ms.onPeers((x) => peers[0]!.push(wire(x)));
    tick();
    const ds = (await d.a.play(d.id(0))) as unknown as { sid: string } & typeof ms;
    ds.onSpend((x) => spends[1]!.push(wire(x)));
    ds.onPeers((x) => peers[1]!.push(wire(x)));
    const r = (
      d.a as unknown as { sessions: { bySessionId(s: string): { emitPeers(p: unknown): void } } }
    ).sessions;
    (d.a as unknown as { onWorkerEvent(e: unknown): void }).onWorkerEvent({
      op: 'ev',
      e: 'spend',
      sid: ds.sid,
      mint: mocks.MINTS.a,
      amount: 3,
      total: 3,
      ratePerMin: 180,
    });
    r.bySessionId(ds.sid).emitPeers([
      { pubkey: 'c'.repeat(64), sats: 3, ratePerMin: 180, blocks: 3, latencyMs: 40 },
    ]);
    const isSpend = obj({ total: isSats, ratePerMin: isSats });
    for (const i of [0, 1]) {
      expect(spends[i]!.length, `side ${String(i)}`).toBeGreaterThan(0);
      expect(spends[i]!.every((x) => isSpend(x))).toBe(true);
      expect(peers[i]!.every((x) => arrayOf(isPeerSpend, 256)(x))).toBe(true);
    }
  });
});

// ---- failWith-equivalents ----------------------------------------------------------------

interface Failing {
  readonly name: string;
  readonly mock: MockOpts;
  readonly desk: Parameters<typeof desktopSide>[0];
  readonly code: string;
  readonly run: (s: Side) => Promise<unknown>;
  /** Also compare the real play classifiers (Watch, Shorts). */
  readonly play?: boolean;
}

const RELAY_READS: [string, (s: Side) => Promise<unknown>][] = [
  ['feed', (s) => s.a.feed({ source: 'trending' })],
  ['feed tags', (s) => s.a.feed({ source: 'tags', tags: ['space'] })],
  ['video', (s) => s.a.video(s.id(0))],
  ['stats', (s) => s.a.stats(s.id(0))],
  ['related', (s) => s.a.related(s.id(0))],
  ['search', (s) => s.a.search({ text: 'x' })],
  ['comments', (s) => s.a.comments(s.id(0), 'top')],
  ['profile', (s) => s.a.profile(s.channel)],
  ['library.history', (s) => s.a.library.history()],
  ['studio.analytics', (s) => s.a.studio.analytics(s.id(0))],
];

const FAILING: Failing[] = [
  ...RELAY_READS.map(([name, run]): Failing => ({
    name: `relay-down: ${name}`,
    mock: { failWith: 'relay-down' },
    desk: { failWith: 'relay-down' },
    code: 'relay-down',
    run,
  })),
  {
    name: 'no-seeders: play',
    mock: { failWith: 'no-seeders' },
    desk: { failWith: 'no-seeders' },
    code: 'no-seeders',
    run: (s) => s.a.play(s.id(0)),
    play: true,
  },
  {
    name: 'no-balance: play',
    mock: { failWith: 'no-balance' },
    desk: { failWith: 'no-balance' },
    code: 'no-balance',
    run: (s) => s.a.play(s.id(0)),
    play: true,
  },
];

describe('conformance: failWith-equivalents reject with the same code and classification', () => {
  it.each(FAILING.map((f) => [f.name, f] as const))('%s', async (_n, f) => {
    const [m, d] = await pair(f.mock, f.desk);
    const om = await outcome(f.run(m));
    const od = await outcome(f.run(d));
    if (om.ok || od.ok)
      throw new Error(`expected both to reject (mock ${String(om.ok)}, desktop ${String(od.ok)})`);
    expect(om.err.code).toBe(f.code);
    expect(od.err.code).toBe(f.code);
    expect(od.err.message.startsWith(`${f.code}: `)).toBe(true);
    if (f.play === true) {
      expect(ui.playErrorKind(od.err)).toBe(ui.playErrorKind(om.err));
      expect(ui.shortsPlayErrorKind(od.err)).toBe(ui.shortsPlayErrorKind(om.err));
      expect(ui.playErrorKind(od.err)).toBe(f.code);
    }
  });

  it('no-seeders: the mock reports 0 seeders, the desktop host unknown (#23)', async () => {
    const [m, d] = await pair({ failWith: 'no-seeders' }, { failWith: 'no-seeders' });
    expect((await m.a.stats(m.id(0))).seedersOnline, m.name).toBe(0);
    // The host has no swarm lookup for relay videos, so it cannot know the count before play:
    // the Watch/Shorts pre-play gate stays open, and play() rejects with `no-seeders` on both
    // (the 'no-seeders: play' case above).
    expect('seedersOnline' in (await d.a.stats(d.id(0))), d.name).toBe(false);
  });

  it('no-signer: identity reads look the same (pubkey null, me null)', async () => {
    const [m, d] = await pair({ failWith: 'no-signer' }, { signedIn: false });
    for (const s of [m, d]) {
      const st = await s.a.signer();
      expect(isSignerStatus(wire(st)), s.name).toBe(true);
      expect(st.pubkey, s.name).toBeNull();
      expect(await s.a.me(), s.name).toBeNull();
    }
  });
});

// ---- deliberate differences (each asserted, each with its reason) ---------------------------

describe('conformance: deliberate differences from the (cheatable) mock', () => {
  it('signed out, writes reject `no-signer:` — the screens classify it as no-signer (the mock accepts them)', async () => {
    const [m, d] = await pair({ failWith: 'no-signer' }, { signedIn: false });
    const up = {
      file: '/tmp/clip.mp4',
      title: 't',
      description: '',
      tags: [],
      kind: 21 as const,
      mints: [mocks.MINTS.a],
      satsPerBlock: 1 as never,
      split: { seeder: 50, creator: 50 },
    };
    expect((await outcome(m.a.react(m.id(0), '+'))).ok).toBe(true);
    const react = await outcome(d.a.react(d.id(0), '+'));
    const upload = await outcome(d.a.studio.upload(up, () => undefined));
    for (const o of [react, upload]) {
      if (o.ok) throw new Error('desktop accepted a write without a signer');
      expect(o.err.code).toBe('no-signer');
    }
    if (!upload.ok) expect(ui.classifyStudioError(upload.err)).toBe('no-signer');
  });

  // ADR 0015: the published manifest names the thumbnail in the creator's profile core.
  it('an upload publishes the worker’s profile-core thumbnail on the first rendition', async () => {
    const [, d] = await pair();
    const video = await d.a.studio.upload(
      {
        file: '/tmp/clip.mp4',
        title: 'With a thumbnail',
        description: '',
        tags: [],
        kind: 21,
        mints: [mocks.MINTS.a],
        satsPerBlock: 1 as never,
        split: { seeder: 50, creator: 50 },
      },
      () => undefined,
    );
    expect(video.renditions[0]?.image).toEqual(PROFILE_THUMB);
    expect(video.event.tags.find((t) => t[0] === 'imeta')).toEqual(
      expect.arrayContaining([
        `image ${PROFILE_THUMB.url}`,
        `image-x ${PROFILE_THUMB.sha256}`,
        `image-size ${String(PROFILE_THUMB.size)}`,
      ]),
    );
  });

  it('play of an unknown rendition label is refused (the mock silently falls back to the first)', async () => {
    const [m, d] = await pair();
    const ms = await m.a.play(m.id(0), 'no-such-label');
    expect(ms.rendition).toBe(mocks.VIDEOS[0]!.renditions[0]!.label);
    await ms.close();
    const od = await outcome(d.a.play(d.id(0), 'no-such-label'));
    expect(od.ok ? 'resolved' : od.err.code).toBe('not-found');
  });

  it('settings are local: they still load when every relay is down (the mock rejects relay-down)', async () => {
    const [m, d] = await pair({ failWith: 'relay-down' }, { failWith: 'relay-down' });
    expect((await outcome(m.a.settings())).ok).toBe(false);
    expect(isSettings(wire(await d.a.settings()))).toBe(true);
  });

  it('image() returns nf-media://img/<id>, never the remote URL (the mock echoes the URL)', async () => {
    const [m, d] = await pair();
    expect(await m.a.image(m.imageUrl)).toBe(m.imageUrl);
    expect(await d.a.image(d.imageUrl, PNG_SHA)).toMatch(/^nf-media:\/\/img\/[0-9a-f]{32}$/);
    // F18: without a signed hash the desktop refuses, before any request, while remote images
    // are off (the default).
    await expect(d.a.image(d.imageUrl)).rejects.toThrow(/^forbidden/);
  });
});
