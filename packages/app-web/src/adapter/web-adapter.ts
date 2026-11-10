/**
 * The web client's `NetworkAdapter` (ADR 0022): `platform: 'web'`, NFX only, signed out, over
 * ordinary Nostr relays, video through nfx's player. What each call does here:
 *
 * | Calls | Here |
 * |---|---|
 * | `settings`, `updateSettings` | Web Storage (`WebSettingsStore`) |
 * | `feed` (`network`, `tags`, `author`), `search`, `nfxVideo` | core's `NfxCatalog`; search routed by NIP-11 |
 * | `playNfx` | beacons from core's `NfxBeaconWatch`, then nfx's player (`element` source) |
 * | `profile`, `image` | kind 0 from the read relays; images only by signed sha256, as `blob:` |
 * | `video`, `comments` | read-only NIP-71 reads (an NFX copy's thread) |
 * | `signer`, `me` | signed out |
 * | `feed` (`subscriptions`, `trending`, `shorts`), `related`, `stats`, `subscriptions`, `library` reads, `notifications`, `seeder.onStatus` | empty |
 * | `play`, `setProfilePicture`, `comment`, `react`, `unreact`, `nutzap`, `subscribe`, `unsubscribe`, `report`, `studio.*`, `seeder.status` and writes, `library` writes, `wallet.*` | reject `unsupported`; the shell hides them |
 *
 * `library.recordProgress` resolves and records nothing (signed out, there is no history to keep).
 * `seeder.status` rejects: a `SeederStatus` names the local seeder's key and the page has none, and
 * Channel reads a rejection as "no local seeder" (the web).
 *
 * Every relay read goes through core's `NostrClient` (signatures checked, T9) on a `PoolLike` the
 * page passes in (`SimplePoolAdapter`: the browser's WebSocket). A relay failure is `relay-down`.
 */
import type {
  CatalogVideo,
  Comment,
  FeedQuery,
  NetworkAdapter,
  NfxAddress,
  NfxPlaySession,
  NfxVideo,
  NostrEvent,
  NostrEventId,
  NostrPubkey,
  Notification,
  Page,
  PlaySession,
  Playlist,
  Profile,
  RelayUrl,
  SearchFilters,
  SeederStatus,
  Settings,
  SignerStatus,
  UnixSeconds,
  Unsubscribe,
  VideoManifest,
  VideoStats,
  Sats,
  Sha256Hex,
  Wallet,
} from '@sovit/core';
import {
  NFX_BEACON_WAIT_MS,
  NfxBeaconWatch,
  NfxCatalog,
  NostrClient,
  RelaySearchSupport,
  fetchComments,
  fetchProfile,
  fetchVideo,
  nowSeconds,
  toWire,
  type NfxBeaconWatchTimers,
  type PoolLike,
} from '@sovit/core/nostr';

import { WebAdapterError, fail, unsupported } from '../errors.js';
import { canonicalNfxAddress } from './address.js';
import type { NfxPlayerLib } from '../nfx-lib.js';
import { WEB_FALLBACK_ORIGIN, WEB_ICE_SERVERS, WEB_NFX_NETWORK } from '../settings/defaults.js';
import type { WebSettingsStore } from '../settings/store.js';
import { beaconEndpoints, playEndpoints } from './endpoints.js';
import type { FetchFn } from './http.js';
import { WebImages } from './images.js';
import { browserRelayInfoFetch } from './relay-info.js';
import { WebNfxSession, levelOf } from './session.js';
import { WebWallet } from './wallet.js';

/** Page size of a comment thread (the desktop app's). */
export const WEB_COMMENTS_PAGE = 20;
/** How long one relay query may wait, ms (nfx's player waits as long). */
export const WEB_RELAY_WAIT_MS = 8_000;
/** The largest page a caller may ask for (the desktop's `LIMITS.maxPage`). */
export const WEB_MAX_PAGE = 200;
/** A search text's or cursor's length cap (the desktop's `LIMITS.maxString`). */
export const WEB_MAX_TEXT = 4096;

