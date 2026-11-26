/**
 * NFX-17 seeder lookup, the seeder's half (spec §3): a viewer that presses Play publishes a
 * kind-20465 ask, and this node answers at once with a tell, its own signed beacon addressed to
 * the key that asked, so the viewer need not wait for the next periodic beacon. nfx-node's
 * `lookup.rs` (`Book`, `Answerer`) is the reference this mirrors; core's `nfx/lookup.ts` reads
 * and builds the events.
 *
 * - **Where it listens:** on the scoped relays its beacons go to and on the user's read relays
 *   (the general relays the catalogue is read from, §5), one subscription per relay, for the
 *   videos it can answer for: `lookupAskFilter`, from 60 s back, at most `VIDEOS_PER_FILTER`
 *   videos a filter (NFX-04 §2 allows 256). Remade when those videos change, every
 *   `RESUBSCRIBE_S` regardless, and after the relay closed it, with a growing wait. Nothing is
 *   subscribed while beacons have no scoped relay to go to. Each relay is subscribed on its own
 *   so that it is known which relay an ask came from, and an ask that several relays carry is
 *   seen on each.
 * - **What it answers:** an ask that passes §2 (`readLookupAsk`), for a video whose periodic
 *   beacon (`NfxBeacons`, `serve`) is still live, addressed only to the ask's signer: never to a
 *   key named in a tag (that would make this node a reflector).
 * - **Work is bounded before it is done.** At most `VERIFY_PER_SEC` asks a second are verified per
 *   relay, and none while a budget it would need is empty; the budgets of §3's table are looked at
 *   before verifying and charged only after: per (asker, video) `TELLS_PER_ASKER` per
 *   `ASKER_WINDOW_S`, per video a burst of `VIDEO_BURST` then `VIDEO_PER_SEC`, in all a burst of
 *   `OVERALL_BURST` then `OVERALL_PER_SEC`. State per asker is kept only for an ask answered, in
 *   a capped map.
 * - **Relays one by one:** an answered ask is remembered by (id, relay) for `SEEN_S`; the same ask
 *   on the same relay again (a replay, or a relay that keeps ephemeral events and sends them on a
 *   new subscription) is dropped. The same ask on another relay within `ANSWER_AGAIN_S` of its
 *   first arrival gets the one tell already signed, charged nothing in the table, so one relay
 *   that swallows tells cannot silence this seeder on the others.
 * - **A general relay's share** (NFX-03 §7, `NfxRelayShare`): at most `SHARE_TELLS_PER_MIN` tells
 *   a minute to each, a reused one included. This app sends no beacons to general relays, so
 *   the whole share is the tells'; `NfxRelayShare.beacon` is where beacons will count when they
 *   go there. On a scoped relay only the table applies.
 * - **Back-off:** a relay that answers a tell `rate-limited:` or `blocked:` (NIP-01 `OK` false)
 *   is paused, for tells and beacons alike (`paused`), for `PAUSE_FIRST_S`, doubling up to
 *   `PAUSE_MAX_S`; an accepted event ends it, and no answer (a timeout, a lost connection)
 *   counts as neither.
 * - **What a tell embeds:** the newest beacon for the video. One with under `MIN_BEACON_LIFE_S`
 *   to live is replaced first by a fresh one, from the same `beaconContent` and through the key's
 *   `signBeacon`, so a tell stays useful to a viewer whose clock is up to 30 s off.
 * - **Address class (NFX-03 §4, nfx decision record 0114):** a tell goes only to relays this host
 *   reaches at a public address, and it cannot tell which those are yet, so every relay is one.
 *   A tell therefore embeds only a beacon whose every direct address, its iroh tickets' included,
 *   is shown to be public (`namesOnlyPublicAddresses`); a video whose beacon is not gets no answer
 *   anywhere, and is not listened for. Its periodic beacon covers its viewers.
 * - **Empty budget, no room, a paused relay: no answer.** The periodic beacon covers the viewer.
 *
 * Nothing here logs an address, a key or an event id.
 */
import type { NfxAddress, NostrEvent, NostrFilter, RelayUrl } from '@sovit/core';
import { nfx, nostr } from '@sovit/core';

