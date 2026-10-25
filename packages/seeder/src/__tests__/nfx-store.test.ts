/**
 * The NFX file store (`nfx-store/store.ts`): verified puts (the hash list against its root,
 * every file against its entry), nothing left behind by a refused put, per-video listing,
 * refcounted removal, bounded reads, path validation and the shared disk cap.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { nfx } from '@sovit/core';
import { afterEach, describe, expect, it } from 'vitest';

import type { SeederFs } from '../adapters/fs.js';
import { NfxStore } from '../nfx-store/store.js';
import { DiskCap } from '../store/disk-cap.js';
import { adapters, tmpDir } from './helpers.js';

const enc = new TextEncoder();

function sha(bytes: Uint8Array): string {
  const h = adapters.crypto.createSha256();
  h.update(bytes);
  return h.digestHex();
}

function addr(id: string): nfx.VideoAddr {
  const a = nfx.VideoAddr.parse(`nfx:regtest:1:${id}`);
  if (!a.ok) throw new Error(a.error.reason);
  return a.value;
}

interface Pkg {
  readonly video: nfx.VideoAddr;
  readonly root: string;
  readonly segs: bigint;
  readonly hashListBytes: Uint8Array;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

/** A valid package: a master playlist, one rendition playlist and `segments` segments. */
function pkg(id: string, segments: readonly Uint8Array[]): Pkg {
  const video = addr(id);
  const files = new Map<string, Uint8Array>();
  const entry = (
    name: string,
    role: nfx.FileEntry['role'],
    bytes: Uint8Array,
    durMs?: bigint,
  ): nfx.FileEntry => {
    files.set(sha(bytes), bytes);
    return { name, role, sha256: sha(bytes), size: BigInt(bytes.byteLength), durMs };
  };
  const list: nfx.HashList = {
    v: 1,
    video: video.toString(),
    files: [
      entry('master.m3u8', 'playlist-master', enc.encode(`#EXTM3U\n#${id}\n`)),
      entry('r720p.m3u8', 'playlist', enc.encode(`#EXTM3U\n#rendition ${id}\n`)),
      ...segments.map((s, i) =>
        entry(`720p-seg_${String(i).padStart(5, '0')}.m4s`, 'segment', s, 2000n),
      ),
    ],
    renditions: [
      {
        id: '720p',
        playlist: 'r720p.m3u8',
        bandwidth: 1000n,
        codecs: undefined,
        resolution: undefined,
      },
    ],
  };
  const hashListBytes = nfx.renderHashList(list);
  return { video, root: sha(hashListBytes), segs: BigInt(list.files.length), hashListBytes, files };
}

function put(store: NfxStore, p: Pkg, override?: (sha: string) => Uint8Array | undefined) {
  return store.putVideo({
    video: p.video,
    root: p.root,
    segs: p.segs,
    hashListBytes: p.hashListBytes,
    read: (e) => {
      const bytes = override?.(e.sha256) ?? p.files.get(e.sha256);
      return bytes === undefined ? Promise.reject(new Error('missing')) : Promise.resolve(bytes);
    },
  });
}

const dirs: { rm(): Promise<void> }[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await d.rm();
});

async function open(capBytes = 10 * 1024 * 1024, fs: SeederFs = adapters.fs) {
  const d = await tmpDir('nf-nfx-store-');
  dirs.push(d);
  const store = new NfxStore({ fs, crypto: adapters.crypto, dataDir: d.dir });
  await store.load();
  const cap = new DiskCap(capBytes, store.totalBytes());
  store.attachCap(cap);
  return { store, cap, dir: d.dir };
}

/** Every file under the store's `files/` and `tmp/`. */
async function onDisk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const sub of ['files', 'tmp']) {
    const entries = await readdir(path.join(dir, 'nfx', sub), {
      recursive: true,
      withFileTypes: true,
    });
    for (const e of entries) if (e.isFile()) out.push(path.join(sub, e.name));
  }
  return out.sort();
}

const seg = (n: number, fill: number): Uint8Array => new Uint8Array(n).fill(fill);

