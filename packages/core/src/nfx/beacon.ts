/**
 * Kind-20464 availability beacons (NFX-03). Beacon content is untrusted: endpoints come from
 * it, trust never does. Every byte fetched through an endpoint is still verified against the
 * hash list (NFX-05 §4).
 *
 * This reader implements NFX-12, which nfx-proto does not yet: a `hyperdht` endpoint is parsed
 * strictly, and its `bind` must verify, or the whole beacon is invalid (NFX-12 §2).
 */
import { hexToBytes } from 'nostr-tools/utils';
import sodium from 'sodium-universal';

import type { NostrEvent } from '../contracts/index.js';
import { fail, ok, type NfxResult, type Verified } from './errors.js';
import { KIND_BEACON, KIND_MANIFEST, MAX_CLOCK_SKEW, singleTag, verifyEvent } from './event.js';
import { RESERVED_RENDITION_ID } from './hashlist.js';
import { JsonNumber, JsonObject, asU64, isJsonArray, parseJson, type JsonValue } from './json.js';
import type { Manifest } from './manifest.js';
import { Namespace, VideoAddr } from './namespace.js';
import {
  U64_MAX,
  compareCodePoints,
  isHttpsUrl,
  isLowerHex,
  parseU64Strict,
  utf8,
} from './util.js';

/** Allowed `expiration - created_at`, in seconds (NFX-03 §1). */
export const TTL_MIN = 60;
export const TTL_MAX = 120;

/** Where a seeder serves the video, in the NFX-03 §4 wire form's terms. */
export type Endpoint =
  /** NFX-06. `tickets` is ordered by key, as nfx-proto's `BTreeMap`. */
  | {
      readonly t: 'iroh';
      readonly node: string;
      readonly relay: string;
      readonly addrs: readonly string[];
      readonly tickets: ReadonlyMap<string, string>;
    }
  /** NFX-05 §6: an origin's base URL. */
  | { readonly t: 'https'; readonly url: string }
  /** NFX-10 §2: a bridge. Swarm ids are derived per rendition, never carried. */
  | {
      readonly t: 'webrtc';
      readonly trackerUrls: readonly string[];
      /** Renditions whose swarms the bridge joins; empty means every rendition. */
      readonly renditions: readonly string[];
    }
  /** The deprecated NFX-12 draft: parsed, never emitted by NFX-12 publishers, never dialed. */
  | { readonly t: 'hyper'; readonly drive: string }
  /** NFX-12 §2: the seeder's HyperDHT peer key, and its `bind` to this seeder and network. */
  | { readonly t: 'hyperdht'; readonly peer: string; readonly bind: string };

/** How much of the hash list a seeder holds: all of it, or a count of entries. */
export type Chunks = 'all' | bigint;

/** Beacon content (NFX-03 §4). */
export interface BeaconContent {
  readonly v: 1;
  readonly video: VideoAddr;
  readonly endpoints: readonly Endpoint[];
  /** `t` values of endpoints this implementation skipped as unknown (NFX-03 §4). */
  readonly skipped: readonly string[];
  readonly chunks: Chunks;
  readonly priceHint: bigint;
  readonly acceptsMints: readonly string[];
  readonly free: boolean;
}

/** A beacon event that passed NFX-03 in full at time `now`. */
export interface Beacon {
  readonly seeder: string;
  readonly createdAt: number;
  readonly expiration: bigint;
  /** Author of the manifest this beacon serves (from the `a` tag). */
  readonly creator: string;
  readonly content: BeaconContent;
}

const bad = (reason: string): NfxResult<never> => fail('beacon', reason);

