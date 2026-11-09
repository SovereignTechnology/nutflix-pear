/**
 * The host process loop (design §2): `HostIn` → re-validation with L6-0's guards → dispatch →
 * `HostOut`. Defense in depth: everything main already checked is checked again here.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { mocks } from '@sovit/core';

import { isHostOut } from '../../ipc/guards.js';
import type {
  HostOut,
  PlaySessionWire,
  ReplyMsg,
  SubMsg,
  UploadInputWire,
} from '../../ipc/protocol.js';
import { EXCLUDED_METHODS, IPC_V, LIMITS } from '../../ipc/protocol.js';
import type { StudioUploadArgs } from '../../ipc/worker-protocol.js';
import { handlers } from '../dispatch.js';
import { SignerIdentity } from '../identity.js';
import { seedVideos } from './support/catalog.js';
import { coreTestKit } from './support/core-helpers.js';
import type { Rig } from './support/rig.js';
import { eventually, rig } from './support/rig.js';

const kit = await coreTestKit();

let r: Rig | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

type Reply = Extract<HostOut, { kind: 'reply' }>;
type SubReply = Extract<HostOut, { kind: 'sub-reply' }>;
type Ev = Extract<HostOut, { kind: 'event' }>;

let nextId = 1;
function call(rr: Rig, wc: number, method: string, args: unknown[], extra: object = {}): number {
  const id = nextId++;
  rr.host.handle({ kind: 'call', wc, msg: { v: IPC_V, id, method, args }, ...extra });
  return id;
}

async function reply(rr: Rig, wc: number, id: number): Promise<ReplyMsg> {
  const out = await rr.until(
    (o): o is Reply => o.kind === 'reply' && o.wc === wc && o.msg.id === id,
    `reply ${String(id)}`,
  );
  return out.msg;
}

async function invoke(rr: Rig, wc: number, method: string, args: unknown[]): Promise<ReplyMsg> {
  return reply(rr, wc, call(rr, wc, method, args));
}

type SubBody =
  | {
      readonly op: 'sub';
      readonly subId: number;
      readonly topic: Extract<SubMsg, { op: 'sub' }>['topic'];
    }
  | { readonly op: 'unsub'; readonly subId: number };
function sub(rr: Rig, wc: number, msg: SubBody): void {
  rr.host.handle({ kind: 'sub', wc, msg: { v: IPC_V, ...msg } });
}

async function subReply(rr: Rig, wc: number, subId: number): Promise<ReplyMsg> {
  const all = (): SubReply[] =>
    rr.out.filter(
      (o): o is SubReply => o.kind === 'sub-reply' && o.wc === wc && o.msg.id === subId,
    );
  await eventually(() => all().length > 0, `sub-reply ${String(subId)}`);
  return all().at(-1)!.msg;
}

const errCode = (m: ReplyMsg): string | undefined => (m.ok ? undefined : m.error.code);

describe('HostIn → HostOut', () => {
  it('answers every call exactly once, with a structured-clone-safe, isHostOut-valid reply', async () => {
    r = await rig({ flags: { devMocks: true } });
    await r.ready();
    const settings = await invoke(r, 3, 'settings', []);
    expect(settings).toMatchObject({ ok: true, result: { theme: 'system' } });
    const balances = await invoke(r, 3, 'wallet.balances', []);
    expect(balances.ok && balances.result).toEqual({
      $map: [
        [mocks.MINTS.a, 21_000],
        [mocks.MINTS.b, 21_000],
      ],
    });
    const status = await invoke(r, 3, 'seeder.status', []);
    expect(status.ok && (status.result as { earned: { byMint: unknown } }).earned.byMint).toEqual({
      $map: [['https://mint.fixture-a.example', 0]],
    });
    const cleared = await invoke(r, 3, 'seeder.unban', ['e'.repeat(64)]);
    expect(cleared).toEqual({ v: IPC_V, id: cleared.id, ok: true, result: undefined });
    expect('result' in cleared).toBe(true); // void replies still carry the key (isReplyMsg)
    for (const o of r.out) {
      expect(isHostOut(o), JSON.stringify(o)).toBe(true);
      expect(structuredClone(o)).toEqual(o);
    }
    const replies = r.out.filter((o) => o.kind === 'reply');
    expect(new Set(replies.map((o) => o.msg.id)).size).toBe(replies.length);
  });

  it('re-validates: bad arguments are refused with invalid-argument, garbage is dropped', async () => {
    r = await rig();
    expect(errCode(await invoke(r, 1, 'stats', ['not-an-id']))).toBe('invalid-argument');
    expect(errCode(await invoke(r, 1, 'feed', [{ source: 'trending', extra: 1 }]))).toBe(
      'invalid-argument',
    );
    expect(errCode(await invoke(r, 1, 'image', ['http://img.example/a.png']))).toBe(
      'invalid-argument',
    );
    expect(errCode(await invoke(r, 1, 'constructor', []))).toBe('invalid-argument');
    const before = r.out.length;
    for (const junk of [
      null,
      1,
      'x',
      {},
      { kind: 'call' },
      { kind: 'call', wc: 0, msg: { id: 1 } },
    ])
      r.host.handle(junk);
    expect(r.out.length).toBe(before);
    // 4 refused calls (answered) + 6 junk messages (dropped).
    expect(
      r.log.lines.filter((l) => l.msg === 'refused a malformed message from main'),
    ).toHaveLength(10);
  });

  it('R5-R1: where auto top-ups do not run (--dev-mocks), no hold is listed and resume is refused; a malformed id never reaches it', async () => {
    r = await rig({ flags: { devMocks: true } });
    await r.ready();
    const holds = await invoke(r, 2, 'desktop.wallet.topUp.holds', []);
    expect(holds.ok && holds.result).toEqual([]);
    expect(errCode(await invoke(r, 2, 'desktop.wallet.topUp.resume', ['0123456789abcdef']))).toBe(
      'forbidden',
    );
    for (const bad of [[], ['0123456789ABCDEF'], [{ id: '0123456789abcdef' }]])
      expect(errCode(await invoke(r, 2, 'desktop.wallet.topUp.resume', bad))).toBe(
        'invalid-argument',
      );
  });

  it('D3/D5: wallet.send / receive / p2pkPubkey / keyset are unreachable over IPC', async () => {
    r = await rig({ flags: { devMocks: true } });
    const table = handlers(r.host.adapter) as unknown as Record<string, unknown>;
    for (const m of Object.keys(EXCLUDED_METHODS)) {
      expect(table[m], m).toBeUndefined();
      expect(errCode(await invoke(r, 2, m, [])), m).toBe('invalid-argument');
    }
  });

  it('ADR 0012: without a money plane (no signer, or --dev-mocks) every worker money call is answered payments-unavailable', async () => {
    for (const flags of [{}, { devMocks: true }]) {
      r = await rig({ flags });
      await r.ready();
      const challenge = `pay/1:${'ab'.repeat(64)}:${'cd'.repeat(32)}`;
      await expect(r.worker().request('pay.hello', { challenge })).rejects.toMatchObject({
        code: 'payments-unavailable',
      });
      await expect(
        r.worker().request('seller.keyset', {
          mint: 'https://mint.test' as never,
          id: `00${'ab'.repeat(7)}`,
        }),
      ).rejects.toMatchObject({ code: 'payments-unavailable' });
      await r.close();
    }
  });

  it('SE-1: studio.upload needs main’s file resolution; a file on any other call is refused', async () => {
    const viewer = new kit.TestSigner();
    r = await rig({
      identity: new SignerIdentity(viewer),
      worker: {
        handlers: { 'studio.upload': () => Promise.reject(new Error('aborted: test stops here')) },
      },
    });
    await r.ready();
    const input: UploadInputWire = {
      uploadId: 'a'.repeat(32) as never,
      file: `nf-file:${'b'.repeat(32)}`,
      title: 'Clip',
      description: '',
      tags: [],
      kind: 21,
      mints: [mocks.MINTS.a],
      satsPerBlock: 1 as never,
      split: { seeder: 50, creator: 50 },
      thumbnailChoice: { bytes: Uint8Array.of(0xff, 0xd8, 0xff), type: 'image/jpeg' },
    };
    expect(errCode(await invoke(r, 4, 'studio.upload', [input]))).toBe('file-token-invalid');
    expect(r.worker().calls('studio.upload')).toEqual([]);
    const file = { path: '/home/alice/clip.mp4', name: 'clip.mp4', size: 10 };
    const id = call(r, 4, 'studio.upload', [input], { file });
    expect(errCode(await reply(r, 4, id))).toBe('aborted');
    const asked = r.worker().calls('studio.upload')[0] as StudioUploadArgs;
    expect(asked).toEqual({
      uploadId: input.uploadId,
      path: '/home/alice/clip.mp4',
      name: 'clip.mp4',
      meta: {
        title: 'Clip',
        description: '',
        tags: [],
        kind: 21,
        mints: [mocks.MINTS.a],
        satsPerBlock: 1,
        split: { seeder: 50, creator: 50 },
      },
      thumbnailChoice: { hex: 'ffd8ff', type: 'image/jpeg' },
    });
    expect(JSON.stringify(asked)).not.toContain('nf-file:');
    const bad = call(r, 4, 'settings', [], { file });
    expect(errCode(await reply(r, 4, bad))).toBe('invalid-argument');
  });

  it('play: media-link to main BEFORE the reply; the renderer only gets nf-media://play/<token>', async () => {
    r = await rig({ flags: { devMocks: true } });
    await r.ready();
    const [v] = await seedVideos(kit, r.pool, new kit.TestSigner(), mocks.VIDEOS.slice(0, 1));
    const id = call(r, 5, 'play', [v!.video.id]);
    const rep = await reply(r, 5, id);
    expect(rep.ok).toBe(true);
    const wire = (rep as { result: PlaySessionWire }).result;
    const linkAt = r.out.findIndex((o) => o.kind === 'media-link');
    const replyAt = r.out.findIndex((o) => o.kind === 'reply' && o.msg.id === id);
    expect(linkAt).toBeGreaterThanOrEqual(0);
    expect(linkAt).toBeLessThan(replyAt);
    const link = r.out[linkAt] as Extract<HostOut, { kind: 'media-link' }>;
    expect(wire.source.url).toBe(`nf-media://play/${link.token}`);
    expect(JSON.stringify(rep)).not.toContain('127.0.0.1');
    // Session calls are bound to the webContents that opened it.
    expect(errCode(await invoke(r, 6, 'session.pause', [wire.sid]))).toBe('session-closed');
    expect((await invoke(r, 6, 'session.close', [wire.sid])).ok).toBe(true);
    expect(r.worker().calls('play.close')).toEqual([]);
    expect((await invoke(r, 5, 'session.pause', [wire.sid])).ok).toBe(true);
    expect((await invoke(r, 5, 'session.setPrefetchSeconds', [wire.sid, 5])).ok).toBe(true);
    expect((await invoke(r, 5, 'session.resume', [wire.sid])).ok).toBe(true);
    expect((await invoke(r, 5, 'session.close', [wire.sid])).ok).toBe(true);
    expect((await invoke(r, 5, 'session.close', [wire.sid])).ok).toBe(true); // idempotent
    expect(r.worker().calls('play.close')).toEqual([{ sid: wire.sid }]);
    expect(r.out.filter((o) => o.kind === 'media-link').at(-1)).toEqual({
      kind: 'media-link',
      token: link.token,
      url: null,
    });
  });

  it('topics: events reach the subscribing webContents only; caps, duplicates, foreign sessions', async () => {
    r = await rig({ flags: { devMocks: true } });
    await r.ready();
    const [v] = await seedVideos(kit, r.pool, new kit.TestSigner(), mocks.VIDEOS.slice(0, 1));
    const rep = await invoke(r, 7, 'play', [v!.video.id]);
    const sid = (rep as { result: PlaySessionWire }).result.sid;
    sub(r, 7, { op: 'sub', subId: 1, topic: { t: 'session.spend', sid } });
    sub(r, 7, { op: 'sub', subId: 2, topic: { t: 'wallet.change' } });
    expect((await subReply(r, 7, 1)).ok).toBe(true);
    expect((await subReply(r, 7, 2)).ok).toBe(true);
    // Same subId again → refused; a session of another webContents → session-closed.
    sub(r, 7, { op: 'sub', subId: 2, topic: { t: 'notifications' } });
    expect(errCode(await subReply(r, 7, 2))).toBe('invalid-argument');
    sub(r, 8, { op: 'sub', subId: 1, topic: { t: 'session.peers', sid } });
    expect(errCode(await subReply(r, 8, 1))).toBe('session-closed');

    r.worker().spend(sid, mocks.MINTS.a, 4, 4);
    const events = (): Ev[] => r!.out.filter((o): o is Ev => o.kind === 'event');
    await eventually(() => events().some((e) => e.msg.subId === 1), 'spend event');
    expect(events().find((e) => e.msg.subId === 1)).toEqual({
      kind: 'event',
      wc: 7,
      msg: { v: IPC_V, subId: 1, payload: { total: 4, ratePerMin: 240 } },
    });
    const walletEvents = events().filter((e) => e.msg.subId === 2);
    expect(walletEvents.map((e) => (e.msg.payload as { type: string }).type)).toEqual([
      'balance',
      'history',
    ]);
    expect(events().every((e) => e.wc === 7)).toBe(true);

    // Unsubscribe: nothing more arrives; unsub again is fine.
    sub(r, 7, { op: 'unsub', subId: 2 });
    sub(r, 7, { op: 'unsub', subId: 2 });
    const n = events().length;
    r.worker().spend(sid, mocks.MINTS.a, 1, 5);
    await eventually(() => events().length === n + 1, 'the spend event only');
    expect(events().at(-1)!.msg.subId).toBe(1);
  });

  it('caps subscriptions per webContents at LIMITS.subsPerWc (rate-limited)', async () => {
    r = await rig();
    for (let i = 0; i < LIMITS.subsPerWc; i++)
      sub(r, 9, { op: 'sub', subId: i, topic: { t: 'notifications' } });
    expect(r.host.topics.count(9)).toBe(LIMITS.subsPerWc);
    sub(r, 9, { op: 'sub', subId: 9999, topic: { t: 'notifications' } });
    expect(errCode(await subReply(r, 9, 9999))).toBe('rate-limited');
    sub(r, 10, { op: 'sub', subId: 1, topic: { t: 'notifications' } });
    expect((await subReply(r, 10, 1)).ok).toBe(true);
  });

  it('upload.progress may be subscribed BEFORE the upload starts, and is per webContents', async () => {
    const uploadId = 'd'.repeat(32);
    r = await rig({
      identity: new SignerIdentity(new kit.TestSigner()),
      worker: {
        handlers: {
          'studio.upload': (a, w) => {
            w.progress(a.uploadId, { stage: 'probing' });
            return new Promise(() => undefined);
          },
        },
      },
    });
    await r.ready();
    sub(r, 11, {
      op: 'sub',
      subId: 5,
      topic: { t: 'upload.progress', uploadId: uploadId as never },
    });
    sub(r, 12, {
      op: 'sub',
      subId: 5,
      topic: { t: 'upload.progress', uploadId: uploadId as never },
    });
    call(
      r,
      11,
      'studio.upload',
      [
        {
          uploadId,
          file: `nf-file:${'b'.repeat(32)}`,
          title: 't',
          description: '',
          tags: [],
          kind: 22,
          mints: [mocks.MINTS.a],
          satsPerBlock: 1,
          split: { seeder: 50, creator: 50 },
        },
      ],
      { file: { path: '/tmp/x.mp4', name: 'x.mp4', size: 1 } },
    );
    const ev = await r.until(
      (o): o is Ev => o.kind === 'event' && o.msg.subId === 5,
      'progress event',
    );
    expect(ev).toEqual({
      kind: 'event',
      wc: 11,
      msg: { v: IPC_V, subId: 5, payload: { stage: 'probing' } },
    });
    expect(r.out.filter((o) => o.kind === 'event' && o.wc === 12)).toEqual([]);
  });

  it('contracts v16: studio.probe asks the worker about the file main resolved, and only that', async () => {
    r = await rig();
    await r.ready();
    const token = `nf-file:${'c'.repeat(32)}`;
    const ok = await reply(
      r,
      11,
      call(r, 11, 'studio.probe', [token], {
        file: { path: '/home/u/Videos/clip.mp4', name: 'clip.mp4', size: 9 },
      }),
    );
    expect(ok.ok).toBe(true);
    expect(r.worker().calls('studio.probe')).toEqual([{ path: '/home/u/Videos/clip.mp4' }]);
    expect(ok.ok ? ok.result : undefined).toMatchObject({ height: 1080 });
    // Without main's swap there is no file: the renderer's token is never a path.
    const none = await invoke(r, 11, 'studio.probe', [token]);
    expect(none.ok ? undefined : none.error.code).toBe('file-token-invalid');
    // A file on any other call is refused.
    const other = await reply(
      r,
      11,
      call(r, 11, 'settings', [], { file: { path: '/tmp/x.mp4', name: 'x.mp4', size: 1 } }),
    );
    expect(other.ok ? undefined : other.error.code).toBe('invalid-argument');
    expect(r.worker().calls('studio.probe')).toHaveLength(1);
  });

  it('wc-gone closes that webContents’ sessions and subscriptions, and nothing else', async () => {
    r = await rig({ flags: { devMocks: true } });
    await r.ready();
    const [v] = await seedVideos(kit, r.pool, new kit.TestSigner(), mocks.VIDEOS.slice(0, 1));
    const a = (await invoke(r, 13, 'play', [v!.video.id])) as { result: PlaySessionWire };
    const b = (await invoke(r, 14, 'play', [v!.video.id])) as { result: PlaySessionWire };
    sub(r, 13, { op: 'sub', subId: 1, topic: { t: 'wallet.change' } });
    await subReply(r, 13, 1);
    r.host.handle({ kind: 'wc-gone', wc: 13 });
    await eventually(() => r!.worker().calls('play.close').length === 1, 'close');
    expect(r.worker().calls('play.close')).toEqual([{ sid: a.result.sid }]);
    expect(r.host.topics.count(13)).toBe(0);
    expect(r.host.adapter.sessions.get(14, b.result.sid)).toBeDefined();
  });

  it('serves image bytes for nf-media://img/<id> and null for unknown ids', async () => {
    r = await rig();
    r.host.handle({ kind: 'image', req: 1, id: 'nope' });
    const miss = await r.until(
      (o): o is Extract<HostOut, { kind: 'image' }> => o.kind === 'image' && o.req === 1,
      'image reply',
    );
    expect(miss).toEqual({ kind: 'image', req: 1, bytes: null, type: null });
    r.host.handle({ kind: 'image', req: 'x' });
    await r.until(
      (o): o is Extract<HostOut, { kind: 'image' }> => o.kind === 'image' && o.req === 1,
      'still one',
    );
  });

  it('caps calls in flight per webContents (rate-limited), and frees the slots afterwards', async () => {
    r = await rig({
      flags: { devMocks: true },
      worker: { handlers: { 'studio.ffmpeg': () => new Promise(() => undefined) } },
    });
    await r.ready();
    const ids = Array.from({ length: LIMITS.inflightPerWc }, () =>
      call(r!, 15, 'desktop.ffmpeg', [{ recheck: false }]),
    );
    expect(errCode(await invoke(r, 15, 'settings', []))).toBe('rate-limited');
    expect((await invoke(r, 16, 'settings', [])).ok).toBe(true);
    expect(ids).toHaveLength(LIMITS.inflightPerWc);
  });

  it('after stop() nothing is posted and the worker is gone', async () => {
    r = await rig();
    await r.ready();
    r.host.stop();
    const n = r.out.length;
    r.host.handle({
      kind: 'call',
      wc: 1,
      msg: { v: IPC_V, id: 1, method: 'settings', args: [] },
    });
    expect(r.out.length).toBe(n);
    expect(r.host.worker.state).toBe('stopped');
  });
});
