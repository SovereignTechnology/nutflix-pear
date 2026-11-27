/** A two-rendition NFX package for the keep tests: real playlists naming files by content name. */
import { nfx } from '@sovit/core';

import { adapters } from './helpers.js';

const enc = new TextEncoder();

export function sha(bytes: Uint8Array): string {
  const h = adapters.crypto.createSha256();
  h.update(bytes);
  return h.digestHex();
}

export function addr(id: string): nfx.VideoAddr {
  // A video id is 7 to 63 of [a-z0-9-] (NFX-01): the tests' short names get a prefix.
  const a = nfx.VideoAddr.parse(`nfx:regtest:1:kept-video-${id}`);
  if (!a.ok) throw new Error(a.error.reason);
  return a.value;
}

export interface Rend {
  readonly playlist: Uint8Array;
  readonly init: string;
  readonly segments: readonly string[];
}

export interface Pkg {
  readonly video: nfx.VideoAddr;
  readonly root: string;
  readonly segs: bigint;
  readonly hashListBytes: Uint8Array;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly meta: readonly string[];
  readonly r: Readonly<Record<string, Rend>>;
}

/**
 * Two renditions, 720p and 360p, each an init and `n` segments named by content name in a
 * real playlist (NFX-05 §3), plus a master playlist. `shared` is one segment both carry.
 */
export function pkg(id: string, n = 2, shared?: Uint8Array): Pkg {
  const video = addr(id);
  const files = new Map<string, Uint8Array>();
  const entries: nfx.FileEntry[] = [];
  const entry = (name: string, role: nfx.FileEntry['role'], bytes: Uint8Array): string => {
    files.set(sha(bytes), bytes);
    entries.push({
      name,
      role,
      sha256: sha(bytes),
      size: BigInt(bytes.byteLength),
      durMs: role === 'segment' ? 2000n : undefined,
    });
    return sha(bytes);
  };
  const r: Record<string, Rend> = {};
  const playlists: [string, Uint8Array][] = [];
  for (const id2 of ['720p', '360p']) {
    const init = entry(`${id2}-init.mp4`, 'init', enc.encode(`init ${id} ${id2}`));
    const segments: string[] = [];
    for (let i = 0; i < n; i += 1)
      segments.push(
        entry(
          `${id2}-seg_${i}.m4s`,
          'segment',
          enc.encode(`segment ${id} ${id2} ${i} `.padEnd(100 + i, '.')),
        ),
      );
    if (shared !== undefined) segments.push(entry(`${id2}-shared.m4s`, 'segment', shared));
    const text =
      `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="${init}.mp4"\n` +
      segments.map((s) => `#EXTINF:2.000,\n${s}.m4s\n`).join('') +
      `#EXT-X-ENDLIST\n# ${id}\n`;
    const playlist = enc.encode(text);
    playlists.push([id2, playlist]);
    r[id2] = { playlist, init, segments: [...new Set(segments)] };
  }
  for (const [id2, playlist] of playlists) entry(`r${id2}.m3u8`, 'playlist', playlist);
  entry('master.m3u8', 'playlist-master', enc.encode(`#EXTM3U\n# master ${id}\n`));
  const list: nfx.HashList = {
    v: 1,
    video: video.toString(),
    files: entries.filter((e, i) => entries.findIndex((o) => o.name === e.name) === i),
    renditions: ['720p', '360p'].map((id2) => ({
      id: id2,
      playlist: `r${id2}.m3u8`,
      bandwidth: 1000n,
      codecs: undefined,
      resolution: undefined,
    })),
  };
  const hashListBytes = nfx.renderHashList(list);
  const root = sha(hashListBytes);
  const meta = [
    root,
    ...list.files.filter((f) => f.role !== 'init' && f.role !== 'segment').map((f) => f.sha256),
  ];
  return { video, root, segs: BigInt(list.files.length), hashListBytes, files, meta, r };
}
