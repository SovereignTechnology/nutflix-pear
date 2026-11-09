/**
 * The site build's rules and records (ADR 0022, M4), apart from `build-site.ts` so that tests can
 * call them: the lock, the bundle's deny list, the tree hash and `source.json`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The files of nfx's library tar, in the order `tar -tf` lists them (lib-tar.sh's order). */
export const LIB_FILES = ['api.d.ts', 'player.d.ts', 'player.js', 'wasm/nfx_wasm_bg.wasm'] as const;

/** Every file of `dist/site`, sorted bytewise (the tree hash's order). */
export const SITE_FILES = [
  'app.js',
  'index.html',
  'nfx/player.js',
  'nfx/wasm/nfx_wasm_bg.wasm',
  'shell.css',
  'source.json',
  'ui.css',
] as const;

export const NFX_REPO = 'https://github.com/SovereignTechnology/nfx';
export const PEAR_REPO = 'https://github.com/SovereignTechnology/nutflix-pear';

/** The command that builds the site from a clean checkout of `pear.commit` (README, source.json). */
export const BUILD_COMMAND =
  'npm ci --ignore-scripts && npx tsc -b && npm run -w packages/ui build:css && ' +
  'bash packages/app-web/scripts/nfx-lib.sh build && npm run -w packages/app-web build:site';

export interface NfxTool {
  readonly version: string;
  /** sha256 of its x86_64-unknown-linux-musl release tarball, for the tools that have one. */
  readonly sha256?: string;
}

export interface NfxLock {
  readonly commit: string;
  readonly sourceSha256: string;
  readonly libSha256: string;
  readonly tools: Readonly<Record<string, NfxTool>>;
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/** `nfx-web.lock`, checked as `scripts/nfx-lib.sh` checks it. Throws naming the line. */
export function parseLock(text: string): NfxLock {
  let pin: Pick<NfxLock, 'commit' | 'sourceSha256' | 'libSha256'> | null = null;
  const tools: Record<string, NfxTool> = {};
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const f = line.split(/\s+/);
    const where = `nfx-web.lock line ${String(i + 1)}`;
    if (f[0] === 'nfx') {
      if (pin !== null) throw new Error(`${where}: a second nfx line`);
      const [, commit = '', sourceSha256 = '', libSha256 = ''] = f;
      if (
        f.length !== 4 ||
        !HEX40.test(commit) ||
        !HEX64.test(sourceSha256) ||
        !HEX64.test(libSha256)
      )
        throw new Error(`${where}: not "nfx <commit> <source sha256> <library sha256>"`);
      pin = { commit, sourceSha256, libSha256 };
    } else if (f[0] === 'tool') {
      const [, name = '', version = '', sha256] = f;
      if (f.length < 3 || f.length > 4 || !/^[a-z][a-z0-9-]*$/.test(name) || !VERSION.test(version))
        throw new Error(`${where}: not "tool <name> <version> [<sha256>]"`);
      if (sha256 !== undefined && !HEX64.test(sha256)) throw new Error(`${where}: bad sha256`);
      if (name in tools) throw new Error(`${where}: a second ${name} line`);
      tools[name] = sha256 === undefined ? { version } : { version, sha256 };
    } else {
      throw new Error(`${where}: unknown line`);
    }
  }
  if (pin === null) throw new Error('nfx-web.lock: no nfx line');
  for (const t of ['rust', 'wasm-pack', 'wasm-bindgen'])
    if (!(t in tools)) throw new Error(`nfx-web.lock: no tool line for ${t}`);
  return { ...pin, tools };
}

