/**
 * Slice 5e-4: the iroh `NfxFetcher` against a stand-in helper. Each fake source serves a video's
 * NFX-06 collections as nfx-node forms them (`nfxCollections`), under fake BLAKE3 hashes, with
 * the real helper's refusals: a collection past its cap is `too-large`, one of the wrong size
 * under `exact` and a file whose sha256 differs are `PoisonedError`.
 *
 * What is held: files are placed only from the hash list and playlists (never guessed), a source
 * that lies or breaks the counts is dropped for the session and the next is asked, a ticket that
 * names another node is never dialled, `busy` and a helper restart are not held against a source,
 * and `close` ends every fetch at once.
 */
import { createHash } from 'node:crypto';

import { nfx } from '@sovit/core';
import { silentLogger } from '@sovit/seeder';
import { describe, expect, it } from 'vitest';

import type { NfxIrohEndpointWire } from '../../ipc/worker-protocol.js';
import { nfxCollections } from '../iroh/collections.js';
import type { HelperDialTarget, HelperTicket } from '../iroh/helper.js';
import { HelperError, PoisonedError } from '../iroh/helper.js';
import type { IrohFetchClient } from '../nfx/iroh-fetcher.js';
import { IrohFetcher } from '../nfx/iroh-fetcher.js';
import { NfxFetchError } from '../nfx/watch.js';
import { sha256, testNfxVideo } from './helpers/nfx-video.js';
import type { TestNfxVideo } from './helpers/nfx-video.js';

const RELAY = 'https://iroh-relay.test/';
const b3 = (s: string): string => createHash('sha256').update(`blake3:${s}`).digest('hex');

interface FakeNode {
  /** Collection id → its members' sha256, as served (tests may break them). */
  readonly collections: Map<string, string[]>;
  /** sha256 → the bytes served under it (tests may swap them). */
  readonly blobs: Map<string, Uint8Array>;
  unreachable?: boolean;
  /** Ticket node per collection, when a test wants it to name another node. */
  readonly ticketNode?: Map<string, string>;
}

interface Calls {
  readonly dial: string[];
  readonly getSeq: { node: string; id: string; maxMembers: number; exact: boolean }[];
  readonly getFile: { node: string; sha: string }[];
  readonly hangup: number[];
}

/** A stand-in helper serving `nodes`; tickets are `blob<node>-<id>` strings. */
class FakeClient implements IrohFetchClient {
  readonly calls: Calls = { dial: [], getSeq: [], getFile: [], hangup: [] };
  generation = 1;
  private next = 1;
  private readonly conns = new Map<number, { node: string; generation: number }>();
  /** Fail the next `n` gets with `busy`, or hold every get until released. */
  busyGets = 0;
  hold: Promise<void> | null = null;

  constructor(readonly nodes: Map<string, FakeNode>) {}

  ticket(t: string): Promise<HelperTicket> {
    const m = /^blob([0-9a-f]{64})-(.+)$/.exec(t);
    if (m === null) return Promise.reject(new HelperError('bad-request', 'not a ticket'));
    const [, node = '', id = ''] = m;
    const owner = this.nodes.get(node)?.ticketNode?.get(id) ?? node;
    return Promise.resolve({
      node: owner,
      hash: b3(`${node}/${id}`),
      format: 'hash_seq',
      relays: [RELAY, 'https://elsewhere.test/'],
      addrs: ['192.0.2.1:1'],
    });
  }

  dial(target: HelperDialTarget): Promise<number> {
    this.calls.dial.push(target.node);
    if (target.relays.some((r) => r !== RELAY))
      return Promise.reject(new Error('a relay the network does not run was dialled'));
    if (this.nodes.get(target.node)?.unreachable === true)
      return Promise.reject(new HelperError('dial-failed', 'no route'));
    const id = this.next++;
    this.conns.set(id, { node: target.node, generation: this.generation });
    return Promise.resolve(id);
  }

  async getSeq(
    conn: number,
    hash: string,
    opts: { readonly maxMembers: number; readonly exact?: boolean },
  ): Promise<string[]> {
    const { node, fake } = this.conn(conn);
    const id = [...fake.collections.keys()].find((k) => b3(`${node}/${k}`) === hash);
    this.calls.getSeq.push({
      node,
      id: id ?? '?',
      maxMembers: opts.maxMembers,
      exact: opts.exact === true,
    });
    await this.gate();
    const members = id === undefined ? undefined : fake.collections.get(id);
    if (members === undefined) throw new HelperError('transfer-failed', 'no such collection');
    if (members.length > opts.maxMembers) throw new HelperError('too-large', 'past the cap');
    if (opts.exact === true && members.length !== opts.maxMembers)
      throw new PoisonedError('a collection of the wrong size');
    return members.map((m) => b3(m));
  }

