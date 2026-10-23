import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Sha256Hex } from '@sovit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DiskCap } from '../store/disk-cap.js';
import { NFX_DIR, NFX_INDEX_FILE, NfxFileStore } from '../store/nfx-files.js';
import { adapters, nfxVideo, tmpDir } from './helpers.js';

const bytes = (n: number, fill: number): Uint8Array => new Uint8Array(n).fill(fill);

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

describe('NfxFileStore', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    const t = await tmpDir();
    dir = t.dir;
    cleanup = t.rm;
  });
  afterEach(() => cleanup());

  const fileAt = (sha: string): string => path.join(dir, NFX_DIR, 'files', sha);

  async function open(capBytes = 1 << 20): Promise<{ store: NfxFileStore; cap: DiskCap }> {
    const store = new NfxFileStore({ ...adapters, dataDir: dir });
    await store.load();
    const cap = new DiskCap(capBytes, store.totalBytes());
    store.attach(cap);
    return { store, cap };
  }

  it('stores every listed file and the hash list under their sha256, and reloads them', async () => {
    const v = nfxVideo('first-video', [bytes(10, 1), bytes(20, 2), bytes(300, 3), bytes(400, 4)]);
    const { store, cap } = await open();
    const put = await store.putVideo(v.input);
    expect(put).toMatchObject({ ok: true, deduplicated: false });
    const listSize = v.input.hashListBytes.byteLength;
    expect(store.totalBytes()).toBe(730 + listSize);
    expect(cap.usedBytes).toBe(730 + listSize);
    expect(cap.pendingBytes).toBe(0);
    expect(v.reads).toEqual([...v.bytes.keys()]);
    for (const [sha, b] of v.bytes) {
      expect(store.has(sha)).toBe(true);
      expect(await store.readFile(sha)).toEqual(b);
      expect(new Uint8Array(await readFile(fileAt(sha)))).toEqual(b);
    }
    expect(await store.readFile(v.input.root)).toEqual(v.input.hashListBytes);
    expect(store.video(v.input.video.toString())).toMatchObject({
      root: v.input.root,
      listSize,
      files: [...v.bytes].map(([sha256, b]) => ({ sha256, size: b.byteLength })),
    });

    const again = await open();
    expect(again.store.videos()).toHaveLength(1);
    expect(again.store.totalBytes()).toBe(730 + listSize);
    expect(again.store.droppedOnLoad).toBe(0);
  });

  it('is a no-op for the same address and root, and refuses other content at that address', async () => {
    const v = nfxVideo('same-video', [bytes(10, 1), bytes(20, 2), bytes(30, 3)]);
    const other = nfxVideo('same-video', [bytes(10, 5), bytes(20, 6), bytes(30, 7)]);
    const { store, cap } = await open();
    expect((await store.putVideo(v.input)).ok).toBe(true);
    const used = cap.usedBytes;
    v.reads.length = 0;
    expect(await store.putVideo(v.input)).toMatchObject({ ok: true, deduplicated: true });
    expect(v.reads).toEqual([]);
    expect(await store.putVideo(other.input)).toEqual({
      ok: false,
      error: { code: 'conflict', root: v.input.root },
    });
    expect(other.reads).toEqual([]);
    expect(cap.usedBytes).toBe(used);
  });

  it('counts a file two videos list once, and deletes it only with the last of them', async () => {
    const shared = bytes(500, 9);
    const a = nfxVideo('video-aaaa', [bytes(10, 1), shared, bytes(100, 2)]);
    const b = nfxVideo('video-bbbb', [bytes(11, 1), shared, bytes(200, 3)]);
    const sharedSha = [...a.bytes.keys()][1]!;
    const { store, cap } = await open();
    expect((await store.putVideo(a.input)).ok).toBe(true);
    expect((await store.putVideo(b.input)).ok).toBe(true);
    expect(b.reads).not.toContain(sharedSha);
    const lists = a.input.hashListBytes.byteLength + b.input.hashListBytes.byteLength;
    expect(cap.usedBytes).toBe(10 + 500 + 100 + 11 + 200 + lists);

    expect(await store.removeVideo(a.input.video.toString())).toBe(true);
    expect(store.has(sharedSha)).toBe(true);
    expect(await exists(fileAt(sharedSha))).toBe(true);
    expect(cap.usedBytes).toBe(11 + 500 + 200 + b.input.hashListBytes.byteLength);
    expect(await store.removeVideo(a.input.video.toString())).toBe(false);

    expect(await store.removeVideo(b.input.video.toString())).toBe(true);
    expect(cap.usedBytes).toBe(0);
    expect(await exists(fileAt(sharedSha))).toBe(false);
    expect(store.totalBytes()).toBe(0);
    expect((await open()).store.videos()).toEqual([]);
  });

  it('refuses a video past the disk cap before reading or writing anything', async () => {
    const v = nfxVideo('too-big-video', [bytes(10, 1), bytes(20, 2), bytes(1000, 3)]);
    const { store, cap } = await open(500);
    const put = await store.putVideo(v.input);
    expect(put).toMatchObject({ ok: false, error: { code: 'disk-cap', free: 500 } });
    expect(v.reads).toEqual([]);
    expect(cap.usedBytes + cap.pendingBytes).toBe(0);
    for (const sha of v.bytes.keys()) expect(await exists(fileAt(sha))).toBe(false);
  });

  it('keeps nothing when a file does not match the list, and releases the reservation', async () => {
    const v = nfxVideo('bad-file-video', [bytes(10, 1), bytes(20, 2), bytes(30, 3)]);
    const last = [...v.bytes.keys()][2]! as Sha256Hex;
    const { store, cap } = await open();
    const put = await store.putVideo({
      ...v.input,
      read: async (entry) => {
        const b = await v.input.read(entry);
        return entry.sha256 === last ? bytes(30, 4) : b;
      },
    });
    expect(put).toEqual({ ok: false, error: { code: 'hash-mismatch', sha256: last } });
    expect(cap.usedBytes + cap.pendingBytes).toBe(0);
    expect(store.videos()).toEqual([]);
    for (const sha of [...v.bytes.keys(), v.input.root]) {
      expect(store.has(sha)).toBe(false);
      expect(await exists(fileAt(sha))).toBe(false);
    }
    expect((await open()).store.videos()).toEqual([]);
  });

  it('refuses a hash list that does not match its root, address or segs', async () => {
    const v = nfxVideo('listed-video', [bytes(10, 1), bytes(20, 2), bytes(30, 3)]);
    const other = nfxVideo('other-video', [bytes(10, 1), bytes(20, 2), bytes(30, 3)]);
    const { store } = await open();
    const wrongRoot = await store.putVideo({ ...v.input, root: other.input.root });
    expect(wrongRoot).toMatchObject({ ok: false, error: { code: 'hash-list' } });
    const wrongAddr = await store.putVideo({ ...v.input, video: other.input.video });
    expect(wrongAddr).toMatchObject({ ok: false, error: { code: 'hash-list' } });
    const wrongSegs = await store.putVideo({ ...v.input, segs: 4n });
    expect(wrongSegs).toMatchObject({ ok: false, error: { code: 'hash-list' } });
    expect(v.reads).toEqual([]);
  });

  it('removes what an interrupted put wrote, at the next load', async () => {
    const v = nfxVideo('interrupted', [bytes(10, 1), bytes(20, 2), bytes(30, 3)]);
    const first = await open();
    expect((await first.store.putVideo(v.input)).ok).toBe(true);
    // As a crash between the `pending` record and the finished one leaves it.
    const indexPath = path.join(dir, NFX_DIR, NFX_INDEX_FILE);
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
      videos: Record<string, unknown>[];
    };
    await writeFile(
      indexPath,
      JSON.stringify({ ...index, videos: index.videos.map((x) => ({ ...x, pending: true })) }),
    );

    const again = await open();
    expect(again.store.videos()).toEqual([]);
    expect(again.store.totalBytes()).toBe(0);
    for (const sha of [...v.bytes.keys(), v.input.root])
      expect(await exists(fileAt(sha))).toBe(false);
    expect(JSON.parse(await readFile(indexPath, 'utf8'))).toEqual({ version: 1, videos: [] });
  });

  it('drops a video whose file went missing, and removes the rest of its files', async () => {
    const shared = bytes(50, 9);
    const keep = nfxVideo('kept-video', [bytes(10, 1), shared, bytes(30, 3)]);
    const lose = nfxVideo('lost-video', [bytes(11, 1), shared, bytes(31, 3)]);
    const first = await open();
    expect((await first.store.putVideo(keep.input)).ok).toBe(true);
    expect((await first.store.putVideo(lose.input)).ok).toBe(true);
    const [losePlaylist, , loseSegment] = [...lose.bytes.keys()];
    await unlink(fileAt(loseSegment!));

    const again = await open();
    expect(again.store.droppedOnLoad).toBe(1);
    expect(again.store.videos().map((x) => x.video)).toEqual([keep.input.video.toString()]);
    expect(await exists(fileAt(losePlaylist!))).toBe(false);
    expect(await exists(fileAt(lose.input.root))).toBe(false);
    const sharedSha = [...keep.bytes.keys()][1]!;
    expect(again.store.has(sharedSha)).toBe(true);
    expect(again.store.totalBytes()).toBe(10 + 50 + 30 + keep.input.hashListBytes.byteLength);
  });

  it('starts empty, flagged, from a malformed index', async () => {
    await open();
    await writeFile(
      path.join(dir, NFX_DIR, NFX_INDEX_FILE),
      JSON.stringify({ version: 1, videos: [{ video: 'nfx:regtest:1:../../etc', root: 'x' }] }),
    );
    const { store } = await open();
    expect(store.corruptOnLoad).toBe(true);
    expect(store.videos()).toEqual([]);
  });

  it('refuses to work before load and before a disk cap is attached', async () => {
    const v = nfxVideo('early-video', [bytes(10, 1), bytes(20, 2)]);
    const store = new NfxFileStore({ ...adapters, dataDir: dir });
    await expect(store.putVideo(v.input)).rejects.toThrow(/load/);
    await store.load();
    await expect(store.putVideo(v.input)).rejects.toThrow(/disk cap/);
    store.attach(new DiskCap(1000, 0));
    expect(() => {
      store.attach(new DiskCap(1000, 0));
    }).toThrow(/attached/);
    expect((await store.putVideo(v.input)).ok).toBe(true);
  });
});
