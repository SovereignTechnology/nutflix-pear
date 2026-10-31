/**
 * Slice 5c: the NFX videos this node may announce, and whose manifest each one is.
 *
 * A beacon's `a` names the manifest's author (NFX-03 §1), and an address is its author's
 * (NFX-02 §2), but the worker's store keeps files by video address only. So the host records the
 * author when it learns it: on publishing the user's own manifest (slice 4a), and on fetching
 * another creator's (slice 5d). Public data, kept in `<userData>/nfx/seeded.json`.
 */
import { join } from 'node:path';

import type { NostrPubkey, Sha256Hex } from '@sovit/core';

import type { Logger } from '../log.js';
import { JsonFile } from '../settings/json-file.js';

export const SEEDED_FILE = 'seeded.json';
/** At most this many records; the oldest go first. */
export const MAX_SEEDED = 4096;

export interface SeededVideo {
  /** `<namespace>:<video-id>`. */
  readonly video: string;
  readonly author: NostrPubkey;
  /** The root the store verified the video's files against. */
  readonly root: Sha256Hex;
}

const VIDEO = /^nfx:[a-z0-9-]{2,32}:(?:0|[1-9][0-9]{0,19}):[a-z0-9][a-z0-9-]{6,62}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function isSeeded(x: unknown): x is SeededVideo {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    Object.keys(r).length === 3 &&
    typeof r['video'] === 'string' &&
    VIDEO.test(r['video']) &&
    typeof r['author'] === 'string' &&
    HEX64.test(r['author']) &&
    typeof r['root'] === 'string' &&
    HEX64.test(r['root'])
  );
}

interface SeededFile {
  readonly v: 1;
  readonly videos: readonly SeededVideo[];
}

function parseSeededFile(raw: unknown): SeededFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const videos = r['videos'];
  if (r['v'] !== 1 || !Array.isArray(videos) || videos.length > MAX_SEEDED) return null;
  return videos.every(isSeeded) ? { v: 1, videos } : null;
}

export class SeededVideos {
  private readonly file: JsonFile<SeededFile>;
  private videos: readonly SeededVideo[] = [];

  /** `dir` is `<userData>/nfx`. */
  constructor(dir: string, log: Logger) {
    this.file = new JsonFile(join(dir, SEEDED_FILE), parseSeededFile, log);
  }

  /** Reads the file; a missing or bad one is an empty list. */
  async load(): Promise<void> {
    const r = await this.file.load();
    this.videos = r.kind === 'ok' ? r.value.videos : [];
  }

  list(): readonly SeededVideo[] {
    return this.videos;
  }

  /** Records (or replaces) `v` for its video and author, then persists. */
  async add(v: SeededVideo): Promise<void> {
    if (!isSeeded(v)) throw new TypeError('invalid seeded video');
    const rest = this.videos.filter((x) => !(x.video === v.video && x.author === v.author));
    const next = [...rest, v].slice(-MAX_SEEDED);
    await this.file.save({ v: 1, videos: next });
    this.videos = next;
  }
}
