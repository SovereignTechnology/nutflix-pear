/**
 * The desktop shell (design §4): header, sidebar, the routed screen, the mini-player and ONE
 * shell `ToastStack` (fed by Settings and Library through `onToast`; it outlives the screens,
 * and a toast's action closes that toast before it runs, once). Every prop the screens expect
 * from a shell (docs/archive/status-2026-10-04.md "Shell contract the screens expect") is wired here:
 *
 *   Home      `tab`, `hoverPreview` from Settings
 *   Watch     `videoId`, `startAtSec` (route `t`), `onMiniPlayer` → coordinator, `resumeSession`
 *             (expand / back to a handed-off video), `playlist` (extras)
 *   Shorts    `videoId`, `onPlaybackStart` → pause the mini-player (SE-3); when the mini
 *             resumes, the coordinator pauses the short's session AND its element, and the
 *             short's element-pause handler shows it paused (as Watch does)
 *   Channel   `pubkey`, `tab`; `seedingVideos` deliberately undefined in Stage 1 (v5 lookup)
 *   Search    `q`, `filters` + `onFiltersChange` kept in the history entry
 *   Library   `tab`, `playlistId` (extras), `onToast` → shell stack
 *   Studio    `tab`, `resolveFile` = identity (SE-1: the preload tokenises the File),
 *             `ffmpeg` + `onRecheckFfmpeg` from `desktop.ffmpeg`; kept mounted across tabs;
 *             no `onToast` — Studio raises no toasts (its notices are in-place state)
 *   Wallet    `intent` (extras)
 *   Settings  `onSettingsChange` → theme + hoverPreview, `onToast` → shell stack;
 *             `onChangeSigner` → `desktop.signer.connect` (ADR 0013: the kind only — the flow
 *             runs in main's trusted prompt window), when the host offers the signer flow;
 *             `recovery` → `desktop.wallet.recovery.*` (ADR 0016: an action only — the words
 *             are shown and typed in main's prompt window), with the signer flow too
 *
 * Screens are keyed by route NAME only: Watch is not remounted watch → watch, Shorts not
 * shorts → shorts, Studio not across tabs. The coordinator learns the mounted screen in a
 * layout effect (before any screen effect can call `play()`) and sweeps unowned sessions in a
 * passive effect after every commit (after unmounted screens handed off).
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import type { NetworkAdapter, Settings as SettingsData } from '@sovit/core';
import {
  Channel,
  Home,
  Library,
  NfxWatch,
  Search,
  Settings,
  Shorts,
  Studio,
  ToastStack,
  Wallet,
  Watch,
  applyTheme,
  isNfxAddress,
  isTextEntryTarget,
} from '@sovit/ui';
import type {
  FfmpegStatus,
  RecoveryControls,
  SearchFilterState,
  ToastItem,
  TopUpHoldControls,
} from '@sovit/ui';
import type { PlaybackCoordinator } from './coordinator.js';
import type { Router } from './router.js';
import { Header } from './shell/Header.js';
import { MiniPlayer } from './shell/MiniPlayer.js';
import { Sidebar } from './shell/Sidebar.js';
import { useCoordinator, useIdentity, useRouterState, useWalletTotal } from './shell/hooks.js';

export const MAX_SHELL_TOASTS = 3;

/**
 * ADR 0013: the desktop signer flow (`bridge.desktop.signer`). Every secret is typed in main's
 * prompt window; the shell only starts flows and re-reads identity when the status changes.
 */
export interface SignerFlow {
  /** Resolves when the host offers the flow (rejects `forbidden` with --dev-mocks). */
  info(): Promise<unknown>;
  connect(kind: 'local' | 'nip46'): Promise<unknown>;
  unlock(): Promise<unknown>;
  lock(): Promise<unknown>;
  /** Main confirms first (native dialog). */
  signOut(): Promise<unknown>;
  /** Signer status changes: connect, lock, unlock, sign out. */
  onChange(cb: () => void): () => void;
}

/** A flow error worth a toast (`cancelled` = the user closed the prompt; `forbidden: not confirmed`). */
function flowErrorToast(err: unknown): ToastItem | null {
  const msg = err instanceof Error ? err.message : '';
  if (msg.startsWith('cancelled') || msg === 'forbidden: not confirmed') return null;
  const detail = msg.replace(/^[a-z-]+:\s*/, '');
  return {
    id: 'signer',
    tone: 'error',
    title: 'Signer',
    description: detail === '' ? 'That did not work.' : detail,
  };
}

export interface ShellProps {
  /** The coordinator-wrapped adapter (stable identity for the app's lifetime). */
  readonly adapter: NetworkAdapter;
  readonly coordinator: PlaybackCoordinator;
  readonly router: Router;
  /** `desktop.ffmpeg` (pre-v5 stand-in for `studio.ffmpeg()`); absent = Studio learns on upload. */
  readonly probeFfmpeg?: ((recheck: boolean) => Promise<FfmpegStatus>) | undefined;
  /** ADR 0013: the signer flow; absent (tests) or refused by the host (--dev-mocks) = none. */
  readonly signerFlow?: SignerFlow | undefined;
  /** ADR 0016: the recovery phrase flows; offered to Settings only with the signer flow. */
  readonly recovery?: RecoveryControls | undefined;
  /** R5-R1: held auto top-ups (the host lists none where top-ups do not run). */
  readonly topUpHolds?: TopUpHoldControls | undefined;
}

