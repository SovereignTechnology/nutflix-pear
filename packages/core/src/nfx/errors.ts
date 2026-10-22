/**
 * Why an NFX object was rejected: nfx-proto's `Error`, one kind per variant. Every rejection
 * is total: callers discard the object, never render part of it (NFX-01 §4, NFX-02 §4).
 */
import type { Result } from '../contracts/index.js';

export type NfxErrorKind =
  | 'namespace'
  | 'video-id'
  | 'event'
  | 'signature'
  | 'manifest'
  | 'beacon'
  | 'hash-list'
  | 'playlist'
  | 'canon'
  | 'deletion'
  | 'files';

export interface NfxError {
  readonly kind: NfxErrorKind;
  readonly reason: string;
}

export type NfxResult<T> = Result<T, NfxError>;

export const ok = <T>(value: T): NfxResult<T> => ({ ok: true, value });

export const fail = (kind: NfxErrorKind, reason: string): NfxResult<never> => ({
  ok: false,
  error: { kind, reason },
});

declare const verified: unique symbol;

/**
 * A value that passed its NFX verification (nfx-proto's `Verified`). Only this module's
 * verifying parsers return one (`parseManifest`, `parseBeacon`), so code that must act on
 * verified data only takes `Verified<T>`. A cast can forge it, as with every brand here.
 */
export type Verified<T> = T & { readonly [verified]: true };
