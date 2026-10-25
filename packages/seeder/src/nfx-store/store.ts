/**
 * The NFX file store (ADR 0020, NFX-05 §4): the files of NFX videos this node publishes or
 * seeds, named by their sha256, beside — never inside — the legacy Hyperblobs store. The
 * legacy `blobs` core is shared, priced and joined to the legacy swarm (`cas-index.ts`), so an
 * NFX file kept there would be served to the legacy swarm as well; nothing here joins any
 * swarm. The NFX transport serves from this store through `source()`.
 *
 * Layout under `<dataDir>/nfx/`:
 *   files/<sha[0..2]>/<sha>   one file per content hash, shared across videos (refcounted)
 *   tmp/<sha>.part            a write in progress, renamed into place once complete
 *   videos.json               per video: its hash list root, `segs`, and the files it lists
 *
 * - Nothing is stored unverified: a video's hash list is checked against its `root` first
 *   (`nfx.verifyHashList`), and each file's size and sha256 against the hash list's entry,
 *   in memory, before it is written. The file list comes from the verified hash list, never
 *   from the caller.
 * - Paths are built only from validated lowercase-hex sha256 values.
 * - Disk cap (one pool with the legacy store): a put reserves the bytes of the files not
 *   already stored against the seeder's `DiskCap` and commits them when the video is recorded;
 *   a removal frees the bytes of files no other video lists.
 * - Crash safety: files are written before the video's record, and a record is removed before
 *   its files, so a crash can leave unreferenced files (on disk, not counted), never a record
 *   naming a missing file. A `.part` file is overwritten by the next write of the same hash.
 */
import { nfx } from '@sovit/core';

import type { SeederCrypto } from '../adapters/crypto.js';
import type { SeederFs } from '../adapters/fs.js';
import type { DiskCap } from '../store/disk-cap.js';
import { JsonStore } from '../store/json-store.js';
import { isHex } from '../util/hex.js';

export const NFX_STORE_DIR = 'nfx' as const;
export const NFX_VIDEOS_FILE = 'videos.json' as const;

/** The largest range `read` returns at once: a hash list's cap (NFX-12 §4) bounds memory. */
export const NFX_MAX_READ_BYTES = nfx.MAX_HASH_LIST_BYTES;

/** One file a video lists, as recorded. */
export interface NfxStoredFile {
  readonly sha256: string;
  readonly size: number;
}

/** A stored video. `files` includes the hash list itself (its sha256 is `root`). */
export interface NfxVideoRecord {
  /** `<namespace>:<video-id>` (NFX-01), canonical. */
  readonly video: string;
  readonly root: string;
  /** The manifest `segs`: the hash list's file count, as decimal text (a u64). */
  readonly segs: string;
  readonly files: readonly NfxStoredFile[];
  readonly addedAt: number;
}

interface VideosFile {
  readonly version: 1;
  readonly videos: readonly NfxVideoRecord[];
}

