/**
 * Host supervision (design §1 "supervises host"): `isHostOut` on everything from the host,
 * `backend-down` + respawn on exit within a restart budget, no respawn after quit; plus the
 * redacting logger and main's argv.
 */
import { describe, expect, it } from 'vitest';
import type { HostIn, HostOut } from '../../ipc/protocol.js';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_ENTRY, WORKER_ENTRY, hostArgs, parseMainArgs } from '../args.js';
import { HostLink, type HostChild } from '../host-link.js';
import { createLogger, formatLogLine } from '../log.js';

class Child implements HostChild {
  readonly posted: HostIn[] = [];
  readonly handlers = new Map<string, ((x: never) => void)[]>();
  killed = false;
  throwOnPost = false;
  postMessage(msg: HostIn): void {
    if (this.throwOnPost) throw new Error('closed');
    this.posted.push(msg);
  }
  on(event: 'message' | 'exit', listener: (x: never) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
    return this;
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  emit(event: 'message' | 'exit', x: unknown): void {
    for (const l of this.handlers.get(event) ?? []) l(x as never);
  }
}

function link(maxRestarts = 3): {
  l: HostLink;
  children: Child[];
  out: HostOut[];
  events: string[];
  clock: { now: number };
} {
  const children: Child[] = [];
  const out: HostOut[] = [];
  const events: string[] = [];
  const clock = { now: 0 };
  const l = new HostLink({
    spawn: () => {
      const c = new Child();
      children.push(c);
      return c;
    },
    onOut: (m) => out.push(m),
    onDown: () => events.push('down'),
    onRestart: () => events.push('restart'),
    now: () => clock.now,
    maxRestarts,
    windowMs: 60_000,
  });
  return { l, children, out, events, clock };
}

describe('HostLink', () => {
  it('posts to the running host; false when none runs', () => {
    const t = link();
    expect(t.l.post({ kind: 'wc-gone', wc: 1 })).toBe(false);
    t.l.start();
    expect(t.l.post({ kind: 'wc-gone', wc: 1 })).toBe(true);
    expect(t.children[0]?.posted).toEqual([{ kind: 'wc-gone', wc: 1 }]);
    t.children[0]!.throwOnPost = true;
    expect(t.l.post({ kind: 'wc-gone', wc: 1 })).toBe(false);
  });

  it('forwards only messages that pass isHostOut', () => {
    const t = link();
    t.l.start();
    const c = t.children[0]!;
    c.emit('message', {
      kind: 'media-link',
      token: 'tok0123456789abcdef',
      url: 'http://127.0.0.1:1/x',
    });
    for (const bad of [
      { kind: 'media-link', token: 'tok0123456789abcdef', url: 'http://10.0.0.1:1/x' },
      {
        kind: 'reply',
        wc: 1,
        msg: { v: 1, id: 1, ok: false, error: { code: 'nope', message: 'x' } },
      },
      { kind: 'eval', code: '1' },
      'string',
      null,
    ]) {
      c.emit('message', bad);
    }
    expect(t.out).toEqual([
      { kind: 'media-link', token: 'tok0123456789abcdef', url: 'http://127.0.0.1:1/x' },
    ]);
  });

  it('on exit: down, respawn, restart — within the budget', () => {
    const t = link(2);
    t.l.start();
    t.children[0]!.emit('exit', 1);
    expect(t.events).toEqual(['down', 'restart']);
    expect(t.l.running).toBe(true);
    t.children[1]!.emit('exit', 1);
    t.children[2]!.emit('exit', 1);
    expect(t.children).toHaveLength(3);
    expect(t.l.running).toBe(false);
    expect(t.events).toEqual(['down', 'restart', 'down', 'restart', 'down']);
    // The window slides.
    t.clock.now = 61_000;
    t.l.start();
    expect(t.l.running).toBe(true);
  });

  it('a stale child cannot deliver messages or exits', () => {
    const t = link();
    t.l.start();
    const old = t.children[0]!;
    old.emit('exit', 1);
    old.emit('message', { kind: 'media-link', token: 'tok0123456789abcdef', url: null });
    old.emit('exit', 1);
    expect(t.out).toHaveLength(0);
    expect(t.children).toHaveLength(2);
  });

  // Fix round 4: an app quit lets the host pay the open sessions' tails (SIGTERM → shutdown).
  it('stopAndWait kills the host and resolves when it exits — or after the bound, whichever is first', async () => {
    const t = link();
    t.l.start();
    let done = false;
    const p = t.l.stopAndWait(10_000).then(() => {
      done = true;
    });
    expect(t.children[0]!.killed).toBe(true);
    await Promise.resolve();
    expect(done).toBe(false);
    t.children[0]!.emit('exit', 0);
    await p;
    expect(done).toBe(true);
    expect(t.children).toHaveLength(1); // no respawn after a quit
    const hung = link();
    hung.l.start();
    const t0 = Date.now();
    await hung.l.stopAndWait(50); // never exits: the bound
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
    const none = link();
    await none.l.stopAndWait(10_000); // nothing running: at once
  });

  it('stop kills the host and never respawns it', () => {
    const t = link();
    t.l.start();
    t.l.stop();
    expect(t.children[0]?.killed).toBe(true);
    t.children[0]!.emit('exit', 0);
    expect(t.events).toEqual(['down']);
    t.l.start();
    expect(t.children).toHaveLength(1);
  });
});

describe('redacting logger', () => {
  it('keeps event names and scalar fields only; code must be an ErrorCode', () => {
    expect(formatLogLine('warn', 'gate.refused', { code: 'forbidden', n: 3, ok: true })).toBe(
      '[nutflix-main] warn gate.refused code=forbidden n=3 ok=true',
    );
    const leaky = {
      code: 'nope' as never,
      path: '/home/u/.ssh/id_ed25519' as never,
      url: 'http://127.0.0.1:1/tok' as never,
      'bad key': 1,
      nan: Number.NaN,
    };
    expect(formatLogLine('error', 'host.exit', leaky)).toBe('[nutflix-main] error host.exit');
  });

  it('filters by level and survives a broken writer', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l), 'warn');
    log('info', 'app.start');
    log('warn', 'host.exit');
    expect(lines).toEqual(['[nutflix-main] warn host.exit']);
    const broken = createLogger(() => {
      throw new Error('EPIPE');
    });
    expect(() => {
      broken('error', 'host.exit');
    }).not.toThrow();
  });
});

