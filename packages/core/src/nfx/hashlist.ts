/**
 * Hash lists, content names and playlists (NFX-05 §§2–4). The hash list is the only object a
 * manifest anchors, by `root`: its bytes are checked against `root` before anything is parsed.
 * Integer fields are `bigint`, as the reader keeps every u64 nfx-proto keeps.
 */
import { fail, ok, type NfxResult } from './errors.js';
import { JsonNumber, JsonObject, isJsonArray, parseJson, type JsonValue } from './json.js';
import type { Manifest } from './manifest.js';
import type { VideoAddr } from './namespace.js';
import { decodeUtf8, isLowerHex, rustTrim, sha256Hex, utf8 } from './util.js';

/** Rendition id reserved for the metadata collection (NFX-03 §4, NFX-06 §2). */
export const RESERVED_RENDITION_ID = 'meta';

export const ROLES = [
  'playlist-master',
  'playlist',
  'init',
  'segment',
  'thumb',
  'subtitle',
] as const;
export type Role = (typeof ROLES)[number];

/** One content-addressed file. */
export interface FileEntry {
  readonly name: string;
  readonly role: Role;
  readonly sha256: string;
  readonly size: bigint;
  readonly durMs: bigint | undefined;
}

export interface Rendition {
  readonly id: string;
  readonly playlist: string;
  readonly bandwidth: bigint;
  readonly codecs: string | undefined;
  readonly resolution: string | undefined;
}

/** The NFX-05 hash list. */
export interface HashList {
  readonly v: 1;
  readonly video: string;
  readonly files: readonly FileEntry[];
  readonly renditions: readonly Rendition[];
}

const bad = (reason: string): NfxResult<never> => fail('hash-list', reason);

/**
 * Verify hash-list `bytes` against a manifest's `root` (64 hex), address and `segs`. `root`
 * commits to the exact bytes, so the hash is checked before anything is parsed.
 */
export function verifyHashList(
  bytes: Uint8Array,
  root: string,
  video: VideoAddr,
  segs: bigint,
): NfxResult<HashList> {
  if (sha256Hex(bytes) !== root) return bad('sha256(bytes) does not equal the manifest root');
  const text = decodeUtf8(bytes);
  if (text === undefined) return bad('not a hash list: not UTF-8');
  const json = parseJson(text);
  if (!json.ok) return bad(`not a hash list: ${json.error}`);
  const list = decodeHashList(json.value);
  if (!list.ok) return list;
  const checked = check(list.value, video, segs);
  return checked === undefined ? list : bad(checked);
}

/** `verifyHashList` against the manifest that anchors it. */
export function verifyHashListFor(bytes: Uint8Array, manifest: Manifest): NfxResult<HashList> {
  return verifyHashList(bytes, manifest.root, manifest.addr, manifest.segs);
}

/**
 * The publisher's rendering: two-space indented JSON plus a trailing newline, the bytes
 * Python's `json.dumps(indent=2, ensure_ascii=False) + "\n"` and nfx-proto's `render` produce
 * for this structure. Only the root hash makes the bytes authoritative, not this layout.
 */
export function renderHashList(list: HashList): Uint8Array {
  const q = (s: string): string => JSON.stringify(s);
  const files = list.files.map((f) => {
    const members = [
      `"name": ${q(f.name)}`,
      `"role": ${q(f.role)}`,
      `"sha256": ${q(f.sha256)}`,
      `"size": ${f.size.toString()}`,
    ];
    if (f.durMs !== undefined) members.push(`"dur_ms": ${f.durMs.toString()}`);
    return pretty('{', members, '}', 4);
  });
  const renditions = list.renditions.map((r) => {
    const members = [
      `"id": ${q(r.id)}`,
      `"playlist": ${q(r.playlist)}`,
      `"bandwidth": ${r.bandwidth.toString()}`,
    ];
    if (r.codecs !== undefined) members.push(`"codecs": ${q(r.codecs)}`);
    if (r.resolution !== undefined) members.push(`"resolution": ${q(r.resolution)}`);
    return pretty('{', members, '}', 4);
  });
  const top = [
    '"v": 1',
    `"video": ${q(list.video)}`,
    `"files": ${pretty('[', files, ']', 2)}`,
    `"renditions": ${pretty('[', renditions, ']', 2)}`,
  ];
  return utf8(`${pretty('{', top, '}', 0)}\n`);
}

