/**
 * Slice 5d-3 (contracts v11): free NFX play on the host. The seeders come from the video's live,
 * verified, free beacons on the scoped relays only; no money is involved; closing revokes the link
 * and closes the worker's session, and a gone webContents closes its sessions. NFX-10 §1: the STUN
 * servers those beacons name reach the worker's WebRTC side (`nfx.rtc.stun`), by core's rules.
 */
import { generateKeyPairSync } from 'node:crypto';

import type {
  IrohRelayUrl,
  NfxAddress,
  NostrEvent,
  PlaySourceAddress,
  RelayUrl,
  StunServer,
} from '@sovit/core';
import { mocks, nfx } from '@sovit/core';
import { hyperdhtEndpoint } from '@sovit/seeder';
import { afterEach, describe, expect, it } from 'vitest';

import type { HostOut, ReplyMsg } from '../../ipc/protocol.js';
import { IPC_V } from '../../ipc/protocol.js';
import { validateWorkerArgs } from '../../ipc/worker-guards.js';
import { DEFAULT_NFX_MESH_RELAYS } from '../settings/settings.js';
import { coreTestKit, type TestSignerLike } from './support/core-helpers.js';
import type { Rig } from './support/rig.js';
import { eventually, rig } from './support/rig.js';

const kit = await coreTestKit();
const NS = 'nfx:testnet:1';
const SCOPED = 'wss://scoped.test' as RelayUrl;
const NFX_ON = { enabled: true, network: NS, scopedRelays: [SCOPED] } as const;
const ROOT = 'ab'.repeat(32);

let r: Rig | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

function peerKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d!, 'base64url');
  const pub = Buffer.from(jwk.x!, 'base64url');
  return { publicKey: new Uint8Array(pub), secretKey: new Uint8Array(Buffer.concat([seed, pub])) };
}

async function manifest(creator: TestSignerLike, videoId: string): Promise<NostrEvent> {
  const at = mocks.FIXTURE_NOW - 3600;
  const ev = await kit.sign(creator, {
    kind: 38504,
    created_at: at,
    content: 'A free video.',
    tags: [
      ['d', `${NS}:${videoId}`],
      ['n', NS],
      ['title', videoId],
      ['published_at', String(at)],
      ['license', 'open'],
      ['root', ROOT],
      ['segs', '4'],
      ['t', 'space'],
    ],
  });
  r!.pool.store(ev);
  return ev;
}

async function beacon(
  seeder: TestSignerLike,
  creator: string,
  videoId: string,
  o: {
    readonly free?: boolean;
    readonly endpoints?: (hyperdht: nfx.Endpoint) => nfx.Endpoint[];
    /** Open the video first, as the Watch page does (default); `false`: publish to whoever listens. */
    readonly listen?: boolean;
  } = {},
): Promise<{ readonly peer: string }> {
  const addr = `38504:${creator}:${NS}:${videoId}`;
  // A little ahead of the rig's clock (which ticks per read), well inside the 15-minute skew.
  const now = mocks.FIXTURE_NOW + 300;
  const endpoint = hyperdhtEndpoint(peerKeyPair(), seeder.pubkey, NS);
  const video = nfx.VideoAddr.parse(`${NS}:${videoId}`);
  const tags = nfx.beaconTags(addr, now, 120);
  if (!video.ok || !tags.ok) throw new Error('bad test beacon');
  const free = o.free ?? true;
  // Beacons are ephemeral (NFX-04): the relay forwards them to live subscriptions only. The
  // Watch page opens the video's (as the renderer's `nfxVideo` does) before one is published.
  if (o.listen !== false) await r!.host.adapter.watchNfxVideo(addr as NfxAddress);
  const content = nfx.beaconContentText({
    v: 1,
    video: video.value,
    endpoints: o.endpoints?.(endpoint) ?? [endpoint],
    skipped: [],
    chunks: 'all',
    priceHint: free ? 0n : 1n,
    acceptsMints: free ? [] : ['https://mint.example'],
    free,
  });
  r!.pool.store(
    await kit.sign(seeder, { kind: 20464, created_at: now, tags: tags.value, content }),
  );
  return { peer: endpoint.peer };
}

const addrOf = (creator: string, videoId: string): NfxAddress =>
  `38504:${creator}:${NS}:${videoId}` as NfxAddress;

