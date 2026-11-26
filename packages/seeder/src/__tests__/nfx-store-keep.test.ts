/**
 * Kept videos in the NFX store (NFX-18, ADR 0026): renditions held one at a time, named and
 * counted before a byte is written, checked file by file, resumed after a crash, served only
 * once held, never taken for a whole video by a build that reads only `videos.json`, and
 * removed with their last reason or by eviction (watched-only, least recently used first).
 */
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SeederFs } from '../adapters/fs.js';
import { NfxStore } from '../nfx-store/store.js';
import { DiskCap } from '../store/disk-cap.js';
import { adapters, tmpDir } from './helpers.js';
import type { Pkg } from './nfx-keep-fixtures.js';
import { addr, pkg, sha } from './nfx-keep-fixtures.js';

const dirs: { rm(): Promise<void> }[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await d.rm();
});

async function open(
  capBytes = 10 * 1024 * 1024,
  dir?: string,
  now?: () => number,
  fs: SeederFs = adapters.fs,
) {
  let d = dir;
  if (d === undefined) {
    const t = await tmpDir('nf-nfx-keep-');
    dirs.push(t);
    d = t.dir;
  }
  const store = new NfxStore({
    fs,
    crypto: adapters.crypto,
    dataDir: d,
    ...(now === undefined ? {} : { now }),
  });
  await store.load();
  const cap = new DiskCap(capBytes, store.totalBytes());
  store.attachCap(cap);
  return { store, cap, dir: d };
}

function begin(
  store: NfxStore,
  p: Pkg,
  rendition = '720p',
  reason: 'watched' | 'downloaded' = 'watched',
) {
  return store.beginKeep({
    video: p.video,
    root: p.root,
    segs: p.segs,
    hashListBytes: p.hashListBytes,
    rendition,
    playlistBytes: p.r[rendition]?.playlist ?? new Uint8Array(),
    reason,
  });
}

async function startFill(
  store: NfxStore,
  p: Pkg,
  rendition = '720p',
  reason: 'watched' | 'downloaded' = 'watched',
) {
  const result = await begin(store, p, rendition, reason);
  if (!result.ok || result.state !== 'filling') throw new Error('expected a filling rendition');
  return result;
}

async function fill(store: NfxStore, p: Pkg, fillId: symbol): Promise<void> {
  for (const { sha256: s } of store.keepMissing(p.video)) {
    const res = await store.putKeptFile(p.video, fillId, s, p.files.get(s) ?? new Uint8Array());
    expect(res.ok).toBe(true);
  }
}

async function keep(
  store: NfxStore,
  p: Pkg,
  rendition = '720p',
  reason: 'watched' | 'downloaded' = 'watched',
) {
  const { fillId } = await startFill(store, p, rendition, reason);
  await fill(store, p, fillId);
  const done = await store.completeKeep(p.video, fillId);
  expect(done).toMatchObject({ ok: true, state: 'held' });
}

async function onDisk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const sub of ['files', 'tmp']) {
    const entries = await readdir(path.join(dir, 'nfx', sub), {
      recursive: true,
      withFileTypes: true,
    });
    for (const e of entries) if (e.isFile()) out.push(e.name);
  }
  return out.sort();
}

const filePath = (dir: string, s: string): string =>
  path.join(dir, 'nfx', 'files', s.slice(0, 2), s);

