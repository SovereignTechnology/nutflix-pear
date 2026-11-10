import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  IrohRelayUrl,
  MintUrl,
  NfxSettings,
  RelayUrl,
  Sats,
  Settings,
  TrackerUrl,
} from '@sovit/core';

import { memoryLogger } from '../log.js';
import {
  DEFAULT_NFX,
  DEFAULT_SETTINGS,
  SETTINGS_FILE,
  SettingsStore,
  autoTopUpDue,
  loadDesktopConfig,
  parseStoredSettings,
} from '../settings/settings.js';

const MINT = 'https://mint.example' as MintUrl;
const OTHER = 'https://other.example' as MintUrl;

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nf-l6b-settings-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the first-run relays (ADR 0009 and its 2026-11-07 amendment)', () => {
  it('are exactly the four public relays the README and SECURITY.md name, each read and write over wss', () => {
    expect(DEFAULT_SETTINGS.relays.map((r) => r.url)).toEqual([
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.primal.net',
      // The only free, open relay found that answers NIP-50, which Search relies on.
      'wss://relay.ditto.pub',
    ]);
    expect(DEFAULT_SETTINGS.relays.every((r) => r.read && r.write)).toBe(true);
    expect(new Set(DEFAULT_SETTINGS.relays.map((r) => r.url)).size).toBe(4);
  });

  it('are replaced, not extended, by a stored list: an install with saved relays is unchanged', () => {
    const saved = [{ url: 'wss://only.example' as RelayUrl, read: true, write: false }];
    const parsed = parseStoredSettings({ v: 1, settings: { relays: saved } });
    expect(parsed?.settings.relays).toEqual(saved);
  });
});

