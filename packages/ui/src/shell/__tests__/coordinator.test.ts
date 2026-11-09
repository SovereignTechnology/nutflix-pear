/**
 * The playback coordinator (SE-2/SE-3, design §4) against `MockNetworkAdapter` with a manual
 * tick driver: one wrap, ≤ 1 unpaused session, hand-off / remount / dismiss / expand / sweep,
 * stale plays, rendition lineage, the header rate. `live()` counts the MOCK's open sessions
 * (each registers one tick driver until closed) — the ground truth for "none leaked".
 */
import { describe, expect, it, vi } from 'vitest';
import { mocks } from '@sovit/core';
import type { NostrEventId, PlaySession } from '@sovit/core';
import type { WatchHandoff } from '../../screens/index.js';
import { PlaybackCoordinator } from '../coordinator.js';

const { MockNetworkAdapter, VIDEOS } = mocks;
const V1 = VIDEOS[0]!.id;
const V2 = VIDEOS[1]!.id;

function setup(): {
  c: PlaybackCoordinator;
  a: ReturnType<PlaybackCoordinator['wrap']>;
  base: InstanceType<typeof MockNetworkAdapter>;
  live: () => number;
  tick: () => void;
  mediaPauses: { n: number };
} {
  const ticks = new Set<() => void>();
  const base = new MockNetworkAdapter({
    setInterval: (fn) => {
      ticks.add(fn);
      return () => ticks.delete(fn);
    },
  });
  const mediaPauses = { n: 0 };
  const c = new PlaybackCoordinator({
    pauseScreenMedia: () => {
      mediaPauses.n += 1;
    },
  });
  c.screenMounted(1);
  return {
    c,
    a: c.wrap(base),
    base,
    live: () => ticks.size,
    tick: () => {
      for (const t of [...ticks]) t();
    },
    mediaPauses,
  };
}

