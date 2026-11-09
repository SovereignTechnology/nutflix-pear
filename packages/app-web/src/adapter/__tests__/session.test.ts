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
import { WEB_MAX_PLAY_PROBLEMS, WebNfxSession, levelId, levelOf, problemOf } from '../session.js';

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

  it('pear #97: a pinned start level that is not the expected rendition moves to the one that is', async () => {
    const levels = [
      { index: 0, width: 640, height: 360, bitrate: 950_000 },
      { index: 1, width: 1280, height: 720, bitrate: 2_800_000 },
    ];
    // hls.js dropped a level the start was computed with: index 1 is now 720p, 360p is index 0.
    const moved = new FakeNfxPlayer();
    const a = new WebNfxSession({
      videoId: ADDR,
      manifestJson: '{}',
      origins: ['https://o.example/o'],
      trackers: [],
      iceServers: [],
      level: 1,
      expect: { id: '360p', bandwidth: 950_000, height: 360 },
      player: () => Promise.resolve(moved),
    });
    attach(a, document.createElement('video'));
    await tick();
    expect(moved.last.options.level).toBe(1);
    moved.last.session.parsed(levels);
    expect(moved.last.session.setLevelCalls).toEqual([0]);
    expect(a.rendition).toBe('l0');
    // Told once: a later levels event changes nothing.
    moved.last.session.parsed(levels);
    expect(moved.last.session.setLevelCalls).toEqual([0]);

    // The pinned level is the expected one: nothing moves.
    const kept = new FakeNfxPlayer();
    kept.levels = levels;
    const b = new WebNfxSession({
      videoId: ADDR,
      manifestJson: '{}',
      origins: ['https://o.example/o'],
      trackers: [],
      iceServers: [],
      level: 1,
      expect: { id: '720p', bandwidth: 2_800_000, height: 720 },
      player: () => Promise.resolve(kept),
    });
    attach(b, document.createElement('video'));
    await tick();
    expect(kept.last.session.setLevelCalls).toEqual([]);
    expect(b.rendition).toBe('l1');

    // No level is the expected rendition: back to automatic.
    const none = new FakeNfxPlayer();
    const c = new WebNfxSession({
      videoId: ADDR,
      manifestJson: '{}',
      origins: ['https://o.example/o'],
      trackers: [],
      iceServers: [],
      level: 0,
      expect: { id: '1080p', bandwidth: 5_400_000, height: 1080 },
      player: () => Promise.resolve(none),
    });
    attach(c, document.createElement('video'));
    await tick();
    none.last.session.parsed(levels);
    expect(none.last.session.setLevelCalls).toEqual([-1]);
    expect(c.rendition).toBe('auto');
    await Promise.all([a.close(), b.close(), c.close()]);
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

  it('v15: renditions that arrive after attach, and every problem, are told to onChange', async () => {
    const player = new FakeNfxPlayer();
    const { s } = session(player);
    let told = 0;
    const off = s.onChange(() => {
      told += 1;
    });
    attach(s, document.createElement('video'));
    await tick();
    expect(s.renditions).toEqual([]);
    expect(told).toBe(0);
    const lib = player.last.session;
    lib.parsed([
      { index: 0, width: 640, height: 360, bitrate: 800_000 },
      { index: 1, width: 1280, height: 720, bitrate: 2_500_000 },
    ]);
    expect(told).toBe(1);
    expect(s.renditions.map((r) => r.id)).toEqual(['l0', 'l1']);
    await s.setRendition('l1');
    expect(told).toBe(2);
    expect(s.rendition).toBe('l1');
    lib.emit({
      type: 'origin',
      origin: 'https://a.example/o',
      ok: false,
      why: 'hash list: HTTP 503',
    });
    lib.emit({ type: 'origin', origin: 'https://b.example/o', ok: true });
    lib.emit({
      type: 'rejected',
      sha256: 'f'.repeat(64),
      url: 'https://b.example/o/' + 'e'.repeat(64) + '.m4s',
      why: 'sha256 mismatch',
    });
    lib.emit({ type: 'verified', sha256: 'f'.repeat(64), url: 'https://b.example/o/x.m4s' });
    lib.emit({ type: 'playing' });
    lib.emit({ type: 'error', message: 'play: NotAllowedError' });
    lib.emit({ type: 'error', message: 'networkError:fragLoadError' });
    expect(s.problems).toEqual([
      { kind: 'origin', message: 'https://a.example/o: hash list: HTTP 503' },
      { kind: 'refused', message: `Refused b.example/…/${'e'.repeat(64)}.m4s: sha256 mismatch` },
      { kind: 'stopped', message: 'networkError:fragLoadError' },
    ]);
    expect(told).toBe(5);
    expect(s.error).toBe('networkError:fragLoadError');
    off();
    lib.emit({ type: 'error', message: 'again' });
    expect(told).toBe(5);
    expect(s.problems).toHaveLength(4);
  });

  it('v15: a refusal at open is a stopped problem; nothing is told after close', async () => {
    const player = new FakeNfxPlayer();
    player.refuse =
      'no origin served a hash list that verifies (https://a.example/o: hash list: HTTP 503)';
    const { s } = session(player);
    const seen: string[] = [];
    s.onChange(() => {
      seen.push(s.problems.at(-1)?.kind ?? 'none');
    });
    attach(s, document.createElement('video'));
    await tick();
    expect(seen).toEqual(['stopped']);
    expect(s.problems[0]?.message).toMatch(/^no origin served a hash list that verifies/);
    await s.close();
    let late = 0;
    s.onChange(() => {
      late += 1;
    })();
    expect(late).toBe(0);
  });

  it('v15: problems are capped at the newest WEB_MAX_PLAY_PROBLEMS', async () => {
    const player = new FakeNfxPlayer();
    const { s } = session(player);
    attach(s, document.createElement('video'));
    await tick();
    for (let i = 0; i < WEB_MAX_PLAY_PROBLEMS + 5; i++) {
      player.last.session.emit({ type: 'error', message: `e${String(i)}` });
    }
    expect(s.problems).toHaveLength(WEB_MAX_PLAY_PROBLEMS);
    expect(s.problems[0]?.message).toBe('e5');
  });

  it('v15: the mesh’s refused segments, which nfx’s player only logs, are refusals too', () => {
    expect(
      problemOf({
        type: 'log',
        message: 'mesh: rejected p2p bytes for https://o.example/o/abc.m4s: sha256 mismatch',
      }),
    ).toEqual({
      kind: 'refused',
      message: 'Refused o.example/…/abc.m4s from a peer: sha256 mismatch',
    });
    expect(
      problemOf({
        type: 'log',
        message: 'mesh: rejected http bytes for https://o.example/o/abc.m4s: not on the hash list',
      }),
    ).toEqual({
      kind: 'refused',
      message: 'Refused o.example/…/abc.m4s from an origin: not on the hash list',
    });
    expect(problemOf({ type: 'log', message: 'levels: 360p 720p' })).toBeNull();
  });
});
