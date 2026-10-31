/**
 * Electron main — the thin shell (design §1 row "Main"): lifecycle, the one window, security
 * handlers, the `app:` and `nf-media:` protocols, the SE-1 file-token registry, the IPC gate,
 * and supervision of the host `utilityProcess`. This is the only main-process module that
 * imports `electron` at runtime; everything it wires is Electron-free and unit-tested with
 * fakes (Electron cannot launch on the dev box yet, D4).
 *
 * Entry: `dist/main/main.js` (ESM). Layout it expects next to it (see scripts/bundle.ts):
 *   dist/preload.cjs          the bundled sandboxed preload
 *   dist/renderer/            index.html, app.js, ui.css, shell.css (served by `app:`)
 *   dist/host/main.js         the host utilityProcess entry (lane L6-B)
 *   dist/worker/entry.js      the Bare worker entry the host spawns (lane L6-C; tsc output)
 * A packaged build (issue #6, ADR 0017) has the same layout inside `resources/app.asar`, except
 * the worker: it is unpacked beside the archive (`workerEntryFor`, packaging/stage.ts).
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  net,
  protocol,
  safeStorage,
  session,
  shell,
  utilityProcess,
  webContents as allWebContents,
  type MessageBoxOptions,
  type WebContents,
} from 'electron';
import { appArchive } from '../ipc/asar-path.js';
import { isPromptForm } from '../ipc/guards.js';
import type { HostIn, HostOut, PromptAnswer } from '../ipc/protocol.js';
import { CHANNEL } from '../ipc/protocol.js';
import { phraseChecksumOk } from '../ipc/recovery-checksum.js';
import { PROMPT_FILES, createAppProtocolHandler } from './app-protocol.js';
import { HOST_ENTRY, devFlagIn, hostArgs, parseMainArgs, workerEntryFor } from './args.js';
import { FileTokenRegistry } from './file-tokens.js';
import { HostConfirms } from './host-confirm.js';
import { HostLink } from './host-link.js';
import { IpcGate } from './ipc-gate.js';
import { createLogger } from './log.js';
import { ImageRequests, MediaLinks, createMediaProtocolHandler, netMediaFetch } from './media.js';
import { KeychainStore, keychainUsable } from './keychain.js';
import { createMoneyGate, type ConfirmPrompt } from './money-gate.js';
import { PROMPT_CHANNEL, PromptService, type PromptSender } from './prompt.js';
import {
  APP_URL,
  MEDIA_SCHEME,
  APP_SCHEME,
  PROMPT_HOST,
  PROMPT_URL,
  privilegedSchemes,
} from './schemes.js';
import { ExternalLinks } from './external-links.js';
import {
  hardenWebContents,
  installSessionPolicy,
  packagedRefusedFeature,
  packagedRefusedSwitch,
  remoteDebuggingSwitch,
  sandboxBypassSwitch,
} from './security.js';
import { SQUIRREL_UPDATE_TIMEOUT_MS, squirrelStartup } from './squirrel.js';
import { createMainWindow, createPromptWindow } from './window.js';

const log = createLogger((line) => {
  process.stderr.write(`${line}\n`);
});
const opts = parseMainArgs(process.argv.slice(1));
const distDir = dirname(dirname(fileURLToPath(import.meta.url)));

// ---- before ready ------------------------------------------------------------------------

// Issue #6 (ADR 0017 §5): Squirrel.Windows launches the installed app for its lifecycle events
// (install, update, uninstall, obsolete) and expects shortcuts made or removed and a quick exit.
// Handled FIRST — packaged win32 only — so such a launch never opens a window or starts the
// host or the worker. Update.exe runs with a fixed argv, no shell, bounded in time.
const squirrel = squirrelStartup({
  platform: process.platform,
  packaged: app.isPackaged,
  argv: process.argv.slice(1),
  execPath: process.execPath,
  run: (file, args) => {
    execFileSync(file, [...args], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: SQUIRREL_UPDATE_TIMEOUT_MS,
    });
  },
});
if (squirrel.exit) {
  if (squirrel.ok) log('info', 'app.squirrel-event');
  else log('warn', 'app.squirrel-update-failed');
  app.exit(0);
  throw new Error('Squirrel.Windows lifecycle launch handled');
}
// D4: never run without the Chromium sandbox. Refuse, loudly, instead of degrading.
if (sandboxBypassSwitch(app.commandLine) !== undefined) {
  log('error', 'app.sandbox-bypass-refused');
  app.exit(78);
  throw new Error('refusing to run without the Chromium sandbox');
}
// Security review F21: a packaged build is never a dev build — refuse the dev flags outright.
if (app.isPackaged && devFlagIn(process.argv.slice(1)) !== undefined) {
  log('error', 'app.dev-flag-refused');
  app.exit(78);
  throw new Error('dev flags are refused in a packaged build');
}
// Issue #6: nor a debugging target — Chromium's DevTools-protocol switches are refused too (the
// fuses already close Node's --inspect). The dev build keeps them for the e2e harness.
if (app.isPackaged && remoteDebuggingSwitch(app.commandLine) !== undefined) {
  log('error', 'app.debug-switch-refused');
  app.exit(78);
  throw new Error('remote debugging is refused in a packaged build');
}
// Cross-lane review (round 4): nor wrapped — process-wrapper, V8 and isolation switches are
// refused too (security.ts PACKAGED_REFUSED_SWITCHES). The dev build keeps them for debugging.
if (app.isPackaged && packagedRefusedSwitch(app.commandLine) !== undefined) {
  log('error', 'app.process-switch-refused');
  app.exit(78);
  throw new Error('process-wrapper and engine switches are refused in a packaged build');
}
// ADR 0017 open question 11 (Cameron, 2026-10-02): feature lists only from the allow-list
// (security.ts PACKAGED_ALLOWED_FEATURES: the Wayland ones). The dev build keeps them all.
if (
  app.isPackaged &&
  packagedRefusedFeature(app.commandLine, process.argv.slice(1)) !== undefined
) {
  log('error', 'app.feature-switch-refused');
  app.exit(78);
  throw new Error('a Chromium feature outside the allow-list is refused in a packaged build');
}
app.enableSandbox();
if (opts.userDataDir !== undefined) app.setPath('userData', opts.userDataDir);
// One instance per userData (security review F22): two would share the settings file and race
// on the worker's storage. The lock is keyed on userData, so it is taken after setPath. A second
// launch focuses the first window and quits without starting anything.
const primary = app.requestSingleInstanceLock();
if (!primary) {
  log('info', 'app.already-running');
  app.quit();
}
protocol.registerSchemesAsPrivileged(privilegedSchemes());

/** webContents ids that show the app (the gate refuses everything else). */
const appWebContents = new Set<number>();

