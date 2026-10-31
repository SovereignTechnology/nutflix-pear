/**
 * `DesktopNetworkAdapter` — the real contracts-v4 `NetworkAdapter` of the desktop shell, running
 * in the host `utilityProcess` (design §1 Host row, §6 L6-B).
 *
 *   reads     L1 (`NostrClient` over a `PoolLike`: `SimplePoolAdapter` in production) — every
 *             event through `verifyIncoming`; or `FixtureCatalog` behind `--dev-fixtures`
 *   writes    need a `Signer` (seam in `./identity.ts`); Stage 1 has none → `no-signer: …`
 *   unreact   NIP-09 kind-5 of the viewer's OWN kind-7 ids on the video, never a `-` (SE-5)
 *   play      worker `play.open` → a `HostPlaySession` (host-minted sid; the blob-server link
 *             goes to main as `media-link`, never into a result)
 *   money     `MockWallet` behind `--dev-mocks`, debited from the worker's `spend` events
 *             (an auto top-up is only logged there); with the user's real wallet an auto
 *             top-up EXECUTES behind its caps and first-funding confirm (issue #2,
 *             `./topup/auto-topup.ts`) — only from the payment path (a play opening here,
 *             a PAY in the money plane), never from a wallet balance event
 *   settings  atomic JSON in userData
 *   images    `./images/images.ts` (T16)
 *
 * The D3/D5 methods (`wallet.send/receive/p2pkPubkey/keyset`) exist here because the contract
 * has them, but nothing on the IPC path routes to them (`dispatch.ts` has no entry).
 */
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';

import type {
  CatalogVideo,
  Comment,
  FeedQuery,
  MintUrl,
  NetworkAdapter,
  NfxAddress,
  NfxPlaySession,
  NfxSettings,
  NfxVideo,
  Notification,
  NostrEventId,
  NostrPubkey,
  Page,
  Playlist,
  PlaySession,
  Profile,
  RelayUrl,
  Sats,
  SearchFilters,
  SeederStatus,
  Settings,
  Sha256Hex,
  SignerStatus,
  UnixSeconds,
  Unsubscribe,
  UploadInput,
  UploadProgress,
  VideoManifest,
  VideoStats,
  Wallet,
  WalletChangeEvent,
  WalletHistoryEntry,
} from '@sovit/core';
import { MAX_IMAGE_BYTES, NostrKind, manifest, nostr } from '@sovit/core';

import { toHex } from '../ipc/codec.js';
import { IpcError } from '../ipc/errors.js';
import type {
  FfmpegStatus,
  ImageMime,
  NfMediaImgUrl,
  RecoveryProgressWire,
  RecoveryStatusWire,
  TopUpHoldWire,
  UploadId,
} from '../ipc/protocol.js';
import { IMAGE_MIMES } from '../ipc/protocol.js';
import { rehydrate } from '../ipc/wiremap.js';
import type {
  NfxConfigureArgs,
  PublishDraft,
  ThumbnailHex,
  UploadMeta,
  WorkerEvent,
  WorkerMethodTable,
} from '../ipc/worker-protocol.js';
import type { CatalogSource, SearchQuery } from './catalog/catalog.js';
import { NostrCatalog } from './catalog/catalog.js';
import type { FixtureCatalog } from './catalog/fixture-catalog.js';
import { MergedCatalog } from './catalog/merged-catalog.js';
import { NfxCatalog } from './catalog/nfx-catalog.js';
import { fail, hostError } from './errors.js';
import type { IdentityProvider } from './identity.js';
import { NfxBeacons } from './nfx/beacons.js';
import { NfxHostSession, beaconFilter, beaconPeers, videoOf } from './nfx/play.js';
import type { NfxStored } from './nfx/publish.js';
import { SeededVideos } from './nfx/seeded.js';
import { NfxSeederKey } from './nfx/seeder-key.js';
import {
  PendingNfxUploads,
  isSignedManifest,
  nfxManifestFor,
  nfxManifestRelays,
} from './nfx/publish.js';
import type { DesktopSigner } from './signer/desktop-signer.js';
import type { RecoveryService } from './recovery/service.js';
import { QuoteHandles } from './quote-handles.js';
import type { ImageService } from './images/images.js';
import { sniffImage } from './images/images.js';
import type { Logger } from './log.js';
import { redact } from './log.js';
import type { DesktopConfig, SettingsStore } from './settings/settings.js';
import { autoTopUpDue } from './settings/settings.js';
import type { WorkerCall } from './sessions.js';
import { HostPlaySession, SessionRegistry } from './sessions.js';
import { buildUnreactDeletion, fetchReactionSummary, ownReactionIds } from './social/reactions.js';
import type { MoneyPlane } from './money.js';
import type { AutoTopUp, TopUpOutcome } from './topup/auto-topup.js';
import type { WalletProvider } from './wallet.js';
import { DEV_BALANCE_SATS, SwitchingWallet } from './wallet.js';

interface HistoryItem {
  readonly video: VideoManifest;
  readonly positionSec: number;
  readonly at: UnixSeconds;
}
type AnalyticsResult = VideoStats & { readonly satsByRendition: ReadonlyMap<string, Sats> };

export interface DesktopAdapterOptions {
  readonly settings: SettingsStore;
  readonly desktop: DesktopConfig;
  /** The relay port: `SimplePoolAdapter` in production, `FakeRelayPool` in tests/offline dev. */
  readonly pool: nostr.PoolLike;
  readonly identity: IdentityProvider;
  /** ADR 0013: the connect / unlock / lock / sign-out flow (absent with --dev-mocks or an injected signer). */
  readonly signerFlow?: DesktopSigner;
  /** ADR 0016: the recovery phrase (present with the signer flow only). */
  readonly recovery?: RecoveryService;
  readonly wallet: WalletProvider;
  /**
   * Stage 3 (ADR 0012): the money plane of the unlocked signer, read at each play (ADR 0013: it
   * changes when the signer connects, locks or signs out). Every play session is authorised with
   * it BEFORE the worker opens the core — the worker's PAYs are paid only for registered
   * sessions — and revoked on that same plane when the session closes.
   */
  readonly money?: () => MoneyPlane | undefined;
  /**
   * Issue #2: executes due auto top-ups with the user's REAL wallet (absent with `--dev-mocks`,
   * where a due top-up is only logged).
   */
  readonly autoTopUp?: AutoTopUp;
  readonly images: ImageService;
  /** `WorkerSupervisor.request`, bound. */
  readonly worker: WorkerCall;
  /** Sends `HostOut` `media-link` to main (`url: null` revokes). */
  readonly mediaLink: (token: string, url: string | null) => void;
  readonly log: Logger;
  /** `--dev-fixtures` (only ever given together with `--dev-mocks`). */
  readonly fixtures?: FixtureCatalog;
  readonly random?: (n: number) => Uint8Array;
  readonly now?: () => UnixSeconds;
  /** Relay wait per query, ms. */
  readonly maxWaitMs?: number;
  /**
   * Slice 5c: `<userData>/nfx`, where the seeder key and the seeded-video record live. Without
   * it no beacon is ever published.
   */
  readonly nfxDir?: string;
}