  async getFile(
    conn: number,
    hash: string,
    expect: { readonly sha256: string; readonly maxBytes: number },
  ): Promise<Uint8Array> {
    const { node, fake } = this.conn(conn);
    const sha = [...fake.blobs.keys()].find((k) => b3(k) === hash);
    this.calls.getFile.push({ node, sha: sha ?? '?' });
    await this.gate();
    const bytes = sha === undefined ? undefined : fake.blobs.get(sha);
    if (bytes === undefined) throw new HelperError('transfer-failed', 'no such blob');
    if (bytes.length > expect.maxBytes) throw new HelperError('too-large', 'past the cap');
    if (sha256(bytes) !== expect.sha256) throw new PoisonedError('sha256');
    return bytes;
  }

  hangup(conn: number): Promise<boolean> {
    this.calls.hangup.push(conn);
    return Promise.resolve(this.conns.delete(conn));
  }

  private conn(conn: number): { node: string; fake: FakeNode } {
    const c = this.conns.get(conn);
    if (c?.generation !== this.generation) throw new HelperError('no-conn', 'no such connection');
    const fake = this.nodes.get(c.node);
    if (fake === undefined) throw new HelperError('no-conn', 'no such node');
    return { node: c.node, fake };
  }

  private async gate(): Promise<void> {
    if (this.busyGets > 0) {
      this.busyGets--;
      throw new HelperError('busy', 'too many requests at once');
    }
    await this.hold;
  }
}

const NODE_A = 'a1'.repeat(32);
const NODE_B = 'b2'.repeat(32);

/** A node that serves `v` honestly: every collection, every file. */
function honest(v: TestNfxVideo): FakeNode {
  const listBytes = v.files.get(v.root);
  const list = listBytes && nfx.verifyHashList(listBytes, v.root, video(v), BigInt(v.segs));
  if (list?.ok !== true) throw new Error('bad test video');
  const cols = nfxCollections(v.root, list.value, (s) => v.files.get(s));
  if (!cols.ok) throw new Error('bad test collections');
  return {
    collections: new Map(cols.value.map((c) => [c.id, [...c.members]])),
    blobs: new Map(v.files),
  };
}

function video(v: TestNfxVideo): nfx.VideoAddr {
  const a = nfx.VideoAddr.parse(v.video);
  if (!a.ok) throw new Error('bad test address');
  return a.value;
}

function endpoint(
  node: string,
  ids: readonly string[] = ['meta', '720p', '360p'],
): NfxIrohEndpointWire {
  return {
    t: 'iroh',
    node,
    relay: '',
    addrs: [],
    tickets: { $map: ids.map((id) => [id, `blob${node}-${id}`] as const) },
  };
}

function fetcher(
  v: TestNfxVideo,
  client: FakeClient | null,
  endpoints: readonly NfxIrohEndpointWire[],
): IrohFetcher {
  return new IrohFetcher({
    video: video(v),
    root: v.root,
    segs: v.segs,
    endpoints,
    client: () => Promise.resolve(client),
    generation: () => client?.generation ?? 0,
    networkRelays: () => [RELAY],
    logger: silentLogger,
    busyDelaysMs: [0, 0, 0],
    sleep: () => Promise.resolve(),
  });
}

/** The files a session asks for, in its order: the list, 720p's playlist, the init, segments. */
function plan(v: TestNfxVideo): { sha: string; size: number; exact: boolean }[] {
  const listBytes = v.files.get(v.root)!;
  const list = nfx.verifyHashList(listBytes, v.root, video(v), BigInt(v.segs));
  if (!list.ok) throw new Error('bad test video');
  const pl = list.value.files.find((f) => f.name === 'playlist-720p.m3u8')!;
  const init = list.value.files.find((f) => f.role === 'init')!;
  return [
    { sha: v.root, size: nfx.MAX_HASH_LIST_BYTES, exact: false },
    { sha: pl.sha256, size: Number(pl.size), exact: true },
    { sha: init.sha256, size: Number(init.size), exact: true },
    ...v.segmentShas.map((s) => ({ sha: s, size: v.files.get(s)!.length, exact: true })),
  ];
}

const reasonsOf = async (p: Promise<unknown>): Promise<readonly string[]> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof NfxFetchError) return err.reasons;
    throw err;
  }
  throw new Error('it did not fail');
};

