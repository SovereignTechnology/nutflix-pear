/**
 * `nf-media://…` — main's media proxy (design §1 "PlaySession across processes", §3).
 *
 *   `nf-media://play/<token>`  → the worker's loopback blob-server link the HOST registered for
 *                                that token (`HostOut media-link`); `Range` is forwarded through
 *                                `net.fetch` and the 200/206/416 streamed back; a request the
 *                                player drops aborts its upstream fetch. The renderer never
 *                                learns the port or the worker's own token; CSP stays static.
 *   `nf-media://img/<id>`      → the host's image bytes (`HostIn image` / `HostOut image`); the
 *                                host fetched and hash-checked them (T16).
 *
 * Electron-free: `main.ts` injects `net.fetch`; tests inject fakes.
 */
import type { HostIn, ImageMime } from '../ipc/protocol.js';
import { IMAGE_MIMES } from '../ipc/protocol.js';
import { MEDIA_RESPONSE_HEADERS } from './csp.js';
import { MEDIA_SCHEME } from './schemes.js';
import type { Logger } from './log.js';
import { silentLogger } from './log.js';

/** Exactly what `isHostOut` accepts for a media link (re-checked here before every fetch). */
export const LOOPBACK_LINK = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[\x21-\x7e]*$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** One range, the only shape `<video>` sends (`bytes=0-`, `bytes=N-M`, `bytes=-N`). */
const RANGE = /^bytes=(?:\d{1,16}-\d{0,16}|-\d{1,16})$/;
const CONTENT_RANGE = /^bytes (?:\d{1,16}-\d{1,16}|\*)\/(?:\d{1,16}|\*)$/;
const CONTENT_LENGTH = /^\d{1,16}$/;
export const MAX_MEDIA_LINKS = 256;

/** Token → loopback link, as the host registers and revokes them. */
export class MediaLinks {
  private readonly links = new Map<string, string>();
  constructor(private readonly log: Logger = silentLogger) {}

  /** `url: null` revokes. Returns false (and registers nothing) for a malformed link. */
  set(token: string, url: string | null): boolean {
    if (url === null) {
      this.links.delete(token);
      return true;
    }
    if (!ID.test(token) || !LOOPBACK_LINK.test(url)) {
      this.log('warn', 'media.link-dropped', { malformed: true });
      return false;
    }
    if (!this.links.has(token) && this.links.size >= MAX_MEDIA_LINKS) {
      this.log('warn', 'media.link-dropped', { full: true });
      return false;
    }
    this.links.set(token, url);
    return true;
  }

  get(token: string): string | undefined {
    return this.links.get(token);
  }

  clear(): void {
    this.links.clear();
  }

  get size(): number {
    return this.links.size;
  }
}

export interface ImageResult {
  readonly bytes: Uint8Array;
  readonly type: ImageMime;
}

/**
 * Outstanding `nf-media://img/<id>` requests to the host. Each resolves once: with the bytes,
 * with `null` (unknown id, refused by the host, host down) or after `timeoutMs`.
 */
export class ImageRequests {
  private next = 1;
  private readonly pending = new Map<
    number,
    { resolve: (r: ImageResult | null) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly post: (msg: HostIn) => boolean,
    private readonly timeoutMs = 30_000,
    private readonly log: Logger = silentLogger,
  ) {}

  request(id: string): Promise<ImageResult | null> {
    if (!ID.test(id)) return Promise.resolve(null);
    const req = this.next;
    this.next = this.next >= 0x7fffffff ? 1 : this.next + 1;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(req)) {
          this.log('warn', 'image.timeout');
          resolve(null);
        }
      }, this.timeoutMs);
      this.pending.set(req, { resolve, timer });
      if (!this.post({ kind: 'image', req, id })) this.settle(req, null);
    });
  }

  /** A `HostOut image` arrived. Unknown `req` is ignored. */
  resolve(req: number, bytes: Uint8Array | null, type: ImageMime | null): void {
    const ok = bytes !== null && type !== null && (IMAGE_MIMES as readonly string[]).includes(type);
    this.settle(req, ok ? { bytes, type } : null);
  }

  /** The host went away: every outstanding request fails. */
  failAll(): void {
    for (const req of [...this.pending.keys()]) this.settle(req, null);
  }

  get size(): number {
    return this.pending.size;
  }

  private settle(req: number, r: ImageResult | null): void {
    const p = this.pending.get(req);
    if (p === undefined) return;
    this.pending.delete(req);
    clearTimeout(p.timer);
    p.resolve(r);
  }
}

/** What main passes for `net.fetch` (a subset of the fetch API). */
export type MediaFetch = (
  url: string,
  init: {
    readonly method: 'GET' | 'HEAD';
    readonly headers: Readonly<Record<string, string>>;
    readonly redirect: 'error';
    /** Aborted once the player drops the request (spike S-E, finding 6). */
    readonly signal: AbortSignal;
  },
) => Promise<Response>;

/** `net.fetch` as a `MediaFetch`: what `main.ts` injects (and the proxy-abort e2e, the same). */
export function netMediaFetch(
  fetch: (url: string, init: RequestInit) => Promise<Response>,
): MediaFetch {
  return (url, init) => fetch(url, { ...init, headers: { ...init.headers } });
}

