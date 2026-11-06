#!/usr/bin/env node
// Issue #6 (security review F21, ADR 0017): the desktop release manifest.
//
// Writes, for a set of release artifacts (the .deb, .AppImage, .dmg, Setup.exe …):
//   SHA256SUMS                   `sha256sum -c` compatible: `<sha256>  <name>\n`, names sorted
//   release-manifest.json        name, bytes and sha256 of each artifact, version, commit
//   release-event.unsigned.json  an UNSIGNED Nostr event (NIP-01) for the SovTech key: kind
//                                30071 (NostrKind.ReleaseNotice), `d` = nutflix-desktop,
//                                content = the SHA256SUMS text, one `artifact` tag per file
//
// Nothing here signs, holds a key, or talks to a relay or a bunker. The event is signed later,
// by Cameron, through the SovTech key's NIP-46 signer (Bunker46); `id` and `sig` stay empty
// until then. scripts/release-verify.mjs checks a signed event against downloaded files.
//
// ONE event per release, over every platform's artifacts: kind 30071 is addressable, so relays
// keep one event per key + kind + `d`, and a per-platform event would replace the others
// (independent review of the packaging lane). The CI's final `desktop-release` job gathers the
// platform jobs' artifacts and runs this once.
//
// Event shape (verified field by field by release-verify.mjs):
//   kind       30071
//   pubkey     SOVTECH_PUBKEY_HEX (the signer sets/keeps it; a different key fails verify)
//   created_at when the manifest was made (now), never the commit time: a corrected manifest
//              for the same commit must be NEWER than the one it replaces on the relays
//   tags       ["d","nutflix-desktop"] ["version",v] ["commit",sha]? ["x",sha256(content)]
//              ["files",n] ["size",total] then ["artifact",name,sha256,bytes] per file
//   content    the SHA256SUMS text
//
// Only node:crypto sha256 and nostr-tools' nip19 decoder are used (no crypto of our own).
//
// Usage:
//   node scripts/release-manifest.mjs [--made <list>]... [<artifact|dir>...] [--out <dir>]
//        [--version <v>] [--commit <sha>] [--created-at <unix>]
//   --made names an `out/make/<platform>-<arch>.artifacts.json` list, written by
//   `packaging/cli.ts make`: exactly the artifacts THAT make produced (the preferred input).
//   A directory contributes every file under it with a release extension (.deb .AppImage
//   .dmg .exe .msix .zip .rpm); anything else is skipped (and listed on stderr).
//   Every artifact name must be exactly one a maker writes for this version (ARTIFACT_SHAPES:
//   `Nutflix-0.1.0-x64.AppImage`, `nutflix_0.1.0_amd64.deb`, `Nutflix-0.1.0-Setup.exe` …), so a
//   stale artifact of another version left in out/make, a prerelease one included, is refused,
//   not signed. A name cannot tell two builds of the SAME version apart: that takes --made.
//   --out defaults to packages/app-desktop/out/release (gitignored); --version to
//   @sovit/app-desktop's version; --commit to `git rev-parse HEAD`; --created-at to now.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  createReadStream,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { decode } from 'nostr-tools/nip19';

/** = NostrKind.ReleaseNotice (contracts v3); pinned to the contract by a test. */
export const RELEASE_NOTICE_KIND = 30071;
export const RELEASE_D_TAG = 'nutflix-desktop';
/**
 * Every release notice the SovTech key signs with these scripts, by its `d`: the desktop app, and
 * NFX's own releases (its nfxd and nfx-package tarball, 2026-11-06). The verify and publish
 * scripts take one of these with `--d` (default the desktop's); any other `d` is refused, and a
 * notice for one product never verifies as another's.
 */
export const RELEASE_D_TAGS = Object.freeze([RELEASE_D_TAG, 'nfx']);
/** The SovTech org key (Cameron, 2026-09-24): every release is signed by it, nothing else. */
export const SOVTECH_NPUB = 'npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx';

/** The SovTech key as hex, decoded with nostr-tools (a test pins the value). */
export function sovtechPubkeyHex() {
  const d = decode(SOVTECH_NPUB);
  if (d.type !== 'npub' || typeof d.data !== 'string')
    throw new Error('SOVTECH_NPUB is not an npub');
  return d.data;
}

export const RELEASE_EXTENSIONS = ['.deb', '.AppImage', '.dmg', '.exe', '.msix', '.zip', '.rpm'];

/** packaging/identity.ts MADE_LIST_SCHEMA / MADE_LIST_SUFFIX (pinned together by a test). */
export const MADE_LIST_SCHEMA = 'nutflix-made/1';
export const MADE_LIST_SUFFIX = '.artifacts.json';
/** A made list is a few hundred bytes; anything bigger is not one. */
const MAX_MADE_LIST_BYTES = 64 * 1024;

/** Where the manifest goes by default: under packages/app-desktop/out/ (gitignored). */
export const DEFAULT_OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'app-desktop',
  'out',
  'release',
);

const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

/**
 * Artifact names end up in `sha256sum` lines, event tags and file lookups: no path separators,
 * no whitespace or control characters, no leading dot, bounded.
 */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;

