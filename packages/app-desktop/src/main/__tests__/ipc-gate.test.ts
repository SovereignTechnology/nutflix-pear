/**
 * Design §3 row "IPC gate": sender frame, method allowlist, guards, raw path, flood — against a
 * `FakeHost` backed by `MockNetworkAdapter`. Plus SE-1 token swapping, the money gate, event
 * routing and the lifecycle (webContents gone, host down).
 */
import { describe, expect, it } from 'vitest';
import { mocks } from '@sovit/core';
import type { ReplyMsg } from '../../ipc/protocol.js';
import { CHANNEL, LIMITS } from '../../ipc/protocol.js';
import { callMsg, createHarness, eventFrom, fileStat, topFrame } from './harness.js';

const { VIDEOS, MINTS } = mocks;
const VIDEO = VIDEOS[0]!;

function expectError(r: ReplyMsg, code: string): void {
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.error.code).toBe(code);
    expect(r.error.message.startsWith(`${code}: `)).toBe(true);
  }
}

function uploadArgs(file: unknown, uploadId = 'b'.repeat(32)): unknown[] {
  return [
    {
      uploadId,
      file,
      title: 'My video',
      description: '',
      tags: [],
      kind: 21,
      mints: [MINTS.a],
      satsPerBlock: 2,
      split: { seeder: 50, creator: 50 },
    },
  ];
}

describe('IPC gate — sender check', () => {
  it('relays a call from the app window top frame and returns the host reply', async () => {
    const h = createHarness();
    const r = await h.gate.call(h.ev(), callMsg('video', [VIDEO.id]));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.result as { id: string }).id).toBe(VIDEO.id);
    expect(h.host.received).toHaveLength(1);
    expect(h.host.rejected).toHaveLength(0);
  });

  it.each([
    ['a subframe', { url: 'app://nutflix/index.html', parent: {} }],
    ['another origin', topFrame('https://evil.example/')],
    ['a file: page', topFrame('file:///home/u/index.html')],
    ['a look-alike host', topFrame('app://nutflix.evil/index.html')],
    ['a user-info trick', topFrame('app://x@nutflix/index.html')],
    ['a destroyed frame (null)', null],
  ])('refuses %s with forbidden and never reaches the host', async (_n, frame) => {
    const h = createHarness();
    for (const send of [
      () => h.gate.call(eventFrom(h.wc, frame), callMsg('me', [])),
      () =>
        h.gate.sub(eventFrom(h.wc, frame), {
          v: 1,
          op: 'sub',
          subId: 1,
          topic: { t: 'notifications' },
        }),
      () => h.gate.grant(eventFrom(h.wc, frame), { v: 1, path: '/tmp/x.mp4' }),
    ]) {
      expectError(await send(), 'forbidden');
    }
    await h.host.settled();
    expect(h.host.received).toHaveLength(0);
  });

  it('refuses a webContents main did not create for the app, and a destroyed one', async () => {
    const h = createHarness({ appWcIds: [1] });
    expectError(await h.gate.call(h.ev(h.other), callMsg('me', [])), 'forbidden');
    h.wc.destroyed = true;
    expectError(await h.gate.call(h.ev(h.wc), callMsg('me', [])), 'forbidden');
    await h.host.settled();
    expect(h.host.received).toHaveLength(0);
  });
});

