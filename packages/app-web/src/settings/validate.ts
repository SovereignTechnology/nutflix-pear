/**
 * The web client's settings checks: what a `Partial<Settings>` patch may hold here, the web
 * counterpart of the desktop app's `isSettingsPatch` (`app-desktop/src/ipc/guards.ts`). The URL
 * rules are the desktop guards' own, so a relay or tracker one app accepts the other does too, and
 * both accept exactly what Settings' validators write (`__tests__/settings-validate.test.ts` holds
 * them to `@sovit/ui`'s). The web adds its own limits on top:
 *
 * - **NFX is always on**, on the one network this build speaks, with no iroh relays.
 * - **No wallet, seeding or auto top-up** fields: v1 has none to set (`defaultMints`, `seeding`,
 *   `autoTopUp` are refused).
 * - **`loadRemoteImages` stays `false`**: the client shows only images whose sha256 their publisher
 *   signed (ADR 0022), so a patch turning it on is refused.
 *
 * Every guard is total: anything that is not exactly the expected shape is `false`, never an
 * exception (a hostile getter or Proxy included). Objects must be plain with no unknown keys;
 * optional keys are absent, never `undefined`. Strings and arrays have caps.
 */
import type { NfxSettings, RelayConfig, RelayUrl, Settings, TrackerUrl } from '@sovit/core';

import { WEB_MAX_TRACKERS, WEB_NFX_NETWORK } from './defaults.js';

type Guard<T> = (x: unknown) => x is T;

/** Relay, tracker and server URLs: the desktop's `LIMITS.maxServerUrl`, Settings' `MAX_URL_LENGTH`. */
export const MAX_SERVER_URL = 512;
/** Read relays (the desktop's `LIMITS.maxArray`). */
export const MAX_RELAYS = 256;
/** NFX-04 scoped relays (contracts' `MAX_NFX_SCOPED_RELAYS`). */
export const MAX_SCOPED_RELAYS = 8;
/** Prefetch depth ceiling, seconds (the desktop's `LIMITS.maxPrefetchSec`). */
export const MAX_PREFETCH_SEC = 600;

function safe<T>(g: Guard<T>): Guard<T> {
  return (x: unknown): x is T => {
    try {
      return g(x);
    } catch {
      return false;
    }
  };
}

function isPlainObject(x: unknown): x is Readonly<Record<string, unknown>> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const proto: unknown = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** An exact-keys plain object: `req` present and valid, `opt` absent or valid, nothing else. */
function obj<T>(
  req: Readonly<Record<string, Guard<unknown>>>,
  opt: Readonly<Record<string, Guard<unknown>>> = {},
): Guard<T> {
  const known = new Set([...Object.keys(req), ...Object.keys(opt)]);
  return (x): x is T => {
    if (!isPlainObject(x)) return false;
    for (const k of Object.keys(x)) if (!known.has(k)) return false;
    for (const [k, g] of Object.entries(req)) if (!hasOwn(x, k) || !g(x[k])) return false;
    for (const [k, g] of Object.entries(opt)) if (hasOwn(x, k) && !g(x[k])) return false;
    return true;
  };
}

/** A dense array of at most `max` elements, each passing `g`. */
function arrayOf<T>(g: Guard<T>, max: number): Guard<readonly T[]> {
  return (x): x is readonly T[] => {
    if (!Array.isArray(x) || x.length > max) return false;
    for (const v of x as readonly unknown[]) if (!g(v)) return false;
    return true;
  };
}

function unique<T>(g: Guard<readonly T[]>): Guard<readonly T[]> {
  return (x): x is readonly T[] => g(x) && new Set(x).size === x.length;
}

const bool: Guard<boolean> = (x): x is boolean => typeof x === 'boolean';

function matches(re: RegExp): Guard<string> {
  return (x): x is string => typeof x === 'string' && x.length <= MAX_SERVER_URL && re.test(x);
}

// ---- URLs: the desktop guards' grammar ------------------------------------------------------

