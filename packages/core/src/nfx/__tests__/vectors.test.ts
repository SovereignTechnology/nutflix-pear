/**
 * Every NFX test vector this package implements (docs/vendor/nfx-test-vectors, nfx commit
 * 47cb059), mirroring nfx-proto's `tests/vectors.rs` case by case. Signed events are
 * reproduced up to their id: nfx-proto re-signs with a zero BIP-340 `aux_rand`, which no
 * signer here exposes, so a rebuilt event's id is compared and the vector's signature verified.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { finalizeEvent, getEventHash, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import sodium from 'sodium-universal';
import { describe, expect, it } from 'vitest';

import {
  FILES_MESSAGE_TYPES,
  FILES_PROTOCOL,
  KIND_BEACON,
  KIND_MANIFEST,
  MAX_DATA_PAYLOAD,
  MAX_PAY_MESSAGE,
  Namespace,
  PAY_MESSAGE_TYPES,
  PAY_PROTOCOL,
  VideoAddr,
  beaconContentText,
  beaconServes,
  beaconTags,
  canonicalize,
  checkPlaylist,
  decodeFilesMessage,
  decodePayMessage,
  deletionDeletes,
  deletionTags,
  encodeFilesMessage,
  encodePayMessage,
  hyperdhtBindMessage,
  manifestATag,
  manifestTags,
  parseBeacon,
  parseBeaconContent,
  parseDeletion,
  parseManifest,
  renderHashList,
  renditionForPlaylist,
  resolveContentName,
  validateVideoId,
  verifyEvent,
  verifyFile,
  verifyHashList,
  verifyHashListFor,
  verifyHyperdhtBind,
  type FileEntry,
  type HashList,
  type NfxResult,
  type Rendition,
  type Role,
} from '../index.js';

const DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'docs',
  'vendor',
  'nfx-test-vectors',
);

const VECTOR_FILES = [
  'beacon-hyperdht.json',
  'beacon-invalid.json',
  'beacon.json',
  'canon.json',
  'deletion.json',
  'derived.json',
  'files1.json',
  'hashlist-invalid.json',
  'hashlist.json',
  'manifest-invalid.json',
  'manifest-open.json',
  'manifest.json',
];

interface RawEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}
interface Named {
  name: string;
  event: RawEvent;
}
type Keys = Record<string, string>;

const load = (name: string): unknown => JSON.parse(readFileSync(join(DIR, name), 'utf8'));

function unwrap<T>(r: NfxResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.reason}`);
  return r.value;
}

/** The NIP-01 id of the event with these fields: equal ids mean byte-identical serializations. */
const idOf = (e: Omit<RawEvent, 'id' | 'sig'>): string =>
  getEventHash({
    pubkey: e.pubkey,
    created_at: e.created_at,
    kind: e.kind,
    tags: e.tags,
    content: e.content,
  });

const pubkeyOf = (keys: Keys, who: string): string => getPublicKey(hexToBytes(keys[who]!));

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const manifestVector = load('manifest.json') as { secret_keys_DO_NOT_USE: Keys; event: RawEvent };
const openVector = load('manifest-open.json') as {
  secret_keys_DO_NOT_USE: Keys;
  event: RawEvent;
};
const beaconVector = load('beacon.json') as {
  secret_keys_DO_NOT_USE: Keys;
  now: number;
  event: RawEvent;
};
const manifest = unwrap(parseManifest(manifestVector.event));

describe('vendored NFX vectors (docs/vendor/nfx-test-vectors)', () => {
  it('are exactly the pinned files, each matching its sha256', () => {
    const pins = new Map<string, string>();
    for (const line of readFileSync(join(DIR, 'SHA256SUMS'), 'utf8').split('\n')) {
      if (line === '' || line.startsWith('#')) continue;
      const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
      expect(m, line).not.toBeNull();
      pins.set(m![2]!, m![1]!);
    }
    const present = readdirSync(DIR)
      .filter((f) => f !== 'SHA256SUMS' && f !== 'README.md')
      .sort();
    expect(present, 'every file pinned, every pin present').toEqual([...pins.keys()].sort());
    expect(present).toEqual(VECTOR_FILES);
    for (const [name, sum] of pins) {
      expect(sha256Hex(readFileSync(join(DIR, name))), name).toBe(sum);
    }
  });
});