export interface MediaProtocolDeps {
  readonly links: MediaLinks;
  readonly images: ImageRequests;
  readonly fetch: MediaFetch;
  readonly log?: Logger;
}

function plain(status: number, extra: Readonly<Record<string, string>> = {}): Response {
  return new Response(null, { status, headers: { ...MEDIA_RESPONSE_HEADERS, ...extra } });
}

/** Parses `nf-media://<kind>/<id>`; `null` for anything else. Exported for the tests. */
export function parseMediaUrl(url: string): { kind: 'play' | 'img'; id: string } | null {
  const m = /^nf-media:\/\/(play|img)\/([A-Za-z0-9_-]{1,128})$/.exec(url);
  if (m === null) return null;
  return { kind: m[1] as 'play' | 'img', id: m[2] ?? '' };
}

/** The `protocol.handle('nf-media', …)` handler. Never throws. */
export function createMediaProtocolHandler(
  deps: MediaProtocolDeps,
): (req: Request) => Promise<Response> {
  const log = deps.log ?? silentLogger;
  return async (req) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, { allow: 'GET, HEAD' });
      if (!req.url.startsWith(`${MEDIA_SCHEME}://`)) return plain(404);
      const target = parseMediaUrl(req.url);
      if (target === null) return plain(404);
      if (target.kind === 'img') {
        const img = await deps.images.request(target.id);
        if (img === null) return plain(404);
        return new Response(req.method === 'HEAD' ? null : new Uint8Array(img.bytes), {
          status: 200,
          headers: {
            ...MEDIA_RESPONSE_HEADERS,
            'content-type': img.type,
            'content-length': String(img.bytes.byteLength),
          },
        });
      }
      return await proxyPlay(req, target.id, deps, log);
    } catch {
      log('warn', 'media.proxy-failed');
      return plain(502);
    }
  };
}

async function proxyPlay(
  req: Request,
  token: string,
  deps: MediaProtocolDeps,
  log: Logger,
): Promise<Response> {
  const link = deps.links.get(token);
  if (link === undefined || !LOOPBACK_LINK.test(link)) return plain(404);
  const headers: Record<string, string> = {};
  const range = req.headers.get('range');
  if (range !== null) {
    // Never widen a request: a malformed or multi-range header is refused, not dropped
    // (dropping it would ask the worker for the whole rendition — buffer = money).
    if (!RANGE.test(range.trim())) return plain(416, { 'content-range': 'bytes */*' });
    headers['range'] = range.trim();
  }
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
  // The upstream fetch lives no longer than the player's request. An orphan would hold one of
  // the 6 connections main's `net.fetch` pools per host:port, starving the next source, and
  // keep the worker's gated stream for the video open (spike S-E, finding 6). Electron may say
  // so by aborting `req.signal` or by cancelling the body we return: either aborts it.
  const upstreamAbort = new AbortController();
  const dropped = (): void => {
    upstreamAbort.abort();
  };
  if (req.signal.aborted) dropped();
  else req.signal.addEventListener('abort', dropped, { once: true });
  let upstream: Response;
  try {
    upstream = await deps.fetch(link, {
      method,
      headers,
      redirect: 'error',
      signal: upstreamAbort.signal,
    });
  } catch {
    // A request the player dropped is not a failure worth a line.
    if (!upstreamAbort.signal.aborted) log('warn', 'media.proxy-failed', { fetch: true });
    return plain(502);
  }
  const status = upstream.status;
  if (status !== 200 && status !== 206 && status !== 416) {
    await upstream.body?.cancel().catch(() => undefined);
    return plain(status === 404 ? 404 : 502);
  }
  const out: Record<string, string> = {
    ...MEDIA_RESPONSE_HEADERS,
    // Fixed type (design §3): never whatever the upstream or a URL parameter claims.
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
  };
  const len = upstream.headers.get('content-length');
  if (len !== null && CONTENT_LENGTH.test(len)) out['content-length'] = len;
  const cr = upstream.headers.get('content-range');
  if (cr !== null && CONTENT_RANGE.test(cr)) out['content-range'] = cr;
  if (method === 'HEAD' || status === 416) {
    await upstream.body?.cancel().catch(() => undefined);
    return new Response(null, { status, headers: out });
  }
  const body = upstream.body === null ? null : passThrough(upstream.body, upstreamAbort);
  return new Response(body, { status, headers: out });
}

/**
 * `body` byte for byte, read from upstream only as the player reads (`highWaterMark: 0`: no
 * buffer of its own). Cancelling it, which Electron does when the player drops the request,
 * cancels the upstream body and aborts its fetch; an upstream error does the same.
 */
function passThrough(
  body: ReadableStream<Uint8Array>,
  upstreamAbort: AbortController,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) controller.close();
          else controller.enqueue(chunk.value);
        } catch (e: unknown) {
          // An upstream error, or a read that lost a race with cancel (then a no-op).
          upstreamAbort.abort();
          controller.error(e);
        }
      },
      async cancel(reason: unknown) {
        const cancelled = reader.cancel(reason).catch(() => undefined);
        upstreamAbort.abort();
        await cancelled;
      },
    },
    { highWaterMark: 0 },
  );
}
