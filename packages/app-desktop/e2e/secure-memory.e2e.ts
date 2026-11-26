/**
 * Key memory in the REAL Electron. NEVER part of `npm test`; CI runs it in the e2e job:
 *
 *   NUTFLIX_E2E=1 node --test packages/app-desktop/e2e/secure-memory.e2e.ts
 *
 * Needs `npm run build` (the child imports core's built code) and the Electron binary. No
 * window, no display and no Chromium sandbox: the child runs under `ELECTRON_RUN_AS_NODE=1`.
 *
 * Why this suite exists. Every key the app holds comes from core's `secureAlloc`, which used
 * libsodium's guarded allocator (`sodium_malloc`) unconditionally. Electron refuses the external
 * ArrayBuffer that returns (the V8 memory cage), so in the shipped app "Create a new key" always
 * failed with "internal error", and so did importing or unlocking a key, opening the wallet's
 * journal and making a WebRTC signaling key (desktop 0.1.0 to 0.1.3). Nothing caught it: the unit
 * tests run in Node, where `sodium_malloc` works, and the other suites here run the app with
 * `--dev-mocks`, which refuses the signer flow.
 *
 * So `secure-memory/child.cjs` runs inside the Electron binary and does, with the real
 * sodium-native, what the host does for a new local key, the wallet's seed and a signaling key.
 * This suite asserts every step worked there, and that the child really ran in Electron.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { E2E, PKG, electronBinary } from './support.ts';

const CHILD = join(PKG, 'e2e', 'secure-memory', 'child.cjs');

interface ChildReport {
  readonly electron: string | null;
  readonly node: string;
  readonly step: string;
  readonly guarded?: boolean;
  readonly samePubkey?: boolean;
  readonly signed?: boolean;
  readonly wrongRefused?: boolean;
  readonly entropyRoundTrip?: boolean;
  readonly seedWiped?: boolean;
  readonly meshKey?: boolean;
  readonly error?: string;
  readonly code?: string | null;
}

void describe(
  'key memory in the real Electron',
  { skip: E2E ? false : 'set NUTFLIX_E2E=1 to run (Electron)' },
  () => {
    void it('makes, seals, unlocks and uses a local key, and derives the wallet seed', () => {
      const r = spawnSync(electronBinary(), [CHILD], {
        cwd: PKG,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        // argon2id at the default cost runs three times (create, unlock, the wrong passphrase).
        timeout: 180_000,
      });
      const line = r.stdout.trim().split('\n').at(-1) ?? '';
      let report: ChildReport;
      try {
        report = JSON.parse(line) as ChildReport;
      } catch {
        assert.fail(
          `the child printed no report (status ${String(r.status)}, signal ${String(r.signal)}): ${r.stderr.slice(0, 2000)}`,
        );
      }
      process.stdout.write(`secure-memory: ${line}\n`);

      assert.equal(typeof report.electron, 'string', 'the child did not run inside Electron');
      assert.equal(
        report.step,
        'done',
        `failed at "${report.step}": ${String(report.error)} ${String(report.code)}`,
      );
      assert.equal(r.status, 0);
      assert.equal(typeof report.guarded, 'boolean', 'hasSecureMemory() must answer, not throw');
      assert.equal(report.samePubkey, true, 'the unlocked key is the key that was made');
      assert.equal(report.signed, true, 'the unlocked key signs');
      assert.equal(report.wrongRefused, true, 'a wrong passphrase is refused as bad-passphrase');
      assert.equal(report.entropyRoundTrip, true);
      assert.equal(report.seedWiped, true);
      assert.equal(report.meshKey, true, 'a mesh session key is made (WebRTC signaling)');
    });
  },
);
