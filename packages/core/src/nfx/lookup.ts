/**
 * Seeder lookup (NFX-17, kind 20465): a viewer asks who seeds a video, and each seeder that does
 * answers at once by sending its signed beacon to the key that asked. Written from the spec and
 * pinned by its vectors (`docs/vendor/nfx-test-vectors/lookup*.json`); nfx-proto's `lookup.rs` is
 * the reference it mirrors.
 *
 * One ephemeral kind, told apart by its `t`. An `ask` is signed by a throwaway key, one per video
 * per viewing session. A `tell` is signed by a seeder's beacon key, is addressed (`p`) to the
 * ask's signer, and carries that seeder's complete signed kind-20464 beacon as its content, in
 * exactly one spelling. The embedded beacon gets the ordinary NFX-03 check (`parseBeacon`), so a
 * tell adds no trust of its own: the wrapper only routes (§2).
 *
 * As everything in `@sovit/core/nfx`: pure, with the clock passed in, and nothing here signs or
 * holds a key. The tags, the content and the unsigned events are built here, and whoever holds
 * the key signs them. The readers never throw, whatever they are handed, and read an untrusted
 * object once, so every check and the signature see the same event.
 */
import type { NfxVideo, NostrEvent, NostrFilter, UnixSeconds } from '../contracts/index.js';
import { parseATag, parseBeacon, type Beacon } from './beacon.js';
import { fail, ok, type NfxError, type NfxResult, type Verified } from './errors.js';
import { KIND_BEACON, verifyEvent } from './event.js';
import { JsonNumber, JsonObject, isJsonArray, parseJson, type JsonValue } from './json.js';
import { Namespace, type VideoAddr } from './namespace.js';
import { isLowerHex, parseU64Strict, utf8 } from './util.js';

/** The kind of a lookup event (NFX-17 §1), in the ephemeral range. */
export const KIND_LOOKUP = 20465;
/** The longest lifetime of an ask, in seconds (§2 rule 4). */
export const LOOKUP_ASK_TTL = 60;
/** How far before `now` a lookup event's `created_at` may be, in seconds (§2 rule 3). */
export const LOOKUP_MAX_AGE = 60;
/** How far after `now` a lookup event's `created_at` may be, in seconds (§2 rule 3). */
export const LOOKUP_MAX_FUTURE = 30;
/** The largest tell content in bytes: one beacon, whose NFX-04 §2 limit is 16 KiB (§2 rule 5). */
export const LOOKUP_MAX_TELL_CONTENT = 16 * 1024;
/** The largest ask a scoped relay carries, in bytes of event JSON (§5). */
export const LOOKUP_MAX_ASK_BYTES = 1024;
/** The largest tell a scoped relay carries, in bytes of event JSON: the content, escaped (§5). */
export const LOOKUP_MAX_TELL_BYTES = 36 * 1024;

/** The two types of lookup event this version uses. */
export type LookupType = 'ask' | 'tell';

/**
 * What the checks that need no cryptography say about a lookup event: its tags, its freshness
 * and the length of a tell's content. **Nothing here is authenticated**, `sender` and `asker`
 * included, so a limit keyed on them MUST NOT be charged from a shape (§3, §5): an unsigned event
 * would spend someone else's budget. Charge after `readLookup`.
 */
export interface LookupShape {
  readonly type: LookupType;
  /** The event's signer, as claimed. */
  readonly sender: string;
  /** Who asked: the signer of an ask, the `p` of a tell. */
  readonly asker: string;
  /** The `a` tag: the address of the manifest looked up. */
  readonly a: string;
  /** The manifest's author, from `a`. */
  readonly creator: string;
  /** The video, from `a`; its namespace is the `n` tag's. */
  readonly video: VideoAddr;
  readonly createdAt: number;
  readonly expiration: bigint;
}

/** An ask that passed §2. */
export interface LookupAsk {
  /** The event id: a seeder remembers an ask by (id, relay) (§3). */
  readonly id: string;
  /** The throwaway key to answer. A tell goes to this key and to no other (§3). */
  readonly asker: string;
  readonly a: string;
  readonly creator: string;
  readonly video: VideoAddr;
  readonly createdAt: number;
  readonly expiration: bigint;
}

