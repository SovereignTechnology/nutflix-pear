import type { LadderPlan, MediaProbe, RenditionSpec } from '../contracts/media.js';
import type { SourceSizes } from '../contracts/network-adapter.js';
import { MediaError } from './errors.js';
import { displayDimensions } from './ffprobe.js';

/**
 * Rendition sizes (build-plan §6.4; pear #97, the maintainer's decisions of 2026-11-09): the
 * creator picks one or more sizes for each upload, never upscaled and never above 2160p, and a
 * single 720p rendition is the default until the network grows. The old ladder (1080p / 720p /
 * 360p) stays as the `'all'` preset.
 *
 * The same rule, labels and bitrates as nfx's `crates/nfx-media/src/ladder.rs`, so a video
 * packaged by either side looks the same:
 *
 * - **Sizes key on the short side** of the display dimensions (rotation applied): a size is the
 *   short side's lines, the other side follows the aspect ratio (even). A portrait 1080x1920
 *   video is a 1080 source, and its 720p is 720x1280; landscape is as before.
 * - **Source size** S: the short side, made even, at most 2160 (and at most `maxHeight`).
 * - **Offered sizes:** every tier at or below S, tallest first, then S itself (`${S}p`, the
 *   "original") when S is no tier.
 * - **A non-tier size h** interpolates linearly between the tiers around it (audio 128); below
 *   the lowest tier it is today's fallback, `round(800 × h / 360)`, audio 96; off a tier the
 *   video bitrate is `max(200, round(vk × scale))`.
 * - **Default:** 720p when S ≥ 720, else `${S}p`.
 * - **Chosen sizes** must each be offered (a size the source does not offer is refused, naming
 *   the offered ones, before anything is encoded), named once; they are planned tallest first.
 *
 * Bitrates are the usual H.264 streaming targets; VP9/AV1 scale them down since those codecs are
 * more efficient at the same quality.
 */

export interface Tier {
  readonly label: string;
  readonly height: number;
  readonly videoBitrateKbps: number;
  readonly audioBitrateKbps: number;
}

/** Every tier, tallest first. */
export const LADDER_TIERS: readonly Tier[] = [
  { label: '2160p', height: 2160, videoBitrateKbps: 16000, audioBitrateKbps: 128 },
  { label: '1440p', height: 1440, videoBitrateKbps: 8000, audioBitrateKbps: 128 },
  { label: '1080p', height: 1080, videoBitrateKbps: 5000, audioBitrateKbps: 128 },
  { label: '720p', height: 720, videoBitrateKbps: 2500, audioBitrateKbps: 128 },
  { label: '480p', height: 480, videoBitrateKbps: 1200, audioBitrateKbps: 128 },
  { label: '360p', height: 360, videoBitrateKbps: 800, audioBitrateKbps: 96 },
];

/** The tallest rendition made: a taller source is scaled down to it. */
export const MAX_RENDITION_HEIGHT = 2160 as const;
/** The default: one rendition of this height, or the source's own when it is shorter. */
export const DEFAULT_RENDITION_HEIGHT = 720 as const;
/** The old ladder, kept as the `'all'` preset: these tiers, capped at the source. */
export const ALL_SIZES_PRESET: readonly number[] = [1080, 720, 360];
/** The longest duration `sourceSizes` reports, seconds (the desktop IPC's bound). */
export const MAX_PROBED_DURATION_SEC = 10_000_000;
/** The most sizes one plan names (every tier and the original). */
export const MAX_SIZES = LADDER_TIERS.length + 1;

/**
 * What a plan encodes: `'all'` (the old ladder, `ALL_SIZES_PRESET`, capped at the source), or
 * sizes, each one of the source's offered sizes (`offeredSizes`) and named once. Absent or
 * empty: the default, one rendition (`defaultSize`).
 */
export type LadderSizes = 'all' | readonly number[];

/** Keyframe interval in seconds — identical for every rendition so switches align. */
export const GOP_SECONDS = 2 as const;

/** Thumbnail candidate positions as fractions of the duration. */
export const THUMBNAIL_FRACTIONS: readonly number[] = [0.1, 0.3, 0.5, 0.7];

export const STORYBOARD_COLS = 10 as const;
export const STORYBOARD_TILE_WIDTH = 160 as const;
/** Storyboards aim for at most this many tiles; interval is picked from the list below. */
export const STORYBOARD_MAX_TILES = 100 as const;
const STORYBOARD_INTERVALS: readonly number[] = [1, 2, 5, 10, 20, 30, 60, 120, 300];

const codecContainer = (codec: RenditionSpec['codec']): RenditionSpec['container'] =>
  codec === 'vp9' ? 'webm' : 'mp4';

const bitrateScale = (codec: RenditionSpec['codec']): number =>
  codec === 'h264' ? 1 : codec === 'vp9' ? 0.7 : 0.55;

