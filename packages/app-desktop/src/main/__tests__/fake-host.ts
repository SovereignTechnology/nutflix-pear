/**
 * Test double for the host `utilityProcess` (design §6 L6-A: "§3 fully tested against a
 * FakeHost — IPC dispatch backed by MockNetworkAdapter"). It speaks the real `HostIn`/`HostOut`
 * protocol: every message is structured-cloned (like `parentPort`), checked with `isHostIn`
 * (the real host re-validates), and dispatched to `@sovit/core`'s `MockNetworkAdapter`:
 *
 *   - results `dehydrate`d (Maps → `$map`), failures `toWireError`ed;
 *   - `play` / `session.switchRendition` mint a `sid` and a media token, post `media-link`
 *     BEFORE the reply, and answer a `PlaySessionWire` naming `nf-media://play/<token>`;
 *   - `session.*` drive the mock session; `session.peers`/`session.spend` topics subscribe to it;
 *   - `studio.upload` requires `HostIn.file` (SE-1) and reports progress on `upload.progress`;
 *   - `wc-gone` closes the webContents' sessions and drops its subscriptions;
 *   - `image` answers bytes for known ids.
 *
 * Not a test suite (no `.test.` in the name); shared by the main, preload-chain and renderer
 * tests. Deterministic: session ticks are driven by `tick()`, dispatch by microtasks.
 */
import { mocks } from '@sovit/core';
import type { NostrEventId, PlaySession } from '@sovit/core';
import type {
  HostIn,
  HostOut,
  PlaySessionWire,
  ReplyMsg,
  SessionId,
  Topic,
} from '../../ipc/protocol.js';
import { IPC_V } from '../../ipc/protocol.js';
import { isHostIn } from '../../ipc/guards.js';
import { toWireError, wireError } from '../../ipc/errors.js';
import { dehydrate } from '../../ipc/wiremap.js';

type MockAdapter = InstanceType<typeof mocks.MockNetworkAdapter>;
type MockOptions = ConstructorParameters<typeof mocks.MockNetworkAdapter>[0];

interface HostSession {
  readonly wc: number;
  readonly sid: SessionId;
  readonly token: string;
  session: PlaySession;
  paused: boolean;
  closed: boolean;
}

interface Sub {
  readonly wc: number;
  readonly subId: number;
  readonly unsubscribe: () => void;
}

let hexCounter = 0;
function hex32(): string {
  hexCounter += 1;
  return hexCounter.toString(16).padStart(32, '0');
}

export interface FakeHostOptions {
  readonly mock?: MockOptions;
  /** Refuse to answer (to test in-flight caps): calls are recorded but never replied to. */
  readonly stall?: boolean;
}

export class FakeHost {
  readonly adapter: MockAdapter;
  /** Every message received, after structured clone. */
  readonly received: HostIn[] = [];
  /** Messages that failed `isHostIn` (must stay empty: main never posts junk). */
  readonly rejected: unknown[] = [];
  readonly sessions = new Map<string, HostSession>();
  readonly subs = new Map<string, Sub>();
  running = true;
  stall: boolean;
  /** Session tick drivers registered by the mock (`setInterval` injection). */
  private readonly ticks = new Set<() => void>();
  private pending = 0;
  private idle: (() => void)[] = [];

  constructor(
    private readonly out: (msg: HostOut) => void,
    opts: FakeHostOptions = {},
  ) {
    this.stall = opts.stall ?? false;
    this.adapter = new mocks.MockNetworkAdapter({
      ...opts.mock,
      setInterval: (fn) => {
        this.ticks.add(fn);
        return () => this.ticks.delete(fn);
      },
    });
  }

  /** `utilityProcess.postMessage`: false when the host is down (like `HostLink.post`). */
  readonly post = (msg: HostIn): boolean => {
    if (!this.running) return false;
    const copy: unknown = structuredClone(msg);
    this.pending += 1;
    queueMicrotask(() => {
      void this.dispatch(copy).finally(() => {
        this.pending -= 1;
        if (this.pending === 0) for (const f of this.idle.splice(0)) f();
      });
    });
    return true;
  };

