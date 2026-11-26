/**
 * NFX beacons (NFX-03, ADR 0020 slice 5c): every 30 s, while this node serves its NFX videos,
 * one kind-20464 beacon per video, signed by the seeder key, sent to the network's scoped relays
 * and nowhere else.
 *
 * - **TTL 60 s, republished every 30 s** (NFX-17 §3's SHOULD, which NFX-03 §§1 and 3 allow: TTL in
 *   [60, 120] s, republished at TTL/2), so a seeder that stops is forgotten within a minute.
 * - **Never two beacons for one video to one relay within 20 s** (`BEACON_FLOOR_S`), however soon
 *   a round runs: a scoped relay refuses the second (NFX-04 §2). A round that finds a relay inside
 *   the floor skips that relay for that video, and signs nothing when every relay is.
 * - **A round ends by `ROUND_DEADLINE_MS`.** A video it has not reached by then is left out of it
 *   (`BeaconRound.leftOut`) and goes first next time: the videos are taken least recently reached
 *   first (a fair cursor), so a slow worker or relay delays the tail but never starves it. A tick
 *   that comes while a round still runs starts another as soon as it ends.
 * - **Only while the worker serves.** No endpoint means no beacon: a beacon never names a
 *   listener that is down. Slice 5e-3: the worker is asked per video, since the iroh endpoint is
 *   per video (a ticket per collection, NFX-06 §2) and only there once its files are imported.
 * - **Only for a video whose current manifest, by the recorded author, names the root the store
 *   verified** (NFX-03 §3), and that its author has not deleted (NFX-02 §6: seeders MUST stop
 *   beaconing a deleted manifest). The check is redone every 10 minutes.
 * - **Content** (`beaconContent`): `free: true`, `price_hint: 0`, no mints (NFX-07 §2: a free
 *   seeder does not quote), `chunks: "all"`, and the worker's endpoints: its `iroh` one (slice 5e-3,
 *   NFX-06) when the video is served over iroh, then its `hyperdht` one (NFX-12). An iroh relay is
 *   named only when it is one of the network's (NFX-06 §1), checked again here.
 * - **Self-checked** with core's `parseBeacon` before it goes out.
 * - **Each beacon a round signs is handed on** (`onBeacon`), the newest per video, so NFX-17's
 *   lookup answers (`lookup-answers.ts`) embed it. A relay that told those answers to slow down is
 *   skipped here too while it is paused (`relayPaused`, NFX-17 §3).
 *
 * Seams for the next steps (keeping and seeding what is watched, NFX-18): `roundVideos` alone picks
 * a round's videos and their order, and `beaconContent` alone builds one video's content.
 */
import type {
  IrohRelayUrl,
  NfxAddress,
  NfxVideo,
  NostrEvent,
  NostrPubkey,
  RelayUrl,
  Sha256Hex,
} from '@sovit/core';
import { nfx } from '@sovit/core';

import type { NfxEndpointsWire, NfxStoredVideoWire } from '../../ipc/worker-protocol.js';
import type { Logger } from '../log.js';
import type { SeededVideo } from './seeded.js';
import type { NfxSeederKey } from './seeder-key.js';

export const BEACON_TTL_S = 60;
export const BEACON_EVERY_MS = 30_000;
/**
 * NFX-04 §2: a scoped relay takes one beacon per 20 s per (seeder, video). The clock here is whole
 * seconds, so a second beacon waits until more than this many have passed.
 */
export const BEACON_FLOOR_S = 20;
/** A round starts no video after this long; the rest are left out of it. */
export const ROUND_DEADLINE_MS = 30_000;
/** How long a manifest check holds (NFX-02 §6 deletions are found within this). */
export const MANIFEST_CHECK_S = 600;

/** One video a round may beacon: stored, and seeded with a known author. */
export interface RoundVideo {
  /** `<namespace>:<video-id>` (NFX-01), as the worker's store names it. */
  readonly video: string;
  readonly root: Sha256Hex;
  /** The manifest's author, recorded when it was seeded. */
  readonly author: NostrPubkey;
}

