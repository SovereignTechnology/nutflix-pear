/**
 * "Stats for nerds" (contracts v19, ADR 0024): an overlay on the video saying where its bytes
 * come from — each source by a short id, with what it sent — and the player's own numbers.
 *
 * Peers' addresses appear only behind "Show addresses": off each time the panel opens, never
 * remembered, and asked for (`addresses()`) only while it is on, with a banner saying what
 * they are. `useNerdStats` holds that rule; `NerdStats` only draws.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { NfxPlayStats, PeerSpend, PlaySession, PlaySourceAddress } from '@sovit/core';
import { cx } from '../shared/format.js';
import {
  addressText,
  copyText,
  pathText,
  sampleElement,
  type ElementSample,
  type NerdSourceRow,
  type SampledElement,
} from './model.js';

export interface NerdStatsProps {
  readonly rows: readonly (readonly [string, string])[];
  readonly sources: readonly NerdSourceRow[];
  /** Whether this play can say where its connections go (`addresses()` exists). */
  readonly canShowAddresses: boolean;
  readonly showAddresses: boolean;
  /** Addresses by `NerdSourceRow.key`, while shown. */
  readonly addresses: ReadonlyMap<string, PlaySourceAddress>;
  readonly onShowAddresses: (on: boolean) => void;
  readonly onClose: () => void;
  readonly className?: string | undefined;
}

