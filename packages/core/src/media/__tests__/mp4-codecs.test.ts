/**
 * CODECS from hand-built init segments, plus malformed input (nfx-media `tests/mp4.rs`, ported).
 */
import { describe, expect, it } from 'vitest';

import { MediaError } from '../errors.js';
import { childBoxes, initCodecs } from '../mp4-codecs.js';
import {
  avcEntry,
  box,
  concat,
  h264AacInit,
  initSegment,
  mp4aEntry,
  trakBox,
} from '../testing/fakes.js';

const u8 = (...n: number[]): Uint8Array => new Uint8Array(n);

describe('initCodecs', () => {
  it('reads H.264 High and AAC-LC from avcC and esds', () => {
    expect(initCodecs(h264AacInit())).toEqual(['avc1.640028', 'mp4a.40.2']);
  });

  it('lists video first even when the audio track comes first', () => {
    const init = initSegment([
      trakBox(mp4aEntry(u8(0x12, 0x10))),
      trakBox(avcEntry(0x4d, 0x40, 0x1f)),
    ]);
    expect(initCodecs(init)).toEqual(['avc1.4d401f', 'mp4a.40.2']);
  });

  it('decodes the AAC object-type escape (31 → 32 + the next 6 bits)', () => {
    const escaped = u8(0b1111_1001, 0b0100_0000); // 32 + 10 = 42
    const init = initSegment([trakBox(avcEntry(0x64, 0, 0x1e)), trakBox(mp4aEntry(escaped))]);
    expect(initCodecs(init)[1]).toBe('mp4a.40.42');
  });

  it('keeps the avc3 prefix and reads an esds without AudioSpecificConfig as mp4a.OO', () => {
    const init = initSegment([
      trakBox(avcEntry(0x64, 0, 0x1f, 'avc3')),
      trakBox(mp4aEntry(new Uint8Array(0))),
    ]);
    expect(initCodecs(init)).toEqual(['avc3.64001f', 'mp4a.40']);
  });

  it('reads a video-only init segment', () => {
    expect(initCodecs(initSegment([trakBox(avcEntry(0x64, 0, 0x28))]))).toEqual(['avc1.640028']);
  });
});

describe('childBoxes', () => {
  it('reads 64-bit and to-the-end box sizes', () => {
    const big = concat([
      u8(0, 0, 0, 1),
      new TextEncoder().encode('free'),
      u8(0, 0, 0, 0, 0, 0, 0, 20),
      u8(0, 0, 0, 0),
    ]);
    const tail = concat([u8(0, 0, 0, 0), new TextEncoder().encode('mdat'), u8(9, 9, 9)]);
    const parsed = childBoxes(concat([big, tail]));
    expect(parsed.map((b) => b.type)).toEqual(['free', 'mdat']);
    expect(parsed[0]?.body.length).toBe(4);
    expect([...(parsed[1]?.body ?? [])]).toEqual([9, 9, 9]);
  });
});

describe('malformed input is a MediaError, never another throw', () => {
  it('at every truncation of a good init segment', () => {
    const good = h264AacInit();
    for (let cut = 0; cut < good.length; cut++) {
      expect(() => initCodecs(good.subarray(0, cut)), String(cut)).toThrow(MediaError);
    }
  });

  it('for a size past its parent, a size under its own header, and no moov', () => {
    const lying = box('moov', new Uint8Array(8));
    lying[3] = 200;
    expect(() => initCodecs(lying)).toThrow(MediaError);
    const tiny = box('moov', new Uint8Array(0));
    tiny[3] = 4;
    expect(() => childBoxes(tiny)).toThrow(MediaError);
    expect(() => initCodecs(box('ftyp', u8(0x78)))).toThrow(/missing 'moov'/);
  });

  it('for a descriptor that overruns its box or has a five-byte size', () => {
    const overrun = initSegment([
      trakBox(avcEntry(0x64, 0, 0x28)),
      trakBox(
        box('mp4a', concat([new Uint8Array(28), box('esds', u8(0, 0, 0, 0, 0x03, 0x7f, 1))])),
      ),
    ]);
    expect(() => initCodecs(overrun)).toThrow(/overruns/);
    const fiveByte = initSegment([
      trakBox(avcEntry(0x64, 0, 0x28)),
      trakBox(
        box(
          'mp4a',
          concat([
            new Uint8Array(28),
            box('esds', u8(0, 0, 0, 0, 0x03, 0x80, 0x80, 0x80, 0x80, 0x01)),
          ]),
        ),
      ),
    ]);
    expect(() => initCodecs(fiveByte)).toThrow(/too long/);
  });

  it('refuses a codec NFX does not package (HEVC) as unsupported-input', () => {
    const hevc = box('hvc1', concat([new Uint8Array(78), box('hvcC', u8(1, 2, 3, 4))]));
    let err: unknown;
    try {
      initCodecs(initSegment([trakBox(hevc)]));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).code).toBe('unsupported-input');
  });
});
