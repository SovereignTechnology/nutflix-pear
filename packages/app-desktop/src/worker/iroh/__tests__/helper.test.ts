/**
 * The helper supervisor against a fake child: replies are believed only once validated, a helper
 * that breaks the protocol is killed and restarted, and what the worker buffers is bounded
 * (nfx ADR 0103, sharp edges 1–3). The real helper runs only in the spike-iroh workflow.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { HelperFrameDecoder, encodeCtl, encodeData } from '../frames.js';
import { HelperError, IrohHelper, PoisonedError, dialTarget } from '../helper.js';
import type { HelperChild, HelperEvent, HelperTicket, IrohHelperOptions } from '../helper.js';

type Msg = Readonly<Record<string, unknown>>;
type Responder = (msg: Msg, child: FakeChild) => void;

const NODE = 'ab'.repeat(32);
const HASH = 'cd'.repeat(32);
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function header(len: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, len, false);
  return b;
}

class FakeChild implements HelperChild {
  readonly requests: Msg[] = [];
  readonly kills: string[] = [];
  stdinEnded = false;
  private readonly data: ((c: Uint8Array) => void)[] = [];
  private readonly err: ((c: Uint8Array) => void)[] = [];
  private readonly exits: ((code: number | null, signal: string | null) => void)[] = [];
  private gone = false;
  private readonly decoder = new HelperFrameDecoder((f) => {
    if (f.kind !== 'ctl') throw new Error('the worker sent a data frame');
    this.requests.push(f.msg);
    this.respond(f.msg, this);
  });

  constructor(private readonly respond: Responder) {}

  readonly stdin = {
    write: (c: Uint8Array): boolean => {
      this.decoder.push(c);
      return true;
    },
    end: (): void => {
      this.stdinEnded = true;
      setTimeout(() => {
        this.exit(0, null);
      }, 0);
    },
  };
  readonly stdout = {
    on: (_e: 'data', l: (c: Uint8Array) => void): void => {
      this.data.push(l);
    },
  };
  readonly stderr = {
    on: (_e: 'data', l: (c: Uint8Array) => void): void => {
      this.err.push(l);
    },
  };

  on(event: 'exit' | 'error', l: (...args: never[]) => void): this {
    if (event === 'exit')
      this.exits.push(l as (code: number | null, signal: string | null) => void);
    return this;
  }

  kill(signal = 'SIGTERM'): void {
    this.kills.push(signal);
    setTimeout(() => {
      this.exit(null, signal);
    }, 0);
  }

  send(bytes: Uint8Array): void {
    for (const l of this.data) l(bytes);
  }

  reply(msg: Msg): void {
    this.send(encodeCtl(msg));
  }

  say(line: string): void {
    const bytes = new Uint8Array(line.length);
    for (let i = 0; i < line.length; i += 1) bytes[i] = line.charCodeAt(i);
    for (const l of this.err) l(bytes);
  }

  exit(code: number | null, signal: string | null): void {
    if (this.gone) return;
    this.gone = true;
    for (const l of this.exits) l(code, signal);
  }
}

/** Answers `init` and `addr`; everything else goes to `then`. */
function responder(then: Responder = () => undefined): Responder {
  return (msg, child) => {
    if (msg['op'] === 'init' || msg['op'] === 'addr') {
      child.reply({ id: msg['id'], ok: true, node: NODE, relay: '', addrs: ['127.0.0.1:1'] });
      return;
    }
    then(msg, child);
  };
}

function setup(
  then?: Responder,
  options: Partial<IrohHelperOptions> = {},
): { helper: IrohHelper; children: FakeChild[]; events: HelperEvent[] } {
  const children: FakeChild[] = [];
  const events: HelperEvent[] = [];
  const helper = new IrohHelper({
    spawn: () => {
      const c = new FakeChild(responder(then));
      children.push(c);
      return c;
    },
    file: '/opt/helper',
    stateDir: '/tmp/state',
    init: { relays: ['http://10.200.0.1:3340/'] },
    restart: { minMs: 50, maxMs: 100 },
    onEvent: (e) => events.push(e),
    ...options,
  });
  return { helper, children, events };
}

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PoisonedError) return 'poisoned';
    return e instanceof HelperError ? e.code : `not a HelperError: ${String(e)}`;
  }
  return 'resolved';
}