describe('SettingsStore (atomic JSON in userData)', () => {
  it('starts from defaults on a first run, persists an update, and reads it back', async () => {
    const log = memoryLogger();
    const a = new SettingsStore(dir, log);
    expect(await a.load()).toEqual(DEFAULT_SETTINGS);
    expect(log.lines).toEqual([]); // a missing file is not an error
    const next = await a.update({ theme: 'light', prefetchSeconds: 12 });
    expect(next).toEqual({ ...DEFAULT_SETTINGS, theme: 'light', prefetchSeconds: 12 });
    const b = new SettingsStore(dir, memoryLogger());
    expect(await b.load()).toEqual(next);
    const raw = JSON.parse(await readFile(join(dir, SETTINGS_FILE), 'utf8')) as unknown;
    expect(raw).toEqual({ v: 1, settings: next });
    if (process.platform !== 'win32')
      expect((await stat(join(dir, SETTINGS_FILE))).mode & 0o777).toBe(0o600);
  });

  it('a corrupt file means defaults + a logged warning + the file moved aside — never a crash', async () => {
    for (const body of ['{not json', '[]', '{"v":1,"settings":{"theme":"neon"}}', '{"v":2}', '']) {
      await writeFile(join(dir, SETTINGS_FILE), body);
      const log = memoryLogger();
      const s = new SettingsStore(dir, log);
      expect(await s.load(), body).toEqual(DEFAULT_SETTINGS);
      expect(log.lines.map((l) => [l.level, l.msg])).toEqual([
        ['warn', 'state file is corrupt; using defaults'],
      ]);
      expect(await readFile(join(dir, `${SETTINGS_FILE}.corrupt`), 'utf8')).toBe(body);
    }
  });

  it('unknown keys (a newer build) are ignored; missing keys take their defaults', () => {
    const parsed = parseStoredSettings({
      v: 1,
      settings: { theme: 'dark', ffmpegPath: '/usr/bin/ffmpeg', futureThing: { a: 1 } },
    });
    expect(parsed?.settings).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' });
  });

  it('contracts v10: a valid `nfx` is kept; an invalid one goes alone, to the defaults OFF', () => {
    const nfx = {
      enabled: true,
      network: 'nfx:testnet:1',
      scopedRelays: ['wss://scoped.example', 'ws://127.0.0.1:7777'],
    };
    expect(parseStoredSettings({ v: 1, settings: { theme: 'dark', nfx } })?.settings).toEqual({
      ...DEFAULT_SETTINGS,
      theme: 'dark',
      nfx,
    });
    // A network a newer build added, or a cleartext relay off this computer: only `nfx` goes.
    for (const bad of [
      { ...nfx, network: 'nfx:mainnet:1' },
      { ...nfx, scopedRelays: ['ws://scoped.example'] },
      'on',
    ]) {
      const parsed = parseStoredSettings({ v: 1, settings: { theme: 'dark', nfx: bad } });
      // Never the default ON: a value this build cannot read turns NFX off (2026-11-08).
      expect(parsed?.settings).toEqual({
        ...DEFAULT_SETTINGS,
        theme: 'dark',
        nfx: { ...DEFAULT_NFX, enabled: false },
      });
    }
    // Every other key still fails the whole file, as before.
    expect(parseStoredSettings({ v: 1, settings: { theme: 'neon', nfx } })).toBeNull();
  });

  it('contracts v17: WebRTC and its STUN servers are kept; unreadable, only WebRTC goes off', () => {
    const nfx = { enabled: true, network: 'nfx:testnet:1', scopedRelays: [] };
    const rtc = {
      ...nfx,
      webrtc: false,
      stunServers: ['stun.example:3478', '[2001:db8::1]:19302'],
    };
    expect(parseStoredSettings({ v: 1, settings: { nfx: rtc } })?.settings.nfx).toEqual(rtc);
    // A stored v16 value (neither field) stays as it is: absent WebRTC is on, at the default STUN.
    expect(parseStoredSettings({ v: 1, settings: { nfx } })?.settings.nfx).toEqual(nfx);
    for (const bad of [
      { ...nfx, webrtc: 'yes' },
      { ...nfx, stunServers: ['stun:stun.example:3478'] },
      { ...nfx, stunServers: ['stun.example'] },
      { ...nfx, stunServers: ['stun.example:70000'] },
      { ...nfx, stunServers: ['a.example:1', 'a.example:1'] },
      { ...nfx, stunServers: ['a:1', 'b:1', 'c:1', 'd:1', 'e:1'] },
    ]) {
      const parsed = parseStoredSettings({ v: 1, settings: { nfx: bad } });
      // NFX stays on; WebRTC, which this build could not read, is off.
      expect(parsed?.settings.nfx, JSON.stringify(bad)).toEqual({ ...nfx, webrtc: false });
    }
    // Anything else wrong still turns NFX off, WebRTC fields or not.
    expect(
      parseStoredSettings({ v: 1, settings: { nfx: { ...nfx, network: 'x', webrtc: 'yes' } } })
        ?.settings.nfx,
    ).toEqual({ ...DEFAULT_NFX, enabled: false });
  });

  it("ADR 0020 2026-11-08: NFX is on by default, on the test network's public relays, and every part is the user's to change", () => {
    expect(DEFAULT_SETTINGS.nfx).toEqual({
      enabled: true,
      network: 'nfx:testnet:1',
      scopedRelays: ['wss://relay.nutflix.xyz'],
      irohRelays: ['https://iroh.nutflix.xyz/'],
      // ADR 0023: WebRTC with browsers on, from the network's own STUN server.
      webrtc: true,
      stunServers: ['web.nutflix.xyz:3478'],
    });
    // The defaults pass the same checks a user's settings do (wss://, the iroh relay's form).
    expect(parseStoredSettings({ v: 1, settings: { nfx: DEFAULT_NFX } })?.settings.nfx).toEqual(
      DEFAULT_NFX,
    );
    // No stored `nfx` (a first run, or an install that never touched NFX): the default, on.
    expect(parseStoredSettings({ v: 1, settings: { theme: 'dark' } })?.settings.nfx).toEqual(
      DEFAULT_NFX,
    );
    // The user's own choice always wins: off, other relays, or none at all.
    for (const mine of [
      { ...DEFAULT_NFX, enabled: false },
      { ...DEFAULT_NFX, scopedRelays: ['wss://my.example'], irohRelays: [] },
      { ...DEFAULT_NFX, scopedRelays: [], irohRelays: [] },
    ]) {
      expect(parseStoredSettings({ v: 1, settings: { nfx: mine } })?.settings.nfx).toEqual(mine);
    }
  });

  it('contracts v12: stored `irohRelays` round-trip; a bad one drops `nfx` alone', async () => {
    const nfx: NfxSettings = {
      enabled: true,
      network: 'nfx:testnet:1',
      scopedRelays: ['wss://scoped.example' as RelayUrl],
      irohRelays: ['https://relay.example/', 'http://127.0.0.1:3340/'] as IrohRelayUrl[],
    };
    expect(parseStoredSettings({ v: 1, settings: { theme: 'dark', nfx } })?.settings).toEqual({
      ...DEFAULT_SETTINGS,
      theme: 'dark',
      nfx,
    });
    const s = new SettingsStore(dir, memoryLogger());
    await s.load();
    await s.update({ nfx });
    const reread = new SettingsStore(dir, memoryLogger());
    expect((await reread.load()).nfx).toEqual(nfx);
    // Not iroh's normal form, cleartext off this computer, a duplicate, more than 4.
    for (const irohRelays of [
      ['https://relay.example'],
      ['http://relay.example/'],
      ['https://relay.example/', 'https://relay.example/'],
      Array.from({ length: 5 }, (_, i) => `https://r${String(i)}.example/`),
      'https://relay.example/',
    ]) {
      const parsed = parseStoredSettings({
        v: 1,
        settings: { theme: 'dark', nfx: { ...nfx, irohRelays } },
      });
      expect(parsed?.settings, JSON.stringify(irohRelays)).toEqual({
        ...DEFAULT_SETTINGS,
        theme: 'dark',
        nfx: { ...DEFAULT_NFX, enabled: false },
      });
    }
  });

  it('contracts v14: stored `trackers` round-trip; a bad one drops `nfx` alone; none by default', async () => {
    expect(DEFAULT_NFX.trackers).toBeUndefined();
    const nfx: NfxSettings = {
      ...DEFAULT_NFX,
      trackers: ['wss://tracker.example/announce', 'ws://127.0.0.1:8000'] as TrackerUrl[],
    };
    expect(parseStoredSettings({ v: 1, settings: { theme: 'dark', nfx } })?.settings).toEqual({
      ...DEFAULT_SETTINGS,
      theme: 'dark',
      nfx,
    });
    const s = new SettingsStore(dir, memoryLogger());
    await s.load();
    await s.update({ nfx });
    const reread = new SettingsStore(dir, memoryLogger());
    expect((await reread.load()).nfx).toEqual(nfx);
    // Not the player's form, cleartext off this computer, a query, a duplicate, more than 4.
    for (const trackers of [
      ['WSS://tracker.example'],
      ['ws://tracker.example'],
      ['wss://tracker.example?x=1'],
      ['wss://t.example', 'wss://t.example'],
      Array.from({ length: 5 }, (_, i) => `wss://t${String(i)}.example`),
      'wss://tracker.example',
    ]) {
      const parsed = parseStoredSettings({
        v: 1,
        settings: { theme: 'dark', nfx: { ...nfx, trackers } },
      });
      expect(parsed?.settings, JSON.stringify(trackers)).toEqual({
        ...DEFAULT_SETTINGS,
        theme: 'dark',
        nfx: { ...DEFAULT_NFX, enabled: false },
      });
    }
  });

  it('refuses an invalid patch and keeps the old settings (nothing written)', async () => {
    const s = new SettingsStore(dir, memoryLogger());
    await s.load();
    await expect(
      s.update({ relays: [{ url: 'ws://insecure' as RelayUrl, read: true, write: true }] }),
    ).rejects.toThrow(TypeError);
    await expect(s.update({ prefetchSeconds: -1 })).rejects.toThrow(TypeError);
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    expect(await readdir(dir)).toEqual([]);
  });

  it('serialises concurrent saves and leaves no temp files behind', async () => {
    const s = new SettingsStore(dir, memoryLogger());
    await s.load();
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.update({ prefetchSeconds: i + 1 })));
    expect(await readdir(dir)).toEqual([SETTINGS_FILE]);
    const reread = new SettingsStore(dir, memoryLogger());
    expect((await reread.load()).prefetchSeconds).toBe(s.get().prefetchSeconds);
  });

  it('SE-4: accepts the v4 "off" sentinel belowSats: 0', async () => {
    const s = new SettingsStore(dir, memoryLogger());
    await s.load();
    const next = await s.update({ autoTopUp: { belowSats: 0 as Sats, fromMint: MINT } });
    expect(next.autoTopUp).toEqual({ belowSats: 0, fromMint: MINT });
  });
});

