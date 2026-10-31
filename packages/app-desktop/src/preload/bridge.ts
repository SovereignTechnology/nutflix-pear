/**
 * `window.nutflix` (design §3 row 2, D3/D5, SE-1). Exactly the `NetworkAdapter` shape plus
 * `desktop.ffmpeg`, `desktop.signer.*` (ADR 0013) and `desktop.wallet.recovery.*` (ADR 0016):
 *
 *   - every `MethodTable` method → one numbered call through the IPC gate;
 *   - callback members (`notifications`, `seeder.onStatus`, `wallet.onChange`) → topics;
 *   - `play` / `session.switchRendition` → a real `PlaySession` whose methods close over the
 *     host-minted `sid`; `onPeers` / `onSpend` subscribe to `session.peers` / `session.spend`
 *     and `close()` drops those subscriptions;
 *   - `studio.upload` takes the DOM `File` the user chose; the preload turns it into a path
 *     with `webUtils.getPathForFile`, asks main for a single-use `FileToken`, subscribes to
 *     `upload.progress` (acknowledged) and only then calls `studio.upload` with the token —
 *     a string `file` (a path) is refused (`file-token-invalid`);
 *   - `wallet.send` / `receive` / `p2pkPubkey` / `keyset` are stubs rejecting `forbidden: …`.
 *
 * Nothing else: no `ipcRenderer`, no generic `invoke`, no Node. Errors are `IpcError`s whose
 * message starts with `"<code>: "` (all `contextBridge` keeps); the renderer rebuilds `.code`.
 */
import type { NostrEventId } from '@sovit/core';
import type {
  ExcludedMethod,
  ImageMime,
  Method,
  PlaySessionWire,
  ThumbnailBytes,
  UploadId,
  UploadInputWire,
} from '../ipc/protocol.js';
import { IMAGE_MIMES, LIMITS } from '../ipc/protocol.js';
import { fromWireError, wireError } from '../ipc/errors.js';
import type { Transport } from './transport.js';
import type { BridgePlaySession, BridgeUploadInput, Call, NutflixBridge } from './types.js';

export interface BridgeDeps {
  /** `webUtils.getPathForFile` — `''` for a `File` the page constructed itself. */
  pathForFile(file: File): string;
  /** `n` random bytes as lower-case hex (`crypto.getRandomValues`). */
  randomHex(n: number): string;
}

function forbidden(method: ExcludedMethod): () => Promise<never> {
  return () =>
    Promise.reject(
      fromWireError(wireError('forbidden', `${method} is not available to the renderer`)),
    );
}

function reject(
  code: 'file-token-invalid' | 'unsupported-input' | 'invalid-argument' | 'session-closed',
  detail: string,
): Promise<never> {
  return Promise.reject(fromWireError(wireError(code, detail)));
}

/**
 * Blob-shaped, checked by shape rather than `instanceof`: a Blob that crossed `contextBridge`
 * from the page is not guaranteed to be an instance of the preload world's `Blob` (the fidelity
 * spike records which). The bytes are what matter and the guards check them again.
 */
interface BlobShape {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isBlobShape(x: unknown): x is BlobShape {
  if (typeof x !== 'object' || x === null) return false;
  const b = x as Partial<Record<keyof BlobShape, unknown>>;
  return (
    typeof b.size === 'number' && typeof b.type === 'string' && typeof b.arrayBuffer === 'function'
  );
}

/** `webUtils.getPathForFile`, which throws for anything that is not a real `File`. */
function pathOf(deps: BridgeDeps, file: object): string {
  try {
    const p = deps.pathForFile(file as File);
    return typeof p === 'string' ? p : '';
  } catch {
    return '';
  }
}

function codeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const c = (err as { code?: unknown }).code;
  return typeof c === 'string' ? c : undefined;
}

