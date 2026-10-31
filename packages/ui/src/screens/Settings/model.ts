/**
 * Settings screen — pure helpers: URL validation (relays `wss://` only, mints `https://`
 * only), unit conversion for the seeding disk cap, the prefetch ("buffer = money") and
 * auto-top-up bounds, signer copy and error copy. No React, no adapter calls.
 */
import type { IrohRelayUrl, MintUrl, RelayUrl, SignerStatus } from '@sovit/core';
import {
  UI_AUTO_TOP_UP_MAX_SATS,
  UI_AUTO_TOP_UP_PER_DAY_SATS,
} from '../../components/shared/format.js';

export type Validation<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const ok = <T>(value: T): Validation<T> => ({ ok: true, value });
const fail = <T>(error: string): Validation<T> => ({ ok: false, error });

/** Longest URL the forms accept; relay/mint URLs are short, anything longer is a paste accident. */
export const MAX_URL_LENGTH = 512;

function schemeOf(raw: string): string | undefined {
  return /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
}

/** Parses with WHATWG `URL`: host is lower-cased and IDNA-encoded (`xn--…`), default port dropped. */
function parse(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/** `wss://Relay.Example/` → `wss://relay.example`; paths keep their case, lose trailing `/`. */
export function normaliseRelayUrl(input: string): string {
  const u = parse(input.trim());
  if (!u) return input.trim();
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

/**
 * Relay address check for the "Add relay" form. Only `wss://` is accepted: `ws://` would
 * carry the viewer's reads, writes and NIP-42 auth in cleartext, and anything else is not a
 * relay at all. The error strings are the inline copy under the field.
 */
export function validateRelayUrl(
  input: string,
  existing: readonly string[] = [],
): Validation<RelayUrl> {
  const raw = input.trim();
  if (raw === '') return fail('Enter a relay address, for example wss://relay.example');
  if (raw.length > MAX_URL_LENGTH) return fail('That address is too long to be a relay.');
  if (/\s/.test(raw)) return fail('A relay address cannot contain spaces.');
  const scheme = schemeOf(raw);
  if (scheme === undefined)
    return fail('Relay addresses start with wss:// — for example wss://relay.example');
  if (scheme === 'ws') return fail('Use wss:// — unencrypted ws:// relays are not allowed.');
  if (scheme !== 'wss') return fail(`Relays use wss://, not ${scheme}://`);
  const u = parse(raw);
  if (!u || u.hostname === '') return fail('That is not a valid relay address.');
  if (u.username !== '' || u.password !== '')
    return fail('Remove the user name or password from the address.');
  if (u.hash !== '') return fail('A relay address has no # part.');
  const url = normaliseRelayUrl(raw);
  if (existing.some((e) => normaliseRelayUrl(e) === url))
    return fail('That relay is already in your list.');
  return ok(url as RelayUrl);
}

/** Contracts v10: core's `NFX_NETWORKS[0]`, the one NFX network (the UI imports no core runtime code; a test pins the two). */
export const UI_NFX_NETWORK = 'nfx:testnet:1';
/** Contracts v10: core's `MAX_NFX_SCOPED_RELAYS`. */
export const UI_MAX_NFX_SCOPED_RELAYS = 8;

const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', '[::1]', 'localhost'];

/**
 * Scoped relay check for Settings › NFX (NFX-04). `wss://` as for any relay, or `ws://` to this
 * computer only (a local node's embedded relay, which nfxd serves without TLS). Beacons go to
 * these relays, so `ws://` anywhere else would put them on the network in cleartext.
 */
export function validateScopedRelayUrl(
  input: string,
  existing: readonly string[] = [],
): Validation<RelayUrl> {
  const raw = input.trim();
  if (raw === '') return fail('Enter a relay address, for example wss://relay.example');
  if (raw.length > MAX_URL_LENGTH) return fail('That address is too long to be a relay.');
  if (/\s/.test(raw)) return fail('A relay address cannot contain spaces.');
  const scheme = schemeOf(raw);
  if (scheme === 'ws') {
    const u = parse(raw);
    if (!u || !LOOPBACK_HOSTS.includes(u.hostname)) {
      return fail('Use wss:// — ws:// is allowed only for a relay on this computer.');
    }
    if (u.username !== '' || u.password !== '' || u.hash !== '' || u.search !== '') {
      return fail('That is not a valid relay address.');
    }
    const url = normaliseRelayUrl(raw);
    if (existing.some((e) => normaliseRelayUrl(e) === url))
      return fail('That relay is already in the list.');
    return ok(url as RelayUrl);
  }
  return validateRelayUrl(raw, existing);
}

/** Contracts v12: core's `MAX_NFX_IROH_RELAYS`. */
export const UI_MAX_NFX_IROH_RELAYS = 4;

/** A host as `URL` prints it, in the shape the IPC guard admits: DNS labels or `[IPv6]`. */
const IROH_HOST_RE =
  /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*|\[[0-9a-f:]{2,39}\])$/;

/** `HTTPS://Relay.Example` → `https://relay.example/`, iroh's normal form (scheme, host, port, `/`). */
export function normaliseIrohRelayUrl(input: string): string {
  const u = parse(input.trim());
  if (!u) return input.trim();
  return `${u.protocol}//${u.host}/`;
}

/**
 * iroh relay check for Settings › NFX (contracts v12, NFX-06 §1), written in iroh's normal form,
 * `https://host[:port]/`, so a ticket's relay matches it as a string. `http://` to this computer
 * only (a local relay). A relay sees which nodes talk to whom, so a cleartext one anywhere else
 * would show that to the network, and could be swapped for another on the way.
 */
export function validateIrohRelayUrl(
  input: string,
  existing: readonly string[] = [],
): Validation<IrohRelayUrl> {
  const raw = input.trim();
  if (raw === '') return fail('Enter a relay address, for example https://relay.example/');
  if (raw.length > MAX_URL_LENGTH) return fail('That address is too long to be a relay.');
  if (/\s/.test(raw)) return fail('A relay address cannot contain spaces.');
  const scheme = schemeOf(raw);
  if (scheme === undefined)
    return fail('iroh relay addresses start with https:// — for example https://relay.example/');
  if (scheme !== 'https' && scheme !== 'http')
    return fail(`iroh relays use https://, not ${scheme}://`);
  const u = parse(raw);
  if (!u) return fail('That is not a valid relay address.');
  if (scheme === 'http' && !LOOPBACK_HOSTS.includes(u.hostname))
    return fail('Use https:// — http:// is allowed only for a relay on this computer.');
  if (!IROH_HOST_RE.test(u.hostname) || u.port === '0')
    return fail('That is not a valid relay address.');
  if (u.username !== '' || u.password !== '')
    return fail('Remove the user name or password from the address.');
  if (u.pathname !== '/') return fail('An iroh relay address has no path, only the server.');
  if (u.search !== '' || u.hash !== '') return fail('An iroh relay address has no ? or # part.');
  const url = normaliseIrohRelayUrl(raw);
  if (url.length > MAX_URL_LENGTH) return fail('That address is too long to be a relay.');
  if (existing.some((e) => normaliseIrohRelayUrl(e) === url))
    return fail('That relay is already in the list.');
  return ok(url as IrohRelayUrl);
}

/** `https://Mint.Example/` → `https://mint.example` (contract: `MintUrl` has no trailing slash). */
export function normaliseMintUrl(input: string): string {
  const u = parse(input.trim());
  if (!u) return input.trim();
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

/**
 * Mint address check for "Add mint". `https://` only: a mint answers with blind signatures
 * and swaps proofs, so plain `http://` would hand ecash to anyone on the path.
 */
export function validateMintUrl(
  input: string,
  existing: readonly string[] = [],
): Validation<MintUrl> {
  const raw = input.trim();
  if (raw === '') return fail('Enter a mint address, for example https://mint.example');
  if (raw.length > MAX_URL_LENGTH) return fail('That address is too long to be a mint.');
  if (/\s/.test(raw)) return fail('A mint address cannot contain spaces.');
  const scheme = schemeOf(raw);
  if (scheme === undefined)
    return fail('Mint addresses start with https:// — for example https://mint.example');
  if (scheme === 'http')
    return fail('Use https:// — a mint over plain http:// would expose your ecash.');
  if (scheme !== 'https') return fail(`Mints use https://, not ${scheme}://`);
  const u = parse(raw);
  if (!u || u.hostname === '') return fail('That is not a valid mint address.');
  if (u.username !== '' || u.password !== '')
    return fail('Remove the user name or password from the address.');
  if (u.search !== '' || u.hash !== '') return fail('A mint address has no ? or # part.');
  const url = normaliseMintUrl(raw);
  if (existing.some((e) => normaliseMintUrl(e) === url))
    return fail('That mint is already a default.');
  return ok(url as MintUrl);
}

// ---- seeding disk cap ---------------------------------------------------------------

/** "GB" in this screen is 2^30 bytes — the unit the mocks and most OS file managers use. */
export const GIB = 1024 ** 3;
export const DISK_CAP_MIN_GB = 1;
export const DISK_CAP_MAX_GB = 10_000;
/** The slider covers the common range; the number field takes anything up to the max. */
export const DISK_CAP_SLIDER_MAX_GB = 500;

export function bytesToGb(bytes: number): number {
  return bytes / GIB;
}

export function gbToBytes(gb: number): number {
  return Math.round(gb * GIB);
}

/** `50 GiB` → `"50 GB"`, `1.25 GiB` → `"1.3 GB"`, `300 MiB` → `"300 MB"`, `0` → `"0 GB"`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 GB';
  if (bytes < GIB) {
    const mb = bytes / 1024 ** 2;
    return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, '') : String(Math.round(mb))} MB`;
  }
  const gb = bytes / GIB;
  return `${gb < 100 ? gb.toFixed(1).replace(/\.0$/, '') : String(Math.round(gb))} GB`;
}

/** The number shown in the GB field for a stored cap (at most one decimal). */
export function gbFieldValue(bytes: number): string {
  const gb = bytesToGb(bytes);
  return Number.isInteger(gb) ? String(gb) : gb.toFixed(1).replace(/\.0$/, '');
}

export function parseDiskCapGb(text: string): Validation<number> {
  const t = text.trim();
  if (t === '') return fail('Enter a size in GB.');
  const n = Number(t);
  if (!Number.isFinite(n)) return fail('Enter a number of GB, like 50.');
  if (n < DISK_CAP_MIN_GB || n > DISK_CAP_MAX_GB)
    return fail(
      `Choose between ${String(DISK_CAP_MIN_GB)} and ${DISK_CAP_MAX_GB.toLocaleString('en-US')} GB.`,
    );
  return ok(Math.round(n * 10) / 10);
}

// ---- prefetch ("buffer = money", build-plan §6.2) --------------------------------------

export const PREFETCH_MIN_SEC = 5;
export const PREFETCH_MAX_SEC = 120;
export const PREFETCH_STEP_SEC = 5;
/** build-plan §6.2: "Prefetch depth is a user setting (default ~30 s)". */
export const PREFETCH_DEFAULT_SEC = 30;

export const PREFETCH_PRESETS: readonly {
  readonly seconds: number;
  readonly label: string;
}[] = [
  { seconds: 10, label: 'Data saver' },
  { seconds: PREFETCH_DEFAULT_SEC, label: 'Balanced' },
  { seconds: 60, label: 'Smooth' },
];

export function clampPrefetch(sec: number): number {
  if (!Number.isFinite(sec)) return PREFETCH_DEFAULT_SEC;
  const stepped = Math.round(sec / PREFETCH_STEP_SEC) * PREFETCH_STEP_SEC;
  return Math.min(PREFETCH_MAX_SEC, Math.max(PREFETCH_MIN_SEC, stepped));
}

// ---- auto top-up ----------------------------------------------------------------------

/**
 * The THRESHOLD's default and ceiling (`Settings.autoTopUp.belowSats`) — not an amount. Named so
 * since issue #2's independent review: the ceiling used to be `AUTO_TOP_UP_MAX_SATS`, which in
 * core is the most one top-up MOVES (10 000), a thousand times less.
 */
export const AUTO_TOP_UP_THRESHOLD_DEFAULT_SATS = 1_000;
export const AUTO_TOP_UP_THRESHOLD_MAX_SATS = 10_000_000;
/**
 * Issue #2: the most one auto top-up moves, and its default — core's `AUTO_TOP_UP_MAX_SATS`
 * (a local copy pinned by a test: the screens import no core runtime code).
 */
export const AUTO_TOP_UP_AMOUNT_MAX_SATS = UI_AUTO_TOP_UP_MAX_SATS;
/** Issue #2: the most auto top-ups move in any rolling 24 hours — core's `AUTO_TOP_UP_MAX_SATS_PER_DAY`. */
export const AUTO_TOP_UP_PER_DAY_SATS = UI_AUTO_TOP_UP_PER_DAY_SATS;

/**
 * `Settings.autoTopUp` is optional and `updateSettings` takes a `Partial<Settings>` merge, so
 * under `exactOptionalPropertyTypes` a patch cannot remove it. "Off" is therefore written as a
 * zero threshold (the balance is never below 0 sats) and read back the same way — see
 * docs/archive/contract-requests/L5-Settings.md.
 */
export function autoTopUpEnabled(
  a: { readonly belowSats: number } | undefined,
): a is { readonly belowSats: number } {
  return a !== undefined && a.belowSats > 0;
}

export function parseThresholdSats(text: string): Validation<number> {
  const t = text.trim().replace(/[,_\s]/g, '');
  if (t === '') return fail('Enter an amount in sats.');
  if (!/^\d+$/.test(t)) return fail('Sats are whole numbers, like 1000.');
  const n = Number(t);
  if (n < 1 || n > AUTO_TOP_UP_THRESHOLD_MAX_SATS)
    return fail(
      `Choose between 1 and ${AUTO_TOP_UP_THRESHOLD_MAX_SATS.toLocaleString('en-US')} sats.`,
    );
  return ok(n);
}

/** The sats one auto top-up moves: `amountSats`, absent = the max (issue #2). */
export function autoTopUpAmount(a: { readonly amountSats?: number } | undefined): number {
  const n = a?.amountSats;
  return n === undefined ? AUTO_TOP_UP_AMOUNT_MAX_SATS : Math.min(n, AUTO_TOP_UP_AMOUNT_MAX_SATS);
}

/** Issue #2: a top-up amount — whole sats, 1 … `AUTO_TOP_UP_AMOUNT_MAX_SATS`. */
export function parseTopUpAmountSats(text: string): Validation<number> {
  const t = text.trim().replace(/[,_\s]/g, '');
  if (t === '') return fail('Enter an amount in sats.');
  if (!/^\d+$/.test(t)) return fail('Sats are whole numbers, like 5000.');
  const n = Number(t);
  if (n < 1 || n > AUTO_TOP_UP_AMOUNT_MAX_SATS)
    return fail(
      `Choose between 1 and ${AUTO_TOP_UP_AMOUNT_MAX_SATS.toLocaleString('en-US')} sats per top-up.`,
    );
  return ok(n);
}

// ---- signer copy ------------------------------------------------------------------------

export type SignerKind = SignerStatus['kind'];

export const SIGNER_KINDS: readonly {
  readonly kind: SignerKind;
  readonly title: string;
  readonly nip: string;
  readonly description: string;
}[] = [
  {
    kind: 'nip07',
    title: 'Browser extension',
    nip: 'NIP-07',
    description: 'A Nostr extension in your browser holds your key and signs when Nutflix asks.',
  },
  {
    kind: 'nip46',
    title: 'Remote signer',
    nip: 'NIP-46',
    description:
      'A signer on another device or service signs over a relay. Your key never touches this device.',
  },
  {
    kind: 'local',
    title: 'Local key',
    nip: 'Local',
    description:
      'Your key is stored on this device, encrypted with your passphrase, and unlocked while you use Nutflix.',
  },
];

export function signerTitle(kind: SignerKind): string {
  const s = SIGNER_KINDS.find((k) => k.kind === kind);
  return s ? `${s.title} (${s.nip})` : kind;
}

// ---- error copy -------------------------------------------------------------------------

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : '';
}

/** Copy for the full-screen load failure. Never a stack trace (the shell logs those). */
export function describeLoadError(err: unknown): {
  readonly title: string;
  readonly description: string;
  readonly detail: string | undefined;
} {
  const message = errorMessage(err);
  if (/relay/i.test(message)) {
    return {
      title: 'Relay down',
      description:
        'None of your relays answered, so your settings could not be loaded. Check your connection and retry — nothing was changed.',
      detail: message,
    };
  }
  return {
    title: 'Could not load your settings',
    description: 'Nothing was changed. Try again in a moment.',
    detail: message || undefined,
  };
}

/** Copy for a failed save (the toast). The change has already been rolled back on screen. */
export function describeSaveError(err: unknown): string {
  const message = errorMessage(err);
  if (/relay/i.test(message))
    return 'None of your relays answered, so the change was undone. Retry when you are back online.';
  return message
    ? `The change was undone (${message}).`
    : 'The change was undone. Try again in a moment.';
}
