/**
 * The NFX side of a Studio upload (contracts v8 `UploadInput.nfx`, ADR 0020 Phase 1): after the
 * legacy upload has published, the H.264 renditions it encoded are packaged as NFX-05 CMAF by
 * stream copy (`media.packageNfx`, no second encode) and kept in the seeder's NFX store, which
 * shares the disk cap with the legacy blobs and joins no swarm. Nothing is published here:
 * slice 4 announces the stored video (kind 38504 + beacons), slice 5 shows its status.
 *
 * Free videos only: the guards refuse `nfx` on a priced upload, and this module checks again.
 * Every failure is a typed `NfxUploadStatusWire`, never a throw into the legacy upload.
 */
import type { FsAdapter, ProcessRunner, TranscodeOutput } from '@sovit/core';
import { media, nfx } from '@sovit/core';
import type { Logger, NfxStore } from '@sovit/seeder';

import type { NfxUploadFailure, NfxUploadStatusWire } from '../../ipc/worker-protocol.js';

/**
 * The one NFX network this build packages for, until Settings choose one (slice 5). NFX-01:
 * `nfx:<network>:<specver>`.
 */
export const NFX_DEFAULT_NAMESPACE = 'nfx:testnet:1' as const;

/** Prefix of the video ids this app derives (`nutflix-<32 hex>`, 40 characters). */
const VIDEO_ID_PREFIX = 'nutflix-';

/**
 * The NFX address of the video a legacy NIP-71 event published: `<namespace>:nutflix-<first 32
 * hex of the event id>`. Deterministic (the same legacy video always maps to the same address,
 * so slice 4 can link the two with `["a", …]`), and inside NFX-02's `[a-z0-9][a-z0-9-]{6,62}`.
 * 128 bits of the id keep two of this node's videos from colliding.
 */
export function nfxVideoAddrFor(
  legacyEventId: string,
  namespace: string = NFX_DEFAULT_NAMESPACE,
): nfx.VideoAddr {
  if (!/^[0-9a-f]{64}$/.test(legacyEventId)) {
    throw new TypeError('nfx: a legacy event id is 64 lowercase hex');
  }
  const ns = nfx.Namespace.parse(namespace);
  if (!ns.ok) throw new TypeError('nfx: not an NFX-01 namespace');
  const addr = nfx.VideoAddr.of(ns.value, `${VIDEO_ID_PREFIX}${legacyEventId.slice(0, 32)}`);
  if (!addr.ok) throw new TypeError('nfx: the derived video id is invalid');
  return addr.value;
}

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
    return {
      state: 'stored',
      video: put.record.video,
      root: packaged.root,
      segs: put.record.segs,
      renditions: packaged.hashList.renditions.length,
      bytes,
    };
  } catch {
    return failed('store-failed');
  } finally {
    // The store holds its own copies; ffmpeg's work directories are not needed any more.
    for (const dir of packaged.workDirs)
      await deps.fs.rm(dir, { recursive: true }).catch(() => undefined);
  }
}
