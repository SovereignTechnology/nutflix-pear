/**
 * Live NFX beacons on the host: core's `NfxBeaconWatch` (moved there for the web client, ADR
 * 0022) on Node timers that are `unref`ed, so a watch is never what keeps the host process alive
 * (a quit closes the watch anyway). See `@sovit/core`'s `nostr/nfx-beacon-watch.ts` for what it
 * does and why beacons are read live.
 */
import { nostr } from '@sovit/core';

export const {
  MAX_BEACONS_PER_VIDEO,
  MAX_BEACON_VIDEOS,
  NFX_BEACON_KEEP_S,
  NFX_BEACON_WAIT_MS,
  NFX_BEACON_WARM_MS,
} = nostr;

/** Node's timers, `unref`ed: the only part of the watch that is not runtime-agnostic. */
export const unrefTimers: nostr.NfxBeaconWatchTimers = {
  setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms).unref(),
  clearTimeout: (h: unknown): void => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

export class NfxBeaconWatch extends nostr.NfxBeaconWatch {
  constructor(d: nostr.NfxBeaconWatchDeps) {
    super({ ...d, timers: d.timers ?? unrefTimers });
  }
}