/** Verify a kind-20464 event at time `now` (unix seconds). */
export function parseBeacon(raw: unknown, now: number): NfxResult<Verified<Beacon>> {
  if (!Number.isSafeInteger(now) || now < 0) return bad('`now` is not a unix time');
  const verified = verifyEvent(raw);
  if (!verified.ok) return verified;
  const event = verified.value;
  if (event.kind !== KIND_BEACON) return bad('wrong kind');
  const n = tag(event, 'n');
  if (!n.ok) return n;
  const namespace = Namespace.parse(n.value);
  if (!namespace.ok) return namespace;
  const a = tag(event, 'a');
  if (!a.ok) return a;
  const target = parseATag(a.value);
  if (!target.ok) return target;
  if (!target.value.addr.namespace.equals(namespace.value)) {
    return bad('`a` names a different network than `n`');
  }
  const expirationTag = tag(event, 'expiration');
  if (!expirationTag.ok) return expirationTag;
  const expiration = parseU64Strict(expirationTag.value);
  if (expiration === undefined) return bad('bad `expiration`');
  const createdAt = BigInt(event.created_at);
  if (expiration < createdAt) return bad('`expiration` precedes `created_at`');
  const ttl = expiration - createdAt;
  if (ttl < BigInt(TTL_MIN) || ttl > BigInt(TTL_MAX)) return bad('TTL outside [60,120] s');
  if (Math.abs(now - event.created_at) > MAX_CLOCK_SKEW) {
    return bad('`created_at` more than 15 min from now');
  }
  if (BigInt(now) >= expiration) return bad('expired');
  const json = parseJson(event.content);
  if (!json.ok) return bad('content is not JSON');
  const content = beaconContentFrom(json.value, event.pubkey);
  if (!content.ok) return content;
  if (!content.value.video.equals(target.value.addr)) {
    return bad("content `video` does not equal the `a` tag's d");
  }
  const beacon: Beacon = {
    seeder: event.pubkey,
    createdAt: event.created_at,
    expiration,
    creator: target.value.creator,
    content: content.value,
  };
  return ok(beacon as Verified<Beacon>);
}

/**
 * Parse and check beacon content as `seeder` published it. Unknown endpoint types are
 * skipped, known ones must be well formed, and at least one endpoint of any type must be
 * present. Every `hyperdht` endpoint's `bind` must verify for `seeder` on the content's
 * network (NFX-12 §2), so content taken out of its beacon still names only agreed peer keys.
 */
export function parseBeaconContent(text: string, seeder: string): NfxResult<BeaconContent> {
  const json = parseJson(text);
  return json.ok ? beaconContentFrom(json.value, seeder) : bad('content is not JSON');
}

/** Compact JSON for the event `content` (the publisher side), in nfx-proto's field order. */
export function beaconContentText(content: BeaconContent): string {
  const members = [
    '"v":1',
    `"video":${JSON.stringify(content.video.toString())}`,
    `"endpoints":[${content.endpoints.map(endpointText).join(',')}]`,
    `"chunks":${content.chunks === 'all' ? '"all"' : content.chunks.toString()}`,
    `"price_hint":${content.priceHint.toString()}`,
  ];
  if (content.acceptsMints.length > 0) {
    members.push(`"accepts_mints":${JSON.stringify(content.acceptsMints)}`);
  }
  members.push(`"free":${String(content.free)}`);
  return `{${members.join(',')}}`;
}

/**
 * Whether this beacon announces `manifest` (same author and address). A client holding
 * beacons from a broad REQ must check this before using the endpoints.
 */
export function beaconServes(beacon: Beacon, manifest: Manifest): boolean {
  return beacon.creator === manifest.author && beacon.content.video.equals(manifest.addr);
}

/**
 * The NFX-03 §1 tags for a beacon serving `manifestA` (a `manifestATag`), emitted at
 * `createdAt` with lifetime `ttl` seconds. The namespace is taken from the `a` tag, so the
 * `n`/`a` agreement rule holds by construction.
 */
export function beaconTags(
  manifestA: string,
  createdAt: number,
  ttl: number,
): NfxResult<string[][]> {
  const target = parseATag(manifestA);
  if (!target.ok) return target;
  if (!Number.isInteger(ttl) || ttl < TTL_MIN || ttl > TTL_MAX) {
    return bad('TTL outside [60,120] s');
  }
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) return bad('bad `created_at`');
  const expiration = BigInt(createdAt) + BigInt(ttl);
  if (expiration > U64_MAX) return bad('`expiration` overflows');
  return ok([
    ['n', target.value.addr.namespace.toString()],
    ['a', manifestA],
    ['expiration', expiration.toString()],
  ]);
}

/**
 * `38504:<creator>:<namespace>:<video-id>` → (creator, address). Split at the first two colons
 * only: the rest is the `d` value, which has colons of its own (NFX-02 §2).
 */
export function parseATag(
  a: string,
): NfxResult<{ readonly creator: string; readonly addr: VideoAddr }> {
  const first = a.indexOf(':');
  const second = first < 0 ? -1 : a.indexOf(':', first + 1);
  if (second < 0) return bad('malformed `a` tag');
  if (a.slice(0, first) !== String(KIND_MANIFEST)) {
    return bad('`a` must address a kind-38504 manifest');
  }
  const creator = a.slice(first + 1, second);
  if (!isLowerHex(creator, 64)) return bad('`a` creator is not 64 lowercase hex');
  const addr = VideoAddr.parse(a.slice(second + 1));
  return addr.ok ? ok({ creator, addr: addr.value }) : addr;
}

