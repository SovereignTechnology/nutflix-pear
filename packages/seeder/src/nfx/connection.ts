/**
 * One NFX-12 connection: a HyperDHT secret-stream, its Protomux, and the per-connection rules
 * of §3–§4. Dialing and listening are `endpoint.ts`; this owns what both sides share.
 *
 * - Liveness (§3): a keepalive after 25 s without a write, and the stream is destroyed after
 *   60 s without receiving anything (secret-stream's own timers; empty frames are keepalives).
 * - Flow control (§4): one `FilePump` for every `nfx/files/1` channel on the connection.
 * - Limits (§4): at most 16 videos (so 32 channels) per connection. On the seeder side a
 *   remote channel is accepted only for a well-formed video address the source serves; one
 *   video too many closes the connection. On the watcher side `files`/`pay` refuse to open
 *   past the limit.
 * - Channel ids are `utf8(<namespace>:<video-id>)` (§3, `VideoAddr.channelId()`), and an id
 *   that is not the canonical form of a valid address is rejected, not normalized.
 */
import type NoiseSecretStream from '@hyperswarm/secret-stream';
import { nfx } from '@sovit/core';
import Protomux from 'protomux';

import type { SeederCrypto } from '../adapters/crypto.js';
import { FilesClient } from './files-client.js';
import { serveFiles, type FilesServerOptions } from './files-server.js';
import { PayLane, type PayLaneHandlers } from './pay-lane.js';
import { FilePump } from './pump.js';

export interface NfxLimits {
  /** At most 25 s (NFX-12 §3). */
  readonly keepAliveMs: number;
  /** 60 s (NFX-12 §3). */
  readonly idleTimeoutMs: number;
  /** 16 (NFX-12 §4). */
  readonly maxVideos: number;
  /** 8 in free mode (NFX-12 §4). */
  readonly maxFreeRequestsPerChannel: number;
}

/**
 * Remote channel opens this connection rejects (an id that is no canonical address, a video
 * not served, free mode's pay/1) before it closes: protomux 3.11 bounds neither pending nor
 * rejected opens (`MAX_BACKLOG = Infinity`), and each costs a slot that is never reclaimed.
 */
export const MAX_REJECTED_OPENS = 64;

export const NFX_LIMITS: NfxLimits = {
  keepAliveMs: nfx.KEEPALIVE_INTERVAL_MS,
  idleTimeoutMs: nfx.INACTIVITY_TIMEOUT_MS,
  maxVideos: nfx.MAX_VIDEOS_PER_CONNECTION,
  maxFreeRequestsPerChannel: nfx.MAX_FREE_REQUESTS_PER_CHANNEL,
};

/** What a channel needs from its connection (`files-server.ts`, `files-client.ts`, `pay-lane.ts`). */
export interface ConnectionHost {
  readonly mux: Protomux;
  readonly pump: FilePump;
  readonly limits: NfxLimits;
  readonly remotePublicKey: Uint8Array;
  /** Close the whole connection: a limit was exceeded, or the source is discarded. */
  destroy(reason: string): void;
  /** Stop reading the stream while any holder holds (a sink is behind); idempotent per holder. */
  holdReads(holder: object): void;
  releaseReads(holder: object): void;
}

/** The seeder side of a connection: what it serves, and whether it takes pay/1 lanes. */
export interface NfxServeOptions extends FilesServerOptions {
  /**
   * Accept a remote `nfx/pay/1` lane for a video the source serves (Phase 2's engine attaches
   * here). Unset: free mode, and every pay/1 open is rejected.
   */
  readonly onPay?: (video: nfx.VideoAddr) => PayLaneHandlers | undefined;
}

export interface NfxConnectionOptions {
  /** Set on the seeder side: the connection serves files. */
  readonly serve?: NfxServeOptions;
  /** For the watcher side's sha256 (the platform library, `adapters/crypto.ts`). */
  readonly crypto?: SeederCrypto;
  readonly limits?: Partial<NfxLimits>;
  /** Told when the connection closed and why (a short reason). */
  readonly onClose?: (reason: string) => void;
}

export class NfxConnection implements ConnectionHost {
  readonly mux: Protomux;
  readonly pump: FilePump;
  readonly limits: NfxLimits;
  /** The peer's Noise key; on the watcher side, the key it dialed (checked by `dialNfx`). */
  readonly remotePublicKey: Uint8Array;
  private readonly videos = new Set<string>();
  private readonly clients = new Map<string, FilesClient>();
  private readonly holders = new Set<object>();
  private rejectedOpens = 0;
  private closeReason = 'closed';
  private isClosed = false;