/** Even output size preserving aspect for a target height. */
export function fitToHeight(
  src: { readonly width: number; readonly height: number },
  height: number,
): { readonly width: number; readonly height: number } {
  const h = height - (height % 2);
  const w = Math.round((src.width * h) / src.height);
  return { width: w + (w % 2), height: h };
}

/**
 * Even output size preserving aspect with its SHORT side `size` lines (pear #97: sizes key on
 * the short side): `fitToHeight` for landscape and square, the same with the sides swapped for
 * portrait.
 */
export function fitToShortSide(
  src: { readonly width: number; readonly height: number },
  size: number,
): { readonly width: number; readonly height: number } {
  if (src.width >= src.height) return fitToHeight(src, size);
  const t = fitToHeight({ width: src.height, height: src.width }, size);
  return { width: t.height, height: t.width };
}

/** The short side of display dimensions. */
export function shortSide(display: { readonly width: number; readonly height: number }): number {
  return Math.min(display.width, display.height);
}

/** Thumbnail candidate timestamps for a duration, deduplicated and inside the clip. */
export function thumbnailTimes(durationSec: number): readonly number[] {
  if (!(durationSec > 0)) return [0];
  const times = THUMBNAIL_FRACTIONS.map((f) => Math.floor(durationSec * f * 1000) / 1000);
  const uniq = [...new Set(times)].filter((t) => t >= 0 && t < durationSec);
  return uniq.length > 0 ? uniq : [0];
}

export function storyboardGeometry(
  durationSec: number,
): NonNullable<LadderPlan['storyboard']> | undefined {
  if (!(durationSec > 0)) return undefined;
  const intervalSec =
    STORYBOARD_INTERVALS.find((i) => Math.ceil(durationSec / i) <= STORYBOARD_MAX_TILES) ??
    STORYBOARD_INTERVALS[STORYBOARD_INTERVALS.length - 1] ??
    300;
  const tiles = Math.max(1, Math.ceil(durationSec / intervalSec));
  const cols = Math.min(STORYBOARD_COLS, tiles);
  const rows = Math.ceil(tiles / cols);
  return { intervalSec, cols, rows, tileWidth: STORYBOARD_TILE_WIDTH };
}

const LOWEST_TIER: Tier = {
  label: '360p',
  height: 360,
  videoBitrateKbps: 800,
  audioBitrateKbps: 96,
};

/** An even height of at least 2. */
const even = (h: number): number => Math.max(2, h - (h % 2));

/**
 * S: a source's size, its display short side (`shortSide`) made even, at most
 * `MAX_RENDITION_HEIGHT` (and `maxHeight`); at least 2.
 */
export function sourceSize(short: number, maxHeight?: number): number {
  const cap = Math.min(short, MAX_RENDITION_HEIGHT, maxHeight ?? Infinity);
  return even(Math.floor(Number.isFinite(cap) && cap > 0 ? cap : 2));
}

/** Whether `h` is a tier's height (anything else offered is the source's own, "original"). */
export function isTierHeight(h: number): boolean {
  return LADDER_TIERS.some((t) => t.height === h);
}

/**
 * The sizes offered for a source of size `H` (`sourceSize`): tiers at or below it, tallest first,
 * then H itself when it is no tier.
 */
export function offeredSizes(H: number): readonly number[] {
  const tiers = LADDER_TIERS.filter((t) => t.height <= H).map((t) => t.height);
  return isTierHeight(H) ? tiers : [...tiers, H];
}

/** The default size for a source of size `H`: 720 when it is at least that large, else H. */
export function defaultSize(H: number): number {
  return H >= DEFAULT_RENDITION_HEIGHT ? DEFAULT_RENDITION_HEIGHT : H;
}

/**
 * Studio's remembered default (`Settings.publishSizes`) for a source of size `H`, tallest first,
 * without duplicates: each of `wanted` when offered, else the tallest offered size at or below
 * it, else the shortest offered one. Absent or empty `wanted`: `[defaultSize(H)]`. (`planLadder`
 * does not remap: it refuses a size that is not offered.)
 */
export function chooseSizes(H: number, wanted?: readonly number[]): readonly number[] {
  if (wanted === undefined || wanted.length === 0) return [defaultSize(H)];
  const offered = offeredSizes(H);
  const out = new Set<number>();
  for (const w of wanted) {
    if (offered.includes(w)) {
      out.add(w);
      continue;
    }
    const below = offered.filter((o) => o <= w);
    out.add(below.length > 0 ? Math.max(...below) : Math.min(...offered));
  }
  return [...out].sort((a, b) => b - a);
}

/**
 * Label and bitrates of a rendition `h` lines tall: a tier's own, a linear interpolation between
 * the tiers around a height between two, and the old fallback below the lowest tier.
 */
