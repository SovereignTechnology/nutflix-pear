/**
 * `nfx-web-lib`, as the editor and `tsc -b` see it: the part of nfx's player library this client
 * calls (`NfxPlayerLib`). The site build checks the real declarations instead (the pinned tar's
 * `player.d.ts` and `api.d.ts`, through `lib-check.ts`), and the bundle imports the real library
 * as `./nfx/player.js`.
 */
declare module 'nfx-web-lib' {
  import type { NfxLibSession, NfxOpenOptions, NfxPlayerEvent } from '@sovit/app-web';

  export type PlayerEvent = NfxPlayerEvent;
  export function init(options?: { wasmUrl?: string | URL }): Promise<void>;
  export function open(el: HTMLVideoElement, options: NfxOpenOptions): Promise<NfxLibSession>;
}
