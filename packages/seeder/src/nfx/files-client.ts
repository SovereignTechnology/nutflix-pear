/**
 * The watcher side of `nfx/files/1` (NFX-12 §4) on one channel: whole files by sha256, the
 * receiver duties of §4 and the integrity rule of §6.
 *
 * - Every `data` payload is copied out of the receive buffer (the codec hands out a view) and
 *   written to the caller's sink in order, one write at a time. While more than 1 MiB waits
 *   for the sink the connection stops reading, so a slow sink cannot grow memory unboundedly.
 * - A file is capped at its size: a byte past it, or `end` before it, is a mismatch. Its
 *   sha256 is checked before the result says `ok`, and a mismatch drops the whole connection:
 *   the source is discarded for the session (NFX-05 §4). The sink's bytes are the caller's to
 *   discard on any failure; only `ok` means they are the file.
 * - `data`, `end` or `missing` for a `req` that is not open, a seeder's `get`, or a trapped
 *   unknown type close the channel; its open requests fail `protocol`.
 * - A request that gets no frame for the idle limit (60 s) fails `timeout`, and the channel is
 *   closed to abandon it: a seeder's keepalives hold the connection open, so the connection's
 *   own idle rule cannot catch a transfer that simply stops.
 */
import { nfx } from '@sovit/core';
import type { ProtomuxChannel, ProtomuxMessage } from 'protomux';

import type { SeederCrypto, Sha256Hasher } from '../adapters/crypto.js';
import { fromHex } from '../util/hex.js';
import type { ConnectionHost } from './connection.js';
import { addTraps } from './traps.js';

/** Where a fetched file's bytes go, in order (a spool file, normally). */
export interface NfxSink {
  write(chunk: Uint8Array): void | Promise<void>;
}

export interface FetchOptions {
  /** The file's sha256, 64 lowercase hex. */
  readonly sha: string;
  /**
   * Its `files[].size`. With `exact: false`, a cap instead: the hash list, fetched as `sha` =
   * the manifest `root`, is any length up to 16 MiB.
   */
  readonly size: number;
  readonly exact?: boolean;
  readonly sink: NfxSink;
  /** Fail `timeout` if the file is not complete by then. Unset: only the 60 s stall rule. */
  readonly timeoutMs?: number;
}

export type FetchFailure =
  /** The seeder does not serve it (free mode). */
  | 'missing'
  /** The bytes' sha256 is not `sha`: the connection was dropped. */
  | 'mismatch'
  /** More bytes than `size`: the connection was dropped. */
  | 'too-long'
  /** `end` before `size` bytes: the connection was dropped. */
  | 'too-short'
  /** The seeder broke `nfx/files/1`; the channel was closed. */
  | 'protocol'
  /** The seeder does not serve this video on this connection. */
  | 'unserved'
  | 'closed'
  | 'timeout'
  /** As many requests are open on this channel as NFX-12 §4 allows. */
  | 'busy'
  /** A request for the same `sha` is open on this channel. */
  | 'duplicate'
  | 'invalid-argument'
  /** The sink threw: the channel was closed, since a request cannot be cancelled. */
  | 'sink';

export type FetchResult =
  | { readonly ok: true; readonly bytes: number }
  | { readonly ok: false; readonly reason: FetchFailure };

/** Bytes waiting for the sink above which the connection stops reading, and below which it resumes. */
const SINK_HIGH_BYTES = 1024 * 1024;
const SINK_LOW_BYTES = 256 * 1024;

interface Transfer {
  readonly sha: string;
  readonly size: number;
  readonly exact: boolean;
  readonly sink: NfxSink;
  readonly hasher: Sha256Hasher;
  received: number;
  waiting: number;
  /** Restart the stall timer: a frame of this request arrived. */
  alive(): void;
  writes: Promise<void>;
  sinkFailed: boolean;
  settle(result: FetchResult): void;
}