describe('NFX-02 manifests', () => {
  it('parses the licensed vector and reproduces it', () => {
    const v = manifestVector;
    const ev = v.event;
    expect(ev.kind).toBe(KIND_MANIFEST);
    expect(manifest.addr.toString()).toBe('nfx:mainnet:1:salt-flats-dusk');
    expect(manifest.segs).toBe(7n);
    if (manifest.license.mode !== 'licensed') throw new Error('licensed');
    expect(manifest.license.terms.keyPrice).toBe(200n);
    expect(manifest.license.terms.splitBps).toBe(5000);
    expect(manifest.license.terms.mint).toBe('https://mint.example');
    expect(manifest.license.terms.freeSeeders).toEqual([
      pubkeyOf(v.secret_keys_DO_NOT_USE, 'seeder'),
    ]);
    expect(ev.pubkey).toBe(pubkeyOf(v.secret_keys_DO_NOT_USE, 'creator'));
    expect(idOf(ev)).toBe(ev.id);

    // The publisher side: `manifestTags` is the vector's tag list, so rebuilding reproduces it.
    expect(manifestTags(manifest)).toEqual(ev.tags);
    const rebuilt = {
      pubkey: manifest.author,
      created_at: ev.created_at,
      kind: KIND_MANIFEST,
      tags: manifestTags(manifest),
      content: manifest.description,
    };
    expect(idOf(rebuilt)).toBe(ev.id);
  });

  it('parses the open vector, ignores unknown tags and is reproduced', () => {
    const v = openVector;
    const ev = v.event;
    const m = unwrap(parseManifest(ev));
    expect(m.license).toEqual({ mode: 'open' });
    expect(m.priceHint).toBe(0n);
    expect(idOf(ev)).toBe(ev.id);

    // `manifestTags` emits every tag it understands, in order, and nothing else.
    expect(manifestTags(m)).toEqual(ev.tags.filter((t) => t[0] !== 'x-future-tag'));
    const rebuilt = finalizeEvent(
      {
        created_at: ev.created_at,
        kind: KIND_MANIFEST,
        tags: manifestTags(m),
        content: m.description,
      },
      hexToBytes(v.secret_keys_DO_NOT_USE['creator']!),
    );
    expect(unwrap(parseManifest(rebuilt))).toEqual(m);
  });

  it('rejects every invalid manifest for a semantic reason', () => {
    const v = load('manifest-invalid.json') as {
      secret_keys_DO_NOT_USE: Keys;
      cases: Named[];
    };
    expect(v.cases.length).toBeGreaterThanOrEqual(30);
    const creator = pubkeyOf(v.secret_keys_DO_NOT_USE, 'creator');
    for (const c of v.cases) {
      expect(parseManifest(c.event).ok, `${c.name} must be rejected`).toBe(false);
      if (c.name !== 'bad-signature' && c.name !== 'id-mismatch') {
        expect(verifyEvent(c.event).ok, `${c.name}: signature should be valid`).toBe(true);
        expect(c.event.pubkey, c.name).toBe(creator);
        expect(idOf(c.event), `${c.name} reproduced`).toBe(c.event.id);
      }
    }
  });
});

