/**
 * "Stats for nerds" (contracts v19, ADR 0024): what the panel shows, as pure functions of a
 * session's numbers and a sample of the `<video>` element, so they are tested without a DOM.
 *
 * Sources are shown by a short id. Ids, `via` and labels come from the network (a peer, a
 * tracker, a beacon chose them): they are only ever rendered as text, and cut short here.
 * Addresses are joined in only while the viewer has asked to see them.
 */
import type { NfxPlayStats, PeerSpend, PlaySourceAddress, PlaySourceStat } from '@sovit/core';

/** What the element says now. */
export interface ElementSample {
  readonly width: number;
  readonly height: number;
  /** Seconds buffered ahead of the playhead. */
  readonly bufferAheadSec: number;
  readonly droppedFrames: number | null;
  readonly totalFrames: number | null;
}

/** The slice of `HTMLVideoElement` a sample reads (jsdom has no playback quality). */
export interface SampledElement {
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly currentTime: number;
  readonly buffered: {
    readonly length: number;
    start(i: number): number;
    end(i: number): number;
  };
  getVideoPlaybackQuality?: () => {
    readonly droppedVideoFrames: number;
    readonly totalVideoFrames: number;
  };
}

export function sampleElement(el: SampledElement): ElementSample {
  let ahead = 0;
  for (let i = 0; i < el.buffered.length; i += 1) {
    const start = el.buffered.start(i);
    const end = el.buffered.end(i);
    if (start <= el.currentTime + 0.1 && el.currentTime <= end) ahead = end - el.currentTime;
  }
  const q = typeof el.getVideoPlaybackQuality === 'function' ? el.getVideoPlaybackQuality() : null;
  return {
    width: el.videoWidth,
    height: el.videoHeight,
    bufferAheadSec: Math.max(0, ahead),
    droppedFrames: q === null ? null : q.droppedVideoFrames,
    totalFrames: q === null ? null : q.totalVideoFrames,
  };
}

/** Bytes in binary units: `0 B`, `1.00 KiB`, `12.3 MiB`. */
export function formatByteCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '–';
  if (n < 1024) return `${String(Math.round(n))} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'] as const;
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i] ?? 'TiB'}`;
}

const PRINTABLE = /[^\x20-\x7e]/g;

/** A network-chosen string, as the panel shows it: printable ASCII, at most `max` characters. */
export function printable(raw: string, max: number): string {
  return raw.replace(PRINTABLE, '?').slice(0, max);
}

const HEX64 = /^[0-9a-f]{64}$/;

/** A source's id as the panel shows it: a key cut to 8 hex, an origin's host whole (≤ 64). */
export function shortSourceId(s: Pick<PlaySourceStat, 'kind' | 'id'>): string {
  if (s.kind === 'origin') return printable(s.id, 64);
  return HEX64.test(s.id) ? s.id.slice(0, 8) : printable(s.id, 20);
}

const KIND_NAMES: Readonly<Record<PlaySourceStat['kind'], string>> = {
  origin: 'HTTPS origin',
  webrtc: 'WebRTC peer',
  iroh: 'iroh seeder',
  hyperdht: 'HyperDHT seeder',
  hypercore: 'Hypercore seeder',
};

/** One row of the sources table, as text. */
export interface NerdSourceRow {
  /** The full id, for joining addresses; never shown. */
  readonly key: string;
  readonly kind: PlaySourceStat['kind'];
  readonly source: string;
  readonly id: string;
  readonly via: string;
  readonly down: string;
  readonly up: string;
  readonly files: string;
  readonly connected: boolean;
}

export function sourceRows(sources: readonly PlaySourceStat[]): NerdSourceRow[] {
  return sources.map((s) => ({
    key: s.id,
    kind: s.kind,
    source:
      s.label !== undefined && s.label !== ''
        ? `${KIND_NAMES[s.kind]} (${printable(s.label, 24)})`
        : KIND_NAMES[s.kind],
    id: shortSourceId(s),
    via: s.via === '' ? '–' : printable(s.via, 64),
    down: formatByteCount(s.bytesDown),
    up: formatByteCount(s.bytesUp),
    files: String(s.files),
    connected: s.connected,
  }));
}

/** The paid path's seeders (`PlaySession.onPeers`): blocks and sats, no byte counts. */
export function peerSpendRows(peers: readonly PeerSpend[]): NerdSourceRow[] {
  return [...peers]
    .sort((a, b) => b.blocks - a.blocks)
    .map((p) => ({
      key: p.pubkey,
      kind: 'hypercore' as const,
      source: KIND_NAMES.hypercore,
      id: shortSourceId({ kind: 'hypercore', id: p.pubkey }),
      via: 'Hyperswarm',
      down: `${String(p.blocks)} blocks`,
      up: '–',
      files: `${String(p.sats)} sats`,
      connected: true,
    }));
}

