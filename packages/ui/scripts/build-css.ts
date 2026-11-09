#!/usr/bin/env node
/**
 * Flattens the design-system stylesheets into dist/ so a shell can load them with a single
 * `<link rel="stylesheet">` (SRI-able, CSP `style-src 'self'` clean — no runtime injection):
 *   dist/tokens.css      = src/tokens/tokens.css
 *   dist/components.css  = src/components/components.css with its @imports inlined
 *   dist/screens.css     = src/screens/screens.css with its @imports inlined (L5)
 *   dist/ui.css          = all three, in that order
 *   dist/shell.css       = src/shell/shell.css, the app shell's layout (ADR 0022), a separate sheet
 *                          that a shell links after ui.css
 * Plain CSS in, plain CSS out — no bundler, no minifier, byte-identical for every consumer.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', 'src');
const dist = resolve(here, '..', 'dist');

const IMPORT_RE = /^@import\s+['"]([^'"]+)['"];\s*$/gm;

function inline(file: string, seen = new Set<string>()): string {
  const abs = resolve(file);
  if (seen.has(abs)) throw new Error(`circular @import at ${abs}`);
  seen.add(abs);
  const text = readFileSync(abs, 'utf8');
  return text.replace(IMPORT_RE, (_m, rel: string) => {
    const target = resolve(dirname(abs), rel);
    return `/* ---- ${rel} ---- */\n${inline(target, new Set(seen))}`;
  });
}

const tokens = readFileSync(join(src, 'tokens', 'tokens.css'), 'utf8');
const components = inline(join(src, 'components', 'components.css'));
const screens = inline(join(src, 'screens', 'screens.css'));
const shell = readFileSync(join(src, 'shell', 'shell.css'), 'utf8');
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, 'tokens.css'), tokens);
writeFileSync(join(dist, 'components.css'), components);
writeFileSync(join(dist, 'screens.css'), screens);
writeFileSync(join(dist, 'ui.css'), `${tokens}\n${components}\n${screens}`);
writeFileSync(join(dist, 'shell.css'), shell);
process.stderr.write(
  `build-css: wrote dist/tokens.css, dist/components.css, dist/screens.css, dist/ui.css, dist/shell.css\n`,
);
