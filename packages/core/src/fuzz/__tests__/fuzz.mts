/**
 * The fuzz campaign's harness (execution plan §4; Cameron, 2026-10-02: fast-check, long runs, in a
 * GitHub Actions workflow started by hand, and short nightly runs since 2026-11-06 —
 * `.github/workflows/fuzz.yml`).
 *
 * `fuzzIt` registers one target. In the ordinary suite (no `FUZZ_SECONDS`) it is a quick property
 * test. In a campaign (`FUZZ_SECONDS` > 0) it draws fresh seeds until the deadline; a finding fails
 * the test after printing everything needed to replay it: `fc.assert(prop, { seed, path })`.
 * `FUZZ_SHARD` keeps the parallel jobs' seeds apart.
 */
import * as fc from 'fast-check';
import { it } from 'vitest';

const SECONDS = Number(process.env['FUZZ_SECONDS'] ?? '0');
const SHARD = Number(process.env['FUZZ_SHARD'] ?? '0');
const CAMPAIGN = Number.isFinite(SECONDS) && SECONDS > 0;
/** Cases per seed in a campaign: small enough that the deadline is never overrun by much. */
const BATCH = 2_000;
/**
 * Targets registered in this file: vitest runs one file's tests one after another, so a campaign
 * shares `FUZZ_SECONDS` among them (each file is its own worker and gets the whole budget).
 */
let registered = 0;

export function fuzzIt<T>(
  name: string,
  arb: fc.Arbitrary<T>,
  check: (v: T) => void | Promise<void>,
  quickRuns = 200,
): void {
  const prop = fc.asyncProperty(arb, async (v) => {
    await check(v);
  });
  registered++;
  it(
    name,
    async () => {
      if (!CAMPAIGN) {
        await fc.assert(prop, { numRuns: quickRuns });
        return;
      }
      const deadline = Date.now() + (SECONDS * 1000) / Math.max(1, registered);
      let runs = 0;
      for (let round = 0; Date.now() < deadline; round++) {
        const seed = (SHARD * 1_000_003 + round * 7_919 + (Date.now() % 1_000_000)) | 0;
        const r = await fc.check(prop, { numRuns: BATCH, seed });
        runs += r.numRuns;
        if (r.failed) {
          // In the error itself: the reporter always shows a failure's message, not always logs.
          throw new Error(
            [
              `FUZZ FINDING [${name}] shard ${String(SHARD)}`,
              `  replay: fc.assert(prop, { seed: ${String(r.seed)}, path: ${JSON.stringify(r.counterexamplePath)} })`,
              `  error: ${String(r.errorInstance)}`,
              `  counterexample: ${fc.stringify(r.counterexample).slice(0, 4000)}`,
            ].join('\n'),
          );
        }
      }
      console.warn(`FUZZ [${name}] shard ${String(SHARD)}: ${String(runs)} cases, no finding`);
    },
    CAMPAIGN ? SECONDS * 1000 + 300_000 : 60_000,
  );
}

/** Random edits of a string: replace, insert or delete characters (structure-aware enough). */
export function mutatedString(base: string): fc.Arbitrary<string> {
  const edit = fc.tuple(
    fc.constantFrom('set', 'insert', 'delete'),
    fc.nat(),
    fc.string({ minLength: 1, maxLength: 4, unit: 'binary' }),
  );
  return fc.array(edit, { minLength: 1, maxLength: 6 }).map((edits) => {
    let s = base;
    for (const [op, at, text] of edits) {
      const i = s.length === 0 ? 0 : at % (s.length + 1);
      if (op === 'insert') s = s.slice(0, i) + text + s.slice(i);
      else if (op === 'delete') s = s.slice(0, i) + s.slice(i + 1);
      else s = s.slice(0, i) + text + s.slice(i + 1);
    }
    return s;
  });
}

/** Random edits of bytes: flip, insert, delete. */
export function mutatedBytes(base: Uint8Array): fc.Arbitrary<Uint8Array> {
  const edit = fc.tuple(
    fc.constantFrom('flip', 'insert', 'delete'),
    fc.nat(),
    fc.integer({ min: 0, max: 255 }),
  );
  return fc.array(edit, { minLength: 1, maxLength: 8 }).map((edits) => {
    const b = Array.from(base);
    for (const [op, at, v] of edits) {
      const i = b.length === 0 ? 0 : at % (b.length + 1);
      if (op === 'insert') b.splice(i, 0, v);
      else if (op === 'delete') b.splice(i, 1);
      else if (i < b.length) b[i] = (b[i] ?? 0) ^ (v === 0 ? 1 : v);
    }
    return Uint8Array.from(b);
  });
}
