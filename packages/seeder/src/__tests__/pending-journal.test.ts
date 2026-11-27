/**
 * The runtime-neutral pending-PAY journal (`PendingJournalCore`), shared by the daemon and the
 * desktop worker: only changes are appended, it compacts itself, and it replays to what it holds.
 */
import type { payment } from '@sovit/core';
import { describe, expect, it } from 'vitest';

import {
  JOURNAL_COMPACT_FACTOR,
  JournalReadError,
  PendingJournalCore,
  journalText,
  replayJournal,
} from '../payment/pending-journal.js';

type PendingPay = payment.PendingPay;

function pay(n: number, stage: PendingPay['stage'] = 'redeem'): PendingPay {
  return {
    peer: 'ab'.repeat(32),
    stage,
    msg: {
      range: { core: 'cd'.repeat(32), fromBlock: n * 4, toBlock: n * 4 + 3 },
      seederProofs: { proofs: [{ secret: `s${String(n)}` }] },
      creatorProofs: { proofs: [{ secret: `c${String(n)}` }] },
    },
  } as unknown as PendingPay;
}

function memory() {
  let disk = '';
  const io = {
    append: (t: string) => {
      disk += t;
    },
    rewrite: (t: string) => {
      disk = t;
    },
  };
  return { io, disk: () => disk };
}

/**
 * A disk that can fail. A failed append still leaves half of its text behind (a torn write, as a
 * full disk does); a failed rewrite leaves the old file standing (it is atomic).
 */
function flaky() {
  let disk = '';
  let appendsToFail = 0;
  let rewritesToFail = 0;
  const io = {
    append: (t: string) => {
      if (appendsToFail > 0) {
        appendsToFail--;
        disk += t.slice(0, Math.floor(t.length / 2));
        throw new Error('ENOSPC');
      }
      disk += t;
    },
    rewrite: (t: string) => {
      if (rewritesToFail > 0) {
        rewritesToFail--;
        throw new Error('ENOSPC');
      }
      disk = t;
    },
  };
  return {
    io,
    disk: () => disk,
    failAppends: (n: number) => {
      appendsToFail = n;
    },
    failRewrites: (n: number) => {
      rewritesToFail = n;
    },
  };
}

const blocks = (text: string): number[] => replayJournal(text).map((p) => p.msg.range.fromBlock);