  /** Resolves once every message posted so far (and any it triggered) has been handled. */
  async settled(maxRounds = 50): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      if (this.pending > 0) {
        await new Promise<void>((r) => this.idle.push(r));
        continue;
      }
      await Promise.resolve();
      if (this.pending === 0) return;
    }
    throw new Error(`FakeHost.settled: still busy after ${String(maxRounds)} rounds`);
  }

  /** Fires one tick of every live mock session (spend/peers events). */
  tick(): void {
    for (const t of [...this.ticks]) t();
  }

  /** Open (not closed) sessions, optionally for one webContents. */
  openSessions(wc?: number): HostSession[] {
    return [...this.sessions.values()].filter(
      (s) => !s.closed && (wc === undefined || s.wc === wc),
    );
  }

  // ---- dispatch ----------------------------------------------------------------------------

  private send(msg: HostOut): void {
    this.out(structuredClone(msg));
  }

  private reply(
    wc: number,
    id: number,
    r: { ok: true; result: unknown } | { ok: false; error: unknown },
  ): void {
    const msg: ReplyMsg = r.ok
      ? { v: IPC_V, id, ok: true, result: r.result }
      : { v: IPC_V, id, ok: false, error: toWireError(r.error) };
    this.send({ kind: 'reply', wc, msg });
  }

  private async dispatch(raw: unknown): Promise<void> {
    if (!isHostIn(raw)) {
      this.rejected.push(raw);
      return;
    }
    this.received.push(raw);
    switch (raw.kind) {
      case 'call': {
        if (this.stall) return;
        const { wc, msg } = raw;
        try {
          const result = await this.call(wc, msg.method, msg.args, raw.file);
          this.reply(wc, msg.id, { ok: true, result: dehydrate(result) });
        } catch (err: unknown) {
          this.reply(wc, msg.id, { ok: false, error: err });
        }
        return;
      }
      case 'sub': {
        const { wc, msg } = raw;
        const key = `${String(wc)}:${String(msg.subId)}`;
        if (msg.op === 'unsub') {
          this.subs.get(key)?.unsubscribe();
          this.subs.delete(key);
        } else {
          const unsubscribe = this.subscribe(wc, msg.subId, msg.topic);
          if (unsubscribe === undefined) {
            this.send({
              kind: 'sub-reply',
              wc,
              msg: {
                v: IPC_V,
                id: msg.subId,
                ok: false,
                error: wireError('session-closed', 'no such session'),
              },
            });
            return;
          }
          this.subs.set(key, { wc, subId: msg.subId, unsubscribe });
        }
        this.send({
          kind: 'sub-reply',
          wc,
          msg: { v: IPC_V, id: msg.subId, ok: true, result: undefined },
        });
        return;
      }
      case 'wc-gone': {
        for (const s of this.openSessions(raw.wc)) await this.closeSession(s);
        for (const [k, s] of this.subs) {
          if (s.wc === raw.wc) {
            s.unsubscribe();
            this.subs.delete(k);
          }
        }
        return;
      }
      case 'image': {
        const known = /^thumb[0-9]+$/.test(raw.id) || raw.id === 'avatar';
        this.send({
          kind: 'image',
          req: raw.req,
          bytes: known ? new Uint8Array([0x89, 0x50, 0x4e, 0x47]) : null,
          type: known ? 'image/png' : null,
        });
        return;
      }
      case 'prompt-answer':
      case 'keychain-result':
      case 'confirm-result':
        // ADR 0013 / 0016: main's prompt window, keychain or native confirm answering the host;
        // this fake asks nothing.
        return;
    }
  }

  private emit(wc: number, subId: number, payload: unknown): void {
    this.send({ kind: 'event', wc, msg: { v: IPC_V, subId, payload: dehydrate(payload) } });
  }

  private subscribe(wc: number, subId: number, topic: Topic): (() => void) | undefined {
    const a = this.adapter;
    switch (topic.t) {
      case 'seeder.status':
        return a.seeder.onStatus((s) => {
          this.emit(wc, subId, s);
        });
      case 'notifications':
        return a.notifications((n) => {
          this.emit(wc, subId, n);
        });
      case 'wallet.change':
        return a.wallet.onChange((e) => {
          this.emit(wc, subId, e);
        });
      case 'session.peers':
      case 'session.spend': {
        const s = this.sessions.get(topic.sid);
        if (s === undefined || s.closed || s.wc !== wc) return undefined;
        return topic.t === 'session.peers'
          ? s.session.onPeers((p) => {
              this.emit(wc, subId, p);
            })
          : s.session.onSpend((p) => {
              this.emit(wc, subId, p);
            });
      }
      case 'upload.progress': {
        const key = `upload:${topic.uploadId}`;
        const list = this.uploadSubs.get(key) ?? [];
        const entry = { wc, subId };
        list.push(entry);
        this.uploadSubs.set(key, list);
        return () => {
          const l = this.uploadSubs.get(key) ?? [];
          this.uploadSubs.set(
            key,
            l.filter((x) => x !== entry),
          );
        };
      }
      case 'signer.status':
      case 'recovery.progress':
        // ADR 0013 / 0016: the fake adapter's signer never changes and it runs no restore.
        return () => undefined;
    }
  }

  private readonly uploadSubs = new Map<string, { wc: number; subId: number }[]>();

  private open(wc: number, session: PlaySession): PlaySessionWire {
    const sid = hex32() as SessionId;
    const token = `tok${hex32()}`;
    // media-link BEFORE the reply that names the token (HostOut contract).
    this.send({ kind: 'media-link', token, url: `http://127.0.0.1:47000/${token}` });
    this.sessions.set(sid, { wc, sid, token, session, paused: false, closed: false });
    return {
      sid,
      videoId: session.videoId,
      rendition: session.rendition,
      source: { kind: 'url', url: `nf-media://play/${token}` },
      policy: session.policy,
    };
  }

  private async closeSession(s: HostSession): Promise<void> {
    if (s.closed) return;
    s.closed = true;
    this.send({ kind: 'media-link', token: s.token, url: null });
    await s.session.close();
  }

  private sessionOf(wc: number, sid: unknown): HostSession {
    const s = typeof sid === 'string' ? this.sessions.get(sid) : undefined;
    if (s === undefined || s.closed || s.wc !== wc) {
      throw new Error('session-closed: no such session');
    }
    return s;
  }

  private async call(
    wc: number,
    method: string,
    args: readonly unknown[],
    file: { path: string; name: string; size: number } | undefined,
  ): Promise<unknown> {
    const a = this.adapter;
    switch (method) {
      case 'play': {
        const s = await a.play(args[0] as NostrEventId, args[1] as string | undefined);
        // Host backstop (design §4): at most one unpaused session per webContents.
        for (const o of this.openSessions(wc)) {
          if (!o.paused) {
            o.paused = true;
            o.session.pause();
          }
        }
        return this.open(wc, s);
      }
      case 'session.pause': {
        const s = this.sessionOf(wc, args[0]);
        s.paused = true;
        s.session.pause();
        return undefined;
      }
      case 'session.resume': {
        const s = this.sessionOf(wc, args[0]);
        for (const o of this.openSessions(wc)) {
          if (o !== s && !o.paused) {
            o.paused = true;
            o.session.pause();
          }
        }
        s.paused = false;
        s.session.resume();
        return undefined;
      }
      case 'session.setPrefetchSeconds':
        this.sessionOf(wc, args[0]).session.setPrefetchSeconds(args[1] as number);
        return undefined;
      case 'session.switchRendition': {
        const s = this.sessionOf(wc, args[0]);
        const next = await s.session.switchRendition(args[1] as string);
        await this.closeSession(s);
        return this.open(wc, next);
      }
      case 'session.close': {
        const s = this.sessionOf(wc, args[0]);
        await this.closeSession(s);
        return undefined;
      }
      case 'image':
        return `nf-media://img/thumb${String(this.received.length)}`;
      case 'desktop.ffmpeg':
        return { found: true, path: '/usr/bin/ffmpeg', version: '8.1.2', os: 'linux' };
      case 'studio.upload': {
        if (file === undefined) throw new Error('file-token-invalid: no file');
        const input = args[0] as Record<string, unknown> & { uploadId: string };
        const { uploadId, file: _token, thumbnailChoice, ...meta } = input;
        const subs = (): { wc: number; subId: number }[] =>
          this.uploadSubs.get(`upload:${uploadId}`) ?? [];
        const video = await a.studio.upload(
          {
            ...(meta as unknown as Omit<Parameters<MockAdapter['studio']['upload']>[0], 'file'>),
            file: file.path,
            ...(typeof thumbnailChoice === 'number' ? { thumbnailChoice } : {}),
          },
          (p) => {
            const wire =
              p.stage === 'thumbnails'
                ? {
                    stage: 'thumbnails',
                    candidates: p.candidates.map((_c, i) => `nf-media://img/thumb${String(i)}`),
                  }
                : p;
            for (const s of subs()) if (s.wc === wc) this.emit(wc, s.subId, wire);
          },
        );
        this.lastUpload = { path: file.path, name: file.name, size: file.size };
        return video;
      }
      // Contracts v16: the path is main's swap of the probe's own token, never the renderer's.
      case 'studio.probe': {
        if (file === undefined) throw new Error('file-token-invalid: no file');
        this.lastProbe = { path: file.path, name: file.name, size: file.size };
        return a.studio.probe(file.path);
      }
      default: {
        const [obj, fn] = method.split('.') as [string, string | undefined];
        const owner: unknown =
          fn === undefined ? a : (a as unknown as Record<string, unknown>)[obj];
        const f = (owner as Record<string, unknown>)[fn ?? obj];
        if (typeof f !== 'function') throw new Error(`not-found: ${method}`);
        return await (f as (...x: unknown[]) => Promise<unknown>).apply(owner, [...args]);
      }
    }
  }

  /** The last file `studio.upload` received (SE-1: from main's token swap). */
  lastUpload: { path: string; name: string; size: number } | undefined;
  lastProbe: { path: string; name: string; size: number } | undefined;
}
