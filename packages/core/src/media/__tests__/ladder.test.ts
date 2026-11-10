import { describe, expect, it } from 'vitest';

import type { MediaProbe } from '../../contracts/media.js';
import { MediaError } from '../errors.js';
import { MAX_UPLOAD_HEIGHT, MAX_UPLOAD_SIZES } from '../../contracts/network-adapter.js';
import {
  ALL_SIZES_PRESET,
  LADDER_TIERS,
  MAX_RENDITION_HEIGHT,
  MAX_SIZES,
  STORYBOARD_MAX_TILES,
  chooseSizes,
  defaultSize,
  fitToHeight,
  fitToShortSide,
  isTierHeight,
  offeredSizes,
  planLadder,
  sizeSpec,
  sourceSize,
  sourceSizes,
  storyboardGeometry,
  thumbnailTimes,
} from '../ladder.js';

const src = (
  width: number,
  height: number,
  extra: Partial<NonNullable<MediaProbe['video']>> = {},
  durationSec = 120,
): MediaProbe => ({
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationSec,
  video: { codec: 'h264', width, height, fps: 30, ...extra },
  audio: { codec: 'aac', channels: 2, sampleRate: 48000 },
});

/** label/height/video/audio of each planned rendition. */
const specs = (plan: ReturnType<typeof planLadder>): string[] =>
  plan.renditions.map(
    (r) =>
      `${r.label} ${String(r.height)} ${String(r.videoBitrateKbps)}/${String(r.audioBitrateKbps)}`,
  );

