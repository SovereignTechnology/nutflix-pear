/**
 * `studio.upload` in the worker: L8's `runStudioUpload` (probe → ladder → system ffmpeg
 * transcode → thumbnails → Hyperblobs → publish) with
 *
 *   - the process runner injected (`bare-subprocess` in the worker, L8's adapter);
 *   - a `BlobSink` that stores each rendition through the SEEDER (`Seeder.putFile`: CAS
 *     index, disk cap, dedupe, upload gate and swarm like every other seeded blob). The
 *     pipeline streams the rendition's bytes through the sink while it hashes them; the
 *     sink drains that stream and then lets the seeder read the (verified) file itself —
 *     the seeder needs a re-readable source for its hash-then-write passes — and refuses a
 *     result whose sha256 differs from the transcode output's (`hash-mismatch`);
 *   - `publish` = a worker → host `studio.publish(PublishDraft)` request: the HOST builds and
 *     signs the NIP-71 event (it owns the signer seam) and returns the verified manifest.
 *
 * Progress goes out as `upload.progress` events, shaped to pass the host's guard (error
 * messages go through the ipc scrubber: no paths, one line, capped).
 */
import type {
  BlobLike,
  BlobSink,
  FsAdapter,
  HyperblobRef,
  MediaPipeline,
  ProcessRunner,
  RenditionSpec,
  Sha256Hex,
  TranscodeOutput,
  UploadInput,
  UploadProgress,
  VideoManifest,
} from '@sovit/core';
import { MAX_IMAGE_BYTES, media } from '@sovit/core';
import type { Logger, Seeder } from '@sovit/seeder';

import { fromHex as hexToBytes } from '../../ipc/codec.js';
import { toWireError } from '../../ipc/errors.js';
import type {
  NfxUploadStatusWire,
  PublishDraft,
  StudioUploadArgs,
} from '../../ipc/worker-protocol.js';
import { packageUploadForNfx } from './nfx.js';

export interface WorkerUploadDeps {
  readonly seeder: Seeder;
  readonly binaries: media.FfmpegPaths;
  readonly runner: ProcessRunner;
  readonly fs: FsAdapter;
  readonly sha256: media.Sha256Factory;
  readonly logger: Logger;
  /** Worker → host `studio.publish`. */
  readonly publish: (draft: PublishDraft) => Promise<VideoManifest>;
  /**
   * ADR 0015: write the chosen thumbnail into the creator's profile core; the reference goes into
   * the manifest. Absent (tests): the video is published without a thumbnail.
   */
  readonly putThumbnail?: (
    bytes: Uint8Array,
  ) => Promise<{ url: string; sha256: Sha256Hex; size: number }>;
  readonly progress: (p: UploadProgress) => void;
  /** x264 preset (tests use `ultrafast`). */
  readonly preset?: string;
  /**
   * Contracts v8: the NFX side of an upload with `meta.nfx` (`./nfx.ts`). It runs after the
   * legacy upload resolved and reports on its own; absent, `meta.nfx` is ignored.
   */
  readonly nfx?: (status: Promise<NfxUploadStatusWire>) => void;
}

/** A progress event as it may cross to the host (error text scrubbed and capped). */
export function wireProgress(p: UploadProgress): UploadProgress {
  if (p.stage !== 'error') return p;
  return {
    stage: 'error',
    message: toWireError(new Error(`process-failed: ${p.message}`)).message,
  };
}

function blobLike(hex: string, type: string): BlobLike {
  const bytes = hexToBytes(hex);
  return {
    size: bytes.byteLength,
    type,
    arrayBuffer: () => Promise.resolve(Uint8Array.from(bytes).buffer),
  };
}

/**
 * ADR 0015: the chosen thumbnail into the creator's profile core. A thumbnail that cannot be
 * written (too large, unreadable, hash drift) is logged and left out: the video still publishes.
 */
async function publishThumbnail(
  draft: media.UploadDraft,
  deps: WorkerUploadDeps,
  log: Logger,
): Promise<PublishDraft['thumbnailImage']> {
  if (deps.putThumbnail === undefined) return undefined;
  try {
    const t = draft.thumbnail;
    const bytes = t.kind === 'candidate' ? await deps.fs.readFile(t.path) : t.bytes;
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_IMAGE_BYTES) {
      log.warn('thumbnail larger than the image cap: published without one');
      return undefined;
    }
    const put = await deps.putThumbnail(bytes);
    if (put.sha256 !== t.sha256) {
      log.warn('thumbnail changed since it was hashed: published without one');
      return undefined;
    }
    return put;
  } catch {
    log.warn('thumbnail could not be written: published without one');
    return undefined;
  }
}

