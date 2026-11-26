/**
 * Keeping what is watched (NFX-18, ADR 0026, plan P3): the worker's keep jobs. A free NFX video
 * watched for about a minute (or asked for as a download) has the rendition played finished in
 * the background and held in the NFX store, which then serves it.
 *
 * - `nfx.play.keep` (`keepPlay`): for `watched`, only once the play has been open a minute by the
 *   worker's monotonic clock and its player has read a minute of media. The host counts played
 *   seconds too; this is the worker's own check. A video not kept yet takes one of the hour's
 *   starts (`KeepBudget`), or the keep is refused `rate-limited`.
 * - The keep begins at once (`NfxStore.beginKeep`: its files named and counted against the cap,
 *   the hash list and playlist written). The play's spooled files go to the store when it
 *   closes, before its spool is deleted; the rest are fetched after that, by a job over the
 *   play's sources. Nothing is fetched for a keep while its own play is open: the player fetches
 *   those files itself, and fetching each twice would only compete for the same seeders.
 * - At most `MAX_KEEP_JOBS` jobs run at once, the rest wait in order. While any play is open only
 *   the oldest running job goes on (a job fetches one file at a time); the other waits at its next
 *   file, and no job starts.
 * - A job fetches through `NfxWatching.fetcherFor` (built as a play's fetcher is, and outliving
 *   the play). Each file is checked by its transport and again by the store; one larger than
 *   `MAX_NFX_PLAY_FILE_BYTES` is refused before it is fetched. Its bytes are spent from the hour's
 *   budget first; with none left the job waits and is tried again later.
 * - After a restart a filling record is resumed only when the host names sources for it
 *   (`nfx.keep.resume`), never on its own; a failed job is retried the same way.
 * - Dropping a video's last reason (`nfx.keep.drop`) stops its job first, so a job never brings
 *   back a video its user removed. With NFX off no keep begins and running jobs wait.
 * - `nfx.keep.changed` names a video whose record or job changed, at most once a second each.
 */
import { nfx } from '@sovit/core';
import type {
  KeepBudget,
  KeepJobResult,
  KeepSignal,
  Logger,
  NfxKeepError,
  NfxKeepReason,
  NfxStore,
  NfxStoredFile,
} from '@sovit/seeder';
import { keepRendition } from '@sovit/seeder';

import { IpcError } from '../../ipc/errors.js';
import { isLabel } from '../../ipc/guards.js';
import type { ErrorCode } from '../../ipc/protocol.js';
import type {
  NfxKeepFailure,
  NfxKeepJobWire,
  NfxKeepResumeArgs,
  NfxKeepStateWire,
  NfxKeptFillingWire,
  NfxKeptVideoWire,
} from '../../ipc/worker-protocol.js';
import {
  MAX_NFX_HELD_RENDITIONS,
  MAX_NFX_KEPT_VIDEOS,
  NFX_KEEP_REASONS,
} from '../../ipc/worker-protocol.js';
import type { NfxFetcher, NfxSpool } from './watch.js';
import { MAX_NFX_PLAY_FILE_BYTES } from './watch.js';
import type { NfxPlayKeep, NfxSources } from './watching.js';

/** Keep jobs running at once while nothing plays. */
export const MAX_KEEP_JOBS = 2;
/** A watched video is kept once its play has been open this long and read this much media. */
export const KEEP_WATCHED_MS = 60_000;
/** How long a job the hour's budget stopped waits before it is tried again. */
export const KEEP_BUDGET_RETRY_MS = 5 * 60_000;
/** `nfx.keep.changed` at most this often per video. */
export const KEEP_EVENT_MS = 1000;