/** A file the store serves for a video (the transport's `NfxServedFile`, structurally). */
export interface NfxStoreFile {
  readonly size: number;
  /** Exactly `length` bytes at `offset`; anything outside the file is refused. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** What the NFX transport serves from (its `NfxFileSource`, structurally; no import of it). */
export interface NfxStoreSource {
  hasVideo(video: nfx.VideoAddr): boolean;
  file(video: nfx.VideoAddr, sha: string): NfxStoreFile | undefined;
}

export interface NfxPutVideo {
  readonly video: nfx.VideoAddr;
  /** sha256 of `hashListBytes` (the manifest `root`). */
  readonly root: string;
  /** The manifest `segs`. */
  readonly segs: bigint;
  readonly hashListBytes: Uint8Array;
  /** The bytes of one file the VERIFIED hash list names. Checked against the entry here. */
  readonly read: (entry: nfx.FileEntry) => Promise<Uint8Array>;
}

export type NfxPutError =
  /** The hash list does not verify against `root`, `video` and `segs`. */
  | 'invalid'
  /** A file's bytes are not the size or sha256 its hash-list entry says. */
  | 'mismatch'
  /** The video is already stored with another root (publishing a new version is slice 4's). */
  | 'exists'
  /** Storing the new files would exceed the disk cap. */
  | 'disk-cap'
  /** Reading a source file or writing the store failed. */
  | 'io';

export type NfxPutResult =
  | { readonly ok: true; readonly record: NfxVideoRecord; readonly deduplicated: boolean }
  | { readonly ok: false; readonly error: NfxPutError; readonly message: string };

export interface NfxStoreOptions {
  readonly fs: SeederFs;
  readonly crypto: SeederCrypto;
  readonly dataDir: string;
  readonly now?: () => number;
}

const SHA = /^[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;

function validateVideosFile(raw: unknown): VideosFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o['version'] !== 1 || !Array.isArray(o['videos'])) return null;
  const videos: NfxVideoRecord[] = [];
  const seen = new Set<string>();
  for (const v of o['videos'] as unknown[]) {
    if (typeof v !== 'object' || v === null) return null;
    const r = v as Record<string, unknown>;
    const video = r['video'];
    const root = r['root'];
    const segs = r['segs'];
    const addedAt = r['addedAt'];
    if (typeof video !== 'string' || !canonicalAddress(video) || seen.has(video)) return null;
    if (typeof root !== 'string' || !SHA.test(root)) return null;
    if (typeof segs !== 'string' || !DECIMAL.test(segs)) return null;
    if (!Number.isSafeInteger(addedAt) || (addedAt as number) < 0) return null;
    if (!Array.isArray(r['files'])) return null;
    const files: NfxStoredFile[] = [];
    for (const f of r['files'] as unknown[]) {
      if (typeof f !== 'object' || f === null) return null;
      const e = f as Record<string, unknown>;
      const sha = e['sha256'];
      const size = e['size'];
      if (typeof sha !== 'string' || !SHA.test(sha)) return null;
      if (!Number.isSafeInteger(size) || (size as number) < 0) return null;
      files.push({ sha256: sha, size: size as number });
    }
    if (!files.some((f) => f.sha256 === root)) return null;
    seen.add(video);
    videos.push({ video, root, segs, files, addedAt: addedAt as number });
  }
  return { version: 1, videos };
}

function canonicalAddress(text: string): boolean {
  const parsed = nfx.VideoAddr.parse(text);
  return parsed.ok && parsed.value.toString() === text;
}

export class NfxStore {
  private readonly records = new Map<string, NfxVideoRecord>();
  /** sha256 → size, for every file at least one recorded video lists. */
  private readonly sizes = new Map<string, number>();
  private readonly db: JsonStore<VideosFile>;
  private readonly root: string;
  private readonly now: () => number;
  private cap: DiskCap | null = null;
  /** Mutations run one at a time (a put's reads and writes span awaits). */
  private chain: Promise<unknown> = Promise.resolve();
  private loaded = false;
  corruptOnLoad = false;

  constructor(private readonly o: NfxStoreOptions) {
    this.root = o.fs.join(o.dataDir, NFX_STORE_DIR);
    this.db = new JsonStore<VideosFile>(
      o.fs,
      o.crypto,
      o.fs.join(this.root, NFX_VIDEOS_FILE),
      validateVideosFile,
      () => ({ version: 1, videos: [] }),
    );
    this.now = o.now ?? ((): number => Math.floor(Date.now() / 1000));
  }

  async load(): Promise<void> {
    await this.o.fs.mkdir(this.o.fs.join(this.root, 'files'), { recursive: true });
    await this.o.fs.mkdir(this.o.fs.join(this.root, 'tmp'), { recursive: true });
    const { value, corrupt } = await this.db.load();
    this.corruptOnLoad = corrupt;
    this.records.clear();
    for (const r of value.videos) this.records.set(r.video, r);
    this.recount();
    this.loaded = true;
  }

