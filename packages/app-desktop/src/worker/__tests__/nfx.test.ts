/**
 * The NFX side of a Studio upload (`studio/nfx.ts`): the video address derivation, and every
 * way it refuses or fails without touching the legacy upload. The packaged-and-stored path runs
 * with the system ffmpeg in `upload.test.ts`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ProcessRunner, Sha256Hex, TranscodeOutput } from '@sovit/core';
import { nfx } from '@sovit/core';
import { nodeFsAdapter, nodeSha256 } from '@sovit/core/media/node';
import { NfxStore, nodeCrypto, nodeFs, silentLogger } from '@sovit/seeder';
import { afterEach, describe, expect, it } from 'vitest';

import { NFX_DEFAULT_NAMESPACE, nfxVideoAddrFor, packageUploadForNfx } from '../studio/nfx.js';

const EVENT_ID = '0123456789abcdef'.repeat(4);

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function deps(runner: ProcessRunner) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nf-nfx-upload-'));
  dirs.push(dir);
  const store = new NfxStore({ fs: nodeFs, crypto: nodeCrypto, dataDir: path.join(dir, 'data') });
  await store.load();
  return {
    store,
    runner,
    fs: nodeFsAdapter({ tmpDir: dir }),
    sha256: nodeSha256,
    binaries: { ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe' },
    logger: silentLogger,
  };
}

/** A runner that records its calls and fails every one. */
function failingRunner(): ProcessRunner & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    run: () => {
      calls++;
      return Promise.resolve({ exitCode: 1, stdout: new Uint8Array(0), stderr: 'no' });
    },
  };
}

function output(codec: 'h264' | 'vp9'): TranscodeOutput {
  const sha = 'ab'.repeat(32) as Sha256Hex;
  return {
    renditions: [
      {
        spec: {
          label: '360p',
          height: 360,
          videoBitrateKbps: 800,
          audioBitrateKbps: 96,
          codec,
          container: codec === 'vp9' ? 'webm' : 'mp4',
        },
        path: '/nowhere/360p.mp4',
        size: 1,
        sha256: sha,
        faststart: true,
        width: 640,
        height: 360,
      },
    ],
    thumbnails: [],
    placeholderDataUrl: 'data:image/jpeg;base64,',
  };
}

describe('nfxVideoAddrFor', () => {
  it('derives a valid, deterministic address from the legacy event id', () => {
    const a = nfxVideoAddrFor(EVENT_ID);
    expect(a.toString()).toBe(`${NFX_DEFAULT_NAMESPACE}:nutflix-${EVENT_ID.slice(0, 32)}`);
    expect(nfx.validateVideoId(a.videoId).ok).toBe(true);
    expect(nfxVideoAddrFor(EVENT_ID).equals(a)).toBe(true);
    expect(nfxVideoAddrFor('f'.repeat(64)).equals(a)).toBe(false);
  });

  it('refuses an id that is not 64 lowercase hex, and a namespace that is not NFX-01', () => {
    for (const bad of ['', EVENT_ID.toUpperCase(), EVENT_ID.slice(1), `${EVENT_ID}0`]) {
      expect(() => nfxVideoAddrFor(bad)).toThrow();
    }
    expect(() => nfxVideoAddrFor(EVENT_ID, 'nutflix:testnet:1')).toThrow();
  });
});

describe('packageUploadForNfx', () => {
  it('refuses a priced video without running ffmpeg (free videos only)', async () => {
    const runner = failingRunner();
    const status = await packageUploadForNfx(
      { legacyEventId: EVENT_ID, satsPerBlock: 2, output: output('h264') },
      await deps(runner),
    );
    expect(status).toEqual({ state: 'failed', reason: 'unsupported' });
    expect(runner.calls).toBe(0);
  });

  it('refuses renditions that are not H.264 in MP4', async () => {
    const runner = failingRunner();
    const status = await packageUploadForNfx(
      { legacyEventId: EVENT_ID, satsPerBlock: 0, output: output('vp9') },
      await deps(runner),
    );
    expect(status).toEqual({ state: 'failed', reason: 'unsupported' });
    expect(runner.calls).toBe(0);
  });

  it('reports a failed remux as packaging-failed and stores nothing', async () => {
    const runner = failingRunner();
    const d = await deps(runner);
    const status = await packageUploadForNfx(
      { legacyEventId: EVENT_ID, satsPerBlock: 0, output: output('h264') },
      d,
    );
    expect(status).toEqual({ state: 'failed', reason: 'packaging-failed' });
    expect(runner.calls).toBe(1);
    expect(d.store.videos()).toEqual([]);
    expect(d.store.totalBytes()).toBe(0);
  });
});
