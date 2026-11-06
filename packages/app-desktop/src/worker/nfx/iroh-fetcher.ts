/**
 * An `NfxFetcher` over iroh (NFX-06, ADR 0021, slice 5e-4): whole files from the iroh endpoints a
 * host found in verified beacons, through the worker's WATCHING helper (`./iroh.ts`, an ephemeral
 * node that is never the serving one), tried in the order given. It is how this app watches a
 * seeder that speaks iroh only (nfxd), as spike S-D's `spikes/iroh/nfx06.mjs` did.
 *
 * - **Files are asked for by sha256, served by position.** A beacon's tickets name collections
 *   (NFX-06 §2): `meta` (the hash list, then the other non-media files) and one per rendition
 *   (its init, then its segments in its playlist's order). The fetcher learns where each sha256
 *   sits as the files pass: the hash list (the manifest `root`, `meta` member 0) gives `meta`'s
 *   members (`metaMembers`), and each playlist gives its rendition's (`renditionMembers`). A file
 *   it cannot place yet fails `unmapped`: never a guess. `learn` takes files another transport
 *   fetched (`./fallback-fetcher.ts`), so iroh can place a segment whose playlist came over
 *   HyperDHT.
 * - **The peer's word is never taken for the bytes.** A collection's members are its BLAKE3
 *   hashes, good only for asking; `getFile` returns a file only when its sha256 is the one the
 *   signed hash list gives (NFX-05 §4; nfx ADR 0103, sharp edge 1), capped at its listed size.
 *   A collection is fetched alone first, capped at the members it may have (NFX-06 §2): `segs + 1`
 *   for `meta` before the hash list is known, then exactly as many as the list or playlist says.
 * - **A ticket must name its endpoint's node and a collection** (`dialTarget`), and only the
 *   network's relays survive from it (NFX-06 §1): another node's ticket is never dialled.
 * - **Sources.** Per source, one connection (dialled from the first ticket used) and one fetch of
 *   each collection, both cached. A source that cannot be reached, stalls, sends what the hash
 *   list contradicts or a collection of the wrong size, or whose ticket is bad, is dropped for
 *   the session and the next is asked; one without a ticket for a collection is skipped for its
 *   files only. The helper's own trouble (`busy`; restarting, gone) is never held against a
 *   source: `busy` is retried a few times, and a connection from an older helper process is
 *   dialled again once.
 * - **Reasons are short constants**, never peer data, so a failed open says why without quoting
 *   anyone.
 * - `close` hangs up every connection and makes every fetch in flight reject at once.
 */
import { nfx } from '@sovit/core';
import type { Logger } from '@sovit/seeder';

import type { NfxIrohEndpointWire } from '../../ipc/worker-protocol.js';
import { META_COLLECTION, metaMembers, renditionMembers } from '../iroh/collections.js';
import type { HelperDialTarget, HelperTicket } from '../iroh/helper.js';
import { HelperError, MAX_GET_BYTES, PoisonedError, dialTarget } from '../iroh/helper.js';
import type { NfxFetcher } from './watch.js';
import { NfxFetchError } from './watch.js';

/** What the fetcher needs of the helper (`IrohHelper`), so tests can stand in for it. */
export interface IrohFetchClient {
  ticket(ticket: string): Promise<HelperTicket>;
  dial(target: HelperDialTarget): Promise<number>;
  getSeq(
    conn: number,
    hash: string,
    opts: { readonly maxMembers: number; readonly exact?: boolean },
  ): Promise<string[]>;
  getFile(
    conn: number,
    hash: string,
    expect: { readonly sha256: string; readonly maxBytes: number },
  ): Promise<Uint8Array>;
  hangup(conn: number): Promise<boolean>;
}

/** Why a file did not come from a source (or from iroh at all). */
export type IrohFetchReason =
  | 'iroh-off'
  | 'unmapped'
  | 'no-ticket'
  | 'bad-ticket'
  | 'unreachable'
  | 'timeout'
  | 'transfer'
  | 'poisoned'
  | 'counts'
  | 'size'
  | 'busy'
  | 'helper'
  | 'refused'
  | 'closed';

/** The most members one collection may have: what one `get` can carry (32 bytes each). */
export const MAX_COLLECTION_MEMBERS = MAX_GET_BYTES / 32;
/** Waits before each retry of a request the helper refused `busy`. */
export const IROH_BUSY_DELAYS_MS: readonly number[] = [100, 250, 500, 1000, 2000];
/** Gets (collections and files) one session has in flight through the helper at once. */
export const IROH_SESSION_GETS = 2;

