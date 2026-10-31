/**
 * The watch page of a free NFX video (contracts v9, ADR 0020): what a listing's NFX card opens.
 *
 * Contracts v11 (slice 5d): Play opens a free `playNfx` session from the seeders the video's
 * beacons name, every file checked against its hash list; nothing is paid, so there is no price,
 * spend or peer panel. Nothing that reacts or saves is offered: those are keyed by NIP-71 event
 * ids, and an NFX video is named by its address. The session closes when the page goes.
 */
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type {
  NetworkAdapter,
  NfxAddress,
  NfxPlaySession,
  NfxVideo,
  Profile,
  UnixSeconds,
} from '@sovit/core';
import {
  Button,
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

type PlayState =
  | { readonly status: 'idle' }
  | { readonly status: 'opening' }
  | { readonly status: 'playing'; readonly session: NfxPlaySession }
  | { readonly status: 'no-seeders' }
  | { readonly status: 'error'; readonly error: unknown };

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The stage: Play, then the free session's video, with its renditions to pick from. */
function NfxStage({
  adapter,
  video,
}: {
  readonly adapter: NetworkAdapter;
  readonly video: NfxVideo;
}): ReactElement {
  const [state, setState] = useState<PlayState>({ status: 'idle' });
  const session = useRef<NfxPlaySession | null>(null);
  const opening = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      opening.current++;
      void session.current?.close().catch(() => undefined);
      session.current = null;
    };
  }, [video.id]);

  const open = (rendition?: string): void => {
    const prev = session.current;
    session.current = null;
    void prev?.close().catch(() => undefined);
    const ticket = ++opening.current;
    setState({ status: 'opening' });
    const pending =
      rendition === undefined ? adapter.playNfx(video.id) : adapter.playNfx(video.id, rendition);
    pending.then(
      (s) => {
        if (!mounted.current || ticket !== opening.current) {
          void s.close().catch(() => undefined);
          return;
        }
        session.current = s;
        setState({ status: 'playing', session: s });
      },
      (error: unknown) => {
        if (!mounted.current || ticket !== opening.current) return;
        setState(
          messageOf(error).includes('no-seeders')
            ? { status: 'no-seeders' }
            : { status: 'error', error },
        );
      },
    );
  };

  switch (state.status) {
    case 'idle':
      return (
        <div className="nf-nfxwatch__stage">
          <div className="nf-nfxwatch__start">
            <Button
              variant="primary"
              onClick={() => {
                open();
              }}
            >
              Play — free
            </Button>
            <p className="nf-nfxwatch__note">
              From the NFX network&apos;s seeders; nothing is paid.
            </p>
          </div>
        </div>
      );
    case 'opening':
      return (
        <div className="nf-nfxwatch__stage" aria-busy="true">
          <p className="nf-nfxwatch__note" role="status">
            Finding seeders…
          </p>
        </div>
      );
    case 'no-seeders':
      return (
        <div className="nf-nfxwatch__stage">
          <EmptyState
            preset="no-seeders-online"
            description="Nobody seeding this NFX video is online right now. Try again in a while."
            onAction={() => {
              open();
            }}
          />
        </div>
      );
    case 'error': {
      const e = describeWatchError(state.error);
      return (
        <div className="nf-nfxwatch__stage">
          <ErrorState
            title={e.title}
            description={e.description}
            detail={e.detail}
            onRetry={() => {
              open();
            }}
          />
        </div>
      );
    }
    case 'playing': {
      const s = state.session;
      const url = s.source.kind === 'mediasource' ? undefined : s.source.url;
      return (
        <div className="nf-nfxwatch__player">
          <video
            className="nf-nfxwatch__video"
            src={url}
            controls
            autoPlay
            playsInline
            aria-label={video.title}
          />
          {s.renditions.length > 1 ? (
            <label className="nf-nfxwatch__quality">
              Quality{' '}
              <select
                value={s.rendition}
                onChange={(e) => {
                  open(e.currentTarget.value);
                }}
              >
                {s.renditions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.resolution ?? r.id}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      );
    }
  }
}

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
    const ac = new AbortController();
    const gone = (): boolean => ac.signal.aborted;
    setPhase({ status: 'loading' });
    void (async (): Promise<void> => {
      let video: NfxVideo | null;
      try {
        video = await adapter.nfxVideo(videoId);
      } catch (error: unknown) {
        if (!gone()) setPhase({ status: 'error', error });
        return;
      }
      if (gone()) return;
      if (video === null) {
        setPhase({ status: 'missing' });
        return;
      }
      setPhase({ status: 'ready', video, channel: null, avatar: undefined });
      // The channel row fills in when the profile arrives; a failure leaves the short pubkey.
      const channel = await adapter.profile(video.author).catch(() => null);
      if (gone()) return;
      setPhase({ status: 'ready', video, channel, avatar: undefined });
      const avatar = await (avatarSrc(adapter, channel) ?? Promise.resolve(undefined)).catch(
        () => undefined,
      );
      if (!gone() && avatar !== undefined) setPhase({ status: 'ready', video, channel, avatar });
    })();
    return () => {
      ac.abort();
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
          <NfxStage adapter={adapter} video={video} />
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
