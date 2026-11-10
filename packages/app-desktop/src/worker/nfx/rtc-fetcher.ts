/**
 * An `NfxFetcher` over WebRTC (ADR 0023, #89): segments from the peers (browsers, or other apps)
 * the worker's WebRTC node (`./rtc-node.ts`) is connected to in this video's NFX-10 web swarms. It
 * opens no connection itself: the host's signaling does (Nostr, nfx #71); this asks whoever is
 * connected and has announced the segment.
 *
 * - **Files are asked for by sha256, served by position.** A web swarm carries one rendition's
 *   segments, numbered by their #EXTINF index (NFX-10 §2). The fetcher learns where each sha256
 *   sits as files pass (`learn`, as `./iroh-fetcher.ts` does): the hash list (the manifest `root`),
 *   then each rendition's playlist (`renditionMembers`). Anything else (the hash list itself,
 *   playlists, inits) is never in a web swarm, and fails `unmapped`: never a guess.
 * - **The peer's word is never taken for the bytes.** `rtcGetFile` returns a segment only when its
 *   sha256 is the one the signed hash list gives (NFX-05 §4), capped at its listed size.
 * - **Peers.** Those connected in the segment's swarm whose last announcement holds it, in the
 *   node's order. One that sends what the hash list contradicts is hung up and never asked again
 *   this session; one that no longer holds a segment (`absent`), stalls, or is busy is not held
 *   to it. The helper's own trouble (restarting, gone) ends the attempt, so the next transport is
 *   asked at once. One fetch per peer at a time (the helper's rule): others wait their turn.
 * - **Reasons are short constants**, never peer data.
 */
import { nfx } from '@sovit/core';
import type { Logger } from '@sovit/seeder';

import { HelperError, MAX_GET_BYTES, PoisonedError } from '../iroh/helper.js';
import type { NfxRtcConnection } from './rtc-node.js';
import { holds } from './rtc-node.js';
import type { NfxFetcher } from './watch.js';
import { NfxFetchError } from './watch.js';

/** What the fetcher needs of the helper (`IrohHelper`), so tests can stand in for it. */
export interface RtcFetchClient {
  rtcGetFile(
    peer: number,
    segment: number,
    expect: { readonly sha256: string; readonly maxBytes: number },
  ): Promise<Uint8Array>;
  rtcHangup(peer: number): Promise<boolean>;
}

export type RtcFetchReason =
  | 'rtc-off'
  | 'unmapped'
  | 'size'
  | 'no-peer'
  | 'absent'
  | 'poisoned'
  | 'timeout'
  | 'transfer'
  | 'busy'
  | 'helper'
  | 'refused'
  | 'closed';

export interface RtcFetcherOptions {
  readonly video: nfx.VideoAddr;
  /** The manifest `root` (the hash list's sha256) and `segs`. */
  readonly root: string;
  readonly segs: number;
  /** The WebRTC node's helper, `null` when WebRTC is off. */
  readonly client: () => Promise<RtcFetchClient | null>;
  /** The node's open connections in `swarm`, as it knows them now. */
  readonly connections: (swarm: string) => readonly NfxRtcConnection[];
  readonly logger: Logger;
}

interface Place {
  readonly swarm: string;
  readonly index: number;
}

interface Verdict {
  readonly reason: RtcFetchReason;
  /** Hang the peer up and never ask it again this session. */
  readonly drop: boolean;
  /** The helper's own trouble: ask no other peer now. */
  readonly stop: boolean;
}

function verdict(err: unknown): Verdict {
  if (err instanceof PoisonedError) return { reason: 'poisoned', drop: true, stop: false };
  if (!(err instanceof HelperError)) return { reason: 'helper', drop: false, stop: true };
  switch (err.code) {
    case 'absent':
      return { reason: 'absent', drop: false, stop: false };
    case 'busy':
      return { reason: 'busy', drop: false, stop: false };
    case 'no-peer':
    case 'not-open':
      return { reason: 'no-peer', drop: false, stop: false };
    case 'timeout':
      return { reason: 'timeout', drop: false, stop: false };
    case 'too-large':
    case 'transfer-failed':
      return { reason: 'transfer', drop: true, stop: false };
    case 'not-ready':
    case 'gone':
    case 'violation':
    case 'closed':
      return { reason: 'helper', drop: false, stop: true };
    default:
      return { reason: 'refused', drop: true, stop: false };
  }
}

