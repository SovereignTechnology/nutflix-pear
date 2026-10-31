/**
 * `CallMsg` → `DesktopNetworkAdapter` (design §2). One handler per `MethodTable` entry — a
 * missing one is a compile error — and NONE for `EXCLUDED_METHODS` (D3/D5: `wallet.send`,
 * `wallet.receive`, `wallet.p2pkPubkey`, `wallet.keyset` are unreachable from the renderer even
 * though the adapter has them). Results are returned as the contract shapes; `host.ts`
 * dehydrates Maps before they leave the process.
 */
import type { ArgsOf, Method } from '../ipc/protocol.js';
import { toHex } from '../ipc/codec.js';
import type { DesktopNetworkAdapter } from './adapter.js';
import { fail } from './errors.js';
import type { HostPlaySession } from './sessions.js';

export interface CallContext {
  /** The webContents the call came from (≥ 1). */
  readonly wc: number;
  /** Main's resolution of `studio.upload`'s file token (SE-1). */
  readonly file?: { readonly path: string; readonly name: string; readonly size: number };
}

type Handler<M extends Method> = (ctx: CallContext, args: ArgsOf<M>) => Promise<unknown>;
export type HandlerTable = { readonly [M in Method]: Handler<M> };

export function handlers(a: DesktopNetworkAdapter): HandlerTable {
  const session = (ctx: CallContext, sid: string): HostPlaySession => {
    const s = a.sessions.get(ctx.wc, sid);
    if (s === undefined) fail('session-closed', 'no such playback session');
    return s;
  };
  return {
    signer: () => a.signer(),
    me: () => a.me(),
    profile: (_c, [pk]) => a.profile(pk),
    setProfilePicture: (_c, [image]) => a.setProfilePicture(image),
    feed: (_c, [q]) => a.feed(q),
    video: (_c, [id]) => a.video(id),
    nfxVideo: (_c, [addr]) => a.nfxVideo(addr),
    stats: (_c, [id]) => a.stats(id),
    related: (_c, [id, limit]) => a.related(id, limit),
    search: (_c, [q]) => a.search(q),
    comments: (_c, [id, sort, cursor]) => a.comments(id, sort, cursor),
    comment: (_c, [id, content, parent]) => a.comment(id, content, parent),
    react: (_c, [id, reaction]) => a.react(id, reaction),
    unreact: (_c, [id]) => a.unreact(id),
    nutzap: (_c, [id, amount, mint, comment]) => a.nutzap(id, amount, mint, comment),
    subscribe: (_c, [pk]) => a.subscribe(pk),
    unsubscribe: (_c, [pk]) => a.unsubscribe(pk),
    subscriptions: () => a.subscriptions(),
    report: (_c, [id, reason]) => a.report(id, reason),
    'library.history': (_c, [cursor]) => a.library.history(cursor),
    'library.recordProgress': (_c, [id, pos]) => a.library.recordProgress(id, pos),
    'library.watchLater': () => a.library.watchLater(),
    'library.setWatchLater': (_c, [id, on]) => a.library.setWatchLater(id, on),
    'library.playlists': (_c, [author]) => a.library.playlists(author),
    'library.savePlaylist': (_c, [p]) => a.library.savePlaylist(p),
    'library.liked': () => a.library.liked(),
    play: async (c, [id, rendition]) => (await a.openSession(c.wc, id, rendition)).toWire(),
    playNfx: async (c, [addr, rendition]) =>
      (await a.openNfxSession(c.wc, addr, rendition)).toWire(),
    image: (_c, [url, sha, size]) => a.image(url, sha, size),
    'session.pause': (c, [sid]) => session(c, sid).pauseAsync(),
    'session.resume': (c, [sid]) => session(c, sid).resumeAsync(),
    'session.setPrefetchSeconds': (c, [sid, sec]) => session(c, sid).setPrefetchAsync(sec),
    'session.switchRendition': async (c, [sid, label]) =>
      (await session(c, sid).switchAsync(label)).toWire(),
    // Idempotent: closing an unknown/closed/foreign sid is a no-op, never another wc's session.
    'session.close': async (c, [sid]) => {
      await a.sessions.get(c.wc, sid)?.closeAsync();
      // Contracts v11: an NFX session closes the same way (one sid space).
      await a.closeNfxSession(c.wc, sid);
    },
    'wallet.mints': () => a.wallet.mints(),
    'wallet.balance': (_c, [mint]) => a.wallet.balance(mint),
    'wallet.inputFeePpk': (_c, [mint]) => a.wallet.inputFeePpk(mint),
    'wallet.balances': () => a.wallet.balances(),
    // F17: the renderer holds an opaque handle, never the (bearer) quote id.
    'wallet.mintQuote': (_c, [mint, amount]) =>
      a.quoteHandles.make(() => a.wallet.mintQuote(mint, amount)),
    'wallet.pollQuote': (_c, [quote]) => a.wallet.pollQuote(a.quoteHandles.resolve(quote)),
    'wallet.meltQuote': (_c, [mint, bolt11]) => a.wallet.meltQuote(mint, bolt11),
    // Stage 2: main's money gate (native confirm) sits in front of this.
    'wallet.melt': (_c, [quote]) => a.wallet.melt(quote),
    // Issue #2: an auto top-up's funding melt reads "top-up" (core's melt takes no memo).
    'wallet.history': (_c, [opts]) => a.walletHistory(opts),
    'studio.upload': (c, [input]) => {
      // SE-1: the path comes ONLY from main's token swap, never from the renderer's message.
      if (c.file === undefined) fail('file-token-invalid', 'no file was granted for this upload');
      const { uploadId, file: _token, thumbnailChoice, ...meta } = input;
      return a.upload(c.wc, {
        uploadId,
        path: c.file.path,
        name: c.file.name,
        meta,
        ...(thumbnailChoice === undefined
          ? {}
          : {
              thumbnailChoice:
                typeof thumbnailChoice === 'number'
                  ? thumbnailChoice
                  : { hex: toHex(thumbnailChoice.bytes), type: thumbnailChoice.type },
            }),
      });
    },
    'studio.myVideos': (_c, [cursor]) => a.studio.myVideos(cursor),
    'studio.analytics': (_c, [id]) => a.studio.analytics(id),
    'seeder.status': () => a.seeder.status(),
    'seeder.setEnabled': (_c, [on]) => a.seeder.setEnabled(on),
    'seeder.melt': (_c, [mint, bolt11]) => a.seeder.melt(mint, bolt11),
    'seeder.unban': (_c, [pk]) => a.seeder.unban(pk),
    settings: () => a.settings(),
    updateSettings: (_c, [patch]) => a.updateSettings(patch),
    'desktop.ffmpeg': (_c, [opts]) => a.ffmpeg(opts.recheck),
    // ADR 0013: the renderer names a kind; the flow runs in main's prompt window.
    'desktop.signer.info': () => a.signerFlow().info(),
    'desktop.signer.connect': (_c, [req]) => a.signerFlow().connect(req),
    'desktop.signer.unlock': () => a.signerFlow().unlock(),
    'desktop.signer.lock': () => a.signerFlow().lock(),
    'desktop.signer.signOut': () => a.signerFlow().signOut(),
    // ADR 0016: an action only; every word is shown and typed in main's prompt window.
    'desktop.wallet.recovery.status': () => a.recoveryStatus(),
    'desktop.wallet.recovery.setup': () => a.recovery().setup(),
    'desktop.wallet.recovery.show': () => a.recovery().show(),
    'desktop.wallet.recovery.restore': () => a.recovery().restore(),
    // R5-R1: an entry id only; the host asks main's native dialog before anything changes.
    'desktop.wallet.topUp.holds': () => a.topUpHolds(),
    'desktop.wallet.topUp.resume': (_c, [id]) => a.resumeTopUp(id),
  };
}
