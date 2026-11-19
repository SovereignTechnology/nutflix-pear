/**
 * Stats for nerds (contracts v19, ADR 0024): the panel's rows and sources (pure), the panel, and
 * the rule the hook holds — addresses off on every open, asked for only while on, and only the
 * shown ones copied.
 */
import { act, createElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NfxPlayStats, PlaySourceAddress } from '@sovit/core';
import { NerdStats, useNerdStats, type NerdFeed } from '../NerdStats/NerdStats.js';
import {
  addressText,
  copyText,
  formatByteCount,
  pathText,
  peerSpendRows,
  sampleElement,
  shortSourceId,
  sourceRows,
  statRows,
} from '../NerdStats/model.js';
import { click, fire, render, type Rendered } from '../testing/render.js';

const KEY = 'ab'.repeat(32);
const STATS: NfxPlayStats = {
  engine: 'hls.js 1.7.4 + p2p-media-loader 4.0.0',
  sources: [
    {
      kind: 'origin',
      id: 'origin.example',
      via: 'beacon',
      bytesDown: 1024,
      bytesUp: 0,
      files: 2,
      connected: true,
    },
    {
      kind: 'webrtc',
      id: KEY,
      via: 'nostr',
      bytesDown: 3072,
      bytesUp: 512,
      files: 3,
      connected: true,
    },
    {
      kind: 'iroh',
      id: 'x\u0000y',
      via: '',
      bytesDown: 0,
      bytesUp: 0,
      files: 0,
      connected: false,
      label: 'odd',
    },
  ],
  peers: { connected: 1, total: 2 },
  signaling: { kind: 'nostr', endpoints: ['relay.example'], open: 1 },
  verified: 5,
  refused: 1,
  bandwidthEstimate: 12_345_000,
};
const ADDRESS: PlaySourceAddress = {
  kind: 'webrtc',
  id: KEY,
  address: '203.0.113.7:50000',
  path: 'direct',
  rttMs: 24,
  detail: 'srflx/udp',
};

async function flush(rounds = 6): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

describe('stats for nerds: the model', () => {
  it('formats bytes in binary units', () => {
    expect([0, 1023, 1024, 10 * 1024 ** 2, -1, Number.NaN].map(formatByteCount)).toEqual([
      '0 B',
      '1023 B',
      '1.00 KiB',
      '10.0 MiB',
      '–',
      '–',
    ]);
  });

  it('shows a key by 8 hex, an origin whole, anything else cut and made printable', () => {
    expect(shortSourceId({ kind: 'webrtc', id: KEY })).toBe('abababab');
    expect(shortSourceId({ kind: 'origin', id: 'origin.example' })).toBe('origin.example');
    expect(shortSourceId({ kind: 'webrtc', id: `-NX0100-${'z'.repeat(40)}` })).toHaveLength(20);
    expect(shortSourceId({ kind: 'iroh', id: 'x\u0000y' })).toBe('x?y');
  });

  it('rows: the share from peers, peers, signaling, verified, playback', () => {
    const rows = Object.fromEntries(
      statRows(
        STATS,
        { width: 1280, height: 720, bufferAheadSec: 8.04, droppedFrames: 2, totalFrames: 300 },
        { rendition: '720p' },
      ),
    );
    expect(rows).toMatchObject({
      Engine: 'hls.js 1.7.4 + p2p-media-loader 4.0.0',
      Rendition: '720p',
      Resolution: '1280x720',
      'Buffer health': '8.0 s',
      'Dropped frames': '2 of 300',
      'Bandwidth estimate': '12.35 Mb/s',
      'From peers': '75% (3.00 KiB of 4.00 KiB)',
      Uploaded: '512 B',
      Peers: '1 connected, 2 since start',
      Signaling: 'Nostr, 1 of 1 relays open: relay.example',
      'Verified files': '5, 1 refused',
    });
    expect(statRows(null, null)).toEqual([]);
  });

  it('sources and the paid seeders, as text', () => {
    const rows = sourceRows(STATS.sources);
    expect(rows.map((r) => [r.source, r.id, r.via, r.down, r.up, r.files, r.connected])).toEqual([
      ['HTTPS origin', 'origin.example', 'beacon', '1.00 KiB', '0 B', '2', true],
      ['WebRTC peer', 'abababab', 'nostr', '3.00 KiB', '512 B', '3', true],
      ['iroh seeder (odd)', 'x?y', '–', '0 B', '0 B', '0', false],
    ]);
    const paid = peerSpendRows([
      { pubkey: 'cd'.repeat(32) as never, sats: 5 as never, ratePerMin: 1 as never, blocks: 3 },
      { pubkey: 'ef'.repeat(32) as never, sats: 9 as never, ratePerMin: 2 as never, blocks: 7 },
    ]);
    expect(paid.map((r) => [r.id, r.down, r.files])).toEqual([
      ['efefefef', '7 blocks', '9 sats'],
      ['cdcdcdcd', '3 blocks', '5 sats'],
    ]);
  });

  it('addresses and paths say what is hidden or unknown, never guess', () => {
    expect(addressText(ADDRESS)).toBe('203.0.113.7:50000');
    expect(addressText({ ...ADDRESS, address: '' })).toBe('hidden');
    expect(addressText(undefined)).toBe('–');
    expect(pathText(ADDRESS)).toBe('direct (srflx/udp, 24 ms)');
    expect(
      pathText({
        ...ADDRESS,
        path: 'relayed',
        via: 'turn.example',
        detail: undefined as never,
        rttMs: undefined as never,
      }),
    ).toBe('relayed via turn.example');
    expect(pathText({ ...ADDRESS, path: 'unknown' })).toBe('srflx/udp, 24 ms');
    expect(pathText({ kind: 'webrtc', id: KEY, address: '', path: 'unknown' })).toBe('–');
  });

  it('copy: short ids only, and addresses only while shown', () => {
    const sources = sourceRows(STATS.sources);
    const without = copyText([['Engine', 'e']], sources, null);
    expect(without).not.toContain(KEY);
    expect(without).not.toContain('203.0.113');
    const shown = JSON.parse(copyText([], sources, new Map([[KEY, ADDRESS]]))) as {
      sources: { id: string; address?: string }[];
    };
    expect(shown.sources[1]).toMatchObject({ id: 'abababab', address: '203.0.113.7:50000' });
    expect(JSON.stringify(shown)).not.toContain(KEY);
  });

  it('samples buffer ahead and frames from an element', () => {
    const s = sampleElement({
      videoWidth: 640,
      videoHeight: 360,
      currentTime: 10,
      buffered: { length: 2, start: (i) => [0, 20][i] ?? 0, end: (i) => [15, 30][i] ?? 0 },
      getVideoPlaybackQuality: () => ({ droppedVideoFrames: 1, totalVideoFrames: 99 }),
    });
    expect(s).toEqual({
      width: 640,
      height: 360,
      bufferAheadSec: 5,
      droppedFrames: 1,
      totalFrames: 99,
    });
    expect(
      sampleElement({
        videoWidth: 0,
        videoHeight: 0,
        currentTime: 0,
        buffered: { length: 0, start: () => 0, end: () => 0 },
      }).droppedFrames,
    ).toBeNull();
  });
});