/** Slice 5e-4: the network's iroh relay, and an iroh endpoint as a beacon carries one. */
const IROH_RELAY = 'https://iroh-relay.test/' as IrohRelayUrl;
const ticket = (c: string): string => `blob${c.repeat(60)}`;
function irohEndpoint(node: string, o: Partial<Omit<IrohEndpoint, 't'>> = {}): IrohEndpoint {
  return {
    t: 'iroh',
    node,
    relay: IROH_RELAY,
    addrs: ['192.0.2.7:4433'],
    tickets: new Map([
      ['720p', ticket('b')],
      ['meta', ticket('a')],
    ]),
    ...o,
  };
}
type IrohEndpoint = Extract<nfx.Endpoint, { readonly t: 'iroh' }>;

describe('openNfxSession (contracts v11)', () => {
  it('opens on the beaconed seeders, sends the media link, and closes cleanly', async () => {
    r = await rig({ nfx: NFX_ON });
    await r.ready();
    const creator = new kit.TestSigner();
    const seeder = new kit.TestSigner();
    await manifest(creator, 'free-video-1');
    const { peer } = await beacon(seeder, creator.pubkey, 'free-video-1');
    const a = r.host.adapter;
    const s = await a.openNfxSession(7, addrOf(creator.pubkey, 'free-video-1'));
    const [open] = r.worker().calls('nfx.play.open');
    expect(open).toMatchObject({
      video: `${NS}:free-video-1`,
      root: ROOT,
      segs: 4,
      peers: [{ t: 'hyperdht', peer }],
      iroh: [],
    });
    expect(validateWorkerArgs['nfx.play.open'](open)).toBe(true);
    expect(s.toWire()).toMatchObject({
      rendition: '720p',
      videoId: addrOf(creator.pubkey, 'free-video-1'),
    });
    const links = r.out.filter((m) => m.kind === 'media-link');
    expect(links).toHaveLength(1);
    expect(s.toWire().source.url).toBe(`nf-media://play/${(links[0] as { token: string }).token}`);

    // Only the owner can close it; then the link is revoked and the worker told.
    await a.closeNfxSession(8, s.sid);
    expect(r.worker().calls('nfx.play.close')).toEqual([]);
    await a.closeNfxSession(7, s.sid);
    expect(r.worker().calls('nfx.play.close')).toEqual([{ sid: s.sid }]);
    expect(r.out.filter((m) => m.kind === 'media-link').at(-1)).toMatchObject({ url: null });
  });

  it('slice 5e-4: passes iroh endpoints too, their relays held to the network', async () => {
    r = await rig({ nfx: { ...NFX_ON, irohRelays: [IROH_RELAY] } });
    await r.ready();
    const creator = new kit.TestSigner();
    await manifest(creator, 'free-video-5');
    const nodeA = 'a1'.repeat(32);
    const nodeB = 'b2'.repeat(32);
    // An nfxd-like seeder (iroh only), one with both, and endpoints that cannot cross.
    await beacon(new kit.TestSigner(), creator.pubkey, 'free-video-5', {
      endpoints: () => [irohEndpoint(nodeA)],
    });
    const { peer } = await beacon(new kit.TestSigner(), creator.pubkey, 'free-video-5', {
      endpoints: (h) => [
        irohEndpoint(nodeB, {
          relay: 'https://not-the-network.test/',
          addrs: [
            '192.0.2.8:4433',
            'host.example:1',
            ...Array.from({ length: 20 }, (_, i) => `198.51.100.${String(i)}:1`),
          ],
        }),
        h,
      ],
    });
    await beacon(new kit.TestSigner(), creator.pubkey, 'free-video-5', {
      endpoints: (h) => [
        irohEndpoint('c3'.repeat(32), { tickets: new Map([['720p', ticket('b')]]) }),
        irohEndpoint('d4'.repeat(32), { tickets: new Map([['meta', 'not-a-ticket']]) }),
        h,
      ],
    });
    await r.host.adapter.openNfxSession(7, addrOf(creator.pubkey, 'free-video-5'));
    const [open] = r.worker().calls('nfx.play.open');
    expect(validateWorkerArgs['nfx.play.open'](open)).toBe(true);
    const iroh = (open as { iroh: { node: string; relay: string; addrs: string[] }[] }).iroh;
    expect(iroh.map((e) => e.node).sort()).toEqual([nodeA, nodeB].sort());
    const a = iroh.find((e) => e.node === nodeA)!;
    const b = iroh.find((e) => e.node === nodeB)!;
    expect(a).toMatchObject({
      relay: IROH_RELAY,
      tickets: {
        $map: [
          ['meta', ticket('a')],
          ['720p', ticket('b')],
        ],
      },
    });
    expect(b.relay).toBe('');
    expect(b.addrs).toHaveLength(16);
    expect(b.addrs).not.toContain('host.example:1');
    expect((open as { peers: { peer: string }[] }).peers.map((p) => p.peer)).toContain(peer);
  });

  it('slice 5e-4: an iroh-only seeder is enough to open', async () => {
    r = await rig({ nfx: NFX_ON });
    await r.ready();
    const creator = new kit.TestSigner();
    await manifest(creator, 'free-video-6');
    await beacon(new kit.TestSigner(), creator.pubkey, 'free-video-6', {
      endpoints: () => [irohEndpoint('e5'.repeat(32))],
    });
    await r.host.adapter.openNfxSession(7, addrOf(creator.pubkey, 'free-video-6'));
    const [open] = r.worker().calls('nfx.play.open');
    expect(open).toMatchObject({ peers: [], iroh: [{ node: 'e5'.repeat(32), relay: '' }] });
    expect(validateWorkerArgs['nfx.play.open'](open)).toBe(true);
  });

  it('pear #97: tells the worker which renditions the seeders it names hold', async () => {
    r = await rig({ nfx: { ...NFX_ON, irohRelays: [IROH_RELAY] } });
    await r.ready();
    const creator = new kit.TestSigner();
    await manifest(creator, 'free-video-7');
    const tickets = (...ids: string[]): Map<string, string> =>
      new Map([['meta', ticket('a')], ...ids.map((id) => [id, ticket('c')] as [string, string])]);
    // Two nfxd-like seeders with one rendition each (one of them 720p), one with both, and a
    // HyperDHT seeder (whole videos: every rendition).
    await beacon(new kit.TestSigner(), creator.pubkey, 'free-video-7', {
      endpoints: () => [irohEndpoint('a1'.repeat(32), { tickets: tickets('720p') })],
    });
    await beacon(new kit.TestSigner(), creator.pubkey, 'free-video-7', {
      endpoints: () => [irohEndpoint('b2'.repeat(32), { tickets: tickets('1080p') })],
    });
    await beacon(new kit.TestSigner(), creator.pubkey, 'free-video-7', {
      endpoints: () => [irohEndpoint('c3'.repeat(32), { tickets: tickets('720p', '1080p') })],
    });
    await beacon(new kit.TestSigner(), creator.pubkey, 'free-video-7');
    await r.host.adapter.openNfxSession(7, addrOf(creator.pubkey, 'free-video-7'));
    const [open] = r.worker().calls('nfx.play.open');
    expect(validateWorkerArgs['nfx.play.open'](open)).toBe(true);
    const held = (open as { held: { seeders: number; all: number; named: { $map: unknown[] } } })
      .held;
    expect(held.seeders).toBe(4);
    expect(held.all).toBe(1);
    expect(new Map(held.named.$map as [string, number][])).toEqual(
      new Map([
        ['720p', 2],
        ['1080p', 2],
      ]),
    );
  });

  it('pear #97: a seeder whose only endpoint holds no rendition is no seeder', async () => {
    r = await rig({ nfx: { ...NFX_ON, irohRelays: [IROH_RELAY] } });
    await r.ready();
    const creator = new kit.TestSigner();
    await manifest(creator, 'free-video-8');
    // A `meta` ticket and nothing else: the hash list, but no rendition to play.
    await beacon(new kit.TestSigner(), creator.pubkey, 'free-video-8', {
      endpoints: () => [
        irohEndpoint('a1'.repeat(32), { tickets: new Map([['meta', ticket('a')]]) }),
      ],
    });
    await expect(
      r.host.adapter.openNfxSession(7, addrOf(creator.pubkey, 'free-video-8')),
    ).rejects.toThrow(/no-seeders/);
    expect(r.worker().calls('nfx.play.open')).toHaveLength(0);
  });

  /** An `https` endpoint naming `renditions` (the desktop plays over iroh and HyperDHT only). */
  const origin = (renditions: readonly string[]): nfx.Endpoint => ({
    t: 'https',
    url: 'https://origin.example/nfx',
    renditions,
  });

  it('pear #104: a beacon whose https endpoint lists no rendition, or one twice, is no seeder', async () => {
    r = await rig({ nfx: { ...NFX_ON, irohRelays: [IROH_RELAY] } });
    await r.ready();
    const creator = new kit.TestSigner();
    await manifest(creator, 'free-video-9');
    // NFX-03 §4 rejects these beacons whole: their HyperDHT and iroh endpoints are not used either.
    await beacon(new kit.TestSigner(), creator.pubkey, 'free-video-9', {
      endpoints: (hyperdht) => [hyperdht, irohEndpoint('a1'.repeat(32)), origin([])],
    });
    await beacon(new kit.TestSigner(), creator.pubkey, 'free-video-9', {
      endpoints: () => [irohEndpoint('b2'.repeat(32)), origin(['720p', '720p'])],
    });
    await expect(
      r.host.adapter.openNfxSession(7, addrOf(creator.pubkey, 'free-video-9')),
    ).rejects.toThrow(/no-seeders/);
    expect(r.worker().calls('nfx.play.open')).toHaveLength(0);
  });

  it('pear #104: beside such beacons, only the valid seeder is named and counted', async () => {
    r = await rig({ nfx: { ...NFX_ON, irohRelays: [IROH_RELAY] } });
    await r.ready();
    const creator = new kit.TestSigner();
    await manifest(creator, 'free-video-10');
    const { peer } = await beacon(new kit.TestSigner(), creator.pubkey, 'free-video-10', {
      endpoints: (hyperdht) => [hyperdht, irohEndpoint('a1'.repeat(32)), origin([])],
    });
    await beacon(new kit.TestSigner(), creator.pubkey, 'free-video-10', {
      endpoints: () => [irohEndpoint('b2'.repeat(32)), origin(['720p', '720p'])],
    });
    const tickets = new Map([
      ['meta', ticket('a')],
      ['1080p', ticket('c')],
    ]);
    await beacon(new kit.TestSigner(), creator.pubkey, 'free-video-10', {
      endpoints: () => [irohEndpoint('c3'.repeat(32), { tickets }), origin(['1080p'])],
    });
    await r.host.adapter.openNfxSession(7, addrOf(creator.pubkey, 'free-video-10'));
    const [open] = r.worker().calls('nfx.play.open');
    expect(validateWorkerArgs['nfx.play.open'](open)).toBe(true);
    expect(open).toMatchObject({ peers: [], iroh: [{ node: 'c3'.repeat(32) }] });
    expect((open as { peers: { peer: string }[] }).peers.map((p) => p.peer)).not.toContain(peer);
    const held = (open as { held: { seeders: number; all: number; named: { $map: unknown[] } } })
      .held;
    expect(held.seeders).toBe(1);
    expect(held.all).toBe(0);
    expect(new Map(held.named.$map as [string, number][])).toEqual(new Map([['1080p', 1]]));
  });

  it('no live free beacon by a seeder for this manifest means no-seeders', async () => {
    r = await rig({ nfx: NFX_ON });
    await r.ready();
    const creator = new kit.TestSigner();
    const other = new kit.TestSigner();
    const seeder = new kit.TestSigner();
    await manifest(creator, 'free-video-2');
    // A paid beacon, and a free one naming another creator's address of the same id.
    await beacon(seeder, creator.pubkey, 'free-video-2', { free: false });
    await beacon(seeder, other.pubkey, 'free-video-2');
    await expect(
      r.host.adapter.openNfxSession(7, addrOf(creator.pubkey, 'free-video-2')),
    ).rejects.toThrow(/^no-seeders/);
    expect(r.worker().calls('nfx.play.open')).toEqual([]);
  });

  it('a beacon that arrives while the play waits opens it (beacons are never stored)', async () => {
    r = await rig({ nfx: NFX_ON });
    await r.ready();
    const creator = new kit.TestSigner();
    const seeder = new kit.TestSigner();
    await manifest(creator, 'free-video-7');
    const address = addrOf(creator.pubkey, 'free-video-7');
    // Published before anyone listens: gone, as on a real scoped relay.
    await beacon(seeder, creator.pubkey, 'free-video-7', { listen: false });
    await expect(r.host.adapter.openNfxSession(7, address)).rejects.toThrow(/^no-seeders/);
    expect(r.worker().calls('nfx.play.open')).toEqual([]);
    // A play that is waiting gets the seeder's next beacon (its republish) and opens on it.
    const opening = r.host.adapter.openNfxSession(9, address);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { peer } = await beacon(seeder, creator.pubkey, 'free-video-7', { listen: false });
    const s = await opening;
    expect(s.videoId).toBe(address);
    const [open] = r.worker().calls('nfx.play.open') as [{ readonly peers: { peer: string }[] }];
    expect(open.peers.map((p) => p.peer)).toEqual([peer]);
  });

  it('without scoped relays, or with NFX off, nothing opens', async () => {
    r = await rig({ nfx: { ...NFX_ON, scopedRelays: [] } });
    await r.ready();
    const creator = new kit.TestSigner();
    await manifest(creator, 'free-video-3');
    await beacon(new kit.TestSigner(), creator.pubkey, 'free-video-3');
    await expect(
      r.host.adapter.openNfxSession(7, addrOf(creator.pubkey, 'free-video-3')),
    ).rejects.toThrow(/^no-seeders/);
    await r.host.adapter.updateSettings({ nfx: { ...NFX_ON, enabled: false } });
    await expect(
      r.host.adapter.openNfxSession(7, addrOf(creator.pubkey, 'free-video-3')),
    ).rejects.toThrow(/^not-found/);
  });

  it('a gone webContents closes its sessions, and a dead worker revokes every link', async () => {
    r = await rig({ nfx: NFX_ON });
    await r.ready();
    const creator = new kit.TestSigner();
    await manifest(creator, 'free-video-4');
    await beacon(new kit.TestSigner(), creator.pubkey, 'free-video-4');
    const a = r.host.adapter;
    const mine = await a.openNfxSession(7, addrOf(creator.pubkey, 'free-video-4'));
    const theirs = await a.openNfxSession(9, addrOf(creator.pubkey, 'free-video-4'));
    await a.closeNfxOwner(7);
    expect(r.worker().calls('nfx.play.close')).toEqual([{ sid: mine.sid }]);
    a.onWorkerDown();
    const revoked = r.out.filter((m) => m.kind === 'media-link' && m.url === null);
    expect(revoked).toHaveLength(2);
    expect(r.worker().calls('nfx.play.close')).toEqual([{ sid: mine.sid }]);
    expect(theirs.sid).not.toBe(mine.sid);
  });
});

