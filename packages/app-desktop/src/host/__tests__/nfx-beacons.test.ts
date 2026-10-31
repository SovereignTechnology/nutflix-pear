/**
 * Slice 5c: the beacon publisher. Beacons go to the scoped relays only, only while the worker
 * serves, only for a video whose current manifest by the recorded author names the stored root,
 * and each one passes core's `parseBeacon` (free, `price_hint` 0, `chunks` all, TTL 120 s).
 * Slice 5e-3: the worker is asked per video, and its iroh endpoint goes beside the HyperDHT one,
 * naming a relay only when it is one of the network's.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  IrohRelayUrl,
  NfxAddress,
  NfxVideo,
  NostrEvent,
  NostrPubkey,
  RelayUrl,
  Sha256Hex,
} from '@sovit/core';
import { nfx } from '@sovit/core';
import { hyperdhtEndpoint } from '@sovit/seeder';
import { afterEach, describe, expect, it } from 'vitest';

import type { NfxEndpointsWire, NfxIrohEndpointWire } from '../../ipc/worker-protocol.js';
import { memoryLogger } from '../log.js';
import { BEACON_TTL_S, NfxBeacons, beaconEndpoints, type NfxBeaconDeps } from '../nfx/beacons.js';
import { NfxSeederKey } from '../nfx/seeder-key.js';
import { coreTestKit } from './support/core-helpers.js';

const kit = await coreTestKit();
const NS = 'nfx:testnet:1';
const NOW = 1_790_000_000;
const SCOPED = 'wss://scoped.test' as RelayUrl;
const ROOT = 'ab'.repeat(32) as Sha256Hex;
const VIDEO = `${NS}:nutflix-${'c'.repeat(32)}`;
const CREATOR = 'd'.repeat(64) as NostrPubkey;
const ADDRESS = `38504:${CREATOR}:${VIDEO}` as NfxAddress;
const IROH_RELAY = 'https://iroh-relay.test/' as IrohRelayUrl;
/** Slice 5e-3: an iroh endpoint as the worker answers it (tickets in its own order). */
const IROH: NfxIrohEndpointWire = {
  t: 'iroh',
  node: 'e1'.repeat(32),
  relay: IROH_RELAY,
  addrs: ['192.0.2.7:4433', '[2001:db8::7]:4433'],
  tickets: {
    $map: [
      ['meta', `blob${'m'.repeat(60)}`],
      ['720p', `blob${'s'.repeat(60)}`],
      ['360p', `blob${'t'.repeat(60)}`],
    ],
  },
};

/** An Ed25519 key pair in sodium's form (secret = seed ‖ public), as a HyperDHT key is. */
function peerKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d!, 'base64url');
  const pub = Buffer.from(jwk.x!, 'base64url');
  return { publicKey: new Uint8Array(pub), secretKey: new Uint8Array(Buffer.concat([seed, pub])) };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function seederKey(): Promise<NfxSeederKey> {
  const d = await mkdtemp(join(tmpdir(), 'nf-nfx-beacons-'));
  dirs.push(d);
  const user = new kit.TestSigner();
  return NfxSeederKey.open({ dir: join(d, 'nfx'), network: NS, user: user.pubkey, seal: user });
}

function manifest(root: Sha256Hex = ROOT): NfxVideo {
  return { root } as NfxVideo;
}