describe('NFX-03 beacons', () => {
  it('parses all endpoint types and is reproduced', () => {
    const v = beaconVector;
    const ev = v.event;
    expect(ev.kind).toBe(KIND_BEACON);
    const b = unwrap(parseBeacon(ev, v.now));
    expect(beaconServes(b, manifest)).toBe(true);
    const open = unwrap(parseManifest(openVector.event));
    expect(beaconServes(b, open), 'same author and address, newer revision').toBe(true);
    expect(b.content.chunks).toBe('all');
    expect(b.content.endpoints.map((e) => e.t)).toEqual(['iroh', 'https', 'webrtc', 'hyper']);
    const webrtc = b.content.endpoints.find((e) => e.t === 'webrtc');
    expect(webrtc?.t === 'webrtc' ? webrtc.renditions : undefined).toEqual(['720p']);
    expect(b.content.skipped).toEqual([]);

    // The publisher side renders the exact content string and tags.
    expect(beaconContentText(b.content)).toBe(ev.content);
    expect(unwrap(beaconTags(manifestATag(manifest), ev.created_at, 120))).toEqual(ev.tags);
    expect(ev.pubkey).toBe(pubkeyOf(v.secret_keys_DO_NOT_USE, 'seeder'));
    expect(idOf(ev)).toBe(ev.id);
    for (const badTtl of [59, 121]) {
      expect(beaconTags(manifestATag(manifest), ev.created_at, badTtl).ok).toBe(false);
    }
    expect(beaconTags('30023:ab:nfx:mainnet:1:x', ev.created_at, 120).ok).toBe(false);
  });

  it('rejects every invalid beacon and skips unknown endpoints', () => {
    const v = load('beacon-invalid.json') as {
      now: number;
      cases: Named[];
      unknown_endpoint_only: RawEvent;
    };
    for (const c of v.cases) {
      expect(verifyEvent(c.event).ok, `${c.name}: signature should be valid`).toBe(true);
      expect(parseBeacon(c.event, v.now).ok, `${c.name} must be rejected`).toBe(false);
    }
    const onlyUnknown = unwrap(parseBeacon(v.unknown_endpoint_only, v.now));
    expect(onlyUnknown.content.endpoints).toEqual([]);
    expect(onlyUnknown.content.skipped).toEqual(['carrier-pigeon']);

    // The valid beacon is rejected once it expires or when the clock is far off.
    const good = beaconVector.event;
    expect(parseBeacon(good, good.created_at + 120).ok).toBe(false);
    expect(parseBeacon(good, good.created_at - 901).ok).toBe(false);
  });

  it('round-trips beacon content through its own parser', () => {
    const ev = beaconVector.event;
    const parsed = unwrap(parseBeaconContent(ev.content, ev.pubkey));
    expect(unwrap(parseBeaconContent(beaconContentText(parsed), ev.pubkey))).toEqual(parsed);
  });
});

describe('NFX-12 hyperdht endpoints (beacon-hyperdht.json)', () => {
  const v = load('beacon-hyperdht.json') as {
    secret_keys_DO_NOT_USE: Keys;
    now: number;
    bind: { seeder: string; namespace: string; peer: string; message_utf8: string; sig: string };
    valid: Named[];
    invalid: (Named & { reason: string })[];
    gossip_budget: {
      hyperdht_endpoint_bytes: number;
      limits: Record<string, { without_hyperdht: number; with_hyperdht: number }>;
    };
  };

  it('accepts every valid beacon with its hyperdht endpoint, and reproduces its content', () => {
    for (const c of v.valid) {
      const b = unwrap(parseBeacon(c.event, v.now));
      const hyperdht = b.content.endpoints.find((e) => e.t === 'hyperdht');
      expect(hyperdht, c.name).toEqual({ t: 'hyperdht', peer: v.bind.peer, bind: v.bind.sig });
      expect(b.content.skipped, c.name).toEqual([]);
      expect(beaconContentText(b.content), c.name).toBe(c.event.content);
      expect(idOf(c.event), c.name).toBe(c.event.id);
    }
    expect(v.valid.length + v.invalid.length).toBe(12);
  });

  it('rejects every invalid beacon whole', () => {
    for (const c of v.invalid) {
      expect(verifyEvent(c.event).ok, `${c.name}: signature should be valid`).toBe(true);
      expect(parseBeacon(c.event, v.now).ok, `${c.name} (${c.reason}) must be rejected`).toBe(
        false,
      );
    }
  });

  it('binds the peer key to the seeder and network', () => {
    const { seeder, namespace, peer, message_utf8, sig } = v.bind;
    expect(seeder).toBe(pubkeyOf(v.secret_keys_DO_NOT_USE, 'seeder'));
    expect(hyperdhtBindMessage(seeder, namespace)).toBe(message_utf8);
    expect(verifyHyperdhtBind(peer, sig, seeder, namespace)).toBe(true);
    expect(verifyHyperdhtBind(peer, sig, seeder, 'nfx:testnet:1')).toBe(false);
    expect(verifyHyperdhtBind(peer, sig, '0'.repeat(64), namespace)).toBe(false);

    // Ed25519 is deterministic: the throwaway peer key reproduces `bind` byte for byte.
    const pk = new Uint8Array(sodium.crypto_sign_PUBLICKEYBYTES);
    const sk = new Uint8Array(sodium.crypto_sign_SECRETKEYBYTES);
    sodium.crypto_sign_seed_keypair(pk, sk, hexToBytes(v.secret_keys_DO_NOT_USE['hyperdht_peer']!));
    expect(bytesToHex(pk)).toBe(peer);
    const out = new Uint8Array(sodium.crypto_sign_BYTES);
    sodium.crypto_sign_detached(out, new TextEncoder().encode(message_utf8), sk);
    expect(bytesToHex(out)).toBe(sig);
  });

  it('fits the gossip budget the vector counts (canon)', () => {
    const content = JSON.parse(beaconVector.event.content) as {
      endpoints: { tickets: Record<string, string> }[];
    };
    const iroh = content.endpoints[0]!;
    const ticket720 = iroh.tickets['720p']!;
    const ticketMeta = iroh.tickets['meta']!;
    const hyperdht = { t: 'hyperdht', peer: v.bind.peer, bind: v.bind.sig };
    const canonBytes = (value: unknown): number =>
      new TextEncoder().encode(unwrap(canonicalize(JSON.stringify(value)))).length;
    expect(canonBytes(hyperdht) + 1).toBe(v.gossip_budget.hyperdht_endpoint_bytes);

    // generate.py's list: the first n get the 720p ticket, then `meta` its own.
    const renditionIds = [
      '2160p',
      '1440p',
      '1080p',
      '720p',
      '540p',
      '480p',
      '360p',
      '240p',
      '144p',
      'audio-hi',
      'audio-lo',
      'r1',
      'r2',
      'r3',
      'r4',
      'r5',
      'r6',
      'r7',
      'r8',
      'r9',
    ];
    const envelopeBytes = (n: number, withHyperdht: boolean): number => {
      const tickets: Record<string, string> = {};
      for (const id of renditionIds.slice(0, n)) tickets[id] = ticket720;
      tickets['meta'] = ticketMeta;
      const beacon = {
        ...content,
        endpoints: [{ ...iroh, tickets }, ...(withHyperdht ? [hyperdht] : [])],
      };
      const body = {
        v: 1,
        op: 'here',
        pubkey: beaconVector.event.pubkey,
        beacon,
        created_at: beaconVector.event.created_at,
        sig: '0'.repeat(128), // a BIP-340 signature's length; its value does not count
      };
      return canonBytes(body);
    };
    const fit = (limit: number, withHyperdht: boolean): number => {
      let n = 0;
      while (n < renditionIds.length && envelopeBytes(n + 1, withHyperdht) <= limit) n++;
      return n;
    };
    for (const [limit, expected] of Object.entries(v.gossip_budget.limits)) {
      expect(fit(Number(limit), false), `${limit} without`).toBe(expected.without_hyperdht);
      expect(fit(Number(limit), true), `${limit} with`).toBe(expected.with_hyperdht);
    }
  });
});