/** Per page in the in-memory paged lists (history). */
const LIST_PAGE = 20;
/** Comments per page (the mock's size). */
const COMMENTS_PAGE = 20;
/** Upper bound on comments counted for `stats().comments` (one relay query). */
const MAX_COMMENTS_COUNTED = 500;
/** How often (ms) a due-but-not-executed (`--dev-mocks`) auto top-up is logged per mint. */
const TOP_UP_LOG_EVERY_MS = 60_000;

/** Watch's report reasons → NIP-56 report types. */
const REPORT_TYPE_OF: Readonly<Record<string, nostr.ReportType>> = {
  spam: 'spam',
  sexual: 'nudity',
  legal: 'illegal',
};

export class DesktopNetworkAdapter implements NetworkAdapter {
  readonly platform = 'desktop' as const;
  readonly wallet: Wallet;

  private readonly o: DesktopAdapterOptions;
  private readonly log: Logger;
  private readonly random: (n: number) => Uint8Array;
  private readonly now: () => UnixSeconds;
  readonly sessions = new SessionRegistry();
  /** F17: what the renderer gets in place of mint quote ids. */
  readonly quoteHandles: QuoteHandles;
  private clientCache: {
    readonly relays: Settings['relays'];
    readonly signer: unknown;
    readonly client: nostr.NostrClient;
  } | null = null;
  /** The NIP-71 relay catalogue. */
  private readonly nip71Catalog: NostrCatalog;
  /** Contracts v10: the merged catalogue for the current `Settings.nfx`, rebuilt when it changes. */
  private merged: { readonly nfx: NfxSettings; readonly catalog: CatalogSource } | null = null;
  private readonly seederListeners = new Set<(s: SeederStatus) => void>();
  /** uploadId → the owner (webContents) that started it. */
  private readonly uploads = new Map<string, { readonly owner: number }>();
  /** Slice 4a: legacy events of NFX uploads until their `upload.nfx` (bounded, expiring). */
  private readonly pendingNfx = new PendingNfxUploads();
  /** Slice 5c: whose manifest each seeded NFX video is (with `nfxDir`). */
  private readonly seeded: SeededVideos | null;
  /** Slice 5d: the free NFX play sessions, by sid (each with its owner). */
  private readonly nfxSessions = new Map<string, NfxHostSession>();
  /** Slice 5c: the beacon publisher (with `nfxDir`). */
  private readonly beacons: NfxBeacons | null;
  /** Slice 5c: the seeder key of the current user and network, opened on first need. */
  private seederKey: {
    readonly user: NostrPubkey;
    readonly network: string;
    readonly key: Promise<NfxSeederKey>;
  } | null = null;
  /** `${owner}:${uploadId}` → progress listeners (subscribed before the upload starts). */
  private readonly uploadListeners = new Map<string, Set<(p: UploadProgress) => void>>();
  private readonly topUpLogged = new Map<string, number>();
  private readonly devCredited = new Set<string>();

  constructor(opts: DesktopAdapterOptions) {
    this.o = opts;
    this.log = opts.log.child('adapter');
    this.random = opts.random ?? ((n) => randomBytes(n));
    const w = opts.wallet.wallet;
    this.quoteHandles = new QuoteHandles(
      this.random,
      w instanceof SwitchingWallet ? () => w.generation() : undefined,
    );
    this.now = opts.now ?? nostr.nowSeconds;
    this.wallet = opts.wallet.wallet;
    this.nip71Catalog = new NostrCatalog(() => this.client());
    const nfxDir = opts.nfxDir;
    this.seeded = nfxDir === undefined ? null : new SeededVideos(nfxDir, this.log);
    this.beacons =
      nfxDir === undefined
        ? null
        : new NfxBeacons({
            scopedRelays: () => this.beaconRelays(),
            key: () => this.nfxSeederKey(nfxDir),
            endpoint: (seeder, video) => this.o.worker('nfx.endpoint', { seeder, video }),
            irohRelays: () => this.o.settings.get().nfx?.irohRelays ?? [],
            stored: async () => (await this.o.worker('nfx.videos', {})).videos,
            seeded: () => this.seeded?.list() ?? [],
            manifest: (addr) => this.nfxVideo(addr),
            send: async (event, relays) =>
              (await this.o.pool.publish(relays, event)).filter((r) => r.ok).length,
            now: () => this.now(),
            log: this.log.child('nfx-beacons'),
          });
    this.wallet.onChange((e) => {
      if (e.type === 'balance') this.logAutoTopUpDue(e.mint, e.balance);
    });
  }

  // ---- plumbing --------------------------------------------------------------------------

  /** The L1 client for the current relays + signer (rebuilt when either changes). */
  private client(): nostr.NostrClient {
    const relays = this.o.settings.get().relays;
    const signer = this.o.identity.signer();
    const c = this.clientCache;
    if (c !== null && c.relays === relays && c.signer === signer) return c.client;
    const client = new nostr.NostrClient({
      pool: this.o.pool,
      relays,
      ...(signer === undefined ? {} : { signer }),
      now: this.now,
      ...(this.o.maxWaitMs === undefined ? {} : { maxWaitMs: this.o.maxWaitMs }),
      onDropped: (reason) => {
        this.log.debug('dropped an event at the verification boundary', { reason });
      },
    });
    this.clientCache = { relays, signer, client };
    return client;
  }

  private catalog(): CatalogSource {
    return this.o.fixtures ?? this.relayCatalog();
  }

  /**
   * The relay catalogue: NIP-71, merged with the NFX network when `Settings.nfx` is enabled
   * (contracts v10, ADR 0020). Off, it makes no NFX query at all.
   */
  private relayCatalog(): CatalogSource {
    const nfx = this.o.settings.get().nfx;
    if (nfx?.enabled !== true) return this.nip71Catalog;
    if (this.merged?.nfx !== nfx) {
      const source = new NfxCatalog(
        () => this.client(),
        nfx.network,
        () => nfx.scopedRelays,
      );
      const catalog = new MergedCatalog(this.nip71Catalog, source, this.log.child('nfx-catalog'));
      this.merged = { nfx, catalog };
    }
    return this.merged.catalog;
  }

  /** Slice 5c: start the beacon publisher (after the seeded-video record loads). */
  startNfx(): void {
    void this.seeded
      ?.load()
      .catch(() => undefined)
      .then(() => {
        this.beacons?.start();
      });
  }

  /** Slice 5c: stop publishing beacons (they expire on their own within 120 s). */
  stopNfx(): void {
    this.beacons?.stop();
  }

  /** Slice 5c: beacons go to the scoped relays only, and only while seeding and NFX are on. */
  private beaconRelays(): readonly RelayUrl[] {
    const s = this.o.settings.get();
    return s.seeding.enabled && s.nfx?.enabled === true ? s.nfx.scopedRelays : [];
  }

