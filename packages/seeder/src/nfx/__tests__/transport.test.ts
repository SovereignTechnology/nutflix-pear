/**
 * NFX-12 `nfx/files/1` and `nfx/pay/1` end to end over a real secret-stream pair joined in
 * memory: the seeder side (`files-server.ts`), the watcher side (`files-client.ts`), and the
 * connection's rules (`connection.ts`). Hostile peers speak raw Protomux.
 */
import { nfx } from '@sovit/core';
import Protomux, { type ProtomuxMessage } from 'protomux';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nodeCrypto } from '../../adapters/node/crypto.js';
import { fromHex } from '../../util/hex.js';
import { NfxConnection } from '../connection.js';
import { TRAPPED_TYPES } from '../traps.js';
import {
  MemorySink,
  MemorySource,
  bytes,
  closedOf,
  connectedPair,
  sha256Hex,
  streamPair,
  video,
  type ConnectedPair,
} from './helpers.js';

const V = video('nfx-transport-a');
const W = video('nfx-transport-b');

const open: ConnectedPair[] = [];
afterEach(() => {
  for (const p of open.splice(0)) {
    p.client.destroy('test over');
    p.server.destroy('test over');
  }
});

async function pair(source: MemorySource, limits?: Parameters<typeof connectedPair>[1]) {
  const p = await connectedPair({ source }, limits);
  open.push(p);
  return p;
}

/** A `get` frame as a hostile client would send it. */
function get(req: number, sha: string): Uint8Array {
  const f = nfx.encodeFilesMessage({ type: 'get', req, sha: fromHex(sha) });
  if (!f.ok) throw new Error(f.error.reason);
  return f.value.bytes;
}

