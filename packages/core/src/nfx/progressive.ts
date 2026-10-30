/**
 * One rendition as one progressive file (spike S-E): its init, an optional index, then its
 * segments, laid end to end, so a `<video src>` can play and seek it by byte range through the
 * existing proxy. Pure: the layout says where each byte lives, and `locate` turns a range into
 * reads of stored files (each within `NFX_MAX_READ_BYTES`, as `NfxStore.file().read` allows) or
 * slices of literal bytes (a built `sidx`).
 *
 * A range comes from a player through the proxy, so `locate` refuses anything outside the
 * layout instead of clamping it: a caller answers 416, never reads past a file.
 */
import { MAX_HASH_LIST_BYTES } from './files1.js';

/** A stored file (by sha256 and size) or bytes made for the view (a `sidx`). */
export type ProgressivePart =
  | { readonly kind: 'file'; readonly sha256: string; readonly size: number }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array };

export interface PlacedPart {
  readonly part: ProgressivePart;
  readonly offset: number;
  readonly size: number;
}

export interface ProgressiveLayout {
  readonly parts: readonly PlacedPart[];
  /** Bytes in the whole view. */
  readonly size: number;
}

/** One read a range needs: `length` bytes at `offset` within one part. */
export interface ProgressivePiece {
  readonly part: ProgressivePart;
  readonly offset: number;
  readonly length: number;
}

const SHA = /^[0-9a-f]{64}$/;

/** Parts end to end. Throws `RangeError` on an empty part, a bad sha256 or a size past 2^53. */
export function progressiveLayout(parts: readonly ProgressivePart[]): ProgressiveLayout {
  if (parts.length === 0) throw new RangeError('progressive: no parts');
  const placed: PlacedPart[] = [];
  let offset = 0;
  for (const part of parts) {
    const size = part.kind === 'file' ? part.size : part.bytes.length;
    if (part.kind === 'file' && !SHA.test(part.sha256))
      throw new RangeError('progressive: a part is not a sha256');
    if (!Number.isSafeInteger(size) || size < 1) throw new RangeError('progressive: an empty part');
    if (!Number.isSafeInteger(offset + size)) throw new RangeError('progressive: past 2^53 bytes');
    placed.push({ part, offset, size });
    offset += size;
  }
  return { parts: placed, size: offset };
}

/**
 * The reads that make up `length` bytes at `offset` of the view, in order, none longer than
 * `maxRead`. Throws `RangeError` if the range is empty or not wholly inside the view.
 */
export function locate(
  layout: ProgressiveLayout,
  offset: number,
  length: number,
  maxRead: number = MAX_HASH_LIST_BYTES,
): ProgressivePiece[] {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1)
    throw new RangeError('progressive: a bad range');
  if (offset + length > layout.size) throw new RangeError('progressive: a range past the end');
  if (!Number.isSafeInteger(maxRead) || maxRead < 1)
    throw new RangeError('progressive: bad maxRead');
  // The first part that ends after `offset` (binary search: a long video has thousands).
  let lo = 0;
  let hi = layout.parts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const p = layout.parts[mid];
    if (p === undefined) throw new RangeError('progressive: layout');
    if (p.offset + p.size <= offset) lo = mid + 1;
    else hi = mid;
  }
  const pieces: ProgressivePiece[] = [];
  let at = offset;
  let left = length;
  for (let i = lo; left > 0; i++) {
    const p = layout.parts[i];
    if (p === undefined) throw new RangeError('progressive: layout');
    let within = at - p.offset;
    let inPart = Math.min(left, p.size - within);
    while (inPart > 0) {
      const n = Math.min(inPart, maxRead);
      pieces.push({ part: p.part, offset: within, length: n });
      within += n;
      at += n;
      left -= n;
      inPart -= n;
    }
  }
  return pieces;
}
