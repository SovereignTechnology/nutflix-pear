import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Sha256Hex } from '@sovit/core';
import { mocks, payProtocol } from '@sovit/core';

import { toHex } from '../codec.js';
import { FrameDecoder, encodeFrame } from '../framing.js';
import type { Guard } from '../guards.js';
import { dehydrate } from '../wiremap.js';
import {
  isHostToWorker,
  isWorkerToHost,
  validateHostArgs,
  validateHostResult,
  validateWorkerArgs,
  validateWorkerEvent,
  validateWorkerResult,
} from '../worker-guards.js';
import { WORKER_V } from '../worker-protocol.js';
import type {
  HostMethod,
  HostMethodTable,
  PublishDraft,
  WorkerEvent,
  WorkerEventName,
  WorkerMethod,
  WorkerMethodTable,
} from '../worker-protocol.js';
import { MINT, PUBKEY, SID, UPLOAD_ID, VIDEO, sats } from './samples.js';

const R = VIDEO.renditions[0]!;
const HYPER_IMG = `hyper://${'ab'.repeat(32)}/0-1`;
const seeding = { enabled: true, diskCapBytes: 50 * 1024 ** 3 };
const meta = {
  title: 'My video',
  description: '',
  tags: ['space'],
  kind: 21 as const,
  mints: [MINT],
  satsPerBlock: sats(2),
  split: { seeder: 50, creator: 50 },
};