describe('IPC gate — shape check', () => {
  it.each([
    ['an unknown method', callMsg('eval', ['1+1'])],
    ['an inherited name', callMsg('__proto__', [])],
    [
      'wallet.send (D3, excluded)',
      callMsg('wallet.send', [1, { p2pk: '02' + 'a'.repeat(64), mint: MINTS.a }]),
    ],
    ['wallet.receive (D3, excluded)', callMsg('wallet.receive', [{ mint: MINTS.a, proofs: [] }])],
    ['wallet.p2pkPubkey (D5, excluded)', callMsg('wallet.p2pkPubkey', [])],
    ['wallet.keyset (D5, excluded)', callMsg('wallet.keyset', [MINTS.a, 'kid'])],
    ['bad arguments', callMsg('video', ['not-hex'])],
    ['an extra argument', callMsg('me', [1])],
    ['an unknown key', { ...callMsg('me', []), extra: true }],
    ['a wrong version', { ...callMsg('me', []), v: 2 }],
    ['a non-object', 'me'],
    ['null', null],
  ])('refuses %s with invalid-argument before the host', async (_n, raw) => {
    const h = createHarness();
    expectError(await h.gate.call(h.ev(), raw), 'invalid-argument');
    await h.host.settled();
    expect(h.host.received).toHaveLength(0);
  });

  it('answers with the caller id when it is well formed, 0 otherwise', async () => {
    const h = createHarness();
    const r = await h.gate.call(h.ev(), callMsg('video', ['x'], 4242));
    expect(r.id).toBe(4242);
    expect((await h.gate.call(h.ev(), { id: -1 })).id).toBe(0);
  });

  it('refuses a duplicate id in flight', async () => {
    const h = createHarness({ stall: true });
    const first = h.gate.call(h.ev(), callMsg('me', [], 77));
    expectError(await h.gate.call(h.ev(), callMsg('me', [], 77)), 'invalid-argument');
    h.gate.hostDown();
    expectError(await first, 'backend-down');
  });
});

