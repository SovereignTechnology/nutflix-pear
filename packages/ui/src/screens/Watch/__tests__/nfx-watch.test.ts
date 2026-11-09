/**
 * NfxWatch (ADR 0020): a free NFX video's page shows what it is (contracts v9) and plays it, free,
 * from its seeders (v11). Nothing on it pays, reacts or saves; a same-author NIP-71 twin's
 * comments show (slice 5d-4).
 */
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mocks } from '@sovit/core';
import type {
  MediaElementLike,
  NfxAddress,
  NfxPlayProblem,
  NfxPlaySession,
  NfxRenditionInfo,
} from '@sovit/core';
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
  it('shows the video and its channel, and a free Play', async () => {
    const adapter = new MockNetworkAdapter({ nfx: true });
    const { r, navigate } = mount(adapter);
    await flush();
    expect(r.get('.nf-watch__title').textContent).toBe(NFX.title);
    expect(r.get('.nf-nfxwatch__start button').textContent).toBe('Play — free');
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

  it("slice 5d-4: a NIP-71 video's NFX copy shows that event's comments, same author only", async () => {
    const legacy = mocks.VIDEOS.find((v) => v.author !== NFX.author)!;
    const same = new MockNetworkAdapter({ nfx: true });
    vi.spyOn(same, 'nfxVideo').mockResolvedValue({
      ...NFX,
      author: legacy.author,
      legacyId: legacy.id,
    });
    const asked = vi.spyOn(same, 'comments');
    const first = mount(same);
    await flush();
    expect(first.r.get('.nf-watch__comments')).toBeTruthy();
    expect(asked.mock.calls[0]?.[0]).toBe(legacy.id);
    first.r.unmount();
    mounted = undefined;

    // Another author's event: no thread at all, and nothing asked for it.
    const other = new MockNetworkAdapter({ nfx: true });
    vi.spyOn(other, 'nfxVideo').mockResolvedValue({ ...NFX, legacyId: legacy.id });
    const notAsked = vi.spyOn(other, 'comments');
    const { r } = mount(other);
    await flush();
    expect(r.container.querySelector('.nf-watch__comments')).toBeNull();
    expect(notAsked).not.toHaveBeenCalled();
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

  it("v14: an element source is attached to the page's <video>, with no src, and detached when the page goes", async () => {
    const adapter = new MockNetworkAdapter({ nfx: true });
    const real = adapter.playNfx.bind(adapter);
    const attached: MediaElementLike[] = [];
    let detached = 0;
    vi.spyOn(adapter, 'playNfx').mockImplementation(async (addr, rendition) => {
      const s = await real(addr, rendition);
      return {
        ...s,
        source: {
          kind: 'element',
          attach: (el) => {
            attached.push(el);
            return () => {
              detached++;
            };
          },
        },
      };
    });
    const { r } = mount(adapter);
    await flush();
    click(r.get('.nf-nfxwatch__start button'));
    await flush();
    const video = r.get('video.nf-nfxwatch__video');
    expect(attached).toEqual([video]);
    expect(video.hasAttribute('src')).toBe(false);
    expect(detached).toBe(0);
    r.unmount();
    mounted = undefined;
    await flush();
    expect(detached).toBe(1);
  });

  it('v14: a session with setRendition switches quality in place; one that fails is reopened', async () => {
    const adapter = new MockNetworkAdapter({ nfx: true });
    const real = adapter.playNfx.bind(adapter);
    const asked: string[] = [];
    let fail = false;
    const opened: NfxPlaySession[] = [];
    const playNfx = vi.spyOn(adapter, 'playNfx').mockImplementation(async (addr, rendition) => {
      const s = await real(addr, rendition);
      const session: NfxPlaySession = {
        ...s,
        setRendition: (id) => {
          asked.push(id);
          return fail ? Promise.reject(new Error('relay-down: gone')) : Promise.resolve();
        },
      };
      opened.push(session);
      return session;
    });
    const { r } = mount(adapter);
    await flush();
    click(r.get('.nf-nfxwatch__start button'));
    await flush();
    const choose = (id: string): void => {
      const select = r.get('.nf-nfxwatch__quality select') as HTMLSelectElement;
      act(() => {
        select.value = id;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
    choose('360p');
    await flush();
    expect(asked).toEqual(['360p']);
    expect(playNfx).toHaveBeenCalledTimes(1);
    expect((r.get('.nf-nfxwatch__quality select') as HTMLSelectElement).value).toBe('360p');

    fail = true;
    choose('720p');
    await flush();
    expect(asked).toEqual(['360p', '720p']);
    expect(playNfx).toHaveBeenCalledTimes(2);
    expect(playNfx).toHaveBeenLastCalledWith(NFX.id, '720p');
    expect(opened).toHaveLength(2);
  });

  it('v15: renditions an element source learns after attach reach the quality picker', async () => {
    const adapter = new MockNetworkAdapter({ nfx: true });
    const real = adapter.playNfx.bind(adapter);
    let renditions: readonly NfxRenditionInfo[] = [];
    const listeners = new Set<() => void>();
    vi.spyOn(adapter, 'playNfx').mockImplementation(async (addr, rendition) => {
      const s = await real(addr, rendition);
      return {
        videoId: s.videoId,
        rendition: 'auto',
        get renditions() {
          return renditions;
        },
        source: { kind: 'element', attach: () => () => undefined },
        setRendition: () => Promise.resolve(),
        onChange: (cb) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        close: () => Promise.resolve(),
      };
    });
    const { r } = mount(adapter);
    await flush();
    click(r.get('.nf-nfxwatch__start button'));
    await flush();
    expect(r.container.querySelector('.nf-nfxwatch__quality')).toBeNull();
    expect(listeners.size).toBe(1);
    renditions = [
      { id: 'l0', bandwidth: 800_000, resolution: '640x360' },
      { id: 'l1', bandwidth: 2_500_000, resolution: '1280x720' },
    ];
    act(() => {
      for (const cb of listeners) cb();
    });
    const select = r.get('.nf-nfxwatch__quality select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Auto', '640x360', '1280x720']);
    expect(select.value).toBe('');
    r.unmount();
    mounted = undefined;
    expect(listeners.size).toBe(0);
  });

  it('v15: the problems a session reports are shown, and a stopped play can be tried again', async () => {
    const adapter = new MockNetworkAdapter({ nfx: true });
    const real = adapter.playNfx.bind(adapter);
    let problems: NfxPlayProblem[] = [];
    let tell: () => void = () => undefined;
    const playNfx = vi.spyOn(adapter, 'playNfx').mockImplementation(async (addr, rendition) => {
      const s = await real(addr, rendition);
      return {
        ...s,
        get problems() {
          return problems;
        },
        onChange: (cb) => {
          tell = cb;
          return () => undefined;
        },
      };
    });
    const { r } = mount(adapter);
    await flush();
    click(r.get('.nf-nfxwatch__start button'));
    await flush();
    expect(r.container.querySelector('.nf-nfxwatch__problems')).toBeNull();
    problems = [
      { kind: 'origin', message: 'https://a.example/o: hash list: HTTP 503' },
      { kind: 'refused', message: 'Refused b.example/…/x.m4s: sha256 mismatch' },
      { kind: 'refused', message: 'Refused b.example/…/y.m4s: sha256 mismatch' },
    ];
    act(() => {
      tell();
    });
    const text = r.get('.nf-nfxwatch__problems').textContent;
    expect(text).toContain('2 files did not match the video’s hash list and were refused.');
    expect(text).toContain('Refused b.example/…/y.m4s: sha256 mismatch');
    expect(text).toContain('An origin did not serve a hash list that verifies, so it was skipped.');
    expect(r.container.querySelector('[role="alert"]')).toBeNull();
    problems = [
      ...problems,
      { kind: 'stopped', message: 'no origin served a hash list that verifies' },
    ];
    act(() => {
      tell();
    });
    expect(r.get('[role="alert"]').textContent).toContain(
      'Playback stopped. no origin served a hash list that verifies',
    );
    problems = [];
    click(r.get('.nf-nfxwatch__problem--stopped button'));
    await flush();
    expect(playNfx).toHaveBeenCalledTimes(2);
    expect(playNfx).toHaveBeenLastCalledWith(NFX.id);
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
