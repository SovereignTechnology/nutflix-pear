/**
 * Slice 5e-3 (ADR 0021): the worker seeds a stored NFX video over iroh (NFX-06) through the REAL
 * helper (`NUTFLIX_IROH_HELPER`, which CI builds: ci.yml's `iroh-helper` job), driven through the
 * real wire (`WorkerRpc` + the L6-0 guards). A SEPARATE helper client, spawned here with
 * node:child_process, with no relay (direct, on this host), dials the `meta` ticket and one
 * rendition's from the worker's beacon endpoint and runs NFX-06's fetch as spike S-D's harness
 * did: each collection alone first, then each member capped at its listed size and returned only
 * under the sha256 the hash list gives. Every file of the video comes back.
 *
 * Also: serving stops when NFX goes off, and a worker restarted over the same storage serves the
 * same collections from the same node id (its key is derived from the Corestore primary key).
 * The direct dials need `testIrohLocalAddrs`: without it (a user's node, NFX-18) neither the
 * beacon endpoint nor a ticket names a LAN or loopback address.
 *
 * Skipped where no helper is built (a developer's machine); FAILS in CI without one, so it can
 * never pass by being skipped.
 */
import { randomBytes } from 'node:crypto';

import type { NostrPubkey } from '@sovit/core';
import { nfx } from '@sovit/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { NfxIrohEndpointWire, WorkerEvent } from '../../ipc/worker-protocol.js';
import { devMockProviders } from '../dev/dev-mocks.js';
import type { DevTestnet } from '../dev/fixtures-net.js';
import { startDevTestnet } from '../dev/fixtures-net.js';
import { LoopbackPayHub } from '../dev/loopback-pay.js';
import { metaMembers, renditionMembers } from '../iroh/collections.js';
import { IrohHelper } from '../iroh/helper.js';
import type { WorkerClient } from './helpers/harness.js';
import { nodeHelperSpawn, sleep, startWorker, tempDir } from './helpers/harness.js';
import { testNfxVideo } from './helpers/nfx-video.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const HELPER = process.env['NUTFLIX_IROH_HELPER'] ?? '';
const IN_CI = (process.env['CI'] ?? '') !== '';
const MISSING =
  'NUTFLIX_IROH_HELPER names no iroh helper: CI builds one for this (ci.yml, the iroh-helper job)';
const SEEDER = 'ab'.repeat(32) as NostrPubkey;
/** How long the worker may take to import and ticket the video. */
const SERVE_WITHIN_MS = 60_000;

type LogEvent = Extract<WorkerEvent, { e: 'log' }>;
const logs = (w: WorkerClient): string =>
  w.events
    .filter((e): e is LogEvent => e.e === 'log')
    .map((e) => `${e.level}: ${e.msg}`)
    .join('\n');

