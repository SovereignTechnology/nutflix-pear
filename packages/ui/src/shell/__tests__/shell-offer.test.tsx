// @vitest-environment jsdom
/**
 * What a shell offers (ADR 0022): the web client's shell lists fewer sidebar sections, Home feeds
 * and Settings sections, and no sign-in; a route in a section it does not offer shows Home. Without
 * an offer the shell offers everything, as the desktop app's always did.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mocks } from '@sovit/core';
import type * as Screens from '../../screens/index.js';
import type { Route } from '../../screens/index.js';
import { Shell, type ShellOffer } from '../Shell.js';
import { createShellModel, type ShellModel } from '../model.js';
import { SHELL_SECTIONS, routeSection } from '../Sidebar.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const seen = vi.hoisted(() => ({ props: new Map<string, Record<string, unknown>>() }));

vi.mock('../../screens/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof Screens>();
  const stub =
    (name: string) =>
    (props: Record<string, unknown>): ReturnType<typeof createElement> => {
      seen.props.set(name, props);
      return createElement('div', { 'data-screen': name });
    };
  return {
    ...orig,
    Home: stub('Home'),
    Shorts: stub('Shorts'),
    Library: stub('Library'),
    Studio: stub('Studio'),
    Wallet: stub('Wallet'),
    Settings: stub('Settings'),
    Search: stub('Search'),
  };
});

const { MockNetworkAdapter } = mocks;

/** The web client's offer (ADR 0022). */
const WEB: ShellOffer = {
  sections: ['home', 'settings'],
  homeTabs: ['network', 'tags'],
  settingsSections: ['appearance', 'playback', 'relays', 'nfx'],
  nfxParts: { toggle: false, irohRelays: false, trackers: true, meshNotice: true },
  appearanceParts: { remoteImages: false },
  signIn: false,
};

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup) c();
  cleanup = [];
  seen.props.clear();
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
  offer?: ShellOffer,
): Promise<ShellModel & { readonly container: HTMLElement }> {
  // Signed out: the web client has no signer in v1.
  const model = createShellModel(new MockNetworkAdapter({ signedIn: false }), initial);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(Shell, {
        adapter: model.adapter,
        coordinator: model.coordinator,
        router: model.router,
        ...(offer === undefined ? {} : { offer }),
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
  return { ...model, container };
}

async function go(m: ShellModel, to: Route): Promise<void> {
  act(() => {
    m.router.navigate(to);
  });
  await flush();
}

const navLabels = (c: HTMLElement): string[] =>
  Array.from(c.querySelectorAll('.nf-shell__sidebar .nf-shell__nav-item')).map(
    (b) => b.textContent,
  );

describe('ShellOffer (ADR 0022)', () => {
  it('without an offer: every section in the sidebar, every route its screen, a sign-in (the desktop)', async () => {
    const m = await mount({ name: 'home' });
    expect(navLabels(m.container)).toEqual([
      'Home',
      'Shorts',
      'Subscriptions',
      'Library',
      'Studio',
      'Wallet',
      'Settings',
    ]);
    expect(m.container.querySelectorAll('.nf-shell__nav')).toHaveLength(2);
    expect(seen.props.get('Home')?.['tabs']).toBeUndefined();
    for (const name of ['shorts', 'library', 'studio', 'wallet'] as const) {
      await go(m, { name });
      expect(m.container.querySelector('[data-screen]')?.getAttribute('data-screen')).toBe(
        name.charAt(0).toUpperCase() + name.slice(1),
      );
    }
    await go(m, { name: 'settings' });
    expect(seen.props.get('Settings')?.['sections']).toBeUndefined();
    expect(seen.props.get('Settings')?.['nfxParts']).toBeUndefined();
    expect(seen.props.get('Settings')?.['appearanceParts']).toBeUndefined();
    expect(m.container.textContent).toContain('Connect signer');
  });

  it("the web's offer: Home and Settings only, Home's feeds and Settings' sections passed on, no sign-in", async () => {
    const m = await mount({ name: 'home' }, WEB);
    expect(navLabels(m.container)).toEqual(['Home', 'Settings']);
    expect(seen.props.get('Home')?.['tabs']).toEqual(['network', 'tags']);
    expect(m.container.textContent).not.toContain('Connect signer');
    await go(m, { name: 'settings' });
    expect(seen.props.get('Settings')?.['sections']).toEqual(WEB.settingsSections);
    expect(seen.props.get('Settings')?.['nfxParts']).toEqual(WEB.nfxParts);
    expect(seen.props.get('Settings')?.['appearanceParts']).toEqual(WEB.appearanceParts);
    await go(m, { name: 'search', q: 'orbits' });
    expect(m.container.querySelector('[data-screen]')?.getAttribute('data-screen')).toBe('Search');
  });

  it('a route in a section not offered shows Home, and nothing in the sidebar is current', async () => {
    const m = await mount({ name: 'home' }, WEB);
    for (const to of [
      { name: 'shorts' },
      { name: 'library' },
      { name: 'studio' },
      { name: 'wallet' },
      { name: 'home', tab: 'subscriptions' },
    ] as Route[]) {
      seen.props.clear();
      await go(m, to);
      expect(m.container.querySelector('[data-screen]')?.getAttribute('data-screen'), to.name).toBe(
        'Home',
      );
      expect(seen.props.get('Home')?.['tab'], to.name).toBeUndefined();
      expect(m.container.querySelector('.nf-shell__sidebar [aria-current="page"]')).toBeNull();
    }
  });

  it('every route maps to a section, or to none for watch, channel and search', () => {
    expect(SHELL_SECTIONS).toEqual([
      'home',
      'shorts',
      'subscriptions',
      'library',
      'studio',
      'wallet',
      'settings',
    ]);
    expect(routeSection({ name: 'home' })).toBe('home');
    expect(routeSection({ name: 'home', tab: 'network' })).toBe('home');
    expect(routeSection({ name: 'home', tab: 'subscriptions' })).toBe('subscriptions');
    expect(routeSection({ name: 'wallet' })).toBe('wallet');
    expect(routeSection({ name: 'search', q: 'x' })).toBeNull();
    expect(routeSection({ name: 'channel', pubkey: mocks.ME })).toBeNull();
  });
});