  /**
   * Count puts and removals against `cap` from now on. The cap's starting `committed` must
   * already include `totalBytes()` (the seeder sizes it from both stores).
   */
  attachCap(cap: DiskCap): void {
    this.cap = cap;
  }

  /** Bytes of every stored file, each once however many videos list it. */
  totalBytes(): number {
    let n = 0;
    for (const size of this.sizes.values()) n += size;
    return n;
  }

  videos(): readonly NfxVideoRecord[] {
    return [...this.records.values()];
  }

  get(video: nfx.VideoAddr): NfxVideoRecord | undefined {
    return this.records.get(video.toString());
  }

  hasVideo(video: nfx.VideoAddr): boolean {
    return this.records.has(video.toString());
  }

  /**
   * File `sha` of `video`: only a file that video's verified hash list lists (or the hash list
   * itself, `sha` = root). `undefined` for anything else, even a file stored for another video.
   */
  file(video: nfx.VideoAddr, sha: string): NfxStoreFile | undefined {
    if (!SHA.test(sha)) return undefined;
    const entry = this.records.get(video.toString())?.files.find((f) => f.sha256 === sha);
    if (entry === undefined) return undefined;
    const path = this.filePath(sha);
    const size = entry.size;
    return {
      size,
      read: (offset, length) => this.readRange(path, size, offset, length),
    };
  }

  /** The transport's view of the store. */
  source(): NfxStoreSource {
    return {
      hasVideo: (video) => this.hasVideo(video),
      file: (video, sha) => this.file(video, sha),
    };
  }

  /** Verify and store a video's hash list and every file it lists; failures are results. */
  putVideo(input: NfxPutVideo): Promise<NfxPutResult> {
    return this.serialize(() => this.put(input));
  }

  /** Forget `video` and remove the files no other video lists. `false` if it was not stored. */
  removeVideo(video: nfx.VideoAddr): Promise<boolean> {
    return this.serialize(() => this.remove(video));
  }

  private async put(input: NfxPutVideo): Promise<NfxPutResult> {
    this.assertLoaded();
    const fail = (error: NfxPutError, message: string): NfxPutResult => ({
      ok: false,
      error,
      message,
    });
    const key = input.video.toString();
    if (!SHA.test(input.root)) return fail('invalid', 'root is not 64 lowercase hex');
    const known = this.records.get(key);
    if (known !== undefined) {
      return known.root === input.root
        ? { ok: true, record: known, deduplicated: true }
        : fail('exists', 'the video is stored with another hash list');
    }
    const verified = nfx.verifyHashList(input.hashListBytes, input.root, input.video, input.segs);
    if (!verified.ok) return fail('invalid', verified.error.reason);

    // The files to record: the hash list itself, then every entry, each hash once.
    const listed = new Map<string, { size: number; entry: nfx.FileEntry | undefined }>();
    listed.set(input.root, { size: input.hashListBytes.byteLength, entry: undefined });
    for (const f of verified.value.files) {
      if (f.size > BigInt(Number.MAX_SAFE_INTEGER)) return fail('invalid', 'a file is too large');
      if (!listed.has(f.sha256)) listed.set(f.sha256, { size: Number(f.size), entry: f });
    }
    let newBytes = 0;
    for (const [sha, { size }] of listed) if (!this.sizes.has(sha)) newBytes += size;
    const reservation = this.cap === null ? null : this.cap.reserve(newBytes);
    if (this.cap !== null && reservation === null) {
      return fail('disk-cap', 'storing the video would exceed the disk cap');
    }

    const written: string[] = [];
    const undo = async (): Promise<void> => {
      reservation?.release();
      for (const sha of written) await this.o.fs.unlink(this.filePath(sha)).catch(() => undefined);
    };
    for (const [sha, { size, entry }] of listed) {
      if (this.sizes.has(sha)) continue; // stored for another video
      let bytes: Uint8Array;
      try {
        bytes = entry === undefined ? input.hashListBytes : await input.read(entry);
      } catch {
        await undo();
        return fail('io', `could not read ${entry?.name ?? 'the hash list'}`);
      }
      if (bytes.byteLength !== size || this.sha256(bytes) !== sha) {
        await undo();
        return fail('mismatch', `${entry?.name ?? 'the hash list'} is not the listed bytes`);
      }
      try {
        await this.writeVerified(sha, bytes);
      } catch {
        await undo();
        return fail('io', 'could not write the store');
      }
      written.push(sha);
    }

    const record: NfxVideoRecord = {
      video: key,
      root: input.root,
      segs: input.segs.toString(),
      files: [...listed].map(([sha256, { size }]) => ({ sha256, size })),
      addedAt: this.now(),
    };
    this.records.set(key, record);
    try {
      await this.persist();
    } catch {
      this.records.delete(key);
      await undo();
      return fail('io', 'could not record the video');
    }
    reservation?.commit();
    this.recount();
    return { ok: true, record, deduplicated: false };
  }

