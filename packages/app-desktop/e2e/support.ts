/**
 * Shared plumbing for the Electron end-to-end suites (never run by `npm test`; see
 * docs/development.md "Running the Electron end-to-end suites"). Runs under plain Node 24 with type
 * stripping: only erasable TypeScript, relative imports with `.ts` extensions.
 *
 * Nothing here weakens the sandbox (D4): `sandboxReady()` only REPORTS whether Chromium's
 * sandbox can start on this machine, and the suites stop with Cameron's fix if it cannot;
 * `launch()` passes `chromiumSandbox: true` (playwright-core otherwise ADDS `--no-sandbox` on
 * Linux) and refuses to hand back an app whose renderer is not actually sandboxed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';

export const E2E = process.env['NUTFLIX_E2E'] === '1';
export const PKG = dirname(dirname(fileURLToPath(import.meta.url)));

/** Holds main's `ready` until Playwright has attached (see the file: a launch race). */
const HOLD_READY = join(PKG, 'e2e', 'hold-ready.cjs');

/** The Electron binary `node node_modules/electron/install.js` extracted. */
export function electronBinary(): string {
  const req = createRequire(import.meta.url);
  const p = req('electron') as unknown;
  if (typeof p !== 'string' || !existsSync(p)) {
    throw new Error(
      'Electron binary missing: run `node node_modules/electron/install.js` (uses the cached zip)',
    );
  }
  return p;
}

/**
 * Whether Chromium's sandbox can start here (D4). One of:
 *   - `chrome-sandbox` next to the binary is root-owned and mode 4755 (SUID sandbox), or
 *   - unprivileged user namespaces are allowed (`kernel.apparmor_restrict_unprivileged_userns`
 *     is 0 or absent), or
 *   - Cameron installed an AppArmor profile granting `userns` to this binary and says so with
 *     `NUTFLIX_E2E_APPARMOR_PROFILE=1` (a profile cannot be detected without root).
 * Never `--no-sandbox`.
 */
export function sandboxReady(binary: string): { ok: boolean; why: string } {
  const helper = join(dirname(binary), 'chrome-sandbox');
  try {
    const st = statSync(helper);
    if (st.uid === 0 && (st.mode & 0o4755) === 0o4755)
      return { ok: true, why: 'SUID chrome-sandbox' };
  } catch {
    // no helper: fall through
  }
  let restricted: string;
  try {
    restricted = readFileSync(
      '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
      'utf8',
    ).trim();
  } catch {
    restricted = '0';
  }
  if (restricted === '0') return { ok: true, why: 'unprivileged user namespaces allowed' };
  if (process.env['NUTFLIX_E2E_APPARMOR_PROFILE'] === '1')
    return { ok: true, why: 'AppArmor userns profile (declared)' };
  return {
    ok: false,
    why:
      `Chromium's sandbox cannot start (D4): ${helper} is not root-owned 4755 and ` +
      'kernel.apparmor_restrict_unprivileged_userns=1. Cameron: either\n' +
      `  sudo chown root:root ${helper} && sudo chmod 4755 ${helper}\n` +
      'or install an AppArmor profile allowing `userns` for that electron binary, then rerun with ' +
      'NUTFLIX_E2E_APPARMOR_PROFILE=1. Never --no-sandbox.',
  };
}

export function hasFfmpeg(): boolean {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

/** Fixture shape: long and big enough to span many blocks and still play at the end. */
export interface FixtureShape {
  /** Duration, seconds. */
  readonly seconds: number;
  /** Constant video bitrate, kbit/s. */
  readonly kbps: number;
}

/**
 * The e2e fixture (design §5b said 6 s; E2E-fix failure 4): a 6 s lavfi clip is 39 977 bytes —
 * ONE 64 KiB block — so a seek never needs a second Range, there is barely a streaming rate,
 * and the video has ended before the later steps run. So: 90 s at a forced 2 Mbit/s (CBR x264,
 * `nal-hrd=cbr` pads with filler), ≈ 22.5 MB = ≈ 343 blocks; a keyframe every 2 s so seeks
 * land where asked; `+faststart` so `moov` comes first. `ultrafast` keeps it to ~2–3 s.
 */
export const FIXTURE: FixtureShape = { seconds: 90, kbps: 2000 };

/** An H.264 + faststart MP4 from lavfi `source`, `shape` long at a constant bitrate. */
export function makeFixtureMp4(
  out: string,
  source: 'testsrc' | 'testsrc2',
  shape: FixtureShape = FIXTURE,
): void {
  const rate = `${String(shape.kbps)}k`;
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `${source}=size=640x360:rate=25`,
      '-t',
      String(shape.seconds),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '50',
      '-b:v',
      rate,
      '-minrate',
      rate,
      '-maxrate',
      rate,
      '-bufsize',
      rate,
      '-x264-params',
      'nal-hrd=cbr',
      '-movflags',
      '+faststart',
      '-y',
      out,
    ],
    { stdio: 'inherit', timeout: 120_000 },
  );
  const size = statSync(out).size;
  const expected = (shape.seconds * shape.kbps * 1000) / 8;
  if (size < 0.8 * expected) {
    throw new Error(
      `fixture ${out} is ${String(size)} bytes, expected ≈ ${String(expected)} (CBR not honoured?)`,
    );
  }
}

