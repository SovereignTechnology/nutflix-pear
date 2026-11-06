/**
 * Issue #6 (security review F21, ADR 0017): the desktop release manifest and its verifier.
 *
 * The manifest script writes SHA256SUMS, a JSON manifest and an UNSIGNED Nostr event for the
 * SovTech key; it never signs. The verifier accepts only an event whose signature verifies AND
 * whose key is the SovTech key, then checks every file's size and sha256.
 *
 * Signing here uses a THROWAWAY key generated in this process (nostr-tools), held in memory and
 * never written anywhere: the verifier CLI must refuse its events (not the SovTech key), and the
 * library entry point is called with that throwaway key only to reach the file checks.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { repoRoot, runNode, scriptsDir, tempDir } from './helpers.js';

interface Artifact {
  name: string;
  sha256: string;
  bytes: number;
}
interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}
interface VerifyLib {
  verifyRelease(
    ev: unknown,
    o: { files?: string[]; allDir?: string; trustedPubkey?: string },
  ): Promise<{ version: string; commit?: string; createdAt: number; files: Artifact[] }>;
  MAX_EVENT_BYTES: number;
}
interface ManifestLib {
  sovtechPubkeyHex(): string;
  SOVTECH_NPUB: string;
  RELEASE_NOTICE_KIND: number;
  MADE_LIST_SCHEMA: string;
  MADE_LIST_SUFFIX: string;
  DEFAULT_OUT: string;
  parseArgs(argv: string[]): { out: string };
  nameCarriesVersion(name: string, version: string): boolean;
  releaseArtifactNames(version: string): string[];
  ARTIFACT_SHAPES: readonly { maker: string; prefix: string; tails: readonly string[] }[];
  SAFE_NAME: RegExp;
}

const SOVTECH_HEX = '83d8bce2f7d6966f306e6f1a712497cf0a2c77d073923136a0e2bb54963b3434';
const sha256 = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

async function lib<T>(file: string): Promise<T> {
  const path = join(scriptsDir, file);
  return (await import(/* @vite-ignore */ path)) as T;
}

/** A module of packages/app-desktop/packaging (the makers and their config). */
async function packaging<T>(file: string): Promise<T> {
  const path = join(repoRoot, 'packages', 'app-desktop', 'packaging', file);
  return (await import(/* @vite-ignore */ path)) as T;
}

const hasBin = (bin: string): boolean => spawnSync('which', [bin]).status === 0;

/** NostrKind.ReleaseNotice from the contracts SOURCE (scripts cannot import packages/core). */
function releaseNoticeKind(): number {
  const src = readFileSync(join(repoRoot, 'packages/core/src/contracts/nostr.ts'), 'utf8');
  const m = /ReleaseNotice:\s*(\d+)/.exec(src);
  if (!m) throw new Error('NostrKind.ReleaseNotice not found');
  return Number(m[1]);
}

/**
 * TMPDIR as this file found it (lane I1, packaging round-3 verifier). `makerNames` points TMPDIR
 * into a test's own dir while the makers run. A test that times out leaves its maker promise
 * running and TMPDIR pointed there; `afterEach` then deletes that dir, and every later
 * `tempDir()` failed with ENOENT (10 misleading failures after the one real timeout). So
 * `afterEach` puts this value back (or its absence) before anything else.
 */
const ORIGINAL_TMPDIR: { readonly set: boolean; readonly value: string | undefined } = {
  set: Object.hasOwn(process.env, 'TMPDIR'),
  value: process.env['TMPDIR'],
};

function restoreTmpdir(): void {
  if (ORIGINAL_TMPDIR.set) process.env['TMPDIR'] = ORIGINAL_TMPDIR.value;
  else delete process.env['TMPDIR'];
}

/**
 * Point TMPDIR into `work/tmp` (the makers stage there, so `work`'s cleanup removes it). The
 * returned restore puts back what was there, but only while TMPDIR is still ours: a maker run
 * that outlived its test must not take TMPDIR away from the test running now.
 */
function tmpdirInto(work: string): () => void {
  const saved = process.env['TMPDIR'];
  const had = Object.hasOwn(process.env, 'TMPDIR');
  const mine = join(work, 'tmp');
  mkdirSync(mine, { recursive: true });
  process.env['TMPDIR'] = mine;
  return () => {
    if (process.env['TMPDIR'] !== mine) return;
    if (had) process.env['TMPDIR'] = saved;
    else delete process.env['TMPDIR'];
  };
}

let dir = '';
let cleanup: () => void = () => undefined;
let make = '';
let out = '';
// Every artifact name carries the release version (independent review of the packaging lane:
// the manifest refuses a name without it, so the Setup.exe is now versioned too).
const files: Record<string, Buffer> = {
  'Nutflix-0.1.0-x64.AppImage': Buffer.from('appimage '.repeat(1000)),
  'nutflix_0.1.0_amd64.deb': Buffer.from('deb '.repeat(777)),
  'Nutflix-0.1.0-Setup.exe': Buffer.from('exe'),
};

beforeEach(() => {
  ({ dir, cleanup } = tempDir('release'));
  make = join(dir, 'make');
  out = join(dir, 'out');
  mkdirSync(join(make, 'deb', 'x64'), { recursive: true });
  mkdirSync(join(make, 'appimage', 'x64'), { recursive: true });
  mkdirSync(join(make, 'squirrel.windows', 'x64'), { recursive: true });
  writeFileSync(
    join(make, 'appimage', 'x64', 'Nutflix-0.1.0-x64.AppImage'),
    files['Nutflix-0.1.0-x64.AppImage']!,
  );
  writeFileSync(
    join(make, 'deb', 'x64', 'nutflix_0.1.0_amd64.deb'),
    files['nutflix_0.1.0_amd64.deb']!,
  );
  writeFileSync(
    join(make, 'squirrel.windows', 'x64', 'Nutflix-0.1.0-Setup.exe'),
    files['Nutflix-0.1.0-Setup.exe']!,
  );
  // Not a release artifact: skipped, and listed on stderr.
  writeFileSync(join(make, 'squirrel.windows', 'x64', 'RELEASES'), 'x');
});
afterEach(() => {
  restoreTmpdir();
  cleanup();
});

function manifest(extra: string[] = []): ReturnType<typeof runNode> {
  return runNode('release-manifest.mjs', [
    make,
    '--out',
    out,
    '--version',
    '0.1.0',
    '--commit',
    'a'.repeat(40),
    '--created-at',
    '1790000000',
    ...extra,
  ]);
}