async function setup(over: Partial<NfxBeaconDeps> = {}): Promise<{
  beacons: NfxBeacons;
  sent: { event: NostrEvent; relays: readonly RelayUrl[] }[];
  key: NfxSeederKey;
  manifests: NfxAddress[];
}> {
  const key = await seederKey();
  const peer = peerKeyPair();
  const sent: { event: NostrEvent; relays: readonly RelayUrl[] }[] = [];
  const manifests: NfxAddress[] = [];
  const beacons = new NfxBeacons({
    scopedRelays: () => [SCOPED],
    key: () => Promise.resolve(key),
    endpoint: (seeder) =>
      Promise.resolve({ hyperdht: hyperdhtEndpoint(peer, seeder, NS), iroh: null }),
    irohRelays: () => [IROH_RELAY],
    stored: () => Promise.resolve([{ video: VIDEO, root: ROOT, segs: 9 }]),
    seeded: () => [{ video: VIDEO, author: CREATOR, root: ROOT }],
    manifest: (addr) => {
      manifests.push(addr);
      return Promise.resolve(manifest());
    },
    send: (event, relays) => {
      sent.push({ event, relays });
      return Promise.resolve(1);
    },
    now: () => NOW,
    log: memoryLogger(),
    ...over,
  });
  return { beacons, sent, key, manifests };
}

