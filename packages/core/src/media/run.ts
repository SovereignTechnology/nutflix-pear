import type { ProcessRunner } from '../contracts/media.js';
import { MediaError, isProcessRunnerError } from './errors.js';

/**
 * Run one ffmpeg/ffprobe step through the injected runner (argv only) and map every failure
 * to a `MediaError`: `aborted`, `ffmpeg-not-found` (the spawn failed), or `process-failed`
 * (non-zero exit, stderr attached). Shared by the pipeline and the NFX packager.
 */
export async function runOrThrow(
  runner: ProcessRunner,
  file: string,
  args: readonly string[],
  what: string,
  onStderrLine?: (line: string) => void,
): Promise<{ readonly stdout: Uint8Array; readonly stderr: string }> {
  let res: Awaited<ReturnType<ProcessRunner['run']>>;
  try {
    res = await runner.run(file, args, onStderrLine ? { onStderrLine } : undefined);
  } catch (e) {
    if (isProcessRunnerError(e)) {
      if (e.code === 'aborted') throw new MediaError('aborted', `${what}: aborted`, { cause: e });
      throw new MediaError(
        'ffmpeg-not-found',
        `${what}: could not spawn ${e.file}${e.errno ? ` (${e.errno})` : ''}`,
        { cause: e },
      );
    }
    throw new MediaError('process-failed', `${what}: runner failed`, { cause: e });
  }
  if (res.exitCode !== 0) {
    throw new MediaError('process-failed', `${what}: exit ${res.exitCode}`, {
      stderr: res.stderr,
    });
  }
  return res;
}
