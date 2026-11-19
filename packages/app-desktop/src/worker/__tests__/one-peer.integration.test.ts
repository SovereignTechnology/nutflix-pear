/**
 * Security review F33 and issue #8 on the desktop path: three `@sovit/seeder` fixture nodes on a
 * local `hyperdht` testnet (127.0.0.1 only), each holding the WHOLE blob, and the desktop
 * `WorkerHost` (`--dev-mocks`: `MockPaymentEngine`, the loopback `pay/1` hub) playing it through
 * the real framed wire with a prefetch covering the whole file, so the three race for every block.
 *
 *   - one seeder per block: every block is delivered ONCE, and the seeders' own engines counted
 *     exactly the blocks the viewer received — none sent twice, none paid twice;
 *   - seeders paid fairly: each is paid exactly for the blocks it delivered;
 *   - credit per seeder window: A has a window of 8, B of 4, C of 1. C is never overrun (its
 *     outstanding count, read inside its own `recordUpload`, never passes 1; no ban), and the
 *     viewer's pool grows to 8 + 4 + 1 instead of staying at the old global 4;
 *   - a seeder that disconnects mid-download: the rest comes from the others, each block once,
 *     and no block is paid to two seeders.
 *
 * The video's policy sets a 2-sat minimum PAY at 2 sats/block, so each seeder's effective window
 * (ADR 0007) is exactly its configured one.
 */
import { randomBytes } from 'node:crypto';

import type { BlockRange, NostrPubkey, PeerWindow, PricePolicy, Sats } from '@sovit/core';
import type Hypercore from 'hypercore';
import type { Logger } from '@sovit/seeder';
import { createLogger, nodeFs, toHex } from '@sovit/seeder';
import { afterEach, describe, expect, it } from 'vitest';

import type { SessionId } from '../../ipc/protocol.js';
import type { PlayOpenArgs, WorkerEvent } from '../../ipc/worker-protocol.js';
import { sodiumCrypto } from '../crypto.js';
import type { DevMockProviders } from '../dev/dev-mocks.js';
import type { DevTestnet, FixtureSeeder } from '../dev/fixtures-net.js';
import {
  createFixtureSeeder,
  devFixturePolicy,
  fixtureManifest,
  startDevTestnet,
  syntheticBytes,
  within,
} from '../dev/fixtures-net.js';
import { LoopbackPayHub } from '../dev/loopback-pay.js';
import type { WorkerClient } from './helpers/harness.js';
import { httpGet, startWorker, tempDir, until } from './helpers/harness.js';

const BLOCK = 65_536;
const N = 48;
const quiet: Logger = createLogger({ level: 'error', sink: () => undefined });
const sid = (): SessionId => randomBytes(16).toString('hex') as SessionId;
/** Exact windows: a 2-sat minimum PAY at 2 sats/block (ceil(2 / 2) = 1 never widens them). */
const POLICY: PricePolicy = { ...devFixturePolicy(), minPaySats: 2 as Sats };

interface Net {
  readonly testnet: DevTestnet;
  readonly hub: LoopbackPayHub;
  readonly seeders: readonly FixtureSeeder[];
  readonly bytes: Uint8Array;
  readonly worker: WorkerClient;
  readonly args: PlayOpenArgs;
  /** Max outstanding each seeder's engine recorded toward the viewer (inside `recordUpload`). */
  readonly worst: number[];
  readonly bansFor: (fx: FixtureSeeder) => number;
}

const teardown: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of teardown.splice(0).reverse()) await close();
}, 60_000);

/** Resolves once every unit of `pool` is settled. */
async function drained(fx: FixtureSeeder): Promise<void> {
  await until(
    () => fx.credit.size === 0,
    (cb) => fx.credit.onAvailable(cb),
    20_000,
    'mirror credit',
  );
}

/**
 * S[0] writes the blob; the others mirror ALL of it (as paying viewers, so they are credit-gated
 * and routed like any viewer); then the worker is started on the same testnet.
 */