import type { Logger } from '../log.js';
import { namesOnlyPublicAddresses } from './address-class.js';
import { signBeaconEvent, type SignedBeacon } from './beacons.js';
import type { NfxSeederKey } from './seeder-key.js';

/** Asks verified per second per relay; the rest are dropped unverified. */
export const VERIFY_PER_SEC = 32;
/** Tells per (asker, video) per `ASKER_WINDOW_S`: the viewer's one re-ask (§4). */
export const TELLS_PER_ASKER = 2;
export const ASKER_WINDOW_S = 10;
/** Per video: this many at once, then `VIDEO_PER_SEC`. */
export const VIDEO_BURST = 8;
export const VIDEO_PER_SEC = 1;
/** Across all videos: this many at once, then `OVERALL_PER_SEC`. */
export const OVERALL_BURST = 32;
export const OVERALL_PER_SEC = 4;
/** An ask heard on another relay within this long gets the same tell there, at no charge. */
export const ANSWER_AGAIN_S = 10;
/** How long an answered ask is remembered by (id, relay). */
export const SEEN_S = 120;
/** A tell embeds a beacon with at least this long to live; otherwise a fresh one is signed. */
export const MIN_BEACON_LIFE_S = 30;
/** Videos per subscription filter, within NFX-04 §2's 256 tag values. */
export const VIDEOS_PER_FILTER = 250;
/** NFX-03 §7, per seeder key on one general relay: events a minute, beacons and tells. */
export const SHARE_EVENTS_PER_MIN = 30;
/** Of which beacons at most this many. */
export const SHARE_BEACONS_PER_MIN = 20;
/** And tells at most this many: the 10 beacons never take, and up to 5 they leave unused. */
export const SHARE_TELLS_PER_MIN = 15;
const SHARE_WINDOW_S = 60;
/** The first pause after a `rate-limited:` or `blocked:` refusal; each one in a row doubles it. */
export const PAUSE_FIRST_S = 60;
export const PAUSE_MAX_S = 1800;
/** A subscription is remade this often even when nothing changed. */
export const RESUBSCRIBE_S = 600;
/** The wait before subscribing again on a relay that closed the subscription; it doubles. */
export const SUB_RETRY_S = 5;
export const SUB_RETRY_MAX_S = 300;
/** A subscription that lived this long before it closed starts that wait over. */
const SUB_STABLE_S = 60;
/**
 * Answered asks remembered at once. The overall budget answers at most 32 + 4 × 120 = 512 asks
 * in `SEEN_S`, so this cap never cuts the memory short; it bounds it if that ever changes.
 */
const MAX_ANSWERED = 1024;
/** (asker, video) pairs remembered at once; only an answered ask makes one. */
const MAX_ASKERS = 4096;
const TICK_MS = 2000;

/** One relay's key, however its URL is spelled: what the share and the maps here count by. */
function relayKey(url: string): string {
  return nostr.normalizeRelayUrl(url) ?? url;
}

/** Whether a relay's refusal asks the sender to slow down or stop (NIP-01 `OK` prefixes). */
export function refusalPauses(reason: string): boolean {
  return reason.startsWith('rate-limited:') || reason.startsWith('blocked:');
}

interface ShareState {
  /** When each beacon and each tell of the last minute went (unix s), oldest first. */
  readonly beacons: number[];
  readonly tells: number[];
  pausedUntil: number;
  /** The current pause, in seconds; 0 since the relay last accepted. */
  pause: number;
}

/**
 * This seeder key's share of each relay (NFX-03 §7) and each relay's back-off (NFX-17 §3). A
 * general relay takes at most `SHARE_EVENTS_PER_MIN` events a minute, of which at most
 * `SHARE_BEACONS_PER_MIN` beacons and at most `SHARE_TELLS_PER_MIN` tells; beacons never use the
 * tells' 10. A scoped relay is bound only by a pause. Keys are canonical relay URLs.
 */
export class NfxRelayShare {
  private readonly relays = new Map<string, ShareState>();

