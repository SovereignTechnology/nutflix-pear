/**
 * The per-connection pump (NFX-12 §4 flow control) against a stand-in for a streamx stream:
 * `write` returns `false` once 16 KiB are buffered, and `'drain'` fires when a buffer that
 * asked for one has emptied. The real queue never exceeds one frame on a sub-HWM buffer.
 */
import { EventEmitter } from 'node:events';

import { nfx } from '@sovit/core';
import { describe, expect, it } from 'vitest';

import { FilePump } from '../pump.js';

const HWM = 16_384;
const FRAME = nfx.MAX_DATA_PAYLOAD + 4;

class FakeStream extends EventEmitter {
  buffered = 0;
  maxBuffered = 0;
  private needDrain = false;

  write(n: number): boolean {
    this.buffered += n;
    this.maxBuffered = Math.max(this.maxBuffered, this.buffered);
    const below = this.buffered < HWM;
    if (!below) this.needDrain = true;
    return below;
  }

  /** The transport takes `n` bytes. */
  flush(n: number): void {
    this.buffered = Math.max(0, this.buffered - n);
    if (this.buffered === 0 && this.needDrain) {
      this.needDrain = false;
      this.emit('drain');
    }
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('FilePump', () => {
  it('writes one frame on a full buffer at most, and resumes on drain', async () => {
    const stream = new FakeStream();
    const pump = new FilePump(stream);
    const order: string[] = [];
    let busy = 0;
    const transfer = async (name: string, frames: number): Promise<void> => {
      for (let i = 0; i < frames; i++) {
        if (!(await pump.turn())) return;
        busy++;
        expect(busy).toBe(1); // one turn out at a time
        expect(stream.buffered).toBeLessThan(HWM); // never written on a buffer asking for a drain
        order.push(name);
        pump.sent(FRAME, stream.write(FRAME));
        busy--;
      }
    };
    const all = Promise.all([transfer('a', 6), transfer('b', 6), transfer('c', 6)]);
    for (let i = 0; i < 400 && order.length < 18; i++) {
      await tick();
      stream.flush(8_192);
    }
    await all;
    expect(order).toHaveLength(18);
    // Arrival order: the three transfers interleave instead of one draining first.
    expect(order.slice(0, 6)).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
    expect(stream.maxBuffered).toBeLessThanOrEqual(HWM - 1 + FRAME);
    expect(pump.stats.frames).toBe(18);
    expect(pump.stats.stalls).toBe(18);
    expect(pump.stats.maxQueuedBytes).toBeLessThanOrEqual(nfx.MAX_QUEUED_FILE_BYTES);
    expect(pump.stats.maxQueuedBytes).toBeGreaterThanOrEqual(stream.maxBuffered);
  });

  it('keeps writing small frames while the stream accepts them', async () => {
    const stream = new FakeStream();
    const pump = new FilePump(stream);
    for (let i = 0; i < 10; i++) {
      expect(await pump.turn()).toBe(true);
      pump.sent(100, stream.write(100));
      stream.flush(100);
    }
    expect(pump.stats.stalls).toBe(0);
    expect(pump.stats.maxQueuedBytes).toBeLessThan(HWM);
  });

  it('gives a skipped turn to the next transfer', async () => {
    const pump = new FilePump(new FakeStream());
    expect(await pump.turn()).toBe(true);
    const second = pump.turn();
    pump.skip();
    expect(await second).toBe(true);
  });

  it('answers every waiter `false` once the stream closes', async () => {
    const stream = new FakeStream();
    const pump = new FilePump(stream);
    expect(await pump.turn()).toBe(true);
    pump.sent(FRAME, stream.write(FRAME)); // blocked now
    const waiting = [pump.turn(), pump.turn()];
    stream.emit('close');
    expect(await Promise.all(waiting)).toEqual([false, false]);
    expect(await pump.turn()).toBe(false);
    expect(stream.listenerCount('drain')).toBe(0);
    expect(stream.listenerCount('close')).toBe(0);
  });
});
