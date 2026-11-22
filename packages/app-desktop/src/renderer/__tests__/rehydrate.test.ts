// @vitest-environment jsdom
/**
 * Design §2 "Renderer rebuild" (+ §0.8, risk 5): what the screens get from `window.nutflix`.
 *
 *   1. `rebuildError`: the code comes back from the message prefix (`.code` set, prefix kept),
 *      so the REAL screen classifiers read these errors correctly;
 *   2. the full chain — renderer adapter → an EMULATED `contextBridge` (copies data, proxies
 *      functions, drops Error custom properties, refuses Maps) → the real preload bridge and
 *      transport → main's real IPC gate → `FakeHost` (MockNetworkAdapter): Maps, sessions,
 *      callbacks, errors and the SE-1 upload all arrive as the screens expect. The emulation
 *      encodes the assumptions the day-1 fidelity spike (e2e/fidelity.e2e.ts) checks for real.
 *   3. the renderer's expected key tree equals the preload's allowlist.
 */
import { describe, expect, it } from 'vitest';
import { mocks } from '@sovit/core';
import type { NetworkAdapter } from '@sovit/core';
import { EXCLUDED_METHODS, METHODS, TOPIC_METHODS } from '../../ipc/index.js';
import { adapterFromBridge, rebuildError, sessionFromBridge } from '../adapter/rehydrate.js';
import type { BridgeNfxPlaySession, BridgePlaySession, NutflixBridge } from '../bridge-types.js';

const { VIDEOS, MINTS } = mocks;
const VIDEO = VIDEOS[0]!;

describe('rebuildError', () => {
  it.each([
    ['no-seeders: nobody is seeding', 'no-seeders'],
    ['no-balance: no balance at https://mint', 'no-balance'],
    ['relay-down: no relays reachable', 'relay-down'],
    ['ffmpeg-not-found: spawn ffmpeg ENOENT', 'ffmpeg-not-found'],
    ["Error invoking remote method 'nf:call': Error: no-signer: sign in", 'no-signer'],
  ])('%s → .code %s with the prefix kept', (message, code) => {
    const e = rebuildError(new Error(message));
    expect(e.code).toBe(code);
    expect(e.message.startsWith(`${code}: `)).toBe(true);
  });

  it('anything unrecognised is internal with a constant message', () => {
    for (const x of [new Error('boom'), 'made-up: x', null, 42, { message: 7 }]) {
      const e = rebuildError(x);
      expect(e.code).toBe('internal');
      expect(e.message).toBe('internal: internal error');
    }
  });

  it('the real screen classifiers read the rebuilt errors', async () => {
    // Not in @sovit/ui's root barrel: loaded from the ui source, like L6-0's errors.test.ts.
    // `base` is a variable on purpose: Vite rewrites `new URL(\`…${x}\`, import.meta.url)` in
    // web (jsdom) transform mode.
    const base = import.meta.url;
    const ui = async <T>(rel: string): Promise<T> =>
      (await import(
        /* @vite-ignore */ new URL(`../../../../ui/src/screens/${rel}`, base).href
      )) as T;
    const { classifyStudioError } = await ui<{ classifyStudioError: (e: unknown) => string }>(
      'Studio/model.ts',
    );
    const { shortsPlayErrorKind } = await ui<{ shortsPlayErrorKind: (e: unknown) => string }>(
      'Shorts/Shorts.tsx',
    );
    const { playErrorKind } = await ui<{ playErrorKind: (e: unknown) => string }>('Watch/model.ts');
    expect(classifyStudioError(rebuildError(new Error('ffmpeg-not-found: x')))).toBe(
      'ffmpeg-not-found',
    );
    expect(
      classifyStudioError(rebuildError(new Error('unsupported-input: not a regular file'))),
    ).toBe('unsupported-input');
    expect(shortsPlayErrorKind(rebuildError(new Error('no-balance: none')))).toBe('no-balance');
    expect(playErrorKind(rebuildError(new Error('no-seeders: x')))).toBe('no-seeders');
  });
});

