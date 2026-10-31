/**
 * Slice 5d-3 (contracts v11): free NFX play on the host. The seeders come from the video's live,
 * verified, free beacons on the scoped relays only; no money is involved; closing revokes the link
 * and closes the worker's session, and a gone webContents closes its sessions.
 */
import { generateKeyPairSync } from 'node:crypto';

import type { NfxAddress, NostrEvent, RelayUrl } from '@sovit/core';
import { mocks, nfx } from '@sovit/core';
import { hyperdhtEndpoint } from '@sovit/seeder';
import { afterEach, describe, expect, it } from 'vitest';

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
  o: { readonly free?: boolean } = {},
): Promise<{ readonly peer: string }> {
  const addr = `38504:${creator}:${NS}:${videoId}`;
  // A little ahead of the rig's clock (which ticks per read), well inside the 15-minute skew.
  const now = mocks.FIXTURE_NOW + 300;
  const endpoint = hyperdhtEndpoint(peerKeyPair(), seeder.pubkey, NS);
  const video = nfx.VideoAddr.parse(`${NS}:${videoId}`);
  const tags = nfx.beaconTags(addr, now, 120);
  if (!video.ok || !tags.ok) throw new Error('bad test beacon');
  const free = o.free ?? true;
  const content = nfx.beaconContentText({
    v: 1,
    video: video.value,
    endpoints: [endpoint],
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
    });
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