/** Studio's `resolveFile`: the File itself — the preload, never the page, turns it into a token. */
const identityFile = (file: File): File => file;

/** Pause the page's own `<video>`s (never the mini-player's). */
export function pauseScreenMedia(doc: Document = document): void {
  for (const v of doc.querySelectorAll('video')) {
    if (v.closest('.nf-shell__mini') !== null) continue;
    try {
      v.pause();
    } catch {
      // no media support
    }
  }
}

/** Wires router ⇄ coordinator: navigation requests, and "watch the mini's video" = expand. */
export function connectRouter(router: Router, coordinator: PlaybackCoordinator): void {
  router.onRequest = (route) => {
    coordinator.routeRequested(route);
  };
  router.intercept = (entry) => {
    const mini = coordinator.snapshot().mini;
    if (entry.route.name !== 'watch' || mini?.handoff.videoId !== entry.route.videoId) {
      return entry;
    }
    const handoff = coordinator.expandMini();
    return handoff === null
      ? entry
      : { ...entry, extras: { ...entry.extras, resumeSession: handoff } };
  };
}

export function Shell({
  adapter,
  coordinator,
  router,
  probeFfmpeg,
  signerFlow,
  recovery,
  topUpHolds,
}: ShellProps): ReactElement {
  const rs = useRouterState(router);
  const { route, extras } = rs.entry;
  const play = useCoordinator(coordinator);
  // ---- the signer (ADR 0013): bumped on every status change, re-reading identity + wallet ----
  const [signerGen, setSignerGen] = useState(0);
  const [flowOn, setFlowOn] = useState(false);
  useEffect(() => {
    if (signerFlow === undefined) return undefined;
    let alive = true;
    signerFlow.info().then(
      () => {
        if (alive) setFlowOn(true);
      },
      () => undefined,
    );
    const off = signerFlow.onChange(() => {
      setSignerGen((g) => g + 1);
    });
    return () => {
      alive = false;
      off();
    };
  }, [signerFlow]);
  const identity = useIdentity(adapter, signerGen);
  const balance = useWalletTotal(
    adapter,
    identity.status === 'signed-in' && identity.locked !== true,
    signerGen,
  );
  const navigate = router.navigate;

  // ---- settings: theme at boot and on every change; hoverPreview for Home ------------------
  const [settings, setSettings] = useState<SettingsData | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    adapter.settings().then(
      (s) => {
        if (!alive) return;
        applyTheme(s.theme);
        setSettings(s);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [adapter]);
  const onSettingsChange = useCallback((s: SettingsData): void => {
    applyTheme(s.theme);
    setSettings(s);
  }, []);

  // ---- toasts --------------------------------------------------------------------------------
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const toastSeq = useRef(0);
  const dismissToast = useCallback((id: string): void => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const pushToast = useCallback(
    (t: ToastItem): void => {
      toastSeq.current += 1;
      const id = `shell-${String(toastSeq.current)}`;
      const action = t.action;
      let used = false;
      // Ids are re-minted here, so a screen's own dismiss cannot reach this stack: an action
      // (Undo, Retry) closes its toast itself — as the screens' own stacks do — and runs once.
      const item: ToastItem =
        action === undefined
          ? { ...t, id }
          : {
              ...t,
              id,
              action: {
                label: action.label,
                onClick: () => {
                  if (used) return;
                  used = true;
                  dismissToast(id);
                  action.onClick();
                },
              },
            };
      setToasts((prev) => [...prev, item].slice(-MAX_SHELL_TOASTS));
    },
    [dismissToast],
  );

  // ---- ffmpeg probe for Studio -------------------------------------------------------------
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | undefined>(undefined);
  const probing = useRef(false);
  const probe = useCallback(
    (recheck: boolean): void => {
      if (probeFfmpeg === undefined || probing.current) return;
      probing.current = true;
      probeFfmpeg(recheck).then(
        (s) => {
          probing.current = false;
          setFfmpeg(s);
        },
        () => {
          probing.current = false;
        },
      );
    },
    [probeFfmpeg],
  );
  const onStudio = route.name === 'studio';
  useEffect(() => {
    if (onStudio && ffmpeg === undefined) probe(false);
  }, [onStudio, ffmpeg, probe]);
  const recheckFfmpeg = useCallback((): void => {
    probe(true);
  }, [probe]);

  // ---- screen identity + coordinator hooks ------------------------------------------------
  const keyRef = useRef({ name: route.name, key: 1 });
  if (keyRef.current.name !== route.name) {
    keyRef.current = { name: route.name, key: keyRef.current.key + 1 };
  }
  const screenKey = keyRef.current.key;
  useLayoutEffect(() => {
    coordinator.screenMounted(screenKey);
  }, [coordinator, screenKey]);
  useEffect(() => {
    coordinator.routeCommitted(route);
    // `rs.version` changes on every navigation, including in-place extras updates.
  }, [coordinator, route, rs.version]);

  // ---- back / forward: Alt+←/→ and the mouse's back/forward buttons -------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isTextEntryTarget(e.target)) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        router.back();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        router.forward();
      }
    };
    const onMouse = (e: MouseEvent): void => {
      if (e.button === 3) {
        e.preventDefault();
        router.back();
      } else if (e.button === 4) {
        e.preventDefault();
        router.forward();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouse);
    };
  }, [router]);

  const onFiltersChange = useCallback(
    (f: SearchFilterState): void => {
      router.updateExtras({ searchFilters: f });
    },
    [router],
  );

  // ---- signer actions (ADR 0013) ------------------------------------------------------------
  const runFlow = useCallback(
    async (f: () => Promise<unknown>): Promise<void> => {
      try {
        await f();
      } catch (err) {
        const t = flowErrorToast(err);
        if (t !== null) pushToast(t);
        throw err;
      }
    },
    [pushToast],
  );
  const onChangeSigner = useCallback(
    (kind: 'nip07' | 'nip46' | 'local'): Promise<void> => {
      if (signerFlow === undefined || kind === 'nip07')
        return runFlow(() =>
          Promise.reject(
            new Error('invalid-argument: browser extensions are not available on desktop'),
          ),
        );
      return runFlow(() => signerFlow.connect(kind));
    },
    [runFlow, signerFlow],
  );
  const headerSigner = useMemo(
    () =>
      signerFlow === undefined
        ? undefined
        : {
            unlock: () => runFlow(() => signerFlow.unlock()).catch(() => undefined),
            lock: () => runFlow(() => signerFlow.lock()).catch(() => undefined),
            signOut: () => runFlow(() => signerFlow.signOut()).catch(() => undefined),
          },
    [runFlow, signerFlow],
  );

  // ---- the screen ---------------------------------------------------------------------------
  const common = { adapter, navigate } as const;
  let screen: ReactElement;
  switch (route.name) {
    case 'home':
      screen = <Home {...common} tab={route.tab} hoverPreview={settings?.hoverPreview} />;
      break;
    case 'watch': {
      // Contracts v9: an NFX address opens the NFX page, which plays nothing yet (ADR 0020).
      if (isNfxAddress(route.videoId)) {
        screen = <NfxWatch {...common} videoId={route.videoId} />;
        break;
      }
      const handed = extras.resumeSession;
      const resume =
        handed?.videoId === route.videoId && coordinator.canResume(handed.session)
          ? handed
          : undefined;
      screen = (
        <Watch
          {...common}
          videoId={route.videoId}
          startAtSec={route.t}
          onMiniPlayer={coordinator.handOff}
          resumeSession={resume}
          playlist={extras.watchPlaylist}
        />
      );
      break;
    }
    case 'channel':
      screen = (
        <Channel {...common} pubkey={route.pubkey} tab={route.tab} seedingVideos={undefined} />
      );
      break;
    case 'search':
      screen = (
        <Search
          {...common}
          q={route.q}
          filters={extras.searchFilters}
          onFiltersChange={onFiltersChange}
        />
      );
      break;
    case 'shorts':
      screen = (
        <Shorts {...common} videoId={route.videoId} onPlaybackStart={coordinator.pauseMini} />
      );
      break;
    case 'library':
      screen = (
        <Library {...common} tab={route.tab} playlistId={extras.playlistId} onToast={pushToast} />
      );
      break;
    case 'studio':
      screen = (
        <Studio
          {...common}
          tab={route.tab}
          resolveFile={identityFile}
          ffmpeg={ffmpeg}
          onRecheckFfmpeg={probeFfmpeg === undefined ? undefined : recheckFfmpeg}
        />
      );
      break;
    case 'wallet':
      screen = <Wallet {...common} intent={extras.walletIntent} />;
      break;
    case 'settings':
      screen = (
        <Settings
          {...common}
          onSettingsChange={onSettingsChange}
          onToast={pushToast}
          {...(flowOn ? { onChangeSigner, recovery } : {})}
          topUpHolds={topUpHolds}
        />
      );
      break;
  }

  return (
    <div className="nf-shell" data-route={route.name}>
      <Header
        route={route}
        navigate={navigate}
        canBack={rs.canBack}
        canForward={rs.canForward}
        onBack={router.back}
        onForward={router.forward}
        identity={identity}
        balance={balance}
        ratePerMin={play.ratePerMin}
        signer={flowOn ? headerSigner : undefined}
      />
      <div className="nf-shell__body">
        <Sidebar route={route} navigate={navigate} />
        <main
          className="nf-shell__main"
          key={route.name === 'settings' ? `${screenKey}:${String(signerGen)}` : screenKey}
        >
          {screen}
        </main>
      </div>
      {play.mini !== null ? (
        <MiniPlayer
          mini={play.mini}
          coordinator={coordinator}
          navigate={navigate}
          ratePerMin={play.mini.paused ? 0 : play.ratePerMin}
        />
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismissToast} className="nf-shell__toasts" />
    </div>
  );
}
