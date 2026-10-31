/**
 * `main.ts` wiring against a fake `electron` module (Electron cannot launch here, D4): the order
 * of the before-ready steps, the sandbox refusal (`app.commandLine` never gets `no-sandbox`, and
 * main exits when it is present), the protocols, the three IPC channels, the host spawn, the
 * window, and one message through each path (renderer call → host, host media-link → nf-media).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mocks } from '@sovit/core';

interface FakeChild {
  posted: unknown[];
  listeners: Map<string, ((x: unknown) => void)[]>;
  killed: boolean;
}

const fx = vi.hoisted(() => {
  const state = {
    order: [] as string[],
    switches: new Set<string>(),
    switchValues: new Map<string, string>(),
    appended: [] as string[],
    exitCode: undefined as number | undefined,
    appListeners: new Map<string, ((...a: unknown[]) => void)[]>(),
    protocols: new Map<string, (req: Request) => Promise<Response>>(),
    ipc: new Map<string, (e: unknown, raw: unknown) => Promise<unknown>>(),
    forks: [] as { path: string; args: string[]; opts: unknown }[],
    children: [] as FakeChild[],
    windows: [] as { options: Record<string, unknown>; url?: string }[],
    fetches: [] as { url: string; init: unknown }[],
    paths: new Map<string, string>(),
    ready: undefined as undefined | (() => void),
    /** `app.requestSingleInstanceLock()`'s answer. */
    primary: true,
    dialogs: [] as unknown[],
    dialogAnswer: 0,
    /**
     * Round 8: a dialog nobody answers — open until its `signal` aborts (then Cancel, as
     * Electron's `showMessageBox` does).
     */
    dialogHold: false,
    /** ADR 0013: `safeStorage` — off (a Linux box with no keyring) unless a test turns it on. */
    keychain: false,
    keychainBackend: 'gnome_libsecret',
    /** ADR 0013 addendum: what main asked the OS to open in the browser. */
    opened: [] as string[],
    /** `app.isPackaged` (F21: a packaged build refuses the dev flags). */
    packaged: false,
    /** Issue #6: what main ran through `execFileSync` (Squirrel's Update.exe only). */
    execs: [] as { file: string; args: string[]; opts: Record<string, unknown> }[],
  };
  return state;
});

// Issue #6 (Squirrel.Windows): main runs `..\Update.exe` through execFileSync; record it here.
vi.mock('node:child_process', () => ({
  execFileSync: (file: string, args: string[], opts: Record<string, unknown>) => {
    fx.execs.push({ file, args, opts });
    return Buffer.alloc(0);
  },
}));

vi.mock('electron', () => {
  const on =
    (m: Map<string, ((...a: unknown[]) => void)[]>) =>
    (event: string, fn: (...a: unknown[]) => void) => {
      m.set(event, [...(m.get(event) ?? []), fn]);
    };
  class BrowserWindow {
    static all: BrowserWindow[] = [];
    readonly webContents = {
      id: 1,
      on: () => undefined,
      once: () => undefined,
      reload: () => {
        fx.order.push('reload');
      },
    };
    private destroyed = false;
    private readonly closedListeners: (() => void)[] = [];
    constructor(options: Record<string, unknown>) {
      fx.windows.push({ options });
      // Per boot: the app window is webContents 1, a prompt window 2, …
      this.webContents.id = fx.windows.length;
      BrowserWindow.all.push(this);
    }
    once(event?: string, fn?: () => void): void {
      if (event === 'closed' && fn !== undefined) this.closedListeners.push(fn);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    close(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      const w = fx.windows[this.webContents.id - 1];
      if (w) (w as { closed?: boolean }).closed = true;
      for (const l of this.closedListeners.splice(0)) l();
    }
    show(): void {
      return undefined;
    }
    /** ADR 0016: recorded per window (webContents id → each call). */
    setContentProtection(on: boolean): void {
      const w = fx.windows[this.webContents.id - 1] as { protection?: boolean[] } | undefined;
      if (w) (w.protection ??= []).push(on);
    }
    loadURL(url: string): Promise<void> {
      const w = fx.windows.at(-1);
      if (w) w.url = url;
      return Promise.resolve();
    }
    static getAllWindows(): BrowserWindow[] {
      return BrowserWindow.all;
    }
  }
  return {
    app: {
      get isPackaged() {
        return fx.packaged;
      },
      commandLine: {
        hasSwitch: (s: string) => fx.switches.has(s),
        getSwitchValue: (s: string) => fx.switchValues.get(s) ?? '',
        appendSwitch: (s: string) => {
          fx.appended.push(s);
        },
      },
      enableSandbox: () => {
        fx.order.push('enableSandbox');
      },
      setPath: (k: string, v: string) => {
        fx.paths.set(k, v);
      },
      getPath: (k: string) => fx.paths.get(k) ?? `/tmp/nf-${k}`,
      on: on(fx.appListeners),
      exit: (code: number) => {
        fx.exitCode = code;
      },
      quit: () => {
        fx.order.push('quit');
      },
      requestSingleInstanceLock: () => fx.primary,
      whenReady: () =>
        new Promise<void>((r) => {
          fx.ready = () => {
            fx.order.push('ready');
            r();
          };
        }),
    },
    BrowserWindow,
    shell: {
      openExternal: (url: string) => {
        fx.opened.push(url);
        return Promise.resolve();
      },
    },
    safeStorage: {
      isEncryptionAvailable: () => fx.keychain,
      getSelectedStorageBackend: () => fx.keychainBackend,
      encryptStringAsync: (t: string) => Promise.resolve(Buffer.from(`sealed:${t}`)),
      decryptStringAsync: (b: Buffer) =>
        Promise.resolve({ result: b.toString().replace(/^sealed:/, ''), shouldReEncrypt: false }),
    },
    dialog: {
      showMessageBox: (...a: unknown[]) => {
        const box = a.at(-1) as { signal?: AbortSignal; cancelId?: number };
        fx.dialogs.push(box);
        if (!fx.dialogHold) return Promise.resolve({ response: fx.dialogAnswer });
        return new Promise((resolve) => {
          box.signal?.addEventListener('abort', () => {
            resolve({ response: box.cancelId ?? 0 });
          });
        });
      },
    },
    webContents: { fromId: () => undefined },
    Menu: { setApplicationMenu: () => undefined, buildFromTemplate: () => ({}) },
    ipcMain: {
      handle: (channel: string, fn: (e: unknown, raw: unknown) => Promise<unknown>) => {
        fx.ipc.set(channel, fn);
      },
    },
    net: {
      fetch: (url: string, init: unknown) => {
        fx.fetches.push({ url, init });
        return Promise.resolve(
          new Response(new Uint8Array([1, 2, 3]), {
            status: 206,
            headers: { 'content-range': 'bytes 0-2/3' },
          }),
        );
      },
    },
    protocol: {
      registerSchemesAsPrivileged: () => {
        fx.order.push('registerSchemes');
      },
      handle: (scheme: string, fn: (req: Request) => Promise<Response>) => {
        fx.protocols.set(scheme, fn);
      },
    },
    session: {
      defaultSession: {
        setPermissionRequestHandler: () => undefined,
        setPermissionCheckHandler: () => undefined,
        setDevicePermissionHandler: () => undefined,
        setSpellCheckerEnabled: () => undefined,
        on: () => undefined,
      },
    },
    utilityProcess: {
      fork: (path: string, args: string[], opts: unknown) => {
        fx.forks.push({ path, args, opts });
        const child: FakeChild = { posted: [], listeners: new Map(), killed: false };
        fx.children.push(child);
        return {
          // parentPort clones: main may wipe its buffers after posting.
          postMessage: (m: unknown) => child.posted.push(structuredClone(m)),
          on: (e: string, l: (x: unknown) => void) => {
            child.listeners.set(e, [...(child.listeners.get(e) ?? []), l]);
          },
          kill: () => {
            child.killed = true;
            return true;
          },
        };
      },
    },
  };
});

const argv = process.argv;
/** Everything main logged (stderr is captured, not printed). */
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    logged.push(String(chunk));
    return true;
  });
  vi.resetModules();
  fx.order.length = 0;
  fx.switches.clear();
  fx.switchValues.clear();
  fx.appended.length = 0;
  fx.exitCode = undefined;
  fx.primary = true;
  fx.dialogs.length = 0;
  fx.dialogAnswer = 0;
  fx.dialogHold = false;
  fx.keychain = false;
  fx.keychainBackend = 'gnome_libsecret';
  fx.opened.length = 0;
  fx.packaged = false;
  fx.execs.length = 0;
  fx.appListeners.clear();
  fx.protocols.clear();
  fx.ipc.clear();
  fx.forks.length = 0;
  fx.children.length = 0;
  fx.windows.length = 0;
  fx.fetches.length = 0;
  fx.paths.clear();
  fx.ready = undefined;
});