async function net(windows: readonly number[]): Promise<Net> {
  const testnet = await startDevTestnet();
  teardown.push(() => testnet.destroy());
  const hub = new LoopbackPayHub();
  const dir = await tempDir('nf-f33-');
  teardown.push(() => dir.rm());
  const seeders: FixtureSeeder[] = [];
  for (const [i, windowBlocks] of windows.entries()) {
    const fx = await createFixtureSeeder({
      name: `s${String(i)}`,
      dataDir: nodeFs.join(dir.dir, `s${String(i)}`),
      fs: nodeFs,
      crypto: sodiumCrypto,
      hub,
      bootstrap: testnet.bootstrap,
      logger: quiet,
      policy: POLICY,
      windowBlocks,
    });
    teardown.push(() => fx.close());
    seeders.push(fx);
  }
  const origin = seeders[0]!;
  const bytes = syntheticBytes(N * BLOCK, 0x33f);
  const put = await origin.seeder.putBytes(bytes, { mime: 'video/mp4' });
  if (!put.ok) throw new Error(put.error.code);
  const entry = put.entry;
  for (const fx of seeders) fx.seeder.setCorePolicy(entry.coreKey, POLICY);
  const oc = origin.seeder.blobs.coreByKey(entry.coreKey)!.core;
  origin.node.join(oc.discoveryKey, { server: true, client: false });
  await within(origin.node.flushed(oc.discoveryKey), 20_000, 'origin announce');
  for (const fx of seeders.slice(1)) {
    const sc = await fx.seeder.blobs.openCoreByKey(oc.key);
    fx.payer.attachCore(sc.core);
    fx.node.join(sc.core.discoveryKey, { server: true, client: true });
    const waits: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      await within(fx.credit.acquire(entry.coreKey, i).promise, 20_000, 'mirror credit');
      waits.push(sc.core.download({ start: i, end: i + 1 }).done());
    }
    await within(Promise.all(waits), 30_000, 'mirror download');
    await fx.payer.flush();
    await drained(fx);
    await within(fx.node.flushed(sc.core.discoveryKey), 20_000, 'mirror announce');
  }

  const worker = startWorker({ hub, logLevel: 'error' });
  teardown.push(() => worker.close());
  const wdir = await tempDir('nf-f33-worker-');
  teardown.push(() => wdir.rm());
  await worker.call('init', {
    v: 1,
    storage: wdir.dir,
    seeding: { enabled: false, diskCapBytes: 1024 ** 3 },
    prefetchSeconds: 600,
    dev: {
      mocks: true,
      fixtures: false,
      bootstrap: testnet.bootstrap.map((b) => ({ host: '127.0.0.1' as const, port: b.port })),
    },
  });
  await worker.event(
    (e): e is Extract<WorkerEvent, { e: 'ready' }> => e.e === 'ready',
    5000,
    'ready',
  );
  const viewerPk = (worker.host.internals.providers as DevMockProviders).pubkey;
  // Each seeder's outstanding count toward the viewer, read where the seeder decides to cut.
  const worst = seeders.map(() => 0);
  for (const [k, fx] of seeders.entries()) {
    const record = fx.engine.recordUpload.bind(fx.engine);
    fx.engine.recordUpload = (peer: NostrPubkey, blocks: BlockRange, pricing): PeerWindow => {
      const w = record(peer, blocks, pricing);
      if (peer === viewerPk) worst[k] = Math.max(worst[k] ?? 0, w.outstanding);
      return w;
    };
  }
  const video = fixtureManifest(
    entry,
    { title: 'F33', bytes, durationSec: 60 },
    POLICY,
    origin.engine.config.ownPubkey,
    Date.now(),
  );
  const r = video.renditions[0]!;
  const args: PlayOpenArgs = {
    sid: sid(),
    videoId: video.id,
    // 64 kbps and 600 s of prefetch: ~73 blocks allowed at once — the whole file, unpaced.
    rendition: { label: r.label, hyper: r.hyper, size: r.size, bitrateKbps: 64 },
    policy: POLICY,
    prefetchSeconds: 600,
  };
  return {
    testnet,
    hub,
    seeders,
    bytes,
    worker,
    args,
    worst,
    bansFor: (fx) => fx.seeder.bans().length + fx.engine.bans().length,
  };
}