describe('Settings.autoTopUp.amountSats (issue #2)', () => {
  it('accepts a whole number of sats in 1 … AUTO_TOP_UP_MAX_SATS, and absence (= the max)', async () => {
    const s = new SettingsStore(dir, memoryLogger());
    await s.load();
    for (const amountSats of [1, 2_500, 10_000]) {
      const next = await s.update({
        autoTopUp: { belowSats: 500 as Sats, fromMint: MINT, amountSats: amountSats as Sats },
      });
      expect(next.autoTopUp).toEqual({ belowSats: 500, fromMint: MINT, amountSats });
    }
    const reread = new SettingsStore(dir, memoryLogger());
    expect((await reread.load()).autoTopUp).toEqual({
      belowSats: 500,
      fromMint: MINT,
      amountSats: 10_000,
    });
    expect(
      (await s.update({ autoTopUp: { belowSats: 500 as Sats, fromMint: MINT } })).autoTopUp,
    ).toEqual({ belowSats: 500, fromMint: MINT });
  });

  it('refuses anything else — in a patch and in the stored file (which then reads as the defaults: off)', async () => {
    const s = new SettingsStore(dir, memoryLogger());
    await s.load();
    const bad: unknown[] = [0, -1, 10_001, 1.5, '100', null, Number.NaN, 2 ** 53];
    for (const amountSats of bad) {
      await expect(
        s.update({
          autoTopUp: { belowSats: 500 as Sats, fromMint: MINT, amountSats: amountSats as Sats },
        }),
        String(amountSats),
      ).rejects.toThrow(TypeError);
      expect(
        parseStoredSettings({
          v: 1,
          settings: { autoTopUp: { belowSats: 500, fromMint: MINT, amountSats } },
        }),
        String(amountSats),
      ).toBeNull();
    }
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    await writeFile(
      join(dir, SETTINGS_FILE),
      JSON.stringify({
        v: 1,
        settings: { autoTopUp: { belowSats: 1, fromMint: MINT, amountSats: 1e6 } },
      }),
    );
    expect((await new SettingsStore(dir, memoryLogger()).load()).autoTopUp).toBeUndefined();
  });
});

