/**
 * Watching one free NFX video (ADR 0020 slice 5d, spike S-E): one rendition served as one
 * progressive fMP4, layout C (`media.planNfxPlayback`) — the init, one global `sidx`, then each
 * segment from its `moof`.
 *
 * Transport-agnostic: files come from an `NfxFetcher` (whole files, sha256-checked by the
 * transport), so iroh (NFX-06) can plug in beside NFX-12's HyperDHT (`./hyperdht-fetcher.ts`).
 *
 * `open` fetches the hash list (sha = the manifest `root`), verifies it against the manifest,
 * picks the rendition, fetches its playlist, its init and its first segment, plans layout C and
 * spools each file to `<dir>/<sha>`; it answers once segment 0 is spooled. The rest are then
 * fetched in the background, in order from where the player reads, at most `concurrency` at a
 * time and `prefetchSeconds` of media ahead (a segment a read waits for goes first). Each is
 * checked against the plan on arrival (`media.checkNfxSegment`): the byte offsets were promised to
 * the player, so a mismatch — or a file no source serves — fails the session. A failed session
 * still serves what it spooled; a read of anything else is refused.
 *
 * `close` refuses every waiting read, closes the fetcher (its fetches and connections) and
 * deletes the spool.
 */
import { media, nfx } from '@sovit/core';
import type { Logger, SeederFs } from '@sovit/seeder';

import { IpcError } from '../../ipc/errors.js';
import type { ErrorCode } from '../../ipc/protocol.js';
import { isNfxRenditionWire } from '../../ipc/worker-guards.js';
import type { NfxRenditionWire } from '../../ipc/worker-protocol.js';
import { MAX_NFX_RENDITIONS } from '../../ipc/worker-protocol.js';

/**
 * How an `NfxFetcher` gives up: one short constant per source it tried (`missing`, `unreachable`,
 * …), never peer data, so a failed open says why.
 */
export class NfxFetchError extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(`nfx: no source served the file (${reasons.join(', ') || 'none left to ask'})`);
    this.reasons = reasons;
  }
}

/** Where a session's files come from. */
export interface NfxFetcher {
  /**
   * File `sha`: exactly `size` bytes, or with `exact: false` at most `size` (the hash list), whose
   * sha256 the transport checked against `sha`. Rejects when no source serves it (with an
   * `NfxFetchError`, which says why).
   */
  fetch(sha: string, size: number, exact: boolean): Promise<Uint8Array>;
  /** Abandon every fetch in flight (they reject) and close what this fetcher opened. */
  close(): Promise<void>;
}

/**
 * The most bytes one listed file may have here, checked before it is fetched (a fetch is held in
 * memory until it is spooled): the packager's own cap for a segment, far above a 2 s segment.
 */
export const MAX_NFX_PLAY_FILE_BYTES = 64 * 1024 * 1024;
/** Segments fetched at once in the background (NFX-12 §4 allows 8 requests per channel, free). */
export const NFX_FETCH_CONCURRENCY = 4;
/** How long a read waits for a segment that has not arrived yet. */
export const NFX_READ_WAIT_MS = 30_000;
/** Segments past the one being read that are always fetched, whatever `prefetchSeconds` says. */
const MIN_AHEAD_SEGMENTS = 2;

export interface NfxWatchSessionOptions {
  readonly video: nfx.VideoAddr;
  /** The manifest `root` and `segs`. */
  readonly root: string;
  readonly segs: number;
  /** A rendition id; absent: the highest-bandwidth one. */
  readonly rendition?: string;
  readonly prefetchSeconds: number;
  readonly fetcher: NfxFetcher;
  readonly fs: SeederFs;
  /** Remove a directory and everything in it; a missing one is fine. */
  readonly rmTree: (path: string) => Promise<void>;
  /** This session's spool directory (created on the first write, deleted by `close`). */
  readonly dir: string;
  readonly logger: Logger;
  /** Tests: `NFX_READ_WAIT_MS`, `NFX_FETCH_CONCURRENCY`. */
  readonly waitMs?: number;
  readonly concurrency?: number;
}

export interface NfxWatchOpened {
  /** The rendition served. */
  readonly rendition: string;
  /** The hash list's renditions, highest bandwidth first (at most `MAX_NFX_RENDITIONS`). */
  readonly renditions: readonly NfxRenditionWire[];
  readonly layout: nfx.ProgressiveLayout;
}

type SegmentState = 'pending' | 'fetching' | 'ready';

interface Waiter {
  resolve(): void;
  reject(err: Error): void;
}

function coded(code: ErrorCode, detail: string): IpcError {
  return new IpcError(code, `${code}: ${detail}`);
}