describe('NfxStore', () => {
  it('stores a verified video and serves only the files its hash list lists', async () => {
    const { store, cap, dir } = await open();
    const p = pkg('nfx-store-one', [seg(70_000, 1), seg(1_000, 2)]);
    const r = await put(store, p);
    expect(r.ok).toBe(true);
    expect(store.hasVideo(p.video)).toBe(true);
    // Hash list + master + rendition playlist + 2 segments.
    expect((await onDisk(dir)).filter((f) => f.startsWith('files'))).toHaveLength(5);
    expect((await onDisk(dir)).filter((f) => f.startsWith('tmp'))).toEqual([]);
    expect(store.totalBytes()).toBe(cap.usedBytes);

    const list = store.file(p.video, p.root)!;
    expect(sha(await list.read(0, list.size))).toBe(p.root);
    const [first] = [...p.files.entries()].filter(([, b]) => b.byteLength === 70_000);
    const f = store.file(p.video, first![0])!;
    expect(f.size).toBe(70_000);
    expect(await f.read(65_536, 4_464)).toEqual(first![1].subarray(65_536));
    expect(store.file(addr('nfx-store-other'), p.root)).toBeUndefined();
  });

  it('refuses a hash list that is not its root, and writes nothing', async () => {
    const { store, cap, dir } = await open();
    const p = pkg('nfx-store-bad-root', [seg(10, 1)]);
    const r = await store.putVideo({
      ...p,
      root: 'ab'.repeat(32),
      read: () => Promise.resolve(seg(1, 0)),
    });
    expect(r).toMatchObject({ ok: false, error: 'invalid' });
    expect(await onDisk(dir)).toEqual([]);
    expect(cap.usedBytes + cap.pendingBytes).toBe(0);
  });

  it('refuses a file that is not its entry, removes what it wrote and releases the cap', async () => {
    const { store, cap, dir } = await open();
    const p = pkg('nfx-store-mismatch', [seg(100, 1), seg(100, 2)]);
    const last = [...p.files.keys()].at(-1)!;
    const r = await put(store, p, (s) => (s === last ? seg(100, 9) : undefined));
    expect(r).toMatchObject({ ok: false, error: 'mismatch' });
    expect(store.hasVideo(p.video)).toBe(false);
    expect((await onDisk(dir)).filter((f) => f.startsWith('files'))).toEqual([]);
    expect(cap.usedBytes + cap.pendingBytes).toBe(0);
  });

  it('refuses a video that would exceed the disk cap, before writing anything', async () => {
    const { store, cap, dir } = await open(1_000);
    const r = await put(store, pkg('nfx-store-big', [seg(5_000, 1)]));
    expect(r).toMatchObject({ ok: false, error: 'disk-cap' });
    expect(await onDisk(dir)).toEqual([]);
    expect(cap.usedBytes + cap.pendingBytes).toBe(0);
  });

  it('shares a file between videos, counts it once, and removes it with the last one', async () => {
    const { store, cap } = await open();
    const shared = seg(4_000, 7);
    const a = pkg('nfx-store-a1', [shared, seg(10, 1)]);
    const b = pkg('nfx-store-b1', [shared, seg(10, 2)]);
    expect((await put(store, a)).ok).toBe(true);
    const afterA = cap.usedBytes;
    expect((await put(store, b)).ok).toBe(true);
    expect(cap.usedBytes - afterA).toBeLessThan(4_000); // the shared segment is not counted twice
    expect(await store.removeVideo(a.video)).toBe(true);
    expect(store.file(b.video, sha(shared))).toBeDefined();
    expect(await store.removeVideo(b.video)).toBe(true);
    expect(cap.usedBytes).toBe(0);
    expect(store.totalBytes()).toBe(0);
    expect(await store.removeVideo(b.video)).toBe(false);
  });

  it('is idempotent for the same root and refuses another root at the same address', async () => {
    const { store } = await open();
    const p = pkg('nfx-store-again', [seg(10, 1)]);
    expect(await put(store, p)).toMatchObject({ ok: true, deduplicated: false });
    expect(await put(store, p)).toMatchObject({ ok: true, deduplicated: true });
    const other = pkg('nfx-store-again', [seg(11, 1)]);
    expect(await put(store, other)).toMatchObject({ ok: false, error: 'exists' });
  });

  it('bounds reads to the file and refuses hashes that are not 64 lowercase hex', async () => {
    const { store } = await open();
    const p = pkg('nfx-store-bounds', [seg(100, 1)]);
    await put(store, p);
    const f = store.file(p.video, p.root)!;
    for (const [offset, length] of [
      [-1, 1],
      [0, f.size + 1],
      [f.size, 1],
      [0.5, 1],
      [0, Number.NaN],
    ] as const) {
      await expect(f.read(offset, length), `${String(offset)},${String(length)}`).rejects.toThrow();
    }
    expect(await f.read(f.size, 0)).toEqual(new Uint8Array(0));
    for (const bad of ['../../etc/passwd', p.root.toUpperCase(), p.root.slice(1), `${p.root}/x`]) {
      expect(store.file(p.video, bad)).toBeUndefined();
    }
  });

  it('reloads its videos and their bytes from disk', async () => {
    const { store, dir } = await open();
    const p = pkg('nfx-store-reload', [seg(300, 3)]);
    await put(store, p);
    const again = new NfxStore({ fs: adapters.fs, crypto: adapters.crypto, dataDir: dir });
    await again.load();
    expect(again.corruptOnLoad).toBe(false);
    expect(again.hasVideo(p.video)).toBe(true);
    expect(again.totalBytes()).toBe(store.totalBytes());
    const f = again.file(p.video, p.root)!;
    expect(sha(await f.read(0, f.size))).toBe(p.root);
  });

  it('reads ranges through the stream when the adapter has no readRange', async () => {
    const { readRange: _omit, ...withoutRange } = adapters.fs;
    const { store } = await open(10 * 1024 * 1024, withoutRange);
    const big = new Uint8Array(200_000);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const p = pkg('nfx-store-stream', [big]);
    await put(store, p);
    const f = store.file(p.video, sha(big))!;
    expect(await f.read(150_000, 30_000)).toEqual(big.subarray(150_000, 180_000));
  });

  it('serves through source() exactly what file() serves', async () => {
    const { store } = await open();
    const p = pkg('nfx-store-source', [seg(10, 1)]);
    await put(store, p);
    const src = store.source();
    expect(src.hasVideo(p.video)).toBe(true);
    expect(src.file(p.video, p.root)?.size).toBe(p.hashListBytes.byteLength);
    expect(src.hasVideo(addr('nfx-store-absent'))).toBe(false);
  });
});
