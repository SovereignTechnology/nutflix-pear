/**
 * NIP-11 relay information, as far as search needs it (ADR 0022): whether a relay lists NIP-50 in
 * its `supported_nips`. Search is sent only to the relays that do; the others are read with a
 * plain query and matched in the client (`searchNfxVideosRouted`), because a stock relay may
 * refuse a filter with `search` or ignore the field and answer as if it were not there.
 *
 * The HTTP request is the shell's (`RelayInfoFetch`): core has no DOM lib and opens no socket of
 * its own. Answers are cached per relay, a failure for less time than an answer. Anything that is
 * not a clear "yes" (a timeout, an error, a document without 50) counts as "no", which costs only
 * the server-side search, never a result.
 */
import type { RelayUrl } from '../contracts/index.js';

/**
 * Fetches a relay's NIP-11 document: a GET of `url` (the relay's `http(s)://` address, from
 * `nip11Url`) with `Accept: application/nostr+json`, no redirects followed, and a bounded body.
 * Resolves to the parsed JSON; rejects on any failure.
 */
export type RelayInfoFetch = (url: string) => Promise<unknown>;

/** The relay's NIP-11 address: `wss://` → `https://`, `ws://` → `http://`; `null` otherwise. */
export function nip11Url(relay: string): string | null {
  const m = /^(wss?):\/\/([^\s#]+)$/i.exec(relay);
  const scheme = m?.[1]?.toLowerCase();
  const rest = m?.[2];
  if (scheme === undefined || rest === undefined) return null;
  return `${scheme === 'wss' ? 'https' : 'http'}://${rest}`;
}

/** Whether a NIP-11 document lists NIP-50 (`supported_nips` holds the number 50). */
export function relayInfoSupportsSearch(doc: unknown): boolean {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return false;
  const nips = (doc as { readonly supported_nips?: unknown }).supported_nips;
  return Array.isArray(nips) && nips.some((n) => n === 50);
}

export interface RelaySearchSupportOptions {
  /** How long an answer is kept, ms. Default 1 hour. */
  readonly ttlMs?: number;
  /** How long a failure (no answer) is kept, ms. Default 5 minutes. */
  readonly failureTtlMs?: number;
  /** How long one probe may take, ms. Default 5 s. */
  readonly timeoutMs?: number;
  /** At most this many relays are remembered; the oldest is forgotten first. Default 256. */
  readonly maxEntries?: number;
  /** Milliseconds; tests pass a clock. */
  readonly now?: () => number;
}

interface Entry {
  readonly at: number;
  readonly ttl: number;
  readonly answer: Promise<boolean>;
}

/** Per-relay NIP-50 support from NIP-11, cached; concurrent asks for one relay share a probe. */
export class RelaySearchSupport {
  readonly #fetch: RelayInfoFetch;
  readonly #ttl: number;
  readonly #failureTtl: number;
  readonly #timeout: number;
  readonly #max: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, Entry>();

  constructor(fetchInfo: RelayInfoFetch, opts: RelaySearchSupportOptions = {}) {
    this.#fetch = fetchInfo;
    this.#ttl = opts.ttlMs ?? 60 * 60 * 1000;
    this.#failureTtl = opts.failureTtlMs ?? 5 * 60 * 1000;
    this.#timeout = opts.timeoutMs ?? 5_000;
    this.#max = opts.maxEntries ?? 256;
    this.#now = opts.now ?? Date.now;
  }

  /** Whether `relay` answers NIP-50 search. Never rejects. */
  supports = (relay: RelayUrl): Promise<boolean> => {
    const now = this.#now();
    const hit = this.#cache.get(relay);
    if (hit !== undefined && now - hit.at < hit.ttl) return hit.answer;
    const url = nip11Url(relay);
    if (url === null) return Promise.resolve(false);
    const answer = this.#probe(url).then(
      (yes) => {
        this.#remember(relay, { at: this.#now(), ttl: this.#ttl, answer: Promise.resolve(yes) });
        return yes;
      },
      () => {
        this.#remember(relay, {
          at: this.#now(),
          ttl: this.#failureTtl,
          answer: Promise.resolve(false),
        });
        return false;
      },
    );
    // While the probe runs, a second ask shares it.
    this.#remember(relay, { at: now, ttl: this.#timeout, answer });
    return answer;
  };

  async #probe(url: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('NIP-11 probe timed out'));
      }, this.#timeout);
    });
    try {
      return relayInfoSupportsSearch(await Promise.race([this.#fetch(url), timeout]));
    } finally {
      clearTimeout(timer);
    }
  }

  #remember(relay: string, e: Entry): void {
    this.#cache.delete(relay);
    this.#cache.set(relay, e);
    while (this.#cache.size > this.#max) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }
}