/** A tell that passed §2. */
export interface LookupTell {
  readonly id: string;
  /** The seeder: the tell's signer, which is the embedded beacon's. Never the asker's key. */
  readonly seeder: string;
  /** The `p` the tell is addressed to. */
  readonly asker: string;
  readonly a: string;
  readonly creator: string;
  readonly video: VideoAddr;
  readonly createdAt: number;
  /** The embedded beacon's, which the tell's equals. */
  readonly expiration: bigint;
  /** The embedded kind-20464 event, exactly as its seeder signed it. */
  readonly event: NostrEvent;
  /** The embedded beacon, which passed NFX-03 at the `now` it was read at. */
  readonly beacon: Verified<Beacon>;
}

/** What `readLookup` made of an event that is not an error. */
export type LookupRead =
  | { readonly type: 'ask'; readonly ask: Verified<LookupAsk> }
  | { readonly type: 'tell'; readonly tell: Verified<LookupTell> }
  /** A `t` this version does not use: dropped without error (§2, NFX-01 §4). */
  | { readonly type: 'ignored'; readonly why: string };

/** An unsigned lookup event: the signer adds `pubkey`, `id` and `sig`. */
export interface LookupTemplate {
  readonly kind: typeof KIND_LOOKUP;
  readonly created_at: number;
  readonly tags: string[][];
  readonly content: string;
}

/** A signed event's members, as a tell embeds them. A `NostrEvent` is one. */
export interface SignedEventMembers {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
  readonly sig: string;
}

const T_ASK = 'ask';
const T_TELL = 'tell';
const OTHER_TYPE = 'a type this version does not use';

/** NIP-01's members, in the order a tell's content spells them (§1.2). */
const MEMBERS: readonly string[] = ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig'];
const U16_MAX = 0xffffn;
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

const bad = (reason: string): NfxResult<never> => fail('event', `lookup: ${reason}`);
/** An error from a check this module delegates, with its kind kept and its place named. */
const from = (error: NfxError, place = ''): NfxResult<never> =>
  fail(error.kind, `lookup: ${place}${error.reason}`);

const isUnixTime = (t: number): boolean => Number.isSafeInteger(t) && t >= 0;

/**
 * A tell's content: `e` as compact JSON, exactly the members id, pubkey, created_at, kind, tags,
 * content, sig in that order (§1.2). `JSON.stringify` escapes a well-formed string as serde_json
 * does (`"`, `\`, the two-letter controls and lowercase `\u00xx` below U+0020, nothing else).
 */
function compactEvent(e: SignedEventMembers): string {
  const q = (s: string): string => JSON.stringify(s);
  return (
    `{"id":${q(e.id)},"pubkey":${q(e.pubkey)},"created_at":${String(e.created_at)},` +
    `"kind":${String(e.kind)},"tags":${JSON.stringify(e.tags)},"content":${q(e.content)},` +
    `"sig":${q(e.sig)}}`
  );
}

/** The value of the one tag called `name`: `undefined` if absent, an error if repeated or empty. */
function one(tags: readonly (readonly string[])[], name: string): NfxResult<string | undefined> {
  let found: readonly string[] | undefined;
  for (const t of tags) {
    if (t[0] !== name) continue;
    if (found !== undefined) return bad(`duplicate \`${name}\` tag`);
    found = t;
  }
  if (found === undefined) return ok(undefined);
  const value = found[1];
  return value === undefined ? bad(`\`${name}\` tag has no value`) : ok(value);
}

function required(tags: readonly (readonly string[])[], name: string): NfxResult<string> {
  const value = one(tags, name);
  if (!value.ok) return value;
  return value.value === undefined ? bad(`missing \`${name}\` tag`) : ok(value.value);
}

/** An untrusted event, read once into plain values. `id` and `sig` are the verifier's to check. */
interface Snapshot {
  readonly id: unknown;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
  readonly sig: unknown;
}

/**
 * One read of an untrusted object (a relay's event, or anything else), so that everything after
 * it sees the same event: an object with getters, or a proxy, cannot show one thing to the checks
 * and another to the verifier. The verifier copies it again before it hashes.
 */