describe('IrohHelper', () => {
  it('starts with --state and an init carrying the relays and the secret, never argv', async () => {
    const spawned: { file: string; args: readonly string[] }[] = [];
    let child: FakeChild | undefined;
    const helper = new IrohHelper({
      spawn: (file, args) => {
        spawned.push({ file, args });
        child = new FakeChild(responder());
        return child;
      },
      file: '/opt/helper',
      stateDir: '/tmp/state',
      init: { relays: ['http://r/'], secret: 'ee'.repeat(32) },
    });
    await expect(helper.start()).resolves.toEqual({
      node: NODE,
      relay: '',
      addrs: ['127.0.0.1:1'],
    });
    expect(spawned).toEqual([{ file: '/opt/helper', args: ['--state', '/tmp/state'] }]);
    expect(child?.requests[0]).toMatchObject({
      op: 'init',
      relays: ['http://r/'],
      secret: 'ee'.repeat(32),
    });
    await helper.close();
    expect(child?.stdinEnded).toBe(true);
  });

  it('correlates replies by id, in any order', async () => {
    const held: Msg[] = [];
    const { helper, children } = setup((msg) => held.push(msg));
    await helper.start();
    const a = helper.import('/a');
    const b = helper.import('/b');
    await vi.waitFor(() => {
      expect(held).toHaveLength(2);
    });
    const [ra, rb] = held;
    children[0]!.reply({ id: rb!['id'], ok: true, hash: '22'.repeat(32), size: 2 });
    children[0]!.reply({ id: ra!['id'], ok: true, hash: '11'.repeat(32), size: 1 });
    await expect(a).resolves.toEqual({ hash: '11'.repeat(32), size: 1 });
    await expect(b).resolves.toEqual({ hash: '22'.repeat(32), size: 2 });
    await helper.close();
  });

  it('getFile returns bytes only under the sha256 they must have; anything else is poisoned', async () => {
    const { helper, children } = setup((msg, child) => {
      child.send(encodeData(msg['id'] as number, new Uint8Array([1, 2])));
      child.send(encodeData(msg['id'] as number, new Uint8Array([3])));
      child.reply({ id: msg['id'], ok: true, size: 3 });
    });
    await helper.start();
    const good = sha(new Uint8Array([1, 2, 3]));
    await expect(helper.getFile(1, HASH, { sha256: good, maxBytes: 3 })).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    // The peer's bytes, under the wrong name: refused, and never handed back.
    expect(await rejection(helper.getFile(1, HASH, { sha256: 'ee'.repeat(32), maxBytes: 3 }))).toBe(
      'poisoned',
    );
    // A poisoned file is the peer's fault, not the helper's: no kill.
    expect(children[0]!.kills).toEqual([]);
    expect(await rejection(helper.getFile(1, HASH, { sha256: 'NOT', maxBytes: 3 }))).toBe(
      'bad-request',
    );
    await helper.close();
  });

  it('getSeq returns member hashes, refuses what is not a HashSeq, and can demand a count', async () => {
    let body = new Uint8Array(64).fill(0xab);
    const { helper } = setup((msg, child) => {
      child.send(encodeData(msg['id'] as number, body));
      child.reply({ id: msg['id'], ok: true, size: body.length });
    });
    await helper.start();
    await expect(helper.getSeq(1, HASH, { maxMembers: 2 })).resolves.toEqual([NODE, NODE]);
    expect(await rejection(helper.getSeq(1, HASH, { maxMembers: 3, exact: true }))).toBe(
      'poisoned',
    );
    body = new Uint8Array(33);
    expect(await rejection(helper.getSeq(1, HASH, { maxMembers: 2 }))).toBe('poisoned');
    expect(await rejection(helper.getSeq(1, HASH, { maxMembers: 0 }))).toBe('bad-request');
    await helper.close();
  });

  it('kills and restarts a helper whose get sends more than its max', async () => {
    const { helper, children, events } = setup((msg, child) => {
      if (msg['op'] === 'get') child.send(encodeData(msg['id'] as number, new Uint8Array(4)));
    });
    await helper.start();
    expect(await rejection(helper.getFile(1, HASH, { sha256: HASH, maxBytes: 3 }))).toBe(
      'violation',
    );
    expect(children[0]!.kills).toEqual(['SIGKILL']);
    expect(events.some((e) => e.type === 'violation')).toBe(true);
    await vi.waitFor(() => {
      expect(helper.restarts).toBe(1);
    });
    expect(children).toHaveLength(2);
    expect(children[1]!.requests[0]).toMatchObject({ op: 'init' });
    await helper.close();
  });

  it('kills a helper that sends an oversize frame, a reply for nothing, or a malformed reply', async () => {
    for (const misbehave of [
      (c: FakeChild) => {
        c.send(header(0x7fff_ffff));
      },
      (c: FakeChild) => {
        c.reply({ id: 999_999, ok: true });
      },
      (c: FakeChild, m: Msg) => {
        c.reply({ id: m['id'], ok: true, hash: 'NOT-HEX', size: 1 });
      },
      (c: FakeChild, m: Msg) => {
        c.reply({ id: m['id'], ok: true, size: 99 });
      },
    ]) {
      const { helper, children } = setup((msg, child) => {
        misbehave(child, msg);
      });
      await helper.start();
      expect(await rejection(helper.import('/x'))).toBe('violation');
      expect(children[0]!.kills).toEqual(['SIGKILL']);
      await helper.close();
    }
  });

  it('a get reply whose size disagrees with its bytes is a violation', async () => {
    const { helper, children } = setup((msg, child) => {
      child.send(encodeData(msg['id'] as number, new Uint8Array(2)));
      child.reply({ id: msg['id'], ok: true, size: 1 });
    });
    await helper.start();
    expect(await rejection(helper.getFile(1, HASH, { sha256: HASH, maxBytes: 8 }))).toBe(
      'violation',
    );
    expect(children[0]!.kills).toEqual(['SIGKILL']);
    await helper.close();
  });

  it('times a request out, then drops its late reply and late bytes without a kill', async () => {
    let late: Msg | undefined;
    const { helper, children } = setup(
      (msg) => {
        late = msg;
      },
      { timeoutMs: 20 },
    );
    await helper.start();
    expect(await rejection(helper.getFile(1, HASH, { sha256: HASH, maxBytes: 4 }))).toBe('timeout');
    children[0]!.send(encodeData(late!['id'] as number, new Uint8Array(4)));
    children[0]!.reply({ id: late!['id'], ok: true, size: 4 });
    expect(children[0]!.kills).toEqual([]);
    // Late bytes past what the get could still owe are a violation all the same.
    expect(await rejection(helper.getFile(1, HASH, { sha256: HASH, maxBytes: 2 }))).toBe('timeout');
    children[0]!.send(encodeData(late!['id'] as number, new Uint8Array(3)));
    expect(children[0]!.kills).toEqual(['SIGKILL']);
    await helper.close();
  });

  it('refuses work over its bounds instead of queueing it', async () => {
    const { helper } = setup(() => undefined, {
      maxInflight: 1,
      maxGetBytesInflight: 10,
      timeoutMs: 50,
    });
    await helper.start();
    const first = helper.import('/a');
    expect(await rejection(helper.import('/b'))).toBe('busy');
    expect(await rejection(first)).toBe('timeout');
    expect(await rejection(helper.getFile(1, HASH, { sha256: HASH, maxBytes: 11 }))).toBe('busy');
    expect(
      await rejection(helper.getFile(1, HASH, { sha256: HASH, maxBytes: 64 * 1024 * 1024 + 1 })),
    ).toBe('bad-request');
    await helper.close();
  });

  it('passes a helper error through with its code', async () => {
    const { helper } = setup((msg, child) => {
      child.reply({ id: msg['id'], ok: false, err: 'dial-failed', msg: 'no route' });
    });
    await helper.start();
    const target = dialTarget(
      { node: NODE, hash: HASH, format: 'hash_seq', relays: [], addrs: ['10.0.0.1:1'] },
      NODE,
      [],
    );
    expect(await rejection(helper.dial(target!))).toBe('dial-failed');
    await helper.close();
  });

  it('a first start whose init fails is not restarted; a spawn that throws is gone', async () => {
    const children: FakeChild[] = [];
    const helper = new IrohHelper({
      spawn: () => {
        const c = new FakeChild((msg, child) => {
          child.reply({ id: msg['id'], ok: false, err: 'io', msg: 'no state dir' });
        });
        children.push(c);
        return c;
      },
      file: '/opt/helper',
      stateDir: '/tmp/state',
      init: { relays: [] },
      restart: { minMs: 50, maxMs: 50 },
    });
    expect(await rejection(helper.start())).toBe('io');
    expect(children[0]!.kills).toEqual(['SIGKILL']);
    await new Promise((r) => setTimeout(r, 20));
    expect(children).toHaveLength(1);

    const thrower = new IrohHelper({
      spawn: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      file: '/missing',
      stateDir: '/tmp/state',
      init: { relays: [] },
    });
    expect(await rejection(thrower.start())).toBe('gone');
  });

  it('close ends stdin, rejects what waits, and never restarts', async () => {
    const { helper, children } = setup(() => undefined);
    await helper.start();
    const waiting = helper.import('/a');
    await helper.close();
    expect(await rejection(waiting)).toBe('closed');
    expect(children[0]!.stdinEnded).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(children).toHaveLength(1);
    expect(await rejection(helper.addr())).toBe('closed');
  });

  it('an exit rejects what waits with gone, and the supervisor restarts it', async () => {
    const { helper, children } = setup(() => undefined);
    await helper.start();
    const waiting = helper.import('/a');
    children[0]!.exit(70, null);
    expect(await rejection(waiting)).toBe('gone');
    await vi.waitFor(() => {
      expect(helper.restarts).toBe(1);
    });
    await expect(helper.addr()).resolves.toMatchObject({ node: NODE });
    await helper.close();
  });

  it('reports stderr as bounded printable lines', async () => {
    const { helper, children, events } = setup();
    await helper.start();
    children[0]!.say(`nutflix-iroh-helper: one\n${'x'.repeat(2000)}\n`);
    const lines = events.flatMap((e) => (e.type === 'stderr' ? [e.line] : []));
    expect(lines[0]).toBe('nutflix-iroh-helper: one');
    expect(lines[1]!.length).toBeLessThanOrEqual(512);
    await helper.close();
  });
});