export interface NfxKeepingDeps {
  readonly store: NfxStore;
  readonly budget: KeepBudget;
  /** A fetcher over `sources` (`NfxWatching.fetcherFor`); `null`: none this worker can ask. */
  readonly fetcherFor: (sources: NfxSources) => NfxFetcher | null;
  /** Whether a play session is open: keeping yields to it. */
  readonly playing: () => boolean;
  /** File `sha` of `video` if an open play spooled it (`NfxWatching.spooled`). */
  readonly spooled?: (video: string, sha: string) => Promise<Uint8Array | null>;
  /** `nfx.keep.changed` (throttled here). */
  readonly changed: (video: string) => void;
  readonly logger: Logger;
  /** Whether NFX is on at the start; `setOn` after. */
  readonly on: boolean;
  /** Tests: `MAX_KEEP_JOBS`, `MAX_NFX_PLAY_FILE_BYTES`, `KEEP_BUDGET_RETRY_MS`, `KEEP_EVENT_MS`. */
  readonly maxJobs?: number;
  readonly maxFileBytes?: number;
  readonly budgetRetryMs?: number;
  readonly eventMs?: number;
}

/**
 * - `play`: waiting for the plays it was asked from to close.
 * - `queued`: in line (or put back while NFX is off).
 * - `budget`: stopped by the hour's budget, tried again later.
 */
type JobState = 'play' | 'queued' | 'running' | 'budget' | 'held' | 'failed';

/** What `NfxStore.beginKeep` needs beside the record: from the play, or fetched on resume. */
interface JobBegin {
  readonly hashListBytes: Uint8Array;
  readonly playlistSha: string;
  readonly playlistBytes: Uint8Array;
}

interface Job {
  readonly key: string;
  readonly video: nfx.VideoAddr;
  readonly root: string;
  readonly segs: number;
  readonly rendition: string;
  /** Its place in line: lower first. */
  readonly seq: number;
  sources: NfxSources;
  begin: JobBegin | null;
  state: JobState;
  error: NfxKeepFailure | null;
  /** The plays (session ids) it waits for. */
  readonly plays: Set<string>;
  abort: JobStop | null;
  /** Why it is being stopped: `pause` puts it back in line; `end` ends it. */
  stopping: 'pause' | 'end' | null;
  /** While running: settles when its run ended. */
  done: Promise<void> | null;
}

/**
 * A running job's stop flag, as `keepRendition` reads it. Bare (the worker's runtime) has no
 * `AbortController`; stopping also runs `onStop` callbacks, which close the job's fetcher.
 */
class JobStop implements KeepSignal {
  private stopped = false;
  private readonly callbacks = new Set<() => void>();

  get aborted(): boolean {
    return this.stopped;
  }

  /** Run `fn` once at the stop; the result takes it back. */
  onStop(fn: () => void): () => void {
    this.callbacks.add(fn);
    return () => {
      this.callbacks.delete(fn);
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const fns = [...this.callbacks];
    this.callbacks.clear();
    for (const fn of fns) fn();
  }
}

function fail(code: ErrorCode, detail: string): never {
  throw new IpcError(code, `${code}: ${detail}`);
}

/** A store refusal of a keep, as an IPC error. */
function refuse(error: NfxKeepError, message: string): never {
  switch (error) {
    case 'invalid':
    case 'rendition':
    case 'exists':
      return fail('invalid-argument', message);
    case 'busy':
      return fail('rate-limited', message);
    case 'disk-cap':
      return fail('forbidden', message);
    case 'unavailable':
      return fail('backend-down', message);
    case 'mismatch':
    case 'io':
    case 'unknown':
    case 'unwanted':
      return fail('internal', message);
  }
}

/** A job's failure as the host sees it. */
function failure(error: NfxKeepError | 'too-large' | 'fetch'): NfxKeepFailure {
  switch (error) {
    case 'fetch':
    case 'too-large':
    case 'disk-cap':
    case 'busy':
      return error;
    case 'invalid':
    case 'mismatch':
    case 'rendition':
    case 'exists':
      return 'invalid';
    case 'io':
    case 'unavailable':
    case 'unknown':
    case 'unwanted':
      return 'store';
  }
}

function parseVideo(text: string): nfx.VideoAddr {
  const v = nfx.VideoAddr.parse(text);
  if (!v.ok || v.value.toString() !== text) fail('invalid-argument', 'not an NFX video address');
  return v.value;
}

/** One file from `fetcher`; refused at once once the job is stopping. */
function fetchFile(
  fetcher: NfxFetcher,
  file: NfxStoredFile,
  signal: KeepSignal,
): Promise<Uint8Array> {
  if (signal.aborted) return Promise.reject(new Error('nfx: the keep stopped'));
  return fetcher.fetch(file.sha256, file.size, true);
}

export class NfxKeeping {
  private readonly d: NfxKeepingDeps;
  private readonly maxJobs: number;
  private readonly maxFileBytes: number;
  private readonly budgetRetryMs: number;
  private readonly eventMs: number;
  /** By video address: at most one job each. */
  private readonly jobs = new Map<string, Job>();
  private queue: Job[] = [];
  /** In the order they started: the first may go on while a play is open. */
  private running: Job[] = [];
  /** Running jobs waiting for their turn at their next file. */
  private readonly turns = new Map<Job, () => void>();
  private readonly pending = new Set<string>();
  private eventTimer: ReturnType<typeof setTimeout> | null = null;
  private budgetTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private on: boolean;
  private closing: Promise<void> | null = null;