/** Resolve a content name (`<sha256-hex>.<ext>`, NFX-05 §3) to its file entry. */
export function resolveContentName(list: HashList, contentName: string): FileEntry | undefined {
  const hash = contentHash(contentName);
  return hash === undefined ? undefined : list.files.find((f) => f.sha256 === hash);
}

/**
 * The rendition whose playlist has this content name (`<sha256>.m3u8`): how a stream maps to
 * its rendition (NFX-10 §2). `undefined` for anything else.
 */
export function renditionForPlaylist(list: HashList, contentName: string): Rendition | undefined {
  const hash = contentHash(contentName);
  if (hash === undefined) return undefined;
  const file = list.files.find((f) => f.role === 'playlist' && f.sha256 === hash);
  return file === undefined ? undefined : list.renditions.find((r) => r.playlist === file.name);
}

/**
 * NFX-05 §3: every URI in a playlist is a content name listed in `files`. On a tag line every
 * `URI` attribute counts, and a tag with more than one is invalid (players disagree on which
 * duplicate wins).
 */
export function checkPlaylist(list: HashList, bytes: Uint8Array): NfxResult<void> {
  const text = decodeUtf8(bytes);
  if (text === undefined) return fail('playlist', 'not UTF-8');
  const listed = new Set(list.files.map((f) => f.sha256));
  const resolves = (uri: string): boolean => {
    const hash = contentHash(uri);
    return hash !== undefined && listed.has(hash);
  };
  for (const line of lines(text)) {
    let uris: string[];
    if (line.startsWith('#')) {
      const found = tagUris(line);
      if (!found.ok) return found;
      uris = found.value;
    } else if (rustTrim(line) === '') {
      continue;
    } else {
      uris = [line];
    }
    if (uris.length > 1) return fail('playlist', 'a tag carries more than one URI attribute');
    const unresolved = uris.find((u) => !resolves(u));
    if (unresolved !== undefined) {
      return fail('playlist', `URI ${JSON.stringify(unresolved)} is not a listed content name`);
    }
  }
  return ok(undefined);
}

/** The Blossom rule (NFX-05 §4): `sha256(bytes) == expected`, checked before use or storage. */
export function verifyFile(expectedSha256: string, bytes: Uint8Array): NfxResult<void> {
  if (!isLowerHex(expectedSha256, 64)) return bad('expected sha256 is not 64 lowercase hex');
  return sha256Hex(bytes) === expectedSha256
    ? ok(undefined)
    : bad('file bytes do not match their sha256');
}

/** `<64 lowercase hex>.<non-empty ext>` → the hex, split at the first dot as nfx-proto does. */
function contentHash(contentName: string): string | undefined {
  const dot = contentName.indexOf('.');
  if (dot < 0 || dot === contentName.length - 1) return undefined;
  const hash = contentName.slice(0, dot);
  return isLowerHex(hash, 64) ? hash : undefined;
}

