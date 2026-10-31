/**
 * The watch page of a free NFX video (contracts v9, ADR 0020): what a listing's NFX card opens.
 *
 * This build lists NFX videos but cannot play them; the NFX transports arrive with slice 5. So
 * the stage says so plainly, and nothing that plays, pays, reacts or saves is offered: those are
 * keyed by NIP-71 event ids, and an NFX video is named by its address.
 */
import { useEffect, useId, useState, type ReactElement } from 'react';
import type { NfxAddress, NfxVideo, Profile, UnixSeconds } from '@sovit/core';
import {
  EmptyState,
  ErrorState,
  Markdown,
  ProfileAvatar,
  Skeleton,
  SkeletonLines,
  cx,
  formatDuration,
  formatRelativeTime,
  shortPubkey,
} from '../../components/index.js';
import type { ScreenProps } from '../shared/route.js';
import { avatarSrc } from '../shared/image.js';
import { describeWatchError } from './model.js';

export interface NfxWatchProps extends ScreenProps {
  /** The NFX video to show (`Route { name: 'watch', videoId }` with an NFX address). */
  readonly videoId: NfxAddress;
  /** "now" for relative timestamps; stories/tests pin it so PNGs are diffable. */
  readonly now?: UnixSeconds | number | undefined;
  readonly className?: string | undefined;
}

type Phase =
  | { readonly status: 'loading' }
  | { readonly status: 'missing' }
  | { readonly status: 'error'; readonly error: unknown }
  | {
      readonly status: 'ready';
      readonly video: NfxVideo;
      readonly channel: Profile | null;
      readonly avatar: string | undefined;
    };

export function NfxWatch({
  adapter,
  navigate,
  videoId,
  now,
  className,
}: NfxWatchProps): ReactElement {
  const id = useId();
  const [phase, setPhase] = useState<Phase>({ status: 'loading' });
  const [gen, setGen] = useState(0);

  useEffect(() => {
    let alive = true;
    setPhase({ status: 'loading' });
    void (async (): Promise<void> => {
      let video: NfxVideo | null;
      try {
        video = await adapter.nfxVideo(videoId);
      } catch (error: unknown) {
        if (alive) setPhase({ status: 'error', error });
        return;
      }
      if (!alive) return;
      if (video === null) {
        setPhase({ status: 'missing' });
        return;
      }
      setPhase({ status: 'ready', video, channel: null, avatar: undefined });
      // The channel row fills in when the profile arrives; a failure leaves the short pubkey.
      const channel = await adapter.profile(video.author).catch(() => null);
      if (!alive) return;
      setPhase({ status: 'ready', video, channel, avatar: undefined });
      const avatar = await (avatarSrc(adapter, channel) ?? Promise.resolve(undefined)).catch(
        () => undefined,
      );
      if (alive && avatar !== undefined) setPhase({ status: 'ready', video, channel, avatar });
    })();
    return () => {
      alive = false;
    };
  }, [adapter, videoId, gen]);

  const nowSec = now ?? Math.floor(Date.now() / 1000);

  if (phase.status === 'loading') {
    return (
      <section
        className={cx('nf-watch', 'nf-nfxwatch', className)}
        aria-labelledby={`${id}-title`}
        aria-busy="true"
      >
        <h1 id={`${id}-title`} className="nf-watch__sr">
          Loading video
        </h1>
        <div className="nf-watch__layout">
          <div className="nf-watch__stage-cell">
            <Skeleton variant="block" aspectRatio="16 / 9" className="nf-watch__stage-skeleton" />
          </div>
          <div className="nf-watch__main">
            <Skeleton variant="text" width="60%" height={28} />
            <SkeletonLines lines={3} />
          </div>
        </div>
      </section>
    );
  }

  if (phase.status === 'missing' || phase.status === 'error') {
    const e = phase.status === 'error' ? describeWatchError(phase.error) : undefined;
    return (
      <section className={cx('nf-watch', 'nf-nfxwatch', className)} aria-labelledby={`${id}-title`}>
        <h1 id={`${id}-title`} className="nf-watch__sr">
          {e === undefined ? 'Video not found' : e.title}
        </h1>
        {e === undefined ? (
          <EmptyState
            icon="videoOff"
            title="Video not found"
            description="This NFX video is not on your relays any more: its creator may have deleted it, or it is no longer free."
            action="Back to Home"
            onAction={() => {
              navigate({ name: 'home' });
            }}
          />
        ) : (
          <ErrorState
            title={e.title}
            description={e.description}
            detail={e.detail}
            onRetry={() => {
              setGen((g) => g + 1);
            }}
          />
        )}
      </section>
    );
  }

  const { video, channel, avatar } = phase;
  const channelName = channel?.displayName ?? channel?.name ?? shortPubkey(video.author);
  return (
    <section className={cx('nf-watch', 'nf-nfxwatch', className)} aria-labelledby={`${id}-title`}>
      <div className="nf-watch__layout">
        <div className="nf-watch__stage-cell">
          <div className="nf-nfxwatch__stage">
            <EmptyState
              icon="videoOff"
              title="Can't play this yet"
              description="This free video is on the NFX network. This version of Nutflix can list NFX videos but can't play them yet."
            />
          </div>
        </div>
        <div className="nf-watch__main">
          <h1 id={`${id}-title`} className="nf-watch__title">
            {video.title}
          </h1>
          <button
            type="button"
            className="nf-nfxwatch__channel"
            onClick={() => {
              navigate({ name: 'channel', pubkey: video.author });
            }}
          >
            <ProfileAvatar profile={channel ?? { pubkey: video.author }} src={avatar} size="md" />
            <span>{channelName}</span>
          </button>
          <div className="nf-watch__desc nf-watch__desc--open">
            <p className="nf-watch__desc-meta">
              <span className="nf-watch__desc-stat">Free · NFX</span>
              <span className="nf-watch__desc-stat">
                {formatRelativeTime(video.publishedAt, nowSec)}
              </span>
              {video.durationSec !== undefined ? (
                <span className="nf-watch__desc-stat">{formatDuration(video.durationSec)}</span>
              ) : null}
            </p>
            {video.description.trim() !== '' ? (
              <Markdown source={video.description} className="nf-watch__desc-body" />
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
