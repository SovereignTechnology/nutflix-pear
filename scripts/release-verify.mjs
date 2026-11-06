#!/usr/bin/env node
// Issue #6 (security review F21, ADR 0017): verify a SIGNED desktop release event against the
// files you downloaded. Every check must pass, or it exits 1 and says which one failed:
//
//   1. the event is well-formed and its id and Schnorr signature verify (nostr-tools
//      verifyEvent — library crypto only);
//   2. it was signed by the SovTech key (npub1s0vtech…) — no other key is accepted, and there
//      is deliberately no option to accept one;
//   3. it is a release notice of the product you verify: kind 30071, `d` = nutflix-desktop (or,
//      with `--d nfx`, NFX's own release; no other `d` is accepted), and its `artifact`
//      tags, content (the SHA256SUMS text), `x` (sha256 of that text), `files` (the count) and
//      `size` (the total) agree; `commit`, when present, is a full 40-hex sha;
//   4. each file you name (or, with --all, every artifact of the release) is listed, and its
//      size and sha256 match.
// It prints the release's version, commit and creation date (the event's `created_at`: when
// the manifest was made, before it was signed): an OLDER genuine release also verifies (a
// signature cannot say "latest"), so compare them with the current notice (kind 30071,
// d = nutflix-desktop) on the relays before trusting a download to be current.
//
// Usage:
//   node scripts/release-verify.mjs <signed-event.json> <file>...        each file must match
//   node scripts/release-verify.mjs <signed-event.json> --all <dir>      every artifact, in <dir>
//   node scripts/release-verify.mjs <signed-event.json> --d nfx <file>  an NFX release
//
// It reads the files and the event; it contacts nothing.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { verifyEvent } from 'nostr-tools/pure';

import {
  RELEASE_D_TAG,
  RELEASE_D_TAGS,
  RELEASE_NOTICE_KIND,
  SAFE_NAME,
  sha256File,
  sovtechPubkeyHex,
  sumsText,
} from './release-manifest.mjs';

/** A release event is small; anything bigger is refused before it is parsed. */
export const MAX_EVENT_BYTES = 256 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

export class ReleaseVerifyError extends Error {
  name = 'ReleaseVerifyError';
}
const refuse = (msg) => {
  throw new ReleaseVerifyError(msg);
};

/** `input` as plain JSON data, after checking the trusted key's shape. */
function plainEvent(input, trustedPubkey) {
  if (typeof trustedPubkey !== 'string' || !HEX64.test(trustedPubkey))
    refuse('the trusted key must be a 64-hex public key');
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    refuse('the event is not a JSON object');
  // Plain data only. nostr-tools' verifyEvent trusts a cached `verifiedSymbol` flag on the
  // object (set when an event is signed or verified, and COPIED by `{ ...ev }`), so an object that was
  // once verified and then edited would pass without being re-checked. A JSON round trip drops
  // every symbol and non-JSON value; the checks below then see exactly what was signed.
  try {
    return JSON.parse(JSON.stringify(input));
  } catch {
    return refuse('the event is not plain JSON data');
  }
}

/** The release (version, date, artifacts) from a signature-checked event (checks 1–3). */
export function checkEvent(input, trustedPubkey, d = RELEASE_D_TAG) {
  const ev = plainEvent(input, trustedPubkey);
  let valid;
  try {
    // Throws on a structurally invalid event (missing fields, non-string tags).
    valid = verifyEvent(ev);
  } catch {
    valid = false;
  }
  if (!valid) refuse('bad event: its id or signature does not verify');
  return releaseShape(ev, trustedPubkey, d);
}

/**
 * The release from an UNSIGNED template (release-manifest.mjs's release-event.unsigned.json):
 * the same checks as checkEvent but the signature, which it does not have yet (`id` and `sig`
 * empty). For scripts/release-publish.mjs, before it asks anyone to sign.
 */