const tokens = new FileTokenRegistry({
  lstat: (p) => lstat(p),
  now: () => Date.now(),
  randomHex: (n) => randomBytes(n).toString('hex'),
  basename: (p) => basename(p),
});
const links = new MediaLinks(log);
let host: HostLink | undefined;
const post = (msg: Parameters<HostLink['post']>[0]): boolean => host?.post(msg) ?? false;
const images = new ImageRequests(post, 30_000, log);
/** The app window (the prompt window is modal to it). */
let mainWindow: BrowserWindow | undefined;

// ADR 0013: main's trusted prompt window. The page's two calls are accepted only from the open
// prompt window (`PromptService.accept`); the IPC gate refuses that webContents for everything.
const prompts = new PromptService({
  openWindow: () => {
    const parent = mainWindow !== undefined && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const win = createPromptWindow(BrowserWindow, join(distDir, 'prompt-preload.cjs'), parent);
    win.once('ready-to-show', () => {
      win.show();
    });
    win.webContents.on('did-fail-load', () => {
      log('error', 'prompt.load-failed');
      if (!win.isDestroyed()) win.close();
    });
    void win.loadURL(PROMPT_URL);
    return {
      webContentsId: win.webContents.id,
      close: () => {
        if (!win.isDestroyed()) win.close();
      },
      onClosed: (cb) => {
        win.once('closed', cb);
      },
      // ADR 0016: while a recovery phrase is on screen (macOS/Windows; a no-op on Linux).
      setContentProtection: (on) => {
        if (!win.isDestroyed()) win.setContentProtection(on);
      },
    };
  },
  // ADR 0016: a typed recovery phrase's checksum, re-checked here from its indices.
  checksumOk: (words) =>
    phraseChecksumOk(words, (data) => new Uint8Array(createHash('sha256').update(data).digest())),
  openExternal: (url) => {
    void shell.openExternal(url).catch(() => {
      log('warn', 'prompt.open-failed');
    });
  },
  answer: (req, answer) => {
    if (e2ePrompts.has(req)) {
      // --e2e-hooks: a synthetic question (below) — only the answer's shape is kept.
      e2ePrompts.set(req, summarizeAnswer(answer));
      return;
    }
    post({ kind: 'prompt-answer', req, answer });
  },
  log: (level, event) => {
    log(level, event);
  },
});
/** e2e only: how many external links main opened (a count, never a URL). */
let externalOpens = 0;
/** Security review F25: a clicked https link — main asks in the prompt window, then opens. */
const externalLinks = new ExternalLinks({
  ask: (url, done) => prompts.askLink(url, done),
  open: (url) => {
    externalOpens++;
    void shell.openExternal(url).catch(() => {
      log('warn', 'link.open-failed');
    });
  },
  now: () => Date.now(),
  log: (level, event) => {
    log(level, event);
  },
});
/** Bound in `start()` (safeStorage answers only after `ready`). */
let keychain: KeychainStore | undefined;

