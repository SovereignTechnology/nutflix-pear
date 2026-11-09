/**
 * How the web adapter fails: an `Error` whose `message` starts with `"<code>: "` and which carries
 * `.code`, the two things the screens classify by (the desktop app's `IpcError` has the same
 * shape). Messages never carry a relay's or a peer's own words, only what this client decided.
 */

export type WebErrorCode =
  /** A call this client cannot serve (ADR 0022: no wallet, signer, Hypercore or Studio). */
  | 'unsupported'
  | 'invalid-argument'
  | 'not-found'
  /** Nobody seeding the video named an endpoint this client can use (the screens' prefix). */
  | 'no-seeders'
  /** No relay answered (the screens' prefix). */
  | 'relay-down'
  /** Refused by this client's rules, e.g. an image whose sha256 nobody signed. */
  | 'forbidden'
  | 'session-closed'
  | 'internal';

export class WebAdapterError extends Error {
  override readonly name = 'WebAdapterError' as const;
  readonly code: WebErrorCode;

  constructor(code: WebErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

/** Throws a `WebAdapterError`. */
export function fail(code: WebErrorCode, detail: string): never {
  throw new WebAdapterError(code, detail);
}

/** A promise rejected with a `WebAdapterError`. */
export function rejectWith<T = never>(code: WebErrorCode, detail: string): Promise<T> {
  return Promise.reject(new WebAdapterError(code, detail));
}

/** A call the web client does not offer (and whose screen or action it hides). */
export function unsupported<T = never>(what: string): Promise<T> {
  return rejectWith('unsupported', `${what} is not available in the web client`);
}