export interface WebAdapterOptions {
  /** The relay pool: `SimplePoolAdapter` (the browser's WebSocket) in the page. */
  readonly pool: PoolLike;
  readonly settings: WebSettingsStore;
  /** nfx's player library (M4 wires the pinned one; tests pass a fake). */
  readonly player: NfxPlayerLib;
  /** Where the player's WASM is served; absent = the library's default. */
  readonly wasmUrl?: string | undefined;
  /** The page's `fetch`, for NIP-11 documents and images. */
  readonly fetch: FetchFn;
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  /** Unix seconds; tests pass a clock. */
  readonly now?: (() => UnixSeconds) | undefined;
  /** The beacon watch's timers; default the browser's. */
  readonly timers?: NfxBeaconWatchTimers | undefined;
  /** How long a play waits for a usable beacon, ms (default one republish interval). */
  readonly beaconWaitMs?: number | undefined;
  /** Per-query relay wait, ms. */
  readonly maxWaitMs?: number | undefined;
}

const SIGNED_OUT: SignerStatus = Object.freeze({
  kind: 'nip07',
  pubkey: null,
  locked: false,
  supportsSignSecret: false,
});

const EMPTY_STATS: VideoStats = Object.freeze({
  paidViews: 0,
  satsToCreator: 0 as Sats,
  reactions: 0,
  likes: 0,
  dislikes: 0,
  comments: 0,
});

/** Arguments are checked as `unknown`: the screens are typed, but nothing here relies on it. */
function isHex64(x: unknown): x is string {
  return typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
}

function isText(x: unknown): x is string {
  return typeof x === 'string' && x.length <= WEB_MAX_TEXT;
}

function checkPage(cursor: unknown, limit: unknown): void {
  if (cursor !== undefined && !isText(cursor)) fail('invalid-argument', 'not a cursor');
  if (
    limit !== undefined &&
    !(
      typeof limit === 'number' &&
      Number.isSafeInteger(limit) &&
      limit >= 1 &&
      limit <= WEB_MAX_PAGE
    )
  ) {
    fail('invalid-argument', 'not a page size');
  }
}

export class WebNetworkAdapter implements NetworkAdapter {
  readonly platform = 'web' as const;
  readonly wallet: Wallet = new WebWallet();

  readonly #o: WebAdapterOptions;
  readonly #now: () => UnixSeconds;
  readonly #catalog: NfxCatalog;
  readonly #beacons: NfxBeaconWatch;
  readonly #images: WebImages;
  readonly #sessions = new Set<WebNfxSession>();
  #client: { readonly relays: Settings['relays']; readonly client: NostrClient } | null = null;
  #player: Promise<NfxPlayerLib> | null = null;