  constructor(d: NfxKeepingDeps) {
    this.d = d;
    this.on = d.on;
    this.maxJobs = d.maxJobs ?? MAX_KEEP_JOBS;
    this.maxFileBytes = d.maxFileBytes ?? MAX_NFX_PLAY_FILE_BYTES;
    this.budgetRetryMs = d.budgetRetryMs ?? KEEP_BUDGET_RETRY_MS;
    this.eventMs = d.eventMs ?? KEEP_EVENT_MS;
  }

  /** `nfx.play.keep`: keep the rendition `play` plays. Throws `<code>: …` errors. */
  async keepPlay(
    play: NfxPlayKeep,
    reason: NfxKeepReason,
  ): Promise<{ readonly state: NfxKeepStateWire }> {
    this.assertOn();
    if (
      reason === 'watched' &&
      (play.openForMs < KEEP_WATCHED_MS || play.mediaReadMs < KEEP_WATCHED_MS)
    )
      fail('invalid-argument', 'the video has not been watched for a minute');
    const { store } = this.d;
    const { video } = play.sources;
    const key = video.toString();
    const record = store.keptOf(video);
    const filling = record?.filling ?? null;
    if (filling !== null && filling.rendition !== play.rendition)
      fail('rate-limited', 'another rendition of this video is being kept');
    // A video not kept yet is one of the hour's starts, counted before the keep begins.
    if (record === undefined && store.get(video) === undefined) {
      // Saved before it is granted (#158): a crash cannot hand the hour's starts out twice.
      const started = await this.d.budget.start().catch(() => null);
      if (started === null) fail('backend-down', 'could not save the keep budget');
      if (!started) fail('rate-limited', 'no more new videos may be kept within this hour');
    }
    const begun = await store.beginKeep({
      video,
      root: play.sources.root,
      segs: BigInt(play.sources.segs),
      hashListBytes: play.hashListBytes,
      rendition: play.rendition,
      playlistBytes: play.playlistBytes,
      reason,
    });
    if (!begun.ok) return refuse(begun.error, begun.message);
    this.changed(key);
    if (begun.state !== 'filling') return { state: begun.state };

    let job = this.jobs.get(key);
    if (job === undefined || job.state === 'held' || job.state === 'failed') {
      job = this.newJob(play.sources, play.rendition, 'play', {
        hashListBytes: play.hashListBytes,
        playlistSha: play.playlistSha,
        playlistBytes: play.playlistBytes,
      });
      this.jobs.set(key, job);
    }
    // A job not started yet waits for this play too; one started takes its spool all the same.
    const waiting = job.state === 'play' ? job : null;
    const { fillId } = begun;
    const handed = play.keepOnClose(async (spool) => {
      try {
        await this.harvest(video, fillId, spool);
      } finally {
        if (waiting !== null) this.playClosed(waiting, play.sid);
      }
    });
    if (waiting !== null) {
      if (handed) waiting.plays.add(play.sid);
      else if (waiting.plays.size === 0) this.enqueue(waiting);
    }
    return { state: 'filling' };
  }