function snapshot(raw: unknown): NfxResult<Snapshot> {
  if (typeof raw !== 'object' || raw === null) return bad('not a well-formed event');
  try {
    const e = raw as Readonly<Record<string, unknown>>;
    const { id, pubkey, kind, content, sig } = e;
    const createdAt = e['created_at'];
    const rawTags = e['tags'];
    if (
      typeof kind !== 'number' ||
      !Number.isInteger(kind) ||
      typeof pubkey !== 'string' ||
      typeof content !== 'string' ||
      typeof createdAt !== 'number' ||
      !isUnixTime(createdAt) ||
      !Array.isArray(rawTags)
    )
      return bad('not a well-formed event');
    const tags: string[][] = [];
    for (const t of rawTags as readonly unknown[]) {
      if (!Array.isArray(t) || t.length === 0)
        return bad('a tag is not a non-empty array of strings');
      const copy: string[] = [];
      for (const v of t as readonly unknown[]) {
        if (typeof v !== 'string') return bad('a tag is not a non-empty array of strings');
        copy.push(v);
      }
      tags.push(copy);
    }
    return ok({ id, pubkey, created_at: createdAt, kind, tags, content, sig });
  } catch {
    // A getter or a proxy trap that throws.
    return bad('not a well-formed event');
  }
}

/** The snapshot and its type; `undefined` for a `t` this version does not use. */
function typed(
  raw: unknown,
  now: number,
): NfxResult<{ readonly s: Snapshot; readonly type: LookupType | undefined }> {
  // A reader without a clock would take anything as fresh.
  if (!isUnixTime(now)) return bad('`now` is not a unix time');
  const s = snapshot(raw);
  if (!s.ok) return s;
  if (s.value.kind !== KIND_LOOKUP) return bad('wrong kind');
  const t = required(s.value.tags, 't');
  if (!t.ok) return t;
  const type = t.value === T_ASK || t.value === T_TELL ? t.value : undefined;
  return ok({ s: s.value, type });
}

/** §2 rules 2 to 5, except what the content of a tell must hold. No cryptography. */
function shapeOf(s: Snapshot, type: LookupType, now: number): NfxResult<LookupShape> {
  if (!isLowerHex(s.pubkey, 64)) return bad('`pubkey` is not 64 lowercase hex');
  const n = required(s.tags, 'n');
  if (!n.ok) return n;
  const namespace = Namespace.parse(n.value);
  if (!namespace.ok) return bad('`n` is not a namespace');
  const a = required(s.tags, 'a');
  if (!a.ok) return a;
  const target = parseATag(a.value);
  // parseATag's own reasons are fixed text; a namespace or video id it refuses is not repeated.
  if (!target.ok) {
    return bad(target.error.kind === 'beacon' ? target.error.reason : '`a` names no video');
  }
  if (!target.value.addr.namespace.equals(namespace.value)) {
    return bad('`a` names a different network than `n`');
  }
  const expirationTag = required(s.tags, 'expiration');
  if (!expirationTag.ok) return expirationTag;
  const expiration = parseU64Strict(expirationTag.value);
  if (expiration === undefined) return bad('`expiration` is not a canonical decimal integer');
  const createdAt = s.created_at;
  if (now - createdAt > LOOKUP_MAX_AGE || createdAt - now > LOOKUP_MAX_FUTURE) {
    return bad('`created_at` is not within 60 s before to 30 s after now');
  }
  if (expiration <= BigInt(createdAt)) return bad('`expiration` is not after `created_at`');
  if (BigInt(now) >= expiration) return bad('expired');
  let asker: string;
  if (type === T_ASK) {
    if (expiration - BigInt(createdAt) > BigInt(LOOKUP_ASK_TTL)) {
      return bad('an ask lives at most 60 s');
    }
    if (s.tags.some((t) => t[0] === 'p')) return bad('an ask carries no `p`');
    if (s.content !== '') return bad('an ask carries no content');
    asker = s.pubkey;
  } else {
    const p = required(s.tags, 'p');
    if (!p.ok) return p;
    if (!isLowerHex(p.value, 64)) return bad('`p` is not 64 lowercase hex');
    if (s.content === '') return bad('a tell carries a beacon');
    // A UTF-8 encoding is at least as many bytes as the string has UTF-16 units.
    if (
      s.content.length > LOOKUP_MAX_TELL_CONTENT ||
      utf8(s.content).length > LOOKUP_MAX_TELL_CONTENT
    ) {
      return bad('content over 16384 bytes');
    }
    asker = p.value;
  }
  return ok({
    type,
    sender: s.pubkey,
    asker,
    a: a.value,
    creator: target.value.creator,
    video: target.value.addr,
    createdAt,
    expiration,
  });
}

/**
 * A tell's content read as an event (§2 rule 5): JSON whose members are exactly NIP-01's, once
 * each, with NIP-01's types, spelled in the one compact form of §1.2. Nothing is verified here.
 */
