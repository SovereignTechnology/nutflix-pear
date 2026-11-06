/**
 * Slice 5e-4 (ADR 0021): a worker WITHOUT payment providers plays a free NFX video from a seeder
 * that it can reach over iroh only — as it would watch an nfxd — through the REAL helper
 * (`NUTFLIX_IROH_HELPER`, which CI builds: ci.yml's `iroh-helper` job) and the real wire
 * (`WorkerRpc` + the L6-0 guards). The seeder is a second worker serving the test video over iroh
 * (slice 5e-3); the watcher is given only that iroh endpoint, no HyperDHT peer, and its link must
 * serve layout C (init ‖ sidx ‖ segments from their `moof`), byte for byte. No relay: direct
 * addresses on this host.
 *
 * Also: closing the last session stops the watching helper, and a worker without a helper refuses
 * an iroh-only session (`no-seeders`) instead of hanging.
 *
 * Skipped where no helper is built (a developer's machine); FAILS in CI without one, so it can
 * never pass by being skipped.
 */
import { randomBytes } from 'node:crypto';

import type { NostrPubkey } from '@sovit/core';
import { nfx } from '@sovit/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SessionId } from '../../ipc/protocol.js';
import type { NfxIrohEndpointWire, WorkerEvent } from '../../ipc/worker-protocol.js';
import { devMockProviders } from '../dev/dev-mocks.js';
import type { DevTestnet } from '../dev/fixtures-net.js';
import { startDevTestnet } from '../dev/fixtures-net.js';
import { LoopbackPayHub } from '../dev/loopback-pay.js';
import type { WorkerClient } from './helpers/harness.js';
import { httpGet, sleep, startWorker, tempDir } from './helpers/harness.js';
import { testNfxVideo } from './helpers/nfx-video.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const HELPER = process.env['NUTFLIX_IROH_HELPER'] ?? '';
const IN_CI = (process.env['CI'] ?? '') !== '';
const MISSING =
  'NUTFLIX_IROH_HELPER names no iroh helper: CI builds one for this (ci.yml, the iroh-helper job)';
const SEEDER = 'ab'.repeat(32) as NostrPubkey;
/** How long the seeding worker may take to import and ticket the video. */
const SERVE_WITHIN_MS = 60_000;

const sid = (): SessionId => randomBytes(16).toString('hex') as SessionId;

type LogEvent = Extract<WorkerEvent, { e: 'log' }>;
const logs = (w: WorkerClient): string =>
  w.events
    .filter((e): e is LogEvent => e.e === 'log')
    .map((e) => `${e.level}: ${e.msg}`)
    .join('\n');

