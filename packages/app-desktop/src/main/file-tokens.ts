/**
 * SE-1 file-token registry (docs/archive/reviews/2026-09-23-pre-push-l5-v4.md; design §2).
 *
 * The renderer never names a file. The preload turns a DOM `File` the USER picked or dropped
 * into its path (`webUtils.getPathForFile`) and asks main for a token (`nf:grant-file`); main
 * checks the path itself — absolute, non-empty, `lstat` says a REGULAR file (not a symlink, a
 * directory, a device, a FIFO or a socket) — and mints an opaque token that is:
 *
 *   - single use: `consume` deletes it;
 *   - bound to the webContents that asked: another webContents gets nothing;
 *   - short-lived: `FILE_TOKEN_TTL_MS` (10 min);
 *   - bounded: at most `MAX_TOKENS_PER_WC` live per webContents (oldest evicted).
 *
 * Main swaps a token for `{ path, name, size }` only when relaying `studio.upload` or (contracts
 * v16) `studio.probe` (the IPC gate); any other string there is `file-token-invalid`. A probe
 * reads the file with ffprobe and publishes nothing, so it takes a token of its own and asks no
 * confirmation.
 *
 * Residual (documented in docs/archive/lanes/L6-A.md): a compromised renderer can still ask for a token
 * for a path it knows, because `isGrantFileMsg` is all main sees — the preload only ever sends
 * `webUtils.getPathForFile(file)`, and a renderer-constructed `File` has no path (`''`), which
 * is refused. The upload itself still needs the user's Publish click in Studio.
 */
import type { FileToken, WireError } from '../ipc/protocol.js';
import { isAbsolutePath } from '../ipc/guards.js';
import { wireError } from '../ipc/errors.js';

export const FILE_TOKEN_TTL_MS = 10 * 60 * 1000;
export const MAX_TOKENS_PER_WC = 16;

export interface FileStat {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  readonly size: number;
}

export interface FileTokenDeps {
  /** `fs.promises.lstat` — must NOT follow symlinks. */
  lstat(path: string): Promise<FileStat>;
  /** Milliseconds (monotonic in tests, `Date.now` in main). */
  now(): number;
  /** `bytes` random bytes as lower-case hex (`crypto.randomBytes(n).toString('hex')`). */
  randomHex(bytes: number): string;
  /** The last path component, for `HostIn.file.name`. */
  basename(path: string): string;
}

export interface GrantedFile {
  readonly path: string;
  readonly name: string;
  readonly size: number;
}

interface Entry extends GrantedFile {
  readonly wc: number;
  readonly expires: number;
}

export type GrantResult =
  | { readonly ok: true; readonly token: FileToken }
  | { readonly ok: false; readonly error: WireError };

export class FileTokenRegistry {
  private readonly tokens = new Map<string, Entry>();

  constructor(private readonly deps: FileTokenDeps) {}

  /** Checks `path` and mints a token for `wc`. Never throws. */
  async grant(wc: number, path: unknown): Promise<GrantResult> {
    if (typeof path !== 'string' || path.trim() === '' || !isAbsolutePath(path)) {
      return {
        ok: false,
        error: wireError('invalid-argument', 'grant-file needs an absolute path'),
      };
    }
    let st: FileStat;
    try {
      st = await this.deps.lstat(path);
    } catch {
      return { ok: false, error: wireError('unsupported-input', 'that file cannot be read') };
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      return { ok: false, error: wireError('unsupported-input', 'not a regular file') };
    }
    const name = this.deps.basename(path);
    if (name === '' || name.length > 1024) {
      return { ok: false, error: wireError('unsupported-input', 'that file has no usable name') };
    }
    this.sweep();
    const mine = [...this.tokens.entries()].filter(([, e]) => e.wc === wc);
    if (mine.length >= MAX_TOKENS_PER_WC) {
      const oldest = mine.sort((a, b) => a[1].expires - b[1].expires)[0];
      if (oldest) this.tokens.delete(oldest[0]);
    }
    const hex = this.deps.randomHex(16);
    if (!/^[0-9a-f]{32}$/.test(hex)) {
      return { ok: false, error: wireError('internal', 'token generation failed') };
    }
    const token: FileToken = `nf-file:${hex}`;
    this.tokens.set(token, {
      wc,
      path,
      name,
      size: Number.isSafeInteger(st.size) && st.size >= 0 ? st.size : 0,
      expires: this.deps.now() + FILE_TOKEN_TTL_MS,
    });
    return { ok: true, token };
  }

  /**
   * The file behind `token` for `wc`, deleting the token (single use). `undefined` for an
   * unknown, expired, already used or other-webContents token — and a token presented by the
   * wrong webContents is burnt too, so a leaked token cannot be retried.
   */
  consume(wc: number, token: unknown): GrantedFile | undefined {
    if (typeof token !== 'string') return undefined;
    const e = this.tokens.get(token);
    if (e === undefined) return undefined;
    this.tokens.delete(token);
    if (e.wc !== wc || this.deps.now() >= e.expires) return undefined;
    return { path: e.path, name: e.name, size: e.size };
  }

  /** The webContents went away: its tokens die with it. */
  dropWebContents(wc: number): void {
    for (const [t, e] of this.tokens) if (e.wc === wc) this.tokens.delete(t);
  }

  /** Live tokens (all, or one webContents'). */
  count(wc?: number): number {
    this.sweep();
    let n = 0;
    for (const e of this.tokens.values()) if (wc === undefined || e.wc === wc) n++;
    return n;
  }

  private sweep(): void {
    const now = this.deps.now();
    for (const [t, e] of this.tokens) if (now >= e.expires) this.tokens.delete(t);
  }
}