afterEach(() => {
  process.argv = argv;
  vi.restoreAllMocks();
  // The redacting logger: fixed event names and scalars only — no token, link, path or id.
  for (const line of logged) {
    expect(line).toMatch(
      /^\[nutflix-main\] (debug|info|warn|error) [a-z.-]+( [A-Za-z]+=[A-Za-z0-9.-]+)*\n$/,
    );
    expect(line).not.toMatch(/tok0123|127\.0\.0\.1|\/tmp\/|evil|nutflix\/index/);
  }
});

async function boot(extraArgs: string[] = []): Promise<void> {
  process.argv = [argv[0] ?? 'node', 'dist/main/main.js', ...extraArgs];
  await import('../main.js');
  fx.ready?.();
  await new Promise<void>((r) => {
    setTimeout(r, 0);
  });
}

describe('main.ts wiring (fake electron)', () => {
  it('before ready: sandbox forced on, schemes registered; nothing ever appends a switch', async () => {
    await boot();
    expect(fx.order.slice(0, 3)).toEqual(['enableSandbox', 'registerSchemes', 'ready']);
    expect(fx.appended).toEqual([]);
    expect(fx.exitCode).toBeUndefined();
  });

  it.each(['--dev-mocks', '--dev-fixtures', '--e2e-hooks'])(
    'a packaged build refuses %s (exit 78, nothing registered) — F21',
    async (flag) => {
      fx.packaged = true;
      process.argv = [argv[0] ?? 'node', 'dist/main/main.js', flag];
      await expect(import('../main.js')).rejects.toThrow(/packaged/);
      expect(fx.exitCode).toBe(78);
      expect(fx.order).toEqual([]);
      expect(fx.protocols.size).toBe(0);
    },
  );

  it('a packaged build without dev flags starts; an unpackaged one takes them (F21)', async () => {
    fx.packaged = true;
    await boot(['--user-data-dir=/tmp/nf-packaged']);
    expect(fx.exitCode).toBeUndefined();
    expect(fx.forks[0]?.args).not.toContain('--dev-mocks');
  });

  it.each(['remote-debugging-port', 'remote-debugging-pipe'])(
    'a packaged build refuses --%s (exit 78, nothing registered); a dev build keeps it (issue #6)',
    async (sw) => {
      fx.packaged = true;
      fx.switches.add(sw);
      process.argv = [argv[0] ?? 'node', 'dist/main/main.js'];
      await expect(import('../main.js')).rejects.toThrow(/remote debugging/);
      expect(fx.exitCode).toBe(78);
      expect(fx.order).toEqual([]);
      expect(fx.protocols.size).toBe(0);
      expect(fx.forks).toHaveLength(0);
      // The dev build (the e2e harness attaches through it) starts.
      vi.resetModules();
      fx.packaged = false;
      fx.exitCode = undefined;
      await boot();
      expect(fx.exitCode).toBeUndefined();
      expect(fx.forks).toHaveLength(1);
    },
  );

  describe('Squirrel.Windows lifecycle (issue #6, ADR 0017 §5)', () => {
    const real = {
      platform: Object.getOwnPropertyDescriptor(process, 'platform'),
      execPath: Object.getOwnPropertyDescriptor(process, 'execPath'),
    };
    const EXE = 'C:\\Users\\u\\AppData\\Local\\nutflix\\app-0.1.0\\nutflix.exe';
    const asWindows = (): void => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      Object.defineProperty(process, 'execPath', { value: EXE, configurable: true });
    };
    afterEach(() => {
      if (real.platform) Object.defineProperty(process, 'platform', real.platform);
      if (real.execPath) Object.defineProperty(process, 'execPath', real.execPath);
    });

    it.each([
      ['--squirrel-install', '--createShortcut=nutflix.exe'],
      ['--squirrel-updated', '--createShortcut=nutflix.exe'],
      ['--squirrel-uninstall', '--removeShortcut=nutflix.exe'],
    ])(
      'packaged win32 %s: runs ..\\Update.exe %s (no shell), exits 0 before anything else',
      async (flag, shortcut) => {
        fx.packaged = true;
        asWindows();
        // Even beside a sandbox-bypass switch: the hook never gets as far as Chromium content.
        fx.switches.add('no-sandbox');
        // A packaged app's argv has no app path: Squirrel's flag is argv[1].
        process.argv = [EXE, flag, '0.1.0'];
        await expect(import('../main.js')).rejects.toThrow(/Squirrel/);
        expect(fx.exitCode).toBe(0);
        expect(fx.execs).toHaveLength(1);
        expect(fx.execs[0]?.file).toBe('C:\\Users\\u\\AppData\\Local\\nutflix\\Update.exe');
        expect(fx.execs[0]?.args).toEqual([shortcut]);
        expect(fx.execs[0]?.opts).toMatchObject({ windowsHide: true, timeout: 10_000 });
        expect(fx.execs[0]?.opts).not.toHaveProperty('shell');
        // Nothing else ran: no sandbox setup, no schemes, no protocols, no window, no host.
        expect(fx.order).toEqual([]);
        expect(fx.protocols.size).toBe(0);
        expect(fx.windows).toHaveLength(0);
        expect(fx.forks).toHaveLength(0);
      },
    );

    it('packaged win32 --squirrel-obsolete exits without running anything', async () => {
      fx.packaged = true;
      asWindows();
      process.argv = [EXE, '--squirrel-obsolete', '0.1.0'];
      await expect(import('../main.js')).rejects.toThrow(/Squirrel/);
      expect(fx.exitCode).toBe(0);
      expect(fx.execs).toEqual([]);
      expect(fx.forks).toHaveLength(0);
    });

    it('--squirrel-firstrun starts the app normally', async () => {
      fx.packaged = true;
      asWindows();
      process.argv = [EXE, '--squirrel-firstrun'];
      await import('../main.js');
      fx.ready?.();
      await new Promise<void>((r) => {
        setTimeout(r, 0);
      });
      expect(fx.exitCode).toBeUndefined();
      expect(fx.execs).toEqual([]);
      expect(fx.forks).toHaveLength(1);
    });

    it('elsewhere (Linux, or a dev build) --squirrel-install is an ignored flag', async () => {
      fx.packaged = true;
      process.argv = ['/opt/Nutflix/nutflix', '--squirrel-install', '0.1.0'];
      await import('../main.js');
      fx.ready?.();
      await new Promise<void>((r) => {
        setTimeout(r, 0);
      });
      expect(fx.exitCode).toBeUndefined();
      expect(fx.execs).toEqual([]);
      expect(fx.forks).toHaveLength(1);
    });
  });

  it.each(['no-sandbox', 'disable-gpu-sandbox', 'no-zygote'])(
    'refuses to start with --%s (exit 78, nothing registered)',
    async (sw) => {
      fx.switches.add(sw);
      process.argv = [argv[0] ?? 'node', 'dist/main/main.js'];
      await expect(import('../main.js')).rejects.toThrow(/sandbox/);
      expect(fx.exitCode).toBe(78);
      expect(fx.order).toEqual([]);
      expect(fx.protocols.size).toBe(0);
    },
  );

  // Cross-lane review (round 4, LOW): the rest of Chromium's sandbox-off and in-process
  // switches, refused like D4's three — in a dev build AND a packaged one.
  it.each([
    'no-zygote-sandbox',
    'disable-seccomp-filter-sandbox',
    'disable-namespace-sandbox',
    'disable-setuid-sandbox',
    'disable-landlock-sandbox',
    'allow-sandbox-debugging',
    'gpu-sandbox-allow-sysv-shm',
    'disable-webnn-compiler-sandbox',
    'single-process',
    'in-process-gpu',
  ])('refuses to start with --%s, dev or packaged (exit 78, nothing started)', async (sw) => {
    for (const packaged of [false, true]) {
      vi.resetModules();
      fx.packaged = packaged;
      fx.exitCode = undefined;
      fx.switches.clear();
      fx.switches.add(sw);
      process.argv = [argv[0] ?? 'node', 'dist/main/main.js'];
      await expect(import('../main.js'), String(packaged)).rejects.toThrow(/sandbox/);
      expect(fx.exitCode).toBe(78);
      expect(fx.order).toEqual([]);
      expect(fx.protocols.size).toBe(0);
      expect(fx.forks).toHaveLength(0);
    }
    expect(logged.join('')).toMatch(/app\.sandbox-bypass-refused/);
  });

  // Round 4 (LOW): process wrappers, V8 flags and isolation overrides — packaged builds only.
  it.each([
    'renderer-cmd-prefix',
    'utility-cmd-prefix',
    'gpu-launcher',
    'zygote-cmd-prefix',
    'browser-subprocess-path',
    'js-flags',
    'disable-site-isolation-trials',
    'disable-web-security',
    'enable-blink-features',
    'disable-blink-features',
    'force-fieldtrials',
    'force-fieldtrial-params',
  ])(
    'a packaged build refuses --%s (exit 78, nothing started); a dev build keeps it',
    async (sw) => {
      fx.packaged = true;
      fx.switches.add(sw);
      process.argv = [argv[0] ?? 'node', 'dist/main/main.js'];
      await expect(import('../main.js')).rejects.toThrow(/refused in a packaged build/);
      expect(fx.exitCode).toBe(78);
      expect(fx.order).toEqual([]);
      expect(fx.protocols.size).toBe(0);
      expect(fx.windows).toHaveLength(0);
      expect(fx.forks).toHaveLength(0);
      expect(logged.join('')).toMatch(/app\.process-switch-refused/);
      // The dev build starts (a developer wraps a renderer in gdb, or passes --js-flags).
      vi.resetModules();
      fx.packaged = false;
      fx.exitCode = undefined;
      await boot();
      expect(fx.exitCode).toBeUndefined();
      expect(fx.forks).toHaveLength(1);
    },
  );

  // ADR 0017 open question 11 (Cameron, 2026-10-02): feature lists from the allow-list only.
  it('a packaged build refuses a feature outside the allow-list (exit 78, nothing started); a dev build keeps it', async () => {
    fx.packaged = true;
    process.argv = [
      argv[0] ?? 'node',
      'dist/main/main.js',
      '--disable-features=NetworkServiceSandbox',
    ];
    await expect(import('../main.js')).rejects.toThrow(/outside the allow-list/);
    expect(fx.exitCode).toBe(78);
    expect(fx.order).toEqual([]);
    expect(fx.windows).toHaveLength(0);
    expect(fx.forks).toHaveLength(0);
    expect(logged.join('')).toMatch(/app\.feature-switch-refused/);
    // The value Chromium reports is read as well as argv.
    vi.resetModules();
    logged = [];
    fx.exitCode = undefined;
    process.argv = [argv[0] ?? 'node', 'dist/main/main.js'];
    fx.switches.add('enable-features');
    fx.switchValues.set('enable-features', 'NetworkServiceInProcess');
    await expect(import('../main.js')).rejects.toThrow(/outside the allow-list/);
    expect(fx.exitCode).toBe(78);
    // The dev build starts.
    vi.resetModules();
    fx.packaged = false;
    fx.exitCode = undefined;
    await boot();
    expect(fx.exitCode).toBeUndefined();
    expect(fx.forks).toHaveLength(1);
  });

  it('a packaged build starts with the Wayland features', async () => {
    fx.packaged = true;
    fx.switches.add('enable-features');
    fx.switchValues.set('enable-features', 'UseOzonePlatform,WaylandWindowDecorations');
    await boot([
      '--enable-features=UseOzonePlatform,WaylandWindowDecorations',
      '--ozone-platform=wayland',
    ]);
    expect(fx.exitCode).toBeUndefined();
    expect(fx.forks).toHaveLength(1);
  });

  // Round 4: the order of the before-ready refusals is Squirrel (pinned in its own describe),
  // then the sandbox, the dev flags, the remote-debugging switches, the process switches, the
  // feature lists (open question 11). Each
  // step below removes the one that fired and checks the next one takes over.
  it('refusal order: sandbox, dev flags, remote debugging, process switches, feature lists', async () => {
    const steps: { drop: string | null; expect: RegExp; event: string }[] = [
      { drop: null, expect: /sandbox/, event: 'app.sandbox-bypass-refused' },
      {
        drop: 'disable-seccomp-filter-sandbox',
        expect: /dev flags/,
        event: 'app.dev-flag-refused',
      },
      { drop: '--dev-mocks', expect: /remote debugging/, event: 'app.debug-switch-refused' },
      {
        drop: 'remote-debugging-port',
        expect: /process-wrapper/,
        event: 'app.process-switch-refused',
      },
      {
        drop: 'utility-cmd-prefix',
        expect: /outside the allow-list/,
        event: 'app.feature-switch-refused',
      },
    ];
    const switches = new Set(['disable-seccomp-filter-sandbox', 'remote-debugging-port']);
    switches.add('utility-cmd-prefix');
    let flags = ['--dev-mocks'];
    for (const step of steps) {
      if (step.drop === '--dev-mocks') flags = [];
      else if (step.drop !== null) switches.delete(step.drop);
      vi.resetModules();
      logged = [];
      fx.packaged = true;
      fx.exitCode = undefined;
      fx.switches.clear();
      for (const sw of switches) fx.switches.add(sw);
      process.argv = [
        argv[0] ?? 'node',
        'dist/main/main.js',
        ...flags,
        '--disable-features=NetworkServiceSandbox',
      ];
      await expect(import('../main.js'), step.event).rejects.toThrow(step.expect);
      expect(fx.exitCode).toBe(78);
      expect(logged, step.event).toHaveLength(1);
      expect(logged[0]).toContain(` ${step.event}`);
      expect(fx.order).toEqual([]);
    }
  });

  it('registers the two protocols, the three IPC channels + the two prompt ones, one window at app://nutflix/', async () => {
    await boot();
    expect([...fx.protocols.keys()].sort()).toEqual(['app', 'nf-media']);
    expect([...fx.ipc.keys()].sort()).toEqual([
      'nf-prompt:answer',
      'nf-prompt:init',
      'nf:call',
      'nf:grant-file',
      'nf:sub',
    ]);
    expect(fx.windows).toHaveLength(1);
    expect(fx.windows[0]?.url).toBe('app://nutflix/index.html');
    const wp = fx.windows[0]?.options['webPreferences'] as Record<string, unknown>;
    expect(wp).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false });
    expect(String(wp['preload'])).toMatch(/[\\/]preload\.cjs$/);
  });

  it('spawns the host utilityProcess with userData and forwards only the dev flags', async () => {
    await boot([
      '--dev-mocks',
      '--dev-fixtures',
      '--user-data-dir',
      '/tmp/e2e-ud',
      '--no-such-flag',
    ]);
    expect(fx.paths.get('userData')).toBe('/tmp/e2e-ud');
    expect(fx.forks).toHaveLength(1);
    expect(fx.forks[0]?.path).toMatch(/[\\/]host[\\/]main\.js$/);
    // The worker entry is resolved next to main's own `dist/` (the sibling of `main/`).
    const distDir = dirname(dirname(fx.forks[0]?.path ?? ''));
    expect(fx.forks[0]?.args).toEqual([
      '--user-data-dir=/tmp/e2e-ud',
      `--worker-entry=${join(distDir, 'worker', 'entry.js')}`,
      '--dev-mocks',
      '--dev-fixtures',
    ]);
    // …and the host's real parser accepts exactly that argv (another project, by path).
    const path = '../../host/flags.js';
    const flags = (await import(/* @vite-ignore */ path)) as {
      parseHostArgs(a: readonly string[]): {
        userData: string;
        workerEntry: string;
        flags: Record<string, unknown>;
      };
    };
    expect(flags.parseHostArgs(fx.forks[0]?.args ?? [])).toEqual({
      userData: '/tmp/e2e-ud',
      workerEntry: join(distDir, 'worker', 'entry.js'),
      flags: { devMocks: true, devFixtures: true },
    });
  });

  it('hardens every webContents created', async () => {
    await boot();
    let denied: unknown;
    const prevented: string[] = [];
    const wc = {
      id: 9,
      setWindowOpenHandler: (h: (d: unknown) => unknown) => {
        denied = h({});
      },
      on: (event: string, l: (e: { preventDefault(): void }) => void) => {
        if (event.startsWith('will-')) l({ preventDefault: () => prevented.push(event) });
      },
      once: () => undefined,
    };
    for (const l of fx.appListeners.get('web-contents-created') ?? []) l({}, wc);
    expect(denied).toEqual({ action: 'deny' });
    expect(prevented.sort()).toEqual([
      'will-attach-webview',
      'will-frame-navigate',
      'will-navigate',
      'will-redirect',
    ]);
  });

  // Security review F25.
  it('a link clicked in the app window asks in the prompt window; main opens it only on "Open in browser"', async () => {
    await boot();
    const child = fx.children[0];
    const handlers = new Map<number, (d: unknown) => unknown>();
    const created = (id: number): void => {
      const wc = {
        id,
        setWindowOpenHandler: (h: (d: unknown) => unknown) => {
          handlers.set(id, h);
        },
        on: () => undefined,
        once: () => undefined,
      };
      for (const l of fx.appListeners.get('web-contents-created') ?? []) l({}, wc);
    };
    created(1); // the app window's webContents
    created(9); // anything else
    expect(handlers.get(9)?.({ url: 'https://example.com/elsewhere' })).toEqual({
      action: 'deny',
    });
    expect(handlers.get(1)?.({ url: 'http://example.com/plain' })).toEqual({ action: 'deny' });
    expect(fx.windows).toHaveLength(1); // neither asked anything
    expect(handlers.get(1)?.({ url: 'https://example.com/watch?v=1' })).toEqual({
      action: 'deny',
    });
    expect(fx.windows).toHaveLength(2);
    expect(fx.windows[1]?.url).toBe('app://prompt/prompt.html');
    const init = fx.ipc.get('nf-prompt:init');
    const answer = fx.ipc.get('nf-prompt:answer');
    const ev = {
      sender: { id: 2 },
      senderFrame: { url: 'app://prompt/prompt.html', parent: null },
    };
    expect(await init?.(ev, undefined)).toEqual({
      kind: 'open-link',
      url: 'https://example.com/watch?v=1',
    });
    expect(fx.opened).toEqual([]);
    expect(await answer?.(ev, { kind: 'open-link', open: true })).toBe(true);
    expect(fx.opened).toEqual(['https://example.com/watch?v=1']);
    // The host never saw any of it.
    expect(child?.posted.some((m) => (m as { kind?: string }).kind === 'prompt-answer')).toBe(
      false,
    );
  });

  // Security review F22.
  it('a second instance on the same userData quits without a window, a host or IPC handlers', async () => {
    fx.primary = false;
    await boot(['--user-data-dir=/tmp/nf-one']);
    expect(fx.order).toContain('quit');
    expect(fx.order).not.toContain('ready');
    expect(fx.windows).toHaveLength(0);
    expect(fx.forks).toHaveLength(0);
    expect(fx.ipc.size).toBe(0);
  });

  // Security review F8: the money gate is a native dialog in main, not a stub.
  it('a nutzap from the window asks with a native dialog: Cancel is forbidden and never reaches the host, confirm relays', async () => {
    await boot();
    const call = fx.ipc.get('nf:call');
    const child = fx.children[0];
    const event = {
      sender: { id: 1, isDestroyed: () => false, send: () => undefined },
      senderFrame: { url: 'app://nutflix/index.html', parent: null },
    };
    const nutzap = (id: number): unknown => ({
      v: 1,
      id,
      method: 'nutzap',
      args: [mocks.VIDEOS[0]!.id, 21, mocks.MINTS.a],
    });
    fx.dialogAnswer = 0; // Cancel
    await expect(call?.(event, nutzap(1))).resolves.toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(fx.dialogs).toHaveLength(1);
    expect(fx.dialogs[0]).toMatchObject({
      type: 'question',
      buttons: ['Cancel', 'Send 21 sats'],
      defaultId: 0,
      cancelId: 0,
      message: 'Send 21 sats to the creator of this video?',
    });
    expect(child?.posted.filter((m) => (m as { kind?: string }).kind === 'call')).toHaveLength(0);
    fx.dialogAnswer = 1; // confirm
    void call?.(event, nutzap(2));
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });
    expect(child?.posted.filter((m) => (m as { kind?: string }).kind === 'call')).toHaveLength(1);
  });

  it('a renderer call from the window reaches the host; a host media-link feeds nf-media', async () => {
    await boot();
    const call = fx.ipc.get('nf:call');
    const child = fx.children[0];
    expect(call).toBeDefined();
    const pending = call?.(
      {
        sender: { id: 1, isDestroyed: () => false, send: () => undefined },
        senderFrame: { url: 'app://nutflix/index.html', parent: null },
      },
      { v: 1, id: 1, method: 'video', args: [mocks.VIDEOS[0]!.id] },
    );
    await Promise.resolve();
    expect(child?.posted).toEqual([
      { kind: 'call', wc: 1, msg: { v: 1, id: 1, method: 'video', args: [mocks.VIDEOS[0]!.id] } },
    ]);
    const onMessage = child?.listeners.get('message')?.[0];
    onMessage?.({ kind: 'reply', wc: 1, msg: { v: 1, id: 1, ok: true, result: null } });
    await expect(pending).resolves.toEqual({ v: 1, id: 1, ok: true, result: null });

    onMessage?.({
      kind: 'media-link',
      token: 'tok0123456789abcdef',
      url: 'http://127.0.0.1:41000/x',
    });
    const media = fx.protocols.get('nf-media');
    const res = await media?.(
      new Request('nf-media://play/tok0123456789abcdef', { headers: { range: 'bytes=0-2' } }),
    );
    expect(res?.status).toBe(206);
    expect(fx.fetches).toEqual([
      {
        url: 'http://127.0.0.1:41000/x',
        init: {
          method: 'GET',
          headers: { range: 'bytes=0-2' },
          redirect: 'error',
          // A request the player drops aborts its upstream fetch (media.ts, proxy-abort e2e).
          signal: expect.any(AbortSignal) as AbortSignal,
        },
      },
    ]);
  });

  it('--e2e-hooks: nf-media status counts and 206 Range starts, numbers only; absent without the flag', async () => {
    const E2E_KEY = Symbol.for('nutflix.e2e');
    const g = globalThis as Record<symbol, unknown>;
    Reflect.deleteProperty(g, E2E_KEY);
    await boot();
    expect(g[E2E_KEY]).toBeUndefined();

    vi.resetModules();
    await boot(['--e2e-hooks']);
    const hooks = g[E2E_KEY] as {
      mediaStatuses(): Record<number, number>;
      mediaRangeStarts(): number[];
      mediaLinks(): number;
    };
    expect(hooks).toBeDefined();
    const child = fx.children.at(-1);
    child?.listeners.get('message')?.[0]?.({
      kind: 'media-link',
      token: 'tok0123456789abcdef',
      url: 'http://127.0.0.1:41000/x',
    });
    const media = fx.protocols.get('nf-media');
    for (const range of ['bytes=0-', 'bytes=1048576-']) {
      const res = await media?.(
        new Request('nf-media://play/tok0123456789abcdef', { headers: { range } }),
      );
      expect(res?.status).toBe(206);
    }
    expect((await media?.(new Request('nf-media://play/unknown-token-0000')))?.status).toBe(404);
    expect(hooks.mediaStatuses()).toEqual({ 206: 2, 404: 1 });
    expect(hooks.mediaRangeStarts()).toEqual([0, 1_048_576]);
    expect(hooks.mediaLinks()).toBe(1);
    Reflect.deleteProperty(g, E2E_KEY);
  });

  it('drops host messages that fail isHostOut (a non-loopback media link never registers)', async () => {
    await boot();
    const onMessage = fx.children[0]?.listeners.get('message')?.[0];
    onMessage?.({
      kind: 'media-link',
      token: 'tok0123456789abcdef',
      url: 'http://evil.example:80/x',
    });
    const res = await fx.protocols.get('nf-media')?.(
      new Request('nf-media://play/tok0123456789abcdef'),
    );
    expect(res?.status).toBe(404);
    expect(fx.fetches).toHaveLength(0);
  });

  it('a host crash fails calls in flight (backend-down), respawns and reloads the window', async () => {
    await boot();
    const call = fx.ipc.get('nf:call');
    const pending = call?.(
      {
        sender: { id: 1, isDestroyed: () => false, send: () => undefined },
        senderFrame: { url: 'app://nutflix/index.html', parent: null },
      },
      { v: 1, id: 2, method: 'me', args: [] },
    );
    await Promise.resolve();
    for (const l of fx.children[0]?.listeners.get('exit') ?? []) l(1);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'backend-down' } });
    expect(fx.forks).toHaveLength(2);
    expect(fx.order).toContain('reload');
  });

  // Fix round 4 (cross-lane review, HIGH): a quit lets the host pay the open play sessions'
  // tails, so main holds the quit (Electron passes an event; this test used to pass none) until
  // the host exits — bounded — then quits for real. The kill and the no-respawn still hold.
  it('before-quit kills the host and it is not respawned; the quit waits for the host to exit', async () => {
    await boot();
    let prevented = 0;
    const ev = {
      preventDefault: () => {
        prevented++;
      },
    };
    for (const l of fx.appListeners.get('before-quit') ?? []) l(ev);
    expect(fx.children[0]?.killed).toBe(true);
    expect(prevented).toBe(1);
    expect(fx.order).not.toContain('quit');
    for (const l of fx.children[0]?.listeners.get('exit') ?? []) l(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.order).toContain('quit'); // the host is gone: quit for real
    expect(fx.forks).toHaveLength(1);
    // That second quit is not held again.
    for (const l of fx.appListeners.get('before-quit') ?? []) l(ev);
    expect(prevented).toBe(1);
  });

  it('ADR 0013: --keychain is forwarded only for a real keychain (never basic_text)', async () => {
    fx.keychain = true;
    await boot();
    expect(fx.forks[0]?.args).toContain('--keychain');
    vi.resetModules();
    fx.forks.length = 0;
    fx.keychainBackend = 'basic_text';
    await boot();
    expect(fx.forks[0]?.args).not.toContain('--keychain');
  });

  it('ADR 0013: a host prompt opens the prompt window; only that window may read it or answer', async () => {
    await boot();
    const child = fx.children[0];
    const deliver = (m: unknown): void => {
      for (const l of child?.listeners.get('message') ?? []) l(m);
    };
    deliver({ kind: 'prompt', req: 5, form: { kind: 'unlock-passphrase', retry: false } });
    expect(fx.windows).toHaveLength(2);
    const pw = fx.windows[1];
    expect(pw?.url).toBe('app://prompt/prompt.html');
    expect(pw?.options['modal']).toBe(true);
    const wp = pw?.options['webPreferences'] as Record<string, unknown>;
    expect(String(wp['preload'])).toMatch(/[\\/]prompt-preload\.cjs$/);
    expect(wp).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false });
    const init = fx.ipc.get('nf-prompt:init');
    const answer = fx.ipc.get('nf-prompt:answer');
    const ev = (id: number, url = 'app://prompt/prompt.html', parent: unknown = null): unknown => ({
      sender: { id },
      senderFrame: { url, parent },
    });
    // The app window (webContents 1), a subframe, the wrong origin: nothing.
    expect(await init?.(ev(1, 'app://nutflix/index.html'), undefined)).toBeNull();
    expect(await init?.(ev(2, 'app://prompt/prompt.html', {}), undefined)).toBeNull();
    expect(await init?.(ev(2, 'app://nutflix/index.html'), undefined)).toBeNull();
    expect(await answer?.(ev(1, 'app://nutflix/index.html'), { kind: 'secret', value: 'x' })).toBe(
      false,
    );
    expect(await init?.(ev(2), undefined)).toEqual({ kind: 'unlock-passphrase', retry: false });
    expect(await answer?.(ev(2), { kind: 'secret', value: 'the passphrase' })).toBe(true);
    const posted = child?.posted.find((m) => (m as { kind?: string }).kind === 'prompt-answer') as
      { req: number; answer: { kind: string; value: Uint8Array } } | undefined;
    expect(posted?.req).toBe(5);
    expect(new TextDecoder().decode(posted?.answer.value)).toBe('the passphrase');
    expect((pw as { closed?: boolean }).closed).toBe(true);
    // A host cancel for a question that is gone changes nothing; a new one opens a new window.
    deliver({ kind: 'prompt-cancel', req: 5 });
    deliver({ kind: 'prompt', req: 6, form: { kind: 'create-wallet' } });
    expect(fx.windows).toHaveLength(3);
    deliver({ kind: 'prompt-cancel', req: 6 });
    expect((fx.windows[2] as { closed?: boolean }).closed).toBe(true);
    expect(
      child?.posted.filter((m) => (m as { kind?: string }).kind === 'prompt-answer'),
    ).toHaveLength(1);
  });

  it('ADR 0013: keychain requests are answered through safeStorage, in a private userData dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nf-main-kc-'));
    try {
      fx.keychain = true;
      await boot(['--user-data-dir', dir]);
      const child = fx.children[0];
      const deliver = (m: unknown): void => {
        for (const l of child?.listeners.get('message') ?? []) l(m);
      };
      const results = (): { req: number; ok: boolean; value: Uint8Array | null }[] =>
        (child?.posted ?? []).filter(
          (m) => (m as { kind?: string }).kind === 'keychain-result',
        ) as { req: number; ok: boolean; value: Uint8Array | null }[];
      deliver({
        kind: 'keychain',
        req: 1,
        op: 'put',
        slot: 'passphrase',
        value: new TextEncoder().encode('sealed pass'),
      });
      await vi.waitFor(() => {
        expect(results()).toHaveLength(1);
      });
      expect(results()[0]).toEqual({ kind: 'keychain-result', req: 1, ok: true, value: null });
      const onDisk = await readFile(join(dir, 'keychain', 'passphrase.sealed'), 'utf8');
      expect(onDisk.startsWith('sealed:')).toBe(true); // what the fake safeStorage wrote
      deliver({ kind: 'keychain', req: 2, op: 'get', slot: 'passphrase' });
      await vi.waitFor(() => {
        expect(results()).toHaveLength(2);
      });
      expect(new TextDecoder().decode(results()[1]?.value ?? new Uint8Array())).toBe('sealed pass');
      deliver({ kind: 'keychain', req: 3, op: 'forget', slot: 'passphrase' });
      await vi.waitFor(() => {
        expect(results()).toHaveLength(3);
      });
      expect(results()[2]?.ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ADR 0013 addendum: a NIP-46 approval link opens in the browser only on the prompt window's click", async () => {
    await boot();
    const child = fx.children[0];
    const deliver = (m: unknown): void => {
      for (const l of child?.listeners.get('message') ?? []) l(m);
    };
    const url = 'https://auth.bunker.example/approve?s=1';
    deliver({ kind: 'prompt', req: 9, form: { kind: 'bunker-auth', url } });
    const answer = fx.ipc.get('nf-prompt:answer');
    const ev = (id: number, frameUrl: string): unknown => ({
      sender: { id },
      senderFrame: { url: frameUrl, parent: null },
    });
    // The app window cannot answer (or open) it.
    expect(
      await answer?.(ev(1, 'app://nutflix/index.html'), { kind: 'bunker-auth', open: true }),
    ).toBe(false);
    expect(fx.opened).toEqual([]);
    expect(
      await answer?.(ev(2, 'app://prompt/prompt.html'), { kind: 'bunker-auth', open: true }),
    ).toBe(true);
    expect(fx.opened).toEqual([url]);
    // A host message with a non-https link never even reaches the window (isHostOut).
    deliver({ kind: 'prompt', req: 10, form: { kind: 'bunker-auth', url: 'http://x.example/' } });
    expect(fx.windows).toHaveLength(2);
  });

  it('ADR 0016: a phrase question gets content protection before the page can read it; a typed phrase is checksum-checked by main', async () => {
    await boot();
    const child = fx.children[0];
    const deliver = (m: unknown): void => {
      for (const l of child?.listeners.get('message') ?? []) l(m);
    };
    // BIP-39's 0x7f × 16 vector as indices ("legal winner thank year wave sausage worth useful …").
    const words = [1019, 2015, 1790, 2039, 1983, 1533, 2031, 1919, 1019, 2015, 1790, 2040];
    // (A copy: main zeroes ITS copy of the indices once the window is gone.)
    deliver({
      kind: 'prompt',
      req: 21,
      form: { kind: 'recovery-show', words: [...words], again: false },
    });
    const pw = fx.windows[1] as { url?: string; protection?: boolean[] } | undefined;
    expect(pw?.protection).toEqual([true]);
    const init = fx.ipc.get('nf-prompt:init');
    const answer = fx.ipc.get('nf-prompt:answer');
    const ev = (id: number): unknown => ({
      sender: { id },
      senderFrame: { url: 'app://prompt/prompt.html', parent: null },
    });
    expect(await init?.(ev(2), undefined)).toEqual({ kind: 'recovery-show', words, again: false });
    expect(await answer?.(ev(2), { kind: 'recovery-show', done: true })).toBe(true);
    // A restore: a phrase whose checksum main's own re-check refuses is a cancel (null).
    deliver({ kind: 'prompt', req: 22, form: { kind: 'recovery-restore' } });
    expect((fx.windows[2] as { protection?: boolean[] }).protection).toEqual([true]);
    const bad = [...words.slice(0, 11), 0];
    expect(await answer?.(ev(3), { kind: 'recovery-restore', words: bad })).toBe(true);
    deliver({ kind: 'prompt', req: 23, form: { kind: 'recovery-restore' } });
    expect(await answer?.(ev(4), { kind: 'recovery-restore', words: [...words] })).toBe(true);
    const answers = child?.posted.filter(
      (m) => (m as { kind?: string }).kind === 'prompt-answer',
    ) as { req: number; answer: unknown }[];
    expect(answers.map((a) => [a.req, a.answer])).toEqual([
      [21, { kind: 'recovery-show', done: true }],
      [22, null],
      [23, { kind: 'recovery-restore', words }],
    ]);
  });

  it('ADR 0016: a host confirm is a native dialog built by main (Cancel the default); only the confirm button answers yes', async () => {
    await boot();
    const child = fx.children[0];
    const deliver = (m: unknown): void => {
      for (const l of child?.listeners.get('message') ?? []) l(m);
    };
    const form = {
      kind: 'recovery-reissue',
      plans: [{ mint: 'https://mint.example/cashu/api', amount: 1_000, inputs: 3, feeSats: 2 }],
    };
    fx.dialogAnswer = 0; // Cancel
    deliver({ kind: 'confirm', req: 31, form });
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });
    expect(fx.dialogs[0]).toMatchObject({
      type: 'question',
      buttons: ['Cancel', 'Move it (fee 2 sats)'],
      defaultId: 0,
      cancelId: 0,
      message: 'Move 1,000 sats under your recovery phrase? The mints charge 2 sats in fees.',
    });
    expect(JSON.stringify(fx.dialogs[0])).not.toMatch(/cashu\/api/);
    fx.dialogAnswer = 1; // confirm
    deliver({ kind: 'confirm', req: 32, form: { kind: 'recovery-reveal' } });
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });
    // A malformed question never reaches a dialog (isHostOut).
    deliver({ kind: 'confirm', req: 33, form: { kind: 'recovery-reissue', plans: [] } });
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });
    expect(fx.dialogs).toHaveLength(2);
    expect(child?.posted.filter((m) => (m as { kind?: string }).kind === 'confirm-result')).toEqual(
      [
        { kind: 'confirm-result', req: 31, ok: false },
        { kind: 'confirm-result', req: 32, ok: true },
      ],
    );
  });

  // Round 8 (final panel, packaging): the host's confirm deadline passed and main's dialog
  // stayed on screen — a later "Move it" moved nothing, and every other host confirm was
  // refused while it was up. `confirm-cancel` (and a host that went away) now closes it.
  it('ADR 0016: confirm-cancel closes the open dialog, sends no answer, and the next confirm gets a dialog', async () => {
    await boot();
    const child = fx.children[0];
    const deliver = (m: unknown): void => {
      for (const l of child?.listeners.get('message') ?? []) l(m);
    };
    const tick = (): Promise<void> =>
      new Promise<void>((r) => {
        setTimeout(r, 0);
      });
    const results = (): unknown[] =>
      child?.posted.filter((m) => (m as { kind?: string }).kind === 'confirm-result') ?? [];
    fx.dialogHold = true;
    deliver({ kind: 'confirm', req: 41, form: { kind: 'recovery-reveal' } });
    await tick();
    const first = fx.dialogs[0] as { signal?: AbortSignal } | undefined;
    expect(first?.signal).toBeInstanceOf(AbortSignal);
    expect(first?.signal?.aborted).toBe(false);
    // A cancel for another request, or a malformed one, closes nothing.
    deliver({ kind: 'confirm-cancel', req: 40 });
    deliver({ kind: 'confirm-cancel', req: 41, ok: false });
    await tick();
    expect(first?.signal?.aborted).toBe(false);
    deliver({ kind: 'confirm-cancel', req: 41 });
    expect(first?.signal?.aborted).toBe(true);
    await tick();
    expect(results()).toEqual([]);
    // Not refused as busy: the next confirm opens its own dialog and is answered.
    fx.dialogHold = false;
    fx.dialogAnswer = 1;
    deliver({ kind: 'confirm', req: 42, form: { kind: 'recovery-rotate' } });
    await tick();
    expect(fx.dialogs).toHaveLength(2);
    expect(results()).toEqual([{ kind: 'confirm-result', req: 42, ok: true }]);
    // A host that goes away takes its open dialog with it.
    fx.dialogHold = true;
    deliver({ kind: 'confirm', req: 43, form: { kind: 'recovery-reveal' } });
    await tick();
    const third = fx.dialogs[2] as { signal?: AbortSignal } | undefined;
    expect(third?.signal?.aborted).toBe(false);
    for (const l of child?.listeners.get('exit') ?? []) l(1);
    expect(third?.signal?.aborted).toBe(true);
    await tick();
    expect(results()).toEqual([{ kind: 'confirm-result', req: 42, ok: true }]);
  });
});