describe('IPC gate — SE-1 file tokens', () => {
  it('refuses a raw path in studio.upload (never a token swap, never the host)', async () => {
    const h = createHarness();
    h.files.set('/home/u/secret.key', fileStat('file'));
    expectError(
      await h.gate.call(h.ev(), callMsg('studio.upload', uploadArgs('/home/u/secret.key'))),
      'invalid-argument',
    );
    await h.host.settled();
    expect(h.host.received).toHaveLength(0);
  });

  it('refuses a well-formed but unknown token with file-token-invalid', async () => {
    const h = createHarness();
    expectError(
      await h.gate.call(h.ev(), callMsg('studio.upload', uploadArgs(`nf-file:${'c'.repeat(32)}`))),
      'file-token-invalid',
    );
    await h.host.settled();
    expect(h.host.received).toHaveLength(0);
  });

  it('swaps a granted token for {path,name,size} only on studio.upload, once', async () => {
    const h = createHarness();
    h.files.set('/home/u/Videos/clip.mp4', fileStat('file', 734_003_200));
    const g = await h.gate.grant(h.ev(), { v: 1, path: '/home/u/Videos/clip.mp4' });
    expect(g.ok).toBe(true);
    const token = g.ok ? (g.result as string) : '';
    expect(token).toMatch(/^nf-file:[0-9a-f]{32}$/);
    const r = await h.gate.call(h.ev(), callMsg('studio.upload', uploadArgs(token)));
    expect(r.ok).toBe(true);
    const call = h.host.received.find((m) => m.kind === 'call');
    expect(call?.kind === 'call' ? call.file : undefined).toEqual({
      path: '/home/u/Videos/clip.mp4',
      name: 'clip.mp4',
      size: 734_003_200,
    });
    expect(h.host.lastUpload?.path).toBe('/home/u/Videos/clip.mp4');
    // Single use.
    expectError(
      await h.gate.call(h.ev(), callMsg('studio.upload', uploadArgs(token))),
      'file-token-invalid',
    );
  });

  it('contracts v16: studio.probe swaps its own token, once, and asks nothing', async () => {
    const h = createHarness();
    const seen: unknown[] = [];
    const gate = h.gate as unknown as {
      deps: { moneyGate: { confirm: (r: unknown) => Promise<boolean> } };
    };
    gate.deps.moneyGate.confirm = (r) => {
      seen.push(r);
      return Promise.resolve(false);
    };
    h.files.set('/home/u/Videos/clip.mp4', fileStat('file', 1234));
    const g = await h.gate.grant(h.ev(), { v: 1, path: '/home/u/Videos/clip.mp4' });
    const token = g.ok ? (g.result as string) : '';
    const r = await h.gate.call(h.ev(), callMsg('studio.probe', [token]));
    expect(r.ok).toBe(true);
    expect(h.host.lastProbe).toEqual({
      path: '/home/u/Videos/clip.mp4',
      name: 'clip.mp4',
      size: 1234,
    });
    // Nothing is published, so nothing is asked.
    expect(seen).toEqual([]);
    // Single use: the upload needs a token of its own.
    expectError(await h.gate.call(h.ev(), callMsg('studio.probe', [token])), 'file-token-invalid');
    expectError(
      await h.gate.call(h.ev(), callMsg('studio.upload', uploadArgs(token))),
      'file-token-invalid',
    );
    // A raw path is never a probe's file.
    expectError(
      await h.gate.call(h.ev(), callMsg('studio.probe', ['/home/u/Videos/clip.mp4'])),
      'invalid-argument',
    );
  });

  it('a token from another webContents is refused (and burnt)', async () => {
    const h = createHarness();
    h.files.set('/home/u/a.mp4', fileStat('file'));
    const g = await h.gate.grant(h.ev(h.wc), { v: 1, path: '/home/u/a.mp4' });
    const token = g.ok ? (g.result as string) : '';
    expectError(
      await h.gate.call(h.ev(h.other), callMsg('studio.upload', uploadArgs(token))),
      'file-token-invalid',
    );
    expectError(
      await h.gate.call(h.ev(h.wc), callMsg('studio.upload', uploadArgs(token))),
      'file-token-invalid',
    );
  });

  it('an expired token is refused', async () => {
    const h = createHarness();
    h.files.set('/home/u/a.mp4', fileStat('file'));
    const g = await h.gate.grant(h.ev(), { v: 1, path: '/home/u/a.mp4' });
    h.clock.now += 10 * 60 * 1000;
    expectError(
      await h.gate.call(h.ev(), callMsg('studio.upload', uploadArgs(g.ok ? g.result : ''))),
      'file-token-invalid',
    );
  });

  it.each([
    ['an empty path', ''],
    ['a relative path', 'Videos/clip.mp4'],
    ['a path with NUL', '/tmp/a\u0000.mp4'],
    ['a number', 42],
  ])('grant refuses %s', async (_n, path) => {
    const h = createHarness();
    expectError(await h.gate.grant(h.ev(), { v: 1, path }), 'invalid-argument');
    expect(h.tokens.count()).toBe(0);
  });

  it.each([
    ['a symlink', 'symlink'],
    ['a directory', 'dir'],
    ['a device', 'device'],
  ] as const)('grant refuses %s (lstat: regular files only)', async (_n, kind) => {
    const h = createHarness();
    h.files.set('/home/u/thing', fileStat(kind));
    expectError(await h.gate.grant(h.ev(), { v: 1, path: '/home/u/thing' }), 'unsupported-input');
    expectError(await h.gate.grant(h.ev(), { v: 1, path: '/home/u/missing' }), 'unsupported-input');
    expect(h.tokens.count()).toBe(0);
  });

  it('webContents gone: its tokens die with it', async () => {
    const h = createHarness();
    h.files.set('/home/u/a.mp4', fileStat('file'));
    await h.gate.grant(h.ev(), { v: 1, path: '/home/u/a.mp4' });
    expect(h.tokens.count(1)).toBe(1);
    h.gate.webContentsGone(1);
    expect(h.tokens.count(1)).toBe(0);
  });
});

