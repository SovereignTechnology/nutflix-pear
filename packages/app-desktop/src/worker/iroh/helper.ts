/**
 * The iroh helper's supervisor and client (ADR 0021; protocol: `crates/iroh-helper/README.md`).
 * A long-lived child, unlike the transcode path's one-shot `ProcessRunner`: spawned once,
 * restarted with backoff when it exits, killed when it breaks the protocol.
 *
 * The helper is an untrusted pipe (nfx ADR 0103, sharp edges 1–3). So:
 * - every reply is validated before it is believed, and a reply or data frame for a request that
 *   is not waiting, a `get` that sends more than the `max` it was asked for, or a malformed frame
 *   kills the helper;
 * - what this side buffers is bounded: one partial frame, at most `maxInflight` requests, and the
 *   `max` of the `get`s in flight together at most `maxGetBytesInflight`;
 * - nothing the helper says means "verified". There is no way to get a file's bytes without
 *   naming the sha256 they must have (`getFile`, checked here through sodium, NFX-05 §4): bytes
 *   that do not match are a `PoisonedError`, never returned. A collection's member list
 *   (`getSeq`) is BLAKE3 hashes, good only for asking for those members;
 * - a dial goes through `dialTarget` (a ticket naming another node is ignored, a relay the network
 *   does not run is dropped; the helper drops it again);
 * - the iroh secret, if any, is held in a private field and only ever sent in `init`.
 *
 * A helper started with `init: { rtc }` runs only its WebRTC side (ADR 0023): `rtc-init` is its
 * handshake, no iroh endpoint is made, and its `rtc*` requests follow the same rules (a segment's
 * bytes come back only under the sha256 the hash list names, `rtcGetFile`).
 *
 * Slice 5e-3 wires it: the worker's one helper is `../nfx/iroh.ts`'s. `spawn` is injected, as
 * `bare-process-runner.ts`'s is: `bare-subprocess` under Bare (`WorkerRuntime.spawnHelper`),
 * `node:child_process` in tests.
 */
import { nfx } from '@sovit/core';

import { toHex } from '../../ipc/codec.js';
import { HelperFrameDecoder, encodeCtl } from './frames.js';
import type { HelperFrame } from './frames.js';

export interface HelperReadable {
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
}

export interface HelperWritable {
  write(chunk: Uint8Array): unknown;
  end(): unknown;
}

/** The slice of a child process this module uses (`bare-subprocess` and Node both have it). */
export interface HelperChild {
  readonly stdin?: HelperWritable | null;
  readonly stdout: HelperReadable | null;
  readonly stderr: HelperReadable | null;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  /** Only ever `SIGKILL` from here (named, so Node's `ChildProcess` fits as it is). */
  kill(signal?: 'SIGKILL' | 'SIGTERM'): unknown;
}

/** Spawns the helper with piped stdio. May throw synchronously (S-C finding 9: Bare's ENOENT). */
export type HelperSpawn = (file: string, args: readonly string[]) => HelperChild;

export interface HelperInit {
  /** The network's iroh relays (NFX-06 §1): the only ones the helper will use. */
  readonly relays: readonly string[];
  /** The iroh secret key, 64 lowercase hex. Without it the node id changes at every (re)start. */
  readonly secret?: string;
  readonly relayOnly?: boolean;
  /** Ask the local gateway (UPnP, PCP, NAT-PMP) for a port. Off unless the node seeds and asks. */
  readonly portmapper?: boolean;
  /**
   * Extra CA certificates (DER, lowercase hex; at most 4) for the relays' TLS, added to iroh's
   * embedded roots: a network whose relays use a private CA. iroh never uses them for its own
   * connections, which its keys authenticate. From local network settings only, never from
   * anything a peer or a beacon says.
   */
  readonly relayCas?: readonly string[];
}

/**
 * The start of a helper that runs only its WebRTC side (ADR 0023): `rtc-init` is its handshake,
 * sent at every (re)start as `init` is for an iroh node, and no iroh endpoint is made.
 */
export interface HelperRtcInit {
  /** STUN servers, `host:port`, at most 4: browsers are shown the mapping they report. */
  readonly stun: readonly string[];
  /** Absolute: every file `rtc-serve` names must lie under it (the NFX store). */
  readonly root: string;
  /** `ip:port` to bind; default the address the route to the first STUN server leaves from. */
  readonly bind?: string;
  /** Private and loopback addresses count as reachable: tests and same-LAN runs only. */
  readonly allowPrivate?: boolean;
}

/** Where the WebRTC side's socket is, and the public mapping STUN reported (if any). */
export interface HelperRtcReach {
  readonly local: string;
  readonly mapped: string | null;
}

/** One segment the WebRTC side serves: its #EXTINF index, the file holding it, its size. */
export interface HelperRtcSegment {
  readonly id: number;
  readonly path: string;
  readonly size: number;
}

