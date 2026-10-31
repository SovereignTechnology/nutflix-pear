/**
 * Slice 5e-1 (spike S-D finding 10): the report of `subprocess-probe-entry.ts`, its own module so
 * the Node-side test imports no file that uses the `Bare` global.
 */
export interface SubprocessProbeReport {
  readonly ok: boolean;
  readonly mode: 'ipc' | 'file';
  readonly exchanges: number;
  readonly ticks: number;
  readonly elapsedMs: number;
  readonly exits: readonly (number | null)[];
  /** Milliseconds into the run of each Bare `beforeExit`, with exchanges still pending. */
  readonly beforeExit: readonly number[];
  readonly error?: string;
}

/** Exchanges per child, and the children. */
export const SUBPROCESS_PROBE_ROUNDS = 150;
export const SUBPROCESS_PROBE_CHILDREN = 2;
