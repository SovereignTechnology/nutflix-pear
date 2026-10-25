/**
 * NFX-05 packaging (nfx-media `package.rs`, ADR 0020): the renditions this pipeline already
 * encoded (`transcode`, H.264 + AAC, keyframes every GOP_SECONDS) remuxed by stream copy into
 * CMAF, so one encode serves both the legacy MP4 and NFX. Every output file is named by its
 * sha256 (NFX-05 §3), each rendition playlist is rewritten to content names, a master playlist
 * and the hash list are built, and the result is checked as a consumer would check it (the
 * hash list against its root, every file against its sha256, every playlist against the
 * content-name rule) before it is returned.
 *
 * Nothing is stored here: the result says where each file's bytes are (a file ffmpeg wrote, or
 * bytes made here), and the caller puts them in its sha256 store. Every effect goes through the
 * injected runner (argv only), `FsAdapter` and `sha256`, as in `pipeline.ts`.
 */
import type { FsAdapter, ProcessRunner, RenditionSpec } from '../contracts/media.js';
import type { Sha256Hex } from '../contracts/primitives.js';
import {
  MAX_HASH_LIST_BYTES,
  checkPlaylist,
  renderHashList,
  verifyFile,
  verifyHashList,
  type FileEntry,
  type HashList,
  type Rendition,
  type VideoAddr,
} from '../nfx/index.js';
import { cmafRemuxArgv } from './argv.js';
import { MediaError } from './errors.js';
import { GOP_SECONDS } from './ladder.js';
import { initCodecs } from './mp4-codecs.js';
import { runOrThrow } from './run.js';
import type { FfmpegPaths, Sha256Factory } from './types.js';

export interface NfxPackageDeps {
  readonly runner: ProcessRunner;
  readonly fs: FsAdapter;
  readonly sha256: Sha256Factory;
  readonly binaries: FfmpegPaths;
  /** Prefix for the per-rendition work directories (`fs.mkdtemp`). */
  readonly workDirPrefix?: string;
}

/** One encoded rendition, as `transcode` returns it (`TranscodeOutput.renditions[i]`). */
export interface NfxPackageRendition {
  readonly spec: RenditionSpec;
  /** The faststart H.264 + AAC MP4. */
  readonly path: string;
  readonly width: number;
  readonly height: number;
}

export interface NfxPackageInput {
  /** The NFX address the hash list names (NFX-01, `<namespace>:<video-id>`). */
  readonly video: VideoAddr;
  /** Highest first, as the ladder plans them; every one H.264 in MP4. */
  readonly renditions: readonly NfxPackageRendition[];
  /** A JPEG listed as role `thumb` (`TranscodeOutput.thumbnails[0].path`), as nfx-media does. */
  readonly thumbnailPath?: string;
}

/** Where a listed file's bytes are. */
export type NfxPackagedSource =
  /** A file ffmpeg wrote (an init segment, a media segment) or the thumbnail. */
  | { readonly kind: 'path'; readonly path: string }
  /** Bytes made here: the master and the rendition playlists. */
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array };

export interface NfxPackagedFile {
  readonly entry: FileEntry;
  readonly source: NfxPackagedSource;
}

/** A packaged video, verified. */
export interface NfxPackaged {
  readonly hashList: HashList;
  /** The hash list's bytes (NFX-05 §2); their sha256 is the manifest `root`. */
  readonly hashListBytes: Uint8Array;
  readonly root: Sha256Hex;
  /** `files.length`: the manifest `segs`. */
  readonly segs: bigint;
  /** Every listed file, in hash-list order. */
  readonly files: readonly NfxPackagedFile[];
  /** The directories ffmpeg wrote into; the caller removes them once the files are stored. */
  readonly workDirs: readonly string[];
}

const DEFAULT_PREFIX = 'nutflix-nfx-';
/** Rendition labels become file names (`init-720p.mp4`): the ladder's, never anything else. */
const LABEL = /^[0-9a-z]{1,16}$/;
/** A file name ffmpeg wrote into its own output directory. */
const PLAIN_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const SECONDS = /^[0-9]+(?:\.[0-9]+)?$/;
/**
 * Read caps on what ffmpeg wrote, checked before the bytes are read: far above anything the
 * ladder produces (a 2 s segment at 1080p is a few MB), so they only stop a runaway output.
 */
const MAX_INIT_BYTES = 1024 * 1024;
const MAX_PLAYLIST_BYTES = 16 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

const utf8 = new TextEncoder();

interface PackagedRendition {
  readonly rendition: Rendition;
  readonly playlist: NfxPackagedFile;
  readonly media: readonly NfxPackagedFile[];
  readonly durations: readonly number[];
}

const fail = (message: string): MediaError => new MediaError('process-failed', message);