  /** `nfx.keep.resume`: go on fetching a filling rendition from these sources. */
  resume(a: NfxKeepResumeArgs): void {
    this.assertOn();
    const video = parseVideo(a.video);
    const record = this.d.store.keptOf(video);
    if (record?.root !== a.root || record.segs !== String(a.segs))
      fail('not-found', 'that video is not kept');
    if (Object.hasOwn(record.held, a.rendition)) return;
    if (record.filling?.rendition !== a.rendition)
      fail('not-found', 'that rendition is not being kept');
    const sources: NfxSources = {
      video,
      root: a.root,
      segs: a.segs,
      peers: a.peers,
      iroh: a.iroh,
    };
    const key = video.toString();
    const job = this.jobs.get(key);
    if (job !== undefined && job.state !== 'held' && job.state !== 'failed') {
      // Its next try asks these.
      job.sources = sources;
      return;
    }
    const fresh = this.newJob(sources, a.rendition, 'queued', null);
    this.jobs.set(key, fresh);
    this.enqueue(fresh);
  }

  /** `nfx.keep.list`: every kept video, the most recently used first. */
  list(): NfxKeptVideoWire[] {
    const out: { readonly usedAt: number; readonly wire: NfxKeptVideoWire }[] = [];
    for (const r of this.d.store.keptVideos()) {
      const video = nfx.VideoAddr.parse(r.video);
      const segs = Number(r.segs);
      if (!video.ok || !Number.isSafeInteger(segs) || segs < 1) continue;
      const held = Object.keys(r.held).filter(isLabel).sort().slice(0, MAX_NFX_HELD_RENDITIONS);
      let filling: NfxKeptFillingWire | null = null;
      if (r.filling !== null && isLabel(r.filling.rendition)) {
        const total = new Set([...r.meta, ...r.filling.files].map((f) => f.sha256)).size;
        const missing = this.d.store.keepMissing(video.value).length;
        filling = { rendition: r.filling.rendition, done: total - missing, total };
      }
      if (held.length === 0 && filling === null) continue;
      out.push({
        usedAt: r.usedAt,
        wire: {
          video: r.video,
          root: r.root as NfxKeptVideoWire['root'],
          segs,
          held,
          filling,
          reasons: NFX_KEEP_REASONS.filter((k) => r.reasons[k] !== undefined),
          job: this.jobWire(r.video),
        },
      });
    }
    return out
      .sort((a, b) => b.usedAt - a.usedAt)
      .slice(0, MAX_NFX_KEPT_VIDEOS)
      .map((x) => x.wire);
  }

  /**
   * `nfx.keep.drop`: drop one reason. With none left the video goes, its job stopped first.
   * `false` when it was not kept for that reason.
   */
  async drop(text: string, reason: NfxKeepReason): Promise<boolean> {
    if (this.closing !== null) fail('backend-down', 'worker is shutting down');
    const video = parseVideo(text);
    const key = video.toString();
    const record = this.d.store.keptOf(video);
    if (record?.reasons[reason] === undefined) return false;
    // Its last reason: the job stops before the record goes, so it cannot begin the keep again.
    if (Object.keys(record.reasons).length === 1) this.end(key);
    const dropped = await this.d.store.dropKeepReason(video, reason);
    if (this.d.store.keptOf(video) === undefined) this.end(key);
    this.changed(key);
    return dropped;
  }

  /** NFX on or off: off, no keep begins and running jobs go back in line. */
  setOn(on: boolean): void {
    if (this.on === on) return;
    this.on = on;
    if (on) {
      this.pump();
      return;
    }
    for (const job of this.running) this.stop(job, 'pause');
  }

