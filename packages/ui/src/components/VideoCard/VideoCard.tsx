import { useState, type ReactElement } from 'react';
import type { CatalogVideo, Profile, UnixSeconds, VideoStats } from '@sovit/core';
import { ProfileAvatar } from '../Avatar/Avatar.js';
import { SatsBadge } from '../SatsBadge/SatsBadge.js';
import { Skeleton } from '../Skeleton/Skeleton.js';
import { isNfxVideo } from '../shared/catalog-video.js';
import { Icon } from '../shared/Icon.js';
import {
  cx,
  defaultRenditionSats,
  formatDuration,
  formatPaidViews,
  formatRelativeTime,
  formatSats,
} from '../shared/format.js';

export type VideoCardLayout = 'grid' | 'list';

/**
 * Generic over the video so a screen that lists NIP-71 videos only keeps `onOpen` typed as such,
 * and one that lists NFX videos too must handle both.
 */
export interface VideoCardProps<V extends CatalogVideo = CatalogVideo> {
  /** Contracts v9: a NIP-71 video, or a free NFX one (no price, no thumbnail yet, not playable). */
  readonly video: V;
  /** Channel profile for the row under the title (resolved by the screen). */
  readonly channel?: Profile | undefined;
  /** Resolved, hash-verified thumbnail URL (`NetworkAdapter.image`). Omit while loading. */
  readonly thumbnailSrc?: string | undefined;
  /** Resolved channel avatar URL. */
  readonly avatarSrc?: string | undefined;
  readonly stats?: Pick<VideoStats, 'paidViews'> | undefined;
  /** "now" for the relative timestamp; pass a fixed value in stories/tests. */
  readonly now?: UnixSeconds | number | undefined;
  /** `grid` = home/channel grid (thumbnail on top); `list` = related sidebar / search. */
  readonly layout?: VideoCardLayout;
  /** Hides the channel row (channel page grids). */
  readonly hideChannel?: boolean;
  /** Watched progress 0–1 for the red bar under the thumbnail (from NIP-51 history). */
  readonly progress?: number | undefined;
  readonly onOpen?: ((video: V) => void) | undefined;
  readonly onOpenChannel?: ((pubkey: V['author']) => void) | undefined;
  readonly className?: string;
}

/**
 * YouTube-style video card: 16:9 thumbnail with blur-up placeholder, duration badge, price
 * badge, two-line title, channel row (avatar · name · NIP-05 check), meta line
 * ("12 paid views · 3 hours ago"). Price is on the card because the network shows the price
 * before playback ever starts (build-plan §6.1 Watch/Home). It is the DEFAULT rendition's price
 * (the manifest's first — what `play(id)` streams and Watch/Shorts charge), never "from" the
 * cheapest (ADR 0007 c), and it is part of the thumbnail button's accessible name.
 */
