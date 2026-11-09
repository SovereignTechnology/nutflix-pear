/**
 * The shell's mini-player (Watch → shell hand-off; docs/archive/lanes/L5-Watch.md "Mini-player
 * handshake"). Rendered ONCE at shell level (not in each screen's `miniPlayer` slot) so its
 * `<video>` survives navigation. It shows the coordinator's mini session:
 *
 *   - the element follows the coordinator: paused session ⇒ paused element (Shorts starting,
 *     another session resuming), and an element pause from outside (media keys, PiP) pauses the
 *     session — paused = not paying;
 *   - Play → `coordinator.resumeMini()` (every other session pauses first);
 *   - Expand → navigate to the video; the router's intercept turns that into `resumeSession`;
 *   - Close → `coordinator.dismissMini()` closes the session.
 */
import { useEffect, useRef, type ReactElement } from 'react';
import { IconButton, SatsBadge } from '../components/index.js';
import type { Route } from '../screens/index.js';
import type { MiniState, PlaybackCoordinator } from './coordinator.js';

export interface MiniPlayerProps {
  readonly mini: MiniState;
  readonly coordinator: PlaybackCoordinator;
  readonly navigate: (to: Route) => void;
  /** sats/min while this session is the one paying. */
  readonly ratePerMin: number;
}

function playQuietly(v: HTMLVideoElement): void {
  try {
    Promise.resolve(v.play()).catch(() => undefined);
  } catch {
    // no media support (tests) — the session state is what matters
  }
}

function pauseQuietly(v: HTMLVideoElement): void {
  try {
    v.pause();
  } catch {
    // as above
  }
}

export function MiniPlayer({
  mini,
  coordinator,
  navigate,
  ratePerMin,
}: MiniPlayerProps): ReactElement {
  const ref = useRef<HTMLVideoElement | null>(null);
  const { handoff, paused } = mini;
  const session = handoff.session;
  const url = session.source.kind === 'url' ? session.source.url : undefined;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Start where Watch left off, with its volume/rate.
  useEffect(() => {
    const v = ref.current;
    if (v === null) return;
    try {
      v.currentTime = handoff.positionSec;
      v.volume = Math.min(1, Math.max(0, handoff.volume));
      v.muted = handoff.muted;
      v.playbackRate = handoff.playbackRate;
    } catch {
      // unsupported in this environment
    }
    // Deliberately keyed on the session only: a new hand-off, not every re-render.
  }, [session]);

  // The element follows the session's paid state.
  useEffect(() => {
    const v = ref.current;
    if (v === null) return;
    if (paused) pauseQuietly(v);
    else playQuietly(v);
  }, [paused, session]);

  return (
    <aside className="nf-shell__mini" aria-label="Mini-player">
      <div className="nf-shell__mini-media">
        {url !== undefined ? (
          <video
            ref={ref}
            src={url}
            playsInline
            preload="auto"
            onTimeUpdate={(e) => {
              coordinator.miniProgress(e.currentTarget.currentTime);
            }}
            onPause={() => {
              if (!pausedRef.current) session.pause();
            }}
            onPlay={() => {
              if (pausedRef.current) coordinator.resumeMini();
            }}
            onEnded={() => {
              session.pause();
            }}
          />
        ) : null}
      </div>
      <div className="nf-shell__mini-bar">
        <div className="nf-shell__mini-text">
          <span className="nf-shell__mini-title" title={handoff.title}>
            {handoff.title}
          </span>
          <span className="nf-shell__mini-status">
            {paused ? (
              'Paused — not paying'
            ) : ratePerMin > 0 ? (
              <SatsBadge sats={ratePerMin} variant="rate" size="sm" />
            ) : (
              'Playing'
            )}
          </span>
        </div>
        <IconButton
          icon={paused ? 'play' : 'pause'}
          label={paused ? 'Play' : 'Pause'}
          size="sm"
          onClick={() => {
            if (paused) coordinator.resumeMini();
            else session.pause();
          }}
        />
        <IconButton
          icon="expand"
          label="Expand"
          size="sm"
          onClick={() => {
            const v = ref.current;
            if (v !== null) coordinator.miniProgress(v.currentTime);
            navigate({ name: 'watch', videoId: handoff.videoId });
          }}
        />
        <IconButton
          icon="close"
          label="Close mini-player"
          size="sm"
          onClick={() => {
            coordinator.dismissMini();
          }}
        />
      </div>
    </aside>
  );
}