describe('IPC gate — caps (flood)', () => {
  it(`answers rate-limited past ${String(LIMITS.inflightPerWc)} calls in flight, per webContents`, async () => {
    const h = createHarness({ stall: true });
    const inflight: Promise<ReplyMsg>[] = [];
    for (let i = 0; i < LIMITS.inflightPerWc; i++)
      inflight.push(h.gate.call(h.ev(), callMsg('me', [])));
    expectError(await h.gate.call(h.ev(), callMsg('me', [])), 'rate-limited');
    // Another webContents has its own budget.
    const theirs = h.gate.call(h.ev(h.other), callMsg('me', []));
    expect(h.gate.stats(1).calls).toBe(LIMITS.inflightPerWc);
    expect(h.gate.stats(2).calls).toBe(1);
    h.gate.hostDown();
    for (const r of await Promise.all([...inflight, theirs])) expectError(r, 'backend-down');
    expect(h.gate.stats(1).calls).toBe(0);
  });

  it(`answers rate-limited past ${String(LIMITS.subsPerWc)} subscriptions`, async () => {
    const h = createHarness();
    const acks = await Promise.all(
      Array.from({ length: LIMITS.subsPerWc }, (_x, i) =>
        h.gate.sub(h.ev(), { v: 1, op: 'sub', subId: i + 1, topic: { t: 'notifications' } }),
      ),
    );
    expect(acks.every((a) => a.ok)).toBe(true);
    expectError(
      await h.gate.sub(h.ev(), { v: 1, op: 'sub', subId: 9999, topic: { t: 'notifications' } }),
      'rate-limited',
    );
    expectError(
      await h.gate.sub(h.ev(), { v: 1, op: 'sub', subId: 1, topic: { t: 'notifications' } }),
      'invalid-argument',
    );
  });

  it('caps concurrent grants', async () => {
    const h = createHarness();
    let release: (() => void) | undefined;
    const slow = new Promise<void>((r) => {
      release = r;
    });
    const tokens = h.tokens as unknown as { deps: { lstat: (p: string) => Promise<unknown> } };
    const orig = tokens.deps.lstat;
    tokens.deps.lstat = async (p) => {
      await slow;
      return orig(p);
    };
    const pending = Array.from({ length: 4 }, () =>
      h.gate.grant(h.ev(), { v: 1, path: '/x/a.mp4' }),
    );
    expectError(await h.gate.grant(h.ev(), { v: 1, path: '/x/a.mp4' }), 'rate-limited');
    release?.();
    await Promise.all(pending);
  });
});

