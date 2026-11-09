// @vitest-environment jsdom
/**
 * The shell's side of the desktop signer flow (ADR 0013): Settings gets `onChangeSigner` only when
 * the host offers the flow, and it passes a KIND (never a secret) to `desktop.signer.connect`; the
 * header offers Unlock while locked, Lock and Sign out while not; a `signer.status` change re-reads
 * identity; a flow error is a toast, a dismissed prompt is not.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SignerStatus } from '@sovit/core';
import { mocks } from '@sovit/core';
import type * as Screens from '../../screens/index.js';
import type { SignerFlow } from '../Shell.js';
import { Shell } from '../Shell.js';
import { createShellModel } from '../model.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const seen = vi.hoisted(() => ({ props: new Map<string, Record<string, unknown>>() }));

vi.mock('../../screens/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof Screens>();
  const stub =
    (name: string) =>
    (props: Record<string, unknown>): ReturnType<typeof createElement> => {
      seen.props.set(name, props);
      return createElement('div', { 'data-screen': name });
    };
  return { ...orig, Home: stub('Home'), Settings: stub('Settings') };
});

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup) c();
  cleanup = [];
  seen.props.clear();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++)
      await new Promise<void>((r) => {
        setTimeout(r, 0);
      });
  });
}

function fakeFlow(available: boolean): SignerFlow & {
  calls: string[];
  fire: () => void;
  fail: Error | undefined;
} {
  let listener: (() => void) | undefined;
  const f = {
    calls: [] as string[],
    fail: undefined as Error | undefined,
    fire: () => {
      listener?.();
    },
    info: () => (available ? Promise.resolve({}) : Promise.reject(new Error('forbidden: dev'))),
    connect: (kind: 'local' | 'nip46') => {
      f.calls.push(`connect:${kind}`);
      return f.fail === undefined ? Promise.resolve({}) : Promise.reject(f.fail);
    },
    unlock: () => {
      f.calls.push('unlock');
      return Promise.resolve({});
    },
    lock: () => {
      f.calls.push('lock');
      return Promise.resolve();
    },
    signOut: () => {
      f.calls.push('signOut');
      return Promise.resolve();
    },
    onChange: (cb: () => void) => {
      listener = cb;
      return () => {
        listener = undefined;
      };
    },
  };
  return f;
}

async function mount(
  flow: SignerFlow | undefined,
  o: { locked?: boolean } = {},
): Promise<{ container: HTMLElement; adapter: mocks.MockNetworkAdapter; meCalls: () => number }> {
  const adapter = new mocks.MockNetworkAdapter();
  let meCalls = 0;
  const me = adapter.me.bind(adapter);
  adapter.me = () => {
    meCalls++;
    return me();
  };
  if (o.locked === true) {
    const signer = adapter.signer.bind(adapter);
    adapter.signer = async (): Promise<SignerStatus> => ({ ...(await signer()), locked: true });
  }
  const model = createShellModel(adapter, { name: 'settings' });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(Shell, {
        adapter: model.adapter,
        coordinator: model.coordinator,
        router: model.router,
        signerFlow: flow,
      }),
    );
  });
  cleanup.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  await flush();
  return { container, adapter, meCalls: () => meCalls };
}

const button = (c: HTMLElement, label: RegExp): HTMLButtonElement | undefined =>
  [...c.querySelectorAll('button')].find((b) =>
    label.test(b.getAttribute('aria-label') ?? b.textContent),
  );

describe('the shell and the desktop signer flow (ADR 0013)', () => {
  it('no flow offered (tests, --dev-mocks): no onChangeSigner, no signer buttons', async () => {
    const { container } = await mount(fakeFlow(false));
    expect('onChangeSigner' in (seen.props.get('Settings') ?? {})).toBe(false);
    expect(button(container, /lock signer|sign out|unlock/i)).toBeUndefined();
  });

  it('Settings passes the KIND to desktop.signer.connect; NIP-07 is refused with a toast', async () => {
    const flow = fakeFlow(true);
    const { container } = await mount(flow);
    const change = seen.props.get('Settings')?.['onChangeSigner'] as (k: string) => Promise<void>;
    expect(change).toBeTypeOf('function');
    await act(async () => {
      await change('local');
    });
    await act(async () => {
      await change('nip46');
    });
    expect(flow.calls).toEqual(['connect:local', 'connect:nip46']);
    await act(async () => {
      await change('nip07').catch(() => undefined);
    });
    await flush();
    expect(flow.calls).toHaveLength(2);
    expect(container.textContent).toMatch(/browser extensions are not available on desktop/);
  });

  it('a dismissed prompt raises no toast; a real failure does', async () => {
    const flow = fakeFlow(true);
    const { container } = await mount(flow);
    const change = seen.props.get('Settings')?.['onChangeSigner'] as (k: string) => Promise<void>;
    flow.fail = new Error('cancelled: the prompt was dismissed');
    await act(async () => {
      await change('local').catch(() => undefined);
    });
    await flush();
    expect(container.textContent).not.toMatch(/dismissed/);
    flow.fail = new Error('remote-signer: the remote signer did not answer');
    await act(async () => {
      await change('nip46').catch(() => undefined);
    });
    await flush();
    expect(container.textContent).toMatch(/the remote signer did not answer/);
  });

  it('header: Lock and Sign out while unlocked; a status change re-reads identity', async () => {
    const flow = fakeFlow(true);
    const { container, meCalls } = await mount(flow);
    const lock = button(container, /lock signer/i);
    const out = button(container, /sign out/i);
    expect(lock).toBeDefined();
    expect(out).toBeDefined();
    expect(button(container, /^unlock$/i)).toBeUndefined();
    act(() => {
      lock?.click();
      out?.click();
    });
    await flush();
    expect(flow.calls).toEqual(['lock', 'signOut']);
    const before = meCalls();
    act(() => {
      flow.fire();
    });
    await flush();
    expect(meCalls()).toBeGreaterThan(before);
  });

  it('header: Unlock while locked (and no wallet total is asked for)', async () => {
    const flow = fakeFlow(true);
    const { container } = await mount(flow, { locked: true });
    const unlock = button(container, /^unlock$/i);
    expect(unlock).toBeDefined();
    expect(button(container, /lock signer/i)).toBeUndefined();
    act(() => {
      unlock?.click();
    });
    await flush();
    expect(flow.calls).toEqual(['unlock']);
  });
});