describe('nfx/files/1 over a secret-stream pair', () => {
  it('fetches a multi-frame file byte for byte, its sha256 checked', async () => {
    const source = new MemorySource();
    const data = bytes(3 * nfx.MAX_DATA_PAYLOAD + 123);
    const sha = source.add(V, data);
    const p = await pair(source);
    const sink = new MemorySink();
    const r = await p.client.files(V)!.fetch({ sha, size: data.byteLength, sink });
    expect(r).toEqual({ ok: true, bytes: data.byteLength });
    expect(sink.chunks).toHaveLength(4);
    expect(sha256Hex(sink.bytes())).toBe(sha);
    expect(p.server.pump.stats.frames).toBe(4);
  });

  it('fetches the hash list against a cap instead of an exact size', async () => {
    const source = new MemorySource();
    const list = bytes(5000, 9);
    const root = source.add(V, list);
    const p = await pair(source);
    const sink = new MemorySink();
    const r = await p.client.files(V)!.fetch({
      sha: root,
      size: nfx.MAX_HASH_LIST_BYTES,
      exact: false,
      sink,
    });
    expect(r).toEqual({ ok: true, bytes: 5000 });
  });

  it('serves a zero-byte file as `end` alone', async () => {
    const source = new MemorySource();
    const sha = source.add(V, new Uint8Array(0));
    const p = await pair(source);
    const sink = new MemorySink();
    expect(await p.client.files(V)!.fetch({ sha, size: 0, sink })).toEqual({ ok: true, bytes: 0 });
    expect(sink.chunks).toHaveLength(0);
  });

  it('answers `missing` for a file it does not list for THIS video', async () => {
    const source = new MemorySource();
    const onlyOnW = source.add(W, bytes(100, 3));
    source.add(V, bytes(10, 4));
    const p = await pair(source);
    const sink = new MemorySink();
    const r = await p.client.files(V)!.fetch({ sha: onlyOnW, size: 100, sink });
    // Held for W, asked on V's channel: never an oracle for the rest of the store (§4).
    expect(r).toEqual({ ok: false, reason: 'missing' });
    expect(source.lookups).toEqual([`${V.toString()} ${onlyOnW}`]);
    expect(p.client.closed).toBe(false);
  });

  it('reports a video the seeder does not serve as `unserved`', async () => {
    const source = new MemorySource();
    source.add(V, bytes(10));
    const p = await pair(source);
    const r = await p.client
      .files(W)!
      .fetch({ sha: 'ab'.repeat(32), size: 1, sink: new MemorySink() });
    expect(r).toEqual({ ok: false, reason: 'unserved' });
  });

  it('rejects a poisoned file and drops the source', async () => {
    const source = new MemorySource();
    const real = bytes(70_000, 5);
    const sha = sha256Hex(real);
    source.add(V, bytes(70_000, 6), sha); // same size, other bytes
    const p = await pair(source);
    const r = await p.client
      .files(V)!
      .fetch({ sha, size: real.byteLength, sink: new MemorySink() });
    expect(r).toEqual({ ok: false, reason: 'mismatch' });
    await closedOf(p.client.socket);
    expect(p.client.closed).toBe(true);
  });

  it('refuses more bytes than the size, and `end` before it', async () => {
    const source = new MemorySource();
    const data = bytes(1000, 7);
    const sha = source.add(V, data);
    const long = await pair(source);
    expect(await long.client.files(V)!.fetch({ sha, size: 999, sink: new MemorySink() })).toEqual({
      ok: false,
      reason: 'too-long',
    });
    await closedOf(long.client.socket);
    const short = await pair(source);
    expect(await short.client.files(V)!.fetch({ sha, size: 1001, sink: new MemorySink() })).toEqual(
      { ok: false, reason: 'too-short' },
    );
    await closedOf(short.client.socket);
  });

  it('refuses bad arguments, a second request for the same sha, and a ninth request', async () => {
    const source = new MemorySource();
    const a = source.add(V, bytes(10, 1));
    let release: () => void = () => undefined;
    source.gate = new Promise((r) => {
      release = r;
    });
    const p = await pair(source);
    const files = p.client.files(V)!;
    const sink = new MemorySink();
    expect(await files.fetch({ sha: 'AB'.repeat(32), size: 1, sink })).toEqual({
      ok: false,
      reason: 'invalid-argument',
    });
    const first = files.fetch({ sha: a, size: 10, sink });
    expect(await files.fetch({ sha: a, size: 10, sink })).toEqual({
      ok: false,
      reason: 'duplicate',
    });
    const more = Array.from({ length: 7 }, (_, i) =>
      files.fetch({ sha: (i + 10).toString(16).padStart(2, '0').repeat(32), size: 1, sink }),
    );
    await vi.waitFor(() => {
      expect(files.openRequests).toBe(8);
    });
    expect(await files.fetch({ sha: 'ee'.repeat(32), size: 1, sink })).toEqual({
      ok: false,
      reason: 'busy',
    });
    release();
    expect(await first).toEqual({ ok: true, bytes: 10 });
    for (const r of await Promise.all(more)) expect(r).toEqual({ ok: false, reason: 'missing' });
  });

  it('spools to a slow sink with reads held, the seeder queueing at most 256 KiB', async () => {
    const source = new MemorySource();
    const data = bytes(2 * 1024 * 1024 + 17, 8);
    const sha = source.add(V, data);
    const p = await pair(source);
    const hold = vi.spyOn(p.client, 'holdReads');
    const chunks: Uint8Array[] = [];
    const slow = {
      async write(chunk: Uint8Array): Promise<void> {
        chunks.push(chunk);
        await new Promise((r) => setTimeout(r, 5)); // far below an in-memory pair's rate
      },
    };
    const r = await p.client.files(V)!.fetch({ sha, size: data.byteLength, sink: slow });
    expect(r).toEqual({ ok: true, bytes: data.byteLength });
    expect(hold).toHaveBeenCalled();
    expect(p.server.pump.stats.maxQueuedBytes).toBeLessThanOrEqual(nfx.MAX_QUEUED_FILE_BYTES);
    expect(p.server.pump.stats.stalls).toBeGreaterThan(0);
  }, 30_000);
});

