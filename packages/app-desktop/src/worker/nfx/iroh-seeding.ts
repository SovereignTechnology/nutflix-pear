/**
 * NFX seeding over iroh (NFX-06, ADR 0021 slice 5e-3), beside NFX-12's HyperDHT listener
 * (`./seeding.ts`): this node's stored NFX videos, served over iroh-blobs by the worker's one iroh
 * helper (`./iroh.ts`) while seeding AND NFX are on and a helper is configured, and only then.
 *
 * The work runs in passes, one at a time: at every `set` and every `endpoint` ask (the beacon
 * round is the clock), and when the helper restarts. A pass serves what is stored and not yet
 * served, and stops serving what is no longer stored. For each video:
 * - **Imports by path.** Every member of its collections is imported into the helper by its path
 *   in the NFX store, which names a path only for a file that video's verified hash list lists
 *   (`NfxStore.path`) and stored none before its sha256 checked out. So nothing is hashed again
 *   here, and nothing outside a stored video's hash list can be imported. The helper references
 *   each file in place (spike S-D finding 8). At most `IMPORT_CONCURRENCY` at once, and the size
 *   the helper reports must be the listed one.
 * - **The collections** of NFX-06 §2 (`../iroh/collections.ts`): `meta`, and one per rendition,
 *   membership and order from its playlist (read from the store). A video whose playlists do not
 *   resolve, or whose renditions a beacon could not carry, is not served over iroh (it still is
 *   over HyperDHT), and that is logged once.
 * - **Tags** `nfx/<root>/meta` and `nfx/<root>/r<n>` (its n-th rendition) keep each collection
 *   from the helper's collector. A video no longer stored loses its tags, and its blobs go at the
 *   next collection. Turning serving off stops the helper and empties its store.
 * - **Tickets** are what `seq` returns, each decoded by the helper and checked to name this node
 *   and that collection (the pipe is untrusted). A ticket embeds the node's addresses, so when
 *   they change the tickets are made again.
 *
 * `endpoint(video)` answers at once: the beacon's iroh endpoint while that video is served this
 * way (the node, its relay when that is one of the network's or else `''`, its direct addresses,
 * a ticket per collection), `null` otherwise.
 */
import type { IrohRelayUrl } from '@sovit/core';
import { nfx } from '@sovit/core';
import type { Logger, NfxStoreFile, NfxVideoRecord } from '@sovit/seeder';
import { NFX_MAX_READ_BYTES } from '@sovit/seeder';

import { isNfxBlobTicket, isNfxSocketAddr, isNfxTicketKey } from '../../ipc/worker-guards.js';
import type { NfxIrohEndpointWire } from '../../ipc/worker-protocol.js';
import { MAX_NFX_IROH_ADDRS, MAX_NFX_RENDITIONS } from '../../ipc/worker-protocol.js';
import type { NfxCollection } from '../iroh/collections.js';
import { META_COLLECTION, nfxCollections } from '../iroh/collections.js';
import type { HelperReach, IrohHelper } from '../iroh/helper.js';
import type { NfxIrohNode } from './iroh.js';

/** Imports in flight at once (the helper client allows 8 requests, the helper 16). */
export const IMPORT_CONCURRENCY = 4;

/** The slice of `@sovit/seeder`'s `NfxStore` this serves from. */
export interface NfxIrohStore {
  videos(): readonly NfxVideoRecord[];
  file(video: nfx.VideoAddr, sha: string): NfxStoreFile | undefined;
  path(video: nfx.VideoAddr, sha: string): string | undefined;
}

export interface NfxIrohSeedingDeps {
  readonly node: NfxIrohNode;
  readonly store: NfxIrohStore;
  readonly logger: Logger;
}

/**
 * The helper's tag for collection `n` (`meta`, or `r<i>` for the i-th rendition) of the video
 * whose hash list is `root`: within the helper's alphabet and length (1–128 of `[a-z0-9:._/-]`).
 */
export const irohTag = (root: string, n: string): string => `nfx/${root}/${n}`;

interface Served {
  readonly root: string;
  /** The node's reach when its tickets were made (they embed its addresses). */
  readonly reach: HelperReach;
  /** Collection id → ticket: `meta` first, then the renditions in the hash list's order. */
  readonly tickets: readonly (readonly [string, string])[];
  readonly tags: readonly string[];
}

/** Why this helper will not serve a video (until the next one): logged once, not retried. */
class NotServable extends Error {}

/** A `set` came while a pass ran: the pass stops where it is (the next one starts over). */
class Overtaken extends Error {}

function sameReach(a: HelperReach, b: HelperReach): boolean {
  const sorted = (x: HelperReach): string => [...x.addrs].sort().join(' ');
  return a.node === b.node && a.relay === b.relay && sorted(a) === sorted(b);
}

