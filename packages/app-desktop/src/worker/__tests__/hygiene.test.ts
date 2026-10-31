/**
 * Worker hygiene: the redacting log path (nothing secret or peer-identifying leaves whole),
 * no `console` in worker runtime code, `bare-*` addons only in the Bare-only modules (so the
 * rest loads under Node), D6 as the entry's first import, and no Bare-missing globals used
 * directly by the worker's own runtime code.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from '@sovit/seeder';
import { describe, expect, it } from 'vitest';

import { LIMITS } from '../../ipc/protocol.js';
import { validateWorkerEvent } from '../../ipc/worker-guards.js';
import type { LogEvent } from '../log.js';
import { clampText, createWorkerLogger, toLogEvent } from '../log.js';

const WORKER = dirname(dirname(fileURLToPath(import.meta.url)));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      // Tests and L8's transcode adapter (its own lane, its own rules) are not ours to police.
      if (name === '__tests__' || name === 'transcode') continue;
      out.push(...sources(p));
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Modules that run ONLY under Bare (they import `bare-*` addons that cannot load in Node). */
const BARE_ONLY = new Set([
  'adapters/bare.ts',
  'entry.ts',
  'probe-entry.ts',
  'subprocess-probe-entry.ts',
  'bare-globals.ts',
]);

describe('worker log redaction', () => {
  const pk = 'ab'.repeat(32);
  const token = 'cashuBo2FteCJodHRwczovL21pbnQuZXhhbXBsZS5jb20';

  it('cuts every 32-byte value — even in public-id fields — and scrubs secrets', () => {
    const events: LogEvent[] = [];
    const log = createWorkerLogger({ emit: (e) => events.push(e), level: 'debug' });
    log.info(`paid ${pk}`, {
      pubkey: pk,
      noiseKey: pk,
      core: pk,
      token,
      proofs: [{ amount: 1, secret: 's', C: 'c' }],
    });
    const [e] = events;
    expect(e).toBeDefined();
    expect(e!.msg).not.toContain(pk);
    expect(e!.msg).toContain(`${pk.slice(0, 8)}…`);
    expect(e!.msg).not.toContain(token);
    expect(e!.msg).not.toContain('"secret"');
    expect(validateWorkerEvent.log(e)).toBe(true);
  });

  it('clamps to the protocol limit without splitting a surrogate pair', () => {
    const long = 'x'.repeat(LIMITS.maxString - 2) + '😀😀';
    const c = clampText(long, LIMITS.maxString);
    expect(c.length).toBeLessThanOrEqual(LIMITS.maxString);
    expect(/[\ud800-\udbff]$/.test(c.slice(0, -1))).toBe(false);
    const ev = toLogEvent(JSON.stringify({ msg: 'y'.repeat(20_000) }), { level: 'warn' });
    expect(validateWorkerEvent.log(ev)).toBe(true);
  });

  // Changed by security review F13: the seeder logger itself now replaces PEER identifiers with a
  // per-process alias; content ids (`core`, `sha256`) stay whole there and the worker layer cuts
  // them to 8 hex before the line leaves the process.
  it('the seeder logger aliases peer ids itself; content ids stay whole until the worker layer cuts them', () => {
    const lines: string[] = [];
    createLogger({ sink: (l) => lines.push(l) }).info('x', { pubkey: pk, core: pk });
    expect(lines[0]).toMatch(/"pubkey":"peer#\d+"/);
    expect(lines[0]).toContain(`"core":"${pk}"`);
  });
});

describe('worker source rules', () => {
  const files = sources(WORKER).map((p) => {
    const text = readFileSync(p, 'utf8');
    // Code only: comments may name what the code must not do.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    return { rel: relative(WORKER, p), text, code };
  });

  it('finds the worker sources', () => {
    expect(files.map((f) => f.rel)).toEqual(
      expect.arrayContaining(['host.ts', 'entry.ts', 'rpc.ts']),
    );
  });

  it('no console anywhere in worker runtime code (the redacting logger is the only output)', () => {
    for (const f of files) expect(f.code, f.rel).not.toMatch(/\bconsole\s*\./);
  });

  it('only the Bare-only modules import bare-* addons (everything else loads under Node)', () => {
    for (const f of files) {
      const importsBare = /from\s+'bare-[a-z0-9-]+'/.test(f.code);
      if (!BARE_ONLY.has(f.rel)) expect(importsBare, f.rel).toBe(false);
    }
  });

  it('D6: the entry’s first import installs bare-encoding’s globals', () => {
    const entry = files.find((f) => f.rel === 'entry.ts')!.text;
    const firstImport = /^import\s[^;]*;/m.exec(entry)?.[0];
    expect(firstImport).toBe("import './bare-globals.js';");
    const globals = files.find((f) => f.rel === 'bare-globals.ts')!.text;
    expect(globals).toMatch(/from 'bare-encoding'/);
    expect(globals).toMatch(/g\['TextEncoder'\] = TextEncoder/);
    expect(globals).toMatch(/g\['TextDecoder'\] = TextDecoder/);
  });

  it('no Bare-missing global is used directly (TextEncoder/Decoder, crypto, AbortController, process)', () => {
    for (const f of files) {
      if (f.rel === 'bare-globals.ts') continue;
      expect(f.code, f.rel).not.toMatch(
        /\bnew Text(En|De)coder\b|\bAbortController\b|\bprocess\.|\bcrypto\.(subtle|getRandomValues|randomUUID)/,
      );
    }
  });
});