  /**
   * Slice 5c: the current user's seeder key for the network, opened (or made) on first need with
   * the user's signer sealing its passphrase. `null` without NFX or a signer. A failed open is
   * retried next time, never cached.
   */
  private async nfxSeederKey(dir: string): Promise<NfxSeederKey | null> {
    const nfx = this.o.settings.get().nfx;
    const signer = this.o.identity.signer();
    if (nfx?.enabled !== true || signer === undefined) return null;
    const user = await signer.getPublicKey();
    let held = this.seederKey;
    if (held?.user !== user || held.network !== nfx.network) {
      if (held !== null) void held.key.then((k) => k.lock()).catch(() => undefined);
      const key = NfxSeederKey.open({
        dir,
        network: nfx.network,
        user,
        seal: signer,
        warn: (msg) => {
          this.log.warn(msg);
        },
      });
      held = { user, network: nfx.network, key };
      this.seederKey = held;
    }
    try {
      return await held.key;
    } catch {
      if (this.seederKey === held) this.seederKey = null;
      this.log.warn('nfx: the seeder key could not be opened (the signer said no or is locked)');
      return null;
    }
  }

  /** Contracts v10: the scoped relays of `namespace` while NFX is on for it; otherwise none. */
  private nfxScopedRelays(namespace: string): readonly RelayUrl[] {
    const nfx = this.o.settings.get().nfx;
    return nfx?.enabled === true && nfx.network === namespace ? nfx.scopedRelays : [];
  }

  /** L1 errors → the prefixes the screens classify by. */
  private mapNostrError(e: unknown): Error {
    if (e instanceof IpcError) return e;
    if (e instanceof nostr.NoSignerError) return hostError('no-signer', 'no signer connected');
    if (e instanceof nostr.PublishError)
      return hostError('relay-down', 'no write relay accepted the event');
    this.log.warn('relay request failed');
    return hostError('relay-down', 'relay request failed');
  }

  /** A relay read. No read relay configured is `relay-down`, like every relay failure. */
  private async read<T>(fn: (c: nostr.NostrClient) => Promise<T>): Promise<T> {
    const c = this.client();
    if (c.readRelays.length === 0) fail('relay-down', 'no read relays configured');
    try {
      return await fn(c);
    } catch (e) {
      throw this.mapNostrError(e);
    }
  }

  /** A catalogue read: the fixture catalogue needs no relay. */
  private async fromCatalog<T>(fn: (cat: CatalogSource) => Promise<T>): Promise<T> {
    if (this.o.fixtures) return fn(this.o.fixtures);
    return this.read(() => fn(this.relayCatalog()));
  }

  /** A signed write. The signer check comes first: nothing is fetched or built without one. */
  private async write<T>(fn: (c: nostr.NostrClient, me: NostrPubkey) => Promise<T>): Promise<T> {
    const signer = this.o.identity.signer();
    if (signer === undefined) fail('no-signer', 'no signer connected (sign in to do this)');
    const c = this.client();
    if (c.writeRelays.length === 0) fail('relay-down', 'no write relays configured');
    try {
      const me = await signer.getPublicKey();
      return await fn(c, me);
    } catch (e) {
      throw this.mapNostrError(e);
    }
  }

  private hex(bytes: number): string {
    return toHex(this.random(bytes));
  }

  private async requireVideo(id: NostrEventId): Promise<VideoManifest> {
    const v = await this.video(id);
    if (v === null) fail('not-found', 'video not found');
    return v;
  }

  private static ref(v: VideoManifest): nostr.EventRef {
    return { id: v.id, pubkey: v.author, kind: v.kind };
  }

  // ---- identity --------------------------------------------------------------------------

  signer(): Promise<SignerStatus> {
    return this.o.identity.status();
  }

  /** `signer.status` topic (ADR 0013). */
  onSignerStatus(cb: (s: SignerStatus) => void): Unsubscribe {
    return this.o.identity.onStatus?.(cb) ?? ((): void => undefined);
  }

  /** The desktop signer flow (ADR 0013); refused where the signer is fixed. */
  signerFlow(): DesktopSigner {
    if (this.o.signerFlow === undefined)
      fail('forbidden', 'the signer cannot be changed in this mode (--dev-mocks)');
    return this.o.signerFlow;
  }

  /** ADR 0016: the recovery phrase's flows; refused where the signer is fixed. */
  recovery(): RecoveryService {
    if (this.o.recovery === undefined)
      fail('forbidden', 'the recovery phrase is not available in this mode (--dev-mocks)');
    return this.o.recovery;
  }

  /** ADR 0016: the status — `unavailable` where there is no recovery phrase at all. */
  recoveryStatus(): Promise<RecoveryStatusWire> {
    return (
      this.o.recovery?.status() ??
      Promise.resolve({ state: 'unavailable', reissuePending: false, relayCopy: false })
    );
  }

  /** R5-R1: the signed-in identity's held auto top-ups (none where top-ups do not run). */
  topUpHolds(): Promise<readonly TopUpHoldWire[]> {
    return Promise.resolve(this.o.autoTopUp?.holds() ?? []);
  }

  /** R5-R1: resume past held top-up `id` once main's dialog confirms; `false` if it does not. */
  async resumeTopUp(id: string): Promise<boolean> {
    const top = this.o.autoTopUp;
    if (top === undefined) fail('forbidden', 'auto top-ups do not run in this mode');
    const r = await top.resumeHold(id);
    if (r === 'not-found') fail('not-found', 'no such held auto top-up');
    if (r === 'unavailable') fail('forbidden', 'nothing can be confirmed in this mode');
    return r === 'resumed';
  }

  /** `recovery.progress` topic (ADR 0016). */
  onRecoveryProgress(cb: (p: RecoveryProgressWire) => void): Unsubscribe {
    return this.o.recovery?.onProgress(cb) ?? ((): void => undefined);
  }

  me(): Promise<NostrPubkey | null> {
    return this.o.identity.me();
  }

  /**
   * ADR 0015 part c: our picture goes into our profile core (the worker writes it), then our
   * newest kind 0 is re-published with every other field kept and `picture` = its `hyper://`
   * URL, `picture_sha256` and `picture_size`.
   */
  async setProfilePicture(image: {
    readonly bytes: Uint8Array;
    readonly type: string;
  }): Promise<Profile> {
    if (this.o.identity.signer() === undefined)
      fail('no-signer', 'no signer connected (sign in to change your picture)');
    if (image.bytes.byteLength < 1 || image.bytes.byteLength > MAX_IMAGE_BYTES)
      fail('invalid-argument', 'the picture is empty or larger than 5 MiB');
    // The type is whatever the bytes are, not what the renderer said.
    if (sniffImage(image.bytes) === null)
      fail('unsupported-input', 'the picture must be a JPEG, PNG or WebP image');
    const put = await this.o.worker('profile.putImage', { hex: toHex(image.bytes) });
    return this.write(async (c, me) => {
      const previous = await c.queryOne({ kinds: [NostrKind.Profile], authors: [me] });
      const draft = nostr.mergeProfileEvent(
        previous,
        { picture: put.url, picture_sha256: put.sha256, picture_size: put.size },
        this.now(),
      );
      const { event } = await c.publish(draft);
      const verified = nostr.verifyIncoming(event);
      const p = verified === null ? null : nostr.parseProfile(verified, this.now());
      if (p === null) fail('internal', 'the published profile did not verify');
      return p;
    });
  }

