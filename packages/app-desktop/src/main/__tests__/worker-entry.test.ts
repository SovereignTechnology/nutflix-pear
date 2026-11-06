/**
 * Issue #6 (ADR 0017): the worker entry main hands the host. A dev build spawns the `tsc` output
 * next to main; a packaged build (main's `dist/` IS `resources/app.asar`, which Bare cannot
 * read) spawns the unbundled boot module in the unpacked tree beside the archive.
 *
 * Independent review of the packaging lane: the archive is now named by the caller
 * (`appArchive(process.resourcesPath)` in main.ts) instead of being guessed from the first
 * `*.asar` segment, so each case passes it.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { appArchive } from '../../ipc/asar-path.js';
import {
  PACKAGED_IROH_HELPER,
  PACKAGED_WORKER_ENTRY,
  WORKER_ENTRY,
  hostArgs,
  irohHelperFor,
  workerEntryFor,
} from '../args.js';

const ARCHIVE = '/opt/Nutflix/resources/app.asar';

describe('workerEntryFor', () => {
  it('dev: dist/worker/entry.js next to main', () => {
    const dist = '/home/u/nutflix/packages/app-desktop/dist';
    // The dev Electron has a resources directory of its own; main is not inside its archive.
    const devArchive = appArchive('/home/u/nutflix/node_modules/electron/dist/resources');
    expect(workerEntryFor(dist, devArchive)).toBe(join(dist, WORKER_ENTRY));
    expect(workerEntryFor(dist, undefined)).toBe(join(dist, WORKER_ENTRY));
    expect(WORKER_ENTRY).toBe('worker/entry.js');
  });

  it('packaged: the boot module in app.asar.unpacked, never a path inside the archive', () => {
    const entry = workerEntryFor(ARCHIVE, appArchive('/opt/Nutflix/resources'));
    expect(entry).toBe(join('/opt/Nutflix/resources/app.asar.unpacked', PACKAGED_WORKER_ENTRY));
    expect(PACKAGED_WORKER_ENTRY).toBe('worker/boot.mjs');
    expect(entry).not.toMatch(/app\.asar[\\/]/);
  });

  it('an app.asar that is not the app’s own archive is not treated as one', () => {
    const elsewhere = '/tmp/copy/resources/app.asar';
    expect(workerEntryFor(elsewhere, ARCHIVE)).toBe(join(elsewhere, WORKER_ENTRY));
  });

  it('the packaged entry passes through hostArgs unchanged (the host parser takes any absolute path)', () => {
    const workerEntry = workerEntryFor(ARCHIVE, ARCHIVE);
    expect(
      hostArgs(
        { devMocks: false, devFixtures: false, userDataDir: undefined, e2eHooks: false },
        { userData: '/home/u/.config/Nutflix', workerEntry },
      ),
    ).toEqual(['--user-data-dir=/home/u/.config/Nutflix', `--worker-entry=${workerEntry}`]);
  });
});

describe('irohHelperFor (slice 5e-5)', () => {
  const opts = { devMocks: false, devFixtures: false, userDataDir: undefined, e2eHooks: false };

  it('dev: nothing (the host reads NUTFLIX_IROH_HELPER)', () => {
    const dist = '/home/u/nutflix/packages/app-desktop/dist';
    const devArchive = appArchive('/home/u/nutflix/node_modules/electron/dist/resources');
    expect(irohHelperFor(dist, devArchive, 'linux')).toBeUndefined();
    expect(irohHelperFor(dist, undefined, 'linux')).toBeUndefined();
  });

  it('packaged: the helper in app.asar.unpacked (.exe on Windows), never inside the archive', () => {
    const archive = appArchive('/opt/Nutflix/resources');
    const helper = irohHelperFor(ARCHIVE, archive, 'linux');
    expect(PACKAGED_IROH_HELPER).toBe('iroh/nutflix-iroh-helper');
    expect(helper).toBe(join('/opt/Nutflix/resources/app.asar.unpacked', PACKAGED_IROH_HELPER));
    expect(helper).not.toMatch(/app\.asar[\\/]/);
    expect(irohHelperFor(ARCHIVE, archive, 'win32')).toBe(
      join('/opt/Nutflix/resources/app.asar.unpacked', `${PACKAGED_IROH_HELPER}.exe`),
    );
  });

  it('hostArgs passes it as --iroh-helper, and only when there is one', () => {
    const paths = { userData: '/ud', workerEntry: '/w/boot.mjs' };
    expect(hostArgs(opts, paths)).not.toContainEqual(expect.stringMatching(/^--iroh-helper/));
    expect(hostArgs(opts, { ...paths, irohHelper: '/opt/h' })).toEqual([
      '--user-data-dir=/ud',
      '--worker-entry=/w/boot.mjs',
      '--iroh-helper=/opt/h',
    ]);
  });
});
