import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers.js';

const workflow = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.trim() && !line.trimStart().startsWith('#'))
  .join('\n');
// Match only the verify job's step entries, excluding other jobs and comments.
const verify = /^ {2}verify:\n((?: {4}.*\n?)+)/m.exec(workflow)?.[1] ?? '';
const steps = verify.split(/^ {6}- /m).slice(1);

function step(matcher: RegExp): string {
  const matches = steps.filter((candidate) => matcher.test(candidate));
  expect(matches, `verify steps matching ${matcher.source}`).toHaveLength(1);
  return matches[0]!;
}

const restoreStep = /^(?: {8})?uses: actions\/cache\/restore@/m;
const saveStep = /^(?: {8})?uses: actions\/cache\/save@/m;
const auditStep = /^(?: {8})?run: npm audit signatures\b/m;
const tidyStep = /^ {10}npm cache verify\b/m;
const lockfileKey = /^ {10}key: npm-audit-\$\{\{ hashFiles\('package-lock\.json'\) \}\}\s*$/m;
const httpCachePath = /^ {10}path: \$\{\{ runner\.temp \}\}\/npm-audit\/_cacache\s*$/m;
const onNonExactHit = /^(?: {8})?if: steps\.audit-cache\.outputs\.cache-hit != 'true'\s*$/m;

describe('verify job npm audit cache', () => {
  it('restores a lockfile-specific cache, with an older audit cache as fallback', () => {
    const restore = step(restoreStep);
    expect(restore).toMatch(/^ {8}id: audit-cache$/m);
    expect(restore).toMatch(lockfileKey);
    expect(restore).toMatch(/^ {10}restore-keys: \|\n {12}npm-audit-$(?!\n {12})/m);
  });

  it('shares only npm HTTP data between runs, excluding the TUF key cache', () => {
    for (const cacheStep of [step(restoreStep), step(saveStep)]) {
      expect(cacheStep).toMatch(httpCachePath);
    }
    expect(step(saveStep)).toMatch(lockfileKey);
  });

  it('checks signatures even on an exact cache hit and propagates audit failures', () => {
    const audit = step(auditStep);
    expect(audit).toMatch(
      /^(?: {8})?run: npm audit signatures --cache "\$RUNNER_TEMP\/npm-audit"$/m,
    );
    expect(audit).not.toMatch(/^(?: {8})?(?:if|continue-on-error):/m);
    expect(verify).not.toMatch(/^ {4}continue-on-error:/m);
  });

  it('tidies and saves on a cold or fallback restore, but skips an exact hit or failed audit', () => {
    const tidy = step(tidyStep);
    const save = step(saveStep);
    // With no explicit status function in these conditions, Actions requires success().
    expect(tidy).toMatch(onNonExactHit);
    expect(tidy).not.toMatch(/^(?: {8})?continue-on-error:/m);
    expect(tidy).toMatch(
      /^ {8}run: \|\n {10}npm cache verify --cache "\$RUNNER_TEMP\/npm-audit"\n {10}du -sh "\$RUNNER_TEMP\/npm-audit\/_cacache"$/m,
    );
    expect(save).toMatch(onNonExactHit);

    const positions = [step(restoreStep), step(auditStep), tidy, save].map((s) => steps.indexOf(s));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
