/**
 * NFX file store (ADR 0020, NFX-05 §3–§4; interop plan slice 2b): the files of NFX videos, each
 * kept under its sha256, apart from every Hypercore. The legacy `blobs` core is shared, priced
 * and swarm-joined (`cas-index.ts`), so an NFX file kept there would be served on the legacy
 * swarm; these files are served only by the NFX-12 transport (`files/1`), which asks `has` and
 * `readFile` here (worker wiring, slice 5).
 *
 * Layout under `<dataDir>/nfx/`: `files/<sha256>` (the bytes) and `index.json` (each video's
 * address, `root` and listed files). The hash list itself is stored too, under `root`. A file
 * listed by several videos is stored and counted once, and every stored byte is counted in the
 * seeder's one `DiskCap`, beside the Hyperblobs payload.
 *
 * A put verifies before it keeps: the hash list against `root`, the address and `segs`, then
 * each file's size and sha256 against the list (NFX-05 §4), so nothing unlisted is ever stored.
 * A list that gives one sha256 two sizes, or a size other than the one a stored file has, is
 * refused: a record never disagrees with the bytes it names.
 *
 * Crashes: the fs adapter cannot list a directory, so nothing may be left on disk that no index
 * record names. A put is recorded as `pending` before its first file is written, and a load
 * removes a pending put's files; a removal deletes files before it saves the index, so a crash
 * between leaves a record whose file is missing, which a load drops. At load the size on disk
 * decides which records are true; a video with any file missing or of another size is dropped.
 * Every mutation runs one at a time.
 */
import { nfx } from '@sovit/core';
import type { Sha256Hex, UnixSeconds } from '@sovit/core';

import type { SeederCrypto } from '../adapters/crypto.js';
import type { SeederFs } from '../adapters/fs.js';
import type { Logger } from '../log/logger.js';
import { silentLogger } from '../log/logger.js';
import { isHex } from '../util/hex.js';
import type { DiskCap } from './disk-cap.js';
import { JsonStore } from './json-store.js';

export const NFX_DIR = 'nfx' as const;
export const NFX_INDEX_FILE = 'index.json' as const;
const FILES_DIR = 'files';

/** One stored file: a listed file, or the hash list under its `root`. */
export interface NfxStoredFile {
  readonly sha256: Sha256Hex;
  readonly size: number;
}

/** A video whose files are all stored and verified. */
export interface NfxStoredVideo {
  /** The canonical NFX-01 address, `<namespace>:<video-id>`. */
  readonly video: string;
  /** sha256 of the hash list's bytes: the manifest `root`. */
  readonly root: Sha256Hex;
  /** The hash list's own size, stored under `root`. */
  readonly listSize: number;
  /** The hash list's files, in its order: `files.length` is the manifest `segs`. */
  readonly files: readonly NfxStoredFile[];
  readonly addedAt: UnixSeconds;
}

export interface NfxVideoInput {
  readonly video: nfx.VideoAddr;
  readonly root: Sha256Hex;
  readonly segs: bigint;
  readonly hashListBytes: Uint8Array;
  /** A listed file's bytes. Called once per file this store does not hold yet, in list order. */
  readonly read: (entry: nfx.FileEntry) => Promise<Uint8Array>;
}

export type NfxPutError =
  | { readonly code: 'hash-list'; readonly reason: string }
  /** The address already names other content (NFX-02 §2: a video-id is never reused). */
  | { readonly code: 'conflict'; readonly root: Sha256Hex }
  | { readonly code: 'disk-cap'; readonly needed: number; readonly free: number }
  | { readonly code: 'hash-mismatch'; readonly sha256: Sha256Hex }
  | { readonly code: 'write-failed'; readonly message: string }
  /** The store could not load (`loadError`): NFX is off until a restart that loads. */
  | { readonly code: 'unavailable' };

export type NfxPutResult =
  | { readonly ok: true; readonly video: NfxStoredVideo; readonly deduplicated: boolean }
  | { readonly ok: false; readonly error: NfxPutError };

interface IndexVideo extends NfxStoredVideo {
  /** Recorded before the first file is written; never set on a finished put. */
  readonly pending?: true;
}

