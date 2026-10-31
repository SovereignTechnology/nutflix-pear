/**
 * What the renderer expects at `window.nutflix` — the preload's `contextBridge` surface
 * (`src/preload/types.ts` declares the same shape on the other side; the two TypeScript
 * projects cannot import each other). Wire-typed: results still hold `WireMap`s and errors carry
 * their code only as the `"<code>: "` message prefix, so the renderer never hands this object
 * to a screen directly — `adapter/rehydrate.ts` turns it into a `NetworkAdapter` first.
 *
 * Both files derive every member from `src/ipc/protocol.ts`, and both sides test their key
 * tree against the allowlist computed from `METHODS`, `EXCLUDED_METHODS` and `TOPIC_METHODS`
 * (`renderer/__tests__/rehydrate.test.ts` here, `preload/__tests__/bridge.test.ts` there).
 */
import type {
  NostrEventId,
  Notification,
  PricePolicy,
  UploadInput,
  VideoManifest,
} from '@sovit/core';
import type {
  ArgsOf,
  Method,
  NfMediaPlayUrl,
  ResultOf,
  TopicPayload,
  UploadProgressWire,
} from '../ipc/protocol.js';

export type Call<M extends Method> = (...args: ArgsOf<M>) => Promise<ResultOf<M>>;
export type Listen<P> = (cb: (payload: P) => void) => () => void;

export interface BridgePlaySession {
  readonly videoId: NostrEventId;
  readonly rendition: string;
  readonly source: { readonly kind: 'url'; readonly url: NfMediaPlayUrl };
  readonly policy: PricePolicy;
  onPeers: Listen<TopicPayload['session.peers']>;
  onSpend: Listen<TopicPayload['session.spend']>;
  setPrefetchSeconds(sec: number): void;
  pause(): void;
  resume(): void;
  switchRendition(label: string): Promise<BridgePlaySession>;
  close(): Promise<void>;
}

/**
 * `studio.upload`'s input as the renderer passes it: the DOM `File` the user picked (never a
 * path — SE-1) and, for a custom thumbnail, the image `Blob`.
 */
export type BridgeUploadInput = Omit<UploadInput, 'file' | 'thumbnailChoice'> & {
  readonly file: File;
  readonly thumbnailChoice?: number | Blob;
};

export interface NutflixBridge {
  readonly platform: 'desktop';
  signer: Call<'signer'>;
  me: Call<'me'>;
  profile: Call<'profile'>;
  setProfilePicture: Call<'setProfilePicture'>;
  feed: Call<'feed'>;
  video: Call<'video'>;
  nfxVideo: Call<'nfxVideo'>;
  stats: Call<'stats'>;
  related: Call<'related'>;
  search: Call<'search'>;
  comments: Call<'comments'>;
  comment: Call<'comment'>;
  react: Call<'react'>;
  unreact: Call<'unreact'>;
  nutzap: Call<'nutzap'>;
  subscribe: Call<'subscribe'>;
  unsubscribe: Call<'unsubscribe'>;
  subscriptions: Call<'subscriptions'>;
  report: Call<'report'>;
  readonly library: {
    history: Call<'library.history'>;
    recordProgress: Call<'library.recordProgress'>;
    watchLater: Call<'library.watchLater'>;
    setWatchLater: Call<'library.setWatchLater'>;
    playlists: Call<'library.playlists'>;
    savePlaylist: Call<'library.savePlaylist'>;
    liked: Call<'library.liked'>;
  };
  play(videoId: NostrEventId, rendition?: string): Promise<BridgePlaySession>;
  image: Call<'image'>;
  readonly wallet: {
    mints: Call<'wallet.mints'>;
    balance: Call<'wallet.balance'>;
    inputFeePpk: Call<'wallet.inputFeePpk'>;
    balances: Call<'wallet.balances'>;
    mintQuote: Call<'wallet.mintQuote'>;
    pollQuote: Call<'wallet.pollQuote'>;
    meltQuote: Call<'wallet.meltQuote'>;
    melt: Call<'wallet.melt'>;
    history: Call<'wallet.history'>;
    onChange: Listen<TopicPayload['wallet.change']>;
    /** D3/D5: stubs that always reject `forbidden: …`. */
    send(...args: unknown[]): Promise<never>;
    receive(...args: unknown[]): Promise<never>;
    p2pkPubkey(...args: unknown[]): Promise<never>;
    keyset(...args: unknown[]): Promise<never>;
  };
  readonly studio: {
    upload(
      input: BridgeUploadInput,
      onProgress: (p: UploadProgressWire) => void,
    ): Promise<VideoManifest>;
    myVideos: Call<'studio.myVideos'>;
    analytics: Call<'studio.analytics'>;
  };
  readonly seeder: {
    status: Call<'seeder.status'>;
    setEnabled: Call<'seeder.setEnabled'>;
    melt: Call<'seeder.melt'>;
    unban: Call<'seeder.unban'>;
    onStatus: Listen<TopicPayload['seeder.status']>;
  };
  settings: Call<'settings'>;
  updateSettings: Call<'updateSettings'>;
  notifications: Listen<Notification>;
  readonly desktop: {
    ffmpeg: Call<'desktop.ffmpeg'>;
    /** ADR 0013: the signer connect flow (a kind only; secrets go to main's prompt window). */
    readonly signer: {
      info: Call<'desktop.signer.info'>;
      connect: Call<'desktop.signer.connect'>;
      unlock: Call<'desktop.signer.unlock'>;
      lock: Call<'desktop.signer.lock'>;
      signOut: Call<'desktop.signer.signOut'>;
      onStatus: Listen<TopicPayload['signer.status']>;
    };
    /**
     * ADR 0016: the recovery phrase — an ACTION only; words are shown and typed in main's
     * prompt window, the reissue fee confirmed in main's native dialog.
     */
    readonly wallet: {
      readonly recovery: {
        status: Call<'desktop.wallet.recovery.status'>;
        setup: Call<'desktop.wallet.recovery.setup'>;
        show: Call<'desktop.wallet.recovery.show'>;
        restore: Call<'desktop.wallet.recovery.restore'>;
        onProgress: Listen<TopicPayload['recovery.progress']>;
      };
      /** R5-R1: held auto top-ups; resuming one is confirmed in main's native dialog. */
      readonly topUp: {
        holds: Call<'desktop.wallet.topUp.holds'>;
        resume: Call<'desktop.wallet.topUp.resume'>;
      };
    };
  };
}
