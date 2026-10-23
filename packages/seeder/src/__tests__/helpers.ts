import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { NostrPubkey, PaymentEngineSeeder, Sha256Hex } from '@sovit/core';
import { mocks, nfx } from '@sovit/core';
import type { ReplicationStream } from 'hypercore';

import { nodeCrypto } from '../adapters/node/crypto.js';
import { nodeFs } from '../adapters/node/fs.js';
import { createLogger } from '../log/logger.js';
import type { Logger, LogRecord } from '../log/logger.js';
import { BanList } from '../store/ban-list.js';
import type { NfxVideoInput } from '../store/nfx-files.js';
import { fromHex } from '../util/hex.js';

export const adapters = { fs: nodeFs, crypto: nodeCrypto } as const;

export async function tmpDir(
  prefix = 'nutflix-l2-',
): Promise<{ dir: string; rm: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  // Retry: an in-flight atomic JSON write may still be landing when a test ends.
  const rmRetry = async (): Promise<void> => {
    for (let i = 0; ; i++) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch (err) {
        if (i >= 20) throw err;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  };
  return { dir, rm: rmRetry };
}

export interface CapturedLog {
  readonly logger: Logger;
  readonly lines: string[];
  readonly records: LogRecord[];
}

export function capturedLogger(level: 'debug' | 'info' | 'warn' | 'error' = 'debug'): CapturedLog {
  const lines: string[] = [];
  const records: LogRecord[] = [];
  const logger = createLogger({
    level,
    sink: (line, rec) => {
      lines.push(line);
      records.push(rec);
    },
  });
  return { logger, lines, records };
}

export async function loadedBanList(dir: string): Promise<BanList> {
  const b = new BanList({ ...adapters, dataDir: dir });
  await b.load();
  return b;
}

export function pubkey(seed: string): NostrPubkey {
  return mocks.asPubkey(seed);
}

export function noiseKey(seed: number): Uint8Array {
  return fromHex(seed.toString(16).padStart(2, '0').repeat(32));
}

/** A minimal stand-in for the Noise stream (`peer.stream`) — only what PeerSession touches. */
export class FakeStream implements ReplicationStream {
  remotePublicKey: Uint8Array | null;
  publicKey: Uint8Array | null = null;
  destroyed = false;
  destroyCalls = 0;
  /** Test hook: what `PeerSession.mux` reads (Hypercore sets this to the protomux). */
  userData: unknown = undefined;
  private readonly closeListeners: (() => void)[] = [];
  private readonly connectListeners: (() => void)[] = [];

  constructor(remotePublicKey: Uint8Array | null) {
    this.remotePublicKey = remotePublicKey;
  }
  get noiseStream(): ReplicationStream {
    return this;
  }
  get rawStream(): ReplicationStream {
    return this;
  }
  get opened(): Promise<boolean> {
    return Promise.resolve(true);
  }
  destroy(): void {
    this.destroyCalls++;
    if (this.destroyed) return;
    this.destroyed = true;
    // Real streams emit 'close' asynchronously; keep that shape.
    queueMicrotask(() => {
      for (const cb of this.closeListeners.splice(0)) cb();
    });
  }
  on(event: 'close' | 'connect' | 'error', cb: (...args: never[]) => void): this {
    return this.once(event, cb);
  }
  once(event: 'close' | 'connect' | 'error', cb: (...args: never[]) => void): this {
    if (event === 'close') this.closeListeners.push(cb);
    if (event === 'connect') this.connectListeners.push(cb);
    return this;
  }
  pipe<T extends { pipe: unknown }>(dest: T): T {
    return dest;
  }
  /** Test hook: simulate a completed handshake. */
  connect(remotePublicKey: Uint8Array): void {
    this.remotePublicKey = remotePublicKey;
    for (const cb of this.connectListeners.splice(0)) cb();
  }
  /** Test hook: wait for the async close. */
  closed(): Promise<void> {
    return new Promise((r) => {
      queueMicrotask(r);
    });
  }
}

export function honestEngine(windowBlocks = 4): mocks.MockPaymentEngine {
  return new mocks.MockPaymentEngine({ mode: 'honest', config: { windowBlocks } });
}

export type EngineLike = PaymentEngineSeeder;

const sha256Hex = (bytes: Uint8Array): Sha256Hex =>
  createHash('sha256').update(bytes).digest('hex') as Sha256Hex;

export interface NfxFixture {
  readonly input: NfxVideoInput;
  /** Each listed file's bytes, by sha256. */
  readonly bytes: ReadonlyMap<string, Uint8Array>;
  /** The sha256 of every file `input.read` was asked for, in order. */
  readonly reads: string[];
}

/**
 * An NFX-05 video on `nfx:regtest:1` with a valid hash list: `contents[0]` is its playlist,
 * `contents[1]` its init segment, the rest 2 s media segments (at least two contents).
 */
export function nfxVideo(videoId: string, contents: readonly Uint8Array[]): NfxFixture {
  const ns = nfx.Namespace.parse('nfx:regtest:1');
  if (!ns.ok) throw new Error('namespace');
  const addr = nfx.VideoAddr.of(ns.value, videoId);
  if (!addr.ok) throw new Error(`video id ${videoId}`);
  const bytes = new Map<string, Uint8Array>();
  const files: nfx.FileEntry[] = contents.map((c, i) => {
    const sha = sha256Hex(c);
    bytes.set(sha, c);
    const role: nfx.Role = i === 0 ? 'playlist' : i === 1 ? 'init' : 'segment';
    const ext = i === 0 ? 'm3u8' : i === 1 ? 'mp4' : 'm4s';
    return {
      name: `${sha}.${ext}`,
      role,
      sha256: sha,
      size: BigInt(c.byteLength),
      durMs: role === 'segment' ? 2000n : undefined,
    };
  });
  const playlist = files[0]!;
  const hashListBytes = nfx.renderHashList({
    v: 1,
    video: addr.value.toString(),
    files,
    renditions: [
      {
        id: '360p',
        playlist: playlist.name,
        bandwidth: 800_000n,
        codecs: undefined,
        resolution: '640x360',
      },
    ],
  });
  const reads: string[] = [];
  return {
    input: {
      video: addr.value,
      root: sha256Hex(hashListBytes),
      segs: BigInt(files.length),
      hashListBytes,
      read: (entry) => {
        reads.push(entry.sha256);
        const b = bytes.get(entry.sha256);
        return b === undefined ? Promise.reject(new Error('unlisted')) : Promise.resolve(b);
      },
    },
    bytes,
    reads,
  };
}
