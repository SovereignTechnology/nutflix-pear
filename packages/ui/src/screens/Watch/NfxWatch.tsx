/**
 * The watch page of a free NFX video (contracts v9, ADR 0020): what a listing's NFX card opens.
 *
 * Contracts v11 (slice 5d): Play opens a free `playNfx` session from the seeders the video's
 * beacons name, every file checked against its hash list; nothing is paid, so there is no price,
 * spend or peer panel. Nothing that reacts or saves is offered: those are keyed by NIP-71 event
 * ids, and an NFX video is named by its address. The session closes when the page goes.
 *
 * Slice 5d-4: the NFX copy of a NIP-71 video (`legacyId`) shows that event's comments, once the
 * event is found and is by the same author (a manifest cannot borrow another video's thread).
 *
 * Contracts v14 (ADR 0022): a session's source may be a URL (the desktop app's media link) or an
 * `element` source, which the adapter's own player feeds into this page's `<video>` (`attach`);
 * a session with `setRendition` switches quality in place, any other is closed and reopened.
 *
 * Contracts v15: a session with `onChange` is re-read when it changes, so renditions an `element`
 * source learns once attached reach the quality picker, and its `problems` are shown: files the
 * player refused, origins whose hash list did not verify, and a play that stopped (with a retry).
 */
