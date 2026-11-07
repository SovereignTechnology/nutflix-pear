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
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return givenRelays();
}

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
    expect(() => nfxdRelayArgs({ scoped: [], iroh: [], irohCa: null, relayOnly: true })).toThrow(
      'relay-only needs at least one iroh relay',
    );
  });
});