  profile(pubkey: NostrPubkey): Promise<Profile | null> {
    return this.fromCatalog((cat) => cat.profile(pubkey));
  }

  // ---- catalog ---------------------------------------------------------------------------

  async feed(q: FeedQuery): Promise<Page<CatalogVideo>> {
    const viewer = await this.me();
    return this.fromCatalog((cat) => cat.feed(q, viewer));
  }

  video(id: NostrEventId): Promise<VideoManifest | null> {
    return this.fromCatalog((cat) => cat.video(id));
  }

  /** Contracts v9: `null` unless the catalogue lists an NFX network (`Settings.nfx`). */
  nfxVideo(addr: NfxAddress): Promise<NfxVideo | null> {
    return this.fromCatalog((cat) => cat.nfxVideo(addr));
  }

  async stats(id: NostrEventId): Promise<VideoStats> {
    const video = await this.video(id);
    const viewer = await this.me();
    const [summary, paid, comments] = await this.read((c) =>
      Promise.all([
        fetchReactionSummary(c, id, viewer),
        nostr.fetchPaidStats(c, id),
        countComments(c, id),
      ]),
    );
    const seedersOnline = video === null ? 0 : await this.catalog().seedersOnline(video);
    let emoji = 0;
    for (const n of summary.emoji.values()) emoji += n;
    const mine = summary.mine?.kind;
    return {
      paidViews: paid.paidViews,
      satsToCreator: paid.paidSats,
      reactions: summary.likes + summary.dislikes + emoji,
      likes: summary.likes,
      dislikes: summary.dislikes,
      ...(mine === 'like' || mine === 'dislike' ? { myReaction: mine } : {}),
      comments,
      ...(seedersOnline === undefined ? {} : { seedersOnline }),
    };
  }

  related(id: NostrEventId, limit = 6): Promise<readonly VideoManifest[]> {
    return this.fromCatalog((cat) => cat.related(id, limit));
  }

  search(q: {
    readonly text: string;
    readonly cursor?: string;
    readonly filters?: SearchFilters;
  }): Promise<Page<CatalogVideo>> {
    const query: SearchQuery = q;
    return this.fromCatalog((cat) => cat.search(query));
  }

  // ---- social ----------------------------------------------------------------------------

  comments(videoId: NostrEventId, sort: 'new' | 'top', cursor?: string): Promise<Page<Comment>> {
    return this.read((c) =>
      nostr.fetchComments(c, videoId, { sort, cursor, limit: COMMENTS_PAGE }),
    );
  }

  comment(videoId: NostrEventId, content: string, parent?: NostrEventId): Promise<Comment> {
    return this.write(async (c) => {
      const video = await this.requireVideo(videoId);
      let parentRef: nostr.EventRef | undefined;
      if (parent !== undefined) {
        const ev = await c.queryOne({ ids: [parent], kinds: [NostrKind.Comment] });
        const pc = ev === null ? null : nostr.parseComment(ev);
        if (pc?.rootId !== videoId) fail('not-found', 'parent comment not found');
        parentRef = { id: pc.id, pubkey: pc.author, kind: NostrKind.Comment };
      }
      return nostr.postComment(c, {
        video: DesktopNetworkAdapter.ref(video),
        content,
        ...(parentRef === undefined ? {} : { parent: parentRef }),
      });
    });
  }

  react(videoId: NostrEventId, reaction: string): Promise<void> {
    return this.write(async (c) => {
      const video = await this.requireVideo(videoId);
      await nostr.react(c, DesktopNetworkAdapter.ref(video), reaction);
      // The private "liked" set mirrors our kind-7 likes for Library › Liked.
      await nostr.setLiked(c, videoId, nostr.classifyReaction(reaction) === 'like');
    });
  }

  /**
   * SE-5: a NIP-09 deletion request for the viewer's OWN kind-7 events on `videoId` (every one
   * of them, so an older like cannot resurface), never a `-` reaction. No own reaction → no
   * event at all.
   */
  unreact(videoId: NostrEventId): Promise<void> {
    return this.write(async (c, me) => {
      const ids = await ownReactionIds(c, me, videoId);
      if (ids.length > 0) await c.publish(buildUnreactDeletion(ids, c.now()));
      await nostr.setLiked(c, videoId, false);
    });
  }

  nutzap(_videoId: NostrEventId, _amount: Sats, _mint: MintUrl, _comment?: string): Promise<void> {
    // Order matters for the screens: signed out is `no-signer`, not a payments error.
    if (this.o.identity.signer() === undefined)
      return Promise.reject(hostError('no-signer', 'no signer connected (sign in to zap)'));
    return Promise.reject(
      hostError('payments-unavailable', 'nutzaps need the Stage 2 wallet and payment engine'),
    );
  }

  subscribe(channel: NostrPubkey): Promise<void> {
    return this.write(async (c) => {
      await nostr.setSubscribed(c, channel, true);
    });
  }

  unsubscribe(channel: NostrPubkey): Promise<void> {
    return this.write(async (c) => {
      await nostr.setSubscribed(c, channel, false);
    });
  }

  async subscriptions(): Promise<readonly NostrPubkey[]> {
    const me = await this.me();
    if (me === null || this.o.fixtures) return [];
    return this.read(async (c) => (await nostr.fetchSubscriptions(c, me)).pubkeys);
  }

  report(videoId: NostrEventId, reason: string): Promise<void> {
    return this.write(async (c) => {
      const video = await this.requireVideo(videoId);
      const known = (nostr.REPORT_TYPES as readonly string[]).includes(reason)
        ? (reason as nostr.ReportType)
        : undefined;
      const type = REPORT_TYPE_OF[reason] ?? known ?? 'other';
      await nostr.report(c, { target: DesktopNetworkAdapter.ref(video), type, reason });
    });
  }

  // ---- library ---------------------------------------------------------------------------

