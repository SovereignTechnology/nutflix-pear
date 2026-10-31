/**
 * The NFX address this implementation gives a video it publishes both ways (ADR 0020 Phase 1):
 * the worker stores it under that address, and the host checks it before announcing it.
 */
import { describe, expect, it } from 'vitest';

import { LEGACY_VIDEO_ID_PREFIX, legacyVideoAddr } from '../legacy.js';
import { Namespace } from '../namespace.js';

const EVENT_ID = '0123456789abcdef'.repeat(4);

const ns = (s: string): Namespace => {
  const n = Namespace.parse(s);
  if (!n.ok) throw new Error(n.error.reason);
  return n.value;
};

describe('legacyVideoAddr', () => {
  it('is the namespace and nutflix- plus the first 32 hex of the legacy event id', () => {
    const a = legacyVideoAddr(ns('nfx:testnet:1'), EVENT_ID);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.value.toString()).toBe(
      `nfx:testnet:1:${LEGACY_VIDEO_ID_PREFIX}${EVENT_ID.slice(0, 32)}`,
    );
    const again = legacyVideoAddr(ns('nfx:testnet:1'), EVENT_ID);
    expect(again.ok && again.value.equals(a.value)).toBe(true);
    const other = legacyVideoAddr(ns('nfx:testnet:1'), 'f'.repeat(64));
    expect(other.ok && other.value.equals(a.value)).toBe(false);
    const mainnet = legacyVideoAddr(ns('nfx:mainnet:1'), EVENT_ID);
    expect(mainnet.ok && mainnet.value.equals(a.value)).toBe(false);
  });

  it('refuses anything but a 64-lowercase-hex event id', () => {
    for (const bad of ['', 'ab', EVENT_ID.toUpperCase(), `${EVENT_ID}0`, `${EVENT_ID.slice(1)}g`])
      expect(legacyVideoAddr(ns('nfx:testnet:1'), bad).ok, bad).toBe(false);
  });
});