const ARGS: { readonly [M in WorkerMethod]: readonly WorkerMethodTable[M][0][] } = {
  init: [
    { v: WORKER_V, storage: '/home/u/.config/nutflix/worker', seeding, prefetchSeconds: 30 },
    {
      v: WORKER_V,
      storage: '/tmp/w',
      seeding,
      prefetchSeconds: 30,
      ffmpeg: { ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe' },
      dev: { mocks: true, fixtures: true, bootstrap: [{ host: '127.0.0.1', port: 49737 }] },
    },
  ],
  'play.open': [
    {
      sid: SID,
      videoId: VIDEO.id,
      rendition: { label: R.label, hyper: R.hyper, size: R.size, bitrateKbps: 2500 },
      durationSec: 600,
      policy: VIDEO.price,
      prefetchSeconds: 30,
    },
  ],
  'play.pause': [{ sid: SID }],
  'play.resume': [{ sid: SID }],
  'play.prefetch': [{ sid: SID, seconds: 10 }],
  'play.close': [{ sid: SID }],
  'seeder.status': [{}],
  'seeder.configure': [seeding],
  'seeder.melt': [{ mint: MINT, bolt11: 'lnbc500n1pmockinvoice' }],
  'seeder.unban': [{ pubkey: PUBKEY }],
  'studio.ffmpeg': [{ recheck: true }, { recheck: false, path: '/opt/ffmpeg/bin/ffmpeg' }],
  'studio.upload': [
    { uploadId: UPLOAD_ID, path: '/home/u/Videos/a.mp4', name: 'a.mp4', meta },
    {
      uploadId: UPLOAD_ID,
      path: 'C:\\Users\\u\\a.mp4',
      name: 'a.mp4',
      meta,
      thumbnailChoice: { hex: toHex(Uint8Array.of(0xff, 0xd8)), type: 'image/jpeg' },
    },
    { uploadId: UPLOAD_ID, path: '/a.mp4', name: 'a.mp4', meta, thumbnailChoice: 1 },
    // Contracts v8: a free video may also go to NFX.
    {
      uploadId: UPLOAD_ID,
      path: '/a.mp4',
      name: 'a.mp4',
      meta: { ...meta, satsPerBlock: sats(0), nfx: true },
    },
    { uploadId: UPLOAD_ID, path: '/a.mp4', name: 'a.mp4', meta: { ...meta, nfx: false } },
  ],
  // ADR 0015: a profile-core image.
  'image.fetch': [{ url: HYPER_IMG, sha256: R.sha256, size: 1000 }],
  'profile.putImage': [{ hex: 'ffd8ffe0' }],
};

const status = dehydrate(await new mocks.MockNetworkAdapter().seeder.status());

const RESULTS: { readonly [M in WorkerMethod]: readonly WorkerMethodTable[M][1][] } = {
  init: [undefined],
  'play.open': [{ key: R.hyper.core, link: 'http://127.0.0.1:41234/abc?token=x' }],
  'play.pause': [undefined],
  'play.resume': [undefined],
  'play.prefetch': [undefined],
  // Lane P2-owed-viewer: play.close answers the session's unpaid tail (it answered nothing before;
  // the host now keeps a tail authorisation for what is left — ADR 0018 amendment).
  'play.close': [{ unpaid: 0 }, { unpaid: 12 }],
  'seeder.status': [status],
  'seeder.configure': [undefined],
  'seeder.melt': [{ paid: true }],
  'seeder.unban': [undefined],
  'studio.ffmpeg': [
    { found: false },
    { found: true, path: '/usr/bin/ffmpeg', version: '8.1.2', os: 'linux' },
  ],
  'studio.upload': [VIDEO],
  'image.fetch': [{ hex: 'ffd8ffe0' }],
  'profile.putImage': [{ url: HYPER_IMG, sha256: R.sha256, size: 4 }],
};

const draft: PublishDraft = {
  uploadId: UPLOAD_ID,
  meta,
  durationSec: 600,
  blockSize: 65536,
  renditions: [
    {
      label: R.label,
      mime: R.mime,
      sha256: R.sha256,
      size: R.size,
      hyper: R.hyper,
      hyperUrl: R.hyperUrl,
      fallbacks: [],
    },
  ],
  thumbnail: { kind: 'candidate', path: '/tmp/w/thumb-1.jpg', sha256: R.sha256 },
  storyboard: {
    path: '/tmp/w/sb.jpg',
    vttPath: '/tmp/w/sb.vtt',
    sha256: R.sha256,
    cols: 10,
    rows: 5,
    intervalSec: 5,
  },
  codec: 'h264',
  thumbnailImage: { url: HYPER_IMG, sha256: R.sha256, size: 1000 },
};
const P2PK = `02${'5e'.repeat(32)}` as never;
const PROOF = {
  id: `00${'ab'.repeat(7)}`,
  amount: 2,
  secret: '["P2PK",{"nonce":"ab","data":"02"}]',
  C: `03${'cd'.repeat(32)}`,
  dleq: { e: 'e1'.repeat(32), s: '5a'.repeat(32), r: 'f0'.repeat(32) },
};
const LOCKED = { mint: MINT, unit: 'sat' as const, lockedTo: P2PK, proofs: [PROOF] };
const RANGE = { core: R.hyper.core, fromBlock: 0, toBlock: 3 };
/** Exactly what `buildHello` asks the signer to sign (a 64-byte Noise handshake hash). */
const CHALLENGE = payProtocol.helloChallenge(
  new Uint8Array(64).fill(7),
  new Uint8Array(32).fill(9),
);
const HOST_ARGS: { readonly [M in HostMethod]: readonly HostMethodTable[M][0][] } = {
  'studio.publish': [
    draft,
    { ...draft, thumbnail: { kind: 'custom', sha256: R.sha256, type: 'image/png' } },
  ],
  'pay.build': [
    {
      sid: SID,
      range: RANGE,
      seeder: { pubkey: PUBKEY, p2pk: P2PK, mint: MINT },
      policy: VIDEO.price,
      carryIn: 0,
    },
  ],
  'pay.hello': [{ challenge: CHALLENGE }],
  'seller.keyset': [
    { mint: MINT, id: `00${'ab'.repeat(7)}` },
    { mint: MINT, id: `01${'ab'.repeat(32)}` },
  ],
  'seller.redeem': [{ mint: MINT, proofs: [PROOF] }],
  'seller.checkSpent': [{ mint: MINT, proofs: [PROOF, { ...PROOF, secret: 's2' }] }],
  'seller.spentByUs': [{ mint: MINT, proofs: [PROOF] }],
  'seller.nutzap': [{ set: LOCKED, core: R.hyper.core }],
};

const EVENTS: { readonly [E in WorkerEventName]: readonly Extract<WorkerEvent, { e: E }>[] } = {
  ready: [{ op: 'ev', e: 'ready', v: WORKER_V, port: 41234 }],
  spend: [
    {
      op: 'ev',
      e: 'spend',
      sid: SID,
      mint: MINT,
      amount: sats(8),
      total: sats(64),
      ratePerMin: sats(480),
    },
  ],
  peers: [
    { op: 'ev', e: 'peers', sid: SID, peers: [] },
    {
      op: 'ev',
      e: 'peers',
      sid: SID,
      peers: [{ pubkey: PUBKEY, sats: sats(4), ratePerMin: sats(240), blocks: 2, latencyMs: 40 }],
    },
  ],
  'seeder.status': [{ op: 'ev', e: 'seeder.status', status }],
  'upload.progress': [
    { op: 'ev', e: 'upload.progress', uploadId: UPLOAD_ID, progress: { stage: 'probing' } },
    {
      op: 'ev',
      e: 'upload.progress',
      uploadId: UPLOAD_ID,
      progress: { stage: 'transcoding', rendition: '720p', percent: 50 },
    },
    {
      op: 'ev',
      e: 'upload.progress',
      uploadId: UPLOAD_ID,
      progress: { stage: 'thumbnails', candidates: ['/tmp/w/thumb-1.jpg'] },
    },
    {
      op: 'ev',
      e: 'upload.progress',
      uploadId: UPLOAD_ID,
      progress: { stage: 'done', video: VIDEO },
    },
    {
      op: 'ev',
      e: 'upload.progress',
      uploadId: UPLOAD_ID,
      progress: { stage: 'error', message: 'process-failed: exit 1' },
    },
  ],
  'upload.nfx': [
    {
      op: 'ev',
      e: 'upload.nfx',
      uploadId: UPLOAD_ID,
      status: {
        state: 'stored',
        video: `nfx:testnet:1:nutflix-${'0a'.repeat(16)}`,
        root: 'ef'.repeat(32) as Sha256Hex,
        segs: '12',
        renditions: 3,
        bytes: 1_000_000,
      },
    },
    {
      op: 'ev',
      e: 'upload.nfx',
      uploadId: UPLOAD_ID,
      status: { state: 'failed', reason: 'disk-cap' },
    },
  ],
  'dev.fixtures': [{ op: 'ev', e: 'dev.fixtures', videos: mocks.VIDEOS }],
  log: [{ op: 'ev', e: 'log', level: 'warn', msg: 'peer banned' }],
};

/** Everything crosses as JSON; check the guards on the decoded form. */
const viaJson = (x: unknown): unknown =>
  x === undefined ? undefined : JSON.parse(JSON.stringify(x));

describe('host → worker', () => {
  it.each(Object.keys(ARGS) as WorkerMethod[])(
    '%s: valid args pass (as a framed request too)',
    (m) => {
      for (const a of ARGS[m] as readonly unknown[]) {
        expect((validateWorkerArgs[m] as Guard<unknown>)(viaJson(a)), JSON.stringify(a)).toBe(true);
        const frames: unknown[] = [];
        new FrameDecoder((x) => frames.push(x)).push(encodeFrame({ op: 'req', id: 1, m, a }));
        expect(isHostToWorker(frames[0])).toBe(true);
      }
    },
  );

  it.each(Object.keys(RESULTS) as WorkerMethod[])('%s: valid results pass', (m) => {
    for (const r of RESULTS[m] as readonly unknown[])
      expect((validateWorkerResult[m] as Guard<unknown>)(viaJson(r)), JSON.stringify(r)).toBe(true);
  });

  it('the --dev-mocks fence: a custom bootstrap only with mocks, only 127.0.0.1', () => {
    const base = ARGS.init[1]!;
    const g = validateWorkerArgs.init;
    expect(g(base)).toBe(true);
    expect(
      g({
        ...base,
        dev: { mocks: false, fixtures: true, bootstrap: [{ host: '127.0.0.1', port: 1 }] },
      }),
    ).toBe(false);
    expect(
      g({
        ...base,
        dev: { mocks: true, fixtures: false, bootstrap: [{ host: '10.0.0.1', port: 1 }] },
      }),
    ).toBe(false);
    expect(
      g({
        ...base,
        dev: { mocks: true, fixtures: false, bootstrap: [{ host: 'localhost', port: 1 }] },
      }),
    ).toBe(false);
    expect(g({ ...base, dev: { mocks: true, fixtures: false, bootstrap: [] } })).toBe(false);
    expect(g({ ...base, dev: { mocks: false, fixtures: false } })).toBe(true);
  });

  it('rejects bad args', () => {
    const up = ARGS['studio.upload'][0]!;
    for (const [m, a] of [
      ['init', { ...ARGS.init[0], v: 2 }],
      ['init', { ...ARGS.init[0], storage: 'relative/dir' }],
      ['play.open', { ...ARGS['play.open'][0], sid: 'short' }],
      ['play.open', { ...ARGS['play.open'][0], policy: { ...VIDEO.price, creatorP2pk: 'zz' } }],
      ['play.prefetch', { sid: SID, seconds: -1 }],
      ['studio.upload', { ...up, path: 'a.mp4' }],
      ['studio.upload', { ...up, thumbnailChoice: { hex: 'abc', type: 'image/jpeg' } }],
      ['studio.upload', { ...up, thumbnailChoice: { hex: 'AB', type: 'image/jpeg' } }],
      ['studio.upload', { ...up, meta: { ...meta, mirrorTo: ['http://x'] } }],
      // v6: media on Pear only — no Blossom mirror list crosses, not even a well-formed one.
      ['studio.upload', { ...up, meta: { ...meta, mirrorTo: ['https://blossom.example'] } }],
      // Contracts v8: never NFX for a priced video (free only, issue #15), and only a boolean.
      ['studio.upload', { ...up, meta: { ...meta, nfx: true } }],
      ['studio.upload', { ...up, meta: { ...meta, satsPerBlock: sats(0), nfx: 'yes' } }],
      ['seeder.status', { extra: 1 }],
      ['studio.ffmpeg', { recheck: true, path: 'ffmpeg' }],
      // ADR 0015: only a profile-core reference, within the image cap.
      ['image.fetch', { url: 'https://x.example/a.jpg', sha256: R.sha256, size: 10 }],
      ['image.fetch', { url: HYPER_IMG, sha256: R.sha256, size: 0 }],
      ['image.fetch', { url: HYPER_IMG, sha256: R.sha256, size: 5 * 1024 * 1024 + 1 }],
      ['image.fetch', { url: HYPER_IMG, size: 10 }],
    ] as const)
      expect((validateWorkerArgs[m] as Guard<unknown>)(a), `${m} ${JSON.stringify(a)}`).toBe(false);
    expect(
      validateWorkerResult['play.open']({ key: R.hyper.core, link: 'http://evil.example:80/x' }),
    ).toBe(false);
    expect(
      validateWorkerResult['play.open']({ key: R.hyper.core, link: 'http://127.0.0.1:0/x' }),
    ).toBe(false);
    expect(validateWorkerResult.init({})).toBe(false);
    // Lane P2-owed-viewer: the unpaid tail is a bounded count, exact keys, nothing else.
    for (const bad of [
      undefined,
      {},
      { unpaid: -1 },
      { unpaid: 1.5 },
      { unpaid: '3' },
      { unpaid: 2 ** 21 },
      { unpaid: 1, extra: true },
    ])
      expect(validateWorkerResult['play.close'](bad), JSON.stringify(bad)).toBe(false);
    expect(validateWorkerResult['image.fetch']({ hex: 'abc' })).toBe(false); // odd length
    expect(validateWorkerResult['image.fetch']({ hex: 'ZZ' })).toBe(false);
    expect(isHostToWorker({ op: 'req', id: 1, m: 'studio.publish', a: draft })).toBe(false); // wrong direction
    expect(isHostToWorker({ op: 'req', id: 1, m: 'hasOwnProperty', a: {} })).toBe(false);
    expect(isHostToWorker({ op: 'ev', e: 'ready', v: WORKER_V, port: 1 })).toBe(false);
  });
});

describe('worker → host', () => {
  it('studio.publish args and result', () => {
    for (const a of HOST_ARGS['studio.publish']) {
      expect(validateHostArgs['studio.publish'](viaJson(a))).toBe(true);
      expect(isWorkerToHost({ op: 'req', id: 9, m: 'studio.publish', a: viaJson(a) })).toBe(true);
    }
    expect(validateHostResult['studio.publish'](viaJson(VIDEO))).toBe(true);
    expect(validateHostArgs['studio.publish']({ ...draft, renditions: [] })).toBe(false);
    expect(
      validateHostArgs['studio.publish']({
        ...draft,
        thumbnail: { kind: 'custom', sha256: R.sha256, type: 'image/png', bytes: 'ff' },
      }),
    ).toBe(false);
    expect(isWorkerToHost({ op: 'req', id: 9, m: 'play.open', a: ARGS['play.open'][0] })).toBe(
      false,
    );
  });

  it.each(Object.keys(HOST_ARGS) as HostMethod[])('host method %s: valid samples pass', (m) => {
    for (const a of HOST_ARGS[m] as readonly unknown[]) {
      expect((validateHostArgs[m] as Guard<unknown>)(viaJson(a)), m).toBe(true);
      expect(isWorkerToHost({ op: 'req', id: 3, m, a: viaJson(a) })).toBe(true);
    }
  });

  it('money calls (ADR 0012): malformed args and results are refused', () => {
    const build = HOST_ARGS['pay.build'][0]!;
    expect(validateHostArgs['pay.build']({ ...build, range: { ...RANGE, toBlock: -1 } })).toBe(
      false,
    );
    expect(validateHostArgs['pay.build']({ ...build, range: { ...RANGE, fromBlock: 5 } })).toBe(
      false,
    ); // to < from
    expect(validateHostArgs['pay.build']({ ...build, carryIn: 100 })).toBe(false);
    expect(validateHostArgs['pay.build']({ ...build, sid: 'nope' })).toBe(false);
    expect(validateHostArgs['pay.hello']({ challenge: 'ab'.repeat(32) })).toBe(false); // not a HELLO challenge
    expect(validateHostArgs['pay.hello']({ challenge: CHALLENGE.toUpperCase() })).toBe(false);
    expect(validateHostArgs['pay.hello']({ challenge: `${CHALLENGE}\n` })).toBe(false);
    expect(validateHostArgs['pay.hello']({ challenge: CHALLENGE, kind: 1 })).toBe(false);
    expect(validateHostArgs['seller.redeem']({ mint: MINT, proofs: [] })).toBe(false);
    expect(
      validateHostArgs['seller.redeem']({
        mint: MINT,
        proofs: Array.from({ length: 129 }, () => PROOF),
      }),
    ).toBe(false);
    expect(
      validateHostArgs['seller.redeem']({ mint: MINT, proofs: [{ ...PROOF, amount: 0 }] }),
    ).toBe(false);
    expect(
      validateHostArgs['seller.nutzap']({ set: { ...LOCKED, unit: 'usd' }, core: R.hyper.core }),
    ).toBe(false);
    // Results the worker checks.
    expect(validateHostResult['seller.redeem']({ ok: true, sats: 5 })).toBe(true);
    expect(validateHostResult['seller.redeem']({ ok: false, spent: true })).toBe(true);
    expect(validateHostResult['seller.redeem']({ ok: true })).toBe(false);
    expect(
      validateHostResult['pay.hello']({ pubkey: PUBKEY, createdAt: 1, signature: 'ab'.repeat(64) }),
    ).toBe(true);
    expect(validateHostResult['pay.hello']({ pubkey: PUBKEY, createdAt: 1, signature: 'ab' })).toBe(
      false,
    );
    expect(
      validateHostResult['pay.build']({
        range: RANGE,
        carryIn: 0,
        seederProofs: LOCKED,
        creatorProofs: LOCKED,
      }),
    ).toBe(true);
    // Lane P2-owed-viewer (found building the independent review's 90/10 test): a set whose share
    // is 0 sats by the split is legitimately EMPTY (contracts v5, `PayMessage`) — at 90/10 a PAY
    // of 3 blocks at 2 sats gives the creator 0. The guard refused such a PAY after the host had
    // built it (its proofs spent, locked to the seeder), and the payer asked again. A PAY carries
    // at least one proof, in one set or the other; a set to redeem or nutzap is never empty.
    const empty = { ...LOCKED, proofs: [] };
    expect(
      validateHostResult['pay.build']({
        range: RANGE,
        carryIn: 60,
        seederProofs: LOCKED,
        creatorProofs: empty,
      }),
    ).toBe(true);
    expect(
      validateHostResult['pay.build']({
        range: RANGE,
        carryIn: 0,
        seederProofs: empty,
        creatorProofs: LOCKED,
      }),
    ).toBe(true);
    expect(
      validateHostResult['pay.build']({
        range: RANGE,
        carryIn: 0,
        seederProofs: empty,
        creatorProofs: empty,
      }),
    ).toBe(false);
    expect(
      validateHostResult['pay.build']({
        range: RANGE,
        carryIn: 0,
        seederProofs: LOCKED,
        creatorProofs: { ...empty, unit: 'usd' },
      }),
    ).toBe(false);
    expect(validateHostArgs['seller.nutzap']({ set: empty, core: R.hyper.core })).toBe(false);
    expect(validateHostResult['seller.keyset'](null)).toBe(true);
    expect(
      validateHostResult['seller.keyset']({
        mint: MINT,
        id: `00${'ab'.repeat(7)}`,
        unit: 'sat',
        active: true,
        keys: { '1': P2PK, abc: P2PK },
        fetchedAt: 0,
      }),
    ).toBe(false);
    // Real payments and dev mocks never together.
    const init = ARGS.init[0]!;
    const payments = { pubkey: PUBKEY, p2pk: P2PK, mints: [MINT] };
    expect(validateWorkerArgs.init({ ...init, payments })).toBe(true);
    expect(
      validateWorkerArgs.init({ ...init, payments, dev: { mocks: true, fixtures: false } }),
    ).toBe(false);
  });

  it.each(Object.keys(EVENTS) as WorkerEventName[])('event %s: valid samples pass', (e) => {
    for (const ev of EVENTS[e] as readonly unknown[]) {
      expect(
        (validateWorkerEvent[e] as Guard<unknown>)(viaJson(ev)),
        JSON.stringify(ev).slice(0, 200),
      ).toBe(true);
      expect(isWorkerToHost(viaJson(ev))).toBe(true);
    }
  });

  it('rejects bad events', () => {
    for (const ev of [
      { op: 'ev', e: 'ready', v: 2, port: 1 },
      { op: 'ev', e: 'ready', v: WORKER_V, port: 0 },
      { op: 'ev', e: 'spend', sid: SID, mint: MINT, amount: 0, total: 0, ratePerMin: 0 },
      { op: 'ev', e: 'spend', sid: SID, mint: 'http://mint', amount: 1, total: 1, ratePerMin: 0 },
      {
        op: 'ev',
        e: 'upload.progress',
        uploadId: UPLOAD_ID,
        progress: { stage: 'thumbnails', candidates: ['nf-media://img/x'] },
      },
      {
        op: 'ev',
        e: 'upload.progress',
        uploadId: UPLOAD_ID,
        progress: { stage: 'transcoding', rendition: '720p', percent: 101 },
      },
      ...[
        {
          state: 'stored',
          video: 'nutflix:testnet:1:x',
          root: 'ef'.repeat(32),
          segs: '1',
          renditions: 1,
          bytes: 1,
        },
        {
          state: 'stored',
          video: 'nfx:testnet:1:Upper-Case',
          root: 'ef'.repeat(32),
          segs: '1',
          renditions: 1,
          bytes: 1,
        },
        {
          state: 'stored',
          video: 'nfx:testnet:1:nutflix-abc1234',
          root: 'EF'.repeat(32),
          segs: '1',
          renditions: 1,
          bytes: 1,
        },
        {
          state: 'stored',
          video: 'nfx:testnet:1:nutflix-abc1234',
          root: 'ef'.repeat(32),
          segs: '01',
          renditions: 1,
          bytes: 1,
        },
        {
          state: 'stored',
          video: 'nfx:testnet:1:nutflix-abc1234',
          root: 'ef'.repeat(32),
          segs: '1',
          renditions: 0,
          bytes: 1,
        },
        { state: 'failed', reason: 'oops' },
        { state: 'failed', reason: 'disk-cap', message: '/home/u/secret path' },
      ].map((status) => ({ op: 'ev', e: 'upload.nfx', uploadId: UPLOAD_ID, status })),
      { op: 'ev', e: 'log', level: 'trace', msg: 'x' },
      { op: 'ev', e: 'log', level: 'info', msg: 'x', extra: 1 },
      { op: 'ev', e: 'constructor' },
      {
        op: 'ev',
        e: 'seeder.status',
        status: dehydrate({
          ...status,
          earned: {
            ...status.earned,
            byMint: {
              $map: [
                [MINT, 1],
                [MINT, 2],
              ],
            },
          },
        }),
      },
    ])
      expect(isWorkerToHost(ev), JSON.stringify(ev)).toBe(false);
  });

  it('responses both ways: ok with/without r, error must be a valid WireError', () => {
    for (const g of [isHostToWorker, isWorkerToHost]) {
      expect(g({ op: 'res', id: 1, ok: true })).toBe(true);
      expect(g({ op: 'res', id: 1, ok: true, r: { a: 1 } })).toBe(true);
      expect(
        g({ op: 'res', id: 1, ok: false, e: { code: 'not-found', message: 'not-found: x' } }),
      ).toBe(true);
      expect(g({ op: 'res', id: 1, ok: false, e: { code: 'not-found', message: 'x' } })).toBe(
        false,
      );
      expect(g({ op: 'res', id: 1, ok: false })).toBe(false);
      expect(g({ op: 'res', id: -1, ok: true })).toBe(false);
    }
  });

  it('fuzz: the top-level guards never throw and reject junk', () => {
    fc.assert(
      fc.property(fc.anything({ withNullPrototype: true, withTypedArray: true }), (x) => {
        expect(isHostToWorker(x)).toBe(false);
        expect(isWorkerToHost(x)).toBe(false);
      }),
      { numRuns: 500 },
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...(Object.keys(EVENTS) as WorkerEventName[])),
        fc.string(),
        fc.anything(),
        (e, k, v) => {
          const ev = (EVENTS[e] as readonly object[])[0]!;
          fc.pre(!(k in ev));
          expect(isWorkerToHost({ ...ev, [k]: v })).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });
});