describe('NFX-05 hash lists and playlists', () => {
  interface WireFile {
    name: string;
    role: string;
    sha256: string;
    size: number;
    dur_ms?: number;
  }
  interface WireRendition {
    id: string;
    playlist: string;
    bandwidth: number;
    codecs?: string;
    resolution?: string;
  }
  const v = load('hashlist.json') as {
    rendered_bytes_sha256: string;
    hashlist: { video: string; files: WireFile[]; renditions: WireRendition[] };
    fabricated: Record<string, string>;
    playlists: Record<string, string>;
  };
  // The vector's structure, as nfx-proto's serde reads it (`serde_json::from_value`).
  const list: HashList = {
    v: 1,
    video: v.hashlist.video,
    files: v.hashlist.files.map((f): FileEntry => ({
      name: f.name,
      role: f.role as Role,
      sha256: f.sha256,
      size: BigInt(f.size),
      durMs: f.dur_ms === undefined ? undefined : BigInt(f.dur_ms),
    })),
    renditions: v.hashlist.renditions.map((r): Rendition => ({
      id: r.id,
      playlist: r.playlist,
      bandwidth: BigInt(r.bandwidth),
      codecs: r.codecs,
      resolution: r.resolution,
    })),
  };

  it('renders the bytes the root commits to, and verifies them', () => {
    const bytes = renderHashList(list);
    expect(sha256Hex(bytes)).toBe(v.rendered_bytes_sha256);
    expect(sha256Hex(bytes)).toBe(manifest.root);
    expect(unwrap(verifyHashListFor(bytes, manifest))).toEqual(list);
  });

  it('applies the Blossom rule to every fabricated file', () => {
    for (const [name, b64] of Object.entries(v.fabricated)) {
      const data = new Uint8Array(Buffer.from(b64, 'base64'));
      const entry = list.files.find((f) => f.sha256 === sha256Hex(data));
      expect(entry, `${name} is listed`).toBeDefined();
      expect(verifyFile(entry!.sha256, data).ok, name).toBe(true);
      const tampered = data.slice();
      tampered[0] = tampered[0]! ^ 1;
      expect(verifyFile(entry!.sha256, tampered).ok, name).toBe(false);
    }
  });

  it('checks playlists and maps content names', () => {
    for (const [name, text] of Object.entries(v.playlists)) {
      const bytes = new TextEncoder().encode(text);
      const entry = list.files.find((f) => f.name === name)!;
      expect(verifyFile(entry.sha256, bytes).ok, name).toBe(true);
      expect(checkPlaylist(list, bytes).ok, name).toBe(true);
    }
    // A playlist's content name identifies its rendition (NFX-10 §2 stream mapping).
    for (const r of list.renditions) {
      const playlist = list.files.find((f) => f.name === r.playlist)!;
      expect(renditionForPlaylist(list, `${playlist.sha256}.m3u8`)).toEqual(r);
    }
    const master = list.files.find((f) => f.role === 'playlist-master')!;
    expect(renditionForPlaylist(list, `${master.sha256}.m3u8`)).toBeUndefined();
    const init = list.files.find((f) => f.role === 'init')!;
    expect(resolveContentName(list, `${init.sha256}.mp4`)).toEqual(init);
    expect(resolveContentName(list, 'seg/0001.m4s')).toBeUndefined();
  });

  it('rejects every invalid hash list and playlist', () => {
    const invalid = load('hashlist-invalid.json') as {
      hashlists: { name: string; bytes_b64: string; root: string; video: string; segs: number }[];
      playlists: { name: string; playlist: string }[];
    };
    for (const c of invalid.hashlists) {
      const bytes = new Uint8Array(Buffer.from(c.bytes_b64, 'base64'));
      const video = unwrap(VideoAddr.parse(c.video));
      expect(verifyHashList(bytes, c.root, video, BigInt(c.segs)).ok, c.name).toBe(false);
    }
    for (const c of invalid.playlists) {
      expect(checkPlaylist(list, new TextEncoder().encode(c.playlist)).ok, c.name).toBe(false);
    }
  });
});