/**
 * `--e2e-hooks` only: prompt-window questions the e2e suite opened itself (never the host's), by
 * request id (above the host's range), and what came back — kind and byte length, never a value.
 */
const e2ePrompts = new Map<number, { kind: string; bytes: number } | null | 'pending'>();
let e2ePromptSeq = 2_000_000_000;
function summarizeAnswer(a: PromptAnswer | null): { kind: string; bytes: number } | null {
  if (a === null) return null;
  if (a.kind === 'secret') return { kind: a.kind, bytes: a.value.byteLength };
  if (a.kind === 'bunker') return { kind: a.kind, bytes: a.uri.byteLength };
  if (a.kind === 'create-wallet') return { kind: `create-wallet:${String(a.create)}`, bytes: 0 };
  if (a.kind === 'remove-key') return { kind: `remove-key:${String(a.confirm)}`, bytes: 0 };
  if (a.kind === 'bunker-auth') return { kind: `bunker-auth:${String(a.open)}`, bytes: 0 };
  if (a.kind === 'top-up-first') return { kind: `top-up-first:${String(a.confirm)}`, bytes: 0 };
  // ADR 0016: how many words came back, never which.
  if (a.kind === 'recovery-show') return { kind: `recovery-show:${String(a.done)}`, bytes: 0 };
  if (a.kind === 'recovery-confirm' || a.kind === 'recovery-restore')
    return { kind: a.kind, bytes: a.words.length };
  return { kind: `local-setup:${a.method}:${a.flow}`, bytes: 0 };
}

/** Keychain requests from the host; every one is answered, secrets wiped once posted. */
async function onKeychain(out: Extract<HostOut, { kind: 'keychain' }>): Promise<void> {
  const k = keychain;
  let reply: Extract<HostIn, { kind: 'keychain-result' }>;
  if (k === undefined) reply = { kind: 'keychain-result', req: out.req, ok: false, value: null };
  else if (out.op === 'get') {
    const value = await k.get(out.slot);
    reply = { kind: 'keychain-result', req: out.req, ok: k.usable, value };
  } else if (out.op === 'put') {
    const ok = out.value === undefined ? false : await k.put(out.slot, out.value);
    reply = { kind: 'keychain-result', req: out.req, ok, value: null };
  } else {
    reply = { kind: 'keychain-result', req: out.req, ok: await k.forget(out.slot), value: null };
  }
  post(reply);
  reply.value?.fill(0);
}

function promptSender(e: Electron.IpcMainInvokeEvent): PromptSender {
  const frame = e.senderFrame;
  return {
    senderId: e.sender.id,
    frameUrl: frame?.url,
    topFrame: frame !== null && frame.parent === null,
  };
}
/**
 * The confirm gate's native dialog (security review F7/F8): modal to the asking window, Cancel
 * the default and the Escape answer, the text built by `money-gate.ts` from guarded arguments.
 */
async function askUser(wcId: number, p: ConfirmPrompt): Promise<boolean> {
  const wc = allWebContents.fromId(wcId);
  return showConfirm(wc === undefined ? null : BrowserWindow.fromWebContents(wc), p);
}

/** ADR 0016: the host's native questions, modal to the app window (`host-confirm.ts`). */
const hostConfirms = new HostConfirms({
  ask: (p, signal) =>
    showConfirm(
      mainWindow !== undefined && !mainWindow.isDestroyed() ? mainWindow : null,
      p,
      signal,
    ),
  answer: (req, ok) => {
    post({ kind: 'confirm-result', req, ok });
  },
  log: (level, event) => {
    log(level, event);
  },
});