/** A listed size as a number, refused past `MAX_NFX_PLAY_FILE_BYTES`. */
function fileSize(f: nfx.FileEntry): number {
  if (f.size > BigInt(MAX_NFX_PLAY_FILE_BYTES))
    throw coded('unsupported-input', 'a file of this video is larger than this app plays');
  return Number(f.size);
}

/**
 * The renditions as they cross to the host, highest bandwidth first: one the wire cannot carry
 * (an id that is no label, a bandwidth past 2^53) is left out, an odd `resolution` dropped.
 */
export function wireRenditions(list: readonly nfx.Rendition[]): NfxRenditionWire[] {
  const out: NfxRenditionWire[] = [];
  for (const r of list) {
    const base = { id: r.id, bandwidth: Number(r.bandwidth) };
    const full = r.resolution === undefined ? base : { ...base, resolution: r.resolution };
    if (isNfxRenditionWire(full)) out.push(full);
    else if (isNfxRenditionWire(base)) out.push(base);
  }
  return out.sort((a, b) => b.bandwidth - a.bandwidth);
}

export class NfxWatchSession {
  private readonly o: NfxWatchSessionOptions;
  private readonly waitMs: number;
  private readonly concurrency: number;
  private state: 'idle' | 'opening' | 'open' | 'failed' | 'closed' = 'idle';
  private plan: media.NfxPlayPlan | null = null;
  private segments: SegmentState[] = [];
  /** Media time at each segment's start, ms (the prefetch window). */
  private startsMs: number[] = [];
  /** Each segment part of the layout → its index (`locate` hands the part objects back). */
  private readonly segmentOf = new Map<nfx.ProgressivePart, number>();
  private readonly waiters = new Map<number, Set<Waiter>>();
  /** Segments a read is waiting for: fetched first. */
  private readonly wanted = new Set<number>();
  /** Fetches in flight by sha (a sha listed twice is fetched once). */
  private readonly fetching = new Map<string, Promise<Uint8Array>>();
  /** Spool writes by sha; `close` waits for them before deleting the directory. */
  private readonly spooled = new Map<string, Promise<void>>();
  private dirReady: Promise<void> | null = null;
  private inFlight = 0;
  /** The segment the player read last. */
  private cursor = 0;
  private closing: Promise<void> | null = null;

  constructor(o: NfxWatchSessionOptions) {
    this.o = o;
    this.waitMs = o.waitMs ?? NFX_READ_WAIT_MS;
    this.concurrency = o.concurrency ?? NFX_FETCH_CONCURRENCY;
  }

  /** A segment did not match the plan, or no source served one: what is not spooled is lost. */
  get failed(): boolean {
    return this.state === 'failed';
  }

  get closed(): boolean {
    return this.state === 'closed';
  }

  /** Layout C, once `open` answered (what the range server serves). */
  get layout(): nfx.ProgressiveLayout {
    if (this.plan === null) throw new Error('nfx: the session is not open');
    return this.plan.layout;
  }

  /** Segments spooled and checked so far. */
  get readySegments(): number {
    let n = 0;
    for (const s of this.segments) if (s === 'ready') n++;
    return n;
  }

