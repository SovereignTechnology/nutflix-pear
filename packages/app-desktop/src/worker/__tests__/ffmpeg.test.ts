import { existsSync } from 'node:fs';

import type { ProcessRunner } from '@sovit/core';
import { describe, expect, it } from 'vitest';

import type { Guard } from '../../ipc/protocol.js';
import { validateWorkerResult } from '../../ipc/worker-guards.js';
import type { FfmpegProbeDeps } from '../ffmpeg.js';
import {
  FLATPAK_FFMPEG,
  ffmpegCandidates,
  parseFfmpegVersion,
  pathCandidates,
  probeFfmpeg,
  siblingFfprobe,
} from '../ffmpeg.js';
import { nodeRuntime } from './helpers/harness.js';

const isStatus = validateWorkerResult['studio.ffmpeg'] as Guard<unknown>;
const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

function fake(
  executables: readonly string[],
  answer: (file: string) => { exitCode: number; out: string } | 'throw',
): FfmpegProbeDeps & { calls: string[] } {
  const calls: string[] = [];
  const runner: ProcessRunner = {
    run: (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      const a = answer(file);
      if (a === 'throw') return Promise.reject(new Error('spawn-failed'));
      return Promise.resolve({ exitCode: a.exitCode, stdout: ascii(a.out), stderr: '' });
    },
  };
  return {
    runner,
    pathEnv: '/nope:relative/bin:/usr/local/bin/:/usr/bin',
    isExecutable: (p) => Promise.resolve(executables.includes(p)),
    os: 'linux',
    calls,
  };
}

const V =
  'ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers\nbuilt with gcc';

