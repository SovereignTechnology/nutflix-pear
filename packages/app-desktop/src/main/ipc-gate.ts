/**
 * The IPC gate (design §2 "Rules", §3 row "IPC gate"): everything the renderer sends reaches
 * main through exactly three `ipcMain.handle` channels, and every message passes, in order:
 *
 *   1. the SENDER check — a webContents main created for the app, whose sending frame is the
 *      TOP frame and is at `app://nutflix/` (never a subframe, never another origin);
 *   2. the SHAPE check — L6-0's `isCallMsg` / `isSubMsg` / `isGrantFileMsg` (envelope, method
 *      allowlist = `MethodTable`, per-method argument guards, `LIMITS`);
 *   3. the per-webContents CAPS — `LIMITS.inflightPerWc` calls in flight, `LIMITS.subsPerWc`
 *      live subscriptions, a small grant concurrency cap (`rate-limited` beyond);
 *   4. SE-1 — `studio.upload`'s `FileToken` (and, contracts v16, `studio.probe`'s) is swapped
 *      for `{ path, name, size }` (single use, same webContents, unexpired) or the call is
 *      answered `file-token-invalid`;
 *   5. the confirm gate (`money-gate.ts`, a native dialog in main) — `wallet.melt`,
 *      `seeder.melt`, `nutzap`; an `updateSettings` patch that adds trusted mints or turns an
 *      auto top-up on; `studio.upload`, naming the file the token resolved to (security
 *      review F7/F8); and `desktop.signer.signOut` (ADR 0013).
 *
 * Only then is a `HostIn` posted to the host `utilityProcess`, which re-validates it. Handlers
 * never throw across `ipcMain.handle`: every path resolves a `ReplyMsg` (L6-0 rule). Replies
 * from the host are matched by (webContents, id); events are delivered only for subscriptions
 * this gate acknowledged for that webContents.
 *
 * Electron-free (structural types) so the tests drive fake senders and a fake host.
 */
import type {
  AnyCallMsg,
  EventMsg,
  HostIn,
  HostOut,
  Method,
  MethodTable,
  ReplyMsg,
  WireError,
} from '../ipc/protocol.js';
import { CHANNEL, EXCLUDED_METHODS, IPC_V, LIMITS } from '../ipc/protocol.js';
import { isCallMsg, isGrantFileMsg, isMsgId, isSubMsg } from '../ipc/guards.js';
import { wireError } from '../ipc/errors.js';
import type { FileTokenRegistry } from './file-tokens.js';
import type { Logger } from './log.js';
import { silentLogger } from './log.js';
import type { ConfirmRequest, MoneyGate, MoneyRequest } from './money-gate.js';
import { isMoneyMethod } from './money-gate.js';
import { isAppUrl } from './schemes.js';

/** Grants in flight per webContents (each costs an `lstat`). */
export const GRANTS_INFLIGHT_PER_WC = 4;

export interface GateFrame {
  readonly url: string;
  /** `null` for the top frame (`WebFrameMain.parent`). */
  readonly parent: unknown;
}

export interface GateWebContents {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, msg: EventMsg): void;
}

/** The part of `IpcMainInvokeEvent` the gate reads. */
export interface GateEvent {
  readonly sender: GateWebContents;
  readonly senderFrame: GateFrame | null;
}

export interface IpcGateDeps {
  /** Posts to the host; `false` when the host is not running. */
  post(msg: HostIn): boolean;
  readonly tokens: FileTokenRegistry;
  readonly moneyGate: MoneyGate;
  /** True for webContents main created to show the app (the window). */
  isAppWebContents(id: number): boolean;
  readonly log?: Logger;
}

interface WcState {
  readonly wc: GateWebContents;
  /** Calls in flight: id → resolver (money gate / file swap / host). */
  readonly calls: Map<number, (r: ReplyMsg) => void>;
  /** Subscriptions acknowledged by the host. */
  readonly subs: Set<number>;
  /** `sub`/`unsub` awaiting the host's ack: subId → resolver. */
  readonly acks: Map<number, (r: ReplyMsg) => void>;
  /** Method of each call in flight (to learn the settings from their replies). */
  readonly methods: Map<number, Method>;
  /** The settings the host last returned to this page (`settings` / `updateSettings`). */
  knownSettings: MethodTable['settings'][1] | undefined;
  grants: number;
}

function fail(id: number, error: WireError): ReplyMsg {
  return { v: IPC_V, id, ok: false, error };
}

/** The id to answer with before the message is known to be well formed. */
function idOf(raw: unknown, key: 'id' | 'subId'): number {
  if (typeof raw !== 'object' || raw === null) return 0;
  try {
    const v = (raw as Record<string, unknown>)[key];
    return isMsgId(v) ? v : 0;
  } catch {
    return 0;
  }
}

export class IpcGate {
  private readonly states = new Map<number, WcState>();
  private readonly log: Logger;

  constructor(private readonly deps: IpcGateDeps) {
    this.log = deps.log ?? silentLogger;
  }

  // ---- renderer → main ------------------------------------------------------------------

