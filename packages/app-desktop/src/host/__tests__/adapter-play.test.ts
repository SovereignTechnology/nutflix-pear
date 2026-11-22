/**
 * Playback across processes (design §1) and the host backstop (§4): host-minted sids, the
 * blob-server link only ever sent to MAIN (`media-link`), ≤ 1 unpaused session per
 * webContents, `wc-gone`/worker death close everything, spend events debit the `--dev-mocks`
 * wallet, and with `--dev-mocks` nothing executes an auto top-up (SE-4; with the real wallet it
 * does since issue #2 — `auto-topup.test.ts`, `topup-host.test.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NostrEventId, Sats } from '@sovit/core';
import { mocks } from '@sovit/core';

import type { IpcError } from '../../ipc/errors.js';
import type { HostOut } from '../../ipc/protocol.js';
import type { PlayOpenArgs } from '../../ipc/worker-protocol.js';
import type { HostPlaySession } from '../sessions.js';
import { HostPlaySession as PlaySessionClass, SessionRegistry } from '../sessions.js';
import type { WorkerCall } from '../sessions.js';
import { handlers } from '../dispatch.js';
import { silentLogger as hostSilent } from '../log.js';
import { seedVideos } from './support/catalog.js';
import type { SeededVideo } from './support/catalog.js';
import { coreTestKit } from './support/core-helpers.js';
import type { Rig } from './support/rig.js';
import { eventually, rig } from './support/rig.js';

const kit = await coreTestKit();

let r: Rig | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return (e as IpcError).code;
  }
};

type MediaLink = Extract<HostOut, { kind: 'media-link' }>;
const links = (rr: Rig): MediaLink[] =>
  rr.out.filter((o): o is MediaLink => o.kind === 'media-link');

async function devRig(): Promise<{ r: Rig; videos: SeededVideo[] }> {
  r = await rig({ flags: { devMocks: true } });
  await r.ready();
  const videos = await seedVideos(kit, r.pool, new kit.TestSigner(), mocks.VIDEOS.slice(0, 4));
  return { r, videos };
}

describe('play() / openSession', () => {
  it('mints a 128-bit sid, opens the core in the worker, sends the link to MAIN only', async () => {
    const { r, videos } = await devRig();
    const v = videos[1]!.video; // two renditions? use the first by default
    const s = await r.host.adapter.openSession(7, v.id);
    expect(s.sid).toMatch(/^[0-9a-f]{32}$/);
    expect(s.source.url).toMatch(/^nf-media:\/\/play\/[0-9a-f]{64}$/);
    const opened = r.worker().calls('play.open') as PlayOpenArgs[];
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      sid: s.sid,
      videoId: v.id,
      rendition: { label: v.renditions[0]!.label, hyper: v.renditions[0]!.hyper },
      policy: v.price,
      prefetchSeconds: 30,
    });
    const link = links(r);
    expect(link).toEqual([
      {
        kind: 'media-link',
        token: s.token,
        url: `http://127.0.0.1:45000/${'t'.repeat(64)}/${s.sid}`,
      },
    ]);
    // The renderer's view carries the nf-media URL, never the loopback link or its port.
    const wire = JSON.stringify(s.toWire());
    expect(wire).not.toContain('127.0.0.1');
    expect(wire).not.toContain('45000');
    expect(s.toWire()).toEqual({
      sid: s.sid,
      videoId: v.id,
      rendition: v.renditions[0]!.label,
      source: { kind: 'url', url: `nf-media://play/${s.token}` },
      policy: v.price,
    });
  });

  it('distinct sids and tokens per session', async () => {
    const { r, videos } = await devRig();
    const a = await r.host.adapter.openSession(1, videos[0]!.video.id);
    const b = await r.host.adapter.openSession(2, videos[0]!.video.id);
    expect(new Set([a.sid, b.sid, a.token, b.token]).size).toBe(4);
  });

  it('refuses an unknown video / rendition before touching the worker', async () => {
    const { r, videos } = await devRig();
    expect(await codeOf(r.host.adapter.play('e'.repeat(64) as NostrEventId))).toBe('not-found');
    expect(await codeOf(r.host.adapter.play(videos[0]!.video.id, '4320p'))).toBe('not-found');
    expect(r.worker().calls('play.open')).toEqual([]);
  });

  it('no-balance when every accepted mint is empty', async () => {
    const { r, videos } = await devRig();
    const w = r.host.adapter.wallet as mocks.MockWallet;
    w.credit(mocks.MINTS.a, -Number(await w.balance(mocks.MINTS.a)), 'out', 'drain');
    const err = await r.host.adapter.play(videos[0]!.video.id).catch((e: unknown) => e as IpcError);
    expect(err).toMatchObject({ code: 'no-balance' });
    expect((err as IpcError).message).toMatch(/^no-balance: no balance at https:\/\/mint/);
    expect(r.worker().calls('play.open')).toEqual([]);
  });

  it('payments-unavailable without --dev-mocks (no wallet in Stage 1)', async () => {
    const rr = await rig();
    r = rr;
    await rr.ready();
    const vs = await seedVideos(kit, rr.pool, new kit.TestSigner(), mocks.VIDEOS.slice(0, 1));
    expect(await codeOf(rr.host.adapter.play(vs[0]!.video.id))).toBe('payments-unavailable');
    expect(await codeOf(rr.host.adapter.wallet.balances())).toBe('payments-unavailable');
    expect(rr.worker().calls('play.open')).toEqual([]);
  });

  it('no-seeders from the worker reaches the caller with its prefix', async () => {
    r = await rig({
      flags: { devMocks: true },
      worker: {
        handlers: {
          'play.open': () => {
            throw new Error('no-seeders: nobody is seeding this video right now');
          },
        },
      },
    });
    await r.ready();
    const vs = await seedVideos(kit, r.pool, new kit.TestSigner(), mocks.VIDEOS.slice(0, 1));
    const err = await r.host.adapter.play(vs[0]!.video.id).catch((e: unknown) => e as IpcError);
    expect(err).toMatchObject({ code: 'no-seeders' });
    expect(links(r)).toEqual([]);
  });
});

describe('the session backstop (≤ 1 unpaused session per webContents)', () => {
  it('opening a second session pauses the first; resuming the first pauses the second', async () => {
    const { r, videos } = await devRig();
    const a = r.host.adapter;
    const s1 = await a.openSession(3, videos[0]!.video.id);
    const s2 = await a.openSession(3, videos[1]!.video.id);
    const other = await a.openSession(4, videos[2]!.video.id);
    expect([s1.paused, s2.paused, other.paused]).toEqual([true, false, false]);
    expect(r.worker().calls('play.pause')).toEqual([{ sid: s1.sid }]);
    await s1.resumeAsync();
    expect([s1.paused, s2.paused, other.paused]).toEqual([false, true, false]);
    expect(r.worker().calls('play.resume')).toEqual([{ sid: s1.sid }]);
    const unpaused = (wc: number): number => a.sessions.ofOwner(wc).filter((s) => !s.paused).length;
    expect(unpaused(3)).toBe(1);
    expect(unpaused(4)).toBe(1);
  });

  it('two concurrent opens in one webContents still end with exactly one unpaused', async () => {
    const { r, videos } = await devRig();
    const a = r.host.adapter;
    await Promise.all([
      a.openSession(5, videos[0]!.video.id),
      a.openSession(5, videos[1]!.video.id),
      a.openSession(5, videos[2]!.video.id),
    ]);
    expect(a.sessions.ofOwner(5)).toHaveLength(3);
    expect(a.sessions.ofOwner(5).filter((s) => !s.paused)).toHaveLength(1);
  });

  it('closeOwner (wc-gone) closes every session of that webContents and revokes its links', async () => {
    const { r, videos } = await devRig();
    const a = r.host.adapter;
    const s1 = await a.openSession(6, videos[0]!.video.id);
    const s2 = await a.openSession(6, videos[1]!.video.id);
    const keep = await a.openSession(8, videos[0]!.video.id);
    await a.sessions.closeOwner(6);
    expect([s1.closed, s2.closed, keep.closed]).toEqual([true, true, false]);
    expect((r.worker().calls('play.close') as { sid: string }[]).map((c) => c.sid).sort()).toEqual(
      [s1.sid, s2.sid].sort(),
    );
    expect(
      links(r)
        .filter((l) => l.url === null)
        .map((l) => l.token)
        .sort(),
    ).toEqual([s1.token, s2.token].sort());
    expect(a.sessions.get(6, s1.sid)).toBeUndefined();
    expect(a.sessions.get(8, keep.sid)).toBe(keep);
    // Another owner's sid reads as unknown.
    expect(a.sessions.get(6, keep.sid)).toBeUndefined();
  });

  it('switchRendition opens the new rendition first, then closes the old; keeps pause + prefetch', async () => {
    const { r, videos } = await devRig();
    const a = r.host.adapter;
    // Raku has 3 renditions in the fixtures.
    const v = videos.find((x) => x.video.renditions.length > 1)!.video;
    const s1 = await a.openSession(9, v.id, v.renditions[0]!.label);
    await s1.setPrefetchAsync(12);
    await s1.pauseAsync();
    const s2: HostPlaySession = await s1.switchAsync(v.renditions[1]!.label);
    expect(s1.closed).toBe(true);
    expect(s2.closed).toBe(false);
    expect(s2.rendition).toBe(v.renditions[1]!.label);
    expect(s2.paused).toBe(true);
    expect(s2.prefetchSeconds).toBe(12);
    const opens = r.worker().calls('play.open') as PlayOpenArgs[];
    expect(opens.at(-1)).toMatchObject({ sid: s2.sid, prefetchSeconds: 12 });
    const order = r.worker().received.map((x) => x.m);
    expect(order.lastIndexOf('play.open')).toBeLessThan(order.lastIndexOf('play.close'));
    // A failed switch leaves the old session open.
    expect(await codeOf(s2.switchAsync('nope'))).toBe('not-found');
    expect(s2.closed).toBe(false);
  });

  it('a closed session refuses control calls (session-closed); close is idempotent', async () => {
    const { r, videos } = await devRig();
    const s = await r.host.adapter.openSession(2, videos[0]!.video.id);
    await s.closeAsync();
    await s.closeAsync();
    expect(r.worker().calls('play.close')).toHaveLength(1);
    for (const p of [s.pauseAsync(), s.resumeAsync(), s.setPrefetchAsync(3), s.switchAsync('x')])
      expect(await codeOf(p)).toBe('session-closed');
  });
});

// Fix round 4 (cross-lane review, HIGH): the host revoked a session the moment it closed — before
// the worker even heard `play.close` — so every PAY for the session's tail was refused. The money
// plane's revocation now waits for the worker's answer (its tail paid first), and quit closes every
// session through the worker before stopping it.
describe('closing a session: revoked only once the worker has paid its tail (fix round 4)', () => {
  function bare(worker: WorkerCall, registry = new SessionRegistry()) {
    const s = new PlaySessionClass(
      {
        sid: 'ab'.repeat(16) as HostPlaySession['sid'],
        token: 'cd'.repeat(32),
        owner: 1,
        videoId: 'ef'.repeat(32) as NostrEventId,
        title: 't',
        rendition: '720p',
        policy: mocks.VIDEOS[0]!.price,
        prefetchSeconds: 30,
      },
      {
        worker,
        mediaLink: () => undefined,
        log: hostSilent,
        registry,
        reopen: () => Promise.reject(new Error('not here')),
      },
    );
    registry.add(s);
    return s;
  }

  it('closeAsync: closed to the renderer at once; onSettled (the revocation) only after play.close answered', async () => {
    let answer: () => void = () => undefined;
    const order: string[] = [];
    const s = bare((m: string) => {
      order.push(`worker:${m}`);
      return new Promise<undefined>((resolve) => {
        answer = () => {
          order.push('worker:answered');
          resolve(undefined);
        };
      });
    });
    s.onClose(() => order.push('closed'));
    s.onSettled(() => order.push('settled'));
    const closing = s.closeAsync();
    expect(s.closed).toBe(true);
    await Promise.resolve();
    expect(order).toEqual(['closed', 'worker:play.close']);
    answer();
    await closing;
    expect(order).toEqual(['closed', 'worker:play.close', 'worker:answered', 'settled']);
  });

  it('a play.close that fails still settles; a worker gone settles at once; settling happens once', async () => {
    const failing = bare(() => Promise.reject(new Error('backend-down: x')));
    let n = 0;
    failing.onSettled(() => n++);
    await failing.closeAsync();
    expect(n).toBe(1);
    const gone = bare((() => new Promise(() => undefined)) as unknown as WorkerCall);
    let m = 0;
    gone.onSettled(() => m++);
    gone.markClosed();
    gone.markClosed();
    expect(m).toBe(1);
    gone.onSettled(() => m++); // registered late: runs at once
    expect(m).toBe(2);
  });

  // Lane P2-owed-viewer (ADR 0018 amendment): the money plane keeps a tail authorisation for what
  // the worker reported still unpaid — so the settle hooks must learn it, and learn "unknown" when
  // the worker could not say.
  it('onSettled learns what the worker reported unpaid at play.close; null when it could not say (a failing close, a worker gone)', async () => {
    const s = bare(() => Promise.resolve({ unpaid: 3 }));
    const seen: (number | null)[] = [];
    s.onSettled((u) => seen.push(u));
    await s.closeAsync();
    s.onSettled((u) => seen.push(u)); // registered late: the same answer
    expect(seen).toEqual([3, 3]);
    const failing = bare(() => Promise.reject(new Error('backend-down: x')));
    const f: (number | null)[] = [];
    failing.onSettled((u) => f.push(u));
    await failing.closeAsync();
    expect(f).toEqual([null]);
    const gone = bare((() => new Promise(() => undefined)) as unknown as WorkerCall);
    const g: (number | null)[] = [];
    gone.onSettled((u) => g.push(u));
    gone.markClosed();
    expect(g).toEqual([null]);
  });

  it('the adapter revokes the session on the money plane only after the worker answered play.close', async () => {
    const { r, videos } = await devRig();
    const s = await r.host.adapter.openSession(3, videos[0]!.video.id);
    const settled: string[] = [];
    s.onClose(() => settled.push('closed'));
    s.onSettled(() => settled.push('settled'));
    await s.closeAsync();
    expect(settled).toEqual(['closed', 'settled']);
    expect(r.worker().calls('play.close')).toHaveLength(1);
  });

  it('quit: Host.shutdown closes every session THROUGH the worker (tails paid) before it stops', async () => {
    const { r, videos } = await devRig();
    const a = await r.host.adapter.openSession(4, videos[0]!.video.id);
    const b = await r.host.adapter.openSession(5, videos[1]!.video.id);
    await r.host.shutdown(5000);
    const closed = r.worker().calls('play.close') as { sid: string }[];
    expect(closed.map((c) => c.sid).sort()).toEqual([a.sid, b.sid].sort());
    expect(a.closed && b.closed).toBe(true);
  });
});

describe('worker events', () => {
  it('spend debits the dev wallet and reaches onSpend; wrong mint or unknown sid is ignored', async () => {
    const { r, videos } = await devRig();
    const a = r.host.adapter;
    const w = a.wallet as mocks.MockWallet;
    const s = await a.openSession(1, videos[0]!.video.id);
    const spends: unknown[] = [];
    s.onSpend((x) => spends.push(x));
    const changes: unknown[] = [];
    a.wallet.onChange((e) => changes.push(e));
    const before = await w.balance(mocks.MINTS.a);
    r.worker().spend(s.sid, mocks.MINTS.a, 5, 5);
    r.worker().spend(s.sid, mocks.MINTS.b, 7, 12); // not a mint of this video
    r.worker().spend('1'.repeat(32), mocks.MINTS.a, 9, 9); // no such session
    r.worker().spend(s.sid, mocks.MINTS.a, 3, 8);
    await eventually(() => spends.length === 2, 'two spends');
    expect(spends).toEqual([
      { total: 5, ratePerMin: 300 },
      { total: 8, ratePerMin: 180 },
    ]);
    expect(await w.balance(mocks.MINTS.a)).toBe(before - 8);
    expect(await w.balance(mocks.MINTS.b)).toBe(21_000);
    expect(changes.filter((c) => (c as { type: string }).type === 'balance')).toHaveLength(2);
  });

  it('peers reach onPeers; nothing reaches a closed session', async () => {
    const { r, videos } = await devRig();
    const s = await r.host.adapter.openSession(1, videos[0]!.video.id);
    const seen: unknown[] = [];
    s.onPeers((p) => seen.push(p));
    const peer = {
      pubkey: 'c'.repeat(64) as never,
      sats: 3 as never,
      ratePerMin: 60 as never,
      blocks: 3,
    };
    r.worker().peers(s.sid, [peer]);
    await eventually(() => seen.length === 1, 'peers');
    await s.closeAsync();
    r.worker().peers(s.sid, [peer]);
    r.worker().spend(s.sid, mocks.MINTS.a, 1, 1);
    await eventually(() => r.worker().calls('play.close').length === 1, 'close');
    expect(seen).toHaveLength(1);
  });

  it('pear #123: a paid session’s addresses come from the worker, only while it is open', async () => {
    const seeder = {
      kind: 'hypercore' as const,
      id: 'c'.repeat(64),
      address: '203.0.113.4:49737',
      path: 'direct' as const,
    };
    r = await rig({
      flags: { devMocks: true },
      worker: { handlers: { 'play.addresses': () => ({ addresses: [seeder] }) } },
    });
    await r.ready();
    const [v] = await seedVideos(kit, r.pool, new kit.TestSigner(), mocks.VIDEOS.slice(0, 1));
    const s = await r.host.adapter.openSession(4, v!.video.id);
    expect(r.worker().calls('play.addresses')).toEqual([]);
    expect(await s.addresses()).toEqual([seeder]);
    // Through the dispatcher, on the caller's own session; another webContents gets nothing.
    const h = handlers(r.host.adapter);
    await expect(h['session.addresses']({ wc: 4 }, [s.sid])).resolves.toEqual([seeder]);
    expect(
      await codeOf(Promise.resolve().then(() => h['session.addresses']({ wc: 5 }, [s.sid]))),
    ).toBe('session-closed');
    // `session.stats` is a free NFX session's only.
    expect(await codeOf(Promise.resolve().then(() => h['session.stats']({ wc: 4 }, [s.sid])))).toBe(
      'session-closed',
    );
    expect(r.worker().calls('play.addresses')).toEqual([{ sid: s.sid }, { sid: s.sid }]);
    await s.closeAsync();
    expect(await codeOf(s.addresses())).toBe('session-closed');
    expect(r.worker().calls('play.addresses')).toHaveLength(2);
  });

  it('worker death drops every session and revokes every link without asking the worker', async () => {
    const { r, videos } = await devRig();
    const s = await r.host.adapter.openSession(1, videos[0]!.video.id);
    const first = r.worker();
    first.crash(1);
    await eventually(() => s.closed, 'session dropped');
    expect(links(r).at(-1)).toEqual({ kind: 'media-link', token: s.token, url: null });
    expect(first.calls('play.close')).toEqual([]);
    expect(await codeOf(r.host.adapter.play(videos[0]!.video.id))).toBe('backend-down');
  });
});

// Issue #2 changed Stage 1's rule for the REAL wallet only (auto top-ups execute there, behind
// their caps and first-funding confirm). With --dev-mocks (fake sats, no prompt window) a due
// top-up is still evaluated and logged, never executed — only the log line's wording changed.
describe('SE-4: with --dev-mocks nothing executes an auto top-up', () => {
  it.each([0, 100])(
    'belowSats %i: balances drain to 0, mintQuote is never called',
    async (below) => {
      const { r, videos } = await devRig();
      const a = r.host.adapter;
      const w = a.wallet as mocks.MockWallet;
      const mintQuote = vi.spyOn(w, 'mintQuote');
      // v5 (ADR 0010 item 5): the PAYING mint (a) is compared, the top-up is funded from
      // `fromMint` (b), and only mints on the user's own list are topped up (security review F4).
      // Before the review fixes this test funded from — and drained — the same mint, which the
      // contract says never fires.
      await a.updateSettings({
        defaultMints: [mocks.MINTS.a, mocks.MINTS.b],
        autoTopUp: { belowSats: below as Sats, fromMint: mocks.MINTS.b },
      });
      const s = await a.openSession(1, videos[0]!.video.id);
      const bal = Number(await w.balance(mocks.MINTS.a));
      let drained = false;
      w.onChange((e) => {
        if (e.type === 'balance' && e.mint === mocks.MINTS.a && e.balance === 0) drained = true;
      });
      r.worker().spend(s.sid, mocks.MINTS.a, bal, bal);
      await eventually(() => drained, 'the balance at mint a to reach 0');
      expect(mintQuote).not.toHaveBeenCalled();
      const due = r.log.lines.filter(
        (l) => l.msg === 'auto top-up would be due; not executed with --dev-mocks',
      );
      expect(due).toHaveLength(below > 0 ? 1 : 0);
    },
  );
});