describe.skipIf(HELPER === '' && !IN_CI)('slice 5e-3: NFX seeding over iroh', () => {
  const teardown: (() => Promise<void>)[] = [];
  const v = testNfxVideo();
  const label = `iroh-${randomBytes(4).toString('hex')}`;
  let testnet: DevTestnet;
  let hub: LoopbackPayHub;
  let storage: string;
  /** The one worker over `storage` (it holds the Corestore): a new one closes it first. */
  let current: WorkerClient | null = null;

  beforeAll(async () => {
    testnet = await startDevTestnet();
    teardown.push(() => testnet.destroy());
    hub = new LoopbackPayHub();
    const d = await tempDir('nf-iroh-worker-');
    storage = d.dir;
    teardown.push(() => d.rm());
  });
  afterAll(async () => {
    await current?.close();
    for (const t of teardown.splice(0).reverse()) await t().catch(() => undefined);
  });

  /**
   * A worker with (mock) payment providers, so with a seeder; seeding and NFX on, the helper
   * given, and the test video in its NFX store (a put of a stored video is a no-op). Its tickets
   * name this host's local addresses unless `localAddrs` is false (the client dials directly).
   */
  async function start(localAddrs = true): Promise<WorkerClient> {
    await current?.close();
    const w = startWorker({
      hub,
      logLevel: 'info',
      testBootstrap: testnet.bootstrap,
      providers: () => devMockProviders({ hub, label }),
      testIrohLocalAddrs: localAddrs,
    });
    current = w;
    await w.call('init', {
      v: 1,
      storage,
      seeding: { enabled: true, diskCapBytes: 1024 ** 3 },
      prefetchSeconds: 30,
      nfx: { enabled: true, irohRelays: [] },
      irohHelper: HELPER,
    });
    await w.event((e): e is Extract<WorkerEvent, { e: 'ready' }> => e.e === 'ready', 10_000);
    const seeder = w.host.internals.seeder;
    if (seeder === null) throw new Error('the worker has no seeder');
    const put = await seeder.nfx.putVideo({
      video: addr(),
      root: v.root,
      segs: BigInt(v.segs),
      hashListBytes: v.files.get(v.root)!,
      read: (e) => Promise.resolve(v.files.get(e.sha256)!),
    });
    expect(put.ok).toBe(true);
    return w;
  }

  function addr(): nfx.VideoAddr {
    const a = nfx.VideoAddr.parse(v.video);
    if (!a.ok) throw new Error('bad test video');
    return a.value;
  }

  /** The beacon's iroh endpoint once the worker serves the video (asking is what drives it). */
  async function irohEndpoint(w: WorkerClient): Promise<NfxIrohEndpointWire> {
    const deadline = Date.now() + SERVE_WITHIN_MS;
    for (;;) {
      const r = await w.call('nfx.endpoint', { seeder: SEEDER, video: v.video });
      if (r.iroh !== null) return r.iroh;
      if (Date.now() > deadline)
        throw new Error(`no iroh endpoint in time; the worker said:\n${logs(w)}`);
      await sleep(250);
    }
  }

  async function client(): Promise<IrohHelper> {
    const d = await tempDir('nf-iroh-client-');
    teardown.push(() => d.rm());
    const c = new IrohHelper({
      spawn: nodeHelperSpawn,
      file: HELPER,
      stateDir: d.dir,
      // No relay: direct addresses only, on this host.
      init: { relays: [] },
      restart: false,
    });
    teardown.push(() => c.close());
    await c.start();
    return c;
  }

  it('serves every file of a stored video over iroh, each under its hash-list sha256', async () => {
    expect(HELPER, MISSING).not.toBe('');
    const w = await start();
    const ep = await irohEndpoint(w);
    expect(ep.node).toMatch(/^[0-9a-f]{64}$/);
    // No relay in this network: none is named.
    expect(ep.relay).toBe('');
    const tickets = new Map(ep.tickets.$map);
    expect([...tickets.keys()].sort()).toEqual(['360p', '720p', 'meta']);

    const c = await client();
    const conns: number[] = [];
    const open = async (id: string): Promise<{ conn: number; hash: string }> => {
      const ticket = tickets.get(id);
      if (ticket === undefined) throw new Error(`no ${id} ticket`);
      const dialed = await c.dialTicket(ticket, ep.node, []);
      if (dialed === null) throw new Error(`the ${id} ticket names another node or no collection`);
      conns.push(dialed.conn);
      return dialed;
    };
    const got = new Map<string, Uint8Array>();
    try {
      // `meta`: the collection alone, capped at one member per listed file plus the hash list.
      const meta = await open('meta');
      const members = await c.getSeq(meta.conn, meta.hash, { maxMembers: v.segs + 1 });
      const listBytes = await c.getFile(meta.conn, members[0]!, {
        sha256: v.root,
        maxBytes: nfx.MAX_HASH_LIST_BYTES,
      });
      const verified = nfx.verifyHashList(listBytes, v.root, addr(), BigInt(v.segs));
      if (!verified.ok) throw new Error(verified.error.reason);
      const list = verified.value;
      got.set(v.root, listBytes);
      const sizeOf = (s: string): number =>
        Number(list.files.find((f) => f.sha256 === s)?.size ?? 0n);
      const expected = metaMembers(v.root, list);
      expect(members).toHaveLength(expected.length);
      for (let i = 1; i < expected.length; i++) {
        const s = expected[i]!;
        got.set(s, await c.getFile(meta.conn, members[i]!, { sha256: s, maxBytes: sizeOf(s) }));
      }

      // One rendition, ordered by its playlist (which came with `meta`).
      const rendition = list.renditions.find((r) => r.id === '720p')!;
      const playlist = list.files.find((f) => f.name === rendition.playlist)!;
      const want = renditionMembers(list, got.get(playlist.sha256)!);
      if (!want.ok) throw new Error(want.error.reason);
      const at = await open('720p');
      const seq = await c.getSeq(at.conn, at.hash, { maxMembers: want.value.length, exact: true });
      for (const [i, s] of want.value.entries())
        got.set(s, await c.getFile(at.conn, seq[i]!, { sha256: s, maxBytes: sizeOf(s) }));
    } finally {
      for (const conn of conns) await c.hangup(conn).catch(() => false);
    }

    // Every file of the video, byte for byte (`getFile` returns bytes only under their sha256).
    expect([...got.keys()].sort()).toEqual([...v.files.keys()].sort());
    for (const [s, bytes] of v.files)
      expect(Buffer.from(got.get(s)!).equals(Buffer.from(bytes)), s).toBe(true);

    // NFX off: the helper goes, and no beacon names an iroh endpoint.
    await w.call('nfx.configure', { enabled: false, irohRelays: [] });
    expect((await w.call('nfx.endpoint', { seeder: SEEDER, video: v.video })).iroh).toBeNull();
  });

  it('a restarted worker serves the same collections from the same node id', async () => {
    expect(HELPER, MISSING).not.toBe('');
    const before = await start();
    const first = await irohEndpoint(before);
    // `start` closes it first: the next worker opens the same storage.
    const after = await start();
    const second = await irohEndpoint(after);
    expect(second.node).toBe(first.node);
    // The same files make the same collections; only the tickets' addresses may differ.
    const c = await client();
    const hashes = async (ep: NfxIrohEndpointWire): Promise<Map<string, string>> => {
      const out = new Map<string, string>();
      for (const [id, ticket] of ep.tickets.$map) {
        const t = await c.ticket(ticket);
        expect(t.node).toBe(ep.node);
        expect(t.format).toBe('hash_seq');
        out.set(id, t.hash);
      }
      return out;
    };
    expect(await hashes(second)).toEqual(await hashes(first));
  });

  it("NFX-18: a user's node names no LAN or loopback address in its endpoint or tickets", async () => {
    expect(HELPER, MISSING).not.toBe('');
    const ep = await irohEndpoint(await start(false));
    const c = await client();
    const named = [...ep.addrs];
    for (const [, ticket] of ep.tickets.$map) named.push(...(await c.ticket(ticket)).addrs);
    expect(named.filter(notGlobal)).toEqual([]);
    // With the switch (every other test here) the direct dials above work.
  });
});