function track(core: Hypercore): { index: number; from: string }[] {
  const out: { index: number; from: string }[] = [];
  core.on('download', (index, _b, peer) => {
    out.push({ index, from: toHex(peer.remotePublicKey) });
  });
  return out;
}

async function settled(w: WorkerClient): Promise<void> {
  const payer = w.host.internals.payer!;
  const credit = w.host.internals.credit!;
  await payer.flush();
  await until(
    () => credit.size === 0,
    (cb) => credit.onAvailable(cb),
    20_000,
    'every PAY ACKed',
  );
}

describe('F33 / issue #8 — one seeder per block, credit per seeder window (desktop)', () => {
  it(
    'three full seeders race for 48 blocks: each delivered and paid ONCE, each seeder paid exactly for what it sent, the window-1 seeder never overrun',
    { timeout: 120_000 },
    async () => {
      const n = await net([8, 4, 1]);
      const { link, key } = await n.worker.call('play.open', n.args);
      const viewerCore = n.worker.host.internals.seeder!.blobs.coreByKey(key)!.core;
      const downloads = track(viewerCore);
      const body = await within(httpGet(link), 60_000, 'the whole blob over HTTP');
      expect(body.status).toBe(200);
      expect(Buffer.compare(body.body, Buffer.from(n.bytes))).toBe(0);
      await settled(n.worker);

      // One delivery per block.
      expect(downloads).toHaveLength(N);
      expect(new Set(downloads.map((d) => d.index)).size).toBe(N);

      const providers = n.worker.host.internals.providers as DevMockProviders;
      const viewerPk = providers.pubkey;
      let sent = 0;
      for (const [k, fx] of n.seeders.entries()) {
        await fx.seeder.flushNow();
        const w = fx.engine.window(viewerPk);
        const delivered = downloads.filter((d) => d.from === fx.noiseKeyHex()).length;
        // Paid exactly for what it sent, which is exactly what the viewer received from it.
        expect(w?.uploaded ?? 0, `seeder ${String(k)} sent`).toBe(delivered);
        expect(w?.paid ?? 0, `seeder ${String(k)} paid`).toBe(delivered);
        expect(w?.banned ?? false).toBe(false);
        sent += w?.uploaded ?? 0;
      }
      expect(sent).toBe(N); // nothing sent twice
      const price = POLICY.satsPerBlock;
      expect(providers.engine.spent().total).toBe(N * price);
      const spends = n.worker.events.filter(
        (e): e is Extract<WorkerEvent, { e: 'spend' }> => e.e === 'spend' && e.sid === n.args.sid,
      );
      expect(spends.reduce((a, e) => a + e.amount, 0)).toBe(N * price);

      // Pear #123 (stats for nerds): each seeder its `peers` events name, at the remote end of
      // its live connection, through the real wire and its guards; and nothing logged it.
      const lastPeers =
        n.worker.events
          .filter(
            (e): e is Extract<WorkerEvent, { e: 'peers' }> =>
              e.e === 'peers' && e.sid === n.args.sid,
          )
          .at(-1)?.peers ?? [];
      expect(lastPeers.length).toBeGreaterThan(0);
      const { addresses } = await n.worker.call('play.addresses', { sid: n.args.sid });
      expect(addresses.map((a) => a.id).sort()).toEqual(lastPeers.map((p) => p.pubkey).sort());
      for (const a of addresses) {
        expect(a).toMatchObject({ kind: 'hypercore', path: 'direct' });
        expect(a.address).toMatch(/^(?:[0-9.]+|\[[0-9a-f:.]+\]):[0-9]+$/);
        expect(JSON.stringify(n.worker.events)).not.toContain(a.address);
      }

      // Issue #8: each seeder within its own window — the window-1 seeder included.
      for (const [k, window] of [8, 4, 1].entries())
        expect(n.worst[k], `seeder ${String(k)} (window ${String(window)})`).toBeLessThanOrEqual(
          window,
        );
      for (const fx of n.seeders) expect(n.bansFor(fx)).toBe(0);
      expect(n.worker.host.internals.seeder!.bans()).toEqual([]);
      // The pool follows the seeders' windows (it was a global 4).
      expect(n.worker.host.internals.credit!.limit).toBe(8 + 4 + 1);
      expect(n.worker.host.internals.payer!.stats()).toMatchObject({
        acksRejected: 0,
        unmatchedAcks: 0,
        owed: 0,
      });
      await n.worker.call('play.close', { sid: n.args.sid });
      await expect(n.worker.call('play.addresses', { sid: n.args.sid })).rejects.toMatchObject({
        code: 'session-closed',
      });
      expect(n.worker.invalid).toEqual([]);
    },
  );

  it(
    'a seeder that disconnects mid-download: the rest comes from the others, each block once, no block paid twice',
    { timeout: 120_000 },
    async () => {
      const n = await net([8, 4, 4]);
      const providers = n.worker.host.internals.providers as DevMockProviders;
      // Every PAY the viewer builds: which seeder, which blocks.
      const paidTo = new Map<NostrPubkey, number[]>();
      const pay = providers.engine.pay.bind(providers.engine);
      providers.engine.pay = (range, seeder, ...rest) => {
        const list = paidTo.get(seeder.pubkey) ?? [];
        for (let i = range.fromBlock; i <= range.toBlock; i++) list.push(i);
        paidTo.set(seeder.pubkey, list);
        return pay(range, seeder, ...rest);
      };
      const { link, key } = await n.worker.call('play.open', n.args);
      const viewerCore = n.worker.host.internals.seeder!.blobs.coreByKey(key)!.core;
      const downloads = track(viewerCore);
      const listeners = new Set<() => void>();
      viewerCore.on('download', () => {
        for (const cb of [...listeners]) cb();
      });
      const body = httpGet(link);
      await until(
        () => downloads.length >= N / 3,
        (cb) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        60_000,
        'a third of the blocks',
      );
      const noise = new Map(n.seeders.map((fx) => [fx, fx.noiseKeyHex()]));
      const gone = n.seeders[1]!;
      await gone.node.destroy();
      const res = await within(body, 60_000, 'the whole blob over HTTP');
      expect(Buffer.compare(res.body, Buffer.from(n.bytes))).toBe(0);
      await settled(n.worker);

      expect(downloads).toHaveLength(N);
      expect(new Set(downloads.map((d) => d.index)).size).toBe(N);
      // No block paid twice, and nobody paid for a block it did not deliver.
      const all = [...paidTo.values()].flat();
      expect(new Set(all).size).toBe(all.length);
      const viewerPk = providers.pubkey;
      for (const fx of n.seeders) {
        const delivered = new Set(
          downloads.filter((d) => d.from === noise.get(fx)).map((d) => d.index),
        );
        const paid = paidTo.get(fx.engine.config.ownPubkey) ?? [];
        for (const i of paid) expect(delivered.has(i)).toBe(true);
        if (fx === gone) {
          expect(paid.length).toBeLessThanOrEqual(delivered.size);
          continue;
        }
        // The survivors: paid for every block they delivered, and they sent nothing else.
        expect(paid.length).toBe(delivered.size);
        await fx.seeder.flushNow();
        const w = fx.engine.window(viewerPk);
        expect(w?.uploaded ?? 0).toBe(delivered.size);
        expect(w?.paid ?? 0).toBe(delivered.size);
      }
      expect(providers.engine.spent().total).toBe(all.length * POLICY.satsPerBlock);
      for (const fx of n.seeders) if (fx !== gone) expect(n.bansFor(fx)).toBe(0);
      await n.worker.call('play.close', { sid: n.args.sid });
    },
  );
});
