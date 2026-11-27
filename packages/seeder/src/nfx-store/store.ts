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
 * - Nothing is stored unverified: a video's hash list (at most 16 MiB) is checked against its
 *   `root` first (`nfx.verifyHashList`), and each file's size and sha256 against the hash
 *   list's entry, in memory, before it is written. The file list comes from the verified hash
 *   list, never from the caller, and buffers are copied before they are checked.
 * - One size per sha256: a list that gives one hash two sizes, or a size other than the one a
 *   stored file has, is refused, so a record never disagrees with the bytes it names (one that
 *   did would skew the cap and, at the next load, drop every video sharing the file).
 * - Paths are built only from validated lowercase-hex sha256 values.
 * - Disk cap (one pool with the legacy store): a put reserves the bytes of the files not
 *   already stored against the seeder's `DiskCap` and commits them when the video is recorded;
 *   a removal frees the bytes of files no other video lists.
 * - Crash safety: nothing may be left
 *   on disk that no record names. A put is recorded as `pending` before its first file is
 *   written, and a load removes a pending put's files and `.part` files; a removal deletes its
 *   files before it saves the record list. At load the size on disk decides which records are
 *   true: a record naming a missing file, or one of another size, is dropped with its video.
 * - A malformed record is dropped on its own; a `videos.json` that is not one (or of another
 *   version) is set aside, never written over. A store that cannot load is off
 *   (`loadError`, every put `unavailable`), and the seeder still starts.
 *
 * Kept videos (NFX-18, ADR 0026): what this node's user watched or downloaded, held by
 * rendition, in `kept.json` beside `videos.json`, never inside it. A build that predates them
 * never reads `kept.json`, so it cannot take a kept video for a whole one and announce every
 * rendition of it; the files are shared (one `files/` tree, one size per sha256, one disk cap).
 * - A kept record names the meta files (the hash list and every file that is not an init or a
 *   segment), the init and segments of each rendition it holds, and at most one `filling`
 *   rendition: the one being fetched, its files named before the first is written, and counted
 *   against the cap from then on, as if stored. So the rule above holds: nothing is on disk
 *   that no record names.
 * - Files arrive one at a time (`putKeptFile`), each checked against its entry before it is
 *   written; a rendition becomes held only when every meta file and every file of it is on disk
 *   (`completeKeep`). Only held renditions are served, and only files on disk.
 * - At load the disk decides again: a record holding a rendition whose meta or held files are
 *   missing or of another size is dropped; a filling rendition keeps the files it has and
 *   resumes (`keepMissing`), meta files included while nothing is held yet.
 * - A record keeps its reasons (`watched`, `downloaded`) and goes when the last is dropped;
 *   eviction (`evictable`) offers only records kept for `watched` alone, least recently used
 *   first. Downloaded and whole videos are never offered.
 */
import { nfx } from '@sovit/core';

import type { SeederCrypto } from '../adapters/crypto.js';
import type { SeederFs } from '../adapters/fs.js';
import type { DiskCap } from '../store/disk-cap.js';
import { JsonStore } from '../store/json-store.js';
import { isHex } from '../util/hex.js';

export const NFX_STORE_DIR = 'nfx' as const;
export const NFX_VIDEOS_FILE = 'videos.json' as const;
export const NFX_KEPT_FILE = 'kept.json' as const;

/** Why a video is kept (NFX-18 §1). A whole video (`videos.json`) is published or seeded. */
export type NfxKeepReason = 'watched' | 'downloaded';
const KEEP_REASONS: readonly NfxKeepReason[] = ['watched', 'downloaded'];

/** A video kept by rendition (NFX-18). Files are `{sha256, size}` as in a whole record. */
export interface NfxKeptRecord {
  /** `<namespace>:<video-id>` (NFX-01), canonical. */
  readonly video: string;
  readonly root: string;
  /** The manifest `segs`, as decimal text. */
  readonly segs: string;
  /** The hash list itself and every file that is not an init or a segment. */
  readonly meta: readonly NfxStoredFile[];
  /** Per rendition held whole: its init and segments. */
  readonly held: Readonly<Record<string, readonly NfxStoredFile[]>>;
  /** The rendition being fetched, and its init and segments (some not on disk yet). */
  readonly filling: { readonly rendition: string; readonly files: readonly NfxStoredFile[] } | null;
  /** When each reason was given (unix seconds). Never empty. */
  readonly reasons: Readonly<Partial<Record<NfxKeepReason, number>>>;
  /** Last played or asked for (unix seconds): eviction takes the oldest first. */
  readonly usedAt: number;
  readonly addedAt: number;
}

interface KeptFile {
  readonly version: 1;
  readonly videos: readonly NfxKeptRecord[];
  /** Files of a committed abandonment, until cleanup succeeds. */
  readonly cleanup?: readonly string[];
  /** Records refused at load (malformed, or an address given twice). Never saved. */
  readonly dropped?: number;
}

export interface NfxKeepBegin {
  readonly video: nfx.VideoAddr;
  /** sha256 of `hashListBytes` (the manifest `root`). */
  readonly root: string;
  readonly segs: bigint;
  readonly hashListBytes: Uint8Array;
  /** The rendition to hold, by id. */
  readonly rendition: string;
  /** That rendition's playlist, as the verified hash list lists it: it names the files. */
  readonly playlistBytes: Uint8Array;
  readonly reason: NfxKeepReason;
}

export type NfxKeepError =
  | NfxPutError
  /** The rendition is not in the hash list, or its playlist is not the listed bytes. */
  | 'rendition'
  /** Another rendition of this video is being fetched: one at a time per video. */
  | 'busy'
  /** Not kept, or not filling. */
  | 'unknown'
  /** `sha` is not a file this video's filling rendition or meta still needs. */
  | 'unwanted';

/** `held`: nothing to fetch. `filling`: `missing` lists what is not on disk yet. */
export type NfxKeepResult =
  | {
      readonly ok: true;
      readonly state: 'whole' | 'held';
      readonly missing: readonly NfxStoredFile[];
    }
  | {
      readonly ok: true;
      readonly state: 'filling';
      readonly missing: readonly NfxStoredFile[];
      /** Identity of this fill in the open store. */
      readonly fillId: symbol;
    }
  | { readonly ok: false; readonly error: NfxKeepError; readonly message: string };

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

/** A record as `videos.json` keeps it: `pending` while its put is writing files. */
interface StoredRecord extends NfxVideoRecord {
  readonly pending?: true;
}

