/**
 * Settings screen under jsdom against `MockNetworkAdapter` (allowed in tests, never in the
 * screen). Covers every state, the optimistic save queue (rollback + toast + retry, input
 * kept on failure, per-operation rollback, ordering), URL validation in the forms, signer
 * copy, seeding / playback / auto top-up writes, navigation routes and cancellation.
 */
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mocks } from '@sovit/core';
import type { NetworkAdapter, Settings as SettingsData, SignerStatus } from '@sovit/core';
import type { ToastItem } from '../../../components/index.js';
import { click, fire, render, type Rendered } from '../../../components/testing/render.js';
import type { Route } from '../../shared/route.js';
import { GIB } from '../model.js';
import { SETTINGS_SECTIONS, Settings, type SettingsProps } from '../Settings.js';

const { MockNetworkAdapter, MINTS, ME } = mocks;
type Opts = ConstructorParameters<typeof MockNetworkAdapter>[0];
type Mock = InstanceType<typeof MockNetworkAdapter>;

async function flush(rounds = 10): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

const rendered: Rendered[] = [];
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useRealTimers();
  errorSpy = vi.spyOn(console, 'error');
});
afterEach(() => {
  for (const r of rendered.splice(0)) r.unmount();
  vi.restoreAllMocks();
});

function adapterWith(opts: Opts = {}, patch: Partial<SettingsData> = {}): Mock {
  const a = new MockNetworkAdapter(opts);
  if (Object.keys(patch).length > 0) void a.updateSettings(patch).catch(() => undefined);
  return a;
}

function mount(
  adapter: NetworkAdapter,
  props: Partial<Omit<SettingsProps, 'adapter' | 'navigate'>> = {},
): { readonly r: Rendered; readonly navigate: ReturnType<typeof vi.fn<(to: Route) => void>> } {
  const navigate = vi.fn<(to: Route) => void>();
  const r = render(createElement(Settings, { adapter, navigate, ...props }));
  rendered.push(r);
  return { r, navigate };
}

async function ready(
  adapter: NetworkAdapter,
  props: Partial<Omit<SettingsProps, 'adapter' | 'navigate'>> = {},
): Promise<ReturnType<typeof mount>> {
  const m = mount(adapter, props);
  await flush();
  return m;
}