  readonly library: NetworkAdapter['library'] = {
    history: (cursor?: string): Promise<Page<HistoryItem>> =>
      this.read(async (c) => {
        if (!c.hasSigner) return { items: [] };
        const entries = await nostr.fetchHistory(c);
        const start = nostr.decodeOffsetCursor(cursor);
        const slice = entries.slice(start, start + LIST_PAGE);
        const videos = new Map(
          (await this.catalogVideos(slice.map((e) => e.videoId))).map((v) => [v.id as string, v]),
        );
        const items: HistoryItem[] = slice.flatMap((e) => {
          const video = videos.get(e.videoId);
          return video ? [{ video, positionSec: e.positionSec, at: e.at }] : [];
        });
        const end = start + slice.length;
        return end < entries.length ? { items, next: nostr.encodeOffsetCursor(end) } : { items };
      }),
    recordProgress: (videoId: NostrEventId, positionSec: number): Promise<void> =>
      this.write((c) => nostr.recordProgress(c, videoId, positionSec)),
    watchLater: (): Promise<readonly VideoManifest[]> =>
      this.read(async (c) =>
        c.hasSigner ? this.catalogVideos(await nostr.fetchWatchLater(c)) : [],
      ),
    setWatchLater: (videoId: NostrEventId, on: boolean): Promise<void> =>
      this.write((c) => nostr.setWatchLater(c, videoId, on)),
    playlists: async (author?: NostrPubkey): Promise<readonly Playlist[]> => {
      const who = author ?? (await this.me());
      if (who === null) return [];
      return this.read((c) => nostr.fetchPlaylists(c, who));
    },
    savePlaylist: (
      p: Omit<Playlist, 'id' | 'author'> & { readonly id?: string },
    ): Promise<Playlist> =>
      this.write((c) =>
        nostr.savePlaylist(c, {
          id: p.id ?? `pl-${this.hex(8)}`,
          title: p.title,
          ...(p.description === undefined ? {} : { description: p.description }),
          videoIds: p.videoIds,
          isPrivate: p.isPrivate,
        }),
      ),
    liked: (): Promise<readonly VideoManifest[]> =>
      this.read(async (c) => (c.hasSigner ? this.catalogVideos(await nostr.fetchLiked(c)) : [])),
  };

  private catalogVideos(ids: readonly NostrEventId[]): Promise<VideoManifest[]> {
    return ids.length === 0 ? Promise.resolve([]) : this.catalog().videos(ids);
  }

  // ---- playback --------------------------------------------------------------------------

  play(videoId: NostrEventId, rendition?: string): Promise<PlaySession> {
    return this.openSession(0, videoId, rendition);
  }

  /** Contracts v11: a free NFX session for an in-process caller (owner 0). */
  async playNfx(addr: NfxAddress, rendition?: string): Promise<NfxPlaySession> {
    const s = await this.openNfxSession(0, addr, rendition);
    return {
      videoId: s.videoId,
      rendition: s.rendition,
      renditions: s.renditions,
      source: s.source,
      close: () => s.close(),
    };
  }

  /**
   * Slice 5d (ADR 0020): opens a free NFX session for `owner` from the seeders the video's live
   * beacons name on the network's scoped relays. No balance check and no money plane: Phase 1
   * plays free videos only, and nothing here can pay. `no-seeders` when no beacon names one.
   */
  async openNfxSession(
    owner: number,
    addr: NfxAddress,
    rendition?: string,
  ): Promise<NfxHostSession> {
    const settings = this.o.settings.get();
    const scoped = settings.nfx?.enabled === true ? settings.nfx.scopedRelays : [];
    const video = await this.nfxVideo(addr);
    const d = videoOf(addr);
    if (video === null || d === null) fail('not-found', 'no such free NFX video');
    const events =
      scoped.length === 0 ? [] : await this.read((c) => c.query(beaconFilter(video), scoped));
    const peers = beaconPeers(video, events, this.now());
    if (peers.length === 0) fail('no-seeders', 'nobody seeding this NFX video is online');
    const sid = this.hex(16) as HostPlaySession['sid'];
    const token = this.hex(32);
    const res = await this.o.worker('nfx.play.open', {
      sid,
      video: d,
      root: video.root,
      segs: video.segs,
      ...(rendition === undefined ? {} : { rendition }),
      peers,
      prefetchSeconds: settings.prefetchSeconds,
    });
    const s = new NfxHostSession({
      sid,
      owner,
      token,
      videoId: addr,
      rendition: res.rendition,
      renditions: res.renditions,
      close: (x) => this.endNfxSession(x, true),
    });
    this.nfxSessions.set(sid, s);
    // Main learns the link before the reply that names its token (as for paid sessions).
    this.o.mediaLink(token, res.link);
    return s;
  }

  /** Slice 5d: closes `owner`'s NFX session `sid`; a no-op for any other (idempotent). */
  async closeNfxSession(owner: number, sid: string): Promise<void> {
    const s = this.nfxSessions.get(sid);
    if (s?.owner === owner) await s.close();
  }

  /** Slice 5d: a webContents went away — its NFX sessions go too. */
  async closeNfxOwner(owner: number): Promise<void> {
    const mine = [...this.nfxSessions.values()].filter((s) => s.owner === owner);
    await Promise.all(mine.map((s) => s.close()));
  }

  private async endNfxSession(s: NfxHostSession, viaWorker: boolean): Promise<void> {
    this.nfxSessions.delete(s.sid);
    this.o.mediaLink(s.linkToken, null);
    if (viaWorker) await this.o.worker('nfx.play.close', { sid: s.sid }).catch(() => undefined);
  }

  /**
   * Opens a paid session for `owner` (a webContents id; 0 = in-process). Backstop: every other
   * unpaused session of the same owner is paused before the worker opens this one, and again
   * once it is registered (two concurrent opens cannot both end up playing).
   */
  async openSession(
    owner: number,
    videoId: NostrEventId,
    label?: string,
    carry?: { readonly prefetchSeconds: number; readonly paused: boolean },
  ): Promise<HostPlaySession> {
    const video = await this.requireVideo(videoId);
    const r =
      label === undefined ? video.renditions[0] : video.renditions.find((x) => x.label === label);
    if (r === undefined)
      fail('not-found', label === undefined ? 'video has no renditions' : 'no such rendition');
    await this.checkBalance(video);
    const sid = this.hex(16) as HostPlaySession['sid'];
    const token = this.hex(32);
    await this.sessions.pauseOthers({ owner, sid });
    const prefetchSeconds = carry?.prefetchSeconds ?? this.o.settings.get().prefetchSeconds;
    const plane = this.o.money?.();
    plane?.authorizeSession(
      sid,
      { core: r.hyper.core, blob: r.hyper.blob, policy: video.price },
      video.author,
    );
    let res: WorkerMethodTable['play.open'][1];
    try {
      res = await this.o.worker('play.open', {
        sid,
        videoId: video.id,
        rendition: {
          label: r.label,
          hyper: r.hyper,
          size: r.size,
          ...(r.bitrateKbps === undefined ? {} : { bitrateKbps: r.bitrateKbps }),
        },
        ...(video.durationSec === undefined ? {} : { durationSec: video.durationSec }),
        policy: video.price,
        prefetchSeconds,
      });
    } catch (err) {
      void plane?.revokeSession(sid);
      throw err;
    }
    const session = new HostPlaySession(
      {
        sid,
        token,
        owner,
        videoId: video.id,
        title: video.title,
        rendition: r.label,
        policy: video.price,
        prefetchSeconds,
      },
      {
        worker: this.o.worker,
        mediaLink: this.o.mediaLink,
        log: this.log,
        registry: this.sessions,
        reopen: (from, next) =>
          this.openSession(from.owner, from.videoId, next, {
            prefetchSeconds: from.prefetchSeconds,
            paused: from.paused,
          }),
      },
    );
    this.sessions.add(session);
    // Fix round 4: revoked once the worker has paid the session's tail (its answer to
    // `play.close`), not when the renderer closes it — a PAY for those blocks needs it. Lane
    // P2-owed-viewer: what it left unpaid (or, unknown, what it had left) stays payable as a tail.
    session.onSettled((unpaid) => {
      void plane?.revokeSession(sid, unpaid);
    });
    // Main learns the link BEFORE anyone learns the token (HostOut ordering, protocol.ts).
    this.o.mediaLink(token, res.link);
    await this.sessions.pauseOthers(session);
    if (carry?.paused === true) await session.pauseAsync();
    return session;
  }

