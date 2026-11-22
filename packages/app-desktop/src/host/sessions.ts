/**
 * `PlaySession` across processes (design §1) and the host's session backstop (§4: at most ONE
 * unpaused session per webContents; `wc-gone` closes all of them).
 *
 * The host mints `sid` (128-bit hex) and a separate 256-bit media token per session. The worker's
 * loopback blob-server link goes to MAIN as `media-link {token, url}`, never into the renderer's
 * result: the renderer only ever sees `nf-media://play/<token>`. Closing a session revokes the
 * link (`url: null`) and tells the worker (`play.close`, after which its link 404s).
 *
 * Owner `0` is the in-process caller (`DesktopNetworkAdapter.play()` used directly — tests and
 * the conformance suite); webContents ids are ≥ 1.
 */
import type {
  NostrEventId,
  PeerSpend,
  PlaySession,
  PlaySourceAddress,
  PricePolicy,
  Sats,
  Unsubscribe,
} from '@sovit/core';

import type { NfMediaPlayUrl, PlaySessionWire, SessionId } from '../ipc/protocol.js';
import type { WorkerMethod, WorkerMethodTable } from '../ipc/worker-protocol.js';
import { hostError } from './errors.js';
import type { Logger } from './log.js';

export type WorkerCall = <M extends WorkerMethod>(
  m: M,
  a: WorkerMethodTable[M][0],
) => Promise<WorkerMethodTable[M][1]>;

export interface SessionDeps {
  readonly worker: WorkerCall;
  readonly mediaLink: (token: string, url: string | null) => void;
  readonly log: Logger;
  /** Opens the replacement session for `switchRendition` (same owner, same video). */
  readonly reopen: (from: HostPlaySession, label: string) => Promise<HostPlaySession>;
  readonly registry: SessionRegistry;
}

export interface SessionInit {
  readonly sid: SessionId;
  readonly token: string;
  readonly owner: number;
  readonly videoId: NostrEventId;
  readonly title: string;
  readonly rendition: string;
  readonly policy: PricePolicy;
  readonly prefetchSeconds: number;
}

interface SpendPayload {
  readonly total: Sats;
  readonly ratePerMin: Sats;
}

export class HostPlaySession implements PlaySession {
  readonly sid: SessionId;
  readonly token: string;
  readonly owner: number;
  readonly videoId: NostrEventId;
  readonly title: string;
  readonly rendition: string;
  readonly policy: PricePolicy;
  readonly source: { readonly kind: 'url'; readonly url: NfMediaPlayUrl };
  private readonly d: SessionDeps;
  private pausedValue = false;
  private closedValue = false;
  private prefetch: number;
  private readonly peerCbs = new Set<(p: readonly PeerSpend[]) => void>();
  private readonly spendCbs = new Set<(s: SpendPayload) => void>();
  private readonly closeCbs = new Set<() => void>();
  private readonly settledCbs = new Set<(unpaid: number | null) => void>();
  private settledValue = false;
  /** What the worker reported unpaid at `play.close` (`null`: it could not say). */
  private unpaidValue: number | null = null;

  constructor(init: SessionInit, deps: SessionDeps) {
    this.sid = init.sid;
    this.token = init.token;
    this.owner = init.owner;
    this.videoId = init.videoId;
    this.title = init.title;
    this.rendition = init.rendition;
    this.policy = init.policy;
    this.prefetch = init.prefetchSeconds;
    this.source = { kind: 'url', url: `nf-media://play/${init.token}` };
    this.d = deps;
  }

  get paused(): boolean {
    return this.pausedValue;
  }
  get closed(): boolean {
    return this.closedValue;
  }
  get prefetchSeconds(): number {
    return this.prefetch;
  }

  /** The renderer's view: data only (`sid` instead of methods). */
  toWire(): PlaySessionWire {
    return {
      sid: this.sid,
      videoId: this.videoId,
      rendition: this.rendition,
      source: this.source,
      policy: this.policy,
    };
  }

  // ---- PlaySession (contract; fire-and-forget for the void ones) -------------------------

  onPeers(cb: (peers: readonly PeerSpend[]) => void): Unsubscribe {
    this.peerCbs.add(cb);
    return () => this.peerCbs.delete(cb);
  }

  onSpend(cb: (s: SpendPayload) => void): Unsubscribe {
    this.spendCbs.add(cb);
    return () => this.spendCbs.delete(cb);
  }

  setPrefetchSeconds(sec: number): void {
    this.setPrefetchAsync(sec).catch(() => undefined);
  }

  pause(): void {
    this.pauseAsync().catch(() => undefined);
  }

  resume(): void {
    this.resumeAsync().catch(() => undefined);
  }

  switchRendition(label: string): Promise<PlaySession> {
    return this.switchAsync(label);
  }

  close(): Promise<void> {
    return this.closeAsync();
  }

  /**
   * Contracts v19 (ADR 0024): where each seeder `onPeers` names is connected now. Other hosts'
   * addresses: asked for only while the viewer shows them; passed on, never logged or kept.
   */
  async addresses(): Promise<readonly PlaySourceAddress[]> {
    this.assertOpen();
    return (await this.d.worker('play.addresses', { sid: this.sid })).addresses;
  }

  // ---- awaited variants (what the IPC dispatcher calls) ----------------------------------

  async pauseAsync(): Promise<void> {
    this.assertOpen();
    if (this.pausedValue) return;
    this.pausedValue = true;
    await this.d.worker('play.pause', { sid: this.sid });
  }

  /** Resuming pauses every other unpaused session of the same owner first (backstop). */
  async resumeAsync(): Promise<void> {
    this.assertOpen();
    await this.d.registry.pauseOthers(this);
    if (!this.pausedValue) return;
    this.pausedValue = false;
    await this.d.worker('play.resume', { sid: this.sid });
  }