export interface DisplayStrategy {
  readonly name: string;
  /** Chromium switches (before the app's own arguments). */
  readonly switches: readonly string[];
  /** Environment for the Electron process. */
  readonly env: Readonly<Record<string, string>>;
}

/** GNOME's Xwayland when this shell has no `DISPLAY`: its socket and mutter's auth FILE. */
export function discoverXwayland(): { display: string; xauthority: string } | undefined {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  const runtime = process.env['XDG_RUNTIME_DIR'] ?? `/run/user/${String(uid)}`;
  let auth: string | undefined;
  let sockets: number[];
  try {
    // The PATH is handed to Xlib as XAUTHORITY; the cookie inside is never read here.
    auth = readdirSync(runtime)
      .filter((n) => n.startsWith('.mutter-Xwaylandauth.'))
      .sort()[0];
    sockets = readdirSync('/tmp/.X11-unix')
      .map((n) => /^X(\d+)$/.exec(n))
      .filter((m): m is RegExpExecArray => m !== null)
      .filter((m) => statSync(join('/tmp/.X11-unix', m[0])).uid === uid)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  } catch {
    return undefined;
  }
  const n = sockets[0];
  if (auth === undefined || n === undefined) return undefined;
  return { display: `:${String(n)}`, xauthority: join(runtime, auth) };
}

/**
 * How the window gets a display. Measured with Electron 44.2.0 on the dev laptop (2026-09-23,
 * docs/archive/lanes/E2E-fix.md):
 *   - X11 WORKS — `DISPLAY` if set, else GNOME's Xwayland (`/tmp/.X11-unix/X<n>` + mutter's
 *     auth file). That X screen has no monitor (0×0), so the window is clamped to its minimum
 *     size; the suites resize it to 1280×800 (`launch`). Nothing is visible to the user.
 *   - `--ozone-platform=headless` SEGFAULTS the main process at `new BrowserWindow` (a null
 *     function call; reproduced with a 10-line app, sandbox on or off, with or without
 *     `--use-angle=swiftshader` / `--disable-gpu`). Opt-in only: `NUTFLIX_E2E_DISPLAY=headless`.
 *   - `--ozone-platform=wayland` hangs before `ready`. Opt-in only: `NUTFLIX_E2E_DISPLAY=wayland`.
 */
export function displayStrategies(): DisplayStrategy[] {
  const want = process.env['NUTFLIX_E2E_DISPLAY'] ?? 'x11';
  if (want === 'headless')
    return [{ name: 'ozone-headless', switches: ['--ozone-platform=headless'], env: {} }];
  if (want === 'wayland') {
    const w = process.env['WAYLAND_DISPLAY'];
    return w === undefined
      ? []
      : [{ name: 'wayland', switches: ['--ozone-platform=wayland'], env: { WAYLAND_DISPLAY: w } }];
  }
  if (want !== 'x11') throw new Error(`NUTFLIX_E2E_DISPLAY=${want}: x11 | headless | wayland`);
  const display = process.env['DISPLAY'];
  if (display !== undefined && display !== '')
    return [{ name: `x11 (DISPLAY=${display})`, switches: ['--ozone-platform=x11'], env: {} }];
  const xw = discoverXwayland();
  return xw === undefined
    ? []
    : [
        {
          name: `x11 (GNOME Xwayland ${xw.display})`,
          switches: ['--ozone-platform=x11'],
          env: { DISPLAY: xw.display, XAUTHORITY: xw.xauthority },
        },
      ];
}

/** Every switch that turns a Chromium sandbox layer off (main refuses the first three). */
const SANDBOX_BYPASS = [
  'no-sandbox',
  'disable-gpu-sandbox',
  'no-zygote',
  'disable-setuid-sandbox',
  'disable-namespace-sandbox',
  'disable-seccomp-filter-sandbox',
] as const;

export interface SandboxReport {
  /** Sandbox-bypass switches main sees (`app.commandLine` or argv). Must be empty. */
  readonly bypassSwitches: string[];
  /** Linux: the window's renderer runs under a seccomp-bpf filter (`Seccomp: 2`). */
  readonly rendererSeccompFilter: boolean | null;
  /** Linux: the renderer lives in its own PID namespace (`NSpid` has ≥ 2 entries). */
  readonly rendererPidNamespace: boolean | null;
}

