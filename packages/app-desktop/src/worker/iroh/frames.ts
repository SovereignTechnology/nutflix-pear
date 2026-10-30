/**
 * Worker ⇄ iroh-helper frames (`crates/iroh-helper/README.md`, ADR 0021): a 4-byte big-endian
 * length, then a kind byte and its body. `ctl` carries a JSON object (requests, replies); `data`
 * carries a run of bytes answering one `get`, tagged with that request's id.
 *
 * The helper is an untrusted pipe (nfx ADR 0103, sharp edges 2 and 3): the decoder checks a
 * length before it buffers a byte of the body, holds at most one partial frame, and fails for
 * good on anything malformed — after a bad frame the stream cannot be trusted to be aligned, so
 * the owner kills the helper.
 *
 * Runtime-neutral like `src/ipc/framing.ts`: `Uint8Array`, `DataView`, `JSON` and the pure UTF-8
 * codec only (Bare 1.31 has no `TextEncoder`).
 */
import { CodecError, utf8 } from '../../ipc/codec.js';

export const KIND_CTL = 1;
export const KIND_DATA = 2;
/** The largest JSON payload, and the largest run of bytes in one data frame. */
export const MAX_PAYLOAD = 64 * 1024;
/** The largest frame after its length prefix: kind, request id, payload. */
export const MAX_FRAME = 1 + 4 + MAX_PAYLOAD;
const HEADER = 4;

export type HelperFrame =
  | { readonly kind: 'ctl'; readonly msg: Readonly<Record<string, unknown>> }
  | { readonly kind: 'data'; readonly id: number; readonly bytes: Uint8Array };

export type HelperFrameErrorCode =
  | 'frame-too-large'
  | 'frame-empty'
  | 'unknown-kind'
  | 'invalid-json'
  | 'not-an-object'
  | 'truncated';

export class HelperFrameError extends Error {
  override readonly name = 'HelperFrameError' as const;
  readonly code: HelperFrameErrorCode;
  constructor(code: HelperFrameErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

/** One request → one `ctl` frame. Throws `HelperFrameError` if the JSON is over the limit. */
export function encodeCtl(msg: Readonly<Record<string, unknown>>): Uint8Array {
  const payload = utf8.encode(JSON.stringify(msg));
  if (payload.length === 0 || payload.length > MAX_PAYLOAD)
    throw new HelperFrameError('frame-too-large', `${payload.length} > ${MAX_PAYLOAD} bytes`);
  const out = new Uint8Array(HEADER + 1 + payload.length);
  new DataView(out.buffer).setUint32(0, 1 + payload.length, false);
  out[HEADER] = KIND_CTL;
  out.set(payload, HEADER + 1);
  return out;
}

/** A `data` frame (the helper's side; used by tests and fakes). */
export function encodeData(id: number, bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0 || bytes.length > MAX_PAYLOAD)
    throw new HelperFrameError('frame-too-large', `${bytes.length} > ${MAX_PAYLOAD} bytes`);
  const out = new Uint8Array(HEADER + 1 + 4 + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 1 + 4 + bytes.length, false);
  out[HEADER] = KIND_DATA;
  view.setUint32(HEADER + 1, id, false);
  out.set(bytes, HEADER + 1 + 4);
  return out;
}

/**
 * Incremental decoder over any chunking. `push` delivers each complete frame to `onFrame`
 * synchronously, in order; on a bad frame it throws (after the frames before it) and stays failed.
 */
export class HelperFrameDecoder {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private need: number | null = null;
  private failure: HelperFrameError | null = null;

  constructor(private readonly onFrame: (frame: HelperFrame) => void) {}

  get error(): HelperFrameError | null {
    return this.failure;
  }

  /** Bytes received and not yet delivered: at most one partial frame plus the last chunk. */
  get pendingBytes(): number {
    return this.buffered;
  }

  push(chunk: Uint8Array): void {
    if (this.failure) throw this.failure;
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    for (;;) {
      if (this.need === null) {
        if (this.buffered < HEADER) return;
        const head = this.take(HEADER);
        const len = new DataView(head.buffer, head.byteOffset, HEADER).getUint32(0, false);
        // Checked before one body byte is kept: a hostile length costs nothing.
        if (len > MAX_FRAME) this.fail('frame-too-large', `${len} > ${MAX_FRAME} bytes`);
        if (len === 0) this.fail('frame-empty', 'zero-length frame');
        this.need = len;
      }
      if (this.buffered < this.need) return;
      const body = this.take(this.need);
      this.need = null;
      this.onFrame(this.parse(body));
    }
  }

  /** The stream ended: throws `truncated` inside a frame. */
  end(): void {
    if (this.failure) throw this.failure;
    if (this.buffered > 0 || this.need !== null)
      this.fail('truncated', `stream ended inside a frame (${this.buffered} bytes pending)`);
  }

  private parse(body: Uint8Array): HelperFrame {
    const kind = body[0];
    if (kind === KIND_CTL) {
      if (body.length < 2) return this.fail('frame-empty', 'empty control frame');
      let value: unknown;
      try {
        value = JSON.parse(utf8.decode(body.subarray(1)));
      } catch (e) {
        return this.fail('invalid-json', e instanceof CodecError ? e.message : 'not JSON');
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return this.fail('not-an-object', 'control frames carry JSON objects only');
      return { kind: 'ctl', msg: value as Record<string, unknown> };
    }
    if (kind === KIND_DATA) {
      if (body.length <= 1 + 4) return this.fail('frame-empty', 'data frame without bytes');
      const id = new DataView(body.buffer, body.byteOffset + 1, 4).getUint32(0, false);
      // A copy: the decoder's chunks are reused by the caller's stream.
      return { kind: 'data', id, bytes: body.slice(1 + 4) };
    }
    return this.fail('unknown-kind', `kind ${String(kind)}`);
  }

  private fail(code: HelperFrameErrorCode, detail: string): never {
    this.failure = new HelperFrameError(code, detail);
    this.chunks = [];
    this.buffered = 0;
    throw this.failure;
  }

  /** Removes and returns exactly `n` buffered bytes (the caller checked `n <= buffered`). */
  private take(n: number): Uint8Array {
    const first = this.chunks[0];
    if (first === undefined) throw new RangeError('helper frames: buffer underflow');
    if (first.length >= n) {
      const out = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return out;
    }
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const c = this.chunks[0];
      if (c === undefined) throw new RangeError('helper frames: buffer underflow');
      const k = Math.min(c.length, n - o);
      out.set(c.subarray(0, k), o);
      o += k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    this.buffered -= n;
    return out;
  }
}