/**
 * IPv4 outside global unicast: `rtc/candidates.rs` `v4_global`, negated, range by range.
 */
function v4NotGlobal(host: string): boolean {
  const [a = 0, b = 0, c = 0] = host.split('.').map(Number);
  return (
    a === 0 || // "this network"
    a === 10 || // private
    (a === 100 && b >= 64 && b < 128) || // shared address space (CGNAT, tailnets)
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b < 32) || // private
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // documentation
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // documentation
    (a === 203 && b === 0 && c === 113) || // documentation
    a >= 224 // multicast, reserved, broadcast
  );
}

/** An IPv6 address's eight segments (any textual form, dotted tail included). */
function v6Segments(host: string): number[] {
  const n = new URL(`http://[${host}]`).hostname.slice(1, -1); // canonical: hex only
  const [head = '', tail] = n.split('::');
  const h = head === '' ? [] : head.split(':');
  const t = tail === undefined || tail === '' ? [] : tail.split(':');
  const fill = tail === undefined ? [] : Array<string>(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((x) => parseInt(x, 16));
}

/**
 * `ip:port` or `[ip6]:port` that the helper's rule (`rtc/candidates.rs` `allowed`, private
 * addresses not allowed) rejects: outside IPv4 global unicast (an IPv4-mapped IPv6 address by
 * the IPv4 rule, as `allowed` maps it) or outside 2000::/3 less its documentation prefixes.
 */
function notGlobal(addr: string): boolean {
  const host = addr.startsWith('[') ? addr.slice(1, addr.indexOf(']')) : addr.split(':')[0]!;
  if (!host.includes(':')) return v4NotGlobal(host);
  const s = v6Segments(host);
  if (s.slice(0, 5).every((x) => x === 0) && s[5] === 0xffff)
    return v4NotGlobal(`${s[6]! >> 8}.${s[6]! & 255}.${s[7]! >> 8}.${s[7]! & 255}`);
  const s0 = s[0]!;
  return !(
    (s0 & 0xe000) === 0x2000 &&
    !(s0 === 0x2001 && s[1] === 0x0db8) &&
    (s0 & 0xfff0) !== 0x3ff0
  );
}

describe("notGlobal, the test's copy of candidates::allowed", () => {
  it('rejects what the helper rejects and keeps what it keeps', () => {
    const rejected = [
      '0.1.2.3:1',
      '10.0.0.1:1',
      '100.64.0.3:1',
      '127.0.0.1:1',
      '169.254.169.254:1',
      '172.16.0.1:1',
      '192.0.0.1:1234',
      '192.0.2.1:1',
      '192.168.8.1:1',
      '198.18.0.1:1234',
      '198.19.255.255:1',
      '198.51.100.7:1',
      '203.0.113.9:1',
      '224.0.0.1:1',
      '255.255.255.255:1',
      '[::1]:1',
      '[::]:1',
      '[fe80::1]:1',
      '[fd00::1]:1',
      '[2001:db8::1]:1',
      '[3ff0::1]:1',
      '[3fff:ffff::1]:1',
      '[::ffff:192.168.1.1]:1',
      '[::ffff:a00:1]:1',
      '[ff02::1]:1',
    ];
    const kept = [
      '1.1.1.1:1',
      '8.8.8.8:443',
      '100.63.255.255:1',
      '100.128.0.1:1',
      '172.32.0.1:1',
      '192.0.1.1:1',
      '198.20.0.1:1',
      '203.0.114.1:1',
      '223.255.255.255:1',
      '[2606:4700::1111]:1',
      '[2001:db9::1]:1',
      '[3fef::1]:1',
      '[::ffff:8.8.8.8]:1',
    ];
    expect(rejected.filter((a) => !notGlobal(a))).toEqual([]);
    expect(kept.filter(notGlobal)).toEqual([]);
  });
});