/** A new connection: its id, and the SDP to send to the other side. */
export interface HelperRtcSdp {
  readonly peer: number;
  readonly sdp: string;
}

/** Inclusive ranges of segment ids. */
export type HelperRtcRanges = readonly (readonly [number, number])[];

/** What the WebRTC side reports (`rtc-poll`). Untrusted until parsed here. */
export type HelperRtcEvent =
  | {
      readonly t: 'open';
      readonly peer: number;
      readonly swarm: string;
      readonly dir: 'in' | 'out';
    }
  | {
      readonly t: 'have';
      readonly peer: number;
      readonly ranges: HelperRtcRanges;
      readonly more: boolean;
    }
  | { readonly t: 'closed'; readonly peer: number; readonly why: string };

export interface HelperRtcPeer {
  readonly peer: number;
  readonly swarm: string;
  readonly dir: 'in' | 'out';
  readonly open: boolean;
}

/** Where the helper's node can be reached, as a beacon's iroh endpoint carries it. */
export interface HelperReach {
  readonly node: string;
  readonly relay: string;
  readonly addrs: readonly string[];
}

/** A ticket, decoded by the helper. Untrusted: it is whatever a beacon said. */
export interface HelperTicket {
  readonly node: string;
  readonly hash: string;
  readonly format: 'raw' | 'hash_seq' | 'other';
  readonly relays: readonly string[];
  readonly addrs: readonly string[];
}

declare const checked: unique symbol;

/** Where to dial: only `dialTarget` makes one, so no dial skips its checks. */
export interface HelperDialTarget {
  readonly node: string;
  readonly relays: readonly string[];
  readonly addrs: readonly string[];
  readonly [checked]: true;
}

export interface HelperStats {
  readonly rssHwmKib: number | null;
  readonly storeBytes: number;
}

export class HelperError extends Error {
  override readonly name = 'HelperError' as const;
  /**
   * The helper's own code (`bad-request`, `dial-failed`, `too-large`, …) or this side's:
   * `not-ready` (not started, or restarting), `busy`, `timeout`, `gone` (it exited),
   * `violation` (it broke the protocol and was killed), `closed`.
   */
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/**
 * A peer sent what the signed hash list says it must not be: a file whose sha256 differs, or a
 * collection that is not one. Drop that source (NFX-06 §2); the bytes were never returned.
 */
export class PoisonedError extends Error {
  override readonly name = 'PoisonedError' as const;
  constructor(readonly what: string) {
    super(`poisoned: ${what}`);
  }
}

export type HelperEvent =
  | { readonly type: 'stderr'; readonly line: string }
  | { readonly type: 'exit'; readonly code: number | null; readonly signal: string | null }
  | { readonly type: 'violation'; readonly reason: string }
  /** `reach` is `null` for a helper that runs only its WebRTC side. */
  | { readonly type: 'restarted'; readonly attempt: number; readonly reach: HelperReach | null }
  | { readonly type: 'restart-failed'; readonly attempt: number; readonly error: string };

export interface IrohHelperOptions {
  readonly spawn: HelperSpawn;
  /** The helper executable (its `prebuilds/` package in a packaged build: never `chmod`ed). */
  readonly file: string;
  /** Absolute; the helper keeps its iroh-blobs store under it. */
  readonly stateDir: string;
  /** An iroh node's `init`, or `{ rtc }`: a helper that runs only its WebRTC side (`startRtc`). */
  readonly init: HelperInit | { readonly rtc: HelperRtcInit };
  /** Requests waiting for a reply at once; one more is refused `busy`. Default 8. */
  readonly maxInflight?: number;
  /** The `max` of every `get` in flight, together. Default 128 MiB. */
  readonly maxGetBytesInflight?: number;
  /** Reply deadline per request. Default 60 s (a `get` may take a 15 s dial plus 30 s). */
  readonly timeoutMs?: number;
  /** Restart backoff, doubling from `minMs` to `maxMs`; `false` never restarts. */
  readonly restart?: { readonly minMs: number; readonly maxMs: number } | false;
  readonly onEvent?: (event: HelperEvent) => void;
}

/** The largest `get` the helper serves (`MAX_GET_BYTES` there). */
export const MAX_GET_BYTES = 64 * 1024 * 1024;
/** Timed-out requests whose late replies are still expected; past this the helper is killed. */
const MAX_ABANDONED = 64;
/** A run that lived this long resets the restart backoff. */
const HEALTHY_MS = 30_000;
const CLOSE_GRACE_MS = 5_000;
const MAX_STDERR_LINE = 512;
const MAX_LIST = 64;
/** The helper's own bounds (crates/iroh-helper/README.md, "WebRTC with browsers"). */
const MAX_RTC_EVENTS = 256;
const MAX_RTC_RANGES = 512;
const MAX_RTC_PEERS = 32;
const MAX_SDP = 32 * 1024;
const MAX_SEGMENT_ID = Number.MAX_SAFE_INTEGER;
const SWARM = /^[\x21-\x7e]{1,256}$/;

type Timer = ReturnType<typeof setTimeout>;

interface Pending {
  readonly resolve: (value: Readonly<Record<string, unknown>>) => void;
  readonly reject: (err: HelperError) => void;
  readonly timer: Timer;
  /** For a `get`: the cap, and the bytes received so far. */
  readonly get: { readonly max: number; readonly chunks: Uint8Array[]; got: number } | null;
}

interface Run {
  readonly child: HelperChild;
  readonly decoder: HelperFrameDecoder;
  readonly startedAt: number;
  /** Set when this side killed the child, so the exit is reported as that. */
  killedFor: 'violation' | 'close' | 'init' | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
/** The shortest restart backoff: a helper that dies at once must not spin. */
const MIN_RESTART_MS = 50;

function positive(v: number | undefined, fallback: number, what: string): number {
  const n = v ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`${what} must be a positive integer`);
  return n;
}

function str(v: unknown, what: string, max = 2048): string {
  if (typeof v !== 'string' || v.length > max) throw new TypeError(`${what} is not a string`);
  return v;
}

function hex64(v: unknown, what: string): string {
  const s = str(v, what, 64);
  if (!HEX64.test(s)) throw new TypeError(`${what} is not 64 lowercase hex`);
  return s;
}

function uint(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    throw new TypeError(`${what} is not a non-negative integer`);
  return v;
}

function strs(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.length > MAX_LIST) throw new TypeError(`${what} is not a list`);
  return v.map((s, i) => str(s, `${what}[${String(i)}]`));
}