/** The message a `hyperdht` endpoint's `bind` signs (NFX-12 §2), before UTF-8 encoding. */
export function hyperdhtBindMessage(seeder: string, namespace: string): string {
  return `nfx/hyperdht/1:${seeder}:${namespace}`;
}

/** Whether `bind` (128 hex) is `peer`'s (64 hex) Ed25519 signature for `seeder` on `namespace`. */
export function verifyHyperdhtBind(
  peer: string,
  bind: string,
  seeder: string,
  namespace: string,
): boolean {
  if (!isLowerHex(peer, 64) || !isLowerHex(bind, 128)) return false;
  try {
    return sodium.crypto_sign_verify_detached(
      hexToBytes(bind),
      utf8(hyperdhtBindMessage(seeder, namespace)),
      hexToBytes(peer),
    );
  } catch {
    return false;
  }
}

function beaconContentFrom(value: JsonValue, seeder: string): NfxResult<BeaconContent> {
  if (!(value instanceof JsonObject)) return bad('content is not an object');
  if (asU64(value.get('v')) !== 1n) return bad('`v` must be 1');
  const videoText = stringField(value, 'video');
  if (!videoText.ok) return videoText;
  const video = VideoAddr.parse(videoText.value);
  if (!video.ok) return video;
  const rawEndpoints = value.get('endpoints');
  if (!isJsonArray(rawEndpoints)) return bad('`endpoints` must be an array');
  if (rawEndpoints.length === 0) return bad('`endpoints` must not be empty');
  const endpoints: Endpoint[] = [];
  const skipped: string[] = [];
  for (const raw of rawEndpoints) {
    const parsed = parseEndpoint(raw);
    if (!parsed.ok) return parsed;
    if (typeof parsed.value === 'string') skipped.push(parsed.value);
    else endpoints.push(parsed.value);
  }
  const rawChunks = value.get('chunks');
  let chunks: Chunks;
  if (rawChunks === 'all') {
    chunks = 'all';
  } else if (rawChunks instanceof JsonNumber) {
    const count = asU64(rawChunks);
    if (count === undefined) return bad('`chunks` is not a count');
    chunks = count;
  } else {
    return bad('`chunks` must be "all" or a count');
  }
  const priceHint = asU64(value.get('price_hint'));
  if (priceHint === undefined) return bad('`price_hint` must be a non-negative integer');
  const rawMints = value.get('accepts_mints');
  const acceptsMints =
    rawMints === undefined ? ok([]) : strings(rawMints, 'accepts_mints', isHttpsUrl);
  if (!acceptsMints.ok) return acceptsMints;
  const rawFree = value.get('free');
  if (rawFree !== undefined && typeof rawFree !== 'boolean') return bad('`free` must be a boolean');
  const free = rawFree ?? false;
  // NFX-03 §4: a paying seeder names its mints; there is no "any mint".
  if (!free && acceptsMints.value.length === 0) {
    return bad('`accepts_mints` is required and non-empty unless `free`');
  }
  const namespace = video.value.namespace.toString();
  for (const e of endpoints) {
    if (e.t === 'hyperdht' && !verifyHyperdhtBind(e.peer, e.bind, seeder, namespace)) {
      return bad('hyperdht `bind` does not verify for this seeder and network');
    }
  }
  return ok<BeaconContent>({
    v: 1,
    video: video.value,
    endpoints,
    skipped,
    chunks,
    priceHint,
    acceptsMints: acceptsMints.value,
    free,
  });
}

