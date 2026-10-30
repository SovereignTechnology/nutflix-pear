/**
 * A rendition as one progressive file (spike S-E): its members from the playlist, the layout,
 * and `locate`, which turns a player's byte range into bounded reads and refuses anything else.
 */
import { describe, expect, it } from 'vitest';

import type { FileEntry, HashList } from '../hashlist.js';
import { renditionMembers } from '../hashlist.js';
import { locate, progressiveLayout } from '../progressive.js';

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const I = '11'.repeat(32);
const S1 = '22'.repeat(32);
const S2 = '33'.repeat(32);
const P = '44'.repeat(32);

const entry = (name: string, role: FileEntry['role'], sha256: string, size: bigint): FileEntry => ({
  name,
  role,
  sha256,
  size,
  durMs: role === 'segment' ? 2000n : undefined,
});
const list: HashList = {
  v: 1,
  video: 'nfx:regtest:1:progressive',
  files: [
    entry('r720p.m3u8', 'playlist', P, 100n),
    entry('init-720p.mp4', 'init', I, 900n),
    entry('720p-seg_00000.m4s', 'segment', S1, 5000n),
    entry('720p-seg_00001.m4s', 'segment', S2, 4000n),
  ],
  renditions: [
    { id: '720p', playlist: 'r720p.m3u8', bandwidth: 1n, codecs: undefined, resolution: undefined },
  ],
};
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const playlist = (body: string): Uint8Array =>
  utf8(`#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n${body}#EXT-X-ENDLIST\n`);
const good = `#EXT-X-MAP:URI="${I}.mp4"\n#EXTINF:2.000,\n${S1}.m4s\n#EXTINF:2.000,\n${S2}.m4s\n`;

describe('renditionMembers', () => {
  it('gives the init and the segments in playlist order', () => {
    const r = renditionMembers(list, playlist(good));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.init.sha256).toBe(I);
    expect(r.value.segments.map((s) => s.sha256)).toEqual([S1, S2]);
    // The playlist's order, not the hash list's.
    const swapped = `#EXT-X-MAP:URI="${I}.mp4"\n${S2}.m4s\n${S1}.m4s\n`;
    const s = renditionMembers(list, playlist(swapped));
    expect(s.ok && s.value.segments.map((x) => x.sha256)).toEqual([S2, S1]);
  });

  it('refuses a playlist naming what is not listed, or a file of the wrong role', () => {
    for (const body of [
      `#EXT-X-MAP:URI="${I}.mp4"\n${'55'.repeat(32)}.m4s\n`, // unlisted
      `#EXT-X-MAP:URI="${S1}.m4s"\n${S2}.m4s\n`, // a segment as the init
      `#EXT-X-MAP:URI="${I}.mp4"\n${I}.mp4\n`, // the init as a segment
      `#EXT-X-MAP:URI="${I}.mp4"\n#EXT-X-MAP:URI="${I}.mp4"\n${S1}.m4s\n`, // two inits
      `#EXT-X-MAP:URI="${I}.mp4",URI="${I}.mp4"\n${S1}.m4s\n`, // two URIs on one map
      `${S1}.m4s\n`, // no init
      `#EXT-X-MAP:URI="${I}.mp4"\n`, // no segment
      `#EXT-X-MAP:URI="${I}.mp4"\n ${S1}.m4s\n`, // a name with a space, not trimmed into one
    ])
      expect(renditionMembers(list, playlist(body)).ok, body).toBe(false);
    expect(renditionMembers(list, new Uint8Array([0xc3, 0x28])).ok).toBe(false);
  });
});

describe('progressiveLayout and locate', () => {
  const sidx = new Uint8Array(10).fill(9);
  const layout = progressiveLayout([
    { kind: 'bytes', bytes: sidx },
    { kind: 'file', sha256: A, size: 100 },
    { kind: 'file', sha256: B, size: 50 },
  ]);

  it('lays the parts end to end', () => {
    expect(layout.size).toBe(160);
    expect(layout.parts.map((p) => [p.offset, p.size])).toEqual([
      [0, 10],
      [10, 100],
      [110, 50],
    ]);
  });

  it('turns a range into reads across part boundaries', () => {
    expect(locate(layout, 5, 10).map((p) => [p.part.kind, p.offset, p.length])).toEqual([
      ['bytes', 5, 5],
      ['file', 0, 5],
    ]);
    const whole = locate(layout, 0, 160);
    expect(whole.reduce((n, p) => n + p.length, 0)).toBe(160);
    expect(locate(layout, 159, 1)).toEqual([
      { part: layout.parts[2]!.part, offset: 49, length: 1 },
    ]);
  });

  it('splits a read past maxRead, so no store read exceeds its cap', () => {
    expect(locate(layout, 10, 100, 30).map((p) => [p.offset, p.length])).toEqual([
      [0, 30],
      [30, 30],
      [60, 30],
      [90, 10],
    ]);
  });

  it('refuses a range not wholly inside the view, instead of clamping it', () => {
    for (const [o, n] of [
      [0, 161],
      [160, 1],
      [-1, 5],
      [0, 0],
      [1.5, 2],
      [0, Number.MAX_SAFE_INTEGER],
    ] as const)
      expect(() => locate(layout, o, n), `${String(o)}+${String(n)}`).toThrow(RangeError);
    expect(() => locate(layout, 0, 1, 0)).toThrow(RangeError);
  });

  it('refuses an empty part, a part that is not a sha256, and no parts', () => {
    expect(() => progressiveLayout([])).toThrow(RangeError);
    expect(() => progressiveLayout([{ kind: 'bytes', bytes: new Uint8Array(0) }])).toThrow(
      RangeError,
    );
    expect(() => progressiveLayout([{ kind: 'file', sha256: 'A'.repeat(64), size: 1 }])).toThrow(
      RangeError,
    );
    expect(() => progressiveLayout([{ kind: 'file', sha256: A, size: 0 }])).toThrow(RangeError);
  });
});
