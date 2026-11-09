// @vitest-environment node
/**
 * The site build's rules (ADR 0022, M4): the lock it reads, the deny list it holds the bundle to,
 * the tree hash it prints (the one scripts/reproducible-build.mjs defines) and `source.json`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DENY,
  LIB_FILES,
  SITE_FILES,
  deniedInputs,
  hashTree,
  npmPackages,
  parseLock,
  sourceRecord,
  sri384,
} from '../site.ts';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repo = resolve(pkg, '..', '..');

const C = 'c'.repeat(40);
const S = 'a'.repeat(64);
const T = 'b'.repeat(64);
const TOOLS = `tool rust 1.98.0\ntool wasm-pack 0.15.1 ${S}\ntool wasm-bindgen 0.2.128 ${T}\n`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('nfx-web.lock', () => {
  it('the lock in the tree parses: one nfx pin and the three tools', () => {
    const lock = parseLock(readFileSync(join(pkg, 'nfx-web.lock'), 'utf8'));
    expect(lock.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(lock.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.libSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(lock.tools).sort()).toEqual(['rust', 'wasm-bindgen', 'wasm-pack']);
    expect(lock.tools['wasm-pack']?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('scripts/nfx-lib.sh reads the same pins', () => {
    const lock = parseLock(readFileSync(join(pkg, 'nfx-web.lock'), 'utf8'));
    const r = spawnSync('bash', [join(pkg, 'scripts', 'nfx-lib.sh'), 'show'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`NFX_COMMIT=${lock.commit}\n`);
    expect(r.stdout).toContain(`NFX_SRC_SHA256=${lock.sourceSha256}\n`);
    expect(r.stdout).toContain(`NFX_LIB_SHA256=${lock.libSha256}\n`);
    expect(r.stdout).toContain(
      `WASM_BINDGEN_VERSION=${lock.tools['wasm-bindgen']?.version ?? ''}\n`,
    );
  });

  it('nfx-lib.sh check refuses a tar that is not the pinned one', () => {
    const d = mkdtempSync(join(tmpdir(), 'nfx-lib-check-'));
    dirs.push(d);
    writeFileSync(join(d, 'x.tar'), 'not the library');
    const r = spawnSync('bash', [join(pkg, 'scripts', 'nfx-lib.sh'), 'check', join(d, 'x.tar')], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/sha256 [0-9a-f]{64}, not the lock's/);
  });

  it('refuses anything but one well-formed pin line and the tool lines', () => {
    expect(parseLock(`# c\nnfx ${C} ${S} ${T}\n${TOOLS}`).commit).toBe(C);
    const bad = [
      TOOLS,
      `nfx ${C} ${S} ${T}\nnfx ${C} ${S} ${T}\n${TOOLS}`,
      `nfx ${C.toUpperCase()} ${S} ${T}\n${TOOLS}`,
      `nfx ${C} ${S}\n${TOOLS}`,
      `nfx ${C} ${S} ${T} extra\n${TOOLS}`,
      `nfx ${C} ${S} ${T}\ntool rust 1.98\ntool wasm-pack 0.15.1\ntool wasm-bindgen 0.2.128\n`,
      `nfx ${C} ${S} ${T}\ntool rust 1.98.0\n`,
      `nfx ${C} ${S} ${T}\n${TOOLS}pin something\n`,
    ];
    for (const text of bad) expect(() => parseLock(text), text).toThrow(/nfx-web\.lock/);
  });
});

describe('the bundle deny list', () => {
  const clean = [
    '/r/node_modules/react/cjs/react.production.js',
    '/r/node_modules/nostr-tools/lib/esm/pure.js',
    '/r/node_modules/nostr-tools/node_modules/@noble/hashes/esm/sha2.js',
    '/r/node_modules/@noble/curves/ed25519.js',
    '/r/packages/core/dist/nostr/index.js',
    '/r/packages/core/dist/nfx/beacon.js',
    '/r/packages/core/dist/contracts/index.js',
    '/r/packages/ui/dist/index.js',
    '/r/packages/app-web/dist/main.js',
    '/r/packages/app-web/site/entry.ts',
  ];

  it('lets the page’s own code, React, nostr-tools and noble through', () => {
    expect(deniedInputs(clean)).toEqual([]);
    expect(npmPackages(clean)).toEqual(['@noble/curves', '@noble/hashes', 'nostr-tools', 'react']);
  });

  it('refuses Cashu, sodium, Hypercore, Bare, Electron, Pear, BIP-39 and core’s money code', () => {
    const denied = [
      '/r/node_modules/@cashu/cashu-ts/lib/index.js',
      '/r/node_modules/sodium-universal/index.js',
      '/r/node_modules/sodium-javascript/index.js',
      '/r/node_modules/sodium-native/index.js',
      '/r/node_modules/hypercore/index.js',
      '/r/node_modules/hypercore-crypto/index.js',
      '/r/node_modules/hyperswarm/index.js',
      '/r/node_modules/corestore/index.js',
      '/r/node_modules/bare-fs/index.js',
      '/r/node_modules/electron/index.js',
      '/r/node_modules/pear-runtime/index.js',
      '/r/node_modules/@scure/bip39/index.js',
      '/r/packages/core/dist/wallet/nip60-wallet.js',
      '/r/packages/core/dist/payment/engine.js',
      '/r/packages/core/dist/signer/keyfile.js',
      '/r/packages/core/dist/pay-protocol/codec.js',
      '/r/packages/core/dist/media/node/index.js',
      '/r/packages/core/dist/index.js',
      '/r/node_modules/@sovit/core/dist/wallet/spend.js',
      '/r/node_modules/@sovit/seeder/dist/index.js',
      '/r/packages/seeder/dist/index.js',
      '/r/packages/app-desktop/dist/main.js',
      'node:crypto',
    ];
    const out = deniedInputs(denied);
    expect(out).toHaveLength(denied.length);
    for (const [i, line] of out.entries()) expect(line.startsWith(denied[i]!)).toBe(true);
    // Every rule is exercised by at least one path above.
    for (const rule of DENY)
      expect(
        denied.some((p) => rule.re.test(p)),
        rule.what,
      ).toBe(true);
  });
});

describe('the tree hash and source.json', () => {
  it('hashTree is scripts/reproducible-build.mjs’s tree hash', () => {
    const d = mkdtempSync(join(tmpdir(), 'site-tree-'));
    dirs.push(d);
    mkdirSync(join(d, 'nfx', 'wasm'), { recursive: true });
    writeFileSync(join(d, 'index.html'), '<!doctype html>');
    writeFileSync(join(d, 'app.js'), 'export {};');
    writeFileSync(join(d, 'nfx', 'player.js'), 'export {};\n');
    writeFileSync(join(d, 'nfx', 'wasm', 'nfx_wasm_bg.wasm'), new Uint8Array([0, 97, 115, 109]));
    const ours = hashTree(d);
    const r = spawnSync(
      process.execPath,
      [join(repo, 'scripts', 'reproducible-build.mjs'), d, '--commit', C],
      { encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
    const theirs = JSON.parse(r.stdout) as { treeHash: string };
    expect(ours.treeHash).toBe(theirs.treeHash);
    expect(ours.files.map((f) => f.path)).toEqual([
      'app.js',
      'index.html',
      'nfx/player.js',
      'nfx/wasm/nfx_wasm_bg.wasm',
    ]);
  });

  it('source.json names both commits, the lock, the CSP and every file, deterministically', () => {
    const lock = parseLock(`nfx ${C} ${S} ${T}\n${TOOLS}`);
    const input = {
      lock,
      pearCommit: 'd'.repeat(40),
      modified: false,
      libFiles: LIB_FILES.map((path) => ({ path, sha256: S, bytes: 1 })),
      csp: "default-src 'none'",
      files: [{ path: 'app.js', sha256: T, bytes: 2 }],
    };
    const text = sourceRecord(input);
    expect(sourceRecord(input)).toBe(text);
    const j = JSON.parse(text) as Record<string, unknown> & {
      pear: { commit: string; tree: string };
      nfx: { commit: string; source: { url: string; sha256: string }; library: { sha256: string } };
    };
    expect(j.license).toBe('AGPL-3.0-or-later');
    expect(j.pear).toMatchObject({ commit: 'd'.repeat(40), tree: 'clean' });
    expect(j.nfx.commit).toBe(C);
    expect(j.nfx.source).toEqual({
      url: `https://github.com/SovereignTechnology/nfx/archive/${C}.tar.gz`,
      sha256: S,
    });
    expect(j.nfx.library.sha256).toBe(T);
    expect(j['files']).toEqual(input.files);
    expect(JSON.parse(sourceRecord({ ...input, modified: true })).pear.tree).toBe('modified');
  });

  it('SITE_FILES is sorted bytewise, and sri384 is the SRI form', () => {
    expect([...SITE_FILES].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))).toEqual([
      ...SITE_FILES,
    ]);
    expect(sri384(new TextEncoder().encode('abc'))).toBe(
      'sha384-ywB1P0WjXou1oD1pmsZQBycsMqsO3tFjGotgWkP/W+2AhgcroefMI1i67KE0yCWn',
    );
  });
});