  /**
   * Wrap an OPENED secret-stream (from `dialNfx`, `listenNfx`, or an in-memory pair in tests).
   * Throws if its handshake has not completed: the remote key is the account's identity.
   */
  constructor(
    readonly socket: NoiseSecretStream,
    private readonly o: NfxConnectionOptions = {},
  ) {
    if (socket.remotePublicKey === null) throw new Error('nfx: the stream is not open');
    this.remotePublicKey = socket.remotePublicKey;
    this.limits = { ...NFX_LIMITS, ...o.limits };
    socket.setKeepAlive(this.limits.keepAliveMs);
    socket.setTimeout(this.limits.idleTimeoutMs);
    socket.on('error', (err) => {
      this.closeReason = err.message;
    });
    socket.on('close', () => {
      this.isClosed = true;
      this.pump.close();
      this.o.onClose?.(this.closeReason);
    });
    this.mux = Protomux.from(socket);
    this.pump = new FilePump(socket);
    const serve = o.serve;
    if (serve !== undefined) {
      this.mux.pair({ protocol: nfx.FILES_PROTOCOL }, (id) => this.acceptFiles(id, serve));
      this.mux.pair({ protocol: nfx.PAY_PROTOCOL }, (id) => this.acceptPay(id, serve));
    }
  }

  get closed(): boolean {
    return this.isClosed || this.socket.destroyed;
  }

  /**
   * The watcher side of `nfx/files/1` for `video` on this connection (one per video), or
   * `undefined` past the video limit, without `crypto`, or once the connection is closed.
   */
  files(video: nfx.VideoAddr): FilesClient | undefined {
    const key = video.toString();
    const known = this.clients.get(key);
    if (known !== undefined && !known.closed) return known;
    if (this.closed || this.o.crypto === undefined || !this.claimVideo(key)) return undefined;
    try {
      const client = new FilesClient(this, video, this.o.crypto);
      this.clients.set(key, client);
      return client;
    } catch {
      return undefined;
    }
  }

  /** The watcher side of `nfx/pay/1` for `video`, or `undefined` past the limit or once closed. */
  pay(video: nfx.VideoAddr, handlers: PayLaneHandlers): PayLane | undefined {
    if (this.closed || !this.claimVideo(video.toString())) return undefined;
    try {
      return new PayLane(this, video, handlers);
    } catch {
      return undefined;
    }
  }

  destroy(reason: string): void {
    if (this.closed) return;
    this.closeReason = reason;
    this.socket.destroy();
  }

  holdReads(holder: object): void {
    this.holders.add(holder);
    if (this.holders.size === 1) this.socket.pause();
  }

  releaseReads(holder: object): void {
    if (!this.holders.delete(holder)) return;
    if (this.holders.size === 0) this.socket.resume();
  }

  /** A video counted against the limit; `false` (and the seeder closes) once past it. */
  private claimVideo(key: string): boolean {
    if (this.videos.has(key)) return true;
    if (this.videos.size >= this.limits.maxVideos) return false;
    this.videos.add(key);
    return true;
  }

  private async acceptFiles(id: Uint8Array | null, serve: NfxServeOptions): Promise<void> {
    const video = await this.acceptVideo(id, serve);
    if (video === undefined || serveFiles(this, video, serve) === null) this.rejected();
  }

  private async acceptPay(id: Uint8Array | null, serve: NfxServeOptions): Promise<void> {
    const video = await this.acceptVideo(id, serve);
    // Free mode (no `onPay`, or it declines): the open is rejected.
    const handlers = video === undefined ? undefined : serve.onPay?.(video);
    if (video === undefined || handlers === undefined) {
      this.rejected();
      return;
    }
    try {
      new PayLane(this, video, handlers);
    } catch {
      this.rejected(); // the stream went away while the handler ran
    }
  }

  /** Count a rejected remote open; past the budget the peer is closed. */
  private rejected(): void {
    if (++this.rejectedOpens > MAX_REJECTED_OPENS) {
      this.destroy('too many rejected channel opens');
    }
  }

  /**
   * The video a remote channel id names, if this connection may open it: a canonical address,
   * served by the source, within the video limit. Otherwise `undefined`, and protomux rejects
   * the open (or the connection is closed past the limit).
   */
  private async acceptVideo(
    id: Uint8Array | null,
    serve: NfxServeOptions,
  ): Promise<nfx.VideoAddr | undefined> {
    if (id === null || id.byteLength > 256 || this.closed) return undefined;
    let text: string;
    try {
      // `ignoreBOM` keeps a leading U+FEFF, so the canonical-form check below refuses it.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(id);
    } catch {
      return undefined;
    }
    const video = nfx.VideoAddr.parse(text);
    if (!video.ok || video.value.toString() !== text) return undefined;
    if (!this.claimVideo(text)) {
      this.destroy('more videos than one connection may carry');
      return undefined;
    }
    let served: boolean;
    try {
      served = await serve.source.hasVideo(video.value);
    } catch {
      served = false;
    }
    return served && !this.closed ? video.value : undefined;
  }
}