/** What `roundVideos` picks: the videos in the order the round takes them, and the rest. */
export interface RoundPick {
  readonly videos: readonly RoundVideo[];
  /** Videos (`RoundVideo.video`) left out of this round before it starts. None today. */
  readonly leftOut: readonly string[];
}

/** One beacon a round signed, for whoever answers lookups with it (NFX-17). */
export interface SignedBeacon {
  /** The manifest address (`a` tag) it serves. */
  readonly address: NfxAddress;
  readonly video: string;
  readonly event: NostrEvent;
  /** What `beaconContent` built and `event` carries. */
  readonly content: nfx.BeaconContent;
  /** The key that signed it, which signs the answers that embed it. */
  readonly key: NfxSeederKey;
}

export interface NfxBeaconDeps {
  /** The network's scoped relays now; none means no beacon (never to public relays). */
  readonly scopedRelays: () => readonly RelayUrl[];
  /** The seeder key, or `null` while there is none (NFX off, no user signer). */
  readonly key: () => Promise<NfxSeederKey | null>;
  /**
   * Where the worker serves `video` for `seeder`'s beacons (`nfx.endpoint`): each endpoint
   * `null` while it does not serve it that way.
   */
  readonly endpoint: (seeder: NostrPubkey, video: string) => Promise<NfxEndpointsWire>;
  /** Slice 5e-3: the network's iroh relays now (`Settings.nfx.irohRelays`). */
  readonly irohRelays: () => readonly IrohRelayUrl[];
  /** What the worker's store holds (`nfx.videos`). */
  readonly stored: () => Promise<readonly NfxStoredVideoWire[]>;
  readonly seeded: () => readonly SeededVideo[];
  /** The current, undeleted, free manifest at `addr`, or `null` (the catalogue's `nfxVideo`). */
  readonly manifest: (addr: NfxAddress) => Promise<NfxVideo | null>;
  /** Sends a signed event; resolves to how many relays accepted it. */
  readonly send: (event: NostrEvent, relays: readonly RelayUrl[]) => Promise<number>;
  /** Unix seconds. */
  readonly now: () => number;
  /** Milliseconds, for the round's deadline only (default: `Date.now`). */
  readonly clockMs?: () => number;
  /** NFX-17: each beacon a round signs, the newest for its video, as soon as it is signed. */
  readonly onBeacon?: (b: SignedBeacon) => void;
  /** NFX-17 §3: a relay that refused this seeder with `rate-limited:` or `blocked:` lately. */
  readonly relayPaused?: (relay: RelayUrl) => boolean;
  readonly log: Logger;
  readonly timers?: {
    readonly setInterval: (fn: () => void, ms: number) => unknown;
    readonly clearInterval: (h: unknown) => void;
  };
}

export interface BeaconRound {
  readonly published: number;
  /**
   * Seeded videos this round did not beacon because it ran out of time (or, later, past a round's
   * cap): a screen can show them as queued. They go first in the next round.
   */
  readonly leftOut: readonly string[];
  /** Why nothing went out at all, when nothing did (`not-serving`: no video asked is served). */
  readonly idle?: 'no-scoped-relays' | 'no-key' | 'not-serving';
}

/**
 * Slice 5e-3: what a beacon names for one video, from the worker's `nfx.endpoint`: the iroh
 * endpoint first (NFX-06 §6 tries iroh first), then the HyperDHT one. The iroh relay is kept only
 * when it is one of `networkRelays` (NFX-06 §1); the worker checked that too.
 */
export function beaconEndpoints(
  served: NfxEndpointsWire,
  networkRelays: readonly string[],
): nfx.Endpoint[] {
  const out: nfx.Endpoint[] = [];
  const iroh = served.iroh;
  if (iroh !== null)
    out.push({
      t: 'iroh',
      node: iroh.node,
      relay: networkRelays.includes(iroh.relay) ? iroh.relay : '',
      addrs: iroh.addrs,
      // Core writes them in key order (nfx-proto's `BTreeMap`).
      tickets: new Map(iroh.tickets.$map),
    });
  if (served.hyperdht !== null) out.push(served.hyperdht);
  return out;
}