describe.skipIf(HELPER === '' && !IN_CI)('slice 5e-4: NFX play over iroh', () => {
  const teardown: (() => Promise<void>)[] = [];
  const v = testNfxVideo();
  let testnet: DevTestnet;
  let endpoint: NfxIrohEndpointWire;

  beforeAll(async () => {
    if (HELPER === '') return;
    testnet = await startDevTestnet();
    teardown.push(() => testnet.destroy());
    endpoint = await seedOverIroh();
  });
  afterAll(async () => {
    for (const t of teardown.splice(0).reverse()) await t().catch(() => undefined);
  });

  /**
   * The seeder: a worker with (mock) payment providers, seeding and NFX on, the helper given and
   * the test video in its NFX store; its beacon's iroh endpoint once it serves the video.
   */
  async function seedOverIroh(): Promise<NfxIrohEndpointWire> {
    const hub = new LoopbackPayHub();
    const d = await tempDir('nf-iroh-seed-');
    teardown.push(() => d.rm());
    const label = `iroh-seed-${randomBytes(4).toString('hex')}`;
    const w = startWorker({
      hub,
      logLevel: 'info',
      testBootstrap: testnet.bootstrap,
      providers: () => devMockProviders({ hub, label }),
    });
    teardown.push(() => w.close());
    await w.call('init', {
      v: 1,
      storage: d.dir,
      seeding: { enabled: true, diskCapBytes: 1024 ** 3 },
      prefetchSeconds: 30,
      nfx: { enabled: true, irohRelays: [] },
      irohHelper: HELPER,
    });
    await w.event((e): e is Extract<WorkerEvent, { e: 'ready' }> => e.e === 'ready', 10_000);
    const seeder = w.host.internals.seeder;
    if (seeder === null) throw new Error('the seeding worker has no seeder');
    const addr = nfx.VideoAddr.parse(v.video);
    if (!addr.ok) throw new Error('bad test video');
    const put = await seeder.nfx.putVideo({
      video: addr.value,
      root: v.root,
      segs: BigInt(v.segs),
      hashListBytes: v.files.get(v.root)!,
      read: (e) => Promise.resolve(v.files.get(e.sha256)!),
    });
    expect(put.ok).toBe(true);
    const deadline = Date.now() + SERVE_WITHIN_MS;
    for (;;) {
      const r = await w.call('nfx.endpoint', { seeder: SEEDER, video: v.video });
      if (r.iroh !== null) return r.iroh;
      if (Date.now() > deadline)
        throw new Error(`no iroh endpoint in time; the seeder said:\n${logs(w)}`);
      await sleep(250);
    }
  }

  /** A watcher: no payment providers (no seeder, no swarm), NFX on, with or without a helper. */
  async function watcher(helper: string | null): Promise<WorkerClient> {
    const d = await tempDir('nf-iroh-watch-');
    teardown.push(() => d.rm());
    const w = startWorker({ logLevel: 'info', testBootstrap: testnet.bootstrap });
    teardown.push(() => w.close());
    await w.call('init', {
      v: 1,
      storage: d.dir,
      seeding: { enabled: false, diskCapBytes: 1024 ** 3 },
      prefetchSeconds: 30,
      nfx: { enabled: true, irohRelays: [] },
      ...(helper === null ? {} : { irohHelper: helper }),
    });
    expect(w.host.internals.seeder).toBeNull();
    return w;
  }

  const args = (over: { readonly rendition?: string } = {}) => ({
    sid: sid(),
    video: v.video,
    root: v.root,
    segs: v.segs,
    ...over,
    peers: [],
    iroh: [endpoint],
    prefetchSeconds: 30,
  });

  it('plays from an iroh-only seeder, byte for byte, and stops its helper after', async () => {
    expect(HELPER, MISSING).not.toBe('');
    const w = await watcher(HELPER);
    const open = args();
    const opened = await w.call('nfx.play.open', open);
    expect(opened.rendition).toBe('720p');
    const whole = await httpGet(opened.link);
    expect(whole.status).toBe(200);
    expect(whole.body.equals(Buffer.from(v.expected)), logs(w)).toBe(true);
    // A range from the middle of the last segment to the end.
    const at = v.segmentAt.at(-1)! + 3;
    const tail = await httpGet(opened.link, { range: `bytes=${String(at)}-` });
    expect(tail.status).toBe(206);
    expect(tail.body.equals(Buffer.from(v.expected.subarray(at)))).toBe(true);

    // A second rendition at the same time shares the watching node.
    const low = args({ rendition: '360p' });
    const second = await w.call('nfx.play.open', low);
    expect((await httpGet(second.link)).body.equals(Buffer.from(v.expected))).toBe(true);
    await w.call('nfx.play.close', { sid: open.sid });
    expect(logs(w)).not.toMatch(/the iroh helper is stopped/);
    await w.call('nfx.play.close', { sid: low.sid });
    expect(logs(w)).toMatch(/the iroh helper is stopped/);
  });

  it('without a helper, an iroh-only session is refused at once', async () => {
    expect(HELPER, MISSING).not.toBe('');
    const w = await watcher(null);
    await expect(w.call('nfx.play.open', args())).rejects.toMatchObject({ code: 'no-seeders' });
  });
});