/**
 * The launch precondition (D4, E2E-fix failure 1): playwright-core's `_electron.launch`
 * PREPENDS `--no-sandbox` on Linux unless `chromiumSandbox: true` is passed, which made the
 * fidelity run report `noSandboxSwitch: true`. So after every launch, check both ways: main
 * sees no bypass switch, and (Linux) the renderer really is sandboxed — a seccomp-bpf filter
 * and its own PID namespace, read from `/proc/<pid>/status` (world-readable; nothing else).
 */
export async function sandboxPosture(app: ElectronApplication): Promise<SandboxReport> {
  const seen = await app.evaluate(
    ({ app: a, BrowserWindow }, names) => {
      const bypass = names.filter(
        (n) =>
          a.commandLine.hasSwitch(n) ||
          process.argv.some((x) => x === `--${n}` || x.startsWith(`--${n}=`)),
      );
      const pid = BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId() ?? 0;
      return { bypass, pid };
    },
    SANDBOX_BYPASS as unknown as string[],
  );
  let seccomp: boolean | null = null;
  let pidns: boolean | null = null;
  if (process.platform === 'linux' && seen.pid > 0) {
    const status = readFileSync(`/proc/${String(seen.pid)}/status`, 'utf8');
    seccomp = /^Seccomp:\s*2$/m.test(status);
    const nspid = /^NSpid:\s*(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/) ?? [];
    pidns = nspid.length >= 2;
  }
  return {
    bypassSwitches: seen.bypass,
    rendererSeccompFilter: seccomp,
    rendererPidNamespace: pidns,
  };
}

export function assertSandboxed(r: SandboxReport): void {
  const problems: string[] = [];
  if (r.bypassSwitches.length > 0)
    problems.push(`sandbox-bypass switches present: ${r.bypassSwitches.join(', ')}`);
  if (r.rendererSeccompFilter === false) problems.push('the renderer has no seccomp-bpf filter');
  if (r.rendererPidNamespace === false) problems.push('the renderer shares the PID namespace');
  if (process.platform === 'linux' && r.rendererSeccompFilter === null)
    problems.push('could not find the renderer process to check');
  if (problems.length > 0)
    throw new Error(
      `the Chromium sandbox is NOT on (D4) — refusing to test: ${problems.join('; ')}`,
    );
}

/**
 * `NUTFLIX_E2E_LOG=<file>`: append the Electron process's stdout/stderr there (main, host and
 * worker log lines — already redacted by their loggers) for triage. Off by default.
 */
function teeLogs(app: ElectronApplication): void {
  const file = process.env['NUTFLIX_E2E_LOG'];
  if (file === undefined || file === '') return;
  const p = app.process();
  for (const stream of [p.stdout, p.stderr]) {
    stream?.on('data', (chunk: Buffer) => {
      appendFileSync(file, chunk);
    });
  }
}

/** The most of a launch's call log a failure keeps (its last lines: the hang is at the end). */
const CALL_LOG_LINES = 60;

/**
 * A launch failure, readable in a CI log: the error's first line, plus the tail of Playwright's
 * "Call log". That log holds Electron's own stdout/stderr (`[pid=…][err] …`, main's lines
 * already redacted by its logger): what says WHY a launch failed. It is how the intermittent 30 s
 * `electron.launch` timeout was traced to an attach race (fixed by `hold-ready.cjs`).
 */