interface IndexFile {
  readonly version: 1;
  readonly videos: readonly IndexVideo[];
  /** Entries refused at load (malformed, or an address given twice). Never saved. */
  readonly dropped?: number;
}

const isSize = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

function validateFile(raw: unknown): NfxStoredFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const sha = o['sha256'];
  if (typeof sha !== 'string' || !isHex(sha, 32) || !isSize(o['size'])) return null;
  return { sha256: sha as Sha256Hex, size: o['size'] };
}

function validateVideo(raw: unknown): IndexVideo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const video = o['video'];
  const root = o['root'];
  if (typeof video !== 'string') return null;
  const addr = nfx.VideoAddr.parse(video);
  if (!addr.ok || addr.value.toString() !== video) return null;
  if (typeof root !== 'string' || !isHex(root, 32)) return null;
  if (!isSize(o['listSize']) || !Number.isInteger(o['addedAt'])) return null;
  if (!Array.isArray(o['files']) || o['files'].length === 0) return null;
  const files: NfxStoredFile[] = [];
  for (const f of o['files'] as unknown[]) {
    const v = validateFile(f);
    if (v === null) return null;
    files.push(v);
  }
  const pending = o['pending'];
  if (pending !== undefined && pending !== true) return null;
  return {
    video,
    root: root as Sha256Hex,
    listSize: o['listSize'],
    files,
    addedAt: o['addedAt'] as UnixSeconds,
    ...(pending === true ? { pending: true as const } : {}),
  };
}

/**
 * The index, entry by entry: a malformed entry, or a second one for an address, is dropped on
 * its own (its files are not trusted, so it keeps nothing alive). `null` only when the file is
 * not an index at all, or of another version.
 */
function validateIndex(raw: unknown): IndexFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o['version'] !== 1 || !Array.isArray(o['videos'])) return null;
  const videos: IndexVideo[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const v of o['videos'] as unknown[]) {
    const video = validateVideo(v);
    if (video === null || seen.has(video.video)) {
      dropped += 1;
      continue;
    }
    seen.add(video.video);
    videos.push(video);
  }
  return { version: 1, videos, dropped };
}

/** Every file a video keeps: its listed files, then the hash list under `root`. */
function filesOf(v: NfxStoredVideo): readonly NfxStoredFile[] {
  return [...v.files, { sha256: v.root, size: v.listSize }];
}

/** A video's files, each sha256 once. */
function uniqueFiles(v: NfxStoredVideo): readonly NfxStoredFile[] {
  return [...new Map(filesOf(v).map((f) => [f.sha256, f])).values()];
}

export interface NfxFileStoreOptions {
  readonly fs: SeederFs;
  readonly crypto: SeederCrypto;
  readonly dataDir: string;
  readonly logger?: Logger;
  readonly now?: () => UnixSeconds;
}

export class NfxFileStore {
  private readonly fs: SeederFs;
  private readonly crypto: SeederCrypto;
  private readonly filesDir: string;
  private readonly indexPath: string;
  private readonly store: JsonStore<IndexFile>;
  private readonly log: Logger;
  private readonly now: () => UnixSeconds;
  private readonly byVideo = new Map<string, NfxStoredVideo>();
  /** sha256 → size and how many stored videos keep it. */
  private readonly refs = new Map<string, { size: number; count: number }>();
  /** The put in progress, written to the index as `pending`. */
  private pending: IndexVideo | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private diskCap: DiskCap | null = null;
  private loaded = false;
  /** Why `load` failed; the store then holds nothing and refuses every put. */
  loadError: string | null = null;
  /** The index was not an index (or of another version) and was set aside. */
  corruptOnLoad = false;
  /** Videos dropped at load: malformed, or a file missing or of another size. */
  droppedOnLoad = 0;