/** Bytewise order (LC_ALL=C), so the sums text is reproducible. */
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

export async function sha256File(path) {
  const h = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    h.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: h.digest('hex'), bytes };
}

/**
 * Expands inputs into artifact paths; symlinks and odd entries are refused. `filter`: skip
 * (and report) files without a release extension — always inside a directory, and for every
 * entry of a made list (Squirrel's list also names RELEASES and the .nupkg).
 */
export function collectArtifacts(inputs, skipped = [], filter = false) {
  const out = [];
  const visit = (p, fromDir) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`symlinks are not release artifacts: ${p}`);
    if (st.isDirectory()) {
      if (filter) throw new Error(`a made list names a directory: ${p}`);
      for (const e of readdirSync(p).sort(byteOrder)) visit(join(p, e), true);
      return;
    }
    if (!st.isFile()) throw new Error(`not a regular file: ${p}`);
    if ((fromDir || filter) && !RELEASE_EXTENSIONS.some((x) => p.endsWith(x))) {
      skipped.push(p);
      return;
    }
    out.push(resolve(p));
  };
  for (const i of inputs) visit(i, false);
  return out;
}

/**
 * The artifact paths of one `make` (packaging/cli.ts writes the list beside them), resolved
 * against the list's own directory. Refused: not a list, a list made for another version,
 * an empty list, and any entry that is absolute, uses backslashes or climbs out with `..`.
 */
