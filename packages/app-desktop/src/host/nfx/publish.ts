/**
 * Slice 4a (ADR 0020 Phase 1): the kind-38504 manifest (NFX-02) of a free upload this node
 * packaged and stored for NFX. It is built from the legacy NIP-71 event the upload published
 * first and the store's `upload.nfx` status, and the creator signs it through the same user
 * signer as the legacy event (a NIP-46 bunker asks once per upload). Beacons are not here: they
 * are true only once a transport serves the files (slice 5).
 *
 * Pure: the adapter signs and publishes. Every outcome is a value, because the legacy upload has
 * already succeeded and an NFX failure never reaches it.
 */
import type { NostrEvent, RelayUrl, VideoManifest } from '@sovit/core';
import { nfx } from '@sovit/core';

import type { NfxUploadStatusWire } from '../../ipc/worker-protocol.js';

/**
 * The NFX network this build announces on: the one the worker packages for
 * (`worker/studio/nfx.ts` `NFX_DEFAULT_NAMESPACE`; a test pins the two equal). Slice 5's settings
 * replace both. A stored video in any other namespace is refused, so a mismatch fails closed.
 */
export const NFX_PUBLISH_NAMESPACE = 'nfx:testnet:1' as const;

export type NfxStored = Extract<NfxUploadStatusWire, { state: 'stored' }>;

/** Why a stored NFX upload's manifest was not published (logged; slice 5 shows it). */
export type NfxPublishFailure =
  /** The host no longer holds the upload's legacy event (expired, evicted, or a restart). */
  | 'no-legacy-event'
  /** The stored video is not the one this upload's legacy event derives. */
  | 'address-mismatch'
  /** The legacy event's fields do not make a valid manifest. */
  | 'invalid'
  /** The connected signer is not the legacy event's author. */
  | 'not-author'
  /** The signed event is not the manifest that was built. */
  | 'did-not-verify';

/** An unsigned manifest event and the manifest it encodes. */
export interface NfxManifestDraft {
  readonly manifest: nfx.Manifest;
  readonly event: {
    readonly kind: typeof nfx.KIND_MANIFEST;
    readonly created_at: number;
    readonly tags: readonly (readonly string[])[];
    readonly content: string;
  };
}

/**
 * The manifest of `stored`, the NFX copy of `legacy`, as of `createdAt`. Free only (`license
 * open`, no `price_hint`). One tag beyond NFX-02 §3, `["e", <legacy id>]`, links it back to the
 * legacy event: the catalog de-duplicates on it, and only between events of the same author (ADR
 * 0020). nfx ignores it (NFX-02 §3: unknown tags MUST be ignored). NFX-02's Annex A links the
 * other way, with an `a` tag on a NIP-71 mirror, but the legacy event is published first and the
 * NFX address derives from its id.
 */
export function nfxManifestFor(
  legacy: VideoManifest,
  stored: NfxStored,
  createdAt: number,
): { readonly ok: true; readonly draft: NfxManifestDraft } | NfxNotPublished {
  const ns = nfx.Namespace.parse(NFX_PUBLISH_NAMESPACE);
  const expected = ns.ok ? nfx.legacyVideoAddr(ns.value, legacy.id) : undefined;
  const addr = nfx.VideoAddr.parse(stored.video);
  if (expected?.ok !== true || !addr.ok || !addr.value.equals(expected.value)) {
    return notPublished('address-mismatch');
  }
  if (!Number.isSafeInteger(legacy.publishedAt) || legacy.publishedAt < 0) {
    return notPublished('invalid');
  }
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) return notPublished('invalid');
  const duration =
    legacy.durationSec !== undefined &&
    Number.isFinite(legacy.durationSec) &&
    legacy.durationSec >= 0
      ? BigInt(Math.round(legacy.durationSec))
      : undefined;
  const manifest: nfx.Manifest = {
    author: legacy.author,
    createdAt,
    addr: addr.value,
    title: legacy.title,
    publishedAt: BigInt(legacy.publishedAt),
    root: stored.root,
    segs: BigInt(stored.segs),
    duration,
    thumb: stored.thumb,
    priceHint: undefined,
    license: { mode: 'open' },
    hashtags: legacy.tags,
    alt: undefined,
    description: legacy.description,
  };
  return {
    ok: true,
    draft: {
      manifest,
      event: {
        kind: nfx.KIND_MANIFEST,
        created_at: createdAt,
        tags: [...nfx.manifestTags(manifest), ['e', legacy.id]],
        content: manifest.description,
      },
    },
  };
}

export interface NfxNotPublished {
  readonly ok: false;
  readonly reason: NfxPublishFailure;
}

const notPublished = (reason: NfxPublishFailure): NfxNotPublished => ({ ok: false, reason });

/**
 * Whether `event`, as signed, is exactly `draft` by `author`: it verifies, parses as an NFX-02
 * manifest, and carries the built kind, time, tags and content. The adapter reports a manifest
 * published only when this holds.
 */
export function isSignedManifest(
  event: NostrEvent,
  draft: NfxManifestDraft,
  author: string,
): boolean {
  if (event.pubkey !== author || event.kind !== draft.event.kind) return false;
  if (event.created_at !== draft.event.created_at || event.content !== draft.event.content) {
    return false;
  }
  if (JSON.stringify(event.tags) !== JSON.stringify(draft.event.tags)) return false;
  const parsed = nfx.parseManifest(event);
  return parsed.ok && parsed.value.addr.equals(draft.manifest.addr);
}

/**
 * Where a manifest goes: the write relays (NFX-04 §4: manifests are mirrored to public relays)
 * and the network's scoped relays, each once.
 */
export function nfxManifestRelays(
  writeRelays: readonly RelayUrl[],
  scopedRelays: readonly RelayUrl[],
): RelayUrl[] {
  return [...new Set([...writeRelays, ...scopedRelays])];
}

/** At most this many uploads wait for their NFX packaging at once. */
export const MAX_PENDING_NFX = 16;
/** A legacy event waits this long (s) for its NFX packaging. */
export const PENDING_NFX_TTL_S = 3600;

/**
 * Legacy events of NFX uploads, by upload id, between `studio.upload` resolving and the worker's
 * `upload.nfx`. Bounded: the oldest entry goes first, and an entry expires after
 * `PENDING_NFX_TTL_S`. A restart loses it, as it loses the in-process packaging itself.
 */
export class PendingNfxUploads {
  private readonly entries = new Map<string, { legacy: VideoManifest; at: number }>();

  remember(uploadId: string, legacy: VideoManifest, now: number): void {
    this.sweep(now);
    this.entries.delete(uploadId);
    while (this.entries.size >= MAX_PENDING_NFX) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(uploadId, { legacy, at: now });
  }

  /** The upload's legacy event, once: it is forgotten as it is taken. */
  take(uploadId: string, now: number): VideoManifest | undefined {
    this.sweep(now);
    const e = this.entries.get(uploadId);
    this.entries.delete(uploadId);
    return e?.legacy;
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(now: number): void {
    for (const [id, e] of this.entries) {
      if (now - e.at >= PENDING_NFX_TTL_S) this.entries.delete(id);
    }
  }
}
