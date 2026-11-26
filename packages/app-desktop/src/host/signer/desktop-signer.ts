/**
 * The desktop's signer (ADR 0013): core's `SignerManager` behind the user's choice of how to
 * unlock, and the money plane that follows the signer.
 *
 *   passphrase  the local key file (argon2id + XChaCha20-Poly1305, 0600 in `<userData>/signer`),
 *               unlocked with a passphrase typed into main's trusted prompt window at each launch;
 *   keychain    the same key file, its passphrase sealed by the OS keychain (main's `safeStorage`;
 *               offered only where main reports a real keychain), so the app unlocks by itself;
 *   nip46       a remote signer (bunker); the URI is typed into the prompt window, never the
 *               renderer. "Remember" seals the session's client key in the keychain so it reopens
 *               at launch (core `resumeBunker`); otherwise it is reconnected by hand.
 *
 * The renderer only names a KIND (`desktop.signer.connect`); the method, the flow, every
 * passphrase, nsec and URI are chosen and typed in main's window. Secrets arrive as bytes; the
 * manager wipes what it is handed, and this module wipes its own copies (the one it seals, the
 * NIP-46 session blob). A bunker URI must become a JS string for nostr-tools and cannot be wiped.
 *
 * Every signer change swaps the money plane (`MoneyPlane`): the old one is closed, a new one
 * opens for an unlocked signer. A brand-new key gets a new NIP-60 wallet at once (nothing can be
 * replaced); an existing identity with no wallet found is ASKED in the prompt window (default
 * no — "not found" can mean "relays unreachable", ADR 0012 §3). The host restarts the worker
 * around the swap (`swap`), so its init carries the new signer's payments.
 *
 * Flows are exclusive: a second connect while one is open is refused (`rate-limited`).
 */
import { dirname, join } from 'node:path';

import type { NostrPubkey, Signer, SignerStatus } from '@sovit/core';
import { signer as signerMod } from '@sovit/core';

import type { DesktopSignerInfo, SignerConnectWire, UnlockMethod } from '../../ipc/protocol.js';
import { UNLOCK_METHODS } from '../../ipc/protocol.js';
import { IpcError } from '../../ipc/errors.js';
import { isAuthUrl } from '../../ipc/guards.js';
import { fail, hostError } from '../errors.js';
import type { IdentityProvider } from '../identity.js';
import type { Logger } from '../log.js';
import type { MoneyPlane } from '../money.js';
import { JsonFile } from '../settings/json-file.js';
import type { MainBridge } from './main-bridge.js';
import { wipeAnswer } from './main-bridge.js';
import {
  ensurePrivateDir,
  readPrivateFile,
  removePrivateFile,
  writePrivateFile,
} from './private-file.js';

/** A NEW passphrase must be at least this long (bytes; the prompt window enforces it first). */
export const MIN_NEW_PASSPHRASE_BYTES = 12;
/** Wrong passphrases accepted per unlock before it fails. */
export const UNLOCK_ATTEMPTS = 3;
/**
 * Prompt throttle: after this many dismissed prompts within `CANCEL_WINDOW_MS`, the renderer's
 * connect / unlock calls are refused for `CANCEL_COOLDOWN_MS`, so a compromised page cannot keep
 * re-opening the (genuine) prompt window the moment the user closes it.
 */
export const CANCEL_LIMIT = 3;
export const CANCEL_WINDOW_MS = 60_000;
export const CANCEL_COOLDOWN_MS = 60_000;
/**
 * NIP-46 approval links (`auth_url`): at most this many prompts per `AUTH_WINDOW_MS`, one at a
 * time — a misbehaving bunker cannot flood the user with approval windows.
 */
export const AUTH_LIMIT = 5;
export const AUTH_WINDOW_MS = 10 * 60_000;
const KEY_FILE = 'local.key';
const METHOD_FILE = 'method.json';
const MAX_KEY_FILE_BYTES = 64 * 1024;
/** What `SignerManager` is handed to resume a remembered bunker (never parsed as a URI). */
const RESUME_URI = 'bunker://resume';