  /** Fetch, verify, plan and spool up to segment 0. Throws `<code>: …` errors. */
  async open(): Promise<NfxWatchOpened> {
    if (this.state !== 'idle') throw coded('invalid-argument', 'the play session is already open');
    this.state = 'opening';
    const { video, root } = this.o;

    const listBytes = await this.fetch(root, nfx.MAX_HASH_LIST_BYTES, false, 'the hash list');
    const verified = nfx.verifyHashList(listBytes, root, video, BigInt(this.o.segs));
    if (!verified.ok) {
      this.o.logger.warn('nfx: a hash list did not verify', { reason: verified.error.reason });
      throw coded('invalid-argument', 'the hash list does not verify against its manifest');
    }
    const list = verified.value;
    const renditions = wireRenditions(list.renditions);
    const chosen =
      this.o.rendition === undefined
        ? renditions[0]
        : renditions.find((r) => r.id === this.o.rendition);
    if (chosen === undefined)
      throw coded(
        'not-found',
        this.o.rendition === undefined ? 'no playable rendition' : 'no such rendition',
      );
    const rendition = list.renditions.find((r) => r.id === chosen.id);
    const playlist = list.files.find(
      (f) => f.role === 'playlist' && f.name === rendition?.playlist,
    );
    if (playlist === undefined) throw coded('not-found', 'the rendition has no playlist');

    const playlistBytes = await this.fetch(
      playlist.sha256,
      fileSize(playlist),
      true,
      'the playlist',
    );
    const members = nfx.renditionMembers(list, playlistBytes);
    // Not logged: a playlist error quotes the creator's URIs.
    if (!members.ok) throw coded('unsupported-input', 'the rendition playlist does not resolve');
    const { init } = members.value;
    const segments = members.value.segments.map((s) => ({
      sha256: s.sha256,
      size: fileSize(s),
      durMs: s.durMs === undefined ? 0 : Number(s.durMs),
    }));
    const head = segments[0];
    if (head === undefined) throw coded('unsupported-input', 'the rendition has no segments');
    const initSize = fileSize(init);

    const [initBytes, first] = await Promise.all([
      this.fetch(init.sha256, initSize, true, 'the init segment'),
      this.fetch(head.sha256, head.size, true, 'the first segment'),
    ]);
    const planned = media.planNfxPlayback({
      init: { sha256: init.sha256, size: initSize },
      initBytes,
      segments,
      first,
    });
    if (!planned.ok)
      throw coded('unsupported-input', `this rendition cannot play as one file: ${planned.reason}`);
    try {
      await Promise.all([this.spool(init.sha256, initBytes), this.spool(head.sha256, first)]);
    } catch {
      this.alive();
      throw coded('internal', 'the first files could not be spooled');
    }
    this.alive();

    const plan = planned.plan;
    this.plan = plan;
    this.segments = plan.segments.map((_, i) => (i === 0 ? 'ready' : 'pending'));
    let ms = 0;
    this.startsMs = plan.segments.map((s) => {
      const at = ms;
      ms += s.durMs;
      return at;
    });
    // Layout C: the init, the sidx, then segment i at part 2 + i.
    plan.layout.parts.slice(2).forEach((p, i) => {
      this.segmentOf.set(p.part, i);
    });
    this.state = 'open';
    this.pump();
    return { rendition: chosen.id, renditions: shown(renditions, chosen), layout: plan.layout };
  }

  /**
   * The bytes of one piece of the layout (`nfx.locate`). A segment not spooled yet is waited for
   * (bounded by `waitMs`, and fetched first); rejects once the session failed or closed without
   * it, or when the wait runs out.
   */
  async read(piece: nfx.ProgressivePiece): Promise<Uint8Array> {
    const { part } = piece;
    if (part.kind === 'bytes')
      return part.bytes.subarray(piece.offset, piece.offset + piece.length);
    if (this.plan === null || this.isClosed()) throw new Error('nfx: the session is not open');
    const i = this.segmentOf.get(part);
    // No index: the init, spooled before `open` answered.
    if (i !== undefined) await this.whenReady(i);
    if (this.isClosed()) throw new Error('nfx: the session closed');
    const path = this.o.fs.join(this.o.dir, part.sha256);
    const offset = (part.skip ?? 0) + piece.offset;
    const bytes =
      this.o.fs.readRange === undefined
        ? (await this.o.fs.readFile(path)).subarray(offset, offset + piece.length)
        : await this.o.fs.readRange(path, offset, piece.length);
    if (bytes.byteLength !== piece.length) throw new Error('nfx: a short read from the spool');
    return bytes;
  }

  /** Stop for good: waiting reads are refused, fetches abandoned, the spool deleted. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.state = 'closed';
      this.rejectWaiters(new Error('nfx: the session closed'));
      await this.o.fetcher.close().catch(() => undefined);
      // A write that started before the close lands first, so nothing is left behind.
      await Promise.allSettled([...this.spooled.values()]);
      try {
        await this.o.rmTree(this.o.dir);
      } catch (err) {
        this.o.logger.warn('nfx: a play spool could not be deleted', { error: err });
      }
    })();
    return this.closing;
  }

  // ------------------------------------------------------------------ fetching

  /** One file for `open`, with its failure as an IPC error. */
  private async fetch(
    sha: string,
    size: number,
    exact: boolean,
    what: string,
  ): Promise<Uint8Array> {
    let bytes: Uint8Array;
    try {
      bytes = await this.fetchOnce(sha, size, exact);
    } catch (err) {
      this.alive();
      const why = err instanceof NfxFetchError ? ` (${err.reasons.join(', ')})` : '';
      throw coded('no-seeders', `no seeder served ${what}${why}`);
    }
    this.alive();
    return bytes;
  }

  private fetchOnce(sha: string, size: number, exact: boolean): Promise<Uint8Array> {
    let p = this.fetching.get(sha);
    if (p === undefined) {
      p = this.o.fetcher.fetch(sha, size, exact).finally(() => {
        this.fetching.delete(sha);
      });
      this.fetching.set(sha, p);
    }
    return p;
  }

