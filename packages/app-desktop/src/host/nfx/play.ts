/**
 * Free NFX play on the host (ADR 0020 slice 5d-3, contracts v11): who serves a video, and the
 * sessions the renderer holds.
 *
 * - **Who serves** comes from the video's live beacons (NFX-03 §5): kind 20464 with `#n` and `#a`,
 *   read from the network's scoped relays only (beacons are never on public relays). Each beacon
 *   must pass core's `parseBeacon` (signature, TTL, NIP-40 expiry, every `bind`) and name this
 *   manifest's author and address, and be free (Phase 1). Only each seeder's newest beacon counts
 *   (NFX-03 §2). "Endpoints come from it, trust never does": the worker still checks every file.
 * - **Both transports** (slice 5e-4): a beacon's `iroh` endpoints (NFX-06, which nfxd speaks) and
 *   its `hyperdht` ones (NFX-12). An iroh endpoint crosses only in the form the worker's guard
 *   takes: its relay kept only when it is one of the network's (`Settings.nfx.irohRelays`, NFX-06
 *   §1), the addresses and tickets the wire can carry, and a `meta` ticket. One that cannot is
 *   skipped, so one hostile beacon cannot make the worker refuse the whole session.
 * - **A session** is a sid, a media-link token and its owner (a webContents). No money is
 *   involved: no `checkBalance`, no money plane. Closing revokes the link and closes the worker's
 *   session; a gone webContents or a dead worker closes them too.
 */
import type { NfxAddress, NfxVideo, NostrEvent, NostrFilter } from '@sovit/core';
import { nfx } from '@sovit/core';

import type { NfMediaPlayUrl, NfxPlaySessionWire, SessionId } from '../../ipc/protocol.js';
import {
  isNfxBlobTicket,
  isNfxIrohEndpointWire,
  isNfxSocketAddr,
  isNfxTicketKey,
} from '../../ipc/worker-guards.js';
import type {
  NfxHeldWire,
  NfxHyperdhtEndpointWire,
  NfxIrohEndpointWire,
  NfxRenditionWire,
} from '../../ipc/worker-protocol.js';
import {
  MAX_NFX_IROH_ADDRS,
  MAX_NFX_PLAY_IROH,
  MAX_NFX_PLAY_PEERS,
  MAX_NFX_RENDITIONS,
} from '../../ipc/worker-protocol.js';

export { MAX_NFX_PLAY_IROH, MAX_NFX_PLAY_PEERS };

/** Slice 5e-4: who serves a video, by transport, each in the order to try them. */
export interface NfxPlaySources {
  readonly hyperdht: NfxHyperdhtEndpointWire[];
  readonly iroh: NfxIrohEndpointWire[];
  /**
   * Pear #97: which renditions the seeders of these endpoints hold (core's `nfx.countHolders`):
   * a `hyperdht` endpoint every rendition (NFX-12 serves whole videos), an `iroh` one those it
   * kept a ticket for. Only endpoints kept above count, so a rendition counted is one the worker
   * can fetch from someone it is given.
   */
  readonly held: NfxHeldWire;
}

/** Pear #97: core's counts as the worker takes them. */
export function heldWire(a: nfx.RenditionAvailability): NfxHeldWire {
  return { seeders: a.seeders, all: a.all, named: { $map: [...a.named] } };
}

/** The beacon filter for one video (NFX-04 §5, "Live availability"): core's, since ADR 0022. */
export const beaconFilter: (video: NfxVideo) => NostrFilter = nfx.beaconFilter;

type IrohEndpoint = Extract<nfx.Endpoint, { readonly t: 'iroh' }>;

/**
 * Slice 5e-4: a beacon's iroh endpoint as `nfx.play.open` carries it, or `null` when it cannot
 * cross. The relay survives only when it is one of `networkRelays`; addresses and tickets the
 * wire cannot carry are dropped (at most `MAX_NFX_IROH_ADDRS` addresses, `meta` and
 * `MAX_NFX_RENDITIONS` rendition tickets); without a `meta` ticket there is nothing to fetch.
 */
export function irohWire(
  e: IrohEndpoint,
  networkRelays: readonly string[],
): NfxIrohEndpointWire | null {
  const addrs = e.addrs.filter((a) => isNfxSocketAddr(a)).slice(0, MAX_NFX_IROH_ADDRS);
  const tickets: [string, string][] = [];
  const meta = e.tickets.get(nfx.RESERVED_RENDITION_ID);
  if (meta === undefined || !isNfxBlobTicket(meta)) return null;
  tickets.push([nfx.RESERVED_RENDITION_ID, meta]);
  for (const [k, v] of e.tickets) {
    if (tickets.length > MAX_NFX_RENDITIONS) break;
    if (k !== nfx.RESERVED_RENDITION_ID && isNfxTicketKey(k) && isNfxBlobTicket(v))
      tickets.push([k, v]);
  }
  const wire = {
    t: 'iroh' as const,
    node: e.node,
    relay: networkRelays.includes(e.relay) ? e.relay : '',
    addrs,
    tickets: { $map: tickets },
  };
  return isNfxIrohEndpointWire(wire) ? wire : null;
}

/**
 * The endpoints of the free seeders `events` announce for `video`, newest beacon first, one
 * beacon per seeder: unique HyperDHT peers (at most `MAX_NFX_PLAY_PEERS`) and unique iroh nodes
 * (at most `MAX_NFX_PLAY_IROH`, in the wire form `irohWire` gives, against `networkRelays`), and
 * which renditions their seeders hold (pear #97).
 */
export function beaconPeers(
  video: NfxVideo,
  events: readonly NostrEvent[],
  now: number,
  networkRelays: readonly string[] = [],
): NfxPlaySources {
  const newestFirst = [...events].sort((a, b) => b.created_at - a.created_at);
  const seeders = new Set<string>();
  const peers = new Map<string, NfxHyperdhtEndpointWire>();
  const nodes = new Map<string, NfxIrohEndpointWire>();
  // Pear #97: what each seeder holds through the endpoints kept for it.
  const holds: nfx.SeederHolds[] = [];
  for (const ev of newestFirst) {
    const parsed = nfx.parseBeacon(ev, now);
    if (!parsed.ok) continue;
    const b = parsed.value;
    if (seeders.has(b.seeder)) continue;
    seeders.add(b.seeder);
    const address = `${String(nfx.KIND_MANIFEST)}:${b.creator}:${b.content.video.toString()}`;
    if (b.creator !== video.author || address !== video.id || !b.content.free) continue;
    let every = false;
    const ids = new Set<string>();
    for (const e of b.content.endpoints) {
      if (e.t === 'hyperdht') {
        if (peers.has(e.peer) || peers.size >= MAX_NFX_PLAY_PEERS) continue;
        peers.set(e.peer, { t: 'hyperdht', peer: e.peer, bind: e.bind });
        every = true;
      } else if (e.t === 'iroh') {
        if (nodes.has(e.node) || nodes.size >= MAX_NFX_PLAY_IROH) continue;
        const wire = irohWire(e, networkRelays);
        if (wire === null) continue;
        nodes.set(e.node, wire);
        for (const [k] of wire.tickets.$map) if (k !== nfx.RESERVED_RENDITION_ID) ids.add(k);
      }
    }
    if (every) holds.push('all');
    else if (ids.size > 0) holds.push(ids);
    if (peers.size >= MAX_NFX_PLAY_PEERS && nodes.size >= MAX_NFX_PLAY_IROH) break;
  }
  return {
    hyperdht: [...peers.values()],
    iroh: [...nodes.values()],
    held: heldWire(nfx.countHolders(holds)),
  };
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