function check(list: HashList, video: VideoAddr, segs: bigint): string | undefined {
  if (list.video !== video.toString()) return "`video` does not equal the manifest's address";
  if (list.files.length === 0) return '`files` is empty';
  if (BigInt(list.files.length) !== segs) return 'manifest `segs` does not equal len(files)';
  const names = new Set<string>();
  for (const f of list.files) {
    if (f.name === '') return 'file with an empty name';
    // NFX-05 §2: a name is a position (licensed mode binds ciphertext to it).
    if (names.has(f.name)) return 'file names must be unique';
    names.add(f.name);
    if (!isLowerHex(f.sha256, 64)) return 'file sha256 is not 64 lowercase hex';
    if (f.durMs === 0n) return '`dur_ms` must be >= 1';
  }
  if (list.renditions.length === 0) return '`renditions` is empty';
  const ids = new Set<string>();
  const playlistNames = new Set<string>();
  const playlistHashes = new Set<string>();
  for (const r of list.renditions) {
    if (r.id === '' || r.id === RESERVED_RENDITION_ID || ids.has(r.id)) {
      return 'rendition ids must be unique, non-empty and not `meta`';
    }
    ids.add(r.id);
    const playlist = list.files.find((f) => f.role === 'playlist' && f.name === r.playlist);
    if (playlist === undefined) return 'rendition `playlist` does not name a playlist file';
    // NFX-05 §2: a playlist's content name identifies its rendition (NFX-10 §2).
    if (playlistNames.has(r.playlist) || playlistHashes.has(playlist.sha256)) {
      return 'renditions must name distinct playlists';
    }
    playlistNames.add(r.playlist);
    playlistHashes.add(playlist.sha256);
    if (r.bandwidth === 0n) return '`bandwidth` must be >= 1';
    if (r.resolution !== undefined && !/^[0-9]+x[0-9]+$/.test(r.resolution)) {
      return '`resolution` must be <w>x<h>';
    }
  }
  return undefined;
}

/**
 * The hash list's fields, read as nfx-proto's serde structs read them: unknown fields are
 * ignored, a known field given twice is an error, an optional field may be absent or `null`.
 */
function decodeHashList(value: JsonValue): NfxResult<HashList> {
  const obj = struct(value, 'hash list', ['v', 'video', 'files', 'renditions']);
  if (!obj.ok) return obj;
  const v = u64(obj.value, 'v');
  if (!v.ok) return v;
  if (v.value !== 1n) return bad('`v` must be 1');
  const video = str(obj.value, 'video');
  if (!video.ok) return video;
  const rawFiles = obj.value.get('files');
  if (!isJsonArray(rawFiles)) return bad('missing or invalid `files`');
  const files: FileEntry[] = [];
  for (const raw of rawFiles) {
    const f = decodeFile(raw);
    if (!f.ok) return f;
    files.push(f.value);
  }
  const rawRenditions = obj.value.get('renditions');
  if (!isJsonArray(rawRenditions)) return bad('missing or invalid `renditions`');
  const renditions: Rendition[] = [];
  for (const raw of rawRenditions) {
    const r = decodeRendition(raw);
    if (!r.ok) return r;
    renditions.push(r.value);
  }
  return ok<HashList>({ v: 1, video: video.value, files, renditions });
}

function decodeFile(value: JsonValue): NfxResult<FileEntry> {
  const obj = struct(value, 'file', ['name', 'role', 'sha256', 'size', 'dur_ms']);
  if (!obj.ok) return obj;
  const name = str(obj.value, 'name');
  if (!name.ok) return name;
  const role = obj.value.get('role');
  if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) {
    return bad('`role` is not one of the six roles');
  }
  const sha256 = str(obj.value, 'sha256');
  if (!sha256.ok) return sha256;
  const size = u64(obj.value, 'size');
  if (!size.ok) return size;
  const durMs = optional(obj.value, 'dur_ms', u64);
  if (!durMs.ok) return durMs;
  return ok({
    name: name.value,
    role: role as Role,
    sha256: sha256.value,
    size: size.value,
    durMs: durMs.value,
  });
}

