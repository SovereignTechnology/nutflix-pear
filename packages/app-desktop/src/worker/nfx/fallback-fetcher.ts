/**
 * One play session's sources across transports (slice 5e-4): iroh first, then NFX-12's HyperDHT
 * (NFX-06 §6 tries iroh first). Each file is asked of each fetcher in order until one serves it;
 * the reasons of those that did not are kept together, so a failed open still says why.
 *
 * A file one fetcher served is handed to the others' `learn` (it was checked against its sha256
 * by the transport that fetched it): the iroh fetcher places a rendition's segments from its
 * playlist, whichever transport brought that playlist. `close` closes every fetcher.
 *
 * Pear #123 (ADR 0024): its stats are its fetchers' (each counts its own sources, which only it
 * can name), and so are its addresses, asked of one fetcher after another.
 */
import type { PlaySourceAddress, PlaySourceStat } from '@sovit/core';

import type { NfxFetcher, NfxFetcherStats } from './watch.js';
import { NfxFetchError } from './watch.js';

export class NfxFallbackFetcher implements NfxFetcher {
  private readonly fetchers: readonly NfxFetcher[];

  constructor(fetchers: readonly NfxFetcher[]) {
    this.fetchers = fetchers;
  }

  async fetch(sha: string, size: number, exact: boolean): Promise<Uint8Array> {
    const reasons: string[] = [];
    for (const f of this.fetchers) {
      let bytes: Uint8Array;
      try {
        bytes = await f.fetch(sha, size, exact);
      } catch (err) {
        // Anything but an `NfxFetchError` is that fetcher's own failure: the next is asked.
        reasons.push(...(err instanceof NfxFetchError ? err.reasons : ['error']));
        continue;
      }
      for (const other of this.fetchers) if (other !== f) other.learn?.(sha, bytes);
      return bytes;
    }
    throw new NfxFetchError(reasons);
  }

  learn(sha: string, bytes: Uint8Array): void {
    for (const f of this.fetchers) f.learn?.(sha, bytes);
  }

  async close(): Promise<void> {
    await Promise.all(this.fetchers.map((f) => f.close().catch(() => undefined)));
  }

  stats(): NfxFetcherStats {
    const sources: PlaySourceStat[] = [];
    let refused = 0;
    for (const f of this.fetchers) {
      const s = f.stats?.();
      if (s === undefined) continue;
      sources.push(...s.sources);
      refused += s.refused;
    }
    return { sources, refused };
  }

  async addresses(): Promise<readonly PlaySourceAddress[]> {
    const out: PlaySourceAddress[] = [];
    for (const f of this.fetchers) {
      if (f.addresses === undefined) continue;
      try {
        out.push(...(await f.addresses()));
      } catch {
        // That transport could not say; the others still can.
      }
    }
    return out;
  }
}
