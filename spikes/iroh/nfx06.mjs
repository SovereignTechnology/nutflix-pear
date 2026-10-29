// NFX-06 §2 over the iroh helper, for spike S-D: how a verified hash list maps onto iroh
// collections (nfx-node `video.rs`), and the fetch that re-anchors every file to sha256
// (nfx-node `fetch.rs`). Spike code: slice 5 moves what survives into the worker.
//
// The helper's word is never taken for the bytes: every file is checked against the signed hash
// list here (NFX-05 §4), by position, before it is kept (nfx ADR 0103, sharp edge 1).
import { nfx } from '@sovit/core';

import { dialTarget } from '../../packages/app-desktop/dist/worker/iroh/index.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Largest hash list fetched before its sha256 is known (nfx-node `MAX_HASH_LIST_BYTES`). */
export const MAX_HASH_LIST_BYTES = 16 * 1024 * 1024;

export class Poisoned extends Error {
  constructor(what) {
    super(`poisoned: ${what}`);
    this.what = what;
  }
}

/** The meta collection's sha256 values: root, then every file that is not an init or segment. */
export function metaMembers(root, list) {
  return [
    root,
    ...list.files.filter((f) => f.role !== 'init' && f.role !== 'segment').map((f) => f.sha256),
  ];
}

/** A rendition collection's sha256 values: its init, then its segments in playlist order. */
export function renditionMembers(list, playlistBytes) {
  const text = utf8.decode(playlistBytes);
  let init;
  const segments = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('#EXT-X-MAP:')) {
      const uri = /URI="([^"]*)"/.exec(line)?.[1] ?? '';
      const f = nfx.resolveContentName(list, uri);
      if (f?.role !== 'init' || init !== undefined) throw new Error('playlist: not one init');
      init = f.sha256;
    } else if (line !== '' && !line.startsWith('#')) {
      const f = nfx.resolveContentName(list, line);
      if (f?.role !== 'segment') throw new Error(`playlist: ${line} is not a segment`);
      segments.push(f.sha256);
    }
  }
  if (init === undefined || segments.length === 0) throw new Error('playlist: no init or segments');
  return [init, ...segments];
}

export function entryOf(list, root, hashListBytes, sha) {
  if (sha === root) return { sha256: root, size: BigInt(hashListBytes.length), role: 'hash-list' };
  const e = list.files.find((f) => f.sha256 === sha);
  if (e === undefined) throw new Error(`${sha} is not listed`);
  return e;
}

/** A HashSeq blob's member hashes (32 bytes each), as hex. */
export function seqMembers(bytes, what) {
  if (bytes.length === 0 || bytes.length % 32 !== 0) throw new Poisoned(`${what}: not a HashSeq`);
  const out = [];
  for (let i = 0; i < bytes.length; i += 32)
    out.push(Buffer.from(bytes.subarray(i, i + 32)).toString('hex'));
  return out;
}

function cap(size) {
  if (size < 1n || size > 64n * 1024n * 1024n)
    throw new Error(`a file of ${size} bytes is outside the spike's cap`);
  return Number(size);
}

/**
 * Fetch `manifest`'s video from one beacon iroh endpoint through `helper`. Returns the verified
 * hash list and every file's bytes by sha256, or throws `Poisoned` for a file that does not
 * match (the caller drops that source) and `Error` for anything else.
 */
export async function fetchVideo(helper, endpoint, manifest, networkRelays) {
  const tickets = endpoint.tickets;
  const conns = new Map();
  const target = async (ticketText, what) => {
    if (ticketText === undefined) throw new Error(`no ${what} ticket`);
    const t = await helper.ticket(ticketText);
    const where = dialTarget(t, endpoint.node, networkRelays);
    if (where === null) throw new Error(`${what} ticket names another node or is not a collection`);
    let conn = conns.get(t.node);
    if (conn === undefined) {
      conn = await helper.dial(where);
      conns.set(t.node, conn);
    }
    return { conn, hash: t.hash };
  };
  try {
    const meta = await target(tickets.get('meta'), 'meta');
    const segs = manifest.segs;
    if (segs > 100_000n) throw new Error('segs is outside the spike');
    // NFX-06 §2: the collection alone first, capped at 32 bytes per member the manifest allows.
    const members = seqMembers(
      await helper.get(meta.conn, meta.hash, (Number(segs) + 1) * 32),
      'meta',
    );
    const listBytes = await helper.get(meta.conn, members[0], MAX_HASH_LIST_BYTES);
    const verified = nfx.verifyHashListFor(listBytes, manifest);
    if (!verified.ok) throw new Poisoned(`hash list: ${verified.error.reason}`);
    const list = verified.value;
    const files = new Map([[manifest.root, listBytes]]);
    const expected = metaMembers(manifest.root, list);
    if (members.length !== expected.length) throw new Poisoned('meta: member count');
    for (let i = 1; i < expected.length; i += 1) {
      const entry = entryOf(list, manifest.root, listBytes, expected[i]);
      const bytes = await helper.get(meta.conn, members[i], cap(entry.size));
      if (!nfx.verifyFile(entry.sha256, bytes).ok) throw new Poisoned(`meta member ${i}`);
      if (entry.role === 'playlist' || entry.role === 'playlist-master') {
        if (!nfx.checkPlaylist(list, bytes).ok) throw new Poisoned(`meta member ${i}: playlist`);
      }
      files.set(entry.sha256, bytes);
    }
    for (const r of list.renditions) {
      const at = await target(tickets.get(r.id), r.id);
      const playlist = list.files.find((f) => f.name === r.playlist);
      const playlistBytes = playlist === undefined ? undefined : files.get(playlist.sha256);
      if (playlistBytes === undefined) throw new Error(`no playlist for ${r.id}`);
      const want = renditionMembers(list, playlistBytes);
      const got = seqMembers(await helper.get(at.conn, at.hash, want.length * 32), r.id);
      if (got.length !== want.length) throw new Poisoned(`${r.id}: member count`);
      for (let i = 0; i < want.length; i += 1) {
        const entry = entryOf(list, manifest.root, listBytes, want[i]);
        const bytes = await helper.get(at.conn, got[i], cap(entry.size));
        if (!nfx.verifyFile(entry.sha256, bytes).ok) throw new Poisoned(`${r.id} member ${i}`);
        files.set(entry.sha256, bytes);
      }
    }
    return { list, files, listBytes };
  } finally {
    for (const conn of conns.values()) await helper.hangup(conn).catch(() => false);
  }
}