describe('IPC gate — money gate (Stage 2 hook)', () => {
  it.each([
    [
      'wallet.melt',
      [
        {
          mint: MINTS.a,
          quoteId: 'q1',
          amount: 10,
          feeReserve: 1,
          expiry: 2_000_000_000,
          state: 'UNPAID',
        },
      ],
    ],
    ['seeder.melt', [MINTS.a, 'lnbc1500n1ptest']],
    ['nutzap', [VIDEO.id, 21, MINTS.a]],
  ])(
    'asks before relaying %s; a refusal is forbidden and never reaches the host',
    async (method, args) => {
      const h = createHarness();
      h.money.allow = false;
      expectError(await h.gate.call(h.ev(), callMsg(method, args)), 'forbidden');
      expect(h.money.asked).toEqual([method]);
      await h.host.settled();
      expect(h.host.received).toHaveLength(0);
      h.money.allow = true;
      await h.gate.call(h.ev(), callMsg(method, args));
      expect(h.host.received.filter((m) => m.kind === 'call')).toHaveLength(1);
    },
  );

  it('a page that goes away while the confirmation is pending never reaches the host', async () => {
    const h = createHarness();
    let answer: ((ok: boolean) => void) | undefined;
    const gate = h.gate as unknown as { deps: { moneyGate: { confirm: () => Promise<boolean> } } };
    gate.deps.moneyGate.confirm = () =>
      new Promise<boolean>((r) => {
        answer = r;
      });
    const p = h.gate.call(h.ev(), callMsg('nutzap', [VIDEO.id, 21, MINTS.a]));
    await Promise.resolve();
    h.gate.webContentsGone(1);
    expectError(await p, 'session-closed');
    answer?.(true);
    await h.host.settled();
    expect(h.host.received.filter((m) => m.kind === 'call')).toHaveLength(0);
  });

  // Security review F7: a compromised renderer PROCESS can mint a token for any path it knows,
  // so main names the file it resolved — never renderer text — and a refusal uploads nothing.
  it('studio.upload asks about the file main resolved from the token; a refusal never reaches the host', async () => {
    const h = createHarness();
    const seen: unknown[] = [];
    const gate = h.gate as unknown as {
      deps: { moneyGate: { confirm: (r: unknown) => Promise<boolean> } };
    };
    gate.deps.moneyGate.confirm = (r) => {
      seen.push(r);
      return Promise.resolve(false);
    };
    h.files.set('/home/u/.ssh/id_ed25519', fileStat('file', 411));
    const g = await h.gate.grant(h.ev(), { v: 1, path: '/home/u/.ssh/id_ed25519' });
    const token = g.ok ? (g.result as string) : '';
    expectError(
      await h.gate.call(h.ev(), callMsg('studio.upload', uploadArgs(token))),
      'forbidden',
    );
    expect(seen).toEqual([
      { wc: 1, method: 'studio.upload', file: { name: 'id_ed25519', size: 411 } },
    ]);
    await h.host.settled();
    expect(h.host.received.filter((m) => m.kind === 'call')).toHaveLength(0);
  });

  // Security review F4/F8: settings that decide where sats may go are asked about, with the
  // settings main last saw for the page so only real additions are named.
  it('updateSettings goes through the gate with the settings main learned from the last settings reply', async () => {
    const h = createHarness();
    const seen: { method: string; known?: unknown }[] = [];
    const gate = h.gate as unknown as {
      deps: {
        moneyGate: { confirm: (r: { method: string; known?: unknown }) => Promise<boolean> };
      };
    };
    gate.deps.moneyGate.confirm = (r) => {
      seen.push(r);
      return Promise.resolve(true);
    };
    const current = await h.gate.call(h.ev(), callMsg('settings', []));
    expect(current.ok).toBe(true);
    await h.gate.call(h.ev(), callMsg('updateSettings', [{ theme: 'light' }]));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('updateSettings');
    expect(seen[0]?.known).toEqual(current.ok ? current.result : undefined);
  });

  it('ADR 0013: sign-out is asked first; a refusal never reaches the host, a yes does', async () => {
    const h = createHarness();
    const seen: unknown[] = [];
    let answer = false;
    const gate = h.gate as unknown as {
      deps: { moneyGate: { confirm: (r: unknown) => Promise<boolean> } };
    };
    gate.deps.moneyGate.confirm = (r) => {
      seen.push(r);
      return Promise.resolve(answer);
    };
    expectError(await h.gate.call(h.ev(), callMsg('desktop.signer.signOut', [])), 'forbidden');
    await h.host.settled();
    expect(h.host.received.filter((m) => m.kind === 'call')).toHaveLength(0);
    answer = true;
    await h.gate.call(h.ev(), callMsg('desktop.signer.signOut', []));
    await h.host.settled();
    expect(seen).toEqual([
      { wc: 1, method: 'desktop.signer.signOut' },
      { wc: 1, method: 'desktop.signer.signOut' },
    ]);
    expect(h.host.received.filter((m) => m.kind === 'call')).toHaveLength(1);
  });

  it('never asks for anything else (a signer connect names a kind only; the prompt window asks)', async () => {
    const h = createHarness();
    await h.gate.call(h.ev(), callMsg('wallet.balances', []));
    await h.gate.call(h.ev(), callMsg('video', [VIDEO.id]));
    await h.gate.call(h.ev(), callMsg('desktop.signer.connect', [{ kind: 'local' }]));
    await h.gate.call(h.ev(), callMsg('desktop.signer.lock', []));
    expect(h.money.asked).toEqual([]);
  });
});

