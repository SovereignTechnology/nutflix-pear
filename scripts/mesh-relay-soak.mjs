#!/usr/bin/env node
// Which relays carry NFX mesh signaling (NFX-10 §6, kind 25050 `nfx-mesh/1`)? A scoped relay
// refuses the kind and a general one may rate-limit or drop ephemeral events, so the app's
// default signaling relays are picked by holding each candidate for a while and counting.
//
// Per relay, two throwaway sessions (fresh keys, never anyone's identity) in one random room:
// each subscribes to the room and sends `connect` every 30 s, as a real session does; the first
// also sends an offer every minute (one small SDP, one the size of a browser's with many
// candidates), which the second answers. Every event is signed when sent. A relay PASSES when it
// accepted every event (OK true), delivered every one to the other session within 10 s, never
// closed the subscription or the socket, and sent no NOTICE.
//
// Usage (after `npx tsc -b`; it needs the built @sovit/core):
//   node scripts/mesh-relay-soak.mjs [--minutes 10] wss://relay.one wss://relay.two …
//
// It contacts only the relays named. What they see: two random keys, a random room key, timing,
// and ciphertext. Exit 0 always; read the table.
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { clearInterval, setInterval, setTimeout } from 'node:timers';

import { nfx, signer } from '@sovit/core';
import WebSocket from 'ws';

const args = process.argv.slice(2);
let minutes = 10;
const relays = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--minutes') minutes = Number(args[++i]);
  else relays.push(args[i]);
}
if (relays.length === 0 || !(minutes > 0) || relays.some((r) => !/^wss?:\/\//.test(r))) {
  process.stderr.write('usage: mesh-relay-soak.mjs [--minutes N] wss://relay …\n');
  process.exit(2);
}

const now = () => Math.floor(Date.now() / 1000);
const sdp = (candidates) =>
  [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...Array.from(
      { length: candidates },
      (_, i) => `a=candidate:${i} 1 udp 2113937151 192.0.2.${i % 250} ${40000 + i} typ host`,
    ),
    'a=ice-ufrag:soak',
    'a=ice-pwd:soaksoaksoaksoaksoaksoak',
    'a=fingerprint:sha-256 ' + Array.from({ length: 32 }, () => 'AB').join(':'),
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    '',
  ].join('\r\n');

/** One session's socket on one relay. */
function side(url, room, key, stats, name) {
  const s = { ws: null, open: false, got: new Map(), key };
  const connect = () => {
    const ws = new WebSocket(url, { handshakeTimeout: 15_000 });
    s.ws = ws;
    ws.on('open', () => {
      s.open = true;
      ws.send(JSON.stringify(['REQ', `soak-${name}`, nfx.meshRoomFilter(room.key, now())]));
    });
    ws.on('message', (data) => {
      let m;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!Array.isArray(m)) return;
      if (m[0] === 'EVENT' && m[2] && typeof m[2].id === 'string') {
        const read = nfx.readMeshEvent(m[2], {
          room: room.key,
          now: now(),
          self: key.pubkey,
          decrypt: (from, content) => key.decrypt(from, content),
        });
        if (read.kind !== 'ignored' && read.kind !== 'dropped' && !s.got.has(m[2].id))
          s.got.set(m[2].id, { at: Date.now(), read });
        else if (read.kind === 'dropped') stats.invalid += 1;
      } else if (m[0] === 'OK') {
        const p = stats.pending.get(m[1]);
        if (p) {
          p.ok = m[2] === true;
          if (!p.ok) stats.refusals.push(String(m[3]).slice(0, 80));
        }
      } else if (m[0] === 'NOTICE') stats.notices.push(String(m[1]).slice(0, 80));
      else if (m[0] === 'CLOSED') stats.closed.push(String(m[2]).slice(0, 80));
      else if (m[0] === 'AUTH') stats.auth += 1;
    });
    ws.on('close', () => {
      s.open = false;
      if (!stats.done) {
        stats.drops += 1;
        setTimeout(connect, 2000);
      }
    });
    ws.on('error', (e) => {
      stats.errors.push(String(e.message).slice(0, 80));
    });
  };
  connect();
  return s;
}

