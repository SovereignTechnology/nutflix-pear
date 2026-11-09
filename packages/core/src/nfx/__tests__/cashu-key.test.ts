/**
 * A licensed manifest's `cashu_key` (NFX-02 §3) is a compressed secp256k1 point on the curve. The
 * check calls noble's `Point.fromHex` directly since ADR 0022 (cashu-ts's `pointFromHex` wrapped
 * it), so that `@sovit/core/nfx` loads no Cashu code: the same points pass and fail as before.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pointFromHex } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';

import { T0, TestSigner, sign } from '../../nostr/__tests__/helpers.js';
import { parseManifest } from '../manifest.js';

const NS = 'nfx:testnet:1';
/** The generator's x coordinate: on the curve with either parity. */
const GX = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
/** The field prime p: an x coordinate of p or more is not a field element. */
const P = 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f';

const signer = new TestSigner();

async function licensed(cashuKey: string) {
  const ev = await sign(signer, {
    kind: 38504,
    created_at: T0,
    content: 'A licensed video.',
    tags: [
      ['d', `${NS}:licensed-video`],
      ['n', NS],
      ['title', 'Licensed'],
      ['published_at', String(T0)],
      ['license', 'licensed'],
      ['root', 'ab'.repeat(32)],
      ['segs', '4'],
      ['key_price', '200'],
      ['split', '5000'],
      ['mint', 'https://mint.example'],
      ['cashu_key', cashuKey],
    ],
  });
  return parseManifest(ev);
}

/** What cashu-ts's `pointFromHex` said about `hex`: the behaviour before the switch. */
function cashuAccepts(hex: string): boolean {
  try {
    pointFromHex(hex);
    return true;
  } catch {
    return false;
  }
}

const CASES: readonly (readonly [string, string, boolean])[] = [
  ['the generator, even y', `02${GX}`, true],
  ['the generator, odd y', `03${GX}`, true],
  ['x = 1 (on the curve)', `02${'0'.repeat(63)}1`, true],
  ['x = 0 (no point: 7 is not a square mod p)', `02${'0'.repeat(64)}`, false],
  ['x = 5 (no point)', `03${'0'.repeat(63)}5`, false],
  ['x = p (not a field element)', `02${P}`, false],
  ['x = 2^256 - 1', `02${'f'.repeat(64)}`, false],
  ['an uncompressed prefix', `04${GX}`, false],
  ['the infinity encoding', `00${'0'.repeat(64)}`, false],
  ['upper-case hex', `02${GX.toUpperCase()}`, false],
  ['32 bytes', GX, false],
  ['34 bytes', `02${GX}00`, false],
  ['not hex', `02${'zz'.repeat(32)}`, false],
];

describe('cashu_key: a compressed secp256k1 point (noble, as cashu-ts did)', () => {
  for (const [name, key, valid] of CASES) {
    it(`${name}: ${valid ? 'accepted' : 'refused'}`, async () => {
      const parsed = await licensed(key);
      expect(parsed.ok).toBe(valid);
      if (valid && parsed.ok) {
        expect(parsed.value.license).toMatchObject({ mode: 'licensed', terms: { cashuKey: key } });
      }
      if (!valid && !parsed.ok) expect(parsed.error.reason).toMatch(/cashu_key/);
    });
  }

  it('on every point the old check saw, the decision is the same', async () => {
    for (const [, key] of CASES) {
      // The old check: the shape first (lowercase hex, 02/03), then cashu-ts's pointFromHex.
      const shaped = /^0[23][0-9a-f]{64}$/.test(key);
      expect((await licensed(key)).ok, key).toBe(shaped && cashuAccepts(key));
    }
  });
});

describe('@sovit/core/nfx and @sovit/core/nostr load no Cashu code (ADR 0022)', () => {
  it('no module under nfx/ or nostr/ imports @cashu', () => {
    const src = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
    let scanned = 0;
    for (const dir of ['nfx', 'nostr']) {
      for (const f of readdirSync(join(src, dir))) {
        if (!f.endsWith('.ts')) continue;
        scanned += 1;
        expect(readFileSync(join(src, dir, f), 'utf8'), `${dir}/${f}`).not.toMatch(
          /from '@cashu\//,
        );
      }
    }
    expect(scanned).toBeGreaterThan(20);
  });
});
