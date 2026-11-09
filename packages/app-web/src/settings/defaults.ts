/**
 * The web client's first-run settings and the endpoints it is built with (ADR 0022 items 4 to 6).
 *
 * - **Read relays:** ADR 0009's four, with its 2026-11-07 amendment (`relay.ditto.pub`, the free
 *   relay that answers NIP-50 search), as in the desktop app.
 * - **NFX, always on**, on `nfx:testnet:1`: the network's scoped relay `wss://relay.nutflix.xyz`
 *   (the desktop app's `DEFAULT_NFX`) and its WebTorrent tracker `wss://web.nutflix.xyz/tracker`.
 *   No iroh relay: no iroh runs in a browser.
 * - **No wallet, no seeding, no unsigned images** in v1: those fields are fixed, never stored.
 *
 * Every value here is a public name (web.nutflix.xyz, relay.nutflix.xyz and the public relays).
 */
import type {
  MAX_NFX_TRACKERS,
  NfxNetwork,
  NfxSettings,
  RelayUrl,
  Settings,
  TrackerUrl,
} from '@sovit/core';

export const WEB_NFX_NETWORK: NfxNetwork = 'nfx:testnet:1';

/** The network's scoped relay (manifests and beacons). */
export const WEB_SCOPED_RELAY = 'wss://relay.nutflix.xyz' as RelayUrl;

/** The network's WebTorrent tracker, served beside the page. */
export const WEB_TRACKER = 'wss://web.nutflix.xyz/tracker' as TrackerUrl;

/** The HTTPS origin tried after every origin the beacons name (ADR 0022 item 5). */
export const WEB_FALLBACK_ORIGIN = 'https://web.nutflix.xyz/o';

/**
 * SovTech's own STUN server (ADR 0022 item 4): the only ICE server, with no TURN and no third
 * party. nfxd's `--stun` serves it; until that is deployed the mesh still forms between peers
 * that need no server-reflexive candidate.
 */
export const WEB_STUN_URL = 'stun:web.nutflix.xyz:3478';

/** The `iceServers` every play passes to nfx's player. */
export const WEB_ICE_SERVERS: readonly { readonly urls: readonly string[] }[] = Object.freeze([
  Object.freeze({ urls: Object.freeze([WEB_STUN_URL]) }),
]);

/** At most this many trackers in all, configured and from beacons (contracts v14). */
export const WEB_MAX_TRACKERS: typeof MAX_NFX_TRACKERS = 4;

export const DEFAULT_WEB_NFX: NfxSettings = Object.freeze({
  enabled: true,
  network: WEB_NFX_NETWORK,
  scopedRelays: Object.freeze([WEB_SCOPED_RELAY]),
  trackers: Object.freeze([WEB_TRACKER]),
});

const relay = (url: string): Settings['relays'][number] =>
  Object.freeze({ url: url as RelayUrl, read: true, write: true });

export const DEFAULT_WEB_SETTINGS: Settings = Object.freeze({
  relays: Object.freeze([
    relay('wss://relay.damus.io'),
    relay('wss://nos.lol'),
    relay('wss://relay.primal.net'),
    relay('wss://relay.ditto.pub'),
  ]),
  // Fixed in v1: no wallet, no seeding, and only images whose sha256 the publisher signed.
  defaultMints: Object.freeze([]),
  seeding: Object.freeze({ enabled: false, diskCapBytes: 0, serveImages: false }),
  prefetchSeconds: 30,
  hoverPreview: true,
  loadRemoteImages: false,
  theme: 'system' as const,
  nfx: DEFAULT_WEB_NFX,
});