function unsigned(): NostrEvent {
  return JSON.parse(readFileSync(join(out, 'release-event.unsigned.json'), 'utf8')) as NostrEvent;
}

/** Signs a template with a throwaway key (in memory only) — what Bunker46 does with the real one. */
function signThrowaway(t: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>): {
  ev: NostrEvent;
  pubkey: string;
} {
  const sk = generateSecretKey();
  const ev = finalizeEvent(
    { kind: t.kind, tags: t.tags, content: t.content, created_at: t.created_at },
    sk,
  ) as unknown as NostrEvent;
  return { ev, pubkey: getPublicKey(sk) };
}

function artifactPaths(): string[] {
  return [
    join(make, 'appimage', 'x64', 'Nutflix-0.1.0-x64.AppImage'),
    join(make, 'deb', 'x64', 'nutflix_0.1.0_amd64.deb'),
    join(make, 'squirrel.windows', 'x64', 'Nutflix-0.1.0-Setup.exe'),
  ];
}

describe('scripts/release-manifest.mjs', () => {
  it('writes sha256sum-compatible SHA256SUMS over the release artifacts only', () => {
    const r = manifest();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/skipped \(not a release artifact\): .*RELEASES/);
    const names = Object.keys(files).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const expected = names.map((n) => `${sha256(files[n]!)}  ${n}\n`).join('');
    expect(readFileSync(join(out, 'SHA256SUMS'), 'utf8')).toBe(expected);
    expect(r.stdout).toBe(expected);
    const m = JSON.parse(readFileSync(join(out, 'release-manifest.json'), 'utf8')) as {
      artifacts: Artifact[];
      version: string;
      commit: string;
      app: string;
    };
    expect(m).toMatchObject({ app: 'nutflix-desktop', version: '0.1.0', commit: 'a'.repeat(40) });
    expect(m.artifacts).toEqual(
      names.map((n) => ({ name: n, sha256: sha256(files[n]!), bytes: files[n]!.byteLength })),
    );
  });

  it('writes an UNSIGNED kind-30071 event for the SovTech key (id and sig empty)', async () => {
    expect(manifest().status).toBe(0);
    const ev = unsigned();
    const m = await lib<ManifestLib>('release-manifest.mjs');
    expect(m.sovtechPubkeyHex()).toBe(SOVTECH_HEX);
    expect(m.SOVTECH_NPUB).toBe('npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx');
    expect(m.RELEASE_NOTICE_KIND).toBe(releaseNoticeKind());
    expect(ev).toMatchObject({
      id: '',
      sig: '',
      pubkey: SOVTECH_HEX,
      kind: 30071,
      created_at: 1790000000,
    });
    expect(ev.content).toBe(readFileSync(join(out, 'SHA256SUMS'), 'utf8'));
    expect(ev.tags.slice(0, 6)).toEqual([
      ['d', 'nutflix-desktop'],
      ['version', '0.1.0'],
      ['commit', 'a'.repeat(40)],
      ['x', sha256(ev.content)],
      ['files', '3'],
      ['size', String(Object.values(files).reduce((n, b) => n + b.byteLength, 0))],
    ]);
    expect(ev.tags.filter((t) => t[0] === 'artifact')).toHaveLength(3);
  });

  it('refuses unsafe names, duplicate names, symlinks and a malformed commit', () => {
    writeFileSync(join(dir, 'bad name.deb'), 'x');
    expect(
      runNode('release-manifest.mjs', [join(dir, 'bad name.deb'), '--out', out]).stderr,
    ).toMatch(/unsafe artifact name/);
    mkdirSync(join(dir, 'other'));
    writeFileSync(join(dir, 'other', 'nutflix_0.1.0_amd64.deb'), 'dup');
    // --version: the names must now carry it (the default is app-desktop's own version).
    const dup = runNode('release-manifest.mjs', [
      make,
      join(dir, 'other'),
      '--out',
      out,
      '--version',
      '0.1.0',
    ]);
    expect(dup.status).toBe(1);
    expect(dup.stderr).toMatch(/two artifacts named nutflix_0\.1\.0_amd64\.deb/);
    symlinkSync(join(make, 'deb', 'x64', 'nutflix_0.1.0_amd64.deb'), join(dir, 'link.deb'));
    expect(runNode('release-manifest.mjs', [join(dir, 'link.deb'), '--out', out]).stderr).toMatch(
      /symlinks/,
    );
    expect(manifest(['--commit', 'HEAD']).stderr).toMatch(/--commit must be a full 40-hex/);
  });

  it('never signs and never talks to the network (source hygiene)', () => {
    const src = readFileSync(join(scriptsDir, 'release-manifest.mjs'), 'utf8');
    for (const bad of [
      /finalizeEvent/,
      /getPublicKey/,
      /generateSecretKey/,
      /nsec1/,
      /bunker:\/\//,
      /wss:\/\//,
      /\bfetch\(/,
    ])
      expect(src).not.toMatch(bad);
    const verify = readFileSync(join(scriptsDir, 'release-verify.mjs'), 'utf8');
    for (const bad of [
      /finalizeEvent/,
      /nsec1/,
      /bunker:\/\//,
      /wss:\/\//,
      /\bfetch\(/,
      // The CLI never picks the trusted key: verifyRelease's default (SovTech) applies.
      /trustedPubkey:/,
    ])
      expect(verify).not.toMatch(bad);
  });
});

/** A made list as packaging/cli.ts writes it (relative to its own directory). */
function madeList(file: string, version: string, artifacts: string[]): string {
  writeFileSync(
    file,
    JSON.stringify({
      schema: 'nutflix-made/1',
      platform: 'linux',
      arch: 'x64',
      version,
      artifacts,
    }),
  );
  return file;
}

describe('scripts/release-manifest.mjs — one release, only this make (independent review)', () => {
  it('created_at is NOW by default, never SOURCE_DATE_EPOCH (a re-made manifest must be newer on the relays)', () => {
    const before = Math.floor(Date.now() / 1000);
    const r = runNode(
      'release-manifest.mjs',
      [make, '--out', out, '--version', '0.1.0', '--commit', 'a'.repeat(40)],
      { env: { SOURCE_DATE_EPOCH: '1700000000' } },
    );
    expect(r.status, r.stderr).toBe(0);
    const ev = unsigned();
    expect(ev.created_at).toBeGreaterThanOrEqual(before);
    expect(ev.created_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    const src = readFileSync(join(scriptsDir, 'release-manifest.mjs'), 'utf8');
    expect(src).not.toMatch(/env\.SOURCE_DATE_EPOCH/);
  });

  it('refuses an artifact whose name does not carry the version (a stale one in out/make)', () => {
    writeFileSync(join(make, 'appimage', 'x64', 'Nutflix-0.0.9-x64.AppImage'), 'old build');
    const r = manifest();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Nutflix-0\.0\.9-x64\.AppImage does not carry version 0\.1\.0/);
    expect(existsSync(join(out, 'release-event.unsigned.json'))).toBe(false);
  });

  it('nameCarriesVersion matches the version as a whole field only', async () => {
    const m = await lib<ManifestLib>('release-manifest.mjs');
    for (const n of [
      'Nutflix-0.1.0-x64.AppImage',
      'nutflix_0.1.0_amd64.deb',
      'Nutflix-0.1.0-Setup.exe',
      'Nutflix-0.1.0-arm64.dmg',
    ])
      expect(m.nameCarriesVersion(n, '0.1.0'), n).toBe(true);
    for (const n of [
      'Nutflix-Setup.exe',
      'Nutflix-0.1.01-x64.AppImage',
      'Nutflix-10.1.0-x64.AppImage',
      'Nutflix-0x1x0-x64.AppImage',
    ])
      expect(m.nameCarriesVersion(n, '0.1.0'), n).toBe(false);
    expect(m.nameCarriesVersion('a-0.1.0-x.deb', '0.1.0 ')).toBe(false);
  });

  it('--made takes exactly the artifacts that make produced; a stale file beside them is ignored', () => {
    writeFileSync(join(make, 'appimage', 'x64', 'Nutflix-0.0.9-x64.AppImage'), 'old build');
    const list = madeList(join(make, 'linux-x64.artifacts.json'), '0.1.0', [
      'deb/x64/nutflix_0.1.0_amd64.deb',
      'appimage/x64/Nutflix-0.1.0-x64.AppImage',
      'squirrel.windows/x64/RELEASES',
    ]);
    const r = runNode('release-manifest.mjs', [
      '--made',
      list,
      '--out',
      out,
      '--version',
      '0.1.0',
      '--commit',
      'a'.repeat(40),
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/skipped \(not a release artifact\): .*RELEASES/);
    expect(
      unsigned()
        .tags.filter((t) => t[0] === 'artifact')
        .map((t) => t[1]),
    ).toEqual(['Nutflix-0.1.0-x64.AppImage', 'nutflix_0.1.0_amd64.deb']);
  });

  it('--made refuses a list for another version, an empty or foreign list, and paths that escape it', () => {
    const run = (content: string): ReturnType<typeof runNode> => {
      const f = join(make, 'x.artifacts.json');
      writeFileSync(f, content);
      return runNode('release-manifest.mjs', ['--made', f, '--out', out, '--version', '0.1.0']);
    };
    const base = { schema: 'nutflix-made/1', platform: 'linux', arch: 'x64', version: '0.1.0' };
    expect(
      run(
        JSON.stringify({
          ...base,
          version: '0.0.9',
          artifacts: ['deb/x64/nutflix_0.1.0_amd64.deb'],
        }),
      ).stderr,
    ).toMatch(/made for version "0\.0\.9", not 0\.1\.0/);
    expect(run(JSON.stringify({ ...base, artifacts: [] })).stderr).toMatch(/lists no artifacts/);
    expect(run(JSON.stringify({ ...base, schema: 'x', artifacts: ['a'] })).stderr).toMatch(
      /is not a nutflix-made\/1 list/,
    );
    expect(run('{').stderr).toMatch(/is not JSON/);
    for (const bad of [
      '../make/deb/x64/nutflix_0.1.0_amd64.deb',
      '/etc/passwd',
      'deb\\x64\\a.deb',
      'deb//a.deb',
      './deb/a.deb',
    ])
      expect(run(JSON.stringify({ ...base, artifacts: [bad] })).stderr, bad).toMatch(
        /bad artifact path/,
      );
    // A list naming a symlink is refused like any other input.
    symlinkSync(
      join(make, 'deb', 'x64', 'nutflix_0.1.0_amd64.deb'),
      join(make, 'nutflix_0.1.0_link.deb'),
    );
    expect(run(JSON.stringify({ ...base, artifacts: ['nutflix_0.1.0_link.deb'] })).stderr).toMatch(
      /symlinks/,
    );
  });

  it('--out defaults to packages/app-desktop/out/release (gitignored), never the working directory', async () => {
    const m = await lib<ManifestLib>('release-manifest.mjs');
    expect(m.DEFAULT_OUT).toBe(join(repoRoot, 'packages', 'app-desktop', 'out', 'release'));
    expect(m.parseArgs([make]).out).toBe(m.DEFAULT_OUT);
    expect(readFileSync(join(repoRoot, '.gitignore'), 'utf8')).toMatch(
      /^packages\/app-desktop\/out\/$/m,
    );
  });

  it('the made-list schema and suffix are the ones packaging/cli.ts writes', async () => {
    const m = await lib<ManifestLib>('release-manifest.mjs');
    const identity = (await import(
      /* @vite-ignore */ join(repoRoot, 'packages', 'app-desktop', 'packaging', 'identity.ts')
    )) as { MADE_LIST_SCHEMA: string; MADE_LIST_SUFFIX: string; RELEASE_D_TAG: string };
    expect(m.MADE_LIST_SCHEMA).toBe(identity.MADE_LIST_SCHEMA);
    expect(m.MADE_LIST_SUFFIX).toBe(identity.MADE_LIST_SUFFIX);
    expect(identity.RELEASE_D_TAG).toBe('nutflix-desktop');
  });

  it('the CI makes ONE release event, after every platform job (kind 30071 is addressable)', () => {
    const ci = readFileSync(
      join(repoRoot, 'packages', 'app-desktop', 'packaging', 'ci', 'release.gitlab-ci.yml'),
      'utf8',
    );
    const code = ci
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    const runs = code.match(/release-manifest\.mjs[^\n]*(?:\n\s+--[^\n]*)*/g) ?? [];
    expect(runs).toHaveLength(1);
    for (const list of ['linux-x64', 'darwin-arm64', 'darwin-x64', 'win32-x64'])
      expect(runs[0], list).toContain(
        `--made packages/app-desktop/out/make/${list}.artifacts.json`,
      );
    expect(code).toMatch(
      /^desktop-release-manifest:\n(?: {2}.*\n)*? {2}needs: \[desktop-linux, desktop-macos, desktop-windows\]\n/m,
    );
    // …and it is the job that runs it: the only script line naming release-manifest.mjs.
    const job = /^desktop-release-manifest:\n((?: {2}.*\n|\s*\n)*)/m.exec(code)?.[1] ?? '';
    expect(job).toContain('release-manifest.mjs');
  });

  // Cameron, 2026-10-02: 0.1.0 is Linux only, released from GitHub Actions on `desktop-v*`
  // tags into a DRAFT GitHub release; PRs that touch the packaging run the build as a dry run.
  it('the GitHub release workflow: one manifest after the Linux job; only a tag-only draft job writes', async () => {
    const wf = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
    const code = wf
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).toMatch(/^on:\n {2}push:\n {4}tags: \['desktop-v\*'\]\n {2}pull_request:\n/m);
    // ONE manifest run, over the Linux list, after the Linux job.
    const runs = code.match(/node scripts\/release-manifest\.mjs[^\n]*(?:\n\s+--[^\n]*)*/g) ?? [];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain('--made packages/app-desktop/out/make/linux-x64.artifacts.json');
    expect(code).toMatch(/^ {2}desktop-release-manifest:\n {4}needs: \[desktop-linux\]\n/m);
    // A tag must name the version being built.
    expect(code).toContain('"$GITHUB_REF_NAME" != "desktop-v$v"');
    // Read-only by default; write only in draft-release, only on a tag push, only a draft, and
    // that job runs no project code.
    expect(code).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(code.match(/contents: write/g)).toHaveLength(1);
    const draft = /^ {2}draft-release:\n((?: {4}.*\n|\s*\n)*)/m.exec(code)?.[1] ?? '';
    expect(draft).toMatch(/^ {4}if: github\.event_name == 'push'\n/m);
    expect(draft).toMatch(/^ {6}contents: write\n/m);
    expect(draft).toContain('gh release create "$GITHUB_REF_NAME" --draft --verify-tag');
    expect(draft).not.toMatch(/\bnpm\b|\bnode\b/);
    // Every action pinned to a full commit sha; no secrets; no stored credentials.
    const uses = code.match(/uses: \S+/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^uses: actions\/[a-z-]+@[0-9a-f]{40}$/);
    expect(code).not.toMatch(/secrets\./);
    expect(code.match(/persist-credentials: false/g)?.length).toBe(
      code.match(/uses: actions\/checkout@/g)?.length,
    );
    // The runtime it fetches is checked against the maker's own pin.
    const { APPIMAGE_RUNTIMES } = (await import(
      /* @vite-ignore */ join(repoRoot, 'packages', 'app-desktop', 'packaging', 'maker-appimage.ts')
    )) as { APPIMAGE_RUNTIMES: Record<string, { asset: string; sha256: string }> };
    const x64 = APPIMAGE_RUNTIMES['x64'];
    expect(code).toContain(`releases/download/20251108/${x64?.asset ?? '?'}`);
    expect(code).toContain(
      `echo '${x64?.sha256 ?? '?'}  packages/app-desktop/out/appimage-runtime/`,
    );
    // Slice 5e-5: the app ships the iroh helper built in this job, from this commit and its
    // Cargo.lock, with the crate's pinned toolchain, and never from a cache.
    expect(code).toContain('grep -qx "channel = \\"${RUST_VERSION}\\"" crates/iroh-helper/');
    expect(code).toContain('cargo build --release --locked');
    expect(code).toMatch(
      /make -- --platform linux --arch x64 --targets deb,appimage \\\n\s+--iroh-helper "\$GITHUB_WORKSPACE\/crates\/iroh-helper\/target\/release\/nutflix-iroh-helper"/,
    );
    expect(code).not.toContain('actions/cache@');
  });
});

/** A Forge maker as the tests drive it (the config is resolved by prepareConfig). */
interface MakerLike {
  name: string;
  config: Record<string, unknown>;
  prepareConfig(arch: string): Promise<void>;
  make(o: Record<string, unknown>): Promise<string[]>;
}
interface IdentityLib {
  APP: { name: string; productName: string };
  BUILD_ARCHES: readonly string[];
}
interface ForgeConfigLib {
  TARGETS: readonly string[];
  makers: (o: {
    version: string;
    electronChecksums: Record<string, string>;
    appImageRuntimeDir: string;
    targets?: readonly string[];
  }) => unknown[];
}
type MakerCtor = new (config: Record<string, unknown>) => MakerLike;

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** electron-installer-common's .deb staging dirs in `root` (tmp: `<prefix>-<pid>-<random>`). */
const installerStaging = (root: string): string[] =>
  readdirSync(root).filter((n) => n.startsWith('electron-installer-'));

/**
 * The file names the four configured makers write for `version` on every build arch: Squirrel's
 * `setupExe` from the Forge config, the dmg maker with hdiutil stubbed, and — when `real` — the
 * real deb maker (electron-installer-debian, dpkg + fakeroot) and the real AppImage maker
 * (mksquashfs, a fixture runtime) run over a minimal packaged tree with the staged package.json's
 * fields (stage.ts: no Debian `revision`). The makers' temp files go to `<work>/tmp`.
 */
async function makerNames(version: string, work: string, real: boolean): Promise<string[]> {
  // electron-installer-common stages each .deb in tmp.dir() and removes it only in tmp's
  // graceful-cleanup exit hook, which never runs in a vitest worker (verifier, round 3). tmp
  // reads os.tmpdir(), and so TMPDIR, on every call: point it into `work` while the makers run,
  // so the caller's cleanup of `work` removes the staging, then restore it (or its absence).
  // A timeout skips that restore until the makers finish: afterEach restores TMPDIR too.
  const restore = tmpdirInto(work);
  try {
    return await makeNames(version, work, real);
  } finally {
    restore();
  }
}

async function makeNames(version: string, work: string, real: boolean): Promise<string[]> {
  const { APP, BUILD_ARCHES } = await packaging<IdentityLib>('identity.ts');
  const { makers } = await packaging<ForgeConfigLib>('forge-config.ts');
  const { MakerDmg } = await packaging<{ MakerDmg: MakerCtor }>('maker-dmg.ts');
  const { MakerAppImage } = await packaging<{ MakerAppImage: MakerCtor }>('maker-appimage.ts');
  const app = join(work, `app-${version}`);
  mkdirSync(join(app, 'resources', 'app'), { recursive: true });
  writeFileSync(join(app, APP.name), '#!/bin/sh\n');
  chmodSync(join(app, APP.name), 0o755);
  writeFileSync(join(app, 'version'), '44.2.0');
  writeFileSync(join(app, 'LICENSE'), 'license');
  writeFileSync(join(app, 'LICENSES.chromium.html'), 'licenses');
  writeFileSync(
    join(app, 'resources', 'app', 'package.json'),
    JSON.stringify({
      name: APP.name,
      productName: APP.productName,
      version,
      description: 'd',
      author: 'SovTech',
      license: 'AGPL-3.0-or-later',
      main: 'main/main.js',
      type: 'module',
    }),
  );
  const runtime = Buffer.from('#fixture-runtime#'.repeat(8));
  writeFileSync(join(work, 'rt'), runtime);
  const names = new Set<string>();
  for (const arch of BUILD_ARCHES) {
    const [sq, dmg, deb, appimage] = makers({
      version,
      electronChecksums: {},
      appImageRuntimeDir: work,
    }) as MakerLike[];
    for (const mk of [sq, dmg, deb, appimage]) await mk!.prepareConfig(arch);
    names.add(String(sq!.config['setupExe']));
    const make = (mk: MakerLike, targetPlatform: string): Promise<string[]> =>
      mk.make({
        dir: app,
        makeDir: join(work, `make-${version}`),
        appName: APP.productName,
        targetPlatform,
        targetArch: arch,
        forgeConfig: {},
        packageJSON: { version },
      });
    const stubbedDmg = new MakerDmg({ ...dmg!.config, exec: () => Promise.resolve() });
    await stubbedDmg.prepareConfig(arch);
    for (const out of await make(stubbedDmg, 'darwin')) names.add(basename(out));
    if (!real) continue;
    for (const out of await make(deb!, 'linux')) names.add(basename(out));
    const fixtureAppImage = new MakerAppImage({
      ...appimage!.config,
      runtimes: {
        [arch]: { asset: 'rt', sha256: createHash('sha256').update(runtime).digest('hex') },
      },
    });
    await fixtureAppImage.prepareConfig(arch);
    for (const out of await make(fixtureAppImage, 'linux')) names.add(basename(out));
  }
  return [...names].sort(byteOrder);
}

// Verifier, round 2: `nameCarriesVersion` took the version followed by ANY `-`, `_` or `.`, so
// for 0.1.0 it accepted a stale prerelease or extended build (`Nutflix-0.1.0-rc.1-x64.AppImage`,
// `Nutflix-0.1.0.1-x64.AppImage`) and positional mode would have signed it into 0.1.0.
describe('scripts/release-manifest.mjs — exact maker names (verifier, round 2)', () => {
  it('refuses a prerelease, an extended version, another maker shape or arch, for version 0.1.0', async () => {
    const m = await lib<ManifestLib>('release-manifest.mjs');
    for (const n of [
      // The verifier's four examples.
      'Nutflix-0.1.0-rc.1-x64.AppImage',
      'nutflix_0.1.0-rc1_amd64.deb',
      'Nutflix-0.1.0.1-x64.AppImage',
      'nutflix-0.1.0-full.nupkg',
      // More of the same shape.
      'Nutflix-0.1.0-rc.1-Setup.exe',
      'Nutflix-0.1.0-beta-arm64.dmg',
      'nutflix_0.1.0+b1_amd64.deb',
      'nutflix_0.1.0~rc.1_amd64.deb',
      'nutflix_0.1.0-1_amd64.deb', // a Debian revision: the maker writes none
      'Nutflix-0.1.0-x64.zip',
      'Nutflix-0.1.0-x64.AppImage.zsync',
      'Nutflix-0.1.0-Setup.exe.blockmap',
      'Nutflix-0.1.0-ia32.AppImage', // not a build arch (cli.ts), no pinned runtime
      'nutflix_0.1.0_i386.deb',
      'Nutflix-0.1.0-universal.dmg',
      'Nutflix-0.1.0-amd64.AppImage', // the Debian arch name on a Forge shape
      'nutflix_0.1.0_x64.deb', // and the other way round
      'Nutflix-0.1.0-x64.deb',
      'Other-0.1.0-x64.AppImage',
      'nutflix-0.1.0-x64.AppImage',
      'Nutflix_0.1.0_amd64.deb',
      'xNutflix-0.1.0-x64.AppImage',
      'Nutflix-0.1.0-x64.AppImagex',
    ])
      expect(m.nameCarriesVersion(n, '0.1.0'), n).toBe(false);
    for (const n of [
      'Nutflix-0.1.0-x64.AppImage',
      'Nutflix-0.1.0-arm64.AppImage',
      'Nutflix-0.1.0-x64.dmg',
      'Nutflix-0.1.0-arm64.dmg',
      'nutflix_0.1.0_amd64.deb',
      'nutflix_0.1.0_arm64.deb',
      'Nutflix-0.1.0-Setup.exe',
    ])
      expect(m.nameCarriesVersion(n, '0.1.0'), n).toBe(true);
    // A prerelease release is matched whole as well: its names carry exactly its version.
    for (const n of ['Nutflix-0.1.0-rc.1-x64.AppImage', 'Nutflix-0.1.0-rc.1-Setup.exe'])
      expect(m.nameCarriesVersion(n, '0.1.0-rc.1'), n).toBe(true);
    for (const n of [
      'Nutflix-0.1.0-x64.AppImage',
      'Nutflix-0.1.0-rc.10-x64.AppImage',
      'Nutflix-0.1.0-rc.1.1-x64.AppImage',
    ])
      expect(m.nameCarriesVersion(n, '0.1.0-rc.1'), n).toBe(false);
  });

  it('positional mode refuses a stale rc artifact left in out/make for the 0.1.0 release', () => {
    writeFileSync(join(make, 'appimage', 'x64', 'Nutflix-0.1.0-rc.1-x64.AppImage'), 'rc build');
    const r = manifest();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Nutflix-0\.1\.0-rc\.1-x64\.AppImage does not carry version 0\.1\.0/);
    expect(existsSync(join(out, 'release-event.unsigned.json'))).toBe(false);
    // …and so does a direct file argument, which skips the extension filter.
    writeFileSync(join(dir, 'nutflix-0.1.0-full.nupkg'), 'nupkg');
    const direct = runNode('release-manifest.mjs', [
      join(dir, 'nutflix-0.1.0-full.nupkg'),
      '--out',
      out,
      '--version',
      '0.1.0',
    ]);
    expect(direct.status).toBe(1);
    expect(direct.stderr).toMatch(/nutflix-0\.1\.0-full\.nupkg does not carry version 0\.1\.0/);
  });

  it("the shapes are the makers' own: prefixes, build arches, runtime pins, Debian arches", async () => {
    const m = await lib<ManifestLib>('release-manifest.mjs');
    const { APP, BUILD_ARCHES } = await packaging<IdentityLib>('identity.ts');
    const { TARGETS } = await packaging<ForgeConfigLib>('forge-config.ts');
    const { APPIMAGE_RUNTIMES } = await packaging<{ APPIMAGE_RUNTIMES: Record<string, unknown> }>(
      'maker-appimage.ts',
    );
    const { debianArch } = (await import('@electron-forge/maker-deb')) as unknown as {
      debianArch: (a: string) => string;
    };
    // cli.ts builds only BUILD_ARCHES, and each has a pinned AppImage runtime.
    expect([...BUILD_ARCHES].sort()).toEqual(Object.keys(APPIMAGE_RUNTIMES).sort());
    expect([...m.ARTIFACT_SHAPES].map((s) => s.maker).sort()).toEqual([...TARGETS].sort());
    const shape = (maker: string): unknown => m.ARTIFACT_SHAPES.find((s) => s.maker === maker);
    expect(shape('appimage')).toEqual({
      maker: 'appimage',
      prefix: `${APP.productName}-`,
      tails: BUILD_ARCHES.map((a) => `-${a}.AppImage`),
    });
    expect(shape('dmg')).toEqual({
      maker: 'dmg',
      prefix: `${APP.productName}-`,
      tails: BUILD_ARCHES.map((a) => `-${a}.dmg`),
    });
    expect(shape('deb')).toEqual({
      maker: 'deb',
      prefix: `${APP.name}_`,
      tails: BUILD_ARCHES.map((a) => `_${debianArch(a)}.deb`),
    });
    expect(shape('squirrel')).toEqual({
      maker: 'squirrel',
      prefix: `${APP.productName}-`,
      tails: ['-Setup.exe'],
    });
    // Why a name then matches only an artifact made for exactly this version: prefix + X + tail
    // = prefix' + V + tail' with X ≠ V needs one prefix to start another or one tail to end another.
    const prefixes = [...new Set(m.ARTIFACT_SHAPES.map((s) => s.prefix))];
    const tails = m.ARTIFACT_SHAPES.flatMap((s) => s.tails);
    expect(new Set(tails).size).toBe(tails.length);
    for (const a of tails)
      for (const b of tails) if (a !== b) expect(b.endsWith(a), `${a} ends ${b}`).toBe(false);
    for (const a of prefixes)
      for (const b of prefixes)
        if (a !== b) expect(b.startsWith(a), `${a} starts ${b}`).toBe(false);
  });

  it('accepts what the Squirrel config and the dmg maker (stubbed hdiutil) write, per version', async () => {
    const m = await lib<ManifestLib>('release-manifest.mjs');
    const written = await makerNames('0.1.0', dir, false);
    expect(written).toEqual([
      'Nutflix-0.1.0-Setup.exe',
      'Nutflix-0.1.0-arm64.dmg',
      'Nutflix-0.1.0-x64.dmg',
    ]);
    for (const n of written) expect(m.nameCarriesVersion(n, '0.1.0'), n).toBe(true);
    const rc = await makerNames('0.1.0-rc.1', dir, false);
    for (const n of rc) expect(m.nameCarriesVersion(n, '0.1.0-rc.1'), n).toBe(true);
    // Each version's artifacts are stale for the other.
    for (const n of written) expect(m.nameCarriesVersion(n, '0.1.0-rc.1'), n).toBe(false);
    for (const n of rc) expect(m.nameCarriesVersion(n, '0.1.0'), n).toBe(false);
  });

  it.runIf(process.platform === 'linux' && ['mksquashfs', 'dpkg', 'fakeroot'].every(hasBin))(
    'accepts exactly what the four makers write, no more (real deb and AppImage makers)',
    async () => {
      const m = await lib<ManifestLib>('release-manifest.mjs');
      // Verifier, round 3: electron-installer-common stages each .deb in tmp.dir() and removes
      // it only in tmp's graceful-cleanup exit hook, which never runs in a vitest worker, so
      // every run left ~0.5 MB per .deb in the real os.tmpdir(). Nothing may be left there.
      const realTmp = tmpdir();
      const tmpdirEnv = process.env['TMPDIR'];
      const before = new Set(installerStaging(realTmp));
      const written = await makerNames('0.1.0', dir, true);
      expect(written).toEqual([...m.releaseArtifactNames('0.1.0')].sort(byteOrder));
      expect(written).toHaveLength(7);
      // A prerelease: electron-installer-debian writes its Debian form (`0.1.0~rc.1`), and `~`
      // is not a safe artifact name, so the manifest refuses that .deb (fails closed; ADR 0017
      // §8). Everything else it writes is accepted for that version and refused for 0.1.0.
      const rc = await makerNames('0.1.0-rc.1', dir, true);
      const debs = rc.filter((n) => n.endsWith('.deb'));
      expect(debs).toEqual(['nutflix_0.1.0~rc.1_amd64.deb', 'nutflix_0.1.0~rc.1_arm64.deb']);
      for (const n of debs) expect(m.SAFE_NAME.test(n), n).toBe(false);
      for (const n of rc.filter((x) => !x.endsWith('.deb')))
        expect(m.nameCarriesVersion(n, '0.1.0-rc.1'), n).toBe(true);
      for (const n of rc) expect(m.nameCarriesVersion(n, '0.1.0'), n).toBe(false);
      for (const n of written) expect(m.nameCarriesVersion(n, '0.1.0-rc.1'), n).toBe(false);
      // Round 3, continued. Only this process's staging counts (the pid is in tmp's name):
      // another test process or session may be staging in os.tmpdir() at the same time.
      const ours = `-${process.pid}-`;
      const left = installerStaging(realTmp).filter((n) => !before.has(n));
      expect(left.filter((n) => n.includes(ours))).toEqual([]);
      // Not vacuous: the four .debs (two arches, two versions) were staged in the test's own
      // dir, under this pid, which afterEach's cleanup removes; and TMPDIR is restored.
      const staged = installerStaging(join(dir, 'tmp'));
      expect(staged).toHaveLength(4);
      for (const n of staged) expect(n).toContain(ours);
      expect(process.env['TMPDIR']).toBe(tmpdirEnv);
      expect(Object.hasOwn(process.env, 'TMPDIR')).toBe(tmpdirEnv !== undefined);
    },
    60_000,
  );
});