export function readMadeList(file, version) {
  const st = statSync(file);
  if (!st.isFile() || st.size > MAX_MADE_LIST_BYTES)
    throw new Error(`${file} is not a made list (not a small regular file)`);
  let list;
  try {
    list = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not JSON`);
  }
  if (typeof list !== 'object' || list === null || list.schema !== MADE_LIST_SCHEMA)
    throw new Error(`${file} is not a ${MADE_LIST_SCHEMA} list`);
  if (list.version !== version)
    throw new Error(
      `${file} was made for version ${JSON.stringify(list.version)}, not ${version}: a stale list?`,
    );
  if (!Array.isArray(list.artifacts) || list.artifacts.length === 0)
    throw new Error(`${file} lists no artifacts`);
  const base = dirname(resolve(file));
  return list.artifacts.map((rel) => {
    if (
      typeof rel !== 'string' ||
      rel.startsWith('/') ||
      rel.includes('\\') ||
      rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
    )
      throw new Error(`${file}: bad artifact path ${JSON.stringify(rel)}`);
    return join(base, ...rel.split('/'));
  });
}

/**
 * The file names the makers write: `<prefix><version><tail>`, one of these exact tails (verifier,
 * round 2: the first rule took ANY `-`, `_` or `.` after the version, so for 0.1.0 it accepted a
 * stale `Nutflix-0.1.0-rc.1-x64.AppImage` or `Nutflix-0.1.0.1-x64.AppImage`). Pinned by
 * scripts/__tests__/release.test.ts to packages/app-desktop/packaging and to the real makers:
 *   appimage  maker-appimage.ts  `${productName}-${version}-${arch}.AppImage`
 *   dmg       maker-dmg.ts       `${productName}-${version}-${arch}.dmg`
 *   deb       @electron-forge/maker-deb (electron-installer-debian's default name, no revision)
 *                                `${name}_${version}_${debianArch(arch)}.deb`
 *   squirrel  forge-config.ts    `setupExe: ${productName}-${version}-Setup.exe`
 * `arch` is one of identity.ts BUILD_ARCHES (x64, arm64), the only ones cli.ts builds. No prefix
 * starts another and no tail ends another, so a name matches only an artifact made for exactly
 * this version. Squirrel's RELEASES and .nupkg are not release artifacts.
 * electron-installer-debian writes a prerelease in Debian form (`0.1.0-rc.1` → `0.1.0~rc.1`),
 * which SAFE_NAME refuses: a prerelease's .deb cannot be released yet (fails closed; ADR 0017 §8).
 */
export const ARTIFACT_SHAPES = Object.freeze([
  Object.freeze({
    maker: 'appimage',
    prefix: 'Nutflix-',
    tails: Object.freeze(['-x64.AppImage', '-arm64.AppImage']),
  }),
  Object.freeze({
    maker: 'dmg',
    prefix: 'Nutflix-',
    tails: Object.freeze(['-x64.dmg', '-arm64.dmg']),
  }),
  Object.freeze({
    maker: 'deb',
    prefix: 'nutflix_',
    tails: Object.freeze(['_amd64.deb', '_arm64.deb']),
  }),
  Object.freeze({ maker: 'squirrel', prefix: 'Nutflix-', tails: Object.freeze(['-Setup.exe']) }),
]);

/** Every name a maker writes for `version` (none for a malformed version). */
export function releaseArtifactNames(version) {
  if (typeof version !== 'string' || !VERSION.test(version)) return [];
  return ARTIFACT_SHAPES.flatMap((s) => s.tails.map((t) => `${s.prefix}${version}${t}`));
}

/** Whether `name` is exactly a name a maker writes for `version` (ARTIFACT_SHAPES). */
export function nameCarriesVersion(name, version) {
  return releaseArtifactNames(version).includes(name);
}

export function sumsText(artifacts) {
  return [...artifacts]
    .sort((a, b) => byteOrder(a.name, b.name))
    .map((a) => `${a.sha256}  ${a.name}\n`)
    .join('');
}

/** The unsigned NIP-01 event: `id` and `sig` empty until the SovTech signer fills them. */
export function unsignedEvent({ artifacts, version, commit, createdAt, d = RELEASE_D_TAG }) {
  if (!RELEASE_D_TAGS.includes(d)) throw new Error(`unknown release d ${JSON.stringify(d)}`);
  const sorted = [...artifacts].sort((a, b) => byteOrder(a.name, b.name));
  const content = sumsText(sorted);
  const tags = [
    ['d', d],
    ['version', version],
  ];
  if (commit) tags.push(['commit', commit]);
  tags.push(
    ['x', createHash('sha256').update(content, 'utf8').digest('hex')],
    ['files', String(sorted.length)],
    ['size', String(sorted.reduce((n, a) => n + a.bytes, 0))],
  );
  for (const a of sorted) tags.push(['artifact', a.name, a.sha256, String(a.bytes)]);
  return {
    id: '',
    pubkey: sovtechPubkeyHex(),
    created_at: createdAt,
    kind: RELEASE_NOTICE_KIND,
    tags,
    content,
    sig: '',
  };
}

export async function buildManifest(paths, { version, commit, createdAt }) {
  if (paths.length === 0) throw new Error('no release artifacts given');
  if (typeof version !== 'string' || !VERSION.test(version))
    throw new Error('--version must be a plain version string');
  if (commit !== undefined && !/^[0-9a-f]{40}$/.test(commit))
    throw new Error('--commit must be a full 40-hex git sha');
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) throw new Error('bad created_at');
  const seen = new Set();
  const artifacts = [];
  for (const p of paths) {
    const name = basename(p);
    if (!SAFE_NAME.test(name)) throw new Error(`unsafe artifact name: ${JSON.stringify(name)}`);
    if (!nameCarriesVersion(name, version))
      throw new Error(
        `${name} does not carry version ${version} in a name a maker writes ` +
          `(${ARTIFACT_SHAPES.map((sh) => `${sh.prefix}${version}{${sh.tails.join(',')}}`).join(' ')}): ` +
          "a stale artifact? Use the make's own list " +
          '(--made out/make/<platform>-<arch>.artifacts.json) or empty out/make',
      );
    if (seen.has(name)) throw new Error(`two artifacts named ${name}`);
    seen.add(name);
    artifacts.push({ name, ...(await sha256File(p)) });
  }
  artifacts.sort((a, b) => byteOrder(a.name, b.name));
  return {
    manifest: {
      schema: 'nutflix-release/1',
      app: RELEASE_D_TAG,
      version,
      ...(commit ? { commit } : {}),
      createdAt,
      artifacts,
    },
    sums: sumsText(artifacts),
    event: unsignedEvent({ artifacts, version, commit, createdAt }),
  };
}

export function parseArgs(argv) {
  const o = { inputs: [], made: [], out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--out') o.out = next();
    else if (a === '--made') o.made.push(next());
    else if (a === '--version') o.version = next();
    else if (a === '--commit') o.commit = next();
    else if (a === '--created-at') o.createdAt = Number(next());
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else o.inputs.push(a);
  }
  return o;
}

/** Default `--version`: @sovit/app-desktop's package.json (what Forge names the artifacts by). */
function desktopVersion() {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(
    readFileSync(join(here, '..', 'packages', 'app-desktop', 'package.json'), 'utf8'),
  ).version;
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

export async function run(argv) {
  const o = parseArgs(argv);
  const version = o.version ?? desktopVersion();
  const skipped = [];
  const paths = [
    ...o.made.flatMap((list) => collectArtifacts(readMadeList(list, version), skipped, true)),
    ...collectArtifacts(o.inputs, skipped),
  ];
  for (const s of skipped)
    process.stderr.write(`release-manifest: skipped (not a release artifact): ${s}\n`);
  // Now, not SOURCE_DATE_EPOCH: the event is addressable (one per key + kind + d on a relay),
  // so a re-made manifest must be newer than the event it replaces, and the verifier reports
  // this as the date the release notice was created.
  const createdAt = o.createdAt ?? Math.floor(Date.now() / 1000);
  const { manifest, sums, event } = await buildManifest(paths, {
    version,
    commit: o.commit ?? gitHead(),
    createdAt,
  });
  mkdirSync(o.out, { recursive: true });
  writeFileSync(join(o.out, 'SHA256SUMS'), sums);
  writeFileSync(join(o.out, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(o.out, 'release-event.unsigned.json'), `${JSON.stringify(event, null, 2)}\n`);
  process.stdout.write(sums);
  process.stderr.write(
    `release-manifest: ${String(manifest.artifacts.length)} artifacts -> ${resolve(o.out)} ` +
      '(release-event.unsigned.json is UNSIGNED: sign it with the SovTech key through Bunker46, never here)\n',
  );
  return { manifest, sums, event };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`release-manifest: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