interface VideosFile {
  readonly version: 1;
  readonly videos: readonly StoredRecord[];
  /** Records refused at load (malformed, or an address given twice). Never saved. */
  readonly dropped?: number;
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
  | 'io'
  /** The store could not load (`loadError`): NFX is off until a restart that loads. */
  | 'unavailable';

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

function validateRecord(v: unknown): StoredRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const video = r['video'];
  const root = r['root'];
  const segs = r['segs'];
  const addedAt = r['addedAt'];
  const pending = r['pending'];
  if (typeof video !== 'string' || !canonicalAddress(video)) return null;
  if (typeof root !== 'string' || !SHA.test(root)) return null;
  if (typeof segs !== 'string' || !DECIMAL.test(segs)) return null;
  if (!Number.isSafeInteger(addedAt) || (addedAt as number) < 0) return null;
  if (pending !== undefined && pending !== true) return null;
  if (!Array.isArray(r['files'])) return null;
  const files: NfxStoredFile[] = [];
  const seen = new Set<string>();
  for (const f of r['files'] as unknown[]) {
    if (typeof f !== 'object' || f === null) return null;
    const e = f as Record<string, unknown>;
    const sha = e['sha256'];
    const size = e['size'];
    if (typeof sha !== 'string' || !SHA.test(sha) || seen.has(sha)) return null;
    if (!Number.isSafeInteger(size) || (size as number) < 0) return null;
    seen.add(sha);
    files.push({ sha256: sha, size: size as number });
  }
  if (!seen.has(root)) return null;
  return {
    video,
    root,
    segs,
    files,
    addedAt: addedAt as number,
    ...(pending === true ? { pending: true as const } : {}),
  };
}

/**
 * Record by record: a malformed record, or a second one for an address, is dropped on its own
 * (its files are not trusted, so it keeps nothing alive). `null` only when the file is not a
 * record list at all, or of another version.
 */
function validateVideosFile(raw: unknown): VideosFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o['version'] !== 1 || !Array.isArray(o['videos'])) return null;
  const videos: StoredRecord[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const v of o['videos'] as unknown[]) {
    const r = validateRecord(v);
    if (r === null || seen.has(r.video)) {
      dropped += 1;
      continue;
    }
    seen.add(r.video);
    videos.push(r);
  }
  return { version: 1, videos, dropped };
}

/** A list of distinct `{sha256, size}`; `null` if anything is off. */
function validateFiles(v: unknown, nonEmpty: boolean): NfxStoredFile[] | null {
  if (!Array.isArray(v) || (nonEmpty && v.length === 0)) return null;
  const out: NfxStoredFile[] = [];
  const seen = new Set<string>();
  for (const f of v as unknown[]) {
    if (typeof f !== 'object' || f === null) return null;
    const e = f as Record<string, unknown>;
    const sha = e['sha256'];
    const size = e['size'];
    if (typeof sha !== 'string' || !SHA.test(sha) || seen.has(sha)) return null;
    if (!Number.isSafeInteger(size) || (size as number) < 0) return null;
    seen.add(sha);
    out.push({ sha256: sha, size: size as number });
  }
  return out;
}

/** The rendition IDs supported by the kept store. */
function renditionId(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= 64 &&
    v !== nfx.RESERVED_RENDITION_ID &&
    !Object.prototype.hasOwnProperty.call(Object.prototype, v)
  );
}

function stamp(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0;
}

function validateKeptRecord(v: unknown): NfxKeptRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const { video, root, segs, usedAt, addedAt } = r;
  if (typeof video !== 'string' || !canonicalAddress(video)) return null;
  if (typeof root !== 'string' || !SHA.test(root)) return null;
  if (typeof segs !== 'string' || !DECIMAL.test(segs)) return null;
  if (!stamp(usedAt) || !stamp(addedAt)) return null;
  const meta = validateFiles(r['meta'], true);
  if (!meta?.some((f) => f.sha256 === root)) return null;
  const heldRaw = r['held'];
  if (typeof heldRaw !== 'object' || heldRaw === null || Array.isArray(heldRaw)) return null;
  const held: Record<string, readonly NfxStoredFile[]> = {};
  for (const [id, files] of Object.entries(heldRaw)) {
    const list = validateFiles(files, true);
    if (!renditionId(id) || list === null) return null;
    held[id] = list;
  }
  let filling: NfxKeptRecord['filling'] = null;
  if (r['filling'] !== null) {
    if (typeof r['filling'] !== 'object' || Array.isArray(r['filling'])) return null;
    const f = r['filling'] as Record<string, unknown>;
    const files = validateFiles(f['files'], true);
    const rendition = f['rendition'];
    if (!renditionId(rendition) || files === null || Object.hasOwn(held, rendition)) return null;
    filling = { rendition, files };
  }
  const sizes = new Map<string, number>();
  for (const files of [meta, ...Object.values(held), filling?.files ?? []])
    for (const { sha256, size } of files) {
      const previous = sizes.get(sha256);
      if (previous !== undefined && previous !== size) return null;
      sizes.set(sha256, size);
    }
  const reasonsRaw = r['reasons'];
  if (typeof reasonsRaw !== 'object' || reasonsRaw === null || Array.isArray(reasonsRaw))
    return null;
  const reasons: Partial<Record<NfxKeepReason, number>> = {};
  for (const [k, at] of Object.entries(reasonsRaw)) {
    if (!KEEP_REASONS.includes(k as NfxKeepReason) || !stamp(at)) return null;
    reasons[k as NfxKeepReason] = at;
  }
  if (Object.keys(reasons).length === 0) return null;
  if (Object.keys(held).length === 0 && filling === null) return null;
  return { video, root, segs, meta, held, filling, reasons, usedAt, addedAt };
}

/** As `validateVideosFile`, for `kept.json`. */
function validateKeptFile(raw: unknown): KeptFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o['version'] !== 1 || !Array.isArray(o['videos'])) return null;
  const videos: NfxKeptRecord[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const v of o['videos'] as unknown[]) {
    const r = validateKeptRecord(v);
    if (r === null || seen.has(r.video)) {
      dropped += 1;
      continue;
    }
    seen.add(r.video);
    videos.push(r);
  }
  const cleanup = o['cleanup'];
  if (
    cleanup !== undefined &&
    (!Array.isArray(cleanup) ||
      !cleanup.every((sha: unknown) => typeof sha === 'string' && SHA.test(sha)))
  )
    return null;
  return { version: 1, videos, dropped, ...(cleanup === undefined ? {} : { cleanup }) };
}