export interface IrohFetcherOptions {
  readonly video: nfx.VideoAddr;
  /** The manifest `root` (the hash list's sha256) and `segs` (how many files it lists). */
  readonly root: string;
  readonly segs: number;
  /** The beaconed iroh endpoints, in the order to try them (unique nodes, the wire's form). */
  readonly endpoints: readonly NfxIrohEndpointWire[];
  /** The watching helper, started on first need; `null`: iroh is off. */
  readonly client: () => Promise<IrohFetchClient | null>;
  /** Changes whenever the helper restarts or is replaced: its connections are then void. */
  readonly generation: () => number;
  /** The network's iroh relays (NFX-06 §1): a ticket's other relays are dropped. */
  readonly networkRelays: () => readonly string[];
  readonly logger: Logger;
  /** Tests: `IROH_BUSY_DELAYS_MS`, `IROH_SESSION_GETS`, and the clock. */
  readonly busyDelaysMs?: readonly number[];
  readonly maxGets?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Place {
  readonly collection: string;
  readonly index: number;
}

interface Seq {
  /** Where to dial for it (the ticket's node, addresses and the network's relays). */
  readonly target: HelperDialTarget;
  /** The members' BLAKE3 hashes: the peer's say-so, good only for asking. */
  readonly members: readonly string[];
}

interface Source {
  readonly node: string;
  readonly tickets: ReadonlyMap<string, string>;
  dropped: boolean;
  conn: { readonly generation: number; readonly id: Promise<number> } | null;
  readonly seqs: Map<string, Promise<Seq>>;
}

/** A source's fault (or not, with `drop: false`) that the helper did not name. */
class SourceFault extends Error {
  constructor(
    readonly reason: IrohFetchReason,
    readonly drop: boolean,
  ) {
    super(`nfx/iroh: ${reason}`);
  }
}

class Closed extends Error {
  constructor() {
    super('nfx/iroh: the fetcher closed');
  }
}

interface Verdict {
  readonly reason: IrohFetchReason;
  /** Drop the source for the session. */
  readonly drop: boolean;
  /** Its connection is void (the helper restarted): dial again, once. */
  readonly redial: boolean;
}

/** How a failed request reflects on its source. */
function verdict(err: unknown): Verdict {
  if (err instanceof SourceFault) return { reason: err.reason, drop: err.drop, redial: false };
  if (err instanceof PoisonedError) return { reason: 'poisoned', drop: true, redial: false };
  if (!(err instanceof HelperError)) return { reason: 'helper', drop: false, redial: false };
  switch (err.code) {
    case 'busy':
      return { reason: 'busy', drop: false, redial: false };
    // The helper's own trouble, or a connection an older helper process held.
    case 'not-ready':
    case 'gone':
    case 'violation':
    case 'closed':
    case 'no-conn':
      return { reason: 'helper', drop: false, redial: true };
    case 'dial-failed':
      return { reason: 'unreachable', drop: true, redial: false };
    case 'timeout':
      return { reason: 'timeout', drop: true, redial: false };
    case 'too-large':
    case 'transfer-failed':
      return { reason: 'transfer', drop: true, redial: false };
    default:
      return { reason: 'refused', drop: true, redial: false };
  }
}

export class IrohFetcher implements NfxFetcher {
  private readonly o: IrohFetcherOptions;
  private readonly sources: Source[];
  private readonly busyDelaysMs: readonly number[];
  private readonly maxGets: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** The verified hash list once it passed through, and where each listed sha256 sits. */
  private list: nfx.HashList | null = null;
  private metaCount: number | null = null;
  private readonly renditionCounts = new Map<string, number>();
  private readonly places = new Map<string, Place>();
  /** Connections this fetcher opened, by the helper generation that holds them. */
  private readonly opened: { readonly generation: number; readonly conn: number }[] = [];
  private lastClient: IrohFetchClient | null = null;
  private gets = 0;
  private readonly waiting: (() => void)[] = [];
  private closed = false;
  private readonly aborted: Promise<never>;
  private abort: (err: Error) => void = () => undefined;

  constructor(o: IrohFetcherOptions) {
    this.o = o;
    this.sources = o.endpoints.map((e) => ({
      node: e.node,
      tickets: new Map(e.tickets.$map),
      dropped: false,
      conn: null,
      seqs: new Map(),
    }));
    this.busyDelaysMs = o.busyDelaysMs ?? IROH_BUSY_DELAYS_MS;
    this.maxGets = o.maxGets ?? IROH_SESSION_GETS;
    this.sleep =
      o.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.aborted = new Promise<never>((_, reject) => {
      this.abort = reject;
    });
    this.aborted.catch(() => undefined);
  }