describe('sizes (pear #97, the canonical rule shared with nfx ladder.rs)', () => {
  it('tiers: 2160p to 360p, tallest first, with their bitrates', () => {
    expect(
      LADDER_TIERS.map((t) => [t.label, t.height, t.videoBitrateKbps, t.audioBitrateKbps]),
    ).toEqual([
      ['2160p', 2160, 16000, 128],
      ['1440p', 1440, 8000, 128],
      ['1080p', 1080, 5000, 128],
      ['720p', 720, 2500, 128],
      ['480p', 480, 1200, 128],
      ['360p', 360, 800, 96],
    ]);
    expect(ALL_SIZES_PRESET).toEqual([1080, 720, 360]);
    expect(MAX_SIZES).toBe(MAX_UPLOAD_SIZES);
    expect(MAX_RENDITION_HEIGHT).toBe(MAX_UPLOAD_HEIGHT);
  });

  it('source size: the short side, even, at most 2160 and maxHeight', () => {
    expect(sourceSize(4320)).toBe(2160);
    expect(sourceSize(2160)).toBe(2160);
    expect(sourceSize(1081)).toBe(1080);
    expect(sourceSize(1080, 600)).toBe(600);
    expect(sourceSize(135)).toBe(134);
    expect(sourceSize(1)).toBe(2);
    expect(sourceSize(0)).toBe(2);
    expect(sourceSize(Number.NaN)).toBe(2);
  });

  it('offered sizes and the default, per the vectors', () => {
    const vectors: [number, number[], number][] = [
      [2160, [2160, 1440, 1080, 720, 480, 360], 720],
      [1440, [1440, 1080, 720, 480, 360], 720],
      [1080, [1080, 720, 480, 360], 720],
      [1000, [720, 480, 360, 1000], 720],
      [720, [720, 480, 360], 720],
      [576, [480, 360, 576], 576],
      [480, [480, 360], 480],
      [360, [360], 360],
      [240, [240], 240],
    ];
    for (const [H, offered, def] of vectors) {
      expect(offeredSizes(H), String(H)).toEqual(offered);
      expect(defaultSize(H), String(H)).toBe(def);
      expect(isTierHeight(H), String(H)).toBe(LADDER_TIERS.some((t) => t.height === H));
    }
    // 8K is the same as 2160 once capped.
    expect(offeredSizes(sourceSize(4320))).toEqual(offeredSizes(2160));
  });

  it('bitrates: tiers, interpolated originals, the old fallback below 360', () => {
    const v = (h: number, codec?: 'h264' | 'vp9' | 'av1'): [string, number, number] => {
      const s = sizeSpec(h, codec);
      return [s.label, s.videoBitrateKbps, s.audioBitrateKbps];
    };
    expect(v(2160)).toEqual(['2160p', 16000, 128]);
    expect(v(1440)).toEqual(['1440p', 8000, 128]);
    expect(v(1000)).toEqual(['1000p', 4444, 128]); // round(2500 + 2500 × 280 / 360)
    expect(v(718)).toEqual(['718p', 2489, 128]); // round(1200 + 1300 × 238 / 240)
    expect(v(576)).toEqual(['576p', 1720, 128]); // round(1200 + 1300 × 96 / 240)
    expect(v(362)).toEqual(['362p', 807, 128]); // round(800 + 400 × 2 / 120)
    expect(v(360)).toEqual(['360p', 800, 96]);
    expect(v(240)).toEqual(['240p', 533, 96]);
    expect(v(100)).toEqual(['100p', 222, 96]);
    expect(v(50)).toEqual(['50p', 200, 96]);
    expect(v(2160, 'vp9')).toEqual(['2160p', 11200, 128]);
    expect(v(576, 'vp9')).toEqual(['576p', 1204, 128]);
    expect(v(240, 'vp9')).toEqual(['240p', 373, 96]);
    expect(v(1080, 'av1')).toEqual(['1080p', 2750, 128]);
    expect(sizeSpec(720, 'vp9').container).toBe('webm');
    expect(sizeSpec(720, 'av1').container).toBe('mp4');
  });

  it('chooseSizes: the default, offered sizes kept, others to the tallest offered at or below', () => {
    expect(chooseSizes(1080)).toEqual([720]);
    expect(chooseSizes(1080, [])).toEqual([720]);
    expect(chooseSizes(480)).toEqual([480]);
    expect(chooseSizes(1080, [360, 1080])).toEqual([1080, 360]);
    // a remembered 1080 on a 576 source: the tallest offered size at or below it, the original
    expect(chooseSizes(576, [1080])).toEqual([576]);
    expect(chooseSizes(576, [1080, 720, 360])).toEqual([576, 360]);
    // a remembered original that this source does not offer
    expect(chooseSizes(1080, [1000])).toEqual([720]);
    // below every offered size: the shortest offered one
    expect(chooseSizes(1080, [240])).toEqual([360]);
    expect(chooseSizes(2160, [2160, 1440, 1080, 720, 480, 360])).toHaveLength(6);
  });

  it('sourceSizes: what studio.probe answers', () => {
    expect(sourceSizes(src(1920, 1000))).toEqual({
      height: 1000,
      sizes: [
        { height: 720, original: false, kbps: 2628 },
        { height: 480, original: false, kbps: 1328 },
        { height: 360, original: false, kbps: 896 },
        { height: 1000, original: true, kbps: 4572 },
      ],
      durationSec: 120,
    });
    expect(sourceSizes(src(1080, 1920, { rotation: 90 })).height).toBe(1080);
    expect(() => sourceSizes({ container: 'mp3', durationSec: 1 })).toThrow(MediaError);
  });
});

