/**
 * Run by `secure-memory.e2e.ts` INSIDE the Electron binary (`ELECTRON_RUN_AS_NODE=1`), which is
 * the runtime the app's host process has. NEVER loaded by the app.
 *
 * It does what the host does for "Create a new key" and for opening the wallet, with core's
 * built code and the real sodium-native: a new local key sealed under a passphrase at the
 * default argon2id cost, the file unlocked again, an event signed, a recovery phrase turned into
 * its seed, and a mesh session key (NFX-10 §6). Prints ONE JSON line. Exit 0 only when every step
 * worked.
 */
'use strict';
const process = require('node:process');
const { TextEncoder } = require('node:util');

const PASSPHRASE = 'correct horse battery staple';

async function main() {
  const out = {
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    step: 'load',
  };
  try {
    const { signer, wallet } = await import('@sovit/core');
    const pw = () => new TextEncoder().encode(PASSPHRASE);

    out.step = 'probe';
    out.guarded = signer.hasSecureMemory();

    out.step = 'create';
    const made = await signer.LocalSigner.create({ passphrase: pw() });
    const pubkey = await made.signer.getPublicKey();
    await made.signer.lock();

    out.step = 'unlock';
    const again = await signer.LocalSigner.unlock(made.file, pw());
    out.samePubkey = (await again.getPublicKey()) === pubkey;

    out.step = 'sign';
    const ev = await again.signEvent({ kind: 1, created_at: 1, tags: [], content: 'e2e' });
    out.signed = typeof ev.sig === 'string' && ev.sig.length === 128 && ev.pubkey === pubkey;
    await again.lock();

    out.step = 'wrong-passphrase';
    out.wrongRefused = await signer.LocalSigner.unlock(
      made.file,
      new TextEncoder().encode('wrong horse battery staple'),
    ).then(
      () => false,
      (e) => /^bad-passphrase/.test(String(e && e.message)),
    );

    out.step = 'seed';
    const entropy = wallet.recoveryPhrases.generate();
    const hex = wallet.entropyToHex(entropy);
    out.entropyRoundTrip = wallet.entropyToHex(wallet.entropyFromHex(hex)) === hex;
    const seed = await wallet.recoveryPhrases.toSeed(entropy);
    seed.wipe();
    out.seedWiped = seed.wiped === true;
    wallet.wipeEntropy(entropy);

    out.step = 'mesh-key';
    const session = signer.MeshSessionKey.create();
    out.meshKey = /^[0-9a-f]{64}$/.test(session.pubkey);
    session.destroy();

    out.step = 'done';
  } catch (e) {
    // The class name and the code prefix only: this line is test output, never a key.
    out.error = e instanceof Error ? e.name : 'unknown';
    out.code = e instanceof Error ? (/^[a-z-]+(?=:)/.exec(e.message)?.[0] ?? null) : null;
  }
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exitCode = out.step === 'done' ? 0 : 1;
}

void main();
