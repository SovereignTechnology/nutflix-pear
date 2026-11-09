/**
 * The app's long-lived renderer objects: the ONE playback coordinator, its (once-)wrapped
 * adapter and the router, connected. `main.tsx` builds them around the bridge's adapter; the
 * tests build them around `MockNetworkAdapter`.
 */
import type { NetworkAdapter } from '@sovit/core';
import type { Route } from '../screens/index.js';
import { PlaybackCoordinator } from './coordinator.js';
import { Router } from './router.js';
import { connectRouter, pauseScreenMedia } from './Shell.js';

export interface ShellModel {
  /** The coordinator-wrapped adapter every screen gets (stable identity). */
  readonly adapter: NetworkAdapter;
  readonly coordinator: PlaybackCoordinator;
  readonly router: Router;
}

export function createShellModel(
  base: NetworkAdapter,
  initial: Route = { name: 'home' },
): ShellModel {
  const coordinator = new PlaybackCoordinator({
    pauseScreenMedia: () => {
      pauseScreenMedia();
    },
  });
  const router = new Router(initial);
  connectRouter(router, coordinator);
  return { adapter: coordinator.wrap(base), coordinator, router };
}
