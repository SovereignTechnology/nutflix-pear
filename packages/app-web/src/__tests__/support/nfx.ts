/**
 * Test-only: really signed NFX manifests (kind 38504) and beacons (kind 20464), per-relay fake
 * relays (core's `FakeRelayPool`, one per URL, every query on record), and a web adapter wired to
 * them, to fake NIP-11 documents and to the fake player. Secret keys exist only here, through
 * `nostr-tools`.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import type {
  NfxAddress,
  NostrEvent,
  NostrFilter,
  RelayUrl,
  Settings,
  UnixSeconds,
} from '@sovit/core';
import { beaconTags } from '@sovit/core/nfx';
import { FakeRelayPool, type PoolLike } from '@sovit/core/nostr';

import { WebNetworkAdapter } from '../../adapter/web-adapter.js';
import type { FetchFn } from '../../adapter/http.js';
import { DEFAULT_WEB_NFX, DEFAULT_WEB_SETTINGS } from '../../settings/defaults.js';
import { WebSettingsStore } from '../../settings/store.js';
import { FakeNfxPlayer } from './fake-nfx-lib.js';

export const NS = 'nfx:testnet:1';
export const T = 1_800_000_000 as UnixSeconds;
export const ROOT = 'ab'.repeat(32);

export class Key {
  readonly #sk = generateSecretKey();
  readonly pubkey = getPublicKey(this.#sk);

  sign(e: {
    readonly kind: number;
    readonly created_at: number;
    readonly tags: readonly (readonly string[])[];
    readonly content: string;
  }): NostrEvent {
    const signed = finalizeEvent(
      {
        kind: e.kind,
        created_at: e.created_at,
        tags: e.tags.map((t) => [...t]),
        content: e.content,
      },
      this.#sk,
    );
    return JSON.parse(JSON.stringify(signed)) as NostrEvent;
  }
}

export const addrOf = (creator: Key | string, videoId: string): NfxAddress =>
  `38504:${typeof creator === 'string' ? creator : creator.pubkey}:${NS}:${videoId}` as NfxAddress;

export function manifest(
  creator: Key,
  videoId: string,
  o: {
    readonly title?: string;
    readonly description?: string;
    readonly tags?: readonly string[];
    readonly createdAt?: number;
  } = {},
): NostrEvent {
  const at = o.createdAt ?? T - 3600;
  return creator.sign({
    kind: 38504,
    created_at: at,
    content: o.description ?? `About ${o.title ?? videoId}.`,
    tags: [
      ['d', `${NS}:${videoId}`],
      ['n', NS],
      ['title', o.title ?? videoId],
      ['published_at', String(at)],
      ['license', 'open'],
      ['root', ROOT],
      ['segs', '4'],
      ['duration', '61'],
      ...(o.tags ?? ['space']).map((t) => ['t', t]),
    ],
  });
}

export type RawEndpoint = Readonly<Record<string, unknown>>;

export const https = (url: string): RawEndpoint => ({ t: 'https', url });
export const webrtc = (...trackers: string[]): RawEndpoint => ({
  t: 'webrtc',
  tracker_urls: trackers,
});

/** A beacon by `seeder` for `addr` (an address string, any creator) naming `endpoints`. */
export function beacon(
  seeder: Key,
  addr: string,
  endpoints: readonly RawEndpoint[],
  o: { readonly createdAt?: number; readonly free?: boolean; readonly videoId?: string } = {},
): NostrEvent {
  const at = o.createdAt ?? T;
  const tags = beaconTags(addr, at, 120);
  if (!tags.ok) throw new Error(`bad test beacon: ${tags.error.reason}`);
  const free = o.free ?? true;
  const video = o.videoId ?? addr.split(':').slice(2).join(':');
  const content = JSON.stringify({
    v: 1,
    video,
    endpoints,
    chunks: 'all',
    price_hint: free ? 0 : 1,
    ...(free ? {} : { accepts_mints: ['https://mint.example'] }),
    free,
  });
  return seeder.sign({ kind: 20464, created_at: at, tags: tags.value, content });
}

export interface Relays {
  readonly pool: PoolLike;
  readonly of: (url: RelayUrl) => FakeRelayPool;
  readonly asked: { readonly relay: RelayUrl; readonly filter: NostrFilter }[];
}

