/**
 * NfxWatch (contracts v9, ADR 0020): a free NFX video's page shows what it is and says plainly
 * that this build cannot play it. Nothing on it plays, pays, reacts or saves.
 */
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mocks } from '@sovit/core';
import type { NfxAddress } from '@sovit/core';
import { click, render, type Rendered } from '../../../components/testing/render.js';
import type { Route } from '../../shared/route.js';
import { NfxWatch } from '../NfxWatch.js';

const { MockNetworkAdapter, NFX_VIDEOS, CHANNELS } = mocks;
const NFX = NFX_VIDEOS[0]!;

async function flush(rounds = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

let mounted: Rendered | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function mount(
  adapter: mocks.MockNetworkAdapter,
  videoId: NfxAddress = NFX.id,
): { r: Rendered; navigate: ReturnType<typeof vi.fn<(to: Route) => void>> } {
  const navigate = vi.fn<(to: Route) => void>();
  const r = render(createElement(NfxWatch, { adapter, navigate, videoId, now: mocks.FIXTURE_NOW }));
  mounted = r;
  return { r, navigate };
}

describe('NfxWatch', () => {
  it("shows the video and its channel, and says it can't play yet", async () => {
    const adapter = new MockNetworkAdapter({ nfx: true });
    const { r, navigate } = mount(adapter);
    await flush();
    expect(r.get('.nf-watch__title').textContent).toBe(NFX.title);
    expect(r.container.textContent).toContain("Can't play this yet");
    expect(r.container.textContent).toContain('Free · NFX');
    const channel = CHANNELS.find((c) => c.pubkey === NFX.author)!;
    expect(r.get('.nf-nfxwatch__channel').textContent).toContain(channel.profile.displayName);
    click(r.get('.nf-nfxwatch__channel'));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'channel', pubkey: NFX.author });
  });

  it('plays only when asked, free: no paid session, stats, comments or money UI', async () => {
    const adapter = new MockNetworkAdapter({ nfx: true });
    const play = vi.spyOn(adapter, 'play');
    const playNfx = vi.spyOn(adapter, 'playNfx');
    const stats = vi.spyOn(adapter, 'stats');
    const comments = vi.spyOn(adapter, 'comments');
    const { r } = mount(adapter);
    await flush();
    expect(r.container.querySelector('video')).toBeNull();
    expect(playNfx).not.toHaveBeenCalled();
    click(r.get('.nf-nfxwatch__start button'));
    await flush();
    expect(playNfx).toHaveBeenCalledWith(NFX.id);
    const video = r.get('video.nf-nfxwatch__video');
    expect(video.getAttribute('src')).toBe(`fixture://nfx/${NFX.eventId}/720p`);
    for (const sel of [
      '.nf-sats--price',
      '.nf-reactions',
      '.nf-watch__actions',
      '.nf-watch__comments',
    ]) {
      expect(r.container.querySelector(sel), sel).toBeNull();
    }
    expect(play).not.toHaveBeenCalled();
    expect(stats).not.toHaveBeenCalled();
    expect(comments).not.toHaveBeenCalled();
  });

  it('switching quality closes the session and opens the other rendition', async () => {
    const adapter = new MockNetworkAdapter({ nfx: true });
    const closes: string[] = [];
    const real = adapter.playNfx.bind(adapter);
    const spy = vi.spyOn(adapter, 'playNfx').mockImplementation(async (addr, rendition) => {
      const s = await real(addr, rendition);
      return {
        ...s,
        close: () => {
          closes.push(s.rendition);
          return Promise.resolve();
        },
      };
    });
    const { r } = mount(adapter);
    await flush();
    click(r.get('.nf-nfxwatch__start button'));
    await flush();
    const select = r.get('.nf-nfxwatch__quality select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['720p', '360p']);
    act(() => {
      select.value = '360p';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(spy).toHaveBeenLastCalledWith(NFX.id, '360p');
    expect(closes).toEqual(['720p']);
    expect(r.get('video').getAttribute('src')).toBe(`fixture://nfx/${NFX.eventId}/360p`);
    r.unmount();
    mounted = undefined;
    await flush();
    expect(closes).toEqual(['720p', '360p']);
  });

  it('nobody seeding: says so, and Retry asks again', async () => {
    const adapter = new MockNetworkAdapter({ nfx: true, failWith: 'no-seeders' });
    const playNfx = vi.spyOn(adapter, 'playNfx');
    const { r } = mount(adapter);
    await flush();
    click(r.get('.nf-nfxwatch__start button'));
    await flush();
    expect(r.container.textContent).toContain('No seeders online');
    click(r.get('.nf-state--empty button'));
    await flush();
    expect(playNfx).toHaveBeenCalledTimes(2);
  });

  it('an unknown, deleted or priced address is "not found", with a way home', async () => {
    const adapter = new MockNetworkAdapter({ nfx: true });
    const missing = `38504:${NFX.author}:nfx:testnet:1:missing-video` as NfxAddress;
    const { r, navigate } = mount(adapter, missing);
    await flush();
    expect(r.container.textContent).toContain('Video not found');
    click(r.get('.nf-state--empty button'));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'home' });
  });

  it('a relay failure shows a retryable error', async () => {
    const adapter = new MockNetworkAdapter({ nfx: true, failWith: 'relay-down' });
    const nfxVideo = vi.spyOn(adapter, 'nfxVideo');
    const { r } = mount(adapter);
    await flush();
    expect(r.container.textContent).toContain('Relay down');
    expect(nfxVideo).toHaveBeenCalledTimes(1);
    click(r.get('.nf-state--error button'));
    await flush();
    expect(nfxVideo).toHaveBeenCalledTimes(2);
  });
});
