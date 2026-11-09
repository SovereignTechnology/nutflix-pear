/**
 * The `element` source of a web play (contracts v14): one element at a time, everything the
 * player started stopped on detach and close, the player's refusal kept, renditions from its
 * levels.
 */
import { describe, expect, it } from 'vitest';

import type { MediaElementLike, NfxAddress } from '@sovit/core';

import { FakeNfxPlayer } from '../../__tests__/support/fake-nfx-lib.js';
import { tick } from '../../__tests__/support/nfx.js';
import { WebAdapterError } from '../../errors.js';
import { WebNfxSession, levelId, levelOf } from '../session.js';

const ADDR = `38504:${'a'.repeat(64)}:nfx:testnet:1:v` as NfxAddress;

function session(player: FakeNfxPlayer, o: { level?: number } = {}) {
  const closed: WebNfxSession[] = [];
  const s = new WebNfxSession({
    videoId: ADDR,
    manifestJson: '{"kind":38504}',
    origins: ['https://o.example/o'],
    trackers: [],
    iceServers: [],
    level: o.level,
    player: () => player.init().then(() => player),
    onClose: (x) => closed.push(x),
  });
  return { s, closed };
}

function attach(s: WebNfxSession, el: MediaElementLike): () => void {
  return s.source.attach(el);
}

describe('WebNfxSession', () => {
  it('level ids', () => {
    expect(levelId(0)).toBe('l0');
    expect(levelOf('l12')).toBe(12);
    for (const bad of ['l', 'l01', 'l1000', '0', 'L1', 'l-1', ' l1'])
      expect(levelOf(bad), bad).toBeNull();
  });

  it('attaching a second element detaches the first; detaching a stale one changes nothing', async () => {
    const player = new FakeNfxPlayer();
    const { s } = session(player);
    const a = document.createElement('video');
    const b = document.createElement('video');
    const offA = attach(s, a);
    await tick();
    const first = player.last;
    attach(s, b);
    await tick();
    expect(first.session.destroyed).toBe(1);
    expect(first.options.signal?.aborted).toBe(true);
    expect(player.last.el).toBe(b);
    offA();
    expect(player.last.session.destroyed).toBe(0);
    await s.close();
    expect(player.last.session.destroyed).toBe(1);
  });

  it('a detach before the player opened: the session it opens is destroyed at once', async () => {
    const player = new FakeNfxPlayer();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = new WebNfxSession({
      videoId: ADDR,
      manifestJson: '{}',
      origins: ['https://o.example/o'],
      trackers: ['wss://t.example/a'],
      iceServers: [{ urls: ['stun:s.example:3478'] }],
      player: () => gate.then(() => player),
    });
    const off = attach(s, document.createElement('video'));
    off();
    release();
    await tick();
    expect(player.opens).toHaveLength(0);
  });

  it('closing is idempotent, told once, and an attach after it does nothing', async () => {
    const player = new FakeNfxPlayer();
    const { s, closed } = session(player);
    await s.close();
    await s.close();
    expect(closed).toEqual([s]);
    expect(s.closed).toBe(true);
    attach(s, document.createElement('video'))();
    await tick();
    expect(player.opens).toHaveLength(0);
  });

  it('the player’s refusal and its fatal errors are kept; events after a detach are not', async () => {
    const player = new FakeNfxPlayer();
    player.refuse = 'no origin served a hash list that verifies';
    const { s } = session(player);
    attach(s, document.createElement('video'));
    await tick();
    expect(s.error).toBe('no origin served a hash list that verifies');
    player.refuse = null;
    const off = attach(s, document.createElement('video'));
    await tick();
    const lib = player.last.session;
    lib.emit({ type: 'error', message: 'networkError:fragLoadError' });
    expect(s.error).toBe('networkError:fragLoadError');
    off();
    lib.emit({ type: 'error', message: 'late' });
    lib.parsed([{ index: 0, width: 1, height: 1, bitrate: 1 }]);
    expect(s.error).toBe('networkError:fragLoadError');
    expect(s.renditions).toEqual([]);
  });

  it('levels the player already has at open are the renditions; one without a size has no resolution', async () => {
    const player = new FakeNfxPlayer();
    player.levels = [
      { index: 0, width: 0, height: 0, bitrate: 96_000 },
      { index: 1, width: 1920, height: 1080, bitrate: 5_000_000 },
    ];
    const { s } = session(player, { level: 1 });
    expect(s.rendition).toBe('l1');
    attach(s, document.createElement('video'));
    await tick();
    expect(player.last.options.level).toBe(1);
    expect(s.renditions).toEqual([
      { id: 'l0', bandwidth: 96_000 },
      { id: 'l1', bandwidth: 5_000_000, resolution: '1920x1080' },
    ]);
  });

  it('setRendition before the player opened, or after a detach, is invalid-argument', async () => {
    const player = new FakeNfxPlayer();
    const { s } = session(player);
    await expect(s.setRendition('l0')).rejects.toBeInstanceOf(WebAdapterError);
    player.levels = [{ index: 0, width: 1, height: 1, bitrate: 1 }];
    const off = attach(s, document.createElement('video'));
    await tick();
    await s.setRendition('l0');
    off();
    await expect(s.setRendition('l0')).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('a level the player itself refuses is invalid-argument', async () => {
    const player = new FakeNfxPlayer();
    player.levels = [{ index: 0, width: 1, height: 1, bitrate: 1 }];
    const { s } = session(player);
    attach(s, document.createElement('video'));
    await tick();
    player.last.session.levels = [];
    await expect(s.setRendition('l0')).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('only a <video> element is taken', () => {
    const { s } = session(new FakeNfxPlayer());
    expect(() => attach(s, { currentTime: 0, paused: true })).toThrow(/^invalid-argument: /);
    expect(() => attach(s, document.createElement('audio'))).toThrow(WebAdapterError);
  });

  it('a player whose init fails is tried again on the next attach', async () => {
    const player = new FakeNfxPlayer();
    player.failInit = true;
    const { s } = session(player);
    attach(s, document.createElement('video'));
    await tick();
    expect(s.error).toBe('wasm did not load');
    attach(s, document.createElement('video'));
    await tick();
    expect(player.opens).toHaveLength(1);
  });
});
