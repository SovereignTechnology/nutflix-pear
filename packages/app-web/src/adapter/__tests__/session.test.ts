/**
 * The `element` source of a web play (contracts v14): one element at a time, everything the
 * player started stopped on detach and close, the player's refusal kept, renditions from its
 * levels by their rendition ids, and what the play allows handed to the player (pear #97).
 */
import { describe, expect, it } from 'vitest';

import type { MediaElementLike, NfxAddress } from '@sovit/core';

import { FakeNfxPlayer } from '../../__tests__/support/fake-nfx-lib.js';
import { tick } from '../../__tests__/support/nfx.js';
import { WebAdapterError } from '../../errors.js';
import { WEB_MAX_PLAY_PROBLEMS, WebNfxSession, originSource, problemOf } from '../session.js';

const ADDR = `38504:${'a'.repeat(64)}:nfx:testnet:1:v` as NfxAddress;

const L360 = { index: 0, id: '360p', width: 640, height: 360, bitrate: 950_000 };
const L720 = { index: 1, id: '720p', width: 1280, height: 720, bitrate: 2_800_000 };

function session(player: FakeNfxPlayer, o: { pin?: string; renditions?: string[] } = {}) {
  const closed: WebNfxSession[] = [];
  const s = new WebNfxSession({
    videoId: ADDR,
    manifestJson: '{"kind":38504}',
    origins: [{ url: 'https://o.example/o' }],
    renditions: o.renditions,
    trackers: [],
    iceServers: [],
    pin: o.pin,
    player: () => player.init().then(() => player),
    onClose: (x) => closed.push(x),
  });
  return { s, closed };
}

function attach(s: WebNfxSession, el: MediaElementLike): () => void {
  return s.source.attach(el);
}

describe('WebNfxSession', () => {
  it('origins reach the player bare when they serve every rendition, else with their list', () => {
    expect(originSource({ url: 'https://a.example/o' })).toBe('https://a.example/o');
    expect(originSource({ url: 'https://a.example/o', renditions: ['360p'] })).toEqual({
      url: 'https://a.example/o',
      renditions: ['360p'],
    });
    expect(originSource({ url: 'https://a.example/o', renditions: [] })).toEqual({
      url: 'https://a.example/o',
      renditions: [],
    });
  });

  it('pear #97: the player gets the allowed renditions and each origin’s list, as given', async () => {
    const player = new FakeNfxPlayer();
    const s = new WebNfxSession({
      videoId: ADDR,
      manifestJson: '{}',
      origins: [
        { url: 'https://a.example/o', renditions: ['360p'] },
        { url: 'https://b.example/o' },
      ],
      renditions: ['360p', '720p'],
      trackers: [],
      iceServers: [],
      player: () => Promise.resolve(player),
    });
    attach(s, document.createElement('video'));
    await tick();
    expect(player.last.options.origins).toEqual([
      { url: 'https://a.example/o', renditions: ['360p'] },
      'https://b.example/o',
    ]);
    expect(player.last.options.renditions).toEqual(['360p', '720p']);
    // Nothing to restrict: no list at all (the library allows every rendition).
    const plain = new FakeNfxPlayer();
    attach(session(plain).s, document.createElement('video'));
    await tick();
    expect('renditions' in plain.last.options).toBe(false);
    expect(plain.last.options.origins).toEqual(['https://o.example/o']);
    await s.close();
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
      origins: [{ url: 'https://o.example/o' }],
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
    lib.parsed([{ index: 0, id: '360p', width: 1, height: 1, bitrate: 1 }]);
    expect(s.error).toBe('networkError:fragLoadError');
    expect(s.renditions).toEqual([]);
  });

  it('levels the player already has at open are the renditions, by id; one without a size has no resolution', async () => {
    const player = new FakeNfxPlayer();
    player.levels = [
      { index: 0, id: 'audio', width: 0, height: 0, bitrate: 96_000 },
      { index: 1, id: '1080p', width: 1920, height: 1080, bitrate: 5_000_000 },
      // The same rendition twice (a master playlist may list a variant twice): listed once.
      { index: 2, id: '1080p', width: 1920, height: 1080, bitrate: 5_000_000 },
    ];
    const { s } = session(player, { pin: '1080p' });
    expect(s.rendition).toBe('1080p');
    attach(s, document.createElement('video'));
    await tick();
    expect('level' in player.last.options).toBe(false);
    expect(player.last.session.setLevelCalls).toEqual([1]);
    expect(s.rendition).toBe('1080p');
    expect(s.renditions).toEqual([
      { id: 'audio', bandwidth: 96_000 },
      { id: '1080p', bandwidth: 5_000_000, resolution: '1920x1080' },
    ]);
  });

  it('setRendition before the player opened, or after a detach, is invalid-argument', async () => {
    const player = new FakeNfxPlayer();
    const { s } = session(player);
    await expect(s.setRendition('360p')).rejects.toBeInstanceOf(WebAdapterError);
    player.levels = [L360];
    const off = attach(s, document.createElement('video'));
    await tick();
    await s.setRendition('360p');
    off();
    await expect(s.setRendition('360p')).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('a level the player itself refuses is invalid-argument', async () => {
    const player = new FakeNfxPlayer();
    player.levels = [L360];
    const { s } = session(player);
    attach(s, document.createElement('video'));
    await tick();
    player.last.session.levels = [];
    await expect(s.setRendition('360p')).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('a viewer’s pick is played once the levels list it, by id, whatever its index; else hls.js picks', async () => {
    // The levels arrive after open, the pick at index 1.
    const later = new FakeNfxPlayer();
    const { s: a } = session(later, { pin: '720p' });
    attach(a, document.createElement('video'));
    await tick();
    expect(later.last.session.setLevelCalls).toEqual([]);
    later.last.session.parsed([L360, L720]);
    expect(later.last.session.setLevelCalls).toEqual([1]);
    expect(a.rendition).toBe('720p');
    // Once: a later levels event changes nothing.
    later.last.session.parsed([L360, L720]);
    expect(later.last.session.setLevelCalls).toEqual([1]);

    // The play does not offer it (not allowed, or its origin does not serve it): automatic.
    const cut = new FakeNfxPlayer();
    const { s: b } = session(cut, { pin: '720p', renditions: ['360p'] });
    expect(b.rendition).toBe('720p');
    attach(b, document.createElement('video'));
    await tick();
    cut.last.session.parsed([L360]);
    expect(cut.last.session.setLevelCalls).toEqual([]);
    expect(b.rendition).toBe('auto');
    expect(b.renditions.map((r) => r.id)).toEqual(['360p']);

    // No pick: nothing is set.
    const free = new FakeNfxPlayer();
    free.levels = [L360, L720];
    const { s: c } = session(free);
    attach(c, document.createElement('video'));
    await tick();
    expect(free.last.session.setLevelCalls).toEqual([]);
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
    lib.parsed([L360, L720]);
    expect(told).toBe(1);
    expect(s.renditions.map((r) => r.id)).toEqual(['360p', '720p']);
    await s.setRendition('720p');
    expect(lib.setLevelCalls).toEqual([1]);
    expect(told).toBe(2);
    expect(s.rendition).toBe('720p');
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