/** Every file a kept record names, each once (a sha may serve two renditions). */
function keptFiles(r: NfxKeptRecord): NfxStoredFile[] {
  const out = new Map<string, NfxStoredFile>();
  for (const f of r.meta) out.set(f.sha256, f);
  for (const files of Object.values(r.held)) for (const f of files) out.set(f.sha256, f);
  for (const f of r.filling?.files ?? []) out.set(f.sha256, f);
  return [...out.values()];
}

/** The files a kept record serves: its meta files and those of the renditions it holds. */
function heldFiles(r: NfxKeptRecord): Set<string> {
  const out = new Set(r.meta.map((f) => f.sha256));
  for (const files of Object.values(r.held)) for (const f of files) out.add(f.sha256);
  return out;
}

/** A loaded record as the store holds it: never `pending`. */
function withoutPending(r: StoredRecord): NfxVideoRecord {
  return { video: r.video, root: r.root, segs: r.segs, files: r.files, addedAt: r.addedAt };
}

function canonicalAddress(text: string): boolean {
  const parsed = nfx.VideoAddr.parse(text);
  return parsed.ok && parsed.value.toString() === text;
}

export class NfxStore {
  private readonly records = new Map<string, NfxVideoRecord>();
  /** Kept videos (NFX-18), by address. */
  private readonly kept = new Map<string, NfxKeptRecord>();
  /** Per kept video holding a rendition: the files it serves (`heldFiles`). */
  private readonly keptServes = new Map<string, Set<string>>();
  /**
   * sha256 → size, for every file at least one record names: every file of a whole video, and
   * every file a kept one names, a filling rendition's included (counted against the cap).
   */
  private readonly sizes = new Map<string, number>();
  /** The named files that are on disk, verified: a filling rendition's arrive one by one. */
  private readonly present = new Set<string>();
  private readonly db: JsonStore<VideosFile>;
  private readonly keptDb: JsonStore<KeptFile>;
  /** A kept record changed only in memory (`touchKept`): saved with the next save. */
  private keptDirty = false;
  private keptGeneration = 0;
  private keptWritable = true;
  private readonly fillIds = new WeakMap<NonNullable<NfxKeptRecord['filling']>, symbol>();
  private readonly keepCleanup = new Set<string>();
  /**
   * Bytes of journaled cleanup files that may still be on disk, charged to the cap until their
   * deletion succeeds. For a hash a record names again, the record's size is charged and this
   * holds only what the file takes beyond it, until a verified write shrinks it: the cap holds the
   * larger of the two.
   */
  private readonly cleanupBytes = new Map<string, number>();
  private readonly root: string;
  private readonly now: () => number;
  private cap: DiskCap | null = null;
  /** Mutations run one at a time (a put's reads and writes span awaits). */
  private chain: Promise<unknown> = Promise.resolve();
  /** The put in progress, saved as a `pending` record before its first file is written. */
  private pending: StoredRecord | null = null;
  private loaded = false;
  /** `videos.json` was not a record list (or of another version) and was set aside. */
  corruptOnLoad = false;
  /** Records dropped at load: malformed, or naming a file missing or of another size. */
  droppedOnLoad = 0;
  /** `kept.json` was not a record list (or of another version) and was set aside. */
  keptCorruptOnLoad = false;
  /** Kept records dropped at load: malformed, or a meta or held file missing or wrong. */
  keptDroppedOnLoad = 0;
  /** Why `load` failed; the store then holds nothing and every put is `unavailable`. */
  loadError: string | null = null;

  constructor(private readonly o: NfxStoreOptions) {
    this.root = o.fs.join(o.dataDir, NFX_STORE_DIR);
    this.db = new JsonStore<VideosFile>(
      o.fs,
      o.crypto,
      this.videosPath(),
      validateVideosFile,
      () => ({ version: 1, videos: [] }),
    );
    this.keptDb = new JsonStore<KeptFile>(
      o.fs,
      o.crypto,
      this.keptPath(),
      validateKeptFile,
      () => ({ version: 1, videos: [] }),
    );
    this.now = o.now ?? ((): number => Math.floor(Date.now() / 1000));
  }

  /** Never throws: a store that cannot load is off (`loadError`), and the seeder still starts. */
  async load(): Promise<void> {
    try {
      await this.loadRecords();
    } catch (err) {
      this.records.clear();
      this.kept.clear();
      this.keptServes.clear();
      this.sizes.clear();
      this.present.clear();
      this.loadError = err instanceof Error ? err.message : String(err);
    }
    this.loaded = true;
  }