  /** `ipcMain.handle(CHANNEL.call)`. */
  async call(e: GateEvent, raw: unknown): Promise<ReplyMsg> {
    const id = idOf(raw, 'id');
    try {
      const st = this.sender(e);
      if (st === undefined) return this.refuse(id, 'forbidden', 'sender is not the app window');
      if (!isCallMsg(raw)) return this.refuse(id, 'invalid-argument', 'malformed call');
      const msg: AnyCallMsg = raw;
      if (Object.prototype.hasOwnProperty.call(EXCLUDED_METHODS, msg.method)) {
        return this.refuse(id, 'forbidden', 'method is not available to the renderer');
      }
      if (st.calls.has(msg.id)) return this.refuse(id, 'invalid-argument', 'duplicate call id');
      if (st.calls.size >= LIMITS.inflightPerWc) {
        return this.refuse(id, 'rate-limited', 'too many calls in flight');
      }
      return await new Promise<ReplyMsg>((resolve) => {
        st.calls.set(msg.id, resolve);
        st.methods.set(msg.id, msg.method);
        void this.relay(st, msg).catch(() => {
          this.settle(st, msg.id, fail(msg.id, wireError('internal', 'relay failed')));
        });
      });
    } catch {
      return fail(id, wireError('internal', 'gate failure'));
    }
  }

  /** `ipcMain.handle(CHANNEL.sub)`: subscribe / unsubscribe; the reply's `id` is the subId. */
  async sub(e: GateEvent, raw: unknown): Promise<ReplyMsg> {
    const id = idOf(raw, 'subId');
    try {
      const st = this.sender(e);
      if (st === undefined) return this.refuse(id, 'forbidden', 'sender is not the app window');
      if (!isSubMsg(raw)) return this.refuse(id, 'invalid-argument', 'malformed subscription');
      const subId = raw.subId;
      if (raw.op === 'sub') {
        if (st.subs.has(subId) || st.acks.has(subId)) {
          return this.refuse(id, 'invalid-argument', 'duplicate subscription id');
        }
        if (st.subs.size + st.acks.size >= LIMITS.subsPerWc) {
          return this.refuse(id, 'rate-limited', 'too many subscriptions');
        }
      } else {
        if (st.acks.has(subId)) return this.refuse(id, 'invalid-argument', 'subscription busy');
        // Stop delivering at once; unknown ids are acknowledged locally (idempotent).
        if (!st.subs.delete(subId)) return { v: IPC_V, id: subId, ok: true, result: undefined };
      }
      const reply = await new Promise<ReplyMsg>((resolve) => {
        st.acks.set(subId, resolve);
        if (!this.deps.post({ kind: 'sub', wc: st.wc.id, msg: raw })) {
          this.settleAck(
            st,
            subId,
            fail(subId, wireError('backend-down', 'the app backend is not running')),
          );
        }
      });
      if (raw.op === 'sub' && reply.ok) st.subs.add(subId);
      return reply;
    } catch {
      return fail(id, wireError('internal', 'gate failure'));
    }
  }

  /** `ipcMain.handle(CHANNEL.grant)`: SE-1 — a path from `webUtils.getPathForFile` → token. */
  async grant(e: GateEvent, raw: unknown): Promise<ReplyMsg> {
    try {
      const st = this.sender(e);
      if (st === undefined) return this.refuse(0, 'forbidden', 'sender is not the app window');
      if (!isGrantFileMsg(raw)) return this.refuse(0, 'invalid-argument', 'malformed grant');
      if (st.grants >= GRANTS_INFLIGHT_PER_WC) {
        return this.refuse(0, 'rate-limited', 'too many file grants in flight');
      }
      st.grants++;
      try {
        const r = await this.deps.tokens.grant(st.wc.id, raw.path);
        if (!r.ok) {
          this.log('warn', 'gate.refused', { code: r.error.code, grant: true });
          return fail(0, r.error);
        }
        return { v: IPC_V, id: 0, ok: true, result: r.token };
      } finally {
        st.grants--;
      }
    } catch {
      return fail(0, wireError('internal', 'gate failure'));
    }
  }

  // ---- host → main -----------------------------------------------------------------------

  /** A `HostOut` of kind reply / sub-reply / event (already `isHostOut`-checked by main). */
  fromHost(out: HostOut): void {
    if (out.kind !== 'reply' && out.kind !== 'sub-reply' && out.kind !== 'event') return;
    const st = this.states.get(out.wc);
    if (st === undefined) return;
    if (out.kind === 'reply') this.settle(st, out.msg.id, out.msg);
    else if (out.kind === 'sub-reply') this.settleAck(st, out.msg.id, out.msg);
    else {
      const ev = out.msg;
      if (!st.subs.has(ev.subId) && !st.acks.has(ev.subId)) return;
      if (st.wc.isDestroyed()) return;
      try {
        st.wc.send(CHANNEL.event, ev);
      } catch {
        // The renderer is going away; `webContentsGone` follows.
      }
    }
  }

