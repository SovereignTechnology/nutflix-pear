/**
 * Which STUN servers a WebRTC client uses (NFX-10 §1): its own, then those that keys name over
 * Nostr, picked by one set of rules for every NFX client. They are the rules of the nfx web
 * library (`web/player/src/endpoints.ts`: `beaconStun`, `ranked`) and of the nfx STUN draft
 * (branch `stun/decentralized`, 1ae4068, pending), which the desktop app's WebRTC side now
 * follows too.
 *
 * - **Sources.** A `StunClaim` is one key naming one server. Today the claims come from the `stun`
 *   endpoints of a video's live beacons, each named by the beacon's signer (`beaconStunClaims`).
 *   A STUN announcement (a signed event whose kind nfx has yet to assign) will name a server the
 *   same way, by its operator's key, and its claims go into the same `selectStunServers`. A key
 *   counts once per server, whichever source it names the server through.
 * - **Global unicast only** (`isGlobalStunAddr`). The address must be in the canonical `ip:port`
 *   form of the `stun` endpoint (`isCanonicalSocketAddr`): an IP literal and never a name (beacons
 *   carry none, and a name could resolve anywhere), and never an IPv4 address written inside IPv6.
 *   It must also be one the desktop app's helper would send an ICE check to (its
 *   `candidates::allowed`), so the worker and the helper agree. That rules out IPv4 "this network",
 *   private, shared (CGNAT, 100.64/10), loopback, link-local, IETF protocol assignments,
 *   benchmarking, documentation, multicast, reserved and broadcast addresses. For IPv6 only 2000::/3
 *   passes (so no unspecified, loopback, link-local, ULA or multicast address), less the
 *   documentation prefixes 2001:db8::/32 and 3fff::/20 (RFC 9637), exactly. A beacon from
 *   anywhere must not point the user's app at their own network.
 * - **Selection** (`selectStunServers`):
 *   1. the client's own servers first, each once (`stunServerKey`), never dropped for a named one;
 *   2. then the named servers that pass the check above and are not its own, ranked by the number
 *      of distinct keys that name each, most first, ties in the order first named;
 *   3. a server named by one key alone only when the client has none of its own and no named
 *      server has two keys or more: a lone stranger's key adds no server beside a better one;
 *   4. at most `MAX_NFX_STUN_SERVERS` (4) in all.
 *
 * Every server used learns the user's IP address and when they watch. Keys are free to make, so
 * "most keys" counts keys a stranger can multiply. The bound is what holds whatever Nostr says: at
 * most 4 servers in all, and never an address that is not global unicast.
 */
import { MAX_NFX_STUN_SERVERS } from '../contracts/index.js';
import type { NfxVideo, NostrEvent } from '../contracts/index.js';
import { MAX_AVAILABILITY_EVENTS, MAX_AVAILABILITY_SEEDERS } from './availability.js';
import { parseBeacon, type Beacon } from './beacon.js';
import { KIND_MANIFEST } from './event.js';
import { ipv6Groups, isCanonicalSocketAddr } from './util.js';

/** The most STUN servers taken from one beacon (the nfx web library's `PER_BEACON`). */
export const MAX_STUN_PER_BEACON = 4;
/** The most claims `selectStunServers` reads; any past it are ignored. */
export const MAX_STUN_CLAIMS = 1024;

/** One key naming one STUN server. */
export interface StunClaim {
  /** The key that signed the event naming the server: a beacon's seeder, an announcement's operator. */
  readonly key: string;
  /** The server, `ip:port` as the event wrote it: untrusted until `isGlobalStunAddr` passes it. */
  readonly addr: string;
}

/** What `selectStunServers` picked: `own` and then `named`, together at most the cap. */
export interface StunSelection {
  /** The client's own servers, each once, in the order given. */
  readonly own: readonly string[];
  /** The servers named over Nostr, in canonical `ip:port` form, best first. */
  readonly named: readonly string[];
}

/** IPv4 as the helper's `v4_global` counts it (crates/iroh-helper/src/rtc/candidates.rs). */
function v4Global([a = 0, b = 0, c = 0]: readonly number[]): boolean {
  const refused =
    a === 0 || // "this network"
    a === 10 || // private
    (a === 100 && b >= 64 && b <= 127) || // shared address space (CGNAT, tailnets)
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // documentation
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // documentation
    (a === 203 && b === 0 && c === 113) || // documentation
    a >= 224; // multicast, reserved, broadcast
  return !refused;
}

/** IPv6 as the helper's `v6_global` counts it: 2000::/3, less the documentation prefixes. */
function v6Global([a = 0, b = 0]: readonly number[]): boolean {
  return (
    (a & 0xe000) === 0x2000 &&
    !(a === 0x2001 && b === 0x0db8) &&
    !(a === 0x3fff && (b & 0xf000) === 0)
  );
}

/**
 * Whether `addr` may be used as a STUN server on a key's say-so: canonical `ip:port` (NFX-10 §1)
 * at a global unicast address, as the module comment defines it.
 */