/** `signal` closes the dialog as a Cancel (round 8: a host confirm nobody waits for any more). */
async function showConfirm(
  win: BrowserWindow | null,
  p: ConfirmPrompt,
  signal?: AbortSignal,
): Promise<boolean> {
  const box: MessageBoxOptions = {
    type: 'question',
    buttons: ['Cancel', p.confirmLabel],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: p.title,
    message: p.message,
    detail: p.detail,
    ...(signal === undefined ? {} : { signal }),
  };
  const r = win === null ? await dialog.showMessageBox(box) : await dialog.showMessageBox(win, box);
  return r.response === 1;
}

const gate = new IpcGate({
  post,
  tokens,
  moneyGate: createMoneyGate({ devMocks: opts.devMocks, ask: askUser }),
  isAppWebContents: (id) => appWebContents.has(id),
  log,
});

app.on('web-contents-created', (_event, wc) => {
  hardenWebContents(wc, (url, id) => {
    externalLinks.request(url, appWebContents.has(id));
  });
  wc.once('destroyed', () => {
    appWebContents.delete(wc.id);
    gate.webContentsGone(wc.id);
  });
  // A new document in the same webContents (crash recovery, our reload after a host restart):
  // the old page's subscriptions, sessions and file tokens die with it.
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) gate.webContentsGone(wc.id);
  });
  wc.on('render-process-gone', () => {
    log('error', 'renderer.gone');
    gate.webContentsGone(wc.id);
  });
});

function onHostOut(out: HostOut): void {
  switch (out.kind) {
    case 'media-link':
      links.set(out.token, out.url);
      return;
    case 'image':
      images.resolve(out.req, out.bytes, out.type);
      return;
    case 'prompt':
      prompts.ask(out.req, out.form);
      return;
    case 'prompt-cancel':
      prompts.cancel(out.req);
      return;
    case 'keychain':
      void onKeychain(out);
      return;
    case 'confirm':
      hostConfirms.ask(out.req, out.form);
      return;
    case 'confirm-cancel':
      hostConfirms.cancel(out.req);
      return;
    case 'reply':
    case 'sub-reply':
    case 'event':
      gate.fromHost(out);
      return;
  }
}

function showWindow(): void {
  const win = createMainWindow(BrowserWindow, join(distDir, 'preload.cjs'));
  mainWindow = win;
  const wc: WebContents = win.webContents;
  appWebContents.add(wc.id);
  win.once('ready-to-show', () => {
    win.show();
  });
  wc.on('did-fail-load', () => {
    log('error', 'window.load-failed');
  });
  void win.loadURL(APP_URL);
  log('info', 'window.created');
}