describe('hostile watchers', () => {
  /** A seeder connection and a raw Protomux on the watcher's stream. */
  async function hostile(source: MemorySource) {
    const s = await streamPair();
    let reason = '';
    const server = new NfxConnection(s.server, {
      serve: { source },
      onClose: (why) => {
        reason = why;
      },
    });
    const mux = Protomux.from(s.client);
    const channel = (v: nfx.VideoAddr, onclose?: () => void) => {
      const ch = mux.createChannel({
        protocol: nfx.FILES_PROTOCOL,
        id: v.channelId(),
        onclose: () => {
          onclose?.();
        },
      })!;
      const messages = Array.from({ length: 4 + TRAPPED_TYPES + 1 }, () => ch.addMessage({}));
      ch.open();
      return { ch, messages };
    };
    return { server, client: s.client, channel, reason: () => reason };
  }

  it('closes the channel on an unknown message type', async () => {
    const source = new MemorySource();
    source.add(V, bytes(10));
    const h = await hostile(source);
    let closed = false;
    const { ch, messages } = h.channel(V, () => {
      closed = true;
    });
    expect(await ch.fullyOpened()).toBe(true);
    messages[4]!.send(new Uint8Array(4)); // index 4: the first trap
    await vi.waitFor(() => {
      expect(closed).toBe(true);
    });
    h.server.destroy('test over');
  });

  it('closes the channel on a `req` that is already open', async () => {
    const source = new MemorySource();
    const sha = source.add(V, bytes(10));
    source.gate = new Promise(() => undefined); // never answers
    const h = await hostile(source);
    let closed = false;
    const { ch, messages } = h.channel(V, () => {
      closed = true;
    });
    expect(await ch.fullyOpened()).toBe(true);
    messages[0]!.send(get(7, sha));
    messages[0]!.send(get(7, sha));
    await vi.waitFor(() => {
      expect(closed).toBe(true);
    });
    h.server.destroy('test over');
  });

  it('closes the connection on a ninth open request on one channel', async () => {
    const source = new MemorySource();
    source.gate = new Promise(() => undefined);
    source.add(V, bytes(10));
    const h = await hostile(source);
    const { ch, messages } = h.channel(V);
    expect(await ch.fullyOpened()).toBe(true);
    for (let req = 1; req <= 9; req++) messages[0]!.send(get(req, 'cd'.repeat(32)));
    await closedOf(h.client);
    expect(h.reason()).toMatch(/too many open requests/);
  });

  it('closes the connection past 16 videos', async () => {
    const source = new MemorySource();
    source.allVideos = true;
    const h = await hostile(source);
    for (let i = 0; i < 17; i++) h.channel(video(`nfx-video-${String(i).padStart(3, '0')}`));
    await closedOf(h.client);
    expect(h.reason()).toMatch(/more videos/);
  });

  it('closes the connection after 64 rejected channel opens', async () => {
    const h = await hostile(new MemorySource()); // serves nothing
    const mux = Protomux.from(h.client);
    for (let i = 0; i <= 64; i++) {
      // Not canonical (uppercase), so no video is claimed: only the rejection budget counts.
      mux
        .createChannel({
          protocol: nfx.FILES_PROTOCOL,
          id: new TextEncoder().encode(`NFX:regtest:1:bad-${String(i)}`),
        })
        ?.open();
    }
    await closedOf(h.client);
    expect(h.reason()).toMatch(/rejected channel opens/);
  });

  it('rejects a channel id that is not a canonical video address', async () => {
    const source = new MemorySource();
    source.allVideos = true;
    const s = await streamPair();
    const server = new NfxConnection(s.server, { serve: { source } });
    const mux = Protomux.from(s.client);
    const ch = mux.createChannel({
      protocol: nfx.FILES_PROTOCOL,
      id: new TextEncoder().encode('NFX:regtest:1:Not-Canonical'),
    })!;
    ch.open();
    expect(await ch.fullyOpened()).toBe(false);
    // A served address behind a byte-order mark: the bytes are not the canonical id.
    const bom = mux.createChannel({
      protocol: nfx.FILES_PROTOCOL,
      id: new Uint8Array([0xef, 0xbb, 0xbf, ...V.channelId()]),
    })!;
    bom.open();
    expect(await bom.fullyOpened()).toBe(false);
    server.destroy('test over');
  });
});

