/**
 * The web shell (ADR 0022): `@sovit/ui`'s shell over the web adapter with the web's offer. Nothing a
 * viewer can reach needs what the adapter rejects: Shorts, Subscriptions, Library, Studio and
 * Wallet are not in the sidebar and their routes show Home, Home lists the Network and Tags feeds,
 * Settings shows Appearance, Playback, Relays and NFX with the line about IP addresses. The route
 * follows the page's hash both ways.
 */
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { NostrPubkey } from '@sovit/core';
import { FakeRelayPool } from '@sovit/core/nostr';

import { startWebClient, type WebClient } from '../main.js';
import { WebSettingsStore } from '../settings/store.js';
import { FakeNfxPlayer } from './support/fake-nfx-lib.js';
import { Key, addrOf, manifest } from './support/nfx.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const running: { client: WebClient; container: HTMLElement }[] = [];
afterEach(async () => {
  for (const { client, container } of running.splice(0)) {
    await act(async () => {
      await client.stop();
    });
    container.remove();
  }
  window.history.replaceState(null, '', '/');
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((r) => {
        setTimeout(r, 0);
      });
    }
  });
}

const NOW = Math.floor(Date.now() / 1000);

/** A relay holding one free NFX video. */
function world(): { readonly pool: FakeRelayPool; readonly addr: string } {
  const pool = new FakeRelayPool();
  const creator = new Key();
  pool.store(
    manifest(creator, 'free-video-1', { title: 'Orbits of Jupiter', createdAt: NOW - 3600 }),
  );
  return { pool, addr: addrOf(creator, 'free-video-1') };
}

async function start(
  url = '/',
  w = world(),
): Promise<{
  client: WebClient;
  container: HTMLElement;
  player: FakeNfxPlayer;
  addr: string;
}> {
  window.history.replaceState(null, '', url);
  const pool = w.pool;
  const player = new FakeNfxPlayer();
  const container = document.createElement('div');
  document.body.appendChild(container);
  let client: WebClient | undefined;
  act(() => {
    client = startWebClient({
      container,
      player,
      pool,
      settings: new WebSettingsStore({ storage: null }),
      fetch: () => Promise.resolve(new Response('', { status: 404 })),
    });
  });
  if (client === undefined) throw new Error('not started');
  running.push({ client, container });
  await flush();
  return { client, container, player, addr: w.addr };
}

const navLabels = (c: HTMLElement): (string | null)[] =>
  Array.from(c.querySelectorAll('.nf-shell__sidebar .nf-shell__nav-item')).map(
    (b) => b.textContent,
  );

const route = (c: HTMLElement): string | null =>
  c.querySelector('.nf-shell')?.getAttribute('data-route') ?? null;

async function goHash(hash: string): Promise<void> {
  window.history.replaceState(null, '', hash);
  act(() => {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await flush();
}

describe('the web shell (ADR 0022)', () => {
  it('the sidebar offers Home and Settings only; Home the Network and Tags feeds', async () => {
    const { container, player } = await start();
    expect(navLabels(container)).toEqual(['Home', 'Settings']);
    expect(player.opens).toHaveLength(0);
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')).map((t) => t.textContent);
    expect(tabs).toEqual(['Your tags', 'Network']);
    expect(container.textContent).toContain('Orbits of Jupiter');
    expect(container.textContent).not.toContain('Connect signer');
  });

  it('the hidden screens’ routes show Home, from a link or from the router', async () => {
    const { container } = await start('/#/wallet');
    expect(route(container)).toBe('home');
    expect(window.location.hash).toBe('#/');
    for (const hash of ['#/studio', '#/shorts', '#/library']) {
      await goHash(hash);
      expect(route(container), hash).toBe('home');
      expect(window.location.hash, hash).toBe('#/');
    }
  });

  it('#/watch/<addr> opens the NFX watch page', async () => {
    const { container, addr } = await start();
    await goHash(`#/watch/${addr}`);
    expect(route(container)).toBe('watch');
    expect(container.querySelector('.nf-watch__title')?.textContent).toBe('Orbits of Jupiter');
  });

  it('`?a=<addr>` opens it too, and the address becomes the hash form', async () => {
    const w = world();
    const { container } = await start(`/?a=${encodeURIComponent(w.addr)}`, w);
    expect(route(container)).toBe('watch');
    expect(container.querySelector('.nf-watch__title')?.textContent).toBe('Orbits of Jupiter');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe(`#/watch/${w.addr}`);
  });

  it('Settings: Appearance, Playback, Relays and NFX; the IP address line; no switch that does nothing here', async () => {
    const { container } = await start('/#/settings');
    expect(route(container)).toBe('settings');
    const headings = Array.from(container.querySelectorAll('h2')).map((h) => h.textContent);
    expect(headings).toEqual(['Appearance', 'Playback and performance', 'Relays', 'NFX network']);
    const notice = container.querySelector('[id$="-nfx-mesh-notice"]');
    expect(notice?.textContent).toContain('Trackers and the peers you meet see your IP address.');
    expect(container.querySelector('[id$="-appearance-remote-images"]')).toBeNull();
    expect(container.querySelector('[id$="-nfx-enabled"]')).toBeNull();
    expect(container.querySelector('[id$="-nfx-iroh-add"]')).toBeNull();
    expect(container.textContent).toContain('wss://web.nutflix.xyz/tracker');
    expect(container.textContent).toContain('wss://relay.nutflix.xyz');
    // T13 and AGPL-3.0 §13: the source the page was built from, and what a browser cannot promise.
    expect(container.querySelector('.nf-settings__source a')?.getAttribute('href')).toBe(
      'source.json',
    );
  });

  it('the route follows the hash, and the hash the route', async () => {
    const { client, container } = await start();
    await goHash('#/settings');
    expect(route(container)).toBe('settings');
    const pk = 'ab'.repeat(32) as NostrPubkey;
    await goHash(`#/channel/${pk}`);
    expect(route(container)).toBe('channel');
    // A navigation inside the shell writes the hash (replaced: the shell keeps its own history).
    const home = container.querySelector<HTMLButtonElement>(
      '.nf-shell__sidebar .nf-shell__nav-item',
    );
    act(() => {
      home?.click();
    });
    await flush();
    expect(route(container)).toBe('home');
    expect(window.location.hash).toBe('#/');
    expect(client.adapter.platform).toBe('web');
  });

  it('stop() unmounts the shell and stops following the hash', async () => {
    const { client, container } = await start();
    await act(async () => {
      await client.stop();
    });
    running.splice(0);
    expect(container.querySelector('.nf-shell')).toBeNull();
    await goHash('#/settings');
    expect(container.querySelector('.nf-shell')).toBeNull();
    await client.stop();
  });
});
