# Development notes

For setup and the day-to-day commands see [CONTRIBUTING.md](../CONTRIBUTING.md). This page holds
what does not fit there.

## Running the Electron end-to-end suites

The suites in `packages/app-desktop/e2e/` launch the real Electron app and drive it with
Playwright. They are **not** run by `npm test`. The app starts with `--dev-mocks --dev-fixtures`,
so they run offline: in-memory relays, a loopback DHT, fixture videos and mock sats. CI runs them
in the `e2e` job, under a virtual display. One suite, `secure-memory.e2e.ts`, opens no window and
uses no mocks: it runs a child inside the Electron binary. `nfx-exit-app.e2e.ts` is in the same
directory but is run only by the `nfx-exit` workflow.

Prerequisites:

1. **Chromium's sandbox must be able to start.** The suites never pass `--no-sandbox`, and the app
   refuses it in every build. On Ubuntu 24.04 and later, which restricts unprivileged user
   namespaces, give your checkout's helper the setuid bit (redo it after every `npm ci`, which
   replaces the file):

   ```sh
   sudo chown root:root node_modules/electron/dist/chrome-sandbox
   sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
   ```

   The alternative is an AppArmor profile that grants `userns` to your checkout's
   `node_modules/electron/dist/electron`. A profile cannot be detected without root, so say you
   have one with `NUTFLIX_E2E_APPARMOR_PROFILE=1`.

2. `node node_modules/electron/install.js`, once per checkout (lifecycle scripts are off, so
   Electron's binary is not fetched by `npm ci`).
3. `npm run build` after every source change. `tsc -b` is incremental; never edit `dist/` by hand.
   The system `ffmpeg` must be on your `PATH`, because the fixtures are made on each run.
4. **A display.** Use `DISPLAY` if your shell has one, or wrap the run in `xvfb-run -a` as CI does.
   Failing both, the suites look for a GNOME session's Xwayland socket.

Run them from the repository root, one run at a time:

```sh
xvfb-run -a npm run -w packages/app-desktop test:e2e    # six suites, serially
```

That script runs six files (`fidelity`, `stage1`, `signer`, `secure-memory`, `proxy-abort` and
`nfx-playback`) and sets `NUTFLIX_E2E=1`; without it the suites skip. To run one file, set the
variable yourself: `NUTFLIX_E2E=1 node --test packages/app-desktop/e2e/stage1.e2e.ts`.

| Variable                           | Effect                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| `NUTFLIX_E2E=1`                    | Required, or the suites skip (the npm script sets it)                                   |
| `NUTFLIX_E2E_LOG=<file>`           | Appends the app's own log lines (main, host and worker, already redacted) to a file     |
| `NUTFLIX_E2E_APPARMOR_PROFILE=1`   | Declares that an AppArmor profile lets the sandbox start                                |
| `NUTFLIX_E2E_DISPLAY=headless\|wayland` | Opt in to another display mode. Both fail with Electron 44.2.0, so the default is X11 |

What `e2e/support.ts` guarantees on every launch:

- **The sandbox is on, and the suite proves it.** It passes `chromiumSandbox: true`, because
  Playwright otherwise prepends `--no-sandbox` on Linux. Before any test runs it asserts that no
  sandbox-bypass switch is in main's command line and that the renderer has a seccomp filter and its
  own PID namespace. A regression stops the suite with "the Chromium sandbox is NOT on".
- **X11 by default.** `--ozone-platform=headless` crashes Electron 44.2.0 at `new BrowserWindow`,
  and `--ozone-platform=wayland` hangs before `ready`.
- **Fixtures long enough to seek.** Each is a 90 s clip at a forced 2 Mbit/s (about 343 blocks), so
  there is a second Range request and the video is still playing when the mini-player steps run.
  An earlier 6 s clip was a single 64 KiB block.