describe('slice 5e-4: IrohFetcher', () => {
  it('fetches a whole video, placing each file from the hash list and the playlist', async () => {
    const v = testNfxVideo();
    const c = new FakeClient(new Map([[NODE_A, honest(v)]]));
    const f = fetcher(v, c, [endpoint(NODE_A)]);
    for (const p of plan(v)) expect(sha256(await f.fetch(p.sha, p.size, p.exact))).toBe(p.sha);
    // One connection; each collection fetched once, `meta` capped, the rendition exactly.
    expect(c.calls.dial).toEqual([NODE_A]);
    expect(c.calls.getSeq.map((g) => [g.id, g.maxMembers, g.exact])).toEqual([
      ['meta', v.segs + 1, false],
      ['720p', 1 + v.segmentShas.length, true],
    ]);
    await f.close();
    expect(c.calls.hangup).toEqual([1]);
  });

  it('never guesses: a file it cannot place yet fails `unmapped`, before asking anyone', async () => {
    const v = testNfxVideo();
    const c = new FakeClient(new Map([[NODE_A, honest(v)]]));
    const f = fetcher(v, c, [endpoint(NODE_A)]);
    const seg = v.segmentShas[0]!;
    expect(await reasonsOf(f.fetch(seg, v.files.get(seg)!.length, true))).toEqual(['unmapped']);
    expect(c.calls.dial).toEqual([]);
  });

  it('places files from what another transport fetched (learn)', async () => {
    const v = testNfxVideo();
    const c = new FakeClient(new Map([[NODE_A, honest(v)]]));
    const f = fetcher(v, c, [endpoint(NODE_A)]);
    const [list, playlist, init] = plan(v);
    f.learn(list!.sha, v.files.get(list!.sha)!);
    f.learn(playlist!.sha, v.files.get(playlist!.sha)!);
    // Neither the list nor the playlist is fetched over iroh: only 720p's collection.
    expect(sha256(await f.fetch(init!.sha, init!.size, true))).toBe(init!.sha);
    expect(c.calls.getSeq.map((g) => g.id)).toEqual(['720p']);
  });

  it('a hash list that does not verify places nothing', async () => {
    const v = testNfxVideo();
    const c = new FakeClient(new Map([[NODE_A, honest(v)]]));
    const f = fetcher(v, c, [endpoint(NODE_A)]);
    f.learn(v.root, new TextEncoder().encode('{"v":1}'));
    const seg = v.segmentShas[0]!;
    expect(await reasonsOf(f.fetch(seg, v.files.get(seg)!.length, true))).toEqual(['unmapped']);
  });

  it('drops a source that serves bytes the hash list contradicts, and asks the next', async () => {
    const v = testNfxVideo();
    const liar = honest(v);
    const [s0, s1] = v.segmentShas;
    liar.blobs.set(s0!, v.files.get(s1!)!);
    const c = new FakeClient(
      new Map([
        [NODE_A, liar],
        [NODE_B, honest(v)],
      ]),
    );
    const f = fetcher(v, c, [endpoint(NODE_A), endpoint(NODE_B)]);
    const steps = plan(v);
    for (const p of steps) expect(sha256(await f.fetch(p.sha, p.size, p.exact))).toBe(p.sha);
    // A served the list, playlist and init, lied about segment 0, and was never asked again.
    const fromA = c.calls.getFile.filter((g) => g.node === NODE_A).map((g) => g.sha);
    expect(fromA).toEqual([steps[0]!.sha, steps[1]!.sha, steps[2]!.sha, s0]);
  });

  it('drops a source whose meta collection turns out the wrong size once the list is known', async () => {
    const v = testNfxVideo();
    const padded = honest(v);
    padded.collections.get('meta')!.push(v.segmentShas[0]!);
    const c = new FakeClient(
      new Map([
        [NODE_A, padded],
        [NODE_B, honest(v)],
      ]),
    );
    const f = fetcher(v, c, [endpoint(NODE_A), endpoint(NODE_B)]);
    const [list, playlist] = plan(v);
    expect(sha256(await f.fetch(list!.sha, list!.size, false))).toBe(list!.sha);
    expect(sha256(await f.fetch(playlist!.sha, playlist!.size, true))).toBe(playlist!.sha);
    expect(c.calls.getFile.map((g) => g.node)).toEqual([NODE_A, NODE_B]);
  });

  it('drops a source whose rendition collection is the wrong size', async () => {
    const v = testNfxVideo();
    const short = honest(v);
    short.collections.get('720p')!.pop();
    const c = new FakeClient(
      new Map([
        [NODE_A, short],
        [NODE_B, honest(v)],
      ]),
    );
    const f = fetcher(v, c, [endpoint(NODE_A), endpoint(NODE_B)]);
    for (const p of plan(v)) expect(sha256(await f.fetch(p.sha, p.size, p.exact))).toBe(p.sha);
    const fromA = c.calls.getFile.filter((g) => g.node === NODE_A);
    expect(fromA).toHaveLength(2);
  });

  it('never dials a ticket that names another node, nor a relay the network does not run', async () => {
    const v = testNfxVideo();
    const other = honest(v);
    const pointed: FakeNode = { ...other, ticketNode: new Map([['meta', NODE_B]]) };
    const c = new FakeClient(
      new Map([
        [NODE_A, pointed],
        [NODE_B, honest(v)],
      ]),
    );
    // A's meta ticket names B: A is dropped without a dial (B's node is never dialled for it).
    const f = fetcher(v, c, [endpoint(NODE_A)]);
    const [list] = plan(v);
    expect(await reasonsOf(f.fetch(list!.sha, list!.size, false))).toEqual(['bad-ticket']);
    expect(c.calls.dial).toEqual([]);
    // The FakeClient refuses a dial with any relay but the network's: every dial above passed.
  });

  it('skips a source without a ticket for the collection, without dropping it', async () => {
    const v = testNfxVideo();
    const c = new FakeClient(
      new Map([
        [NODE_A, honest(v)],
        [NODE_B, honest(v)],
      ]),
    );
    const f = fetcher(v, c, [endpoint(NODE_A, ['meta', '360p']), endpoint(NODE_B)]);
    for (const p of plan(v)) expect(sha256(await f.fetch(p.sha, p.size, p.exact))).toBe(p.sha);
    // A kept serving `meta` (list, playlist); 720p's files came from B.
    const fromA = c.calls.getFile.filter((g) => g.node === NODE_A);
    expect(fromA).toHaveLength(2);
  });

  it('an unreachable source is dropped; with none left the reasons say why', async () => {
    const v = testNfxVideo();
    const c = new FakeClient(new Map([[NODE_A, { ...honest(v), unreachable: true }]]));
    const f = fetcher(v, c, [endpoint(NODE_A)]);
    const [list] = plan(v);
    expect(await reasonsOf(f.fetch(list!.sha, list!.size, false))).toEqual(['unreachable']);
    expect(await reasonsOf(f.fetch(list!.sha, list!.size, false))).toEqual([]);
    expect(c.calls.dial).toEqual([NODE_A]);
  });

  it('`busy` is retried, and past the retries not held against the source', async () => {
    const v = testNfxVideo();
    const c = new FakeClient(new Map([[NODE_A, honest(v)]]));
    const f = fetcher(v, c, [endpoint(NODE_A)]);
    const [list, playlist] = plan(v);
    c.busyGets = 2;
    expect(sha256(await f.fetch(list!.sha, list!.size, false))).toBe(list!.sha);
    c.busyGets = 100;
    expect(await reasonsOf(f.fetch(playlist!.sha, playlist!.size, true))).toEqual(['busy']);
    c.busyGets = 0;
    expect(sha256(await f.fetch(playlist!.sha, playlist!.size, true))).toBe(playlist!.sha);
  });

  it('a restarted helper is dialled again, once, without dropping the source', async () => {
    const v = testNfxVideo();
    const c = new FakeClient(new Map([[NODE_A, honest(v)]]));
    const f = fetcher(v, c, [endpoint(NODE_A)]);
    const [list, playlist] = plan(v);
    await f.fetch(list!.sha, list!.size, false);
    c.generation++;
    expect(sha256(await f.fetch(playlist!.sha, playlist!.size, true))).toBe(playlist!.sha);
    expect(c.calls.dial).toEqual([NODE_A, NODE_A]);
  });

  it('without a helper it says `iroh-off`', async () => {
    const v = testNfxVideo();
    const f = fetcher(v, null, [endpoint(NODE_A)]);
    expect(await reasonsOf(f.fetch(v.root, nfx.MAX_HASH_LIST_BYTES, false))).toEqual(['iroh-off']);
  });

  it('close ends a fetch in flight at once and hangs up', async () => {
    const v = testNfxVideo();
    const c = new FakeClient(new Map([[NODE_A, honest(v)]]));
    const f = fetcher(v, c, [endpoint(NODE_A)]);
    c.hold = new Promise(() => undefined);
    const pending = reasonsOf(f.fetch(v.root, nfx.MAX_HASH_LIST_BYTES, false));
    await new Promise((r) => setTimeout(r, 10));
    await f.close();
    expect(await pending).toEqual(['closed']);
    expect(c.calls.hangup).toEqual([1]);
    expect(await reasonsOf(f.fetch(v.root, nfx.MAX_HASH_LIST_BYTES, false))).toEqual(['closed']);
  });
});
