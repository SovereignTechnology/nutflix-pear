/**
 * Namespaces, video addresses and the identifiers derived from them (NFX-01 §2, NFX-06 §4,
 * NFX-10 §2, NFX-12 §3).
 */
import { fail, ok, type NfxResult } from './errors.js';
import { parseU64Strict, sha256, utf8 } from './util.js';

/** The only wire token (NFX-01 §2). `nutflix:*` namespaces are void. */
export const TOKEN = 'nfx';

const NETWORK = /^[a-z0-9-]{2,32}$/;
const VIDEO_ID = /^[a-z0-9][a-z0-9-]{6,62}$/;

/** `nfx:<network>:<specver>`. */
export class Namespace {
  private constructor(
    readonly network: string,
    readonly specver: bigint,
  ) {}

  /**
   * Parse and validate a namespace. Rejects every other token, uppercase, leading zeros in
   * `specver`, and network names outside `[a-z0-9-]{2,32}`.
   */
  static parse(s: string): NfxResult<Namespace> {
    const parts = s.split(':');
    const [token, network, specverText] = parts;
    if (parts.length !== 3 || token !== TOKEN || network === undefined) return fail('namespace', s);
    if (!NETWORK.test(network)) return fail('namespace', s);
    const specver = parseU64Strict(specverText ?? '');
    if (specver === undefined) return fail('namespace', s);
    return ok(new Namespace(network, specver));
  }

  toString(): string {
    return `${TOKEN}:${this.network}:${this.specver.toString()}`;
  }

  equals(other: Namespace): boolean {
    return this.network === other.network && this.specver === other.specver;
  }
}

/** `[a-z0-9][a-z0-9-]{6,62}` (NFX-02 §2). */
export function validateVideoId(id: string): NfxResult<string> {
  return VIDEO_ID.test(id) ? ok(id) : fail('video-id', id);
}

/** `<namespace>:<video-id>`: the `d` tag, the hash list's `video`, the beacon's `video`. */
export class VideoAddr {
  private constructor(
    readonly namespace: Namespace,
    readonly videoId: string,
  ) {}

  static of(namespace: Namespace, videoId: string): NfxResult<VideoAddr> {
    const id = validateVideoId(videoId);
    return id.ok ? ok(new VideoAddr(namespace, id.value)) : id;
  }

  /** Split at the LAST colon: the namespace has two of its own. */
  static parse(s: string): NfxResult<VideoAddr> {
    const at = s.lastIndexOf(':');
    if (at < 0) return fail('video-id', s);
    const namespace = Namespace.parse(s.slice(0, at));
    return namespace.ok ? VideoAddr.of(namespace.value, s.slice(at + 1)) : namespace;
  }

  toString(): string {
    return `${this.namespace.toString()}:${this.videoId}`;
  }

  equals(other: VideoAddr): boolean {
    return this.namespace.equals(other.namespace) && this.videoId === other.videoId;
  }

  /** iroh-gossip topic: `sha256("nfx/1/swarm/" + namespace + "/" + video-id)` (NFX-06 §4). */
  swarmTopic(): Uint8Array {
    return sha256(utf8(`nfx/1/swarm/${this.namespace.toString()}/${this.videoId}`));
  }

  /**
   * Browser-mesh stream swarm ID of one rendition (NFX-10 §2). Its tracker infohash (a SHA-1)
   * is not derived here: the web mesh is out of this app's scope.
   */
  webStreamSwarmId(renditionId: string): string {
    return `nfx/1/web/${this.toString()}/${renditionId}`;
  }

  /** HyperDHT per-video topic, a MAY (NFX-12 §3): `sha256("nfx/1/hyper/" + ns + "/" + id)`. */
  hyperTopic(): Uint8Array {
    return sha256(utf8(`nfx/1/hyper/${this.namespace.toString()}/${this.videoId}`));
  }

  /** The Protomux channel id of both NFX-12 protocols: `utf8(<namespace>:<video-id>)` (§3). */
  channelId(): Uint8Array {
    return utf8(this.toString());
  }
}