/** The encrypted key file (core `KeyStore`), private on disk. */
export class FileKeyStore implements signerMod.KeyStore {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  async read(): Promise<Uint8Array | null> {
    await ensurePrivateDir(dirname(this.path));
    return readPrivateFile(this.path, MAX_KEY_FILE_BYTES);
  }
  async write(file: Uint8Array): Promise<void> {
    await ensurePrivateDir(dirname(this.path));
    await writePrivateFile(this.path, file);
  }
  /** Delete the key file from this device (ADR 0013 addendum: a forgotten passphrase). */
  async remove(): Promise<void> {
    await removePrivateFile(this.path);
  }
  /** True when a key file is there — also when it is not private (unlocking then says why). */
  async exists(): Promise<boolean> {
    try {
      return (await this.read()) !== null;
    } catch {
      return true;
    }
  }
}

interface StoredMethod {
  readonly v: 1;
  readonly method: UnlockMethod | null;
}

function parseStoredMethod(raw: unknown): StoredMethod | null {
  const o = raw as { v?: unknown; method?: unknown } | null;
  if (typeof o !== 'object' || o?.v !== 1) return null;
  if (o.method !== null && !(UNLOCK_METHODS as readonly unknown[]).includes(o.method)) return null;
  return { v: 1, method: o.method as UnlockMethod | null };
}

/** The error code prefix of a core error (`bad-passphrase`, `no-wallet`, `remote-signer`, …). */
function prefix(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return /^[a-z][a-z0-9-]*(?=:)/.exec(m)?.[0] ?? (e instanceof Error ? e.name : 'unknown');
}

/** `prefix(e)` for a log line: a code or a class name is short, so anything longer is not one. */
function reasonOf(e: unknown): string {
  const p = prefix(e);
  return p.length <= 40 ? p : 'unknown';
}

/**
 * Core signer errors → the codes the renderer understands (never a key, never a path).
 * What is reduced to `internal`, and a runtime that cannot run the local signer, is logged with
 * its reason (a code prefix or the error's class name, never its message): the renderer is told
 * only "internal error", and without this line nothing says why.
 */
function mapError(e: unknown, log: Logger): Error {
  if (e instanceof IpcError) return e;
  switch (prefix(e)) {
    case 'cancelled':
      return hostError('cancelled', 'the prompt was dismissed');
    case 'bad-passphrase':
      return hostError('forbidden', 'wrong passphrase (or a damaged key file)');
    case 'remote-signer':
      return hostError('remote-signer', 'the remote signer did not answer');
    case 'invalid-argument':
      return hostError('invalid-argument', e instanceof Error ? e.message : 'invalid argument');
    case 'no-signer':
      return hostError('no-signer', 'there is no local key on this device yet');
    case 'malformed':
    case 'unsupported-version':
    case 'weak-parameters':
    case 'excessive-parameters':
    case 'bad-key':
      return hostError('forbidden', `the key file cannot be used (${prefix(e)})`);
    case 'unsupported-runtime':
      log.error('the local signer cannot run here', { reason: reasonOf(e) });
      return hostError('forbidden', 'a local key cannot be used in this build of the app');
    default:
      log.error('the signer failed', { reason: reasonOf(e) });
      return hostError('internal', 'the signer failed');
  }
}

export interface Nip46Connector {
  readonly connect: typeof signerMod.connectBunker;
  readonly resume: typeof signerMod.resumeBunker;
}