/** What one video's beacon content is built from. */
export interface BeaconContentInput {
  readonly video: nfx.VideoAddr;
  /** `beaconEndpoints` of what the worker serves; at least one. */
  readonly endpoints: readonly nfx.Endpoint[];
}

/**
 * One video's beacon content (NFX-03 §4): a free seeder of every chunk at the endpoints given.
 * The one place content is made, for the periodic beacons and for the fresh ones lookup answers
 * sign (NFX-17 §3). Partial seeding (`chunks`), HyperDHT `renditions` and tickets for only the
 * renditions held (NFX-18) belong here.
 */
export function beaconContent(o: BeaconContentInput): nfx.BeaconContent {
  return {
    v: 1,
    video: o.video,
    endpoints: o.endpoints,
    skipped: [],
    chunks: 'all',
    priceHint: 0n,
    acceptsMints: [],
    free: true,
  };
}

/**
 * `content` signed by `key` as the beacon for `address` at `now`, with this module's TTL, then
 * checked as any reader would; `null` (and a warning) when it does not pass.
 */
export async function signBeaconEvent(
  key: NfxSeederKey,
  address: NfxAddress,
  content: nfx.BeaconContent,
  now: number,
  log: Logger,
): Promise<NostrEvent | null> {
  const tags = nfx.beaconTags(address, now, BEACON_TTL_S);
  if (!tags.ok) return null;
  const event = await key.signBeacon({
    kind: nfx.KIND_BEACON,
    created_at: now,
    tags: tags.value,
    content: nfx.beaconContentText(content),
  });
  const check = nfx.parseBeacon(event, now);
  if (!check.ok || check.value.seeder !== key.pubkey) {
    log.warn('nfx beacons: a built beacon did not verify; not sent');
    return null;
  }
  return event;
}

const realTimers = {
  setInterval: (fn: () => void, ms: number): unknown => setInterval(fn, ms),
  clearInterval: (h: unknown): void => {
    clearInterval(h as ReturnType<typeof setInterval>);
  },
};

export class NfxBeacons {
  private readonly d: NfxBeaconDeps;
  private timer: unknown = null;
  private running: Promise<BeaconRound> | null = null;
  /** A tick came while a round ran: another starts when it ends. */
  private again = false;
  /** `address` → when its manifest was last checked, and whether it may be beaconed. */
  private readonly checked = new Map<string, { readonly at: number; readonly ok: boolean }>();
  /** `<relay> <address>` → when a beacon last went there (unix s), within the floor. */
  private readonly sentAt = new Map<string, number>();
  /** The fair cursor: video → when a round last reached it (unix s). */
  private readonly turns = new Map<string, number>();

  constructor(d: NfxBeaconDeps) {
    this.d = d;
  }

  start(): void {
    if (this.timer !== null) return;
    const timers = this.d.timers ?? realTimers;
    this.timer = timers.setInterval(() => {
      if (this.running !== null) this.again = true;
      else void this.round();
    }, BEACON_EVERY_MS);
    void this.round();
  }

  stop(): void {
    if (this.timer === null) return;
    (this.d.timers ?? realTimers).clearInterval(this.timer);
    this.timer = null;
    this.again = false;
  }

  /** One round (rounds never overlap); never throws. */
  round(): Promise<BeaconRound> {
    this.running ??= this.doRound()
      .catch((): BeaconRound => {
        // A worker or relay failure; the next round tries again. No fields: nothing to redact.
        this.d.log.warn('nfx beacons: the round failed');
        return { published: 0, leftOut: [] };
      })
      .finally(() => {
        this.running = null;
        if (this.again && this.timer !== null) {
          this.again = false;
          void this.round();
        }
      });
    return this.running;
  }

