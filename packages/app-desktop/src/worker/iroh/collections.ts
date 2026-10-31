/**
 * NFX-06 §2: how a verified hash list maps onto iroh collections (nfx-node `video.rs`), moved
 * here from spike S-D's `nfx06.mjs` for the worker that serves them (slice 5e-3) and the one that
 * fetches (5e-4).
 *
 * - **`meta`:** the hash list itself, then every file that is not an init or a segment (the
 *   playlists, thumbs and subtitles) in the hash list's `files` order.
 * - **One per rendition:** its init, then its segments in its PLAYLIST's order. The hash list
 *   does not say which files belong to which rendition; the playlist does, so membership and
 *   order come from it, never from `files` (core's `renditionMembers`, which refuses a name that
 *   is not a listed file of the right role).
 *
 * Members are sha256 values. The helper's BLAKE3 hashes are its own: only the sha256 a hash list
 * gives says what a file is (nfx ADR 0103, sharp edge 1).
 */
import { nfx } from '@sovit/core';

/** The metadata collection's key in a beacon's `tickets` (NFX-03 §4: never a rendition id). */
export const META_COLLECTION = nfx.RESERVED_RENDITION_ID;

/** One collection a provider forms: `meta`, or a rendition by its id. */
export interface NfxCollection {
  readonly id: string;
  /** The sha256 of each member, in collection order. */
  readonly members: readonly string[];
}

/** The `meta` collection's members: `root` (the hash list), then the rest in `files` order. */
export function metaMembers(root: string, list: nfx.HashList): string[] {
  return [
    root,
    ...list.files.filter((f) => f.role !== 'init' && f.role !== 'segment').map((f) => f.sha256),
  ];
}

/** A rendition collection's members: its init, then its segments in `playlistBytes`' order. */
export function renditionMembers(
  list: nfx.HashList,
  playlistBytes: Uint8Array,
): nfx.NfxResult<string[]> {
  const files = nfx.renditionMembers(list, playlistBytes);
  if (!files.ok) return files;
  return {
    ok: true,
    value: [files.value.init.sha256, ...files.value.segments.map((f) => f.sha256)],
  };
}

/**
 * Every collection of a video: `meta` first, then one per rendition in the hash list's order.
 * `playlist` gives a listed playlist's bytes by sha256 (already checked against it), or
 * `undefined` when there are none; a rendition whose playlist is missing or does not resolve
 * fails the whole video, so no collection is ever partial.
 */
export function nfxCollections(
  root: string,
  list: nfx.HashList,
  playlist: (sha256: string) => Uint8Array | undefined,
): nfx.NfxResult<NfxCollection[]> {
  const out: NfxCollection[] = [{ id: META_COLLECTION, members: metaMembers(root, list) }];
  for (const r of list.renditions) {
    const entry = list.files.find((f) => f.role === 'playlist' && f.name === r.playlist);
    const bytes = entry === undefined ? undefined : playlist(entry.sha256);
    if (bytes === undefined)
      return { ok: false, error: { kind: 'playlist', reason: `no playlist for ${r.id}` } };
    const members = renditionMembers(list, bytes);
    if (!members.ok) return members;
    out.push({ id: r.id, members: members.value });
  }
  return { ok: true, value: out };
}