describe('NfxStore kept videos', () => {
  it('holds one rendition of two and serves only it, once every file is on disk', async () => {
    const { store, dir } = await open();
    const p = pkg('a');
    const started = await startFill(store, p);
    const { fillId } = started;
    // The hash list and the playlist it was given are written at once; the rest is missing.
    const r720 = p.r['720p']!;
    expect(new Set(started.missing.map((f) => f.sha256))).toEqual(
      new Set(
        [...p.meta, r720.init, ...r720.segments].filter(
          (s) => s !== p.root && s !== sha(r720.playlist),
        ),
      ),
    );
    // Not served while filling.
    expect(store.hasVideo(p.video)).toBe(false);
    expect(store.file(p.video, p.root)).toBeUndefined();
    await fill(store, p, fillId);
    expect(await store.completeKeep(p.video, fillId)).toEqual({
      ok: true,
      state: 'held',
      missing: [],
    });

    expect(store.hasVideo(p.video)).toBe(true);
    expect(store.servedRenditions(p.video)).toEqual(['720p']);
    const seg = r720.segments[0]!;
    const f = store.file(p.video, seg);
    expect(f?.size).toBe(p.files.get(seg)!.byteLength);
    expect(await f!.read(0, f!.size)).toEqual(p.files.get(seg));
    expect(store.path(p.video, seg)).toBe(filePath(dir, seg));
    for (const m of p.meta) expect(store.file(p.video, m)).toBeDefined();
    const r360 = p.r['360p']!;
    expect(store.file(p.video, r360.segments[0]!)).toBeUndefined();
    expect(store.path(p.video, r360.init)).toBeUndefined();
    // Never in the whole list, on disk or in memory: an older build reads only that.
    expect(store.videos()).toEqual([]);
    const videos = JSON.parse(
      await readFile(path.join(dir, 'nfx', 'videos.json'), 'utf8').catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '{"videos":[]}';
        throw err;
      }),
    ) as { videos: unknown[] };
    expect(videos.videos).toEqual([]);
    const kept = JSON.parse(await readFile(path.join(dir, 'nfx', 'kept.json'), 'utf8')) as {
      videos: { video: string }[];
    };
    expect(kept.videos.map((v) => v.video)).toEqual([p.video.toString()]);
  });

  it('refuses a rendition it does not have, a playlist that is not the listed one, and a hash list that is not the root', async () => {
    const { store, dir } = await open();
    const p = pkg('b');
    expect(await begin(store, p, '1080p')).toMatchObject({ ok: false, error: 'rendition' });
    expect(
      await store.beginKeep({
        video: p.video,
        root: p.root,
        segs: p.segs,
        hashListBytes: p.hashListBytes,
        rendition: '720p',
        playlistBytes: p.r['360p']!.playlist,
        reason: 'watched',
      }),
    ).toMatchObject({ ok: false, error: 'rendition' });
    expect(
      await store.beginKeep({
        video: p.video,
        root: '00'.repeat(32),
        segs: p.segs,
        hashListBytes: p.hashListBytes,
        rendition: '720p',
        playlistBytes: p.r['720p']!.playlist,
        reason: 'watched',
      }),
    ).toMatchObject({ ok: false, error: 'invalid' });
    expect(store.keptVideos()).toEqual([]);
    expect(await onDisk(dir)).toEqual([]);
  });

  it('checks every file against its entry and takes only what the rendition needs', async () => {
    const { store } = await open();
    const p = pkg('c');
    const { fillId } = await startFill(store, p);
    const seg = p.r['720p']!.segments[0]!;
    expect(
      await store.putKeptFile(p.video, fillId, seg, new Uint8Array(100).fill(9)),
    ).toMatchObject({
      ok: false,
      error: 'mismatch',
    });
    const other = p.r['360p']!.segments[0]!;
    expect(await store.putKeptFile(p.video, fillId, other, p.files.get(other)!)).toMatchObject({
      ok: false,
      error: 'unwanted',
    });
    expect(await store.putKeptFile(addr('nope'), fillId, seg, p.files.get(seg)!)).toMatchObject({
      ok: false,
      error: 'unknown',
    });
    const before = store.keepMissing(p.video).length;
    expect(await store.putKeptFile(p.video, fillId, seg, p.files.get(seg)!)).toEqual({
      ok: true,
      remaining: before - 1,
    });
    // Not complete until everything is there.
    expect(await store.completeKeep(p.video, fillId)).toMatchObject({ ok: true, state: 'filling' });
  });

  it('resumes a filling rendition after a restart and leaves nothing on disk that no record names', async () => {
    const { store, dir } = await open();
    const p = pkg('d', 3);
    const { fillId } = await startFill(store, p);
    const [first, second] = store.keepMissing(p.video).map((f) => f.sha256);
    await store.putKeptFile(p.video, fillId, first!, p.files.get(first!)!);
    // A write a crash cut short.
    await writeFile(path.join(dir, 'nfx', 'tmp', `${second!}.part`), new Uint8Array(3));

    const stray = `${'ff'.repeat(32)}.part`;
    const alreadyPresent = `${first!}.part`;
    for (const part of [stray, alreadyPresent])
      await writeFile(path.join(dir, 'nfx', 'tmp', part), new Uint8Array(3));
    const again = await open(10 * 1024 * 1024, dir);
    const missing = again.store.keepMissing(p.video).map((f) => f.sha256);
    expect(missing).not.toContain(first);
    expect(missing).toContain(second);
    const files = await onDisk(dir);
    for (const part of [`${second!}.part`, stray, alreadyPresent])
      expect(files).not.toContain(part);
    const resumed = await startFill(again.store, p);
    await fill(again.store, p, resumed.fillId);
    expect(await again.store.completeKeep(p.video, resumed.fillId)).toMatchObject({
      ok: true,
      state: 'held',
    });
    expect(again.store.servedRenditions(p.video)).toEqual(['720p']);
  });

  it('grows by a rendition and keeps serving the one it holds meanwhile; one fills at a time', async () => {
    const { store } = await open();
    const p = pkg('e');
    await keep(store, p, '720p');
    const { fillId } = await startFill(store, p, '360p');
    expect(store.servedRenditions(p.video)).toEqual(['720p']);
    // Already filling 360p: asking again adds nothing; 720p is held.
    expect(await begin(store, p, '360p', 'downloaded')).toMatchObject({
      ok: true,
      state: 'filling',
    });
    expect(await begin(store, p, '720p')).toMatchObject({ ok: true, state: 'held' });
    await fill(store, p, fillId);
    await store.completeKeep(p.video, fillId);
    expect(store.servedRenditions(p.video)).toEqual(['360p', '720p']);
    expect(store.keptOf(p.video)?.reasons).toHaveProperty('downloaded');

    const q = pkg('f');
    await begin(store, q, '720p');
    expect(await begin(store, q, '360p')).toMatchObject({ ok: false, error: 'busy' });
  });

  it('counts the whole rendition against the cap before writing, and frees it when abandoned', async () => {
    const p = pkg('g');
    const { store, cap, dir } = await open(200);
    expect(await begin(store, p)).toMatchObject({ ok: false, error: 'disk-cap' });
    expect(store.keptVideos()).toEqual([]);
    expect(await onDisk(dir)).toEqual([]);

    const big = await open();
    const started = await begin(big.store, p);
    expect(started.ok).toBe(true);
    const need = big.store.totalBytes();
    expect(big.cap.usedBytes).toBe(need);
    expect(await big.store.abandonKeep(p.video)).toBe(true);
    expect(big.cap.usedBytes).toBe(0);
    expect(big.store.keptVideos()).toEqual([]);
    expect(await onDisk(big.dir)).toEqual([]);
    expect(cap.usedBytes).toBe(0);
  });

  it('retains a fill on commit failure and retries committed cleanup on reopen', async () => {
    const { dir } = await open();
    const p = pkg('abandon-retry');
    const root = filePath(dir, p.root);
    let failCommit = false;
    let failUnlink = false;
    const { store } = await open(undefined, dir, undefined, {
      ...adapters.fs,
      rename: (from, to) =>
        failCommit && to.endsWith('kept.json')
          ? Promise.reject(new Error('cannot commit'))
          : adapters.fs.rename(from, to),
      unlink: (file) =>
        failUnlink && file === root
          ? Promise.reject(new Error('cannot unlink'))
          : adapters.fs.unlink(file),
    });
    const { fillId } = await startFill(store, p);
    failCommit = true;
    await expect(store.abandonKeep(p.video)).rejects.toThrow('cannot commit');
    expect(await store.completeKeep(p.video, fillId)).toMatchObject({ state: 'filling' });
    expect(await onDisk(dir)).toContain(p.root);

    failCommit = false;
    failUnlink = true;
    expect(await store.abandonKeep(p.video)).toBe(true);
    expect(await onDisk(dir)).toContain(p.root);
    const again = await open(undefined, dir);
    expect(again.store.keptOf(p.video)).toBeUndefined();
    expect(await onDisk(dir)).not.toContain(p.root);
  });

  it('keeps a cleanup file it could not delete charged to the cap, across a reopen', async () => {
    const p = pkg('abandon-charge');
    const { dir } = await open();
    const root = filePath(dir, p.root);
    let failUnlink = true;
    const fs: SeederFs = {
      ...adapters.fs,
      unlink: (file) =>
        failUnlink && file === root
          ? Promise.reject(new Error('cannot unlink'))
          : adapters.fs.unlink(file),
    };
    const { store, cap } = await open(undefined, dir, undefined, fs);
    await startFill(store, p);
    expect(await store.abandonKeep(p.video)).toBe(true);
    // Every other file is gone and freed; the hash list stays on disk, and stays charged.
    expect(await onDisk(dir)).toEqual([p.root]);
    const left = p.hashListBytes.byteLength;
    expect(cap.usedBytes).toBe(left);
    expect(store.totalBytes()).toBe(left);

    const stuck = await open(undefined, dir, undefined, fs);
    expect(stuck.cap.usedBytes).toBe(left);
    failUnlink = false;
    await stuck.store.flushKept();
    expect(await onDisk(dir)).toEqual([]);
    expect(stuck.cap.usedBytes).toBe(0);
    expect(stuck.store.totalBytes()).toBe(0);
  });

  it('rejects late writes and completion from an abandoned fill', async () => {
    const { store } = await open();
    const p = pkg('replacement-fill');
    const old = await startFill(store, p);
    await store.abandonKeep(p.video);
    const next = await startFill(store, p);
    const file = next.missing[0]!;
    expect(
      await store.putKeptFile(p.video, old.fillId, file.sha256, p.files.get(file.sha256)!),
    ).toMatchObject({ ok: false, error: 'unknown' });
    expect(store.keepMissing(p.video)).toContainEqual(file);
    await fill(store, p, next.fillId);
    expect(await store.completeKeep(p.video, old.fillId)).toMatchObject({
      ok: false,
      error: 'unknown',
    });
    expect(await store.completeKeep(p.video, next.fillId)).toMatchObject({ state: 'held' });
  });

  it('flushes a touch that occurred during a pending kept save', async () => {
    let now = 10;
    let duringSave: (() => void) | undefined;
    const { store, dir } = await open(undefined, undefined, () => now, {
      ...adapters.fs,
      rename: (from, to) => {
        if (to.endsWith('kept.json')) duringSave?.();
        return adapters.fs.rename(from, to);
      },
    });
    const p = pkg('touch-during-save');
    await keep(store, p);
    duringSave = () => {
      now = 20;
      store.touchKept(p.video);
      duringSave = undefined;
    };
    await store.addKeepReason(p.video, 'downloaded');
    await store.flushKept();
    const again = await open(undefined, dir);
    expect(again.store.keptOf(p.video)?.usedAt).toBe(20);
  });

  it('goes with its last reason, and evicts only watched-only videos, least recently used first', async () => {
    let t = 1000;
    const { store, cap, dir } = await open(10 * 1024 * 1024, undefined, () => t);
    const a = pkg('h1');
    const b = pkg('h2');
    const c = pkg('h3');
    await keep(store, a);
    t = 2000;
    await keep(store, b);
    t = 3000;
    await keep(store, c, '720p', 'downloaded');
    expect(store.evictable()).toEqual([a.video.toString(), b.video.toString()]);
    t = 4000;
    store.touchKept(a.video);
    expect(store.evictable()).toEqual([b.video.toString(), a.video.toString()]);

    // Downloaded too: kept when watched is dropped, and no longer evictable.
    expect(await store.addKeepReason(a.video, 'downloaded')).toBe(true);
    expect(store.evictable()).toEqual([b.video.toString()]);
    expect(await store.dropKeepReason(a.video, 'watched')).toBe(true);
    expect(store.hasVideo(a.video)).toBe(true);

    const before = cap.usedBytes;
    expect(await store.dropKeepReason(b.video, 'watched')).toBe(true);
    expect(store.hasVideo(b.video)).toBe(false);
    expect(cap.usedBytes).toBeLessThan(before);
    for (const s of b.files.keys()) expect(await onDisk(dir)).not.toContain(s);
    expect(await store.dropKeepReason(b.video, 'watched')).toBe(false);
    expect(await store.removeKept(c.video)).toBe(true);
    expect(store.keptVideos().map((r) => r.video)).toEqual([a.video.toString()]);
  });

  it('shares files with whole videos: neither removal deletes what the other names', async () => {
    const shared = new Uint8Array(150).fill(42);
    const p = pkg('i', 1, shared);
    const { store, dir } = await open();
    await keep(store, p);
    // A whole video carrying the same segment.
    const w = pkg('j', 1, shared);
    const put = await store.putVideo({
      video: w.video,
      root: w.root,
      segs: w.segs,
      hashListBytes: w.hashListBytes,
      read: (e) => Promise.resolve(w.files.get(e.sha256)!),
    });
    expect(put.ok).toBe(true);
    const s = sha(shared);
    expect(await store.removeKept(p.video)).toBe(true);
    expect(await onDisk(dir)).toContain(s);
    expect(store.file(w.video, s)).toBeDefined();
    await keep(store, p);
    expect(await store.removeVideo(w.video)).toBe(true);
    expect(await onDisk(dir)).toContain(s);
    expect(store.file(p.video, s)).toBeDefined();
  });

  it('at load, drops a record whose held file is gone, and one for a video stored whole', async () => {
    const { store, dir } = await open();
    const p = pkg('k');
    const q = pkg('l');
    await keep(store, p);
    await keep(store, q);
    const gone = p.r['720p']!.segments[1]!;
    await unlink(filePath(dir, gone));

    const again = await open(10 * 1024 * 1024, dir);
    expect(again.store.keptDroppedOnLoad).toBe(1);
    expect(again.store.hasVideo(p.video)).toBe(false);
    expect(again.store.hasVideo(q.video)).toBe(true);
    // p's files went with it; q's stayed.
    const files = await onDisk(dir);
    for (const s of p.r['720p']!.segments) expect(files).not.toContain(s);
    for (const s of q.r['720p']!.segments) expect(files).toContain(s);

    // Stored whole from now on: the kept copy is replaced, and is not read back.
    const put = await again.store.putVideo({
      video: q.video,
      root: q.root,
      segs: q.segs,
      hashListBytes: q.hashListBytes,
      read: (e) => Promise.resolve(q.files.get(e.sha256)!),
    });
    expect(put.ok).toBe(true);
    expect(again.store.keptOf(q.video)).toBeUndefined();
    expect(again.store.servedRenditions(q.video)).toBe('all');
    const kept = JSON.parse(await readFile(path.join(dir, 'nfx', 'kept.json'), 'utf8')) as {
      videos: { video: string }[];
    };
    expect(kept.videos.map((r) => r.video)).not.toContain(q.video.toString());
  });

  it.each(['none', 'quarantine', 'repair'])(
    'keeps whole videos after kept corruption with %s failure',
    async (failure) => {
      const { store, dir } = await open();
      const p = pkg('m');
      await keep(store, p);
      const whole = pkg('whole');
      expect(
        await store.putVideo({
          video: whole.video,
          root: whole.root,
          segs: whole.segs,
          hashListBytes: whole.hashListBytes,
          read: (e) => Promise.resolve(whole.files.get(e.sha256)!),
        }),
      ).toMatchObject({ ok: true });
      const keptPath = path.join(dir, 'nfx', 'kept.json');
      const corrupted = '{"version":2,"videos":[]}';
      await writeFile(keptPath, corrupted);
      const again = await open(undefined, dir, undefined, {
        ...adapters.fs,
        rename: (from, to) => {
          if (
            (failure === 'quarantine' && from === keptPath) ||
            (failure === 'repair' && to === keptPath)
          )
            return Promise.reject(new Error('kept database rename failed'));
          return adapters.fs.rename(from, to);
        },
      });
      expect(again.store.keptCorruptOnLoad).toBe(true);
      expect(again.store.hasVideo(whole.video)).toBe(true);
      const root = again.store.file(whole.video, whole.root);
      expect(await root?.read(0, root.size)).toEqual(whole.hashListBytes);
      expect(again.store.keptVideos()).toEqual([]);
      expect(again.store.loadError).toBeNull();
      const names = await readdir(path.join(dir, 'nfx'));
      expect(names.some((n) => n.startsWith('kept.json.unreadable-'))).toBe(
        failure !== 'quarantine',
      );
      if (failure === 'quarantine') {
        expect(await begin(again.store, p)).toMatchObject({ ok: false, error: 'unavailable' });
        expect(await readFile(keptPath, 'utf8')).toBe(corrupted);
      }
    },
  );

  it('while kept records are unknown, refuses whole puts and removals: a shared file stays', async () => {
    const shared = new Uint8Array(150).fill(43);
    const p = pkg('n', 1, shared);
    const { store, dir } = await open();
    await keep(store, p);
    const w = pkg('o', 1, shared);
    const put = (s: NfxStore, v: Pkg) =>
      s.putVideo({
        video: v.video,
        root: v.root,
        segs: v.segs,
        hashListBytes: v.hashListBytes,
        read: (e) => Promise.resolve(v.files.get(e.sha256)!),
      });
    expect(await put(store, w)).toMatchObject({ ok: true });
    const keptPath = path.join(dir, 'nfx', 'kept.json');
    await writeFile(keptPath, '{"version":2,"videos":[]}');
    // Unreadable and not set aside: what the kept records name is unknown.
    const again = await open(undefined, dir, undefined, {
      ...adapters.fs,
      rename: (from, to) =>
        from === keptPath
          ? Promise.reject(new Error('kept database rename failed'))
          : adapters.fs.rename(from, to),
    });
    await expect(again.store.removeVideo(w.video)).rejects.toThrow(/^unavailable:/);
    expect(again.store.hasVideo(w.video)).toBe(true);
    expect(await onDisk(dir)).toContain(sha(shared));
    expect(await put(again.store, pkg('x'))).toMatchObject({ ok: false, error: 'unavailable' });
  });

  it('drops a malformed kept record on its own', async () => {
    const { store, dir } = await open();
    const p = pkg('n');
    await keep(store, p);
    const file = path.join(dir, 'nfx', 'kept.json');
    const { videos } = JSON.parse(await readFile(file, 'utf8')) as {
      videos: { held: Record<string, unknown> }[];
    };
    const good = videos[0]!;
    // Valid addresses, so each record is dropped for the one thing wrong with it.
    const bad = [
      { ...good, video: 'nfx:regtest:1:other-video-1', reasons: {} },
      { ...good, video: 'nfx:regtest:1:other-video-2', held: { meta: good.held['720p'] } },
      { ...good, video: 'nfx:regtest:1:other-video-4', reasons: { liked: 1 } },
    ];
    // A rendition id that names a prototype key, written as raw JSON (a literal would set it).
    const proto = JSON.stringify({
      ...good,
      video: 'nfx:regtest:1:other-video-3',
      held: { PROTO: good.held['720p'] },
    }).replace('"PROTO"', '"__proto__"');
    const records = [...bad.map((b) => JSON.stringify(b)), proto, JSON.stringify(good)];
    const text = `{"version":1,"videos":[${records.join(',')}]}`;
    await writeFile(file, text);
    const again = await open(10 * 1024 * 1024, dir);
    expect(again.store.keptDroppedOnLoad).toBe(bad.length + 1);
    expect(again.store.keptVideos().map((r) => r.video)).toEqual([p.video.toString()]);
  });
});