export function sizeSpec(h: number, codec: RenditionSpec['codec'] = 'h264'): RenditionSpec {
  const scale = bitrateScale(codec);
  const base = { label: `${String(h)}p`, height: h, codec, container: codecContainer(codec) };
  const tier = LADDER_TIERS.find((t) => t.height === h);
  if (tier !== undefined) {
    return {
      ...base,
      label: tier.label,
      videoBitrateKbps: Math.round(tier.videoBitrateKbps * scale),
      audioBitrateKbps: tier.audioBitrateKbps,
    };
  }
  const lo = LADDER_TIERS.find((t) => t.height < h);
  const hi = [...LADDER_TIERS].reverse().find((t) => t.height > h);
  if (lo === undefined || hi === undefined) {
    // Below the lowest tier (or, never planned, above the top one): scaled from the lowest tier.
    const vk = Math.round((LOWEST_TIER.videoBitrateKbps * h) / LOWEST_TIER.height);
    return {
      ...base,
      videoBitrateKbps: Math.max(200, Math.round(vk * scale)),
      audioBitrateKbps: LOWEST_TIER.audioBitrateKbps,
    };
  }
  const vk = Math.round(
    lo.videoBitrateKbps +
      ((hi.videoBitrateKbps - lo.videoBitrateKbps) * (h - lo.height)) / (hi.height - lo.height),
  );
  return {
    ...base,
    videoBitrateKbps: Math.max(200, Math.round(vk * scale)),
    audioBitrateKbps: hi.audioBitrateKbps,
  };
}

/** What `studio.probe` answers for a probed source (contracts v16). */
export function sourceSizes(probe: MediaProbe): SourceSizes {
  if (!probe.video) throw new MediaError('no-video-stream', 'input has no video stream');
  const H = sourceSize(shortSide(displayDimensions(probe.video)));
  const sizes = offeredSizes(H).map((h) => {
    const spec = sizeSpec(h);
    return {
      height: h,
      original: !isTierHeight(h),
      kbps: spec.videoBitrateKbps + spec.audioBitrateKbps,
    };
  });
  // A duration a file claims past ~115 days is no estimate worth showing (and the IPC caps it).
  const d = probe.durationSec;
  const known = Number.isFinite(d) && d > 0 && d <= MAX_PROBED_DURATION_SEC;
  return { height: H, sizes, ...(known ? { durationSec: d } : {}) };
}

/** The old ladder for a source `cap` lines tall (`ALL_SIZES_PRESET`, or one native rendition). */
function presetHeights(cap: number): readonly number[] {
  const tiers = ALL_SIZES_PRESET.filter((h) => h <= cap);
  return tiers.length > 0 ? tiers : [even(cap)];
}

/**
 * The sizes to encode for a source of size `S`, tallest first: `wanted` exactly, each offered and
 * named once (refused otherwise, before anything is encoded), or the default when there are none.
 */
function plannedSizes(S: number, wanted: readonly number[] | undefined): readonly number[] {
  if (wanted === undefined || wanted.length === 0) return [defaultSize(S)];
  if (wanted.length > MAX_SIZES) {
    throw new MediaError('unsupported-input', 'too many rendition sizes');
  }
  const offered = offeredSizes(S);
  const seen = new Set<number>();
  for (const h of wanted) {
    if (!Number.isSafeInteger(h) || h < 2) {
      throw new MediaError('unsupported-input', 'a rendition size is not a height');
    }
    if (!offered.includes(h)) {
      const list = offered.map((o) => `${String(o)}p`).join(', ');
      throw new MediaError(
        'unsupported-input',
        `${String(h)}p is not offered for this source (${String(S)} lines; never upscaled): offered ${list}`,
      );
    }
    if (seen.has(h)) throw new MediaError('unsupported-input', `${String(h)}p is named twice`);
    seen.add(h);
  }
  return [...seen].sort((a, b) => b - a);
}

export function planLadder(
  probe: MediaProbe,
  opts: {
    readonly maxHeight?: number;
    readonly codec?: RenditionSpec['codec'];
    readonly sizes?: LadderSizes;
  } = {},
): LadderPlan {
  if (!probe.video) throw new MediaError('no-video-stream', 'input has no video stream');
  const codec = opts.codec ?? 'h264';
  const short = shortSide(displayDimensions(probe.video));
  const heights =
    opts.sizes === 'all'
      ? presetHeights(Math.min(short, opts.maxHeight ?? Infinity))
      : plannedSizes(sourceSize(short, opts.maxHeight), opts.sizes);
  const renditions = heights.map((h) => sizeSpec(h, codec));

  const storyboard = storyboardGeometry(probe.durationSec);
  return {
    source: probe,
    renditions,
    thumbnailTimes: thumbnailTimes(probe.durationSec),
    ...(storyboard ? { storyboard } : {}),
  };
}