describe('planLadder', () => {
  it('default: one 720p h264 mp4 rendition for a 1080p source', () => {
    const plan = planLadder(src(1920, 1080));
    expect(plan.renditions).toEqual([
      {
        label: '720p',
        height: 720,
        videoBitrateKbps: 2500,
        audioBitrateKbps: 128,
        codec: 'h264',
        container: 'mp4',
      },
    ]);
  });

  it('default: never upscaled, a shorter source keeps its own height', () => {
    expect(specs(planLadder(src(1280, 720)))).toEqual(['720p 720 2500/128']);
    expect(specs(planLadder(src(1024, 576)))).toEqual(['576p 576 1720/128']);
    expect(specs(planLadder(src(854, 480)))).toEqual(['480p 480 1200/128']);
    expect(specs(planLadder(src(640, 360)))).toEqual(['360p 360 800/96']);
    expect(specs(planLadder(src(320, 240)))).toEqual(['240p 240 533/96']);
    expect(planLadder(src(200, 135)).renditions[0]?.height).toBe(134);
  });

  it('the creator picks sizes: one or more, tallest first, up to 2160p', () => {
    expect(specs(planLadder(src(3840, 2160), { sizes: [2160] }))).toEqual(['2160p 2160 16000/128']);
    expect(specs(planLadder(src(7680, 4320), { sizes: [2160, 360] }))).toEqual([
      '2160p 2160 16000/128',
      '360p 360 800/96',
    ]);
    expect(specs(planLadder(src(1920, 1080), { sizes: [360, 1080, 720] }))).toEqual([
      '1080p 1080 5000/128',
      '720p 720 2500/128',
      '360p 360 800/96',
    ]);
    expect(specs(planLadder(src(1920, 1000), { sizes: [1000] }))).toEqual(['1000p 1000 4444/128']);
  });

  it('refuses a size the source does not offer, naming the offered ones, and a size twice', () => {
    expect(() => planLadder(src(1024, 576), { sizes: [1080] })).toThrow(
      /^1080p is not offered for this source \(576 lines; never upscaled\): offered 480p, 360p, 576p$/,
    );
    expect(() => planLadder(src(1920, 1000), { sizes: [720, 1080] })).toThrow(
      /offered 720p, 480p, 360p, 1000p$/,
    );
    expect(() => planLadder(src(1920, 1080), { sizes: [720, 720] })).toThrow(/720p is named twice/);
    for (const sizes of [[1080], [720, 2160]])
      expect(() => planLadder(src(3840, 2160), { sizes })).not.toThrow();
  });

  it("'all' keeps the old ladder: 1080p/720p/360p capped at the source", () => {
    expect(planLadder(src(1920, 1080), { sizes: 'all' }).renditions.map((r) => r.label)).toEqual([
      '1080p',
      '720p',
      '360p',
    ]);
    expect(planLadder(src(3840, 2160), { sizes: 'all' }).renditions.map((r) => r.label)).toEqual([
      '1080p',
      '720p',
      '360p',
    ]);
    expect(planLadder(src(1280, 720), { sizes: 'all' }).renditions.map((r) => r.label)).toEqual([
      '720p',
      '360p',
    ]);
    expect(planLadder(src(854, 480), { sizes: 'all' }).renditions.map((r) => r.label)).toEqual([
      '360p',
    ]);
    const low = planLadder(src(320, 240), { sizes: 'all' });
    expect(specs(low)).toEqual(['240p 240 533/96']);
  });

  it('refuses sizes that are not heights', () => {
    for (const sizes of [[0], [1.5], [-720], [Number.NaN], Array.from({ length: 8 }, () => 720)])
      expect(() => planLadder(src(1920, 1080), { sizes }), JSON.stringify(sizes)).toThrow(
        MediaError,
      );
  });

  it('portrait: sizes key on the short side of the display (rotation applied)', () => {
    // 1080x1920 portrait, stored as such or as 1920x1080 with rotation 90: a 1080 source.
    for (const portrait of [src(1080, 1920), src(1920, 1080, { rotation: 90 })]) {
      expect(sourceSizes(portrait).height).toBe(1080);
      expect(sourceSizes(portrait).sizes.map((x) => x.height)).toEqual([1080, 720, 480, 360]);
      expect(specs(planLadder(portrait))).toEqual(['720p 720 2500/128']);
      expect(planLadder(portrait, { sizes: [1080, 360] }).renditions.map((r) => r.label)).toEqual([
        '1080p',
        '360p',
      ]);
      expect(() => planLadder(portrait, { sizes: [1440] })).toThrow(/offered 1080p, 720p/);
      expect(planLadder(portrait, { sizes: 'all' }).renditions.map((r) => r.label)).toEqual([
        '1080p',
        '720p',
        '360p',
      ]);
    }
    // A 4K portrait phone video (2160x3840) offers every tier; a 576x1024 one its own 576.
    expect(sourceSizes(src(2160, 3840)).height).toBe(2160);
    expect(sourceSizes(src(576, 1024)).sizes.map((x) => x.height)).toEqual([480, 360, 576]);
    expect(specs(planLadder(src(576, 1024)))).toEqual(['576p 576 1720/128']);
    // The old ladder never upscales the short side: a 720x1280 portrait has no 1080p.
    expect(planLadder(src(720, 1280), { sizes: 'all' }).renditions.map((r) => r.label)).toEqual([
      '720p',
      '360p',
    ]);
    // Square is landscape's rule.
    expect(sourceSizes(src(1080, 1080)).height).toBe(1080);
  });

  it('honours maxHeight and codec options', () => {
    const plan = planLadder(src(1920, 1080), { maxHeight: 720, codec: 'vp9', sizes: 'all' });
    expect(plan.renditions.map((r) => r.label)).toEqual(['720p', '360p']);
    expect(plan.renditions.every((r) => r.codec === 'vp9' && r.container === 'webm')).toBe(true);
    expect(plan.renditions[0]?.videoBitrateKbps).toBe(1750);
    expect(planLadder(src(1920, 1080), { codec: 'av1' }).renditions[0]?.container).toBe('mp4');
    expect(specs(planLadder(src(1920, 1080), { maxHeight: 576, sizes: [576] }))).toEqual([
      '576p 576 1720/128',
    ]);
    expect(specs(planLadder(src(1920, 1080), { maxHeight: 576 }))).toEqual(['576p 576 1720/128']);
  });

  it('throws no-video-stream for audio-only input', () => {
    const audioOnly: MediaProbe = {
      container: 'mp3',
      durationSec: 10,
      audio: { codec: 'mp3', channels: 2, sampleRate: 44100 },
    };
    expect(() => planLadder(audioOnly)).toThrow(MediaError);
  });

  it('adds thumbnail times and storyboard geometry', () => {
    const plan = planLadder(src(1920, 1080, {}, 100));
    expect(plan.thumbnailTimes).toEqual([10, 30, 50, 70]);
    expect(plan.storyboard).toEqual({ intervalSec: 1, cols: 10, rows: 10, tileWidth: 160 });
  });
});