function reachOf(m: Readonly<Record<string, unknown>>): HelperReach {
  return {
    node: hex64(m['node'], 'node'),
    relay: str(m['relay'], 'relay'),
    addrs: strs(m['addrs'], 'addrs'),
  };
}

function rtcReachOf(m: Readonly<Record<string, unknown>>): HelperRtcReach {
  const mapped = m['mapped'];
  return {
    local: str(m['local'], 'local', 64),
    mapped: mapped === null || mapped === undefined ? null : str(mapped, 'mapped', 64),
  };
}

function swarmOf(v: unknown): string {
  const s = str(v, 'swarm', 256);
  if (!SWARM.test(s)) throw new TypeError('swarm is not 1-256 printable ASCII');
  return s;
}

function dirOf(v: unknown): 'in' | 'out' {
  if (v !== 'in' && v !== 'out') throw new TypeError('dir is not in or out');
  return v;
}

function rangesOf(v: unknown): HelperRtcRanges {
  if (!Array.isArray(v) || v.length > MAX_RTC_RANGES) throw new TypeError('ranges is not a list');
  return v.map((r, i) => {
    if (!Array.isArray(r) || r.length !== 2) throw new TypeError(`ranges[${String(i)}]`);
    const a = uint(r[0], 'range start');
    const b = uint(r[1], 'range end');
    if (a > b || b > MAX_SEGMENT_ID) throw new TypeError(`ranges[${String(i)}] is not a range`);
    return [a, b] as const;
  });
}

function rtcEventOf(v: unknown): HelperRtcEvent {
  if (typeof v !== 'object' || v === null) throw new TypeError('an event is not an object');
  const e = v as Readonly<Record<string, unknown>>;
  const peer = uint(e['peer'], 'peer');
  switch (e['t']) {
    case 'open':
      return { t: 'open', peer, swarm: swarmOf(e['swarm']), dir: dirOf(e['dir']) };
    case 'have':
      return { t: 'have', peer, ranges: rangesOf(e['ranges']), more: e['more'] === true };
    case 'closed':
      return { t: 'closed', peer, why: str(e['why'], 'why', 64) };
    default:
      throw new TypeError('an event of no known kind');
  }
}

