/**
 * NFX beacons (NFX-03, ADR 0020 slice 5c): every minute, while this node serves its NFX videos,
 * one kind-20464 beacon per video, signed by the seeder key, sent to the network's scoped relays
 * and nowhere else.
 *
 * - **TTL 120 s, republished every 60 s** (NFX-03 §3: at TTL/2), within the scoped relays' rate
 *   limit of one per 20 s per (seeder, address) (NFX-04 §2).
 * - **Only while the worker serves.** No endpoint means no beacon: a beacon never names a
 *   listener that is down. Slice 5e-3: the worker is asked per video, since the iroh endpoint is
 *   per video (a ticket per collection, NFX-06 §2) and only there once its files are imported.
 * - **Only for a video whose current manifest, by the recorded author, names the root the store
 *   verified** (NFX-03 §3), and that its author has not deleted (NFX-02 §6: seeders MUST stop
 *   beaconing a deleted manifest). The check is redone every 10 minutes.
 * - **Content:** `free: true`, `price_hint: 0`, no mints (NFX-07 §2: a free seeder does not quote),
 *   `chunks: "all"`, and the worker's endpoints: its `iroh` one (slice 5e-3, NFX-06) when the
 *   video is served over iroh, then its `hyperdht` one (NFX-12). An iroh relay is named only when
 *   it is one of the network's (NFX-06 §1), checked again here.
 * - **Self-checked** with core's `parseBeacon` before it goes out.
 */
import type {
  IrohRelayUrl,
  NfxAddress,
  NfxVideo,
  NostrEvent,
  NostrPubkey,
  RelayUrl,
} from '@sovit/core';
import { nfx } from '@sovit/core';

import type { NfxEndpointsWire, NfxStoredVideoWire } from '../../ipc/worker-protocol.js';
import type { Logger } from '../log.js';
import type { SeededVideo } from './seeded.js';
import type { NfxSeederKey } from './seeder-key.js';

export const BEACON_TTL_S = 120;
export const BEACON_EVERY_MS = 60_000;
/** How long a manifest check holds (NFX-02 §6 deletions are found within this). */
export const MANIFEST_CHECK_S = 600;

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
  readonly now: () => number;
  readonly log: Logger;
  readonly timers?: {
    readonly setInterval: (fn: () => void, ms: number) => unknown;
    readonly clearInterval: (h: unknown) => void;
  };
}

export interface BeaconRound {
  readonly published: number;
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
  /** `address` → when its manifest was last checked, and whether it may be beaconed. */
  private readonly checked = new Map<string, { readonly at: number; readonly ok: boolean }>();

  constructor(d: NfxBeaconDeps) {
    this.d = d;
  }

  start(): void {
    if (this.timer !== null) return;
    const timers = this.d.timers ?? realTimers;
    this.timer = timers.setInterval(() => {
      void this.round();
    }, BEACON_EVERY_MS);
    void this.round();
  }

  stop(): void {
    if (this.timer === null) return;
    (this.d.timers ?? realTimers).clearInterval(this.timer);
    this.timer = null;
  }

  /** One round (rounds never overlap); never throws. */
  round(): Promise<BeaconRound> {
    this.running ??= this.doRound()
      .catch((): BeaconRound => {
        // A worker or relay failure; the next round tries again. No fields: nothing to redact.
        this.d.log.warn('nfx beacons: the round failed');
        return { published: 0 };
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async doRound(): Promise<BeaconRound> {
    const relays = this.d.scopedRelays();
    if (relays.length === 0) return { published: 0, idle: 'no-scoped-relays' };
    const key = await this.d.key();
    if (key === null) return { published: 0, idle: 'no-key' };
    const seeded = this.d.seeded();
    let published = 0;
    let asked = 0;
    let served = 0;
    for (const s of await this.d.stored()) {
      const record = seeded.find((x) => x.video === s.video && x.root === s.root);
      if (record === undefined) continue;
      // Before the manifest check: asking the worker is cheap, a relay query is not.
      asked++;
      const endpoints = beaconEndpoints(
        await this.d.endpoint(key.pubkey, s.video),
        this.d.irohRelays(),
      );
      if (endpoints.length === 0) continue;
      served++;
      const address = `${nfx.KIND_MANIFEST}:${record.author}:${s.video}` as NfxAddress;
      if (!(await this.mayBeacon(address, s.root))) continue;
      const event = await this.build(key, address, s.video, endpoints);
      if (event === null) continue;
      const accepted = await this.d.send(event, relays);
      if (accepted > 0) published++;
    }
    return asked > 0 && served === 0 ? { published, idle: 'not-serving' } : { published };
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

  private async build(
    key: NfxSeederKey,
    address: NfxAddress,
    video: string,
    endpoints: readonly nfx.Endpoint[],
  ): Promise<NostrEvent | null> {
    const addr = nfx.VideoAddr.parse(video);
    const now = this.d.now();
    const tags = nfx.beaconTags(address, now, BEACON_TTL_S);
    if (!addr.ok || !tags.ok) return null;
    const content = nfx.beaconContentText({
      v: 1,
      video: addr.value,
      endpoints,
      skipped: [],
      chunks: 'all',
      priceHint: 0n,
      acceptsMints: [],
      free: true,
    });
    const event = await key.signBeacon({
      kind: nfx.KIND_BEACON,
      created_at: now,
      tags: tags.value,
      content,
    });
    const check = nfx.parseBeacon(event, now);
    if (!check.ok || check.value.seeder !== key.pubkey) {
      this.d.log.warn('nfx beacons: a built beacon did not verify; not sent');
      return null;
    }
    return event;
  }
}
