/**
 * Slice 5d-3 (contracts v11): free NFX play on the host. The seeders come from the video's live,
 * verified, free beacons on the scoped relays only; no money is involved; closing revokes the link
 * and closes the worker's session, and a gone webContents closes its sessions.
 */
import { generateKeyPairSync } from 'node:crypto';

import type { IrohRelayUrl, NfxAddress, NostrEvent, RelayUrl } from '@sovit/core';
import { mocks, nfx } from '@sovit/core';
import { hyperdhtEndpoint } from '@sovit/seeder';
import { afterEach, describe, expect, it } from 'vitest';

import { validateWorkerArgs } from '../../ipc/worker-guards.js';
import { coreTestKit, type TestSignerLike } from './support/core-helpers.js';
import type { Rig } from './support/rig.js';
import { rig } from './support/rig.js';

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
