/**
 * The host's command line (main passes it to `utilityProcess.fork`). Strict: an unknown or
 * malformed argument is an error, and the dev fences are enforced here —
 *   `--dev-fixtures` is REFUSED unless `--dev-mocks` is also on (design §5(a));
 *   `--dev-bootstrap` (a local hyperdht testnet) needs `--dev-mocks` and loopback only (D1).
 */
import { isAbsolute } from 'node:path';

export interface HostFlags {
  readonly devMocks: boolean;
  readonly devFixtures: boolean;
  /** ADR 0013: main can seal secrets in the OS keychain (never Linux's `basic_text`). */
  readonly keychain?: boolean;
  readonly devBootstrap?: readonly { readonly host: '127.0.0.1'; readonly port: number }[];
}

export interface HostArgs {
  readonly userData: string;
  readonly workerEntry: string;
  readonly flags: HostFlags;
}

export class HostArgsError extends Error {
  override readonly name = 'HostArgsError' as const;
}

/** Slice 5e-3: the environment variable naming the iroh helper's executable (dev and CI). */
export const IROH_HELPER_ENV = 'NUTFLIX_IROH_HELPER';

/**
 * Slice 5e-3 (ADR 0021): the iroh helper's executable from `NUTFLIX_IROH_HELPER` (dev and CI;
 * slice 5e-5 supplies a packaged build's own copy), or `null` when it is unset or empty, and the
 * worker then speaks HyperDHT only. Strict like the arguments: a value that is not an absolute
 * path is an error, never a quiet fallback.
 */
export function irohHelperFromEnv(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  if (!isAbsolute(value) || value.includes('\u0000'))
    throw new HostArgsError(`${IROH_HELPER_ENV} needs an absolute path`);
  return value;
}

function bootstrapList(v: string): { host: '127.0.0.1'; port: number }[] {
  const out: { host: '127.0.0.1'; port: number }[] = [];
  for (const part of v.split(',')) {
    const m = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(part);
    const port = Number(m?.[1]);
    if (!m || port > 65535) throw new HostArgsError('--dev-bootstrap takes 127.0.0.1:<port>[,…]');
    out.push({ host: '127.0.0.1', port });
  }
  if (out.length === 0 || out.length > 16) throw new HostArgsError('--dev-bootstrap: 1–16 nodes');
  return out;
}

export function parseHostArgs(argv: readonly string[]): HostArgs {
  let userData: string | undefined;
  let workerEntry: string | undefined;
  let devMocks = false;
  let devFixtures = false;
  let keychain = false;
  let devBootstrap: { host: '127.0.0.1'; port: number }[] | undefined;
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? undefined : arg.slice(eq + 1);
    switch (key) {
      case '--user-data-dir':
      case '--worker-entry': {
        if (value === undefined || !isAbsolute(value) || value.includes('\u0000'))
          throw new HostArgsError(`${key} needs an absolute path`);
        if (key === '--user-data-dir') userData = value;
        else workerEntry = value;
        break;
      }
      case '--dev-mocks':
      case '--dev-fixtures':
        if (value !== undefined) throw new HostArgsError(`${key} takes no value`);
        if (key === '--dev-mocks') devMocks = true;
        else devFixtures = true;
        break;
      case '--keychain':
        if (value !== undefined) throw new HostArgsError('--keychain takes no value');
        keychain = true;
        break;
      case '--dev-bootstrap':
        if (value === undefined) throw new HostArgsError('--dev-bootstrap needs a value');
        devBootstrap = bootstrapList(value);
        break;
      default:
        throw new HostArgsError('unknown host argument');
    }
  }
  if (userData === undefined) throw new HostArgsError('--user-data-dir is required');
  if (workerEntry === undefined) throw new HostArgsError('--worker-entry is required');
  if (devFixtures && !devMocks)
    throw new HostArgsError('--dev-fixtures is refused without --dev-mocks');
  if (devBootstrap !== undefined && !devMocks)
    throw new HostArgsError('--dev-bootstrap is refused without --dev-mocks');
  return {
    userData,
    workerEntry,
    flags: {
      devMocks,
      devFixtures,
      ...(keychain ? { keychain } : {}),
      ...(devBootstrap === undefined ? {} : { devBootstrap }),
    },
  };
}
