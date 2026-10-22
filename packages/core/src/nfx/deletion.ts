/**
 * NFX-02 §6 deletions: NIP-09 kind-5 requests that withdraw the author's own manifests.
 */
import { parseATag } from './beacon.js';
import { fail, ok, type NfxResult } from './errors.js';
import { KIND_DELETION, KIND_MANIFEST, tagValues, verifyEvent } from './event.js';
import type { Manifest } from './manifest.js';
import type { VideoAddr } from './namespace.js';

/** A deletion that is valid for NFX (NFX-02 §6). */
export interface Deletion {
  readonly author: string;
  readonly createdAt: number;
  /** The manifest addresses withdrawn, all the author's own. */
  readonly addresses: readonly VideoAddr[];
}

const bad = (reason: string): NfxResult<never> => fail('deletion', reason);

/**
 * Verify a kind-5 event against NFX-02 §6: a valid signature, at least one `a` tag, every `a`
 * a kind-38504 address of the author's own, and no `e` tag.
 */
export function parseDeletion(raw: unknown): NfxResult<Deletion> {
  const verified = verifyEvent(raw);
  if (!verified.ok) return verified;
  const event = verified.value;
  if (event.kind !== KIND_DELETION) return bad('a deletion is kind 5');
  if (tagValues(event, 'e').length > 0) {
    return bad('manifests are addressed; an `e` tag is not allowed');
  }
  const addresses: VideoAddr[] = [];
  for (const values of tagValues(event, 'a')) {
    const a = values[0];
    if (a === undefined) return bad('empty `a` tag');
    const target = parseATag(a);
    if (!target.ok) return bad('`a` is not a kind-38504 address');
    if (target.value.creator !== event.pubkey) {
      return bad("every `a` must be the deletion author's own address");
    }
    addresses.push(target.value.addr);
  }
  if (addresses.length === 0) return bad('at least one `a` tag is required');
  return ok({ author: event.pubkey, createdAt: event.created_at, addresses });
}

/**
 * Whether `deletion` withdraws `manifest`: same author, one of its addresses, and at least as
 * new as that revision (NIP-09). A later revision republishes the video.
 */
export function deletionDeletes(deletion: Deletion, manifest: Manifest): boolean {
  return (
    deletion.author === manifest.author &&
    deletion.createdAt >= manifest.createdAt &&
    deletion.addresses.some((addr) => addr.equals(manifest.addr))
  );
}

/** The tags of a deletion withdrawing `manifestATags` (each a `manifestATag`). */
export function deletionTags(manifestATags: readonly string[]): string[][] {
  return [...manifestATags.map((a) => ['a', a]), ['k', String(KIND_MANIFEST)]];
}