// ---- contextBridge emulation ------------------------------------------------------------------

/**
 * What `contextBridge` is assumed to do (Electron docs; verified by the fidelity spike): plain
 * data is copied, functions become proxies (in both directions, at any depth), Promises are
 * bridged, a rejected Error arrives as a NEW Error with the message only, `File`/`Blob` pass as
 * themselves. A `Map` must never be sent (the wire uses `$map`), so the emulation refuses one.
 */
function emulateContextBridge<T>(api: T): T {
  const errOf = (e: unknown): Error => new Error(e instanceof Error ? e.message : String(e));
  const copy = (v: unknown, depth = 0): unknown => {
    if (depth > 64) throw new Error('too deep');
    if (typeof v === 'function') return wrap(v as (...a: unknown[]) => unknown);
    if (v instanceof Map || v instanceof Set)
      throw new Error('contextBridge fidelity: a Map/Set crossed the bridge');
    if (v instanceof Blob || v instanceof Uint8Array) return v;
    if (v instanceof Error) return errOf(v);
    if (Array.isArray(v)) return v.map((x) => copy(x, depth + 1));
    if (typeof v === 'object' && v !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = copy(x, depth + 1);
      return out;
    }
    return v;
  };
  const wrap =
    (f: (...a: unknown[]) => unknown) =>
    (...args: unknown[]): unknown => {
      let r: unknown;
      try {
        r = f(...args.map((a) => copy(a)));
      } catch (e: unknown) {
        throw errOf(e);
      }
      if (r instanceof Promise) {
        return r.then(
          (x: unknown) => copy(x),
          (e: unknown) => {
            throw errOf(e);
          },
        );
      }
      return copy(r);
    };
  return copy(api) as T;
}

// ---- the full chain ----------------------------------------------------------------------------

interface Chain {
  adapter: NetworkAdapter;
  host: {
    settled(): Promise<void>;
    tick(): void;
    openSessions(wc?: number): unknown[];
    lastUpload: { path: string } | undefined;
    rejected: unknown[];
  };
  files: Map<string, unknown>;
  stat(kind: string): unknown;
}

async function chain(
  opts: Record<string, unknown> = {},
  pathForFile = (): string => '',
): Promise<Chain> {
  // Main and preload are other TypeScript projects: loaded at runtime, typed structurally.
  const harnessPath = '../../main/__tests__/harness.js';
  const bridgePath = '../../preload/bridge.js';
  const transportPath = '../../preload/transport.js';
  const hm = (await import(/* @vite-ignore */ harnessPath)) as {
    createHarness(o: Record<string, unknown>): {
      gate: Record<'call' | 'sub' | 'grant', (e: unknown, raw: unknown) => Promise<unknown>>;
      host: Chain['host'];
      wc: { send(channel: string, msg: unknown): void };
      files: Map<string, unknown>;
      ev(): unknown;
    };
    fileStat(kind: string, size?: number): unknown;
  };
  const bm = (await import(/* @vite-ignore */ bridgePath)) as {
    createBridge(
      t: unknown,
      deps: { pathForFile(f: File): string; randomHex(n: number): string },
    ): NutflixBridge;
  };
  const tm = (await import(/* @vite-ignore */ transportPath)) as {
    createTransport(ipc: {
      invoke(c: string, m: unknown): Promise<unknown>;
      on(c: string, l: (e: unknown, m: unknown) => void): void;
    }): unknown;
  };
  const h = hm.createHarness(opts);
  const listeners: ((e: unknown, m: unknown) => void)[] = [];
  const send = h.wc.send.bind(h.wc);
  h.wc.send = (c, m) => {
    send(c, m);
    for (const l of listeners) l({}, structuredClone(m));
  };
  const ipc = {
    async invoke(channel: string, msg: unknown): Promise<unknown> {
      const key = channel === 'nf:call' ? 'call' : channel === 'nf:sub' ? 'sub' : 'grant';
      return structuredClone(await h.gate[key](h.ev(), structuredClone(msg)));
    },
    on(_c: string, l: (e: unknown, m: unknown) => void): void {
      listeners.push(l);
    },
  };
  let n = 0;
  const bridge = bm.createBridge(tm.createTransport(ipc), {
    pathForFile,
    randomHex: (k) => {
      n += 1;
      return n.toString(16).padStart(k * 2, '0');
    },
  });
  return {
    adapter: adapterFromBridge(emulateContextBridge(bridge)),
    host: h.host,
    files: h.files,
    stat: (k) => hm.fileStat(k, 4096),
  };
}

