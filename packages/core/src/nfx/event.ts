/**
 * Nostr events as NFX uses them (nfx-proto `event.rs`): verification and strict tag lookup.
 * Verification is the package's one boundary (`nostr/event.ts`, T9): a fresh copy, then
 * nostr-tools' id and BIP-340 checks. Nothing here signs.
 */
import type { NostrEvent } from '../contracts/index.js';
import { classifyIncoming } from '../nostr/event.js';
import { fail, ok, type NfxResult } from './errors.js';

/** Kind of the addressable video manifest (NFX-02). */
export const KIND_MANIFEST = 38504;
/** Kind of the ephemeral availability beacon (NFX-03). */
export const KIND_BEACON = 20464;
/** Kind of a NIP-09 deletion request; NFX admits only manifest deletions (NFX-02 §6). */
export const KIND_DELETION = 5;
/** Largest `|now - created_at|` accepted for beacons, in seconds. */
export const MAX_CLOCK_SKEW = 15 * 60;

/** A tag's values: everything after its name, at least one. */
export type TagValues = readonly [string, ...string[]];

/**
 * Check an untrusted event's shape, id and signature. One difference from nfx-proto: the
 * boundary refuses an empty tag (`[]`), which nfx-proto skips.
 */
export function verifyEvent(raw: unknown): NfxResult<NostrEvent> {
  const checked = classifyIncoming(raw);
  if (checked.event !== null) return ok(checked.event);
  switch (checked.reason) {
    case 'bad-signature':
      return fail('signature', 'id or signature does not verify');
    case 'bad-tag':
      return fail('event', 'a tag is not a non-empty array of strings');
    case 'malformed':
      return fail('event', 'not a well-formed event');
  }
}

/** Values (everything after the name) of every tag called `name`, in order. */
export function tagValues(event: NostrEvent, name: string): (readonly string[])[] {
  return event.tags.filter((t) => t[0] === name).map((t) => t.slice(1));
}

/**
 * The single tag called `name`: `undefined` if absent, an error if it appears twice or
 * carries no value.
 */
export function singleTag(event: NostrEvent, name: string): NfxResult<TagValues | undefined> {
  const found = tagValues(event, name);
  if (found.length > 1) return fail('event', `duplicate \`${name}\` tag`);
  const [values] = found;
  if (values === undefined) return ok(undefined);
  const [first, ...rest] = values;
  if (first === undefined) return fail('event', `\`${name}\` tag has no value`);
  return ok<TagValues | undefined>([first, ...rest]);
}
