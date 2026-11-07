/**
 * Slice 5f, the two-host run: the exit run's two directions with nfx and this app on SEPARATE
 * machines over a real network, as Cameron's release gate asks. One copy of this suite runs per
 * machine, in one role (`NFX_EXIT_ROLE`):
 *
 * - **`nfx`:** nfxd and nfx-package (as `nfx-exit.yml` builds them). A: package a clip, publish it,
 *   seed it. B: find this app's manifest, `nfxd --fetch` it, check every file of its hash list under
 *   its sha256, and ffmpeg-decode the HLS its origin serves.
 * - **`pear`:** this app's real worker under Node with the real iroh helper, and the host's NFX
 *   code. B: package the clip the way Studio does, publish the manifest, serve it over iroh, and
 *   beacon it with `NfxBeacons`. A: find nfxd's manifest and live beacon (`NfxBeaconWatch`), play
 *   every rendition over iroh only: byte for byte against layout C (its sha256, sent by the nfx
 *   machine), a mid-file Range, and an ffmpeg decode.
 *
 * Neither machine accepts a connection, so they meet on relays they are GIVEN: scoped Nostr relays
 * (`NFX_SCOPED_RELAYS`, wss://) for manifests, beacons and the run's signals, and iroh relays
 * (`NFX_IROH_RELAYS`, https://, optionally with a private CA in `NFX_IROH_RELAY_CA`). With
 * `NFX_RELAY_ONLY=true` nfxd runs with `--relay-only`, so every byte it moves goes through those
 * iroh relays (the suite passes it no gossip flag, which nfxd refuses with it). Everything
 * else derives from the run id (`NFX_EXIT_RUN_ID`) on both sides: the throwaway keys
 * (`derivedSecret`), the video ids and so the manifest addresses.
 *
 * Signals: ephemeral events (kind `SIGNAL_KIND`, never stored) signed by the role's key:
 * `a-ready` (nfx: A is seeded; its content is each rendition's layout C sha256 and length),
 * `a-played` (pear), `b-fetched` (nfx). Each machine republishes its own every 10 s once it has it,
 * and leaves when it has the other's (after three more), or at the run's window. A signal only ends
 * the wait early: each machine's own checks are what pass or fail it.
 *
 * Cleanup: A's manifest is withdrawn with `nfxd delete` (NFX-02 §6); B's carries a NIP-40
 * `expiration` an hour out (NFX-02 §3: unknown tags are ignored) and is withdrawn with a kind-5
 * deletion. Beacons and signals are ephemeral.
 *
 * Runs only with `NUTFLIX_EXIT_TWO_HOST=1` (`.github/workflows/nfx-exit-two-host.yml`); then a
 * missing binary, relay or run id FAILS it, never skips it.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { NfxVideo, NostrEvent, NostrFilter, NostrPubkey, VideoManifest } from '@sovit/core';
import { media, nfx, nostr } from '@sovit/core';
import { nodeFsAdapter, nodeProcessRunner, nodeSha256 } from '@sovit/core/media/node';
import { silentLogger } from '@sovit/seeder';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { NfxIrohEndpointWire, WorkerEvent } from '../../ipc/worker-protocol.js';
import { devMockProviders } from '../../worker/dev/dev-mocks.js';
import type { DevTestnet } from '../../worker/dev/fixtures-net.js';
import { startDevTestnet } from '../../worker/dev/fixtures-net.js';
import { LoopbackPayHub } from '../../worker/dev/loopback-pay.js';
import { packageUploadForNfx } from '../../worker/studio/nfx.js';
import type { WorkerClient } from '../../worker/__tests__/helpers/harness.js';
import {
  httpGet,
  sleep,
  startWorker,
  tempDir,
  within,
} from '../../worker/__tests__/helpers/harness.js';
import { memoryLogger } from '../log.js';
import { NfxBeacons } from '../nfx/beacons.js';
import { NfxBeaconWatch } from '../nfx/beacon-watch.js';
import { beaconPeers } from '../nfx/play.js';
import { nfxManifestFor } from '../nfx/publish.js';
import { NfxSeederKey } from '../nfx/seeder-key.js';
import type { GivenRelays, Proc } from './support/nfx-exit-kit.js';
import {
  BIN,
  derivedSecret,
  derivedSigner,
  freePort,
  givenRelays,
  layoutC,
  listening,
  makeClip,
  mustRun,
  nfxdRelayArgs,
  nowS,
  runOnce,
  setLogDir,
  sha256,
  sid,
  start,
  stopAll,
  storeFiles,
  tail,
  waitFor,
  writeNfxdKey,
} from './support/nfx-exit-kit.js';

vi.setConfig({ testTimeout: 1_800_000, hookTimeout: 600_000 });

const TWO_HOST = process.env['NUTFLIX_EXIT_TWO_HOST'] === '1';
const ROLE = process.env['NFX_EXIT_ROLE'] ?? '';
const RUN_ID = process.env['NFX_EXIT_RUN_ID'] ?? '';
const NS = 'nfx:testnet:1';
/** How long one machine waits for the other at any step (its manifest, beacon, signal). */
const WAIT_OTHER_MS = 10 * 60_000;
/** The run's whole window: a machine leaves by then, done or not. */
const WINDOW_MS = 25 * 60_000;
/** Ephemeral (NIP-01: 20000–29999, never stored); not an NFX kind. */
const SIGNAL_KIND = 21_464;
const SIGNAL_EVERY_MS = 10_000;