export class RtcFetcher implements NfxFetcher {
  private readonly o: RtcFetcherOptions;
  private list: nfx.HashList | null = null;
  private readonly learned = new Set<string>();
  private readonly places = new Map<string, Place>();
  /** Peers that sent what the hash list contradicts. */
  private readonly dropped = new Set<number>();
  /** The fetch each peer is serving (the helper allows one per peer). */
  private readonly turns = new Map<number, Promise<unknown>>();
  private closed = false;

  constructor(o: RtcFetcherOptions) {
    this.o = o;
  }

  async fetch(sha: string, size: number, exact: boolean): Promise<Uint8Array> {
    if (this.closed) throw new NfxFetchError(['closed']);
    const place = this.places.get(sha);
    if (place === undefined) throw new NfxFetchError(['unmapped']);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_GET_BYTES)
      throw new NfxFetchError(['size']);
    const peers = this.o
      .connections(place.swarm)
      .filter((c) => !this.dropped.has(c.peer) && holds(c.have, place.index));
    if (peers.length === 0) throw new NfxFetchError(['no-peer']);
    const client = await this.o.client();
    if (client === null) throw new NfxFetchError(['rtc-off']);
    const reasons: RtcFetchReason[] = [];
    for (const c of peers) {
      if (this.isClosed()) throw new NfxFetchError(['closed']);
      try {
        const bytes = await this.turn(c.peer, () =>
          client.rtcGetFile(c.peer, place.index, { sha256: sha, maxBytes: size }),
        );
        // Its sha256 is the listed one, so its size is too; a short `exact` read is a lie.
        if (exact && bytes.length !== size) throw new PoisonedError('a segment of another size');
        return bytes;
      } catch (err) {
        if (this.isClosed()) throw new NfxFetchError(['closed']);
        const v = verdict(err);
        reasons.push(v.reason);
        if (v.drop) {
          this.dropped.add(c.peer);
          void client.rtcHangup(c.peer).catch(() => false);
          this.o.logger.info('nfx: a WebRTC peer was dropped for this session', {
            reason: v.reason,
          });
        }
        if (v.stop) break;
      }
    }
    throw new NfxFetchError(reasons);
  }

  /**
   * `bytes` are file `sha`'s, checked against it by whichever transport fetched them: the hash
   * list, then each rendition's playlist, place its segments. Anything else is ignored.
   */
  learn(sha: string, bytes: Uint8Array): void {
    if (this.closed || this.learned.has(sha)) return;
    if (sha === this.o.root) {
      const verified = nfx.verifyHashList(bytes, this.o.root, this.o.video, BigInt(this.o.segs));
      if (!verified.ok) return;
      this.list = verified.value;
      this.learned.add(sha);
      return;
    }
    const list = this.list;
    if (list === null) return;
    for (const r of list.renditions) {
      const playlist = list.files.find((f) => f.role === 'playlist' && f.name === r.playlist);
      if (playlist?.sha256 !== sha) continue;
      const members = nfx.renditionMembers(list, bytes);
      if (!members.ok) continue;
      this.learned.add(sha);
      const swarm = this.o.video.webStreamSwarmId(r.id);
      members.value.segments.forEach((f, index) => {
        if (!this.places.has(f.sha256)) this.places.set(f.sha256, { swarm, index });
      });
    }
  }

  /** The web swarm and #EXTINF index of segment `sha`, once known. */
  placeOf(sha: string): Place | undefined {
    return this.places.get(sha);
  }

  /** Read through a call: `close` may run while a fetch awaits, which narrowing cannot see. */
  private isClosed(): boolean {
    return this.closed;
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  /** `task` once `peer` has finished the fetch before it. */
  private async turn<T>(peer: number, task: () => Promise<T>): Promise<T> {
    const before = this.turns.get(peer) ?? Promise.resolve();
    const mine = before.catch(() => undefined).then(task);
    const settled = mine.catch(() => undefined);
    this.turns.set(peer, settled);
    try {
      return await mine;
    } finally {
      if (this.turns.get(peer) === settled) this.turns.delete(peer);
    }
  }
}
