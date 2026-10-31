/** Pure helpers behind the Settings forms: URL validation, units, bounds, error copy. */
import { describe, expect, it } from 'vitest';
import {
  AUTO_TOP_UP_MAX_SATS as CORE_TOP_UP_MAX,
  AUTO_TOP_UP_MAX_SATS_PER_DAY,
  MAX_NFX_SCOPED_RELAYS,
  NFX_NETWORKS,
} from '@sovit/core';
import {
  AUTO_TOP_UP_AMOUNT_MAX_SATS,
  AUTO_TOP_UP_PER_DAY_SATS,
  GIB,
  autoTopUpAmount,
  autoTopUpEnabled,
  clampPrefetch,
  describeLoadError,
  describeSaveError,
  formatBytes,
  gbFieldValue,
  parseDiskCapGb,
  parseThresholdSats,
  parseTopUpAmountSats,
  signerTitle,
  validateMintUrl,
  UI_MAX_NFX_SCOPED_RELAYS,
  UI_NFX_NETWORK,
  validateRelayUrl,
  validateScopedRelayUrl,
} from '../model.js';

describe('validateScopedRelayUrl (contracts v10)', () => {
  it('mirrors core: one network, the same relay cap', () => {
    expect(NFX_NETWORKS).toEqual([UI_NFX_NETWORK]);
    expect(UI_MAX_NFX_SCOPED_RELAYS).toBe(MAX_NFX_SCOPED_RELAYS);
  });

  it('accepts wss anywhere and ws to this computer only, normalised', () => {
    expect(validateScopedRelayUrl(' wss://Scoped.Example/ ')).toEqual({
      ok: true,
      value: 'wss://scoped.example',
    });
    for (const [raw, value] of [
      ['ws://127.0.0.1:7777', 'ws://127.0.0.1:7777'],
      ['ws://[::1]:7777/', 'ws://[::1]:7777'],
      ['WS://LocalHost:7777', 'ws://localhost:7777'],
    ] as const) {
      expect(validateScopedRelayUrl(raw)).toEqual({ ok: true, value });
    }
  });

  it('refuses cleartext relays off this computer, and duplicates', () => {
    for (const raw of ['ws://scoped.example', 'ws://192.168.1.10:7777', 'ws://127.0.0.1?x=1']) {
      expect(validateScopedRelayUrl(raw).ok, raw).toBe(false);
    }
    expect(validateScopedRelayUrl('ws://127.0.0.1:7777', ['ws://127.0.0.1:7777']).ok).toBe(false);
    expect(validateScopedRelayUrl('wss://a.example', ['wss://a.example']).ok).toBe(false);
    expect(validateScopedRelayUrl('https://a.example').ok).toBe(false);
    expect(validateScopedRelayUrl('').ok).toBe(false);
  });
});

