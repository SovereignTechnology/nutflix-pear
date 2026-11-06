/**
 * Slice 5e-4: one session's fetchers across transports — iroh first, then HyperDHT (NFX-06 §6).
 * A file goes to the first that serves it, the others learn it, every reason is kept when none
 * does, and `close` reaches every fetcher.
 */
import { describe, expect, it } from 'vitest';

import { NfxFallbackFetcher } from '../nfx/fallback-fetcher.js';
import type { NfxFetcher } from '../nfx/watch.js';
import { NfxFetchError } from '../nfx/watch.js';

interface Probe extends NfxFetcher {
  readonly asked: string[];
  readonly learned: string[];
  closed: number;
}

function probe(serve: (sha: string) => Uint8Array | Error): Probe {
  const p: Probe = {
    asked: [],
    learned: [],
    closed: 0,
    fetch(sha) {
      p.asked.push(sha);
      const r = serve(sha);
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    },
    learn(sha) {
      p.learned.push(sha);
    },
    close() {
      p.closed++;
      return Promise.resolve();
    },
  };
  return p;
}

const BYTES = new Uint8Array([1, 2, 3]);

describe('slice 5e-4: NfxFallbackFetcher', () => {
  it('asks in order, and the others learn what one served', async () => {
    const iroh = probe((sha) => (sha === 'a' ? BYTES : new NfxFetchError(['unmapped'])));
    const dht = probe(() => BYTES);
    const f = new NfxFallbackFetcher([iroh, dht]);
    expect(await f.fetch('a', 3, true)).toBe(BYTES);
    expect(await f.fetch('b', 3, true)).toBe(BYTES);
    expect(iroh.asked).toEqual(['a', 'b']);
    expect(dht.asked).toEqual(['b']);
    expect(dht.learned).toEqual(['a']);
    expect(iroh.learned).toEqual(['b']);
  });

  it('keeps every reason when no fetcher serves the file', async () => {
    const f = new NfxFallbackFetcher([
      probe(() => new NfxFetchError(['iroh-off'])),
      probe(() => new Error('a bug')),
      probe(() => new NfxFetchError(['missing', 'unreachable'])),
    ]);
    await expect(f.fetch('a', 3, true)).rejects.toMatchObject({
      reasons: ['iroh-off', 'error', 'missing', 'unreachable'],
    });
  });

  it('learn and close reach every fetcher', async () => {
    const a = probe(() => BYTES);
    const b = probe(() => BYTES);
    const f = new NfxFallbackFetcher([a, b]);
    f.learn('x', BYTES);
    await f.close();
    expect([a.learned, b.learned, a.closed, b.closed]).toEqual([['x'], ['x'], 1, 1]);
  });
});
