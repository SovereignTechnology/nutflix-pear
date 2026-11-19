/**
 * Pear #123 (ADR 0024): the worker's side of stats for nerds, without a network.
 *
 * - Addresses take one form (`a.b.c.d:port`, `[v6]:port`, lowercase, no scope) or none (`''`),
 *   whatever a transport hands over.
 * - `HyperdhtFetcher` counts per seeder what it delivered to this session, says whether its
 *   connection is open, and reads a connection's remote end only when asked.
 * - Sources are ranked open first, then by bytes, at most 64.
 */
import type { PlaySourceStat } from '@sovit/core';
import { nfx } from '@sovit/core';
import { silentLogger, toHex } from '@sovit/seeder';
import { describe, expect, it } from 'vitest';

import type { NfxFetchOutcome, NfxPeerLease, NfxPeerPool } from '../nfx/hyperdht-fetcher.js';
import { HyperdhtFetcher } from '../nfx/hyperdht-fetcher.js';
import { rankSources } from '../nfx/watching.js';
import { hostPort, socketAddr, streamRemote } from '../net/remote-addr.js';

describe('pear #123: addresses as stats for nerds shows them', () => {
  it('hostPort: one form for v4 and v6, or nothing', () => {
    expect(hostPort('192.0.2.7', 4433)).toBe('192.0.2.7:4433');
    expect(hostPort('2001:DB8::7', 1)).toBe('[2001:db8::7]:1');
    expect(hostPort('[fe80::1%eth0]', 65535)).toBe('[fe80::1]:65535');
    expect(hostPort('::ffff:192.0.2.7', 80)).toBe('[::ffff:192.0.2.7]:80');
    for (const [h, p] of [
      ['192.0.2.256', 1],
      ['192.0.2', 1],
      ['peer.example', 1],
      ['', 1],
      ['192.0.2.7', 0],
      ['192.0.2.7', 65536],
      ['192.0.2.7', 1.5],
      ['192.0.2.7', '1'],
      [null, 1],
      ['1'.repeat(65), 1],
      ['zz::1', 1],
    ] as const)
      expect(hostPort(h, p), `${String(h)} ${String(p)}`).toBe('');
  });

  it('socketAddr: as Rust prints a SocketAddr', () => {
    expect(socketAddr('192.0.2.7:4433')).toBe('192.0.2.7:4433');
    expect(socketAddr('[2001:db8::7%2]:4433')).toBe('[2001:db8::7]:4433');
    for (const s of ['192.0.2.7', 'peer:1', '[::1]', '[::1]:', 1, null, `${'1.'.repeat(40)}1:1`])
      expect(socketAddr(s), String(s)).toBe('');
  });

  it('streamRemote: a secret-stream’s UDX raw stream, read defensively', () => {
    expect(streamRemote({ rawStream: { remoteHost: '198.51.100.2', remotePort: 49737 } })).toBe(
      '198.51.100.2:49737',
    );
    expect(streamRemote({ rawStream: null })).toBe('');
    expect(streamRemote({ rawStream: { remoteHost: null, remotePort: 0 } })).toBe('');
    expect(streamRemote(null)).toBe('');
    const hostile = {
      get rawStream(): never {
        throw new Error('no');
      },
    };
    expect(streamRemote(hostile)).toBe('');
  });
});

describe('pear #123: rankSources', () => {
  const s = (id: string, bytesDown: number, connected: boolean): PlaySourceStat => ({
    kind: 'webrtc',
    id,
    via: 'nostr',
    bytesDown,
    bytesUp: 0,
    files: 0,
    connected,
  });

  it('open ones first, then the most bytes, at most 64', () => {
    expect(
      rankSources([s('a', 5, false), s('b', 1, true), s('c', 9, false), s('d', 3, true)]).map(
        (x) => x.id,
      ),
    ).toEqual(['d', 'b', 'c', 'a']);
    const many = Array.from({ length: 70 }, (_, i) => s(`p${String(i)}`, i, false));
    const ranked = rankSources(many);
    expect(ranked).toHaveLength(64);
    expect(ranked[0]?.id).toBe('p69');
  });
});

/** A stand-in pool: per peer, what each fetch answers and where its connection goes. */
class FakePool {
  readonly released: string[] = [];
  readonly open = new Map<string, boolean>();
  readonly remotes = new Map<string, string>();
  constructor(private readonly answer: (peer: string, sha: string) => NfxFetchOutcome) {}