  private state(relay: string): ShareState {
    const k = relayKey(relay);
    let s = this.relays.get(k);
    if (s === undefined) {
      s = { beacons: [], tells: [], pausedUntil: 0, pause: 0 };
      this.relays.set(k, s);
    }
    return s;
  }

  private static prune(s: ShareState, now: number): void {
    for (const q of [s.beacons, s.tells])
      while (q[0] !== undefined && now - q[0] >= SHARE_WINDOW_S) q.shift();
  }

  /** Whether `relay` refused lately with `rate-limited:` or `blocked:` and is still paused. */
  paused(relay: string, now: number): boolean {
    const s = this.relays.get(relayKey(relay));
    return s !== undefined && now < s.pausedUntil;
  }

  /** Whether a tell may go to `relay` now (`general`: within the share). Counts nothing. */
  room(relay: string, now: number, general: boolean): boolean {
    if (this.paused(relay, now)) return false;
    if (!general) return true;
    const s = this.relays.get(relayKey(relay));
    if (s === undefined) return true;
    NfxRelayShare.prune(s, now);
    return (
      s.tells.length < SHARE_TELLS_PER_MIN &&
      s.tells.length + s.beacons.length < SHARE_EVENTS_PER_MIN
    );
  }

  /** Whether a tell may go to `relay` now; counted against a general relay's share if so. */
  tell(relay: string, now: number, general: boolean): boolean {
    if (!this.room(relay, now, general)) return false;
    if (general) this.state(relay).tells.push(now);
    return true;
  }

  /**
   * Whether a beacon may go to general relay `relay` now; counted if so. Beacons take at most
   * `SHARE_BEACONS_PER_MIN`, so the tells keep 10. This app does not send beacons to general
   * relays yet; this is where they will be counted when it does.
   */
  beacon(relay: string, now: number): boolean {
    if (this.paused(relay, now)) return false;
    const s = this.state(relay);
    NfxRelayShare.prune(s, now);
    if (
      s.beacons.length >= SHARE_BEACONS_PER_MIN ||
      s.beacons.length + s.tells.length >= SHARE_EVENTS_PER_MIN
    )
      return false;
    s.beacons.push(now);
    return true;
  }

  /**
   * `relay`'s answer to an event sent through this share. A `rate-limited:` or `blocked:`
   * refusal pauses it (`PAUSE_FIRST_S`, doubling to `PAUSE_MAX_S`); an acceptance ends the
   * pause. Any other failure (no answer, a lost connection, another refusal) changes nothing.
   */
  answered(relay: string, result: nostr.PublishResult, now: number): void {
    if (result.ok) {
      const s = this.relays.get(relayKey(relay));
      if (s !== undefined) {
        s.pause = 0;
        s.pausedUntil = 0;
      }
      return;
    }
    if (!refusalPauses(result.reason ?? '')) return;
    const s = this.state(relay);
    s.pause = s.pause === 0 ? PAUSE_FIRST_S : Math.min(s.pause * 2, PAUSE_MAX_S);
    s.pausedUntil = now + s.pause;
  }

  /** Forget relays not in `keep` (canonical keys), so the map stays as small as the settings. */
  retain(keep: ReadonlySet<string>): void {
    for (const k of [...this.relays.keys()]) if (!keep.has(k)) this.relays.delete(k);
  }
}

/** A token bucket in whole seconds: `burst` at once, then `perSec` a second. */
class Bucket {
  private tokens: number;
  private at: number;

  constructor(
    private readonly burst: number,
    private readonly perSec: number,
    now: number,
  ) {
    this.tokens = burst;
    this.at = now;
  }

  hasOne(now: number): boolean {
    if (now > this.at) {
      this.tokens = Math.min(this.burst, this.tokens + (now - this.at) * this.perSec);
      this.at = now;
    }
    return this.tokens >= 1;
  }

  take(): void {
    this.tokens = Math.max(0, this.tokens - 1);
  }
}