function embeddedEvent(content: string): NfxResult<SignedEventMembers> {
  const json = parseJson(content);
  if (!json.ok) return bad('the content is not JSON');
  const v = json.value;
  if (!(v instanceof JsonObject)) return bad('the content is not an event');
  if (v.duplicates.size > 0) return bad('the embedded event repeats a member');
  for (const key of v.entries.keys()) {
    if (!MEMBERS.includes(key)) return bad('the embedded event has a member NIP-01 does not');
  }
  const str = (name: string): string | undefined => {
    const x = v.get(name);
    return typeof x === 'string' ? x : undefined;
  };
  const int = (name: string, max: bigint): number | undefined => {
    const x = v.get(name);
    return x instanceof JsonNumber && x.int !== undefined && x.int >= 0n && x.int <= max
      ? Number(x.int)
      : undefined;
  };
  const id = str('id');
  const pubkey = str('pubkey');
  const eventContent = str('content');
  const sig = str('sig');
  const kind = int('kind', U16_MAX);
  // Past 2^53 − 1 a beacon is centuries from any clock NFX-03 accepts: refused here, unrounded.
  const createdAt = int('created_at', SAFE_MAX);
  const tags = stringArrays(v.get('tags'));
  if (
    id === undefined ||
    pubkey === undefined ||
    eventContent === undefined ||
    sig === undefined ||
    kind === undefined ||
    createdAt === undefined ||
    tags === undefined
  ) {
    return bad('the content is not an event with NIP-01 members and types');
  }
  const event: SignedEventMembers = {
    id,
    pubkey,
    created_at: createdAt,
    kind,
    tags,
    content: eventContent,
    sig,
  };
  // One spelling, so that every implementation reads the same bytes as the same event.
  if (compactEvent(event) !== content) return bad('the embedded beacon is not in its compact form');
  return ok(event);
}

function stringArrays(value: JsonValue | undefined): string[][] | undefined {
  if (!isJsonArray(value)) return undefined;
  const out: string[][] = [];
  for (const item of value) {
    if (!isJsonArray(item)) return undefined;
    const values: string[] = [];
    for (const s of item) {
      if (typeof s !== 'string') return undefined;
      values.push(s);
    }
    out.push(values);
  }
  return out;
}

function verifiedAsk(s: Snapshot, shape: LookupShape): NfxResult<Verified<LookupAsk>> {
  const verified = verifyEvent(s);
  if (!verified.ok) return from(verified.error);
  const ask: LookupAsk = {
    id: verified.value.id,
    asker: shape.asker,
    a: shape.a,
    creator: shape.creator,
    video: shape.video,
    createdAt: shape.createdAt,
    expiration: shape.expiration,
  };
  return ok(ask as Verified<LookupAsk>);
}

/**
 * The rest of §2 rule 5, cheapest first: the content's spelling and what it names, then the
 * tell's signature, then the beacon's (NFX-03 in full), then the beacon's dates against the tell's.
 */
function verifiedTell(
  s: Snapshot,
  shape: LookupShape,
  now: number,
): NfxResult<Verified<LookupTell>> {
  const embedded = embeddedEvent(s.content);
  if (!embedded.ok) return embedded;
  const inner = embedded.value;
  if (inner.kind !== KIND_BEACON) return bad('the embedded event is not a beacon');
  if (inner.pubkey !== shape.sender) return bad("the tell's signer is not the beacon's");
  const innerA = one(inner.tags, 'a');
  if (!innerA.ok) return bad('the embedded beacon does not have exactly one `a`');
  if (innerA.value !== shape.a) return bad('the embedded beacon serves another video');
  const outer = verifyEvent(s);
  if (!outer.ok) return from(outer.error);
  // The embedded event through the package's boundary, then NFX-03, which verifies its own copy
  // again: a second signature check, spent only on a tell that passed everything before it.
  const event = verifyEvent(inner);
  if (!event.ok) return from(event.error, 'the embedded beacon: ');
  const beacon = parseBeacon(event.value, now);
  if (!beacon.ok) return from(beacon.error, 'the embedded beacon: ');
  if (beacon.value.expiration !== shape.expiration) {
    return bad("`expiration` is not the embedded beacon's");
  }
  // Without this, a beacon dated up to NFX-03's 15 minutes ahead would hold a place in a viewer's
  // table for that long (§2).
  if (beacon.value.createdAt > shape.createdAt) {
    return bad('the embedded beacon is dated after the tell');
  }
  const tell: LookupTell = {
    id: outer.value.id,
    seeder: shape.sender,
    asker: shape.asker,
    a: shape.a,
    creator: shape.creator,
    video: shape.video,
    createdAt: shape.createdAt,
    expiration: shape.expiration,
    event: event.value,
    beacon: beacon.value,
  };
  return ok(tell as Verified<LookupTell>);
}