  private async remove(video: nfx.VideoAddr): Promise<boolean> {
    this.assertLoaded();
    const key = video.toString();
    const record = this.records.get(key);
    if (record === undefined) return false;
    this.records.delete(key);
    try {
      await this.persist();
    } catch (err) {
      this.records.set(key, record);
      throw err;
    }
    const before = new Map(this.sizes);
    this.recount();
    for (const [sha, size] of before) {
      if (this.sizes.has(sha)) continue;
      await this.o.fs.unlink(this.filePath(sha)).catch(() => undefined);
      this.cap?.free(size);
    }
    return true;
  }

  /** `bytes` (already checked against `sha`) to `files/<sha[0..2]>/<sha>`, via a `.part` file. */
  private async writeVerified(sha: string, bytes: Uint8Array): Promise<void> {
    const dir = this.o.fs.join(this.root, 'files', sha.slice(0, 2));
    await this.o.fs.mkdir(dir, { recursive: true });
    const tmp = this.o.fs.join(this.root, 'tmp', `${sha}.part`);
    await this.o.fs.writeFile(tmp, bytes);
    try {
      await this.o.fs.rename(tmp, this.filePath(sha));
    } catch (err) {
      await this.o.fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  private async readRange(
    path: string,
    size: number,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      length > NFX_MAX_READ_BYTES ||
      offset + length > size
    ) {
      throw new RangeError('nfx store: read outside the file');
    }
    const bytes =
      this.o.fs.readRange === undefined
        ? await this.streamRange(path, offset, length)
        : await this.o.fs.readRange(path, offset, length);
    if (bytes.byteLength !== length) throw new Error('nfx store: short read');
    return bytes;
  }

  /** `readRange` without the adapter's: read from the start, keep the range. */
  private async streamRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    let pos = 0;
    let filled = 0;
    for await (const chunk of this.o.fs.readStream(path)) {
      const end = pos + chunk.byteLength;
      if (end > offset && filled < length) {
        const from = Math.max(0, offset - pos);
        const take = chunk.subarray(from, from + (length - filled));
        out.set(take, filled);
        filled += take.byteLength;
      }
      pos = end;
      if (filled === length) break;
    }
    return out.subarray(0, filled);
  }

  private filePath(sha: string): string {
    // Callers pass validated hashes only; this is the guard that keeps paths inside the store.
    if (!isHex(sha, 32)) throw new Error('nfx store: not a sha256');
    return this.o.fs.join(this.root, 'files', sha.slice(0, 2), sha);
  }

  private sha256(bytes: Uint8Array): string {
    const h = this.o.crypto.createSha256();
    h.update(bytes);
    return h.digestHex();
  }

  private recount(): void {
    this.sizes.clear();
    for (const r of this.records.values())
      for (const f of r.files) this.sizes.set(f.sha256, f.size);
  }

  private persist(): Promise<void> {
    return this.db.save({ version: 1, videos: this.videos() });
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('NfxStore: call load() before mutating');
  }
}
