import { afterEach, describe, expect, it, vi } from 'vitest';

import { givenRelays, nfxdRelayArgs } from './support/nfx-exit-kit.js';

const SCOPED = 'wss://relay.example';
const IROH_A = 'https://iroh.example/';
const IROH_B = 'https://iroh2.example:8443/';

/** Set the run's relay inputs the way the workflow's environment does. */
function given(env: Record<string, string>): ReturnType<typeof givenRelays> {
  vi.stubEnv('NFX_SCOPED_RELAYS', SCOPED);
  vi.stubEnv('NFX_IROH_RELAYS', `${IROH_A} ${IROH_B}`);
  vi.stubEnv('NFX_IROH_RELAY_CA', '');
  vi.stubEnv('NFX_RELAY_ONLY', '');
  vi.stubEnv('NFX_NOSTR_ONLY', '');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return givenRelays();
}

/** A Nostr-only run as the workflow passes it: the box ticked, the iroh relays cleared. */
const NOSTR_ONLY = { NFX_NOSTR_ONLY: 'true', NFX_IROH_RELAYS: '' };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('givenRelays: NFX_RELAY_ONLY', () => {
  it('is off when unset, empty or false', () => {
    expect(given({}).relayOnly).toBe(false);
    expect(given({ NFX_RELAY_ONLY: 'false' }).relayOnly).toBe(false);
  });

  it('is on for exactly true', () => {
    expect(given({ NFX_RELAY_ONLY: 'true' }).relayOnly).toBe(true);
  });

  it('refuses any other value', () => {
    for (const v of ['1', 'yes', 'TRUE', 'true false'])
      expect(() => given({ NFX_RELAY_ONLY: v }), v).toThrow(
        'NFX_RELAY_ONLY: must be true or false',
      );
  });

  it('fails loudly, naming both variables, when the iroh relays are missing', () => {
    expect(() => given({ NFX_RELAY_ONLY: 'true', NFX_IROH_RELAYS: '' })).toThrow(
      /NFX_RELAY_ONLY=true needs NFX_IROH_RELAYS.*--relay-only/,
    );
  });

  it('still demands the iroh relays when it is off', () => {
    expect(() => given({ NFX_IROH_RELAYS: '' })).toThrow(/NFX_IROH_RELAYS: at least one/);
  });
});

describe('givenRelays: NFX_NOSTR_ONLY', () => {
  it('is off when unset, empty or false, and then the iroh relays are still demanded', () => {
    expect(given({}).nostrOnly).toBe(false);
    expect(given({ NFX_NOSTR_ONLY: 'false' }).nostrOnly).toBe(false);
    expect(() => given({ NFX_NOSTR_ONLY: 'false', NFX_IROH_RELAYS: '' })).toThrow(
      /NFX_IROH_RELAYS: at least one.*NFX_NOSTR_ONLY=true/,
    );
  });

  it('takes zero iroh relays, and still the scoped ones', () => {
    const r = given(NOSTR_ONLY);
    expect(r.nostrOnly).toBe(true);
    expect(r.iroh).toEqual([]);
    expect(r.scoped).toEqual([SCOPED]);
    expect(r.relayOnly).toBe(false);
    expect(() => given({ ...NOSTR_ONLY, NFX_SCOPED_RELAYS: '' })).toThrow(
      'NFX_SCOPED_RELAYS: at least one',
    );
  });

  it('refuses iroh relays given anyway, valid or not', () => {
    expect(() => given({ NFX_NOSTR_ONLY: 'true' })).toThrow(
      'NFX_NOSTR_ONLY=true takes no NFX_IROH_RELAYS',
    );
    expect(() =>
      given({ NFX_NOSTR_ONLY: 'true', NFX_IROH_RELAYS: 'http://iroh.example/' }),
    ).toThrow('NFX_IROH_RELAYS: not a relay this run takes');
  });

  it('is never together with NFX_RELAY_ONLY, and takes no CA', () => {
    expect(() => given({ ...NOSTR_ONLY, NFX_RELAY_ONLY: 'true' })).toThrow(
      /NFX_NOSTR_ONLY=true and NFX_RELAY_ONLY=true: pick one/,
    );
    expect(() => given({ ...NOSTR_ONLY, NFX_IROH_RELAY_CA: '/tmp/relay-ca.pem' })).toThrow(
      'NFX_NOSTR_ONLY=true takes no NFX_IROH_RELAY_CA',
    );
  });

  it('refuses any other value', () => {
    for (const v of ['1', 'yes', 'TRUE', 'true false'])
      expect(() => given({ ...NOSTR_ONLY, NFX_NOSTR_ONLY: v }), v).toThrow(
        'NFX_NOSTR_ONLY: must be true or false',
      );
  });

  it('still refuses more than four iroh relays when it is off', () => {
    const five = [1, 2, 3, 4, 5].map((n) => `https://iroh${String(n)}.example/`).join(' ');
    expect(() => given({ NFX_IROH_RELAYS: five })).toThrow('NFX_IROH_RELAYS: at most 4 relays');
  });
});

describe('nfxdRelayArgs', () => {
  it('passes the scoped and iroh relays, and no --relay-only by default', () => {
    expect(nfxdRelayArgs(given({}))).toEqual([
      '--relay',
      SCOPED,
      '--iroh-relay',
      IROH_A,
      '--iroh-relay',
      IROH_B,
    ]);
  });

  it('adds --relay-only after the iroh relays it needs, and never a gossip flag', () => {
    const args = nfxdRelayArgs(given({ NFX_RELAY_ONLY: 'true' }));
    expect(args).toEqual([
      '--relay',
      SCOPED,
      '--iroh-relay',
      IROH_A,
      '--iroh-relay',
      IROH_B,
      '--relay-only',
    ]);
    expect(args.some((a) => a.startsWith('--gossip'))).toBe(false);
    expect(args.indexOf('--relay-only')).toBeGreaterThan(args.indexOf('--iroh-relay'));
  });

  it('keeps the private CA flag with --relay-only', () => {
    const args = nfxdRelayArgs(
      given({ NFX_RELAY_ONLY: 'true', NFX_IROH_RELAY_CA: '/tmp/relay-ca.pem' }),
    );
    expect(args).toContain('--iroh-relay-ca');
    expect(args).toContain('--relay-only');
  });

  it('refuses relay-only without an iroh relay, as nfxd does', () => {
    expect(() =>
      nfxdRelayArgs({ scoped: [], iroh: [], irohCa: null, relayOnly: true, nostrOnly: false }),
    ).toThrow('relay-only needs at least one iroh relay');
  });

  it('passes only the scoped relays for a Nostr-only run: no iroh flag at all', () => {
    expect(nfxdRelayArgs(given(NOSTR_ONLY))).toEqual(['--relay', SCOPED]);
  });

  it('refuses a Nostr-only run that carries an iroh relay, built by hand', () => {
    expect(() => nfxdRelayArgs({ ...given({}), nostrOnly: true })).toThrow(
      'nostr-only takes no iroh relay',
    );
  });
});
