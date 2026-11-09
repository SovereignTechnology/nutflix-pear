/**
 * The drift check (ADR 0022 item 2). `scripts/build-site.ts` type-checks this file with
 * `nfx-web-lib` mapped to the pinned tar's own `player.d.ts` (and the `api.d.ts` beside it), and
 * fails the build on any error: the library must still be what `src/nfx-lib.ts` says the adapter
 * calls.
 *
 * Function types, not methods, so TypeScript checks parameters contravariantly: every option the
 * adapter passes must be one the library takes, and every event and session the library hands back
 * must be one the adapter reads. A new kind of event in nfx fails here until `NfxPlayerEvent`
 * names it.
 */
import { init, open, type PlayerEvent } from 'nfx-web-lib';
import type { NfxLibSession, NfxOpenOptions, NfxPlayerEvent, NfxPlayerLib } from '@sovit/app-web';

export const checkInit: (options?: { readonly wasmUrl?: string }) => Promise<void> = init;
export const checkOpen: (el: HTMLVideoElement, options: NfxOpenOptions) => Promise<NfxLibSession> =
  open;
export const checkLib: NfxPlayerLib = { init, open };
export const checkEvent = (e: PlayerEvent): NfxPlayerEvent => e;
