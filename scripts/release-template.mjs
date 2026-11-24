#!/usr/bin/env node
// The UNSIGNED release notice (kind 30071) for release files that already exist, such as NFX's
// own release tarball (its workflow builds no notice), for release-publish.mjs to sign. The
// desktop app's notice comes from release-manifest.mjs, which checks the makers' file names.
//
//   node scripts/release-template.mjs --d <release> --version <v> --commit <40-hex sha>
//        [--verlink <pear://fork.length.key>] <file>...
//
// `--verlink` is nutflix-runtime's, and required there: its notice names one versioned link and
// exactly its five targets, and a macOS bundle (a directory) goes in by its tree digest.
//
// It writes release-event.unsigned.json beside the first file (never over an existing one) and
// prints its path. `--d` is one of RELEASE_D_TAGS; every file is read in full for its sha256 and
// size; created_at is now. It contacts nothing and signs nothing.

import { existsSync, lstatSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  RELEASE_D_TAGS,
  RUNTIME_D_TAG,
  SAFE_NAME,
  sha256File,
  treeDigest,
  unsignedEvent,
} from './release-manifest.mjs';

const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

/** The unsigned notice for `files` (paths), or a thrown Error saying what is wrong. */
export async function templateFor(files, { d, version, commit, createdAt, verlink }) {
  if (!RELEASE_D_TAGS.includes(d)) throw new Error(`--d takes one of ${RELEASE_D_TAGS.join(', ')}`);
  if (typeof version !== 'string' || !VERSION.test(version))
    throw new Error('--version must be a plain version string');
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit))
    throw new Error('--commit must be a full 40-hex git sha');
  if (files.length === 0) throw new Error('name at least one release file');
  const artifacts = [];
  const seen = new Set();
  for (const path of files) {
    const name = basename(path);
    if (!SAFE_NAME.test(name)) throw new Error(`${name}: not a plain file name`);
    if (seen.has(name)) throw new Error(`${name} is named twice`);
    seen.add(name);
    const st = lstatSync(path);
    const bundle = d === RUNTIME_D_TAG && name.endsWith('.app');
    if (bundle ? !st.isDirectory() : !st.isFile())
      throw new Error(`${path} is not a ${bundle ? 'bundle directory' : 'regular file'}`);
    const got = bundle ? await treeDigest(path) : await sha256File(path);
    artifacts.push({ name, sha256: got.sha256, bytes: got.bytes });
  }
  return unsignedEvent({ artifacts, version, commit, createdAt, d, verlink });
}

export async function run(argv) {
  const files = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--d' || a === '--version' || a === '--commit' || a === '--verlink') {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      opt[a.slice(2)] = v;
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else files.push(a);
  }
  const ev = await templateFor(files, {
    d: opt.d,
    version: opt.version,
    commit: opt.commit,
    createdAt: Math.floor(Date.now() / 1000),
    verlink: opt.verlink,
  });
  const out = join(dirname(files[0]), 'release-event.unsigned.json');
  if (existsSync(out)) throw new Error(`${out} exists already: move it away first`);
  writeFileSync(out, `${JSON.stringify(ev, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${out}\n`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`release-template: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