function decodeRendition(value: JsonValue): NfxResult<Rendition> {
  const obj = struct(value, 'rendition', ['id', 'playlist', 'bandwidth', 'codecs', 'resolution']);
  if (!obj.ok) return obj;
  const id = str(obj.value, 'id');
  if (!id.ok) return id;
  const playlist = str(obj.value, 'playlist');
  if (!playlist.ok) return playlist;
  const bandwidth = u64(obj.value, 'bandwidth');
  if (!bandwidth.ok) return bandwidth;
  const codecs = optional(obj.value, 'codecs', str);
  if (!codecs.ok) return codecs;
  const resolution = optional(obj.value, 'resolution', str);
  if (!resolution.ok) return resolution;
  return ok({
    id: id.value,
    playlist: playlist.value,
    bandwidth: bandwidth.value,
    codecs: codecs.value,
    resolution: resolution.value,
  });
}

function struct(value: JsonValue, what: string, fields: readonly string[]): NfxResult<JsonObject> {
  if (!(value instanceof JsonObject)) return bad(`${what} is not an object`);
  const { duplicates } = value;
  const repeated = fields.find((f) => duplicates.has(f));
  if (repeated !== undefined) return bad(`duplicate field \`${repeated}\` in ${what}`);
  return ok(value);
}

function str(obj: JsonObject, name: string): NfxResult<string> {
  const value = obj.get(name);
  return typeof value === 'string' ? ok(value) : bad(`missing or invalid \`${name}\``);
}

function u64(obj: JsonObject, name: string): NfxResult<bigint> {
  const value = obj.get(name);
  return value instanceof JsonNumber && value.int !== undefined && value.int >= 0n
    ? ok(value.int)
    : bad(`missing or invalid \`${name}\``);
}

/** An `Option` field: absent or `null` is `undefined`, anything else must parse. */
function optional<T>(
  obj: JsonObject,
  name: string,
  read: (obj: JsonObject, name: string) => NfxResult<T>,
): NfxResult<T | undefined> {
  const value = obj.get(name);
  return value === undefined || value === null ? ok(undefined) : read(obj, name);
}

/** Rust's `str::lines` then `trim_end_matches('\r')`: split on `\n`, no final empty line. */
function lines(text: string): string[] {
  const out = text.split('\n');
  if (out[out.length - 1] === '') out.pop();
  return out.map((line) => line.replace(/\r+$/, ''));
}

function pretty(open: string, items: readonly string[], close: string, indent: number): string {
  if (items.length === 0) return `${open}${close}`;
  const inner = ' '.repeat(indent + 2);
  return `${open}\n${items.map((i) => inner + i).join(',\n')}\n${' '.repeat(indent)}${close}`;
}

/**
 * The values of every `URI` attribute on an HLS tag line. Lines that mention no `URI=` have
 * none; lines that do must be a well-formed attribute list (`NAME=value`, quoted or not,
 * comma-separated), or they are refused rather than guessed at.
 */
function tagUris(line: string): NfxResult<string[]> {
  if (!line.includes('URI=')) return ok([]);
  const malformed = fail('playlist', `malformed attribute list: ${JSON.stringify(line)}`);
  const colon = line.indexOf(':');
  if (colon < 0) return malformed;
  let rest = line.slice(colon + 1);
  const uris: string[] = [];
  while (rest !== '') {
    const eq = rest.indexOf('=');
    if (eq < 0) return malformed;
    const name = rustTrim(rest.slice(0, eq));
    if (!/^[A-Z0-9-]+$/.test(name)) return malformed;
    const after = rest.slice(eq + 1);
    let value: string;
    let next: string;
    if (after.startsWith('"')) {
      const end = after.indexOf('"', 1);
      if (end < 0) return malformed;
      value = after.slice(1, end);
      next = after.slice(end + 1);
    } else {
      const comma = after.indexOf(',');
      value = comma < 0 ? after : after.slice(0, comma);
      next = comma < 0 ? '' : after.slice(comma);
    }
    if (name === 'URI') uris.push(value);
    if (next.startsWith(',')) rest = next.slice(1);
    else if (rustTrim(next) === '') rest = '';
    else return malformed;
  }
  return ok(uris);
}