export function NerdStats({
  rows,
  sources,
  canShowAddresses,
  showAddresses,
  addresses,
  onShowAddresses,
  onClose,
  className,
}: NerdStatsProps): ReactElement {
  const [status, setStatus] = useState('');
  const withAddresses = canShowAddresses && showAddresses;
  const copy = (): void => {
    const text = copyText(rows, sources, withAddresses ? addresses : null);
    const clip = (globalThis.navigator as Navigator | undefined)?.clipboard;
    if (clip === undefined) {
      setStatus('Copy failed: no clipboard here.');
      return;
    }
    clip.writeText(text).then(
      () => {
        setStatus(withAddresses ? 'Copied, with addresses.' : 'Copied (no addresses).');
      },
      () => {
        setStatus('Copy failed: the clipboard was refused.');
      },
    );
  };
  return (
    <section
      className={cx('nf-nerd', className)}
      role="dialog"
      aria-label="Stats for nerds"
      data-testid="nerd-stats"
    >
      <div className="nf-nerd__head">
        <strong className="nf-nerd__title">Stats for nerds</strong>
        {canShowAddresses ? (
          <label className="nf-nerd__switch">
            <input
              type="checkbox"
              checked={showAddresses}
              onChange={(e) => {
                onShowAddresses(e.currentTarget.checked);
              }}
            />{' '}
            Show addresses
          </label>
        ) : null}
        <button type="button" className="nf-nerd__button" onClick={copy}>
          Copy
        </button>
        <button
          type="button"
          className="nf-nerd__button"
          aria-label="Close stats"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {withAddresses ? (
        <p className="nf-nerd__banner" role="note">
          Addresses visible: these are other people&apos;s IP addresses. Don&apos;t share
          screenshots.
        </p>
      ) : null}
      {/* The sources first: they are what the panel is for, and in a small player the panel
          scrolls, so what is below the fold is the player's own numbers. */}
      {sources.length > 0 ? (
        <table className="nf-nerd__sources">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">ID</th>
              <th scope="col">Via</th>
              <th scope="col">Down</th>
              <th scope="col">Up</th>
              <th scope="col">Files</th>
              {withAddresses ? (
                <>
                  <th scope="col">Address</th>
                  <th scope="col">Path</th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => {
              const a = withAddresses ? addresses.get(s.key) : undefined;
              return (
                <tr
                  key={`${s.kind}:${s.key}`}
                  className={cx(!s.connected && 'nf-nerd__closed')}
                  data-kind={s.kind}
                >
                  <td>
                    {s.source}
                    {s.connected ? '' : ' (closed)'}
                  </td>
                  <td className="nf-nerd__id">{s.id}</td>
                  <td>{s.via}</td>
                  <td>{s.down}</td>
                  <td>{s.up}</td>
                  <td>{s.files}</td>
                  {withAddresses ? (
                    <>
                      <td className="nf-nerd__addr">
                        {s.kind === 'origin' ? s.id : addressText(a)}
                      </td>
                      <td>{s.kind === 'origin' ? 'HTTPS' : pathText(a)}</td>
                    </>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="nf-nerd__status">No source has sent bytes yet.</p>
      )}
      <table className="nf-nerd__rows">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {status !== '' ? (
        <p className="nf-nerd__status" role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}

export interface NerdFeed<S> {
  /** The play's numbers; polled while the panel is open. */
  readonly stats?: (() => Promise<S>) | undefined;
  /** Where its connections go; asked only while addresses are shown. */
  readonly addresses?: (() => Promise<readonly PlaySourceAddress[]>) | undefined;
  /** The `<video>` to sample. */
  readonly element: () => SampledElement | null;
}

export interface NerdState<S> {
  readonly stats: S | null;
  readonly sample: ElementSample | null;
  readonly canShowAddresses: boolean;
  readonly showAddresses: boolean;
  readonly addresses: ReadonlyMap<string, PlaySourceAddress>;
  readonly setShowAddresses: (on: boolean) => void;
}

const NO_ADDRESSES: ReadonlyMap<string, PlaySourceAddress> = new Map();
const NO_PEERS: readonly PeerSpend[] = [];

/**
 * The paid session's seeders (`onPeers`) for a panel, for the players that do not already keep
 * them (Shorts, the mini-player). `onPeers` does not replay what it last said, so this listens
 * for the session's whole life and keeps only the latest list; it re-renders its caller only
 * while `open`, and opens with that latest list rather than an empty one.
 */
export function useSessionPeers(session: PlaySession | null, open: boolean): readonly PeerSpend[] {
  const [shown, setShown] = useState<readonly PeerSpend[]>(NO_PEERS);
  const latest = useRef<readonly PeerSpend[]>(NO_PEERS);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    latest.current = NO_PEERS;
    setShown(NO_PEERS);
    if (session === null) return undefined;
    return session.onPeers((list) => {
      latest.current = list;
      if (openRef.current) setShown(list);
    });
  }, [session]);

  useEffect(() => {
    setShown(open ? latest.current : NO_PEERS);
  }, [open]);

  return shown;
}

/**
 * Polls `feed` every `intervalMs` while `open`. Addresses start off on every open and are
 * cleared on close; `feed.addresses` runs only while they are on, one call at a time.
 */
export function useNerdStats<S = NfxPlayStats>(
  open: boolean,
  feed: NerdFeed<S>,
  intervalMs = 1000,
): NerdState<S> {
  const [stats, setStats] = useState<S | null>(null);
  const [sample, setSample] = useState<ElementSample | null>(null);
  const [showAddresses, setShow] = useState(false);
  const [addresses, setAddresses] = useState<ReadonlyMap<string, PlaySourceAddress>>(NO_ADDRESSES);
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const showRef = useRef(false);
  const asking = useRef(false);

  const setShowAddresses = useCallback((on: boolean): void => {
    showRef.current = on;
    setShow(on);
    setAddresses(NO_ADDRESSES);
  }, []);

  useEffect(() => {
    // Off on every open, and on close.
    showRef.current = false;
    setShow(false);
    setAddresses(NO_ADDRESSES);
    if (!open) return undefined;
    let live = true;
    let request = 0;
    let acceptedRequest = 0;
    const tick = (): void => {
      const f = feedRef.current;
      const el = f.element();
      setSample(el === null ? null : sampleElement(el));
      const currentRequest = ++request;
      f.stats?.().then(
        (s) => {
          if (live && currentRequest > acceptedRequest) {
            acceptedRequest = currentRequest;
            setStats(s);
          }
        },
        () => undefined,
      );
      if (showRef.current && f.addresses !== undefined && !asking.current) {
        asking.current = true;
        f.addresses().then(
          (list) => {
            asking.current = false;
            if (live && showRef.current) setAddresses(new Map(list.map((a) => [a.id, a])));
          },
          () => {
            asking.current = false;
          },
        );
      }
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [open, intervalMs]);

  // Switched on: ask now, not at the next tick.
  useEffect(() => {
    if (!open || !showAddresses) return undefined;
    const f = feedRef.current;
    if (f.addresses === undefined || asking.current) return undefined;
    let live = true;
    asking.current = true;
    f.addresses().then(
      (list) => {
        asking.current = false;
        if (live && showRef.current) setAddresses(new Map(list.map((a) => [a.id, a])));
      },
      () => {
        asking.current = false;
      },
    );
    return () => {
      live = false;
    };
  }, [open, showAddresses]);

  return {
    stats,
    sample,
    canShowAddresses: feed.addresses !== undefined,
    showAddresses,
    addresses,
    setShowAddresses,
  };
}