describe('PendingJournalCore', () => {
  it('appends only what changed, and replays to the live queue', () => {
    const m = memory();
    const j = new PendingJournalCore(m.io, []);
    j.compact();
    j.persist([pay(1), pay(2)]);
    j.persist([pay(2), pay(3)]); // 1 gone, 3 added: two lines, not a rewrite
    expect(m.disk().trim().split('\n')).toHaveLength(1 + 2 + 2);
    expect(replayJournal(m.disk()).map((p) => p.msg.range.fromBlock)).toEqual([8, 12]);
    j.persist([pay(2, 'nutzap'), pay(3)]); // a stage change: one removal + one addition
    expect(replayJournal(m.disk()).map((p) => p.stage)).toEqual(['redeem', 'nutzap']);
    expect(j.size).toBe(2);
  });

  it('compacts once it holds more than JOURNAL_COMPACT_FACTOR lines per live PAY', () => {
    const m = memory();
    const j = new PendingJournalCore(m.io, []);
    j.compact();
    let worst = 0;
    for (let i = 0; i < 300; i++) {
      j.persist([pay(i), pay(i + 1)]);
      worst = Math.max(worst, m.disk().trim().split('\n').length);
    }
    expect(worst).toBeLessThanOrEqual(Math.max(64, JOURNAL_COMPACT_FACTOR * 2) + 1 + 2);
    expect(m.disk().startsWith(journalText([]).trim())).toBe(true);
  });

  it('a torn last line is skipped; any other damage throws JournalReadError', () => {
    const good = journalText([pay(1)]);
    expect(replayJournal(`${good}{"a":{"pe`)).toHaveLength(1);
    expect(() => replayJournal(`${good}{"a":{"pe\n`)).toThrow(JournalReadError);
    expect(() => replayJournal('{"format":"other","v":1}\n')).toThrow(JournalReadError);
    expect(() => replayJournal('')).toThrow(JournalReadError);
  });

  // The engine swallows the hook's error and acknowledges the PAY anyway, so a write that failed
  // must be made good by the next one (nutflix-pear #169).
  it('a PAY whose append failed is written by the next call, over the torn line', () => {
    const m = flaky();
    const j = new PendingJournalCore(m.io, []);
    j.compact();
    j.persist([pay(1)]);
    m.failAppends(1);
    expect(() => {
      j.persist([pay(1), pay(2)]);
    }).toThrow('ENOSPC');
    // On disk: PAY 1 and half a line. The journal does not claim PAY 2.
    expect(m.disk().endsWith('\n')).toBe(false);
    expect(blocks(m.disk())).toEqual([4]);
    expect(j.size).toBe(1);

    j.persist([pay(1), pay(2), pay(3)]); // the next change carries PAY 2 with it
    expect(blocks(m.disk())).toEqual([4, 8, 12]);
    expect(m.disk().endsWith('\n')).toBe(true); // rewritten: no line follows the torn one
    expect(j.size).toBe(3);

    j.persist([pay(2), pay(3)]); // and appending carries on from the rewritten file
    expect(blocks(m.disk())).toEqual([8, 12]);
    expect(m.disk().trim().split('\n')).toHaveLength(1 + 3 + 1);
  });

  it('retries a failed write even when the queue has not changed since', () => {
    const m = flaky();
    const j = new PendingJournalCore(m.io, []);
    j.compact();
    m.failAppends(1);
    expect(() => {
      j.persist([pay(1)]);
    }).toThrow('ENOSPC');
    expect(blocks(m.disk())).toEqual([]);
    j.persist([pay(1)]);
    expect(blocks(m.disk())).toEqual([4]);
  });

  it('retries a failed removal: a PAY that was redeemed does not come back after a restart', () => {
    const m = flaky();
    const j = new PendingJournalCore(m.io, []);
    j.compact();
    j.persist([pay(1), pay(2)]);
    m.failAppends(1);
    expect(() => {
      j.persist([pay(2)]);
    }).toThrow('ENOSPC');
    expect(blocks(m.disk())).toEqual([4, 8]); // PAY 1's removal did not reach the disk
    j.persist([pay(2)]);
    expect(blocks(m.disk())).toEqual([8]);
  });

  it('a failed rewrite leaves the old journal standing and is retried by the next call', () => {
    const m = flaky();
    const j = new PendingJournalCore(m.io, []);
    j.compact();
    j.persist([pay(1)]);
    const before = m.disk();
    m.failAppends(1);
    expect(() => {
      j.persist([pay(1), pay(2)]);
    }).toThrow('ENOSPC');
    m.failRewrites(1);
    expect(() => {
      j.persist([pay(1), pay(2)]);
    }).toThrow('ENOSPC');
    expect(m.disk().startsWith(before)).toBe(true); // the retry failed too: nothing was replaced
    expect(blocks(m.disk())).toEqual([4]);
    j.persist([pay(1), pay(2)]);
    expect(blocks(m.disk())).toEqual([4, 8]);
    expect(j.size).toBe(2);
  });

  it('a compaction that fails loses nothing and is made good by the next call', () => {
    const m = flaky();
    const j = new PendingJournalCore(m.io, [pay(1)]);
    m.failRewrites(1);
    expect(() => {
      j.compact();
    }).toThrow('ENOSPC');
    expect(m.disk()).toBe('');
    j.persist([pay(1), pay(2)]);
    expect(blocks(m.disk())).toEqual([4, 8]);
  });
});