/** What may not be in the page (ADR 0022): each rule matches an input path, `/`-separated. */
export const DENY: readonly { readonly what: string; readonly re: RegExp }[] = [
  { what: 'Cashu', re: /\/node_modules\/@cashu\// },
  { what: 'sodium', re: /\/node_modules\/sodium-[^/]+\// },
  {
    what: 'Hypercore',
    re: /\/node_modules\/(?:hypercore[^/]*|hyperswarm|hyperdht|hyperblobs|corestore|@hyperswarm\/[^/]+)\//,
  },
  { what: 'Bare', re: /\/node_modules\/(?:bare-[^/]+|@bare[^/]*\/[^/]+)\// },
  { what: 'Electron', re: /\/node_modules\/(?:electron|@electron\/[^/]+)\// },
  { what: 'Pear', re: /\/node_modules\/pear-[^/]+\// },
  { what: 'the recovery phrase (BIP-39)', re: /\/node_modules\/@scure\/bip39\// },
  {
    what: "core's wallet, payment, signer, pay/1, mock or media code",
    re: /\/(?:packages\/core|node_modules\/@sovit\/core)\/(?:src|dist)\/(?:wallet|payment|signer|pay-protocol|mocks|media)\//,
  },
  {
    what: "core's main entry (it brings the wallet; use @sovit/core/nostr and /nfx)",
    re: /\/(?:packages\/core|node_modules\/@sovit\/core)\/(?:src|dist)\/index\.[jt]s$/,
  },
  {
    what: 'the gateway, the seeder or the desktop app',
    re: /\/(?:packages|node_modules\/@sovit)\/(?:gateway|seeder|app-desktop)\//,
  },
  { what: 'a Node built-in', re: /^node:/ },
];

/** `inputs` (absolute paths, or esbuild's `ns:path` for virtual ones) that the deny list refuses. */
export function deniedInputs(inputs: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of inputs) {
    const p = raw.split(sep).join('/');
    const rule = DENY.find((d) => d.re.test(p));
    if (rule !== undefined) out.push(`${raw} (${rule.what})`);
  }
  return out;
}

/** The npm packages among `inputs`, by name, sorted: what the page is made of, for the log. */
export function npmPackages(inputs: readonly string[]): string[] {
  const names = new Set<string>();
  for (const raw of inputs) {
    const m = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(?!.*\/node_modules\/)/.exec(
      raw.split(sep).join('/'),
    );
    if (m?.[1] !== undefined) names.add(m[1]);
  }
  return [...names].sort();
}

export function sha256Hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** `sha384-…`, the SRI form. */
export function sri384(buf: Uint8Array): string {
  return `sha384-${createHash('sha384').update(buf).digest('base64')}`;
}

export interface TreeFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Every regular file under `root`, as a `/`-separated relative path, bytewise sorted. */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(root, p).split(sep).join('/'));
      else throw new Error(`not a regular file or directory: ${relative(root, p)}`);
    }
  };
  walk(root);
  return out.sort(byteOrder);
}

/**
 * The tree hash of `scripts/reproducible-build.mjs`: sha256 of the `sha256sum`-style manifest
 * (`<sha256>  <path>\n` per file, bytewise path order), so anyone can recompute it with coreutils:
 * `cd dist/site && find . -type f | sed 's#^\./##' | LC_ALL=C sort | xargs -d '\n' sha256sum | sha256sum`.
 */
export function hashTree(root: string): { readonly treeHash: string; readonly files: TreeFile[] } {
  const files: TreeFile[] = [];
  let manifest = '';
  for (const path of listFiles(root)) {
    const buf = readFileSync(join(root, path));
    const sha256 = sha256Hex(buf);
    files.push({ path, sha256, bytes: buf.length });
    manifest += `${sha256}  ${path}\n`;
  }
  return { treeHash: sha256Hex(Buffer.from(manifest, 'utf8')), files };
}

export interface SourceInput {
  readonly lock: NfxLock;
  readonly pearCommit: string;
  /** Whether the pear tree had changes `pearCommit` does not hold. */
  readonly modified: boolean;
  /** The library tar's own files (`LIB_FILES`). */
  readonly libFiles: readonly TreeFile[];
  /** The `Content-Security-Policy` header value the page is served with. */
  readonly csp: string;
  /** Every file of the site but `source.json`. */
  readonly files: readonly TreeFile[];
}

/** `source.json` (AGPL-3.0 §13, T13): where the page's every byte comes from. */
export function sourceRecord(s: SourceInput): string {
  const record = {
    name: 'nutflix-web',
    license: 'AGPL-3.0-or-later',
    pear: {
      repository: PEAR_REPO,
      commit: s.pearCommit,
      tree: s.modified ? 'modified' : 'clean',
      source: `${PEAR_REPO}/tree/${s.pearCommit}`,
    },
    nfx: {
      repository: NFX_REPO,
      commit: s.lock.commit,
      source: {
        url: `${NFX_REPO}/archive/${s.lock.commit}.tar.gz`,
        sha256: s.lock.sourceSha256,
      },
      library: {
        file: `nfx-web-lib-${s.lock.commit.slice(0, 12)}.tar`,
        sha256: s.lock.libSha256,
        built: 'web/player/lib-tar.sh in that source',
        files: s.libFiles,
      },
    },
    build: BUILD_COMMAND,
    csp: s.csp,
    files: s.files,
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}
