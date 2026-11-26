/**
 * `mergeNfxPages` (ADR 0026): two relay sets' pages as one, with a cursor that never passes a
 * set's unread videos and never repeats (CodeRabbit on nutflix-pear #157).
 */
import { describe, expect, it } from 'vitest';

import type { NfxVideo, Page } from '../../contracts/index.js';
import { decodeTimeCursor, timeCursor } from '../cursor.js';
import { mergeNfxPages } from '../nfx-catalog.js';

/** A listed video as the merge sees it: its address, its revision's id and second. */
const video = (address: string, id: string, at: number): NfxVideo =>
  ({ id: address, eventId: id, event: { id, created_at: at } }) as unknown as NfxVideo;

const hex = (c: string): string => c.repeat(64);

describe('mergeNfxPages', () => {
  it('an empty page with a cursor (a search scan that matched nothing) still bounds the merge', () => {
    // Scoped: a full page down to 100. Read: a scan read down to 200 and matched nothing there.
    const scoped: Page<NfxVideo> = {
      items: [video('a', hex('a'), 300), video('b', hex('b'), 100)],
      next: timeCursor(100, [hex('b')]),
    };
    const read: Page<NfxVideo> = { items: [], next: timeCursor(200, [hex('9')]) };
    const { page, dropped } = mergeNfxPages([scoped, read], 2);
    expect(page.items.map((v) => v.id)).toEqual(['a']);
    expect(dropped).toBe(1);
    // Short: the cursor is the read set's floor, so a read-relay match at 150 is still ahead.
    expect(decodeTimeCursor(page.next)?.until).toBe(200);
  });

  it('a page emptied by withdrawals keeps every id already passed at that second: no loop', () => {
    // X and Y share a second and are both withdrawn; the incoming cursor already passed X.
    const x = hex('1');
    const y = hex('2');
    const read: Page<NfxVideo> = { items: [video('y', y, 500)], next: timeCursor(500, [y]) };
    const { page } = mergeNfxPages([{ items: [] }, read], 1, new Set([y]), timeCursor(500, [x]));
    expect(page.items).toEqual([]);
    const next = decodeTimeCursor(page.next);
    expect(next?.until).toBe(500);
    expect([...(next?.seen ?? [])].sort()).toEqual([x, y].sort());
  });

  it('a full page ends at its last video, skipping only what it accounts for at that second', () => {
    // Three videos at 400 on the scoped page; limit 2 lists two of them, the third stays ahead.
    const scoped: Page<NfxVideo> = {
      items: [video('a', hex('a'), 400), video('b', hex('b'), 400), video('c', hex('c'), 400)],
      next: timeCursor(400, [hex('a'), hex('b'), hex('c')]),
    };
    const { page } = mergeNfxPages([scoped, { items: [] }], 2);
    expect(page.items.map((v) => v.id)).toEqual(['a', 'b']);
    const next = decodeTimeCursor(page.next);
    expect(next?.until).toBe(400);
    expect([...(next?.seen ?? [])].sort()).toEqual([hex('a'), hex('b')]);
  });

  it('nothing more anywhere: no cursor', () => {
    const { page } = mergeNfxPages([{ items: [video('a', hex('a'), 1)] }, { items: [] }], 5);
    expect(page).toEqual({ items: [video('a', hex('a'), 1)] });
  });
});
