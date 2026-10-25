/**
 * Errors as data (design §0.8, §2). `contextBridge` drops custom Error properties and
 * `ipcMain.handle` rewrites thrown messages, so every failure crosses a process boundary as a
 * `WireError` inside a resolved `ReplyMsg`, and the receiving side rebuilds an `Error` whose
 * `message` starts with `"<code>: "` and which carries `.code` — the two things the screens
 * classify by (message prefixes `no-seeders:`, `no-balance:`, `no-signer`, `relay-down`,
 * `ffmpeg-not-found`; Studio reads `.code`).
 *
 * No imports from `@sovit/core` at runtime: `MediaError`/`ProcessRunnerError` are recognised
 * structurally (by `name` + `code`), exactly as core's own `isProcessRunnerError` does.
 */
import type { ErrorCode, WireError } from './protocol.js';
import { LIMITS, MEDIA_ERROR_CODES } from './protocol.js';
import { isErrorCode, isWireError } from './guards.js';

/** The rebuilt error on the receiving side of a hop. */
export class IpcError extends Error {
  override readonly name = 'IpcError' as const;
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The message every unrecognised failure is reduced to (no stack, no path, no detail). */
export const INTERNAL_MESSAGE = 'internal: internal error' as const;

const PREFIX = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?![A-Za-z0-9_-])/;
const MEDIA = new Set<string>(MEDIA_ERROR_CODES);

function field(e: object, k: 'code' | 'name' | 'message' | 'cause'): unknown {
  try {
    return (e as Record<string, unknown>)[k];
  } catch {
    return undefined;
  }
}

/** The code an error is known by: its own `code`, a runner/media code, or its message prefix. */
function codeOf(err: unknown): ErrorCode | undefined {
  for (let e: unknown = err, depth = 0; depth < 4; depth++) {
    if (typeof e === 'string') {
      const p = PREFIX.exec(e)?.[1];
      return isErrorCode(p) ? p : undefined;
    }
    if (typeof e !== 'object' || e === null) return undefined;
    const code = field(e, 'code');
    const name = field(e, 'name');
    if (name === 'ProcessRunnerError') {
      // core's pipeline maps these the same way (media/run.ts runOrThrow).
      if (code === 'spawn-failed') return 'ffmpeg-not-found';
      if (code === 'aborted') return 'aborted';
    }
    if (name === 'MediaError' && typeof code === 'string' && MEDIA.has(code))
      return code as ErrorCode;
    if (isErrorCode(code)) return code;
    const message = field(e, 'message');
    if (typeof message === 'string') {
      const p = PREFIX.exec(message)?.[1];
      if (isErrorCode(p)) return p;
    }
    e = field(e, 'cause');
  }
  return undefined;
}

// Best-effort path scrubbing for messages of RECOGNISED errors (unrecognised ones are replaced
// wholesale). A path starts after whitespace / a quote / a bracket / `=` — so `wss://relay/x`
// and `https://mint/y` (preceded by `:`) are left alone.
const PATHS = [
  /()file:\/\/[^\s'"`)\]}>,]*/gi,
  /(^|[\s'"`([{<=,])(?:~|\.{1,2})?\/[^\s'"`)\]}>,]*/g,
  /(^|[\s'"`([{<=,])[A-Za-z]:\\[^\s'"`)\]}>,]*/g,
  /(^|[\s'"`([{<=,])\\\\[^\s'"`)\]}>,]*/g,
];

function scrub(message: string): string {
  // Bound the work first: only the first line of the first few KiB is ever kept.
  let m = message.slice(0, 8 * LIMITS.maxErrorMessage).split(/\r?\n/, 1)[0] ?? '';
  for (const re of PATHS) m = m.replace(re, (_all, lead?: string) => `${lead ?? ''}<path>`);
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  m = m.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return m;
}

function clamp(message: string): string {
  return message.length <= LIMITS.maxErrorMessage
    ? message
    : `${message.slice(0, LIMITS.maxErrorMessage - 1)}…`;
}

/** A `WireError` for `code` with a human `detail` (the `"<code>: "` prefix is added). */
export function wireError(code: ErrorCode, detail: string): WireError {
  const d = scrub(detail);
  return { code, message: clamp(d === '' ? `${code}: ${code}` : `${code}: ${d}`) };
}

/**
 * Anything thrown → a `WireError` that is safe to send to a less-trusted process. Recognised
 * codes keep their (first-line, path-scrubbed, clamped) message; anything else becomes
 * `internal` with a constant message. Never includes a stack. Never throws.
 */
export function toWireError(err: unknown): WireError {
  try {
    // A WireError-shaped input takes the same path (its `code` field wins), so it is scrubbed too.
    const code = codeOf(err);
    if (code === undefined || code === 'internal')
      return { code: 'internal', message: INTERNAL_MESSAGE };
    let message = '';
    if (typeof err === 'string') message = err;
    else if (typeof err === 'object' && err !== null) {
      const m = field(err, 'message');
      if (typeof m === 'string') message = m;
    }
    message = scrub(message);
    // Keep an existing "<code>:"/"<code> " prefix once; otherwise prepend it.
    const rest =
      PREFIX.exec(message)?.[1] === code
        ? message.slice(code.length).replace(/^:?\s*/, '')
        : message;
    return { code, message: clamp(rest === '' ? `${code}: ${code}` : `${code}: ${rest}`) };
  } catch {
    return { code: 'internal', message: INTERNAL_MESSAGE };
  }
}

/**
 * A `WireError` (or anything claiming to be one) → the `Error` the calling code sees:
 * `message` starts with `"<code>: "`, `.code` is set. Malformed input → `internal`.
 */
export function fromWireError(w: unknown): IpcError {
  if (!isWireError(w)) return new IpcError('internal', INTERNAL_MESSAGE);
  return new IpcError(w.code, w.message);
}