export class FilesClient {
  private readonly channel: ProtomuxChannel;
  private readonly get: ProtomuxMessage;
  private readonly opened: Promise<boolean>;
  private readonly open = new Map<number, Transfer>();
  private nextReq = 1;
  private everOpened = false;

  /** Use `NfxConnection.files(video)`. Throws if the mux will not open the channel. */
  constructor(
    private readonly host: ConnectionHost,
    readonly video: nfx.VideoAddr,
    private readonly crypto: SeederCrypto,
  ) {
    const ch = host.mux.createChannel({
      protocol: nfx.FILES_PROTOCOL,
      id: video.channelId(),
      onclose: () => {
        this.failAll(this.everOpened ? 'closed' : 'unserved');
      },
    });
    if (ch === null) {
      throw new Error('nfx/files/1: the channel is already open or the stream is gone');
    }
    this.channel = ch;
    // Pinned order (NFX-12 §4): 0 get, 1 data, 2 end, 3 missing.
    this.get = ch.addMessage({
      onmessage: () => {
        this.protocolError();
      },
    });
    ch.addMessage({
      onmessage: (bytes) => {
        this.onData(bytes);
      },
    });
    ch.addMessage({
      onmessage: (bytes) => {
        this.onEnd(bytes);
      },
    });
    ch.addMessage({
      onmessage: (bytes) => {
        this.onMissing(bytes);
      },
    });
    addTraps(ch, () => {
      this.protocolError();
    });
    ch.open();
    this.opened = ch.fullyOpened().then((opened) => {
      this.everOpened = opened;
      return opened;
    });
  }

  get openRequests(): number {
    return this.open.size;
  }

  get closed(): boolean {
    return this.channel.closed;
  }