export class NfxIrohSeeding {
  private readonly d: NfxIrohSeedingDeps;
  private on = false;
  /** Bumped by every `set`: a pass that sees it change stops. */
  private epoch = 0;
  private queue: Promise<void> = Promise.resolve();
  private passQueued = false;
  private closed = false;
  /** The helper generation the maps below belong to. */
  private generation = -1;
  /** By video address. */
  private readonly served = new Map<string, Served>();
  /** sha256 → BLAKE3 of the files the current helper has imported. */
  private readonly blake = new Map<string, string>();
  /** `<video> <root>` of the videos the current helper will not serve. */
  private readonly refused = new Set<string>();
  private readonly offGeneration: () => void;

  constructor(d: NfxIrohSeedingDeps) {
    this.d = d;
    // A new or restarted helper holds none of the old tickets' addresses: serve again.
    this.offGeneration = d.node.onGeneration(() => {
      this.kick();
    });
  }

  /** How many videos are served over iroh now. */
  get videos(): number {
    return this.served.size;
  }

  /**
   * Serve (`on`) or stop, with the network's iroh relays. Settles once a change of relays has
   * stopped the old helper, or a stop is done; serving goes on in the background. Never throws.
   */
  set(on: boolean, relays: readonly IrohRelayUrl[]): Promise<void> {
    this.on = on && !this.closed;
    this.epoch += 1;
    // In the node's own order now, so no pass still waiting starts a helper with the old relays.
    const relaysSet = this.d.node.setRelays(relays);
    const applied = this.enqueue(async () => {
      await relaysSet;
      if (!this.on) await this.stop();
    });
    if (this.on) this.kick();
    return applied;
  }

  /** The iroh endpoint for `video`'s beacons while it is served over iroh, else `null`. */
  endpoint(video: string): NfxIrohEndpointWire | null {
    if (!this.on) return null;
    this.kick();
    if (this.d.node.generation !== this.generation) return null;
    const s = this.served.get(video);
    if (s === undefined) return null;
    return {
      t: 'iroh',
      node: s.reach.node,
      // NFX-06 §1: a beacon names the network's own relays and no other.
      relay: this.d.node.networkRelays.find((r) => r === s.reach.relay) ?? '',
      addrs: s.reach.addrs.filter((a) => isNfxSocketAddr(a)).slice(0, MAX_NFX_IROH_ADDRS),
      tickets: { $map: s.tickets },
    };
  }

  /** Stop for good: the helper goes too. */
  async close(): Promise<void> {
    this.closed = true;
    this.on = false;
    this.epoch += 1;
    this.offGeneration();
    await this.enqueue(() => this.stop());
    await this.d.node.close();
  }