import {
  useCallback,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type ReactElement,
  type RefCallback,
} from 'react';
import type {
  NetworkAdapter,
  NfxAddress,
  NfxPlayProblem,
  NfxPlaySession,
  NfxVideo,
  NostrEventId,
  NostrPubkey,
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
  ToastStack,
  cx,
  formatDuration,
  formatRelativeTime,
  shortPubkey,
  type ToastItem,
} from '../../components/index.js';
import type { ScreenProps } from '../shared/route.js';
import { avatarSrc } from '../shared/image.js';
import { playSourceUrl } from '../shared/play-source.js';
import { describeWatchError, type Me } from './model.js';
import { useResolvers } from './useResolvers.js';
import { WatchComments } from './WatchComments.js';

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
  | { readonly status: 'playing'; readonly session: NfxPlaySession; readonly ticket: number }
  | { readonly status: 'no-seeders' }
  | { readonly status: 'error'; readonly error: unknown };

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What the player ran into (v15), as the viewer reads it: a stop, refused files, origins skipped. */
function NfxProblems({
  problems,
  onRetry,
}: {
  readonly problems: readonly NfxPlayProblem[];
  readonly onRetry: () => void;
}): ReactElement | null {
  const stopped = problems.findLast((p) => p.kind === 'stopped');
  const refused = problems.filter((p) => p.kind === 'refused');
  const origins = problems.filter((p) => p.kind === 'origin');
  if (stopped === undefined && refused.length === 0 && origins.length === 0) return null;
  return (
    <div className="nf-nfxwatch__problems">
      {stopped !== undefined ? (
        <div className="nf-nfxwatch__problem nf-nfxwatch__problem--stopped" role="alert">
          <p className="nf-nfxwatch__problem-text">
            <strong>Playback stopped.</strong> {stopped.message}
          </p>
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
      {refused.length > 0 ? (
        <p className="nf-nfxwatch__problem" role="status">
          <strong>
            {refused.length === 1
              ? 'A file did not match the video’s hash list and was refused.'
              : `${String(refused.length)} files did not match the video’s hash list and were refused.`}
          </strong>{' '}
          {refused.at(-1)?.message}
        </p>
      ) : null}
      {origins.length > 0 ? (
        <p className="nf-nfxwatch__problem" role="status">
          <strong>
            {origins.length === 1
              ? 'An origin did not serve a hash list that verifies, so it was skipped.'
              : `${String(origins.length)} origins did not serve a hash list that verifies, so they were skipped.`}
          </strong>{' '}
          {origins.at(-1)?.message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A playing session's `<video>` and quality picker. An `element` source (v14) is attached to the
 * element while both live and detached when either goes; a URL source is the element's `src`.
 * `onReopen` closes the session and opens the rendition anew: the only switch a session without
 * `setRendition` has, and the fallback when an in-place switch fails. A session with `onChange`
 * (v15) is re-read on every change; `onRetry` opens the video anew after the play stopped.
 */
function NfxPlayer({
  session,
  title,
  onReopen,
  onRetry,
}: {
  readonly session: NfxPlaySession;
  readonly title: string;
  readonly onReopen: (rendition: string) => void;
  readonly onRetry: () => void;
}): ReactElement {
  const [rendition, setRendition] = useState(session.rendition);
  const [switching, setSwitching] = useState(false);
  const [, changed] = useReducer((n: number) => n + 1, 0);
  useEffect(
    () =>
      session.onChange?.(() => {
        changed();
      }),
    [session],
  );
  const source = session.source;
  const renditions = session.renditions;
  const detach = useRef<(() => void) | null>(null);
  const videoRef: RefCallback<HTMLVideoElement> = useCallback(
    (el: HTMLVideoElement | null) => {
      detach.current?.();
      detach.current = null;
      if (el !== null && source.kind === 'element') detach.current = source.attach(el);
    },
    [source],
  );
  useEffect(
    () => () => {
      detach.current?.();
      detach.current = null;
    },
    [],
  );

  const pick = (id: string): void => {
    if (id === rendition) return;
    const inPlace = session.setRendition?.bind(session);
    if (inPlace === undefined) {
      onReopen(id);
      return;
    }
    setSwitching(true);
    inPlace(id).then(
      () => {
        setSwitching(false);
        setRendition(id);
      },
      () => {
        setSwitching(false);
        onReopen(id);
      },
    );
  };

  return (
    <div className="nf-nfxwatch__player">
      <video
        ref={videoRef}
        className="nf-nfxwatch__video"
        src={playSourceUrl(source)}
        controls
        autoPlay
        playsInline
        aria-label={title}
      />
      {renditions.length > 1 ? (
        <label className="nf-nfxwatch__quality">
          Quality{' '}
          <select
            value={renditions.some((r) => r.id === rendition) ? rendition : ''}
            disabled={switching}
            onChange={(e) => {
              pick(e.currentTarget.value);
            }}
          >
            {renditions.some((r) => r.id === rendition) ? null : (
              <option value="" disabled>
                Auto
              </option>
            )}
            {renditions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.resolution ?? r.id}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <NfxProblems problems={session.problems ?? []} onRetry={onRetry} />
    </div>
  );
}

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
        setState({ status: 'playing', session: s, ticket });
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
    case 'playing':
      return (
        <NfxPlayer
          key={state.ticket}
          session={state.session}
          title={video.title}
          onReopen={(rendition) => {
            open(rendition);
          }}
          onRetry={() => {
            open();
          }}
        />
      );
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
  const resolvers = useResolvers(adapter);

  const [me, setMe] = useState<Me>('pending');
  useEffect(() => {
    const ac = new AbortController();
    adapter.me().then(
      (pk) => {
        if (!ac.signal.aborted) setMe(pk);
      },
      () => {
        // An identity that cannot be read degrades to the signed-out experience.
        if (!ac.signal.aborted) setMe(null);
      },
    );
    return () => {
      ac.abort();
    };
  }, [adapter]);

  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const toastSeq = useRef(0);
  const toastError = useCallback((title: string, detail?: string): void => {
    toastSeq.current += 1;
    const item: ToastItem = {
      id: `toast-${String(toastSeq.current)}`,
      tone: 'error',
      title,
      ...(detail !== undefined ? { description: detail } : {}),
    };
    setToasts((prev) => [...prev, item]);
  }, []);
  const dismissToast = useCallback((toastId: string): void => {
    setToasts((prev) => prev.filter((t) => t.id !== toastId));
  }, []);

  // Slice 5d-4: the NIP-71 event this copy names, trusted only from the same author.
  const readyVideo = phase.status === 'ready' ? phase.video : null;
  const [twin, setTwin] = useState<{ readonly of: NfxAddress; readonly id: NostrEventId } | null>(
    null,
  );
  useEffect(() => {
    const legacyId = readyVideo?.legacyId;
    if (readyVideo === null || legacyId === undefined) return;
    const ac = new AbortController();
    adapter.video(legacyId).then(
      (v) => {
        if (!ac.signal.aborted && v?.author === readyVideo.author) {
          setTwin({ of: readyVideo.id, id: v.id });
        }
      },
      () => {
        // No thread rather than a wrong one.
      },
    );
    return () => {
      ac.abort();
    };
  }, [adapter, readyVideo]);

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
          {twin?.of === video.id ? (
            <WatchComments
              key={twin.id}
              adapter={adapter}
              videoId={twin.id}
              me={me}
              nowSec={nowSec}
              totalHint={undefined}
              resolvers={resolvers}
              onOpenChannel={(pubkey: NostrPubkey) => {
                navigate({ name: 'channel', pubkey });
              }}
              onSignIn={() => {
                navigate({ name: 'settings' });
              }}
              onError={toastError}
              idPrefix={id}
            />
          ) : null}
        </div>
      </div>
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </section>
  );
}