  acquire(_namespace: string, key: Uint8Array): NfxPeerLease {
    const peer = toHex(key);
    return {
      fetch: (_video, sha) => Promise.resolve(this.answer(peer, sha)),
      release: () => {
        this.released.push(peer);
      },
      open: () => this.open.get(peer) ?? true,
      established: () => this.open.get(peer) ?? true,
      remote: () => this.remotes.get(peer) ?? '',
    };
  }
}

describe('pear #123: HyperdhtFetcher', () => {
  const parsed = nfx.VideoAddr.parse('nfx:testnet:1:nutflix-' + 'c'.repeat(32));
  if (!parsed.ok) throw new Error('bad test address');
  const video = parsed.value;
  const A = new Uint8Array(32).fill(0xa1);
  const B = new Uint8Array(32).fill(0xb2);
  const C = new Uint8Array(32).fill(0xc3);
  const bytes = new Uint8Array([1, 2, 3, 4]);

  function fetcher(pool: FakePool, peers: readonly Uint8Array[]): HyperdhtFetcher {
    return new HyperdhtFetcher({
      pool: pool as unknown as NfxPeerPool,
      video,
      peers,
      logger: silentLogger,
    });
  }

  it('counts what each seeder delivered, its refusals, and whether it is open', async () => {
    // A lacks the files, B serves a wrong size once (dropped), C serves.
    const pool = new FakePool((peer, sha) => {
      if (peer === toHex(A)) return { ok: false, reason: 'missing' };
      if (peer === toHex(B)) return { ok: true, bytes: new Uint8Array(9) };
      return sha === 'x' ? { ok: true, bytes } : { ok: false, reason: 'missing' };
    });
    const f = fetcher(pool, [A, B, C]);
    expect(f.stats()).toEqual({ sources: [], refused: 0 });
    expect(await f.fetch('x', 4, true)).toBe(bytes);
    await expect(f.fetch('y', 4, true)).rejects.toMatchObject({
      reasons: ['missing', 'dropped', 'missing'],
    });
    const row = (key: Uint8Array, n: number, files: number, connected: boolean): unknown => ({
      kind: 'hyperdht',
      id: toHex(key),
      via: 'beacon',
      bytesDown: n,
      bytesUp: 0,
      files,
      connected,
    });
    expect(f.stats()).toEqual({
      sources: [row(A, 0, 0, true), row(B, 0, 0, false), row(C, 4, 1, true)],
      refused: 1,
    });
    // A connection that closed is listed, no longer open.
    pool.open.set(toHex(C), false);
    expect(f.stats().sources.at(-1)).toEqual(row(C, 4, 1, false));
    await f.close();
    expect(f.stats().sources.map((x) => x.connected)).toEqual([false, false, false]);
  });

  it('retains a connected peer whose first queued request closes, excluding failed dials', async () => {
    const pool = new FakePool(() => ({ ok: false, reason: 'closed' }));
    pool.open.set(toHex(B), false);
    const f = fetcher(pool, [A, B]);
    await expect(f.fetch('x', 4, true)).rejects.toThrow();
    expect(f.stats().sources).toMatchObject([
      { id: toHex(A), bytesDown: 0, files: 0, connected: false },
    ]);
    await f.close();
    expect(f.stats().sources).toHaveLength(1);
  });

  it('addresses are the open connections’ remote ends, read when asked', async () => {
    const pool = new FakePool(() => ({ ok: true, bytes }));
    pool.remotes.set(toHex(A), '198.51.100.2:49737');
    const f = fetcher(pool, [A, B, C]);
    // No lease yet: no connection to read.
    expect(await f.addresses()).toEqual([]);
    await f.fetch('x', 4, true);
    expect(await f.addresses()).toEqual([
      { kind: 'hyperdht', id: toHex(A), address: '198.51.100.2:49737', path: 'direct' },
    ]);
    pool.remotes.delete(toHex(A));
    expect(await f.addresses()).toEqual([
      { kind: 'hyperdht', id: toHex(A), address: '', path: 'unknown' },
    ]);
    await f.close();
    expect(await f.addresses()).toEqual([]);
    expect(pool.released).toEqual([toHex(A)]);
  });
});
