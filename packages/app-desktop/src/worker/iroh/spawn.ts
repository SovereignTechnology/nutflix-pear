/**
 * `HelperSpawn` over `bare-subprocess.spawn` (injected, as `bare-process-runner.ts` takes it:
 * no `bare-*` addon loads under Node). Every stdio stream is a pipe: framed requests in, framed
 * replies out, diagnostics on stderr. Argv only, never a shell; the environment is inherited
 * and carries no secret (the iroh key, if any, goes in `init`).
 */
import type { BareSpawn } from '../transcode/bare-subprocess-types.js';
import type { HelperSpawn } from './helper.js';

export function bareHelperSpawn(spawn: BareSpawn): HelperSpawn {
  return (file, args) => spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
}