/** Package `input` as NFX-05 content. Rejects with a `MediaError`; never returns unverified. */
export async function packageNfx(
  deps: NfxPackageDeps,
  input: NfxPackageInput,
): Promise<NfxPackaged> {
  const { runner, fs, sha256, binaries } = deps;
  const prefix = deps.workDirPrefix ?? DEFAULT_PREFIX;
  checkInput(input);
  const workDirs: string[] = [];

  const hash = (bytes: Uint8Array): Sha256Hex => {
    const h = sha256();
    h.update(bytes);
    return h.digest();
  };
  const readCapped = async (path: string, max: number, what: string): Promise<Uint8Array> => {
    if ((await fs.stat(path)).size > max) throw fail(`NFX package: ${what} is too large`);
    return fs.readFile(path);
  };

  async function packageRendition(r: NfxPackageRendition): Promise<PackagedRendition> {
    const label = r.spec.label;
    const dir = await fs.mkdtemp(`${prefix}${label}-`);
    workDirs.push(dir);
    await runOrThrow(runner, binaries.ffmpeg, cmafRemuxArgv(r.path, dir), `nfx remux ${label}`);

    const initPath = `${dir}/init.mp4`;
    const initBytes = await readCapped(initPath, MAX_INIT_BYTES, `${label} init segment`);
    const initSha = hash(initBytes);
    const codecs = initCodecs(initBytes).join(',');
    const media: NfxPackagedFile[] = [
      {
        entry: {
          name: `init-${label}.mp4`,
          role: 'init',
          sha256: initSha,
          size: BigInt(initBytes.length),
          durMs: undefined,
        },
        source: { kind: 'path', path: initPath },
      },
    ];

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(
        await readCapped(`${dir}/index.m3u8`, MAX_PLAYLIST_BYTES, `${label} playlist`),
      );
    } catch (e) {
      if (e instanceof TypeError) throw fail(`${label}: the playlist is not UTF-8`);
      throw e;
    }
    const out: string[] = [];
    const durations: number[] = [];
    let pendingMs: number | undefined;
    let peakBps = 0n;
    for (const line of lines(text)) {
      if (line.startsWith('#EXT-X-MAP:')) {
        if (!line.includes('URI="init.mp4"')) throw fail(`${label}: unexpected EXT-X-MAP`);
        out.push(`#EXT-X-MAP:URI="${initSha}.mp4"`);
      } else if (line.startsWith('#EXTINF:')) {
        const field = line.slice('#EXTINF:'.length).split(',')[0] ?? '';
        if (!SECONDS.test(field)) throw fail(`${label}: bad EXTINF`);
        const ms = Math.round(Number(field) * 1000);
        if (ms === 0) throw fail(`${label}: zero-length segment`);
        pendingMs = ms;
        out.push(line);
      } else if (line !== '' && !line.startsWith('#')) {
        // A URI line: a segment ffmpeg wrote next to the playlist, nothing else.
        if (!PLAIN_NAME.test(line)) throw fail(`${label}: a segment name is not a plain name`);
        if (pendingMs === undefined) throw fail(`${label}: a segment without EXTINF`);
        const durMs = pendingMs;
        pendingMs = undefined;
        const path = `${dir}/${line}`;
        const bytes = await readCapped(path, MAX_SEGMENT_BYTES, `${label} segment`);
        const sha = hash(bytes);
        const size = BigInt(bytes.length);
        const ms = BigInt(durMs);
        const bps = (size * 8000n + ms - 1n) / ms;
        if (bps > peakBps) peakBps = bps;
        media.push({
          entry: { name: `${label}-${line}`, role: 'segment', sha256: sha, size, durMs: ms },
          source: { kind: 'path', path },
        });
        durations.push(durMs);
        out.push(`${sha}.m4s`);
      } else {
        out.push(line);
      }
    }
    if (durations.length === 0 || !text.includes('#EXT-X-ENDLIST')) {
      throw fail(`${label}: incomplete playlist`);
    }
    const playlistBytes = utf8.encode(`${out.join('\n')}\n`);
    const playlistName = `r${label}.m3u8`;
    return {
      rendition: {
        id: label,
        playlist: playlistName,
        bandwidth: peakBps,
        codecs,
        resolution: `${String(r.width)}x${String(r.height)}`,
      },
      playlist: {
        entry: {
          name: playlistName,
          role: 'playlist',
          sha256: hash(playlistBytes),
          size: BigInt(playlistBytes.length),
          durMs: undefined,
        },
        source: { kind: 'bytes', bytes: playlistBytes },
      },
      media,
      durations,
    };
  }

  try {
    const packaged: PackagedRendition[] = [];
    for (const r of input.renditions) packaged.push(await packageRendition(r));
    checkGopGrid(packaged);

    let master = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n';
    for (const p of packaged) {
      const r = p.rendition;
      master +=
        `#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth.toString()},` +
        `RESOLUTION=${r.resolution ?? ''},CODECS="${r.codecs ?? ''}"\n` +
        `${p.playlist.entry.sha256}.m3u8\n`;
    }
    const masterBytes = utf8.encode(master);
    const files: NfxPackagedFile[] = [
      {
        entry: {
          name: 'master.m3u8',
          role: 'playlist-master',
          sha256: hash(masterBytes),
          size: BigInt(masterBytes.length),
          durMs: undefined,
        },
        source: { kind: 'bytes', bytes: masterBytes },
      },
      ...packaged.map((p) => p.playlist),
      ...packaged.flatMap((p) => p.media),
    ];
    if (input.thumbnailPath !== undefined) {
      const bytes = await fs.readFile(input.thumbnailPath);
      files.push({
        entry: {
          name: 'thumb.jpg',
          role: 'thumb',
          sha256: hash(bytes),
          size: BigInt(bytes.length),
          durMs: undefined,
        },
        source: { kind: 'path', path: input.thumbnailPath },
      });
    }

    const hashList: HashList = {
      v: 1,
      video: input.video.toString(),
      files: files.map((f) => f.entry),
      renditions: packaged.map((p) => p.rendition),
    };
    const hashListBytes = renderHashList(hashList);
    // Receivers refuse a longer hash list (NFX-12 §4), so a package that needs one is unusable.
    if (hashListBytes.length > MAX_HASH_LIST_BYTES) {
      throw fail('NFX package: the hash list exceeds 16 MiB');
    }
    const root = hash(hashListBytes);
    const segs = BigInt(files.length);
    await selfCheck(fs, input.video, files, hashListBytes, root, segs);
    return { hashList, hashListBytes, root, segs, files, workDirs };
  } catch (e) {
    // Best effort: nothing of a failed package is kept. The caller owns the dirs on success.
    for (const dir of workDirs) await fs.rm(dir, { recursive: true }).catch(() => undefined);
    throw e;
  }
}

