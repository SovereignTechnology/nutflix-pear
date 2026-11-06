/**
 * Slice 5e-5 (ADR 0021): staging the iroh helper a packaged build ships. It must be a regular
 * executable file built for the TARGET (a helper built for the build machine would only fail on
 * a user's computer), copied 0755 to `iroh/`, and the choice to ship none must be explicit.
 */
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PACKAGED_IROH_HELPER } from '../identity.ts';
import {
  MAX_IROH_HELPER_BYTES,
  StageError,
  irohHelperArg,
  irohHelperFormatProblem,
  stageIrohHelper,
} from '../stage.ts';

/** The first bytes of an ELF64 little-endian executable for `machine`. */
function elf(machine: number): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  b[18] = machine & 0xff;
  b[19] = machine >> 8;
  return b;
}

/** The first bytes of a 64-bit little-endian Mach-O for `cpu`. */
function macho(cpu: number): Uint8Array {
  const b = new Uint8Array(64);
  new DataView(b.buffer).setUint32(0, 0xfeedfacf, true);
  new DataView(b.buffer).setUint32(4, cpu, true);
  return b;
}

describe('irohHelperFormatProblem', () => {
  it('accepts an executable built for the target', () => {
    expect(irohHelperFormatProblem(elf(62), 'linux', 'x64')).toBeNull();
    expect(irohHelperFormatProblem(elf(183), 'linux', 'arm64')).toBeNull();
    expect(irohHelperFormatProblem(macho(0x01000007), 'darwin', 'x64')).toBeNull();
    expect(irohHelperFormatProblem(macho(0x0100000c), 'darwin', 'arm64')).toBeNull();
    expect(
      irohHelperFormatProblem(new Uint8Array([0xca, 0xfe, 0xba, 0xbe]), 'darwin', 'x64'),
    ).toBeNull();
    expect(irohHelperFormatProblem(new Uint8Array([0x4d, 0x5a]), 'win32', 'x64')).toBeNull();
  });

  it('refuses another machine, another format, a 32-bit or big-endian ELF, a script', () => {
    expect(irohHelperFormatProblem(elf(183), 'linux', 'x64')).toMatch(/machine 183, not x64/);
    expect(irohHelperFormatProblem(elf(62), 'linux', 'arm64')).toMatch(/not arm64/);
    expect(irohHelperFormatProblem(macho(0x01000007), 'linux', 'x64')).toMatch(/not an ELF/);
    expect(irohHelperFormatProblem(elf(62), 'darwin', 'x64')).toMatch(/not a 64-bit Mach-O/);
    expect(irohHelperFormatProblem(macho(0x0100000c), 'darwin', 'x64')).toMatch(/not x64/);
    expect(irohHelperFormatProblem(elf(62), 'win32', 'x64')).toMatch(/not a PE/);
    const elf32 = elf(62);
    elf32[4] = 1;
    expect(irohHelperFormatProblem(elf32, 'linux', 'x64')).toMatch(/64-bit little-endian/);
    const be = elf(62);
    be[5] = 2;
    expect(irohHelperFormatProblem(be, 'linux', 'x64')).toMatch(/64-bit little-endian/);
    const script = new TextEncoder().encode('#!/bin/sh\necho hi\n');
    expect(irohHelperFormatProblem(script, 'linux', 'x64')).toMatch(/not an ELF/);
    expect(irohHelperFormatProblem(new Uint8Array(0), 'linux', 'x64')).toMatch(/not an ELF/);
    expect(irohHelperFormatProblem(elf(62), 'freebsd', 'x64')).toMatch(/no iroh helper format/);
  });
});

describe('stageIrohHelper', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nf-iroh-stage-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const helper = (bytes: Uint8Array, mode = 0o755): string => {
    const f = join(dir, 'nutflix-iroh-helper');
    writeFileSync(f, bytes);
    chmodSync(f, mode);
    return f;
  };

  it('copies a target executable to iroh/, 0755, byte for byte', () => {
    const src = helper(elf(62), 0o700);
    const out = join(dir, 'out');
    stageIrohHelper(src, out, 'linux', 'x64');
    const dst = join(out, PACKAGED_IROH_HELPER);
    expect(readFileSync(dst)).toEqual(readFileSync(src));
    expect(statSync(dst).mode & 0o777).toBe(0o755);
  });

  it('names the .exe on Windows', () => {
    const out = join(dir, 'out');
    stageIrohHelper(helper(new Uint8Array([0x4d, 0x5a, 0, 0])), out, 'win32', 'x64');
    expect(statSync(join(out, `${PACKAGED_IROH_HELPER}.exe`)).isFile()).toBe(true);
  });

  it('refuses a missing file, a symlink, a directory, a non-executable, another target', () => {
    const out = join(dir, 'out');
    expect(() => {
      stageIrohHelper(join(dir, 'nope'), out, 'linux', 'x64');
    }).toThrow(/does not exist/);
    const real = helper(elf(62));
    const link = join(dir, 'link');
    symlinkSync(real, link);
    expect(() => {
      stageIrohHelper(link, out, 'linux', 'x64');
    }).toThrow(/is a symlink/);
    expect(() => {
      stageIrohHelper(dir, out, 'linux', 'x64');
    }).toThrow(/not a regular file/);
    chmodSync(real, 0o644);
    expect(() => {
      stageIrohHelper(real, out, 'linux', 'x64');
    }).toThrow(/not executable/);
    chmodSync(real, 0o755);
    expect(() => {
      stageIrohHelper(real, out, 'linux', 'arm64');
    }).toThrow(/machine 62, not arm64 \(target linux-arm64\)/);
    expect(() => {
      stageIrohHelper(real, out, 'linux', 'x64');
    }).not.toThrow();
  });

  it('refuses a file over the cap', () => {
    // Sparse: the size is what counts, and writing 64 MiB would only slow the suite.
    const big = helper(elf(62));
    truncateSync(big, MAX_IROH_HELPER_BYTES + 1);
    expect(() => {
      stageIrohHelper(big, join(dir, 'out'), 'linux', 'x64');
    }).toThrow(/over 67108864/);
    expect(() => {
      stageIrohHelper(big, join(dir, 'out'), 'linux', 'x64');
    }).toThrow(StageError);
  });
});

describe('irohHelperArg: a choice, never an omission', () => {
  it('--iroh-helper <file> resolves it; --without-iroh-helper is null', () => {
    expect(irohHelperArg(['--iroh-helper', 'crates/h'])).toBe(resolve('crates/h'));
    expect(irohHelperArg(['--platform', 'linux', '--without-iroh-helper'])).toBeNull();
  });

  it('refuses neither, both, or a flag with no file', () => {
    expect(() => irohHelperArg([])).toThrow(/--without-iroh-helper/);
    expect(() => irohHelperArg(['--iroh-helper', 'h', '--without-iroh-helper'])).toThrow(
      /not both/,
    );
    expect(() => irohHelperArg(['--iroh-helper'])).toThrow(/needs a file/);
    expect(() => irohHelperArg(['--iroh-helper', '--without-iroh-helper'])).toThrow(/needs a file/);
  });
});