// Lane I1 (packaging round-3 verifier, Low): a real-maker test that timed out left TMPDIR in a
// dir afterEach then deleted, and the 10 tests after it failed with ENOENT. Ordered on purpose:
// the first test leaves exactly what such a timeout leaves; the second is the test after it.
// (Manual check, recorded in docs/archive/reviews/2026-09-25-pre-push-dleq-packaging.md: with that
// test's timeout cut to 300 ms, the file now fails 1 test, the timeout, not 11.)
describe('a maker run that outlives its test does not take TMPDIR with it (lane I1)', () => {
  it('leaves TMPDIR pointed into its own dir, unrestored, as a timed-out makerNames does', () => {
    tmpdirInto(dir); // the makers are still running: nothing restores it
    expect(process.env['TMPDIR']).toBe(join(dir, 'tmp'));
    expect(tmpdir()).toBe(join(dir, 'tmp'));
  });

  it('the next test finds TMPDIR as this file found it, and can make a temp dir', () => {
    expect(Object.hasOwn(process.env, 'TMPDIR')).toBe(ORIGINAL_TMPDIR.set);
    expect(process.env['TMPDIR']).toBe(ORIGINAL_TMPDIR.value);
    const t = tempDir('release-after-timeout'); // ENOENT here before the fix
    expect(existsSync(t.dir)).toBe(true);
    t.cleanup();
  });

  it('when the old run finally settles, its restore leaves the current test’s TMPDIR alone', () => {
    const late = tmpdirInto(join(dir, 'a')); // test A's makers, then A times out
    restoreTmpdir(); // afterEach
    const current = tmpdirInto(join(dir, 'b')); // test B's makers
    late(); // A's makers settle at last
    expect(process.env['TMPDIR']).toBe(join(dir, 'b', 'tmp'));
    current();
    expect(Object.hasOwn(process.env, 'TMPDIR')).toBe(ORIGINAL_TMPDIR.set);
    expect(process.env['TMPDIR']).toBe(ORIGINAL_TMPDIR.value);
  });
});