export function checkUnsignedRelease(input, trustedPubkey, d = RELEASE_D_TAG) {
  const ev = plainEvent(input, trustedPubkey);
  if (ev.id !== '' || ev.sig !== '')
    refuse('not an unsigned release template (its id and sig must be empty)');
  if (!Number.isSafeInteger(ev.created_at) || ev.created_at <= 0)
    refuse('the template has no valid created_at');
  if (typeof ev.content !== 'string') refuse('the template content is not a string');
  if (
    !Array.isArray(ev.tags) ||
    !ev.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))
  )
    refuse('the template tags are not lists of strings');
  if (ev.pubkey !== trustedPubkey) refuse('the template is not for the SovTech key');
  return { ...releaseShape(ev, trustedPubkey, d), event: ev };
}

/** Checks 2–3 on plain data whose structure is already valid. */
function releaseShape(ev, trustedPubkey, d) {
  if (!RELEASE_D_TAGS.includes(d)) refuse(`unknown release ${JSON.stringify(d)}`);
  if (ev.pubkey !== trustedPubkey) refuse('the event is not signed by the SovTech key');
  if (ev.kind !== RELEASE_NOTICE_KIND)
    refuse(`wrong kind ${String(ev.kind)} (want ${String(RELEASE_NOTICE_KIND)})`);
  const tag = (k) => ev.tags.filter((t) => t[0] === k);
  const one = (k) => {
    const t = tag(k);
    if (t.length !== 1 || typeof t[0][1] !== 'string')
      refuse(`the event needs exactly one "${k}" tag`);
    return t[0][1];
  };
  if (one('d') !== d) refuse(`not a ${d} release (d = ${JSON.stringify(one('d'))})`);
  const artifacts = [];
  const seen = new Set();
  for (const t of tag('artifact')) {
    const [, name, sha256, bytes] = t;
    if (t.length !== 4 || typeof name !== 'string' || !SAFE_NAME.test(name))
      refuse('malformed artifact tag (name)');
    if (typeof sha256 !== 'string' || !HEX64.test(sha256))
      refuse(`malformed artifact tag for ${name} (sha256)`);
    if (typeof bytes !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(bytes))
      refuse(`malformed artifact tag for ${name} (size)`);
    if (seen.has(name)) refuse(`artifact ${name} is listed twice`);
    seen.add(name);
    artifacts.push({ name, sha256, bytes: Number(bytes) });
  }
  if (artifacts.length === 0) refuse('the event lists no artifacts');
  if (ev.content !== sumsText(artifacts))
    refuse('the event content does not match its artifact tags');
  if (one('x') !== createHash('sha256').update(ev.content, 'utf8').digest('hex'))
    refuse('the event x tag is not the sha256 of its content');
  if (one('files') !== String(artifacts.length))
    refuse('the files tag does not match the artifact count');
  if (one('size') !== String(artifacts.reduce((n, a) => n + a.bytes, 0)))
    refuse("the size tag does not match the artifacts' total");
  const version = one('version');
  if (!/^[0-9A-Za-z.+-]{1,64}$/.test(version)) refuse('malformed version tag');
  const commits = tag('commit');
  if (commits.length > 1) refuse('the event has more than one commit tag');
  const commit = commits[0]?.[1];
  if (commits.length === 1 && (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)))
    refuse('malformed commit tag (want a full 40-hex git sha)');
  return { artifacts, version, commit, createdAt: ev.created_at, d };
}

/**
 * The event file's text, read through one descriptor: it must be a regular file (a FIFO or a
 * device such as /dev/zero would never end) of at most MAX_EVENT_BYTES — bytes actually read,
 * so a symlink is measured by its target and a growing file cannot slip past the limit.
 * Opened O_NONBLOCK: a plain open of a FIFO waits for a writer, so fstat never got to refuse it
 * (verifier, round 2). The flag changes nothing for a regular file; Windows has none (0).
 */
