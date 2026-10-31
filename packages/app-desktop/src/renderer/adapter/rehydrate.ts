/**
 * `window.nutflix` → the `NetworkAdapter` the screens get (design §2 "Renderer rebuild",
 * §0.8). Two things do not survive `contextBridge` and are rebuilt here:
 *
 *   - **Maps**: every result and topic payload goes through L6-0's `rehydrate` (`{ $map }` →
 *     `Map`), so `wallet.balances()`, `seeder.status().earned.byMint`, `studio.analytics()`'s
 *     `satsByRendition` and `seeder.onStatus` payloads are real `ReadonlyMap`s again;
 *   - **error codes**: `contextBridge` copies an Error's `message` only, so the code is read
 *     back from the `"<code>: "` prefix and the error is rebuilt as an `IpcError` with `.code`
 *     (Studio reads `.code`; the other screens classify by prefix, which is preserved).
 *
 * Arguments pass through untouched — a DOM `File` for `studio.upload` must reach the preload
 * as the same `File` (SE-1: the preload, not the renderer, turns it into a token).
 */
import type { NetworkAdapter, PlaySession, UploadInput, Wallet } from '@sovit/core';
import type { RecoveryControls, TopUpHoldControls } from '@sovit/ui';
import type { IpcError } from '../../ipc/errors.js';
import { INTERNAL_MESSAGE, fromWireError } from '../../ipc/errors.js';
import { isErrorCode } from '../../ipc/guards.js';
import { rehydrate } from '../../ipc/wiremap.js';
import type { BridgePlaySession, BridgeUploadInput, NutflixBridge } from '../bridge-types.js';

const PREFIX = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*):/;

/** Anything a bridge call rejected with → an `IpcError` whose `.code` matches its prefix. */
export function rebuildError(err: unknown): IpcError {
  let message = '';
  try {
    if (typeof err === 'string') message = err;
    else if (typeof err === 'object' && err !== null) {
      const m = (err as { message?: unknown }).message;
      if (typeof m === 'string') message = m;
    }
  } catch {
    message = '';
  }
  // Electron may prefix a rejection that crossed an isolated world ("Error invoking remote
  // method …: Error: <code>: …"); the code is the first recognised prefix.
  const tail = /(?:^|: (?:Error: )?)([a-z][a-z0-9-]*: [\s\S]*)$/.exec(message)?.[1] ?? message;
  const code = PREFIX.exec(tail)?.[1];
  if (!isErrorCode(code)) return fromWireError({ code: 'internal', message: INTERNAL_MESSAGE });
  return fromWireError({ code, message: tail.slice(0, 512) });
}

async function settle<T>(p: Promise<unknown>): Promise<T> {
  try {
    return rehydrate(await p) as T;
  } catch (err: unknown) {
    throw rebuildError(err);
  }
}

/** A screen's callback, fed rehydrated payloads (the wire payload's Maps are `$map`s). */
function rehydrating(cb: (payload: never) => void): (payload: unknown) => void {
  return (payload) => {
    cb(rehydrate(payload) as never);
  };
}

/** A bridge `PlaySession` → a contract `PlaySession` (errors rebuilt, switch wrapped). */
export function sessionFromBridge(s: BridgePlaySession): PlaySession {
  return {
    videoId: s.videoId,
    rendition: s.rendition,
    source: { kind: 'url', url: s.source.url },
    policy: s.policy,
    onPeers: (cb) => s.onPeers(rehydrating(cb)),
    onSpend: (cb) => s.onSpend(rehydrating(cb)),
    setPrefetchSeconds: (sec) => {
      s.setPrefetchSeconds(sec);
    },
    pause: () => {
      s.pause();
    },
    resume: () => {
      s.resume();
    },
    switchRendition: async (label) =>
      sessionFromBridge(await settle<BridgePlaySession>(s.switchRendition(label))),
    close: () => settle<undefined>(s.close()),
  };
}

