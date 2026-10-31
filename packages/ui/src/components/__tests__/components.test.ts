/**
 * Every component renders under jsdom (no browser) and its props-in/callbacks-out contract
 * holds. Data comes from `@sovit/core` mocks — allowed in tests, never in component source.
 */
import { createElement, createRef, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_TOP_UP_MAX_SATS,
  AUTO_TOP_UP_MAX_SATS_PER_DAY,
  DEFAULT_MIN_PAY_SATS,
  mocks,
} from '@sovit/core';
import type { NostrPubkey, Profile, Sats, UnixSeconds } from '@sovit/core';
import { Avatar, ProfileAvatar } from '../Avatar/Avatar.js';
import { Button, IconButton } from '../Button/Button.js';
import { ChannelRow, ChannelRowSkeleton } from '../ChannelRow/ChannelRow.js';
import { EMPTY_STATE_PRESETS, EmptyState, ErrorState } from '../EmptyState/EmptyState.js';
import { MintChip } from '../MintChip/MintChip.js';
import { PeerMeter } from '../PeerMeter/PeerMeter.js';
import { ReactionButtons } from '../ReactionButtons/ReactionButtons.js';
import { reactionStateOf, reactionStep } from '../ReactionButtons/reaction.js';
import { SatsBadge } from '../SatsBadge/SatsBadge.js';
import { Sheet } from '../Sheet/Sheet.js';
import { Skeleton, SkeletonLines } from '../Skeleton/Skeleton.js';
import { Toast, ToastStack } from '../Toast/Toast.js';
import { VideoCard, VideoCardSkeleton } from '../VideoCard/VideoCard.js';
import * as components from '../index.js';
import { ICON_NAMES, Icon } from '../shared/Icon.js';
import {
  cheapestRenditionSats,
  defaultRenditionSats,
  formatDuration,
  formatRelativeTime,
  formatSats,
  formatSatsCompact,
  initials,
  mintHost,
  renditionPriceSats,
  shortPubkey,
} from '../shared/format.js';
import { click, fire, keydown, render } from '../testing/render.js';
import {
  PAY_INPUTS_ESTIMATE,
  UI_AUTO_TOP_UP_MAX_SATS,
  UI_AUTO_TOP_UP_PER_DAY_SATS,
  UI_DEFAULT_MIN_PAY_SATS,
  estimateMintFeeSats,
} from '../shared/format.js';

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('fixture missing');
  return v;
}
const video = must(mocks.VIDEOS[1]);
const channel = must(mocks.CHANNELS[0]);
const sats = (n: number): Sats => n as Sats;

describe('issue #2: the auto top-up caps the screens state', () => {
  it('equal core’s (the UI imports no core runtime code)', () => {
    expect(UI_AUTO_TOP_UP_MAX_SATS).toBe(AUTO_TOP_UP_MAX_SATS);
    expect(UI_AUTO_TOP_UP_PER_DAY_SATS).toBe(AUTO_TOP_UP_MAX_SATS_PER_DAY);
  });
});

describe('estimateMintFeeSats (Cameron 2026-09-24: fees shown in the price)', () => {
  it('PAYs × the swap fee of one PAY; 0 for a free mint; the UI default matches core', () => {
    expect(UI_DEFAULT_MIN_PAY_SATS).toBe(DEFAULT_MIN_PAY_SATS);
    // 1,000 sats at the default 10-sat minimum = 100 PAYs; 2 inputs × 100 ppk = 0.2 → 1 sat each.
    expect(estimateMintFeeSats(1000, {}, 100)).toBe(100);
    expect(estimateMintFeeSats(1000, { minPaySats: 50 as never }, 100)).toBe(20);
    // 2 inputs × 1000 ppk = 2 sats a PAY.
    expect(estimateMintFeeSats(95, {}, 1000)).toBe(20);
    expect(estimateMintFeeSats(1000, {}, 0)).toBe(0);
    expect(estimateMintFeeSats(0, {}, 100)).toBe(0);
    expect(PAY_INPUTS_ESTIMATE).toBe(2);
  });
});