export function readEventFile(path) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) refuse('the event file is not a regular file');
    const buf = Buffer.alloc(MAX_EVENT_BYTES + 1);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n > MAX_EVENT_BYTES) refuse('the event file is too large');
    }
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Checks 1–4. `files`: paths to verify (each must be listed); or `allDir`: every listed
 * artifact must be there. `trustedPubkey` defaults to the SovTech key and the CLI never passes
 * one; tests pass a throwaway key to reach the file checks. Never derive it from the event
 * (`ev.pubkey`): that would accept any validly signed event from anyone.
 */
export async function verifyRelease(
  ev,
  { files = [], allDir, trustedPubkey = sovtechPubkeyHex(), d = RELEASE_D_TAG },
) {
  const { artifacts, version, commit, createdAt } = checkEvent(ev, trustedPubkey, d);
  const ok = await checkFiles(artifacts, { files, allDir });
  return { version, commit, createdAt, d, files: ok };
}

/**
 * Check 4: each of `files` (or, with `allDir`, every artifact, in that directory) is listed in
 * `artifacts` and matches its size and sha256. Returns the artifacts checked.
 */
export async function checkFiles(artifacts, { files = [], allDir }) {
  const byName = new Map(artifacts.map((a) => [a.name, a]));
  const targets = [];
  if (allDir !== undefined) {
    for (const a of artifacts) targets.push({ path: join(allDir, a.name), a });
  } else {
    if (files.length === 0) refuse('name at least one downloaded file (or use --all <dir>)');
    for (const path of files) {
      const a = byName.get(basename(path));
      if (a === undefined) refuse(`${basename(path)} is not part of this release`);
      targets.push({ path, a });
    }
  }
  const ok = [];
  for (const { path, a } of targets) {
    let st;
    try {
      st = lstatSync(path);
    } catch {
      refuse(`${a.name} is missing`);
    }
    if (!st.isFile()) refuse(`${path} is not a regular file`);
    const got = await sha256File(path);
    if (got.bytes !== a.bytes)
      refuse(`${a.name}: size ${String(got.bytes)}, release says ${String(a.bytes)}`);
    if (got.sha256 !== a.sha256) refuse(`${a.name}: sha256 does not match the signed release`);
    ok.push(a);
  }
  return ok;
}

export async function run(argv) {
  const [eventPath, ...rest] = argv;
  if (eventPath === undefined)
    refuse(
      'usage: release-verify.mjs <signed-event.json> [--d <release>] (<file>... | --all <dir>)',
    );
  let allDir;
  let d = RELEASE_D_TAG;
  const files = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--all') {
      allDir = rest[++i];
      if (allDir === undefined) refuse('--all needs a directory');
    } else if (rest[i] === '--d') {
      d = rest[++i];
      if (d === undefined || !RELEASE_D_TAGS.includes(d))
        refuse(`--d takes one of ${RELEASE_D_TAGS.join(', ')}`);
    } else if (rest[i].startsWith('-')) refuse(`unknown option ${rest[i]}`);
    else files.push(rest[i]);
  }
  if (allDir !== undefined && files.length > 0) refuse('give files or --all <dir>, not both');
  const text = readEventFile(eventPath);
  let ev;
  try {
    ev = JSON.parse(text);
  } catch {
    refuse('the event file is not JSON');
  }
  const r = await verifyRelease(ev, { files, allDir, d });
  for (const a of r.files) process.stdout.write(`OK  ${a.sha256}  ${a.name}\n`);
  // A genuine OLD release verifies too (a signature cannot say "latest"): show which one it is,
  // so it can be compared with the current release notice on the relays. `created_at` is when
  // the manifest was made (the signer signs it as given), so it is labelled "created".
  const when = new Date(Number(r.createdAt) * 1000);
  const created = Number.isNaN(when.getTime()) ? 'unknown' : when.toISOString();
  process.stdout.write(
    `${r.d} release ${r.version}${r.commit === undefined ? '' : ` (commit ${r.commit})`}, created ${created}\n`,
  );
  process.stdout.write(
    `release-verify: ${String(r.files.length)} file(s) match the release signed by the SovTech key\n`,
  );
  return r;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((err) => {
    process.stderr.write(
      `release-verify: FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
