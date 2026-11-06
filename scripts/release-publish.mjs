#!/usr/bin/env node
// The last step of a desktop release (ADR 0017 §8; Cameron, 2026-10-02): sign the release
// notice with the SovTech key through Cameron's NIP-46 signer (Bunker46), check it the way
// users will, and publish it to the release relays.
//
//   1. The UNSIGNED template (release-manifest.mjs's release-event.unsigned.json) must be a
//      kind 30071 release for the SovTech key whose tags agree, and every artifact in --dir
//      must match it (size and sha256): before anything touches the network.
//   2. The bunker:// URI is read from the terminal with echo off (never from argv: shell
//      history and `ps` would keep it). It is used for the one connection and never written,
//      logged or printed. The bunker must sign for the SovTech key, or nothing is asked of it.
//   3. Signing goes through @sovit/core's Nip46Signer, which refuses any returned event that is
//      not exactly the template signed by that key (checkRemoteSigned). The signed event is then
//      checked by release-verify.mjs's verifyRelease against the files, as a user would.
//   4. It is saved as release-event.json beside the template (never over an existing file), a
//      summary is shown, and only after typing `publish` is it sent to RELEASE_RELAYS; each
//      relay's answer is reported.
//
// Given an already SIGNED event (a retry after a relay failed), it skips 2–3: full verify,
// confirm, publish. --dry-run stops before publishing. The key never leaves the bunker; this
// script's own NIP-46 client key is made per run by nostr-tools and dropped at exit.
//
// Usage (after `npm run build`: it loads @sovit/core's built signer):
//   node scripts/release-publish.mjs <release-event.unsigned.json | release-event.json>
//        --dir <dir with the downloaded artifacts> [--d <release>] [--dry-run]
//   `--d nfx` signs NFX's own release notice (its nfxd and nfx-package tarball) instead of the
//   desktop app's (`nutflix-desktop`, the default); no other `d` is accepted.
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { npubEncode } from 'nostr-tools/nip19';
import WebSocket from 'ws';

import { RELEASE_D_TAG, RELEASE_D_TAGS, sovtechPubkeyHex } from './release-manifest.mjs';
import {
  checkFiles,
  checkUnsignedRelease,
  readEventFile,
  ReleaseVerifyError,
  verifyRelease,
} from './release-verify.mjs';

// Every nostr-tools pool in this process (ours and @sovit/core's bunker pool) uses `ws`, not
// Node's built-in WebSocket: on Node 22 (undici), nostr-tools 2.25.2's onerror -> ws.close()
// on a socket still connecting re-fires `error` synchronously, recursing until the stack
// overflows, so an unreachable relay could throw an uncaught RangeError mid-publish
// (reproduced on Node 22.22.0; not on Electron 44's Node 24.20, which the app runs on).
//
// `ws` needs one more guard. When a relay accepts the TCP connection and never finishes the
// handshake, nostr-tools' connection timeout calls close() on the socket still connecting; `ws`
// then emits `error` ("closed before the connection was established") after nostr-tools has
// dropped its handlers, and an `error` nobody listens for ends the process (seen 2026-10-05:
// relay.primal.net was down, and the publish died before reporting any relay). Every socket
// keeps a listener of its own, so that relay is reported as failed like any other.
class RelaySocket extends WebSocket {
  constructor(...args) {
    super(...args);
    this.on('error', () => undefined);
  }
}
useWebSocketImplementation(RelaySocket);

/** Where the notice is published (Cameron, 2026-10-02: the app's three default relays). */
export const RELEASE_RELAYS = Object.freeze([
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
]);
/** How long each relay has to answer the publish. */
export const PUBLISH_TIMEOUT_MS = 15_000;
/** What must be typed to publish: not a reflexive `y`. */
export const CONFIRM_WORD = 'publish';

const refuse = (msg) => {
  throw new ReleaseVerifyError(msg);
};