function concat(chunks: readonly Uint8Array[], n: number): Uint8Array {
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Where to dial for a ticket from a beacon's iroh endpoint `endpointNode`, or `null` when the
 * ticket must be ignored (NFX-06 §2): it names another node, or is not a collection. Only the
 * ticket's direct addresses and the relays of this network survive; a relay the ticket names
 * that the network does not run is dropped, never dialled.
 */
export function dialTarget(
  ticket: HelperTicket,
  endpointNode: string,
  networkRelays: readonly string[],
): HelperDialTarget | null {
  if (ticket.node !== endpointNode || ticket.format !== 'hash_seq') return null;
  return {
    node: ticket.node,
    relays: ticket.relays.filter((r) => networkRelays.includes(r)),
    addrs: [...ticket.addrs],
  } as unknown as HelperDialTarget;
}

interface Launched {
  readonly reach: HelperReach | null;
  readonly rtc: HelperRtcReach | null;
}

export class IrohHelper {
  private readonly o: IrohHelperOptions;
  /** Never in `o`, never logged, never serialised: only the `init` frame carries it. */
  readonly #secret: string | undefined;
  /** Set for a helper that runs only its WebRTC side. */
  private readonly rtcInit: HelperRtcInit | null;
  private readonly maxInflight: number;
  private readonly maxGetBytes: number;
  private readonly timeoutMs: number;
  private run: Run | null = null;
  private ready = false;
  private closing = false;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  /** Timed-out requests: a late reply is dropped; a late `get` may still send `remaining` bytes. */
  private readonly abandoned = new Map<number, { remaining: number }>();
  private getBytesInflight = 0;
  private attempt = 0;
  private backoffMs: number;
  private restartTimer: Timer | null = null;
  private stderrRest = '';
  private exited: (() => void) | null = null;
  private lastReach: HelperReach | null = null;
  /** The first `start` succeeded: from then on an exit is followed by a restart. */
  private started = false;
  /** How many times the helper was restarted after an exit. */
  restarts = 0;

  constructor(options: IrohHelperOptions) {
    if ('rtc' in options.init) {
      const rtc = options.init.rtc;
      if (rtc.stun.length > 4 || rtc.stun.some((s) => s.length < 3 || s.length > 300))
        throw new RangeError('init.rtc.stun must be at most 4 host:port');
      if (rtc.root.length < 1 || rtc.root.length > 4096)
        throw new RangeError('init.rtc.root must be a path');
      this.#secret = undefined;
      this.rtcInit = { ...rtc, stun: [...rtc.stun] };
      this.o = options;
    } else {
      const { secret, ...init } = options.init;
      // The message never repeats the value.
      if (secret !== undefined && !HEX64.test(secret))
        throw new RangeError('init.secret must be 64 lowercase hex');
      this.#secret = secret;
      this.rtcInit = null;
      const cas = init.relayCas ?? [];
      if (cas.length > 4 || cas.some((c) => !/^(?:[0-9a-f]{2}){1,8192}$/.test(c)))
        throw new RangeError('init.relayCas must be at most 4 DER certificates in lowercase hex');
      this.o = { ...options, init };
    }
    this.maxInflight = positive(options.maxInflight, 8, 'maxInflight');
    this.maxGetBytes = positive(
      options.maxGetBytesInflight,
      128 * 1024 * 1024,
      'maxGetBytesInflight',
    );
    this.timeoutMs = positive(options.timeoutMs, 60_000, 'timeoutMs');
    const restart = options.restart;
    if (
      restart !== undefined &&
      restart !== false &&
      (!Number.isSafeInteger(restart.minMs) ||
        restart.minMs < MIN_RESTART_MS ||
        !Number.isSafeInteger(restart.maxMs) ||
        restart.maxMs < restart.minMs)
    )
      throw new RangeError(`restart needs ${String(MIN_RESTART_MS)} <= minMs <= maxMs`);
    this.backoffMs = restart === false ? 0 : (restart?.minMs ?? 250);
  }

  /** The reach of the running helper, as its last `init` or `addr` reported it. */
  get reach(): HelperReach | null {
    return this.lastReach;
  }

  get running(): boolean {
    return this.ready;
  }

  /** Spawn and `init`. Rejects if either fails; then nothing is restarted. */
  async start(): Promise<HelperReach> {
    if (this.rtcInit !== null)
      throw new HelperError('bad-request', 'a WebRTC-only helper starts with startRtc');
    if (this.run !== null || this.closing) throw new HelperError('bad-request', 'already started');
    const { reach } = await this.launch();
    this.started = true;
    if (reach === null) throw new HelperError('violation', 'no reach');
    return reach;
  }

  /**
   * Spawn a helper that runs only its WebRTC side, with `rtc-init` (sent again at every restart).
   * Rejects if either fails; then nothing is restarted.
   */
  async startRtc(): Promise<HelperRtcReach> {
    if (this.rtcInit === null)
      throw new HelperError('bad-request', 'an iroh helper starts with start');
    if (this.run !== null || this.closing) throw new HelperError('bad-request', 'already started');
    const { rtc } = await this.launch();
    this.started = true;
    if (rtc === null) throw new HelperError('violation', 'no WebRTC reach');
    return rtc;
  }

  async addr(): Promise<HelperReach> {
    const m = await this.request({ op: 'addr' });
    const reach = this.believe(() => reachOf(m));
    this.lastReach = reach;
    return reach;
  }

  async import(path: string): Promise<{ readonly hash: string; readonly size: number }> {
    const m = await this.request({ op: 'import', path });
    return this.believe(() => ({ hash: hex64(m['hash'], 'hash'), size: uint(m['size'], 'size') }));
  }

  async seq(
    members: readonly string[],
    tag: string,
  ): Promise<{ readonly hash: string; readonly ticket: string }> {
    const m = await this.request({ op: 'seq', members: [...members], tag });
    return this.believe(() => ({
      hash: hex64(m['hash'], 'hash'),
      ticket: str(m['ticket'], 'ticket', 4096),
    }));
  }

  async untag(tag: string): Promise<number> {
    const m = await this.request({ op: 'untag', tag });
    return this.believe(() => uint(m['deleted'], 'deleted'));
  }

  async ticket(ticket: string): Promise<HelperTicket> {
    const m = await this.request({ op: 'ticket', ticket });
    const format = m['format'];
    return this.believe(() => ({
      node: hex64(m['node'], 'node'),
      hash: hex64(m['hash'], 'hash'),
      format: format === 'raw' || format === 'hash_seq' ? format : 'other',
      relays: strs(m['relays'], 'relays'),
      addrs: strs(m['addrs'], 'addrs'),
    }));
  }

  /**
   * Decode `ticket` (from a beacon's iroh endpoint `endpointNode`) and dial it through
   * `dialTarget`: `null` when the ticket must be ignored. `hash` is the collection to `getSeq`.
   */
  async dialTicket(
    ticket: string,
    endpointNode: string,
    networkRelays: readonly string[],
  ): Promise<{ readonly conn: number; readonly hash: string } | null> {
    const t = await this.ticket(ticket);
    const target = dialTarget(t, endpointNode, networkRelays);
    if (target === null) return null;
    return { conn: await this.dial(target), hash: t.hash };
  }

  async dial(target: HelperDialTarget): Promise<number> {
    const m = await this.request({
      op: 'dial',
      node: target.node,
      relays: [...target.relays],
      addrs: [...target.addrs],
    });
    return this.believe(() => uint(m['conn'], 'conn'));
  }

  /**
   * The member hashes (BLAKE3) of collection `hash`, fetched alone and capped at `maxMembers`
   * (NFX-06 §2); with `exact`, the count must be `maxMembers`. They are the peer's say-so: good
   * only for asking for each member with `getFile`, whose sha256 the hash list gives.
   */
  async getSeq(
    conn: number,
    hash: string,
    opts: { readonly maxMembers: number; readonly exact?: boolean },
  ): Promise<string[]> {
    const n = opts.maxMembers;
    if (!Number.isSafeInteger(n) || n < 1 || n * 32 > MAX_GET_BYTES)
      throw new HelperError('bad-request', 'maxMembers is out of range');
    const bytes = await this.getRaw(conn, hash, n * 32);
    if (bytes.length === 0 || bytes.length % 32 !== 0)
      throw new PoisonedError('a collection that is not a HashSeq');
    const members: string[] = [];
    for (let i = 0; i < bytes.length; i += 32) members.push(toHex(bytes.subarray(i, i + 32)));
    if (opts.exact === true && members.length !== n)
      throw new PoisonedError(
        `a collection of ${String(members.length)} members, not ${String(n)}`,
      );
    return members;
  }

  /**
   * The bytes of blob `hash` over `conn` — at most `maxBytes`, and only if their sha256 is
   * `sha256` (the hash list's entry, NFX-05 §4). Anything else is a `PoisonedError`.
   */
  async getFile(
    conn: number,
    hash: string,
    expect: { readonly sha256: string; readonly maxBytes: number },
  ): Promise<Uint8Array> {
    if (!HEX64.test(expect.sha256))
      throw new HelperError('bad-request', 'sha256 must be 64 lowercase hex');
    const bytes = await this.getRaw(conn, hash, expect.maxBytes);
    if (!nfx.verifyFile(expect.sha256, bytes).ok)
      throw new PoisonedError(`a file whose sha256 is not ${expect.sha256.slice(0, 16)}…`);
    return bytes;
  }

  /** At most `max` bytes of a blob, unchecked: private, so no caller can skip `getFile`. */
  private getRaw(conn: number, hash: string, max: number): Promise<Uint8Array> {
    return this.getBytes({ op: 'get', conn, hash }, max);
  }

  /** A `get`-shaped request's bytes (at most `max`), unchecked: private, as `getRaw`. */
  private async getBytes(msg: Readonly<Record<string, unknown>>, max: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(max) || max < 1 || max > MAX_GET_BYTES)
      throw new HelperError('bad-request', 'max must be 1 to 64 MiB');
    if (this.getBytesInflight + max > this.maxGetBytes)
      throw new HelperError('busy', 'too many bytes in flight');
    this.getBytesInflight += max;
    try {
      const m = await this.request({ ...msg, max }, max);
      const bytes = m['bytes'];
      if (!(bytes instanceof Uint8Array)) throw new HelperError('violation', 'no bytes');
      return bytes;
    } finally {
      this.getBytesInflight -= max;
    }
  }

  async hangup(conn: number): Promise<boolean> {
    return (await this.request({ op: 'hangup', conn }))['closed'] === true;
  }

  async stats(): Promise<HelperStats> {
    const m = await this.request({ op: 'stats' });
    const rss = m['rss_hwm_kib'];
    return this.believe(() => ({
      rssHwmKib: rss === null ? null : uint(rss, 'rss_hwm_kib'),
      storeBytes: uint(m['store_bytes'], 'store_bytes'),
    }));
  }

  // ---- The WebRTC side (ADR 0023; crates/iroh-helper/README.md, "WebRTC with browsers") ----

  /** Serve `segments` of `swarm`, replacing what it served unless `append`; how many it serves now. */
  async rtcServe(
    swarm: string,
    segments: readonly HelperRtcSegment[],
    append = false,
  ): Promise<number> {
    const m = await this.request({
      op: 'rtc-serve',
      swarm,
      segments: segments.map((s) => ({ id: s.id, path: s.path, size: s.size })),
      append,
    });
    return this.believe(() => uint(m['segments'], 'segments'));
  }

  async rtcUnserve(swarm: string): Promise<boolean> {
    return (await this.request({ op: 'rtc-unserve', swarm }))['removed'] === true;
  }

  /** Answer a remote offer for `swarm`: the other side asked to connect. */
  async rtcAnswer(swarm: string, offer: string): Promise<HelperRtcSdp> {
    const m = await this.request({ op: 'rtc-answer', swarm, offer });
    return this.believe(() => ({
      peer: uint(m['peer'], 'peer'),
      sdp: str(m['sdp'], 'sdp', MAX_SDP),
    }));
  }

  /** An offer to a peer in `swarm`, completed by `rtcAccept`. */
  async rtcOffer(swarm: string): Promise<HelperRtcSdp> {
    const m = await this.request({ op: 'rtc-offer', swarm });
    return this.believe(() => ({
      peer: uint(m['peer'], 'peer'),
      sdp: str(m['sdp'], 'sdp', MAX_SDP),
    }));
  }

  async rtcAccept(peer: number, answer: string): Promise<void> {
    await this.request({ op: 'rtc-accept', peer, answer });
  }

  /**
   * Segment `segment` from `peer` — at most `maxBytes`, and only if their sha256 is `sha256` (the
   * hash list's entry, NFX-05 §4). Anything else is a `PoisonedError`, as `getFile`'s.
   */
  async rtcGetFile(
    peer: number,
    segment: number,
    expect: { readonly sha256: string; readonly maxBytes: number },
  ): Promise<Uint8Array> {
    if (!HEX64.test(expect.sha256))
      throw new HelperError('bad-request', 'sha256 must be 64 lowercase hex');
    const bytes = await this.getBytes({ op: 'rtc-get', peer, segment }, expect.maxBytes);
    if (!nfx.verifyFile(expect.sha256, bytes).ok)
      throw new PoisonedError(`a segment whose sha256 is not ${expect.sha256.slice(0, 16)}…`);
    return bytes;
  }

  /** The WebRTC side's events, waiting up to `waitMs` (at most 30 s) for the first. */
  async rtcPoll(
    waitMs: number,
  ): Promise<{ readonly events: readonly HelperRtcEvent[]; readonly lost: boolean }> {
    const wait = Math.min(Math.max(0, Math.floor(waitMs)), 30_000);
    const m = await this.request({ op: 'rtc-poll', wait_ms: wait });
    return this.believe(() => {
      const events = m['events'];
      if (!Array.isArray(events) || events.length > MAX_RTC_EVENTS)
        throw new TypeError('events is not a list');
      return { events: events.map(rtcEventOf), lost: m['lost'] === true };
    });
  }

  /** What `peer` last announced it holds. */
  async rtcHave(
    peer: number,
  ): Promise<{ readonly ranges: HelperRtcRanges; readonly more: boolean }> {
    const m = await this.request({ op: 'rtc-have', peer });
    return this.believe(() => ({ ranges: rangesOf(m['ranges']), more: m['more'] === true }));
  }

  async rtcHangup(peer: number): Promise<boolean> {
    return (await this.request({ op: 'rtc-hangup', peer }))['closed'] === true;
  }

  /** The live connections (to resync after `lost`). */
  async rtcStatus(): Promise<readonly HelperRtcPeer[]> {
    const m = await this.request({ op: 'rtc-status' });
    return this.believe(() => {
      const peers = m['peers'];
      if (!Array.isArray(peers) || peers.length > MAX_RTC_PEERS)
        throw new TypeError('peers is not a list');
      return peers.map((v: unknown) => {
        if (typeof v !== 'object' || v === null) throw new TypeError('a peer is not an object');
        const p = v as Readonly<Record<string, unknown>>;
        return {
          peer: uint(p['peer'], 'peer'),
          swarm: swarmOf(p['swarm']),
          dir: dirOf(p['dir']),
          open: p['open'] === true,
        };
      });
    });
  }

  /** End the helper's stdin (it exits 0), then kill it if it has not within 5 s. */
  async close(): Promise<void> {
    this.closing = true;
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const run = this.run;
    if (run === null) return;
    const exited = new Promise<void>((done) => {
      this.exited = done;
    });
    try {
      run.child.stdin?.end();
    } catch {
      // already gone
    }
    const killTimer = setTimeout(() => {
      this.kill(run, 'close');
    }, CLOSE_GRACE_MS);
    await exited;
    clearTimeout(killTimer);
  }

  private async launch(): Promise<Launched> {
    let child: HelperChild;
    try {
      child = this.o.spawn(this.o.file, ['--state', this.o.stateDir]);
    } catch (e) {
      throw new HelperError('gone', `spawn failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const run: Run = {
      child,
      decoder: new HelperFrameDecoder((f) => {
        this.onFrame(run, f);
      }),
      startedAt: Date.now(),
      killedFor: null,
    };
    this.run = run;
    child.stdout?.on('data', (chunk) => {
      if (this.run !== run) return;
      try {
        run.decoder.push(chunk);
      } catch (e) {
        this.violation(run, e instanceof Error ? e.message : 'bad frame');
      }
    });
    child.stderr?.on('data', (chunk) => {
      this.onStderr(chunk);
    });
    child.on('error', () => {
      // An `exit` follows, or the spawn never happened; both end the run there.
    });
    child.on('exit', (code, signal) => {
      this.onExit(run, code, signal);
    });
    let launched: Launched;
    try {
      const rtc = this.rtcInit;
      if (rtc === null) {
        const m = await this.send(run, this.irohInit(), null);
        launched = { reach: this.believe(() => reachOf(m)), rtc: null };
      } else {
        const init: Record<string, unknown> = {
          op: 'rtc-init',
          stun: [...rtc.stun],
          root: rtc.root,
        };
        if (rtc.bind !== undefined) init['bind'] = rtc.bind;
        if (rtc.allowPrivate === true) init['allow_private'] = true;
        const m = await this.send(run, init, null);
        launched = { reach: null, rtc: this.believe(() => rtcReachOf(m)) };
      }
    } catch (e) {
      // A helper that cannot init is of no use: it goes, and a restart (if any) tries again.
      if (this.run === run) this.kill(run, 'init');
      throw e;
    }
    this.ready = true;
    if (launched.reach !== null) this.lastReach = launched.reach;
    return launched;
  }

  private irohInit(): Record<string, unknown> {
    const o = this.o.init as HelperInit;
    const init: Record<string, unknown> = { op: 'init', relays: [...o.relays] };
    if (this.#secret !== undefined) init['secret'] = this.#secret;
    if (o.relayOnly === true) init['relay_only'] = true;
    if (o.portmapper === true) init['portmapper'] = true;
    if (o.relayCas !== undefined && o.relayCas.length > 0) init['relay_cas'] = [...o.relayCas];
    return init;
  }

  /** A reply's fields, or a protocol violation: the helper is killed and the call fails. */
  private believe<T>(parse: () => T): T {
    try {
      return parse();
    } catch (e) {
      const reason = `a malformed reply: ${e instanceof Error ? e.message : String(e)}`;
      const run = this.run;
      if (run !== null) this.violation(run, reason);
      throw new HelperError('violation', reason);
    }
  }

  private request(
    msg: Readonly<Record<string, unknown>>,
    getMax: number | null = null,
  ): Promise<Readonly<Record<string, unknown>>> {
    const run = this.run;
    if (run === null || !this.ready || this.closing)
      return Promise.reject(new HelperError(this.closing ? 'closed' : 'not-ready', 'no helper'));
    return this.send(run, msg, getMax);
  }

  private send(
    run: Run,
    msg: Readonly<Record<string, unknown>>,
    getMax: number | null,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (this.pending.size >= this.maxInflight)
      return Promise.reject(new HelperError('busy', 'too many requests at once'));
    const id = this.allocId();
    let frame: Uint8Array;
    try {
      frame = encodeCtl({ ...msg, id });
    } catch (e) {
      return Promise.reject(
        new HelperError('bad-request', e instanceof Error ? e.message : 'frame'),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (p === undefined) return;
        this.pending.delete(id);
        this.abandoned.set(id, { remaining: p.get === null ? 0 : p.get.max - p.get.got });
        if (this.abandoned.size > MAX_ABANDONED)
          this.violation(run, 'too many unanswered requests');
        reject(new HelperError('timeout', `no reply in ${String(this.timeoutMs)} ms`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        get: getMax === null ? null : { max: getMax, chunks: [], got: 0 },
      });
      try {
        run.child.stdin?.write(frame);
      } catch {
        // The exit that follows rejects it.
      }
    });
  }

  private allocId(): number {
    do {
      this.nextId = this.nextId >= 0xffff_ffff ? 1 : this.nextId + 1;
    } while (this.pending.has(this.nextId) || this.abandoned.has(this.nextId));
    return this.nextId;
  }

  private onFrame(run: Run, frame: HelperFrame): void {
    if (this.run !== run) return;
    if (frame.kind === 'data') {
      const p = this.pending.get(frame.id);
      if (p?.get) {
        if (p.get.got + frame.bytes.length > p.get.max) {
          this.violation(run, 'a get sent more than its max');
          return;
        }
        p.get.chunks.push(frame.bytes);
        p.get.got += frame.bytes.length;
        return;
      }
      const late = this.abandoned.get(frame.id);
      if (late !== undefined && late.remaining >= frame.bytes.length) {
        late.remaining -= frame.bytes.length;
        return;
      }
      this.violation(run, 'data for no waiting get');
      return;
    }
    const msg = frame.msg;
    const id = msg['id'];
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
      this.violation(run, 'a reply without an id');
      return;
    }
    const p = this.pending.get(id);
    if (p === undefined) {
      if (this.abandoned.delete(id)) return;
      this.violation(run, 'a reply for no waiting request');
      return;
    }
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (msg['ok'] === true) {
      if (p.get === null) {
        p.resolve(msg);
        return;
      }
      if (msg['size'] !== p.get.got) {
        p.reject(new HelperError('violation', 'a get reply disagrees with its bytes'));
        this.violation(run, 'a get reply disagrees with its bytes');
        return;
      }
      p.resolve({ ...msg, bytes: concat(p.get.chunks, p.get.got) });
      return;
    }
    if (msg['ok'] === false) {
      const code = typeof msg['err'] === 'string' ? msg['err'].slice(0, 32) : 'internal';
      const text = typeof msg['msg'] === 'string' ? msg['msg'].slice(0, 512) : '';
      p.reject(new HelperError(code, text));
      return;
    }
    p.reject(new HelperError('violation', 'a reply without ok'));
    this.violation(run, 'a reply without ok');
  }

  private onStderr(chunk: Uint8Array): void {
    let text = this.stderrRest;
    for (const b of chunk)
      text += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : b === 0x0a ? '\n' : '?';
    const lines = text.split('\n');
    this.stderrRest = (lines.pop() ?? '').slice(0, MAX_STDERR_LINE);
    for (const line of lines)
      if (line.length > 0)
        this.o.onEvent?.({ type: 'stderr', line: line.slice(0, MAX_STDERR_LINE) });
  }

  private violation(run: Run, reason: string): void {
    if (this.run !== run || run.killedFor !== null) return;
    this.o.onEvent?.({ type: 'violation', reason });
    this.kill(run, 'violation');
  }

  private kill(run: Run, why: 'violation' | 'close' | 'init'): void {
    run.killedFor ??= why;
    try {
      run.child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }

  private onExit(run: Run, code: number | null, signal: string | null): void {
    if (this.run !== run) return;
    this.run = null;
    this.ready = false;
    this.o.onEvent?.({ type: 'exit', code, signal });
    const why = this.closing ? 'closed' : run.killedFor === 'violation' ? 'violation' : 'gone';
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new HelperError(why, `the helper exited (${String(code ?? signal)})`));
      this.pending.delete(id);
    }
    this.abandoned.clear();
    if (this.closing) {
      this.exited?.();
      return;
    }
    // A first start that failed is the caller's to retry; after that, the supervisor's.
    if (this.started) this.scheduleRestart(Date.now() - run.startedAt >= HEALTHY_MS);
  }

  /** At most one restart is ever pending. */
  private scheduleRestart(healthy: boolean): void {
    const policy = this.o.restart;
    if (policy === false || this.restartTimer !== null) return;
    const minMs = policy?.minMs ?? 250;
    const maxMs = policy?.maxMs ?? 10_000;
    if (healthy) this.backoffMs = minMs;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(maxMs, Math.max(minMs, this.backoffMs * 2));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.closing) return;
      this.attempt += 1;
      const attempt = this.attempt;
      this.launch().then(
        ({ reach }) => {
          this.restarts += 1;
          this.o.onEvent?.({ type: 'restarted', attempt, reach });
        },
        (e: unknown) => {
          this.o.onEvent?.({
            type: 'restart-failed',
            attempt,
            error: e instanceof Error ? e.message : String(e),
          });
          // A spawn that threw leaves no run, so no exit will schedule the next try.
          if (this.run === null && !this.closing) this.scheduleRestart(false);
        },
      );
    }, delay);
  }
}