describe('scripts/release-verify.mjs', () => {
  it('the CLI REFUSES an event signed by any key but the SovTech one', () => {
    expect(manifest().status).toBe(0);
    const { ev } = signThrowaway(unsigned());
    writeFileSync(join(dir, 'signed.json'), JSON.stringify(ev));
    const r = runNode('release-verify.mjs', [join(dir, 'signed.json'), ...artifactPaths()]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not signed by the SovTech key/);
    expect(r.stdout).not.toMatch(/^OK/m);
  });

  it('the CLI refuses a throwaway-signed event that claims the SovTech pubkey (signature no longer verifies)', () => {
    expect(manifest().status).toBe(0);
    const { ev } = signThrowaway(unsigned());
    writeFileSync(join(dir, 'forged.json'), JSON.stringify({ ...ev, pubkey: SOVTECH_HEX }));
    const r = runNode('release-verify.mjs', [join(dir, 'forged.json'), '--all', make]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/id or signature does not verify/);
  });

  it('the CLI refuses an oversized event file (bytes read, symlink measured by its target) and a device', async () => {
    expect(manifest().status).toBe(0);
    const v = await lib<VerifyLib>('release-verify.mjs');
    const big = join(dir, 'big.json');
    writeFileSync(big, `{"pad":"${'x'.repeat(v.MAX_EVENT_BYTES)}"}`);
    const r = runNode('release-verify.mjs', [big, ...artifactPaths()]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/event file is too large/);
    symlinkSync(big, join(dir, 'small-looking.json'));
    expect(
      runNode('release-verify.mjs', [join(dir, 'small-looking.json'), ...artifactPaths()]).stderr,
    ).toMatch(/event file is too large/);
    if (existsSync('/dev/zero'))
      expect(runNode('release-verify.mjs', ['/dev/zero', ...artifactPaths()]).stderr).toMatch(
        /not a regular file/,
      );
  });

  // Verifier, round 2: `openSync(path, 'r')` waits for a writer on a FIFO, so the fstat refusal
  // was never reached and the CLI hung. The spawn is bounded: a regression fails, not hangs.
  it.runIf(process.platform !== 'win32' && hasBin('mkfifo'))(
    'the CLI refuses a FIFO event file at once, without waiting for a writer',
    () => {
      const fifo = join(dir, 'event.fifo');
      expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
      const r = runNode('release-verify.mjs', [fifo, ...artifactPaths()], { timeout: 8_000 });
      expect(r.signal, 'still blocked opening the FIFO when the timeout killed it').toBeNull();
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/event file is not a regular file/);
    },
    30_000,
  );

  it('the CLI refuses the unsigned template and junk', () => {
    expect(manifest().status).toBe(0);
    const u = runNode('release-verify.mjs', [
      join(out, 'release-event.unsigned.json'),
      ...artifactPaths(),
    ]);
    expect(u.status).toBe(1);
    expect(u.stderr).toMatch(/does not verify/);
    writeFileSync(join(dir, 'junk.json'), '{"not":"an event"');
    expect(
      runNode('release-verify.mjs', [join(dir, 'junk.json'), ...artifactPaths()]).stderr,
    ).toMatch(/not JSON/);
  });

  describe('file checks (reached with the throwaway key through the library entry point)', () => {
    it('the library defaults to the SovTech key and refuses a malformed trusted key', async () => {
      expect(manifest().status).toBe(0);
      const { ev } = signThrowaway(unsigned());
      const v = await lib<VerifyLib>('release-verify.mjs');
      await expect(v.verifyRelease(ev, { files: artifactPaths() })).rejects.toThrow(
        /not signed by the SovTech key/,
      );
      for (const bad of ['', 'ab', 'Z'.repeat(64)])
        await expect(
          v.verifyRelease(ev, { files: artifactPaths(), trustedPubkey: bad }),
        ).rejects.toThrow(/trusted key must be a 64-hex/);
    });

    it('accepts matching files and --all', async () => {
      expect(manifest().status).toBe(0);
      const { ev, pubkey } = signThrowaway(unsigned());
      const v = await lib<VerifyLib>('release-verify.mjs');
      expect(
        (await v.verifyRelease(ev, { files: artifactPaths(), trustedPubkey: pubkey })).files
          .map((a) => a.name)
          .sort(),
      ).toEqual(Object.keys(files).sort());
      const flat = join(dir, 'downloads');
      mkdirSync(flat);
      for (const [n, b] of Object.entries(files)) writeFileSync(join(flat, n), b);
      const all = await v.verifyRelease(ev, { allDir: flat, trustedPubkey: pubkey });
      expect(all.files).toHaveLength(3);
      // What was verified is reported: an old genuine release verifies too (no "latest").
      expect(all).toMatchObject({ version: '0.1.0', createdAt: 1790000000 });
    });

    it('reports the commit; refuses a symlinked download (never follows it to other bytes)', async () => {
      expect(manifest().status).toBe(0);
      const { ev, pubkey } = signThrowaway(unsigned());
      const v = await lib<VerifyLib>('release-verify.mjs');
      const deb = join(make, 'deb', 'x64', 'nutflix_0.1.0_amd64.deb');
      expect(await v.verifyRelease(ev, { files: [deb], trustedPubkey: pubkey })).toMatchObject({
        commit: 'a'.repeat(40),
      });
      const dl = join(dir, 'dl');
      mkdirSync(dl);
      symlinkSync(deb, join(dl, 'nutflix_0.1.0_amd64.deb'));
      await expect(
        v.verifyRelease(ev, {
          files: [join(dl, 'nutflix_0.1.0_amd64.deb')],
          trustedPubkey: pubkey,
        }),
      ).rejects.toThrow(/is not a regular file/);
    });

    it('refuses a changed byte, a truncated file, a file not in the release, a missing artifact', async () => {
      expect(manifest().status).toBe(0);
      const { ev, pubkey } = signThrowaway(unsigned());
      const v = await lib<VerifyLib>('release-verify.mjs');
      const deb = join(make, 'deb', 'x64', 'nutflix_0.1.0_amd64.deb');
      const orig = readFileSync(deb);
      const flipped = Buffer.from(orig);
      flipped[10] = flipped[10]! ^ 1;
      writeFileSync(deb, flipped);
      await expect(v.verifyRelease(ev, { files: [deb], trustedPubkey: pubkey })).rejects.toThrow(
        /sha256 does not match/,
      );
      writeFileSync(deb, orig.subarray(1));
      await expect(v.verifyRelease(ev, { files: [deb], trustedPubkey: pubkey })).rejects.toThrow(
        /size/,
      );
      writeFileSync(join(dir, 'Nutflix-9.9.9-x64.AppImage'), 'x');
      await expect(
        v.verifyRelease(ev, {
          files: [join(dir, 'Nutflix-9.9.9-x64.AppImage')],
          trustedPubkey: pubkey,
        }),
      ).rejects.toThrow(/not part of this release/);
      await expect(
        v.verifyRelease(ev, { allDir: join(dir, 'empty-nowhere'), trustedPubkey: pubkey }),
      ).rejects.toThrow(/is missing/);
      await expect(v.verifyRelease(ev, { files: [], trustedPubkey: pubkey })).rejects.toThrow(
        /at least one/,
      );
    });

    it('refuses events whose tags, content or kind disagree, and path-like artifact names', async () => {
      expect(manifest().status).toBe(0);
      const t = unsigned();
      const v = await lib<VerifyLib>('release-verify.mjs');
      const check = async (
        tpl: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>,
        re: RegExp,
      ): Promise<void> => {
        const { ev, pubkey } = signThrowaway(tpl);
        await expect(v.verifyRelease(ev, { allDir: make, trustedPubkey: pubkey })).rejects.toThrow(
          re,
        );
      };
      await check({ ...t, kind: 1 }, /wrong kind/);
      await check(
        { ...t, tags: t.tags.filter((x) => x[0] !== 'version') },
        /exactly one "version" tag/,
      );
      await check({ ...t, content: `${t.content}deadbeef  extra\n` }, /content does not match/);
      await check(
        { ...t, tags: t.tags.map((x) => (x[0] === 'd' ? ['d', 'nutflix-web'] : x)) },
        /not a desktop release/,
      );
      await check(
        { ...t, tags: t.tags.map((x) => (x[0] === 'x' ? ['x', '0'.repeat(64)] : x)) },
        /x tag/,
      );
      const evil = t.tags.map((x) =>
        x[0] === 'artifact' && x[1] === 'Nutflix-0.1.0-Setup.exe'
          ? ['artifact', '../../etc/passwd', x[2]!, x[3]!]
          : x,
      );
      await check({ ...t, tags: evil }, /malformed artifact tag \(name\)/);
      await check(
        { ...t, tags: [...t.tags, t.tags.find((x) => x[0] === 'artifact')!] },
        /listed twice/,
      );
      await check(
        { ...t, tags: t.tags.map((x) => (x[0] === 'files' ? ['files', '2'] : x)) },
        /files tag does not match the artifact count/,
      );
      await check(
        { ...t, tags: t.tags.map((x) => (x[0] === 'size' ? ['size', '1'] : x)) },
        /size tag does not match/,
      );
      await check({ ...t, tags: t.tags.filter((x) => x[0] !== 'size') }, /exactly one "size" tag/);
      await check(
        { ...t, tags: t.tags.map((x) => (x[0] === 'commit' ? ['commit', 'HEAD'] : x)) },
        /malformed commit tag/,
      );
      await check({ ...t, tags: [...t.tags, ['commit', 'b'.repeat(40)]] }, /more than one commit/);
      // Tampering after signing breaks the signature — even on an in-process copy that still
      // carries nostr-tools' cached "verified" flag (`{ ...ev }` copies that symbol property).
      // (Found by this test: checkEvent now re-verifies plain JSON data, see there.)
      const { ev, pubkey } = signThrowaway(t);
      await expect(
        v.verifyRelease(
          { ...ev, content: ev.content.replace(/^./, 'f') },
          { allDir: make, trustedPubkey: pubkey },
        ),
      ).rejects.toThrow(/does not verify/);
    });
  });
});
