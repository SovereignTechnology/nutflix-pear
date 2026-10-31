/**
 * Free NFX play on the host (ADR 0020 slice 5d-3, contracts v11): who serves a video, and the
 * sessions the renderer holds.
 *
 * - **Who serves** comes from the video's live beacons (NFX-03 §5): kind 20464 with `#n` and `#a`,
 *   read from the network's scoped relays only (beacons are never on public relays). Each beacon
 *   must pass core's `parseBeacon` (signature, TTL, NIP-40 expiry, every `bind`) and name this
 *   manifest's author and address, and be free (Phase 1). Only each seeder's newest beacon counts
 *   (NFX-03 §2). "Endpoints come from it, trust never does": the worker still checks every file.
 * - **A session** is a sid, a media-link token and its owner (a webContents). No money is
 *   involved: no `checkBalance`, no money plane. Closing revokes the link and closes the worker's
 *   session; a gone webContents or a dead worker closes them too.
 */
import type { NfxAddress, NfxVideo, NostrEvent, NostrFilter } from '@sovit/core';
import { nfx } from '@sovit/core';

import type { NfMediaPlayUrl, NfxPlaySessionWire, SessionId } from '../../ipc/protocol.js';
import type { NfxHyperdhtEndpointWire, NfxRenditionWire } from '../../ipc/worker-protocol.js';

/** The most seeders one session is given (the worker's `MAX_NFX_PLAY_PEERS`). */
export const MAX_NFX_PLAY_PEERS = 16;

/** The beacon filter for one video (NFX-04 §5, "Live availability"). */
export function beaconFilter(video: NfxVideo): NostrFilter {
  return { kinds: [nfx.KIND_BEACON], '#n': [video.namespace], '#a': [video.id] };
}

/**
 * The `hyperdht` endpoints of the free seeders `events` announce for `video`, newest beacon
 * first, one beacon per seeder, unique peers, at most `MAX_NFX_PLAY_PEERS`.
 */
export function beaconPeers(
  video: NfxVideo,
  events: readonly NostrEvent[],
  now: number,
): NfxHyperdhtEndpointWire[] {
  const newestFirst = [...events].sort((a, b) => b.created_at - a.created_at);
  const seeders = new Set<string>();
  const peers = new Map<string, NfxHyperdhtEndpointWire>();
  for (const ev of newestFirst) {
    const parsed = nfx.parseBeacon(ev, now);
    if (!parsed.ok) continue;
    const b = parsed.value;
    if (seeders.has(b.seeder)) continue;
    seeders.add(b.seeder);
    const address = `${String(nfx.KIND_MANIFEST)}:${b.creator}:${b.content.video.toString()}`;
    if (b.creator !== video.author || address !== video.id || !b.content.free) continue;
    for (const e of b.content.endpoints) {
      if (e.t !== 'hyperdht' || peers.has(e.peer)) continue;
      peers.set(e.peer, { t: 'hyperdht', peer: e.peer, bind: e.bind });
      if (peers.size >= MAX_NFX_PLAY_PEERS) return [...peers.values()];
    }
  }
  return [...peers.values()];
}

/** The manifest's `d` (`<namespace>:<video-id>`) of an NFX address. */
export function videoOf(addr: NfxAddress): string | null {
  const target = nfx.parseATag(addr);
  return target.ok ? target.value.addr.toString() : null;
}

export class NfxHostSession {
  readonly sid: SessionId;
  readonly owner: number;
  readonly videoId: NfxAddress;
  readonly rendition: string;
  readonly renditions: readonly NfxRenditionWire[];
  private readonly token: string;
  private readonly closeFn: (s: NfxHostSession) => Promise<void>;
  private closing: Promise<void> | null = null;

  constructor(o: {
    readonly sid: SessionId;
    readonly owner: number;
    readonly token: string;
    readonly videoId: NfxAddress;
    readonly rendition: string;
    readonly renditions: readonly NfxRenditionWire[];
    readonly close: (s: NfxHostSession) => Promise<void>;
  }) {
    this.sid = o.sid;
    this.owner = o.owner;
    this.token = o.token;
    this.videoId = o.videoId;
    this.rendition = o.rendition;
    this.renditions = o.renditions;
    this.closeFn = o.close;
  }

  get source(): { readonly kind: 'url'; readonly url: NfMediaPlayUrl } {
    return { kind: 'url', url: `nf-media://play/${this.token}` };
  }

  /** The media-link token (revoked on close). */
  get linkToken(): string {
    return this.token;
  }

  toWire(): NfxPlaySessionWire {
    return {
      sid: this.sid,
      videoId: this.videoId,
      rendition: this.rendition,
      renditions: this.renditions,
      source: this.source,
    };
  }

  /** Idempotent. */
  close(): Promise<void> {
    this.closing ??= this.closeFn(this);
    return this.closing;
  }
}
