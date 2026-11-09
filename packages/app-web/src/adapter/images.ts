/**
 * `image()` in the page (ADR 0022: "shows images only when they match a hash their publisher
 * signed"). An image is fetched only when its publisher signed its sha256, and handed to the
 * screens only as a `blob:` URL of bytes that match it, so the page's CSP can keep `img-src` to
 * `blob:` and no unchecked byte reaches an `<img>`.
 *
 * - **No sha256, no request:** `forbidden`, and the screen keeps its placeholder (an unsigned URL
 *   is a tracking pixel). `hyper://` images (Pear) are the desktop app's: `forbidden` too.
 * - **The URL:** `https:` only, no user-info, nothing the URL parser would rewrite, a public host
 *   (`isPublicHost`): a profile cannot make viewers' browsers fetch from their own network.
 * - **The bytes:** one GET, no cookies or referrer, no redirect, at most `MAX_IMAGE_BYTES` (or the
 *   signed `size`, which must then match), sha256-checked, then sniffed: JPEG, PNG, WebP or GIF by
 *   their magic numbers, and the blob takes the sniffed type. Never SVG or anything else a browser
 *   could run as a document from a `blob:` URL of this origin.
 * - **Cached by sha256,** at most `MAX_WEB_IMAGES` URLs; the oldest is revoked first. One request
 *   per hash at a time.
 */
import type { MAX_IMAGE_BYTES, Sha256Hex } from '@sovit/core';

import { WebAdapterError, fail } from '../errors.js';
import { type FetchFn, HttpError, getBounded } from './http.js';
import { isPublicHost, parseStrictUrl } from './hosts.js';

/** Contracts' `MAX_IMAGE_BYTES` (5 MiB). */
export const WEB_MAX_IMAGE_BYTES: typeof MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The most `blob:` URLs kept. */
export const MAX_WEB_IMAGES = 256;
/** An image URL's length cap (the desktop's `LIMITS.maxUrl`). */
export const MAX_IMAGE_URL = 2048;
export const IMAGE_TIMEOUT_MS = 15_000;

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

/** The image type the bytes are (magic numbers), or `null`. */
export function sniffImage(b: Uint8Array): ImageType | null {
  const at = (i: number, ...v: number[]): boolean => v.every((x, k) => b[i + k] === x);
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
    return 'image/webp';
  if (
    b.length >= 6 &&
    (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))
  )
    return 'image/gif';
  return null;
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');
}

export interface WebImagesOptions {
  readonly fetch: FetchFn;
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  readonly timeoutMs?: number | undefined;
  /** The most URLs kept (at least 1). */
  readonly max?: number | undefined;
}

export class WebImages {
  readonly #o: WebImagesOptions;
  /** sha256 → `blob:` URL, oldest first. */
  readonly #urls = new Map<string, string>();
  readonly #pending = new Map<string, Promise<string>>();

  constructor(o: WebImagesOptions) {
    this.#o = o;
  }

  image(url: string, sha256?: Sha256Hex, size?: number): Promise<string> {
    try {
      return this.#image(url, sha256, size);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** Arguments as `unknown`: the screens are typed, but nothing here relies on it. */
  #image(url: unknown, sha256: unknown, size: unknown): Promise<string> {
    if (typeof url !== 'string') fail('invalid-argument', 'not an image URL');
    if (sha256 === undefined) {
      fail('forbidden', 'only images whose sha256 the publisher signed are shown here');
    }
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      fail('invalid-argument', 'not a sha256');
    }
    let signedSize: number | undefined;
    if (size !== undefined) {
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
        fail('invalid-argument', 'not an image size');
      }
      if (size > WEB_MAX_IMAGE_BYTES) fail('forbidden', 'image too large');
      signedSize = size;
    }
    const u = parseStrictUrl(url, MAX_IMAGE_URL);
    if (u?.protocol !== 'https:') fail('forbidden', 'only https images are shown here');
    if (!isPublicHost(u.hostname)) fail('forbidden', 'not a public host');
    const hit = this.#urls.get(sha256);
    if (hit !== undefined) {
      // Most recently used last.
      this.#urls.delete(sha256);
      this.#urls.set(sha256, hit);
      return Promise.resolve(hit);
    }
    const pending = this.#pending.get(sha256);
    if (pending !== undefined) return pending;
    const p = this.#load(u.href, sha256, signedSize).finally(() => {
      this.#pending.delete(sha256);
    });
    this.#pending.set(sha256, p);
    return p;
  }

  async #load(url: string, sha256: string, size: number | undefined): Promise<string> {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = await getBounded(this.#o.fetch, url, {
        maxBytes: size ?? WEB_MAX_IMAGE_BYTES,
        timeoutMs: this.#o.timeoutMs ?? IMAGE_TIMEOUT_MS,
      });
    } catch (e) {
      throw new WebAdapterError(
        'not-found',
        `image unavailable (${e instanceof HttpError ? e.message : 'request failed'})`,
      );
    }
    if (size !== undefined && bytes.byteLength !== size) fail('forbidden', 'image size mismatch');
    // WebCrypto's SHA-256, always: nothing here can swap the check out.
    if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== sha256) {
      fail('forbidden', 'image hash mismatch');
    }
    const type = sniffImage(bytes);
    if (type === null) fail('forbidden', 'not a JPEG, PNG, WebP or GIF image');
    const blobUrl = this.#o.createObjectURL(new Blob([bytes], { type }));
    this.#urls.set(sha256, blobUrl);
    const max = Math.max(1, this.#o.max ?? MAX_WEB_IMAGES);
    for (const [oldest, oldUrl] of this.#urls) {
      if (this.#urls.size <= max) break;
      this.#urls.delete(oldest);
      this.#o.revokeObjectURL(oldUrl);
    }
    return blobUrl;
  }

  /** Revokes every URL handed out. */
  clear(): void {
    for (const u of this.#urls.values()) this.#o.revokeObjectURL(u);
    this.#urls.clear();
  }
}
