/**
 * @sovit/app-web: the web client for NFX videos (ADR 0022). `startWebClient` renders `@sovit/ui`'s
 * shell over `WebNetworkAdapter`; the site build (M4) wires nfx's pinned player library in.
 */
export const PACKAGE = '@sovit/app-web' as const;

export { WebAdapterError, type WebErrorCode } from './errors.js';
export type {
  NfxIceServer,
  NfxLevel,
  NfxLibSession,
  NfxOpenOptions,
  NfxOriginSource,
  NfxPlayerEvent,
  NfxPlayerLib,
  NfxTrackerSignaling,
} from './nfx-lib.js';
export {
  DEFAULT_WEB_NFX,
  DEFAULT_WEB_SETTINGS,
  WEB_FALLBACK_ORIGIN,
  WEB_ICE_SERVERS,
  WEB_MAX_TRACKERS,
  WEB_NFX_NETWORK,
  WEB_SCOPED_RELAY,
  WEB_STUN_URL,
  WEB_TRACKER,
} from './settings/defaults.js';
export { isWebSettingsPatch } from './settings/validate.js';
export {
  WEB_SETTINGS_KEY,
  WebSettingsStore,
  browserSettingsStore,
  parseStoredWebSettings,
  type SettingsStorage,
  type StorageEventTarget,
  type WebSettingsStoreOptions,
} from './settings/store.js';
export { WebNetworkAdapter, type WebAdapterOptions } from './adapter/web-adapter.js';
export {
  WebNfxSession,
  AUTO_RENDITION,
  WEB_MAX_PLAY_PROBLEMS,
  originSource,
  problemOf,
  shortUrl,
} from './adapter/session.js';
export {
  beaconEndpoints,
  beaconOrigin,
  beaconTracker,
  playEndpoints,
  type BeaconEndpoints,
  type PlayEndpoints,
  type PlayOrigin,
} from './adapter/endpoints.js';
export { isPublicHost } from './adapter/hosts.js';
export { WEB_OFFER } from './shell/offer.js';
export { hashOf, routeFromLocation } from './shell/routes.js';
export { startWebClient, type WebClient, type WebClientOptions } from './main.js';