export function VideoCard<V extends CatalogVideo>({
  video,
  channel,
  thumbnailSrc,
  avatarSrc,
  stats,
  now = Math.floor(Date.now() / 1000),
  layout = 'grid',
  hideChannel = false,
  progress,
  onOpen,
  onOpenChannel,
  className,
}: VideoCardProps<V>): ReactElement {
  const [loaded, setLoaded] = useState(false);
  // Narrowing works on the union, not on the type parameter.
  const shown: CatalogVideo = video;
  // An NFX video has no renditions and no price: its files are fetched over NFX (slice 5).
  const nfx = isNfxVideo(shown);
  const placeholder = isNfxVideo(shown) ? undefined : shown.renditions[0]?.placeholder;
  const price = isNfxVideo(shown) ? undefined : defaultRenditionSats(shown.renditions, shown.price);
  const channelName = channel?.displayName ?? channel?.name ?? '';
  const isShort = video.kind === 22;

  const open = (): void => {
    onOpen?.(video);
  };

  return (
    <article
      className={cx('nf-card', `nf-card--${layout}`, isShort && 'nf-card--short', className)}
      aria-label={video.title}
    >
      <button
        type="button"
        className="nf-card__thumb"
        onClick={open}
        aria-label={
          nfx
            ? `${video.title}, free`
            : price === undefined
              ? video.title
              : `${video.title}, ${formatSats(price)}`
        }
      >
        {placeholder ? (
          <img className="nf-card__placeholder" src={placeholder} alt="" aria-hidden="true" />
        ) : null}
        {thumbnailSrc ? (
          <img
            className={cx('nf-card__img', loaded && 'nf-card__img--loaded')}
            src={thumbnailSrc}
            alt=""
            loading="lazy"
            decoding="async"
            onLoad={() => {
              setLoaded(true);
            }}
          />
        ) : null}
        {nfx ? null : (
          <span className="nf-card__hover" aria-hidden="true">
            <Icon name="play" size={40} />
          </span>
        )}
        {video.durationSec !== undefined ? (
          <span className="nf-card__duration">{formatDuration(video.durationSec)}</span>
        ) : null}
        {nfx ? (
          <span className="nf-card__free" aria-hidden="true">
            Free
          </span>
        ) : null}
        {price !== undefined ? (
          <SatsBadge
            className="nf-card__price"
            sats={price}
            variant="price"
            size="sm"
            overlay
            compact
          />
        ) : null}
        {progress !== undefined && progress > 0 ? (
          <span className="nf-card__progress" aria-hidden="true">
            <span
              className="nf-card__progress-bar"
              style={{ width: `${Math.min(100, Math.max(0, progress * 100)).toFixed(1)}%` }}
            />
          </span>
        ) : null}
      </button>

      <div className="nf-card__body">
        {!hideChannel && layout === 'grid' ? (
          <button
            type="button"
            className="nf-card__avatar"
            aria-label={channelName || 'channel'}
            onClick={() => {
              onOpenChannel?.(video.author);
            }}
          >
            <ProfileAvatar
              profile={channel ?? { pubkey: video.author }}
              src={avatarSrc}
              size="md"
            />
          </button>
        ) : null}
        <div className="nf-card__text">
          <h3 className="nf-card__title">
            <button type="button" className="nf-card__title-button" onClick={open}>
              {video.title}
            </button>
          </h3>
          {!hideChannel ? (
            <button
              type="button"
              className="nf-card__channel"
              onClick={() => {
                onOpenChannel?.(video.author);
              }}
            >
              <span className="nf-card__channel-name">{channelName || 'Unknown channel'}</span>
              {channel?.nip05Status === 'verified' ? (
                <Icon name="verified" size={14} label="verified" className="nf-card__verified" />
              ) : null}
            </button>
          ) : null}
          <div className="nf-card__meta">
            {stats ? <span>{formatPaidViews(stats.paidViews)}</span> : null}
            {stats ? <span aria-hidden="true"> · </span> : null}
            <span>{formatRelativeTime(video.publishedAt, now)}</span>
          </div>
        </div>
      </div>
    </article>
  );
}

export interface VideoCardSkeletonProps {
  readonly layout?: VideoCardLayout;
  /** Matches a `VideoCard` with `hideChannel` (channel page grids): no avatar circle. */
  readonly hideChannel?: boolean;
  readonly className?: string;
}

/** Same footprint as `VideoCard` while data loads. */
export function VideoCardSkeleton({
  layout = 'grid',
  hideChannel = false,
  className,
}: VideoCardSkeletonProps): ReactElement {
  return (
    <div
      className={cx('nf-card', `nf-card--${layout}`, 'nf-card--skeleton', className)}
      aria-busy="true"
    >
      <div className="nf-card__thumb nf-card__thumb--skeleton">
        <Skeleton variant="block" aspectRatio="16 / 9" />
      </div>
      <div className="nf-card__body">
        {layout === 'grid' && !hideChannel ? (
          <span className="nf-card__avatar">
            <Skeleton variant="circle" />
          </span>
        ) : null}
        <div className="nf-card__text">
          <Skeleton variant="text" width="90%" height={14} />
          <Skeleton variant="text" width="60%" height={14} />
          <Skeleton variant="text" width="40%" height={12} />
        </div>
      </div>
    </div>
  );
}