describe('NFX-11 §9 canon', () => {
  it('canonicalizes or rejects every case', () => {
    const v = load('canon.json') as {
      cases: { name: string; input: string; canon: string | null }[];
    };
    for (const c of v.cases) {
      const got = canonicalize(c.input);
      if (c.canon === null) expect(got.ok, `${c.name} must be rejected`).toBe(false);
      else expect(unwrap(got), c.name).toBe(c.canon);
    }
  });
});

describe('NFX-01 derived identifiers and grammar', () => {
  const v = load('derived.json') as {
    videos: {
      namespace: string;
      video_id: string;
      d: string;
      swarm_topic: string;
      hyper_topic: string;
      web_swarms: { rendition: string; stream_swarm_id: string; tracker_infohash: string }[];
    }[];
    a_tag: { a: string; creator: string };
    namespaces_valid: string[];
    namespaces_invalid: string[];
    video_ids_valid: string[];
    video_ids_invalid: string[];
  };

  it('derives topics and swarm ids', () => {
    for (const d of v.videos) {
      const addr = unwrap(VideoAddr.parse(d.d));
      expect(addr.namespace.toString()).toBe(d.namespace);
      expect(addr.videoId).toBe(d.video_id);
      expect(bytesToHex(addr.swarmTopic())).toBe(d.swarm_topic);
      // `tracker_infohash` (a SHA-1, NFX-10 §2) is the browser mesh's: not derived here.
      for (const w of d.web_swarms)
        expect(addr.webStreamSwarmId(w.rendition)).toBe(w.stream_swarm_id);
      expect(bytesToHex(addr.hyperTopic())).toBe(d.hyper_topic);
    }
    expect(manifestATag(manifest)).toBe(v.a_tag.a);
    expect(manifest.author).toBe(v.a_tag.creator);
  });

  it('accepts and rejects namespaces and video ids', () => {
    for (const ns of v.namespaces_valid) expect(unwrap(Namespace.parse(ns)).toString()).toBe(ns);
    for (const ns of v.namespaces_invalid) expect(Namespace.parse(ns).ok, ns).toBe(false);
    for (const id of v.video_ids_valid) expect(validateVideoId(id).ok, id).toBe(true);
    for (const id of v.video_ids_invalid) expect(validateVideoId(id).ok, id).toBe(false);
  });
});