async function codeOf(
  p: Promise<unknown>,
): Promise<{ code: unknown; message: string; name: string }> {
  try {
    await p;
  } catch (e: unknown) {
    const err = e as Error & { code?: unknown };
    return { code: err.code, message: err.message, name: err.name };
  }
  throw new Error('expected a rejection');
}

describe('renderer adapter over the whole chain', () => {
  it('Maps are Maps again (wallet.balances, seeder earned.byMint, analytics)', async () => {
    const c = await chain();
    const balances = await c.adapter.wallet.balances();
    expect(balances).toBeInstanceOf(Map);
    expect(balances.get(MINTS.a)).toBe(2100);
    const status = await c.adapter.seeder.status();
    expect(status.earned.byMint).toBeInstanceOf(Map);
    const a = await c.adapter.studio.analytics(VIDEO.id);
    expect(a.satsByRendition).toBeInstanceOf(Map);
    expect(c.host.rejected).toEqual([]);
  });

  it('seeder.onStatus payloads are rehydrated too', async () => {
    const c = await chain();
    const got: unknown[] = [];
    c.adapter.seeder.onStatus((s) => got.push(s.earned.byMint));
    await c.host.settled();
    await c.adapter.seeder.setEnabled(false);
    await c.host.settled();
    expect(got).toHaveLength(1);
    expect(got[0]).toBeInstanceOf(Map);
  });

  it('errors arrive with .code and the prefix despite contextBridge dropping properties', async () => {
    const c = await chain({ mock: { failWith: 'no-seeders' } });
    const r = await codeOf(c.adapter.play(VIDEO.id));
    expect(r).toMatchObject({ code: 'no-seeders', name: 'IpcError' });
    expect(r.message).toMatch(/^no-seeders: /);
    const forbidden = await codeOf(
      c.adapter.wallet.send(1 as never, { p2pk: '02' as never, mint: MINTS.a }),
    );
    expect(forbidden.code).toBe('forbidden');
  });

  it('a PlaySession works through proxies: spend events, pause, switch, close', async () => {
    const c = await chain();
    const s = await c.adapter.play(VIDEO.id);
    expect(s.source).toMatchObject({ kind: 'url' });
    expect(s.source.kind === 'url' ? s.source.url : '').toMatch(/^nf-media:\/\/play\//);
    const spend: number[] = [];
    s.onSpend((x) => spend.push(x.ratePerMin));
    await c.host.settled();
    c.host.tick();
    await c.host.settled();
    expect(spend.length).toBe(1);
    const next = await s.switchRendition(VIDEO.renditions[1]!.label);
    expect(next.rendition).toBe(VIDEO.renditions[1]!.label);
    await s.close();
    await next.close();
    await c.host.settled();
    expect(c.host.openSessions()).toHaveLength(0);
  });

  it('SE-1: a DOM File uploads by token; a string path is refused before IPC', async () => {
    const c = await chain({}, () => '/home/u/Videos/clip.mp4');
    c.files.set('/home/u/Videos/clip.mp4', c.stat('file'));
    const meta = {
      title: 'Mine',
      description: '',
      tags: [],
      kind: 21 as const,
      mints: [MINTS.a],
      satsPerBlock: 2 as never,
      split: { seeder: 50, creator: 50 },
    };
    const stages: string[] = [];
    const v = await c.adapter.studio.upload({ ...meta, file: new File(['x'], 'clip.mp4') }, (p) =>
      stages.push(p.stage),
    );
    expect(v.title).toBe('Mine');
    expect(c.host.lastUpload?.path).toBe('/home/u/Videos/clip.mp4');
    expect(stages.at(-1)).toBe('done');
    const raw = await codeOf(
      c.adapter.studio.upload({ ...meta, file: '/etc/passwd' }, () => undefined),
    );
    expect(raw.code).toBe('file-token-invalid');
  });
});

describe('contracts v19: stats for nerds reach the screens', () => {
  const STATS = { sources: [], engine: 'nfx worker: HyperDHT' };
  const ADDRESSES = [{ kind: 'hypercore', id: 'c'.repeat(64), address: '', path: 'unknown' }];

  it('a free NFX session forwards stats and addresses, errors rebuilt', async () => {
    const nfxSession: BridgeNfxPlaySession = {
      videoId: mocks.NFX_VIDEOS[0]!.id,
      rendition: '720p',
      renditions: [],
      source: { kind: 'url', url: 'nf-media://play/tok' },
      stats: () => Promise.resolve(STATS),
      addresses: () => Promise.reject(new Error('session-closed: gone')),
      close: () => Promise.resolve(),
    };
    const b = { playNfx: () => Promise.resolve(nfxSession) } as unknown as NutflixBridge;
    const s = await adapterFromBridge(b).playNfx(mocks.NFX_VIDEOS[0]!.id);
    await expect(s.stats?.()).resolves.toEqual(STATS);
    expect(await codeOf(s.addresses?.() ?? Promise.resolve())).toMatchObject({
      code: 'session-closed',
      name: 'IpcError',
    });
  });

  it('a paid session forwards addresses', async () => {
    const paid = {
      videoId: VIDEO.id,
      rendition: '720p',
      source: { kind: 'url', url: 'nf-media://play/tok' },
      policy: VIDEO.price,
      addresses: () => Promise.resolve(ADDRESSES),
    } as unknown as BridgePlaySession;
    await expect(sessionFromBridge(paid).addresses?.()).resolves.toEqual(ADDRESSES);
  });
});

describe('the renderer side of the key tree', () => {
  it('adapterFromBridge maps every bridged member (same allowlist as the preload test)', () => {
    const touched = new Set<string>();
    const fake = (path: string): unknown =>
      new Proxy(() => undefined, {
        get: (_t, k) =>
          typeof k === 'string' ? fake(path === '' ? k : `${path}.${k}`) : undefined,
        apply: () => {
          touched.add(path);
          return Promise.resolve(undefined);
        },
      });
    const a = adapterFromBridge(fake('') as NutflixBridge);
    const call = (f: unknown): void => {
      // The fake resolves `undefined` everywhere; only which bridge member was reached matters.
      (f as () => Promise<unknown>)().catch(() => undefined);
    };
    for (const [k, v] of Object.entries(a as unknown as Record<string, unknown>)) {
      if (typeof v === 'function') call(v);
      else if (typeof v === 'object' && v !== null)
        for (const w of Object.values(v as Record<string, unknown>)) call(w);
      else expect(k).toBe('platform');
    }
    const expected = new Set<string>();
    for (const m of METHODS)
      if (!m.startsWith('session.') && !m.startsWith('desktop.')) expected.add(m);
    for (const m of Object.keys(EXCLUDED_METHODS)) expected.add(m);
    for (const m of Object.keys(TOPIC_METHODS)) expected.add(m);
    expect([...touched].sort()).toEqual([...expected].sort());
  });
});
