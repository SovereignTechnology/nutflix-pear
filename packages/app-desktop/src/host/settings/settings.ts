/**
 * `Settings` (contracts v4) persisted in userData `settings.json`, plus the shell-only
 * `desktop.json` (design §1: the ffmpeg location lives there until v5 adds
 * `Settings.ffmpegPath`). The host owns both files; the worker is told what it needs.
 */
import { join } from 'node:path';

import type { MintUrl, RelayUrl, Sats, Settings } from '@sovit/core';

import { isAbsolutePath, obj } from '../../ipc/guards.js';
import { validateArgs } from '../../ipc/guards.js';
import type { Logger } from '../log.js';
import { JsonFile } from './json-file.js';

export const SETTINGS_FILE = 'settings.json';
export const DESKTOP_FILE = 'desktop.json';
const FILE_V = 1 as const;

/**
 * First-run settings. Decisions (docs/archive/lanes/L6-B.md): three widely used public relays so a
 * first run shows something; no default mint (the user chooses who holds their money);
 * seeding OFF until the user opts in (it spends disk and upload bandwidth); a 30 s prefetch
 * ("buffer = money"); theme follows the system.
 */
export const DEFAULT_SETTINGS: Settings = Object.freeze({
  relays: Object.freeze([
    Object.freeze({ url: 'wss://relay.damus.io' as RelayUrl, read: true, write: true }),
    Object.freeze({ url: 'wss://nos.lol' as RelayUrl, read: true, write: true }),
    Object.freeze({ url: 'wss://relay.primal.net' as RelayUrl, read: true, write: true }),
  ]),
  defaultMints: Object.freeze([]),
  // ADR 0015: once seeding is on, creators' thumbnails and avatars are shared too (free).
  seeding: Object.freeze({ enabled: false, diskCapBytes: 10 * 1024 ** 3, serveImages: true }),
  prefetchSeconds: 30,
  hoverPreview: true,
  // Security review F18: only hash-addressed images until the user opts in.
  loadRemoteImages: false,
  theme: 'system' as const,
});

const SETTINGS_KEYS: readonly (keyof Settings)[] = [
  'relays',
  'defaultMints',
  'seeding',
  'prefetchSeconds',
  'hoverPreview',
  'loadRemoteImages',
  'theme',
  'autoTopUp',
  'nfx',
];

/** True when `patch` is a valid `Partial<Settings>` — the same guard main and the host run on IPC. */
export function isSettingsPatch(patch: unknown): patch is Partial<Settings> {
  return validateArgs.updateSettings([patch]);
}

/**
 * A stored settings object → `Settings`, or `null`. Unknown keys (e.g. written by a newer
 * build) are ignored; missing keys take their defaults; every present key must be valid —
 * except `nfx` (contracts v10), which is checked on its own: an invalid one (say, a network a
 * newer build added) is dropped, so NFX is off, and leaves the rest of the file standing.
 */
export function parseStoredSettings(raw: unknown): StoredSettings | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const file = raw as Record<string, unknown>;
  if (file['v'] !== FILE_V) return null;
  const s = file['settings'];
  if (typeof s !== 'object' || s === null || Array.isArray(s)) return null;
  const picked: Record<string, unknown> = {};
  for (const k of SETTINGS_KEYS)
    if (Object.prototype.hasOwnProperty.call(s, k)) picked[k] = (s as Record<string, unknown>)[k];
  const { nfx, ...rest } = picked;
  if (!isSettingsPatch(rest)) return null;
  const nfxPatch: unknown = nfx === undefined ? {} : { nfx };
  const kept = isSettingsPatch(nfxPatch) ? nfxPatch : {};
  return { v: FILE_V, settings: { ...DEFAULT_SETTINGS, ...rest, ...kept } };
}

/** What `settings.json` holds. */
export interface StoredSettings {
  readonly v: typeof FILE_V;
  readonly settings: Settings;
}

/**
 * Whether a top-up of `mint` (whose balance is `balance`) is due — the question the contract
 * defines; `../topup/auto-topup.ts` executes it (issue #2) behind its own caps and confirm:
 *
 *   - SE-4 (docs/archive/reviews/2026-09-23-pre-push-l5-v4.md): "off" when absent or `belowSats <= 0`
 *     (a patch cannot clear the optional key, so Settings/Wallet write `belowSats: 0`); the
 *     trigger is strictly `balance < belowSats`;
 *   - v5 (ADR 0010 item 5): `mint` is the mint a payment is about to draw from, the top-up is
 *     funded from `fromMint`, and it never fires for `fromMint` itself;
 *   - security review F4: only a mint on the user's own list (`defaultMints`) is ever topped up —
 *     never a mint first seen in a video's manifest, which a creator can run to siphon
 *     unattended top-ups.
 */
export function autoTopUpDue(settings: Settings, mint: MintUrl, balance: Sats): boolean {
  const a = settings.autoTopUp;
  if (a === undefined) return false;
  if (!(Number.isFinite(a.belowSats) && a.belowSats > 0)) return false;
  if (mint === a.fromMint) return false;
  if (!settings.defaultMints.includes(mint)) return false;
  return balance < a.belowSats;
}

export class SettingsStore {
  private readonly file: JsonFile<StoredSettings>;
  private readonly log: Logger;
  private current: Settings = DEFAULT_SETTINGS;
  private readonly listeners = new Set<(next: Settings, prev: Settings) => void>();

  constructor(userData: string, log: Logger) {
    this.log = log.child('settings');
    this.file = new JsonFile(join(userData, SETTINGS_FILE), parseStoredSettings, this.log);
  }

  /** Reads the file once at start-up. Never throws: a bad file means defaults. */
  async load(): Promise<Settings> {
    const r = await this.file.load();
    this.current = r.kind === 'ok' ? r.value.settings : DEFAULT_SETTINGS;
    return this.current;
  }

  get(): Settings {
    return this.current;
  }

  /**
   * Validates `patch`, merges it, persists atomically, then notifies listeners. A persist
   * failure rejects and leaves the in-memory settings unchanged.
   */
  async update(patch: Partial<Settings>): Promise<Settings> {
    if (!isSettingsPatch(patch)) throw new TypeError('invalid settings patch');
    const prev = this.current;
    const next: Settings = { ...prev, ...patch };
    await this.file.save({ v: FILE_V, settings: next });
    this.current = next;
    for (const l of this.listeners) {
      try {
        l(next, prev);
      } catch {
        this.log.warn('settings listener threw');
      }
    }
    return next;
  }

  onChange(cb: (next: Settings, prev: Settings) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

// ---- desktop.json -------------------------------------------------------------------------

export interface DesktopConfig {
  /** System ffmpeg/ffprobe the user pointed Studio at (pre-v5 `Settings.ffmpegPath`). */
  readonly ffmpeg?: { readonly ffmpeg: string; readonly ffprobe: string };
}

const isFfmpegPaths = obj({ ffmpeg: isAbsolutePath, ffprobe: isAbsolutePath });

export function parseDesktopConfig(raw: unknown): DesktopConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const file = raw as Record<string, unknown>;
  if (file['v'] !== FILE_V) return null;
  const f = file['ffmpeg'];
  if (f === undefined) return {};
  return isFfmpegPaths(f) ? { ffmpeg: { ffmpeg: f.ffmpeg, ffprobe: f.ffprobe } } : null;
}

export async function loadDesktopConfig(userData: string, log: Logger): Promise<DesktopConfig> {
  const r = await new JsonFile(join(userData, DESKTOP_FILE), parseDesktopConfig, log).load();
  return r.kind === 'ok' ? r.value : {};
}
