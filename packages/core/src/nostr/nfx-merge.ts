/**
 * Pages of one query from different relay groups, merged into one (ADR 0026): the scoped and the
 * read relays in `NfxCatalog`, the NIP-50 and the scanned relays in `searchNfxVideosRouted`.
 */
import type { NfxVideo, Page } from '../contracts/index.js';
import { decodeTimeCursor, timeCursor } from './cursor.js';
import { byNewest } from './event.js';

/**
 * Pages of one query from different relay sets, as one page: one video per address, the newest
 * revision winning and, at the same `created_at`, the earlier page's copy (callers pass the scoped
 * relays' page first, so the network's own copy wins a tie); newest first, at most `limit`;
 * `withdrawn` revisions are left out, and `dropped` counts what was left out for them or for
 * `floor`.
 *
 * **The cursor never passes a set's unread videos, and never repeats.** A page with `next` was read
 * only down to its cursor's `until` (a full page's oldest video, or how far a search scan read,
 * even with no match), so nothing older than the newest such floor is listed here. Without a
 * withdrawal that cuts nothing (a full page alone fills `limit` above its own floor); with one, the
 * page comes out short. A full page's cursor is its last video's second; a short one's is the
 * floor, since everything above it was listed or withdrawn. Either way the cursor skips, at that
 * second, every id the page accounts for: listed, withdrawn, or a revision a listed one replaced,
 * plus the incoming `cursor`'s own at the same second and, on a short page (where `limit` cut
 * nothing), the sets' own cursors' there. So the next page starts where this one ended, and an
 * empty one still moves on.
 */
export function mergeNfxPages(
  pages: readonly Page<NfxVideo>[],
  limit: number,
  withdrawn: ReadonlySet<string> = new Set(),
  cursor?: string,
): { readonly page: Page<NfxVideo>; readonly dropped: number } {
  let floor: number | undefined;
  for (const p of pages) {
    if (p.next === undefined) continue;
    const at =
      decodeTimeCursor(p.next)?.until ??
      (p.items.length === 0 ? undefined : Math.min(...p.items.map((v) => v.event.created_at)));
    if (at !== undefined && (floor === undefined || at > floor)) floor = at;
  }
  const newest = new Map<string, NfxVideo>();
  let dropped = 0;
  for (const v of pages.flatMap((p) => p.items)) {
    if (withdrawn.has(v.eventId)) {
      dropped++;
      continue;
    }
    const seen = newest.get(v.id);
    if (seen === undefined || v.event.created_at > seen.event.created_at) newest.set(v.id, v);
  }
  const unique = [...newest.values()].sort((a, b) => byNewest(a.event, b.event));
  const cut = floor;
  const all = cut === undefined ? unique : unique.filter((v) => v.event.created_at >= cut);
  dropped += unique.length - all.length;
  const items = all.slice(0, limit);
  if (all.length <= limit && pages.every((p) => p.next === undefined)) {
    return { page: { items }, dropped };
  }
  const short = items.length < limit;
  const until = short && floor !== undefined ? floor : items.at(-1)?.event.created_at;
  if (until === undefined) {
    // Only a set whose cursor is not a time cursor has more: carry on from it, as before.
    const next = pages.find((p) => p.next !== undefined)?.next;
    return { page: next === undefined ? { items } : { items, next }, dropped };
  }
  const listed = new Set(items.map((v) => v.id));
  const skip = new Set<string>();
  for (const v of pages.flatMap((p) => p.items)) {
    if (v.event.created_at === until && (withdrawn.has(v.eventId) || listed.has(v.id))) {
      skip.add(v.eventId);
    }
  }
  for (const c of [cursor, ...(short ? pages.map((p) => p.next) : [])]) {
    const t = decodeTimeCursor(c);
    if (t?.until === until) for (const id of t.seen) skip.add(id);
  }
  return { page: { items, next: timeCursor(until, skip) }, dropped };
}