describe('formatting helpers', () => {
  it('formats sats, durations, relative time and pubkeys deterministically', () => {
    expect(formatSats(1)).toBe('1 sat');
    expect(formatSats(1240)).toBe('1,240 sats');
    expect(formatSatsCompact(999)).toBe('999');
    expect(formatSatsCompact(1240)).toBe('1.2k');
    expect(formatSatsCompact(12400)).toBe('12k');
    expect(formatSatsCompact(1_240_000)).toBe('1.2M');
    expect(formatDuration(754)).toBe('12:34');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(-3)).toBe('0:00');
    const now = 1_000_000 as UnixSeconds;
    expect(formatRelativeTime((now - 3 * 3600) as UnixSeconds, now)).toBe('3 hours ago');
    expect(formatRelativeTime((now - 86400) as UnixSeconds, now)).toBe('1 day ago');
    expect(formatRelativeTime(now, now)).toBe('just now');
    expect(shortPubkey(channel.pubkey)).toMatch(/^[0-9a-f]{8}…[0-9a-f]{4}$/);
    expect(mintHost(mocks.MINTS.a)).toBe('mint.fixture-a.example');
    expect(initials('Orbital Mechanics')).toBe('OM');
    expect(initials('matrixops')).toBe('M');
    expect(initials(undefined)).toBe('?');
  });

  it('prices a rendition as ceil(size / blockSize) × satsPerBlock', () => {
    const r = video.renditions[0];
    if (!r) throw new Error('rendition missing');
    const blocks = Math.ceil(r.size / video.price.blockSize);
    expect(renditionPriceSats(r, video.price)).toBe(blocks * video.price.satsPerBlock);
    const cheapest = cheapestRenditionSats(video.renditions, video.price);
    expect(cheapest?.from).toBe(true);
    expect(cheapest?.sats).toBe(
      Math.min(...video.renditions.map((x) => renditionPriceSats(x, video.price))),
    );
    expect(cheapestRenditionSats([], video.price)).toBeUndefined();
  });

  it('defaultRenditionSats is the FIRST rendition — what play(id) streams (ADR 0007 c)', () => {
    const first = video.renditions[0];
    if (!first) throw new Error('rendition missing');
    const expected = renditionPriceSats(first, video.price);
    expect(defaultRenditionSats(video.renditions, video.price)).toBe(expected);
    // the fixture's first rendition is not its cheapest: the card must not show the cheapest
    expect(cheapestRenditionSats(video.renditions, video.price)?.sats).not.toBe(expected);
    expect(defaultRenditionSats([], video.price)).toBeUndefined();
  });
});

