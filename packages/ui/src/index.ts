/**
 * @sovit/ui — React design system (lane L4, docs/archive/lanes/L4.md), screens (L5), player chrome
 * and the app shell (ADR 0022: header, sidebar, router, playback coordinator; `shell.css`).
 * Talks only to `NetworkAdapter` types from `@sovit/core`; components are presentational.
 * Stylesheets are NOT imported from JS (CSP `style-src 'self'`): shells load
 * `@sovit/ui/ui.css` (or `tokens.css` + `components.css`) from `dist/`, built by `build:css`.
 */
export const PACKAGE = '@sovit/ui' as const;

export * from './tokens/index.js';
export * from './components/index.js';
export * from './screens/index.js';
export * from './shell/index.js';