export function launchFailure(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const [first = '', ...rest] = e.message.split('\n');
  // eslint-disable-next-line no-control-regex -- Playwright dims the call log with ANSI codes
  const log = rest.map((l) => l.replace(/\u001b\[[0-9;]*m/g, '')).filter((l) => l.trim() !== '');
  if (log.length === 0) return first;
  const tail = log.slice(-CALL_LOG_LINES);
  const cut = log.length - tail.length;
  return [
    first,
    ...(cut > 0 ? [`    … ${String(cut)} earlier lines`] : []),
    ...tail.map((l) => `    ${l}`),
  ].join('\n');
}

/**
 * Launches `script` (a main-process entry) with the display strategy until one shows a
 * window, WITH the Chromium sandbox (`chromiumSandbox: true`: never let playwright add
 * `--no-sandbox`), then asserts the sandbox is really on and sizes the window to 1280×800
 * (test-only: the Xwayland screen is 0×0, see `displayStrategies`).
 */
export async function launch(
  script: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ app: ElectronApplication; page: Page; display: string; sandbox: SandboxReport }> {
  const binary = electronBinary();
  const failures: string[] = [];
  const strategies = displayStrategies();
  if (strategies.length === 0)
    throw new Error(
      'no display: set DISPLAY (X11), or run inside a GNOME session (Xwayland is discovered), ' +
        'or opt in with NUTFLIX_E2E_DISPLAY=headless|wayland (both fail with Electron 44.2.0)',
    );
  for (const d of strategies) {
    let app: ElectronApplication | undefined;
    try {
      app = await _electron.launch({
        executablePath: binary,
        args: ['-r', HOLD_READY, ...d.switches, script, ...args],
        env: { ...(process.env as Record<string, string>), ...d.env, ...env },
        chromiumSandbox: true,
        timeout: 30_000,
      });
      teeLogs(app);
      const page = await app.firstWindow({ timeout: 30_000 });
      const sandbox = await sandboxPosture(app);
      assertSandboxed(sandbox);
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setSize(1280, 800);
      });
      return { app, page, display: d.name, sandbox };
    } catch (e: unknown) {
      failures.push(`${d.name}: ${launchFailure(e)}`);
      await app?.close().catch(() => undefined);
    }
  }
  throw new Error(`no display strategy worked:\n  ${failures.join('\n  ')}`);
}

/** The recursive own-key tree of an object as dotted names (for the preload allowlist). */
/** What `checkNerdStats` looks for: the source's row and where its address must point. */
export interface NerdStatsCheck {
  /** The `<video>` to right-click. */
  readonly video: string;
  readonly kind: 'iroh' | 'hypercore';
  /** Whether a row's Address and Path cells are the route this run must show. */
  readonly route: (address: string, path: string) => boolean;
}

/**
 * Stats for nerds (ADR 0024), driven as a viewer drives it: right-click opens it on a connected
 * `kind` row that has received data, with no address; the switch shows the route under a banner;
 * closed with the switch on, it reopens with the switch off; `n` closes it. Errors never quote an
 * address.
 */
export async function checkNerdStats(page: Page, o: NerdStatsCheck): Promise<void> {
  const panel = page.getByTestId('nerd-stats');
  const addressSwitch = panel.getByRole('checkbox', { name: 'Show addresses' });
  const rows = panel.locator(`tr[data-kind="${o.kind}"]:not(.nf-nerd__closed)`);
  const open = async (): Promise<void> => {
    await page.locator(o.video).click({ button: 'right', position: { x: 24, y: 24 } });
    await page.getByRole('menuitem', { name: 'Stats for nerds', exact: true }).click();
    await panel.waitFor({ timeout: 10_000 });
  };
  const cells = (): Promise<string[][]> =>
    rows.evaluateAll((trs) =>
      trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent)),
    );
  const until = async (what: string, test: (row: string[]) => boolean): Promise<void> => {
    const end = Date.now() + 30_000;
    while (!(await cells()).some(test)) {
      if (Date.now() > end) throw new Error(`stats for nerds: no ${o.kind} row with ${what}`);
      await page.waitForTimeout(250);
    }
  };
  const hasRoute = (row: string[]): boolean => o.route(row[6] ?? '', row[7] ?? '');
  const assertNoAddress = async (when: string): Promise<void> => {
    if (
      (await addressSwitch.isChecked()) ||
      (await panel.locator('.nf-nerd__addr').count()) > 0 ||
      (await panel.locator('.nf-nerd__banner').count()) > 0
    )
      throw new Error(`stats for nerds: addresses showing ${when}`);
  };

  await open();
  await until('data received', (row) => Number.parseFloat(row[3] ?? '') > 0);
  await assertNoAddress('when it opened');

  await addressSwitch.check();
  await panel.locator('.nf-nerd__banner').waitFor({ timeout: 5_000 });
  await until('the expected route', hasRoute);

  await addressSwitch.uncheck();
  await panel.locator('.nf-nerd__addr').first().waitFor({ state: 'detached', timeout: 5_000 });
  await assertNoAddress('after the switch went off');

  // On again and closed that way, so that reopening has a switch to reset.
  await addressSwitch.check();
  await until('the expected route again', hasRoute);
  await panel.getByRole('button', { name: 'Close stats' }).click();
  await panel.waitFor({ state: 'detached', timeout: 5_000 });

  await open();
  await assertNoAddress('after reopening');
  await page.keyboard.press('n');
  await panel.waitFor({ state: 'detached', timeout: 5_000 });
}

export const KEY_TREE_SOURCE = `(() => {
  const walk = (o, p) => Object.keys(o).flatMap((k) => {
    const n = p === '' ? k : p + '.' + k;
    const v = o[k];
    return v !== null && typeof v === 'object' ? [n, ...walk(v, n)] : [n];
  });
  return walk(window.nutflix, '').sort();
})()`;
