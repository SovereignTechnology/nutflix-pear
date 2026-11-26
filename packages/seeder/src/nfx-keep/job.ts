/**
 * Keep one rendition of a video (NFX-18 §2): the store names and counts its files
 * (`NfxStore.beginKeep`), then each missing file comes from what this node already holds (a play's
 * spool) or from a fetcher, is checked and written by the store, and the rendition becomes held
 * once every file is on disk. Moved from nutflix-runtime's `seeds.ts` (`fetchAndStore`), made per
 * rendition and transport-neutral: the caller's fetcher is iroh, HyperDHT, WebRTC or a fallback
 * of them, and checks bytes first; the store checks them again.
 *
 * - Nothing here decides whether to keep: the caller checks the user's switch, the budget
 *   (`./budget.ts`) and the cap first.
 * - Stopping (`signal`) leaves the rendition filling, so it resumes after a restart; the caller
 *   abandons it if it should not (`NfxStore.abandonKeep`).
 * - A file larger than `maxFileBytes` is refused before it is fetched: a fetch is held in memory
 *   until the store writes it.
 */
import type { nfx } from '@sovit/core';

import type {
  NfxKeepBegin,
  NfxKeepError,
  NfxKeepResult,
  NfxStore,
  NfxStoredFile,
} from '../nfx-store/index.js';

/**
 * What a job reads of the signal that stops it. An `AbortSignal` is one; so is a plain flag, for
 * a runtime without `AbortController` (Bare 1.31, where the desktop worker runs).
 */
export interface KeepSignal {
  readonly aborted: boolean;
}

/** Bytes of one file, from wherever the caller has them. `null`: not here. */
export type KeepHeld = (sha256: string) => Promise<Uint8Array | null>;
/** Bytes of one file from the network, checked against `sha256` and `size`. Throws on failure. */
export type KeepFetch = (file: NfxStoredFile, signal: KeepSignal) => Promise<Uint8Array>;

export interface KeepProgress {
  readonly video: string;
  readonly rendition: string;
  /** Files on disk of those the rendition needs (meta files included). */
  readonly done: number;
  readonly total: number;
  /** Bytes fetched from the network by this job so far (not those already held). */
  readonly fetchedBytes: number;
}

export interface KeepJobInput extends NfxKeepBegin {
  readonly store: NfxStore;
  readonly held?: KeepHeld;
  readonly fetch: KeepFetch;
  readonly signal: KeepSignal;
  readonly maxFileBytes: number;
  readonly onProgress?: (p: KeepProgress) => void;
  /** Bytes about to be fetched: `false` stops the job as `budget` (`./budget.ts`). */
  readonly spend?: (bytes: number) => boolean;
}

export type KeepJobResult =
  /** Held now (or already, or stored whole). */
  | { readonly ok: true; readonly state: 'held' | 'whole'; readonly fetchedBytes: number }
  /** Stopped by `signal` or the budget: still filling, resumable. */
  | {
      readonly ok: false;
      readonly state: 'stopped';
      readonly why: 'aborted' | 'budget';
      readonly fetchedBytes: number;
    }
  /** The store refused, or a file could not be had. */
  | {
      readonly ok: false;
      readonly state: 'failed';
      readonly error: NfxKeepError | 'too-large' | 'fetch';
      readonly message: string;
      readonly fetchedBytes: number;
    };

export async function keepRendition(input: KeepJobInput): Promise<KeepJobResult> {
  const { store, video } = input;
  // Read afresh each time: the signal changes while this awaits.
  const aborted = (): boolean => input.signal.aborted;
  let fetchedBytes = 0;
  const failed = (error: NfxKeepError | 'too-large' | 'fetch', message: string): KeepJobResult => ({
    ok: false,
    state: 'failed',
    error,
    message,
    fetchedBytes,
  });
  const stopped = (why: 'aborted' | 'budget'): KeepJobResult => ({
    ok: false,
    state: 'stopped',
    why,
    fetchedBytes,
  });

  const begun: NfxKeepResult = await store.beginKeep(input);
  if (!begun.ok) return failed(begun.error, begun.message);
  if (begun.state !== 'filling') return { ok: true, state: begun.state, fetchedBytes };

  // What the rendition needs in all, for progress: what is missing plus what is already here.
  const total = countNeeded(store, video);
  const report = (): void => {
    input.onProgress?.({
      video: video.toString(),
      rendition: input.rendition,
      done: total - store.keepMissing(video).length,
      total,
      fetchedBytes,
    });
  };
  report();
  for (const file of store.keepMissing(video)) {
    if (aborted()) return stopped('aborted');
    if (file.size > input.maxFileBytes)
      return failed('too-large', 'a file of this rendition is too large to keep');
    let bytes = (await input.held?.(file.sha256).catch(() => null)) ?? null;
    if (bytes === null) {
      if (input.spend !== undefined && !input.spend(file.size)) return stopped('budget');
      try {
        bytes = await input.fetch(file, input.signal);
      } catch (err) {
        if (aborted()) return stopped('aborted');
        return failed('fetch', err instanceof Error ? err.message : 'the fetch failed');
      }
      fetchedBytes += bytes.byteLength;
    }
    const put = await store.putKeptFile(video, file.sha256, bytes);
    if (!put.ok) return failed(put.error, put.message);
    report();
  }
  const done = await store.completeKeep(video);
  if (!done.ok) return failed(done.error, done.message);
  if (done.state !== 'held') return failed('fetch', 'files went missing while keeping');
  return { ok: true, state: 'held', fetchedBytes };
}

/** Files the record names for its filling rendition and meta, for a progress total. */
function countNeeded(store: NfxStore, video: nfx.VideoAddr): number {
  const r = store.keptOf(video);
  if (r === undefined) return 0;
  return new Set([...r.meta, ...(r.filling?.files ?? [])].map((f) => f.sha256)).size;
}