describe('fitToShortSide (pear #97)', () => {
  it('scales the short side to the size, the other side by aspect, even', () => {
    expect(fitToShortSide({ width: 1920, height: 1080 }, 720)).toEqual({
      width: 1280,
      height: 720,
    });
    expect(fitToShortSide({ width: 1080, height: 1920 }, 720)).toEqual({
      width: 720,
      height: 1280,
    });
    expect(fitToShortSide({ width: 2160, height: 3840 }, 2160)).toEqual({
      width: 2160,
      height: 3840,
    });
    expect(fitToShortSide({ width: 1080, height: 1080 }, 360)).toEqual({ width: 360, height: 360 });
    // odd results are made even, as fitToHeight does
    expect(fitToShortSide({ width: 3, height: 4 }, 361)).toEqual({ width: 360, height: 480 });
    expect(fitToShortSide({ width: 1080, height: 1921 }, 720)).toEqual({
      width: 720,
      height: 1282,
    });
  });
});

describe('fitToHeight', () => {
  it('keeps aspect and even dimensions', () => {
    expect(fitToHeight({ width: 1920, height: 1080 }, 720)).toEqual({ width: 1280, height: 720 });
    expect(fitToHeight({ width: 1920, height: 1080 }, 360)).toEqual({ width: 640, height: 360 });
    expect(fitToHeight({ width: 1080, height: 1920 }, 720)).toEqual({ width: 406, height: 720 });
    expect(fitToHeight({ width: 4, height: 3 }, 361)).toEqual({ width: 480, height: 360 });
  });
});

describe('thumbnailTimes', () => {
  it('spreads through the clip, never past the end, and dedups', () => {
    expect(thumbnailTimes(10)).toEqual([1, 3, 5, 7]);
    expect(thumbnailTimes(0)).toEqual([0]);
    expect(thumbnailTimes(Number.NaN)).toEqual([0]);
    expect(thumbnailTimes(0.001)).toEqual([0]);
    for (const t of thumbnailTimes(0.5)) expect(t).toBeLessThan(0.5);
  });
});

describe('storyboardGeometry', () => {
  it('picks the smallest interval that keeps tiles ≤ max', () => {
    expect(storyboardGeometry(30)).toEqual({ intervalSec: 1, cols: 10, rows: 3, tileWidth: 160 });
    expect(storyboardGeometry(101)?.intervalSec).toBe(2);
    expect(storyboardGeometry(3600)?.intervalSec).toBe(60);
    const long = storyboardGeometry(6 * 3600);
    expect(long && Math.ceil((6 * 3600) / long.intervalSec)).toBeLessThanOrEqual(
      STORYBOARD_MAX_TILES,
    );
    expect(storyboardGeometry(3)).toEqual({ intervalSec: 1, cols: 3, rows: 1, tileWidth: 160 });
    expect(storyboardGeometry(0)).toBeUndefined();
  });
});
