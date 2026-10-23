/**
 * NFX on upload (ADR 0020; interop plan slice 2b): a free video's renditions, already encoded
 * for the legacy MP4, packaged as NFX-05 content by stream copy (`media.packageNfx`: no second
 * encode) and kept in the seeder's NFX file store, each file under its sha256.
 *
 *   - **Free videos only** (ADR 0020, Phase 1): a video with any legacy price is never packaged,
 *     so a free NFX copy can never undercut it. Only H.264 in MP4 can be remuxed into CMAF.
 *   - **Off until the host turns it on:** `runWorkerUpload` packages only when it is given
 *     `WorkerNfxDeps` (the network and a video-id source), which the host passes once NFX has
 *     its settings (slice 5). Nothing is announced here: the kind 38504 manifest and the
 *     beacons are slice 4.
 *   - **Additive:** NFX never fails a legacy upload. A failure is logged and the upload goes on
 *     without it; a legacy publish that fails removes the stored NFX video again.
 */
import type { FsAdapter, ProcessRunner, TranscodeOutput } from '@sovit/core';
import { media, nfx } from '@sovit/core';
import type { Logger, NfxFileStore, NfxStoredVideo } from '@sovit/seeder';

import type { UploadMeta } from '../../ipc/worker-protocol.js';

export interface WorkerNfxDeps {
  /** The NFX network this node publishes on (NFX-01 §2), e.g. `nfx:testnet:1`. */
  readonly namespace: nfx.Namespace;
  /** A fresh video-id (NFX-02 §2): one is never reused for different content. */
  readonly newVideoId: () => string;
}

export interface StoreNfxDeps {
  readonly store: NfxFileStore;
  readonly nfx: WorkerNfxDeps;
  readonly runner: ProcessRunner;
  readonly fs: FsAdapter;
  readonly sha256: media.Sha256Factory;
  readonly binaries: media.FfmpegPaths;
  readonly logger: Logger;
}

/** Whether an upload goes to NFX: free, and every rendition H.264 in MP4. */
export function nfxEligible(meta: UploadMeta, output: TranscodeOutput): boolean {
  return (
    meta.satsPerBlock === 0 &&
    output.renditions.length > 0 &&
    output.renditions.every((r) => r.spec.codec === 'h264' && r.spec.container === 'mp4')
  );
}

/**
 * Package `output` for NFX and store it. Resolves the stored video, or `undefined` when
 * anything failed (logged); never rejects.
 */
export async function storeNfxUpload(
  output: TranscodeOutput,
  thumbnailPath: string | undefined,
  deps: StoreNfxDeps,
): Promise<NfxStoredVideo | undefined> {
  const log = deps.logger.child({ component: 'studio-nfx' });
  const addr = nfx.VideoAddr.of(deps.nfx.namespace, deps.nfx.newVideoId());
  if (!addr.ok) {
    log.warn('NFX video-id refused: uploading without NFX', { reason: addr.error.reason });
    return undefined;
  }
  let packaged: media.NfxPackaged;
  try {
    packaged = await media.packageNfx(
      { runner: deps.runner, fs: deps.fs, sha256: deps.sha256, binaries: deps.binaries },
      {
        video: addr.value,
        renditions: output.renditions.map((r) => ({
          spec: r.spec,
          path: r.path,
          width: r.width,
          height: r.height,
        })),
        ...(thumbnailPath !== undefined ? { thumbnailPath } : {}),
      },
    );
  } catch (err) {
    log.warn('NFX packaging failed: uploading without NFX', { error: err });
    return undefined;
  }
  try {
    const sources = new Map<string, media.NfxPackagedSource>(
      packaged.files.map((f) => [f.entry.sha256, f.source]),
    );
    const put = await deps.store.putVideo({
      video: addr.value,
      root: packaged.root,
      segs: packaged.segs,
      hashListBytes: packaged.hashListBytes,
      read: (entry) => {
        const source = sources.get(entry.sha256);
        if (source === undefined) return Promise.reject(new Error('a listed file has no source'));
        return source.kind === 'bytes'
          ? Promise.resolve(source.bytes)
          : deps.fs.readFile(source.path);
      },
    });
    if (!put.ok) {
      log.warn('NFX files could not be stored: uploading without NFX', { code: put.error.code });
      return undefined;
    }
    log.info('NFX video stored', {
      video: put.video.video,
      root: put.video.root,
      files: put.video.files.length,
    });
    return put.video;
  } catch (err) {
    log.warn('NFX files could not be stored: uploading without NFX', { error: err });
    return undefined;
  } finally {
    for (const dir of packaged.workDirs)
      await deps.fs.rm(dir, { recursive: true }).catch(() => undefined);
  }
}