  /** Fetch one whole file. Resolves once; never throws. */
  async fetch(o: FetchOptions): Promise<FetchResult> {
    const exact = o.exact ?? true;
    if (
      !/^[0-9a-f]{64}$/.test(o.sha) ||
      !Number.isSafeInteger(o.size) ||
      o.size < 0 ||
      (!exact && o.size > nfx.MAX_HASH_LIST_BYTES)
    ) {
      return { ok: false, reason: 'invalid-argument' };
    }
    if (this.open.size >= this.host.limits.maxFreeRequestsPerChannel) {
      return { ok: false, reason: 'busy' };
    }
    for (const t of this.open.values())
      if (t.sha === o.sha) return { ok: false, reason: 'duplicate' };
    if (!(await this.opened) || this.channel.closed) {
      return { ok: false, reason: this.everOpened ? 'closed' : 'unserved' };
    }
    // Re-checked: other fetches may have started while this one waited for the channel.
    if (this.open.size >= this.host.limits.maxFreeRequestsPerChannel) {
      return { ok: false, reason: 'busy' };
    }
    for (const t of this.open.values())
      if (t.sha === o.sha) return { ok: false, reason: 'duplicate' };
    const req = this.allocateReq();
    const frame = nfx.encodeFilesMessage({ type: 'get', req, sha: fromHex(o.sha) });
    if (!frame.ok) return { ok: false, reason: 'invalid-argument' };

    return new Promise<FetchResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stall: ReturnType<typeof setTimeout> | undefined;
      const abandon = (): void => {
        // No cancel in nfx/files/1 (§4): abandoning a transfer closes the channel.
        transfer.settle({ ok: false, reason: 'timeout' });
        this.channel.close();
      };
      const transfer: Transfer = {
        sha: o.sha,
        size: o.size,
        exact,
        sink: o.sink,
        hasher: this.crypto.createSha256(),
        received: 0,
        waiting: 0,
        alive: () => {
          if (stall !== undefined) clearTimeout(stall);
          stall = setTimeout(() => {
            // Bytes still waiting for the sink: the silence is ours (reads are held), not the seeder's.
            if (transfer.waiting > 0) transfer.alive();
            else abandon();
          }, this.host.limits.idleTimeoutMs);
        },
        writes: Promise.resolve(),
        sinkFailed: false,
        settle: (result) => {
          if (this.open.get(req) !== transfer) return;
          this.open.delete(req);
          if (timer !== undefined) clearTimeout(timer);
          if (stall !== undefined) clearTimeout(stall);
          this.host.releaseReads(transfer);
          resolve(result);
        },
      };
      this.open.set(req, transfer);
      transfer.alive();
      if (o.timeoutMs !== undefined) timer = setTimeout(abandon, o.timeoutMs);
      this.get.send(frame.value.bytes);
    });
  }

  /** Close the channel; open requests fail `closed`. */
  close(): void {
    this.channel.close();
  }

  private onData(bytes: Uint8Array): void {
    const m = this.decode(1, bytes);
    if (m?.type !== 'data') return;
    const t = this.open.get(m.req);
    if (t === undefined) {
      this.protocolError();
      return;
    }
    if (t.received + m.payload.byteLength > t.size) {
      this.discardSource(t, 'too-long');
      return;
    }
    t.alive();
    const chunk = m.payload.slice();
    t.received += chunk.byteLength;
    t.hasher.update(chunk);
    t.waiting += chunk.byteLength;
    if (t.waiting > SINK_HIGH_BYTES) this.host.holdReads(t);
    t.writes = t.writes.then(async () => {
      if (t.sinkFailed) return;
      try {
        await t.sink.write(chunk);
      } catch {
        t.sinkFailed = true;
        t.settle({ ok: false, reason: 'sink' });
        this.channel.close();
        return;
      }
      t.waiting -= chunk.byteLength;
      if (t.waiting < SINK_LOW_BYTES) this.host.releaseReads(t);
    });
  }

  private onEnd(bytes: Uint8Array): void {
    const m = this.decode(2, bytes);
    if (m?.type !== 'end') return;
    const t = this.open.get(m.req);
    if (t === undefined) {
      this.protocolError();
      return;
    }
    if (t.exact && t.received !== t.size) {
      this.discardSource(t, 'too-short');
      return;
    }
    void t.writes.then(() => {
      if (t.sinkFailed) return;
      if (t.hasher.digestHex() !== t.sha) {
        this.discardSource(t, 'mismatch');
        return;
      }
      t.settle({ ok: true, bytes: t.received });
    });
  }

  private onMissing(bytes: Uint8Array): void {
    const m = this.decode(3, bytes);
    if (m?.type !== 'missing') return;
    const t = this.open.get(m.req);
    if (t === undefined) {
      this.protocolError();
      return;
    }
    // A refusal answers a `get`; after bytes of the same request it is a protocol error.
    if (t.received > 0) {
      t.settle({ ok: false, reason: 'protocol' });
      this.protocolError();
      return;
    }
    t.settle({ ok: false, reason: 'missing' });
  }

  private decode(index: number, bytes: Uint8Array): nfx.FilesMessage | undefined {
    const m = nfx.decodeFilesMessage(index, bytes);
    if (m.ok) return m.value;
    this.protocolError();
    return undefined;
  }

  /** NFX-05 §4: a source that served a mismatch is discarded for the session. */
  private discardSource(t: Transfer, reason: 'too-long' | 'too-short' | 'mismatch'): void {
    t.settle({ ok: false, reason });
    this.host.destroy(`the seeder served a ${reason} file`);
  }

  private protocolError(): void {
    this.failAll('protocol');
    this.channel.close();
  }

  private failAll(reason: FetchFailure): void {
    for (const t of [...this.open.values()]) t.settle({ ok: false, reason });
  }

  /** A u32 not in use on this channel (NFX-12 §4: unique among the open requests). */
  private allocateReq(): number {
    for (;;) {
      const req = this.nextReq;
      this.nextReq = req === 0xffff_ffff ? 0 : req + 1;
      if (!this.open.has(req)) return req;
    }
  }
}