  private async checkBalance(video: VideoManifest): Promise<void> {
    if (this.o.wallet.kind === 'unavailable')
      fail('payments-unavailable', 'no wallet in Stage 1 (run with --dev-mocks for fake sats)');
    const mints = video.price.mints;
    let balances = await Promise.all(mints.map((m) => this.wallet.balance(m)));
    const top = this.o.wallet.kind === 'real' ? this.o.autoTopUp : undefined;
    if (top !== undefined && mints.length > 0) {
      if (balances.every((b) => b <= 0)) {
        // Issue #2: nothing to pay with — top up a TRUSTED paying mint first (the first funding
        // of a mint asks the user in main's prompt window; a manifest's other mints are never
        // topped up: `autoTopUpDue` requires the user's own list). One top-up at a time.
        // The first mint that is due decides: done, declined, capped or failed, no second mint
        // is tried (and asked about) for the same play. Round 4 (info), round 5: waited for at
        // most `PLAY_TOP_UP_WAIT_MS` in all, the time the first-funding question is open aside;
        // a slower top-up finishes in the background and the play fails `no-balance` now (the
        // user retries). Lane R6-reconcile: ONE call for all of the video's mints, so that bound
        // is the play's — it used to be one call, and one bound, per mint.
        const out = await top.checkForPlay(mints);
        if (out === 'in-flight')
          fail('no-balance', 'a top-up is on its way to this mint: try again in a moment');
        balances = await Promise.all(mints.map((m) => this.wallet.balance(m)));
      } else {
        mints.forEach((m, i) => {
          void top.check(m, balances[i] ?? (0 as Sats));
        });
      }
    }
    if (mints.length === 0 || balances.every((b) => b <= 0))
      fail('no-balance', `no balance at ${mints[0] ?? 'any accepted mint'}`);
  }

  /** `wallet.history` as the screens see it: an auto top-up's funding melt says "top-up". */
  async walletHistory(opts?: {
    readonly limit?: number;
    readonly mint?: MintUrl;
  }): Promise<readonly WalletHistoryEntry[]> {
    const list = await this.wallet.history(opts);
    const top = this.o.autoTopUp;
    return top === undefined ? list : list.map((e) => top.relabel(e));
  }

  /** `wallet.change` events as the screens see them (`walletHistory`'s label). */
  walletChange(e: WalletChangeEvent): WalletChangeEvent {
    return this.o.autoTopUp?.relabelChange(e) ?? e;
  }

  /** The auto top-up in flight, if any (tests, shutdown). */
  topUpInFlight(): Promise<TopUpOutcome> | null {
    return this.o.autoTopUp?.inFlight ?? null;
  }

  image(url: string, sha256?: Sha256Hex, size?: number): Promise<NfMediaImgUrl> {
    return this.o.images.image(url, sha256, size);
  }

  // ---- studio ----------------------------------------------------------------------------

  readonly studio: NetworkAdapter['studio'] = {
    upload: async (
      input: UploadInput,
      onProgress: (p: UploadProgress) => void,
    ): Promise<VideoManifest> => {
      if (typeof input.file !== 'string')
        fail('invalid-argument', 'desktop uploads take a file path');
      const uploadId = this.hex(16) as UploadId;
      const off = this.onUploadProgress(0, uploadId, onProgress);
      try {
        let thumb: number | ThumbnailHex | undefined;
        const t = input.thumbnailChoice;
        if (typeof t === 'number') thumb = t;
        else if (t !== undefined) {
          if (!(IMAGE_MIMES as readonly string[]).includes(t.type))
            fail('invalid-argument', 'thumbnail must be JPEG, PNG or WebP');
          thumb = { hex: toHex(new Uint8Array(await t.arrayBuffer())), type: t.type as ImageMime };
        }
        const { file: _file, thumbnailChoice: _t, ...meta } = input;
        return await this.upload(0, {
          uploadId,
          path: input.file,
          name: basename(input.file),
          meta,
          ...(thumb === undefined ? {} : { thumbnailChoice: thumb }),
        });
      } finally {
        off();
      }
    },
    myVideos: async (cursor?: string): Promise<Page<VideoManifest>> => {
      const me = await this.me();
      if (me === null) return { items: [] };
      const page = await this.feed({
        source: 'author',
        author: me,
        ...(cursor === undefined ? {} : { cursor }),
      });
      // Studio manages NIP-71 uploads; an NFX copy is the same upload's other announcement.
      const items = page.items.filter((v): v is VideoManifest => v.kind !== 38504);
      return page.next === undefined ? { items } : { items, next: page.next };
    },
    analytics: async (videoId: NostrEventId): Promise<AnalyticsResult> => {
      // Real per-rendition sats need Stage 2 receipts; an empty map is the honest answer.
      const stats = await this.stats(videoId);
      return { ...stats, satsByRendition: new Map<string, Sats>() };
    },
  };

  /**
   * Starts an upload in the worker (`studio.upload`). Signing is checked FIRST: without a
   * signer nothing is transcoded, because the result could not be published.
   */
  async upload(
    owner: number,
    input: {
      readonly uploadId: UploadId;
      readonly path: string;
      readonly name: string;
      readonly meta: UploadMeta;
      readonly thumbnailChoice?: number | ThumbnailHex;
    },
  ): Promise<VideoManifest> {
    if (this.o.identity.signer() === undefined)
      fail('no-signer', 'no signer connected (sign in to publish)');
    if (this.uploads.has(input.uploadId)) fail('invalid-argument', 'upload id already in use');
    this.uploads.set(input.uploadId, { owner });
    try {
      const video = await this.o.worker('studio.upload', input);
      // Slice 4a: its NFX copy is announced once the worker has stored it (`upload.nfx`).
      if (input.meta.nfx === true) this.pendingNfx.remember(input.uploadId, video, this.now());
      return video;
    } finally {
      this.uploads.delete(input.uploadId);
    }
  }

  /** Progress for `uploadId` as started by `owner` (may be subscribed before it starts). */
  onUploadProgress(owner: number, uploadId: string, cb: (p: UploadProgress) => void): Unsubscribe {
    const key = `${String(owner)}:${uploadId}`;
    let set = this.uploadListeners.get(key);
    if (set === undefined) {
      set = new Set();
      this.uploadListeners.set(key, set);
    }
    set.add(cb);
    return () => {
      const s = this.uploadListeners.get(key);
      s?.delete(cb);
      if (s?.size === 0) this.uploadListeners.delete(key);
    };
  }

