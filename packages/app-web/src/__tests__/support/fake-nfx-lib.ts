/**
 * A fake of nfx's player library (`NfxPlayerLib`): it records every `init` and `open` with the
 * exact options it was given, and hands back sessions the test drives (levels, events, a refusal).
 * No WASM, no hls.js and no network.
 */
import type {
  NfxLevel,
  NfxLibSession,
  NfxOpenOptions,
  NfxPlayerEvent,
  NfxPlayerLib,
} from '../../nfx-lib.js';

export interface FakeOpen {
  readonly el: HTMLVideoElement;
  readonly options: NfxOpenOptions;
  readonly session: FakeLibSession;
}

export class FakeLibSession implements NfxLibSession {
  levels: NfxLevel[] = [];
  readonly setLevelCalls: number[] = [];
  destroyed = 0;
  readonly #emit: (e: NfxPlayerEvent) => void;

  constructor(emit: (e: NfxPlayerEvent) => void) {
    this.#emit = emit;
  }

  setLevel(index: number): void {
    if (!Number.isSafeInteger(index) || index < -1 || index >= this.levels.length) {
      throw new RangeError(`nfx: no level ${String(index)}`);
    }
    this.setLevelCalls.push(index);
  }

  destroy(): void {
    this.destroyed += 1;
  }

  /** hls.js parsed the master playlist. */
  parsed(levels: NfxLevel[]): void {
    this.levels = levels;
    this.#emit({ type: 'levels', levels });
  }

  emit(e: NfxPlayerEvent): void {
    this.#emit(e);
  }
}

export class FakeNfxPlayer implements NfxPlayerLib {
  readonly inits: ({ readonly wasmUrl?: string } | undefined)[] = [];
  readonly opens: FakeOpen[] = [];
  /** Set to make the next `init` reject once. */
  failInit = false;
  /** Set to make every `open` reject with this message (no origin verified, say). */
  refuse: string | null = null;
  /** Levels each new session reports at once. */
  levels: NfxLevel[] = [];

  init(options?: { readonly wasmUrl?: string }): Promise<void> {
    this.inits.push(options);
    if (this.failInit) {
      this.failInit = false;
      return Promise.reject(new Error('wasm did not load'));
    }
    return Promise.resolve();
  }

  open(el: HTMLVideoElement, options: NfxOpenOptions): Promise<NfxLibSession> {
    if (options.signal?.aborted === true) return Promise.reject(new Error('aborted'));
    if (this.refuse !== null) return Promise.reject(new Error(this.refuse));
    const session = new FakeLibSession((e) => options.onEvent?.(e));
    session.levels = [...this.levels];
    this.opens.push({ el, options, session });
    return Promise.resolve(session);
  }

  get last(): FakeOpen {
    const o = this.opens.at(-1);
    if (o === undefined) throw new Error('nothing opened');
    return o;
  }
}
