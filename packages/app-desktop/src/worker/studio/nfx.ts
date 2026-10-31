/**
 * The NFX side of a Studio upload (contracts v8 `UploadInput.nfx`, ADR 0020 Phase 1): after the
 * legacy upload has published, the H.264 renditions it encoded are packaged as NFX-05 CMAF by
 * stream copy (`media.packageNfx`, no second encode) and kept in the seeder's NFX store, which
 * shares the disk cap with the legacy blobs and joins no swarm. Nothing is published here: the
 * host announces the stored video's manifest (kind 38504, `host/nfx/publish.ts`); beacons come
 * with slice 5's transport, which also shows the status.
 *
 * Free videos only: the guards refuse `nfx` on a priced upload, and this module checks again.
 * Every failure is a typed `NfxUploadStatusWire`, never a throw into the legacy upload.
 */
import type { FsAdapter, ProcessRunner, Sha256Hex, TranscodeOutput, nfx } from '@sovit/core';
import { media } from '@sovit/core';
import type { Logger, NfxStore } from '@sovit/seeder';

import { nfxVideoAddrFor } from '../../ipc/nfx-addr.js';
import type { NfxUploadFailure, NfxUploadStatusWire } from '../../ipc/worker-protocol.js';

// Shared with the host, which checks the stored video is the one it published (`ipc/nfx-addr.ts`).
export { NFX_DEFAULT_NAMESPACE, nfxVideoAddrFor } from '../../ipc/nfx-addr.js';

export interface NfxUploadDeps {
  readonly store: NfxStore;
  readonly runner: ProcessRunner;
  readonly fs: FsAdapter;
  readonly sha256: media.Sha256Factory;
  readonly binaries: media.FfmpegPaths;
  readonly logger: Logger;
}

export interface NfxUploadInput {
  /** The published legacy event's id (`VideoManifest.id`). */
  readonly legacyEventId: string;
  /** The upload's price: anything but 0 is refused (free videos only, issue #15). */
  readonly satsPerBlock: number;
  /** What `transcode` produced for the legacy upload (still on disk). */
  readonly output: TranscodeOutput;
}

/** Package `input` for NFX and store it. Never throws. */
export async function packageUploadForNfx(
  input: NfxUploadInput,
  deps: NfxUploadDeps,
): Promise<NfxUploadStatusWire> {
  const log = deps.logger.child({ component: 'studio-nfx' });
  const failed = (reason: NfxUploadFailure): NfxUploadStatusWire => {
    log.warn('upload not packaged for NFX', { reason });
    return { state: 'failed', reason };
  };
  if (input.satsPerBlock !== 0) return failed('unsupported');
  const renditions = input.output.renditions;
  if (
    renditions.length === 0 ||
    renditions.some((r) => r.spec.codec !== 'h264' || r.spec.container !== 'mp4')
  ) {
    return failed('unsupported');
  }

  let video: nfx.VideoAddr;
  try {
    video = nfxVideoAddrFor(input.legacyEventId);
  } catch {
    return failed('unsupported');
  }

  let packaged: media.NfxPackaged;
  try {
    const thumbnail = input.output.thumbnails[0];
    packaged = await media.packageNfx(
      { runner: deps.runner, fs: deps.fs, sha256: deps.sha256, binaries: deps.binaries },
      {
        video,
        renditions: renditions.map((r) => ({
          spec: r.spec,
          path: r.path,
          width: r.width,
          height: r.height,
        })),
        ...(thumbnail !== undefined ? { thumbnailPath: thumbnail.path } : {}),
      },
    );
  } catch {
    // packageNfx removes its own work directories when it fails.
    return failed('packaging-failed');
  }

  try {
    const bySha = new Map(packaged.files.map((f) => [f.entry.sha256, f] as const));
    const put = await deps.store.putVideo({
      video,
      root: packaged.root,
      segs: packaged.segs,
      hashListBytes: packaged.hashListBytes,
      // The store asks only for files its verified hash list names, and checks each one.
      read: async (entry) => {
        const f = bySha.get(entry.sha256);
        if (f === undefined) throw new Error('not in the package');
        return f.source.kind === 'bytes' ? f.source.bytes : deps.fs.readFile(f.source.path);
      },
    });
    if (!put.ok) return failed(put.error === 'disk-cap' ? 'disk-cap' : 'store-failed');
    let bytes = 0;
    for (const f of put.record.files) bytes += f.size;
    log.info('upload packaged for NFX', {
      video: put.record.video,
      segs: put.record.segs,
      deduplicated: put.deduplicated,
    });
    // The manifest's `thumb` (NFX-02): the JPEG the packager listed with role `thumb`. Its hash
    // is the packager's own sha256, 64 lowercase hex (re-checked by the guard on the hop).
    const thumb = packaged.hashList.files.find((f) => f.role === 'thumb');
    return {
      state: 'stored',
      video: put.record.video,
      root: packaged.root,
      segs: put.record.segs,
      renditions: packaged.hashList.renditions.length,
      bytes,
      ...(thumb !== undefined
        ? { thumb: { sha256: thumb.sha256 as Sha256Hex, mime: 'image/jpeg' } }
        : {}),
    };
  } catch {
    return failed('store-failed');
  } finally {
    // The store holds its own copies; ffmpeg's work directories are not needed any more.
    for (const dir of packaged.workDirs)
      await deps.fs.rm(dir, { recursive: true }).catch(() => undefined);
  }
}
