// NFX's own release notice (2026-11-06): the same kind 30071 notice the desktop app's releases
// carry, signed by the SovTech key, with `d` = nfx. release-template.mjs builds the unsigned one
// for release files that already exist; release-verify.mjs and release-publish.mjs take it with
// `--d nfx`. A notice never verifies as another product's, and no `d` outside the allow-list is
// accepted anywhere.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runNode, scriptsDir, tempDir } from './helpers.js';

interface Unsigned {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: string[][];
  readonly content: string;
  readonly sig: string;
}
interface Manifest {
  RELEASE_D_TAG: string;
  RELEASE_D_TAGS: readonly string[];
}
interface Template {
  templateFor(
    files: string[],
    o: { d: string; version: string; commit: string; createdAt: number },
  ): Promise<Unsigned>;
}
interface Verify {
  checkUnsignedRelease(ev: unknown, trustedPubkey: string, d?: string): unknown;
  verifyRelease(
    ev: unknown,
    o: { files?: string[]; allDir?: string; trustedPubkey?: string; d?: string },
  ): Promise<{ version: string; d: string; files: { name: string }[] }>;
}

const load = async <T>(name: string): Promise<T> =>
  (await import(/* @vite-ignore */ join(scriptsDir, name))) as T;

const COMMIT = 'fd0bf66'.padEnd(40, '0');
let dir: { dir: string; cleanup(): void };
let tarball = '';

beforeEach(() => {
  dir = tempDir('release-nfx');
  mkdirSync(join(dir.dir, 'rel'));
  tarball = join(dir.dir, 'rel', 'nfx-0.1.0-linux-x64.tar.gz');
  writeFileSync(tarball, 'not really a tarball, but bytes to hash');
});
afterEach(() => {
  dir.cleanup();
});

/** The template signed by a throwaway key standing in for the SovTech one. */
function sign(t: Unsigned): { ev: unknown; pubkey: string } {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  const ev = finalizeEvent(
    { kind: t.kind, created_at: t.created_at, tags: t.tags, content: t.content },
    sk,
  );
  return { ev, pubkey };
}

describe('the NFX release notice', () => {
  it('the allow-list is the desktop app and NFX, the desktop the default', async () => {
    const m = await load<Manifest>('release-manifest.mjs');
    expect(m.RELEASE_D_TAG).toBe('nutflix-desktop');
    expect([...m.RELEASE_D_TAGS]).toEqual(['nutflix-desktop', 'nfx']);
  });

  it('release-template builds an nfx notice that verifies with --d nfx, file for file', async () => {
    const t = await load<Template>('release-template.mjs');
    const v = await load<Verify>('release-verify.mjs');
    const unsigned = await t.templateFor([tarball], {
      d: 'nfx',
      version: '0.1.0',
      commit: COMMIT,
      createdAt: 1_794_000_000,
    });
    expect(unsigned.kind).toBe(30071);
    expect(unsigned.tags.find((x) => x[0] === 'd')).toEqual(['d', 'nfx']);
    expect(unsigned.tags.find((x) => x[0] === 'commit')).toEqual(['commit', COMMIT]);
    expect(unsigned.id).toBe('');
    expect(unsigned.sig).toBe('');
    const { ev, pubkey } = sign({ ...unsigned, pubkey: '' });
    const r = await v.verifyRelease(ev, { files: [tarball], trustedPubkey: pubkey, d: 'nfx' });
    expect(r).toMatchObject({ version: '0.1.0', d: 'nfx' });
    expect(r.files.map((f) => f.name)).toEqual(['nfx-0.1.0-linux-x64.tar.gz']);
  });

  it('a notice never verifies as the other product, and an unknown d is refused', async () => {
    const t = await load<Template>('release-template.mjs');
    const v = await load<Verify>('release-verify.mjs');
    const unsigned = await t.templateFor([tarball], {
      d: 'nfx',
      version: '0.1.0',
      commit: COMMIT,
      createdAt: 1_794_000_000,
    });
    const { ev, pubkey } = sign({ ...unsigned, pubkey: '' });
    // The default is the desktop app: an nfx notice is refused there…
    await expect(v.verifyRelease(ev, { files: [tarball], trustedPubkey: pubkey })).rejects.toThrow(
      /not a nutflix-desktop release \(d = "nfx"\)/,
    );
    // …and a desktop notice is refused as NFX's.
    const desktop = await t.templateFor([tarball], {
      d: 'nutflix-desktop',
      version: '0.1.0',
      commit: COMMIT,
      createdAt: 1_794_000_000,
    });
    const signedDesktop = sign({ ...desktop, pubkey: '' });
    await expect(
      v.verifyRelease(signedDesktop.ev, {
        files: [tarball],
        trustedPubkey: signedDesktop.pubkey,
        d: 'nfx',
      }),
    ).rejects.toThrow(/not a nfx release/);
    // Nothing outside the allow-list, in either script.
    await expect(
      v.verifyRelease(ev, { files: [tarball], trustedPubkey: pubkey, d: 'something-else' }),
    ).rejects.toThrow(/unknown release/);
    expect(() =>
      v.checkUnsignedRelease({ ...unsigned }, unsigned.pubkey, 'something-else'),
    ).toThrow(/unknown release/);
    await expect(
      t.templateFor([tarball], { d: 'other', version: '0.1.0', commit: COMMIT, createdAt: 1 }),
    ).rejects.toThrow(/--d takes one of/);
  });

  it('release-template refuses a short commit, a bad version, a missing file, and an existing output', () => {
    const run = (args: string[]) => runNode('release-template.mjs', args);
    expect(run(['--d', 'nfx', '--version', '0.1.0', '--commit', 'HEAD', tarball]).stderr).toMatch(
      /--commit must be a full 40-hex/,
    );
    expect(run(['--d', 'nfx', '--version', 'v 0.1', '--commit', COMMIT, tarball]).stderr).toMatch(
      /--version must be/,
    );
    expect(run(['--d', 'nfx', '--version', '0.1.0', '--commit', COMMIT]).stderr).toMatch(
      /name at least one/,
    );
    const ok = run(['--d', 'nfx', '--version', '0.1.0', '--commit', COMMIT, tarball]);
    expect(ok.status).toBe(0);
    const out = join(dir.dir, 'rel', 'release-event.unsigned.json');
    expect(ok.stdout.trim()).toBe(out);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ kind: 30071, sig: '' });
    // Never over an existing one.
    expect(run(['--d', 'nfx', '--version', '0.1.0', '--commit', COMMIT, tarball]).stderr).toMatch(
      /exists already/,
    );
  });

  it('the CLIs take --d only from the allow-list', () => {
    expect(runNode('release-verify.mjs', ['x.json', '--d', 'evil', 'f']).stderr).toMatch(
      /--d takes one of nutflix-desktop, nfx/,
    );
    expect(
      runNode('release-publish.mjs', ['x.json', '--dir', '/tmp', '--d', 'evil']).stderr,
    ).toMatch(/--d takes one of nutflix-desktop, nfx/);
  });

  it('release-template never signs and never talks to the network (source hygiene)', () => {
    const src = readFileSync(join(scriptsDir, 'release-template.mjs'), 'utf8');
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
  });
});