/** The key/value rows above the sources table. */
export function statRows(
  stats: NfxPlayStats | null,
  sample: ElementSample | null,
  extra: { readonly rendition?: string | undefined } = {},
): [string, string][] {
  const rows: [string, string][] = [];
  if (stats?.engine !== undefined) rows.push(['Engine', printable(stats.engine, 120)]);
  if (extra.rendition !== undefined) rows.push(['Rendition', extra.rendition]);
  if (sample !== null) {
    rows.push([
      'Resolution',
      sample.width > 0 ? `${String(sample.width)}x${String(sample.height)}` : '–',
    ]);
    rows.push(['Buffer health', `${sample.bufferAheadSec.toFixed(1)} s`]);
    rows.push([
      'Dropped frames',
      sample.droppedFrames === null
        ? '–'
        : `${String(sample.droppedFrames)} of ${String(sample.totalFrames ?? 0)}`,
    ]);
  }
  if (stats === null) return rows;
  if (stats.bandwidthEstimate !== undefined && stats.bandwidthEstimate > 0) {
    rows.push(['Bandwidth estimate', `${(stats.bandwidthEstimate / 1e6).toFixed(2)} Mb/s`]);
  }
  const down = stats.sources.reduce((n, s) => n + s.bytesDown, 0);
  const fromPeers = stats.sources
    .filter((s) => s.kind !== 'origin')
    .reduce((n, s) => n + s.bytesDown, 0);
  const up = stats.sources.reduce((n, s) => n + s.bytesUp, 0);
  rows.push([
    'From peers',
    down > 0
      ? `${String(Math.round((fromPeers / down) * 100))}% (${formatByteCount(fromPeers)} of ${formatByteCount(down)})`
      : '–',
  ]);
  if (up > 0) rows.push(['Uploaded', formatByteCount(up)]);
  if (stats.peers !== undefined) {
    rows.push([
      'Peers',
      `${String(stats.peers.connected)} connected, ${String(stats.peers.total)} since start`,
    ]);
  }
  if (stats.signaling !== undefined) {
    const sig = stats.signaling;
    const where = sig.endpoints.map((e) => printable(e, 64)).join(', ');
    rows.push([
      'Signaling',
      sig.kind === 'nostr'
        ? `Nostr${sig.open !== undefined ? `, ${String(sig.open)} of ${String(sig.endpoints.length)} relays open` : ''}: ${where}`
        : `trackers: ${where}`,
    ]);
  }
  if (stats.verified !== undefined) {
    rows.push([
      'Verified files',
      `${String(stats.verified)}${stats.refused !== undefined && stats.refused > 0 ? `, ${String(stats.refused)} refused` : ''}`,
    ]);
  }
  return rows;
}

/** An address cell. Hidden ones say so; nothing is guessed. */
export function addressText(a: PlaySourceAddress | undefined): string {
  if (a === undefined) return '–';
  if (a.address === '') return 'hidden';
  return printable(a.address, 64);
}

/** A path cell: direct or relayed (through whom), the transport's detail, the round trip. */
export function pathText(a: PlaySourceAddress | undefined): string {
  if (a === undefined || a.path === 'unknown') return '–';
  const parts: string[] = [];
  if (a.detail !== undefined && a.detail !== '') parts.push(printable(a.detail, 24));
  if (a.rttMs !== undefined) parts.push(`${String(a.rttMs)} ms`);
  const via = a.path === 'relayed' && a.via !== undefined ? ` via ${printable(a.via, 64)}` : '';
  return `${a.path}${via}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
}

/**
 * What Copy puts on the clipboard: the rows and the sources by their short ids, and the
 * addresses only while they are shown. Never a full key, a media URL or a token.
 */
export function copyText(
  rows: readonly (readonly [string, string])[],
  sources: readonly NerdSourceRow[],
  addresses: ReadonlyMap<string, PlaySourceAddress> | null,
): string {
  return JSON.stringify(
    {
      stats: Object.fromEntries(rows),
      sources: sources.map((s) => {
        const base = {
          source: s.source,
          id: s.id,
          via: s.via,
          down: s.down,
          up: s.up,
          files: s.files,
          connected: s.connected,
        };
        if (addresses === null) return base;
        const a = addresses.get(s.key);
        return { ...base, address: addressText(a), path: pathText(a) };
      }),
    },
    null,
    2,
  );
}