export interface DesktopSignerOptions {
  /** `<userData>/signer` (created 0700). */
  readonly dir: string;
  readonly bridge: MainBridge;
  /** Main reported a real OS keychain (never Linux's `basic_text`). */
  readonly keychain: boolean;
  readonly log: Logger;
  /** Open the money plane for an unlocked signer (`create`: make a new NIP-60 wallet). */
  readonly openMoney: (signer: Signer, create: boolean) => Promise<MoneyPlane>;
  /**
   * Run `change` (which swaps the money plane) with the worker stopped, then start it again —
   * so its init carries the new signer's payments and no old worker talks to a new plane.
   */
  readonly swap: (change: () => Promise<void>) => Promise<void>;
  /** Tests: a NIP-46 connector over an in-memory relay. */
  readonly nip46?: Nip46Connector;
  /** Tests: the KDF floor for new key files. */
  readonly cost?: signerMod.KdfCost;
  /** Tests: the clock of the prompt throttle. */
  readonly now?: () => number;
}

export class DesktopSigner implements IdentityProvider {
  private readonly o: DesktopSignerOptions;
  private readonly log: Logger;
  private readonly manager: signerMod.SignerManager;
  readonly keyStore: FileKeyStore;
  private readonly methodFile: JsonFile<StoredMethod>;
  private readonly nip46: Nip46Connector;
  private methodValue: UnlockMethod | null = null;
  private rememberedValue = false;
  private lockedPubkey: NostrPubkey | null = null;
  private plane: MoneyPlane | undefined;
  /**
   * Lane P2-owed-viewer (independent review): the tail-authorisation writes of every plane closed
   * so far — `MoneyPlane.close` starts one per session still open, then closes its tail book, so
   * these are every write a closed plane makes (fix round 7: a tail PAY still waiting at a mint
   * then writes nothing). The host's quit waits for them (`flushTails`), and so does the next
   * plane's open (its book reads the same file, and owns it from then on).
   */
  private retiring: Promise<void> = Promise.resolve();
  /** Why the last money plane did not open (an error code prefix), or `null`. */
  private planeError: string | null = null;
  private busy = false;
  private closed = false;
  /** When the user dismissed recent prompts (the throttle). */
  private cancels: number[] = [];
  private coolUntil = 0;
  /** NIP-46 approval prompts: one open at a time, and when recent ones were shown. */
  private authOpen = false;
  private authTimes: number[] = [];
  private readonly listeners = new Set<(s: SignerStatus) => void>();

  // One flow's scratch state (flows are exclusive).
  /** The keychain's passphrase, handed to the manager instead of asking (it wipes it). */
  private preset: Uint8Array | null = null;
  /** Keep a copy of what the user types, to seal it in the keychain after success. */
  private capturing = false;
  private captured: Uint8Array | null = null;
  /** The next unlock prompt says the last passphrase was wrong. */
  private retry = false;
  /** Ask `connectBunker` for a resume blob; the blob it returned; one to resume from. */
  private remember = false;
  private resumeOut: Uint8Array | null = null;
  private resumeIn: Uint8Array | null = null;

  constructor(o: DesktopSignerOptions) {
    this.o = o;
    this.log = o.log.child('signer');
    this.keyStore = new FileKeyStore(join(o.dir, KEY_FILE));
    this.methodFile = new JsonFile(join(o.dir, METHOD_FILE), parseStoredMethod, this.log);
    this.nip46 = o.nip46 ?? { connect: signerMod.connectBunker, resume: signerMod.resumeBunker };
    this.manager = new signerMod.SignerManager({
      prompt: { ask: (kind) => this.askSecret(kind) },
      keyStore: this.keyStore,
      nip46: (uri) => this.openBunker(uri),
      ...(o.cost === undefined ? {} : { cost: o.cost }),
    });
  }

  // ---- IdentityProvider ----------------------------------------------------------------------

  signer(): Signer | undefined {
    const s = this.manager.current();
    return s !== null && !s.isLocked() ? s : undefined;
  }

  status(): Promise<SignerStatus> {
    return Promise.resolve(this.statusNow());
  }

  async me(): Promise<NostrPubkey | null> {
    return (await this.status()).pubkey;
  }

  private statusNow(): SignerStatus {
    const st = this.manager.status();
    const local = this.methodValue === 'passphrase' || this.methodValue === 'keychain';
    // A local key that is not unlocked yet still names its owner (the key file header).
    if (st.pubkey === null && local && this.lockedPubkey !== null)
      return {
        kind: 'local',
        pubkey: this.lockedPubkey,
        locked: true,
        supportsSignSecret: false,
        detail: 'Local key (locked)',
      };
    return st;
  }