/** A video this node announces, and the newest beacon it holds for it. */
interface Held {
  readonly address: string;
  /** The newest beacon: the round's, or a fresh one signed for a tell. */
  event: NostrEvent;
  expiration: number;
  content: nfx.BeaconContent;
  key: NfxSeederKey;
  /** When the newest periodic beacon expires: the video is answered for until then. */
  periodicExpires: number;
  /** `namesOnlyPublicAddresses` of `event`'s content: a tell embeds it only if so. */
  publicOk: boolean;
  readonly bucket: Bucket;
  refreshing: Promise<void> | null;
}

interface Answered {
  /** The video asked about. */
  readonly a: string;
  readonly at: number;
  /** The one tell, while it may be sent again (`ANSWER_AGAIN_S`); `null` after. */
  tell: Promise<NostrEvent | null> | null;
  /** The relays it was heard on (canonical keys). */
  readonly relays: Set<string>;
}

interface Sub {
  readonly key: string;
  readonly url: RelayUrl;
  off: () => void;
  readonly cover: string;
  readonly at: number;
  dead: boolean;
  retryAt: number;
  failures: number;
}

export interface NfxLookupAnswersDeps {
  /** The network's scoped relays now (where beacons go); none means no subscription at all. */
  readonly scopedRelays: () => readonly RelayUrl[];
  /** The user's read relays now: the general relays the catalogue is read from (§5). */
  readonly readRelays: () => readonly RelayUrl[];
  /**
   * A live subscription on ONE relay; events arrive unverified, and `onClose` is called when the
   * relay or its connection ended it. Returns the unsubscribe.
   */
  readonly subscribe: (
    relay: RelayUrl,
    filters: readonly NostrFilter[],
    onEvent: (raw: unknown) => void,
    onClose: () => void,
  ) => () => void;
  /** Sends a signed event; resolves to each relay's answer (never rejects for a refusal). */
  readonly publish: (
    event: NostrEvent,
    relays: readonly RelayUrl[],
  ) => Promise<readonly nostr.PublishResult[]>;
  /** Unix seconds. */
  readonly now: () => number;
  readonly log: Logger;
  readonly timers?: {
    readonly setInterval: (fn: () => void, ms: number) => unknown;
    readonly clearInterval: (h: unknown) => void;
  };
}

const realTimers = {
  setInterval: (fn: () => void, ms: number): unknown => setInterval(fn, ms),
  clearInterval: (h: unknown): void => {
    clearInterval(h as ReturnType<typeof setInterval>);
  },
};

