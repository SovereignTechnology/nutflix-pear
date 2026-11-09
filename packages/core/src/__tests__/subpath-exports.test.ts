/**
 * ADR 0022: `@sovit/core/nostr` and `@sovit/core/nfx` are entry points a web page can import
 * without the wallet, payment, signer or `pay/1` code (and their Cashu dependency), and the
 * package declares no side effects. Checked on the source's runtime import graph: `import type`
 * is erased, every other relative import is followed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as nostrEntry from '../nostr/index.js';
import * as nfxEntry from '../nfx/index.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = resolve(SRC, '..');

/** Runtime import specifiers of one module (not `import type` / `export type`). */
function runtimeImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /^(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s+'([^']+)'/gms;
  for (const m of text.matchAll(re)) {
    if (m[1] !== undefined) continue;
    const what = (m[2] ?? '').trim();
    // `import { type A, type B } from` is erased too.
    if (
      /^\{[^}]*\}$/.test(what) &&
      what
        .slice(1, -1)
        .split(',')
        .every((s) => /^\s*(type\s|$)/.test(s))
    )
      continue;
    out.push(m[3] ?? '');
  }
  for (const m of text.matchAll(/^import\s+'([^']+)';/gm)) out.push(m[1] ?? '');
  return out;
}

/** Every source file and external package reachable from `entry` at run time. */
function graph(entry: string): { files: Set<string>; packages: Map<string, Set<string>> } {
  const files = new Set<string>();
  const packages = new Map<string, Set<string>>();
  const todo = [entry];
  for (let f = todo.pop(); f !== undefined; f = todo.pop()) {
    if (files.has(f)) continue;
    files.add(f);
    for (const spec of runtimeImports(f)) {
      if (spec.startsWith('.')) {
        todo.push(resolve(dirname(f), spec.replace(/\.js$/, '.ts')));
        continue;
      }
      const name = spec.startsWith('@')
        ? spec.split('/').slice(0, 2).join('/')
        : spec.split('/')[0]!;
      const from = packages.get(name) ?? new Set<string>();
      from.add(relative(SRC, f));
      packages.set(name, from);
    }
  }
  return { files, packages };
}

const FORBIDDEN_DIRS = ['wallet/', 'payment/', 'signer/', 'pay-protocol/', 'mocks/', 'media/'];

describe('core entry points (ADR 0022)', () => {
  it('package.json maps ./nostr and ./nfx to their dist barrels and declares no side effects', () => {
    const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
      exports: Record<string, { types: string; default: string }>;
      sideEffects: unknown;
    };
    expect(pkg.exports['./nostr']).toEqual({
      types: './dist/nostr/index.d.ts',
      default: './dist/nostr/index.js',
    });
    expect(pkg.exports['./nfx']).toEqual({
      types: './dist/nfx/index.d.ts',
      default: './dist/nfx/index.js',
    });
    expect(pkg.sideEffects).toBe(false);
  });

  for (const entry of ['nostr', 'nfx'] as const) {
    it(`${entry}/ reaches no wallet, payment, signer, pay/1, mock or media code`, () => {
      const { files, packages } = graph(join(SRC, entry, 'index.ts'));
      const reached = [...files].map((f) => relative(SRC, f));
      expect(reached.length).toBeGreaterThan(3);
      for (const f of reached) {
        expect(
          FORBIDDEN_DIRS.some((d) => f.startsWith(d)),
          f,
        ).toBe(false);
      }
      // No cashu code at all (M3 moved the one curve-point check in NFX manifests to @noble/curves).
      expect(packages.has('@cashu/cashu-ts')).toBe(false);
      // No sodium (M4): a page would get sodium-javascript. SHA-256 is @noble/hashes' (nfx/util.ts)
      // and the NFX-12 bind check @noble/curves' Ed25519 (nfx/beacon.ts).
      expect([...packages.keys()].filter((p) => p.includes('sodium'))).toEqual([]);
      const curves = [...(packages.get('@noble/curves') ?? [])].sort();
      expect(
        curves.every((f) => f === 'nfx/manifest.ts' || f === 'nfx/beacon.ts'),
        curves.join(', '),
      ).toBe(true);
      const hashes = [...(packages.get('@noble/hashes') ?? [])];
      expect(
        hashes.every((f) => f === 'nfx/util.ts'),
        hashes.join(', '),
      ).toBe(true);
      const allowed = ['nostr-tools', '@noble/curves', '@noble/hashes'];
      expect([...packages.keys()].filter((p) => !allowed.includes(p))).toEqual([]);
    });
  }

  it('the moved NFX pieces are on the nostr and nfx entry points', () => {
    for (const name of [
      'NfxCatalog',
      'NfxBeaconWatch',
      'RelaySearchSupport',
      'searchNfxVideosRouted',
      'scanNfxVideos',
    ] as const)
      expect(typeof nostrEntry[name], name).toBe('function');
    expect(typeof nfxEntry.beaconFilter).toBe('function');
  });
});