function summary(r, relays) {
  const when = new Date(Number(r.createdAt) * 1000).toISOString();
  return [
    `${r.d} release ${r.version}${r.commit === undefined ? '' : ` (commit ${r.commit})`}, created ${when}`,
    ...r.files.map((a) => `  ${a.sha256}  ${a.name}  (${String(a.bytes)} bytes)`),
    `relays: ${relays.join(', ')}`,
  ].join('\n');
}

/**
 * The whole flow, with its edges injected (tests pass fakes; `run` passes the real ones).
 *   event         the parsed template, or an already signed event
 *   dir           where the artifacts are
 *   askBunkerUri  () => Promise<string>
 *   connect       (uri, { onauth }) => Promise<{ bunker, relays }>   (@sovit/core connectBunker)
 *   adopt         (bunker, relays) => Promise<Signer>                 (@sovit/core Nip46Signer.adopt)
 *   confirm       (summaryText) => Promise<boolean>
 *   publish       (relays, event) => Promise<Array<{ relay, ok, message }>>
 *   save          (event) => string (the path written)
 *   log           (line) => void
 * `trustedPubkey` defaults to the SovTech key and the CLI never passes one; tests pass a
 * throwaway key. Never derived from the event or the bunker.
 */
export async function publishRelease({
  event,
  dir,
  relays = RELEASE_RELAYS,
  askBunkerUri,
  connect,
  adopt,
  confirm,
  publish,
  save,
  log,
  dryRun = false,
  trustedPubkey = sovtechPubkeyHex(),
  d = RELEASE_D_TAG,
}) {
  const signedAlready =
    typeof event === 'object' && event !== null && event.id !== '' && event.sig !== '';
  let signed;
  if (signedAlready) {
    signed = event;
    log('the event is signed already: verifying it, then publishing (no bunker needed)');
  } else {
    // 1. Before the network: the template and every file.
    const t = checkUnsignedRelease(event, trustedPubkey, d);
    await checkFiles(t.artifacts, { allDir: dir });
    log(`template ok: ${String(t.artifacts.length)} artifact(s) in ${dir} match it`);
    // 2. The bunker, which must sign for the trusted key.
    const uri = await askBunkerUri();
    const session = await connect(uri, {
      onauth: (url) => {
        log(`the bunker asks you to approve this client: ${url}`);
      },
    });
    const signer = await adopt(session.bunker, session.relays);
    try {
      const pk = await signer.getPublicKey();
      if (pk !== trustedPubkey)
        refuse(`the bunker signs for ${npubEncode(pk)}, not the SovTech key: nothing was signed`);
      // 3. Sign exactly the template (Nip46Signer refuses anything else that comes back).
      const ev = t.event;
      signed = await signer.signEvent({
        pubkey: trustedPubkey,
        kind: ev.kind,
        created_at: ev.created_at,
        tags: ev.tags,
        content: ev.content,
      });
    } finally {
      await signer.close();
    }
  }
  // As a user will check it: signature, key, shape, every file.
  const r = await verifyRelease(signed, { allDir: dir, trustedPubkey, d });
  if (!signedAlready) log(`signed and verified; saved to ${save(signed)}`);
  const text = summary(r, relays);
  if (dryRun) {
    log(`dry run: not published.\n${text}`);
    return { signed, results: [] };
  }
  if (!(await confirm(text))) {
    log('not published.');
    return { signed, results: [] };
  }
  const results = await publish(relays, signed);
  for (const x of results)
    log(`${x.ok ? 'OK    ' : 'FAILED'} ${x.relay}${x.message === '' ? '' : `: ${x.message}`}`);
  if (!results.some((x) => x.ok)) refuse('no relay accepted the release notice');
  return { signed, results };
}

