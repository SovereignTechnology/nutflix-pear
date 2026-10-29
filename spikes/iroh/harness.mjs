#!/usr/bin/env node
// Spike S-D's JavaScript peer: the worker's side of the iroh helper, run under Node 22 (its
// global WebSocket reaches the scoped relay). CI only (spikes/iroh/nat/run.sh), never on a
// developer's machine.
//
//   harness.mjs serve --helper <bin> --state <dir> --iroh-relay <url|none> --nostr <ws url>
//                     --package <nfx-package dir> --a <manifest a> [--poison]
//   harness.mjs fetch --helper <bin> --state <dir> --iroh-relay <url|none> --nostr <ws url>
//                     --a <manifest a> [--timeout <s>] [--evict-wait <s>]
//
// serve: puts the packaged video into an NfxStore (verified), has the helper import the store's
//   files by reference and form NFX-06's collections, then signs and publishes beacons (kind
//   20464) naming the helper's iroh endpoint; prints {"ready":true,…} once the first beacon is
//   accepted, and its stats on SIGTERM. --poison serves one segment with a flipped byte.
// fetch: subscribes to beacons first (scoped relays never store them), prints {"watching":true},
//   then fetches from the first serving endpoint through the helper, checks every file's sha256,
//   and puts the video into an NfxStore; prints one result line and exits 0 only on success.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { nfx } from '@sovit/core';
import { NfxStore, nodeCrypto, nodeFs } from '@sovit/seeder';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import { IrohHelper } from '../../packages/app-desktop/dist/worker/iroh/index.js';
import { PoisonedError, fetchVideo, metaMembers, renditionMembers } from './nfx06.mjs';

const BEACON_TTL = 120;
const REPUBLISH_MS = 30_000;

function args(argv) {
  const [role, ...rest] = argv;
  const flags = new Map();
  for (let i = 0; i < rest.length; i += 1) {
    const name = rest[i];
    if (!name.startsWith('--')) throw new Error(`unexpected ${name}`);
    const bare = name.slice(2);
    if (bare === 'poison') flags.set(bare, true);
    else flags.set(bare, rest[++i]);
  }
  return { role, flags };
}

function need(flags, name) {
  const v = flags.get(name);
  if (typeof v !== 'string' || v === '') throw new Error(`--${name} is required`);
  return v;
}

function emit(obj) {
  process.stdout.write(
    `${JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))}\n`,
  );
}

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A NIP-01 client for one relay: just enough to publish and to subscribe. */
class Relay {
  static open(url, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error(`relay ${url}: no connection`)), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new Relay(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`relay ${url}: connection failed`));
      });
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.oks = new Map();
    this.subs = new Map();
    this.next = 0;
    ws.addEventListener('message', (e) => this.onMessage(e.data));
  }

  onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;
    const [type, a, b, c] = msg;
    if (type === 'OK') this.oks.get(a)?.({ accepted: b === true, message: String(c ?? '') });
    else if (type === 'EVENT') this.subs.get(a)?.onEvent(b);
    else if (type === 'EOSE') this.subs.get(a)?.onEose();
  }

  publish(event, timeoutMs = 10_000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.oks.delete(event.id);
        resolve({ accepted: false, message: 'no OK in time' });
      }, timeoutMs);
      this.oks.set(event.id, (ok) => {
        clearTimeout(timer);
        this.oks.delete(event.id);
        resolve(ok);
      });
      this.ws.send(JSON.stringify(['EVENT', event]));
    });
  }

  subscribe(filter, onEvent, onEose = () => undefined) {
    const id = `s${(this.next += 1)}`;
    this.subs.set(id, { onEvent, onEose });
    this.ws.send(JSON.stringify(['REQ', id, filter]));
    return id;
  }

  unsubscribe(id) {
    this.subs.delete(id);
    this.ws.send(JSON.stringify(['CLOSE', id]));
  }

  close() {
    this.ws.close();
  }
}

/** The newest valid manifest at address `a` (kind 38504 is stored; ask until it is there). */
async function resolveManifest(relay, a, deadline) {
  const target = nfx.parseATag(a);
  if (!target.ok) throw new Error(`--a: ${target.error.reason}`);
  const { creator, addr } = target.value;
  while (performance.now() < deadline) {
    const found = await new Promise((resolve) => {
      let best;
      const sub = relay.subscribe(
        { kinds: [nfx.KIND_MANIFEST], authors: [creator], '#d': [addr.toString()] },
        (ev) => {
          const m = nfx.parseManifest(ev);
          if (
            m.ok &&
            m.value.addr.equals(addr) &&
            (best === undefined || m.value.createdAt > best.createdAt)
          )
            best = m.value;
        },
        () => {
          relay.unsubscribe(sub);
          resolve(best);
        },
      );
    });
    if (found !== undefined) return found;
    await sleep(500);
  }
  throw new Error('no manifest in time');
}

function helperFor(flags, relays) {
  const events = [];
  const helper = new IrohHelper({
    spawn: (file, a) => spawn(file, [...a], { stdio: ['pipe', 'pipe', 'pipe'] }),
    file: need(flags, 'helper'),
    stateDir: join(need(flags, 'state'), 'helper'),
    init: { relays },
    restart: false,
    onEvent: (e) => {
      if (e.type === 'stderr') process.stderr.write(`helper: ${e.line}\n`);
      else events.push(e);
    },
  });
  return { helper, events };
}

