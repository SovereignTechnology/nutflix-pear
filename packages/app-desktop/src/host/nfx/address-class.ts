/**
 * Which addresses a beacon may name on a public relay (NFX-03 §4 as amended by nfx decision record
 * 0114; NFX-17 §3): only public unicast ones. The seeder's LAN, VPN, tailnet and loopback
 * addresses go only to relays on its own networks, and this host cannot tell those apart yet, so
 * every relay is public here and a beacon either names public addresses only or does not go into
 * a lookup answer at all.
 *
 * - **Public** is nfx-node's `is_public`, the same tables: an IPv4 address outside IANA's
 *   special-purpose blocks, multicast and 240/4; an IPv6 address in 2000::/3 outside the IETF
 *   protocol assignments (2001::/23), documentation (2001:db8::/32, 3fff::/20) and 6to4
 *   (2002::/16, which wraps an IPv4 address that may be private); never port 0. It fails closed:
 *   anything not known to be public is not, IPv4-mapped IPv6 and any zone-scoped address included.
 * - **Every direct address**: an `iroh` endpoint's `addrs`, and the direct addresses inside each of
 *   its tickets (NFX-06 §2), which can be more than `addrs` shows. The tickets are iroh-blobs
 *   `BlobTicket`s; core has no reader for them and the worker hands them over opaque, so
 *   `decodeBlobTicket` reads the one wire form iroh-blobs 0.103 writes (`Variant0`, checked against
 *   the vendored nfx vectors) and refuses anything else. A ticket it cannot read, or one that names
 *   another node, makes the beacon unprovable.
 * - An endpoint type this module does not read for addresses (`https`, `webrtc`, `hyper`, one the
 *   parser skipped) makes the beacon unprovable too. This app's beacons carry `iroh` and
 *   `hyperdht` only (`beaconEndpoints`); widen the list here when that changes.
 *
 * Pure, no clock, no I/O. Nothing here logs an address.
 */
import type { nfx } from '@sovit/core';

/** The longest ticket string a beacon carries (`isNfxBlobTicket`). */
const MAX_TICKET_CHARS = 4096;
/** Direct addresses one ticket may name before it is refused as unreadable. */
const MAX_TICKET_ADDRS = 64;
/** The longest relay URL read out of a ticket. */
const MAX_TICKET_URL_BYTES = 2048;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** IPv4 blocks that are never public (nfx-node `NOT_PUBLIC_V4`): [first octets, prefix]. */
const NOT_PUBLIC_V4: readonly (readonly [readonly number[], number])[] = [
  [[0, 0, 0, 0], 8], // "this network"
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // shared address space (CGNAT, tailnets)
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // documentation
  [[192, 88, 99, 0], 24], // 6to4 relay anycast (deprecated)
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // documentation
  [[203, 0, 113, 0], 24], // documentation
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved, and the broadcast address
];

/** IPv6 blocks inside 2000::/3 that are not public (nfx-node `NOT_PUBLIC_V6`). */
const NOT_PUBLIC_V6: readonly (readonly [readonly number[], number])[] = [
  [[0x20, 0x01, 0x00, 0x00], 23], // IETF protocol assignments: Teredo, ORCHID, benchmarking…
  [[0x20, 0x01, 0x0d, 0xb8], 32], // documentation
  [[0x20, 0x02], 16], // 6to4: wraps an IPv4 address, which may be a private one
  [[0x3f, 0xff, 0x00], 20], // documentation
];

/** Whether the first `len` bits of `ip` are those of `net`. */
function within(ip: Uint8Array, net: readonly number[], len: number): boolean {
  for (let bit = 0; bit < len; bit += 8) {
    const take = Math.min(8, len - bit);
    const mask = (0xff << (8 - take)) & 0xff;
    const byte = bit / 8;
    if (((ip[byte] ?? 0) & mask) !== ((net[byte] ?? 0) & mask)) return false;
  }
  return true;
}

/** One direct address: 4 or 16 octets and a port. */
export interface DirectAddr {
  readonly ip: Uint8Array;
  readonly port: number;
}

/** nfx-node `is_public`: a public unicast address peers on the internet can dial. Fails closed. */
export function isPublicAddr(a: DirectAddr): boolean {
  if (!Number.isInteger(a.port) || a.port < 1 || a.port > 0xffff) return false;
  if (a.ip.length === 4) return !NOT_PUBLIC_V4.some(([net, len]) => within(a.ip, net, len));
  if (a.ip.length !== 16) return false;
  return within(a.ip, [0x20], 3) && !NOT_PUBLIC_V6.some(([net, len]) => within(a.ip, net, len));
}

function v4Octets(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    // Canonical decimal only: no leading zero, which some parsers read as octal.
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    out.push(v);
  }
  return out;
}