describe('IPC gate — subscriptions and events', () => {
  it('delivers events only to the subscribed webContents, and stops after unsub', async () => {
    const h = createHarness();
    const ack = await h.gate.sub(h.ev(), {
      v: 1,
      op: 'sub',
      subId: 5,
      topic: { t: 'notifications' },
    });
    expect(ack).toEqual({ v: 1, id: 5, ok: true, result: undefined });
    h.host.adapter.emitNotification({ type: 'nutzap-received', amount: 21 as never });
    await h.host.settled();
    expect(h.wc.sent).toHaveLength(1);
    expect(h.wc.sent[0]?.channel).toBe(CHANNEL.event);
    expect(h.wc.sent[0]?.msg.subId).toBe(5);
    expect(h.other.sent).toHaveLength(0);
    const un = await h.gate.sub(h.ev(), { v: 1, op: 'unsub', subId: 5 });
    expect(un.ok).toBe(true);
    h.host.adapter.emitNotification({ type: 'nutzap-received', amount: 21 as never });
    await h.host.settled();
    expect(h.wc.sent).toHaveLength(1);
  });

  it('drops events for a subId the gate never acknowledged, or for another webContents', () => {
    const h = createHarness();
    h.gate.fromHost({ kind: 'event', wc: 1, msg: { v: 1, subId: 99, payload: 'x' } });
    h.gate.fromHost({ kind: 'event', wc: 7, msg: { v: 1, subId: 1, payload: 'x' } });
    expect(h.wc.sent).toHaveLength(0);
  });

  it('an unknown unsub is acknowledged locally (idempotent)', async () => {
    const h = createHarness();
    expect((await h.gate.sub(h.ev(), { v: 1, op: 'unsub', subId: 3 })).ok).toBe(true);
    await h.host.settled();
    expect(h.host.received).toHaveLength(0);
  });

  it('a refused host subscription is not recorded', async () => {
    const h = createHarness();
    const r = await h.gate.sub(h.ev(), {
      v: 1,
      op: 'sub',
      subId: 8,
      topic: { t: 'session.spend', sid: 'd'.repeat(32) as never },
    });
    expectError(r, 'session-closed');
    expect(h.gate.stats(1).subs).toBe(0);
  });
});

describe('IPC gate — lifecycle', () => {
  it('webContents gone: posts wc-gone once and the host closes its sessions', async () => {
    const h = createHarness();
    const r = await h.gate.call(h.ev(), callMsg('play', [VIDEO.id]));
    expect(r.ok).toBe(true);
    expect(h.host.openSessions(1)).toHaveLength(1);
    h.gate.webContentsGone(1);
    h.gate.webContentsGone(1);
    await h.host.settled();
    expect(h.host.received.filter((m) => m.kind === 'wc-gone')).toHaveLength(1);
    expect(h.host.openSessions(1)).toHaveLength(0);
  });

  it('host down: calls in flight fail backend-down, new ones too', async () => {
    const h = createHarness({ stall: true });
    const p = h.gate.call(h.ev(), callMsg('me', []));
    h.host.running = false;
    h.gate.hostDown();
    expectError(await p, 'backend-down');
    expectError(await h.gate.call(h.ev(), callMsg('me', [])), 'backend-down');
    expectError(
      await h.gate.sub(h.ev(), { v: 1, op: 'sub', subId: 1, topic: { t: 'notifications' } }),
      'backend-down',
    );
  });

  it('errors from the host keep their code and prefix (no-seeders, no-balance, relay-down)', async () => {
    for (const failWith of ['no-seeders', 'relay-down'] as const) {
      const h = createHarness({ mock: { failWith } });
      const r = await h.gate.call(
        h.ev(),
        callMsg(
          failWith === 'no-seeders' ? 'play' : 'feed',
          failWith === 'no-seeders' ? [VIDEO.id] : [{ source: 'trending' }],
        ),
      );
      expectError(r, failWith);
    }
    const h = createHarness({ mock: { failWith: 'no-balance' } });
    expectError(await h.gate.call(h.ev(), callMsg('play', [VIDEO.id])), 'no-balance');
  });
});