function relaysOf(flags) {
  const r = need(flags, 'iroh-relay');
  return r === 'none' ? [] : [r];
}

async function openStore(dir) {
  const store = new NfxStore({ fs: nodeFs, crypto: nodeCrypto, dataDir: dir });
  await store.load();
  if (store.loadError !== null) throw new Error(`store: ${store.loadError}`);
  return store;
}

/** Where NfxStore keeps a file (its documented layout, `nfx/files/<sha[0..2]>/<sha>`). */
const storePath = (dir, sha) => join(dir, 'nfx', 'files', sha.slice(0, 2), sha);

async function serve(flags) {
  const state = need(flags, 'state');
  const pkg = need(flags, 'package');
  const a = need(flags, 'a');
  const relays = relaysOf(flags);
  const meta = JSON.parse(await readFile(join(pkg, 'nfx.json'), 'utf8'));
  const video = nfx.VideoAddr.parse(meta.video);
  if (!video.ok) throw new Error(`nfx.json video: ${video.error.reason}`);
  const segs = BigInt(meta.segs);
  const listBytes = new Uint8Array(await readFile(join(pkg, 'store', meta.root)));
  const verified = nfx.verifyHashList(listBytes, meta.root, video.value, segs);
  if (!verified.ok) throw new Error(`package: ${verified.error.reason}`);
  const list = verified.value;

  // The worker's store first: it checks every file, so the helper only ever serves checked files.
  const storeDir = join(state, 'store');
  const store = await openStore(storeDir);
  const put = await store.putVideo({
    video: video.value,
    root: meta.root,
    segs,
    hashListBytes: listBytes,
    read: async (e) => new Uint8Array(await readFile(join(pkg, 'store', e.sha256))),
  });
  if (!put.ok) throw new Error(`store put: ${put.error}: ${put.message}`);

  const { helper } = helperFor(flags, relays);
  await helper.start();
  const sizeOf = (sha) =>
    sha === meta.root ? listBytes.length : Number(list.files.find((f) => f.sha256 === sha).size);

  // --poison: one segment is served from a copy with a flipped byte. Its BLAKE3 (and so the
  // collection) is built from the bad bytes, so iroh accepts them; only sha256 can catch it.
  let poisoned;
  if (flags.get('poison') === true) {
    const playlist = list.files.find((f) => f.name === list.renditions[0].playlist);
    const [, firstSegment] = renditionMembers(
      list,
      new Uint8Array(await readFile(storePath(storeDir, playlist.sha256))),
    );
    const bytes = new Uint8Array(await readFile(storePath(storeDir, firstSegment)));
    bytes[0] ^= 0xff;
    await mkdir(join(state, 'poison'), { recursive: true });
    poisoned = { sha: firstSegment, path: join(state, 'poison', firstSegment) };
    await writeFile(poisoned.path, bytes);
  }
  const blake = new Map();
  const imported = async (sha) => {
    if (!blake.has(sha)) {
      const path = poisoned?.sha === sha ? poisoned.path : storePath(storeDir, sha);
      const got = await helper.import(path);
      if (got.size !== sizeOf(sha)) throw new Error(`import of ${sha}: size ${got.size}`);
      blake.set(sha, got.hash);
    }
    return blake.get(sha);
  };
  const tag = meta.root.slice(0, 16);
  const tickets = new Map();
  const metaSeq = [];
  for (const sha of metaMembers(meta.root, list)) metaSeq.push(await imported(sha));
  tickets.set('meta', (await helper.seq(metaSeq, `${tag}/meta`)).ticket);
  for (const r of list.renditions) {
    const playlist = list.files.find((f) => f.name === r.playlist);
    const members = renditionMembers(
      list,
      new Uint8Array(await readFile(storePath(storeDir, playlist.sha256))),
    );
    const hashes = [];
    for (const sha of members) hashes.push(await imported(sha));
    tickets.set(r.id, (await helper.seq(hashes, `${tag}/${r.id}`)).ticket);
  }
  const reach = await helper.addr();
  const sorted = new Map([...tickets].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  const content = {
    v: 1,
    video: video.value,
    endpoints: [
      { t: 'iroh', node: reach.node, relay: reach.relay, addrs: reach.addrs, tickets: sorted },
    ],
    skipped: [],
    chunks: 'all',
    priceHint: 0n,
    acceptsMints: [],
    free: true,
  };
  const seederKey = generateSecretKey();
  const relay = await Relay.open(need(flags, 'nostr'));
  const publishBeacon = async () => {
    const at = now();
    const tags = nfx.beaconTags(a, at, BEACON_TTL);
    if (!tags.ok) throw new Error(`beacon tags: ${tags.error.reason}`);
    const event = finalizeEvent(
      {
        kind: nfx.KIND_BEACON,
        created_at: at,
        tags: tags.value,
        content: nfx.beaconContentText(content),
      },
      seederKey,
    );
    // Our own reader must accept what we publish, or nobody else will.
    const self = nfx.parseBeacon(event, at);
    if (!self.ok) throw new Error(`own beacon: ${self.error.reason}`);
    return relay.publish(event);
  };
  const first = await publishBeacon();
  if (!first.accepted) throw new Error(`beacon refused: ${first.message}`);
  const stats = await helper.stats();
  emit({
    ready: true,
    role: 'serve',
    node: reach.node,
    relay: reach.relay,
    addrs: reach.addrs,
    seeder: getPublicKey(seederKey),
    files: blake.size,
    bytes: put.record.files.reduce((n, f) => n + f.size, 0),
    helper_store_bytes: stats.storeBytes,
    poisoned: poisoned?.sha ?? null,
  });
  const timer = setInterval(() => {
    publishBeacon().catch((e) => process.stderr.write(`republish: ${e.message}\n`));
  }, REPUBLISH_MS);
  await new Promise((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
  clearInterval(timer);
  const end = await helper.stats().catch(() => null);
  process.stderr.write(`${JSON.stringify({ stats: end })}\n`);
  relay.close();
  await helper.close();
}

async function fetchRole(flags) {
  const state = need(flags, 'state');
  const a = need(flags, 'a');
  const relays = relaysOf(flags);
  const timeoutS = Number(flags.get('timeout') ?? '90');
  const deadline = performance.now() + timeoutS * 1000;
  const relay = await Relay.open(need(flags, 'nostr'));
  const manifest = await resolveManifest(relay, a, deadline);
  const { helper } = helperFor(flags, relays);
  await helper.start();
  const store = await openStore(join(state, 'store'));
  const dropped = new Set();
  const queue = [];
  let wake = () => undefined;
  // Subscribed before anything can serve: beacons are ephemeral (NFX-04 §1).
  await new Promise((resolve) => {
    relay.subscribe(
      { kinds: [nfx.KIND_BEACON], '#n': [manifest.addr.namespace.toString()], '#a': [a] },
      (ev) => {
        const b = nfx.parseBeacon(ev, now());
        if (!b.ok || !nfx.beaconServes(b.value, manifest)) return;
        for (const e of b.value.content.endpoints)
          if (e.t === 'iroh' && !dropped.has(e.node))
            queue.push({ seeder: b.value.seeder, endpoint: e });
        wake();
      },
      resolve,
    );
  });
  emit({ watching: true, role: 'fetch' });
  for (;;) {
    while (queue.length === 0) {
      const left = deadline - performance.now();
      if (left <= 0) {
        emit({ ok: false, role: 'fetch', error: 'timeout', dropped: [...dropped] });
        return 1;
      }
      await Promise.race([new Promise((r) => (wake = r)), sleep(Math.min(left, 1000))]);
    }
    const { seeder, endpoint } = queue.shift();
    if (dropped.has(endpoint.node)) continue;
    const t0 = performance.now();
    try {
      const got = await fetchVideo(helper, endpoint, manifest, relays);
      const ms = performance.now() - t0;
      const bytes = [...got.files.values()].reduce((n, b) => n + b.length, 0);
      const put = await store.putVideo({
        video: manifest.addr,
        root: manifest.root,
        segs: manifest.segs,
        hashListBytes: got.listBytes,
        read: async (e) => got.files.get(e.sha256),
      });
      if (!put.ok) throw new Error(`store put: ${put.error}: ${put.message}`);
      const after = await helper.stats();
      const evictWait = Number(flags.get('evict-wait') ?? '0');
      if (evictWait > 0) await sleep(evictWait * 1000);
      const evicted = evictWait > 0 ? await helper.stats() : null;
      emit({
        ok: true,
        role: 'fetch',
        seeder,
        node: endpoint.node,
        files: got.files.size,
        bytes,
        ms: Math.round(ms),
        mbit_s: Math.round(((bytes * 8) / (ms / 1000) / 1e6) * 10) / 10,
        helper_rss_kib: (evicted ?? after).rssHwmKib,
        helper_store_bytes_after_fetch: after.storeBytes,
        helper_store_bytes_after_evict: evicted?.storeBytes ?? null,
      });
      relay.close();
      await helper.close();
      return 0;
    } catch (e) {
      if (e instanceof PoisonedError) {
        // The source is dropped and never asked again; the spike reports it and stops.
        dropped.add(endpoint.node);
        emit({
          ok: false,
          role: 'fetch',
          error: 'poisoned',
          what: e.what,
          dropped: [...dropped],
          stored: store.hasVideo(manifest.addr),
        });
        relay.close();
        await helper.close();
        return 1;
      }
      process.stderr.write(`fetch from ${endpoint.node.slice(0, 8)}: ${e.message}\n`);
    }
  }
}

const { role, flags } = args(process.argv.slice(2));
try {
  if (role === 'serve') {
    await serve(flags);
    process.exit(0);
  } else if (role === 'fetch') {
    process.exit(await fetchRole(flags));
  } else {
    process.stderr.write('usage: harness.mjs serve|fetch …\n');
    process.exit(2);
  }
} catch (e) {
  emit({ ok: false, role, error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
}
