/**
 * The web client's entry (ADR 0022): `@sovit/ui`'s shell over the web adapter, with the web's offer
 * (`WEB_OFFER`) and the route mirrored into the page's hash (`./shell/routes.ts`).
 *
 * The site build (M4) calls `startWebClient` with nfx's pinned player library and its WASM URL; this
 * module imports neither, so the page and the tests can hand it any `NfxPlayerLib`.
 */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell, applyTheme, createShellModel, sameRoute } from '@sovit/ui';
import { SimplePoolAdapter, type PoolLike } from '@sovit/core/nostr';

import { WebNetworkAdapter } from './adapter/web-adapter.js';
import type { FetchFn } from './adapter/http.js';
import type { NfxPlayerLib } from './nfx-lib.js';
import { WEB_OFFER } from './shell/offer.js';
import { hashOf, routeFromLocation } from './shell/routes.js';
import { browserSettingsStore, type WebSettingsStore } from './settings/store.js';

export interface WebClientOptions {
  /** Where the shell renders. */
  readonly container: HTMLElement;
  /** nfx's player library. */
  readonly player: NfxPlayerLib;
  /** Where the player's WASM is served (the site's SRI-pinned copy). */
  readonly wasmUrl?: string | undefined;
  /** Default: the container's window. */
  readonly window?: Window | undefined;
  /** Default: `SimplePoolAdapter`, the browser's WebSocket. */
  readonly pool?: PoolLike | undefined;
  /** Default: the window's Web Storage (`browserSettingsStore`). */
  readonly settings?: WebSettingsStore | undefined;
  /** Default: the window's `fetch`. */
  readonly fetch?: FetchFn | undefined;
}

export interface WebClient {
  readonly adapter: WebNetworkAdapter;
  readonly settings: WebSettingsStore;
  /** Unmounts the shell, closes every play and subscription, and stops following the URL. */
  stop(): Promise<void>;
}

export function startWebClient(o: WebClientOptions): WebClient {
  const win = o.window ?? o.container.ownerDocument.defaultView;
  if (win === null) throw new Error('startWebClient: the container is not in a window');
  const settings = o.settings ?? browserSettingsStore(win);
  const pool = o.pool ?? new SimplePoolAdapter();
  const adapter = new WebNetworkAdapter({
    pool,
    settings,
    player: o.player,
    wasmUrl: o.wasmUrl,
    fetch: o.fetch ?? ((input, init) => win.fetch(input, init)),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => {
      URL.revokeObjectURL(url);
    },
  });
  const model = createShellModel(adapter, routeFromLocation(win.location));

  // The route into the hash: replaced, not pushed, so the shell's own back and forward stay the
  // only history, and a `?a=` link becomes its `#/watch/…` form.
  const sync = (): void => {
    const hash = hashOf(model.router.current.route);
    if (win.location.hash !== hash || win.location.search !== '') {
      win.history.replaceState(win.history.state as unknown, '', `${win.location.pathname}${hash}`);
    }
  };
  sync();
  const offRouter = model.router.subscribe(sync);
  // A hash the viewer typed or a link they followed.
  const onHash = (): void => {
    const route = routeFromLocation(win.location);
    if (sameRoute(route, model.router.current.route)) sync();
    else model.router.navigate(route);
  };
  win.addEventListener('hashchange', onHash);
  // Another tab's theme (the shell applies this tab's own saves).
  const offSettings = settings.onChange((s) => {
    applyTheme(s.theme);
  });

  const root = createRoot(o.container);
  root.render(
    createElement(Shell, {
      offer: WEB_OFFER,
      adapter: model.adapter,
      coordinator: model.coordinator,
      router: model.router,
    }),
  );

  let stopped: Promise<void> | null = null;
  return {
    adapter,
    settings,
    stop: () => {
      stopped ??= (async (): Promise<void> => {
        win.removeEventListener('hashchange', onHash);
        offRouter();
        offSettings();
        root.unmount();
        await adapter.close();
        settings.close();
        pool.close();
      })();
      return stopped;
    },
  };
}
