/**
 * The web client's settings (ADR 0022 item 8): what a patch may hold, what a stored value reads as
 * (corrupt, partial, of another version, too large), writes the browser refuses, a page with no
 * storage, and the `storage` event that keeps open tabs in step.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Settings } from '@sovit/core';

import { WebAdapterError } from '../../errors.js';
import {
  DEFAULT_WEB_NFX,
  DEFAULT_WEB_SETTINGS,
  WEB_ICE_SERVERS,
  WEB_SCOPED_RELAY,
  WEB_TRACKER,
} from '../defaults.js';
import {
  MAX_STORED_SETTINGS,
  WEB_SETTINGS_KEY,
  WebSettingsStore,
  browserSettingsStore,
  parseStoredWebSettings,
  type SettingsStorage,
  type StorageEventTarget,
} from '../store.js';
import { isRelayUrl, isScopedRelayUrl, isTrackerUrl, isWebSettingsPatch } from '../validate.js';

const stored = (settings: unknown, v: unknown = 1): string => JSON.stringify({ v, settings });

class MemoryStorage implements SettingsStorage {
  readonly m = new Map<string, string>();
  failWrites = false;
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.failWrites) throw new DOMException('quota', 'QuotaExceededError');
    this.m.set(k, v);
  }
}

class Events implements StorageEventTarget {
  readonly listeners = new Set<(e: { readonly key: string | null }) => void>();
  addEventListener(_t: 'storage', l: (e: { readonly key: string | null }) => void): void {
    this.listeners.add(l);
  }
  removeEventListener(_t: 'storage', l: (e: { readonly key: string | null }) => void): void {
    this.listeners.delete(l);
  }
  fire(key: string | null): void {
    for (const l of this.listeners) l({ key });
  }
}

function caught(fn: () => unknown): WebAdapterError {
  try {
    fn();
  } catch (e) {
    if (e instanceof WebAdapterError) return e;
    throw e;
  }
  throw new Error('did not throw');
}

describe('defaults (ADR 0022 items 4 to 6)', () => {
  it("ADR 0009's four read relays, NFX on with relay.nutflix.xyz and the web's tracker, our STUN", () => {
    expect(DEFAULT_WEB_SETTINGS.relays.map((r) => r.url)).toEqual([
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.primal.net',
      'wss://relay.ditto.pub',
    ]);
    expect(DEFAULT_WEB_SETTINGS.nfx).toEqual({
      enabled: true,
      network: 'nfx:testnet:1',
      scopedRelays: ['wss://relay.nutflix.xyz'],
      trackers: ['wss://web.nutflix.xyz/tracker'],
    });
    expect(DEFAULT_WEB_SETTINGS.nfx?.irohRelays).toBeUndefined();
    expect(WEB_ICE_SERVERS).toEqual([{ urls: ['stun:web.nutflix.xyz:3478'] }]);
    expect(DEFAULT_WEB_SETTINGS.loadRemoteImages).toBe(false);
    expect(DEFAULT_WEB_SETTINGS.seeding.enabled).toBe(false);
    expect(DEFAULT_WEB_SETTINGS.defaultMints).toEqual([]);
    expect(DEFAULT_WEB_SETTINGS.autoTopUp).toBeUndefined();
    expect(isWebSettingsPatch({ relays: DEFAULT_WEB_SETTINGS.relays, nfx: DEFAULT_WEB_NFX })).toBe(
      true,
    );
  });
});

describe('isWebSettingsPatch', () => {
  it.each([
    ['nothing', {}],
    ['relays', { relays: [{ url: 'wss://relay.example', read: true, write: false }] }],
    ['no relays', { relays: [] }],
    ['the theme', { theme: 'dark' }],
    ['prefetch', { prefetchSeconds: 45 }],
    ['hover preview', { hoverPreview: false }],
    ['loadRemoteImages off', { loadRemoteImages: false }],
    [
      'NFX without trackers',
      { nfx: { enabled: true, network: 'nfx:testnet:1', scopedRelays: [] } },
    ],
    [
      'NFX with a local relay and a local tracker',
      {
        nfx: {
          enabled: true,
          network: 'nfx:testnet:1',
          scopedRelays: ['ws://127.0.0.1:7777'],
          trackers: ['ws://localhost:8000/announce', WEB_TRACKER],
        },
      },
    ],
  ])('accepts %s', (_name, patch) => {
    expect(isWebSettingsPatch(patch)).toBe(true);
  });

  const nfx = { enabled: true, network: 'nfx:testnet:1', scopedRelays: [WEB_SCOPED_RELAY] };
  it.each([
    ['not an object', 'theme=dark'],
    ['an array', []],
    ['null', null],
    ['a class instance', new Date()],
    ['an unknown key', { volume: 1 }],
    ['a key set to undefined', { theme: undefined }],
    ['mints (no wallet in v1)', { defaultMints: [] }],
    ['seeding (none in v1)', { seeding: { enabled: false, diskCapBytes: 0 } }],
    ['auto top-up', { autoTopUp: { belowSats: 0, fromMint: 'https://mint.example' } }],
    ['loadRemoteImages on (signed images only)', { loadRemoteImages: true }],
    ['a bad theme', { theme: 'blue' }],
    ['prefetch over the cap', { prefetchSeconds: 601 }],
    ['prefetch NaN', { prefetchSeconds: Number.NaN }],
    ['an http relay', { relays: [{ url: 'https://relay.example', read: true, write: true }] }],
    [
      'a relay with a fragment',
      { relays: [{ url: 'wss://relay.example#x', read: true, write: true }] },
    ],
    [
      'a relay with user-info',
      { relays: [{ url: 'wss://u@relay.example', read: true, write: true }] },
    ],
    ['a relay without flags', { relays: [{ url: 'wss://relay.example' }] }],
    ['NFX off', { nfx: { ...nfx, enabled: false } }],
    ['another network', { nfx: { ...nfx, network: 'nfx:mainnet:1' } }],
    ['iroh relays', { nfx: { ...nfx, irohRelays: ['https://iroh.example/'] } }],
    [
      'a ws scoped relay off this computer',
      { nfx: { ...nfx, scopedRelays: ['ws://relay.example'] } },
    ],
    [
      'a duplicate scoped relay',
      { nfx: { ...nfx, scopedRelays: [WEB_SCOPED_RELAY, WEB_SCOPED_RELAY] } },
    ],
    [
      'nine scoped relays',
      {
        nfx: {
          ...nfx,
          scopedRelays: Array.from({ length: 9 }, (_, i) => `wss://r${String(i)}.example`),
        },
      },
    ],
    [
      'five trackers',
      {
        nfx: {
          ...nfx,
          trackers: Array.from({ length: 5 }, (_, i) => `wss://t${String(i)}.example`),
        },
      },
    ],
    ['a duplicate tracker', { nfx: { ...nfx, trackers: [WEB_TRACKER, WEB_TRACKER] } }],
    ['a ws tracker off this computer', { nfx: { ...nfx, trackers: ['ws://tracker.example/a'] } }],
    ['a tracker with a query', { nfx: { ...nfx, trackers: ['wss://tracker.example/a?x=1'] } }],
    ['an upper-case tracker', { nfx: { ...nfx, trackers: ['wss://Tracker.example/a'] } }],
    ['a tracker with a bare /', { nfx: { ...nfx, trackers: ['wss://tracker.example/'] } }],
  ])('refuses %s', (_name, patch) => {
    expect(isWebSettingsPatch(patch)).toBe(false);
  });

  it('never throws, whatever a getter does', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'theme', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(isWebSettingsPatch(hostile)).toBe(false);
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    expect(isWebSettingsPatch(proxy)).toBe(false);
  });

  it('the URL forms Settings writes (normalised) pass; what it refuses fails', () => {
    for (const ok of [
      'wss://relay.example',
      'wss://relay.example/path',
      'wss://[2001:db8::1]:7000',
    ]) {
      expect(isRelayUrl(ok), ok).toBe(true);
      expect(isScopedRelayUrl(ok), ok).toBe(true);
    }
    expect(isScopedRelayUrl('ws://[::1]:7777')).toBe(true);
    expect(isRelayUrl('ws://[::1]:7777')).toBe(false);
    for (const ok of [
      'wss://tracker.example',
      'wss://tracker.example/announce',
      'ws://[::1]:8000/a',
    ]) {
      expect(isTrackerUrl(ok), ok).toBe(true);
    }
    expect(isTrackerUrl(`wss://t.example/${'a'.repeat(600)}`)).toBe(false);
  });
});

describe('parseStoredWebSettings: unreadable means defaults', () => {
  it.each([
    ['nothing stored', null],
    ['not JSON', '{"v":1,'],
    ['JSON, not an object', '[1,2]'],
    ['another version', stored({ theme: 'dark' }, 2)],
    ['no version', JSON.stringify({ settings: { theme: 'dark' } })],
    ['settings not an object', stored('dark')],
    ['a field this client refuses', stored({ theme: 'dark', relays: 'wss://relay.example' })],
    ['loadRemoteImages on', stored({ theme: 'dark', loadRemoteImages: true })],
    ['too large', stored({ theme: 'dark', pad: 'x'.repeat(MAX_STORED_SETTINGS) })],
  ])('%s → the defaults', (_name, raw) => {
    expect(parseStoredWebSettings(raw)).toBe(DEFAULT_WEB_SETTINGS);
  });

  it('partial: what is stored, the defaults for the rest; unknown and fixed keys ignored', () => {
    const s = parseStoredWebSettings(
      stored({
        theme: 'light',
        prefetchSeconds: 10,
        future: { x: 1 },
        defaultMints: ['https://mint.example'],
        seeding: { enabled: true, diskCapBytes: 1 },
      }),
    );
    expect(s).toEqual({ ...DEFAULT_WEB_SETTINGS, theme: 'light', prefetchSeconds: 10 });
    expect(s.defaultMints).toEqual([]);
    expect(s.seeding.enabled).toBe(false);
  });

  it('an nfx that does not check out is replaced by the default one (always on), the rest kept', () => {
    for (const nfx of [
      { enabled: false, network: 'nfx:testnet:1', scopedRelays: [] },
      { enabled: true, network: 'nfx:mainnet:1', scopedRelays: [] },
      'on',
    ]) {
      const s = parseStoredWebSettings(stored({ theme: 'dark', nfx }));
      expect(s.theme).toBe('dark');
      expect(s.nfx).toBe(DEFAULT_WEB_NFX);
    }
  });
});

describe('WebSettingsStore', () => {
  it('reads what is stored, and writes only the fields a viewer sets', () => {
    const storage = new MemoryStorage();
    storage.m.set(WEB_SETTINGS_KEY, stored({ theme: 'dark' }));
    const store = new WebSettingsStore({ storage });
    expect(store.get().theme).toBe('dark');
    const next = store.update({ hoverPreview: false });
    expect(next).toEqual({ ...DEFAULT_WEB_SETTINGS, theme: 'dark', hoverPreview: false });
    const written = JSON.parse(storage.m.get(WEB_SETTINGS_KEY)!) as {
      v: number;
      settings: Record<string, unknown>;
    };
    expect(written.v).toBe(1);
    expect(Object.keys(written.settings).sort()).toEqual(
      ['hoverPreview', 'loadRemoteImages', 'nfx', 'prefetchSeconds', 'relays', 'theme'].sort(),
    );
    expect(new WebSettingsStore({ storage }).get()).toEqual(next);
  });

  it('a patch this client refuses: invalid-argument, nothing written', () => {
    const storage = new MemoryStorage();
    const store = new WebSettingsStore({ storage });
    const heard = vi.fn();
    store.onChange(heard);
    const e = caught(() => store.update({ nfx: { ...DEFAULT_WEB_NFX, enabled: false } }));
    expect(e.code).toBe('invalid-argument');
    expect(e.message).toMatch(/^invalid-argument: /);
    expect(storage.m.size).toBe(0);
    expect(store.get()).toBe(DEFAULT_WEB_SETTINGS);
    expect(heard).not.toHaveBeenCalled();
  });

  it('a write the browser refuses: internal, nothing changes', () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    const store = new WebSettingsStore({ storage });
    expect(caught(() => store.update({ theme: 'dark' })).code).toBe('internal');
    expect(store.get().theme).toBe('system');
  });

  it('a storage that throws on read means the defaults', () => {
    const store = new WebSettingsStore({
      storage: {
        getItem: () => {
          throw new DOMException('denied', 'SecurityError');
        },
        setItem: () => undefined,
      },
    });
    expect(store.get()).toBe(DEFAULT_WEB_SETTINGS);
  });

  it('no storage at all: the settings live in memory for the session', () => {
    const events = new Events();
    const store = new WebSettingsStore({ storage: null, events });
    expect(store.update({ theme: 'light' }).theme).toBe('light');
    events.fire(WEB_SETTINGS_KEY);
    expect(store.get().theme).toBe('light');
  });

  it('another tab’s write: re-read and heard; another key ignored; a cleared storage is defaults', () => {
    const storage = new MemoryStorage();
    const events = new Events();
    const store = new WebSettingsStore({ storage, events });
    const heard: Settings[] = [];
    store.onChange((s) => heard.push(s));
    storage.m.set(WEB_SETTINGS_KEY, stored({ theme: 'dark', relays: [] }));
    events.fire('some.other.key');
    expect(heard).toHaveLength(0);
    events.fire(WEB_SETTINGS_KEY);
    expect(store.get().theme).toBe('dark');
    expect(store.get().relays).toEqual([]);
    expect(heard).toHaveLength(1);
    // The same value again is no change.
    events.fire(WEB_SETTINGS_KEY);
    expect(heard).toHaveLength(1);
    // Another tab wrote garbage: defaults, as at start-up.
    storage.m.set(WEB_SETTINGS_KEY, '{garbage');
    events.fire(WEB_SETTINGS_KEY);
    expect(store.get()).toBe(DEFAULT_WEB_SETTINGS);
    storage.m.clear();
    store.update({ theme: 'light' });
    storage.m.clear();
    events.fire(null);
    expect(store.get()).toBe(DEFAULT_WEB_SETTINGS);
    expect(heard).toHaveLength(4);
    store.close();
    expect(events.listeners.size).toBe(0);
  });

  it('a listener that throws does not stop the next one', () => {
    const store = new WebSettingsStore({ storage: new MemoryStorage() });
    const second = vi.fn();
    store.onChange(() => {
      throw new Error('boom');
    });
    const off = store.onChange(second);
    store.update({ theme: 'dark' });
    expect(second).toHaveBeenCalledTimes(1);
    off();
    store.update({ theme: 'light' });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('browserSettingsStore: the window’s Web Storage, or memory where reading it throws', () => {
    const storage = new MemoryStorage();
    storage.m.set(WEB_SETTINGS_KEY, stored({ theme: 'dark' }));
    const events = new Events();
    const win = {
      localStorage: storage,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } as unknown as Window;
    const store = browserSettingsStore(win);
    expect(store.get().theme).toBe('dark');
    storage.m.set(WEB_SETTINGS_KEY, stored({ theme: 'light' }));
    events.fire(WEB_SETTINGS_KEY);
    expect(store.get().theme).toBe('light');
    const blocked = {
      get localStorage(): Storage {
        throw new DOMException('denied', 'SecurityError');
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as Window;
    const memory = browserSettingsStore(blocked);
    expect(memory.get()).toBe(DEFAULT_WEB_SETTINGS);
    expect(memory.update({ theme: 'light' }).theme).toBe('light');
  });
});