/**
 * The checks of a lookup event that need no cryptography (§2 rules 2 to 5, a tell's content
 * aside), for a seeder that looks at its budgets before it verifies (§3). A type this version
 * does not use is an error here. See `LookupShape`: nothing in it is authenticated.
 */
export function lookupShape(raw: unknown, now: number): NfxResult<LookupShape> {
  const t = typed(raw, now);
  if (!t.ok) return t;
  if (t.value.type === undefined) return bad(OTHER_TYPE);
  return shapeOf(t.value.s, t.value.type, now);
}

/**
 * A reader's check of a kind-20465 event at `now`, unix seconds (§2): every rule, the signature
 * and the embedded beacon's NFX-03 check included. A `t` this version does not use is `ignored`.
 * Whether a tell is addressed to this reader is `readLookupTell`'s check.
 */
export function readLookup(raw: unknown, now: number): NfxResult<LookupRead> {
  const t = typed(raw, now);
  if (!t.ok) return t;
  const { s, type } = t.value;
  if (type === undefined) return ok({ type: 'ignored', why: OTHER_TYPE });
  const shape = shapeOf(s, type, now);
  if (!shape.ok) return shape;
  if (type === T_ASK) {
    const ask = verifiedAsk(s, shape.value);
    return ask.ok ? ok({ type: 'ask', ask: ask.value }) : ask;
  }
  const tell = verifiedTell(s, shape.value, now);
  return tell.ok ? ok({ type: 'tell', tell: tell.value }) : tell;
}

/** A seeder's read of an event on its ask subscription (§3): an ask that passes §2, or an error. */
export function readLookupAsk(raw: unknown, now: number): NfxResult<Verified<LookupAsk>> {
  const t = typed(raw, now);
  if (!t.ok) return t;
  const { s, type } = t.value;
  if (type !== T_ASK) return bad('not an ask');
  const shape = shapeOf(s, type, now);
  return shape.ok ? verifiedAsk(s, shape.value) : shape;
}

/** What a viewer asked with: its throwaway key and the video. */
export interface LookupTellReader {
  /** Unix seconds. */
  readonly now: number;
  /** The key the ask was signed with: a tell's `p` must be it. */
  readonly asker: string;
  /** The manifest address asked about: a tell's `a` must be it. */
  readonly a: string;
}

/**
 * A viewer's read of an event on its tell subscription (§2, §4): a tell that passes §2, addressed
 * to `asker` and about `a`, or an error. Anything else is an error, an ask or a `t` this version
 * does not use included, as for nfx's `LookupAsker.readTell`. The address is checked before any
 * cryptography, so a tell for someone else costs nothing. The seeder is the beacon's signer,
 * never the asker's key; what a viewer may then do with it is §4.1's.
 */
export function readLookupTell(raw: unknown, o: LookupTellReader): NfxResult<Verified<LookupTell>> {
  const { now, asker, a } = o;
  if (!isLowerHex(asker, 64)) return bad('the asker is not 64 lowercase hex');
  const t = typed(raw, now);
  if (!t.ok) return t;
  const { s, type } = t.value;
  if (type !== T_TELL) return bad('not a tell');
  const shape = shapeOf(s, type, now);
  if (!shape.ok) return shape;
  if (shape.value.asker !== asker) return bad('a tell to another key');
  if (shape.value.a !== a) return bad('a tell about another video');
  return verifiedTell(s, shape.value, now);
}

/** Whether an event of `type`, `eventJsonBytes` long, fits a scoped relay's size limit (§5). */
export function lookupSizeOk(type: LookupType, eventJsonBytes: number): boolean {
  return eventJsonBytes <= (type === T_ASK ? LOOKUP_MAX_ASK_BYTES : LOOKUP_MAX_TELL_BYTES);
}

/**
 * The tags of an ask for the manifest address `manifestA`, made at `createdAt`, with the longest
 * allowed lifetime (§1.1). The namespace is taken from `a`, so `n` and `a` agree by construction.
 */