function start(): void {
  // macOS needs an Edit menu for copy/paste shortcuts; elsewhere there is no menu at all
  // (so no default Reload / Toggle DevTools accelerators either).
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }])
      : null,
  );
  installSessionPolicy(session.defaultSession);
  const appFiles = createAppProtocolHandler({
    root: join(distDir, 'renderer'),
    readFile,
    realpath,
  });
  // ADR 0013: the prompt page, at its own origin, from its own directory and file list.
  const promptFiles = createAppProtocolHandler({
    root: join(distDir, 'prompt'),
    files: PROMPT_FILES,
    host: PROMPT_HOST,
    readFile,
    realpath,
  });
  protocol.handle(APP_SCHEME, (req) => {
    let host = '';
    try {
      host = new URL(req.url).host;
    } catch {
      // appFiles answers 404
    }
    return host === PROMPT_HOST ? promptFiles(req) : appFiles(req);
  });
  const keychainOk = keychainUsable(safeStorage, process.platform);
  keychain = new KeychainStore({
    dir: join(app.getPath('userData'), 'keychain'),
    usable: keychainOk,
    safeStorage: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      getSelectedStorageBackend: () =>
        process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os',
      encryptStringAsync: async (text) =>
        new Uint8Array(await safeStorage.encryptStringAsync(text)),
      decryptStringAsync: async (b) =>
        safeStorage.decryptStringAsync(Buffer.from(b.buffer, b.byteOffset, b.byteLength)),
    },
    fs: fsp,
    join,
    posix: process.platform !== 'win32',
  });
  log('info', 'keychain.ready', { usable: keychainOk });
  const media = createMediaProtocolHandler({
    links,
    images,
    fetch: netMediaFetch((url, init) => net.fetch(url, init)),
    log,
  });
  /** e2e only: response status counts of `nf-media:` (numbers, never URLs). */
  const mediaStatuses = new Map<number, number>();
  /** e2e only: the first byte of every `nf-media:` Range answered 206, in order (numbers). */
  const mediaRangeStarts: number[] = [];
  protocol.handle(MEDIA_SCHEME, async (req) => {
    const res = await media(req);
    if (opts.e2eHooks) {
      mediaStatuses.set(res.status, (mediaStatuses.get(res.status) ?? 0) + 1);
      const start = /^bytes=(\d{1,15})-/.exec(req.headers.get('range') ?? '')?.[1];
      if (res.status === 206 && start !== undefined && mediaRangeStarts.length < 4096)
        mediaRangeStarts.push(Number(start));
    }
    return res;
  });
  ipcMain.handle(CHANNEL.call, (e, raw: unknown) => gate.call(e, raw));
  ipcMain.handle(CHANNEL.sub, (e, raw: unknown) => gate.sub(e, raw));
  ipcMain.handle(CHANNEL.grant, (e, raw: unknown) => gate.grant(e, raw));
  ipcMain.handle(PROMPT_CHANNEL.init, (e) => prompts.init(promptSender(e)));
  ipcMain.handle(PROMPT_CHANNEL.answer, (e, raw: unknown) => prompts.submit(promptSender(e), raw));

  host = new HostLink({
    spawn: () =>
      utilityProcess.fork(
        join(distDir, HOST_ENTRY),
        hostArgs(opts, {
          userData: app.getPath('userData'),
          workerEntry: workerEntryFor(distDir, appArchive(process.resourcesPath, realpathSync)),
          keychain: keychainOk,
        }),
        { serviceName: 'nutflix-host', stdio: 'inherit' },
      ),
    onOut: onHostOut,
    onDown: () => {
      gate.hostDown();
      links.clear();
      images.failAll();
      prompts.cancelAll();
      hostConfirms.hostGone();
    },
    onRestart: () => {
      // Only app windows: a prompt window belongs to the host that is gone (closed on down).
      for (const w of BrowserWindow.getAllWindows())
        if (appWebContents.has(w.webContents.id)) w.webContents.reload();
    },
    now: () => Date.now(),
    log,
  });
  host.start();

  if (opts.e2eHooks) {
    // Main-process only (reached by playwright's `electronApp.evaluate`), counts only.
    (globalThis as Record<symbol, unknown>)[Symbol.for('nutflix.e2e')] = Object.freeze({
      mediaLinks: (): number => links.size,
      mediaStatuses: (): Record<number, number> => Object.fromEntries(mediaStatuses),
      mediaRangeStarts: (): number[] => [...mediaRangeStarts],
      fileTokens: (): number => tokens.count(),
      hostRunning: (): boolean => host?.running ?? false,
      /** ADR 0013: open the prompt window with a question (the form is guarded like the host's). */
      openPrompt: (form: unknown): number => {
        if (!isPromptForm(form)) return 0;
        const req = ++e2ePromptSeq;
        e2ePrompts.set(req, 'pending');
        prompts.ask(req, form);
        return req;
      },
      promptAnswer: (req: number): { kind: string; bytes: number } | null | 'pending' | undefined =>
        e2ePrompts.get(req),
      promptWindowId: (): number | null => prompts.windowId,
      /** F25: external links main opened (after the user's click in the prompt window). */
      externalOpens: (): number => externalOpens,
    });
  }
  showWindow();
  log('info', 'app.start', { devMocks: opts.devMocks, devFixtures: opts.devFixtures });
}

app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (w === undefined) return;
  if (w.isMinimized()) w.restore();
  w.focus();
});
app.on('window-all-closed', () => {
  app.quit();
});
// Fix round 4: the host pays the open play sessions' tails before its worker goes (SIGTERM →
// `Host.shutdown`, `QUIT_FLUSH_MS` in host/host.ts); main lets it, up to `QUIT_GRACE_MS`, before
// quitting.
const QUIT_GRACE_MS = 9000;
let quitReady = false;
app.on('before-quit', (e) => {
  const h = host;
  if (quitReady || !h?.running) {
    h?.stop();
    return;
  }
  e.preventDefault();
  quitReady = true;
  void h.stopAndWait(QUIT_GRACE_MS).finally(() => {
    app.quit();
  });
});
if (primary)
  app.whenReady().then(start, () => {
    app.exit(1);
  });