  // ---- state for the host --------------------------------------------------------------------

  /** The money plane of the unlocked signer, if its wallet opened. */
  money(): MoneyPlane | undefined {
    return this.plane;
  }

  /**
   * Why the unlocked signer has no money plane, as an error code prefix (`journal-unreadable`,
   * `no-wallet`, `relay-down`, …), or `null`. Never a key, a path or a proof.
   */
  moneyError(): string | null {
    return this.plane === undefined ? this.planeError : null;
  }

  async info(): Promise<DesktopSignerInfo> {
    return {
      method: this.methodValue,
      hasLocalKey: await this.keyStore.exists(),
      keychain: this.o.keychain,
      remembered: this.rememberedValue,
    };
  }

  onStatus(cb: (s: SignerStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * At launch: load the chosen method and unlock by it — the keychain silently, a passphrase in
   * the prompt window, a remembered bunker by resuming. A failure leaves the signer locked.
   */
  async start(): Promise<void> {
    const loaded = await this.methodFile.load();
    this.methodValue = loaded.kind === 'ok' ? loaded.value.method : null;
    await this.readLockedPubkey();
    this.emit();
    try {
      await this.exclusive(async () => {
        if (this.methodValue === 'passphrase' || this.methodValue === 'keychain') {
          if (this.lockedPubkey === null) return;
          await this.unlockLocal(false);
        } else if (this.methodValue === 'nip46') {
          await this.resumeRemembered(false);
        }
      });
    } catch (e) {
      this.log.info('the signer stays locked at launch', { reason: prefix(e) });
    }
  }

  // ---- the renderer's calls ------------------------------------------------------------------

  connect(req: SignerConnectWire): Promise<SignerStatus> {
    return this.throttled(() =>
      this.exclusive(async () => {
        if (req.kind === 'local') await this.connectLocal();
        else await this.connectRemote();
        return this.statusNow();
      }),
    );
  }

  unlock(): Promise<SignerStatus> {
    return this.throttled(() => this.unlockNow());
  }

  private unlockNow(): Promise<SignerStatus> {
    return this.exclusive(async () => {
      const cur: (Signer & { unlock?: () => void }) | null = this.manager.current();
      if (cur !== null && cur.kind === 'nip46' && cur.isLocked() && cur.unlock !== undefined) {
        cur.unlock();
        await this.changed(true, false);
      } else if (this.methodValue === 'passphrase' || this.methodValue === 'keychain') {
        await this.unlockLocal(true);
      } else if (this.methodValue === 'nip46') {
        await this.resumeRemembered(true);
      } else fail('no-signer', 'no signer yet: connect one first');
      return this.statusNow();
    });
  }

  lock(): Promise<void> {
    return this.exclusive(async () => {
      await this.manager.lock();
      await this.changed(false, false);
    });
  }

  /** Forget the signer and everything the keychain holds for it. The key file stays. */
  signOut(): Promise<void> {
    return this.exclusive(async () => {
      await this.manager.disconnect();
      await this.forgetKeychain('passphrase');
      await this.forgetKeychain('nip46');
      this.rememberedValue = false;
      await this.setMethod(null);
      await this.changed(false, false);
    });
  }

  /**
   * ADR 0016: close the money plane and open it again for the same signer (the worker restarts
   * around it), with `beforeOpen` run in between — while no plane holds the wallet — so a
   * recovery phrase saved there is what the new plane derives from. No status change is
   * announced (the identity did not change). Refused while a signer flow runs.
   */
  reopenMoney(beforeOpen?: () => Promise<void>): Promise<void> {
    return this.exclusive(() => this.swapPlane(false, false, beforeOpen));
  }

  /**
   * Host shutdown: wipe the key, close the money plane and any NIP-46 session. The plane is closed
   * before the first `await`, so its tail writes have started when this returns its promise:
   * `flushTails` waits for them.
   */
  async close(): Promise<void> {
    this.closed = true;
    const old = this.plane;
    this.plane = undefined;
    this.retire(old);
    await this.manager.disconnect().catch(() => undefined);
  }

  /**
   * Every tail-authorisation write started so far has landed — those of the planes closed before
   * (sign-out, lock, a signer swap, shutdown) and of the current one. Never rejects.
   */
  async flushTails(): Promise<void> {
    await Promise.all([this.retiring, this.plane?.flushTails().catch(() => undefined)]);
  }

  // ---- flows ---------------------------------------------------------------------------------

  private async connectLocal(): Promise<void> {
    const hasKey = await this.keyStore.exists();
    const setup = await this.o.bridge.ask({
      kind: 'local-setup',
      hasKey,
      keychain: this.o.keychain,
    });
    if (setup?.kind !== 'local-setup') {
      wipeAnswer(setup);
      fail('cancelled', 'the prompt was dismissed');
    }
    if (setup.flow === 'remove') {
      await this.removeLocalKey();
      return;
    }
    const flow = setup.flow;
    const useKeychain = setup.method === 'keychain' && this.o.keychain;
    this.capturing = useKeychain;
    try {
      await this.localConnectLoop(flow);
      await this.readLockedPubkey();
      await this.forgetKeychain('nip46');
      this.rememberedValue = false;
      await this.recordLocalMethod(useKeychain);
    } finally {
      this.endFlow();
    }
    await this.changed(true, flow === 'generate');
  }

  /**
   * Delete the key file (a forgotten passphrase is otherwise a dead end), after the user confirms
   * in the prompt window ("Keep it" is the default). A local signer is signed out, its keychain
   * copy forgotten; a connected remote signer is left alone.
   */
  private async removeLocalKey(): Promise<void> {
    const a = await this.o.bridge.ask({ kind: 'remove-key' });
    if (a?.kind !== 'remove-key' || !a.confirm) fail('cancelled', 'the key was kept');
    if (this.manager.current()?.kind === 'local') await this.manager.disconnect();
    await this.keyStore.remove();
    this.lockedPubkey = null;
    await this.forgetKeychain('passphrase');
    if (this.methodValue === 'passphrase' || this.methodValue === 'keychain')
      await this.setMethod(null);
    this.log.info('local key removed from this device');
    await this.changed(false, false);
  }

  private async unlockLocal(interactive: boolean): Promise<void> {
    if (this.methodValue === 'keychain') {
      const r = await this.o.bridge.keychain('get', 'passphrase');
      if (r.value !== null) {
        this.preset = r.value;
        try {
          await this.manager.connect({ kind: 'local', flow: 'unlock' });
          await this.changed(interactive, false);
          return;
        } catch (e) {
          if (prefix(e) !== 'bad-passphrase') throw mapError(e, this.log);
          // The key file changed under the keychain's copy: drop it and ask the user.
          this.log.warn('the keychain passphrase no longer unlocks the key; asking instead');
          await this.forgetKeychain('passphrase');
        } finally {
          signerMod.wipe(this.preset);
          this.preset = null;
        }
      }
    }
    this.capturing = this.methodValue === 'keychain' && this.o.keychain;
    try {
      await this.localConnectLoop('unlock');
      if (this.capturing) await this.recordLocalMethod(true);
    } finally {
      this.endFlow();
    }
    await this.changed(interactive, false);
  }

  /** `manager.connect` for a local flow; a wrong passphrase is asked again, a few times. */
  private async localConnectLoop(flow: 'unlock' | 'import' | 'generate'): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.manager.connect({ kind: 'local', flow });
        return;
      } catch (e) {
        signerMod.wipe(this.captured);
        this.captured = null;
        if (flow === 'unlock' && prefix(e) === 'bad-passphrase' && attempt < UNLOCK_ATTEMPTS) {
          this.retry = true;
          continue;
        }
        throw mapError(e, this.log);
      }
    }
  }

  /** After a local connect: seal the typed passphrase (keychain) or drop any sealed copy. */
  private async recordLocalMethod(useKeychain: boolean): Promise<void> {
    if (useKeychain) {
      const r =
        this.captured === null
          ? { ok: false }
          : await this.o.bridge.keychain('put', 'passphrase', this.captured);
      if (r.ok) {
        if (await this.setMethod('keychain')) return;
        // Unrecorded, the sealed copy would outlive the choice: never keep a secret nobody uses.
        await this.forgetKeychain('passphrase');
        return;
      }
      this.log.warn('the OS keychain did not store the passphrase: it will be asked at launch');
    }
    await this.forgetKeychain('passphrase');
    await this.setMethod('passphrase');
  }

  private async connectRemote(): Promise<void> {
    const a = await this.o.bridge.ask({ kind: 'bunker', keychain: this.o.keychain });
    if (a?.kind !== 'bunker') {
      wipeAnswer(a);
      fail('cancelled', 'the prompt was dismissed');
    }
    let uri: string;
    try {
      uri = new TextDecoder('utf-8', { fatal: true }).decode(a.uri).trim();
    } catch {
      fail('invalid-argument', 'the bunker URI is not text');
    } finally {
      signerMod.wipe(a.uri);
    }
    this.remember = a.remember && this.o.keychain;
    try {
      await this.manager.connect({ kind: 'nip46', uri });
      await this.forgetKeychain('passphrase');
      if (this.resumeOut !== null) {
        const r = await this.o.bridge.keychain('put', 'nip46', this.resumeOut);
        this.rememberedValue = r.ok;
        if (!r.ok) this.log.warn('OS keychain refused to store the remote signer session');
      } else {
        await this.forgetKeychain('nip46');
        this.rememberedValue = false;
      }
      await this.setMethod('nip46');
    } catch (e) {
      throw mapError(e, this.log);
    } finally {
      this.endFlow();
    }
    await this.changed(true, false);
  }

  private async resumeRemembered(interactive: boolean): Promise<void> {
    const r = await this.o.bridge.keychain('get', 'nip46');
    if (r.value === null) {
      this.rememberedValue = false;
      fail('no-signer', 'connect your remote signer again');
    }
    this.resumeIn = r.value;
    try {
      await this.manager.connect({ kind: 'nip46', uri: RESUME_URI });
      this.rememberedValue = true;
    } catch (e) {
      // A bunker that is offline may come back: keep the session. A blob that is not one: drop it.
      if (prefix(e) === 'invalid-argument') {
        await this.forgetKeychain('nip46');
        this.rememberedValue = false;
      }
      throw mapError(e, this.log);
    } finally {
      this.endFlow();
    }
    await this.changed(interactive, false);
  }

  // ---- seams for SignerManager ---------------------------------------------------------------

  private async askSecret(
    kind: 'unlock-passphrase' | 'new-passphrase' | 'import-nsec',
  ): Promise<Uint8Array | null> {
    if (kind === 'unlock-passphrase' && this.preset !== null) {
      // Handed over once; the manager wipes what it is given, so give it a copy.
      const p = signerMod.secureCopy(this.preset);
      signerMod.wipe(this.preset);
      this.preset = null;
      return p;
    }
    if (this.closed) return null;
    const a = await this.o.bridge.ask(
      kind === 'unlock-passphrase' ? { kind, retry: this.retry } : { kind },
    );
    if (a?.kind !== 'secret') {
      wipeAnswer(a);
      return null;
    }
    if (kind === 'new-passphrase' && a.value.byteLength < MIN_NEW_PASSPHRASE_BYTES) {
      signerMod.wipe(a.value);
      throw hostError('invalid-argument', 'the passphrase is too short');
    }
    if (this.capturing && kind !== 'import-nsec') {
      signerMod.wipe(this.captured);
      this.captured = signerMod.secureCopy(a.value);
    }
    return a.value;
  }

  private async openBunker(
    uri: string,
  ): Promise<{ readonly bunker: signerMod.BunkerLike; readonly relays: readonly string[] }> {
    if (uri === RESUME_URI) {
      const blob = this.resumeIn;
      this.resumeIn = null;
      if (blob === null) throw new Error('invalid-argument: no remembered session');
      try {
        return await this.nip46.resume(blob, {
          onauth: (u) => {
            this.onAuthUrl(u);
          },
        });
      } finally {
        signerMod.wipe(blob);
      }
    }
    const s = await this.nip46.connect(uri, {
      remember: this.remember,
      onauth: (u) => {
        this.onAuthUrl(u);
      },
    });
    if (s.resume !== undefined) {
      signerMod.wipe(this.resumeOut);
      this.resumeOut = s.resume;
    }
    return { bunker: s.bunker, relays: s.relays };
  }

  /**
   * A NIP-46 `auth_url`: ask the user, in the prompt window, whether to open it (main opens it on
   * "Open in browser"). Only `https:` links; one prompt at a time, `AUTH_LIMIT` per window. It can
   * come at any time — during setup, or when the bunker wants approval to sign later.
   */
  private onAuthUrl(url: string): void {
    if (!isAuthUrl(url)) {
      this.log.warn('ignored a remote signer approval link that is not a plain https: URL');
      return;
    }
    const now = (this.o.now ?? Date.now)();
    this.authTimes = this.authTimes.filter((t) => now - t < AUTH_WINDOW_MS);
    if (this.authOpen || this.authTimes.length >= AUTH_LIMIT || this.closed) {
      this.log.info('ignored a remote signer approval link (one is open, or too many)');
      return;
    }
    this.authTimes.push(now);
    this.authOpen = true;
    void this.o.bridge.ask({ kind: 'bunker-auth', url }).then((a) => {
      this.authOpen = false;
      wipeAnswer(a);
    });
  }

  // ---- helpers -------------------------------------------------------------------------------

  /** Swap the money plane for the current signer (worker stopped around it), then announce. */
  private async changed(interactive: boolean, generated: boolean): Promise<void> {
    await this.swapPlane(interactive, generated);
    this.emit();
  }

  /**
   * Close the money plane, run `between` (ADR 0016: no plane holds the wallet then), open one
   * for the current signer. A failure of `between` is rethrown once the plane is open again.
   */
  private async swapPlane(
    interactive: boolean,
    generated: boolean,
    between?: () => Promise<void>,
  ): Promise<void> {
    const failed: { hit: boolean; e?: unknown } = { hit: false };
    await this.o.swap(async () => {
      const old = this.plane;
      this.plane = undefined;
      this.planeError = null;
      this.retire(old);
      // W8a: the closed plane's wallet drains (bounded, `PLANE_DRAIN_MS`) before a rotation moves
      // the counters file aside and before the next plane opens over it: its late watermark write
      // then lands before them, or never.
      await old?.drained();
      if (between !== undefined)
        try {
          await between();
        } catch (e) {
          failed.hit = true;
          failed.e = e;
        }
      const s = this.signer();
      if (s === undefined || this.closed) return;
      // The next plane's tail book reads the file the closed ones are still writing: after them,
      // or it would miss those tails and its next save would drop them (independent review). A
      // closed plane's book writes nothing later (fix round 7), so this book then owns the file.
      await this.retiring;
      // Shut down meanwhile: no plane after `close` (its key would never be wiped).
      if (this.isClosed()) return;
      try {
        this.plane = await this.o.openMoney(s, generated);
        return;
      } catch (e) {
        this.planeError = prefix(e);
        if (this.planeError === 'journal-unreadable') {
          // ADR 0014 amendment: the journal may hold ecash — refuse the wallet, keep the file.
          this.log.error(
            'the wallet journal on this device cannot be read: payments stay off, and the file is kept',
            { reason: this.planeError },
          );
          return;
        }
        if (this.planeError !== 'no-wallet' || !interactive) {
          this.log.warn('payments stay unavailable', { reason: this.planeError });
          return;
        }
      }
      const a = await this.o.bridge.ask({ kind: 'create-wallet' });
      if (a?.kind !== 'create-wallet' || !a.create) {
        this.log.info('no wallet: the user chose not to create one now');
        return;
      }
      try {
        this.plane = await this.o.openMoney(s, true);
        this.planeError = null;
        this.log.info('created a new NIP-60 wallet at the user’s request');
      } catch (e) {
        this.planeError = prefix(e);
        this.log.warn('the wallet could not be created', { reason: this.planeError });
      }
    });
    if (failed.hit) throw failed.e;
  }

  /** Read through a call: `closed` may change across an `await` (TypeScript narrows the field). */
  private isClosed(): boolean {
    return this.closed;
  }

  /**
   * Close `plane` (its sessions keep their tails) and remember its tail writes — and (W8a) its
   * wallet's drain, bounded: the host's quit waits for both (`flushTails`).
   */
  private retire(plane: MoneyPlane | undefined): void {
    if (plane === undefined) return;
    plane.close();
    const flushed = plane.flushTails().catch(() => undefined);
    const drained = plane.drained().catch(() => undefined);
    this.retiring = Promise.all([this.retiring, flushed, drained]).then(() => undefined);
  }

  private emit(): void {
    const st = this.statusNow();
    for (const cb of this.listeners) {
      try {
        cb(st);
      } catch {
        // a listener's failure is its own
      }
    }
  }

  private async readLockedPubkey(): Promise<void> {
    try {
      const file = await this.keyStore.read();
      this.lockedPubkey =
        file === null ? null : (signerMod.readKeyFileHeader(file).pubkey as NostrPubkey);
    } catch {
      this.lockedPubkey = null;
    }
  }

  /** Record the method; `false` when it could not be saved (it still applies until exit). */
  private async setMethod(method: UnlockMethod | null): Promise<boolean> {
    this.methodValue = method;
    try {
      await this.methodFile.save({ v: 1, method });
      return true;
    } catch {
      this.log.warn('could not save the unlock method');
      return false;
    }
  }

  private async forgetKeychain(slot: 'passphrase' | 'nip46'): Promise<void> {
    if (!this.o.keychain) return;
    const r = await this.o.bridge.keychain('forget', slot);
    if (!r.ok) this.log.warn('the OS keychain did not forget a secret', { slot });
  }

  private endFlow(): void {
    this.capturing = false;
    signerMod.wipe(this.captured);
    this.captured = null;
    signerMod.wipe(this.preset);
    this.preset = null;
    this.retry = false;
    this.remember = false;
    signerMod.wipe(this.resumeOut);
    this.resumeOut = null;
    signerMod.wipe(this.resumeIn);
    this.resumeIn = null;
  }

  /** A renderer-started flow: refused while cooling down; a dismissed prompt counts. */
  private async throttled<T>(f: () => Promise<T>): Promise<T> {
    const now = (this.o.now ?? Date.now)();
    if (now < this.coolUntil)
      fail('rate-limited', 'too many dismissed prompts: try again in a minute');
    try {
      return await f();
    } catch (e) {
      if (e instanceof IpcError && e.code === 'cancelled') {
        const t = (this.o.now ?? Date.now)();
        this.cancels = [...this.cancels.filter((c) => t - c < CANCEL_WINDOW_MS), t];
        if (this.cancels.length >= CANCEL_LIMIT) {
          this.coolUntil = t + CANCEL_COOLDOWN_MS;
          this.cancels = [];
          this.log.warn('prompts dismissed repeatedly: signer flows paused for a minute');
        }
      }
      throw e;
    }
  }

  private async exclusive<T>(f: () => Promise<T>): Promise<T> {
    if (this.closed) fail('no-signer', 'the app is shutting down');
    if (this.busy) fail('rate-limited', 'a signer prompt is already open');
    this.busy = true;
    try {
      return await f();
    } finally {
      this.busy = false;
    }
  }
}