const LABEL = '[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?';
const HOST = `(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9A-Fa-f:.]{2,45}\\])`;
const PORT = '(?::[0-9]{1,5})?';
const PCHAR = "[A-Za-z0-9\\-._~!$&'()*+,;=:@%]";
const PATH_NO_TRAILING = `(?:/[A-Za-z0-9\\-._~!$&'()*+,;=:@%/]*${PCHAR})?`;
const QUERY = "(?:\\?[A-Za-z0-9\\-._~!$&'()*+,;=:@%/?]*)?";
const RELAY_RE = new RegExp(`^[Ww][Ss][Ss]://${HOST}${PORT}${PATH_NO_TRAILING}${QUERY}$`);
const LOOPBACK_WS_RE = new RegExp(
  `^[Ww][Ss]://(?:127\\.0\\.0\\.1|\\[::1\\]|localhost)${PORT}${PATH_NO_TRAILING}$`,
);
const LOWER_LABEL = '[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?';
const LOWER_HOST = `(?:${LOWER_LABEL}(?:\\.${LOWER_LABEL})*|\\[[0-9a-f:]{2,39}\\])`;
const LOWER_PORT = '(?::[1-9][0-9]{0,4})?';
const TRACKER_PATH = "(?:/[A-Za-z0-9\\-._~!$&'()*+,;=:@%/]+)?";
const TRACKER_RE = new RegExp(
  `^(?:wss://${LOWER_HOST}${LOWER_PORT}|ws://(?:127\\.0\\.0\\.1|\\[::1\\]|localhost)${LOWER_PORT})${TRACKER_PATH}$`,
);

/** A read relay: `wss://`, no user-info or fragment, no trailing slash. */
export const isRelayUrl = safe(matches(RELAY_RE)) as Guard<RelayUrl>;

/** An NFX-04 scoped relay: as `isRelayUrl`, or `ws://` to a loopback address (a local node). */
export const isScopedRelayUrl = safe(
  (x: unknown): x is string => isRelayUrl(x) || matches(LOOPBACK_WS_RE)(x),
) as Guard<RelayUrl>;

/**
 * Contracts v14: a WebTorrent tracker in the form nfx's player reduces one to: lower-case `wss://`
 * (or `ws://` to a loopback address), an optional port, a path other than a bare `/`; no
 * user-info, query or fragment.
 */
export const isTrackerUrl = safe(matches(TRACKER_RE)) as Guard<TrackerUrl>;

const isRelayConfig = obj<RelayConfig>({ url: isRelayUrl, read: bool, write: bool });

/** NFX on the web: always on, one network, no iroh relays (a browser runs no iroh). */
const isWebNfx = obj<NfxSettings>(
  {
    enabled: (x): x is true => x === true,
    network: (x): x is string => x === WEB_NFX_NETWORK,
    scopedRelays: unique(arrayOf(isScopedRelayUrl, MAX_SCOPED_RELAYS)),
  },
  { trackers: unique(arrayOf(isTrackerUrl, WEB_MAX_TRACKERS)) },
);

/** The fields a viewer sets on the web; every other `Settings` field is fixed in v1. */
export const WEB_SETTING_KEYS = [
  'relays',
  'prefetchSeconds',
  'hoverPreview',
  'theme',
  'nfx',
  'loadRemoteImages',
] as const;

const isPatch = obj<Partial<Settings>>(
  {},
  {
    relays: arrayOf(isRelayConfig, MAX_RELAYS),
    prefetchSeconds: (x): x is number =>
      typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX_PREFETCH_SEC,
    hoverPreview: bool,
    theme: (x): x is Settings['theme'] => x === 'dark' || x === 'light' || x === 'system',
    nfx: isWebNfx,
    // ADR 0022: only signed images, so the only value is the one it already has.
    loadRemoteImages: (x): x is false => x === false,
  },
);

/** True when `patch` is a `Partial<Settings>` the web client accepts. */
export const isWebSettingsPatch: Guard<Partial<Settings>> = safe(isPatch);
