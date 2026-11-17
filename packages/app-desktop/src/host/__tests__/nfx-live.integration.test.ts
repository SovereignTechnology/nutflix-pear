/**
 * The live testnet check, before a desktop release: this app, set up as a fresh install is, finds
 * a free video somebody really seeds on `nfx:testnet:1` and plays it, over the public internet.
 * Nothing runs on this machine but this app's side: the real worker under Node with the real iroh
 * helper, and the host's own NFX code: the catalogue (`NfxCatalog` over the host's `NostrClient`
 * and Nostr pool, its NIP-11 search routing), the beacon reader (`NfxBeaconWatch`, `beaconPeers`)
 * and the worker's NFX settings (`nfxWorkerArgs` of `DEFAULT_SETTINGS`). The relays are the
 * defaults this version ships: the four public read relays, `wss://relay.nutflix.xyz` and
 * `https://iroh.nutflix.xyz/`.
 *
 *   1. The catalogue's Network feed lists the video, its search finds it by `NFX_LIVE_SEARCH`, and
 *      `video(address)` returns it, free.
 *   2. Its live beacon (NFX-04: ephemeral, on the scoped relay) names at least one iroh endpoint.
 *   3. The worker plays the rendition most seeders hold (the one the app starts on) start to end:
 *      every segment it serves passed its sha256 against the signed hash list (the worker serves
 *      nothing else), a mid-file Range reads the same bytes, and ffmpeg decodes the whole view
 *      with no error. Every other held rendition opens and serves its first and middle MiB.
 *
 * It reads public relays and fetches from whoever seeds; it publishes nothing and seeds nothing.
 * Runs only with `NUTFLIX_LIVE_RUN=1`; then a missing input FAILS it, never skips it:
 *   NFX_LIVE_ADDRESS     the video, `38504:<creator hex>:<namespace>:<video id>`
 *   NFX_LIVE_SEARCH      text its title or description holds (optional: no search check without)
 *   NUTFLIX_IROH_HELPER  the helper binary, as the exit run
 *   NUTFLIX_EXIT_LOGS    where the worker's log goes (optional)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { NfxAddress, NfxVideo, RelayUrl } from '@sovit/core';
import { nfx, nostr } from '@sovit/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { WorkerEvent } from '../../ipc/worker-protocol.js';
import type { WorkerClient } from '../../worker/__tests__/helpers/harness.js';
import { httpGet, startWorker, tempDir, within } from '../../worker/__tests__/helpers/harness.js';
import { nfxWorkerArgs } from '../adapter.js';
import { NfxBeaconWatch } from '../nfx/beacon-watch.js';
import { beaconPeers, videoOf } from '../nfx/play.js';
import { hostRelayInfoFetch } from '../nfx/relay-info.js';
import { DEFAULT_NFX, DEFAULT_SETTINGS } from '../settings/settings.js';
import { BIN, nowS, runOnce, sha256, sid, tail } from './support/nfx-exit-kit.js';

vi.setConfig({ testTimeout: 1_200_000, hookTimeout: 120_000 });

const LIVE = process.env['NUTFLIX_LIVE_RUN'] === '1';
const ADDRESS = (process.env['NFX_LIVE_ADDRESS'] ?? '') as NfxAddress;
const SEARCH = process.env['NFX_LIVE_SEARCH'] ?? '';
const NS = DEFAULT_NFX.network;
const MIB = 1024 * 1024;

describe.skipIf(!LIVE)('the live testnet: a fresh install finds and plays a seeded video', () => {
  const pool = new nostr.SimplePoolAdapter();
  const client = new nostr.NostrClient({ pool, relays: DEFAULT_SETTINGS.relays });
  const scoped = DEFAULT_NFX.scopedRelays;
  const catalog = new nostr.NfxCatalog(
    () => client,
    NS,
    () => scoped,
    {
      searchSupport: new nostr.RelaySearchSupport(hostRelayInfoFetch()).supports,
    },
  );
  const cleanup: (() => Promise<void>)[] = [];
  let video: NfxVideo | null = null;
  let logDir = '';

  beforeAll(async () => {
    expect(ADDRESS, 'NFX_LIVE_ADDRESS').toMatch(/^38504:[0-9a-f]{64}:nfx:[a-z0-9:-]+$/);
    expect(BIN.helper, 'NUTFLIX_IROH_HELPER').not.toBe('');
    const d = await tempDir('nf-live-');
    cleanup.push(() => d.rm());
    logDir = process.env['NUTFLIX_EXIT_LOGS'] ?? join(d.dir, 'logs');
    await mkdir(logDir, { recursive: true });
  });

  afterAll(async () => {
    pool.close();
    for (const c of cleanup.splice(0).reverse()) await c().catch(() => undefined);
  });

  it('the catalogue lists it on the default relays: Network, search, and by address', async () => {
    video = await catalog.video(ADDRESS);
    expect(video, `video(${ADDRESS})`).not.toBeNull();
    if (video === null) return;
    expect(video.kind).toBe(nfx.KIND_MANIFEST);
    const network = await catalog.feed({ source: 'network', limit: 100 }, null);
    expect(
      network.items.some((v) => v.id === ADDRESS),
      `the Network feed (${String(network.items.length)} videos) lists it`,
    ).toBe(true);
    if (SEARCH !== '') {
      const found = await catalog.search({ text: SEARCH });
      expect(
        found.items.some((v) => v.id === ADDRESS),
        `search "${SEARCH}" finds it among ${String(found.items.length)}`,
      ).toBe(true);
    }
    console.log(
      `listed: ${video.title} (${String(video.segs)} files, root ${video.root.slice(0, 12)}…, ` +
        `${String(video.durationSec ?? '?')} s)`,
    );
  });

  it('its live beacon names an iroh endpoint, and the worker plays it end to end', async () => {
    const v = video;
    expect(v, 'listed by the test before').not.toBeNull();
    if (v === null) return;
    const watch = new NfxBeaconWatch({
      subscribe: (filter, relays, onEvent) =>
        pool.subscribe(relays, [filter], {
          onevent: (raw) => {
            const ev = nostr.verifyIncoming(raw);
            if (ev !== null) onEvent(ev);
          },
        }),
      now: nowS,
    });
    cleanup.push(() => {
      watch.close();
      return Promise.resolve();
    });
    const irohRelays = DEFAULT_NFX.irohRelays;
    const events = await watch.wait(
      v,
      scoped,
      (evs) => beaconPeers(v, evs, nowS(), irohRelays).iroh.length > 0,
      75_000,
    );
    const sources = beaconPeers(v, events, nowS(), irohRelays);
    expect(
      sources.iroh.length,
      `iroh endpoints in ${String(events.length)} beacons`,
    ).toBeGreaterThan(0);
    const named = [...sources.held.named.$map];
    console.log(
      `beacons: ${String(events.length)}, seeders ${String(sources.held.seeders)} ` +
        `(${String(sources.held.all)} hold all), iroh ${String(sources.iroh.length)}, ` +
        `hyperdht ${String(sources.hyperdht.length)}, held ${JSON.stringify(named)}`,
    );

    const d = await tempDir('nf-live-watch-');
    cleanup.push(() => d.rm());
    const w = startWorker({ logLevel: 'info' });
    cleanup.push(async () => {
      await writeFile(join(logDir, 'worker.log'), workerLog(w, Infinity)).catch(() => undefined);
      await w.close();
    });
    await w.call('init', {
      v: 1,
      storage: d.dir,
      seeding: { enabled: false, diskCapBytes: 1024 ** 3 },
      prefetchSeconds: DEFAULT_SETTINGS.prefetchSeconds,
      nfx: nfxWorkerArgs(DEFAULT_SETTINGS, true),
      irohHelper: BIN.helper,
    });

    const id = videoOf(ADDRESS);
    expect(id).not.toBeNull();
    const open = (rendition?: string) => ({
      sid: sid(),
      video: id ?? '',
      root: v.root,
      segs: v.segs,
      ...(rendition === undefined ? {} : { rendition }),
      peers: sources.hyperdht,
      iroh: sources.iroh,
      prefetchSeconds: DEFAULT_SETTINGS.prefetchSeconds,
      held: sources.held,
    });
    const say = (e: unknown): never => {
      throw new Error(`${String(e)}\nthe worker said:\n${workerLog(w)}`);
    };

    // The app's start: no rendition named, so the worker picks the one most seeders hold.
    const first = open();
    const t0 = Date.now();
    const opened = await within(w.call('nfx.play.open', first), 180_000, 'open').catch(say);
    console.log(
      `opened ${opened.rendition} in ${String(Date.now() - t0)} ms; renditions ` +
        opened.renditions
          .map((r) => `${r.id}${r.resolution === undefined ? '' : ` ${r.resolution}`}`)
          .join(', '),
    );
    const t1 = Date.now();
    const whole = await httpGet(opened.link).catch(say);
    const secs = (Date.now() - t1) / 1000;
    expect(whole.status, 'the whole view').toBe(200);
    expect(whole.body.length).toBeGreaterThan(MIB);
    console.log(
      `${opened.rendition}: ${String(whole.body.length)} bytes in ${secs.toFixed(1)} s ` +
        `(${((whole.body.length * 8) / secs / 1e6).toFixed(1)} Mbit/s), sha256 ${sha256(whole.body).slice(0, 16)}…`,
    );
    const at = Math.floor(whole.body.length / 2);
    const range = await httpGet(opened.link, {
      range: `bytes=${String(at)}-${String(at + 65_535)}`,
    });
    expect(range.status).toBe(206);
    expect(range.body.equals(whole.body.subarray(at, at + 65_536)), 'a mid-file Range').toBe(true);
    const decoded = await runOnce(
      BIN.ffmpeg,
      ['-v', 'error', '-i', opened.link, '-f', 'null', '-'],
      600_000,
    );
    expect(decoded.code, `ffmpeg decodes it:\n${tail(decoded.stderr)}`).toBe(0);
    expect(decoded.stderr.trim(), 'ffmpeg reports no error').toBe('');
    await w.call('nfx.play.close', { sid: first.sid });

    // Every other rendition a seeder holds: opens, and serves its first and middle MiB.
    const held = new Set(named.map(([k]) => k));
    const others = opened.renditions
      .map((r) => r.id)
      .filter((r) => r !== opened.rendition && (sources.held.all > 0 || held.has(r)));
    for (const r of others) {
      const o = open(r);
      const got = await within(w.call('nfx.play.open', o), 180_000, `open ${r}`).catch(say);
      expect(got.rendition).toBe(r);
      const head = await httpGet(got.link, { range: `bytes=0-${String(MIB - 1)}` }).catch(say);
      expect(head.status, `${r}: the first MiB`).toBe(206);
      expect(head.body.length).toBe(MIB);
      const size = Number(/\/(\d+)$/.exec(head.headers['content-range'] ?? '')?.[1] ?? NaN);
      expect(Number.isFinite(size), `${r}: Content-Range names the size`).toBe(true);
      const mid = Math.floor(size / 2);
      const middle = await httpGet(got.link, {
        range: `bytes=${String(mid)}-${String(mid + MIB - 1)}`,
      }).catch(say);
      expect(middle.status, `${r}: a middle MiB`).toBe(206);
      expect(middle.body.length).toBe(MIB);
      console.log(`${r}: ${String(size)} bytes; first and middle MiB served`);
      await w.call('nfx.play.close', { sid: o.sid });
    }
  });
});

type LogEvent = Extract<WorkerEvent, { e: 'log' }>;
function workerLog(w: WorkerClient, n = 60): string {
  return tail(
    w.events
      .filter((e): e is LogEvent => e.e === 'log')
      .map((e) => `${e.level}: ${e.msg}`)
      .join('\n'),
    n,
  );
}
