/**
 * NFX-18: what this worker serves from its NFX store, for the iroh and WebRTC sides. A whole
 * video (published, or seeded whole) serves every rendition. A kept one (watched or downloaded)
 * serves its meta files and the renditions it holds, and nothing while it holds none, so no
 * ticket or WebRTC table names a file the store would not hand out (`NfxStore.file`).
 */
import { nfx } from '@sovit/core';
import type { NfxKeptRecord, NfxStoreFile, NfxStoredFile, NfxVideoRecord } from '@sovit/seeder';

export interface NfxServedVideo {
  /** `<namespace>:<video-id>`, canonical. */
  readonly video: string;
  readonly root: string;
  /** The manifest `segs`, as decimal text. */
  readonly segs: string;
  /** `'all'` for a whole video, else the ids held (sorted, never empty). */
  readonly renditions: 'all' | readonly string[];
  /** Every file served, the hash list included. */
  readonly files: readonly NfxStoredFile[];
}

/** The slice of `@sovit/seeder`'s `NfxStore` the serving sides read. */
export interface NfxServingStore {
  videos(): readonly NfxVideoRecord[];
  keptVideos(): readonly NfxKeptRecord[];
  servedRenditions(video: nfx.VideoAddr): 'all' | readonly string[] | undefined;
  file(video: nfx.VideoAddr, sha: string): NfxStoreFile | undefined;
  path(video: nfx.VideoAddr, sha: string): string | undefined;
}

/** Every video served now: the whole ones, then each kept one holding a rendition. */
export function servedVideos(store: NfxServingStore): NfxServedVideo[] {
  const out: NfxServedVideo[] = store.videos().map((r) => ({
    video: r.video,
    root: r.root,
    segs: r.segs,
    renditions: 'all',
    files: r.files,
  }));
  for (const k of store.keptVideos()) {
    const video = nfx.VideoAddr.parse(k.video);
    if (!video.ok) continue;
    // The store's word, not the record's: a held file missing from disk serves nothing.
    const held = store.servedRenditions(video.value);
    if (held === undefined || held === 'all' || held.length === 0) continue;
    const files = [...k.meta, ...held.flatMap((id) => k.held[id] ?? [])];
    out.push({ video: k.video, root: k.root, segs: k.segs, renditions: held, files });
  }
  return out;
}

/** What a serving side compares to decide a video must be served again: root and renditions. */
export function servedKey(v: Pick<NfxServedVideo, 'root' | 'renditions'>): string {
  return `${v.root} ${v.renditions === 'all' ? '*' : v.renditions.join(',')}`;
}

/** Whether `served` (from `servedVideos`) includes rendition `id`. */
export function servesRendition(served: NfxServedVideo['renditions'], id: string): boolean {
  return served === 'all' || served.includes(id);
}

/** What the iroh and WebRTC sides read: the videos served, and their files. */
export interface NfxServedStore {
  served(): readonly NfxServedVideo[];
  file(video: nfx.VideoAddr, sha: string): NfxStoreFile | undefined;
  path(video: nfx.VideoAddr, sha: string): string | undefined;
}

/** `store` as the serving sides read it. */
export function servingView(store: NfxServingStore): NfxServedStore {
  return {
    served: () => servedVideos(store),
    file: (video, sha) => store.file(video, sha),
    path: (video, sha) => store.path(video, sha),
  };
}