export async function runWorkerUpload(
  args: StudioUploadArgs,
  deps: WorkerUploadDeps,
): Promise<VideoManifest> {
  const log = deps.logger.child({ component: 'studio-upload' });
  const inner = media.createMediaPipeline({
    runner: deps.runner,
    fs: deps.fs,
    sha256: deps.sha256,
    binaries: deps.binaries,
    ...(deps.preset !== undefined ? { preset: deps.preset } : {}),
  });
  // Remember the transcode output: the sink needs each rendition's file path.
  let output: TranscodeOutput | null = null;
  const pipeline: MediaPipeline = {
    probe: (p) => inner.probe(p),
    plan: (probe, opts) => inner.plan(probe, opts),
    transcode: async (p, plan, onProgress, opts) => {
      output = await inner.transcode(p, plan, onProgress, opts);
      return output;
    },
    publish: (r, sink) => inner.publish(r, sink),
  };

  const sinkFor = (spec: RenditionSpec): BlobSink => ({
    put: async (chunks): Promise<HyperblobRef> => {
      const done: TranscodeOutput | null = output;
      const r = done?.renditions.find((x) => x.spec.label === spec.label);
      if (r === undefined) throw new media.MediaError('process-failed', 'rendition not found');
      // Let the pipeline hash what it streams; the seeder re-reads the verified file.
      for await (const _chunk of chunks) {
        // drained
      }
      const put = await deps.seeder.putFile(r.path, {
        mime: r.spec.container === 'webm' ? 'video/webm' : 'video/mp4',
      });
      if (!put.ok) {
        const why =
          put.error.code === 'disk-cap'
            ? 'disk cap reached — raise it in Settings'
            : put.error.code;
        throw new media.MediaError('process-failed', `could not store the rendition: ${why}`);
      }
      if (put.entry.sha256 !== r.sha256 || put.entry.size !== r.size)
        throw new media.MediaError(
          'hash-mismatch',
          `${spec.label}: stored bytes differ from the transcode`,
        );
      return { core: put.entry.coreKey, blob: put.entry.blob };
    },
  });

  const t = args.thumbnailChoice;
  const input: UploadInput = {
    ...args.meta,
    file: args.path,
    ...(t === undefined
      ? {}
      : { thumbnailChoice: typeof t === 'number' ? t : blobLike(t.hex, t.type) }),
  };

  const video = await media.runStudioUpload(
    input,
    (p) => {
      deps.progress(wireProgress(p));
    },
    {
      pipeline,
      sink: sinkFor,
      sha256: deps.sha256,
      fs: deps.fs,
      publish: async (draft) => {
        const first = draft.output.renditions[0];
        const pd: PublishDraft = {
          uploadId: args.uploadId,
          meta: args.meta,
          durationSec: draft.probe.durationSec,
          blockSize: deps.seeder.config.blockSize,
          renditions: draft.renditions,
          thumbnail:
            draft.thumbnail.kind === 'candidate'
              ? { kind: 'candidate', path: draft.thumbnail.path, sha256: draft.thumbnail.sha256 }
              : {
                  kind: 'custom',
                  sha256: draft.thumbnail.sha256,
                  type: typeof t === 'object' ? t.type : 'image/jpeg',
                },
          ...(draft.storyboard
            ? {
                storyboard: {
                  path: draft.storyboard.path,
                  vttPath: draft.storyboard.vttPath,
                  sha256: draft.storyboard.sha256,
                  cols: draft.storyboard.cols,
                  rows: draft.storyboard.rows,
                  intervalSec: draft.storyboard.intervalSec,
                },
              }
            : {}),
          codec: first?.spec.codec ?? 'h264',
        };
        const thumbnailImage = await publishThumbnail(draft, deps, log);
        log.info('upload transcoded; asking the host to publish', {
          renditions: draft.renditions.length,
          thumbnail: thumbnailImage !== undefined,
        });
        return deps.publish(thumbnailImage === undefined ? pd : { ...pd, thumbnailImage });
      },
    },
  );

  // The NFX side (contracts v8), only once the legacy upload has published, and detached: its
  // packaging (a remux and the store's verified writes) never delays or fails the legacy result.
  const done: TranscodeOutput | null = output;
  if (args.meta.nfx === true && deps.nfx !== undefined && done !== null) {
    deps.nfx(
      packageUploadForNfx(
        { legacyEventId: video.id, satsPerBlock: args.meta.satsPerBlock, output: done },
        {
          store: deps.seeder.nfx,
          runner: deps.runner,
          fs: deps.fs,
          sha256: deps.sha256,
          binaries: deps.binaries,
          logger: deps.logger,
        },
      ),
    );
  }
  return video;
}
