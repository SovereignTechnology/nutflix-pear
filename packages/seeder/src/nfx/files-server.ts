/**
 * The seeder side of `nfx/files/1` (NFX-12 §4) on one channel, i.e. one video on one
 * connection. Free mode only: a request the node will not or cannot serve is answered
 * `missing`. Paid mode (Phase 2) plugs in at `NfxAdmission`, where a pay/1 session decides.
 *
 * - Only a file the source lists for THIS video (its verified hash list, or the hash list
 *   itself as `sha` = the manifest `root`) is served, so a channel is never an oracle for the
 *   rest of the node's store.
 * - Bytes go out in `data` frames of at most 64 KiB, then `end`, every frame through the
 *   connection's pump (flow control, `pump.ts`). Each frame is read inside the pump's turn, so
 *   a connection holds one chunk in memory however many requests it has open (a peer could
 *   otherwise make the node buffer 16 videos × 8 requests × 64 KiB per connection); the cost
 *   is that a slow read delays the other transfers on the same connection only.
 * - A malformed message, a message a seeder never receives (`data`, `end`, `missing`), an
 *   unknown type in the trapped range, or a `req` already open closes the channel. More open
 *   requests than the limit closes the connection (§4 "a peer that exceeds one is closed").
 */
import { nfx } from '@sovit/core';
import type { ProtomuxChannel, ProtomuxMessage } from 'protomux';

import { toHex } from '../util/hex.js';
import type { ConnectionHost } from './connection.js';
import { addTraps } from './traps.js';

/** One file a node serves on a channel. */
export interface NfxServedFile {
  /** The file's byte length (its `files[].size`, or the hash list's length). */
  readonly size: number;
  /** Exactly `length` bytes at `offset`; anything else fails the transfer. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** What a node serves: its stores, as the transport sees them. */
export interface NfxFileSource {
  /** Whether this node serves `video` at all. A channel for any other video is rejected. */
  hasVideo(video: nfx.VideoAddr): boolean | Promise<boolean>;
  /**
   * File `sha` (64 lowercase hex) of `video`: only a file listed in that video's hash list
   * this node holds and verified (NFX-05 §5), or the hash list itself when `sha` is the
   * manifest `root`. `undefined` for anything else, even a file held for another video.
   */
  file(
    video: nfx.VideoAddr,
    sha: string,
  ): NfxServedFile | undefined | Promise<NfxServedFile | undefined>;
}

/** A request as the admission hook sees it. */
export interface NfxRequest {
  readonly video: nfx.VideoAddr;
  readonly sha: string;
  /** The watcher's Noise key: the NFX-07 §3 peer of its account on this transport. */
  readonly remotePublicKey: Uint8Array;
}

/**
 * Where paid mode decides (Phase 2). Free mode admits every request the source serves; a
 * `false` here is answered `missing`.
 */
export type NfxAdmission = (request: NfxRequest) => boolean | Promise<boolean>;

export interface FilesServerOptions {
  readonly source: NfxFileSource;
  readonly admission?: NfxAdmission;
  /** Told why the channel or connection was closed (a short reason, never file bytes). */
  readonly onProtocolError?: (why: string) => void;
}

/** Open the seeder side of `nfx/files/1` for `video` on `host`; `null` if the mux refused it. */
export function serveFiles(
  host: ConnectionHost,
  video: nfx.VideoAddr,
  o: FilesServerOptions,
): ProtomuxChannel | null {
  const ch = host.mux.createChannel({ protocol: nfx.FILES_PROTOCOL, id: video.channelId() });
  if (ch === null) return null;
  const open = new Set<number>();
  const fail = (why: string): void => {
    o.onProtocolError?.(why);
    ch.close();
  };

  // Pinned order (NFX-12 §4): 0 get, 1 data, 2 end, 3 missing.
  ch.addMessage({
    onmessage: (bytes) => {
      onGet(bytes);
    },
  });
  const data = ch.addMessage({
    onmessage: () => {
      fail('a seeder does not receive `data`');
    },
  });
  const end = ch.addMessage({
    onmessage: () => {
      fail('a seeder does not receive `end`');
    },
  });
  const missing = ch.addMessage({
    onmessage: () => {
      fail('a seeder does not receive `missing`');
    },
  });
  addTraps(ch, () => {
    fail('unknown nfx/files/1 message type');
  });
  ch.open();
  return ch;

  function onGet(bytes: Uint8Array): void {
    const decoded = nfx.decodeFilesMessage(0, bytes);
    if (!decoded.ok || decoded.value.type !== 'get') {
      fail(decoded.ok ? 'not a `get`' : decoded.error.reason);
      return;
    }
    const { req, sha } = decoded.value;
    if (open.has(req)) {
      fail('a `req` that is already open');
      return;
    }
    if (open.size >= host.limits.maxFreeRequestsPerChannel) {
      host.destroy('too many open requests on one channel');
      return;
    }
    open.add(req);
    void serve(req, toHex(sha)).finally(() => {
      open.delete(req);
    });
  }

  async function serve(req: number, sha: string): Promise<void> {
    let file: NfxServedFile | undefined;
    try {
      const request = { video, sha, remotePublicKey: host.remotePublicKey };
      const admitted = o.admission === undefined ? true : await o.admission(request);
      file = admitted ? await o.source.file(video, sha) : undefined;
    } catch {
      fail('the source failed');
      return;
    }
    if (ch.closed) return;
    if (file === undefined) {
      send(missing, { type: 'missing', req });
      return;
    }
    const size = file.size;
    if (!Number.isSafeInteger(size) || size < 0) {
      fail('the source gave a bad size');
      return;
    }
    for (let offset = 0; offset < size; offset += nfx.MAX_DATA_PAYLOAD) {
      const length = Math.min(nfx.MAX_DATA_PAYLOAD, size - offset);
      if (!(await host.pump.turn())) return;
      let chunk: Uint8Array;
      try {
        chunk = await file.read(offset, length);
      } catch {
        host.pump.skip();
        fail('the source failed mid-file');
        return;
      }
      if (ch.closed) {
        host.pump.skip();
        return;
      }
      if (chunk.byteLength !== length) {
        host.pump.skip();
        fail('the source returned a short or long read');
        return;
      }
      const frame = nfx.encodeFilesMessage({ type: 'data', req, payload: chunk });
      if (!frame.ok) {
        host.pump.skip();
        fail(frame.error.reason);
        return;
      }
      host.pump.sent(frame.value.bytes.byteLength, data.send(frame.value.bytes));
    }
    // After the last `data` frame on the same ordered stream, so it cannot overtake it.
    send(end, { type: 'end', req });
  }

  function send(message: ProtomuxMessage, m: nfx.FilesMessage): void {
    const frame = nfx.encodeFilesMessage(m);
    if (frame.ok) message.send(frame.value.bytes);
  }
}
