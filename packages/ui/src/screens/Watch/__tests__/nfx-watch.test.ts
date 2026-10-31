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

  it('never plays, pays, reacts or saves', async () => {
    const adapter = new MockNetworkAdapter({ nfx: true });
    const play = vi.spyOn(adapter, 'play');
    const stats = vi.spyOn(adapter, 'stats');
    const comments = vi.spyOn(adapter, 'comments');
    const video = vi.spyOn(adapter, 'video');
    const { r } = mount(adapter);
    await flush();
    for (const sel of [
      'video',
      '.nf-player',
      '.nf-sats--price',
      '.nf-reactions',
      '.nf-watch__actions',
      '.nf-watch__comments',
    ]) {
      expect(r.container.querySelector(sel), sel).toBeNull();
    }
    expect(r.container.querySelectorAll('button')).toHaveLength(1); // the channel link
    expect(play).not.toHaveBeenCalled();
    expect(stats).not.toHaveBeenCalled();
    expect(comments).not.toHaveBeenCalled();
    expect(video).not.toHaveBeenCalled();
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