  /** `open` goes on only while the session does. */
  private alive(): void {
    if (this.isClosed()) throw coded('session-closed', 'the play session closed');
  }

  /** Start background fetches while there is room and a segment to fetch. */
  private pump(): void {
    if (this.state !== 'open') return;
    while (this.inFlight < this.concurrency) {
      const i = this.nextSegment();
      if (i === undefined) return;
      this.segments[i] = 'fetching';
      this.wanted.delete(i);
      this.inFlight++;
      void this.fetchSegment(i).finally(() => {
        this.inFlight--;
        this.pump();
      });
    }
  }

  /** A segment a read waits for; else the next pending one from the cursor, within the window. */
  private nextSegment(): number | undefined {
    for (const i of this.wanted) if (this.segments[i] === 'pending') return i;
    const n = this.segments.length;
    const limit = (this.startsMs[this.cursor] ?? 0) + this.o.prefetchSeconds * 1000;
    let end = Math.min(n, this.cursor + 1 + MIN_AHEAD_SEGMENTS);
    while (end < n && (this.startsMs[end] ?? Infinity) < limit) end++;
    for (let i = this.cursor; i < end; i++) if (this.segments[i] === 'pending') return i;
    return undefined;
  }

  private async fetchSegment(i: number): Promise<void> {
    const plan = this.plan;
    const seg = plan?.segments[i];
    if (plan === null || seg === undefined) return;
    let bytes: Uint8Array;
    try {
      bytes = await this.fetchOnce(seg.sha256, seg.size, true);
    } catch (err) {
      const why = err instanceof NfxFetchError ? ` (${err.reasons.join(', ')})` : '';
      this.fail(`no seeder served segment ${String(i)}${why}`);
      return;
    }
    if (this.isClosed()) return;
    if (!media.checkNfxSegment(plan, i, bytes)) {
      this.fail(`segment ${String(i)} is not where the plan put it`);
      return;
    }
    try {
      await this.spool(seg.sha256, bytes);
    } catch {
      this.fail(`segment ${String(i)} could not be spooled`);
      return;
    }
    if (this.isClosed()) return;
    // Checked and spooled: servable even if the session failed meanwhile.
    this.segments[i] = 'ready';
    this.wanted.delete(i);
    const set = this.waiters.get(i);
    this.waiters.delete(i);
    for (const w of set ?? []) w.resolve();
  }

  /** Write `bytes` to the spool once per sha. Never called once the session is closed. */
  private spool(sha: string, bytes: Uint8Array): Promise<void> {
    let p = this.spooled.get(sha);
    if (p === undefined) {
      this.dirReady ??= this.o.fs.mkdir(this.o.dir, { recursive: true });
      p = this.dirReady.then(() => this.o.fs.writeFile(this.o.fs.join(this.o.dir, sha), bytes));
      this.spooled.set(sha, p);
    }
    return p;
  }

  private fail(reason: string): void {
    if (this.state !== 'open') return;
    this.state = 'failed';
    this.o.logger.warn('nfx: a play session failed', { reason });
    this.rejectWaiters(new Error('nfx: the session failed'));
  }

  private rejectWaiters(err: Error): void {
    const all = [...this.waiters.values()];
    this.waiters.clear();
    for (const set of all) for (const w of set) w.reject(err);
  }

  /** Segment `i` spooled, or a rejection (bounded). Moves the cursor: the player reads `i` now. */
  private async whenReady(i: number): Promise<void> {
    if (this.cursor !== i) {
      this.cursor = i;
      this.pump();
    }
    if (this.segments[i] === 'ready') return;
    if (this.state !== 'open') throw new Error('nfx: the segment is not available');
    this.wanted.add(i);
    this.pump();
    let set = this.waiters.get(i);
    if (set === undefined) {
      set = new Set();
      this.waiters.set(i, set);
    }
    const waiting = set;
    await new Promise<void>((resolve, reject) => {
      const w: Waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        waiting.delete(w);
        reject(new Error('nfx: a segment did not arrive in time'));
      }, this.waitMs);
      waiting.add(w);
    });
  }

  /** Read fresh after an `await` (an earlier check's narrowing no longer holds). */
  private isClosed(): boolean {
    return this.state === 'closed';
  }
}

/** The renditions reported: the first `MAX_NFX_RENDITIONS`, always including the one served. */
function shown(all: readonly NfxRenditionWire[], chosen: NfxRenditionWire): NfxRenditionWire[] {
  const out = all.slice(0, MAX_NFX_RENDITIONS);
  if (!out.includes(chosen)) out[out.length - 1] = chosen;
  return out;
}
