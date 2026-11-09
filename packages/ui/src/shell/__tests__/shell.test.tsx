// @vitest-environment jsdom
/**
 * The shell in jsdom with the real `@sovit/ui` screens over `MockNetworkAdapter` (design §4,
 * §6 L6-A): Watch→Watch, Watch→Home, Shorts-over-mini-player (≤ 1 unpaused session, none
 * leaked — counted at the MOCK, where a session lives until closed; the short's element pause
 * when the mini resumes), expand/dismiss, theme at boot and on change, the header chip,
 * back/forward, and the one shell toast stack (a Library toast and its Undo). Media elements
 * behave like a browser's: `play()`/`pause()` queue a `play`/`pause` event on a change.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { mocks } from '@sovit/core';
import type { NostrEventId } from '@sovit/core';
import type { FfmpegStatus, Route } from '../../screens/index.js';
import { Shell } from '../Shell.js';
import { createShellModel, type ShellModel } from '../model.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { MockNetworkAdapter, VIDEOS } = mocks;

function must<T>(x: T | undefined, what: string): T {
  if (x === undefined) throw new Error(`fixture missing: ${what}`);
  return x;
}
const V1 = must(
  VIDEOS.find((v) => v.kind === 21),
  'a kind-21 video',
).id;
const V2 = must(VIDEOS.filter((v) => v.kind === 21)[1], 'a second kind-21 video').id;

interface Mounted extends ShellModel {
  readonly container: HTMLElement;
  readonly root: Root;
  readonly base: InstanceType<typeof MockNetworkAdapter>;
  /** Open sessions at the MOCK (each holds a tick driver until closed). */
  live(): number;
  tick(): void;
  playSpy: ReturnType<typeof vi.fn>;
  /** Every session the MOCK handed out, with its (inner) pause/resume counted. */
  readonly sessions: readonly RecordedSession[];
  probe: ReturnType<typeof vi.fn>;
}

interface RecordedSession {
  readonly videoId: NostrEventId;
  readonly pause: MockInstance;
  readonly resume: MockInstance;
}

let mounted: Mounted[] = [];
/** `<video>.pause()` calls (jsdom has no media playback; both methods are stubbed). */
let mediaPauses = 0;

beforeEach(() => {
  mediaPauses = 0;
  // Browser-like media: `play()` / `pause()` flip the element's paused state and QUEUE a
  // `play` / `pause` event (a media element task) only when it changes, so the screens' and
  // the mini-player's element handlers run as they do in Chromium.
  const paused = new WeakMap<HTMLMediaElement, boolean>();
  const queue = (el: HTMLMediaElement, type: 'play' | 'pause'): void => {
    setTimeout(() => {
      el.dispatchEvent(new Event(type));
    }, 0);
  };
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    if (paused.get(this) ?? true) {
      paused.set(this, false);
      queue(this, 'play');
    }
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    mediaPauses += 1;
    if (!(paused.get(this) ?? true)) {
      paused.set(this, true);
      queue(this, 'pause');
    }
  });
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  for (const m of mounted) {
    act(() => {
      m.root.unmount();
    });
    m.container.remove();
  }
  mounted = [];
  vi.restoreAllMocks();
});

async function flush(rounds = 12): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) {
      await new Promise<void>((r) => {
        setTimeout(r, 0);
      });
    }
  });
}

async function mount(
  initial: Route = { name: 'home' },
  opts: { theme?: 'dark' | 'light' } = {},
): Promise<Mounted> {
  const ticks = new Set<() => void>();
  const base = new MockNetworkAdapter({
    setInterval: (fn) => {
      ticks.add(fn);
      return () => ticks.delete(fn);
    },
  });
  if (opts.theme !== undefined) await base.updateSettings({ theme: opts.theme });
  const playSpy = vi.fn();
  const sessions: RecordedSession[] = [];
  const origPlay = base.play.bind(base);
  base.play = async (id: NostrEventId, r?: string) => {
    playSpy(id, r);
    const session = await origPlay(id, r);
    sessions.push({
      videoId: id,
      pause: vi.spyOn(session, 'pause'),
      resume: vi.spyOn(session, 'resume'),
    });
    return session;
  };
  const model = createShellModel(base, initial);
  const probe = vi.fn((recheck: boolean): Promise<FfmpegStatus> =>
    Promise.resolve({
      found: true,
      path: '/usr/bin/ffmpeg',
      version: recheck ? '8.1.3' : '8.1.2',
      os: 'linux',
    }),
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <Shell
        adapter={model.adapter}
        coordinator={model.coordinator}
        router={model.router}
        probeFfmpeg={probe}
      />,
    );
  });
  const m: Mounted = {
    ...model,
    container,
    root,
    base,
    live: () => ticks.size,
    tick: () => {
      act(() => {
        for (const t of [...ticks]) t();
      });
    },
    playSpy,
    sessions,
    probe,
  };
  mounted.push(m);
  await flush();
  return m;
}