/** Publish to each relay; every relay gets an answer: accepted, refused, or timed out. */
export async function publishToRelays(relays, event, timeoutMs = PUBLISH_TIMEOUT_MS) {
  const pool = new SimplePool();
  try {
    const attempts = pool.publish([...relays], event);
    return await Promise.all(
      attempts.map(async (p, i) => {
        let timer;
        const late = new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('no answer in time'));
          }, timeoutMs);
        });
        try {
          const message = await Promise.race([p, late]);
          return {
            relay: relays[i],
            ok: true,
            message: typeof message === 'string' ? message : '',
          };
        } catch (e) {
          return {
            relay: relays[i],
            ok: false,
            message: e instanceof Error ? e.message : String(e),
          };
        } finally {
          clearTimeout(timer);
        }
      }),
    );
  } finally {
    pool.close([...relays]);
  }
}

/** A line from the terminal with echo off (the bunker URI carries a one-time secret). */
function askHidden(prompt) {
  const input = process.stdin;
  if (!input.isTTY) refuse('run this in a terminal: the bunker URI is read with echo off');
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    let line = '';
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const done = (err) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      process.stderr.write('\n');
      if (err === undefined) resolve(line.trim());
      else reject(err);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new ReleaseVerifyError('cancelled'));
        if (ch === '\u007f' || ch === '\b') line = line.slice(0, -1);
        else line += ch;
      }
      return undefined;
    };
    input.on('data', onData);
  });
}

function askLine(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function run(argv) {
  const [eventPath, ...rest] = argv;
  if (eventPath === undefined || eventPath.startsWith('-'))
    refuse(
      'usage: release-publish.mjs <release-event(.unsigned).json> --dir <dir> [--d <release>] [--dry-run]',
    );
  let dir;
  let dryRun = false;
  let d = RELEASE_D_TAG;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dir') {
      dir = rest[++i];
      if (dir === undefined) refuse('--dir needs a directory');
    } else if (rest[i] === '--d') {
      d = rest[++i];
      if (d === undefined || !RELEASE_D_TAGS.includes(d))
        refuse(`--d takes one of ${RELEASE_D_TAGS.join(', ')}`);
    } else if (rest[i] === '--dry-run') dryRun = true;
    else refuse(`unknown argument ${rest[i]}`);
  }
  if (dir === undefined) refuse('--dir <dir with the downloaded artifacts> is required');
  let event;
  try {
    event = JSON.parse(readEventFile(eventPath));
  } catch (e) {
    if (e instanceof ReleaseVerifyError) throw e;
    refuse('the event file is not JSON');
  }
  const out = join(dirname(eventPath), 'release-event.json');
  // Before anyone is asked to sign: the signed event will have nowhere to go.
  if (event?.sig === '' && existsSync(out))
    refuse(`${out} exists already: move it away first (never overwritten)`);
  // Loaded only now, so a usage error needs no build.
  let signerLib;
  try {
    ({ signer: signerLib } = await import('@sovit/core'));
  } catch {
    refuse('@sovit/core is not built: run `npm run build` first');
  }
  const log = (line) => process.stderr.write(`${line}\n`);
  await publishRelease({
    event,
    dir,
    dryRun,
    d,
    askBunkerUri: () => askHidden('bunker:// URI of the SovTech signer (not shown): '),
    connect: (uri, o) => signerLib.connectBunker(uri, o),
    adopt: (bunker, relays) => signerLib.Nip46Signer.adopt(bunker, relays),
    confirm: async (text) => {
      process.stderr.write(`\n${text}\n\n`);
      const a = await askLine(`Type "${CONFIRM_WORD}" to publish this release notice: `);
      return a.trim() === CONFIRM_WORD;
    },
    publish: (relays, ev) => publishToRelays(relays, ev),
    save: (ev) => {
      if (existsSync(out)) refuse(`${out} exists already: move it away first (never overwritten)`);
      writeFileSync(out, `${JSON.stringify(ev, null, 2)}\n`, { flag: 'wx' });
      return out;
    },
    log,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(
    () => process.exit(0),
    (err) => {
      process.stderr.write(
        `release-publish: FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    },
  );
}