  /** A play opened or closed. */
  wake(): void {
    this.pump();
  }

  /** Stop every job (fillings stay, to be resumed) and save the budget. Never throws. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      if (this.eventTimer !== null) clearTimeout(this.eventTimer);
      if (this.budgetTimer !== null) clearTimeout(this.budgetTimer);
      this.eventTimer = null;
      this.budgetTimer = null;
      const running = [...this.running];
      for (const job of running) this.stop(job, 'end');
      await Promise.allSettled(running.map((j) => j.done ?? Promise.resolve()));
      await this.d.budget.flush().catch(() => undefined);
    })();
    return this.closing;
  }

  // ------------------------------------------------------------------ jobs

  private newJob(
    sources: NfxSources,
    rendition: string,
    state: 'play' | 'queued',
    begin: JobBegin | null,
  ): Job {
    return {
      key: sources.video.toString(),
      video: sources.video,
      root: sources.root,
      segs: sources.segs,
      rendition,
      seq: this.seq++,
      sources,
      begin,
      state,
      error: null,
      plays: new Set(),
      abort: null,
      stopping: null,
      done: null,
    };
  }

  /** Play `sid`, which `job` waited for, closed: the job starts once the last one has. */
  private playClosed(job: Job, sid: string): void {
    job.plays.delete(sid);
    if (job.plays.size > 0 || job.state !== 'play' || this.jobs.get(job.key) !== job) return;
    this.enqueue(job);
  }

  /**
   * The files `spool` holds that the filling rendition of `video` still misses, to the store.
   * `fillId` is the fill the play began: one dropped and begun again meanwhile takes nothing.
   */
  private async harvest(video: nfx.VideoAddr, fillId: symbol, spool: NfxSpool): Promise<void> {
    const want = new Set(this.d.store.keepMissing(video).map((f) => f.sha256));
    for (const sha of spool.shas) {
      if (!want.has(sha)) continue;
      const bytes = await spool.read(sha);
      if (bytes === null) continue;
      const put = await this.d.store.putKeptFile(video, fillId, sha, bytes);
      // No longer this fill (dropped, begun again, or held meanwhile): nothing more to take.
      if (!put.ok && put.error === 'unknown') return;
    }
  }

  private enqueue(job: Job): void {
    job.state = 'queued';
    this.insert(job);
    this.changed(job.key);
    this.pump();
  }

  /** Into the line by `seq`: a job put back keeps its place. */
  private insert(job: Job): void {
    const at = this.queue.findIndex((j) => j.seq > job.seq);
    if (at < 0) this.queue.push(job);
    else this.queue.splice(at, 0, job);
  }

  /** Jobs running at once now: one while a play is open. */
  private limit(): number {
    return this.d.playing() ? 1 : this.maxJobs;
  }

  /** Start what may start, and let go on what may. */
  private pump(): void {
    this.releaseTurns();
    if (this.closing !== null || !this.on) return;
    while (this.running.length < this.limit()) {
      const job = this.queue.shift();
      if (job === undefined) return;
      this.start(job);
    }
  }

  private start(job: Job): void {
    const abort = new JobStop();
    job.state = 'running';
    job.error = null;
    job.stopping = null;
    job.abort = abort;
    this.running.push(job);
    this.changed(job.key);
    job.done = this.run(job, abort)
      .catch((err: unknown) => {
        this.d.logger.warn('nfx: a keep job ended on an error', { error: err });
        this.settle(job, 'failed', 'store');
      })
      .finally(() => {
        this.running = this.running.filter((j) => j !== job);
        job.abort = null;
        job.done = null;
        this.pump();
      });
  }

