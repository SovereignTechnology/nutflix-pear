/**
 * A machine must not tell a stranger its local addresses (NFX-18 §4; moved from nutflix-runtime
 * with `../net/no-local-addresses.ts`): unless its node's socket is really bound to 127.0.0.1
 * (read at each dial, and when a listener starts, after the bind), a dial sets
 * `localConnection: false` and a listener `shareLocalAddress: false`. On a loopback test network
 * the node is bound there and keeps hyperdht's defaults, so peers on one host still meet. The
 * test switch only forces hiding on. The same two options can be set on a whole node
 * (`hideLocalAddressesOn`, for a library such as Hyperswarm that takes one).
 */
import { randomBytes } from 'node:crypto';

import DHT from 'hyperdht';
import type { KeyPair } from 'hyperdht';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import { describe, expect, it, vi } from 'vitest';

import type { BindableNode } from '../net/no-local-addresses.js';
import {
  hideLocalAddressesOn,
  hidesLocalAddresses,
  isLoopbackTestnet,
  localAddressesByBind,
} from '../net/no-local-addresses.js';

vi.setConfig({ testTimeout: 120_000 });

/**
 * A stand-in node bound to `host` (`null`: not yet; `'throws'`: its `address()` throws), recording
 * what each call was given.
 */
function fakeNode(
  host: string | null,
  bindTo?: string,
): {
  node: BindableNode;
  seen: unknown[];
  listened: KeyPair[];
} {
  const seen: unknown[] = [];
  const listened: KeyPair[] = [];
  let bound = host;
  const node: BindableNode = {
    address: () => {
      if (bound === 'throws') throw new Error('no socket');
      return bound === null ? null : { host: bound };
    },
    bind: () => {
      if (bindTo !== undefined) bound = bindTo;
      return Promise.resolve();
    },
    connect: (_k, opts) => {
      seen.push(opts);
      return {} as never;
    },
    createServer: (opts) => {
      seen.push(opts);
      return {
        publicKey: null,
        listen: (kp: KeyPair) => {
          listened.push(kp);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      };
    },
  };
  return { node, seen, listened };
}

describe('localAddressesByBind', () => {
  const keyPair = DHT.keyPair();
  const firewall = (): boolean => false;

  it('keeps the defaults only on a socket really bound to 127.0.0.1', async () => {
    const { node, seen } = fakeNode('127.0.0.1');
    const view = localAddressesByBind(node);
    view.connect(new Uint8Array(32), { keyPair });
    await view.createServer({ firewall }, () => undefined).listen(keyPair);
    expect(seen).toEqual([{ keyPair }, { firewall }]);
  });

  it.each([['0.0.0.0'], ['10.0.0.2'], ['127.0.0.2'], [null], ['throws']] as const)(
    'hides on a socket bound to %j (or not bound, or unreadable), and a caller cannot undo it',
    async (host) => {
      const { node, seen } = fakeNode(host);
      const view = localAddressesByBind(node);
      view.connect(new Uint8Array(32), { keyPair, localConnection: true });
      await view
        .createServer({ firewall, shareLocalAddress: true }, () => undefined)
        .listen(keyPair);
      expect(seen).toEqual([
        { keyPair, localConnection: false },
        { firewall, shareLocalAddress: false },
      ]);
    },
  );

  it('the switch only forces hiding on', async () => {
    const { node, seen } = fakeNode('127.0.0.1');
    const view = localAddressesByBind(node, { force: true });
    view.connect(new Uint8Array(32));
    await view.createServer({}, () => undefined).listen(keyPair);
    expect(seen).toEqual([{ localConnection: false }, { shareLocalAddress: false }]);
  });

  it('a listener decides after the bind, on what the socket got', async () => {
    // Unbound when the listener is made; the bind then gives 127.0.0.1, or every interface.
    for (const [bindTo, want] of [
      ['127.0.0.1', {}],
      ['0.0.0.0', { shareLocalAddress: false }],
    ] as const) {
      const { node, seen, listened } = fakeNode(null, bindTo);
      const server = localAddressesByBind(node).createServer({}, () => undefined);
      expect(seen).toEqual([]);
      expect(server.publicKey).toBeNull();
      await server.listen(keyPair);
      expect(seen).toEqual([want]);
      expect(listened).toEqual([keyPair]);
    }
  });

  it('a listener closed before it listens never listens', async () => {
    const { node, seen } = fakeNode('127.0.0.1');
    const server = localAddressesByBind(node).createServer({}, () => undefined);
    await server.close();
    await expect(server.listen(keyPair)).rejects.toThrow(/^backend-down/);
    expect(seen).toEqual([]);
  });

  it.each([
    [null, false, true],
    ['0.0.0.0', false, true],
    ['127.0.0.1', false, false],
    ['127.0.0.1', true, true],
    ['127.1.2.3', false, true],
  ])('bound to %j, forced: %s, hides: %s', (host, force, want) => {
    expect(hidesLocalAddresses({ boundHost: host, force })).toBe(want);
  });

  it.each([
    [null, false],
    [[], false],
    [[{ host: '127.0.0.1', port: 1 }], true],
    [
      [
        { host: '127.0.0.1', port: 1 },
        { host: '127.0.0.1', port: 2 },
      ],
      true,
    ],
    [
      [
        { host: '127.0.0.1', port: 1 },
        { host: '88.99.3.86', port: 49737 },
      ],
      false,
    ],
    [[{ host: '127.0.0.2', port: 1 }], false],
    [[{ host: 'localhost', port: 1 }], false],
    [[{ host: '10.0.0.1', port: 1 }], false],
  ])('treats %j as a loopback test network: %s', (b, want) => {
    expect(isLoopbackTestnet(b)).toBe(want);
  });
});

describe('hideLocalAddressesOn', () => {
  it('sets the two options on the node itself, last, in both createServer forms', () => {
    const seen: unknown[] = [];
    const node = {
      connect: (_k: Uint8Array, opts?: unknown) => {
        seen.push(opts);
        return {} as never;
      },
      createServer: (opts: unknown, cb?: unknown) => {
        seen.push([opts, cb]);
        return {} as never;
      },
    };
    const onconnection = (): void => undefined;
    const firewall = (): boolean => false;
    expect(hideLocalAddressesOn(node)).toBe(node);
    node.connect(new Uint8Array(32), { localConnection: true });
    node.connect(new Uint8Array(32));
    node.createServer({ firewall, shareLocalAddress: true }, onconnection);
    (node.createServer as (cb: unknown) => unknown)(onconnection);
    expect(seen).toEqual([
      { localConnection: false },
      { localConnection: false },
      [{ firewall, shareLocalAddress: false }, onconnection],
      [{ shareLocalAddress: false }, onconnection],
    ]);
  });

  it('a Hyperswarm given such a node dials and listens with both off', async () => {
    const testnet = await createTestnet(3);
    const calls: { kind: 'connect' | 'server'; opts: unknown }[] = [];
    const proto = DHT.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    const realConnect = proto['connect'];
    const realServer = proto['createServer'];
    if (realConnect === undefined || realServer === undefined)
      throw new Error('no hyperdht methods');
    let mine: DHT | null = null;
    vi.spyOn(DHT.prototype, 'connect').mockImplementation(function (this: DHT, key, opts) {
      if (this === mine) calls.push({ kind: 'connect', opts });
      return Reflect.apply(realConnect, this, [key, opts]) as ReturnType<DHT['connect']>;
    });
    vi.spyOn(DHT.prototype, 'createServer').mockImplementation(function (this: DHT, opts, cb) {
      if (this === mine) calls.push({ kind: 'server', opts });
      return Reflect.apply(realServer, this, [opts, cb]) as ReturnType<DHT['createServer']>;
    });
    const topic = randomBytes(32);
    const server = new Hyperswarm({ bootstrap: testnet.bootstrap });
    const client = new Hyperswarm({
      dht: hideLocalAddressesOn((mine = new DHT({ bootstrap: testnet.bootstrap }))),
    });
    try {
      await server.join(topic, { server: true, client: false }).flushed();
      client.join(topic, { server: false, client: true });
      const end = Date.now() + 30_000;
      while (!calls.some((c) => c.kind === 'connect') && Date.now() < end)
        await new Promise((r) => setTimeout(r, 50));
      // The swarm's own server, made in its constructor, and its dial to the announced peer.
      expect(calls.some((c) => c.kind === 'server')).toBe(true);
      expect(calls.some((c) => c.kind === 'connect')).toBe(true);
      for (const c of calls)
        expect(c.opts).toMatchObject(
          c.kind === 'connect' ? { localConnection: false } : { shareLocalAddress: false },
        );
    } finally {
      vi.restoreAllMocks();
      await client.destroy();
      await server.destroy();
      await testnet.destroy();
    }
  });
});