  /** One pass after whatever is queued; at most one waits at a time. */
  private kick(): void {
    if (this.passQueued || !this.on) return;
    this.passQueued = true;
    void this.enqueue(async () => {
      this.passQueued = false;
      await this.pass();
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((err: unknown) => {
      this.d.logger.warn('nfx: serving over iroh failed', { error: err });
    });
    return this.queue;
  }

  private async stop(): Promise<void> {
    this.served.clear();
    this.blake.clear();
    this.refused.clear();
    await this.d.node.stop();
  }

  private async pass(): Promise<void> {
    const epoch = this.epoch;
    if (!this.on) return;
    // Nothing stored and nothing to stop serving: no helper is needed yet.
    if (this.served.size === 0 && this.d.store.videos().length === 0) return;
    const helper = await this.d.node.start();
    if (helper === null || epoch !== this.epoch) return;
    const generation = this.d.node.generation;
    if (generation !== this.generation) {
      // Another helper: nothing the old one held is there.
      this.served.clear();
      this.blake.clear();
      this.refused.clear();
      this.generation = generation;
    }
    let reach: HelperReach;
    try {
      reach = await helper.addr();
    } catch {
      return; // restarting or stopped: a restart kicks the next pass
    }
    const stored = new Map(this.d.store.videos().map((r) => [r.video, r] as const));
    for (const [video, s] of [...this.served]) {
      if (stored.get(video)?.root === s.root) continue;
      this.served.delete(video);
      for (const tag of s.tags) await helper.untag(tag).catch(() => 0);
    }
    for (const r of stored.values()) {
      if (epoch !== this.epoch || this.d.node.generation !== generation) return;
      const s = this.served.get(r.video);
      if (s !== undefined && sameReach(s.reach, reach)) continue;
      const key = `${r.video} ${r.root}`;
      if (this.refused.has(key)) continue;
      try {
        this.served.set(r.video, await this.serve(helper, r, reach, epoch));
      } catch (err) {
        if (err instanceof Overtaken || epoch !== this.epoch) return;
        if (err instanceof NotServable) {
          this.refused.add(key);
          this.d.logger.warn('nfx: a stored video is not served over iroh', {
            video: r.video,
            reason: err.message,
          });
          continue;
        }
        // The helper failed (restarting, busy, gone): the next pass tries again.
        this.d.logger.warn('nfx: a video could not be served over iroh yet', {
          video: r.video,
          error: err,
        });
        return;
      }
    }
  }

  private async serve(
    helper: IrohHelper,
    r: NfxVideoRecord,
    reach: HelperReach,
    epoch: number,
  ): Promise<Served> {
    const video = nfx.VideoAddr.parse(r.video);
    if (!video.ok) throw new NotServable('not an NFX video address');
    const listBytes = await this.read(video.value, r.root);
    // Core's one hash-list parser. The sha256 it checks is the hash list's own, already checked
    // when the store took it; no media file is hashed again.
    const verified = nfx.verifyHashList(listBytes, r.root, video.value, BigInt(r.segs));
    if (!verified.ok) throw new NotServable(`its hash list: ${verified.error.reason}`);
    const list = verified.value;
    // A beacon carries `meta` and one ticket per rendition, each keyed by its id.
    if (list.renditions.length > MAX_NFX_RENDITIONS)
      throw new NotServable('more renditions than a beacon carries');
    if (!list.renditions.every((x) => isNfxTicketKey(x.id)))
      throw new NotServable('a rendition id a beacon cannot carry');
    const playlists = new Map<string, Uint8Array>();
    for (const f of list.files)
      if (f.role === 'playlist' && !playlists.has(f.sha256))
        playlists.set(f.sha256, await this.read(video.value, f.sha256));
    const collections = nfxCollections(r.root, list, (sha) => playlists.get(sha));
    if (!collections.ok) throw new NotServable(`a playlist: ${collections.error.reason}`);
    const sizes = new Map(r.files.map((f) => [f.sha256, f.size] as const));
    const shas = [...new Set(collections.value.flatMap((c) => c.members))];
    await this.importAll(helper, video.value, shas, sizes, epoch);

    const tickets: (readonly [string, string])[] = [];
    const tags: string[] = [];
    for (const [i, c] of collections.value.entries()) {
      if (epoch !== this.epoch) throw new Overtaken();
      // `nfxCollections` puts `meta` first.
      const tag = irohTag(r.root, i === 0 ? META_COLLECTION : `r${String(i - 1)}`);
      tickets.push([c.id, await this.ticket(helper, c, tag, reach)]);
      tags.push(tag);
    }
    return { root: r.root, reach, tickets, tags };
  }

  /** A whole stored file of `video`: its hash list or a playlist (at most 16 MiB). */
  private async read(video: nfx.VideoAddr, sha: string): Promise<Uint8Array> {
    const f = this.d.store.file(video, sha);
    if (f === undefined) throw new NotServable('a listed file is not in the store');
    if (f.size > NFX_MAX_READ_BYTES) throw new NotServable('a file over 16 MiB to read whole');
    return f.read(0, f.size);
  }

  /** Every file of `shas` not yet imported into this helper, `IMPORT_CONCURRENCY` at a time. */
  private async importAll(
    helper: IrohHelper,
    video: nfx.VideoAddr,
    shas: readonly string[],
    sizes: ReadonlyMap<string, number>,
    epoch: number,
  ): Promise<void> {
    const todo = shas.filter((sha) => !this.blake.has(sha));
    let next = 0;
    const lane = async (): Promise<void> => {
      for (let sha = todo[next++]; sha !== undefined; sha = todo[next++]) {
        try {
          if (epoch !== this.epoch) throw new Overtaken();
          // Only a file this video's verified hash list lists has a path here.
          const path = this.d.store.path(video, sha);
          const size = sizes.get(sha);
          if (path === undefined || size === undefined)
            throw new NotServable('a member is not a listed, stored file');
          const got = await helper.import(path);
          if (got.size !== size)
            throw new NotServable('the iroh helper imported a file at another size');
          this.blake.set(sha, got.hash);
        } catch (err) {
          next = todo.length; // the other lanes take nothing more
          throw err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, todo.length) }, lane));
  }

  /** `c` as a tagged HashSeq; its ticket, checked to name this node and this collection. */
  private async ticket(
    helper: IrohHelper,
    c: NfxCollection,
    tag: string,
    reach: HelperReach,
  ): Promise<string> {
    const members: string[] = [];
    for (const sha of c.members) {
      const hash = this.blake.get(sha);
      if (hash === undefined) throw new Error('nfx: a collection member was not imported');
      members.push(hash);
    }
    const made = await helper.seq(members, tag);
    if (!isNfxBlobTicket(made.ticket))
      throw new NotServable('the iroh helper made a ticket a beacon cannot carry');
    const t = await helper.ticket(made.ticket);
    if (t.node !== reach.node || t.hash !== made.hash || t.format !== 'hash_seq')
      throw new NotServable('the iroh helper made a ticket for another node or collection');
    return made.ticket;
  }
}
