/**
 * Which STUN servers a WebRTC client uses (NFX-10 §1, "the creator's, or the fallback": nfx
 * ADR 0107, the maintainer's decision of 2026-11-24, which `stun-select.json` pins): its own,
 * then the ones the video's creator names. The rules are the nfx web library's
 * (`web/player/src/endpoints.ts`: `selectStun`) and nfx-proto's (`stun::select`).
 *
 * - **Sources.** A `StunClaim` is one key naming one server: the `stun` endpoints of a video's
 *   live beacons, each named by the beacon's signer (`beaconStunClaims`). Routinely only the
 *   creator's count (`creatorStunServers`): a beacon whose signer is the creator its `a` tag names,
 *   the manifest's author. Keys are free, so a count of other keys proves nothing, and no number of
 *   them adds a server here. Another seeder's server is reached only by NFX-10 §1's fallback, for
 *   one peer it already signals with. A STUN service announcement (kind 33478) is a directory for
 *   people choosing servers to configure, and is never used automatically.
 * - **Global unicast only** (`isGlobalStunAddr`). The address must be in the canonical `ip:port`
 *   form of the `stun` endpoint (`isCanonicalSocketAddr`): an IP literal and never a name (beacons
 *   carry none, and a name could resolve anywhere), and never an IPv4 address written inside IPv6.
 *   It must also be one the desktop app's helper would send an ICE check to (its
 *   `candidates::allowed`), so the worker and the helper agree. That rules out IPv4 "this network",
 *   private, shared (CGNAT, 100.64/10), loopback, link-local, IETF protocol assignments,
 *   benchmarking, documentation, multicast, reserved and broadcast addresses. For IPv6 only 2000::/3
 *   passes (so no unspecified, loopback, link-local, ULA or multicast address), less the
 *   documentation prefixes 2001:db8::/32 and 3fff::/20 (RFC 9637), exactly. A beacon from
 *   anywhere must not point the user's app at their own network. A server taken from Nostr also
 *   needs a port of `MIN_STUN_PORT` (1024) or above (`isAskableStunAddr`), so a beacon cannot aim
 *   the app at a well-known service.
 * - **Selection** (`selectStunServers`):
 *   1. the client's own servers first, each once (`stunServerKey`), never dropped for a named one,
 *      on any port;
 *   2. then the creator's, in the order heard, each once, if askable and not its own;
 *   3. no other server named over Nostr;
 *   4. at most `MAX_NFX_STUN_SERVERS` (4) in all.
 *
 * Every server used learns the user's IP address and when they watch. So the app's address goes
 * only to its own servers, to those the creator of the video the user chose names, and (by the
 * fallback, not here) to a server at the address of a peer it already signals with.
 */
import { MAX_NFX_STUN_SERVERS } from '../contracts/index.js';
import type { NfxVideo, NostrEvent } from '../contracts/index.js';
import { MAX_AVAILABILITY_EVENTS, MAX_AVAILABILITY_SEEDERS } from './availability.js';
import { parseBeacon, type Beacon } from './beacon.js';
import { KIND_MANIFEST } from './event.js';
import { ipv6Groups, isCanonicalSocketAddr } from './util.js';

/** The most STUN servers taken from one beacon (the nfx web library's `PER_BEACON`). */
export const MAX_STUN_PER_BEACON = 4;
/** The most named servers `selectStunServers` reads; any past it are ignored. */
export const MAX_STUN_CLAIMS = 1024;
/**
 * The lowest port of a STUN server taken from Nostr (NFX-10 §1; nfx `MIN_STUN_PORT`,
 * `stun::MIN_FALLBACK_PORT`): below it are well-known services (DNS, NTP, SNMP, ...). The
 * client's own servers may use any port.
 */
export const MIN_STUN_PORT = 1024;

/** One key naming one STUN server. */
export interface StunClaim {
  /** The key that signed the beacon naming the server: its seeder, which may be the creator. */
  readonly key: string;
  /** The server, `ip:port` as the event wrote it: untrusted until `isGlobalStunAddr` passes it. */
  readonly addr: string;
}

/** What `selectStunServers` picked: `own` and then `named`, together at most the cap. */
export interface StunSelection {
  /** The client's own servers, each once, in the order given. */
  readonly own: readonly string[];
  /** The servers creators named over Nostr, in canonical `ip:port` form, in the order heard. */
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
 * Whether `addr` may be asked on Nostr's say-so (NFX-10 §1): `isGlobalStunAddr`, on a port of
 * `MIN_STUN_PORT` or above.
 */
export function isAskableStunAddr(addr: string): boolean {
  return isGlobalStunAddr(addr) && Number(addr.slice(addr.lastIndexOf(':') + 1)) >= MIN_STUN_PORT;
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
 * The STUN servers the creator of `video` names at `now`: those of `beaconStunClaims` whose key is
 * the manifest's author (the creator a beacon's `a` tag names, which that function already
 * matches), in the order heard. A creator whose node signs beacons with another key names none
 * here: its servers are for the fallback.
 */
export function creatorStunServers(
  video: Pick<NfxVideo, 'id' | 'author'>,
  events: readonly NostrEvent[],
  now: number,
): string[] {
  return beaconStunClaims(video, events, now)
    .filter((c) => c.key === video.author)
    .map((c) => c.addr);
}

/**
 * The STUN servers to use: `own` (the client's configured ones), then those `creator` lists (the
 * servers creators named, `creatorStunServers`), by the rules in the module comment, at most `max`
 * in all (default and ceiling `MAX_NFX_STUN_SERVERS`). `own` may hold names; `named` holds
 * canonical addresses only. nfx-proto's `stun::select(own, creator_named, max)`.
 */
export function selectStunServers(
  own: readonly string[],
  creator: Iterable<string>,
  max: number = MAX_NFX_STUN_SERVERS,
): StunSelection {
  const cap = Number.isSafeInteger(max) ? Math.min(Math.max(max, 0), MAX_NFX_STUN_SERVERS) : 0;
  const mine: string[] = [];
  const taken = new Set<string>();
  for (const s of own) {
    if (mine.length >= cap) break;
    const k = stunServerKey(s);
    if (taken.has(k)) continue;
    taken.add(k);
    mine.push(s);
  }
  const named: string[] = [];
  let read = 0;
  for (const addr of creator) {
    if (mine.length + named.length >= cap || read >= MAX_STUN_CLAIMS) break;
    read += 1;
    if (!isAskableStunAddr(addr)) continue;
    const k = stunServerKey(addr);
    if (taken.has(k)) continue;
    taken.add(k);
    named.push(addr);
  }
  return { own: mine, named };
}