  private async run(job: Job, signal: JobStop): Promise<void> {
    const { store } = this.d;
    const record = store.keptOf(job.video);
    if (record?.root === job.root && Object.hasOwn(record.held, job.rendition)) {
      this.settle(job, 'held');
      return;
    }
    if (this.reasonOf(job) === null) {
      this.forget(job);
      return;
    }
    const fetcher = this.d.fetcherFor(job.sources);
    if (fetcher === null) {
      this.settle(job, 'failed', 'sources');
      return;
    }
    const stop = (): void => {
      void fetcher.close();
    };
    const unhook = signal.onStop(stop);
    try {
      let begin = job.begin;
      if (begin === null) {
        await this.turn(job);
        const got = await this.fetchBegin(job, fetcher);
        if (signal.aborted) {
          this.stopped(job);
          return;
        }
        if (typeof got === 'string') {
          this.settle(job, 'failed', got);
          return;
        }
        begin = got;
        job.begin = got;
      } else {
        fetcher.learn?.(job.root, begin.hashListBytes);
        fetcher.learn?.(begin.playlistSha, begin.playlistBytes);
      }
      // Read again after the awaits: a job never begins a keep that is gone meanwhile.
      const reason = this.reasonOf(job);
      if (signal.aborted) {
        this.stopped(job);
        return;
      }
      if (reason === null) {
        this.forget(job);
        return;
      }
      const result = await keepRendition({
        store,
        video: job.video,
        root: job.root,
        segs: BigInt(job.segs),
        hashListBytes: begin.hashListBytes,
        rendition: job.rendition,
        playlistBytes: begin.playlistBytes,
        reason,
        held: (sha) => this.held(job, sha),
        fetch: (file, s) => fetchFile(fetcher, file, s),
        spend: async (bytes) => !signal.aborted && (await this.d.budget.spend(bytes)),
        signal,
        maxFileBytes: this.maxFileBytes,
        onProgress: () => {
          this.changed(job.key);
        },
      });
      this.outcome(job, result, signal);
    } finally {
      unhook();
      await fetcher.close().catch(() => undefined);
    }
  }

  /**
   * A resumed job's hash list and playlist, from its sources: the hash list checked against the
   * manifest, the playlist found in it (the store checks both again). Else why not.
   */
  private async fetchBegin(job: Job, fetcher: NfxFetcher): Promise<JobBegin | NfxKeepFailure> {
    const size = this.d.store.keptOf(job.video)?.meta.find((f) => f.sha256 === job.root)?.size;
    if (size === undefined) return 'store';
    let hashListBytes: Uint8Array;
    try {
      hashListBytes = await fetcher.fetch(job.root, size, true);
    } catch {
      return 'fetch';
    }
    const verified = nfx.verifyHashList(hashListBytes, job.root, job.video, BigInt(job.segs));
    if (!verified.ok) return 'invalid';
    const list = verified.value;
    const rendition = list.renditions.find((r) => r.id === job.rendition);
    const entry = list.files.find((f) => f.role === 'playlist' && f.name === rendition?.playlist);
    if (entry === undefined) return 'invalid';
    if (entry.size > BigInt(this.maxFileBytes)) return 'too-large';
    try {
      const playlistBytes = await fetcher.fetch(entry.sha256, Number(entry.size), true);
      return { hashListBytes, playlistSha: entry.sha256, playlistBytes };
    } catch {
      return 'fetch';
    }
  }

  /**
   * Before each file: the job's turn (it waits while a play is open and an older job runs), then
   * the file from an open play's spool if one has it.
   */
  private async held(job: Job, sha: string): Promise<Uint8Array | null> {
    await this.turn(job);
    return (await this.d.spooled?.(job.key, sha)) ?? null;
  }

  private turn(job: Job): Promise<void> {
    if (this.mayGo(job)) return Promise.resolve();
    return new Promise((resolve) => {
      this.turns.set(job, () => {
        resolve();
      });
    });
  }

  /** A running job goes on while it is among the first `limit()`; a stopping one, to stop. */
  private mayGo(job: Job): boolean {
    return job.stopping !== null || this.running.indexOf(job) < this.limit();
  }

