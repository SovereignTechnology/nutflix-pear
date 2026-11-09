/**
 * `NfxBeaconWatch` (found by the slice 5f exit run): beacons are ephemeral (NFX-04), so a play
 * holds a live subscription until one names a source, at most one republish interval; what
 * arrived is cached for a beacon's lifetime, bounded; the Watch page opens it ahead of a play.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NfxVideo, NostrEvent, NostrFilter, RelayUrl } from '../../contracts/index.js';
import { KIND_BEACON, beaconFilter } from '../../nfx/index.js';
import {
  MAX_BEACONS_PER_VIDEO,
  MAX_BEACON_VIDEOS,
  NFX_BEACON_KEEP_S,
  NFX_BEACON_WAIT_MS,
  NfxBeaconWatch,
} from '../nfx-beacon-watch.js';

const R1 = 'wss://scoped-1.test' as RelayUrl;
const R2 = 'wss://scoped-2.test' as RelayUrl;

function video(n: number): NfxVideo {
  return {
    id: `38504:${'a'.repeat(64)}:nfx:testnet:1:video-${String(n).padStart(7, '0')}`,
    namespace: 'nfx:testnet:1',
  } as unknown as NfxVideo;
}

let seq = 0;
function ev(createdAt: number): NostrEvent {
  seq += 1;
  return { id: seq.toString(16).padStart(64, '0'), created_at: createdAt } as NostrEvent;
}

interface Sub {
  readonly filter: NostrFilter;
  readonly relays: readonly RelayUrl[];
  readonly push: (e: NostrEvent) => void;
  closed: boolean;
}

function rigged(): {
  readonly w: NfxBeaconWatch;
  readonly subs: Sub[];
  readonly clock: { now: number };
  readonly timers: { at: number; fn: () => void; dead: boolean }[];
  readonly advance: (ms: number) => void;
} {
  const subs: Sub[] = [];
  const clock = { now: 1_800_000_000 };
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  let ms = 0;
  const w = new NfxBeaconWatch({
    subscribe: (filter, relays, onEvent) => {
      const s: Sub = { filter, relays, push: onEvent, closed: false };
      subs.push(s);
      return () => {
        s.closed = true;
      };
    },
    now: () => clock.now,
    timers: {
      setTimeout: (fn, delay) => {
        const t = { at: ms + delay, fn, dead: false };
        timers.push(t);
        return t;
      },
      clearTimeout: (h) => {
        (h as { dead: boolean }).dead = true;
      },
    },
  });
  const advance = (step: number): void => {
    const end = ms + step;
    for (;;) {
      const next = timers.filter((t) => !t.dead && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (next === undefined) break;
      ms = next.at;
      clock.now = 1_800_000_000 + Math.floor(ms / 1000);
      next.dead = true;
      next.fn();
    }
    ms = end;
    clock.now = 1_800_000_000 + Math.floor(ms / 1000);
  };
  return { w, subs, clock, timers, advance };
}

const any = (evs: readonly NostrEvent[]): boolean => evs.length > 0;

describe('NfxBeaconWatch in core (ADR 0022)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("beaconFilter: kind 20464 with the video's namespace and address (NFX-04 §5)", () => {
    const v = video(1);
    expect(beaconFilter(v)).toEqual({
      kinds: [KIND_BEACON],
      '#n': ['nfx:testnet:1'],
      '#a': [v.id],
    });
  });

  it("runs on the runtime's own timers when none are passed (a browser has no unref)", async () => {
    vi.useFakeTimers();
    let closed = 0;
    const w = new NfxBeaconWatch({
      subscribe: () => () => {
        closed++;
      },
      now: () => Math.floor(Date.now() / 1000),
    });
    const waited = w.wait(video(2), [R1], (e) => e.length > 0, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waited).resolves.toEqual([]);
    expect(closed).toBe(0);
    await vi.advanceTimersByTimeAsync(NFX_BEACON_WAIT_MS * 2);
    expect(closed).toBe(1);
    w.close();
  });
});

describe('NfxBeaconWatch', () => {
  it('a waiting play opens on the first beacon that names a source, not before', async () => {
    const { w, subs, clock } = rigged();
    const v = video(1);
    const done: { v: NostrEvent[] | null } = { v: null };
    const p = w.wait(v, [R1], any).then((evs) => {
      done.v = evs;
    });
    expect(subs).toHaveLength(1);
    const [sub] = subs;
    // The video's beacons, live, from a little before now (none is ever stored).
    expect(sub?.filter).toMatchObject({ kinds: [20464], '#a': [v.id], '#n': [v.namespace] });
    expect(sub?.filter.since).toBe(clock.now - NFX_BEACON_KEEP_S);
    expect(sub?.relays).toEqual([R1]);
    await Promise.resolve();
    expect(done.v).toBeNull();
    const b = ev(clock.now);
    sub?.push(b);
    await p;
    expect(done.v).toEqual([b]);
  });

  it('answers at once from what arrived earlier (the Watch page), within its lifetime', async () => {
    const { w, subs, clock, advance } = rigged();
    const v = video(2);
    w.watch(v, [R1]);
    const b = ev(clock.now);
    subs[0]?.push(b);
    expect(await w.wait(v, [R1], any)).toEqual([b]);
    // One subscription served both.
    expect(subs).toHaveLength(1);
    // Past its lifetime it is gone, and a play waits again.
    advance((NFX_BEACON_KEEP_S + 1) * 1000);
    expect(w.seen(v)).toEqual([]);
  });

  it('with nobody seeding, the wait ends after one republish interval with nothing', async () => {
    const { w, subs, advance } = rigged();
    const v = video(3);
    const done: { v: NostrEvent[] | null } = { v: null };
    const p = w.wait(v, [R1], any).then((evs) => {
      done.v = evs;
    });
    advance(NFX_BEACON_WAIT_MS - 1);
    await Promise.resolve();
    expect(done.v).toBeNull();
    advance(1);
    await p;
    expect(done.v).toEqual([]);
    // The subscription stays for the warm-up, then closes on its own.
    expect(subs[0]?.closed).toBe(false);
    advance(120_000);
    expect(subs[0]?.closed).toBe(true);
  });

  it('a beacon that names no source keeps the play waiting', async () => {
    const { w, subs, clock, advance } = rigged();
    const v = video(4);
    const paid = ev(clock.now);
    const free = ev(clock.now);
    const done: { v: NostrEvent[] | null } = { v: null };
    const p = w
      .wait(v, [R1], (evs) => evs.some((e) => e.id === free.id))
      .then((evs) => {
        done.v = evs;
      });
    subs[0]?.push(paid);
    await Promise.resolve();
    expect(done.v).toBeNull();
    advance(1000);
    subs[0]?.push(free);
    await p;
    expect(done.v?.map((e) => e.id).sort()).toEqual([paid.id, free.id].sort());
  });

  it('no scoped relay: nothing to wait for', async () => {
    const { w, subs } = rigged();
    expect(await w.wait(video(5), [], any)).toEqual([]);
    w.watch(video(5), []);
    expect(subs).toEqual([]);
  });

  it('other relays: a new subscription on them, what was seen kept', () => {
    const { w, subs, clock } = rigged();
    const v = video(6);
    w.watch(v, [R1]);
    const b = ev(clock.now);
    subs[0]?.push(b);
    w.watch(v, [R2]);
    expect(subs[0]?.closed).toBe(true);
    expect(subs[1]?.relays).toEqual([R2]);
    expect(w.seen(v)).toEqual([b]);
  });

  it('bounded: beacons per video, and idle videos', () => {
    const { w, subs, clock } = rigged();
    const v = video(7);
    w.watch(v, [R1]);
    for (let i = 0; i < MAX_BEACONS_PER_VIDEO + 5; i++) subs[0]?.push(ev(clock.now - 100 + i));
    const seen = w.seen(v);
    expect(seen).toHaveLength(MAX_BEACONS_PER_VIDEO);
    // The oldest went; newest first.
    expect(seen[0]?.created_at).toBe(clock.now - 100 + MAX_BEACONS_PER_VIDEO + 4);
    for (let n = 100; n < 100 + MAX_BEACON_VIDEOS; n++) w.watch(video(n), [R1]);
    // The oldest idle video was dropped and its subscription closed.
    expect(w.seen(v)).toEqual([]);
    expect(subs[0]?.closed).toBe(true);
  });

  it('close: every wait answers with what it has, every subscription closes', async () => {
    const { w, subs, clock } = rigged();
    const v = video(8);
    const b = ev(clock.now);
    const p = w.wait(v, [R1], () => false);
    subs[0]?.push(b);
    w.close();
    expect(await p).toEqual([b]);
    expect(subs[0]?.closed).toBe(true);
    expect(await w.wait(v, [R1], any)).toEqual([]);
  });
});
