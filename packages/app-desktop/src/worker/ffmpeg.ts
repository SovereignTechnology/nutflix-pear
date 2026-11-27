/**
 * System ffmpeg probe (ADR 0005: ffmpeg is NOT bundled; Studio uses the one on the machine).
 *
 * Order: the configured path (Settings; the host passes it) — and if that one does not work
 * the answer is `found: false` with that `path`, never a silent fallback, so Studio can say
 * "the path you set does not work" — else the first `ffmpeg` on `PATH` with an `ffprobe`
 * beside it, else (Linux) the Flatpak build's `/app/bin/ffmpeg` (`FLATPAK_FFMPEG`). "Works" =
 * executable AND `ffmpeg -version` exits 0 within a few seconds. The version is the token after
 * `ffmpeg version` on the first line, sanitised.
 *
 * Runtime-neutral: the process runner, the PATH lookup and the executable check are injected
 * (`bare-subprocess` / `bare-os` / `bare-fs` in the worker; Node or fakes in tests).
 */
import type { ProcessRunner, media } from '@sovit/core';

import type { FfmpegStatus } from '../ipc/protocol.js';
import { LIMITS } from '../ipc/protocol.js';

export type OsName = NonNullable<FfmpegStatus['os']>;
type FfmpegPaths = media.FfmpegPaths;

export interface FfmpegProbeDeps {
  readonly runner: ProcessRunner;
  /** `PATH` (or `undefined`). */
  readonly pathEnv: string | undefined;
  readonly isExecutable: (path: string) => Promise<boolean>;
  readonly os: OsName;
  /** Milliseconds `-version` may take (default 5000). */
  readonly timeoutMs?: number;
}

export interface FfmpegProbeResult {
  readonly status: FfmpegStatus;
  readonly paths: FfmpegPaths | null;
}

function sep(os: OsName): string {
  return os === 'windows' ? '\\' : '/';
}

function exe(os: OsName, name: 'ffmpeg' | 'ffprobe'): string {
  return os === 'windows' ? `${name}.exe` : name;
}

/** `ffprobe` next to `ffmpeg` (same directory, same extension convention). */
export function siblingFfprobe(ffmpeg: string, os: OsName): string {
  const i = Math.max(ffmpeg.lastIndexOf('/'), ffmpeg.lastIndexOf('\\'));
  const dir = i >= 0 ? ffmpeg.slice(0, i) : '.';
  return `${dir}${sep(os)}${exe(os, 'ffprobe')}`;
}

/** Candidate `ffmpeg` paths from `PATH`, absolute directories only (no cwd lookups). */
export function pathCandidates(pathEnv: string | undefined, os: OsName): string[] {
  if (pathEnv === undefined || pathEnv === '') return [];
  const dirs = pathEnv.split(os === 'windows' ? ';' : ':');
  const out: string[] = [];
  for (const d of dirs) {
    const dir = d.replace(/[\\/]+$/, '');
    const absolute =
      os === 'windows' ? /^[A-Za-z]:[\\/]/.test(d) || d.startsWith('\\\\') : d.startsWith('/');
    if (!absolute || dir === '') continue;
    out.push(`${dir}${sep(os)}${exe(os, 'ffmpeg')}`);
  }
  return out;
}

/**
 * Where a Flatpak build of the app ships ffmpeg and ffprobe. In a Flatpak, `/app` is the app's
 * own read-only prefix, and `/app/bin` is on the sandbox's PATH, but nothing guarantees that
 * PATH reaches the worker (a launcher or the host's spawn may set its own), so it is also asked
 * for by name, after PATH. Outside a Flatpak, `/app` at the filesystem root is root's to create,
 * as `/usr/bin` is: no local user can plant an ffmpeg there.
 */
export const FLATPAK_FFMPEG = '/app/bin/ffmpeg';

/** Where to look, in order, when no path is configured: `PATH`, then (Linux) `FLATPAK_FFMPEG`. */
export function ffmpegCandidates(pathEnv: string | undefined, os: OsName): string[] {
  const out = pathCandidates(pathEnv, os);
  if (os === 'linux' && !out.includes(FLATPAK_FFMPEG)) out.push(FLATPAK_FFMPEG);
  return out;
}

/** `ffmpeg version 6.1.1-3ubuntu5 Copyright …` → `6.1.1-3ubuntu5` (printable ASCII, capped). */
export function parseFfmpegVersion(firstLine: string): string | undefined {
  const m = /^ffmpeg version (\S+)/.exec(firstLine.trim());
  const v = m?.[1]?.replace(/[^\x21-\x7e]/g, '');
  return v === undefined || v === '' ? undefined : v.slice(0, LIMITS.maxLabel);
}

function timeoutSignal(ms: number): {
  readonly signal: { aborted: boolean; addEventListener(t: 'abort', cb: () => void): void };
  cancel(): void;
} {
  const listeners: (() => void)[] = [];
  const signal = {
    aborted: false,
    addEventListener(_t: 'abort', cb: () => void): void {
      listeners.push(cb);
    },
  };
  const timer = setTimeout(() => {
    signal.aborted = true;
    for (const cb of listeners) cb();
  }, ms);
  return {
    signal,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

async function works(
  deps: FfmpegProbeDeps,
  ffmpeg: string,
): Promise<(FfmpegPaths & { version?: string }) | null> {
  const ffprobe = siblingFfprobe(ffmpeg, deps.os);
  if (!(await deps.isExecutable(ffmpeg)) || !(await deps.isExecutable(ffprobe))) return null;
  const t = timeoutSignal(deps.timeoutMs ?? 5000);
  try {
    const r = await deps.runner.run(ffmpeg, ['-hide_banner', '-version'], { signal: t.signal });
    if (r.exitCode !== 0) return null;
    let text = '';
    for (const b of r.stdout.subarray(0, 512)) text += b < 0x80 ? String.fromCharCode(b) : '?';
    const version = parseFfmpegVersion(text.split(/\r?\n/, 1)[0] ?? '');
    return version === undefined ? { ffmpeg, ffprobe } : { ffmpeg, ffprobe, version };
  } catch {
    return null;
  } finally {
    t.cancel();
  }
}

/** Probe the configured path, else `PATH`, else (Linux) the Flatpak's `/app/bin`. Never throws. */
export async function probeFfmpeg(
  deps: FfmpegProbeDeps,
  configured?: string,
): Promise<FfmpegProbeResult> {
  const os = deps.os;
  if (configured !== undefined) {
    const ok = await works(deps, configured);
    if (ok === null) return { status: { found: false, path: configured, os }, paths: null };
    return {
      status: {
        found: true,
        path: ok.ffmpeg,
        os,
        ...(ok.version !== undefined ? { version: ok.version } : {}),
      },
      paths: { ffmpeg: ok.ffmpeg, ffprobe: ok.ffprobe },
    };
  }
  for (const candidate of ffmpegCandidates(deps.pathEnv, os)) {
    const ok = await works(deps, candidate);
    if (ok === null) continue;
    return {
      status: {
        found: true,
        path: ok.ffmpeg,
        os,
        ...(ok.version !== undefined ? { version: ok.version } : {}),
      },
      paths: { ffmpeg: ok.ffmpeg, ffprobe: ok.ffprobe },
    };
  }
  return { status: { found: false, os }, paths: null };
}