describe('the watcher side', () => {
  it('opens no more than 16 videos on one connection', async () => {
    const p = await pair(new MemorySource());
    for (let i = 0; i < 16; i++) {
      expect(p.client.files(video(`nfx-watch-${String(i).padStart(3, '0')}`))).toBeDefined();
    }
    expect(p.client.files(video('nfx-watch-one-more'))).toBeUndefined();
    // The same video again is the same client, not a new one.
    expect(p.client.files(video('nfx-watch-000'))).toBe(p.client.files(video('nfx-watch-000')));
  });

  it('times out a fetch and abandons it by closing the channel', async () => {
    const source = new MemorySource();
    const sha = source.add(V, bytes(10));
    source.gate = new Promise(() => undefined);
    const p = await pair(source);
    const files = p.client.files(V)!;
    const r = await files.fetch({ sha, size: 10, sink: new MemorySink(), timeoutMs: 50 });
    expect(r).toEqual({ ok: false, reason: 'timeout' });
    expect(files.closed).toBe(true);
  });

  it('abandons a transfer that stops while keepalives hold the connection open', async () => {
    const source = new MemorySource();
    const data = bytes(3 * nfx.MAX_DATA_PAYLOAD, 12);
    const sha = source.add(V, data);
    source.hangReadsFrom = nfx.MAX_DATA_PAYLOAD; // the second frame never comes
    const p = await pair(source, { keepAliveMs: 40, idleTimeoutMs: 300 });
    const files = p.client.files(V)!;
    const r = await files.fetch({ sha, size: data.byteLength, sink: new MemorySink() });
    expect(r).toEqual({ ok: false, reason: 'timeout' });
    expect(files.closed).toBe(true);
    expect(p.client.closed).toBe(false);
  });

  it('treats `data` after `end` as a protocol error, not part of the file', async () => {
    const data = bytes(10, 13);
    const sha = sha256Hex(data);
    const s = await streamPair();
    const client = new NfxConnection(s.client, { crypto: nodeCrypto });
    const mux = Protomux.from(s.server);
    const frame = (m: nfx.FilesMessage): Uint8Array => {
      const f = nfx.encodeFilesMessage(m);
      if (!f.ok) throw new Error(f.error.reason);
      return f.value.bytes;
    };
    mux.pair({ protocol: nfx.FILES_PROTOCOL }, () => {
      const ch = mux.createChannel({ protocol: nfx.FILES_PROTOCOL, id: V.channelId() })!;
      const out: { data?: ProtomuxMessage; end?: ProtomuxMessage } = {};
      ch.addMessage({
        onmessage: (b) => {
          const g = nfx.decodeFilesMessage(0, b);
          if (!g.ok) return;
          const { req } = g.value;
          // One write, so the three frames arrive together, before the sha256 check runs.
          mux.cork();
          out.data!.send(frame({ type: 'data', req, payload: data }));
          out.end!.send(frame({ type: 'end', req }));
          out.data!.send(frame({ type: 'data', req, payload: bytes(5, 14) }));
          mux.uncork();
        },
      });
      out.data = ch.addMessage({});
      out.end = ch.addMessage({});
      ch.addMessage({});
      ch.open();
    });
    // A hash-list fetch (a cap, not an exact size), so the late bytes are not `too-long`.
    const r = await client
      .files(V)!
      .fetch({ sha, size: 100, exact: false, sink: new MemorySink() });
    expect(r).toEqual({ ok: false, reason: 'protocol' });
    client.destroy('test over');
  });

  it('fails a fetch whose sink throws', async () => {
    const source = new MemorySource();
    const sha = source.add(V, bytes(10));
    const p = await pair(source);
    const sink = {
      write(): void {
        throw new Error('disk full');
      },
    };
    expect(await p.client.files(V)!.fetch({ sha, size: 10, sink })).toEqual({
      ok: false,
      reason: 'sink',
    });
  });
});