/** An IPv6 literal (no brackets, no zone) as 16 octets, or `null`. */
function v6Octets(s: string): Uint8Array | null {
  if (s.length < 2 || s.length > 45) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (h: string, last: boolean): number[] | null => {
    if (h === '') return [];
    const out: number[] = [];
    const parts = h.split(':');
    for (const [i, g] of parts.entries()) {
      if (last && i === parts.length - 1 && g.includes('.')) {
        const v4 = v4Octets(g);
        if (v4 === null) return null;
        out.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
      } else if (/^[0-9a-fA-F]{1,4}$/.test(g)) {
        out.push(parseInt(g, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const head = groups(halves[0] ?? '', halves.length === 1);
  const tail = halves.length === 2 ? groups(halves[1] ?? '', true) : [];
  if (head === null || tail === null) return null;
  let all: number[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    all = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    all = [...head, ...new Array<number>(fill).fill(0), ...tail];
  }
  const out = new Uint8Array(16);
  for (const [i, g] of all.entries()) {
    out[2 * i] = g >> 8;
    out[2 * i + 1] = g & 0xff;
  }
  return out;
}

/** `a.b.c.d:port` or `[ipv6]:port`, as iroh prints a socket address, or `null`. */
export function parseSocketAddr(s: string): DirectAddr | null {
  if (s.length > 64) return null;
  let host: string;
  let port: string;
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    if (close < 0 || s[close + 1] !== ':') return null;
    host = s.slice(1, close);
    port = s.slice(close + 2);
    // A zone (`%eth0`) scopes a link-local address: never public, and not parsed.
    if (host.includes('%')) return null;
  } else {
    const colon = s.lastIndexOf(':');
    if (colon < 0) return null;
    host = s.slice(0, colon);
    port = s.slice(colon + 1);
  }
  if (!/^(?:0|[1-9][0-9]{0,4})$/.test(port)) return null;
  const p = Number(port);
  if (p > 0xffff) return null;
  if (s.startsWith('[')) {
    const ip = v6Octets(host);
    return ip === null ? null : { ip, port: p };
  }
  const v4 = v4Octets(host);
  return v4 === null ? null : { ip: Uint8Array.from(v4), port: p };
}

/** Whether `s` (an address as a beacon's `addrs` spells it) is public. Unreadable is not. */
export function isPublicSocketAddr(s: string): boolean {
  const a = parseSocketAddr(s);
  return a !== null && isPublicAddr(a);
}

/** RFC 4648 base32, lowercase, no padding, as iroh-tickets writes it; `null` unless canonical. */
function base32(s: string): Uint8Array | null {
  // 1, 3 and 6 characters past a whole group spell no whole byte.
  if ([1, 3, 6].includes(s.length % 8)) return null;
  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (const c of s) {
    const v = BASE32.indexOf(c);
    if (v < 0) return null;
    acc = ((acc << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  // Leftover bits must be zero: one string per byte string, as data-encoding checks.
  if ((acc & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

/** A postcard reader that refuses anything not exactly as postcard writes it. */
class Reader {
  private at = 0;
  constructor(private readonly b: Uint8Array) {}

  get done(): boolean {
    return this.at === this.b.length;
  }

  bytes(n: number): Uint8Array | null {
    if (this.at + n > this.b.length) return null;
    const out = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }

  /** An unsigned LEB128 varint of at most `max`, in its shortest form. */
  varint(max: number): number | null {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.b[this.at++];
      if (byte === undefined) return null;
      v += (byte & 0x7f) * 2 ** (7 * i);
      if ((byte & 0x80) === 0) {
        if (i > 0 && byte === 0) return null; // a longer form than needed
        return v <= max ? v : null;
      }
    }
    return null;
  }
}

/** What a `BlobTicket` names, as far as an address class goes. */
export interface TicketAddrs {
  /** The iroh endpoint id, 64 lowercase hex. */
  readonly node: string;
  readonly relay: string | null;
  readonly addrs: readonly DirectAddr[];
}

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/**
 * The node, relay and direct addresses of an iroh-blobs `BlobTicket` string (iroh-blobs 0.103,
 * iroh-tickets 1.0: `blob` + base32 of postcard `Variant0 { node: { endpoint_id, info: {
 * relay_url, direct_addresses } }, format, hash }`), or `null` for anything else.
 */
export function decodeBlobTicket(ticket: string): TicketAddrs | null {
  if (ticket.length > MAX_TICKET_CHARS || !ticket.startsWith('blob')) return null;
  const bytes = base32(ticket.slice(4));
  if (bytes === null) return null;
  const r = new Reader(bytes);
  if (r.varint(0) !== 0) return null; // TicketWireFormat::Variant0
  const id = r.bytes(32);
  if (id === null) return null;
  let relay: string | null = null;
  const some = r.varint(1);
  if (some === null) return null;
  if (some === 1) {
    const len = r.varint(MAX_TICKET_URL_BYTES);
    const url = len === null ? null : r.bytes(len);
    if (url === null) return null;
    try {
      relay = new TextDecoder('utf-8', { fatal: true }).decode(url);
    } catch {
      return null;
    }
  }
  const count = r.varint(MAX_TICKET_ADDRS);
  if (count === null) return null;
  const addrs: DirectAddr[] = [];
  for (let i = 0; i < count; i++) {
    const family = r.varint(1); // SocketAddr::V4, ::V6
    if (family === null) return null;
    const ip = r.bytes(family === 0 ? 4 : 16);
    const port = r.varint(0xffff);
    if (ip === null || port === null) return null;
    addrs.push({ ip: Uint8Array.from(ip), port });
  }
  if (r.varint(1) === null) return null; // BlobFormat: Raw, HashSeq
  if (r.bytes(32) === null || !r.done) return null; // the hash, and nothing after it
  return { node: hex(id), relay, addrs };
}

/**
 * Whether every direct address `content` names is public unicast (see the module comment), its
 * iroh tickets' included. `false` whenever that cannot be shown.
 */
export function namesOnlyPublicAddresses(content: nfx.BeaconContent): boolean {
  if (content.skipped.length > 0) return false;
  for (const e of content.endpoints) {
    switch (e.t) {
      case 'hyperdht':
        // A peer key and its bind: no address.
        break;
      case 'stun':
        if (!e.addrs.every(isPublicSocketAddr)) return false;
        break;
      case 'iroh': {
        if (!e.addrs.every(isPublicSocketAddr)) return false;
        for (const t of e.tickets.values()) {
          const read = decodeBlobTicket(t);
          if (read?.node !== e.node || !read.addrs.every(isPublicAddr)) return false;
        }
        break;
      }
      case 'https':
      case 'webrtc':
      case 'hyper':
        return false;
    }
  }
  return true;
}