describe('NfxBeacons', () => {
  it('publishes one verified free beacon per seeded video, to the scoped relays only', async () => {
    const { beacons, sent, key, manifests } = await setup();
    expect(await beacons.round()).toEqual({ published: 1 });
    expect(manifests).toEqual([ADDRESS]);
    expect(sent).toHaveLength(1);
    const { event, relays } = sent[0]!;
    expect(relays).toEqual([SCOPED]);
    expect(event.pubkey).toBe(key.pubkey);
    const parsed = nfx.parseBeacon(event, NOW);
    if (!parsed.ok) throw new Error(parsed.error.reason);
    expect(parsed.value.creator).toBe(CREATOR);
    expect(parsed.value.expiration).toBe(BigInt(NOW + BEACON_TTL_S));
    expect(parsed.value.content).toMatchObject({
      chunks: 'all',
      priceHint: 0n,
      acceptsMints: [],
      free: true,
    });
    expect(parsed.value.content.video.toString()).toBe(VIDEO);
    expect(parsed.value.content.endpoints.map((e) => e.t)).toEqual(['hyperdht']);
  });

  it('is idle without scoped relays, a key or a serving worker, in that order', async () => {
    let keyAsked = 0;
    const a = await setup({
      scopedRelays: () => [],
      key: () => {
        keyAsked++;
        return Promise.resolve(null);
      },
    });
    expect(await a.beacons.round()).toEqual({ published: 0, idle: 'no-scoped-relays' });
    expect(keyAsked).toBe(0);
    const b = await setup({ key: () => Promise.resolve(null) });
    expect(await b.beacons.round()).toEqual({ published: 0, idle: 'no-key' });
    const c = await setup({ endpoint: () => Promise.resolve({ hyperdht: null, iroh: null }) });
    expect(await c.beacons.round()).toEqual({ published: 0, idle: 'not-serving' });
    // Not serving: the manifest was never looked up either.
    expect(c.manifests).toEqual([]);
    for (const x of [a, b, c]) expect(x.sent).toEqual([]);
  });

  it('slice 5e-3: asks per video and puts the iroh endpoint beside the HyperDHT one', async () => {
    const asked: [string, string][] = [];
    const peer = peerKeyPair();
    const { beacons, sent } = await setup({
      endpoint: (seeder, video) => {
        asked.push([seeder, video]);
        return Promise.resolve({ hyperdht: hyperdhtEndpoint(peer, seeder, NS), iroh: IROH });
      },
    });
    expect(await beacons.round()).toEqual({ published: 1 });
    const parsed = nfx.parseBeacon(sent[0]!.event, NOW);
    if (!parsed.ok) throw new Error(parsed.error.reason);
    expect(asked).toEqual([[parsed.value.seeder, VIDEO]]);
    const [iroh, hyperdht] = parsed.value.content.endpoints;
    expect(hyperdht?.t).toBe('hyperdht');
    expect(iroh).toEqual({
      t: 'iroh',
      node: IROH.node,
      relay: IROH_RELAY,
      addrs: IROH.addrs,
      tickets: new Map(IROH.tickets.$map),
    });
    // In key order on the wire, as nfx-proto writes them.
    const content = JSON.parse(sent[0]!.event.content) as {
      endpoints: { tickets?: Record<string, string> }[];
    };
    expect(Object.keys(content.endpoints[0]!.tickets!)).toEqual(['360p', '720p', 'meta']);

    // Served over iroh only: the beacon names that alone.
    const only = await setup({ endpoint: () => Promise.resolve({ hyperdht: null, iroh: IROH }) });
    expect(await only.beacons.round()).toEqual({ published: 1 });
    const alone = nfx.parseBeacon(only.sent[0]!.event, NOW);
    expect(alone.ok && alone.value.content.endpoints.map((e) => e.t)).toEqual(['iroh']);
  });

  it('slice 5e-3: names an iroh relay only when it is one of the network’s', () => {
    const served: NfxEndpointsWire = { hyperdht: null, iroh: IROH };
    const [kept] = beaconEndpoints(served, [IROH_RELAY]);
    expect(kept).toMatchObject({ t: 'iroh', relay: IROH_RELAY });
    const [dropped] = beaconEndpoints(served, ['https://other-relay.test/']);
    expect(dropped).toMatchObject({ t: 'iroh', relay: '' });
    const [none] = beaconEndpoints({ hyperdht: null, iroh: { ...IROH, relay: '' } }, [IROH_RELAY]);
    expect(none).toMatchObject({ t: 'iroh', relay: '' });
    expect(beaconEndpoints({ hyperdht: null, iroh: null }, [IROH_RELAY])).toEqual([]);
  });

  it('never beacons a video of unknown author, a deleted manifest, or another root', async () => {
    const unknown = await setup({ seeded: () => [] });
    expect(await unknown.beacons.round()).toEqual({ published: 0 });
    const deleted = await setup({ manifest: () => Promise.resolve(null) });
    expect(await deleted.beacons.round()).toEqual({ published: 0 });
    const other = await setup({
      manifest: () => Promise.resolve(manifest('ef'.repeat(32) as Sha256Hex)),
    });
    expect(await other.beacons.round()).toEqual({ published: 0 });
    const stale = await setup({
      stored: () =>
        Promise.resolve([{ video: VIDEO, root: 'ef'.repeat(32) as Sha256Hex, segs: 9 }]),
    });
    expect(await stale.beacons.round()).toEqual({ published: 0 });
    for (const x of [unknown, deleted, other, stale]) expect(x.sent).toEqual([]);
  });

  it('checks the manifest every 10 minutes, not every round', async () => {
    let now = NOW;
    const { beacons, manifests, sent } = await setup({ now: () => now });
    await beacons.round();
    now += 60;
    await beacons.round();
    expect(manifests).toHaveLength(1);
    expect(sent).toHaveLength(2);
    now += 600;
    await beacons.round();
    expect(manifests).toHaveLength(2);
  });

  it('a failing round is logged and the next one runs', async () => {
    let fail = true;
    const log = memoryLogger();
    const { beacons } = await setup({
      stored: () =>
        fail
          ? Promise.reject(new Error('worker down'))
          : Promise.resolve([{ video: VIDEO, root: ROOT, segs: 9 }]),
      log,
    });
    expect(await beacons.round()).toEqual({ published: 0 });
    expect(log.lines.some((l) => l.msg === 'nfx beacons: the round failed')).toBe(true);
    fail = false;
    expect(await beacons.round()).toEqual({ published: 1 });
  });

  it('starts with a round, then one per interval, until stopped', async () => {
    const ticks: (() => void)[] = [];
    let cleared = 0;
    const { beacons, sent } = await setup({
      timers: {
        setInterval: (fn) => {
          ticks.push(fn);
          return 1;
        },
        clearInterval: () => {
          cleared++;
        },
      },
    });
    beacons.start();
    await beacons.round();
    expect(sent).toHaveLength(1);
    ticks[0]!();
    await beacons.round();
    expect(sent.length).toBeGreaterThanOrEqual(2);
    beacons.stop();
    expect(cleared).toBe(1);
  });
});
