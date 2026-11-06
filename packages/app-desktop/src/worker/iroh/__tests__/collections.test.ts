/**
 * NFX-06 §2's collections (`../collections.ts`, moved from spike S-D's `nfx06.mjs`): `meta` is
 * the hash list then every non-init, non-segment file in `files` order; a rendition is its init
 * then its segments in PLAYLIST order, never `files` order; a playlist naming anything that is
 * not a listed file of the right role is refused, and so is the whole video.
 */
import { createHash } from 'node:crypto';

import type { nfx } from '@sovit/core';
import { describe, expect, it } from 'vitest';

import { META_COLLECTION, metaMembers, nfxCollections, renditionMembers } from '../collections.js';

const enc = new TextEncoder();
const sha = (b: Uint8Array | string): string =>
  createHash('sha256')
    .update(typeof b === 'string' ? enc.encode(b) : b)
    .digest('hex');
const ROOT = 'f0'.repeat(32);

function entry(name: string, role: nfx.Role, bytes: string): nfx.FileEntry {
  return {
    name,
    role,
    sha256: sha(bytes),
    size: BigInt(enc.encode(bytes).length),
    durMs: role === 'segment' ? 2000n : undefined,
  };
}

const INIT = entry('init.mp4', 'init', 'init');
const SEG = [0, 1, 2].map((i) => entry(`seg-${String(i)}.m4s`, 'segment', `segment ${String(i)}`));
const THUMB = entry('thumb.jpg', 'thumb', 'a thumbnail');
const SUBS = entry('en.vtt', 'subtitle', 'WEBVTT');
const MASTER = entry('master.m3u8', 'playlist-master', '#EXTM3U master');

/** A playlist over `segments` (by entry), in the order given. */
function playlistText(init: nfx.FileEntry, segments: readonly nfx.FileEntry[], extra = ''): string {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-MAP:URI="${init.sha256}.mp4"`,
    ...segments.flatMap((s) => ['#EXTINF:2.000,', `${s.sha256}.m4s`]),
    extra,
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
}

/**
 * Two renditions over one init: `high` lists the segments 0, 1, 2 and `low` 2, 0, 1, while the
 * hash list itself lists them 2, 0, 1 and mixes every role in.
 */
function video(lowText?: string): {
  list: nfx.HashList;
  playlists: Map<string, Uint8Array>;
  high: nfx.FileEntry;
  low: nfx.FileEntry;
} {
  const [s0, s1, s2] = SEG as [nfx.FileEntry, nfx.FileEntry, nfx.FileEntry];
  const highText = playlistText(INIT, [s0, s1, s2]);
  const lowBody = lowText ?? playlistText(INIT, [s2, s0, s1], '#EXT-X-INDEPENDENT-SEGMENTS');
  const high = entry('high.m3u8', 'playlist', highText);
  const low = entry('low.m3u8', 'playlist', lowBody);
  const list: nfx.HashList = {
    v: 1,
    video: `nfx:testnet:1:nutflix-${'c'.repeat(32)}`,
    files: [s2, MASTER, high, INIT, THUMB, s0, low, SUBS, s1],
    renditions: [
      {
        id: '720p',
        playlist: 'high.m3u8',
        bandwidth: 2n,
        codecs: undefined,
        resolution: undefined,
      },
      { id: '360p', playlist: 'low.m3u8', bandwidth: 1n, codecs: undefined, resolution: undefined },
    ],
  };
  const playlists = new Map([
    [high.sha256, enc.encode(highText)],
    [low.sha256, enc.encode(lowBody)],
  ]);
  return { list, playlists, high, low };
}

describe('NFX-06 §2 collections', () => {
  it('meta: the hash list, then every file not an init or a segment, in `files` order', () => {
    const { list, high, low } = video();
    expect(metaMembers(ROOT, list)).toEqual([
      ROOT,
      MASTER.sha256,
      high.sha256,
      THUMB.sha256,
      low.sha256,
      SUBS.sha256,
    ]);
  });

  it('a rendition: its init, then its segments in playlist order, not `files` order', () => {
    const { list, playlists, high, low } = video();
    const [s0, s1, s2] = SEG.map((s) => s.sha256);
    expect(renditionMembers(list, playlists.get(high.sha256)!)).toEqual({
      ok: true,
      value: [INIT.sha256, s0, s1, s2],
    });
    expect(renditionMembers(list, playlists.get(low.sha256)!)).toEqual({
      ok: true,
      value: [INIT.sha256, s2, s0, s1],
    });
  });

  it('every collection of a video: meta first, then the renditions in the hash list’s order', () => {
    const { list, playlists } = video();
    const all = nfxCollections(ROOT, list, (s) => playlists.get(s));
    if (!all.ok) throw new Error(all.error.reason);
    expect(all.value.map((c) => c.id)).toEqual([META_COLLECTION, '720p', '360p']);
    expect(META_COLLECTION).toBe('meta');
    expect(all.value[0]!.members).toEqual(metaMembers(ROOT, list));
    // Rendition collections hold only init and segment files (NFX-06 §2).
    const roles = new Map(list.files.map((f) => [f.sha256, f.role]));
    for (const c of all.value.slice(1))
      expect(new Set(c.members.map((m) => roles.get(m)))).toEqual(new Set(['init', 'segment']));
  });

  it('refuses a playlist naming a file the hash list does not list, and the whole video', () => {
    const [s0, s1] = SEG as [nfx.FileEntry, nfx.FileEntry];
    const stranger = entry('stranger.m4s', 'segment', 'not listed');
    const { list, playlists, low } = video(playlistText(INIT, [s0, stranger, s1]));
    const one = renditionMembers(list, playlists.get(low.sha256)!);
    expect(one.ok).toBe(false);
    if (!one.ok) expect(one.error.kind).toBe('playlist');
    expect(nfxCollections(ROOT, list, (s) => playlists.get(s)).ok).toBe(false);
  });

  it('refuses a listed file of the wrong role, a second init, and a playlist without either', () => {
    const [s0, s1] = SEG as [nfx.FileEntry, nfx.FileEntry];
    for (const text of [
      playlistText(INIT, [s0, THUMB, s1]),
      playlistText(s0, [s1]),
      playlistText(INIT, [s0], `#EXT-X-MAP:URI="${INIT.sha256}.mp4"`),
      playlistText(INIT, []),
      '#EXTM3U\n#EXT-X-ENDLIST\n',
    ]) {
      const { list, playlists, low } = video(text);
      expect(renditionMembers(list, playlists.get(low.sha256)!).ok, text).toBe(false);
      expect(nfxCollections(ROOT, list, (s) => playlists.get(s)).ok, text).toBe(false);
    }
  });

  it('refuses a video whose playlist bytes are missing: no collection is ever partial', () => {
    const { list, playlists, low } = video();
    const r = nfxCollections(ROOT, list, (s) => (s === low.sha256 ? undefined : playlists.get(s)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toContain('360p');
  });
});
