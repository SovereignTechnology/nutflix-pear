/**
 * How much keeping may start and fetch in an hour (NFX-18 §2.4), so that a page that plays one
 * video after another cannot turn the app into a downloader: by default 20 new videos and 16 GiB
 * an hour, nutflix-runtime's limits for "seed what you watch". Saved (`keep-budget.json`) so that
 * a restart, or a crash loop, does not reset it; bytes are kept in one-minute buckets, so the file
 * stays small however many files are fetched.
 */
import type { SeederCrypto } from '../adapters/crypto.js';
import type { SeederFs } from '../adapters/fs.js';
import { JsonStore } from '../store/json-store.js';

export const KEEP_BUDGET_FILE = 'keep-budget.json' as const;
export const DEFAULT_KEEP_STARTS_PER_HOUR = 20;
export const DEFAULT_KEEP_BYTES_PER_HOUR = 16 * 1024 * 1024 * 1024;

const HOUR_MS = 3_600_000;
const BUCKET_MS = 60_000;

interface BudgetFile {
  readonly version: 1;
  /** When each new video started (ms). */
  readonly starts: readonly number[];
  /** Bytes fetched per minute: `[bucket start ms, bytes]`. */
  readonly fetched: readonly (readonly [number, number])[];
}

function validate(raw: unknown): BudgetFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o['version'] !== 1 || !Array.isArray(o['starts']) || !Array.isArray(o['fetched']))
    return null;
  const ms = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
  const starts = (o['starts'] as unknown[]).filter(ms);
  const fetched: [number, number][] = [];
  for (const b of o['fetched'] as unknown[])
    if (Array.isArray(b) && b.length === 2 && ms(b[0]) && ms(b[1])) fetched.push([b[0], b[1]]);
  return { version: 1, starts, fetched };
}

export interface KeepBudgetOptions {
  readonly fs: SeederFs;
  readonly crypto: SeederCrypto;
  /** Where `keep-budget.json` lives. */
  readonly dir: string;
  readonly startsPerHour?: number;
  readonly bytesPerHour?: number;
  /** Milliseconds. */
  readonly now?: () => number;
}

export class KeepBudget {
  private readonly db: JsonStore<BudgetFile>;
  private readonly now: () => number;
  private readonly startsPerHour: number;
  private readonly bytesPerHour: number;
  private starts: number[] = [];
  private fetched: [number, number][] = [];
  private dirty = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(o: KeepBudgetOptions) {
    this.db = new JsonStore<BudgetFile>(
      o.fs,
      o.crypto,
      o.fs.join(o.dir, KEEP_BUDGET_FILE),
      validate,
      () => ({ version: 1, starts: [], fetched: [] }),
    );
    this.now = o.now ?? Date.now;
    this.startsPerHour = o.startsPerHour ?? DEFAULT_KEEP_STARTS_PER_HOUR;
    this.bytesPerHour = o.bytesPerHour ?? DEFAULT_KEEP_BYTES_PER_HOUR;
  }

  /** Never throws: an unreadable file is an empty budget (and is written over at the next save). */
  async load(): Promise<void> {
    try {
      const { value } = await this.db.load();
      // A clock set back must not stretch the window: nothing later than now is kept.
      const now = this.now();
      this.starts = value.starts.filter((t) => t <= now);
      this.fetched = value.fetched.filter(([t]) => t <= now).map(([t, b]) => [t, b]);
    } catch {
      this.starts = [];
      this.fetched = [];
    }
    this.prune();
  }

  /** Whether a new video may start keeping now. */
  canStart(): boolean {
    this.prune();
    return this.starts.length < this.startsPerHour && this.sumBytes() < this.bytesPerHour;
  }

  /** Count a new video's start. `false`, and nothing counted, when the hour has none left. */
  async start(): Promise<boolean> {
    if (!this.canStart()) return false;
    this.starts.push(this.now());
    await this.save();
    return true;
  }

  /** Spend `bytes` about to be fetched. `false`, and nothing spent, when it would pass the hour's. */
  async spend(bytes: number): Promise<boolean> {
    this.prune();
    if (!Number.isSafeInteger(bytes) || bytes < 0) return false;
    if (this.sumBytes() + bytes > this.bytesPerHour) return false;
    const bucket = Math.floor(this.now() / BUCKET_MS) * BUCKET_MS;
    const last = this.fetched.at(-1);
    if (last?.[0] === bucket) last[1] += bytes;
    else this.fetched.push([bucket, bytes]);
    await this.save();
    return true;
  }

  /** Bytes fetched within the last hour. */
  usedBytes(): number {
    this.prune();
    return this.sumBytes();
  }

  private sumBytes(): number {
    let n = 0;
    for (const [, b] of this.fetched) n += b;
    return n;
  }

  /** Save now if anything changed. */
  flush(): Promise<void> {
    if (!this.dirty) return this.saving;
    return this.save();
  }

  private save(): Promise<void> {
    this.dirty = false;
    const value: BudgetFile = {
      version: 1,
      starts: [...this.starts],
      fetched: this.fetched.map(([t, b]) => [t, b] as const),
    };
    this.saving = this.saving
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.db.save(value);
        } catch (err) {
          this.dirty = true;
          throw err;
        }
      });
    return this.saving;
  }

  private prune(): void {
    const since = this.now() - HOUR_MS;
    this.starts = this.starts.filter((t) => t > since);
    this.fetched = this.fetched.filter(([t]) => t + BUCKET_MS > since);
  }
}