  private async loadRecords(): Promise<void> {
    const fs = this.o.fs;
    await fs.mkdir(fs.join(this.root, 'files'), { recursive: true });
    await fs.mkdir(fs.join(this.root, 'tmp'), { recursive: true });
    const { value, corrupt } = await this.db.load();
    this.corruptOnLoad = corrupt;
    if (corrupt && (await fs.stat(this.videosPath())) !== null) {
      // Kept for a person to read (a newer version's list, a damaged file), never written over.
      await fs.rename(
        this.videosPath(),
        `${this.videosPath()}.unreadable-${this.o.crypto.randomHex(4)}`,
      );
    }
    this.records.clear();
    const done = value.videos.filter((r) => r.pending !== true);
    const interrupted = value.videos.filter((r) => r.pending === true);

    // The size on disk decides: a record naming a file that is missing, not a file, or of
    // another size is wrong, and its video is dropped; a record that agrees keeps its video.
    const onDisk = new Map<string, number | null>();
    for (const r of done)
      for (const f of r.files) {
        if (onDisk.has(f.sha256)) continue;
        const st = await fs.stat(this.filePath(f.sha256));
        onDisk.set(f.sha256, st?.isFile ? st.size : null);
      }
    const kept = done.filter((r) => r.files.every((f) => onDisk.get(f.sha256) === f.size));
    this.droppedOnLoad = (value.dropped ?? 0) + done.length - kept.length;
    for (const r of kept) this.records.set(r.video, withoutPending(r));
    this.recount();
    this.present.clear();
    for (const sha of this.sizes.keys()) this.present.add(sha);

    // Kept videos, before anything is removed: a file only a kept record names is not a
    // dropped whole video's to delete.
    let keptLoad: Awaited<ReturnType<typeof this.keptDb.load>>;
    try {
      keptLoad = await this.keptDb.load();
      this.keptCorruptOnLoad = keptLoad.corrupt;
      if (keptLoad.corrupt) {
        await fs.rename(
          this.keptPath(),
          `${this.keptPath()}.unreadable-${this.o.crypto.randomHex(4)}`,
        );
      }
    } catch {
      // The kept database could not be read or set aside. Keep serving whole videos and
      // leave the database and any final files it might name untouched until the next load.
      this.keptWritable = false;
      await this.cleanParts().catch(() => undefined);
      return;
    }
    this.kept.clear();
    this.keptServes.clear();
    const keptAll = keptLoad.value.videos;
    for (const sha of keptLoad.value.cleanup ?? []) this.keepCleanup.add(sha);
    for (const r of keptAll)
      for (const f of keptFiles(r)) {
        if (onDisk.has(f.sha256)) continue;
        const st = await fs.stat(this.filePath(f.sha256));
        onDisk.set(f.sha256, st?.isFile ? st.size : null);
      }
    // A record stays if it names no file at another size than any other record does and, once
    // it holds a rendition, every meta and held file is on disk at its size. A record that only
    // fills keeps what it has, meta files included, and resumes.
    const named = new Map(this.sizes);
    let keptDropped = keptLoad.value.dropped ?? 0;
    for (const r of keptAll) {
      const files = keptFiles(r);
      const served = Object.keys(r.held).length > 0 ? heldFiles(r) : new Set<string>();
      const ok =
        !this.records.has(r.video) &&
        files.every((f) => (named.get(f.sha256) ?? f.size) === f.size) &&
        files.every((f) => !served.has(f.sha256) || onDisk.get(f.sha256) === f.size);
      if (!ok) {
        keptDropped += 1;
        continue;
      }
      for (const f of files) named.set(f.sha256, f.size);
      this.setKept(r);
    }
    this.keptDroppedOnLoad = keptDropped;
    this.recount();
    for (const r of this.kept.values())
      for (const f of keptFiles(r)) if (onDisk.get(f.sha256) === f.size) this.present.add(f.sha256);

    // Remove final files of dropped and interrupted records that no surviving record names.
    const candidates = new Set<string>();
    for (const r of [...done, ...interrupted]) for (const f of r.files) candidates.add(f.sha256);
    for (const r of keptAll) for (const f of keptFiles(r)) candidates.add(f.sha256);
    for (const sha of candidates) {
      if (this.present.has(sha)) continue;
      if (!this.sizes.has(sha)) await this.unlinkQuietly(this.filePath(sha));
    }
    await this.cleanParts();
    // A journaled file still on disk takes space: charged (in `totalBytes`) until it is gone.
    for (const sha of this.keepCleanup) {
      const st = await fs.stat(this.filePath(sha));
      if (st?.isFile) this.cleanupBytes.set(sha, st.size);
    }
    const cleaned = await this.cleanAbandonedFiles();
    if (this.droppedOnLoad > 0 || interrupted.length > 0 || corrupt) await this.persist();
    if (keptDropped > 0 || keptLoad.corrupt || cleaned) {
      this.keptDirty = true;
      await this.persistKept().catch(() => undefined);
    }
  }

  /**
   * Count puts and removals against `cap` from now on. The cap's starting `committed` must
   * already include `totalBytes()` (the seeder sizes it from both stores).
   */
  attachCap(cap: DiskCap): void {
    this.cap = cap;
  }

  /**
   * Bytes of every stored file, each once however many videos list it, and what cleanup files
   * not deleted yet take beyond that.
   */
  totalBytes(): number {
    let n = 0;
    for (const size of this.sizes.values()) n += size;
    for (const [sha, size] of this.cleanupBytes)
      n += Math.max(0, size - (this.sizes.get(sha) ?? 0));
    return n;
  }

  videos(): readonly NfxVideoRecord[] {
    return [...this.records.values()];
  }

  get(video: nfx.VideoAddr): NfxVideoRecord | undefined {
    return this.records.get(video.toString());
  }

  /** Stored whole, or kept with at least one rendition held. */
  hasVideo(video: nfx.VideoAddr): boolean {
    const key = video.toString();
    return this.records.has(key) || this.keptServes.has(key);
  }

  /**
   * File `sha` of `video`: only a file that video's verified hash list lists (or the hash list
   * itself, `sha` = root). `undefined` for anything else, even a file stored for another video.
   * For a kept video, only a meta file or a file of a rendition it holds, and only on disk.
   */
  file(video: nfx.VideoAddr, sha: string): NfxStoreFile | undefined {
    if (!SHA.test(sha)) return undefined;
    const size = this.servedSize(video.toString(), sha);
    if (size === undefined) return undefined;
    const path = this.filePath(sha);
    return {
      size,
      read: (offset, length) => this.readRange(path, size, offset, length),
    };
  }

  /** The size of file `sha` if `key`'s record serves it (`file`'s rule), else `undefined`. */
  private servedSize(key: string, sha: string): number | undefined {
    const entry = this.records.get(key)?.files.find((f) => f.sha256 === sha);
    if (entry !== undefined) return entry.size;
    if (this.keptServes.get(key)?.has(sha) !== true || !this.present.has(sha)) return undefined;
    return this.sizes.get(sha);
  }

  /**
   * The renditions served for `video`: `'all'` for a whole video, the held ids (sorted) for a
   * kept one, `undefined` when nothing is served. What a beacon may announce (NFX-03 §4).
   */
  servedRenditions(video: nfx.VideoAddr): 'all' | readonly string[] | undefined {
    const key = video.toString();
    if (this.records.has(key)) return 'all';
    const r = this.kept.get(key);
    if (r === undefined || !this.keptServes.has(key)) return undefined;
    return Object.keys(r.held).sort();
  }