  async fetch(sha: string, size: number, exact: boolean): Promise<Uint8Array> {
    if (this.closed) throw new NfxFetchError(['closed']);
    const place = this.place(sha);
    if (place === null) throw new NfxFetchError(['unmapped']);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_GET_BYTES)
      throw new NfxFetchError(['size']);
    const reasons: IrohFetchReason[] = [];
    for (const s of this.sources) {
      for (let attempt = 0; attempt < 2 && !s.dropped; attempt++) {
        // Asked each time: after a restart (or a change of relays) the node has a new helper.
        const client = await this.client();
        if (client === null) throw new NfxFetchError([this.isClosed() ? 'closed' : 'iroh-off']);
        try {
          const bytes = await this.fromSource(client, s, place, sha, size, exact);
          this.learn(sha, bytes);
          return bytes;
        } catch (err) {
          if (this.isClosed()) throw new NfxFetchError(['closed']);
          const v = verdict(err);
          if (v.drop) {
            s.dropped = true;
            this.o.logger.info('nfx: an iroh source was dropped for this session', {
              reason: v.reason,
            });
          }
          if (v.redial) s.conn = null;
          if (!v.redial || attempt === 1) {
            reasons.push(v.reason);
            break;
          }
        }
      }
    }
    throw new NfxFetchError(reasons);
  }

