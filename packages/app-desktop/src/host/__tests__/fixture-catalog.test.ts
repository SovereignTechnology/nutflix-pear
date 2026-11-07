/**
 * `--dev-fixtures` boot race (docs/archive/lanes/E2E-fix.md, failure 3): the Home screen fetches its
 * feed once, at mount, about a second before the worker's `dev.fixtures` event reaches the
 * catalogue — so it rendered the mock catalogue only and never showed the playable fixtures.
 * Catalogue reads now wait for the first `dev.fixtures`, bounded by `FIXTURE_WAIT_MS`, and stop
 * waiting when the worker fails for good or is stopped. Manual clock; no real-time waits.
 */
import { describe, expect, it } from 'vitest';

import type { NostrEventId, VideoManifest } from '@sovit/core';
import { mocks } from '@sovit/core';

import { FIXTURE_WAIT_MS, FixtureCatalog } from '../catalog/fixture-catalog.js';
import { memoryLogger } from '../log.js';
import type { Timers } from '../worker/supervisor.js';

class ManualClock implements Timers {
  now = 0;
  private seq = 0;
  private readonly due = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.due.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.due.delete(h as number);
  }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.due.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.due.delete(next[0]);
      this.now = next[1].at;
      next[1].fn();
    }
    this.now = end;
  }
  pending(): number {
    return this.due.size;
  }
}

/** Lets every queued promise job and the macrotask after them run (not a sleep). */
const settle = (): Promise<void> =>
  new Promise((r) => {
    setImmediate(r);
  });

/** Tracks whether `p` has resolved yet. */
function track<T>(p: Promise<T>): { readonly done: () => boolean; readonly value: Promise<T> } {
  let done = false;
  const value = p.then((v) => {
    done = true;
    return v;
  });
  return { done: () => done, value };
}

const LIVE: VideoManifest = {
  ...mocks.VIDEOS[0]!,
  id: 'f'.repeat(64) as NostrEventId,
  title: 'E2E fixture A',
};

function make(waitMs?: number): {
  cat: FixtureCatalog;
  clock: ManualClock;
  log: ReturnType<typeof memoryLogger>;
} {
  const clock = new ManualClock();
  const log = memoryLogger('debug');
  const cat = new FixtureCatalog(log, {
    timers: clock,
    ...(waitMs === undefined ? {} : { waitMs }),
  });
  return { cat, clock, log };
}

const warned = (log: ReturnType<typeof memoryLogger>, start: string): number =>
  log.lines.filter((l) => l.level === 'warn' && l.msg.startsWith(start)).length;

describe('FixtureCatalog waits for the worker’s first dev.fixtures', () => {
  it('reads before the event wait for it, then list the live fixtures first', async () => {
    const { cat, clock } = make();
    expect(cat.waiting).toBe(true);
    const feed = track(cat.feed({ source: 'trending' }, mocks.ME));
    const video = track(cat.video(LIVE.id));
    const seeded = track(cat.seedersOnline(LIVE));
    const search = track(cat.search({ text: 'e2e fixture' }));
    const related = track(cat.related(mocks.VIDEOS[1]!.id, 50));
    const many = track(cat.videos([LIVE.id, mocks.VIDEOS[1]!.id]));
    await settle();
    for (const t of [feed, video, seeded, search, related, many]) expect(t.done()).toBe(false);

    cat.setLive([LIVE]);
    expect(cat.waiting).toBe(false);
    expect(clock.pending()).toBe(0); // the bound's timer is gone with the wait
    expect((await feed.value).items[0]?.id).toBe(LIVE.id);
    expect(await video.value).toEqual(LIVE);
    expect(await seeded.value).toBe(1);
    expect((await search.value).items.map((v) => v.id)).toEqual([LIVE.id]);
    expect((await related.value).map((v) => v.id)).toContain(LIVE.id);
    expect((await many.value).map((v) => v.id)).toEqual([LIVE.id, mocks.VIDEOS[1]!.id]);
  });

  it('after the event, reads answer without waiting (nothing on the clock)', async () => {
    const { cat } = make();
    cat.setLive([LIVE]);
    const feed = track(cat.feed({ source: 'trending' }, mocks.ME));
    await settle();
    expect(feed.done()).toBe(true);
  });

  it('the network feed (v13) lists the NFX fixtures only', async () => {
    const { cat } = make();
    cat.setLive([LIVE]);
    const page = await cat.feed({ source: 'network' }, null);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((v) => v.kind === 38504)).toBe(true);
  });

  it('the bound: past FIXTURE_WAIT_MS it answers with what is there and logs once', async () => {
    const { cat, clock, log } = make();
    const feed = track(cat.feed({ source: 'trending' }, mocks.ME));
    clock.advance(FIXTURE_WAIT_MS - 1);
    await settle();
    expect(feed.done()).toBe(false);
    clock.advance(1);
    const page = await feed.value;
    expect(page.items.map((v) => v.id)).not.toContain(LIVE.id);
    expect(page.items.length).toBeGreaterThan(0); // the mock catalogue
    expect(warned(log, 'dev fixtures: none from the worker in time')).toBe(1);
    // Later reads do not wait again, and nothing else is logged about it.
    const again = track(cat.feed({ source: 'trending' }, mocks.ME));
    await settle();
    expect(again.done()).toBe(true);
    clock.advance(10 * FIXTURE_WAIT_MS);
    expect(warned(log, 'dev fixtures: none from the worker in time')).toBe(1);
    // A late event still replaces the set.
    cat.setLive([LIVE]);
    expect((await cat.feed({ source: 'trending' }, mocks.ME)).items[0]?.id).toBe(LIVE.id);
    expect(warned(log, 'dev fixtures: the media worker is gone')).toBe(0);
  });

  it('a worker that fails for good or is stopped ends the wait at once (logged once)', async () => {
    const { cat, clock, log } = make();
    const feed = track(cat.feed({ source: 'trending' }, mocks.ME));
    await settle();
    expect(feed.done()).toBe(false);
    cat.workerGone();
    await feed.value;
    expect(clock.pending()).toBe(0);
    cat.workerGone();
    clock.advance(FIXTURE_WAIT_MS);
    expect(warned(log, 'dev fixtures: the media worker is gone')).toBe(1);
    expect(warned(log, 'dev fixtures: none from the worker in time')).toBe(0);
  });

  it('the bound is clamped to FIXTURE_WAIT_MS (≤ 15 s) and never negative', async () => {
    expect(FIXTURE_WAIT_MS).toBeLessThanOrEqual(15_000);
    const long = make(10 * FIXTURE_WAIT_MS);
    const a = track(long.cat.feed({ source: 'trending' }, null));
    long.clock.advance(FIXTURE_WAIT_MS);
    await a.value;

    const negative = make(-5);
    const b = track(negative.cat.feed({ source: 'trending' }, null));
    negative.clock.advance(0);
    await b.value;
    expect(negative.cat.waiting).toBe(false);
  });

  it('profile() never reads the live set and does not wait', async () => {
    const { cat } = make();
    const p = track(cat.profile(mocks.ME));
    await settle();
    expect(p.done()).toBe(true);
    expect(await p.value).toEqual(mocks.MY_PROFILE);
    expect(cat.waiting).toBe(true);
  });
});