function eventId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  try {
    const id = (raw as { readonly id?: unknown }).id;
    return typeof id === 'string' && /^[0-9a-f]{64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The bytes of `e` as event JSON; past any limit when it cannot be written. */
function jsonBytes(e: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(e), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** The ask filters for `videos` (manifest addresses): per network, `VIDEOS_PER_FILTER` each. */
export function askFilters(videos: readonly string[], now: number): NostrFilter[] {
  const byNetwork = new Map<string, string[]>();
  for (const a of videos) {
    const target = nfx.parseATag(a);
    if (!target.ok) continue;
    const ns = target.value.addr.namespace.toString();
    const list = byNetwork.get(ns) ?? [];
    list.push(a);
    byNetwork.set(ns, list);
  }
  const out: NostrFilter[] = [];
  for (const [ns, list] of byNetwork)
    for (let i = 0; i < list.length; i += VIDEOS_PER_FILTER)
      out.push(nfx.lookupAskFilter(ns, list.slice(i, i + VIDEOS_PER_FILTER), now));
  return out;
}

export class NfxLookupAnswers {
  private readonly d: NfxLookupAnswersDeps;
  /** NFX-03 §7 and the back-off, shared with the beacons through `paused`. */
  readonly share = new NfxRelayShare();
  private on = false;
  private timer: unknown = null;
  private overall: Bucket;
  /** By manifest address. */
  private readonly videos = new Map<string, Held>();
  /** By ask id, oldest first. */
  private readonly answered = new Map<string, Answered>();
  /** `<asker> <a>` → when it was answered (unix s), oldest first. */
  private readonly askers = new Map<string, number[]>();
  /** By relay key. */
  private readonly subs = new Map<string, Sub>();
  /** Relay key → (the second, asks verified in it). */
  private readonly verifying = new Map<string, { sec: number; n: number }>();
  /** The scoped relays' keys, as of the last tick. */
  private scoped = new Set<string>();

  constructor(d: NfxLookupAnswersDeps) {
    this.d = d;
    this.overall = new Bucket(OVERALL_BURST, OVERALL_PER_SEC, d.now());
  }

  start(): void {
    if (this.on) return;
    this.on = true;
    this.overall = new Bucket(OVERALL_BURST, OVERALL_PER_SEC, this.d.now());
    this.timer = (this.d.timers ?? realTimers).setInterval(() => {
      this.tick();
    }, TICK_MS);
    this.tick();
  }

  /** Stop answering: every subscription closes and what was held is dropped. */
  stop(): void {
    if (!this.on) return;
    this.on = false;
    if (this.timer !== null) (this.d.timers ?? realTimers).clearInterval(this.timer);
    this.timer = null;
    for (const s of this.subs.values()) s.off();
    this.subs.clear();
    this.videos.clear();
    this.answered.clear();
    this.askers.clear();
    this.verifying.clear();
  }

  /** Whether `relay` is paused by a refusal (NFX-17 §3): beacons skip it too. */
  paused(relay: RelayUrl): boolean {
    return this.share.paused(relay, this.d.now());
  }

  /** Hold `b`, the newest periodic beacon for its video, to answer with (`NfxBeacons.onBeacon`). */
  serve(b: SignedBeacon): void {
    if (!this.on) return;
    const now = this.d.now();
    const parsed = nfx.parseBeacon(b.event, now);
    if (!parsed.ok || parsed.value.seeder !== b.key.pubkey) return;
    if (b.event.tags.find((t) => t[0] === 'a')?.[1] !== b.address) return;
    const expiration = Number(parsed.value.expiration);
    const publicOk = namesOnlyPublicAddresses(parsed.value.content);
    const held = this.videos.get(b.address);
    if (held === undefined) {
      this.videos.set(b.address, {
        address: b.address,
        event: b.event,
        expiration,
        content: b.content,
        key: b.key,
        periodicExpires: expiration,
        publicOk,
        bucket: new Bucket(VIDEO_BURST, VIDEO_PER_SEC, now),
        refreshing: null,
      });
      if (!publicOk)
        this.d.log.info(
          'nfx lookup: a beacon names an address that is not public; no answers for it',
        );
      this.keepSubscribed(now);
      return;
    }
    const wasOk = held.publicOk;
    // The round's beacon is the newest unless a fresh one signed for a tell outlives it.
    if (expiration >= held.expiration || held.key !== b.key) {
      held.event = b.event;
      held.expiration = expiration;
      held.publicOk = publicOk;
    }
    held.content = b.content;
    held.key = b.key;
    held.periodicExpires = expiration;
    if (wasOk && !held.publicOk)
      this.d.log.info(
        'nfx lookup: a beacon names an address that is not public; no answers for it',
      );
    if (wasOk !== held.publicOk) this.keepSubscribed(now);
  }

  /** One event off `sub`'s relay. Everything it says is unverified until `readLookupAsk`. */
  private onAsk(raw: unknown, sub: Sub): void {
    if (!this.on) return;
    const now = this.d.now();
    const id = eventId(raw);
    if (id === null) return;
    const done = this.answered.get(id);
    if (done !== undefined) {
      // Heard here before: a replay. Heard elsewhere lately: the same tell here, at no charge.
      if (done.relays.has(sub.key) || now >= done.at + ANSWER_AGAIN_S || done.tell === null) return;
      if (!this.answering(done.a, now)) return;
      done.relays.add(sub.key);
      void done.tell.then((t) => {
        if (t !== null) this.send(t, sub);
      });
      return;
    }
    if (!nfx.lookupSizeOk('ask', jsonBytes(raw))) return;
    const shape = nfx.lookupShape(raw, now);
    if (!shape.ok || shape.value.type !== 'ask') return;
    const { a, asker } = shape.value;
    const held = this.answering(a, now);
    if (held === null) return;
    // Room for the work first, then for the answer; looking changes nothing.
    if (!this.share.room(sub.key, now, !this.scoped.has(sub.key))) return;
    let slot = this.verifying.get(sub.key);
    if (slot?.sec !== now) {
      slot = { sec: now, n: 0 };
      this.verifying.set(sub.key, slot);
    }
    if (slot.n >= VERIFY_PER_SEC) return;
    if (!this.overall.hasOne(now)) return;
    const pair = `${asker} ${a}`;
    if (this.answeredLately(pair, now) >= TELLS_PER_ASKER) return;
    if (!held.bucket.hasOne(now)) return;
    slot.n += 1;
    const ask = nfx.readLookupAsk(raw, now);
    if (!ask.ok || ask.value.id !== id || ask.value.a !== a || ask.value.asker !== asker) return;
    // Verified: now charge, and remember it.
    held.bucket.take();
    this.overall.take();
    this.noteAsker(pair, now);
    const tell = this.tellFor(held, ask.value, now);
    this.answered.set(id, { a, at: now, tell, relays: new Set([sub.key]) });
    while (this.answered.size > MAX_ANSWERED) {
      const oldest = this.answered.keys().next().value;
      if (oldest === undefined) break;
      this.answered.delete(oldest);
    }
    void tell.then((t) => {
      if (t !== null) this.send(t, sub);
    });
  }

  /** The video at `a` while it may be answered for: its periodic beacon live and public. */
  private answering(a: string, now: number): Held | null {
    const held = this.videos.get(a);
    return held !== undefined && now < held.periodicExpires && held.publicOk ? held : null;
  }

  private answeredLately(pair: string, now: number): number {
    return (this.askers.get(pair) ?? []).filter((at) => now < at + ASKER_WINDOW_S).length;
  }

  private noteAsker(pair: string, now: number): void {
    const times = (this.askers.get(pair) ?? []).filter((at) => now < at + ASKER_WINDOW_S);
    times.push(now);
    this.askers.delete(pair);
    if (this.askers.size >= MAX_ASKERS) this.pruneAskers(now);
    while (this.askers.size >= MAX_ASKERS) {
      const oldest = this.askers.keys().next().value;
      if (oldest === undefined) break;
      this.askers.delete(oldest);
    }
    this.askers.set(pair, times);
  }

  private pruneAskers(now: number): void {
    for (const [k, times] of [...this.askers]) {
      const last = times[times.length - 1];
      if (last === undefined || now >= last + ASKER_WINDOW_S) this.askers.delete(k);
    }
  }

  /** The tell for a verified ask: the newest beacon (fresh if it is short-lived), signed. */
  private async tellFor(held: Held, ask: nfx.LookupAsk, now: number): Promise<NostrEvent | null> {
    try {
      if (held.expiration - now < MIN_BEACON_LIFE_S) await this.refresh(held, now);
      const beacon = held.event;
      if (!held.publicOk || held.expiration - now < MIN_BEACON_LIFE_S) return null;
      const template = nfx.lookupTellTemplate(beacon, ask.asker, now);
      if (!template.ok) return null;
      const tell = await held.key.signTell(template.value);
      // As the viewer will read it: to the key that asked, about the video it asked about.
      const check = nfx.readLookupTell(tell, { now, asker: ask.asker, a: ask.a });
      if (
        !check.ok ||
        check.value.seeder !== beacon.pubkey ||
        !nfx.lookupSizeOk('tell', jsonBytes(tell))
      ) {
        this.d.log.warn('nfx lookup: a built tell did not verify; not sent');
        return null;
      }
      return tell;
    } catch {
      // The key was locked or replaced meanwhile. No fields: nothing to redact.
      this.d.log.warn('nfx lookup: a tell could not be signed');
      return null;
    }
  }

  /** A fresh beacon from the held content, one at a time per video (§3, `MIN_BEACON_LIFE_S`). */
  private refresh(held: Held, now: number): Promise<void> {
    held.refreshing ??= (async (): Promise<void> => {
      const key = held.key;
      const fresh = await signBeaconEvent(
        key,
        held.address as NfxAddress,
        held.content,
        now,
        this.d.log,
      );
      if (fresh === null || this.videos.get(held.address) !== held || held.key !== key) return;
      const parsed = nfx.parseBeacon(fresh, now);
      if (!parsed.ok) return;
      const expiration = Number(parsed.value.expiration);
      if (expiration <= held.expiration) return;
      held.event = fresh;
      held.expiration = expiration;
      held.publicOk = namesOnlyPublicAddresses(parsed.value.content);
    })().finally(() => {
      held.refreshing = null;
    });
    return held.refreshing;
  }

  /** Send `tell` to `sub`'s relay, within its share and pause, and read its answer. */
  private send(tell: NostrEvent, sub: Sub): void {
    // The relay may have been subscribed again meanwhile; it only has to be one still used.
    if (!this.on || !this.subs.has(sub.key)) return;
    if (!this.share.tell(sub.key, this.d.now(), !this.scoped.has(sub.key))) return;
    void this.d.publish(tell, [sub.url]).then(
      (results) => {
        const r = results[0];
        if (r !== undefined) this.share.answered(sub.key, r, this.d.now());
      },
      () => undefined,
    );
  }

  private tick(): void {
    if (!this.on) return;
    const now = this.d.now();
    this.expire(now);
    this.keepSubscribed(now);
  }

  /** Drop what is past its time: stopped videos, old answers, quiet askers. */
  private expire(now: number): void {
    for (const [a, held] of [...this.videos])
      if (now >= held.periodicExpires) this.videos.delete(a);
    for (const [id, done] of this.answered) {
      if (now >= done.at + SEEN_S) this.answered.delete(id);
      else if (now >= done.at + ANSWER_AGAIN_S || !this.videos.has(done.a)) done.tell = null;
    }
    this.pruneAskers(now);
  }

  /** One subscription per relay for the videos answered for: opened, remade, retried, closed. */
  private keepSubscribed(now: number): void {
    const scoped = this.d.scopedRelays();
    const relays = new Map<string, RelayUrl>();
    if (scoped.length > 0)
      for (const url of [...scoped, ...this.d.readRelays()]) {
        const k = relayKey(url);
        if (!relays.has(k)) relays.set(k, url);
      }
    this.scoped = new Set(scoped.map(relayKey));
    this.share.retain(new Set(relays.keys()));
    for (const k of [...this.verifying.keys()]) if (!relays.has(k)) this.verifying.delete(k);
    const wanted = [...this.videos.values()]
      .filter((h) => now < h.periodicExpires && h.publicOk)
      .map((h) => h.address)
      .sort();
    for (const [k, s] of [...this.subs]) {
      if (wanted.length > 0 && relays.has(k)) continue;
      s.off();
      this.subs.delete(k);
    }
    if (wanted.length === 0) return;
    const cover = wanted.join(' ');
    const filters = askFilters(wanted, now);
    for (const [k, url] of relays) {
      const old = this.subs.get(k);
      if (old !== undefined) {
        const due = old.dead
          ? now >= old.retryAt
          : old.cover !== cover || now - old.at >= RESUBSCRIBE_S;
        if (!due) continue;
        old.off();
      }
      const sub: Sub = {
        key: k,
        url,
        off: () => undefined,
        cover,
        at: now,
        dead: false,
        retryAt: 0,
        failures: old?.dead === true ? old.failures : 0,
      };
      let live = true;
      this.subs.set(k, sub);
      const off = this.d.subscribe(
        url,
        filters,
        (raw) => {
          if (live) this.onAsk(raw, sub);
        },
        () => {
          // Deaf on this relay until it is subscribed again. The pool closed it already, so it
          // is never closed from here again.
          if (!live) return;
          live = false;
          const t = this.d.now();
          sub.dead = true;
          sub.failures = t - sub.at >= SUB_STABLE_S ? 1 : sub.failures + 1;
          sub.retryAt = t + Math.min(SUB_RETRY_S * 2 ** (sub.failures - 1), SUB_RETRY_MAX_S);
        },
      );
      sub.off = () => {
        if (!live) return;
        live = false;
        off();
      };
    }
  }
}