  /** Worker → host `studio.publish`: build, sign and publish the NIP-71 event of an upload. */
  async publishUpload(draft: PublishDraft): Promise<VideoManifest> {
    if (!this.uploads.has(draft.uploadId)) fail('not-found', 'no such upload in progress');
    if (this.o.identity.signer() === undefined)
      fail('no-signer', 'no signer connected (sign in to publish)');
    const creatorP2pk = await this.wallet.p2pkPubkey();
    const input: manifest.VideoManifestInput = {
      kind: draft.meta.kind,
      title: draft.meta.title,
      description: draft.meta.description,
      publishedAt: this.now(),
      durationSec: draft.durationSec,
      tags: draft.meta.tags,
      // ADR 0015: the thumbnail the worker wrote into our profile core goes on the first rendition.
      renditions: draft.renditions.map((r, i) =>
        i === 0 && draft.thumbnailImage !== undefined ? { ...r, image: draft.thumbnailImage } : r,
      ),
      price: {
        satsPerBlock: draft.meta.satsPerBlock,
        blockSize: draft.blockSize,
        mints: draft.meta.mints,
        split: draft.meta.split,
        creatorP2pk,
      },
      // v6: media on Pear only — our manifests name no Blossom servers.
      blossomServers: [],
    };
    return this.write(async (c) => {
      const { event } = await c.publish(manifest.buildVideoEvent(input));
      const verified = nostr.verifyIncoming(event);
      const parsed = verified === null ? null : manifest.parseVideoEvent(verified);
      if (!parsed?.ok) fail('internal', 'published event did not verify');
      return parsed.value;
    });
  }

  /**
   * Slice 4a (ADR 0020): announce a stored NFX upload's kind-38504 manifest, signed by the
   * user's signer and published to the write relays and the namespace's scoped relays. Only the
   * creator's own upload is signed: the stored video must be the one its legacy event derives,
   * and the signer must be that event's author. Logs the outcome; never throws.
   */
  private async publishNfx(uploadId: string, stored: NfxStored): Promise<void> {
    const reason = await this.tryPublishNfx(uploadId, stored);
    if (reason !== null)
      this.log.warn('NFX manifest not published', { video: stored.video, reason });
  }

  /** `publishNfx`'s work: `null` once published, else why not. */
  private async tryPublishNfx(uploadId: string, stored: NfxStored): Promise<string | null> {
    const legacy = this.pendingNfx.take(uploadId, this.now());
    if (legacy === undefined) return 'no-legacy-event';
    const built = nfxManifestFor(legacy, stored, this.now());
    if (!built.ok) return built.reason;
    const { draft } = built;
    try {
      const out = await this.write(async (c, me) => {
        if (me !== legacy.author) return null;
        const relays = nfxManifestRelays(
          c.writeRelays,
          this.nfxScopedRelays(draft.manifest.addr.namespace.toString()),
        );
        const report = await c.publish(draft.event, relays);
        return { report, relays: relays.length };
      });
      if (out === null) return 'not-author';
      if (!isSignedManifest(out.report.event, draft, legacy.author)) return 'did-not-verify';
      // Slice 5c: this node may beacon the video now; the beacon's `a` names its author.
      await this.seeded
        ?.add({ video: stored.video, author: legacy.author, root: stored.root })
        .catch(() => {
          this.log.warn('nfx: the seeded-video record could not be saved');
        });
      this.log.info('NFX manifest published', {
        video: stored.video,
        event: out.report.event.id,
        accepted: out.report.results.filter((r) => r.ok).length,
        relays: out.relays,
      });
      return null;
    } catch (e) {
      return e instanceof IpcError ? e.code : 'internal';
    }
  }

  /** `desktop.ffmpeg` (pre-v5 `studio.ffmpeg()`): the worker probes the configured binary. */
  ffmpeg(recheck: boolean): Promise<FfmpegStatus> {
    const path = this.o.desktop.ffmpeg?.ffmpeg;
    return this.o.worker('studio.ffmpeg', { recheck, ...(path === undefined ? {} : { path }) });
  }

  // ---- seeder ----------------------------------------------------------------------------

  readonly seeder: NetworkAdapter['seeder'] = {
    status: async (): Promise<SeederStatus> => rehydrate(await this.o.worker('seeder.status', {})),
    setEnabled: async (on: boolean): Promise<void> => {
      const prev = this.o.settings.get();
      await this.updateSettings({ seeding: { ...prev.seeding, enabled: on } });
    },
    melt: (mint: MintUrl, bolt11: string): Promise<{ paid: boolean }> =>
      this.o.worker('seeder.melt', { mint, bolt11 }),
    unban: (pubkey: NostrPubkey): Promise<void> => this.o.worker('seeder.unban', { pubkey }),
    onStatus: (cb: (s: SeederStatus) => void): Unsubscribe => {
      this.seederListeners.add(cb);
      return () => this.seederListeners.delete(cb);
    },
  };

  // ---- settings --------------------------------------------------------------------------

  settings(): Promise<Settings> {
    return Promise.resolve(this.o.settings.get());
  }