function checkInput(input: NfxPackageInput): void {
  if (input.renditions.length === 0) {
    throw new MediaError('unsupported-input', 'NFX package: no renditions');
  }
  const labels = new Set<string>();
  for (const r of input.renditions) {
    if (r.spec.codec !== 'h264' || r.spec.container !== 'mp4') {
      throw new MediaError(
        'unsupported-input',
        `NFX package: ${r.spec.label} is ${r.spec.codec}/${r.spec.container}; NFX packages H.264 in MP4`,
      );
    }
    if (!LABEL.test(r.spec.label) || labels.has(r.spec.label)) {
      throw new MediaError('unsupported-input', 'NFX package: rendition labels must be unique');
    }
    labels.add(r.spec.label);
    for (const n of [r.width, r.height]) {
      if (!Number.isSafeInteger(n) || n <= 0) {
        throw new MediaError(
          'unsupported-input',
          `NFX package: ${r.spec.label} has bad dimensions`,
        );
      }
    }
  }
}

/** NFX-05 §1: one GOP grid for every rendition (switches are seamless), every segment but the last GOP_SECONDS. */
function checkGopGrid(packaged: readonly PackagedRendition[]): void {
  const [first, ...rest] = packaged;
  if (first === undefined) return;
  const same = (a: readonly number[]): boolean =>
    a.length === first.durations.length && a.every((d, i) => d === first.durations[i]);
  if (!rest.every((p) => same(p.durations))) {
    throw fail('NFX package: segment durations differ across renditions');
  }
  const gopMs = GOP_SECONDS * 1000;
  if (first.durations.slice(0, -1).some((d) => d !== gopMs)) {
    throw fail(`NFX package: segments are not ${String(GOP_SECONDS)} s`);
  }
}

/** Check the package exactly as a consumer would (NFX-05 §§2–4), with the codec's own sha256. */
async function selfCheck(
  fs: FsAdapter,
  video: VideoAddr,
  files: readonly NfxPackagedFile[],
  hashListBytes: Uint8Array,
  root: Sha256Hex,
  segs: bigint,
): Promise<void> {
  const verified = verifyHashList(hashListBytes, root, video, segs);
  if (!verified.ok) {
    throw new MediaError('hash-mismatch', `NFX package: ${verified.error.reason}`);
  }
  for (const f of files) {
    const bytes = f.source.kind === 'bytes' ? f.source.bytes : await fs.readFile(f.source.path);
    const file = verifyFile(f.entry.sha256, bytes);
    if (!file.ok) {
      throw new MediaError('hash-mismatch', `NFX package: ${f.entry.name}: ${file.error.reason}`);
    }
    if (f.entry.role === 'playlist-master' || f.entry.role === 'playlist') {
      const playlist = checkPlaylist(verified.value, bytes);
      if (!playlist.ok) {
        throw new MediaError(
          'hash-mismatch',
          `NFX package: ${f.entry.name}: ${playlist.error.reason}`,
        );
      }
    }
  }
}

/** Rust's `str::lines`: split on `\n`, drop one trailing `\r` per line, no final empty line. */
function lines(text: string): string[] {
  const out = text.split('\n');
  if (out[out.length - 1] === '') out.pop();
  return out.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}