describe('IrohHelper options', () => {
  const base = {
    spawn: (): HelperChild => new FakeChild(responder()),
    file: '/opt/helper',
    stateDir: '/tmp/state',
  };

  it('keeps the secret out of its fields and every event, and sends it only in init', async () => {
    const secret = '5e'.repeat(32);
    const events: HelperEvent[] = [];
    let child: FakeChild | undefined;
    const helper = new IrohHelper({
      ...base,
      spawn: () => (child = new FakeChild(responder())),
      init: { relays: [], secret },
      onEvent: (e) => events.push(e),
    });
    await helper.start();
    // The helper's own fields; `run` holds the child process handle, which is not its state.
    const { run: _run, ...fields } = helper as unknown as Record<string, unknown>;
    expect(JSON.stringify(fields)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(child?.requests.filter((r) => JSON.stringify(r).includes(secret))).toEqual([
      expect.objectContaining({ op: 'init' }),
    ]);
    await helper.close();
  });

  it('refuses a malformed secret without repeating it, and values that disable a bound', () => {
    const bad = 'NOT-A-KEY-but-a-typo-of-one';
    let message = '';
    try {
      new IrohHelper({ ...base, init: { relays: [], secret: bad } });
    } catch (e) {
      message = e instanceof Error ? e.message : '';
    }
    expect(message).toContain('secret');
    expect(message).not.toContain(bad);
    for (const over of [
      { maxInflight: 0 },
      { timeoutMs: -1 },
      { maxGetBytesInflight: 0.5 },
      { restart: { minMs: 0, maxMs: 0 } },
      { restart: { minMs: 100, maxMs: 50 } },
    ])
      expect(() => new IrohHelper({ ...base, init: { relays: [] }, ...over })).toThrow(RangeError);
  });

  it('passes relay CAs through to init, and refuses ones that are not hex DER', async () => {
    let child: FakeChild | undefined;
    const helper = new IrohHelper({
      ...base,
      spawn: () => (child = new FakeChild(responder())),
      init: { relays: ['https://10.200.0.1:3443/'], relayCas: ['3082abcd'] },
    });
    await helper.start();
    expect(child?.requests[0]).toMatchObject({ op: 'init', relay_cas: ['3082abcd'] });
    await helper.close();
    for (const relayCas of [['XYZ'], ['3'], ['00', '00', '00', '00', '00']])
      expect(() => new IrohHelper({ ...base, init: { relays: [], relayCas } })).toThrow(RangeError);
  });

  it('asks for the portmapper only when told to', async () => {
    let child: FakeChild | undefined;
    const helper = new IrohHelper({
      ...base,
      spawn: () => (child = new FakeChild(responder())),
      init: { relays: [] },
    });
    await helper.start();
    expect(child?.requests[0]).not.toHaveProperty('portmapper');
    await helper.close();
  });
});

describe('dialTarget', () => {
  const ticket = (over: Partial<HelperTicket> = {}): HelperTicket => ({
    node: NODE,
    hash: HASH,
    format: 'hash_seq',
    relays: ['http://ours/', 'http://theirs.example/'],
    addrs: ['192.168.10.2:4433'],
    ...over,
  });

  it('keeps direct addresses and only this network’s relays', () => {
    expect(dialTarget(ticket(), NODE, ['http://ours/'])).toEqual({
      node: NODE,
      relays: ['http://ours/'],
      addrs: ['192.168.10.2:4433'],
    });
  });

  it('ignores a ticket naming another node, or not a collection (NFX-06 §2)', () => {
    expect(dialTarget(ticket({ node: 'ef'.repeat(32) }), NODE, [])).toBeNull();
    expect(dialTarget(ticket({ format: 'raw' }), NODE, [])).toBeNull();
  });
});