let mounted: Rendered | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
});

function Harness({
  open,
  feed,
}: {
  readonly open: boolean;
  readonly feed: NerdFeed<NfxPlayStats>;
}): ReactElement | null {
  const nerd = useNerdStats(open, feed, 50);
  if (!open) return null;
  return createElement(NerdStats, {
    rows: statRows(nerd.stats, nerd.sample),
    sources: sourceRows(nerd.stats?.sources ?? []),
    canShowAddresses: nerd.canShowAddresses,
    showAddresses: nerd.showAddresses,
    addresses: nerd.addresses,
    onShowAddresses: nerd.setShowAddresses,
    onClose: () => undefined,
  });
}

describe('stats for nerds: the panel', () => {
  it('addresses are off when it opens, asked only while on, and off again on reopen', async () => {
    const stats = vi.fn(() => Promise.resolve(STATS));
    const addresses = vi.fn(() => Promise.resolve([ADDRESS]));
    const feed = { stats, addresses, element: () => null };
    mounted = render(createElement(Harness, { open: true, feed }));
    await flush();
    const r = mounted;
    expect(stats).toHaveBeenCalled();
    expect(r.get('[data-testid="nerd-stats"]').textContent).toContain('abababab');
    expect(r.container.textContent).not.toContain(KEY);
    const box = r.get('.nf-nerd__switch input') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(r.all('.nf-nerd__addr')).toHaveLength(0);
    expect(r.all('.nf-nerd__banner')).toHaveLength(0);
    // Polling while off never asks for addresses.
    await act(async () => {
      await new Promise((res) => setTimeout(res, 120));
    });
    expect(addresses).not.toHaveBeenCalled();

    click(box);
    await flush();
    expect(addresses).toHaveBeenCalled();
    expect(r.get('.nf-nerd__banner').textContent).toContain('IP addresses');
    expect(r.all('.nf-nerd__addr').map((e) => e.textContent)).toContain('203.0.113.7:50000');

    // Closed and opened again: off, and nothing shown.
    r.rerender(createElement(Harness, { open: false, feed }));
    await flush();
    r.rerender(createElement(Harness, { open: true, feed }));
    await flush();
    expect((r.get('.nf-nerd__switch input') as HTMLInputElement).checked).toBe(false);
    expect(r.all('.nf-nerd__addr')).toHaveLength(0);
  });

  it('ignores older stats that finish after a newer request', async () => {
    vi.useFakeTimers();
    let resolveOld!: (s: NfxPlayStats) => void;
    const old = new Promise<NfxPlayStats>((resolve) => {
      resolveOld = resolve;
    });
    const stats = vi
      .fn()
      .mockReturnValueOnce(old)
      .mockResolvedValue({ ...STATS, engine: 'newer' });
    mounted = render(createElement(Harness, { open: true, feed: { stats, element: () => null } }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(mounted.container.textContent).toContain('newer');
    await act(async () => {
      resolveOld({ ...STATS, engine: 'older' });
      await Promise.resolve();
    });
    expect(mounted.container.textContent).toContain('newer');
    expect(mounted.container.textContent).not.toContain('older');
  });

  it('a play that cannot say where its connections go has no switch', async () => {
    mounted = render(
      createElement(Harness, {
        open: true,
        feed: { stats: () => Promise.resolve(STATS), element: () => null },
      }),
    );
    await flush();
    expect(mounted.all('.nf-nerd__switch')).toHaveLength(0);
  });

  it('copies through the clipboard, saying whether addresses went with it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    mounted = render(
      createElement(Harness, {
        open: true,
        feed: { stats: () => Promise.resolve(STATS), element: () => null },
      }),
    );
    await flush();
    const copy = mounted.all('.nf-nerd__button').find((b) => b.textContent === 'Copy');
    if (copy === undefined) throw new Error('no Copy');
    fire(copy, new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String((writeText.mock.calls[0] as unknown[])[0])).not.toContain(KEY);
    expect(mounted.container.textContent).toContain('Copied (no addresses).');
  });
});