describe('component exports', () => {
  it('exports every component the brief names', () => {
    for (const name of [
      'VideoCard',
      'Player',
      'ChannelRow',
      'SatsBadge',
      'MintChip',
      'PeerMeter',
      'Skeleton',
      'Sheet',
      'Toast',
      'ToastStack',
      'Markdown',
      'EmptyState',
      'ErrorState',
      'Button',
      'Avatar',
    ]) {
      expect(typeof (components as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});

describe('VideoCard', () => {
  const now = mocks.FIXTURE_NOW;
  const el = (extra: Record<string, unknown> = {}): ReactElement =>
    createElement(VideoCard, {
      video,
      channel: channel.profile,
      thumbnailSrc: 'https://img.example/t.jpg',
      stats: { paidViews: 96 },
      now,
      ...extra,
    });

  it('shows title, duration, the default rendition price, channel with NIP-05 check, and meta', () => {
    const r = render(el());
    expect(r.get('.nf-card__title').textContent).toBe(video.title);
    expect(r.get('.nf-card__duration').textContent).toBe(formatDuration(video.durationSec ?? 0));
    const price = r.get('.nf-card__price');
    const sats = defaultRenditionSats(video.renditions, video.price) ?? -1;
    // exactly what Watch/Shorts charge, compact on the chip, and never "from"
    expect(price.getAttribute('aria-label')).toBe(`${formatSatsCompact(sats)} sats`);
    expect(price.textContent).not.toContain('from');
    expect(r.get('.nf-card__channel-name').textContent).toBe('Orbital Mechanics');
    expect(r.container.querySelector('.nf-card__verified')).toBeTruthy();
    expect(r.get('.nf-card__meta').textContent).toContain('96 paid views');
    expect(r.get('.nf-card__meta').textContent).toContain('9 hours ago');
    expect(r.get('.nf-card__img').getAttribute('src')).toBe('https://img.example/t.jpg');
    expect(r.get('.nf-card__placeholder').getAttribute('src')).toBe(
      video.renditions[0]?.placeholder,
    );
    r.unmount();
  });

  it('names the thumbnail button with the title AND the price (the badge inside is hidden by it)', () => {
    const r = render(el());
    const sats = defaultRenditionSats(video.renditions, video.price) ?? -1;
    expect(r.get('.nf-card__thumb').getAttribute('aria-label')).toBe(
      `${video.title}, ${formatSats(sats)}`,
    );
    r.rerender(el({ video: { ...video, renditions: [] } }));
    expect(r.get('.nf-card__thumb').getAttribute('aria-label')).toBe(video.title);
    expect(r.container.querySelector('.nf-card__price')).toBeNull();
    r.unmount();
  });

  it('calls onOpen / onOpenChannel, never fetches', () => {
    const onOpen = vi.fn();
    const onOpenChannel = vi.fn();
    const r = render(el({ onOpen, onOpenChannel }));
    click(r.get('.nf-card__thumb'));
    click(r.get('.nf-card__title-button'));
    click(r.get('.nf-card__channel'));
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledWith(video);
    expect(onOpenChannel).toHaveBeenCalledWith(video.author);
    r.unmount();
  });

  it('contracts v9: an NFX video is free, has no price, no thumbnail fetch and no play affordance', () => {
    const nfx = mocks.NFX_VIDEOS[0]!;
    const onOpen = vi.fn();
    const r = render(el({ video: nfx, thumbnailSrc: undefined, stats: undefined, onOpen }));
    expect(r.get('.nf-card__title').textContent).toBe(nfx.title);
    expect(r.get('.nf-card__free').textContent).toBe('Free');
    expect(r.get('.nf-card__thumb').getAttribute('aria-label')).toBe(`${nfx.title}, free`);
    expect(r.container.querySelector('.nf-card__price')).toBeNull();
    expect(r.container.querySelector('.nf-card__placeholder')).toBeNull();
    expect(r.container.querySelector('.nf-card__img')).toBeNull();
    expect(r.container.querySelector('.nf-card__hover')).toBeNull();
    expect(r.get('.nf-card__duration').textContent).toBe(formatDuration(nfx.durationSec ?? 0));
    click(r.get('.nf-card__thumb'));
    expect(onOpen).toHaveBeenCalledWith(nfx);
    r.unmount();
  });

  it('progress bar, list layout, hidden channel row, and the skeleton', () => {
    const r = render(el({ progress: 0.5, layout: 'list', hideChannel: true }));
    expect(Number.parseFloat(r.get('.nf-card__progress-bar').style.width)).toBeCloseTo(50);
    expect(r.get('.nf-card').classList.contains('nf-card--list')).toBe(true);
    expect(r.container.querySelector('.nf-card__channel')).toBeNull();
    r.unmount();
    const s = render(createElement(VideoCardSkeleton));
    expect(s.get('.nf-card--skeleton').getAttribute('aria-busy')).toBe('true');
    expect(s.all('.nf-skeleton').length).toBeGreaterThan(2);
    expect(s.container.querySelector('.nf-card__avatar')).toBeTruthy();
    // hideChannel matches a channel-page card: no avatar circle, same text lines
    s.rerender(createElement(VideoCardSkeleton, { hideChannel: true }));
    expect(s.container.querySelector('.nf-card__avatar')).toBeNull();
    expect(s.all('.nf-card__text .nf-skeleton')).toHaveLength(3);
    s.rerender(createElement(VideoCardSkeleton, { layout: 'list' }));
    expect(s.get('.nf-card--skeleton').classList.contains('nf-card--list')).toBe(true);
    expect(s.container.querySelector('.nf-card__avatar')).toBeNull();
    s.unmount();
  });
});

describe('ReactionButtons + reactionStep (ADR 0007 b)', () => {
  const at = (
    likes: number | undefined,
    dislikes: number | undefined,
    mine?: 'like' | 'dislike',
  ): { likes: number | undefined; dislikes: number | undefined; mine: typeof mine } => ({
    likes,
    dislikes,
    mine,
  });

  it('maps every transition to exactly one adapter call and the optimistic counts', () => {
    // neutral → like / dislike
    expect(reactionStep(at(10, 2), 'like')).toEqual({
      call: { method: 'react', content: '+' },
      next: at(11, 2, 'like'),
    });
    expect(reactionStep(at(10, 2), 'dislike')).toEqual({
      call: { method: 'react', content: '-' },
      next: at(10, 3, 'dislike'),
    });
    // switching is ONE react with the new content
    expect(reactionStep(at(11, 2, 'like'), 'dislike')).toEqual({
      call: { method: 'react', content: '-' },
      next: at(10, 3, 'dislike'),
    });
    expect(reactionStep(at(10, 3, 'dislike'), 'like')).toEqual({
      call: { method: 'react', content: '+' },
      next: at(11, 2, 'like'),
    });
    // pressing the active one withdraws it: unreact, never a '-'
    expect(reactionStep(at(11, 2, 'like'), 'like')).toEqual({
      call: { method: 'unreact' },
      next: at(10, 2),
    });
    expect(reactionStep(at(10, 3, 'dislike'), 'dislike')).toEqual({
      call: { method: 'unreact' },
      next: at(10, 2),
    });
    // unknown counts stay unknown; counts never go negative
    expect(reactionStep(at(undefined, undefined), 'like').next).toEqual(
      at(undefined, undefined, 'like'),
    );
    expect(reactionStep(at(0, 0, 'like'), 'like').next).toEqual(at(0, 0));
  });

  it('reactionStateOf reads VideoStats v4 and drops myReaction when signed out', () => {
    const stats = { likes: 5, dislikes: 1, myReaction: 'like' as const };
    expect(reactionStateOf(stats, true)).toEqual(at(5, 1, 'like'));
    expect(reactionStateOf(stats, false)).toEqual(at(5, 1));
    expect(reactionStateOf(undefined, true)).toEqual(at(undefined, undefined));
  });

  it('renders both counts, pressed state, accessible names; presses call onReact unless busy', () => {
    const onReact = vi.fn();
    const r = render(createElement(ReactionButtons, { likes: 1284, dislikes: 1, onReact }));
    const like = r.get('.nf-reactions__like');
    const dislike = r.get('.nf-reactions__dislike');
    expect(r.get('[role="group"]').getAttribute('aria-label')).toBe('Like or dislike');
    expect(like.getAttribute('aria-label')).toBe('Like, 1,284 likes');
    expect(dislike.getAttribute('aria-label')).toBe('Dislike, 1 dislike');
    expect(like.textContent).toBe('1,284');
    expect(dislike.textContent).toBe('1');
    expect(like.getAttribute('aria-pressed')).toBe('false');
    expect(like.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    click(like);
    click(dislike);
    expect(onReact.mock.calls).toEqual([['like'], ['dislike']]);
    r.rerender(
      createElement(ReactionButtons, {
        likes: 0,
        dislikes: 0,
        mine: 'dislike',
        onReact,
        busy: true,
      }),
    );
    expect(r.get('.nf-reactions__dislike').getAttribute('aria-pressed')).toBe('true');
    expect(r.get('.nf-reactions__dislike').getAttribute('title')).toBe('Remove your dislike');
    expect(r.get('.nf-reactions__like').textContent).toBe('0'); // zero is still shown
    expect(r.get('[role="group"]').getAttribute('aria-busy')).toBe('true');
    click(r.get('.nf-reactions__like'));
    expect(onReact).toHaveBeenCalledTimes(2); // ignored while busy, but still focusable
    expect(r.get('.nf-reactions__like').hasAttribute('disabled')).toBe(false);
    r.rerender(createElement(ReactionButtons, { likes: undefined, dislikes: undefined, onReact }));
    expect(r.get('.nf-reactions__like').getAttribute('aria-label')).toBe('Like');
    expect(r.get('.nf-reactions__like').textContent).toBe('');
    r.unmount();
  });
});

describe('Icon', () => {
  it('has the v4 icons, decorative and currentColor', () => {
    for (const name of [
      'thumbUp',
      'thumbDown',
      'comment',
      'share',
      'clock',
      'lock',
      'playlist',
    ] as const) {
      expect(ICON_NAMES).toContain(name);
      const r = render(createElement(Icon, { name }));
      const svg = r.get('svg');
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('fill')).toBe('currentColor');
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(r.get('path').getAttribute('d')?.length).toBeGreaterThan(10);
      r.unmount();
    }
  });
});

describe('ChannelRow', () => {
  it('renders name, NIP-05, subscriber line, sats to creator, seeding and toggles subscribe', () => {
    const onSubscribe = vi.fn();
    const r = render(
      createElement(ChannelRow, {
        profile: channel.profile,
        subscribed: false,
        subscribers: 12800,
        satsToCreator: sats(48210),
        seedingVideos: 3,
        onSubscribe,
      }),
    );
    expect(r.get('.nf-channel__name').textContent).toContain('Orbital Mechanics');
    expect(r.container.querySelector('[aria-label="NIP-05 verified"]')).toBeTruthy();
    expect(r.get('.nf-channel__sub').textContent).toBe(
      'orbital@fixture.example · 12,800 subscribers',
    );
    expect(r.get('.nf-sats--earned').getAttribute('aria-label')).toBe('48,210 sats to creator');
    expect(r.get('.nf-channel__seeding').textContent).toContain('Seeding 3 videos');
    const btn = r.get('button[aria-label="Subscribe to Orbital Mechanics"]');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    click(btn);
    expect(onSubscribe).toHaveBeenCalledWith(channel.pubkey, true);
    r.rerender(
      createElement(ChannelRow, { profile: channel.profile, subscribed: true, onSubscribe }),
    );
    const un = r.get('button[aria-label="Unsubscribe from Orbital Mechanics"]');
    expect(un.getAttribute('aria-pressed')).toBe('true');
    click(un);
    expect(onSubscribe).toHaveBeenLastCalledWith(channel.pubkey, false);
    r.unmount();
    const s = render(createElement(ChannelRowSkeleton));
    expect(s.get('[aria-busy="true"]')).toBeTruthy();
    s.unmount();
  });

  it('omits the check for unverified profiles', () => {
    const plain = mocks.CHANNELS[2]?.profile;
    if (!plain) throw new Error('fixture');
    const r = render(createElement(ChannelRow, { profile: plain, subscribed: false }));
    expect(r.container.querySelector('[aria-label="NIP-05 verified"]')).toBeNull();
    r.unmount();
  });
});

describe('SatsBadge / MintChip / Avatar / Skeleton / Button', () => {
  it('SatsBadge variants produce the documented text', () => {
    const r = render(createElement(SatsBadge, { sats: sats(12), variant: 'rate' }));
    expect(r.get('.nf-sats').getAttribute('aria-label')).toBe('12 sats/min');
    r.rerender(createElement(SatsBadge, { sats: sats(1240), prefix: 'from', compact: true }));
    expect(r.get('.nf-sats').getAttribute('aria-label')).toBe('from 1.2k sats');
    r.rerender(createElement(SatsBadge, { sats: sats(1) }));
    expect(r.get('.nf-sats').getAttribute('aria-label')).toBe('1 sat');
    r.unmount();
  });

  it('MintChip is static without onSelect and a pressed button with it', () => {
    const r = render(
      createElement(MintChip, { mint: mocks.MINTS.a, balance: sats(500), status: 'ok' }),
    );
    expect(r.get('.nf-mint').tagName).toBe('SPAN');
    expect(r.get('.nf-mint__host').textContent).toBe('mint.fixture-a.example');
    expect(r.get('.nf-mint__balance').textContent).toBe('500 sats');
    expect(r.get('.nf-mint__status').getAttribute('aria-label')).toBe('reachable');
    const onSelect = vi.fn();
    r.rerender(createElement(MintChip, { mint: mocks.MINTS.b, selected: true, onSelect }));
    const b = r.get('.nf-mint');
    expect(b.tagName).toBe('BUTTON');
    expect(b.getAttribute('aria-pressed')).toBe('true');
    click(b);
    expect(onSelect).toHaveBeenCalledWith(mocks.MINTS.b);
    r.unmount();
  });

  it('Avatar falls back to initials with a stable hue, and uses the image when given', () => {
    const r = render(createElement(ProfileAvatar, { profile: channel.profile }));
    expect(r.get('.nf-avatar__initials').textContent).toBe('OM');
    expect(r.get('.nf-avatar').getAttribute('aria-label')).toBe('Orbital Mechanics');
    const hue = r.get('.nf-avatar').style.getPropertyValue('--nf-avatar-hue');
    r.rerender(createElement(ProfileAvatar, { profile: channel.profile }));
    expect(r.get('.nf-avatar').style.getPropertyValue('--nf-avatar-hue')).toBe(hue);
    r.rerender(createElement(Avatar, { seed: 'x', name: 'X', src: 'https://a.example/p.png' }));
    expect(r.get('img').getAttribute('src')).toBe('https://a.example/p.png');
    expect(r.container.querySelector('.nf-avatar__initials')).toBeNull();
    r.unmount();
  });

  it('Skeletons are aria-hidden; SkeletonLines renders n lines', () => {
    const r = render(createElement(SkeletonLines, { lines: 4 }));
    expect(r.all('.nf-skeleton')).toHaveLength(4);
    for (const s of r.all('.nf-skeleton')) expect(s.getAttribute('aria-hidden')).toBe('true');
    r.rerender(createElement(Skeleton, { variant: 'block', aspectRatio: '16 / 9' }));
    expect(r.get('.nf-skeleton--block').style.aspectRatio).toBe('16 / 9');
    r.unmount();
  });

  it('Button/IconButton: pressed, loading, accessible names', () => {
    const onClick = vi.fn();
    const r = render(createElement(Button, { pressed: true, onClick }, 'Subscribed'));
    expect(r.get('button').getAttribute('aria-pressed')).toBe('true');
    click(r.get('button'));
    expect(onClick).toHaveBeenCalled();
    r.rerender(createElement(Button, { loading: true }, 'Working'));
    expect(r.get('button').hasAttribute('disabled')).toBe(true);
    expect(r.get('button').getAttribute('aria-busy')).toBe('true');
    r.rerender(createElement(IconButton, { icon: 'close', label: 'Close' }));
    expect(r.get('button').getAttribute('aria-label')).toBe('Close');
    expect(r.get('svg').getAttribute('aria-hidden')).toBe('true');
    r.unmount();
  });
});

describe('PeerMeter', () => {
  const peers = [
    { pubkey: channel.pubkey, sats: sats(400), ratePerMin: sats(10), blocks: 200, latencyMs: 50 },
    { pubkey: mocks.ME, sats: sats(100), ratePerMin: sats(20), blocks: 50, latencyMs: 500 },
  ];
  const profiles: ReadonlyMap<NostrPubkey, Profile> = new Map([[channel.pubkey, channel.profile]]);

  it('ranks peers by rate, sizes bars relative to the fastest, shows totals', () => {
    const r = render(
      createElement(PeerMeter, { peers, total: sats(500), ratePerMin: sats(30), profiles }),
    );
    const rows = r.all('.nf-peers__row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('.nf-peers__name')?.textContent).toBe(shortPubkey(mocks.ME));
    expect(rows[1]?.querySelector('.nf-peers__name')?.textContent).toBe('Orbital Mechanics');
    const fill = (i: number): number =>
      Number.parseFloat(rows[i]?.querySelector<HTMLElement>('.nf-peers__fill')?.style.width ?? '');
    expect(fill(0)).toBeCloseTo(100);
    expect(fill(1)).toBeCloseTo(50);
    expect(r.get('.nf-peers__title').textContent).toBe('2 seeders');
    expect(r.get('.nf-peers__total').textContent).toBe('500 sats so far');
    expect(r.get('.nf-sats--rate').getAttribute('aria-label')).toBe('30 sats/min');
    expect(r.all('[role="meter"]')).toHaveLength(2);
    r.unmount();
  });

  it('shows the "no seeders online" empty state, a loading skeleton, and paused copy', () => {
    const r = render(createElement(PeerMeter, { peers: [], total: sats(0), ratePerMin: sats(0) }));
    expect(r.get('[data-preset="no-seeders-online"] .nf-state__title').textContent).toBe(
      'No seeders online',
    );
    r.rerender(
      createElement(PeerMeter, { peers: [], total: sats(0), ratePerMin: sats(0), loading: true }),
    );
    expect(r.get('.nf-peers').getAttribute('aria-busy')).toBe('true');
    expect(r.all('.nf-skeleton').length).toBeGreaterThan(0);
    r.rerender(
      createElement(PeerMeter, { peers, total: sats(0), ratePerMin: sats(0), paused: true }),
    );
    expect(r.get('.nf-peers__paused-label').textContent).toContain('not paying');
    r.unmount();
  });
});

describe('EmptyState / ErrorState', () => {
  it('carries the copy build-plan §6.3 names, and the action button when wired', () => {
    expect(EMPTY_STATE_PRESETS['no-balance-at-mint'].title.toLowerCase()).toBe(
      'no balance at this mint',
    );
    expect(EMPTY_STATE_PRESETS['no-seeders-online'].title.toLowerCase()).toBe('no seeders online');
    expect(EMPTY_STATE_PRESETS['signer-not-detected'].title.toLowerCase()).toBe(
      'signer not detected',
    );
    const onAction = vi.fn();
    const r = render(createElement(EmptyState, { preset: 'signer-not-detected', onAction }));
    expect(r.get('[role="status"]').getAttribute('data-preset')).toBe('signer-not-detected');
    expect(r.get('.nf-state__title').textContent).toBe('Signer not detected');
    click(r.get('.nf-state__actions button'));
    expect(onAction).toHaveBeenCalled();
    r.rerender(createElement(EmptyState, { preset: 'no-videos' }));
    expect(r.container.querySelector('.nf-state__actions')).toBeNull();
    r.rerender(createElement(EmptyState, { title: 'Custom', icon: 'search' }));
    expect(r.get('.nf-state__title').textContent).toBe('Custom');
    r.unmount();
  });

  it('ErrorState is an alert with retry', () => {
    const onRetry = vi.fn();
    const r = render(createElement(ErrorState, { detail: 'relay timed out', onRetry }));
    expect(r.get('[role="alert"]')).toBeTruthy();
    expect(r.get('.nf-state__detail').textContent).toBe('relay timed out');
    click(r.get('.nf-state__actions button'));
    expect(onRetry).toHaveBeenCalled();
    r.unmount();
  });
});

describe('Sheet', () => {
  it('renders a modal dialog when open, closes on Escape, backdrop and the close button', () => {
    const onClose = vi.fn();
    const r = render(createElement(Sheet, { open: false, onClose, title: 'Pay from' }, 'body'));
    expect(r.container.querySelector('[role="dialog"]')).toBeNull();
    r.rerender(
      createElement(
        Sheet,
        { open: true, onClose, title: 'Pay from' },
        createElement('button', { type: 'button' }, 'ok'),
      ),
    );
    const dialog = r.get('[role="dialog"]');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
      'Pay from',
    );
    // focus moved into the sheet
    expect(dialog.contains(document.activeElement)).toBe(true);
    keydown(dialog, 'Escape');
    click(r.get('[data-testid="sheet-backdrop"]'));
    click(r.get('button[aria-label="Close"]'));
    expect(onClose).toHaveBeenCalledTimes(3);
    r.unmount();
  });

  it('initialFocus: first form field, a selector or a ref instead of Close; bad input falls back', () => {
    const form = createElement(
      'form',
      null,
      createElement('input', { type: 'hidden', name: 'h' }),
      createElement('input', { type: 'text', id: 'title' }),
      createElement('textarea', { id: 'desc' }),
    );
    const open = (initialFocus: string | undefined): ReturnType<typeof render> =>
      render(
        createElement(
          Sheet,
          { open: true, onClose: () => undefined, title: 'New', initialFocus },
          form,
        ),
      );
    let r = open('first-field');
    expect(document.activeElement?.id).toBe('title');
    r.unmount();
    r = open('#desc');
    expect(document.activeElement?.id).toBe('desc');
    r.unmount();
    for (const bad of ['#missing', '[[not a selector']) {
      r = open(bad);
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
      r.unmount();
    }
    const ref = createRef<HTMLButtonElement>();
    r = render(
      createElement(
        Sheet,
        { open: true, onClose: () => undefined, title: 'T', initialFocus: ref },
        createElement('button', { type: 'button', ref, id: 'target' }, 'go'),
      ),
    );
    expect(document.activeElement?.id).toBe('target');
    r.unmount();
    // default is unchanged: Close first
    r = open(undefined);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
    r.unmount();
  });

  it('traps Tab inside the panel', () => {
    const r = render(
      createElement(
        Sheet,
        { open: true, onClose: () => undefined, title: 'T' },
        createElement('button', { type: 'button', id: 'last' }, 'last'),
      ),
    );
    const first = r.get('button[aria-label="Close"]');
    const last = r.get('#last');
    last.focus();
    keydown(last, 'Tab');
    expect(document.activeElement).toBe(first);
    keydown(first, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
    r.unmount();
  });
});

describe('Toast', () => {
  it('uses status for info and alert for errors, dismisses, and auto-dismisses on a timer', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const r = render(
      createElement(ToastStack, {
        inline: true,
        onDismiss,
        toasts: [
          { id: 'a', title: 'Saved', durationMs: 1000 },
          {
            id: 'b',
            tone: 'error',
            title: 'Failed',
            action: { label: 'Retry', onClick: () => undefined },
          },
        ],
      }),
    );
    expect(r.all('[role="status"]')).toHaveLength(1);
    expect(r.all('[role="alert"]')).toHaveLength(1);
    click(r.all('button[aria-label="Dismiss"]')[1]!);
    expect(onDismiss).toHaveBeenCalledWith('b');
    fire(window, new Event('noop'));
    vi.advanceTimersByTime(1100);
    expect(onDismiss).toHaveBeenCalledWith('a');
    vi.useRealTimers();
    r.unmount();
  });

  it('single Toast renders description and action', () => {
    const onClick = vi.fn();
    const r = render(
      createElement(Toast, {
        toast: {
          id: 'x',
          tone: 'sats',
          title: '21 sats sent',
          description: 'to Kiln',
          action: { label: 'Undo', onClick },
          durationMs: 0,
        },
        onDismiss: () => undefined,
      }),
    );
    expect(r.get('.nf-toast__desc').textContent).toBe('to Kiln');
    click(r.get('.nf-toast__action'));
    expect(onClick).toHaveBeenCalled();
    r.unmount();
  });
});

describe('catalog narrowing (contracts v9)', () => {
  const nip71 = mocks.VIDEOS[0]!;
  const nfx = mocks.NFX_VIDEOS[0]!;

  it('tells an NFX video and address from a NIP-71 one', () => {
    expect(components.isNfxVideo(nfx)).toBe(true);
    expect(components.isNfxVideo(nip71)).toBe(false);
    expect(components.isNip71Video(nip71)).toBe(true);
    expect(components.isNip71Video(nfx)).toBe(false);
    expect(components.isNfxAddress(nfx.id)).toBe(true);
    expect(components.isNfxAddress(nip71.id)).toBe(false);
  });

  it('nip71Only keeps the NIP-71 videos in order', () => {
    const v1 = mocks.VIDEOS[1]!;
    expect(components.nip71Only([nip71, nfx, v1])).toEqual([nip71, v1]);
    expect(components.nip71Only([nfx])).toEqual([]);
  });
});
