/**
 * Test support (not a suite): iroh-blobs `BlobTicket` strings with chosen contents, written the way
 * iroh-blobs 0.103 writes them (postcard `Variant0`, then `blob` + lowercase base32 without
 * padding), so tests can make tickets naming the addresses they need.
 */

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function base32(bytes: readonly number[]): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(acc >> bits) & 31] ?? '';
    }
  }
  if (bits > 0) out += BASE32[(acc << (5 - bits)) & 31] ?? '';
  return out;
}

export function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return out;
}

const hexBytes = (h: string): number[] =>
  Array.from({ length: h.length / 2 }, (_, i) => parseInt(h.slice(2 * i, 2 * i + 2), 16));

export interface TicketAddr {
  readonly ip: readonly number[];
  readonly port: number;
}

/** The postcard bytes of a `BlobTicket` (`Variant0`) for `node` (64 hex). */
export function ticketBytes(
  node: string,
  relay: string | null,
  addrs: readonly TicketAddr[],
  hash = 'ab'.repeat(32),
): number[] {
  const out: number[] = [0, ...hexBytes(node)];
  if (relay === null) out.push(0);
  else {
    const url = [...new TextEncoder().encode(relay)];
    out.push(1, ...varint(url.length), ...url);
  }
  out.push(...varint(addrs.length));
  for (const a of addrs) out.push(a.ip.length === 4 ? 0 : 1, ...a.ip, ...varint(a.port));
  out.push(1, ...hexBytes(hash)); // BlobFormat::HashSeq, then the hash
  return out;
}

/** A `BlobTicket` string for `node` naming `addrs` and, if given, `relay`. */
export function blobTicket(
  node: string,
  addrs: readonly TicketAddr[],
  relay: string | null = 'https://iroh-relay.test/',
): string {
  return `blob${base32(ticketBytes(node, relay, addrs))}`;
}

/** `[a, b, c, d]` and a port. */
export const v4 = (ip: readonly number[], port: number): TicketAddr => ({ ip, port });

/** Eight 16-bit groups and a port. */
export const v6 = (groups: readonly number[], port: number): TicketAddr => ({
  ip: groups.flatMap((g) => [g >> 8, g & 0xff]),
  port,
});
