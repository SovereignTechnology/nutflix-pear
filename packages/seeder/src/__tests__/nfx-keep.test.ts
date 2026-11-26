/**
 * Keeping a rendition (`nfx-keep/job.ts`) and the hourly budget (`nfx-keep/budget.ts`):
 * held files first, then the fetcher; only fetched bytes are spent; a stop leaves the rendition
 * filling, and the next run fetches only what is still missing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { KeepBudget } from '../nfx-keep/budget.js';
import { keepRendition } from '../nfx-keep/job.js';
import type { KeepJobInput } from '../nfx-keep/job.js';
import { NfxStore } from '../nfx-store/store.js';
import type { NfxStoredFile } from '../nfx-store/store.js';
import { adapters, tmpDir } from './helpers.js';
import type { Pkg } from './nfx-keep-fixtures.js';
import { pkg } from './nfx-keep-fixtures.js';

const dirs: { rm(): Promise<void> }[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await d.rm();
});

async function dir(): Promise<string> {
  const d = await tmpDir('nf-nfx-keep-job-');
  dirs.push(d);
  return d.dir;
}

async function openStore(d: string): Promise<NfxStore> {
  const store = new NfxStore({ fs: adapters.fs, crypto: adapters.crypto, dataDir: d });
  await store.load();
  return store;
}

function input(store: NfxStore, p: Pkg, over: Partial<KeepJobInput> = {}): KeepJobInput {
  return {
    store,
    video: p.video,
    root: p.root,
    segs: p.segs,
    hashListBytes: p.hashListBytes,
    rendition: '720p',
    playlistBytes: p.r['720p']!.playlist,
    reason: 'watched',
    fetch: (f: NfxStoredFile) => Promise.resolve(p.files.get(f.sha256)!),
    signal: new AbortController().signal,
    maxFileBytes: 1024 * 1024,
    ...over,
  };
}

describe('keepRendition', () => {
  it('takes held files first, fetches the rest, and holds the rendition', async () => {
    const store = await openStore(await dir());
    const p = pkg('job-a', 3);
    const r720 = p.r['720p']!;
    const held = new Set([r720.init, r720.segments[0]!]);
    const fetched: string[] = [];
    const spent: number[] = [];
    const progress: { done: number; total: number }[] = [];
    const res = await keepRendition(
      input(store, p, {
        held: (s) => Promise.resolve(held.has(s) ? p.files.get(s)! : null),
        fetch: (f) => {
          fetched.push(f.sha256);
          return Promise.resolve(p.files.get(f.sha256)!);
        },
        spend: (b) => {
          spent.push(b);
          return true;
        },
        onProgress: ({ done, total }) => progress.push({ done, total }),
      }),
    );
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ state: 'held' });
    for (const s of held) expect(fetched).not.toContain(s);
    let bytes = 0;
    for (const s of fetched) bytes += p.files.get(s)!.byteLength;
    expect(res.fetchedBytes).toBe(bytes);
    expect(spent.reduce((a, b) => a + b, 0)).toBe(bytes);
    const total = new Set([...p.meta, r720.init, ...r720.segments]).size;
    expect(progress.at(-1)).toEqual({ done: total, total });
    expect(store.servedRenditions(p.video)).toEqual(['720p']);
    // Again: already held, nothing fetched.
    const again = await keepRendition(
      input(store, p, { fetch: () => Promise.reject(new Error('no fetch expected')) }),
    );
    expect(again).toEqual({ ok: true, state: 'held', fetchedBytes: 0 });
  });

  it('fetches a mismatched spool file and stops before completing if the final write aborts', async () => {
    const store = await openStore(await dir());
    const p = pkg('job-stale-spool');
    const segment = p.r['720p']!.segments[0]!;
    const fetched: string[] = [];
    const ac = new AbortController();
    const result = await keepRendition(
      input(store, p, {
        signal: ac.signal,
        held: (sha) => Promise.resolve(sha === segment ? new Uint8Array(1) : p.files.get(sha)!),
        fetch: (file) => {
          fetched.push(file.sha256);
          return Promise.resolve(p.files.get(file.sha256)!);
        },
        onProgress: ({ done, total }) => {
          if (done === total) ac.abort();
        },
      }),
    );
    expect(fetched).toEqual([segment]);
    expect(result).toMatchObject({ state: 'stopped', why: 'aborted' });
    expect(store.hasVideo(p.video)).toBe(false);
    expect(store.keepMissing(p.video)).toEqual([]);
  });

  it('does not spend or fetch when aborted during the held lookup', async () => {
    const store = await openStore(await dir());
    const p = pkg('job-lookup-abort');
    const spend = vi.fn(() => true);
    const fetch = vi.fn(() => Promise.resolve(new Uint8Array()));
    const ac = new AbortController();
    const result = await keepRendition(
      input(store, p, {
        signal: ac.signal,
        held: async () => {
          await Promise.resolve();
          ac.abort();
          return null;
        },
        spend,
        fetch,
      }),
    );
    expect(result).toMatchObject({ state: 'stopped', why: 'aborted', fetchedBytes: 0 });
    expect(spend).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stops when asked, leaves the rendition filling, and a later run fetches only the rest', async () => {
    const d = await dir();
    const store = await openStore(d);
    const p = pkg('job-b', 4);
    const ac = new AbortController();
    let n = 0;
    const first = await keepRendition(
      input(store, p, {
        signal: ac.signal,
        fetch: (f) => {
          n += 1;
          if (n === 3) ac.abort();
          return Promise.resolve(p.files.get(f.sha256)!);
        },
      }),
    );
    expect(first).toMatchObject({ ok: false, state: 'stopped', why: 'aborted' });
    const left = store.keepMissing(p.video).length;
    expect(left).toBeGreaterThan(0);

    // After a restart.
    const again = await openStore(d);
    let fetchedAgain = 0;
    const second = await keepRendition(
      input(again, p, {
        fetch: (f) => {
          fetchedAgain += 1;
          return Promise.resolve(p.files.get(f.sha256)!);
        },
      }),
    );
    expect(second).toMatchObject({ ok: true, state: 'held' });
    expect(fetchedAgain).toBe(left);
  });

  it('stops on the budget before fetching, and fails on a fetch error or a file too large', async () => {
    const store = await openStore(await dir());
    const p = pkg('job-c');
    expect(await keepRendition(input(store, p, { spend: () => false }))).toMatchObject({
      ok: false,
      state: 'stopped',
      why: 'budget',
      fetchedBytes: 0,
    });
    expect(
      await keepRendition(input(store, p, { fetch: () => Promise.reject(new Error('gone')) })),
    ).toMatchObject({ ok: false, state: 'failed', error: 'fetch', message: 'gone' });
    expect(await keepRendition(input(store, p, { maxFileBytes: 10 }))).toMatchObject({
      ok: false,
      state: 'failed',
      error: 'too-large',
    });
    // A fetcher that returns other bytes is refused by the store.
    expect(
      await keepRendition(input(store, p, { fetch: () => Promise.resolve(new Uint8Array(3)) })),
    ).toMatchObject({ ok: false, state: 'failed', error: 'mismatch' });
  });
});

describe('KeepBudget', () => {
  it('allows so many new videos and so many bytes an hour, and frees them as the hour moves', async () => {
    let t = 10_000_000;
    const b = new KeepBudget({
      fs: adapters.fs,
      crypto: adapters.crypto,
      dir: await dir(),
      startsPerHour: 2,
      bytesPerHour: 1000,
      now: () => t,
    });
    await b.load();
    expect(await b.start()).toBe(true);
    expect(await b.start()).toBe(true);
    expect(b.canStart()).toBe(false);
    expect(await b.start()).toBe(false);
    expect(await b.spend(600)).toBe(true);
    expect(await b.spend(500)).toBe(false);
    expect(await b.spend(400)).toBe(true);
    expect(b.usedBytes()).toBe(1000);
    expect(await b.spend(-1)).toBe(false);
    expect(await b.spend(0.5)).toBe(false);
    t += 3_600_000 + 60_000;
    expect(b.usedBytes()).toBe(0);
    expect(b.canStart()).toBe(true);
  });

  it('rejects a charge when saving fails and can flush the current budget afterward', async () => {
    const d = await dir();
    let fail = true;
    const budget = new KeepBudget({
      fs: {
        ...adapters.fs,
        rename: (from, to) =>
          fail ? Promise.reject(new Error('budget write failed')) : adapters.fs.rename(from, to),
      },
      crypto: adapters.crypto,
      dir: d,
    });
    await budget.load();
    await expect(budget.spend(100)).rejects.toThrow('budget write failed');
    fail = false;
    await budget.flush();
    const reopened = new KeepBudget({ ...adapters, dir: d });
    await reopened.load();
    expect(reopened.usedBytes()).toBe(100);
  });

  it('survives a restart, and a clock set back does not stretch the hour', async () => {
    let t = 50_000_000;
    const d = await dir();
    const make = (): KeepBudget =>
      new KeepBudget({
        fs: adapters.fs,
        crypto: adapters.crypto,
        dir: d,
        startsPerHour: 1,
        bytesPerHour: 1000,
        now: () => t,
      });
    const b = make();
    await b.load();
    expect(await b.start()).toBe(true);
    expect(await b.spend(900)).toBe(true);
    const again = make();
    await again.load();
    expect(again.canStart()).toBe(false);
    expect(again.usedBytes()).toBe(900);
    // Set back an hour: what was recorded "later" than now is dropped, not kept for two hours.
    t -= 3_600_000;
    const back = make();
    await back.load();
    expect(back.usedBytes()).toBe(0);
    expect(back.canStart()).toBe(true);
  });
});