describe('main argv', () => {
  it('parses the dev flags and an absolute user-data dir (both spellings)', () => {
    expect(parseMainArgs(['main.js', '--dev-mocks', '--user-data-dir', '/tmp/x'])).toEqual({
      devMocks: true,
      devFixtures: false,
      userDataDir: '/tmp/x',
      e2eHooks: false,
    });
    expect(parseMainArgs(['--user-data-dir=/tmp/y', '--dev-fixtures', '--e2e-hooks'])).toEqual({
      devMocks: false,
      devFixtures: true,
      userDataDir: '/tmp/y',
      e2eHooks: true,
    });
  });

  it('refuses a relative user-data dir and a dangling flag', () => {
    expect(parseMainArgs(['--user-data-dir', 'rel/dir']).userDataDir).toBeUndefined();
    expect(parseMainArgs(['--user-data-dir']).userDataDir).toBeUndefined();
    expect(parseMainArgs(['--user-data-dir', '--dev-mocks']).devMocks).toBe(true);
  });

  const PATHS = { userData: '/ud', workerEntry: '/app/dist/worker/entry.js' };

  it('host args carry userData, the worker entry and only the dev flags', () => {
    expect(hostArgs(parseMainArgs(['--dev-mocks', '--no-sandbox']), PATHS)).toEqual([
      '--user-data-dir=/ud',
      '--worker-entry=/app/dist/worker/entry.js',
      '--dev-mocks',
    ]);
  });
});

/**
 * The two ends of the main → host argv must agree. They drifted once (main sent
 * `--user-data=`, the host's strict parser wanted `--user-data-dir=` and `--worker-entry=`): the
 * host exited 2, main respawned it until the budget ran out and reloaded the window each time,
 * and nothing loaded in Electron (docs/archive/lanes/E2E-fix.md, failure 2). So main's `hostArgs()` is
 * fed to the host's REAL `parseHostArgs()` — another TypeScript project, imported by path.
 */
describe("main → host argv round trip (the host's real parser)", () => {
  interface HostArgsLike {
    readonly userData: string;
    readonly workerEntry: string;
    readonly flags: { readonly devMocks: boolean; readonly devFixtures: boolean };
  }
  const parseHostArgs = async (argv: readonly string[]): Promise<HostArgsLike> => {
    const path = '../../host/flags.js';
    const mod = (await import(/* @vite-ignore */ path)) as {
      parseHostArgs(a: readonly string[]): HostArgsLike;
    };
    return mod.parseHostArgs(argv);
  };
  const paths = { userData: '/tmp/nf-ud', workerEntry: '/opt/nutflix/dist/worker/entry.js' };

  it.each([
    [[], { devMocks: false, devFixtures: false }],
    [['--dev-mocks'], { devMocks: true, devFixtures: false }],
    [['--dev-mocks', '--dev-fixtures', '--e2e-hooks'], { devMocks: true, devFixtures: true }],
    [['--dev-mocks', '--no-sandbox', '--whatever=1'], { devMocks: true, devFixtures: false }],
  ])('main argv %j → the host accepts it with the same meaning', async (argv, flags) => {
    const parsed = await parseHostArgs(hostArgs(parseMainArgs(argv), paths));
    expect(parsed.userData).toBe(paths.userData);
    expect(parsed.workerEntry).toBe(paths.workerEntry);
    expect(parsed.flags).toEqual(flags);
  });

  it('slice 5e-5: a packaged build’s --iroh-helper reaches the host unchanged', async () => {
    const helper = '/opt/Nutflix/resources/app.asar.unpacked/iroh/nutflix-iroh-helper';
    const parsed = (await parseHostArgs(
      hostArgs(parseMainArgs([]), { ...paths, irohHelper: helper }),
    )) as HostArgsLike & { readonly irohHelper?: string };
    expect(parsed.irohHelper).toBe(helper);
  });

  it('the host still refuses the old spelling (so this test would have caught the drift)', async () => {
    await expect(
      parseHostArgs(['--user-data=/tmp/nf-ud', '--dev-mocks', '--dev-fixtures']),
    ).rejects.toThrow(/unknown host argument/);
  });

  it('the entries main forks and hands the host are where the build puts them', () => {
    // `dist/` after `npm run build` (CI builds before it tests): the host entry, and the tsc
    // output of the worker entry (never a bundle, D6).
    const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist');
    for (const rel of [HOST_ENTRY, WORKER_ENTRY]) {
      expect(isAbsolute(join(dist, rel))).toBe(true);
      expect(existsSync(join(dist, rel)), `${rel} under dist/`).toBe(true);
    }
    expect(WORKER_ENTRY).toBe('worker/entry.js');
  });
});