describe('#89: a play joins its rendition’s signaling room', () => {
  const mesh = (): NostrEvent[] =>
    r!.pool.published.map((p) => p.event).filter((e) => e.kind === nfx.KIND_MESH_SIGNAL);
  const typed = (t: string): NostrEvent[] =>
    mesh().filter((e) => e.tags.some((x) => x[0] === 't' && x[1] === t));
  const pause = (): Promise<void> => new Promise((done) => setTimeout(done, 60));

  it('with a helper: announces while the session is open, on the signaling relays, under a key per play', async () => {
    r = await rig({ nfx: NFX_ON, irohHelper: '/nonexistent/iroh-helper' });
    await r.ready();
    const creator = new kit.TestSigner();
    await manifest(creator, 'free-video-9');
    await beacon(new kit.TestSigner(), creator.pubkey, 'free-video-9');
    const a = r.host.adapter;
    const addr = addrOf(creator.pubkey, 'free-video-9');
    await pause();
    expect(mesh()).toEqual([]); // nothing played, nothing served: no room

    const s = await a.openNfxSession(7, addr);
    const [connect] = await eventually(
      () => (typed('connect').length > 0 ? typed('connect') : null),
      'a connect',
    );
    const room = nfx.meshRoom(`nfx/1/web/${NS}:free-video-9/720p`);
    expect(connect!.tags).toContainEqual(['P', room.key]);
    expect(r.pool.published.find((p) => p.event === connect)?.relays).toEqual(
      DEFAULT_NFX_MESH_RELAYS,
    );

    // The worker's peer and reset events are taken (a smoke check: the play goes on below).
    r.worker().event({ e: 'nfx.rtc.peer', peer: 1, swarm: room.swarm, dir: 'in', open: true });
    r.worker().event({ e: 'nfx.rtc.reset' });

    await a.closeNfxSession(7, s.sid);
    const [bye] = await eventually(
      () => (typed('disconnect').length > 0 ? typed('disconnect') : null),
      'a disconnect',
    );
    expect(bye!.pubkey).toBe(connect!.pubkey);
    expect(bye!.tags).toContainEqual(['P', room.key]);

    // Watched again: another key. Switched off: a disconnect, and nothing after it.
    const again = await a.openNfxSession(7, addr);
    await eventually(
      () => new Set(typed('connect').map((e) => e.pubkey)).size === 2,
      'a second key',
    );
    await a.updateSettings({ nfx: { ...NFX_ON, webrtc: false } });
    await eventually(() => typed('disconnect').length === 2, 'the disconnect of switching off');
    const count = mesh().length;
    await a.closeNfxSession(7, again.sid);
    await a.openNfxSession(7, addr);
    await pause();
    expect(mesh()).toHaveLength(count);
  });

  it('without a helper nothing is signaled', async () => {
    r = await rig({ nfx: NFX_ON });
    await r.ready();
    const creator = new kit.TestSigner();
    await manifest(creator, 'free-video-10');
    await beacon(new kit.TestSigner(), creator.pubkey, 'free-video-10');
    await r.host.adapter.openNfxSession(7, addrOf(creator.pubkey, 'free-video-10'));
    await pause();
    expect(mesh()).toEqual([]);
  });
});

