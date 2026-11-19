/**
 * The web client's first-run settings and the endpoints it is built with (ADR 0022 items 4 to 6).
 *
 * - **Read relays:** `relay.primal.net` and `relay.ditto.pub` (the free relay that answers NIP-50
 *   search, ADR 0009's 2026-11-07 amendment), as in the desktop app. Since 2026-11-18 (the
 *   maintainer) neither `relay.damus.io` (it refuses this project's address) nor `nos.lol` (it has
 *   rate-limited it) is a default.
 * - **NFX, always on**, on `nfx:testnet:1`: the network's scoped relay `wss://relay.nutflix.xyz`
 *   (the desktop app's `DEFAULT_NFX`) and three signaling relays for the browser mesh
 *   (`WEB_MESH_RELAYS`). No iroh relay: no iroh runs in a browser.
 * - **No wallet, no seeding, no unsigned images** in v1: those fields are fixed, never stored.
 *
 * Every value here is a public name (web.nutflix.xyz, relay.nutflix.xyz and the public relays).
 */
import type { MAX_NFX_MESH_RELAYS, NfxNetwork, NfxSettings, RelayUrl, Settings } from '@sovit/core';

export const WEB_NFX_NETWORK: NfxNetwork = 'nfx:testnet:1';

/** The network's scoped relay (manifests and beacons). */
export const WEB_SCOPED_RELAY = 'wss://relay.nutflix.xyz' as RelayUrl;

/**
 * The signaling relays (NFX-10 §6, pear #89): Nostr relays where this page, the desktop app and
 * nfxd's mesh endpoint find each other. The same list the desktop app defaults to (its
 * `DEFAULT_NFX_MESH_RELAYS`): two peers meet only on a relay both use. First the network's own
 * relay, the scoped relay `WEB_SCOPED_RELAY` itself, which SovTech runs (the maintainer,
 * 2026-11-18: NFX-04 §1, amended that day as an exception to its freeze, lets a scoped relay
 * accept kind 25050 `nfx-mesh/1` as an ephemeral, never stored; one that does lists 25050 in its
 * NIP-11 `nfx.kinds`, §3); then the two public relays
 * `scripts/mesh-relay-soak.mjs` picked. They learn the viewer's IP address and which videos'
 * rooms the page is in, never how it connects.
 */
export const WEB_MESH_RELAYS: readonly RelayUrl[] = Object.freeze([
  WEB_SCOPED_RELAY,
  'wss://relay.primal.net' as RelayUrl,
  'wss://relay.ditto.pub' as RelayUrl,
]);

/** At most this many signaling relays (contracts v18, nfx's library). */
export const WEB_MAX_MESH_RELAYS: typeof MAX_NFX_MESH_RELAYS = 8;

/** The HTTPS origin tried after every origin the beacons name (ADR 0022 item 5). */
export const WEB_FALLBACK_ORIGIN = 'https://web.nutflix.xyz/o';

/**
 * SovTech's own STUN server (ADR 0022 item 4): the only ICE server, with no TURN and no third
 * party. nfxd's `--stun` serves it. Named relay.nutflix.xyz since 2026-11-18 (the maintainer): the
 * same address and responder as web.nutflix.xyz, under the network's own relay name.
 */
export const WEB_STUN_URL = 'stun:relay.nutflix.xyz:3478';

/** The `iceServers` every play passes to nfx's player. */
export const WEB_ICE_SERVERS: readonly { readonly urls: readonly string[] }[] = Object.freeze([
  Object.freeze({ urls: Object.freeze([WEB_STUN_URL]) }),
]);

export const DEFAULT_WEB_NFX: NfxSettings = Object.freeze({
  enabled: true,
  network: WEB_NFX_NETWORK,
  scopedRelays: Object.freeze([WEB_SCOPED_RELAY]),
  meshRelays: WEB_MESH_RELAYS,
});

const relay = (url: string): Settings['relays'][number] =>
  Object.freeze({ url: url as RelayUrl, read: true, write: true });

export const DEFAULT_WEB_SETTINGS: Settings = Object.freeze({
  relays: Object.freeze([relay('wss://relay.primal.net'), relay('wss://relay.ditto.pub')]),
  // Fixed in v1: no wallet, no seeding, and only images whose sha256 the publisher signed.
  defaultMints: Object.freeze([]),
  seeding: Object.freeze({ enabled: false, diskCapBytes: 0, serveImages: false }),
  prefetchSeconds: 30,
  hoverPreview: true,
  loadRemoteImages: false,
  theme: 'system' as const,
  nfx: DEFAULT_WEB_NFX,
});