export function lookupAskTags(manifestA: string, createdAt: number): NfxResult<string[][]> {
  const target = parseATag(manifestA);
  if (!target.ok) return from(target.error);
  if (!isUnixTime(createdAt)) return bad('bad `created_at`');
  const expiration = BigInt(createdAt) + BigInt(LOOKUP_ASK_TTL);
  return ok([
    ['n', target.value.addr.namespace.toString()],
    ['a', manifestA],
    ['t', T_ASK],
    ['expiration', expiration.toString()],
  ]);
}

/**
 * The tags of a tell carrying the signed beacon `beacon`, addressed to `asker`, the ask's signer
 * and never a key named in a tag (§1.2, §3). `n`, `a` and `expiration` are the beacon's own.
 */
export function lookupTellTags(beacon: SignedEventMembers, asker: string): NfxResult<string[][]> {
  if (beacon.kind !== KIND_BEACON) return bad('the embedded event is not a beacon');
  if (!isLowerHex(asker, 64)) return bad('`p` is not 64 lowercase hex');
  const n = required(beacon.tags, 'n');
  if (!n.ok) return n;
  const a = required(beacon.tags, 'a');
  if (!a.ok) return a;
  const expiration = required(beacon.tags, 'expiration');
  if (!expiration.ok) return expiration;
  if (parseU64Strict(expiration.value) === undefined) {
    return bad('`expiration` is not a canonical decimal integer');
  }
  return ok([
    ['n', n.value],
    ['a', a.value],
    ['t', T_TELL],
    ['p', asker],
    ['expiration', expiration.value],
  ]);
}

/** A tell's content: the signed beacon as compact JSON, members in NIP-01 order (§1.2). */
export function lookupTellContent(beacon: SignedEventMembers): NfxResult<string> {
  const content = compactEvent(beacon);
  if (content.length > LOOKUP_MAX_TELL_CONTENT || utf8(content).length > LOOKUP_MAX_TELL_CONTENT) {
    return bad('content over 16384 bytes');
  }
  return ok(content);
}

/** An ask for `manifestA` made at `createdAt`, for the throwaway key to sign (§1.1, §4). */
export function lookupAskTemplate(manifestA: string, createdAt: number): NfxResult<LookupTemplate> {
  const tags = lookupAskTags(manifestA, createdAt);
  if (!tags.ok) return tags;
  return ok({ kind: KIND_LOOKUP, created_at: createdAt, tags: tags.value, content: '' });
}

/**
 * A tell carrying `beacon` to `asker`, made at `createdAt`, for the key that signed the beacon to
 * sign (§1.2, §3). It must be dated within the beacon's lifetime: not before the beacon, and
 * before it expires, or no reader would take it.
 */
export function lookupTellTemplate(
  beacon: SignedEventMembers,
  asker: string,
  createdAt: number,
): NfxResult<LookupTemplate> {
  const tags = lookupTellTags(beacon, asker);
  if (!tags.ok) return tags;
  if (!isUnixTime(createdAt)) return bad('bad `created_at`');
  const expirationTag = required(beacon.tags, 'expiration');
  const expiration = expirationTag.ok ? parseU64Strict(expirationTag.value) : undefined;
  if (
    expiration === undefined ||
    beacon.created_at > createdAt ||
    BigInt(createdAt) >= expiration
  ) {
    return bad("a tell is dated within its beacon's lifetime");
  }
  const content = lookupTellContent(beacon);
  if (!content.ok) return content;
  return ok({ kind: KIND_LOOKUP, created_at: createdAt, tags: tags.value, content: content.value });
}

/**
 * A seeder's subscription for asks about `videos` (manifest addresses) on `namespace`, from 60 s
 * back (§3). Splitting a long list across filters within a relay's limits is the caller's.
 */
export function lookupAskFilter(
  namespace: string,
  videos: readonly string[],
  now: number,
): NostrFilter {
  return {
    kinds: [KIND_LOOKUP],
    '#n': [namespace],
    '#t': [T_ASK],
    '#a': [...videos],
    since: Math.max(0, now - LOOKUP_MAX_AGE) as UnixSeconds,
  };
}

/** A viewer's subscription for the tells to `asker` about `video`, from 60 s back (§4). */
export function lookupTellFilter(
  video: Pick<NfxVideo, 'namespace' | 'id'>,
  asker: string,
  now: number,
): NostrFilter {
  return {
    kinds: [KIND_LOOKUP],
    '#n': [video.namespace],
    '#p': [asker],
    '#t': [T_TELL],
    '#a': [video.id],
    since: Math.max(0, now - LOOKUP_MAX_AGE) as UnixSeconds,
  };
}