type Step = 'a-ready' | 'a-played' | 'b-fetched';
type Signer = Awaited<ReturnType<typeof derivedSigner>>;
interface ARendition {
  readonly sha256: string;
  readonly length: number;
}

/** A's video id (NFX-01: 7+ chars) and B's legacy event id, from the run id. */
const videoIdA = (): string => `exit2-a-${RUN_ID}`;
const legacyIdB = (): string => derivedSecret(RUN_ID, 'pear/legacy');

describe.skipIf(!TWO_HOST)(`slice 5f two-host run, role ${ROLE}`, () => {
  const startedAt = Date.now();
  const teardown: (() => Promise<void>)[] = [];
  const pool = new nostr.SimplePoolAdapter();
  let relays: GivenRelays;
  let work = '';
  let clip = '';
  /** Signals heard from the other machine, by step (content kept). */
  const heard = new Map<Step, NostrEvent>();
  let stopListening: (() => void) | null = null;
  let logDir = '';
  /** What this machine saw, by milestone (ms since start) and measure; written at the end. */
  const result: Record<string, unknown> = { role: ROLE, run: RUN_ID };
  const mark = (name: string, extra: Record<string, unknown> = {}): void => {
    result[name] = { atMs: Date.now() - startedAt, ...extra };
  };

  beforeAll(async () => {
    if (ROLE !== 'nfx' && ROLE !== 'pear') throw new Error('NFX_EXIT_ROLE must be nfx or pear');
    if (!/^[0-9]{1,20}$/.test(RUN_ID)) throw new Error('NFX_EXIT_RUN_ID must be the run id');
    const need =
      ROLE === 'nfx'
        ? { nfxd: BIN.nfxd, nfxPackage: BIN.nfxPackage, ffmpeg: BIN.ffmpeg }
        : { helper: BIN.helper, ffmpeg: BIN.ffmpeg, ffprobe: BIN.ffprobe };
    const missing = Object.entries(need)
      .filter(([, p]) => p === '' || !existsSync(p))
      .map(([k]) => k);
    if (missing.length > 0)
      throw new Error(`the two-host run (${ROLE}) needs: missing ${missing.join(', ')}`);
    relays = givenRelays();
    if (relays.irohCa !== null && !existsSync(relays.irohCa))
      throw new Error('NFX_IROH_RELAY_CA names no file');
    result['relayOnly'] = relays.relayOnly;
    const d = await tempDir('nf-exit2-');
    teardown.push(() => d.rm());
    work = d.dir;
    logDir = process.env['NUTFLIX_EXIT_LOGS'] ?? join(work, 'logs');
    await mkdir(logDir, { recursive: true });
    setLogDir(logDir);
    clip = join(work, 'clip.mp4');
    await makeClip(clip);
    // The other machine's signals, live from the start (they are never stored).
    const other = ROLE === 'nfx' ? 'pear/user' : 'nfx/creator';
    const otherKey = await (await derivedSigner(derivedSecret(RUN_ID, other))).getPublicKey();
    stopListening = pool.subscribe(
      relays.scoped,
      [{ kinds: [SIGNAL_KIND], authors: [otherKey], '#r': [RUN_ID] }],
      {
        onevent: (raw) => {
          const ev = nostr.verifyIncoming(raw);
          const step = ev?.tags.find((t) => t[0] === 's')?.[1];
          if (ev !== null && (step === 'a-ready' || step === 'a-played' || step === 'b-fetched'))
            heard.set(step, ev);
        },
      },
    );
  });

  afterAll(async () => {
    result['heard'] = [...heard.keys()];
    result['totalMs'] = Date.now() - startedAt;
    if (logDir !== '')
      await writeFile(join(logDir, `result-${ROLE}.json`), `${JSON.stringify(result, null, 2)}\n`);
    stopListening?.();
    pool.close();
    for (const t of teardown.splice(0).reverse()) await t().catch(() => undefined);
    await stopAll();
  });

  /** Verified events matching `filter` on the given scoped relays. */
  async function query(filter: NostrFilter): Promise<NostrEvent[]> {
    const raw = await pool.query(relays.scoped, filter, { maxWaitMs: 6000 });
    return raw.flatMap((r) => {
      const ev = nostr.verifyIncoming(r);
      return ev === null ? [] : [ev];
    });
  }

  /** Publishes to every given scoped relay; how many took it, and why the others did not. */
  // (Relays that refuse are named in the result; one that takes it is enough to meet on.)
  async function publish(ev: NostrEvent): Promise<{ ok: number; refused: string[] }> {
    const r = await pool.publish(relays.scoped, ev);
    return {
      ok: r.filter((x) => x.ok).length,
      refused: r.filter((x) => !x.ok).map((x) => `${x.url}: ${x.reason ?? 'refused'}`),
    };
  }

  /** The free NFX video at `address`, once the given relays list it (waits up to the deadline). */
  async function findManifest(author: NostrPubkey, d: string, address: string): Promise<NfxVideo> {
    const end = Date.now() + WAIT_OTHER_MS;
    for (;;) {
      const events = await query({ kinds: [nfx.KIND_MANIFEST], authors: [author], '#d': [d] });
      const v = nfx.listNfxVideos(NS, events, [], nowS()).find((x) => x.id === address);
      if (v !== undefined) return v;
      if (Date.now() > end)
        throw new Error(`the other machine's manifest ${address} did not appear in 10 min`);
      await sleep(10_000);
    }
  }

  /** Our signal for `step`, republished every 10 s from now on (ephemeral: never stored). */
  function signal(
    signer: Signer,
    step: Step,
    content = '',
  ): { sent: () => number; stop: () => void } {
    let sent = 0;
    let stopped = false;
    const once = async (): Promise<void> => {
      if (stopped) return;
      const ev = await signer.signEvent({
        kind: SIGNAL_KIND,
        created_at: nowS(),
        tags: [
          ['t', 'nfx-exit-two-host'],
          ['r', RUN_ID],
          ['s', step],
        ],
        content,
      });
      if ((await publish(ev)).ok > 0) sent++;
    };
    void once();
    const timer = setInterval(() => {
      void once();
    }, SIGNAL_EVERY_MS);
    const stop = (): void => {
      stopped = true;
      clearInterval(timer);
    };
    teardown.push(() => {
      stop();
      return Promise.resolve();
    });
    return { sent: () => sent, stop };
  }

  /** The other's `step` signal once heard, or `null` after `ms`. */
  async function hear(step: Step, ms: number): Promise<NostrEvent | null> {
    const end = Date.now() + ms;
    while (!heard.has(step) && Date.now() < end) await sleep(1000);
    return heard.get(step) ?? null;
  }

  /** Stay serving until the other machine says `step` (and ours went out 3 more times), or the window ends. */
  async function linger(step: Step, ours: { sent: () => number }): Promise<void> {
    const windowLeft = WINDOW_MS - (Date.now() - startedAt);
    const got = await hear(step, Math.max(0, windowLeft));
    if (got === null) return;
    const base = ours.sent();
    const end = Date.now() + 60_000;
    while (ours.sent() < base + 3 && Date.now() < end) await sleep(1000);
  }

  const relayArgs = (): string[] => nfxdRelayArgs(relays);

  it.runIf(ROLE === 'nfx')(
    'nfx: A packaged, published and seeded; B fetched, verified, seeded and served',
    async () => {
      const creatorKey = join(work, 'creator.key');
      const creator = await writeNfxdKey(creatorKey, derivedSecret(RUN_ID, 'nfx/creator'));
      const creatorSigner = await derivedSigner(derivedSecret(RUN_ID, 'nfx/creator'));

      // A: package, publish, seed.
      const pkg = join(work, 'pkg-a');
      await mustRun('nfx-package', BIN.nfxPackage, [
        clip,
        '--video',
        `${NS}:${videoIdA()}`,
        '--out',
        pkg,
        '--max-height',
        '720',
        '--preset',
        'veryfast',
      ]);
      const published = await mustRun('nfxd publish', BIN.nfxd, [
        'publish',
        '--key',
        creatorKey,
        ...relays.scoped.flatMap((r) => ['--relay', r]),
        '--package',
        pkg,
        '--title',
        `nutflix-pear ⇄ nfx two-host run ${RUN_ID} (test, expires)`,
      ]);
      const addressA = `${String(nfx.KIND_MANIFEST)}:${creator}:${NS}:${videoIdA()}`;
      expect(published.stdout.trim()).toBe(addressA);
      teardown.push(async () => {
        await runOnce(BIN.nfxd, [
          'delete',
          '--key',
          creatorKey,
          ...relays.scoped.flatMap((r) => ['--relay', r]),
          '--a',
          addressA,
        ]);
      });
      const seedStore = join(work, 'seed-a-store');
      await cp(join(pkg, 'store'), seedStore, { recursive: true });
      const seeder = start('nfxd-seed-a', BIN.nfxd, [
        'run',
        '--key',
        creatorKey,
        '--store',
        seedStore,
        '--state',
        join(work, 'seed-a-state'),
        '--seed',
        addressA,
        ...relayArgs(),
      ]);
      await waitFor(seeder, new RegExp(`${addressA}: Seeding`), WAIT_OTHER_MS, 'nfxd seeding A');

      // A as the given relays serve it (this also proves they took nfxd's manifest).
      const listedA = await findManifest(creator, `${NS}:${videoIdA()}`, addressA);
      mark('aSeeded', { root: listedA.root, segs: listedA.segs });
      // What the pear machine must receive, rendition by rendition: layout C's sha256 and length.
      const files = await storeFiles(join(pkg, 'store'));
      const addr = nfx.VideoAddr.parse(`${NS}:${videoIdA()}`);
      if (!addr.ok) throw new Error('bad address');
      const verified = nfx.verifyHashList(
        files.get(listedA.root) ?? new Uint8Array(0),
        listedA.root,
        addr.value,
        BigInt(listedA.segs),
      );
      expect(verified.ok, 'the package’s hash list is the listed manifest’s').toBe(true);
      if (!verified.ok) return;
      const expectA: Record<string, ARendition> = {};
      for (const r of verified.value.renditions) {
        const bytes = layoutC(verified.value, files, r);
        expectA[r.id] = { sha256: sha256(bytes), length: bytes.length };
      }
      const ready = signal(creatorSigner, 'a-ready', JSON.stringify(expectA));

      // B: this app's manifest, at the address both machines derive.
      const user = await (await derivedSigner(derivedSecret(RUN_ID, 'pear/user'))).getPublicKey();
      const ns = nfx.Namespace.parse(NS);
      if (!ns.ok) throw new Error('bad namespace');
      const videoB = nfx.legacyVideoAddr(ns.value, legacyIdB());
      if (!videoB.ok) throw new Error('bad B address');
      const addressB = `${String(nfx.KIND_MANIFEST)}:${user}:${videoB.value.toString()}`;
      const listedB = await findManifest(user, videoB.value.toString(), addressB);
      mark('bListed');
      const fetcherKey = join(work, 'fetcher.key');
      await writeNfxdKey(fetcherKey, derivedSecret(RUN_ID, 'nfx/fetcher'));
      const store = join(work, 'fetch-b-store');
      const o = await freePort();
      const fetcher: Proc = start('nfxd-fetch-b', BIN.nfxd, [
        'run',
        '--key',
        fetcherKey,
        '--store',
        store,
        '--state',
        join(work, 'fetch-b-state'),
        '--fetch',
        addressB,
        '--origin',
        `127.0.0.1:${String(o)}`,
        ...relayArgs(),
      ]);
      await waitFor(fetcher, new RegExp(`${addressB}: Seeding`), WAIT_OTHER_MS, 'nfxd fetching B');
      mark('bFetched');

      // Every file of B's hash list in nfxd's store, under its sha256.
      const fetched = await storeFiles(store);
      const listB = listedB.root;
      const listBytes = fetched.get(listB);
      expect(listBytes, 'nfxd holds B’s hash list').toBeDefined();
      if (listBytes === undefined) return;
      const verifiedB = nfx.verifyHashList(listBytes, listB, videoB.value, BigInt(listedB.segs));
      expect(verifiedB.ok).toBe(true);
      if (!verifiedB.ok) return;
      for (const f of verifiedB.value.files) {
        const b = fetched.get(f.sha256);
        expect(b, `nfxd holds ${f.name}`).toBeDefined();
        if (b !== undefined) expect(sha256(b), f.name).toBe(f.sha256);
      }
      await listening(o, 30_000, 'the nfxd origin');
      const decoded = await runOnce(BIN.ffmpeg, [
        '-v',
        'error',
        '-i',
        `http://127.0.0.1:${String(o)}/${listB}/master.m3u8`,
        '-f',
        'null',
        '-',
      ]);
      expect(decoded.code, `ffmpeg decodes nfxd's HLS of B:\n${tail(decoded.stderr)}`).toBe(0);
      mark('bVerified', { files: verifiedB.value.files.length });

      // Done with B; A stays seeded until the pear machine has played it, or the window ends.
      const fetchedSignal = signal(creatorSigner, 'b-fetched');
      await linger('a-played', fetchedSignal);
      mark('lingerEnd', { aPlayedHeard: heard.has('a-played') });
      ready.stop();
      fetchedSignal.stop();
      expect(seeder.exit, `nfxd kept seeding A:\n${tail(seeder.text)}`).toBeNull();
    },
  );

  it.runIf(ROLE === 'pear')(
    'pear: B packaged like Studio, published, served and beaconed; A played over iroh',
    async () => {
      const user = await derivedSigner(derivedSecret(RUN_ID, 'pear/user'));
      const userPub = await user.getPublicKey();
      const testnet: DevTestnet = await startDevTestnet();
      teardown.push(() => testnet.destroy());

      // B: a seeding worker; Studio's path; the manifest and the beacons.
      const hub = new LoopbackPayHub();
      const d = await tempDir('nf-exit2-seed-');
      teardown.push(() => d.rm());
      const w = startWorker({
        hub,
        logLevel: 'info',
        testBootstrap: testnet.bootstrap,
        providers: () => devMockProviders({ hub, label: `exit2-${RUN_ID}` }),
      });
      teardown.push(() => w.close());
      await w.call('init', {
        v: 1,
        storage: d.dir,
        seeding: { enabled: true, diskCapBytes: 1024 ** 3 },
        prefetchSeconds: 30,
        nfx: { enabled: true, irohRelays: [...relays.iroh] },
        irohHelper: BIN.helper,
      });
      await w.event((e): e is Extract<WorkerEvent, { e: 'ready' }> => e.e === 'ready', 20_000);
      const seeder = w.host.internals.seeder;
      if (seeder === null) throw new Error('the seeding worker has no seeder');
      const fs = nodeFsAdapter({ tmpDir: work });
      const runner = nodeProcessRunner();
      const binaries = { ffmpeg: BIN.ffmpeg, ffprobe: BIN.ffprobe };
      const pipeline = media.createMediaPipeline({ runner, fs, sha256: nodeSha256, binaries });
      const plan = pipeline.plan(await pipeline.probe(clip), { codec: 'h264' });
      await mkdir(join(work, 'transcode-b'), { recursive: true });
      const output = await pipeline.transcode(clip, plan, () => undefined, {
        workDir: join(work, 'transcode-b'),
      });
      const status = await packageUploadForNfx(
        { legacyEventId: legacyIdB(), satsPerBlock: 0, output },
        { store: seeder.nfx, runner, fs, sha256: nodeSha256, binaries, logger: silentLogger },
      );
      expect(status.state, JSON.stringify(status)).toBe('stored');
      if (status.state !== 'stored') return;
      const legacy = {
        id: legacyIdB(),
        kind: 21,
        author: userPub,
        title: `nutflix-pear ⇄ nfx two-host run ${RUN_ID} (test, expires)`,
        description: 'Packaged by nutflix-pear, fetched by nfxd, on another machine.',
        publishedAt: nowS(),
        durationSec: 8,
        tags: ['exit-run'],
        renditions: [],
        price: {} as never,
        blossomServers: [],
        event: {} as never,
      } as unknown as VideoManifest;
      const built = nfxManifestFor(legacy, status, nowS());
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const manifest = await user.signEvent({
        ...built.draft.event,
        // NIP-40: public relays drop it an hour out (NFX-02 §3: an unknown tag to nfx).
        tags: [...built.draft.event.tags.map((t) => [...t]), ['expiration', String(nowS() + 3600)]],
      });
      expect(nfx.parseManifest(manifest).ok, 'the manifest with its expiration still parses').toBe(
        true,
      );
      const sent = await publish(manifest);
      result['manifestRefusals'] = sent.refused;
      expect(
        sent.ok,
        `a scoped relay takes this app's manifest: ${sent.refused.join('; ')}`,
      ).toBeGreaterThan(0);
      mark('bPublished');
      const addressB = `${String(nfx.KIND_MANIFEST)}:${userPub}:${status.video}`;
      teardown.push(async () => {
        const del = await user.signEvent({
          kind: 5,
          created_at: nowS(),
          tags: nfx.deletionTags([addressB]),
          content: 'nutflix-pear two-host test run over',
        });
        await publish(del);
      });
      const serveBy = Date.now() + 120_000;
      for (;;) {
        const r = await w.call('nfx.endpoint', { seeder: userPub, video: status.video });
        if (r.iroh !== null) break;
        if (Date.now() > serveBy) throw new Error('no iroh endpoint for B in time');
        await sleep(500);
      }
      const keyDir = await tempDir('nf-exit2-key-');
      teardown.push(() => keyDir.rm());
      const seederKey = await NfxSeederKey.open({
        dir: join(keyDir.dir, 'nfx'),
        network: NS,
        user: userPub,
        seal: user,
      });
      const refused: string[] = [];
      const beacons = new NfxBeacons({
        scopedRelays: () => relays.scoped,
        key: () => Promise.resolve(seederKey),
        endpoint: (s, video) => w.call('nfx.endpoint', { seeder: s, video }),
        irohRelays: () => relays.iroh,
        stored: async () => (await w.call('nfx.videos', {})).videos,
        seeded: () => [{ video: status.video, author: userPub, root: status.root }],
        manifest: async () => {
          const evs = await query({ kinds: [nfx.KIND_MANIFEST], authors: [userPub] });
          return nfx.listNfxVideos(NS, evs, [], nowS()).find((v) => v.id === addressB) ?? null;
        },
        send: async (event, rs) => {
          const r = await pool.publish(rs, event);
          for (const x of r) if (!x.ok) refused.push(x.reason ?? 'refused');
          return r.filter((x) => x.ok).length;
        },
        now: nowS,
        log: memoryLogger(),
      });
      const first = await beacons.round();
      expect(first.published, `B's beacon went out (${refused.join('; ')})`).toBe(1);
      mark('bBeaconed');
      const refresh = setInterval(() => {
        void beacons.round();
      }, 30_000);
      teardown.push(() => {
        clearInterval(refresh);
        return Promise.resolve();
      });

      // A: nfxd's manifest at the derived address, its live beacon, and what to expect.
      const creator = await (
        await derivedSigner(derivedSecret(RUN_ID, 'nfx/creator'))
      ).getPublicKey();
      const addressA = `${String(nfx.KIND_MANIFEST)}:${creator}:${NS}:${videoIdA()}`;
      const video = await findManifest(creator, `${NS}:${videoIdA()}`, addressA);
      mark('aListed');
      const ready = await hear('a-ready', WAIT_OTHER_MS);
      expect(ready, 'the nfx machine said what A’s renditions are').not.toBeNull();
      if (ready === null) return;
      const expectA = JSON.parse(ready.content) as Record<string, ARendition>;
      const watch = new NfxBeaconWatch({
        subscribe: (filter, rs, onEvent) =>
          pool.subscribe(rs, [filter], {
            onevent: (raw) => {
              const ev = nostr.verifyIncoming(raw);
              if (ev !== null) onEvent(ev);
            },
          }),
        now: nowS,
      });
      teardown.push(() => {
        watch.close();
        return Promise.resolve();
      });
      const events = await watch.wait(
        video,
        relays.scoped,
        (evs) => beaconPeers(video, evs, nowS(), relays.iroh).iroh.length > 0,
        WAIT_OTHER_MS,
      );
      const sources = beaconPeers(video, events, nowS(), relays.iroh);
      expect(sources.iroh, 'nfxd’s live beacon names an iroh endpoint').toHaveLength(1);
      const endpoint: NfxIrohEndpointWire | undefined = sources.iroh[0];
      if (endpoint === undefined) return;
      mark('aBeacon', { relayNamed: endpoint.relay !== '', addrs: endpoint.addrs.length });

      // This app plays every rendition, over iroh only, from the other machine.
      const wd = await tempDir('nf-exit2-watch-');
      teardown.push(() => wd.rm());
      const watcher: WorkerClient = startWorker({
        logLevel: 'info',
        testBootstrap: testnet.bootstrap,
      });
      teardown.push(() => watcher.close());
      await watcher.call('init', {
        v: 1,
        storage: wd.dir,
        seeding: { enabled: false, diskCapBytes: 1024 ** 3 },
        prefetchSeconds: 30,
        nfx: { enabled: true, irohRelays: [...relays.iroh] },
        irohHelper: BIN.helper,
      });
      const ids = Object.keys(expectA);
      expect(ids.length).toBeGreaterThanOrEqual(2);
      const opened: string[] = [];
      for (const id of ids) {
        const want = expectA[id];
        if (want === undefined) continue;
        const open = {
          sid: sid(),
          video: `${NS}:${videoIdA()}`,
          root: video.root,
          segs: video.segs,
          rendition: id,
          peers: [],
          iroh: [endpoint],
          prefetchSeconds: 30,
        };
        const t0 = Date.now();
        const o = await within(watcher.call('nfx.play.open', open), 300_000, `open ${id}`);
        expect(o.rendition).toBe(id);
        const whole = await httpGet(o.link);
        expect(whole.status).toBe(200);
        expect(whole.body.length, `${id}: the whole view`).toBe(want.length);
        expect(sha256(whole.body), `${id}: layout C, byte for byte`).toBe(want.sha256);
        const at = Math.floor(want.length / 2);
        const range = await httpGet(o.link, {
          range: `bytes=${String(at)}-${String(at + 65_535)}`,
        });
        expect(range.status).toBe(206);
        expect(range.body.equals(whole.body.subarray(at, at + 65_536))).toBe(true);
        const decoded = await runOnce(BIN.ffmpeg, ['-v', 'error', '-i', o.link, '-f', 'null', '-']);
        expect(decoded.code, `${id}: ffmpeg decodes it:\n${tail(decoded.stderr)}`).toBe(0);
        expect(decoded.stderr.trim(), `${id}: ffmpeg reports no error`).toBe('');
        await watcher.call('nfx.play.close', { sid: open.sid });
        opened.push(id);
        mark(`aPlayed-${id}`, { bytes: whole.body.length, ms: Date.now() - t0 });
      }
      expect(opened.sort()).toEqual([...ids].sort());

      // Done with A; B stays served until nfxd has fetched it, or the window ends.
      const played = signal(user, 'a-played');
      await linger('b-fetched', played);
      played.stop();
      // Not a pass condition here (the nfx machine judges B): what was heard, and who beacons B.
      const beaconsB = await query({ kinds: [nfx.KIND_BEACON], '#a': [addressB] });
      mark('lingerEnd', {
        bFetchedHeard: heard.has('b-fetched'),
        beaconsOnB: beaconsB.length,
      });
    },
  );
});