export function adapterFromBridge(b: NutflixBridge): NetworkAdapter {
  const wallet: Wallet = {
    mints: () => settle(b.wallet.mints()),
    balance: (mint) => settle(b.wallet.balance(mint)),
    inputFeePpk: (mint) => settle(b.wallet.inputFeePpk(mint)),
    balances: () => settle(b.wallet.balances()),
    p2pkPubkey: () => settle(b.wallet.p2pkPubkey()),
    mintQuote: (mint, amount) => settle(b.wallet.mintQuote(mint, amount)),
    pollQuote: (q) => settle(b.wallet.pollQuote(q)),
    send: (amount, opts) => settle(b.wallet.send(amount, opts)),
    receive: (set) => settle(b.wallet.receive(set)),
    meltQuote: (mint, bolt11) => settle(b.wallet.meltQuote(mint, bolt11)),
    melt: (q) => settle(b.wallet.melt(q)),
    keyset: (mint, id) => settle(b.wallet.keyset(mint, id)),
    history: (opts) => settle(opts === undefined ? b.wallet.history() : b.wallet.history(opts)),
    onChange: (cb) => b.wallet.onChange(rehydrating(cb)),
  };
  return {
    platform: 'desktop',
    signer: () => settle(b.signer()),
    me: () => settle(b.me()),
    profile: (pk) => settle(b.profile(pk)),
    setProfilePicture: (image) => settle(b.setProfilePicture(image)),
    feed: (q) => settle(b.feed(q)),
    video: (id) => settle(b.video(id)),
    nfxVideo: (addr) => settle(b.nfxVideo(addr)),
    stats: (id) => settle(b.stats(id)),
    related: (id, limit) => settle(limit === undefined ? b.related(id) : b.related(id, limit)),
    search: (q) => settle(b.search(q)),
    comments: (id, sort, cursor) =>
      settle(cursor === undefined ? b.comments(id, sort) : b.comments(id, sort, cursor)),
    comment: (id, content, parent) =>
      settle(parent === undefined ? b.comment(id, content) : b.comment(id, content, parent)),
    react: (id, r) => settle(b.react(id, r)),
    unreact: (id) => settle(b.unreact(id)),
    nutzap: (id, amount, mint, comment) =>
      settle(
        comment === undefined ? b.nutzap(id, amount, mint) : b.nutzap(id, amount, mint, comment),
      ),
    subscribe: (pk) => settle(b.subscribe(pk)),
    unsubscribe: (pk) => settle(b.unsubscribe(pk)),
    subscriptions: () => settle(b.subscriptions()),
    report: (id, reason) => settle(b.report(id, reason)),
    library: {
      history: (cursor) =>
        settle(cursor === undefined ? b.library.history() : b.library.history(cursor)),
      recordProgress: (id, sec) => settle(b.library.recordProgress(id, sec)),
      watchLater: () => settle(b.library.watchLater()),
      setWatchLater: (id, on) => settle(b.library.setWatchLater(id, on)),
      playlists: (author) =>
        settle(author === undefined ? b.library.playlists() : b.library.playlists(author)),
      savePlaylist: (p) => settle(b.library.savePlaylist(p)),
      liked: () => settle(b.library.liked()),
    },
    play: async (id, rendition) =>
      sessionFromBridge(
        await settle<BridgePlaySession>(
          rendition === undefined ? b.play(id) : b.play(id, rendition),
        ),
      ),
    image: (url, sha) => settle(sha === undefined ? b.image(url) : b.image(url, sha)),
    wallet,
    studio: {
      // The DOM File (and thumbnail Blob) go to the preload as they are (SE-1).
      upload: (input: UploadInput, onProgress) =>
        settle(
          b.studio.upload(input as unknown as BridgeUploadInput, (p) => {
            onProgress(p);
          }),
        ),
      myVideos: (cursor) =>
        settle(cursor === undefined ? b.studio.myVideos() : b.studio.myVideos(cursor)),
      analytics: (id) => settle(b.studio.analytics(id)),
    },
    seeder: {
      status: () => settle(b.seeder.status()),
      setEnabled: (on) => settle(b.seeder.setEnabled(on)),
      melt: (mint, bolt11) => settle(b.seeder.melt(mint, bolt11)),
      unban: (pk) => settle(b.seeder.unban(pk)),
      onStatus: (cb) => b.seeder.onStatus(rehydrating(cb)),
    },
    settings: () => settle(b.settings()),
    updateSettings: (patch) => settle(b.updateSettings(patch)),
    notifications: (cb) => b.notifications(rehydrating(cb)),
  };
}

/**
 * ADR 0016: the shell's recovery phrase flows (`desktop.wallet.recovery.*`) for Settings, errors
 * rebuilt like the adapter's (`cancelled: …`, `rate-limited: …` keep their prefix). Every call
 * names an action; nothing but states, counts, amounts and mint URLs comes back.
 */
export function recoveryFromBridge(
  r: NutflixBridge['desktop']['wallet']['recovery'],
): RecoveryControls {
  return {
    status: () => settle(r.status()),
    setup: () => settle(r.setup()),
    show: () => settle(r.show()),
    restore: () => settle(r.restore()),
    onProgress: (cb) => r.onProgress(rehydrating(cb)),
  };
}

/**
 * R5-R1: the shell's held auto top-ups (`desktop.wallet.topUp.*`) for Settings, errors rebuilt like
 * the adapter's. Resuming names a ledger entry only; the host asks main's native dialog.
 */
export function topUpHoldsFromBridge(
  t: NutflixBridge['desktop']['wallet']['topUp'],
): TopUpHoldControls {
  return {
    holds: () => settle(t.holds()),
    resume: (id) => settle(t.resume(id)),
  };
}