  /**
   * Persists atomically, then pushes seeding changes to the worker. A worker that is down gets
   * the new values in its next `init`, so that failure is logged, not thrown (the setting WAS
   * saved; rejecting would make the screen show the old value).
   */
  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const prev = this.o.settings.get();
    let next: Settings;
    try {
      next = await this.o.settings.update(patch);
    } catch (e) {
      if (e instanceof TypeError) fail('invalid-argument', 'invalid settings');
      this.log.error('settings could not be saved');
      fail('internal', 'settings could not be saved');
    }
    if (
      next.seeding.enabled !== prev.seeding.enabled ||
      next.seeding.diskCapBytes !== prev.seeding.diskCapBytes
    ) {
      try {
        await this.o.worker('seeder.configure', next.seeding);
      } catch {
        this.log.warn('seeding change not pushed to the worker (applies on its next start)');
      }
    }
    // Slice 5b: NFX on or off reaches the worker; slice 5e-3: so does a change of the network's
    // iroh relays (the worker then restarts its helper with them).
    const nfxNow = nfxWorkerArgs(next);
    const nfxWas = nfxWorkerArgs(prev);
    if (
      nfxNow.enabled !== nfxWas.enabled ||
      nfxNow.irohRelays.join(' ') !== nfxWas.irohRelays.join(' ')
    ) {
      try {
        await this.o.worker('nfx.configure', nfxNow);
      } catch {
        this.log.warn('NFX change not pushed to the worker (applies on its next start)');
      }
    }
    return next;
  }

  // ---- live ------------------------------------------------------------------------------

  notifications(cb: (n: Notification) => void): Unsubscribe {
    const state = { closed: false };
    const isClosed = (): boolean => state.closed;
    const unsubs: Unsubscribe[] = [];
    const start = async (): Promise<void> => {
      const me = await this.me();
      if (me === null || isClosed() || this.o.fixtures) return;
      const c = this.client();
      if (c.readRelays.length === 0) return;
      const since = this.now();
      const { pubkeys } = await nostr.fetchSubscriptions(c, me);
      if (isClosed()) return;
      unsubs.push(
        nostr.watchNewVideos(c, pubkeys, since, (video) => {
          cb({ type: 'new-video', video });
        }),
        nostr.watchReplies(c, me, since, (pc) => {
          cb({ type: 'reply', videoId: pc.rootId, comment: toComment(pc) });
        }),
      );
    };
    start().catch(() => {
      this.log.debug('notifications subscription could not start');
    });
    return () => {
      state.closed = true;
      for (const u of unsubs.splice(0)) u();
    };
  }

  // ---- worker events and lifecycle --------------------------------------------------------

  /** Everything the worker announces (already guarded by the supervisor). */
  onWorkerEvent(ev: WorkerEvent): void {
    switch (ev.e) {
      case 'spend': {
        const s = this.sessions.bySessionId(ev.sid);
        if (s === undefined) return;
        if (!s.policy.mints.includes(ev.mint)) {
          this.log.warn('spend at a mint the video does not accept; ignored');
          return;
        }
        if (this.o.wallet.kind === 'mock')
          this.o.wallet.wallet.credit(ev.mint, -Number(ev.amount), 'out', `streamed ${s.title}`);
        s.emitSpend({ total: ev.total, ratePerMin: ev.ratePerMin });
        return;
      }
      case 'peers':
        this.sessions.bySessionId(ev.sid)?.emitPeers(ev.peers);
        return;
      case 'seeder.status': {
        const status = rehydrate(ev.status);
        for (const cb of this.seederListeners) cb(status);
        return;
      }
      case 'upload.progress':
        this.onUploadEvent(ev.uploadId, ev.progress);
        return;
      case 'upload.nfx':
        // Contracts v8 (ADR 0020). Slice 4a announces a stored one; slice 5 shows the status.
        if (ev.status.state === 'stored') {
          this.log.info('upload packaged for NFX', {
            video: ev.status.video,
            segs: ev.status.segs,
            renditions: ev.status.renditions,
          });
          void this.publishNfx(ev.uploadId, ev.status);
        } else {
          this.pendingNfx.take(ev.uploadId, this.now());
          this.log.warn('upload not packaged for NFX', { reason: ev.status.reason });
        }
        return;
      case 'dev.fixtures':
        this.onDevFixtures(ev.videos);
        return;
      case 'ready':
      case 'log':
        return;
    }
  }

  /** The worker died: its sessions died with it (links revoked, nothing asked of it). */
  onWorkerDown(): void {
    this.sessions.dropAll();
    // Slice 5d: the worker's NFX sessions died with it; revoke their links.
    for (const s of [...this.nfxSessions.values()]) void this.endNfxSession(s, false);
  }

  /** Fix round 4 (quit): close every play session through the worker — each tail paid first. */
  async closeAllSessions(): Promise<void> {
    await Promise.all([
      this.sessions.closeAll(),
      ...[...this.nfxSessions.values()].map((s) => s.close()),
    ]);
  }

  /**
   * Lane P2-owed-viewer (quit): every tail authorisation write started so far has landed — the
   * current plane's, and (independent review) those of planes the signer flow closed, its own
   * shutdown included: `Host.stop` drops the plane before this runs.
   */
  async flushTails(): Promise<void> {
    await Promise.all([
      this.o
        .money?.()
        ?.flushTails()
        .catch(() => undefined),
      this.o.signerFlow?.flushTails(),
    ]);
  }

  private onUploadEvent(uploadId: string, p: UploadProgress): void {
    const rec = this.uploads.get(uploadId);
    if (rec === undefined) return;
    let out: UploadProgress = p;
    if (p.stage === 'thumbnails') {
      const candidates: string[] = [];
      for (const path of p.candidates) {
        try {
          candidates.push(this.o.images.registerFile(path));
        } catch {
          this.log.warn('dropped a thumbnail candidate outside the worker storage');
        }
      }
      out = { stage: 'thumbnails', candidates };
    } else if (p.stage === 'error') {
      out = { stage: 'error', message: redact(p.message) };
    }
    const set = this.uploadListeners.get(`${String(rec.owner)}:${uploadId}`);
    if (set) for (const cb of set) cb(out);
  }

  private onDevFixtures(videos: readonly VideoManifest[]): void {
    if (!this.o.fixtures) {
      this.log.warn('dev.fixtures from the worker ignored (no --dev-fixtures)');
      return;
    }
    this.o.fixtures.setLive(videos);
    if (this.o.wallet.kind !== 'mock') return;
    // Fake sats at every mint the live fixtures accept, once, so they are playable.
    for (const v of videos)
      for (const m of v.price.mints) {
        if (this.devCredited.has(m)) continue;
        this.devCredited.add(m);
        void this.o.wallet.wallet.balance(m).then((b) => {
          if (b <= 0 && this.o.wallet.kind === 'mock')
            this.o.wallet.wallet.credit(m, DEV_BALANCE_SATS, 'in', 'dev-mocks fake sats');
        });
      }
  }

  /**
   * A balance changed. It NEVER starts a top-up (issue #2, independent review finding 1): a
   * balance event is also the user's own withdrawal, send or nutzap, or a seeder melt, and the
   * contract compares `belowSats` at the mint a payment is about to draw from — so a real-wallet
   * top-up starts only from the payment path (`checkBalance` at a play, the money plane's PAY
   * via `AutoTopUp.paymentAt`). With `--dev-mocks` (fake sats, where the worker's spends debit
   * the mock wallet) a due top-up is logged, as in Stage 1 (SE-4).
   */
  private logAutoTopUpDue(mint: MintUrl, balance: Sats): void {
    if (this.o.wallet.kind !== 'mock') return;
    if (!autoTopUpDue(this.o.settings.get(), mint, balance)) return;
    const t = Date.now();
    const last = this.topUpLogged.get(mint) ?? 0;
    if (t - last < TOP_UP_LOG_EVERY_MS) return;
    this.topUpLogged.set(mint, t);
    this.log.info('auto top-up would be due; not executed with --dev-mocks');
  }
}

/**
 * Slice 5b: `Settings.nfx` as the worker takes it (`init.nfx`, `nfx.configure`); slice 5e-3: with
 * the network's iroh relays, none when unset.
 */
export function nfxWorkerArgs(s: Settings): NfxConfigureArgs {
  return { enabled: s.nfx?.enabled === true, irohRelays: s.nfx?.irohRelays ?? [] };
}

function toComment(pc: nostr.ParsedComment): Comment {
  return {
    id: pc.id,
    author: pc.author,
    content: pc.content,
    createdAt: pc.createdAt,
    ...(pc.parent === undefined ? {} : { parent: pc.parent }),
    reactions: 0,
    event: pc.event,
  };
}

/** Comments on `videoId` (one bounded query; exact below `MAX_COMMENTS_COUNTED`). */
async function countComments(c: nostr.NostrClient, videoId: NostrEventId): Promise<number> {
  const events = await c.query({
    kinds: [NostrKind.Comment],
    '#E': [videoId],
    limit: MAX_COMMENTS_COUNTED,
  });
  let n = 0;
  for (const ev of events) if (nostr.parseComment(ev)?.rootId === videoId) n++;
  return n;
}