describe('NFX-10 §1: the STUN servers a play’s beacons name reach the worker', () => {
  const HELPER = '/nonexistent/iroh-helper';
  const stunCalls = (): unknown[] => r!.worker().calls('nfx.rtc.stun');
  const pause = (): Promise<void> => new Promise((done) => setTimeout(done, 60));
  /** Global unicast: named by two seeders, by one, and a LAN address named by both. */
  const TWO_KEYS = '185.147.157.180:3478';
  const ONE_KEY = '8.8.8.8:3478';
  const LAN = '192.168.1.2:3478';
  const withStun =
    (...addrs: string[]) =>
    (hyperdht: nfx.Endpoint): nfx.Endpoint[] => [hyperdht, { t: 'stun', addrs }];

  /** A video two seeders beacon, each naming STUN servers; returns its address. */
  async function seeded(videoId: string): Promise<NfxAddress> {
    const creator = new kit.TestSigner();
    await manifest(creator, videoId);
    await beacon(new kit.TestSigner(), creator.pubkey, videoId, {
      endpoints: withStun(TWO_KEYS, ONE_KEY, LAN),
    });
    await beacon(new kit.TestSigner(), creator.pubkey, videoId, {
      endpoints: withStun(LAN, TWO_KEYS),
    });
    return addrOf(creator.pubkey, videoId);
  }

  it('adds a global server two keys name, after the settings’ own; drops it with the play', async () => {
    r = await rig({ nfx: NFX_ON, irohHelper: HELPER });
    await r.ready();
    const a = r.host.adapter;
    const s = await a.openNfxSession(7, await seeded('stun-video-1'));
    const [first] = await eventually(
      () => (stunCalls().length > 0 ? stunCalls() : null),
      'nfx.rtc.stun',
    );
    // Not the one-key server (the settings name one of their own), never the LAN address.
    expect(first).toEqual({ named: [TWO_KEYS] });
    expect(validateWorkerArgs['nfx.rtc.stun'](first)).toBe(true);
    // The settings' own still reach the worker unchanged: the named ones never replace them.
    expect(r.worker().calls('nfx.configure').at(-1)).toMatchObject({
      rtc: { stun: ['web.nutflix.xyz:3478'] },
    });

    // WebRTC off: none. On again, while the play is open: back.
    await a.updateSettings({ nfx: { ...NFX_ON, webrtc: false } });
    expect(stunCalls().at(-1)).toEqual({ named: [] });
    await a.updateSettings({ nfx: NFX_ON });
    expect(stunCalls().at(-1)).toEqual({ named: [TWO_KEYS] });
    // Four of the user's own leave no room.
    const four = ['a.test:1', 'b.test:1', 'c.test:1', 'd.test:1'] as StunServer[];
    await a.updateSettings({ nfx: { ...NFX_ON, stunServers: four } });
    expect(stunCalls().at(-1)).toEqual({ named: [] });
    await a.updateSettings({ nfx: NFX_ON });
    expect(stunCalls()).toHaveLength(5);
    expect(stunCalls().at(-1)).toEqual({ named: [TWO_KEYS] });
    // Settings that change nothing here send nothing.
    await a.updateSettings({ prefetchSeconds: 20 });
    expect(stunCalls()).toHaveLength(5);

    await a.closeNfxSession(7, s.sid);
    await eventually(() => stunCalls().length === 6, 'nfx.rtc.stun after the close');
    expect(stunCalls().at(-1)).toEqual({ named: [] });
  });

  it('keeps a shared named server until the last play closes, without redundant pushes', async () => {
    r = await rig({ nfx: NFX_ON, irohHelper: HELPER });
    await r.ready();
    const a = r.host.adapter;
    const address = await seeded('stun-shared-1');
    const first = await a.openNfxSession(7, address);
    await eventually(() => stunCalls().length === 1, 'the first STUN pick');
    const second = await a.openNfxSession(8, address);
    // updateSettings waits for the queued STUN selection to finish.
    await a.updateSettings({ prefetchSeconds: 20 });
    expect(stunCalls()).toEqual([{ named: [TWO_KEYS] }]);
    await a.closeNfxSession(7, first.sid);
    await a.updateSettings({ prefetchSeconds: 20 });
    expect(stunCalls()).toEqual([{ named: [TWO_KEYS] }]);
    await a.closeNfxSession(8, second.sid);
    await eventually(() => stunCalls().length === 2, 'the last play clearing STUN');
    expect(stunCalls()).toEqual([{ named: [TWO_KEYS] }, { named: [] }]);
  });

  it('combines distinct signers across plays and removes their votes when a play closes', async () => {
    r = await rig({ nfx: NFX_ON, irohHelper: HELPER });
    await r.ready();
    const a = r.host.adapter;
    const first = await a.openNfxSession(7, await seeded('stun-votes-1'));
    await eventually(() => stunCalls().length === 1, 'the first STUN pick');
    const second = await a.openNfxSession(8, await seeded('stun-votes-2'));
    await a.updateSettings({ prefetchSeconds: 20 });
    // ONE_KEY has one signer in each video; together they meet the two-key threshold.
    expect(stunCalls()).toEqual([{ named: [TWO_KEYS] }, { named: [TWO_KEYS, ONE_KEY] }]);
    await a.closeNfxSession(7, first.sid);
    await a.updateSettings({ prefetchSeconds: 20 });
    expect(stunCalls().at(-1)).toEqual({ named: [TWO_KEYS] });
    await a.closeNfxSession(8, second.sid);
    await eventually(() => stunCalls().length === 4, 'the last play clearing STUN');
    expect(stunCalls().at(-1)).toEqual({ named: [] });
  });

  it('names none while there is no WebRTC side: no helper, switched off, or no STUN server of the user’s own', async () => {
    for (const o of [
      { nfx: NFX_ON },
      { nfx: { ...NFX_ON, webrtc: false }, irohHelper: HELPER },
      // An empty list is "none" (WebRTC off), never "whatever Nostr names".
      { nfx: { ...NFX_ON, stunServers: [] }, irohHelper: HELPER },
    ]) {
      r = await rig(o);
      await r.ready();
      const s = await r.host.adapter.openNfxSession(7, await seeded('stun-video-2'));
      await pause();
      expect(stunCalls(), JSON.stringify(o.nfx)).toEqual([]);
      await r.host.adapter.closeNfxSession(7, s.sid);
      await pause();
      expect(stunCalls()).toEqual([]);
      await r.close();
      r = undefined;
    }
  });
});