describe('autoTopUpDue (SE-4, v5, security review F4)', () => {
  const FUNDING = 'https://funding.example' as MintUrl;
  /** The user's own mints are MINT and FUNDING; top-ups are funded from FUNDING. */
  const withTopUp = (belowSats: number, fromMint = FUNDING): Settings => ({
    ...DEFAULT_SETTINGS,
    defaultMints: [MINT, FUNDING],
    autoTopUp: { belowSats: belowSats as Sats, fromMint },
  });

  it('is false whenever belowSats <= 0 — the "off" sentinel — whatever the balance', () => {
    for (const below of [0, -1, -1_000_000, Number.NaN, Number.NEGATIVE_INFINITY])
      for (const balance of [0, 1, 100])
        expect(autoTopUpDue(withTopUp(below), MINT, balance as Sats), `${below}/${balance}`).toBe(
          false,
        );
  });

  it('is false with no autoTopUp at all', () => {
    expect(autoTopUpDue(DEFAULT_SETTINGS, MINT, 0 as Sats)).toBe(false);
  });

  // Corrected in the Stage 2 review fixes: this test used to assert "only for fromMint", which
  // is the opposite of the v5 contract text (network-adapter.ts `Settings.autoTopUp`, ADR 0010
  // item 5): the balance compared is the PAYING mint's, the top-up is funded FROM `fromMint`,
  // and it never fires for `fromMint` itself.
  it('triggers strictly below the threshold (never <=) for the paying mint, never for fromMint itself', () => {
    expect(autoTopUpDue(withTopUp(100), MINT, 99 as Sats)).toBe(true);
    expect(autoTopUpDue(withTopUp(100), MINT, 0 as Sats)).toBe(true);
    expect(autoTopUpDue(withTopUp(100), MINT, 100 as Sats)).toBe(false);
    expect(autoTopUpDue(withTopUp(100), MINT, 101 as Sats)).toBe(false);
    expect(autoTopUpDue(withTopUp(100), FUNDING, 0 as Sats)).toBe(false);
  });

  it('F4: never tops up a mint that is not on the user’s own list (e.g. one a manifest named)', () => {
    expect(autoTopUpDue(withTopUp(100), OTHER, 0 as Sats)).toBe(false);
    expect(
      autoTopUpDue({ ...withTopUp(100), defaultMints: [MINT, FUNDING, OTHER] }, OTHER, 0 as Sats),
    ).toBe(true);
  });
});

describe('desktop.json', () => {
  it('reads the ffmpeg paths; missing or corrupt → {}', async () => {
    expect(await loadDesktopConfig(dir, memoryLogger())).toEqual({});
    await writeFile(
      join(dir, 'desktop.json'),
      JSON.stringify({ v: 1, ffmpeg: { ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe' } }),
    );
    expect(await loadDesktopConfig(dir, memoryLogger())).toEqual({
      ffmpeg: { ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe' },
    });
    await writeFile(
      join(dir, 'desktop.json'),
      JSON.stringify({ v: 1, ffmpeg: { ffmpeg: 'ffmpeg', ffprobe: '/usr/bin/ffprobe' } }),
    );
    expect(await loadDesktopConfig(dir, memoryLogger())).toEqual({});
  });
});