/** Proxy that replaces some adapter methods (keeps the mock's private state working). */
function override(
  base: Mock,
  methods: Partial<Record<keyof NetworkAdapter, unknown>>,
): NetworkAdapter {
  return new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (typeof prop === 'string' && prop in methods)
        return (methods as Record<string, unknown>)[prop];
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

function input(r: Rendered, idSuffix: string): HTMLInputElement {
  return r.get(`[id$="${idSuffix}"]`) as HTMLInputElement;
}

/** React-controlled input: set through the native setter, then fire `input`. */
function type(el: HTMLInputElement, value: string): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- applied to `el` explicitly below
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function submit(el: HTMLInputElement): void {
  fire(el.form!, new Event('submit', { bubbles: true, cancelable: true }));
}

function enter(el: HTMLElement): void {
  fire(el, new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

function section(r: Rendered, title: string): HTMLElement {
  const h = r.all('h2').find((e) => e.textContent === title);
  if (!h) throw new Error(`no section "${title}"`);
  return h.closest('section')!;
}

function buttonByText(root: ParentNode, text: string | RegExp): HTMLButtonElement {
  const b = Array.from(root.querySelectorAll('button')).find((e) =>
    typeof text === 'string' ? e.textContent === text : text.test(e.textContent),
  );
  if (!b) throw new Error(`no button ${String(text)}`);
  return b;
}

describe('Settings — structure and loading', () => {
  it('renders a named landmark, the section nav and skeletons while loading', () => {
    const { r } = mount(adapterWith({ latencyMs: 5000 }));
    expect(r.get('h1').textContent).toBe('Settings');
    const landmark = r.get('section.nf-settings');
    expect(landmark.getAttribute('aria-labelledby')).toBe(r.get('h1').id);
    const nav = r.get('nav[aria-label="Settings sections"]');
    const items = Array.from(nav.querySelectorAll('button'));
    expect(items.map((b) => b.textContent)).toEqual(SETTINGS_SECTIONS.map((s) => s.label));
    expect(items.every((b) => b.disabled)).toBe(true);
    expect(r.get('.nf-settings__body').getAttribute('aria-busy')).toBe('true');
    expect(r.all('.nf-skeleton').length).toBeGreaterThan(0);
    expect(r.all('h2')).toHaveLength(0);
  });

  it('renders every section as a named landmark with labelled controls once loaded', async () => {
    const { r } = await ready(adapterWith());
    expect(r.all('h2').map((h) => h.textContent)).toEqual(SETTINGS_SECTIONS.map((s) => s.label));
    for (const s of r.all('section.nf-settings__section')) {
      const labelledBy = s.getAttribute('aria-labelledby')!;
      expect(s.querySelector(`[id="${labelledBy}"]`)?.tagName).toBe('H2');
    }
    for (const f of r.all('fieldset')) expect(f.querySelector('legend')?.textContent).toBeTruthy();
    // Every form control has an accessible name (label element or aria-label).
    for (const el of r.all('input, select')) {
      const named =
        (el as HTMLInputElement).labels?.length || el.getAttribute('aria-label') ? true : false;
      expect(named, el.outerHTML).toBe(true);
    }
    expect(r.get('.nf-settings__status').textContent).toBe('Changes save automatically');
    expect(r.get('.nf-settings__body').getAttribute('aria-busy')).toBe('false');
  });

  it('shows the adapter settings: relays, mints, seeding, buffer, hover preview, theme', async () => {
    const { r } = await ready(adapterWith());
    const rows = section(r, 'Relays').querySelectorAll('tbody tr');
    expect(Array.from(rows).map((tr) => tr.querySelector('th')?.textContent)).toEqual([
      'wss://relay.fixture-1.example',
      'wss://relay.fixture-2.example',
    ]);
    const flags = (i: number): boolean[] =>
      Array.from(rows[i]!.querySelectorAll<HTMLInputElement>('input[type=checkbox]')).map(
        (c) => c.checked,
      );
    expect(flags(0)).toEqual([true, true]);
    expect(flags(1)).toEqual([true, false]);
    const mints = section(r, 'Mints and top-up');
    const chip = mints.querySelector('.nf-settings__mints .nf-mint')!;
    expect(chip.textContent).toContain('mint.fixture-a.example');
    expect(chip.textContent).toContain('2,100 sats'); // wallet balance at that mint
    // The wallet's other mint is offered as a one-tap add.
    expect(mints.querySelector('.nf-settings__suggest')?.textContent).toContain(
      'mint.fixture-b.example',
    );
    expect(input(r, '-seeding-enabled').checked).toBe(true);
    expect(input(r, '-seeding-cap').value).toBe('50');
    expect(r.get('output').textContent).toBe('30 s');
    expect(input(r, '-playback-hover').checked).toBe(true);
    expect((r.get('input[type=radio][value="dark"]') as HTMLInputElement).checked).toBe(true);
    expect(section(r, 'Seeding').textContent).toContain('of 50 GB used');
  });

  it('renders no playback affordance, and every sats figure is a SatsBadge or MintChip', async () => {
    const { r } = await ready(
      adapterWith({}, { autoTopUp: { belowSats: 2500 as never, fromMint: MINTS.a } }),
    );
    expect(r.all('[aria-label*="Play" i], [aria-label*="Watch" i]')).toHaveLength(0);
    const walker = document.createTreeWalker(r.container, NodeFilter.SHOW_TEXT);
    const figures: Node[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode())
      if (/\d[\d,.]*\s*sats?\b/.test(n.textContent ?? '')) figures.push(n);
    expect(figures.length).toBeGreaterThan(0);
    for (const n of figures)
      expect(n.parentElement?.closest('.nf-sats, .nf-mint'), n.textContent ?? '').toBeTruthy();
    expect(r.get('.nf-settings__summary .nf-sats').getAttribute('aria-label')).toBe('2,500 sats');
  });
});

describe('Settings — account / signer', () => {
  it('shows the local signer, the viewer, and that the wallet key stays in the signer', async () => {
    const { r } = await ready(adapterWith());
    const s = section(r, 'Account');
    expect(s.querySelector('.nf-settings__identity-name')?.textContent).toBe('Fixture Viewer');
    expect(s.querySelector('.nf-settings__identity-key')?.textContent).toBe(
      `${ME.slice(0, 8)}…${ME.slice(-4)}`,
    );
    expect(s.textContent).toContain('Connected');
    expect(s.textContent).toContain('Local key (Local)');
    expect(s.textContent).toContain('never enters this app');
    // No change-signer method in the v3 contract: the choice is read-only without the shell.
    expect(s.querySelector('fieldset')!.disabled).toBe(true);
    expect(s.textContent).toContain('not available in this version');
    expect(s.querySelector<HTMLInputElement>('input[value="local"]')!.checked).toBe(true);
  });

  it('says when the wallet key must be decrypted into app memory (NIP-44 fallback)', async () => {
    const status: SignerStatus = {
      kind: 'nip46',
      pubkey: ME,
      locked: true,
      supportsSignSecret: false,
      detail: 'wss://bunker.example · 7e1f…a41b',
    };
    const { r } = await ready(override(adapterWith(), { signer: () => Promise.resolve(status) }));
    const s = section(r, 'Account');
    expect(s.textContent).toContain('Remote signer (NIP-46)');
    expect(s.textContent).toContain("decrypted into this app's memory");
    expect(s.textContent).toContain('Locked');
    expect(s.textContent).toContain('wss://bunker.example · 7e1f…a41b');
    expect(s.querySelector('.nf-settings__pill--locked')).toBeTruthy();
  });

  it('signed out: signer-not-detected, relay copy asks for a signer, auto top-up disabled', async () => {
    const { r } = await ready(adapterWith({ signedIn: false }));
    const s = section(r, 'Account');
    expect(s.querySelector('[data-preset="signer-not-detected"]')).toBeTruthy();
    expect(s.querySelector('.nf-state button')).toBeNull(); // no shell flow → no dead button
    expect(s.querySelectorAll('input[type=radio]:checked')).toHaveLength(0);
    expect(section(r, 'Relays').textContent).toContain('Connect a signer to publish this list');
    expect(input(r, '-mints-topup').disabled).toBe(true);
    expect(section(r, 'Mints and top-up').textContent).toContain(
      'Connect a signer to use your wallet',
    );
    // Local settings still work signed out.
    expect(input(r, '-playback-hover').disabled).toBe(false);
  });

  it('hands the signer choice to the shell and re-reads the signer when it finishes', async () => {
    const adapter = adapterWith({ failWith: 'no-signer' });
    const signer = vi.spyOn(adapter, 'signer');
    let finish: () => void = () => undefined;
    const onChangeSigner = vi.fn(
      () =>
        new Promise<void>((res) => {
          finish = res;
        }),
    );
    const { r } = await ready(adapter, { onChangeSigner });
    const s = section(r, 'Account');
    click(buttonByText(s, 'Connect signer'));
    expect(onChangeSigner).toHaveBeenLastCalledWith('nip07');
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    await flush();
    click(s.querySelector('input[value="nip46"]')!);
    expect(onChangeSigner).toHaveBeenLastCalledWith('nip46');
    expect(s.textContent).toContain('Connecting…');
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    await flush();
    expect(signer).toHaveBeenCalledTimes(3); // mount + after each finished flow
  });

  it('a failing signer degrades only its own section', async () => {
    const adapter = adapterWith();
    let calls = 0;
    const { r } = await ready(
      override(adapter, {
        signer: () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new Error('nip46: bunker did not answer'))
            : adapter.signer();
        },
      }),
    );
    const s = section(r, 'Account');
    expect(s.querySelector('[role=alert]')?.textContent).toContain('Could not reach your signer');
    expect(s.textContent).toContain('nip46: bunker did not answer');
    expect(r.all('h2')).toHaveLength(SETTINGS_SECTIONS.length);
    // Unreachable is not "signed out": no "connect a signer" copy elsewhere.
    expect(section(r, 'Relays').textContent).not.toContain('Connect a signer');
    expect(section(r, 'Mints and top-up').textContent).toContain('once your signer is reachable');
    click(buttonByText(s, 'Retry'));
    await flush();
    expect(s.textContent).toContain('Fixture Viewer');
  });
});

describe('Settings — relays', () => {
  it('rejects anything but wss:// inline without saving', async () => {
    const adapter = adapterWith();
    const update = vi.spyOn(adapter, 'updateSettings');
    const { r } = await ready(adapter);
    const field = input(r, '-relays-add');
    for (const [value, message] of [
      ['ws://relay.example', 'unencrypted ws:// relays are not allowed'],
      ['https://relay.example', 'Relays use wss://, not https://'],
      ['', 'Enter a relay address'],
      ['wss://relay.fixture-1.example/', 'already in your list'],
    ] as const) {
      type(field, value);
      submit(field);
      expect(field.getAttribute('aria-invalid')).toBe('true');
      const err = r.get(`[id="${field.getAttribute('aria-describedby')!}"]`);
      expect(err.getAttribute('role')).toBe('alert');
      expect(err.textContent).toContain(message);
    }
    expect(update).not.toHaveBeenCalled();
    type(field, 'wss://x');
    expect(field.hasAttribute('aria-invalid')).toBe(false); // editing clears the error
  });

  it('adds a wss:// relay (read + write), then clears the field', async () => {
    const adapter = adapterWith();
    const update = vi.spyOn(adapter, 'updateSettings');
    const onSettingsChange = vi.fn();
    const { r } = await ready(adapter, { onSettingsChange });
    const field = input(r, '-relays-add');
    type(field, ' wss://Relay.New.example/ ');
    submit(field);
    // Optimistic: the row is there before the adapter answers.
    expect(section(r, 'Relays').textContent).toContain('wss://relay.new.example');
    await flush();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).toEqual({
      relays: [
        { url: 'wss://relay.fixture-1.example', read: true, write: true },
        { url: 'wss://relay.fixture-2.example', read: true, write: false },
        { url: 'wss://relay.new.example', read: true, write: true },
      ],
    });
    expect(field.value).toBe('');
    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(r.get('.nf-settings__status').textContent).toBe('All changes saved');
  });

  it('toggles read/write, removes, and guards the last reader and writer', async () => {
    const adapter = adapterWith();
    const update = vi.spyOn(adapter, 'updateSettings');
    const { r } = await ready(adapter);
    const write1 = r.get(
      'input[aria-label="Write to wss://relay.fixture-1.example"]',
    ) as HTMLInputElement;
    const remove1 = r.get(
      'button[aria-label="Remove wss://relay.fixture-1.example"]',
    ) as HTMLButtonElement;
    expect(write1.disabled).toBe(true); // the only writer
    expect(remove1.disabled).toBe(true);
    click(r.get('input[aria-label="Write to wss://relay.fixture-2.example"]'));
    await flush();
    expect(update.mock.calls[0]![0].relays![1]).toEqual({
      url: 'wss://relay.fixture-2.example',
      read: true,
      write: true,
    });
    expect(write1.disabled).toBe(false); // two writers now
    click(r.get('button[aria-label="Remove wss://relay.fixture-2.example"]'));
    await flush();
    expect(update.mock.calls[1]![0].relays).toEqual([
      { url: 'wss://relay.fixture-1.example', read: true, write: true },
    ]);
    expect(
      (r.get('button[aria-label="Remove wss://relay.fixture-1.example"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('shows a designed empty state when there are no relays', async () => {
    const { r } = await ready(adapterWith({}, { relays: [], defaultMints: [] }));
    expect(section(r, 'Relays').textContent).toContain('No relays yet');
    expect(section(r, 'Mints and top-up').textContent).toContain('No default mint yet');
  });
});

describe('Settings — default mints and auto top-up', () => {
  it('validates, normalises and adds mints; one-tap add from the wallet; keeps one', async () => {
    const adapter = adapterWith();
    const update = vi.spyOn(adapter, 'updateSettings');
    const { r } = await ready(adapter);
    const s = section(r, 'Mints and top-up');
    expect(
      s.querySelector<HTMLButtonElement>('button[aria-label="Remove mint.fixture-a.example"]')!
        .disabled,
    ).toBe(true);
    const field = input(r, '-mints-add');
    type(field, 'http://mint.example');
    submit(field);
    expect(s.querySelector('[role=alert]')?.textContent).toContain('expose your ecash');
    type(field, 'https://Mint.New.example/');
    submit(field);
    await flush();
    expect(update.mock.calls[0]![0]).toEqual({
      defaultMints: [MINTS.a, 'https://mint.new.example'],
    });
    click(s.querySelector('.nf-settings__suggest button.nf-mint')!);
    await flush();
    expect(update.mock.calls[1]![0]).toEqual({
      defaultMints: [MINTS.a, 'https://mint.new.example', MINTS.b],
    });
    expect(s.querySelector('.nf-settings__suggest')).toBeNull();
    click(s.querySelector('button[aria-label="Remove mint.new.example"]')!);
    await flush();
    expect(update.mock.calls[2]![0]).toEqual({ defaultMints: [MINTS.a, MINTS.b] });
  });

  it('turns auto top-up on and off, edits threshold and mint', async () => {
    const adapter = adapterWith();
    const update = vi.spyOn(adapter, 'updateSettings');
    const { r } = await ready(adapter);
    click(input(r, '-mints-topup'));
    await flush();
    expect(update.mock.calls[0]![0]).toEqual({ autoTopUp: { belowSats: 1000, fromMint: MINTS.a } });
    const threshold = input(r, '-mints-threshold');
    type(threshold, '2,500');
    enter(threshold);
    await flush();
    expect(update.mock.calls[1]![0]).toEqual({ autoTopUp: { belowSats: 2500, fromMint: MINTS.a } });
    expect(r.get('.nf-settings__summary').textContent).toContain('2,500 sats');
    type(threshold, '1.5');
    enter(threshold);
    expect(r.get(`[id="${threshold.id}-error"]`).textContent).toContain('whole numbers');
    expect(update).toHaveBeenCalledTimes(2);
    const select = r.get('select') as HTMLSelectElement;
    act(() => {
      select.value = MINTS.b;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(update.mock.calls[2]![0]).toEqual({ autoTopUp: { belowSats: 2500, fromMint: MINTS.b } });
    click(input(r, '-mints-topup'));
    await flush();
    // "Off" = a zero threshold (a Partial<Settings> patch cannot delete the optional field).
    expect(update.mock.calls[3]![0]).toEqual({ autoTopUp: { belowSats: 0, fromMint: MINTS.b } });
    expect(input(r, '-mints-topup').checked).toBe(false);
    expect(r.all('.nf-settings__summary')).toHaveLength(0);
  });
});

describe('Settings — auto top-up amount (issue #2)', () => {
  it('shows the default (and max) 10,000, saves an amount, refuses one above the max, and keeps it through other edits', async () => {
    const adapter = adapterWith({}, { autoTopUp: { belowSats: 1000 as never, fromMint: MINTS.a } });
    const update = vi.spyOn(adapter, 'updateSettings');
    const { r } = await ready(adapter);
    const s = section(r, 'Mints and top-up');
    const amount = input(r, '-mints-amount');
    expect(amount.value).toBe('10000');
    // The copy: the daily cap, fees, the first-time confirm, never a manifest's mint.
    expect(s.textContent).toContain('50,000 sats');
    expect(s.textContent).toContain('in any 24 hours, Lightning fees included');
    expect(s.textContent).toContain('The first top-up into each mint asks you to confirm');
    expect(s.textContent).toContain('not on your list are never topped up');
    type(amount, '12,000');
    enter(amount);
    expect(r.get(`[id="${amount.id}-error"]`).textContent).toContain('10,000 sats per top-up');
    expect(update).not.toHaveBeenCalled();
    type(amount, '2,500');
    enter(amount);
    await flush();
    expect(update.mock.calls[0]![0]).toEqual({
      autoTopUp: { belowSats: 1000, fromMint: MINTS.a, amountSats: 2500 },
    });
    expect(r.get('.nf-settings__summary').textContent).toContain('2,500 sats');
    const threshold = input(r, '-mints-threshold');
    type(threshold, '1,500');
    enter(threshold);
    await flush();
    expect(update.mock.calls[1]![0]).toEqual({
      autoTopUp: { belowSats: 1500, fromMint: MINTS.a, amountSats: 2500 },
    });
    click(input(r, '-mints-topup'));
    await flush();
    expect(update.mock.calls[2]![0]).toEqual({
      autoTopUp: { belowSats: 0, fromMint: MINTS.a, amountSats: 2500 },
    });
  });

  it('is off by default', async () => {
    const { r } = await ready(adapterWith());
    expect(input(r, '-mints-topup').checked).toBe(false);
    expect(r.all('[id$="-mints-amount"]')).toHaveLength(0);
  });
});

describe('Settings — seeding, playback, appearance', () => {
  it('switches the live seeder through seeder.setEnabled (not updateSettings)', async () => {
    const adapter = adapterWith();
    const update = vi.spyOn(adapter, 'updateSettings');
    const setEnabled = vi.spyOn(adapter.seeder, 'setEnabled');
    const { r } = await ready(adapter);
    click(input(r, '-seeding-enabled'));
    await flush();
    expect(setEnabled).toHaveBeenCalledWith(false);
    expect(update).not.toHaveBeenCalled();
    expect(input(r, '-seeding-enabled').checked).toBe(false);
    expect(section(r, 'Seeding').textContent).toContain('paused'); // onStatus pushed the change
  });

  it('saves the disk cap in GB and rejects bad sizes inline', async () => {
    const adapter = adapterWith();
    const update = vi.spyOn(adapter, 'updateSettings');
    const { r } = await ready(adapter);
    const cap = input(r, '-seeding-cap');
    type(cap, 'abc');
    enter(cap);
    expect(r.get(`[id="${cap.id}-error"]`).textContent).toContain('Enter a number of GB');
    type(cap, '0');
    enter(cap);
    expect(r.get(`[id="${cap.id}-error"]`).textContent).toContain('between 1 and 10,000 GB');
    expect(update).not.toHaveBeenCalled();
    type(cap, '20');
    enter(cap);
    await flush();
    expect(update.mock.calls[0]![0]).toEqual({
      seeding: { enabled: true, diskCapBytes: 20 * GIB },
    });
    expect(cap.value).toBe('20');
    expect(section(r, 'Seeding').textContent).toContain('Currently 20 GB');
  });

  it('warns when the cap is below what is already stored', async () => {
    const adapter = adapterWith();
    const { bytesStored } = await adapter.seeder.status();
    expect(bytesStored).toBeGreaterThan(0);
    const { r } = await ready(adapter);
    type(input(r, '-seeding-cap'), String(bytesStored / GIB / 2));
    expect(section(r, 'Seeding').textContent).toContain('less than the');
    type(input(r, '-seeding-cap'), '50');
    expect(section(r, 'Seeding').textContent).not.toContain('less than the');
  });

  it('applies buffer presets and the slider (commit on release)', async () => {
    const adapter = adapterWith();
    const update = vi.spyOn(adapter, 'updateSettings');
    const { r } = await ready(adapter);
    const presets = r.get('[aria-label="Buffer presets"]');
    click(buttonByText(presets, 'Data saver · 10 s'));
    await flush();
    expect(update.mock.calls[0]![0]).toEqual({ prefetchSeconds: 10 });
    expect(buttonByText(presets, 'Data saver · 10 s').getAttribute('aria-pressed')).toBe('true');
    const slider = input(r, '-playback-prefetch');
    type(slider, '45');
    expect(update).toHaveBeenCalledTimes(1); // dragging does not save
    expect(r.get('output').textContent).toBe('45 s');
    fire(slider, new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    await flush();
    expect(update.mock.calls[1]![0]).toEqual({ prefetchSeconds: 45 });
    expect(section(r, 'Playback and performance').textContent).toContain('Buffer = money');
  });

  it('persists the theme through the adapter and never touches the document', async () => {
    const adapter = adapterWith();
    const update = vi.spyOn(adapter, 'updateSettings');
    const onSettingsChange = vi.fn<(s: SettingsData) => void>();
    const root = document.documentElement;
    root.setAttribute('data-theme', 'dark');
    const { r } = await ready(adapter, { onSettingsChange });
    click(r.get('input[type=radio][value="light"]'));
    await flush();
    click(r.get('input[type=radio][value="system"]'));
    await flush();
    expect(update.mock.calls.map((c) => c[0])).toEqual([{ theme: 'light' }, { theme: 'system' }]);
    expect(onSettingsChange.mock.calls.map((c) => c[0].theme)).toEqual(['light', 'system']);
    expect(root.getAttribute('data-theme')).toBe('dark'); // the shell applies it, not the screen
    root.removeAttribute('data-theme');
    expect(section(r, 'Appearance').textContent).toContain('Follows your device');
  });

  it('navigates to Studio › Seeder and Wallet', async () => {
    const { r, navigate } = await ready(adapterWith());
    click(buttonByText(section(r, 'Seeding'), /Studio/));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'studio', tab: 'seeder' });
    click(buttonByText(section(r, 'Mints and top-up'), /Wallet/));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'wallet' });
  });

  it('the section nav moves focus to the section heading', async () => {
    const { r } = await ready(adapterWith());
    const nav = r.get('nav');
    click(buttonByText(nav, 'Seeding'));
    expect(document.activeElement?.textContent).toBe('Seeding');
    expect(buttonByText(nav, 'Seeding').getAttribute('aria-current')).toBe('true');
    expect(buttonByText(nav, 'Account').hasAttribute('aria-current')).toBe(false);
  });
});

describe('Settings — save model', () => {
  it('rolls a failed toggle back, raises a toast, and Retry re-sends it', async () => {
    const adapter = adapterWith();
    const update = vi
      .spyOn(adapter, 'updateSettings')
      .mockRejectedValueOnce(new Error('relay-down: no relays reachable'));
    const { r } = await ready(adapter);
    const hover = input(r, '-playback-hover');
    click(hover);
    expect(hover.checked).toBe(false); // optimistic
    expect(r.get('.nf-settings__status').textContent).toBe('Saving…');
    await flush();
    expect(hover.checked).toBe(true); // rolled back
    expect(r.get('.nf-settings__status').textContent).toBe('Last change not saved');
    const toast = r.get('.nf-toast');
    expect(toast.getAttribute('role')).toBe('alert');
    expect(toast.textContent).toContain('Could not save hover preview');
    expect(toast.textContent).toContain('the change was undone');
    click(r.get('.nf-toast__action'));
    await flush();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]![0]).toEqual({ hoverPreview: false });
    expect(hover.checked).toBe(false);
    expect(r.all('.nf-toast')).toHaveLength(0);
  });

  // Security review F18: images without a signed hash stay placeholders until the user opts in.
  it('"Load images from any website" starts off and saves loadRemoteImages', async () => {
    const adapter = adapterWith();
    const update = vi.spyOn(adapter, 'updateSettings');
    const { r } = await ready(adapter);
    const remote = input(r, '-appearance-remote-images');
    expect(remote.checked).toBe(false);
    click(remote);
    await flush();
    expect(update).toHaveBeenLastCalledWith({ loadRemoteImages: true });
    expect(remote.checked).toBe(true);
  });

  // ADR 0015: sharing creators' thumbnails and avatars while seeding, on unless turned off.
  it('"Share creators’ thumbnails and avatars" starts on and saves seeding.serveImages', async () => {
    const adapter = adapterWith();
    const update = vi.spyOn(adapter, 'updateSettings');
    const { r } = await ready(adapter);
    const images = input(r, '-seeding-images');
    expect(images.checked).toBe(true);
    click(images);
    await flush();
    expect(update).toHaveBeenLastCalledWith({
      seeding: expect.objectContaining({ serveImages: false }) as unknown,
    });
    expect(images.checked).toBe(false);
  });

  // ADR 0015 part c: the profile picture goes to Pear through the adapter, then a re-read.
  it('"Change picture" sends the chosen image and refreshes; a wrong type is refused before', async () => {
    const adapter = adapterWith();
    const set = vi.spyOn(adapter, 'setProfilePicture');
    const profile = vi.spyOn(adapter, 'profile');
    const { r } = await ready(adapter);
    const pickerInput = input(r, '-account-picture');
    const choose = async (file: File): Promise<void> => {
      Object.defineProperty(pickerInput, 'files', { value: [file], configurable: true });
      fire(pickerInput, new Event('change', { bubbles: true }));
      await flush();
    };
    await choose(new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' }));
    expect(set).not.toHaveBeenCalled();
    expect(r.get('.nf-settings__picture [role="alert"]').textContent).toContain(
      'JPEG, PNG or WebP',
    );
    const before = profile.mock.calls.length;
    await choose(
      new File([Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)], 'me.jpg', { type: 'image/jpeg' }),
    );
    expect(set).toHaveBeenCalledTimes(1);
    const arg = set.mock.calls[0]![0];
    expect(arg.type).toBe('image/jpeg');
    expect([...arg.bytes]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    expect(profile.mock.calls.length).toBeGreaterThan(before); // the signer re-read the profile
  });

  it('never loses typed input when a save fails', async () => {
    const adapter = adapterWith();
    vi.spyOn(adapter, 'updateSettings').mockRejectedValue(new Error('disk full'));
    const { r } = await ready(adapter);
    const cap = input(r, '-seeding-cap');
    type(cap, '20');
    enter(cap);
    await flush();
    expect(cap.value).toBe('20');
    expect(r.get(`[id="${cap.id}-error"]`).textContent).toContain(
      'Not saved — still limited to 50 GB',
    );
    const relay = input(r, '-relays-add');
    type(relay, 'wss://relay.new.example');
    submit(relay);
    await flush();
    expect(relay.value).toBe('wss://relay.new.example');
    expect(section(r, 'Relays').querySelector('tbody')!.textContent).not.toContain('relay.new');
    expect(r.all('.nf-toast').length).toBe(2);
  });

  it('rolls back only the failed operation and sends writes in order', async () => {
    const adapter = adapterWith();
    const real = adapter.updateSettings.bind(adapter);
    const update = vi
      .spyOn(adapter, 'updateSettings')
      .mockImplementationOnce(() => Promise.reject(new Error('timeout')))
      .mockImplementation(real);
    const { r } = await ready(adapter);
    click(input(r, '-playback-hover')); // fails
    click(r.get('input[type=radio][value="light"]')); // succeeds
    expect(input(r, '-playback-hover').checked).toBe(false);
    expect((r.get('input[type=radio][value="light"]') as HTMLInputElement).checked).toBe(true);
    await flush();
    expect(update.mock.calls.map((c) => c[0])).toEqual([
      { hoverPreview: false },
      { theme: 'light' },
    ]);
    expect(input(r, '-playback-hover').checked).toBe(true);
    expect((r.get('input[type=radio][value="light"]') as HTMLInputElement).checked).toBe(true);
    expect((await adapter.settings()).theme).toBe('light');
  });

  it('recomputes list patches against confirmed settings, so a failed add is not resurrected', async () => {
    const adapter = adapterWith();
    const real = adapter.updateSettings.bind(adapter);
    const update = vi
      .spyOn(adapter, 'updateSettings')
      .mockImplementationOnce(() => Promise.reject(new Error('timeout')))
      .mockImplementation(real);
    const { r } = await ready(adapter);
    const field = input(r, '-relays-add');
    type(field, 'wss://a.example');
    submit(field);
    click(r.get('input[aria-label="Write to wss://relay.fixture-2.example"]'));
    await flush();
    expect(update.mock.calls[1]![0].relays!.map((x) => x.url)).toEqual([
      'wss://relay.fixture-1.example',
      'wss://relay.fixture-2.example',
    ]);
    expect(section(r, 'Relays').querySelector('tbody')!.textContent).not.toContain('a.example');
  });

  it('sends toasts to the shell when onToast is given (also after unmount)', async () => {
    const adapter = adapterWith();
    let reject: (e: Error) => void = () => undefined;
    vi.spyOn(adapter, 'updateSettings').mockImplementation(
      () =>
        new Promise((_res, rej) => {
          reject = rej;
        }),
    );
    const onToast = vi.fn<(t: ToastItem) => void>();
    const { r } = await ready(adapter, { onToast });
    click(input(r, '-playback-hover'));
    expect(r.all('.nf-toasts')).toHaveLength(0);
    r.unmount();
    rendered.splice(rendered.indexOf(r), 1);
    await act(async () => {
      reject(new Error('relay-down'));
      await Promise.resolve();
    });
    await flush();
    expect(onToast).toHaveBeenCalledTimes(1);
    expect(onToast.mock.calls[0]![0]).toMatchObject({
      tone: 'error',
      title: 'Could not save hover preview',
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('Settings — errors and cancellation', () => {
  it('relay down: a designed error with the detail, Retry reloads, nothing thrown', async () => {
    const adapter = adapterWith({ failWith: 'relay-down' });
    const settings = vi.spyOn(adapter, 'settings');
    const { r } = await ready(adapter);
    const alert = r.get('.nf-state--error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('Relay down');
    expect(alert.textContent).toContain('relay-down: no relays reachable');
    expect(r.all('nav')).toHaveLength(0);
    click(buttonByText(alert, 'Retry'));
    await flush();
    expect(settings).toHaveBeenCalledTimes(2);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('seeder status failure degrades to a note; the controls still work', async () => {
    const adapter = adapterWith();
    vi.spyOn(adapter.seeder, 'status').mockRejectedValue(new Error('seeder worker stopped'));
    const { r } = await ready(adapter);
    expect(section(r, 'Seeding').textContent).toContain('Seeder status is unavailable');
    expect(section(r, 'Seeding').textContent).toContain('seeder worker stopped');
    expect(input(r, '-seeding-enabled').disabled).toBe(false);
  });

  it('cancels loading on unmount: no follow-up calls, no state updates', async () => {
    const adapter = adapterWith({ latencyMs: 20 });
    const profile = vi.spyOn(adapter, 'profile');
    const image = vi.spyOn(adapter, 'image');
    const { r } = mount(adapter);
    r.unmount();
    rendered.splice(rendered.indexOf(r), 1);
    await act(async () => {
      await new Promise((res) => setTimeout(res, 60));
    });
    expect(profile).not.toHaveBeenCalled();
    expect(image).not.toHaveBeenCalled();
    expect(r.container.childElementCount).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('unsubscribes from live seeder status on unmount', async () => {
    const adapter = adapterWith();
    const off = vi.fn();
    vi.spyOn(adapter.seeder, 'onStatus').mockReturnValue(off);
    const { r } = await ready(adapter);
    r.unmount();
    rendered.splice(rendered.indexOf(r), 1);
    expect(off).toHaveBeenCalledTimes(1);
  });
});

describe('Settings — NFX network (contracts v10)', () => {
  const OFF = { enabled: false, network: 'nfx:testnet:1', scopedRelays: [] } as const;

  it('is off by default; switching it on saves the one network', async () => {
    const adapter = adapterWith();
    const update = vi.spyOn(adapter, 'updateSettings');
    const { r } = await ready(adapter);
    expect(section(r, 'NFX network').textContent).toContain('Take part in the NFX testnet');
    const toggle = input(r, '-nfx-enabled');
    expect(toggle.checked).toBe(false);
    click(toggle);
    await flush();
    expect(update.mock.calls.at(-1)![0]).toEqual({ nfx: { ...OFF, enabled: true } });
    expect(input(r, '-nfx-enabled').checked).toBe(true);
  });

  it('adds a scoped relay, ws:// only to this computer, and removes it', async () => {
    const adapter = adapterWith();
    const update = vi.spyOn(adapter, 'updateSettings');
    const { r } = await ready(adapter);
    const field = input(r, '-nfx-add');
    type(field, 'ws://relay.example');
    submit(field);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(update).not.toHaveBeenCalled();
    type(field, 'ws://127.0.0.1:7777');
    submit(field);
    await flush();
    expect(update.mock.calls.at(-1)![0]).toEqual({
      nfx: { ...OFF, scopedRelays: ['ws://127.0.0.1:7777'] },
    });
    expect(field.value).toBe('');
    click(r.get('[aria-label="Remove ws://127.0.0.1:7777"]'));
    await flush();
    expect(update.mock.calls.at(-1)![0]).toEqual({ nfx: OFF });
  });

  it('stops at eight scoped relays', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => `wss://r${String(i)}.example`);
    const adapter = adapterWith({}, { nfx: { ...OFF, scopedRelays: eight } } as never);
    const update = vi.spyOn(adapter, 'updateSettings');
    const { r } = await ready(adapter);
    const field = input(r, '-nfx-add');
    type(field, 'wss://r9.example');
    submit(field);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(update).not.toHaveBeenCalled();
  });
});