describe('liveness (short intervals in place of 25 s and 60 s)', () => {
  it('keeps an idle connection open with keepalives', async () => {
    const p = await pair(new MemorySource(), { keepAliveMs: 40, idleTimeoutMs: 200 });
    await new Promise((r) => setTimeout(r, 700));
    expect(p.server.closed).toBe(false);
    expect(p.client.closed).toBe(false);
  });

  it('closes a connection that has been silent for the idle timeout', async () => {
    const s = await streamPair();
    let reason = '';
    const server = new NfxConnection(s.server, {
      serve: { source: new MemorySource() },
      limits: { keepAliveMs: 40, idleTimeoutMs: 200 },
      onClose: (why) => {
        reason = why;
      },
    });
    // The watcher never writes and sends no keepalives.
    await closedOf(s.server);
    expect(server.closed).toBe(true);
    expect(reason).not.toBe('');
    s.client.destroy();
  });
});

describe('nfx/pay/1 lane', () => {
  it('carries messages both ways within the codec rules', async () => {
    const source = new MemorySource();
    source.add(V, bytes(10));
    const p = await connectedPair({
      source,
      onPay: () => ({
        onMessage: (text, lane) => {
          lane.send(`echo:${text}`);
        },
      }),
    });
    open.push(p);
    const got: string[] = [];
    const lane = p.client.pay(V, {
      onMessage: (text) => {
        got.push(text);
      },
    })!;
    expect(await lane.opened()).toBe(true);
    expect(lane.send('{"t":"hello"}')).toEqual({ ok: true, value: true });
    await vi.waitFor(() => {
      expect(got).toEqual(['echo:{"t":"hello"}']);
    });
    expect(lane.send('two\nlines').ok).toBe(false);
    expect(lane.send('x'.repeat(nfx.MAX_PAY_MESSAGE + 1)).ok).toBe(false);
  });

  it('is rejected by a seeder in free mode', async () => {
    const source = new MemorySource();
    source.add(V, bytes(10));
    const p = await pair(source);
    const lane = p.client.pay(V, { onMessage: () => undefined })!;
    expect(await lane.opened()).toBe(false);
  });

  it('closes on a message that breaks the rules', async () => {
    const source = new MemorySource();
    source.add(V, bytes(10));
    const errors: string[] = [];
    const s = await streamPair();
    const server = new NfxConnection(s.server, {
      serve: {
        source,
        onPay: () => ({
          onMessage: () => undefined,
          onProtocolError: (why) => {
            errors.push(why);
          },
        }),
      },
    });
    const mux = Protomux.from(s.client);
    const ch = mux.createChannel({ protocol: nfx.PAY_PROTOCOL, id: V.channelId() })!;
    const msg = ch.addMessage({});
    ch.open();
    expect(await ch.fullyOpened()).toBe(true);
    msg.send(new TextEncoder().encode('a\nb'));
    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    server.destroy('test over');
  });
});

describe('connection', () => {
  it('refuses a stream whose handshake has not completed', () => {
    const fake = { remotePublicKey: null } as unknown as ConstructorParameters<
      typeof NfxConnection
    >[0];
    expect(() => new NfxConnection(fake, { crypto: nodeCrypto })).toThrow(/not open/);
  });
});
