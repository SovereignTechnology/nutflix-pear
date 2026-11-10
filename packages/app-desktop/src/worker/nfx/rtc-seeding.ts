/**
 * NFX seeding to browsers over WebRTC (ADR 0023, #89), beside iroh's (`./iroh-seeding.ts`): this
 * node's stored NFX videos, served in their NFX-10 web swarms by the worker's WebRTC node
 * (`./rtc-node.ts`) while seeding AND NFX AND WebRTC are on, and only then.
 *
 * The work runs in passes, one at a time: at every `set`, every `refresh` (the host's beacon round
 * is the clock, as for iroh), and when the helper restarts. A pass serves what is stored and not
 * yet served, and stops serving what is no longer stored. For each video, each rendition:
 * - **Its swarm** is `video.webStreamSwarmId(rendition)` (NFX-10 §2), the id the browser player
 *   joins.
 * - **Its segments** are its playlist's, in order (`renditionMembers`, the verified hash list's
 *   names only): segment id = the #EXTINF index, as p2p-media-loader numbers them. Each is served
 *   from its path in the NFX store, which names a path only for a file that video's verified hash
 *   list lists (`NfxStore.path`), at the hash list's size. The helper reads a file only when a
 *   peer asks, refuses one whose size changed, and never claims a hash: browsers check every
 *   segment against the hash list (NFX-10 §1).
 * - A table goes in pages of at most `PAGE_BYTES` of JSON (one helper frame is 64 KiB).
 * - A video whose playlists do not resolve, or with a segment over 64 MiB, is not served over
 *   WebRTC (it still is over iroh and HyperDHT); that is logged once.
 */
import { nfx } from '@sovit/core';
import type { Logger, NfxVideoRecord } from '@sovit/seeder';
import { NFX_MAX_READ_BYTES } from '@sovit/seeder';

import type { HelperRtcSegment, IrohHelper } from '../iroh/helper.js';
import { MAX_GET_BYTES } from '../iroh/helper.js';
import type { NfxIrohStore } from './iroh-seeding.js';
import type { NfxRtcNode } from './rtc-node.js';

/** JSON bytes of segment entries in one `rtc-serve` (the frame's cap is 64 KiB). */
export const PAGE_BYTES = 48 * 1024;
/** The helper serves at most this many swarms. */
export const MAX_RTC_SWARMS = 64;

export interface NfxRtcSeedingDeps {
  readonly node: NfxRtcNode;
  readonly store: NfxIrohStore;
  readonly logger: Logger;
}

interface Served {
  readonly root: string;
  readonly swarms: readonly string[];
}

/** Why a video will not be served over WebRTC (until the next helper): logged once. */
class NotServable extends Error {}

/** A `set` came while a pass ran: the pass stops where it is. */
class Overtaken extends Error {}

/** `segments` cut into pages whose JSON stays under `PAGE_BYTES`. */
export function pages(segments: readonly HelperRtcSegment[]): HelperRtcSegment[][] {
  const out: HelperRtcSegment[][] = [];
  let page: HelperRtcSegment[] = [];
  let bytes = 0;
  for (const s of segments) {
    const n = JSON.stringify(s).length + 1;
    if (page.length > 0 && bytes + n > PAGE_BYTES) {
      out.push(page);
      page = [];
      bytes = 0;
    }
    page.push(s);
    bytes += n;
  }
  if (page.length > 0) out.push(page);
  return out;
}

export class NfxRtcSeeding {
  private readonly d: NfxRtcSeedingDeps;
  private on = false;
  private epoch = 0;
  private queue: Promise<void> = Promise.resolve();
  private passQueued = false;
  private closed = false;
  private generation = -1;
  /** By video address. */
  private readonly served = new Map<string, Served>();
  /** `<video> <root>` of videos the current helper will not serve. */
  private readonly refused = new Set<string>();
  private readonly offGeneration: () => void;

  constructor(d: NfxRtcSeedingDeps) {
    this.d = d;
    // A new or restarted helper serves nothing: serve again.
    this.offGeneration = d.node.onGeneration(() => {
      this.kick();
    });
  }

  /** How many videos are served over WebRTC now. */
  get videos(): number {
    return this.served.size;
  }

  /** The swarms served for `video` (its address), if any. */
  swarms(video: string): readonly string[] {
    return this.served.get(video)?.swarms ?? [];
  }

  /** Serve (`on`) or stop serving. Never throws; serving goes on in the background. */
  set(on: boolean): Promise<void> {
    this.on = on && !this.closed;
    this.epoch += 1;
    const applied = this.enqueue(async () => {
      if (!this.on) await this.unserveAll();
    });
    if (this.on) this.kick();
    return applied;
  }

  /** Another pass, for what was stored or removed since the last. */
  refresh(): void {
    this.kick();
  }

  /** Settles once the work queued so far (passes, stops) has run. */
  idle(): Promise<void> {
    return this.queue;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.on = false;
    this.epoch += 1;
    this.offGeneration();
    await this.enqueue(() => this.unserveAll());
  }