export function isGlobalStunAddr(addr: string): boolean {
  if (!isCanonicalSocketAddr(addr)) return false;
  const host = addr.slice(0, addr.lastIndexOf(':'));
  if (host.startsWith('[')) {
    const groups = ipv6Groups(host.slice(1, -1));
    return groups !== undefined && v6Global(groups);
  }
  return v4Global(host.split('.').map(Number));
}

/**
 * The form two STUN servers are compared in: the host in lower case (an IPv6 address in its
 * RFC 5952 form) and the port without leading zeros. A canonical address is its own key. Names
 * are compared as written; a name and the address it resolves to are not known to be the same.
 */
export function stunServerKey(server: string): string {
  const colon = server.lastIndexOf(':');
  if (colon < 1) return server.toLowerCase();
  let host = server.slice(0, colon).toLowerCase();
  const port = server.slice(colon + 1);
  if (host.startsWith('[') && host.endsWith(']')) {
    try {
      host = new URL(`http://${host}/`).hostname;
    } catch {
      // Not an IPv6 address: compared as written.
    }
  }
  return `${host}:${/^[0-9]{1,5}$/.test(port) ? String(Number(port)) : port}`;
}

/**
 * The STUN servers one beacon names, each claimed by its seeder: those its `stun` endpoints list
 * that pass `isGlobalStunAddr`, each once, at most `MAX_STUN_PER_BEACON`.
 */
export function stunClaimsOfBeacon(b: Pick<Beacon, 'seeder' | 'content'>): StunClaim[] {
  const out: StunClaim[] = [];
  for (const e of b.content.endpoints) {
    if (e.t !== 'stun') continue;
    for (const addr of e.addrs) {
      if (out.length >= MAX_STUN_PER_BEACON) return out;
      if (isGlobalStunAddr(addr) && !out.some((c) => c.addr === addr))
        out.push({ key: b.seeder, addr });
    }
  }
  return out;
}

/**
 * The STUN servers the live beacons `events` of `video` name at `now` (unix seconds), in the
 * order to rank ties in: newest beacon first. Each beacon must pass NFX-03 in full and serve this
 * manifest's author and address, free (as the play paths count beacons). Only a seeder's newest
 * valid beacon counts (NFX-03 §2), so a seeder can withdraw a server. Bounded as
 * `renditionAvailability` is: the newest `MAX_AVAILABILITY_EVENTS` events, and
 * `MAX_AVAILABILITY_SEEDERS` seeders.
 */
export function beaconStunClaims(
  video: Pick<NfxVideo, 'id' | 'author'>,
  events: readonly NostrEvent[],
  now: number,
): StunClaim[] {
  const newestFirst = [...events]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, MAX_AVAILABILITY_EVENTS);
  const seen = new Set<string>();
  const out: StunClaim[] = [];
  for (const ev of newestFirst) {
    if (seen.size >= MAX_AVAILABILITY_SEEDERS) break;
    const parsed = parseBeacon(ev, now);
    if (!parsed.ok) continue;
    const b = parsed.value;
    if (seen.has(b.seeder)) continue;
    seen.add(b.seeder);
    const address = `${String(KIND_MANIFEST)}:${b.creator}:${b.content.video.toString()}`;
    if (b.creator !== video.author || address !== video.id || !b.content.free) continue;
    out.push(...stunClaimsOfBeacon(b));
  }
  return out;
}

/**
 * The STUN servers to use: `own` (the client's configured ones) and then those `claims` name,
 * by the rules in the module comment, at most `max` in all (default and ceiling
 * `MAX_NFX_STUN_SERVERS`). `own` may hold names; `named` holds canonical addresses only.
 */
export function selectStunServers(
  own: readonly string[],
  claims: Iterable<StunClaim>,
  max: number = MAX_NFX_STUN_SERVERS,
): StunSelection {
  const cap = Number.isSafeInteger(max) ? Math.min(Math.max(max, 0), MAX_NFX_STUN_SERVERS) : 0;
  const mine: string[] = [];
  const mineKeys = new Set<string>();
  for (const s of own) {
    if (mine.length >= cap) break;
    const k = stunServerKey(s);
    if (mineKeys.has(k)) continue;
    mineKeys.add(k);
    mine.push(s);
  }
  // Each named server's distinct keys; a Map keeps the order first named.
  const keysOf = new Map<string, Set<string>>();
  let read = 0;
  for (const c of claims) {
    if (read >= MAX_STUN_CLAIMS) break;
    read += 1;
    if (!isGlobalStunAddr(c.addr) || mineKeys.has(stunServerKey(c.addr))) continue;
    const keys = keysOf.get(c.addr);
    if (keys === undefined) keysOf.set(c.addr, new Set([c.key]));
    else keys.add(c.key);
  }
  // Array#sort is stable, so equal counts keep the order first named.
  const ranked = [...keysOf]
    .map(([addr, keys]) => ({ addr, keys: keys.size }))
    .sort((x, y) => y.keys - x.keys);
  const lone = mine.length === 0 && !ranked.some((r) => r.keys >= 2);
  const named = ranked
    .filter((r) => r.keys >= 2 || lone)
    .slice(0, cap - mine.length)
    .map((r) => r.addr);
  return { own: mine, named };
}
