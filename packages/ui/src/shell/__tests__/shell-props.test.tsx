// @vitest-environment jsdom
/**
 * docs/archive/status-2026-10-04.md "Shell contract the screens expect": every prop the shell owes each screen,
 * checked by replacing the nine screens with recording stubs (the rest of `@sovit/ui` stays
 * real). Screens always get the ONE coordinator-wrapped adapter and the router's navigate.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mocks } from '@sovit/core';
import type * as Screens from '../../screens/index.js';
import type { FfmpegStatus, Route } from '../../screens/index.js';
import { Shell } from '../Shell.js';
import { createShellModel, type ShellModel } from '../model.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const seen = vi.hoisted(() => ({
  props: new Map<string, Record<string, unknown>>(),
  mounts: new Map<string, number>(),
}));

vi.mock('../../screens/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof Screens>();
  const { useEffect } = await import('react');
  const stub =
    (name: string) =>
    (props: Record<string, unknown>): ReturnType<typeof createElement> => {
      seen.props.set(name, props);
      useEffect(() => {
        seen.mounts.set(name, (seen.mounts.get(name) ?? 0) + 1);
      }, []);
      return createElement('div', { 'data-screen': name });
    };
  return {
    ...orig,
    Home: stub('Home'),
    Watch: stub('Watch'),
    Channel: stub('Channel'),
    Search: stub('Search'),
    Shorts: stub('Shorts'),
    Library: stub('Library'),
    Studio: stub('Studio'),
    Wallet: stub('Wallet'),
    Settings: stub('Settings'),
  };
});

const { MockNetworkAdapter, VIDEOS, CHANNELS, MINTS } = mocks;

function at<T>(list: readonly T[], i: number): T {
  const x = list[i];
  if (x === undefined) throw new Error(`fixture missing: index ${String(i)}`);
  return x;
}
const V1 = at(VIDEOS, 0).id;

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup) c();
  cleanup = [];
  seen.props.clear();
  seen.mounts.clear();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise<void>((r) => {
        setTimeout(r, 0);
      });
    }
  });
}

async function mount(
  initial: Route,
): Promise<ShellModel & { probe: ReturnType<typeof vi.fn>; container: HTMLElement }> {
  const model = createShellModel(new MockNetworkAdapter(), initial);
  const probe = vi.fn((recheck: boolean): Promise<FfmpegStatus> =>
    Promise.resolve({
      found: true,
      path: '/usr/bin/ffmpeg',
      version: recheck ? '2' : '1',
      os: 'linux',
    }),
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(Shell, {
        adapter: model.adapter,
        coordinator: model.coordinator,
        router: model.router,
        probeFfmpeg: probe,
      }),
    );
  });
  cleanup.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  await flush();
  return { ...model, probe, container };
}

async function go(
  m: ShellModel,
  to: Route,
  extras: Parameters<ShellModel['router']['navigate']>[1] = {},
): Promise<void> {
  act(() => {
    m.router.navigate(to, extras);
  });
  await flush();
}

function props(name: string): Record<string, unknown> {
  const p = seen.props.get(name);
  if (p === undefined) throw new Error(`${name} was not rendered`);
  return p;
}

describe('every screen prop the shell owes (status.md "Shell contract")', () => {
  it('all screens: the one wrapped adapter and the router navigate', async () => {
    const m = await mount({ name: 'home' });
    for (const r of [
      { name: 'watch', videoId: V1 },
      { name: 'channel', pubkey: at(CHANNELS, 0).pubkey },
      { name: 'search', q: 'x' },
      { name: 'shorts' },
      { name: 'library' },
      { name: 'studio' },
      { name: 'wallet' },
      { name: 'settings' },
    ] as Route[]) {
      await go(m, r);
    }
    for (const name of [
      'Home',
      'Watch',
      'Channel',
      'Search',
      'Shorts',
      'Library',
      'Studio',
      'Wallet',
      'Settings',
    ]) {
      expect(props(name)['adapter']).toBe(m.adapter);
      expect(props(name)['navigate']).toBe(m.router.navigate);
    }
  });

  it('Home: tab + hoverPreview from Settings', async () => {
    const m = await mount({ name: 'home', tab: 'trending' });
    expect(props('Home')).toMatchObject({ tab: 'trending', hoverPreview: true });
    await go(m, { name: 'home', tab: 'subscriptions' });
    expect(props('Home')['tab']).toBe('subscriptions');
  });

  it('Watch: videoId, startAtSec, onMiniPlayer → coordinator, playlist extras; no stale resumeSession', async () => {
    const m = await mount({ name: 'home' });
    const playlist = { title: 'P', videoIds: [V1] };
    await go(m, { name: 'watch', videoId: V1, t: 90 }, { watchPlaylist: playlist });
    const p = props('Watch');
    expect(p).toMatchObject({ videoId: V1, startAtSec: 90, playlist });
    expect(p['onMiniPlayer']).toBe(m.coordinator.handOff);
    expect(p['resumeSession']).toBeUndefined();
  });

  it('Watch is not remounted watch → watch', async () => {
    const m = await mount({ name: 'watch', videoId: V1 });
    await go(m, { name: 'watch', videoId: at(VIDEOS, 1).id });
    await go(m, { name: 'watch', videoId: at(VIDEOS, 2).id });
    expect(seen.mounts.get('Watch')).toBe(1);
  });

  it('Channel: pubkey + tab; seedingVideos deliberately undefined (Stage 1)', async () => {
    await mount({ name: 'channel', pubkey: at(CHANNELS, 1).pubkey, tab: 'about' });
    const p = props('Channel');
    expect(p).toMatchObject({ pubkey: at(CHANNELS, 1).pubkey, tab: 'about' });
    expect('seedingVideos' in p && p['seedingVideos'] === undefined).toBe(true);
  });

  it('Search: q, filters from the entry, onFiltersChange stored in the entry (back restores them)', async () => {
    const m = await mount({ name: 'search', q: 'kiln' });
    expect(props('Search')['q']).toBe('kiln');
    const f = { uploaded: 'week', duration: 'short', tags: ['raku'], author: '' };
    act(() => {
      (props('Search')['onFiltersChange'] as (x: unknown) => void)(f);
    });
    await flush();
    expect(props('Search')['filters']).toEqual(f);
    await go(m, { name: 'home' });
    act(() => {
      m.router.back();
    });
    await flush();
    expect(props('Search')['filters']).toEqual(f);
  });

  it('Shorts: videoId + onPlaybackStart → coordinator.pauseMini; not remounted shorts → shorts', async () => {
    const m = await mount({ name: 'shorts', videoId: V1 });
    expect(props('Shorts')['videoId']).toBe(V1);
    expect(props('Shorts')['onPlaybackStart']).toBe(m.coordinator.pauseMini);
    await go(m, { name: 'shorts', videoId: at(VIDEOS, 1).id });
    expect(seen.mounts.get('Shorts')).toBe(1);
    // shorts → shorts replaces the history entry
    expect(m.router.snapshot().canBack).toBe(false);
  });

  it('Library: tab + playlistId extras', async () => {
    const m = await mount({ name: 'home' });
    await go(m, { name: 'library', tab: 'playlists' }, { playlistId: 'ceramics-binge' });
    expect(props('Library')).toMatchObject({ tab: 'playlists', playlistId: 'ceramics-binge' });
  });

  it("Library: onToast is the shell's (the same one Settings gets); an action closes its toast and runs once", async () => {
    const m = await mount({ name: 'library' });
    const onToast = props('Library')['onToast'] as (t: unknown) => void;
    expect(typeof onToast).toBe('function');
    await go(m, { name: 'settings' });
    expect(props('Settings')['onToast']).toBe(onToast);
    await go(m, { name: 'library' });
    expect(props('Library')['onToast']).toBe(onToast);

    const undo = vi.fn();
    act(() => {
      onToast({
        id: 'library-toast-1',
        tone: 'info',
        title: 'Removed from Watch later',
        action: { label: 'Undo', onClick: undo },
      });
    });
    await flush();
    const stack = (): Element => {
      const el = m.container.querySelector('.nf-shell__toasts');
      if (el === null) throw new Error('no shell toast stack');
      return el;
    };
    expect(stack().textContent).toContain('Removed from Watch later');
    const action = stack().querySelector<HTMLButtonElement>('.nf-toast__action');
    if (action === null) throw new Error('no toast action');
    act(() => {
      action.click();
      action.click(); // a double click before the re-render still runs it once
    });
    await flush();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(stack().querySelectorAll('.nf-toast')).toHaveLength(0);
  });

  it('Studio gets no onToast (it raises no toasts)', async () => {
    await mount({ name: 'studio' });
    expect('onToast' in props('Studio')).toBe(false);
  });

  it('Studio: resolveFile = identity (SE-1), ffmpeg + onRecheckFfmpeg from desktop.ffmpeg, mounted across tabs', async () => {
    const m = await mount({ name: 'studio', tab: 'upload' });
    const p = props('Studio');
    const f = new File(['x'], 'clip.mp4');
    expect((p['resolveFile'] as (x: File) => unknown)(f)).toBe(f);
    expect(p['ffmpeg']).toEqual({
      found: true,
      path: '/usr/bin/ffmpeg',
      version: '1',
      os: 'linux',
    });
    act(() => {
      (p['onRecheckFfmpeg'] as () => void)();
    });
    await flush();
    expect(m.probe).toHaveBeenLastCalledWith(true);
    expect((props('Studio')['ffmpeg'] as FfmpegStatus).version).toBe('2');
    await go(m, { name: 'studio', tab: 'analytics' });
    expect(props('Studio')['tab']).toBe('analytics');
    expect(seen.mounts.get('Studio')).toBe(1);
  });

  it('Wallet: intent extras', async () => {
    const m = await mount({ name: 'home' });
    const intent = { action: 'fund', mint: MINTS.b, amount: 5000 };
    await go(m, { name: 'wallet' }, { walletIntent: intent as never });
    expect(props('Wallet')['intent']).toEqual(intent);
  });

  it('Settings: onSettingsChange + onToast (into the shell stack); onChangeSigner omitted', async () => {
    const m = await mount({ name: 'settings' });
    const p = props('Settings');
    expect('onChangeSigner' in p).toBe(false);
    act(() => {
      (p['onToast'] as (t: unknown) => void)({ id: 'x', tone: 'error', title: 'Could not save' });
    });
    await flush();
    expect(m.container.querySelector('.nf-shell__toasts')?.textContent).toContain('Could not save');
    act(() => {
      (p['onSettingsChange'] as (s: unknown) => void)({ ...SETTINGS, theme: 'light' });
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

// A complete Settings object for onSettingsChange (the mock's defaults).
const SETTINGS = {
  relays: [],
  defaultMints: [MINTS.a],
  seeding: { enabled: true, diskCapBytes: 1 },
  prefetchSeconds: 30,
  hoverPreview: false,
  theme: 'dark',
};