  private kick(): void {
    if (this.passQueued || !this.on) return;
    this.passQueued = true;
    void this.enqueue(async () => {
      this.passQueued = false;
      await this.pass();
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((err: unknown) => {
      this.d.logger.warn('nfx: serving over WebRTC failed', { error: err });
    });
    return this.queue;
  }

  private async unserveAll(): Promise<void> {
    const swarms = [...this.served.values()].flatMap((s) => s.swarms);
    this.served.clear();
    this.refused.clear();
    // Only the helper that serves them: never one started to stop serving.
    const helper = this.d.node.current();
    if (swarms.length === 0 || helper === null || this.d.node.generation !== this.generation)
      return;
    for (const swarm of swarms) await helper.rtcUnserve(swarm).catch(() => false);
  }

  private async pass(): Promise<void> {
    const epoch = this.epoch;
    if (!this.on || !this.d.node.on) return;
    if (this.served.size === 0 && this.d.store.videos().length === 0) return;
    const helper = await this.d.node.start();
    if (helper === null || epoch !== this.epoch) return;
    const generation = this.d.node.generation;
    if (generation !== this.generation) {
      // Another helper: it serves nothing yet.
      this.served.clear();
      this.refused.clear();
      this.generation = generation;
    }
    const stored = new Map(this.d.store.videos().map((r) => [r.video, r] as const));
    for (const [video, s] of [...this.served]) {
      if (stored.get(video)?.root === s.root) continue;
      this.served.delete(video);
      for (const swarm of s.swarms) await helper.rtcUnserve(swarm).catch(() => false);
    }
    for (const r of stored.values()) {
      if (epoch !== this.epoch || this.d.node.generation !== generation) return;
      if (this.served.has(r.video)) continue;
      const key = `${r.video} ${r.root}`;
      if (this.refused.has(key)) continue;
      try {
        this.served.set(r.video, await this.serve(helper, r, epoch));
      } catch (err) {
        if (err instanceof Overtaken || epoch !== this.epoch) return;
        if (err instanceof NotServable) {
          this.refused.add(key);
          this.d.logger.warn('nfx: a stored video is not served over WebRTC', {
            video: r.video,
            reason: err.message,
          });
          continue;
        }
        // The helper's trouble (restarting, busy, at its swarm limit): the next pass tries again.
        this.d.logger.warn('nfx: a video could not be served over WebRTC yet', {
          video: r.video,
          error: err,
        });
        return;
      }
    }
  }

  private async serve(helper: IrohHelper, r: NfxVideoRecord, epoch: number): Promise<Served> {
    const video = nfx.VideoAddr.parse(r.video);
    if (!video.ok) throw new NotServable('not an NFX video address');
    const listBytes = await this.read(video.value, r.root);
    const verified = nfx.verifyHashList(listBytes, r.root, video.value, BigInt(r.segs));
    if (!verified.ok) throw new NotServable(`its hash list: ${verified.error.reason}`);
    const list = verified.value;
    const tables: (readonly [string, HelperRtcSegment[]])[] = [];
    for (const rendition of list.renditions) {
      const entry = list.files.find((f) => f.role === 'playlist' && f.name === rendition.playlist);
      if (entry === undefined) throw new NotServable(`no playlist for ${rendition.id}`);
      const members = nfx.renditionMembers(list, await this.read(video.value, entry.sha256));
      if (!members.ok) throw new NotServable(`a playlist: ${members.error.reason}`);
      const segments = members.value.segments.map((f, id) => {
        const path = this.d.store.path(video.value, f.sha256);
        if (path === undefined) throw new NotServable('a segment is not a listed, stored file');
        if (f.size < 1n || f.size > BigInt(MAX_GET_BYTES))
          throw new NotServable('a segment over 64 MiB');
        return { id, path, size: Number(f.size) };
      });
      tables.push([video.value.webStreamSwarmId(rendition.id), segments]);
    }
    const swarms = [...this.served.values()].reduce((n, s) => n + s.swarms.length, 0);
    if (swarms + tables.length > MAX_RTC_SWARMS)
      throw new Error('the WebRTC side serves as many swarms as it can');
    const done: string[] = [];
    for (const [swarm, segments] of tables) {
      for (const [i, page] of pages(segments).entries()) {
        if (epoch !== this.epoch) throw new Overtaken();
        await helper.rtcServe(swarm, page, i > 0);
      }
      done.push(swarm);
    }
    return { root: r.root, swarms: done };
  }

  /** A whole stored file of `video`: its hash list or a playlist (at most 16 MiB). */
  private async read(video: nfx.VideoAddr, sha: string): Promise<Uint8Array> {
    const f = this.d.store.file(video, sha);
    if (f === undefined) throw new NotServable('a listed file is not in the store');
    if (f.size > NFX_MAX_READ_BYTES) throw new NotServable('a file over 16 MiB to read whole');
    return f.read(0, f.size);
  }
}