/** One `FakeRelayPool` per relay URL; every query is recorded with the relay it went to. */
export function relays(urls: readonly string[]): Relays {
  const pools = new Map(urls.map((u) => [u as RelayUrl, new FakeRelayPool()]));
  const asked: { relay: RelayUrl; filter: NostrFilter }[] = [];
  const of = (url: RelayUrl): FakeRelayPool => {
    const p = pools.get(url);
    if (p === undefined) throw new Error(`no relay ${url}`);
    return p;
  };
  const pool: PoolLike = {
    async query(rs, filter) {
      const out: unknown[] = [];
      for (const r of rs) {
        asked.push({ relay: r, filter });
        out.push(...(await of(r).query([r], filter)));
      }
      return out;
    },
    subscribe(rs, filters, handlers) {
      const offs = rs.map((r) => of(r).subscribe([r], filters, { onevent: handlers.onevent }));
      handlers.oneose?.();
      return () => {
        for (const off of offs) off();
      };
    },
    publish: () => Promise.reject(new Error('the web client publishes nothing')),
    close: () => undefined,
  };
  return { pool, of, asked };
}

/** A NIP-11 server: `docs` by relay URL (`wss://…`); anything else is a 404. */
export function nip11(docs: Readonly<Record<string, unknown>>): {
  readonly fetch: FetchFn;
  readonly calls: { readonly url: string; readonly init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: FetchFn = (url, init) => {
    calls.push({ url, init });
    const relay = url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
    const doc = docs[relay];
    return Promise.resolve(
      doc === undefined
        ? new Response('not found', { status: 404 })
        : new Response(JSON.stringify(doc), {
            status: 200,
            headers: { 'content-type': 'application/nostr+json' },
          }),
    );
  };
  return { fetch: fetchFn, calls };
}

export const READ_A = 'wss://read-a.example' as RelayUrl;
export const READ_B = 'wss://read-b.example' as RelayUrl;
export const SCOPED = 'wss://scoped.example' as RelayUrl;

/** Settings with these read relays and this scoped relay (the defaults otherwise). */
export function settingsWith(read: readonly RelayUrl[], scoped: readonly RelayUrl[]): Settings {
  return {
    ...DEFAULT_WEB_SETTINGS,
    relays: read.map((url) => ({ url, read: true, write: true })),
    nfx: { ...DEFAULT_WEB_NFX, scopedRelays: [...scoped] },
  };
}

/** An in-memory store holding `s`. */
export function storeWith(s: Settings): WebSettingsStore {
  const m = new Map<string, string>();
  const store = new WebSettingsStore({
    storage: { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) },
  });
  const { relays: r, nfx, prefetchSeconds, hoverPreview, theme } = s;
  store.update({ relays: r, nfx, prefetchSeconds, hoverPreview, theme });
  return store;
}

export interface Rig {
  readonly adapter: WebNetworkAdapter;
  readonly player: FakeNfxPlayer;
  readonly relays: Relays;
  readonly store: WebSettingsStore;
  readonly fetches: { readonly url: string; readonly init: RequestInit }[];
  readonly blobs: Blob[];
  readonly revoked: string[];
}

export function rig(
  o: {
    readonly read?: readonly RelayUrl[];
    readonly scoped?: readonly RelayUrl[];
    readonly nip11?: Readonly<Record<string, unknown>>;
    readonly fetch?: FetchFn;
    readonly beaconWaitMs?: number;
    readonly settings?: WebSettingsStore;
  } = {},
): Rig {
  const read = o.read ?? [READ_A];
  const scoped = o.scoped ?? [SCOPED];
  const r = relays([...new Set([...read, ...scoped])]);
  const info = nip11(o.nip11 ?? {});
  const store = o.settings ?? storeWith(settingsWith(read, scoped));
  const player = new FakeNfxPlayer();
  const blobs: Blob[] = [];
  const revoked: string[] = [];
  const adapter = new WebNetworkAdapter({
    pool: r.pool,
    settings: store,
    player,
    wasmUrl: '/nfx/wasm/nfx_wasm_bg.wasm',
    fetch: o.fetch ?? info.fetch,
    createObjectURL: (b) => {
      blobs.push(b);
      return `blob:test/${String(blobs.length)}`;
    },
    revokeObjectURL: (u) => {
      revoked.push(u);
    },
    now: () => T,
    beaconWaitMs: o.beaconWaitMs ?? 200,
  });
  return { adapter, player, relays: r, store, fetches: info.calls, blobs, revoked };
}

/** Stores `ev` on every relay in `urls`. */
export function put(r: Relays, urls: readonly RelayUrl[], ...evs: NostrEvent[]): void {
  for (const url of urls) for (const ev of evs) r.of(url).store(ev);
}

export const tick = (ms = 0): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
