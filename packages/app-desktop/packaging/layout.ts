/**
 * What a finished package must look like (issue #6, ADR 0017), checked on every packaged output
 * before it counts (Forge `postPackage`), alongside the fuse read-back:
 *
 *   - `resources/app.asar` exists and there is no `resources/app/` folder (OnlyLoadAppFromAsar
 *     would refuse to start from one anyway);
 *   - main, the host and the renderer are PACKED (inside the archive, so on macOS/Windows the
 *     integrity fuse covers the code that holds the wallet and the signer);
 *   - the worker boot module, its bundle and the DLEQ thread's entry (`UNPACKED_FILES`) are
 *     UNPACKED regular files: never a symlink, nor under a symlinked directory, either of which
 *     could lead Bare out of the app's own directory. A missing thread entry would not stop the
 *     app (its worker would check every PAY's DLEQ proofs inline, on its event loop), so it is
 *     refused here;
 *   - bare-sidecar's runtime for this target is unpacked and executable (the host refuses it
 *     otherwise);
 *   - no other platform's `bare` runtime was shipped;
 *   - when the app was staged with it (slice 5e-5), the iroh helper is an unpacked, executable
 *     regular file under a real `iroh/` directory (the worker refuses it otherwise, and then
 *     speaks HyperDHT only — a build that meant to ship it must not pass for one that does).
 */
import { accessSync, constants, existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { statFile } from '@electron/asar';

import {
  PRELOAD_FILES,
  PROMPT_FILES,
  RENDERER_FILES,
  UNPACKED_FILES,
  packagedIrohHelper,
} from './identity.ts';

export function resourcesDir(outputDir: string, platform: string, productName: string): string {
  return platform === 'darwin' || platform === 'mas'
    ? join(outputDir, `${productName}.app`, 'Contents', 'Resources')
    : join(outputDir, 'resources');
}

/**
 * Files that must be packed (read from app.asar, covered by its header hash): everything main
 * loads or serves — its own bundle, the host, both preloads, and every file of the app window
 * and the prompt window (ADR 0013), derived from the same lists the staging step copies, so a
 * file added there is checked here too (independent review of the packaging lane).
 */
export const PACKED: readonly string[] = [
  'package.json',
  'main/main.js',
  'host/main.js',
  ...PRELOAD_FILES,
  ...RENDERER_FILES.map((f) => `renderer/${f}`),
  ...PROMPT_FILES.map((f) => `prompt/${f}`),
];

export function layoutProblems(
  outputDir: string,
  platform: string,
  arch: string,
  productName: string,
  irohHelper = false,
): string[] {
  const res = resourcesDir(outputDir, platform, productName);
  const asar = join(res, 'app.asar');
  const unpacked = join(res, 'app.asar.unpacked');
  const problems: string[] = [];
  if (!existsSync(asar)) return [`${asar} is missing`];
  if (existsSync(join(res, 'app')))
    problems.push(`${join(res, 'app')} exists (only app.asar may hold the app)`);
  for (const f of PACKED) {
    try {
      const e = statFile(asar, f) as { unpacked?: boolean; size?: number };
      if (e.unpacked === true) problems.push(`${f} is unpacked; it must be inside app.asar`);
    } catch {
      problems.push(`${f} is not in app.asar`);
    }
  }
  for (const f of UNPACKED_FILES) {
    // Every directory on the way too (`worker/`, `worker/pay/`): a linked directory leads out as
    // surely as a linked file.
    const parts = f.split('/');
    const linkedDir = parts
      .slice(0, -1)
      .map((_, i) => parts.slice(0, i + 1).join('/'))
      .find((d) => {
        try {
          return lstatSync(join(unpacked, d)).isSymbolicLink();
        } catch {
          return false;
        }
      });
    if (linkedDir !== undefined) {
      problems.push(`${f}: ${linkedDir}/ is a symlink; it must be a real directory`);
      continue;
    }
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(join(unpacked, f));
    } catch {
      problems.push(`${f} is not unpacked`);
      continue;
    }
    if (st.isSymbolicLink()) problems.push(`${f} is a symlink; it must be a regular file`);
    else if (!st.isFile()) problems.push(`${f} is not a regular file`);
  }
  const prebuilds = join(unpacked, 'node_modules', 'bare-sidecar', 'prebuilds');
  const bin = join(prebuilds, `${platform}-${arch}`, platform === 'win32' ? 'bare.exe' : 'bare');
  if (!existsSync(bin)) problems.push(`the Bare runtime for ${platform}-${arch} is missing`);
  else if (platform !== 'win32' && process.platform !== 'win32') {
    try {
      accessSync(bin, constants.X_OK);
    } catch {
      problems.push(`${bin} is not executable`);
    }
  }
  if (existsSync(prebuilds)) {
    const extra = readdirSync(prebuilds).filter(
      (d) => d !== `${platform}-${arch}` && !(platform === 'darwin' && d === 'darwin-universal'),
    );
    if (extra.length > 0)
      problems.push(`other platforms' Bare runtimes shipped: ${extra.join(', ')}`);
  }
  if (irohHelper) problems.push(...irohHelperProblems(unpacked, platform));
  return problems;
}

/** Slice 5e-5: the shipped iroh helper, as the worker will spawn it. */
function irohHelperProblems(unpacked: string, platform: string): string[] {
  const rel = packagedIrohHelper(platform);
  const dir = join(unpacked, rel.split('/')[0] ?? 'iroh');
  try {
    if (lstatSync(dir).isSymbolicLink()) return [`${rel}: its directory is a symlink`];
  } catch {
    return [`${rel} is not unpacked`];
  }
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(join(unpacked, rel));
  } catch {
    return [`${rel} is not unpacked`];
  }
  if (st.isSymbolicLink()) return [`${rel} is a symlink; it must be a regular file`];
  if (!st.isFile()) return [`${rel} is not a regular file`];
  if (platform !== 'win32' && process.platform !== 'win32') {
    try {
      accessSync(join(unpacked, rel), constants.X_OK);
    } catch {
      return [`${rel} is not executable`];
    }
  }
  return [];
}

export function assertLayout(
  outputDir: string,
  platform: string,
  arch: string,
  productName: string,
  irohHelper = false,
): void {
  const p = layoutProblems(outputDir, platform, arch, productName, irohHelper);
  if (p.length > 0) throw new Error(`packaged layout wrong in ${outputDir}:\n  ${p.join('\n  ')}`);
}
