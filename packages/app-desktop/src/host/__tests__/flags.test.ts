import { describe, expect, it } from 'vitest';

import { HostArgsError, irohHelperFromEnv, parseHostArgs } from '../flags.js';

const BASE = ['--user-data-dir=/tmp/ud', '--worker-entry=/opt/app/dist/worker/main.js'];

describe('parseHostArgs', () => {
  it('parses the required paths and the dev flags', () => {
    expect(parseHostArgs(BASE)).toEqual({
      userData: '/tmp/ud',
      workerEntry: '/opt/app/dist/worker/main.js',
      flags: { devMocks: false, devFixtures: false },
    });
    expect(
      parseHostArgs([
        ...BASE,
        '--dev-mocks',
        '--dev-fixtures',
        '--dev-bootstrap=127.0.0.1:49737,127.0.0.1:1',
      ]).flags,
    ).toEqual({
      devMocks: true,
      devFixtures: true,
      devBootstrap: [
        { host: '127.0.0.1', port: 49737 },
        { host: '127.0.0.1', port: 1 },
      ],
    });
  });

  it('ADR 0013: --keychain (main found a real OS keychain) is a plain switch', () => {
    expect(parseHostArgs([...BASE, '--keychain']).flags).toEqual({
      devMocks: false,
      devFixtures: false,
      keychain: true,
    });
    expect(() => parseHostArgs([...BASE, '--keychain=basic_text'])).toThrow(HostArgsError);
  });

  it('REFUSES --dev-fixtures without --dev-mocks (design §5a)', () => {
    expect(() => parseHostArgs([...BASE, '--dev-fixtures'])).toThrow(
      /--dev-fixtures is refused without --dev-mocks/,
    );
  });

  it('refuses a dev bootstrap without --dev-mocks, or one that is not loopback (D1)', () => {
    expect(() => parseHostArgs([...BASE, '--dev-bootstrap=127.0.0.1:1'])).toThrow(HostArgsError);
    for (const v of ['10.0.0.1:1', '127.0.0.2:5', 'localhost:5', '127.0.0.1:0', '127.0.0.1:65536'])
      expect(() => parseHostArgs([...BASE, '--dev-mocks', `--dev-bootstrap=${v}`])).toThrow(
        HostArgsError,
      );
  });

  it('refuses relative paths, unknown arguments, values on switches and missing paths', () => {
    for (const argv of [
      ['--user-data-dir=ud', '--worker-entry=/w.js'],
      [...BASE, '--no-sandbox'],
      [...BASE, '--dev-mocks=1'],
      ['--worker-entry=/w.js'],
      ['--user-data-dir=/ud'],
      [...BASE, '--user-data-dir'],
    ])
      expect(() => parseHostArgs(argv), argv.join(' ')).toThrow(HostArgsError);
  });
});

describe('irohHelperFromEnv (slice 5e-3)', () => {
  it('takes an absolute path; unset or empty is no helper', () => {
    expect(irohHelperFromEnv('/opt/nutflix/nutflix-iroh-helper')).toBe(
      '/opt/nutflix/nutflix-iroh-helper',
    );
    expect(irohHelperFromEnv(undefined)).toBeNull();
    expect(irohHelperFromEnv('')).toBeNull();
  });

  it('refuses anything else instead of falling back quietly', () => {
    for (const v of ['nutflix-iroh-helper', './bin/helper', '/opt/a\u0000b'])
      expect(() => irohHelperFromEnv(v), JSON.stringify(v)).toThrow(HostArgsError);
  });
});