  constructor(o: WebAdapterOptions) {
    this.#o = o;
    this.#now = o.now ?? nowSeconds;
    const search = new RelaySearchSupport(browserRelayInfoFetch(o.fetch));
    this.#catalog = new NfxCatalog(
      () => this.#nostr(),
      WEB_NFX_NETWORK,
      () => this.#settings().nfx?.scopedRelays ?? [],
      { searchSupport: search.supports },
    );
    this.#beacons = new NfxBeaconWatch({
      subscribe: (filter, relays, onEvent) =>
        this.#nostr().subscribe([filter], onEvent, { relays }),
      now: () => this.#now(),
      timers: o.timers,
    });
    this.#images = new WebImages({
      fetch: o.fetch,
      createObjectURL: o.createObjectURL,
      revokeObjectURL: o.revokeObjectURL,
    });
  }

  // ---- plumbing ----------------------------------------------------------------------------

  #settings(): Settings {
    return this.#o.settings.get();
  }

  /** The read client for the current relays (rebuilt when they change). No signer, ever. */
  #nostr(): NostrClient {
    const relays = this.#settings().relays;
    const held = this.#client;
    if (held?.relays === relays) return held.client;
    const client = new NostrClient({
      pool: this.#o.pool,
      relays,
      now: this.#now,
      maxWaitMs: this.#o.maxWaitMs ?? WEB_RELAY_WAIT_MS,
    });
    this.#client = { relays, client };
    return client;
  }

  /** The relays beacons are read from: the scoped relays, or the read relays when there are none. */
  #beaconRelays(): readonly RelayUrl[] {
    const scoped = this.#settings().nfx?.scopedRelays ?? [];
    return scoped.length > 0 ? scoped : this.#nostr().readRelays;
  }

  /** A relay read: `relay-down` when there is no relay to ask or none answered. */
  async #read<T>(fn: () => Promise<T>): Promise<T> {
    const s = this.#settings();
    if (this.#nostr().readRelays.length === 0 && (s.nfx?.scopedRelays.length ?? 0) === 0) {
      fail('relay-down', 'no relays configured');
    }
    try {
      return await fn();
    } catch (e) {
      if (e instanceof WebAdapterError) throw e;
      throw new WebAdapterError('relay-down', 'relay request failed');
    }
  }

  /** nfx's player, `init` once for the page; a failed `init` is tried again on the next play. */
  #playerReady(): Promise<NfxPlayerLib> {
    if (this.#player === null) {
      const lib = this.#o.player;
      const wasmUrl = this.#o.wasmUrl;
      const ready = lib.init(wasmUrl === undefined ? {} : { wasmUrl }).then(() => lib);
      ready.catch(() => {
        if (this.#player === ready) this.#player = null;
      });
      this.#player = ready;
    }
    return this.#player;
  }

  // ---- identity: signed out (NIP-07 comes after v1) -----------------------------------------

  signer(): Promise<SignerStatus> {
    return Promise.resolve(SIGNED_OUT);
  }

  me(): Promise<NostrPubkey | null> {
    return Promise.resolve(null);
  }

  async profile(pubkey: NostrPubkey): Promise<Profile | null> {
    if (!isHex64(pubkey)) fail('invalid-argument', 'not a pubkey');
    // No NIP-05 lookup: it would make the page fetch a URL a relay event names.
    return this.#read(() => fetchProfile(this.#nostr(), pubkey));
  }

  setProfilePicture(): Promise<Profile> {
    return unsupported('setting a profile picture');
  }

  // ---- catalogue ---------------------------------------------------------------------------

  async feed(q: FeedQuery): Promise<Page<CatalogVideo>> {
    checkPage(q.cursor, q.limit);
    switch (q.source) {
      case 'network':
      case 'tags':
      case 'author':
        if (q.author !== undefined && !isHex64(q.author)) fail('invalid-argument', 'not a pubkey');
        return this.#read(() => this.#catalog.feed(q, null));
      case 'subscriptions':
      case 'trending':
      case 'shorts':
        // Signed out, and no NIP-71 listing: nothing to show.
        return { items: [] };
      default:
        return fail('invalid-argument', 'not a feed');
    }
  }

  async video(id: NostrEventId): Promise<VideoManifest | null> {
    if (!isHex64(id)) return null;
    return this.#read(() => fetchVideo(this.#nostr(), id));
  }

  /** The video, and its live beacons read from now on, so Play usually finds a seeder at once. */
  async nfxVideo(addr: NfxAddress): Promise<NfxVideo | null> {
    const a = canonicalNfxAddress(addr);
    if (a === null) return null;
    const video = await this.#read(() => this.#catalog.video(a));
    if (video !== null) this.#beacons.watch(video, this.#beaconRelays());
    return video;
  }

  async playNfx(addr: NfxAddress, rendition?: string): Promise<NfxPlaySession> {
    const a = canonicalNfxAddress(addr);
    if (a === null) fail('invalid-argument', 'not an NFX address on this network');
    const level = rendition === undefined ? undefined : levelOf(rendition);
    if (level === null) fail('invalid-argument', 'no such rendition');
    const video = await this.#read(() => this.#catalog.video(a));
    if (video === null) fail('not-found', 'no such free NFX video');
    const now = (): number => this.#now();
    // Live beacons (NFX-04: never stored): wait until a seeder names an origin or a tracker this
    // page can use, at most one republish interval, then take what came.
    const events: readonly NostrEvent[] = await this.#beacons.wait(
      video,
      this.#beaconRelays(),
      (evs) => beaconEndpoints(video, evs, now()).reachable > 0,
      this.#o.beaconWaitMs ?? NFX_BEACON_WAIT_MS,
    );
    const found = beaconEndpoints(video, events, now());
    if (found.seeders === 0) fail('no-seeders', 'nobody seeding this NFX video is online');
    const { origins, trackers } = playEndpoints(
      found,
      this.#settings().nfx?.trackers ?? [],
      WEB_FALLBACK_ORIGIN,
    );
    const session = new WebNfxSession({
      videoId: a,
      manifestJson: JSON.stringify(toWire(video.event)),
      origins,
      trackers,
      iceServers: WEB_ICE_SERVERS,
      level,
      player: () => this.#playerReady(),
      onClose: (s) => {
        this.#sessions.delete(s);
      },
    });
    this.#sessions.add(session);
    return session;
  }

  play(): Promise<PlaySession> {
    return unsupported('playing a NIP-71 video');
  }

  stats(): Promise<VideoStats> {
    return Promise.resolve(EMPTY_STATS);
  }

  related(): Promise<readonly VideoManifest[]> {
    return Promise.resolve([]);
  }

  async search(q: {
    readonly text: string;
    readonly cursor?: string;
    readonly filters?: SearchFilters;
  }): Promise<Page<CatalogVideo>> {
    if (!isText(q.text)) fail('invalid-argument', 'not a search');
    checkPage(q.cursor, undefined);
    return this.#read(() => this.#catalog.search(q));
  }

  image(url: string, sha256?: Sha256Hex, size?: number): Promise<string> {
    return this.#images.image(url, sha256, size);
  }

  // ---- social: read-only ---------------------------------------------------------------------

  async comments(
    videoId: NostrEventId,
    sort: 'new' | 'top',
    cursor?: string,
  ): Promise<Page<Comment>> {
    if (!isHex64(videoId)) fail('invalid-argument', 'not an event id');
    if (!(['new', 'top'] as readonly unknown[]).includes(sort))
      fail('invalid-argument', 'not a sort');
    checkPage(cursor, undefined);
    return this.#read(() =>
      fetchComments(this.#nostr(), videoId, { sort, cursor, limit: WEB_COMMENTS_PAGE }),
    );
  }

  comment(): Promise<Comment> {
    return unsupported('commenting');
  }

  react(): Promise<void> {
    return unsupported('reacting');
  }

  unreact(): Promise<void> {
    return unsupported('reacting');
  }

  nutzap(): Promise<void> {
    return unsupported('zapping');
  }

  subscribe(): Promise<void> {
    return unsupported('subscribing');
  }

  unsubscribe(): Promise<void> {
    return unsupported('subscribing');
  }

  subscriptions(): Promise<readonly NostrPubkey[]> {
    return Promise.resolve([]);
  }

  report(): Promise<void> {
    return unsupported('reporting');
  }

  readonly library: NetworkAdapter['library'] = {
    history: () => Promise.resolve({ items: [] }),
    recordProgress: () => Promise.resolve(),
    watchLater: () => Promise.resolve([]),
    setWatchLater: () => unsupported('Watch later'),
    playlists: () => Promise.resolve([] as readonly Playlist[]),
    savePlaylist: () => unsupported('saving a playlist'),
    liked: () => Promise.resolve([]),
  };

  readonly studio: NetworkAdapter['studio'] = {
    probe: () => unsupported('uploading'),
    upload: () => unsupported('uploading'),
    myVideos: () => unsupported('Studio'),
    analytics: () => unsupported('Studio'),
  };

  readonly seeder: NetworkAdapter['seeder'] = {
    status: (): Promise<SeederStatus> => unsupported('seeding'),
    setEnabled: () => unsupported('seeding'),
    melt: () => unsupported('seeding'),
    unban: () => unsupported('seeding'),
    onStatus: (): Unsubscribe => () => undefined,
  };

  // ---- settings ------------------------------------------------------------------------------

  settings(): Promise<Settings> {
    return Promise.resolve(this.#settings());
  }

  updateSettings(patch: Partial<Settings>): Promise<Settings> {
    try {
      return Promise.resolve(this.#o.settings.update(patch));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  notifications(_cb: (n: Notification) => void): Unsubscribe {
    return () => undefined;
  }

  // ---- the page --------------------------------------------------------------------------------

  /** The plays open now. */
  get openSessions(): number {
    return this.#sessions.size;
  }

  /** The page is going: every play closes, every beacon subscription too, every image URL. */
  async close(): Promise<void> {
    await Promise.all([...this.#sessions].map((s) => s.close()));
    this.#beacons.close();
    this.#images.clear();
  }
}
