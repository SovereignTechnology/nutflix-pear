/**
 * Test helpers for the NFX-12 transport: an in-memory file source and sink, and a pair of
 * real secret-streams joined in memory (`@hyperswarm/secret-stream` without a transport), so
 * most tests run the real Noise + Protomux stack without a DHT.
 */
import { createHash } from 'node:crypto';

import NoiseSecretStream from '@hyperswarm/secret-stream';
import { nfx } from '@sovit/core';
import DHT from 'hyperdht';

import { nodeCrypto } from '../../adapters/node/crypto.js';
import { NfxConnection, type NfxLimits, type NfxServeOptions } from '../connection.js';
import type { NfxSink } from '../files-client.js';
import type { NfxFileSource, NfxServedFile } from '../files-server.js';

export const sha256Hex = (data: Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

export function video(id: string, namespace = 'nfx:regtest:1'): nfx.VideoAddr {
  const v = nfx.VideoAddr.parse(`${namespace}:${id}`);
  if (!v.ok) throw new Error(`bad test video ${id}`);
  return v.value;
}

/** `n` deterministic bytes. */
export function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed * 7) & 0xff;
  return out;
}

export function keyPair(seed: number): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return DHT.keyPair(new Uint8Array(32).fill(seed));
}

/** Files per video, by sha. `add` may file bytes under a sha that is not theirs (poison). */
export class MemorySource implements NfxFileSource {
  private readonly byVideo = new Map<string, Map<string, Uint8Array>>();
  /** Every video counts as served (for the video-limit test). */
  allVideos = false;
  /** While set, `file()` waits for it (holds requests open). */
  gate: Promise<void> | null = null;
  /** Reads at or past this offset never resolve (a transfer that stops mid-file). */
  hangReadsFrom: number | null = null;
  readonly lookups: string[] = [];

  add(v: nfx.VideoAddr, data: Uint8Array, sha = sha256Hex(data)): string {
    const key = v.toString();
    const files = this.byVideo.get(key) ?? new Map<string, Uint8Array>();
    files.set(sha, data);
    this.byVideo.set(key, files);
    return sha;
  }

  hasVideo(v: nfx.VideoAddr): boolean {
    return this.allVideos || this.byVideo.has(v.toString());
  }

  async file(v: nfx.VideoAddr, sha: string): Promise<NfxServedFile | undefined> {
    this.lookups.push(`${v.toString()} ${sha}`);
    if (this.gate !== null) await this.gate;
    const data = this.byVideo.get(v.toString())?.get(sha);
    if (data === undefined) return undefined;
    const hang = this.hangReadsFrom;
    return {
      size: data.byteLength,
      read: (offset, length) =>
        hang !== null && offset >= hang
          ? new Promise<Uint8Array>(() => undefined)
          : Promise.resolve(data.slice(offset, offset + length)),
    };
  }
}

export class MemorySink implements NfxSink {
  readonly chunks: Uint8Array[] = [];

  write(chunk: Uint8Array): void {
    this.chunks.push(chunk);
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.chunks.reduce((n, c) => n + c.byteLength, 0));
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }
}

/** Two opened secret-streams joined in memory: `client` dialed `server`. */
export async function streamPair(
  serverSeed = 1,
  clientSeed = 2,
): Promise<{ server: NoiseSecretStream; client: NoiseSecretStream }> {
  const client = new NoiseSecretStream(true, null, { keyPair: keyPair(clientSeed) });
  const server = new NoiseSecretStream(false, null, { keyPair: keyPair(serverSeed) });
  client.rawStream.pipe(server.rawStream).pipe(client.rawStream);
  client.on('error', () => undefined);
  server.on('error', () => undefined);
  const [a, b] = await Promise.all([client.opened, server.opened]);
  if (!a || !b) throw new Error('the in-memory pair did not open');
  return { server, client };
}

export interface ConnectedPair {
  readonly server: NfxConnection;
  readonly client: NfxConnection;
  readonly serverClosed: Promise<string>;
}

/** A seeder connection serving `serve` and a watcher connection, joined in memory. */
export async function connectedPair(
  serve: NfxServeOptions,
  limits?: Partial<NfxLimits>,
): Promise<ConnectedPair> {
  const s = await streamPair();
  let closed: (reason: string) => void = () => undefined;
  const serverClosed = new Promise<string>((resolve) => {
    closed = resolve;
  });
  const server = new NfxConnection(s.server, {
    serve,
    ...(limits !== undefined ? { limits } : {}),
    onClose: (reason) => {
      closed(reason);
    },
  });
  const client = new NfxConnection(s.client, {
    crypto: nodeCrypto,
    ...(limits !== undefined ? { limits } : {}),
  });
  return { server, client, serverClosed };
}

/** Resolves when `socket` closes. */
export function closedOf(socket: NoiseSecretStream): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.once('close', resolve);
  });
}
