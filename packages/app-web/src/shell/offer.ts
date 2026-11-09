/**
 * What the web client's shell offers (ADR 0022 item 1): the screens that list and play free NFX
 * videos, and the settings that matter to them. Everything that needs a wallet, a signer or
 * Hypercore is left out, so nothing a viewer can reach calls a method the adapter rejects:
 *
 * - **Sidebar:** Home and Settings. Shorts, Subscriptions, Library, Studio and Wallet are not
 *   offered, and a route into one shows Home. Watch, Channel and Search are always offered.
 * - **Home:** the Network and Tags feeds; Trending and Subscriptions are NIP-71 or signed-in only.
 * - **Settings:** Appearance (without "Load images from any website": only signed images are
 *   shown here), Playback, Relays and NFX (no switch, since NFX is always on; no iroh relays; the
 *   trackers; and the line saying that trackers and peers see the viewer's IP address).
 * - **No sign-in** in the header (NIP-07 comes after v1).
 */
import type { ShellOffer } from '@sovit/ui';

export const WEB_OFFER: ShellOffer = Object.freeze({
  sections: Object.freeze(['home', 'settings'] as const),
  homeTabs: Object.freeze(['network', 'tags'] as const),
  settingsSections: Object.freeze(['appearance', 'playback', 'relays', 'nfx'] as const),
  nfxParts: Object.freeze({
    toggle: false,
    scopedRelays: true,
    irohRelays: false,
    trackers: true,
    meshNotice: true,
  }),
  appearanceParts: Object.freeze({ remoteImages: false }),
  signIn: false,
});