export function createBridge(t: Transport, deps: BridgeDeps): NutflixBridge {
  const call =
    <M extends Method>(m: M): Call<M> =>
    (...args) =>
      t.call(m, args);

  function session(w: PlaySessionWire): BridgePlaySession {
    const sid = w.sid;
    let closed = false;
    const unsubs = new Set<() => void>();
    const fire = (p: Promise<unknown>): void => {
      p.catch(() => undefined);
    };
    const track = (subscribe: () => () => void): (() => void) => {
      if (closed) return () => undefined;
      const u = subscribe();
      unsubs.add(u);
      return () => {
        unsubs.delete(u);
        u();
      };
    };
    return {
      videoId: w.videoId,
      rendition: w.rendition,
      source: { kind: 'url', url: w.source.url },
      policy: w.policy,
      onPeers: (cb) => track(() => t.subscribe({ t: 'session.peers', sid }, cb)),
      onSpend: (cb) => track(() => t.subscribe({ t: 'session.spend', sid }, cb)),
      setPrefetchSeconds(sec: number): void {
        if (closed || typeof sec !== 'number' || Number.isNaN(sec)) return;
        const clamped = Math.min(Math.max(0, sec), LIMITS.maxPrefetchSec);
        fire(t.call('session.setPrefetchSeconds', [sid, clamped]));
      },
      pause(): void {
        if (!closed) fire(t.call('session.pause', [sid]));
      },
      resume(): void {
        if (!closed) fire(t.call('session.resume', [sid]));
      },
      async switchRendition(label: string): Promise<BridgePlaySession> {
        if (closed) return reject('session-closed', 'this session was closed');
        return session(await t.call('session.switchRendition', [sid, label]));
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        for (const u of unsubs) u();
        unsubs.clear();
        try {
          await t.call('session.close', [sid]);
        } catch (err: unknown) {
          const c = codeOf(err);
          if (c !== 'session-closed' && c !== 'not-found') throw err;
        }
      },
    };
  }

  async function thumbnailOf(
    choice: BridgeUploadInput['thumbnailChoice'],
  ): Promise<number | ThumbnailBytes | undefined> {
    if (choice === undefined) return undefined;
    if (typeof choice === 'number') return choice;
    if (!isBlobShape(choice)) return reject('invalid-argument', 'thumbnail must be an image');
    if (!(IMAGE_MIMES as readonly string[]).includes(choice.type)) {
      return reject('unsupported-input', 'thumbnail must be a JPEG, PNG or WebP image');
    }
    if (choice.size > LIMITS.maxThumbnailBytes) {
      return reject('invalid-argument', 'thumbnail is larger than 5 MiB');
    }
    return { bytes: new Uint8Array(await choice.arrayBuffer()), type: choice.type as ImageMime };
  }

  async function upload(
    input: BridgeUploadInput,
    onProgress: Parameters<NutflixBridge['studio']['upload']>[1],
  ): ReturnType<NutflixBridge['studio']['upload']> {
    if (typeof input !== 'object' || (input as unknown) === null) {
      return reject('invalid-argument', 'upload needs an input');
    }
    const file: unknown = input.file;
    // SE-1: the renderer never names a file by path.
    if (typeof file === 'string') {
      return reject('file-token-invalid', 'files are chosen with the file picker, never by path');
    }
    if (typeof file !== 'object' || file === null) {
      return reject('unsupported-input', 'that is not a file');
    }
    // `''` for a File the page constructed itself (no location on disk): refused.
    const path = pathOf(deps, file);
    if (path === '')
      return reject('unsupported-input', 'that file has no location on this computer');
    // Thumbnail first: a refused thumbnail must not leave a granted token behind.
    const thumb = await thumbnailOf(input.thumbnailChoice);
    const token = await t.grantFile(path);
    const uploadId = deps.randomHex(16) as UploadId;
    const wire: UploadInputWire = {
      uploadId,
      file: token,
      title: input.title,
      description: input.description,
      tags: input.tags,
      kind: input.kind,
      mints: input.mints,
      satsPerBlock: input.satsPerBlock,
      split: input.split,
      // Contracts v8 (free videos only; the host and the worker refuse it on a priced one).
      ...(input.nfx === true ? { nfx: true } : {}),
      ...(thumb === undefined ? {} : { thumbnailChoice: thumb }),
    };
    const unsubscribe = await t.subscribeAcked({ t: 'upload.progress', uploadId }, (p) => {
      onProgress(p);
    });
    try {
      return await t.call('studio.upload', [wire]);
    } finally {
      unsubscribe();
    }
  }

  return {
    platform: 'desktop',
    signer: call('signer'),
    me: call('me'),
    profile: call('profile'),
    setProfilePicture: call('setProfilePicture'),
    feed: call('feed'),
    video: call('video'),
    nfxVideo: call('nfxVideo'),
    stats: call('stats'),
    related: call('related'),
    search: call('search'),
    comments: call('comments'),
    comment: call('comment'),
    react: call('react'),
    unreact: call('unreact'),
    nutzap: call('nutzap'),
    subscribe: call('subscribe'),
    unsubscribe: call('unsubscribe'),
    subscriptions: call('subscriptions'),
    report: call('report'),
    library: {
      history: call('library.history'),
      recordProgress: call('library.recordProgress'),
      watchLater: call('library.watchLater'),
      setWatchLater: call('library.setWatchLater'),
      playlists: call('library.playlists'),
      savePlaylist: call('library.savePlaylist'),
      liked: call('library.liked'),
    },
    async play(videoId: NostrEventId, rendition?: string): Promise<BridgePlaySession> {
      const args: [NostrEventId, string?] =
        rendition === undefined ? [videoId] : [videoId, rendition];
      return session(await t.call('play', args));
    },
    image: call('image'),
    wallet: {
      mints: call('wallet.mints'),
      balance: call('wallet.balance'),
      inputFeePpk: call('wallet.inputFeePpk'),
      balances: call('wallet.balances'),
      mintQuote: call('wallet.mintQuote'),
      pollQuote: call('wallet.pollQuote'),
      meltQuote: call('wallet.meltQuote'),
      melt: call('wallet.melt'),
      history: call('wallet.history'),
      onChange: (cb) => t.subscribe({ t: 'wallet.change' }, cb),
      send: forbidden('wallet.send'),
      receive: forbidden('wallet.receive'),
      p2pkPubkey: forbidden('wallet.p2pkPubkey'),
      keyset: forbidden('wallet.keyset'),
    },
    studio: {
      upload,
      myVideos: call('studio.myVideos'),
      analytics: call('studio.analytics'),
    },
    seeder: {
      status: call('seeder.status'),
      setEnabled: call('seeder.setEnabled'),
      melt: call('seeder.melt'),
      unban: call('seeder.unban'),
      onStatus: (cb) => t.subscribe({ t: 'seeder.status' }, cb),
    },
    settings: call('settings'),
    updateSettings: call('updateSettings'),
    notifications: (cb) => t.subscribe({ t: 'notifications' }, cb),
    desktop: {
      ffmpeg: call('desktop.ffmpeg'),
      // ADR 0013: names a signer KIND only; secrets are typed in main's prompt window.
      signer: {
        info: call('desktop.signer.info'),
        connect: call('desktop.signer.connect'),
        unlock: call('desktop.signer.unlock'),
        lock: call('desktop.signer.lock'),
        signOut: call('desktop.signer.signOut'),
        onStatus: (cb) => t.subscribe({ t: 'signer.status' }, cb),
      },
      // ADR 0016: names an ACTION only — whatever the page passes, nothing but the method goes
      // on the wire (main's gate refuses any argument too); every word is shown and typed in
      // main's prompt window.
      wallet: {
        recovery: {
          status: () => t.call('desktop.wallet.recovery.status', []),
          setup: () => t.call('desktop.wallet.recovery.setup', []),
          show: () => t.call('desktop.wallet.recovery.show', []),
          restore: () => t.call('desktop.wallet.recovery.restore', []),
          onProgress: (cb) => t.subscribe({ t: 'recovery.progress' }, cb),
        },
        // R5-R1: held auto top-ups, and resuming one by its ledger entry id (main's gate checks
        // the id's form; the host asks main's native dialog before anything changes).
        topUp: {
          holds: () => t.call('desktop.wallet.topUp.holds', []),
          resume: (id) => t.call('desktop.wallet.topUp.resume', [id]),
        },
      },
    },
  };
}
