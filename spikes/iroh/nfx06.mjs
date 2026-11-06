// NFX-06 §2 over the iroh helper, for spike S-D: the fetch that re-anchors every file to sha256
// (nfx-node `fetch.rs`). Spike code. How a verified hash list maps onto iroh collections
// (nfx-node `video.rs`) moved into the worker with slice 5e-3 (`worker/iroh/collections.ts`);
// this imports it from there.
//
// The helper's word is never taken for the bytes: the client's `getFile` returns a file only if
// its sha256 is the one the signed hash list gives, by position (NFX-05 §4; nfx ADR 0103,
// sharp edge 1), and `getSeq` returns only hashes to ask for.
import { nfx } from '@sovit/core';

import {
  PoisonedError,
  metaMembers,
  renditionMembers as renditionCollection,
} from '../../packages/app-desktop/dist/worker/iroh/index.js';

export { PoisonedError, metaMembers };

/** Largest hash list fetched before its sha256 is known (nfx-node `MAX_HASH_LIST_BYTES`). */
export const MAX_HASH_LIST_BYTES = 16 * 1024 * 1024;

/** A rendition collection's sha256 values (the worker's), or a throw when it does not resolve. */
export function renditionMembers(list, playlistBytes) {
  const members = renditionCollection(list, playlistBytes);
  if (!members.ok) throw new Error(`playlist: ${members.error.reason}`);
  return members.value;
}

function entry(list, sha) {
  const e = list.files.find((f) => f.sha256 === sha);
  if (e === undefined) throw new Error(`${sha} is not listed`);
  if (e.size < 1n || e.size > 64n * 1024n * 1024n)
    throw new Error(`a file of ${e.size} bytes is outside the spike's cap`);
  return e;
}

/**
 * Fetch `manifest`'s video from one beacon iroh endpoint through `helper`. Returns the verified
 * hash list and every file's bytes by sha256, or throws `PoisonedError` when the source sent
 * anything the hash list contradicts (the caller drops it) and `Error` for anything else.
 */
export async function fetchVideo(helper, endpoint, manifest, networkRelays) {
  const conns = [];
  const open = async (ticket, what) => {
    if (ticket === undefined) throw new Error(`no ${what} ticket`);
    const dialed = await helper.dialTicket(ticket, endpoint.node, networkRelays);
    if (dialed === null) throw new Error(`the ${what} ticket names another node or no collection`);
    conns.push(dialed.conn);
    return dialed;
  };
  try {
    const meta = await open(endpoint.tickets.get('meta'), 'meta');
    if (manifest.segs > 100_000n) throw new Error('segs is outside the spike');
    // NFX-06 §2: the collection alone first, capped at one member per file the manifest allows.
    const members = await helper.getSeq(meta.conn, meta.hash, {
      maxMembers: Number(manifest.segs) + 1,
    });
    const listBytes = await helper.getFile(meta.conn, members[0], {
      sha256: manifest.root,
      maxBytes: MAX_HASH_LIST_BYTES,
    });
    const verified = nfx.verifyHashListFor(listBytes, manifest);
    if (!verified.ok) throw new PoisonedError(`hash list: ${verified.error.reason}`);
    const list = verified.value;
    const files = new Map([[manifest.root, listBytes]]);
    const expected = metaMembers(manifest.root, list);
    if (members.length !== expected.length) throw new PoisonedError('meta: member count');
    for (let i = 1; i < expected.length; i += 1) {
      const e = entry(list, expected[i]);
      const bytes = await helper.getFile(meta.conn, members[i], {
        sha256: e.sha256,
        maxBytes: Number(e.size),
      });
      if (e.role === 'playlist' || e.role === 'playlist-master') {
        if (!nfx.checkPlaylist(list, bytes).ok)
          throw new PoisonedError(`meta member ${i}: playlist`);
      }
      files.set(e.sha256, bytes);
    }
    for (const r of list.renditions) {
      const at = await open(endpoint.tickets.get(r.id), r.id);
      const playlist = list.files.find((f) => f.name === r.playlist);
      const playlistBytes = playlist === undefined ? undefined : files.get(playlist.sha256);
      if (playlistBytes === undefined) throw new Error(`no playlist for ${r.id}`);
      const want = renditionMembers(list, playlistBytes);
      const got = await helper.getSeq(at.conn, at.hash, { maxMembers: want.length, exact: true });
      for (let i = 0; i < want.length; i += 1) {
        const e = entry(list, want[i]);
        files.set(
          e.sha256,
          await helper.getFile(at.conn, got[i], { sha256: e.sha256, maxBytes: Number(e.size) }),
        );
      }
    }
    return { list, files, listBytes };
  } finally {
    for (const conn of conns) await helper.hangup(conn).catch(() => false);
  }
}