describe('validateRelayUrl', () => {
  it('accepts wss:// and normalises host case, default port and trailing slash', () => {
    expect(validateRelayUrl('  wss://Relay.Example/  ')).toEqual({
      ok: true,
      value: 'wss://relay.example',
    });
    expect(validateRelayUrl('wss://relay.example:443/')).toEqual({
      ok: true,
      value: 'wss://relay.example',
    });
    expect(validateRelayUrl('wss://relay.example:7447/Nostr/')).toEqual({
      ok: true,
      value: 'wss://relay.example:7447/Nostr',
    });
  });

  it('rejects everything that is not wss:// with a specific message', () => {
    const err = (s: string): string => {
      const r = validateRelayUrl(s);
      if (r.ok) throw new Error(`expected ${s} to be rejected`);
      return r.error;
    };
    expect(err('')).toMatch(/Enter a relay address/);
    expect(err('ws://relay.example')).toMatch(/unencrypted ws:\/\/ relays are not allowed/);
    expect(err('https://relay.example')).toBe('Relays use wss://, not https://');
    expect(err('javascript:alert(1)')).toBe('Relays use wss://, not javascript://');
    expect(err('relay.example')).toMatch(/start with wss:\/\//);
    expect(err('wss://relay .example')).toMatch(/spaces/);
    expect(err('wss://user:pw@relay.example')).toMatch(/user name or password/);
    expect(err('wss://relay.example/#x')).toMatch(/no # part/);
    expect(err('wss://')).toMatch(/not a valid relay address/);
    expect(err(`wss://${'a'.repeat(600)}.example`)).toMatch(/too long/);
  });

  it('rejects duplicates after normalisation', () => {
    const r = validateRelayUrl('WSS://relay.example/', ['wss://relay.example']);
    expect(r).toEqual({ ok: false, error: 'That relay is already in your list.' });
  });

  it('encodes internationalised hosts (no look-alike Unicode in the list)', () => {
    const r = validateRelayUrl('wss://rеlay.example'); // Cyrillic "е"
    expect(r.ok && r.value.startsWith('wss://xn--')).toBe(true);
  });
});

describe('validateMintUrl', () => {
  it('accepts https:// and normalises to the contract form (no trailing slash)', () => {
    expect(validateMintUrl('https://Mint.Example/')).toEqual({
      ok: true,
      value: 'https://mint.example',
    });
    expect(validateMintUrl('https://mint.example/Bitcoin/')).toEqual({
      ok: true,
      value: 'https://mint.example/Bitcoin',
    });
  });

  it('rejects http://, other schemes, credentials, query/fragment and duplicates', () => {
    const err = (s: string, existing: readonly string[] = []): string => {
      const r = validateMintUrl(s, existing);
      if (r.ok) throw new Error(`expected ${s} to be rejected`);
      return r.error;
    };
    expect(err('http://mint.example')).toMatch(/expose your ecash/);
    expect(err('wss://mint.example')).toBe('Mints use https://, not wss://');
    expect(err('mint.example')).toMatch(/start with https:\/\//);
    expect(err('https://a:b@mint.example')).toMatch(/user name or password/);
    expect(err('https://mint.example/?x=1')).toMatch(/no \? or # part/);
    expect(err('https://mint.example/', ['https://mint.example'])).toMatch(/already a default/);
    expect(err('   ')).toMatch(/Enter a mint address/);
  });
});

describe('units and bounds', () => {
  it('formats bytes as GB (2^30) / MB', () => {
    expect(formatBytes(50 * GIB)).toBe('50 GB');
    expect(formatBytes(1.25 * GIB)).toBe('1.3 GB');
    expect(formatBytes(300 * 1024 ** 2)).toBe('300 MB');
    expect(formatBytes(0)).toBe('0 GB');
    expect(formatBytes(250 * GIB)).toBe('250 GB');
    expect(gbFieldValue(50 * GIB)).toBe('50');
    expect(gbFieldValue(12.5 * GIB)).toBe('12.5');
  });

  it('parses the disk cap field', () => {
    expect(parseDiskCapGb(' 20 ')).toEqual({ ok: true, value: 20 });
    expect(parseDiskCapGb('12.34')).toEqual({ ok: true, value: 12.3 });
    expect(parseDiskCapGb('0').ok).toBe(false);
    expect(parseDiskCapGb('10001').ok).toBe(false);
    expect(parseDiskCapGb('abc').ok).toBe(false);
    expect(parseDiskCapGb('').ok).toBe(false);
  });

  it('parses whole-sat thresholds', () => {
    expect(parseThresholdSats('2,500')).toEqual({ ok: true, value: 2500 });
    expect(parseThresholdSats('1.5').ok).toBe(false);
    expect(parseThresholdSats('0').ok).toBe(false);
    expect(parseThresholdSats('-4').ok).toBe(false);
    expect(parseThresholdSats('10000001').ok).toBe(false);
  });

  it('clamps prefetch to the slider steps', () => {
    expect(clampPrefetch(31)).toBe(30);
    expect(clampPrefetch(0)).toBe(5);
    expect(clampPrefetch(900)).toBe(120);
    expect(clampPrefetch(Number.NaN)).toBe(30);
  });

  it('reads a zero auto top-up threshold as off', () => {
    expect(autoTopUpEnabled(undefined)).toBe(false);
    expect(autoTopUpEnabled({ belowSats: 0 })).toBe(false);
    expect(autoTopUpEnabled({ belowSats: 1 })).toBe(true);
  });

  it('issue #2: the amount per top-up — the caps are core’s, absent = the max, 1 … 10,000 whole sats', () => {
    expect(AUTO_TOP_UP_AMOUNT_MAX_SATS).toBe(CORE_TOP_UP_MAX);
    expect(AUTO_TOP_UP_PER_DAY_SATS).toBe(AUTO_TOP_UP_MAX_SATS_PER_DAY);
    expect(autoTopUpAmount(undefined)).toBe(10_000);
    expect(autoTopUpAmount({})).toBe(10_000);
    expect(autoTopUpAmount({ amountSats: 2_500 })).toBe(2_500);
    expect(autoTopUpAmount({ amountSats: 99_999 })).toBe(10_000);
    expect(parseTopUpAmountSats(' 2,500 ')).toEqual({ ok: true, value: 2_500 });
    expect(parseTopUpAmountSats('10000')).toEqual({ ok: true, value: 10_000 });
    for (const bad of ['', '0', '10001', '1.5', '-5', 'abc'])
      expect(parseTopUpAmountSats(bad).ok, bad).toBe(false);
    expect(parseTopUpAmountSats('20000')).toMatchObject({
      error: expect.stringContaining('10,000'),
    });
  });
});

describe('copy', () => {
  it('names signer kinds', () => {
    expect(signerTitle('nip07')).toBe('Browser extension (NIP-07)');
    expect(signerTitle('nip46')).toBe('Remote signer (NIP-46)');
    expect(signerTitle('local')).toBe('Local key (Local)');
  });

  it('maps load and save errors to human copy', () => {
    expect(describeLoadError(new Error('relay-down: no relays reachable'))).toMatchObject({
      title: 'Relay down',
      detail: 'relay-down: no relays reachable',
    });
    expect(describeLoadError('boom')).toMatchObject({
      title: 'Could not load your settings',
      detail: 'boom',
    });
    expect(describeLoadError(undefined).detail).toBeUndefined();
    expect(describeSaveError(new Error('relay-down'))).toMatch(/change was undone/);
    expect(describeSaveError(undefined)).toMatch(/change was undone/);
  });
});
