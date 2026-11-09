/**
 * The app shell (ADR 0022): header, sidebar, router, playback coordinator and mini-player, moved
 * here from the desktop app so the web client renders the same one. A shell says what it offers
 * (`ShellOffer`); the desktop offers everything.
 */
export { MAX_SHELL_TOASTS, Shell, connectRouter, pauseScreenMedia } from './Shell.js';
export type { ShellOffer, ShellProps, SignerFlow } from './Shell.js';
export { createShellModel } from './model.js';
export type { ShellModel } from './model.js';
export { MAX_HISTORY, Router, sameRoute } from './router.js';
export type { HistoryEntry as RouterHistoryEntry, RouteExtras, RouterState } from './router.js';
export { PlaybackCoordinator } from './coordinator.js';
export type { CoordinatorOptions, CoordinatorSnapshot, MiniState } from './coordinator.js';
export { Header } from './Header.js';
export type { HeaderProps } from './Header.js';
export { SHELL_SECTIONS, Sidebar, routeSection } from './Sidebar.js';
export type { ShellSection, SidebarProps } from './Sidebar.js';
export { MiniPlayer } from './MiniPlayer.js';
export type { MiniPlayerProps } from './MiniPlayer.js';
export { useCoordinator, useIdentity, useRouterState, useWalletTotal } from './hooks.js';
export type { Identity } from './hooks.js';
