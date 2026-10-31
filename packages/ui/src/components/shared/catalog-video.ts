/**
 * Contracts v9 (ADR 0020): a listing holds NIP-71 videos and free NFX ones. These narrow it, so
 * nothing that prices, plays, reacts or stores by event id is handed an NFX video.
 */
import type { CatalogVideo, NfxAddress, NfxVideo, VideoId, VideoManifest } from '@sovit/core';

export function isNfxVideo(v: CatalogVideo): v is NfxVideo {
  return v.kind === 38504;
}

export function isNip71Video(v: CatalogVideo): v is VideoManifest {
  return v.kind !== 38504;
}

/** An NFX address starts with its kind (`38504:`); a NIP-71 event id is 64 hex, never a colon. */
export function isNfxAddress(id: VideoId): id is NfxAddress {
  return id.startsWith('38504:');
}

/** The NIP-71 videos of a listing, in order. */
export function nip71Only(items: readonly CatalogVideo[]): VideoManifest[] {
  return items.filter(isNip71Video);
}