  /**
   * Where file `sha` of `video` lies on disk, for a transport that reads files in place (the
   * iroh helper imports them by reference, ADR 0021): only a file that video's verified hash
   * list lists (or the hash list itself), as `file` answers. `undefined` for anything else, even
   * a file stored for another video. The path is under `dataDir`, so absolute when it is.
   */
  path(video: nfx.VideoAddr, sha: string): string | undefined {
    if (!SHA.test(sha)) return undefined;
    return this.servedSize(video.toString(), sha) === undefined ? undefined : this.filePath(sha);
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

  // ---- Kept videos (NFX-18) ----

  /** Every kept video. */
  keptVideos(): readonly NfxKeptRecord[] {
    return [...this.kept.values()];
  }

  keptOf(video: nfx.VideoAddr): NfxKeptRecord | undefined {
    return this.kept.get(video.toString());
  }

  /** What a filling rendition still needs (meta files included); `[]` if none. */
  keepMissing(video: nfx.VideoAddr): readonly NfxStoredFile[] {
    const r = this.kept.get(video.toString());
    return r === undefined ? [] : this.missingOf(r);
  }

  /**
   * Kept videos the cap may take, most evictable first: those kept for `watched` alone, least
   * recently used first. The caller leaves out what is playing. Downloaded videos and whole
   * ones are never offered (NFX-18 §2.4).
   */
  evictable(): readonly string[] {
    return [...this.kept.values()]
      .filter((r) => Object.keys(r.reasons).every((k) => k === 'watched'))
      .sort((a, b) => a.usedAt - b.usedAt || (a.video < b.video ? -1 : 1))
      .map((r) => r.video);
  }

  /**
   * Start holding `rendition` of a video, for `reason`: the hash list is verified against its
   * root, the playlist against its entry, and the files the rendition needs are named and
   * counted against the cap before any is written. The hash list and playlist are written at
   * once. Already held: the reason is added. One rendition fills at a time per video (`busy`).
   */
  beginKeep(input: NfxKeepBegin): Promise<NfxKeepResult> {
    return this.serialize(() => this.begin(input));
  }

  /**
   * One file of a filling rendition (or a meta file it lacks), checked against its entry and
   * written. `remaining`: how many are still missing. A file already on disk is not rewritten.
   */
  putKeptFile(
    video: nfx.VideoAddr,
    fillId: symbol,
    sha: string,
    bytes: Uint8Array,
  ): Promise<
    | { readonly ok: true; readonly remaining: number }
    | { readonly ok: false; readonly error: NfxKeepError; readonly message: string }
  > {
    return this.serialize(() => this.putKept(video, fillId, sha, bytes));
  }

  /** The filling rendition becomes held, once every file it needs is on disk. */
  completeKeep(video: nfx.VideoAddr, fillId: symbol): Promise<NfxKeepResult> {
    return this.serialize(() => this.complete(video, fillId));
  }

  /**
   * Stop filling: its files that nothing else names are removed and freed. A record that held
   * nothing else goes with it.
   */
  abandonKeep(video: nfx.VideoAddr): Promise<boolean> {
    return this.serialize(async () => {
      this.assertLoaded();
      const key = video.toString();
      const r = this.kept.get(key);
      if (r === undefined || r.filling === null) return false;
      const next = Object.keys(r.held).length === 0 ? null : { ...r, filling: null };
      const videos = this.keptVideos().filter((record) => record.video !== key);
      if (next !== null) videos.push(next);
      const named = new Set<string>();
      for (const record of this.records.values()) for (const f of record.files) named.add(f.sha256);
      for (const record of videos) for (const f of keptFiles(record)) named.add(f.sha256);
      const removed = keptFiles(r).filter((f) => !named.has(f.sha256));
      const cleanup = new Set([...this.keepCleanup, ...removed.map((f) => f.sha256)]);
      // Commit the new record list and its cleanup together. Until this succeeds, the
      // original fill is still resumable and no files have been touched.
      await this.persistKept(videos, cleanup);
      if (next === null) this.deleteKept(key);
      else this.setKept({ ...next, usedAt: this.kept.get(key)?.usedAt ?? next.usedAt });
      // Still charged: freed once each file is gone (`cleanAbandonedFiles`).
      for (const { sha256, size } of removed) {
        this.keepCleanup.add(sha256);
        this.present.delete(sha256);
        // The larger charge stays: a recovered file may be bigger than its listed size.
        this.cleanupBytes.set(sha256, Math.max(this.cleanupBytes.get(sha256) ?? 0, size));
      }
      this.recount();
      if (await this.cleanAbandonedFiles()) this.keptDirty = true;
      return true;
    });
  }

  /** Add `reason` to a kept video (and mark it used). `false` if it is not kept. */
  addKeepReason(video: nfx.VideoAddr, reason: NfxKeepReason): Promise<boolean> {
    return this.serialize(async () => {
      this.assertLoaded();
      const key = video.toString();
      const r = this.kept.get(key);
      if (r === undefined) return false;
      const now = this.now();
      this.setKept({
        ...r,
        reasons: { ...r.reasons, [reason]: r.reasons[reason] ?? now },
        usedAt: now,
      });
      await this.persistKept();
      return true;
    });
  }

  /**
   * Drop `reason`; with no reason left the video goes, and its files that nothing else names.
   * `false` if it is not kept for that reason.
   */
  dropKeepReason(video: nfx.VideoAddr, reason: NfxKeepReason): Promise<boolean> {
    return this.serialize(async () => {
      this.assertLoaded();
      const key = video.toString();
      const r = this.kept.get(key);
      if (r?.reasons[reason] === undefined) return false;
      const reasons: NfxKeptRecord['reasons'] = Object.fromEntries(
        Object.entries(r.reasons).filter(([k]) => k !== reason),
      );
      if (Object.keys(reasons).length === 0) await this.replaceKept(key, null);
      else {
        this.setKept({ ...r, reasons });
        await this.persistKept();
      }
      return true;
    });
  }

  /** Forget a kept video whatever its reasons (eviction): `false` if it is not kept. */
  removeKept(video: nfx.VideoAddr): Promise<boolean> {
    return this.serialize(async () => {
      this.assertLoaded();
      const key = video.toString();
      if (!this.kept.has(key)) return false;
      await this.replaceKept(key, null);
      return true;
    });
  }

  /** Mark a kept video used now (a play): saved with the next save, or `flushKept`. */
  touchKept(video: nfx.VideoAddr): void {
    const r = this.kept.get(video.toString());
    if (r === undefined) return;
    this.setKept({ ...r, usedAt: this.now() });
    this.keptGeneration += 1;
    this.keptDirty = true;
  }

  /** Save what `touchKept` changed. */
  flushKept(): Promise<void> {
    return this.serialize(async () => {
      if (this.loadError !== null || !this.keptWritable) return;
      if (await this.cleanAbandonedFiles()) this.keptDirty = true;
      if (this.keptDirty) await this.persistKept();
    });
  }

  private async begin(input: NfxKeepBegin): Promise<NfxKeepResult> {
    this.assertLoaded();
    const fail = (error: NfxKeepError, message: string): NfxKeepResult => ({
      ok: false,
      error,
      message,
    });
    if (this.loadError !== null || !this.keptWritable)
      return fail('unavailable', 'the kept store did not load');
    if (!renditionId(input.rendition)) return fail('rendition', 'unsupported rendition id');
    const key = input.video.toString();
    if (!SHA.test(input.root)) return fail('invalid', 'root is not 64 lowercase hex');
    if (input.hashListBytes.byteLength > nfx.MAX_HASH_LIST_BYTES)
      return fail('invalid', 'the hash list is larger than 16 MiB');
    const whole = this.records.get(key);
    if (whole !== undefined) {
      return whole.root === input.root
        ? { ok: true, state: 'whole', missing: [] }
        : fail('exists', 'the video is stored with another hash list');
    }
    const known = this.kept.get(key);
    if (known !== undefined && known.root !== input.root)
      return fail('exists', 'the video is kept with another hash list');
    // Copies: the caller's buffers may change after they are checked.
    const listBytes = new Uint8Array(input.hashListBytes);
    const verified = nfx.verifyHashList(listBytes, input.root, input.video, input.segs);
    if (!verified.ok) return fail('invalid', verified.error.reason);
    const list = verified.value;
    const rendition = list.renditions.find((r) => r.id === input.rendition);
    const playlist =
      rendition === undefined
        ? undefined
        : list.files.find((f) => f.role === 'playlist' && f.name === rendition.playlist);
    const playlistBytes = new Uint8Array(input.playlistBytes);
    if (
      playlist?.size !== BigInt(playlistBytes.byteLength) ||
      this.sha256(playlistBytes) !== playlist.sha256
    ) {
      return fail('rendition', 'no such rendition, or its playlist is not the listed bytes');
    }
    const members = nfx.renditionMembers(list, playlistBytes);
    if (!members.ok) return fail('rendition', members.error.reason);

    const now = this.now();
    if (known !== undefined) {
      const reasons = { ...known.reasons, [input.reason]: known.reasons[input.reason] ?? now };
      if (
        Object.hasOwn(known.held, input.rendition) ||
        known.filling?.rendition === input.rendition
      ) {
        const record = { ...known, reasons, usedAt: now };
        this.setKept(record);
        try {
          await this.persistKept();
        } catch {
          this.setKept(known);
          return fail('io', 'could not record the reason');
        }
        // The state of the rendition asked for, not of another one filling meanwhile.
        return Object.hasOwn(known.held, input.rendition)
          ? { ok: true, state: 'held', missing: [] }
          : this.fillingResult(record);
      }
      if (known.filling !== null)
        return fail('busy', `rendition ${known.filling.rendition} is being fetched`);
    }

    // The files, each hash once and at one size: within the list, and against what is stored.
    const sizes = new Map<string, number>();
    const add = (sha: string, size: bigint | number): boolean => {
      if (typeof size === 'bigint' && size > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      const n = Number(size);
      const seen = sizes.get(sha) ?? this.sizes.get(sha);
      if (seen !== undefined && seen !== n) return false;
      sizes.set(sha, n);
      return true;
    };
    const meta: NfxStoredFile[] = [];
    const own: NfxStoredFile[] = [];
    if (!add(input.root, listBytes.byteLength))
      return fail('invalid', 'the hash list is stored at another size');
    meta.push({ sha256: input.root, size: listBytes.byteLength });
    for (const f of list.files) {
      if (f.role === 'init' || f.role === 'segment') continue;
      if (!add(f.sha256, f.size)) return fail('invalid', `${f.name} is listed at another size`);
      if (!meta.some((m) => m.sha256 === f.sha256))
        meta.push({ sha256: f.sha256, size: Number(f.size) });
    }
    for (const f of [members.value.init, ...members.value.segments]) {
      if (!add(f.sha256, f.size)) return fail('invalid', `${f.name} is listed at another size`);
      if (!own.some((m) => m.sha256 === f.sha256))
        own.push({ sha256: f.sha256, size: Number(f.size) });
    }
    let newBytes = 0;
    for (const [sha, size] of sizes) newBytes += this.newCharge(sha, size);
    const reservation = this.cap === null ? null : this.cap.reserve(newBytes);
    if (this.cap !== null && reservation === null)
      return fail('disk-cap', 'keeping the rendition would exceed the disk cap');

    const record: NfxKeptRecord =
      known === undefined
        ? {
            video: key,
            root: input.root,
            segs: input.segs.toString(),
            meta,
            held: {},
            filling: { rendition: input.rendition, files: own },
            reasons: { [input.reason]: now },
            usedAt: now,
            addedAt: now,
          }
        : {
            ...known,
            filling: { rendition: input.rendition, files: own },
            reasons: { ...known.reasons, [input.reason]: known.reasons[input.reason] ?? now },
            usedAt: now,
          };
    // Named and counted before the first byte is written.
    this.setKept(record);
    this.recount();
    try {
      await this.persistKept();
    } catch {
      if (known === undefined) this.deleteKept(key);
      else this.setKept(known);
      this.recount();
      reservation?.release();
      return fail('io', 'could not record the rendition');
    }
    reservation?.commit();
    // The two files already checked here are written now; one that fails is fetched again.
    for (const [sha, bytes] of [
      [input.root, listBytes],
      [playlist.sha256, playlistBytes],
    ] as const) {
      if (this.present.has(sha)) continue;
      try {
        await this.writeVerified(sha, bytes);
        this.present.add(sha);
      } catch {
        // left missing
      }
    }
    return this.fillingResult(record);
  }

  private async putKept(
    video: nfx.VideoAddr,
    fillId: symbol,
    sha: string,
    bytes: Uint8Array,
  ): Promise<
    | { readonly ok: true; readonly remaining: number }
    | { readonly ok: false; readonly error: NfxKeepError; readonly message: string }
  > {
    this.assertLoaded();
    const r = this.kept.get(video.toString());
    if (r === undefined || r.filling === null || this.fillIdentity(r.filling) !== fillId)
      return { ok: false, error: 'unknown', message: 'the fill is no longer active' };
    const want =
      r.meta.find((f) => f.sha256 === sha) ?? r.filling.files.find((f) => f.sha256 === sha);
    if (!SHA.test(sha) || want === undefined)
      return { ok: false, error: 'unwanted', message: 'not a file this rendition needs' };
    if (!this.present.has(sha)) {
      const copy = new Uint8Array(bytes);
      if (copy.byteLength !== want.size || this.sha256(copy) !== sha)
        return { ok: false, error: 'mismatch', message: 'not the listed bytes' };
      try {
        await this.writeVerified(sha, copy);
      } catch {
        return { ok: false, error: 'io', message: 'could not write the store' };
      }
      this.present.add(sha);
    }
    return { ok: true, remaining: this.missingOf(r).length };
  }

  private async complete(video: nfx.VideoAddr, fillId: symbol): Promise<NfxKeepResult> {
    this.assertLoaded();
    const key = video.toString();
    const r = this.kept.get(key);
    if (r === undefined || r.filling === null || this.fillIdentity(r.filling) !== fillId)
      return { ok: false, error: 'unknown', message: 'the fill is no longer active' };
    const missing = this.missingOf(r);
    if (missing.length > 0) return { ok: true, state: 'filling', missing, fillId };
    const record: NfxKeptRecord = {
      ...r,
      held: { ...r.held, [r.filling.rendition]: r.filling.files },
      filling: null,
    };
    this.setKept(record);
    try {
      await this.persistKept();
    } catch {
      this.setKept(r);
      return { ok: false, error: 'io', message: 'could not record the rendition' };
    }
    return { ok: true, state: 'held', missing: [] };
  }

  /**
   * Replace (or, with `null`, forget) kept record `key`, then remove and free every file that
   * no record names any more: files first, then the record list, as `remove` does.
   */
  private async replaceKept(key: string, next: NfxKeptRecord | null): Promise<void> {
    const before = new Map(this.sizes);
    if (next === null) this.deleteKept(key);
    else this.setKept(next);
    this.recount();
    for (const [sha, size] of before) {
      if (this.sizes.has(sha)) continue;
      await this.unlinkQuietly(this.filePath(sha));
      await this.unlinkQuietly(this.partPath(sha));
      this.present.delete(sha);
      // One charge, freed here (evaluated even with no cap: it clears the cleanup entry).
      const freed = size + this.endCleanupCharge(sha, size);
      this.cap?.free(freed);
    }
    await this.persistKept().catch(() => undefined);
  }

  private fillingResult(r: NfxKeptRecord): NfxKeepResult {
    if (r.filling === null) throw new Error('NfxStore: expected a filling rendition');
    return {
      ok: true,
      state: 'filling',
      missing: this.missingOf(r),
      fillId: this.fillIdentity(r.filling),
    };
  }

  private fillIdentity(filling: NonNullable<NfxKeptRecord['filling']>): symbol {
    let fillId = this.fillIds.get(filling);
    if (fillId === undefined) {
      fillId = Symbol();
      this.fillIds.set(filling, fillId);
    }
    return fillId;
  }

  private setKept(r: NfxKeptRecord): void {
    this.kept.set(r.video, r);
    if (Object.keys(r.held).length > 0) this.keptServes.set(r.video, heldFiles(r));
    else this.keptServes.delete(r.video);
  }

  private deleteKept(key: string): void {
    this.kept.delete(key);
    this.keptServes.delete(key);
  }

  /** The meta and filling files of `r` not on disk, each once. */
  private missingOf(r: NfxKeptRecord): NfxStoredFile[] {
    const out = new Map<string, NfxStoredFile>();
    for (const f of [...r.meta, ...(r.filling?.files ?? [])])
      if (!this.present.has(f.sha256)) out.set(f.sha256, f);
    return [...out.values()];
  }

  private async put(input: NfxPutVideo): Promise<NfxPutResult> {
    this.assertLoaded();
    const fail = (error: NfxPutError, message: string): NfxPutResult => ({
      ok: false,
      error,
      message,
    });
    if (this.loadError !== null) return fail('unavailable', 'the NFX store did not load');
    // A put that fails deletes what it wrote, and with the kept records unknown that may be
    // a file one of them names: nothing on disk changes until they load.
    if (!this.keptWritable) return fail('unavailable', 'the kept store did not load');
    const key = input.video.toString();
    if (!SHA.test(input.root)) return fail('invalid', 'root is not 64 lowercase hex');
    if (input.hashListBytes.byteLength > nfx.MAX_HASH_LIST_BYTES)
      return fail('invalid', 'the hash list is larger than 16 MiB');
    const known = this.records.get(key);
    if (known !== undefined) {
      return known.root === input.root
        ? { ok: true, record: known, deduplicated: true }
        : fail('exists', 'the video is stored with another hash list');
    }
    // A copy: the caller's buffer may change after it is checked.
    const listBytes = new Uint8Array(input.hashListBytes);
    const verified = nfx.verifyHashList(listBytes, input.root, input.video, input.segs);
    if (!verified.ok) return fail('invalid', verified.error.reason);

    // The files to record: the hash list itself, then every entry, each hash once and at one
    // size: within the list, and against what is stored.
    const listed = new Map<string, { size: number; entry: nfx.FileEntry | undefined }>();
    const add = (sha: string, size: number, entry: nfx.FileEntry | undefined): boolean => {
      const seen = listed.get(sha)?.size ?? this.sizes.get(sha);
      if (seen !== undefined && seen !== size) return false;
      if (!listed.has(sha)) listed.set(sha, { size, entry });
      return true;
    };
    if (!add(input.root, listBytes.byteLength, undefined))
      return fail('invalid', 'the hash list is stored at another size');
    for (const f of verified.value.files) {
      if (f.size > BigInt(Number.MAX_SAFE_INTEGER)) return fail('invalid', 'a file is too large');
      if (!add(f.sha256, Number(f.size), f))
        return fail('invalid', `${f.name} is listed at another size than its hash has`);
    }
    let newBytes = 0;
    for (const [sha, { size }] of listed) newBytes += this.newCharge(sha, size);
    const reservation = this.cap === null ? null : this.cap.reserve(newBytes);
    if (this.cap !== null && reservation === null) {
      return fail('disk-cap', 'storing the video would exceed the disk cap');
    }

    const record: NfxVideoRecord = {
      video: key,
      root: input.root,
      segs: input.segs.toString(),
      files: [...listed].map(([sha256, { size }]) => ({ sha256, size })),
      addedAt: this.now(),
    };
    const written: string[] = [];
    const undo = async (): Promise<void> => {
      reservation?.release();
      for (const sha of written) {
        await this.unlinkQuietly(this.filePath(sha));
        await this.unlinkQuietly(this.partPath(sha));
      }
      this.pending = null;
      await this.persist().catch(() => undefined);
    };
    // Saved before the first file is written, so a crash mid-put leaves a record a load cleans.
    this.pending = { ...record, pending: true };
    try {
      await this.persist();
    } catch {
      await undo();
      return fail('io', 'could not record the put');
    }
    for (const [sha, { size, entry }] of listed) {
      if (this.present.has(sha)) continue; // stored for another video
      let bytes: Uint8Array;
      try {
        bytes = entry === undefined ? listBytes : new Uint8Array(await input.read(entry));
      } catch {
        await undo();
        return fail('io', `could not read ${entry?.name ?? 'the hash list'}`);
      }
      if (bytes.byteLength !== size || this.sha256(bytes) !== sha) {
        await undo();
        return fail('mismatch', `${entry?.name ?? 'the hash list'} is not the listed bytes`);
      }
      written.push(sha);
      try {
        await this.writeVerified(sha, bytes);
      } catch {
        await undo();
        return fail('io', 'could not write the store');
      }
    }

    this.pending = null;
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
    for (const sha of listed.keys()) this.present.add(sha);
    // A whole video replaces a kept copy of it (a load would drop the kept record anyway).
    if (this.kept.has(key)) await this.replaceKept(key, null);
    return { ok: true, record, deduplicated: false };
  }

  private async remove(video: nfx.VideoAddr): Promise<boolean> {
    this.assertLoaded();
    // With the kept records unknown, a file no whole video names may still be a kept one's.
    if (!this.keptWritable)
      throw new Error('unavailable: the kept store did not load, so nothing is removed');
    const key = video.toString();
    const record = this.records.get(key);
    if (record === undefined) return false;
    this.records.delete(key);
    const before = new Map(this.sizes);
    this.recount();
    // Files first, then the record list: a crash between leaves a record whose file is
    // missing, which a load drops; never a file that no record names.
    for (const [sha, size] of before) {
      if (this.sizes.has(sha)) continue;
      await this.unlinkQuietly(this.filePath(sha));
      this.present.delete(sha);
      // One charge, freed here (evaluated even with no cap: it clears the cleanup entry).
      const freed = size + this.endCleanupCharge(sha, size);
      this.cap?.free(freed);
    }
    // Not saved: the disk already agrees with memory, and the next load drops the record.
    await this.persist().catch(() => undefined);
    return true;
  }

  /** `bytes` (already checked against `sha`) to `files/<sha[0..2]>/<sha>`, via a `.part` file. */
  private async writeVerified(sha: string, bytes: Uint8Array): Promise<void> {
    const dir = this.o.fs.join(this.root, 'files', sha.slice(0, 2));
    await this.o.fs.mkdir(dir, { recursive: true });
    const tmp = this.partPath(sha);
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

  /** Where a write of `sha` is made before it is renamed into place. */
  private partPath(sha: string): string {
    if (!isHex(sha, 32)) throw new Error('nfx store: not a sha256');
    return this.o.fs.join(this.root, 'tmp', `${sha}.part`);
  }

  private videosPath(): string {
    return this.o.fs.join(this.root, NFX_VIDEOS_FILE);
  }

  private keptPath(): string {
    return this.o.fs.join(this.root, NFX_KEPT_FILE);
  }

  private async unlinkQuietly(path: string): Promise<void> {
    if ((await this.o.fs.stat(path)) === null) return;
    await this.o.fs.unlink(path).catch(() => undefined);
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
    for (const r of this.kept.values())
      for (const f of keptFiles(r)) this.sizes.set(f.sha256, f.size);
  }

  private persist(): Promise<void> {
    const videos: StoredRecord[] = this.videos().slice();
    if (this.pending !== null) videos.push(this.pending);
    return this.db.save({ version: 1, videos });
  }

  private async cleanParts(): Promise<void> {
    for (const name of await this.o.fs.readdir(this.o.fs.join(this.root, 'tmp'))) {
      const sha = name.slice(0, -5);
      if (name.endsWith('.part') && SHA.test(sha)) await this.unlinkQuietly(this.partPath(sha));
    }
  }

  /**
   * Bytes a file of `size` adds to the cap: none while a record names it; for a journaled
   * cleanup file, what its charge lacks (restored from disk at load, it may be truncated).
   */
  private newCharge(sha: string, size: number): number {
    if (this.sizes.has(sha)) return 0;
    const charged = this.cleanupBytes.get(sha);
    return charged === undefined ? size : Math.max(0, size - charged);
  }

  /**
   * Ends `sha`'s cleanup charge, now carried by a record's `size` (with `newCharge`'s top-up).
   * Returns what it held beyond `size`, which nothing else would free.
   */
  private endCleanupCharge(sha: string, size: number): number {
    const charged = this.cleanupBytes.get(sha);
    this.cleanupBytes.delete(sha);
    return charged === undefined ? 0 : Math.max(0, charged - size);
  }

  /** Keep failed deletions in the journal so a flush or restart can retry them. */
  private async cleanAbandonedFiles(): Promise<boolean> {
    const fs = this.o.fs;
    let changed = false;
    for (const sha of this.keepCleanup) {
      try {
        if (!this.sizes.has(sha)) {
          for (const path of [this.filePath(sha), this.partPath(sha)])
            if ((await fs.stat(path)) !== null) await fs.unlink(path);
          const bytes = this.cleanupBytes.get(sha);
          if (bytes !== undefined) this.cap?.free(bytes);
          this.cleanupBytes.delete(sha);
        } else {
          // Named again: that record's charge carries its size. What the file takes beyond that
          // stays charged until a verified write has shrunk it (retried at the next flush).
          const size = this.sizes.get(sha) ?? 0;
          if ((this.cleanupBytes.get(sha) ?? 0) > size) {
            const st = await fs.stat(this.filePath(sha));
            if (st !== null && st.size > size) continue;
          }
          const excess = this.endCleanupCharge(sha, size);
          if (excess > 0) this.cap?.free(excess);
        }
        this.keepCleanup.delete(sha);
        changed = true;
      } catch {
        // The committed cleanup entry remains available for a later retry.
      }
    }
    return changed;
  }

  private async persistKept(
    videos = this.keptVideos(),
    cleanup: ReadonlySet<string> = this.keepCleanup,
  ): Promise<void> {
    if (!this.keptWritable) throw new Error('could not recover kept.json');
    const generation = this.keptGeneration;
    await this.keptDb.save({
      version: 1,
      videos,
      ...(cleanup.size === 0 ? {} : { cleanup: [...cleanup] }),
    });
    if (this.keptGeneration === generation) this.keptDirty = false;
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
