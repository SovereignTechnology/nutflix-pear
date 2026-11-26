/**
 * NFX-03 §4 as amended by nfx decision record 0114: which direct addresses a beacon may name on a
 * public relay. The public test mirrors nfx-node's `is_public`, and the ticket reader is checked
 * against the tickets of the vendored nfx beacon vector (nfx's own iroh-blobs wrote them) and
 * against tickets written here with chosen addresses.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nfx } from '@sovit/core';
import { describe, expect, it } from 'vitest';

import {
  decodeBlobTicket,
  isPublicSocketAddr,
  namesOnlyPublicAddresses,
  parseSocketAddr,
} from '../nfx/address-class.js';
import { beaconContent } from '../nfx/beacons.js';
import { base32, blobTicket, ticketBytes, v4, v6 } from './support/iroh-ticket.js';

const VECTORS = join(
  dirname(fileURLToPath(import.meta.url)),
  ...['..', '..', '..', '..', '..', 'docs', 'vendor', 'nfx-test-vectors'],
);
const NODE = 'e1'.repeat(32);
const NS = 'nfx:testnet:1';
const VIDEO = `${NS}:nutflix-${'c'.repeat(32)}`;

describe('isPublicSocketAddr', () => {
  it('takes public unicast addresses', () => {
    for (const a of [
      '9.9.9.9:4433',
      '1.1.1.1:1',
      '100.63.255.255:1',
      '100.128.0.0:1',
      '172.15.255.255:1',
      '172.32.0.0:1',
      '223.255.255.255:65535',
      '[2606:4700:4700::1111]:443',
      '[2a01:4f8::1]:1',
      '[2001:200::1]:1',
      '[3fff:1000::1]:1',
    ])
      expect(isPublicSocketAddr(a), a).toBe(true);
  });

  it('refuses every block nfx-node does, and port 0', () => {
    for (const a of [
      '0.1.2.3:1',
      '10.0.0.1:1',
      '100.64.0.1:1',
      '100.127.255.255:1',
      '127.0.0.1:1',
      '169.254.1.1:1',
      '172.16.0.1:1',
      '172.31.255.255:1',
      '192.0.0.1:1',
      '192.0.2.1:1',
      '192.88.99.1:1',
      '192.168.1.1:1',
      '198.18.0.1:1',
      '198.19.255.255:1',
      '198.51.100.1:1',
      '203.0.113.10:11204',
      '224.0.0.1:1',
      '255.255.255.255:1',
      '9.9.9.9:0',
      '[::1]:1',
      '[::]:1',
      '[fe80::1]:1',
      '[fd00::1]:1',
      '[fc00::1]:1',
      '[ff02::1]:1',
      '[::ffff:9.9.9.9]:1',
      '[64:ff9b::909:909]:1',
      '[2001::1]:1',
      '[2001:1ff::1]:1',
      '[2001:db8::1]:1',
      '[2002:909:909::1]:1',
      '[3fff::1]:1',
      '[3fff:fff::1]:1',
      '[4000::1]:1',
    ])
      expect(isPublicSocketAddr(a), a).toBe(false);
  });

  it('refuses what it cannot read, a zone included', () => {
    for (const a of [
      '',
      '9.9.9.9',
      '09.9.9.9:1',
      '9.9.9:1',
      '9.9.9.256:1',
      '9.9.9.9:01',
      '9.9.9.9:65536',
      '[2606:4700::1]',
      '[2606:4700::1]:65536',
      '2606:4700::1:443',
      '[fe80::1%eth0]:1',
      '[2606:4700::1%2]:1',
      '[1::2::3]:1',
      '[1:2:3:4:5:6:7:8:9]:1',
      '[12345::1]:1',
      'example.com:443',
    ])
      expect(isPublicSocketAddr(a), a).toBe(false);
    expect(parseSocketAddr('[1:2:3:4:5:6:1.2.3.4]:7')?.port).toBe(7);
  });
});

describe('decodeBlobTicket', () => {
  it("reads the vendored beacon vector's tickets as nfx wrote them", () => {
    const v = JSON.parse(readFileSync(join(VECTORS, 'beacon.json'), 'utf8')) as {
      now: number;
      event: unknown;
    };
    const b = nfx.parseBeacon(v.event, v.now);
    if (!b.ok) throw new Error(b.error.reason);
    const iroh = b.value.content.endpoints.find((e) => e.t === 'iroh');
    if (iroh?.t !== 'iroh') throw new Error('the vector has an iroh endpoint');
    expect(iroh.tickets.size).toBeGreaterThan(0);
    for (const t of iroh.tickets.values()) {
      const read = decodeBlobTicket(t);
      expect(read?.node).toBe(iroh.node);
      expect(read?.relay).toBe(iroh.relay);
      expect(read?.addrs.map((a) => `${[...a.ip].join('.')}:${String(a.port)}`)).toEqual(
        iroh.addrs,
      );
    }
    // Its address is a documentation one: that beacon is never embedded in a tell.
    expect(namesOnlyPublicAddresses(b.value.content)).toBe(false);
  });

  it('reads tickets with chosen addresses, IPv6 and no relay included', () => {
    const t = blobTicket(
      NODE,
      [v4([9, 9, 9, 9], 4433), v6([0x2606, 0x4700, 0, 0, 0, 0, 0, 1], 4464)],
      null,
    );
    const read = decodeBlobTicket(t);
    expect(read?.node).toBe(NODE);
    expect(read?.relay).toBeNull();
    expect(read?.addrs.map((a) => [a.ip.length, a.port])).toEqual([
      [4, 4433],
      [16, 4464],
    ]);
  });

  it('refuses anything not exactly one Variant0 BlobTicket', () => {
    const good = blobTicket(NODE, [v4([9, 9, 9, 9], 1)]);
    expect(decodeBlobTicket(good)).not.toBeNull();
    const bytes = ticketBytes(NODE, null, []);
    for (const bad of [
      good.slice(4), // no kind
      `node${good.slice(4)}`,
      good.toUpperCase(),
      `${good.slice(0, -1)}1`, // not in the alphabet
      good.slice(0, -1), // a length base32 cannot spell, or a short read
      `blob${base32(bytes.slice(0, -1))}`, // the hash cut short
      `blob${base32([...bytes, 0])}`, // a byte after the hash
      `blob${base32([1, ...bytes.slice(1)])}`, // Variant1
      `blob${base32([0x80, 0x00, ...bytes.slice(1)])}`, // a varint longer than needed
      `blob${base32([...bytes.slice(0, 33), 2, ...bytes.slice(34)])}`, // an Option tag of 2
      'blob',
    ])
      expect(decodeBlobTicket(bad), bad.slice(0, 16)).toBeNull();
    // Bits past the last whole byte must be zero (one spelling per ticket).
    const last = good.at(-1) ?? 'a';
    const sibling = 'abcdefghijklmnopqrstuvwxyz234567'.indexOf(last) ^ 1;
    const flipped = `${good.slice(0, -1)}${'abcdefghijklmnopqrstuvwxyz234567'[sibling] ?? ''}`;
    if ((good.length - 4) % 8 !== 0) expect(decodeBlobTicket(flipped)).toBeNull();
  });
});

describe('namesOnlyPublicAddresses', () => {
  const video = nfx.VideoAddr.parse(VIDEO);
  if (!video.ok) throw new Error('bad video');
  const iroh = (addrs: string[], tickets: string[], node = NODE): nfx.Endpoint => ({
    t: 'iroh',
    node,
    relay: 'https://iroh-relay.test/',
    addrs,
    tickets: new Map(tickets.map((t, i) => [i === 0 ? 'meta' : `r${String(i)}`, t])),
  });
  const content = (...endpoints: nfx.Endpoint[]): nfx.BeaconContent =>
    beaconContent({ video: video.value, endpoints });
  const pub = blobTicket(NODE, [v4([9, 9, 9, 9], 4433)]);

  it('passes a beacon whose every address, tickets included, is public', () => {
    expect(namesOnlyPublicAddresses(content(iroh(['9.9.9.9:4433'], [pub, pub])))).toBe(true);
    // A ticket with no direct address at all names only the relay.
    expect(namesOnlyPublicAddresses(content(iroh([], [blobTicket(NODE, [])])))).toBe(true);
    expect(
      namesOnlyPublicAddresses(
        content({ t: 'hyperdht', peer: 'f'.repeat(64), bind: 'f'.repeat(128) }),
      ),
    ).toBe(true);
  });

  it('fails one with a private address in `addrs` or in any ticket, or an unreadable ticket', () => {
    expect(namesOnlyPublicAddresses(content(iroh(['192.168.1.5:4433'], [pub])))).toBe(false);
    const lan = blobTicket(NODE, [v4([9, 9, 9, 9], 4433), v4([192, 168, 1, 5], 4433)]);
    expect(namesOnlyPublicAddresses(content(iroh(['9.9.9.9:4433'], [pub, lan])))).toBe(false);
    const tailnet = blobTicket(NODE, [v4([100, 64, 0, 3], 4433)]);
    expect(namesOnlyPublicAddresses(content(iroh(['9.9.9.9:4433'], [tailnet])))).toBe(false);
    const ula = blobTicket(NODE, [v6([0xfd00, 0, 0, 0, 0, 0, 0, 1], 4433)]);
    expect(namesOnlyPublicAddresses(content(iroh([], [ula])))).toBe(false);
    // A ticket for another node, or one this reader does not know.
    const other = blobTicket('e2'.repeat(32), [v4([9, 9, 9, 9], 4433)]);
    expect(namesOnlyPublicAddresses(content(iroh(['9.9.9.9:4433'], [other])))).toBe(false);
    expect(namesOnlyPublicAddresses(content(iroh(['9.9.9.9:4433'], ['blobaaaaaaaa'])))).toBe(false);
  });

  it('fails endpoint types it does not read for addresses, and skipped ones', () => {
    expect(namesOnlyPublicAddresses(content({ t: 'https', url: 'https://seed.test/nfx' }))).toBe(
      false,
    );
    expect(
      namesOnlyPublicAddresses(content({ t: 'webrtc', trackerUrls: [], renditions: [] })),
    ).toBe(false);
    expect(namesOnlyPublicAddresses({ ...content(iroh([], [pub])), skipped: ['future'] })).toBe(
      false,
    );
    expect(namesOnlyPublicAddresses(content({ t: 'stun', addrs: ['9.9.9.9:3478'] }))).toBe(true);
    expect(namesOnlyPublicAddresses(content({ t: 'stun', addrs: ['10.0.0.1:3478'] }))).toBe(false);
  });
});