/** A known endpoint, or the `t` of an unknown one (skipped, NFX-03 §4). */
function parseEndpoint(raw: JsonValue): NfxResult<Endpoint | string> {
  if (!(raw instanceof JsonObject)) return bad('endpoint is not an object');
  const t = stringField(raw, 't');
  if (!t.ok) return t;
  switch (t.value) {
    case 'iroh': {
      const node = stringField(raw, 'node');
      if (!node.ok) return node;
      if (!isLowerHex(node.value, 64)) return bad('iroh `node` must be 64 lowercase hex');
      const rawTickets = raw.get('tickets');
      const tickets = new Map<string, string>();
      if (rawTickets instanceof JsonObject) {
        for (const key of [...rawTickets.entries.keys()].sort(compareCodePoints)) {
          const ticket = rawTickets.get(key);
          if (typeof ticket !== 'string' || utf8(ticket).length < 8) {
            return bad('iroh tickets must be strings of 8+ chars');
          }
          tickets.set(key, ticket);
        }
      } else if (rawTickets !== undefined) {
        return bad('iroh `tickets` must be an object');
      }
      const relay = raw.get('relay');
      const rawAddrs = raw.get('addrs');
      const addrs = rawAddrs === undefined ? ok([]) : strings(rawAddrs, 'addrs', () => true);
      if (!addrs.ok) return addrs;
      return ok<Endpoint>({
        t: 'iroh',
        node: node.value,
        relay: typeof relay === 'string' ? relay : '',
        addrs: addrs.value,
        tickets,
      });
    }
    case 'https': {
      const url = stringField(raw, 'url');
      if (!url.ok) return url;
      if (!isHttpsUrl(url.value)) return bad('https endpoint `url` must be an https URL');
      return ok<Endpoint>({ t: 'https', url: url.value });
    }
    case 'webrtc': {
      const rawTrackers = raw.get('tracker_urls');
      if (rawTrackers === undefined) return bad('webrtc endpoint needs `tracker_urls`');
      const trackerUrls = strings(
        rawTrackers,
        'tracker_urls',
        (u) => u.startsWith('wss://') || u.startsWith('ws://'),
      );
      if (!trackerUrls.ok) return trackerUrls;
      const rawRenditions = raw.get('renditions');
      const renditions =
        rawRenditions === undefined
          ? ok([])
          : strings(rawRenditions, 'renditions', (r) => r !== '' && r !== RESERVED_RENDITION_ID);
      if (!renditions.ok) return renditions;
      return ok<Endpoint>({
        t: 'webrtc',
        trackerUrls: trackerUrls.value,
        renditions: renditions.value,
      });
    }
    case 'hyper': {
      const drive = stringField(raw, 'drive');
      if (!drive.ok) return drive;
      if (!isLowerHex(drive.value, 64)) return bad('hyper `drive` must be 64 lowercase hex');
      return ok<Endpoint>({ t: 'hyper', drive: drive.value });
    }
    case 'hyperdht': {
      // Shapes here; the `bind` signature once the whole content (its network) is known.
      const peer = raw.get('peer');
      if (typeof peer !== 'string' || !isLowerHex(peer, 64)) {
        return bad('hyperdht `peer` must be 64 lowercase hex');
      }
      const bind = raw.get('bind');
      if (typeof bind !== 'string' || !isLowerHex(bind, 128)) {
        return bad('hyperdht `bind` must be 128 lowercase hex');
      }
      return ok<Endpoint>({ t: 'hyperdht', peer, bind });
    }
    default:
      return ok(t.value);
  }
}

function endpointText(e: Endpoint): string {
  const q = (s: string): string => JSON.stringify(s);
  switch (e.t) {
    case 'iroh': {
      // nfx-proto's `BTreeMap` order, whatever order the caller's Map was filled in.
      const tickets = [...e.tickets]
        .sort(([a], [b]) => compareCodePoints(a, b))
        .map(([k, v]) => `${q(k)}:${q(v)}`)
        .join(',');
      const members = [
        '"t":"iroh"',
        `"node":${q(e.node)}`,
        `"relay":${q(e.relay)}`,
        `"addrs":${JSON.stringify(e.addrs)}`,
        `"tickets":{${tickets}}`,
      ];
      return `{${members.join(',')}}`;
    }
    case 'https':
      return `{"t":"https","url":${q(e.url)}}`;
    case 'webrtc': {
      const renditions =
        e.renditions.length > 0 ? `,"renditions":${JSON.stringify(e.renditions)}` : '';
      return `{"t":"webrtc","tracker_urls":${JSON.stringify(e.trackerUrls)}${renditions}}`;
    }
    case 'hyper':
      return `{"t":"hyper","drive":${q(e.drive)}}`;
    case 'hyperdht':
      return `{"t":"hyperdht","peer":${q(e.peer)},"bind":${q(e.bind)}}`;
  }
}

/** The single value of a required tag, as a beacon error. */
function tag(event: NostrEvent, name: string): NfxResult<string> {
  const found = singleTag(event, name);
  if (!found.ok) return bad(found.error.reason);
  return found.value === undefined ? bad(`missing \`${name}\` tag`) : ok(found.value[0]);
}

function stringField(obj: JsonObject, name: string): NfxResult<string> {
  const value = obj.get(name);
  return typeof value === 'string' ? ok(value) : bad(`\`${name}\` must be a string`);
}

function strings(
  value: JsonValue,
  name: string,
  accept: (s: string) => boolean,
): NfxResult<string[]> {
  if (!isJsonArray(value)) return bad(`\`${name}\` must be an array`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !accept(item)) return bad(`bad entry in \`${name}\``);
    out.push(item);
  }
  return ok(out);
}