  private releaseTurns(): void {
    for (const [job, resolve] of [...this.turns]) {
      if (!this.mayGo(job)) continue;
      this.turns.delete(job);
      resolve();
    }
  }

  /** The reason to keep `job` under now, or `null` when its rendition is no longer filling. */
  private reasonOf(job: Job): NfxKeepReason | null {
    const r = this.d.store.keptOf(job.video);
    if (r?.root !== job.root || r.filling?.rendition !== job.rendition) return null;
    return r.reasons.downloaded === undefined ? 'watched' : 'downloaded';
  }

  private outcome(job: Job, r: KeepJobResult, signal: KeepSignal): void {
    if (signal.aborted) {
      this.stopped(job);
      return;
    }
    if (r.ok) {
      this.settle(job, 'held');
      return;
    }
    if (r.state === 'stopped') {
      this.settle(job, r.why === 'budget' ? 'budget' : 'queued');
      return;
    }
    // A code only: a message may name a file.
    this.d.logger.info('nfx: a keep job failed', { error: r.error });
    this.settle(job, 'failed', failure(r.error));
  }

  /** A stopped run: a paused job goes back in line; an ended one is already gone. */
  private stopped(job: Job): void {
    if (job.stopping === 'pause') this.settle(job, 'queued');
  }

  /** `job`'s run ended in `state`, unless it was ended meanwhile. */
  private settle(
    job: Job,
    state: 'held' | 'failed' | 'budget' | 'queued',
    error: NfxKeepFailure | null = null,
  ): void {
    if (this.jobs.get(job.key) !== job || this.closing !== null) return;
    job.state = state;
    job.error = error;
    if (state === 'held' || state === 'failed') job.begin = null;
    if (state === 'queued') this.insert(job);
    if (state === 'budget') this.retryLater();
    this.changed(job.key);
  }

  /** Its record no longer fills its rendition (dropped, held elsewhere): the job goes. */
  private forget(job: Job): void {
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    this.changed(job.key);
  }

  /** End `key`'s job: out of line, stopped if running. */
  private end(key: string): void {
    const job = this.jobs.get(key);
    if (job === undefined) return;
    this.jobs.delete(key);
    this.queue = this.queue.filter((j) => j !== job);
    if (job.abort !== null) this.stop(job, 'end');
  }

  private stop(job: Job, why: 'pause' | 'end'): void {
    job.stopping = why;
    job.abort?.stop();
    this.releaseTurns();
  }

  /** Jobs the budget stopped go back in line after `budgetRetryMs`. */
  private retryLater(): void {
    if (this.budgetTimer !== null || this.closing !== null) return;
    this.budgetTimer = setTimeout(() => {
      this.budgetTimer = null;
      for (const job of this.jobs.values()) {
        if (job.state !== 'budget') continue;
        job.state = 'queued';
        this.insert(job);
        this.changed(job.key);
      }
      this.pump();
    }, this.budgetRetryMs);
  }

  private jobWire(key: string): NfxKeepJobWire | null {
    const job = this.jobs.get(key);
    if (job === undefined) return null;
    switch (job.state) {
      case 'running':
        return { state: 'fetching' };
      case 'play':
      case 'queued':
      case 'budget':
        return { state: 'waiting' };
      case 'held':
        return { state: 'held' };
      case 'failed':
        return { state: 'failed', error: job.error ?? 'store' };
    }
  }

  /** `nfx.keep.changed` for `key`, at most once per `eventMs`. */
  private changed(key: string): void {
    if (this.closing !== null) return;
    this.pending.add(key);
    this.eventTimer ??= setTimeout(() => {
      this.eventTimer = null;
      const keys = [...this.pending];
      this.pending.clear();
      for (const k of keys) this.d.changed(k);
    }, this.eventMs);
  }

  private assertOn(): void {
    if (this.closing !== null) fail('backend-down', 'worker is shutting down');
    if (!this.on) fail('forbidden', 'NFX is off');
  }
}