describe('ffmpeg probe (ADR 0005: the system ffmpeg)', () => {
  it('PATH candidates: absolute dirs only, trailing slashes trimmed; Windows uses ; and .exe', () => {
    expect(pathCandidates('/a:rel:/b/:', 'linux')).toEqual(['/a/ffmpeg', '/b/ffmpeg']);
    expect(pathCandidates('C:\\ff\\bin;.\\x;\\\\srv\\share', 'windows')).toEqual([
      'C:\\ff\\bin\\ffmpeg.exe',
      '\\\\srv\\share\\ffmpeg.exe',
    ]);
    expect(pathCandidates(undefined, 'linux')).toEqual([]);
    expect(siblingFfprobe('/opt/ff/ffmpeg', 'linux')).toBe('/opt/ff/ffprobe');
    expect(siblingFfprobe('C:\\ff\\ffmpeg.exe', 'windows')).toBe('C:\\ff\\ffprobe.exe');
  });

  it('parses the version token and nothing else', () => {
    expect(parseFfmpegVersion(V.split('\n')[0]!)).toBe('6.1.1-3ubuntu5');
    expect(parseFfmpegVersion('not ffmpeg')).toBeUndefined();
    expect(parseFfmpegVersion('ffmpeg version \u0007\u0001')).toBeUndefined();
  });

  it('finds the first working ffmpeg on PATH that has an ffprobe beside it', async () => {
    const d = fake(['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', '/usr/bin/ffprobe'], () => ({
      exitCode: 0,
      out: V,
    }));
    const r = await probeFfmpeg(d);
    expect(r.status).toEqual({
      found: true,
      path: '/usr/bin/ffmpeg',
      os: 'linux',
      version: '6.1.1-3ubuntu5',
    });
    expect(r.paths).toEqual({ ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe' });
    expect(isStatus(r.status)).toBe(true);
    expect(d.calls).toEqual(['/usr/bin/ffmpeg -hide_banner -version']);
  });

  it('a configured path that does not work is reported as such — never a silent PATH fallback', async () => {
    const d = fake(
      ['/usr/bin/ffmpeg', '/usr/bin/ffprobe', '/opt/ff/ffmpeg', '/opt/ff/ffprobe'],
      (f) => (f === '/opt/ff/ffmpeg' ? { exitCode: 1, out: '' } : { exitCode: 0, out: V }),
    );
    const r = await probeFfmpeg(d, '/opt/ff/ffmpeg');
    expect(r.status).toEqual({ found: false, path: '/opt/ff/ffmpeg', os: 'linux' });
    expect(r.paths).toBeNull();
    expect(isStatus(r.status)).toBe(true);
  });

  // A Flatpak build ships ffmpeg in its own /app/bin (ADR 0017, amendment 2026-11-26).
  it("Linux: after PATH, the Flatpak build's /app/bin/ffmpeg; once, and on Linux only", async () => {
    expect(FLATPAK_FFMPEG).toBe('/app/bin/ffmpeg');
    expect(ffmpegCandidates('/usr/local/bin:/usr/bin', 'linux')).toEqual([
      '/usr/local/bin/ffmpeg',
      '/usr/bin/ffmpeg',
      '/app/bin/ffmpeg',
    ]);
    expect(ffmpegCandidates(undefined, 'linux')).toEqual(['/app/bin/ffmpeg']);
    expect(ffmpegCandidates('/app/bin:/usr/bin', 'linux')).toEqual([
      '/app/bin/ffmpeg',
      '/usr/bin/ffmpeg',
    ]);
    expect(ffmpegCandidates('/usr/bin', 'macos')).toEqual(['/usr/bin/ffmpeg']);
    expect(ffmpegCandidates('C:\\ff', 'windows')).toEqual(['C:\\ff\\ffmpeg.exe']);
    // PATH has none (the worker's PATH may lack /app/bin): found in the Flatpak's prefix.
    const d = fake(['/app/bin/ffmpeg', '/app/bin/ffprobe'], () => ({ exitCode: 0, out: V }));
    const r = await probeFfmpeg(d);
    expect(r.status).toEqual({
      found: true,
      path: '/app/bin/ffmpeg',
      os: 'linux',
      version: '6.1.1-3ubuntu5',
    });
    expect(r.paths).toEqual({ ffmpeg: '/app/bin/ffmpeg', ffprobe: '/app/bin/ffprobe' });
    expect(d.calls).toEqual(['/app/bin/ffmpeg -hide_banner -version']);
    // A working ffmpeg on PATH still wins, and a configured path never falls back to it.
    const both = fake(
      ['/usr/bin/ffmpeg', '/usr/bin/ffprobe', '/app/bin/ffmpeg', '/app/bin/ffprobe'],
      () => ({ exitCode: 0, out: V }),
    );
    expect((await probeFfmpeg(both)).status.path).toBe('/usr/bin/ffmpeg');
    const configured = await probeFfmpeg(
      fake(['/app/bin/ffmpeg', '/app/bin/ffprobe'], () => ({ exitCode: 0, out: V })),
      '/opt/ff/ffmpeg',
    );
    expect(configured.status).toEqual({ found: false, path: '/opt/ff/ffmpeg', os: 'linux' });
  });

  it('spawn failures and missing binaries are "not found", never a throw', async () => {
    const d = fake(['/usr/bin/ffmpeg', '/usr/bin/ffprobe'], () => 'throw');
    expect((await probeFfmpeg(d)).status).toEqual({ found: false, os: 'linux' });
    expect((await probeFfmpeg(fake([], () => ({ exitCode: 0, out: V })))).status.found).toBe(false);
  });

  it.skipIf(!pathCandidates(process.env['PATH'], 'linux').some((p) => existsSync(p)))(
    'probes the real system ffmpeg when there is one',
    async () => {
      const rt = nodeRuntime();
      const r = await probeFfmpeg({
        runner: rt.runner,
        pathEnv: rt.env('PATH'),
        isExecutable: (p) => rt.isExecutable(p),
        os: rt.os,
      });
      expect(isStatus(r.status)).toBe(true);
      if (r.status.found) expect(r.status.version).toMatch(/\S+/);
    },
  );
});
