/**
 * Design §3 row 2: the preload's exposed surface = the NetworkAdapter shape + `desktop.ffmpeg`,
 * nothing else; D3/D5 stubs reject `forbidden`; PlaySession methods close over `sid`; SE-1 in
 * the preload (a string path is refused before any IPC; the File goes through
 * `webUtils.getPathForFile` → grant → token; progress is subscribed and acknowledged first).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mocks } from '@sovit/core';
import type {
  ArgsOf,
  Method,
  NfxPlaySessionWire,
  PlaySessionWire,
  Topic,
} from '../../ipc/protocol.js';
import { EXCLUDED_METHODS, METHODS, SHELL_TOPIC_METHODS, TOPIC_METHODS } from '../../ipc/index.js';
import { fromWireError, wireError } from '../../ipc/errors.js';
import { createBridge } from '../bridge.js';
import type { Transport } from '../transport.js';
import type { BridgeUploadInput } from '../types.js';

const { VIDEOS, MINTS } = mocks;
const VIDEO = VIDEOS[0]!;
const SID = 'a'.repeat(32);

/** The allowlist, derived from L6-0's constants (the same derivation the renderer test uses). */
export function expectedKeyTree(): string[] {
  const keys = new Set<string>(['platform']);
  // Every dotted prefix is an object key too (`desktop`, `desktop.signer`, …).
  const add = (dotted: string): void => {
    const parts = dotted.split('.');
    for (let i = 1; i <= parts.length; i++) keys.add(parts.slice(0, i).join('.'));
  };
  for (const m of METHODS) if (!m.startsWith('session.')) add(m);
  for (const m of Object.keys(EXCLUDED_METHODS)) add(m);
  for (const m of Object.keys(TOPIC_METHODS)) add(m);
  for (const m of Object.keys(SHELL_TOPIC_METHODS)) add(m);
  return [...keys].sort();
}

function keyTree(o: object, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    const name = prefix === '' ? k : `${prefix}.${k}`;
    out.push(name);
    if (typeof v === 'object' && v !== null) out.push(...keyTree(v as object, name));
  }
  return out.sort();
}

interface Call {
  method: string;
  args: unknown[];
}

function fakeTransport(results: Partial<Record<string, unknown>> = {}): {
  t: Transport;
  calls: Call[];
  subs: { topic: Topic; cb: (p: unknown) => void; unsubscribed: boolean }[];
  grants: string[];
  order: string[];
} {
  const calls: Call[] = [];
  const subs: { topic: Topic; cb: (p: unknown) => void; unsubscribed: boolean }[] = [];
  const grants: string[] = [];
  const order: string[] = [];
  const t: Transport = {
    call: <M extends Method>(method: M, args: ArgsOf<M>) => {
      calls.push({ method, args: [...(args as unknown[])] });
      order.push(`call:${method}`);
      const r = results[method];
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r as never);
    },
    subscribe: (topic, cb) => {
      const s = { topic, cb: cb as (p: unknown) => void, unsubscribed: false };
      subs.push(s);
      order.push(`sub:${topic.t}`);
      return () => {
        s.unsubscribed = true;
      };
    },
    subscribeAcked: (topic, cb) => {
      const s = { topic, cb: cb as (p: unknown) => void, unsubscribed: false };
      subs.push(s);
      order.push(`sub-acked:${topic.t}`);
      return Promise.resolve(() => {
        s.unsubscribed = true;
      });
    },
    grantFile: (path) => {
      grants.push(path);
      order.push('grant');
      return Promise.resolve(`nf-file:${'e'.repeat(32)}` as const);
    },
  };
  return { t, calls, subs, grants, order };
}

const wire = (sid = SID): PlaySessionWire => ({
  sid: sid as PlaySessionWire['sid'],
  videoId: VIDEO.id,
  rendition: '720p',
  source: { kind: 'url', url: 'nf-media://play/tok0123456789abcdef' },
  policy: VIDEO.price,
});

let pathForFile: (f: File) => string;
beforeEach(() => {
  // Like webUtils.getPathForFile: throws for anything that is not a File.
  pathForFile = (f) => {
    if (!(f instanceof File)) throw new TypeError('Expected a File');
    return '/home/u/Videos/clip.mp4';
  };
});

function bridge(results: Partial<Record<string, unknown>> = {}): ReturnType<
  typeof fakeTransport