  async setPrefetchAsync(sec: number): Promise<void> {
    this.assertOpen();
    this.prefetch = sec;
    await this.d.worker('play.prefetch', { sid: this.sid, seconds: sec });
  }

  /** Opens the new rendition's session FIRST; the old one is closed only once that worked. */
  async switchAsync(label: string): Promise<HostPlaySession> {
    this.assertOpen();
    const next = await this.d.reopen(this, label);
    await this.closeAsync();
    return next;
  }

  /**
   * Idempotent. Revokes the media link even when the worker cannot be reached. Fix round 4: the
   * `onSettled` hooks (the money plane's revocation of this session) run only once the worker has
   * answered `play.close` — it pays the session's tail before it answers, and a PAY needs the
   * session to be authorised — or once that call failed (the worker's own bound, or it is gone).
   * Lane P2-owed-viewer: they learn what the worker reported still unpaid (`null` when it could
   * not say), for the money plane's tail authorisation.
   */
  async closeAsync(): Promise<void> {
    if (this.closedValue) return;
    this.closeLocally();
    let unpaid: number | null = null;
    try {
      unpaid = (await this.d.worker('play.close', { sid: this.sid })).unpaid;
    } catch {
      this.d.log.debug('play.close failed (worker down?); link already revoked');
    } finally {
      this.settle(unpaid);
    }
  }

  /** The worker is gone: drop everything without asking it (nothing more can be paid now). */
  markClosed(): void {
    this.closeLocally();
    this.settle(null);
  }

  /**
   * Called once nothing more will be paid for this session as a session: after the worker
   * answered `play.close` (its tail paid, or what is left of it counted: `unpaid`), or when the
   * worker is gone (`unpaid` null: unknown). Where the money plane revokes it — and keeps a tail.
   */
  onSettled(cb: (unpaid: number | null) => void): void {
    if (this.settledValue) cb(this.unpaidValue);
    else this.settledCbs.add(cb);
  }

  private settle(unpaid: number | null): void {
    if (this.settledValue) return;
    this.settledValue = true;
    this.unpaidValue = unpaid;
    for (const cb of this.settledCbs) {
      try {
        cb(unpaid);
      } catch {
        // listeners must not break closing
      }
    }
    this.settledCbs.clear();
  }

  /** Closed to the renderer: registry, media link, listeners — the worker not asked yet. */
  private closeLocally(): void {
    if (this.closedValue) return;
    this.closedValue = true;
    this.d.registry.remove(this);
    this.d.mediaLink(this.token, null);
    this.peerCbs.clear();
    this.spendCbs.clear();
    for (const cb of this.closeCbs) {
      try {
        cb();
      } catch {
        // listeners must not break closing
      }
    }
    this.closeCbs.clear();
  }

  /** Called once when the session closes (the topic registry drops its subscriptions). */
  onClose(cb: () => void): void {
    if (this.closedValue) cb();
    else this.closeCbs.add(cb);
  }

  // ---- worker events ---------------------------------------------------------------------

  emitPeers(peers: readonly PeerSpend[]): void {
    if (this.closedValue) return;
    for (const cb of this.peerCbs) cb(peers);
  }

  emitSpend(s: SpendPayload): void {
    if (this.closedValue) return;
    for (const cb of this.spendCbs) cb(s);
  }

  private assertOpen(): void {
    if (this.closedValue) throw sessionClosed();
  }
}

function sessionClosed(): Error {
  return hostError('session-closed', 'this playback session is closed');
}

/** Every open session, by sid and by owner. */
export class SessionRegistry {
  private readonly bySid = new Map<string, HostPlaySession>();

  add(s: HostPlaySession): void {
    this.bySid.set(s.sid, s);
  }

  remove(s: HostPlaySession): void {
    if (this.bySid.get(s.sid) === s) this.bySid.delete(s.sid);
  }

  /** The open session `sid` IF it belongs to `owner` (another owner's sid reads as unknown). */
  get(owner: number, sid: string): HostPlaySession | undefined {
    const s = this.bySid.get(sid);
    return s?.owner === owner && !s.closed ? s : undefined;
  }

  /** Any owner (worker events). */
  bySessionId(sid: string): HostPlaySession | undefined {
    const s = this.bySid.get(sid);
    return s !== undefined && !s.closed ? s : undefined;
  }

  ofOwner(owner: number): HostPlaySession[] {
    return [...this.bySid.values()].filter((s) => s.owner === owner && !s.closed);
  }

  all(): HostPlaySession[] {
    return [...this.bySid.values()].filter((s) => !s.closed);
  }

  /** Backstop: pause every unpaused session of `keep.owner` except `keep`. */
  async pauseOthers(keep: { readonly owner: number; readonly sid: string }): Promise<void> {
    const others = this.ofOwner(keep.owner).filter((s) => s.sid !== keep.sid && !s.paused);
    await Promise.all(others.map((s) => s.pauseAsync().catch(() => undefined)));
  }

  /** `wc-gone`: close every session of `owner`. */
  async closeOwner(owner: number): Promise<void> {
    await Promise.all(this.ofOwner(owner).map((s) => s.closeAsync()));
  }

  /** Worker died: every session is gone, links revoked, nothing asked of the worker. */
  dropAll(): void {
    for (const s of this.all()) s.markClosed();
  }

  /** Fix round 4 (quit): close every session through the worker, so each tail is paid first. */
  async closeAll(): Promise<void> {
    await Promise.all(this.all().map((s) => s.closeAsync()));
  }
}