  /**
   * `bytes` are file `sha`'s, checked against it by whichever transport fetched them: the hash
   * list places `meta`'s members, a playlist its rendition's. Anything else is ignored.
   */
  learn(sha: string, bytes: Uint8Array): void {
    if (this.closed) return;
    if (sha === this.o.root) {
      if (this.list !== null) return;
      const verified = nfx.verifyHashList(bytes, this.o.root, this.o.video, BigInt(this.o.segs));
      if (!verified.ok) return;
      const list = verified.value;
      const meta = metaMembers(this.o.root, list);
      this.list = list;
      this.metaCount = meta.length;
      meta.forEach((m, index) => {
        this.placeAt(m, META_COLLECTION, index);
      });
      return;
    }
    const list = this.list;
    if (list === null) return;
    for (const r of list.renditions) {
      if (this.renditionCounts.has(r.id) || r.id === META_COLLECTION) continue;
      const playlist = list.files.find((f) => f.role === 'playlist' && f.name === r.playlist);
      if (playlist?.sha256 !== sha) continue;
      const members = renditionMembers(list, bytes);
      if (!members.ok) continue;
      this.renditionCounts.set(r.id, members.value.length);
      members.value.forEach((m, index) => {
        this.placeAt(m, r.id, index);
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort(new Closed());
    for (const wake of this.waiting.splice(0)) wake();
    const client = this.lastClient;
    if (client === null) return;
    const generation = this.o.generation();
    await Promise.all(
      this.opened
        .filter((c) => c.generation === generation)
        .map((c) => client.hangup(c.conn).catch(() => false)),
    );
  }

  // ------------------------------------------------------------------ internals

  /** Read through a call: `closed` changes across the awaits of a fetch. */
  private isClosed(): boolean {
    return this.closed;
  }

  /** The watching helper now, or `null` when iroh is off or the fetcher closed. */
  private async client(): Promise<IrohFetchClient | null> {
    let client: IrohFetchClient | null;
    try {
      client = await this.abortable(this.o.client());
    } catch {
      return null;
    }
    if (client !== null) this.lastClient = client;
    return client;
  }

  private placeAt(sha: string, collection: string, index: number): void {
    // A sha256 listed twice is the same bytes wherever it is fetched from: the first place wins.
    if (!this.places.has(sha)) this.places.set(sha, { collection, index });
  }

  private place(sha: string): Place | null {
    if (sha === this.o.root) return { collection: META_COLLECTION, index: 0 };
    return this.places.get(sha) ?? null;
  }

  /** The members collection `id` must have: `exact`, or at most (`meta` before the list). */
  private expected(id: string): { readonly maxMembers: number; readonly exact: boolean } | null {
    if (id === META_COLLECTION) {
      if (this.metaCount !== null) return { maxMembers: this.metaCount, exact: true };
      return { maxMembers: Math.min(this.o.segs + 1, MAX_COLLECTION_MEMBERS), exact: false };
    }
    const n = this.renditionCounts.get(id);
    return n === undefined ? null : { maxMembers: n, exact: true };
  }

  private async fromSource(
    client: IrohFetchClient,
    s: Source,
    place: Place,
    sha: string,
    size: number,
    exact: boolean,
  ): Promise<Uint8Array> {
    const seq = await this.seqOf(client, s, place.collection);
    const member = seq.members[place.index];
    if (member === undefined) throw new SourceFault('counts', true);
    const conn = await this.connOf(client, s, seq.target);
    const bytes = await this.get(() =>
      client.getFile(conn, member, { sha256: sha, maxBytes: size }),
    );
    // The bytes are `sha`'s; a listed size that disagrees is the hash list's fault, not the peer's.
    if (exact && bytes.byteLength !== size) throw new SourceFault('size', false);
    return bytes;
  }

  /** Collection `id` of `s`, fetched once, and checked against what it must hold now. */
  private async seqOf(client: IrohFetchClient, s: Source, id: string): Promise<Seq> {
    let p = s.seqs.get(id);
    if (p === undefined) {
      const loading = this.loadSeq(client, s, id);
      p = loading;
      s.seqs.set(id, loading);
      loading.catch(() => {
        if (s.seqs.get(id) === loading) s.seqs.delete(id);
      });
    }
    const seq = await this.abortable(p);
    // `meta` fetched before the hash list was known is held to it once it is.
    const want = this.expected(id);
    if (want?.exact === true && seq.members.length !== want.maxMembers)
      throw new SourceFault('counts', true);
    return seq;
  }

  private async loadSeq(client: IrohFetchClient, s: Source, id: string): Promise<Seq> {
    const ticket = s.tickets.get(id);
    if (ticket === undefined) throw new SourceFault('no-ticket', false);
    const want = this.expected(id);
    if (want === null) throw new SourceFault('unmapped', false);
    let decoded: HelperTicket;
    try {
      decoded = await this.call(() => client.ticket(ticket));
    } catch (err) {
      if (err instanceof HelperError && err.code === 'bad-request')
        throw new SourceFault('bad-ticket', true);
      throw err;
    }
    const target = dialTarget(decoded, s.node, this.o.networkRelays());
    if (target === null) throw new SourceFault('bad-ticket', true);
    const conn = await this.connOf(client, s, target);
    const members = await this.get(() => client.getSeq(conn, decoded.hash, want));
    return { target, members };
  }

  /** `s`'s connection on the current helper, dialled on first need. */
  private async connOf(
    client: IrohFetchClient,
    s: Source,
    target: HelperDialTarget,
  ): Promise<number> {
    const generation = this.o.generation();
    const current = s.conn;
    if (current !== null && current.generation === generation) return this.abortable(current.id);
    // Not abandoned on close: a connection that comes up late is still hung up.
    const id = this.call(() => client.dial(target), false);
    const entry = { generation, id };
    s.conn = entry;
    id.then(
      (conn) => {
        this.opened.push({ generation, conn });
        // Dialled after the session closed: nobody will use it.
        if (this.closed) void client.hangup(conn).catch(() => false);
      },
      () => {
        if (s.conn === entry) s.conn = null;
      },
    );
    return this.abortable(id);
  }

  /** One get through the helper, at most `maxGets` at once per session. */
  private async get<T>(task: () => Promise<T>): Promise<T> {
    while (this.gets >= this.maxGets) {
      await this.abortable(
        new Promise<void>((resolve) => {
          this.waiting.push(resolve);
        }),
      );
    }
    this.gets++;
    try {
      return await this.call(task);
    } finally {
      this.gets--;
      this.waiting.shift()?.();
    }
  }

  /**
   * A helper request, retried while the helper says `busy` (its queue, never the source's). With
   * `abandon` (the default) it rejects as soon as the fetcher closes; else it runs to its end.
   */
  private async call<T>(task: () => Promise<T>, abandon = true): Promise<T> {
    for (let i = 0; ; i++) {
      if (this.closed) throw new Closed();
      try {
        return await (abandon ? this.abortable(task()) : task());
      } catch (err) {
        const delay = this.busyDelaysMs[i];
        if (!(err instanceof HelperError && err.code === 'busy') || delay === undefined) throw err;
        await this.abortable(this.sleep(delay));
      }
    }
  }

  /** `p`, or a rejection as soon as the fetcher closes. */
  private abortable<T>(p: Promise<T>): Promise<T> {
    return Promise.race([p, this.aborted]);
  }
}
