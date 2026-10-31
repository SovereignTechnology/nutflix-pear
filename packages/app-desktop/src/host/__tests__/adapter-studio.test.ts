/**
 * Studio (upload progress mapping, the worker's `studio.publish` request → a signed NIP-71
 * event), the seeder over the worker, settings side effects, and the `--dev-fixtures`
 * catalogue (design §5a).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { NostrEvent, RelayUrl, UploadProgress, VideoManifest } from '@sovit/core';
import { mocks, nfx, nostr } from '@sovit/core';

import type { IpcError } from '../../ipc/errors.js';
import type { PublishDraft, StudioUploadArgs } from '../../ipc/worker-protocol.js';
import { SignerIdentity } from '../identity.js';
import { coreTestKit } from './support/core-helpers.js';
import type { FakeWorker } from './support/fake-worker.js';
import type { Rig } from './support/rig.js';
import { RELAY_A, eventually, rig } from './support/rig.js';

const kit = await coreTestKit();

let r: Rig | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return (e as IpcError).code;
  }
};

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function draftFor(a: StudioUploadArgs): PublishDraft {
  return {
    uploadId: a.uploadId,
    meta: a.meta,
    durationSec: 6,
    blockSize: 65536,
    renditions: [
      {
        label: '360p',
        mime: 'video/mp4',
        sha256: 'd'.repeat(64) as never,
        size: 100_000,
        width: 640,
        height: 360,
        hyper: {
          core: 'b'.repeat(64) as never,
          blob: { byteOffset: 0, blockOffset: 0, blockLength: 2, byteLength: 100_000 },
        },
        hyperUrl: `hyper://${'b'.repeat(64)}/0-2`,
        fallbacks: [],
      },
    ],
    thumbnail: { kind: 'custom', sha256: 'e'.repeat(64) as never, type: 'image/jpeg' },
    codec: 'h264',
  };
}

describe('studio.upload', () => {
  it('maps thumbnail paths to nf-media ids, scrubs error text, and publishes via the signer', async () => {
    const viewer = new kit.TestSigner();
    let storage = '';
    r = await rig({
      flags: { devMocks: true },
      identity: new SignerIdentity(viewer),
      worker: {
        handlers: {
          init: (a) => {
            storage = a.storage;
            return undefined;
          },
          'studio.upload': async (a: StudioUploadArgs, w: FakeWorker) => {
            await mkdir(join(storage, 'tmp'), { recursive: true });
            await writeFile(join(storage, 'tmp', 'thumb-0.jpg'), JPEG);
            w.progress(a.uploadId, { stage: 'probing' });
            w.progress(a.uploadId, {
              stage: 'thumbnails',
              candidates: [join(storage, 'tmp', 'thumb-0.jpg'), '/etc/passwd'],
            });
            w.progress(a.uploadId, {
              stage: 'error',
              message: `ffmpeg failed on /home/alice/Videos/in.mp4 (${'a'.repeat(64)})`,
            });
            return (await w.request('studio.publish', draftFor(a))) as VideoManifest;
          },
        },
      },
    });
    await r.ready();
    const seen: UploadProgress[] = [];
    const video = await r.host.adapter.studio.upload(
      {
        file: '/home/alice/Videos/in.mp4',
        title: 'My upload',
        description: 'desc',
        tags: ['diy'],
        kind: 21,
        mints: [mocks.MINTS.a],
        satsPerBlock: 2 as never,
        split: { seeder: 40, creator: 60 },
        thumbnailChoice: {
          size: JPEG.byteLength,
          type: 'image/jpeg',
          arrayBuffer: () => Promise.resolve(JPEG.slice().buffer),
        },
      },
      (p) => seen.push(p),
    );
    // What the worker was asked: the path + display name + meta + hex thumbnail.
    const asked = r.worker().calls('studio.upload')[0] as StudioUploadArgs;
    expect(asked).toMatchObject({
      path: '/home/alice/Videos/in.mp4',
      name: 'in.mp4',
      thumbnailChoice: { hex: 'ffd8ffe0010203', type: 'image/jpeg' },
      meta: { title: 'My upload', satsPerBlock: 2, split: { seeder: 40, creator: 60 } },
    });
    // Progress: the out-of-storage candidate is dropped; the other became an nf-media id.
    await eventually(() => seen.length === 3, 'progress events');
    expect(seen[0]).toEqual({ stage: 'probing' });
    const thumbs = seen[1] as { stage: 'thumbnails'; candidates: string[] };
    expect(thumbs.candidates).toHaveLength(1);
    expect(thumbs.candidates[0]).toMatch(/^nf-media:\/\/img\/[0-9a-f]{32}$/);
    expect(JSON.stringify(seen)).not.toContain('/home/alice');
    expect(seen[2]).toEqual({ stage: 'error', message: 'ffmpeg failed on <path> (<hex>)' });
    const img = await r.host.adapter.image(thumbs.candidates[0]!);
    expect(img).toBe(thumbs.candidates[0]);
    // The published event is real: signed by the viewer, verifiable, parsed back.
    expect(video).toMatchObject({
      author: viewer.pubkey,
      title: 'My upload',
      kind: 21,
      tags: ['diy'],
      price: {
        satsPerBlock: 2,
        mints: [mocks.MINTS.a],
        split: { seeder: 40, creator: 60 },
        creatorP2pk: await r.host.adapter.wallet.p2pkPubkey(),
      },
    });
    expect(r.pool.published.map((p) => p.event.kind)).toContain(21);
    expect(await r.host.adapter.video(video.id)).toEqual(video);
  });

  it('studio.publish for an upload the host did not start is refused (not-found)', async () => {
    r = await rig({ identity: new SignerIdentity(new kit.TestSigner()) });
    await r.ready();
    const fake = draftFor({
      uploadId: 'a'.repeat(32) as never,
      path: '/x',
      name: 'x',
      meta: {
        title: 't',
        description: '',
        tags: [],
        kind: 21,
        mints: [mocks.MINTS.a],
        satsPerBlock: 1 as never,
        split: { seeder: 50, creator: 50 },
      },
    });
    await expect(r.worker().request('studio.publish', fake)).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(r.pool.published).toEqual([]);
  });

  it('a reused uploadId is refused while the first upload runs', async () => {
    let release: () => void = () => undefined;
    r = await rig({
      identity: new SignerIdentity(new kit.TestSigner()),
      worker: {
        handlers: {
          'studio.upload': () =>
            new Promise((_res, rej) => {
              release = () => {
                rej(new Error('aborted: cancelled'));
              };
            }),
        },
      },
    });
    await r.ready();
    const args = {
      uploadId: 'c'.repeat(32) as never,
      path: '/tmp/a.mp4',
      name: 'a.mp4',
      meta: {
        title: 't',
        description: '',
        tags: [],
        kind: 21 as const,
        mints: [mocks.MINTS.a],
        satsPerBlock: 1 as never,
        split: { seeder: 50, creator: 50 },
      },
    };
    const first = r.host.adapter.upload(1, args);
    expect(await codeOf(r.host.adapter.upload(2, args))).toBe('invalid-argument');
    await eventually(() => r!.worker().calls('studio.upload').length === 1, 'upload started');
    release();
    expect(await codeOf(first)).toBe('aborted');
  });
});

describe('seeder over the worker; settings side effects', () => {
  it('status rehydrates the WireMap; setEnabled persists and pushes seeder.configure', async () => {
    r = await rig();
    await r.ready();
    const a = r.host.adapter;
    const st = await a.seeder.status();
    expect(st.earned.byMint).toBeInstanceOf(Map);
    expect([...st.earned.byMint.keys()]).toEqual(['https://mint.fixture-a.example']);
    await a.seeder.setEnabled(true);
    expect((await a.settings()).seeding.enabled).toBe(true);
    expect(r.worker().calls('seeder.configure')).toEqual([
      // ADR 0015: the default shares creators' images while seeding.
      { enabled: true, diskCapBytes: 10 * 1024 ** 3, serveImages: true },
    ]);
    // Unchanged seeding → no push.
    await a.updateSettings({ theme: 'dark' });
    expect(r.worker().calls('seeder.configure')).toHaveLength(1);
    expect(await a.seeder.melt(mocks.MINTS.a, 'lnbc10n1x')).toEqual({ paid: true });
    await a.seeder.unban('d'.repeat(64) as never);
    expect(r.worker().calls('seeder.unban')).toEqual([{ pubkey: 'd'.repeat(64) }]);
  });

  it('slice 5b: Settings.nfx reaches the worker on every on/off change and at init', async () => {
    const nfx = { enabled: true, network: 'nfx:testnet:1', scopedRelays: [] } as const;
    r = await rig();
    await r.ready();
    const a = r.host.adapter;
    expect(r.worker().calls('init')[0]).toMatchObject({ nfx: { enabled: false } });
    await a.updateSettings({ nfx });
    expect(r.worker().calls('nfx.configure')).toEqual([{ enabled: true }]);
    await a.updateSettings({ theme: 'dark' });
    await a.updateSettings({ nfx: { ...nfx, scopedRelays: ['wss://scoped.test' as RelayUrl] } });
    expect(r.worker().calls('nfx.configure')).toHaveLength(1); // no on/off change, no push
    await a.updateSettings({ nfx: { ...nfx, enabled: false } });
    expect(r.worker().calls('nfx.configure')).toEqual([{ enabled: true }, { enabled: false }]);
    await a.updateSettings({ nfx });
    // A restarted worker starts with the current state.
    r.worker().crash(1);
    await eventually(
      () => r!.spawned.length === 2 && r!.host.worker.state === 'ready',
      'restart',
      5000,
    );
    expect(r.spawned[1]!.calls('init')[0]).toMatchObject({ nfx: { enabled: true } });
  });

  it('seeder.status events reach onStatus as SeederStatus (Map)', async () => {
    r = await rig();
    await r.ready();
    const got: unknown[] = [];
    r.host.adapter.seeder.onStatus((s) => got.push(s));
    r.worker().event({
      e: 'seeder.status',
      status: {
        enabled: true,
        pubkey: 'a'.repeat(64),
        videos: 1,
        bytesStored: 5,
        diskCapBytes: 9,
        peers: [],
        earned: { total: 3, unswapped: 1, byMint: { $map: [[mocks.MINTS.a, 3]] } },
        banned: [],
      },
    });
    await eventually(() => got.length === 1, 'status');
    expect(
      (got[0] as { earned: { byMint: Map<string, number> } }).earned.byMint.get(mocks.MINTS.a),
    ).toBe(3);
  });

  it('a seeding change while the worker is down is saved, and reaches the next init', async () => {
    r = await rig();
    await r.ready();
    r.worker().crash(1);
    await eventually(() => r!.host.worker.state === 'down', 'down');
    const next = await r.host.adapter.updateSettings({
      seeding: { enabled: true, diskCapBytes: 5 * 1024 ** 3 },
    });
    expect(next.seeding).toEqual({ enabled: true, diskCapBytes: 5 * 1024 ** 3 });
    expect(r.log.lines.some((l) => l.msg.startsWith('seeding change not pushed'))).toBe(true);
    // The restart (250 ms default back-off) re-inits with the saved values.
    await eventually(
      () => r!.spawned.length === 2 && r!.host.worker.state === 'ready',
      'restart',
      5000,
    );
    expect(r.spawned[1]!.calls('init')[0]).toMatchObject({
      seeding: { enabled: true, diskCapBytes: 5 * 1024 ** 3 },
    });
  });

  it('desktop.ffmpeg asks the worker with the configured path', async () => {
    r = await rig();
    await r.ready();
    expect(await r.host.adapter.ffmpeg(true)).toEqual({
      found: true,
      path: '/usr/bin/ffmpeg',
      version: '7.1',
      os: 'linux',
    });
    expect(r.worker().calls('studio.ffmpeg')).toEqual([{ recheck: true }]);
  });

  it('analytics is stats plus an honest empty satsByRendition (Stage 2 has receipts)', async () => {
    r = await rig();
    const an = await r.host.adapter.studio.analytics('a'.repeat(64) as never);
    expect(an.satsByRendition).toEqual(new Map());
    expect(an).toMatchObject({ likes: 0, dislikes: 0, comments: 0 });
  });
});

describe('--dev-fixtures (design §5a)', () => {
  it('serves mock fixtures + the worker’s live manifests, offline, with a dev identity', async () => {
    r = await rig({ flags: { devMocks: true, devFixtures: true } });
    await r.ready();
    const a = r.host.adapter;
    expect(r.log.lines.some((l) => l.level === 'warn' && l.msg.startsWith('DEV FIXTURES ON'))).toBe(
      true,
    );
    expect(await a.me()).toBe(mocks.ME);
    expect(await a.signer()).toMatchObject({ pubkey: mocks.ME, locked: true });
    // Writes still need a real signer.
    expect(await codeOf(a.react(mocks.VIDEOS[0]!.id, '+'))).toBe('no-signer');

    // The boot race (docs/archive/lanes/E2E-fix.md, failure 3): a feed read before the worker's
    // first dev.fixtures WAITS for it instead of answering with the mock catalogue only.
    let early: string | undefined;
    const earlyFeed = a.feed({ source: 'trending' }).then((p) => {
      early = p.items[0]?.id;
      return p;
    });
    const newMint = 'https://mint.dev-fixture.example' as never;
    const live: VideoManifest = {
      ...mocks.VIDEOS[0]!,
      id: 'f'.repeat(64) as never,
      title: 'Live fixture',
      price: { ...mocks.VIDEOS[0]!.price, mints: [newMint] },
    };
    let credited = false;
    a.wallet.onChange((e) => {
      if (e.type === 'balance' && e.mint === newMint && e.balance > 0) credited = true;
    });
    await new Promise((res) => {
      setImmediate(res);
    });
    expect(early).toBeUndefined();
    r.worker().fixtures([live]);
    await eventually(
      () => r!.log.lines.find((l) => l.msg.startsWith('dev fixtures: live')),
      'live',
    );
    expect((await earlyFeed).items[0]?.id).toBe(live.id);
    expect(early).toBe(live.id);
    expect((await a.feed({ source: 'trending' })).items[0]?.id).toBe(live.id);
    expect((await a.stats(live.id)).seedersOnline).toBe(1);
    expect((await a.stats(mocks.VIDEOS[1]!.id)).seedersOnline).toBe(0);
    // The dev wallet is credited at the live fixture's mint, so it is playable.
    await eventually(() => credited, 'fake sats at the live fixture mint');
    const s = await a.openSession(1, live.id);
    expect(s.videoId).toBe(live.id);
    expect(await a.profile(mocks.ME)).toEqual(mocks.MY_PROFILE);
    // Offline: the fake pool (the rig's) was never asked for catalogue data.
    expect(r.pool.queries.filter((q) => q.filter.kinds?.includes(21))).toEqual([]);
  });

  it('a worker that fails for good releases waiting reads (mock catalogue only)', async () => {
    r = await rig({
      flags: { devMocks: true, devFixtures: true },
      // No restarts: the first death is final (`failed`).
      restart: { baseMs: 1, maxMs: 1, maxRestarts: 0, windowMs: 60_000 },
      worker: {
        handlers: {
          init: () => {
            throw new Error('internal: the worker could not start');
          },
        },
      },
    });
    const feed = r.host.adapter.feed({ source: 'trending' });
    await eventually(() => r!.host.worker.state === 'failed', 'worker failed');
    const page = await feed;
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((v) => mocks.VIDEOS.some((m) => m.id === v.id))).toBe(true);
    expect(
      r.log.lines.filter((l) => l.msg.startsWith('dev fixtures: the media worker is gone')),
    ).toHaveLength(1);
  });

  it('stopping the host releases waiting reads', async () => {
    r = await rig({ flags: { devMocks: true, devFixtures: true } });
    await r.ready();
    const feed = r.host.adapter.feed({ source: 'trending' });
    r.host.stop();
    expect((await feed).items.length).toBeGreaterThan(0);
  });

  it('without --dev-fixtures a dev.fixtures event is ignored', async () => {
    r = await rig({ flags: { devMocks: true } });
    await r.ready();
    r.worker().fixtures([mocks.VIDEOS[0]!]);
    await eventually(
      () => r!.log.lines.find((l) => l.msg.startsWith('dev.fixtures from the worker ignored')),
      'ignored',
    );
  });
});

describe("slice 4a: a free upload's NFX manifest (kind 38504)", () => {
  const SCOPED = 'wss://scoped.test' as RelayUrl;
  const FREE = {
    file: '/home/alice/Videos/in.mp4',
    title: 'A free video',
    description: 'Made with **ffmpeg**.',
    tags: ['diy'],
    kind: 21 as const,
    mints: [mocks.MINTS.a],
    satsPerBlock: 0 as never,
    split: { seeder: 50, creator: 50 },
  };

  const storedFor = (video: VideoManifest, over: object = {}): object => ({
    state: 'stored',
    video: `nfx:testnet:1:nutflix-${video.id.slice(0, 32)}`,
    root: 'ef'.repeat(32),
    segs: '3',
    renditions: 1,
    bytes: 1000,
    thumb: { sha256: 'cd'.repeat(32), mime: 'image/jpeg' },
    ...over,
  });

  /**
   * A rig whose worker publishes the legacy event, returns, and then (as the real worker, whose
   * NFX packaging finishes later) reports `status(video)`.
   */
  async function nfxUpload(
    status: (video: VideoManifest) => object,
    opts: {
      readonly nfx?: boolean;
      readonly pool?: nostr.FakeRelayPool;
      readonly beforeStatus?: (viewer: InstanceType<typeof kit.TestSigner>) => Promise<void>;
    } = {},
  ): Promise<{ viewer: InstanceType<typeof kit.TestSigner>; video: VideoManifest }> {
    const viewer = new kit.TestSigner();
    r = await rig({
      flags: { devMocks: true },
      identity: new SignerIdentity(viewer),
      nfx: { enabled: true, network: 'nfx:testnet:1', scopedRelays: [SCOPED] },
      ...(opts.pool === undefined ? {} : { pool: opts.pool }),
      worker: {
        handlers: {
          'studio.upload': async (a: StudioUploadArgs, w: FakeWorker) => {
            const video = (await w.request('studio.publish', draftFor(a))) as VideoManifest;
            setTimeout(() => {
              void (async () => {
                await opts.beforeStatus?.(viewer);
                w.event({ e: 'upload.nfx', uploadId: a.uploadId, status: status(video) });
              })();
            }, 20);
            return video;
          },
        },
      },
    });
    await r.ready();
    const video = await r.host.adapter.studio.upload(
      { ...FREE, ...(opts.nfx === false ? {} : { nfx: true }) },
      () => undefined,
    );
    return { viewer, video };
  }

  const manifests = (): NostrEvent[] =>
    (r?.pool.published ?? []).filter((p) => p.event.kind === 38504).map((p) => p.event);
  const refused = (reason: string): boolean =>
    r?.log.lines.some((l) => l.msg === 'NFX manifest not published' && l['reason'] === reason) ??
    false;
  /** Lets anything the host would still do happen first (it publishes within a few ms). */
  const settle = (): Promise<void> => new Promise((ok) => setTimeout(ok, 100));

  it('once stored, the creator signs it and it goes to the write and scoped relays', async () => {
    const { viewer, video } = await nfxUpload((v) => storedFor(v));
    const [ev] = await eventually(() => {
      const m = manifests();
      return m.length > 0 ? m : undefined;
    }, 'the manifest');
    expect(ev?.pubkey).toBe(viewer.pubkey);
    const parsed = nfx.parseManifest(ev);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.addr.toString()).toBe(`nfx:testnet:1:nutflix-${video.id.slice(0, 32)}`);
    expect(parsed.value).toMatchObject({
      title: 'A free video',
      description: 'Made with **ffmpeg**.',
      root: 'ef'.repeat(32),
      segs: 3n,
      duration: 6n,
      thumb: { sha256: 'cd'.repeat(32), mime: 'image/jpeg' },
      license: { mode: 'open' },
      hashtags: ['diy'],
    });
    expect(parsed.value.priceHint).toBeUndefined();
    // The link back to the legacy event (4b de-duplicates on it, same author only).
    expect(ev?.tags).toContainEqual(['e', video.id]);
    // The read-only relay is not written to.
    expect(r?.pool.published.find((p) => p.event.id === ev?.id)?.relays).toEqual([RELAY_A, SCOPED]);
    await eventually(
      () => r?.log.lines.some((l) => l.msg === 'NFX manifest published'),
      'the published line',
    );
    expect(manifests()).toHaveLength(1);
    // Slice 5c: this node may beacon it now, naming the user as the manifest's author.
    const seeded = JSON.parse(
      await readFile(join(r!.userData, 'nfx', 'seeded.json'), 'utf8'),
    ) as unknown;
    expect(seeded).toEqual({
      v: 1,
      videos: [
        { video: parsed.value.addr.toString(), author: viewer.pubkey, root: 'ef'.repeat(32) },
      ],
    });
  });

  it('a failed packaging publishes nothing', async () => {
    await nfxUpload(() => ({ state: 'failed', reason: 'disk-cap' }));
    await eventually(
      () => r?.log.lines.some((l) => l.msg === 'upload not packaged for NFX'),
      'the failure line',
    );
    await settle();
    expect(manifests()).toEqual([]);
  });

  it("a stored video that is not this upload's is never signed", async () => {
    const { viewer } = await nfxUpload((v) =>
      storedFor(v, { video: `nfx:testnet:1:nutflix-${'0'.repeat(32)}` }),
    );
    const signs = (): number => viewer.calls.filter((c) => c.method === 'signEvent').length;
    const before = signs();
    await eventually(() => refused('address-mismatch'), 'the refusal');
    expect(manifests()).toEqual([]);
    expect(signs()).toBe(before);
  });

  it('an upload that did not ask for NFX is not announced, whatever the worker reports', async () => {
    await nfxUpload((v) => storedFor(v), { nfx: false });
    await eventually(() => refused('no-legacy-event'), 'the refusal');
    expect(manifests()).toEqual([]);
  });

  it('no signer by then, or every relay refusing it: logged, never thrown', async () => {
    await nfxUpload((v) => storedFor(v), { beforeStatus: (viewer) => viewer.lock() });
    await eventually(() => refused('no-signer'), 'the no-signer refusal');
    expect(manifests()).toEqual([]);
    await r?.close();
    r = undefined;

    const pool = new nostr.FakeRelayPool({
      rejectPublish: (e) => (e.kind === 38504 ? 'blocked: out of scope' : null),
    });
    await nfxUpload((v) => storedFor(v), { pool });
    await eventually(() => refused('relay-down'), 'the relay refusal');
  });
});