function handoffOf(s: PlaySession, videoId: NostrEventId): WatchHandoff {
  return {
    session: s,
    videoId,
    title: 't',
    positionSec: 12,
    paused: false,
    volume: 1,
    muted: false,
    playbackRate: 1,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('PlaybackCoordinator', () => {
  it('wraps the adapter once (stable identity)', () => {
    const t = setup();
    expect(t.c.wrap(t.base)).toBe(t.a);
    expect(t.a.wallet).toBe(t.base.wallet);
    expect(t.a.platform).toBe('mock');
  });

  it('a new session pauses every other: at most one unpaused', async () => {
    const t = setup();
    const s1 = await t.a.play(V1);
    expect(t.c.snapshot()).toMatchObject({ open: 1, unpaused: 1 });
    const s2 = await t.a.play(V2);
    expect(t.c.snapshot()).toMatchObject({ open: 2, unpaused: 1 });
    // resume on the paused one pauses the other
    s1.resume();
    expect(t.c.snapshot()).toMatchObject({ open: 2, unpaused: 1 });
    s1.pause();
    expect(t.c.snapshot().unpaused).toBe(0);
    await s1.close();
    await s2.close();
    expect(t.live()).toBe(0);
  });

  it("header rate: the unpaused session's ratePerMin, 0 when paused", async () => {
    const t = setup();
    const s = await t.a.play(V1);
    t.tick();
    expect(t.c.snapshot().ratePerMin).toBeGreaterThan(0);
    s.pause();
    expect(t.c.snapshot().ratePerMin).toBe(0);
  });

  it('Watch hand-off → mini-player; a second hand-off closes the first', async () => {
    const t = setup();
    t.c.routeRequested({ name: 'home' });
    const s1 = await t.a.play(V1);
    t.c.handOff(s1, V1, handoffOf(s1, V1));
    expect(t.c.snapshot().mini?.handoff.videoId).toBe(V1);
    const s2 = await t.a.play(V2);
    t.c.handOff(s2, V2, handoffOf(s2, V2));
    expect(t.c.snapshot().mini?.handoff.videoId).toBe(V2);
    await flush();
    expect(t.live()).toBe(1);
    expect(t.c.snapshot()).toMatchObject({ open: 1, unpaused: 1 });
  });

  it('watch → watch remount: a hand-off for another video than the target route is closed', async () => {
    const t = setup();
    const s1 = await t.a.play(V1);
    t.c.routeRequested({ name: 'watch', videoId: V2 });
    t.c.handOff(s1, V1, handoffOf(s1, V1));
    await flush();
    expect(t.c.snapshot().mini).toBeNull();
    expect(t.live()).toBe(0);
  });

  it('a hand-off of the same video (the `i` key on its own page) is kept', async () => {
    const t = setup();
    t.c.routeRequested({ name: 'watch', videoId: V1 });
    const s1 = await t.a.play(V1);
    t.c.handOff(s1, V1, handoffOf(s1, V1));
    expect(t.c.snapshot().mini?.handoff.session).toBe(s1);
  });

  it('a session it does not know is closed on hand-off, never kept', async () => {
    const t = setup();
    const foreign = await t.base.play(V1);
    t.c.handOff(foreign, V1, handoffOf(foreign, V1));
    await flush();
    expect(t.c.snapshot().mini).toBeNull();
    expect(t.live()).toBe(0);
  });

  it('Shorts over the mini-player: onPlaybackStart pauses the mini (never two paying)', async () => {
    const t = setup();
    t.c.routeRequested({ name: 'home' });
    const s1 = await t.a.play(V1);
    t.c.handOff(s1, V1, handoffOf(s1, V1));
    t.c.screenMounted(2);
    t.c.routeCommitted({ name: 'shorts' });
    const basePlay = vi.spyOn(t.base, 'play');
    const short = await t.a.play(VIDEOS.find((v) => v.kind === 22)!.id);
    const inner = await (basePlay.mock.results[0]!.value as Promise<PlaySession>);
    const innerPause = vi.spyOn(inner, 'pause');
    const innerResume = vi.spyOn(inner, 'resume');
    t.c.pauseMini();
    expect(t.c.snapshot()).toMatchObject({ open: 2, unpaused: 1 });
    expect(t.c.snapshot().mini?.paused).toBe(true);
    // Resuming the mini pauses the short (and the page's media elements).
    t.c.resumeMini();
    expect(t.c.snapshot()).toMatchObject({ open: 2, unpaused: 1 });
    expect(t.c.snapshot().mini?.paused).toBe(false);
    expect(t.mediaPauses.n).toBe(1);
    expect(innerPause).toHaveBeenCalledTimes(1);
    // Shorts hears its element pause and pauses its own session (as Watch does): a no-op
    // here — the short stays paused, the mini keeps paying, nothing resumes (no loop).
    short.pause();
    expect(t.c.snapshot()).toMatchObject({ open: 2, unpaused: 1 });
    expect(t.c.snapshot().mini?.paused).toBe(false);
    expect(innerPause).toHaveBeenCalledTimes(1);
    expect(innerResume).not.toHaveBeenCalled();
    expect(t.mediaPauses.n).toBe(1);
  });

  it('dismiss closes the mini session', async () => {
    const t = setup();
    t.c.routeRequested({ name: 'home' });
    const s1 = await t.a.play(V1);
    t.c.handOff(s1, V1, handoffOf(s1, V1));
    t.c.dismissMini();
    await flush();
    expect(t.c.snapshot()).toMatchObject({ mini: null, open: 0 });
    expect(t.live()).toBe(0);
  });

  it('expand: the hand-off comes back updated, is adopted by the watch route, and survives the sweep', async () => {
    const t = setup();
    t.c.routeRequested({ name: 'home' });
    const s1 = await t.a.play(V1);
    t.c.handOff(s1, V1, handoffOf(s1, V1));
    t.c.miniProgress(42.5);
    const back = t.c.expandMini();
    expect(back).toMatchObject({ session: s1, videoId: V1, positionSec: 42.5, paused: false });
    expect(t.c.canResume(s1)).toBe(true);
    t.c.screenMounted(3);
    t.c.routeCommitted({ name: 'watch', videoId: V1 });
    expect(t.c.snapshot().open).toBe(1);
    // Now owned by screen 3: leaving it without a hand-off closes it.
    t.c.screenMounted(4);
    t.c.routeCommitted({ name: 'home' });
    await flush();
    expect(t.live()).toBe(0);
    expect(t.c.canResume(s1)).toBe(false);
  });

  it('an expanded session whose watch route never commits is closed', async () => {
    const t = setup();
    t.c.routeRequested({ name: 'home' });
    const s1 = await t.a.play(V1);
    t.c.handOff(s1, V1, handoffOf(s1, V1));
    t.c.expandMini();
    t.c.routeCommitted({ name: 'library' });
    await flush();
    expect(t.live()).toBe(0);
  });

  it('after a route commit, sessions of an unmounted screen are closed (nothing leaks)', async () => {
    const t = setup();
    await t.a.play(V1);
    t.c.routeCommitted({ name: 'watch', videoId: V1 });
    expect(t.c.snapshot().open).toBe(1);
    t.c.screenMounted(2);
    t.c.routeCommitted({ name: 'home' });
    await flush();
    expect(t.c.snapshot().open).toBe(0);
    expect(t.live()).toBe(0);
  });

  it('a play that resolves after its screen unmounted is closed at once', async () => {
    const t = setup();
    const p = t.a.play(V1);
    t.c.screenMounted(2);
    const s = await p;
    await flush();
    expect(t.c.snapshot().open).toBe(0);
    expect(t.live()).toBe(0);
    await s.close(); // idempotent
  });

  it('a rendition switch keeps its predecessor unpaused until the screen closes it', async () => {
    const t = setup();
    const s1 = await t.a.play(V1, '1080p');
    const s2 = await s1.switchRendition('720p');
    expect(s2.rendition).toBe('720p');
    expect(t.c.snapshot().open).toBe(2);
    await s1.close();
    expect(t.c.snapshot()).toMatchObject({ open: 1, unpaused: 1 });
    await s2.close();
    expect(t.live()).toBe(0);
  });

  it('a closed session ignores pause/resume and close is idempotent', async () => {
    const t = setup();
    const s1 = await t.a.play(V1);
    await s1.close();
    s1.resume();
    s1.pause();
    await s1.close();
    expect(t.c.snapshot()).toMatchObject({ open: 0, unpaused: 0 });
  });

  it('notifies subscribers only on real changes', async () => {
    const t = setup();
    let n = 0;
    const un = t.c.subscribe(() => {
      n += 1;
    });
    const s = await t.a.play(V1);
    const after = n;
    s.setPrefetchSeconds(10);
    expect(n).toBe(after);
    s.pause();
    expect(n).toBe(after + 1);
    un();
    s.resume();
    expect(n).toBe(after + 1);
  });
});