function q(m: Mounted, sel: string): HTMLElement {
  const el = m.container.querySelector<HTMLElement>(sel);
  if (el === null) throw new Error(`no element matches ${sel}`);
  return el;
}

async function click(el: HTMLElement): Promise<void> {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function go(m: Mounted, to: Route): Promise<void> {
  act(() => {
    m.router.navigate(to);
  });
  await flush();
}

async function playWatch(m: Mounted): Promise<void> {
  await click(q(m, 'button[aria-label^="Play — costs"]'));
}

/** The SE-2/SE-3 invariant, checked after every step. */
function invariant(m: Mounted): void {
  const s = m.coordinator.snapshot();
  expect(s.unpaused).toBeLessThanOrEqual(1);
  // Nothing open at the adapter that the coordinator does not know about.
  expect(m.live()).toBe(s.open);
}

describe('Watch → Home (mini-player on navigate)', () => {
  it('hands the paying session to the mini-player; dismiss closes it', async () => {
    const m = await mount({ name: 'watch', videoId: V1 });
    await playWatch(m);
    expect(m.live()).toBe(1);
    expect(m.coordinator.snapshot()).toMatchObject({ open: 1, unpaused: 1 });
    invariant(m);

    await go(m, { name: 'home' });
    const mini = q(m, 'aside[aria-label="Mini-player"]');
    expect(mini.querySelector('video')?.getAttribute('src')).toMatch(/^fixture:\/\/video\//);
    expect(m.coordinator.snapshot().mini?.handoff.videoId).toBe(V1);
    expect(m.live()).toBe(1);
    invariant(m);

    await click(q(m, 'button[aria-label="Close mini-player"]'));
    expect(m.container.querySelector('aside[aria-label="Mini-player"]')).toBeNull();
    expect(m.live()).toBe(0);
    invariant(m);
  });

  it('expand gives the session back to Watch without a new play() or price', async () => {
    const m = await mount({ name: 'watch', videoId: V1 });
    await playWatch(m);
    await go(m, { name: 'library' });
    expect(m.coordinator.snapshot().mini).not.toBeNull();
    await click(q(m, 'button[aria-label="Expand"]'));
    expect(m.router.current.route).toEqual({ name: 'watch', videoId: V1 });
    expect(m.coordinator.snapshot().mini).toBeNull();
    expect(m.playSpy).toHaveBeenCalledTimes(1);
    expect(m.live()).toBe(1);
    expect(m.container.querySelector('button[aria-label^="Play — costs"]')).toBeNull();
    invariant(m);
    // Leaving again hands it off again — still one session.
    await go(m, { name: 'home' });
    expect(m.coordinator.snapshot().mini?.handoff.videoId).toBe(V1);
    expect(m.live()).toBe(1);
    invariant(m);
  });

  it("navigating to the mini-player's own video expands it too", async () => {
    const m = await mount({ name: 'watch', videoId: V1 });
    await playWatch(m);
    await go(m, { name: 'home' });
    await go(m, { name: 'watch', videoId: V1 });
    expect(m.coordinator.snapshot().mini).toBeNull();
    expect(m.playSpy).toHaveBeenCalledTimes(1);
    expect(m.live()).toBe(1);
    invariant(m);
  });

  it('back to an old watch entry never re-adopts a session that was closed', async () => {
    const m = await mount({ name: 'watch', videoId: V1 });
    await playWatch(m);
    await go(m, { name: 'home' });
    await click(q(m, 'button[aria-label="Expand"]'));
    await go(m, { name: 'settings' });
    await click(q(m, 'button[aria-label="Close mini-player"]'));
    expect(m.live()).toBe(0);
    act(() => {
      m.router.back();
    });
    await flush();
    expect(m.router.current.route).toEqual({ name: 'watch', videoId: V1 });
    expect(m.live()).toBe(0);
    expect(m.container.querySelector('button[aria-label^="Play — costs"]')).not.toBeNull();
    invariant(m);
  });
});

describe('Watch → Watch', () => {
  it("closes the old video's session (no remount, no hand-off); exactly one session after playing the next", async () => {
    const m = await mount({ name: 'watch', videoId: V1 });
    await playWatch(m);
    await go(m, { name: 'watch', videoId: V2 });
    expect(m.coordinator.snapshot().mini).toBeNull();
    expect(m.live()).toBe(0);
    await playWatch(m);
    expect(m.live()).toBe(1);
    expect(m.coordinator.snapshot()).toMatchObject({ open: 1, unpaused: 1 });
    invariant(m);
  });

  it('with the mini-player holding V1, playing V2 pauses the mini; leaving V2 replaces the mini', async () => {
    const m = await mount({ name: 'watch', videoId: V1 });
    await playWatch(m);
    await go(m, { name: 'home' });
    await go(m, { name: 'watch', videoId: V2 });
    expect(m.coordinator.snapshot().mini?.handoff.videoId).toBe(V1);
    await playWatch(m);
    expect(m.coordinator.snapshot().mini?.paused).toBe(true);
    expect(m.coordinator.snapshot()).toMatchObject({ open: 2, unpaused: 1 });
    invariant(m);
    await go(m, { name: 'home' });
    expect(m.coordinator.snapshot().mini?.handoff.videoId).toBe(V2);
    expect(m.live()).toBe(1);
    invariant(m);
  });
});

describe('Shorts over the mini-player (SE-3)', () => {
  it('a short starting pauses the mini-player: never two sessions paying', async () => {
    const m = await mount({ name: 'watch', videoId: V1 });
    await playWatch(m);
    await go(m, { name: 'shorts' });
    expect(m.coordinator.snapshot().mini).not.toBeNull();
    const before = mediaPauses;
    await click(q(m, '.nf-shorts button[aria-label^="Play — "]'));
    expect(m.coordinator.snapshot().mini?.paused).toBe(true);
    expect(m.coordinator.snapshot()).toMatchObject({ open: 2, unpaused: 1 });
    // The mini's <video> element followed its (now paused) session.
    expect(mediaPauses).toBeGreaterThan(before);
    invariant(m);
    await click(q(m, 'button[aria-label="Close mini-player"]'));
    expect(m.live()).toBe(1);
    invariant(m);
    // Leaving Shorts closes the short (no hand-off from Shorts).
    await go(m, { name: 'home' });
    expect(m.live()).toBe(0);
    invariant(m);
  });

  it("resuming the mini-player pauses the short's session AND element; the short stays paused and says so", async () => {
    const m = await mount({ name: 'watch', videoId: V1 });
    await playWatch(m);
    await go(m, { name: 'shorts' });
    await click(q(m, '.nf-shorts button[aria-label^="Play — "]'));
    const short = must(
      m.sessions.find((s) => s.videoId !== V1),
      "the short's session",
    );
    const shortUi = (): HTMLElement => q(m, '.nf-shorts article[aria-current="true"]');
    expect(shortUi().textContent).not.toContain('Paused — not paying');
    const before = mediaPauses;
    await click(q(m, 'aside[aria-label="Mini-player"] button[aria-label="Play"]'));
    expect(m.coordinator.snapshot().mini?.paused).toBe(false);
    expect(m.coordinator.snapshot()).toMatchObject({ open: 2, unpaused: 1 });
    // The coordinator paused the short's session and its <video>; the element's `pause`
    // reached Shorts, which shows it paused — its own `session.pause()` was a no-op at the
    // coordinator (the mock saw ONE pause) and nothing resumed it: no pause → resume loop.
    expect(mediaPauses).toBeGreaterThan(before);
    expect(short.pause).toHaveBeenCalledTimes(1);
    expect(short.resume).not.toHaveBeenCalled();
    expect(shortUi().textContent).toContain('Paused — not paying');
    expect(shortUi().querySelector('.nf-shorts__controls button')?.getAttribute('aria-label')).toBe(
      'Play (space)',
    );
    await flush();
    expect(short.pause).toHaveBeenCalledTimes(1);
    expect(short.resume).not.toHaveBeenCalled();
    expect(m.coordinator.snapshot().mini?.paused).toBe(false);
    invariant(m);

    // The short's own Resume takes the payment back: the mini pauses, still one paying.
    await click(q(m, '.nf-shorts article[aria-current="true"] .nf-shorts__play'));
    expect(short.resume).toHaveBeenCalledTimes(1);
    expect(m.coordinator.snapshot().mini?.paused).toBe(true);
    expect(m.coordinator.snapshot()).toMatchObject({ open: 2, unpaused: 1 });
    expect(shortUi().textContent).not.toContain('Paused — not paying');
    expect(q(m, 'aside[aria-label="Mini-player"]').textContent).toContain('Paused — not paying');
    invariant(m);
  });
});

describe('one shell toast stack (Settings and Library hand theirs over)', () => {
  it('a Library toast lands in the shell stack; its Undo works and closes it, even after leaving', async () => {
    const m = await mount({ name: 'library', tab: 'watch-later' });
    const saved = (): Promise<string[]> =>
      m.base.library.watchLater().then((list) => list.map((v) => v.id));
    const [id] = await saved();
    expect(id).toBeDefined();
    expect(m.container.querySelector('.nf-library__toasts')).toBeNull();
    const shellToasts = (): HTMLElement[] => [
      ...m.container.querySelectorAll<HTMLElement>('.nf-shell__toasts .nf-toast'),
    ];

    await click(q(m, '.nf-library__remove'));
    expect(await saved()).toEqual([]);
    expect(shellToasts()).toHaveLength(1);
    expect(shellToasts()[0]?.textContent).toContain('Removed from Watch later');
    await click(q(m, '.nf-shell__toasts .nf-toast__action'));
    expect(shellToasts()).toHaveLength(0);
    expect(await saved()).toEqual([id]);
    expect(m.container.querySelectorAll('.nf-library__item')).toHaveLength(1);

    // The shell's stack outlives the screen: Undo still works from another route.
    await click(q(m, '.nf-library__remove'));
    await go(m, { name: 'home' });
    expect(m.container.querySelector('.nf-library')).toBeNull();
    expect(shellToasts()).toHaveLength(1);
    await click(q(m, '.nf-shell__toasts .nf-toast__action'));
    expect(shellToasts()).toHaveLength(0);
    expect(await saved()).toEqual([id]);
  });
});

describe('theme (ADR 0005; the screens never touch the document)', () => {
  it('applies Settings.theme at boot', async () => {
    await mount({ name: 'home' }, { theme: 'light' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('applies it again on every Settings change (light → device)', async () => {
    const m = await mount({ name: 'settings' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    const radio = (label: string): HTMLInputElement => {
      const l = [...m.container.querySelectorAll('label')].find((x) =>
        x.textContent.includes(label),
      );
      const input = l?.htmlFor ? m.container.ownerDocument.getElementById(l.htmlFor) : null;
      if (!(input instanceof HTMLInputElement)) throw new Error(`no radio "${label}"`);
      return input;
    };
    await click(radio('Light theme'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    await click(radio('Use device theme'));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect((await m.base.settings()).theme).toBe('system');
  });
});

describe('chrome', () => {
  it('the WalletChip shows the total and, while a session pays, its rate', async () => {
    const m = await mount({ name: 'watch', videoId: V1 });
    const chip = (): string => q(m, '.nf-shell__header-end').textContent;
    expect(chip()).toContain('2,100');
    await playWatch(m);
    m.tick();
    await flush();
    expect(chip()).toMatch(/\/min/);
    expect(m.coordinator.snapshot().ratePerMin).toBeGreaterThan(0);
  });

  it('search submits the search route; the sidebar marks the current section', async () => {
    const m = await mount();
    const input = q(m, 'input[aria-label="Search videos"]') as HTMLInputElement;
    act(() => {
      // React tracks `value` on the instance; set it through the prototype like a user would.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'ceramics',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(m.router.current.route).toEqual({ name: 'search', q: 'ceramics' });
    await go(m, { name: 'library' });
    expect(q(m, '.nf-shell__nav-item[aria-current="page"]').textContent).toContain('Library');
  });

  it('Alt+← / Alt+→ and the mouse back/forward buttons move through history', async () => {
    const m = await mount();
    await go(m, { name: 'library' });
    await go(m, { name: 'wallet' });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true }));
    });
    expect(m.router.current.route.name).toBe('library');
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { button: 3 }));
    });
    expect(m.router.current.route.name).toBe('home');
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { button: 4 }));
    });
    expect(m.router.current.route.name).toBe('library');
    await flush();
  });

  it('Studio gets the ffmpeg probe (desktop.ffmpeg) and keeps it across tabs', async () => {
    const m = await mount({ name: 'studio' });
    expect(m.probe).toHaveBeenCalledWith(false);
    expect(m.container.textContent).toContain('Transcoding with ffmpeg 8.1.2');
    await go(m, { name: 'studio', tab: 'videos' });
    await go(m, { name: 'studio', tab: 'upload' });
    expect(m.probe).toHaveBeenCalledTimes(1);
  });
});