  constructor(opts: NfxFileStoreOptions) {
    this.fs = opts.fs;
    this.crypto = opts.crypto;
    const dir = opts.fs.join(opts.dataDir, NFX_DIR);
    this.filesDir = opts.fs.join(dir, FILES_DIR);
    this.indexPath = opts.fs.join(dir, NFX_INDEX_FILE);
    this.store = new JsonStore<IndexFile>(
      opts.fs,
      opts.crypto,
      this.indexPath,
      validateIndex,
      () => ({ version: 1, videos: [] }),
    );
    this.log = (opts.logger ?? silentLogger).child({ component: 'nfx-files' });
    this.now = opts.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds);
  }

  /**
   * Read the index, remove what an interrupted put left, and drop any video whose files are
   * not all on disk at their sizes. Call before `totalBytes()` sizes the disk cap. Never
   * throws: a failure leaves the store empty and off (`loadError`), so the seeder still starts.
   */
  async load(): Promise<void> {
    try {
      await this.loadIndex();
    } catch (err) {
      this.byVideo.clear();
      this.refs.clear();
      this.loadError = err instanceof Error ? err.message : String(err);
      this.log.error('NFX file store could not load; NFX is off', { error: err });
    }
    this.loaded = true;
  }

  private async loadIndex(): Promise<void> {
    await this.fs.mkdir(this.filesDir, { recursive: true });
    const { value, corrupt } = await this.store.load();
    this.corruptOnLoad = corrupt;
    if (corrupt && (await this.fs.stat(this.indexPath)) !== null) {
      // Kept for a person to read (a newer version's index, a damaged file), never overwritten.
      const aside = `${this.indexPath}.unreadable-${this.crypto.randomHex(4)}`;
      await this.fs.rename(this.indexPath, aside);
      this.log.error('NFX file index was unreadable; set aside, starting with no NFX videos');
    }
    this.byVideo.clear();
    this.refs.clear();
    const done = value.videos.filter((v) => v.pending !== true);
    const interrupted = value.videos.filter((v) => v.pending === true);

    // The size on disk decides: a record that names a file missing, not a file, or of another
    // size is wrong, and its video is dropped. A record that agrees keeps its video.
    const onDisk = new Map<string, number | null>();
    for (const v of done)
      for (const f of filesOf(v)) {
        if (onDisk.has(f.sha256)) continue;
        const st = await this.fs.stat(this.pathOf(f.sha256));
        onDisk.set(f.sha256, st !== null && st.isFile ? st.size : null);
      }
    const kept = done.filter((v) => filesOf(v).every((f) => onDisk.get(f.sha256) === f.size));
    this.droppedOnLoad = (value.dropped ?? 0) + done.length - kept.length;
    for (const v of kept) this.keep(v);

    // Remove what nothing kept lists: the files of dropped and interrupted puts, and any
    // temporary file a crash mid-write left for one of them.
    const orphans = new Set<string>();
    for (const v of [...done, ...interrupted])
      for (const f of filesOf(v)) if (!this.refs.has(f.sha256)) orphans.add(f.sha256);
    for (const sha of orphans) {
      await this.unlinkQuietly(this.pathOf(sha));
      await this.unlinkQuietly(this.tmpOf(sha));
    }

    if (this.droppedOnLoad > 0 || interrupted.length > 0 || corrupt) {
      this.log.warn('NFX videos dropped at load', {
        dropped: this.droppedOnLoad,
        interrupted: interrupted.length,
      });
      await this.persist();
    }
  }

  /** The disk cap every put reserves in. Set once, by the seeder, after `load`. */
  attach(diskCap: DiskCap): void {
    if (this.diskCap !== null) throw new Error('NfxFileStore: a disk cap is attached already');
    this.diskCap = diskCap;
  }

  /** Bytes of every stored file, each counted once. */
  totalBytes(): number {
    let n = 0;
    for (const r of this.refs.values()) n += r.size;
    return n;
  }

  has(sha256: string): boolean {
    return this.refs.has(sha256);
  }

  sizeOf(sha256: string): number | undefined {
    return this.refs.get(sha256)?.size;
  }

  /** A stored file's bytes, or `null` when this store does not hold it. */
  readFile(sha256: string): Promise<Uint8Array | null> {
    return this.refs.has(sha256) ? this.fs.readFile(this.pathOf(sha256)) : Promise.resolve(null);
  }

  /** A stored file as a stream, or `null` when this store does not hold it. */
  readStream(sha256: string): AsyncIterable<Uint8Array> | null {
    return this.refs.has(sha256) ? this.fs.readStream(this.pathOf(sha256)) : null;
  }

  video(addr: string): NfxStoredVideo | undefined {
    return this.byVideo.get(addr);
  }

  videos(): readonly NfxStoredVideo[] {
    return [...this.byVideo.values()];
  }

  /**
   * Store a packaged video: verify its hash list, then write each listed file it does not hold
   * yet, checked against the list. All or nothing: a failure removes what this put wrote and
   * releases its reservation. The same address with the same `root` is a no-op.
   *
   * The first put for an address wins, and a later `root` for it is refused (`conflict`), so a
   * caller storing what a PEER sent must take `video` and `root` from a manifest it verified
   * (NFX-02, signed by the video's author), never from the peer's word (slice 5).
   */
  putVideo(input: NfxVideoInput): Promise<NfxPutResult> {
    return this.serial(() => this.put(input));
  }

  /** Forget a video; delete the files no other video lists, and free their bytes. */
  removeVideo(addr: string): Promise<boolean> {
    return this.serial(async () => {
      const cap = this.ready();
      const v = this.byVideo.get(addr);
      if (v === undefined) return false;
      this.byVideo.delete(addr);
      const freed: NfxStoredFile[] = [];
      for (const f of uniqueFiles(v)) {
        const r = this.refs.get(f.sha256);
        if (r === undefined) continue;
        r.count -= 1;
        if (r.count > 0) continue;
        this.refs.delete(f.sha256);
        freed.push({ sha256: f.sha256, size: r.size });
      }
      // Files first, then the index: a crash between leaves a record whose file is missing,
      // which a load drops; never a file that no record names.
      for (const f of freed) {
        await this.unlinkQuietly(this.pathOf(f.sha256));
        cap.free(f.size);
      }
      await this.persist().catch((err: unknown) => {
        this.log.error('NFX index not saved after a removal; the next load drops it', {
          video: addr,
          error: err,
        });
      });
      this.log.info('NFX video removed', { video: addr, files: freed.length });
      return true;
    });
  }

  private async put(input: NfxVideoInput): Promise<NfxPutResult> {
    const cap = this.ready();
    if (this.loadError !== null) return fail({ code: 'unavailable' });
    if (!isHex(input.root, 32)) return fail({ code: 'hash-list', reason: 'root is not hex' });
    if (input.hashListBytes.byteLength > nfx.MAX_HASH_LIST_BYTES)
      return fail({ code: 'hash-list', reason: 'the hash list is too large' });
    // Copies: the caller's buffers may change after they are checked.
    const listBytes = input.hashListBytes.slice();
    const verified = nfx.verifyHashList(listBytes, input.root, input.video, input.segs);
    if (!verified.ok) return fail({ code: 'hash-list', reason: verified.error.reason });
    const addr = input.video.toString();

    const existing = this.byVideo.get(addr);
    if (existing !== undefined) {
      return existing.root === input.root
        ? { ok: true, video: existing, deduplicated: true }
        : fail({ code: 'conflict', root: existing.root });
    }

    const listed: { readonly entry: nfx.FileEntry; readonly file: NfxStoredFile }[] = [];
    for (const entry of verified.value.files) {
      if (entry.size > BigInt(Number.MAX_SAFE_INTEGER))
        return fail({ code: 'hash-list', reason: `${entry.name} is too large` });
      listed.push({ entry, file: { sha256: entry.sha256 as Sha256Hex, size: Number(entry.size) } });
    }
    const video: NfxStoredVideo = {
      video: addr,
      root: input.root,
      listSize: listBytes.byteLength,
      files: listed.map((l) => l.file),
      addedAt: this.now(),
    };

    // One size per sha256, within the list (the hash list itself included) and against what
    // is stored: a record never disagrees with the bytes it names.
    const sizes = new Map<string, number>();
    for (const f of filesOf(video)) {
      const seen = sizes.get(f.sha256) ?? this.refs.get(f.sha256)?.size;
      if (seen !== undefined && seen !== f.size)
        return fail({ code: 'hash-list', reason: `${f.sha256} is listed at another size` });
      sizes.set(f.sha256, f.size);
    }

    // What this put must write: each file this store does not hold yet, once.
    const toWrite = new Map<string, { size: number; entry: nfx.FileEntry | null }>();
    for (const { entry, file } of listed)
      if (!this.refs.has(file.sha256) && !toWrite.has(file.sha256))
        toWrite.set(file.sha256, { size: file.size, entry });
    if (!this.refs.has(input.root) && !toWrite.has(input.root))
      toWrite.set(input.root, { size: video.listSize, entry: null });

    let needed = 0;
    for (const w of toWrite.values()) needed += w.size;
    const reservation = cap.reserve(needed);
    if (reservation === null) {
      this.log.warn('disk cap reached — refusing NFX video', { video: addr, needed });
      return fail({ code: 'disk-cap', needed, free: cap.freeBytes });
    }

    const written: string[] = [];
    const undo = async (): Promise<void> => {
      reservation.release();
      for (const sha of written) {
        await this.unlinkQuietly(this.pathOf(sha));
        await this.unlinkQuietly(this.tmpOf(sha));
      }
      written.length = 0;
      this.pending = null;
      await this.persist().catch(() => undefined);
    };
    try {
      this.pending = { ...video, pending: true };
      await this.persist();
      for (const [sha, w] of toWrite) {
        const bytes = w.entry === null ? listBytes : (await input.read(w.entry)).slice();
        if (bytes.byteLength !== w.size || this.sha256(bytes) !== sha) {
          await undo();
          return fail({ code: 'hash-mismatch', sha256: sha as Sha256Hex });
        }
        written.push(sha);
        await this.writeAtomic(sha, bytes);
      }
      this.pending = null;
      this.keep(video);
      await this.persist();
    } catch (err) {
      if (this.byVideo.get(addr) === video) this.unkeep(video);
      await undo();
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('NFX video write failed', { video: addr, error: err });
      return fail({ code: 'write-failed', message });
    }
    reservation.commit();
    this.log.info('NFX video stored', { video: addr, files: video.files.length, bytes: needed });
    return { ok: true, video, deduplicated: false };
  }

  private keep(v: NfxStoredVideo): void {
    this.byVideo.set(v.video, v);
    for (const f of uniqueFiles(v)) {
      const r = this.refs.get(f.sha256);
      if (r === undefined) this.refs.set(f.sha256, { size: f.size, count: 1 });
      else r.count += 1;
    }
  }

  /** Undo a `keep` whose index write failed. */
  private unkeep(v: NfxStoredVideo): void {
    this.byVideo.delete(v.video);
    for (const f of uniqueFiles(v)) {
      const r = this.refs.get(f.sha256);
      if (r === undefined) continue;
      r.count -= 1;
      if (r.count <= 0) this.refs.delete(f.sha256);
    }
  }

  private sha256(bytes: Uint8Array): string {
    const h = this.crypto.createSha256();
    h.update(bytes);
    return h.digestHex();
  }

  /** `sha256` is validated hex before any path is built from it. */
  private pathOf(sha256: string): string {
    if (!isHex(sha256, 32)) throw new Error('NfxFileStore: not a sha256');
    return this.fs.join(this.filesDir, sha256);
  }

  /** One temporary name per file, so a load can find what a crash mid-write left. */
  private tmpOf(sha256: string): string {
    return `${this.pathOf(sha256)}.tmp`;
  }

  private async writeAtomic(sha256: string, bytes: Uint8Array): Promise<void> {
    const tmp = this.tmpOf(sha256);
    await this.fs.writeFile(tmp, bytes);
    try {
      await this.fs.rename(tmp, this.pathOf(sha256));
    } catch (err) {
      await this.fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  private async unlinkQuietly(path: string): Promise<void> {
    if ((await this.fs.stat(path)) === null) return;
    await this.fs.unlink(path).catch((err: unknown) => {
      this.log.warn('NFX file could not be removed', { path, error: err });
    });
  }

  private persist(): Promise<void> {
    const videos: IndexVideo[] = [...this.byVideo.values()];
    if (this.pending !== null) videos.push(this.pending);
    return this.store.save({ version: 1, videos });
  }

  /** The attached disk cap, once loaded. */
  private ready(): DiskCap {
    if (!this.loaded) throw new Error('NfxFileStore: call load() first');
    if (this.diskCap === null) throw new Error('NfxFileStore: attach a disk cap first');
    return this.diskCap;
  }

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.chain.then(op, op);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

const fail = (error: NfxPutError): NfxPutResult => ({ ok: false, error });