  /**
   * The webContents was destroyed, or its page is being replaced (reload/crash): its
   * subscriptions and file tokens die, the host closes its sessions (`wc-gone`).
   */
  webContentsGone(wc: number): void {
    this.deps.tokens.dropWebContents(wc);
    const st = this.states.get(wc);
    if (st === undefined) return;
    this.states.delete(wc);
    const gone = wireError('session-closed', 'the page went away');
    for (const [id, r] of st.calls) r(fail(id, gone));
    for (const [id, r] of st.acks) r(fail(id, gone));
    // Cleared, so a relay still waiting on the money gate never posts for a gone page.
    st.calls.clear();
    st.methods.clear();
    st.acks.clear();
    st.subs.clear();
    this.deps.post({ kind: 'wc-gone', wc });
  }

  /** The host exited: every call in flight fails, every subscription is gone. */
  hostDown(): void {
    const down = wireError('backend-down', 'the app backend stopped');
    for (const st of this.states.values()) {
      for (const [id, r] of st.calls) r(fail(id, down));
      for (const [id, r] of st.acks) r(fail(id, down));
      st.calls.clear();
      st.methods.clear();
      st.acks.clear();
      st.subs.clear();
    }
  }

  /** Counts for tests and the e2e hook. */
  stats(wc: number): { calls: number; subs: number } {
    const st = this.states.get(wc);
    return { calls: st?.calls.size ?? 0, subs: st?.subs.size ?? 0 };
  }

  // ---- internals ---------------------------------------------------------------------------

  /** The sender check. `undefined` = refuse. Creates the webContents' state on first use. */
  private sender(e: GateEvent): WcState | undefined {
    const wc = e.sender;
    const frame = e.senderFrame;
    if (frame?.parent !== null) return undefined;
    if (!isAppUrl(frame.url)) return undefined;
    if (!this.deps.isAppWebContents(wc.id) || wc.isDestroyed()) return undefined;
    let st = this.states.get(wc.id);
    if (st === undefined) {
      st = {
        wc,
        calls: new Map(),
        subs: new Set(),
        acks: new Map(),
        methods: new Map(),
        knownSettings: undefined,
        grants: 0,
      };
      this.states.set(wc.id, st);
    }
    return st;
  }

  private refuse(id: number, code: WireError['code'], detail: string): ReplyMsg {
    this.log('warn', 'gate.refused', { code });
    return fail(id, wireError(code, detail));
  }

  private async relay(st: WcState, msg: AnyCallMsg): Promise<void> {
    let file: { path: string; name: string; size: number } | undefined;
    // Contracts v16: `studio.probe` names its file by a token too (its own, single use).
    if (msg.method === 'studio.upload' || msg.method === 'studio.probe') {
      const token = msg.method === 'studio.upload' ? msg.args[0].file : msg.args[0];
      file = this.deps.tokens.consume(st.wc.id, token);
      if (file === undefined) {
        this.log('warn', 'gate.refused', { code: 'file-token-invalid' });
        this.settle(
          st,
          msg.id,
          fail(msg.id, wireError('file-token-invalid', 'unknown, used or expired file token')),
        );
        return;
      }
    }
    let question: ConfirmRequest | undefined;
    // A probe only reads the file (ffprobe); publishing it is what is asked about (F7).
    if (file !== undefined && msg.method === 'studio.upload')
      question = {
        wc: st.wc.id,
        method: 'studio.upload',
        file: { name: file.name, size: file.size },
      };
    else if (msg.method === 'updateSettings')
      question = {
        wc: st.wc.id,
        method: 'updateSettings',
        args: msg.args,
        known: st.knownSettings,
      };
    else if (isMoneyMethod(msg.method))
      question = { wc: st.wc.id, method: msg.method, args: msg.args } as MoneyRequest;
    else if (msg.method === 'desktop.signer.signOut')
      question = { wc: st.wc.id, method: 'desktop.signer.signOut' };
    if (question !== undefined) {
      const ok = await this.deps.moneyGate.confirm(question).catch(() => false);
      if (!ok) {
        this.settle(st, msg.id, fail(msg.id, wireError('forbidden', 'not confirmed')));
        return;
      }
    }
    if (!st.calls.has(msg.id)) return; // the page went away meanwhile
    const posted = this.deps.post(
      file === undefined
        ? { kind: 'call', wc: st.wc.id, msg }
        : { kind: 'call', wc: st.wc.id, msg, file },
    );
    if (!posted) {
      this.settle(
        st,
        msg.id,
        fail(msg.id, wireError('backend-down', 'the app backend is not running')),
      );
    }
  }

  private settle(st: WcState, id: number, reply: ReplyMsg): void {
    const r = st.calls.get(id);
    if (r === undefined) return;
    st.calls.delete(id);
    const method = st.methods.get(id);
    st.methods.delete(id);
    if (reply.ok && (method === 'settings' || method === 'updateSettings'))
      st.knownSettings = reply.result as MethodTable['settings'][1];
    r(reply);
  }

  private settleAck(st: WcState, subId: number, reply: ReplyMsg): void {
    const r = st.acks.get(subId);
    if (r === undefined) return;
    st.acks.delete(subId);
    r(reply);
  }
}