> & {
  b: ReturnType<typeof createBridge>;
} {
  const f = fakeTransport(results);
  return {
    ...f,
    b: createBridge(f.t, {
      pathForFile: (file) => pathForFile(file),
      randomHex: (n) => 'f'.repeat(n * 2),
    }),
  };
}

async function codeOf(p: Promise<unknown>): Promise<{ code: unknown; message: string }> {
  try {
    await p;
  } catch (e: unknown) {
    const err = e as Error & { code?: unknown };
    return { code: err.code, message: err.message };
  }
  throw new Error('expected a rejection');
}

describe('preload surface (key tree allowlist)', () => {
  it('exposes exactly the NetworkAdapter shape + desktop.ffmpeg + desktop.signer.*', () => {
    const { b } = bridge();
    expect(keyTree(b)).toEqual(expectedKeyTree());
    expect(keyTree(b)).toContain('desktop.ffmpeg');
    expect(keyTree(b)).toContain('desktop.signer.connect');
    expect(keyTree(b)).not.toContain('invoke');
    expect(Object.keys(b)).not.toContain('ipcRenderer');
  });

  it('R5-R1: desktop.wallet.topUp.* — holds takes nothing; resume forwards the entry id only', async () => {
    const { b, calls } = bridge({
      'desktop.wallet.topUp.holds': [],
      'desktop.wallet.topUp.resume': true,
    });
    const t = b.desktop.wallet.topUp;
    expect(await t.holds()).toEqual([]);
    // Whatever else a compromised page passes, only the first argument crosses (main's gate
    // then checks its form); the host asks main's native dialog before anything changes.
    const loose = t as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    await loose['holds']?.({ all: true });
    await loose['resume']?.('0123456789abcdef', { confirmed: true });
    expect(calls).toEqual([
      { method: 'desktop.wallet.topUp.holds', args: [] },
      { method: 'desktop.wallet.topUp.holds', args: [] },
      { method: 'desktop.wallet.topUp.resume', args: ['0123456789abcdef'] },
    ]);
  });

  it('ADR 0016: desktop.wallet.recovery.* name an action only (no arguments cross), progress is a topic', async () => {
    const { b, calls, subs } = bridge({
      'desktop.wallet.recovery.status': {
        state: 'covered',
        reissuePending: false,
        relayCopy: true,
      },
    });
    const r = b.desktop.wallet.recovery;
    expect(await r.status()).toEqual({ state: 'covered', reissuePending: false, relayCopy: true });
    // Whatever a compromised page passes, nothing but the method name goes on the wire.
    const loose = r as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    await loose['setup']?.(
      'abandon ability able about above absent absorb abstract absurd abuse access accident',
    );
    await loose['show']?.({ words: [1, 2, 3] });
    await loose['restore']?.([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(calls).toEqual([
      { method: 'desktop.wallet.recovery.status', args: [] },
      { method: 'desktop.wallet.recovery.setup', args: [] },
      { method: 'desktop.wallet.recovery.show', args: [] },
      { method: 'desktop.wallet.recovery.restore', args: [] },
    ]);
    const seen: unknown[] = [];
    const off = r.onProgress((p) => seen.push(p));
    expect(subs.map((x) => x.topic)).toEqual([{ t: 'recovery.progress' }]);
    subs[0]?.cb({ phrase: 1, phrases: 1, mint: 'https://m.example', keysetsDone: 0, keysets: 1 });
    expect(seen).toHaveLength(1);
    off();
    expect(subs[0]?.unsubscribed).toBe(true);
  });

  it('every leaf is a function except platform', () => {
    const { b } = bridge();
    expect(b.platform).toBe('desktop');
    const leaves = (o: object): unknown[] =>
      Object.values(o as Record<string, unknown>).flatMap((v) =>
        typeof v === 'object' && v !== null ? leaves(v) : [v],
      );
    expect(leaves(b).filter((v) => typeof v !== 'function')).toEqual(['desktop']);
  });

  it.each(Object.keys(EXCLUDED_METHODS))(
    '%s rejects forbidden and never touches IPC (D3/D5)',
    async (m) => {
      const { b, calls } = bridge();
      const fn = (b.wallet as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
        m.slice('wallet.'.length)
      ];
      const r = await codeOf(fn!(1, { p2pk: '02', mint: MINTS.a }));
      expect(r.code).toBe('forbidden');
      expect(r.message).toMatch(/^forbidden: /);
      expect(calls).toHaveLength(0);
    },
  );
});

describe('calls', () => {
  it('maps dotted methods to the right wire method with the caller args', async () => {
    const { b, calls } = bridge();
    await b.library.history('c1');
    await b.related(VIDEO.id);
    await b.related(VIDEO.id, 4);
    await b.desktop.ffmpeg({ recheck: true });
    await b.wallet.balances();
    expect(calls).toEqual([
      { method: 'library.history', args: ['c1'] },
      { method: 'related', args: [VIDEO.id] },
      { method: 'related', args: [VIDEO.id, 4] },
      { method: 'desktop.ffmpeg', args: [{ recheck: true }] },
      { method: 'wallet.balances', args: [] },
    ]);
  });

  it('callback members subscribe to their topics', () => {
    const { b, subs } = bridge();
    const u1 = b.notifications(() => undefined);
    b.seeder.onStatus(() => undefined);
    b.wallet.onChange(() => undefined);
    expect(subs.map((s) => s.topic)).toEqual([
      { t: 'notifications' },
      { t: 'seeder.status' },
      { t: 'wallet.change' },
    ]);
    u1();
    expect(subs[0]?.unsubscribed).toBe(true);
  });
});

describe('PlaySession around sid', () => {
  it('play without a label sends exactly [videoId]', async () => {
    const { b, calls } = bridge({ play: wire() });
    await b.play(VIDEO.id);
    expect(calls[0]).toEqual({ method: 'play', args: [VIDEO.id] });
  });

  it('methods close over sid; onPeers/onSpend subscribe to session topics', async () => {
    const { b, calls, subs } = bridge({
      play: wire(),
      'session.switchRendition': wire('b'.repeat(32)),
    });
    const s = await b.play(VIDEO.id, '720p');
    expect(s.source).toEqual({ kind: 'url', url: 'nf-media://play/tok0123456789abcdef' });
    s.pause();
    s.resume();
    s.setPrefetchSeconds(30);
    s.setPrefetchSeconds(99_999);
    s.setPrefetchSeconds(-5);
    s.setPrefetchSeconds(Number.NaN);
    const peers: unknown[] = [];
    s.onPeers((p) => peers.push(p));
    s.onSpend(() => undefined);
    expect(subs.map((x) => x.topic)).toEqual([
      { t: 'session.peers', sid: SID },
      { t: 'session.spend', sid: SID },
    ]);
    subs[0]?.cb([{ pubkey: 'p', sats: 1, ratePerMin: 1, blocks: 1 }]);
    expect(peers).toHaveLength(1);
    const next = await s.switchRendition('360p');
    expect(next).not.toBe(s);
    await Promise.resolve();
    expect(calls.slice(1)).toEqual([
      { method: 'session.pause', args: [SID] },
      { method: 'session.resume', args: [SID] },
      { method: 'session.setPrefetchSeconds', args: [SID, 30] },
      { method: 'session.setPrefetchSeconds', args: [SID, 600] },
      { method: 'session.setPrefetchSeconds', args: [SID, 0] },
      { method: 'session.switchRendition', args: [SID, '360p'] },
    ]);
  });

  it('close drops the session subscriptions, calls session.close once, then goes quiet', async () => {
    const { b, calls, subs } = bridge({ play: wire() });
    const s = await b.play(VIDEO.id);
    s.onPeers(() => undefined);
    s.onSpend(() => undefined);
    await s.close();
    await s.close();
    expect(subs.every((x) => x.unsubscribed)).toBe(true);
    expect(calls.filter((c) => c.method === 'session.close')).toEqual([
      { method: 'session.close', args: [SID] },
    ]);
    s.pause();
    s.resume();
    expect(s.onPeers(() => undefined)).toBeTypeOf('function');
    expect(subs).toHaveLength(2);
    expect((await codeOf(s.switchRendition('360p'))).code).toBe('session-closed');
    expect(calls.filter((c) => c.method === 'session.pause')).toHaveLength(0);
  });

  it('close tolerates a session the host already closed, but surfaces other failures', async () => {
    const closed = bridge({
      play: wire(),
      'session.close': fromWireError(wireError('session-closed', 'gone')),
    });
    await expect((await closed.b.play(VIDEO.id)).close()).resolves.toBeUndefined();
    const down = bridge({
      play: wire(),
      'session.close': fromWireError(wireError('backend-down', 'x')),
    });
    expect((await codeOf((await down.b.play(VIDEO.id)).close())).code).toBe('backend-down');
  });
});

describe('contracts v19: stats for nerds through the bridge', () => {
  const nfxWire: NfxPlaySessionWire = {
    sid: SID as NfxPlaySessionWire['sid'],
    videoId: `38504:${'a'.repeat(64)}:nfx:testnet:1:clip` as NfxPlaySessionWire['videoId'],
    rendition: '720p',
    renditions: [{ id: '720p', bandwidth: 2_500_000 }],
    source: { kind: 'url', url: 'nf-media://play/tok0123456789abcdef' },
  };
  const STATS = { sources: [], engine: 'nfx worker: iroh' };
  const ADDRESSES = [{ kind: 'iroh', id: 'a'.repeat(64), address: '', path: 'unknown' }];

  it('a free NFX session asks session.stats and session.addresses by its sid, until closed', async () => {
    const { b, calls } = bridge({
      playNfx: nfxWire,
      'session.stats': STATS,
      'session.addresses': ADDRESSES,
    });
    const s = await b.playNfx(nfxWire.videoId);
    await expect(s.stats()).resolves.toEqual(STATS);
    await expect(s.addresses()).resolves.toEqual(ADDRESSES);
    expect(calls.slice(1)).toEqual([
      { method: 'session.stats', args: [SID] },
      { method: 'session.addresses', args: [SID] },
    ]);
    await s.close();
    expect((await codeOf(s.stats())).code).toBe('session-closed');
    expect((await codeOf(s.addresses())).code).toBe('session-closed');
    expect(
      calls.filter((c) => c.method.startsWith('session.') && c.method !== 'session.close'),
    ).toHaveLength(2);
  });

  it('a paid session asks session.addresses by its sid, until closed', async () => {
    const { b, calls } = bridge({ play: wire(), 'session.addresses': [] });
    const s = await b.play(VIDEO.id);
    await expect(s.addresses()).resolves.toEqual([]);
    expect(calls.at(-1)).toEqual({ method: 'session.addresses', args: [SID] });
    await s.close();
    expect((await codeOf(s.addresses())).code).toBe('session-closed');
  });
});

describe('studio.upload (SE-1 in the preload)', () => {
  const meta = {
    title: 'My video',
    description: '',
    tags: ['a'],
    kind: 21,
    mints: [MINTS.a],
    satsPerBlock: 2,
    split: { seeder: 50, creator: 50 },
  } as const;

  function input(file: unknown, extra: Record<string, unknown> = {}): BridgeUploadInput {
    return { ...meta, file, ...extra } as unknown as BridgeUploadInput;
  }

  it('refuses a raw path before any IPC (file-token-invalid)', async () => {
    const { b, calls, grants, subs } = bridge();
    const r = await codeOf(b.studio.upload(input('/home/u/.ssh/id_ed25519'), () => undefined));
    expect(r.code).toBe('file-token-invalid');
    expect(r.message).toMatch(/^file-token-invalid: /);
    expect([calls, grants, subs]).toEqual([[], [], []]);
  });

  it.each([
    [
      'a FileLike that is not a File',
      {
        name: 'x.mp4',
        size: 1,
        type: 'video/mp4',
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)),
      },
    ],
    ['null', null],
  ])('refuses %s (unsupported-input)', async (_n, file) => {
    const { b, grants } = bridge();
    expect((await codeOf(b.studio.upload(input(file), () => undefined))).code).toBe(
      'unsupported-input',
    );
    expect(grants).toEqual([]);
  });

  it('refuses a File with no path on disk (renderer-constructed: getPathForFile → "")', async () => {
    pathForFile = () => '';
    const { b, grants } = bridge();
    const r = await codeOf(b.studio.upload(input(new File(['x'], 'fake.mp4')), () => undefined));
    expect(r.code).toBe('unsupported-input');
    expect(grants).toEqual([]);
  });

  it('File → path → grant → token; progress subscribed (acknowledged) before the call; unsubscribed after', async () => {
    const { b, calls, grants, order, subs } = bridge({ 'studio.upload': VIDEO });
    const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
    const seen: unknown[] = [];
    const done = await b.studio.upload(
      input(file, { mirrorTo: ['https://blossom.example'] }),
      (p) => seen.push(p),
    );
    expect(done).toBe(VIDEO);
    expect(grants).toEqual(['/home/u/Videos/clip.mp4']);
    expect(order).toEqual(['grant', 'sub-acked:upload.progress', 'call:studio.upload']);
    expect(calls[0]?.args).toEqual([
      // v6: media on Pear only — a mirror list the renderer passes never reaches the wire.
      { uploadId: 'f'.repeat(32), file: `nf-file:${'e'.repeat(32)}`, ...meta },
    ]);
    expect(subs[0]?.topic).toEqual({ t: 'upload.progress', uploadId: 'f'.repeat(32) });
    expect(subs[0]?.unsubscribed).toBe(true);
    // The wire input carries no path anywhere.
    expect(JSON.stringify(calls)).not.toContain('/home/u');
  });

  it('extra keys on the renderer input never reach the wire', async () => {
    const { b, calls } = bridge({ 'studio.upload': VIDEO });
    await b.studio.upload(
      input(new File(['x'], 'c.mp4'), { path: '/etc/shadow', evil: 1 }),
      () => undefined,
    );
    expect(Object.keys(calls[0]?.args[0] as object).sort()).toEqual(
      [
        'description',
        'file',
        'kind',
        'mints',
        'satsPerBlock',
        'split',
        'tags',
        'title',
        'uploadId',
      ].sort(),
    );
  });

  it('a custom thumbnail Blob becomes {bytes, type}; a non-image or huge one is refused before the grant', async () => {
    const ok = bridge({ 'studio.upload': VIDEO });
    await ok.b.studio.upload(
      input(new File(['x'], 'c.mp4'), {
        thumbnailChoice: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      }),
      () => undefined,
    );
    expect((ok.calls[0]?.args[0] as { thumbnailChoice: unknown }).thumbnailChoice).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      type: 'image/png',
    });
    const svg = bridge();
    const r = await codeOf(
      svg.b.studio.upload(
        input(new File(['x'], 'c.mp4'), {
          thumbnailChoice: new Blob(['<svg/>'], { type: 'image/svg+xml' }),
        }),
        () => undefined,
      ),
    );
    expect(r.code).toBe('unsupported-input');
    expect(svg.grants).toEqual([]);
    const big = bridge();
    const huge = new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/jpeg' });
    expect(
      (
        await codeOf(
          big.b.studio.upload(
            input(new File(['x'], 'c.mp4'), { thumbnailChoice: huge }),
            () => undefined,
          ),
        )
      ).code,
    ).toBe('invalid-argument');
    const idx = bridge({ 'studio.upload': VIDEO });
    await idx.b.studio.upload(
      input(new File(['x'], 'c.mp4'), { thumbnailChoice: 2 }),
      () => undefined,
    );
    expect((idx.calls[0]?.args[0] as { thumbnailChoice: unknown }).thumbnailChoice).toBe(2);
  });

  it('a failed upload still unsubscribes progress', async () => {
    const { b, subs } = bridge({
      'studio.upload': fromWireError(wireError('ffmpeg-not-found', 'no ffmpeg')),
    });
    const r = await codeOf(b.studio.upload(input(new File(['x'], 'c.mp4')), () => undefined));
    expect(r.code).toBe('ffmpeg-not-found');
    expect(subs[0]?.unsubscribed).toBe(true);
  });
});

describe('preload.ts (the only electron wiring)', () => {
  it('exposes exactly one key, nutflix, through contextBridge', async () => {
    const exposed: [string, unknown][] = [];
    const ipcOn: string[] = [];
    vi.resetModules();
    vi.doMock('electron', () => ({
      contextBridge: { exposeInMainWorld: (k: string, v: unknown) => exposed.push([k, v]) },
      ipcRenderer: { invoke: () => Promise.resolve(undefined), on: (c: string) => ipcOn.push(c) },
      webUtils: { getPathForFile: () => '' },
    }));
    await import('../preload.js');
    vi.doUnmock('electron');
    expect(exposed.map(([k]) => k)).toEqual(['nutflix']);
    expect(keyTree(exposed[0]?.[1] as object)).toEqual(expectedKeyTree());
    expect(ipcOn).toEqual(['nf:event']);
  });
});