async function soak(url) {
  const room = nfx.meshRoom(`nfx/1/web/nfx:testnet:1:soak-${randomBytes(8).toString('hex')}/720p`);
  const a = signer.MeshSessionKey.create();
  const b = signer.MeshSessionKey.create();
  const stats = {
    pending: new Map(),
    sent: 0,
    notices: [],
    closed: [],
    refusals: [],
    errors: [],
    drops: 0,
    auth: 0,
    invalid: 0,
    done: false,
    latency: [],
  };
  const A = side(url, room, a, stats, 'a');
  const B = side(url, room, b, stats, 'b');
  const send = (from, to, event) => {
    if (!from.open) {
      stats.pending.set(event.id, { ok: false, to, sentAt: Date.now(), unsent: true });
      stats.sent += 1;
      return;
    }
    stats.pending.set(event.id, { ok: null, to, sentAt: Date.now() });
    stats.sent += 1;
    from.ws.send(JSON.stringify(['EVENT', event]));
  };
  const round = (n) => {
    send(A, B, a.presence('connect', room, now()));
    send(B, A, b.presence('connect', room, now()));
    if (n % 2 === 0) {
      const offer = a.offer(room, b.pubkey, sdp(n % 4 === 0 ? 3 : 24), now());
      send(A, B, offer);
      // The answer goes out once the offer arrived, as a real session's would.
      const wait = setInterval(() => {
        const got = B.got.get(offer.id);
        if (got === undefined) return;
        clearInterval(wait);
        send(B, A, b.answer(room, a.pubkey, offer.id, got.read.sdp, now()));
      }, 200);
      setTimeout(() => clearInterval(wait), 15_000);
    }
  };
  await new Promise((r) => setTimeout(r, 5000));
  const rounds = Math.max(1, Math.round((minutes * 60) / 30));
  for (let n = 0; n < rounds; n++) {
    round(n);
    await new Promise((r) => setTimeout(r, 30_000));
  }
  send(A, B, a.presence('disconnect', room, now()));
  await new Promise((r) => setTimeout(r, 10_000));
  stats.done = true;
  let accepted = 0;
  let delivered = 0;
  for (const [id, p] of stats.pending) {
    if (p.ok === true) accepted += 1;
    const got = p.to.got.get(id);
    if (got !== undefined && got.at - p.sentAt <= 10_000) {
      delivered += 1;
      stats.latency.push(got.at - p.sentAt);
    }
  }
  for (const s of [A, B]) s.ws.close();
  a.destroy();
  b.destroy();
  stats.latency.sort((x, y) => x - y);
  const median = stats.latency[Math.floor(stats.latency.length / 2)] ?? null;
  const pass =
    accepted === stats.sent &&
    delivered === stats.sent &&
    stats.drops === 0 &&
    stats.closed.length === 0 &&
    stats.notices.length === 0 &&
    stats.auth === 0;
  return {
    url,
    verdict: pass ? 'PASS' : 'FAIL',
    sent: stats.sent,
    accepted,
    delivered,
    medianMs: median,
    drops: stats.drops,
    closed: stats.closed.length,
    notices: stats.notices.length,
    auth: stats.auth,
    invalid: stats.invalid,
    why: [
      ...new Set([...stats.refusals, ...stats.closed, ...stats.notices, ...stats.errors]),
    ].slice(0, 4),
  };
}

const results = await Promise.all(relays.map((r) => soak(r)));
process.stdout.write(`mesh-relay-soak: ${minutes} min, ${new Date().toISOString()}\n`);
for (const r of results) process.stdout.write(`${JSON.stringify(r)}\n`);
process.exit(0);