  /**
   * The videos a round may beacon, in the order it takes them: those the store holds and the
   * seeded record names, least recently reached first, the store's order among equals. The one
   * place a round's videos are chosen.
   */
  async roundVideos(now: number): Promise<RoundPick> {
    const seeded = this.d.seeded();
    const videos: RoundVideo[] = [];
    for (const s of await this.d.stored()) {
      const record = seeded.find((x) => x.video === s.video && x.root === s.root);
      if (record !== undefined)
        videos.push({ video: s.video, root: s.root, author: record.author });
    }
    for (const v of [...this.turns.keys()])
      if (!videos.some((x) => x.video === v)) this.turns.delete(v);
    const since = (v: RoundVideo): number => now - (this.turns.get(v.video) ?? -Infinity);
    const order = videos.map((v, i) => ({ v, i, since: since(v) }));
    // Longest since its turn first; never reached is longest. Stable: the store's order otherwise.
    order.sort((x, y) => (x.since === y.since ? x.i - y.i : x.since > y.since ? -1 : 1));
    return { videos: order.map((x) => x.v), leftOut: [] };
  }

  private async doRound(): Promise<BeaconRound> {
    const clock = this.d.clockMs ?? Date.now;
    const started = clock();
    const relays = this.d.scopedRelays();
    if (relays.length === 0) return { published: 0, leftOut: [], idle: 'no-scoped-relays' };
    const key = await this.d.key();
    if (key === null) return { published: 0, leftOut: [], idle: 'no-key' };
    const pick = await this.roundVideos(this.d.now());
    const leftOut = [...pick.leftOut];
    const start = this.d.now();
    for (const [k, at] of [...this.sentAt]) if (start - at > BEACON_FLOOR_S) this.sentAt.delete(k);
    let published = 0;
    let asked = 0;
    let served = 0;
    for (const [i, v] of pick.videos.entries()) {
      if (clock() - started >= ROUND_DEADLINE_MS) {
        for (const rest of pick.videos.slice(i)) leftOut.push(rest.video);
        break;
      }
      this.turns.set(v.video, this.d.now());
      // Before the manifest check: asking the worker is cheap, a relay query is not.
      asked++;
      const endpoints = beaconEndpoints(
        await this.d.endpoint(key.pubkey, v.video),
        this.d.irohRelays(),
      );
      if (endpoints.length === 0) continue;
      served++;
      const address = `${nfx.KIND_MANIFEST}:${v.author}:${v.video}` as NfxAddress;
      if (!(await this.mayBeacon(address, v.root))) continue;
      const now = this.d.now();
      const to = this.due(address, relays, now);
      if (to.length === 0) continue;
      const addr = nfx.VideoAddr.parse(v.video);
      if (!addr.ok) continue;
      const content = beaconContent({ video: addr.value, endpoints });
      const event = await signBeaconEvent(key, address, content, now, this.d.log);
      if (event === null) continue;
      this.d.onBeacon?.({ address, video: v.video, event, content, key });
      // Counted when sent, accepted or not: a relay that refused one still saw it.
      for (const r of to) this.sentAt.set(`${r} ${address}`, now);
      const accepted = await this.d.send(event, to);
      if (accepted > 0) published++;
    }
    return asked > 0 && served === 0
      ? { published, leftOut, idle: 'not-serving' }
      : { published, leftOut };
  }

  /** The relays a beacon for `address` may go to at `now`: past the floor, and not paused. */
  private due(address: NfxAddress, relays: readonly RelayUrl[], now: number): RelayUrl[] {
    return relays.filter((r) => {
      const at = this.sentAt.get(`${r} ${address}`);
      if (at !== undefined && now - at <= BEACON_FLOOR_S) return false;
      return this.d.relayPaused?.(r) !== true;
    });
  }

  /** The current manifest names this root and is not deleted; rechecked every 10 minutes. */
  private async mayBeacon(address: NfxAddress, root: string): Promise<boolean> {
    const now = this.d.now();
    const held = this.checked.get(address);
    if (held !== undefined && now - held.at < MANIFEST_CHECK_S) return held.ok;
    let ok: boolean;
    try {
      const m = await this.d.manifest(address);
      ok = m !== null && m.root === root;
    } catch {
      // A failed check keeps the last answer until the next round, or "no" when there was none.
      return held?.ok ?? false;
    }
    this.checked.set(address, { at: now, ok });
    return ok;
  }
}