describe('pear #123: stats for nerds on a free NFX session', () => {
  type Reply = Extract<HostOut, { kind: 'reply' }>;
  let nextId = 1;
  /** One call as main relays it, and its reply. */
  async function invoke(wc: number, method: string, args: unknown[]): Promise<ReplyMsg> {
    const id = nextId++;
    r!.host.handle({ kind: 'call', wc, msg: { v: IPC_V, id, method, args } as never });
    const out = await r!.until(
      (o): o is Reply => o.kind === 'reply' && o.wc === wc && o.msg.id === id,
      `reply ${String(id)}`,
    );
    return out.msg;
  }
  const ADDRESS: PlaySourceAddress = {
    kind: 'hyperdht',
    id: 'f0'.repeat(32),
    address: '198.51.100.9:49737',
    path: 'direct',
  };

  it('asks the worker, for the owner only, and refuses once the session is closed', async () => {
    r = await rig({
      nfx: NFX_ON,
      worker: { handlers: { 'nfx.play.addresses': () => ({ addresses: [ADDRESS] }) } },
    });
    await r.ready();
    const creator = new kit.TestSigner();
    await manifest(creator, 'free-video-11');
    const { peer } = await beacon(new kit.TestSigner(), creator.pubkey, 'free-video-11');
    const s = await r.host.adapter.openNfxSession(7, addrOf(creator.pubkey, 'free-video-11'));

    const stats = await invoke(7, 'session.stats', [s.sid]);
    expect(stats).toMatchObject({
      ok: true,
      result: {
        engine: 'nfx worker: HyperDHT',
        sources: [{ kind: 'hyperdht', id: peer, files: 3, connected: true }],
        verified: 3,
      },
    });
    // Without a helper the host does not signal, so there is no signaling to report.
    expect((stats as { result: object }).result).not.toHaveProperty('signaling');
    expect(r.worker().calls('nfx.play.addresses')).toEqual([]);
    expect(await invoke(7, 'session.addresses', [s.sid])).toMatchObject({
      ok: true,
      result: [ADDRESS],
    });
    expect(r.worker().calls('nfx.play.addresses')).toEqual([{ sid: s.sid }]);
    // Nothing on the host's log names it.
    expect(JSON.stringify(r.log.lines)).not.toContain(ADDRESS.address);

    // Another webContents' sid is unknown to it, and a sid main's guard refuses never arrives.
    for (const m of ['session.stats', 'session.addresses'])
      expect(await invoke(8, m, [s.sid])).toMatchObject({
        ok: false,
        error: { code: 'session-closed' },
      });
    expect(await invoke(7, 'session.stats', ['nope'])).toMatchObject({
      ok: false,
      error: { code: 'invalid-argument' },
    });

    // The in-process view (owner 0) has them too.
    const own = await r.host.adapter.playNfx(addrOf(creator.pubkey, 'free-video-11'));
    await expect(own.stats?.()).resolves.toMatchObject({ engine: 'nfx worker: HyperDHT' });
    await expect(own.addresses?.()).resolves.toEqual([ADDRESS]);
    await own.close();
    await expect(own.stats?.()).rejects.toMatchObject({ code: 'session-closed' });

    await r.host.adapter.closeNfxSession(7, s.sid);
    for (const m of ['session.stats', 'session.addresses'])
      expect(await invoke(7, m, [s.sid])).toMatchObject({
        ok: false,
        error: { code: 'session-closed' },
      });
  });

  it('with WebRTC on, the signaling relays and how many it hears on', async () => {
    r = await rig({ nfx: NFX_ON, irohHelper: '/nonexistent/iroh-helper' });
    await r.ready();
    const creator = new kit.TestSigner();
    await manifest(creator, 'free-video-12');
    await beacon(new kit.TestSigner(), creator.pubkey, 'free-video-12');
    const s = await r.host.adapter.openNfxSession(7, addrOf(creator.pubkey, 'free-video-12'));
    const reply = await invoke(7, 'session.stats', [s.sid]);
    const signaling = (reply as { result: { signaling?: unknown } }).result.signaling;
    expect(signaling).toMatchObject({
      kind: 'nostr',
      endpoints: DEFAULT_NFX_MESH_RELAYS.map((u) => new URL(u).host),
    });
    expect((signaling as { open: number }).open).toBeLessThanOrEqual(
      DEFAULT_NFX_MESH_RELAYS.length,
    );
  });
});