describe('NFX-02 §6 deletions', () => {
  it("withdraw their author's own addresses only", () => {
    const v = load('deletion.json') as {
      secret_keys_DO_NOT_USE: Keys;
      manifest_a: string;
      event: RawEvent;
      cases: Named[];
    };
    const d = unwrap(parseDeletion(v.event));
    expect(d.author).toBe(manifest.author);
    expect(d.addresses).toEqual([manifest.addr]);
    expect(deletionDeletes(d, manifest), 'the deletion is newer than the revision').toBe(true);
    const later = { ...manifest, createdAt: d.createdAt + 1 };
    expect(deletionDeletes(d, later), 'a later revision republishes the video').toBe(false);
    expect(deletionTags([v.manifest_a])).toEqual(v.event.tags);
    expect(v.event.pubkey).toBe(pubkeyOf(v.secret_keys_DO_NOT_USE, 'creator'));
    expect(idOf(v.event)).toBe(v.event.id);
    for (const c of v.cases)
      expect(parseDeletion(c.event).ok, `${c.name} must be rejected`).toBe(false);
  });
});

describe('NFX-12 nfx/files/1 and nfx/pay/1 (files1.json)', () => {
  interface Message {
    index: number;
    name: string;
    hex: string;
  }
  const v = load('files1.json') as {
    video: string;
    protocols: { files: string; pay: string };
    channel_id_hex: string;
    types: { files: string[]; pay: string[] };
    transfer: { file: string; sha256: string; size: number; messages: Message[] };
    free_mode_missing: Message;
    pay: Message;
    max_pay_message_bytes: number;
    max_data_payload_bytes: number;
    invalid: { name: string; index: number; protocol?: string; hex?: string; length?: number }[];
  };

  it('pins the protocols, type indices, limits and channel id', () => {
    expect([FILES_PROTOCOL, PAY_PROTOCOL]).toEqual([v.protocols.files, v.protocols.pay]);
    expect(FILES_MESSAGE_TYPES).toEqual(v.types.files);
    expect(PAY_MESSAGE_TYPES).toEqual(v.types.pay);
    expect(MAX_PAY_MESSAGE).toBe(v.max_pay_message_bytes);
    expect(MAX_DATA_PAYLOAD).toBe(v.max_data_payload_bytes);
    expect(bytesToHex(unwrap(VideoAddr.parse(v.video)).channelId())).toBe(v.channel_id_hex);
  });

  it('decodes and re-encodes the transfer, whose data frames are the file', () => {
    const chunks: Uint8Array[] = [];
    for (const m of v.transfer.messages) {
      const bytes = hexToBytes(m.hex);
      const message = unwrap(decodeFilesMessage(m.index, bytes));
      expect(message.type).toBe(m.name);
      expect(message.req).toBe(7);
      if (message.type === 'get') expect(bytesToHex(message.sha)).toBe(v.transfer.sha256);
      if (message.type === 'data') chunks.push(message.payload.slice());
      const again = unwrap(encodeFilesMessage(message));
      expect(again.index).toBe(m.index);
      expect(bytesToHex(again.bytes)).toBe(m.hex);
    }
    const file = Buffer.concat(chunks);
    expect(file.length).toBe(v.transfer.size);
    expect(sha256Hex(file)).toBe(v.transfer.sha256);

    const missing = unwrap(
      decodeFilesMessage(v.free_mode_missing.index, hexToBytes(v.free_mode_missing.hex)),
    );
    expect(missing).toEqual({ type: 'missing', req: 7 });
  });

  it('decodes and re-encodes the pay/1 message', () => {
    const text = unwrap(decodePayMessage(v.pay.index, hexToBytes(v.pay.hex)));
    expect(JSON.parse(text) as unknown).toMatchObject({ t: 'hello', video: v.video });
    expect(bytesToHex(unwrap(encodePayMessage(text)))).toBe(v.pay.hex);
  });

  it('rejects every invalid message', () => {
    for (const c of v.invalid) {
      const bytes = c.hex === undefined ? new Uint8Array(c.length ?? 0) : hexToBytes(c.hex);
      expect(bytes.length, c.name).toBe(c.length ?? bytes.length);
      const decoded =
        c.protocol === 'pay'
          ? decodePayMessage(c.index, bytes)
          : decodeFilesMessage(c.index, bytes);
      expect(decoded.ok, `${c.name} must be rejected`).toBe(false);
    }
  });
});
