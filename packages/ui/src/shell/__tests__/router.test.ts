/**
 * The in-memory router (design §4): entries with extras, back/forward, same-route merges,
 * shorts → shorts replaces, the intercept hook, the request hook, bounded history.
 */
import { describe, expect, it } from 'vitest';
import { mocks } from '@sovit/core';
import type { Route } from '../../screens/index.js';
import { MAX_HISTORY, Router, sameRoute } from '../router.js';

const V1 = mocks.VIDEOS[0]!.id;
const V2 = mocks.VIDEOS[1]!.id;

describe('Router', () => {
  it('pushes, goes back and forward, and truncates forward history on a new push', () => {
    const r = new Router({ name: 'home' });
    r.navigate({ name: 'library' });
    r.navigate({ name: 'wallet' });
    expect(r.snapshot()).toMatchObject({ canBack: true, canForward: false });
    r.back();
    r.back();
    expect(r.current.route).toEqual({ name: 'home' });
    r.back();
    expect(r.current.route).toEqual({ name: 'home' });
    r.forward();
    expect(r.current.route).toEqual({ name: 'library' });
    r.navigate({ name: 'settings' });
    expect(r.snapshot().canForward).toBe(false);
    r.forward();
    expect(r.current.route).toEqual({ name: 'settings' });
  });

  it('the same route does not push; its extras merge in place and the key is kept', () => {
    const r = new Router({ name: 'search', q: 'a' });
    const key = r.current.key;
    const v = r.snapshot().version;
    r.navigate({ name: 'search', q: 'a' }, { playlistId: 'x' });
    expect(r.current.key).toBe(key);
    expect(r.current.extras).toEqual({ playlistId: 'x' });
    expect(r.snapshot().canBack).toBe(false);
    expect(r.snapshot().version).toBe(v + 1);
  });

  it('shorts → shorts replaces the entry', () => {
    const r = new Router({ name: 'home' });
    r.navigate({ name: 'shorts', videoId: V1 });
    r.navigate({ name: 'shorts', videoId: V2 });
    r.back();
    expect(r.current.route).toEqual({ name: 'home' });
  });

  it('updateExtras merges without announcing a navigation', () => {
    const r = new Router({ name: 'search', q: 'a' });
    const requested: Route[] = [];
    r.onRequest = (x) => requested.push(x);
    r.updateExtras({ searchFilters: { uploaded: 'week' } });
    expect(r.current.extras.searchFilters).toEqual({ uploaded: 'week' });
    expect(requested).toEqual([]);
    r.navigate({ name: 'home' });
    expect(requested).toEqual([{ name: 'home' }]);
  });

  it('intercept rewrites targets on navigate and on back/forward', () => {
    const r = new Router({ name: 'home' });
    const seen: string[] = [];
    r.intercept = (e) => {
      seen.push(e.route.name);
      return e.route.name === 'watch' ? { ...e, extras: { ...e.extras, playlistId: 'marked' } } : e;
    };
    r.navigate({ name: 'watch', videoId: V1 });
    expect(r.current.extras.playlistId).toBe('marked');
    r.navigate({ name: 'home' });
    r.back();
    expect(seen).toEqual(['watch', 'home', 'watch']);
  });

  it(`keeps at most ${String(MAX_HISTORY)} entries`, () => {
    const r = new Router({ name: 'home' });
    for (let i = 0; i < MAX_HISTORY + 20; i++) r.navigate({ name: 'search', q: String(i) });
    let n = 0;
    while (r.snapshot().canBack) {
      r.back();
      n++;
    }
    expect(n).toBe(MAX_HISTORY - 1);
  });

  it('notifies subscribers; unsubscribe stops it', () => {
    const r = new Router({ name: 'home' });
    let n = 0;
    const un = r.subscribe(() => {
      n++;
    });
    r.navigate({ name: 'library' });
    un();
    r.navigate({ name: 'wallet' });
    expect(n).toBe(1);
  });

  it('sameRoute ignores undefined keys', () => {
    expect(sameRoute({ name: 'home' }, { name: 'home', tab: undefined } as unknown as Route)).toBe(
      true,
    );
    expect(sameRoute({ name: 'home' }, { name: 'home', tab: 'trending' })).toBe(false);
    expect(sameRoute({ name: 'watch', videoId: V1 }, { name: 'watch', videoId: V2 })).toBe(false);
  });
});
