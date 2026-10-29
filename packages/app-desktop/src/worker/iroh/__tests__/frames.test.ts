/**
 * The helper's stdio frames (crates/iroh-helper/README.md): bounded, fatal on anything bad, and
 * holding at most one partial frame (nfx ADR 0103, sharp edge 2).
 */
import { describe, expect, it } from 'vitest';

import {
  HelperFrameDecoder,
  HelperFrameError,
  KIND_CTL,
  KIND_DATA,
  MAX_FRAME,
  MAX_PAYLOAD,
  encodeCtl,
  encodeData,
} from '../frames.js';
import type { HelperFrame } from '../frames.js';

function decodeAll(bytes: Uint8Array, step = bytes.length): HelperFrame[] {
  const out: HelperFrame[] = [];
  const d = new HelperFrameDecoder((f) => out.push(f));
  for (let i = 0; i < bytes.length; i += step) d.push(bytes.subarray(i, i + step));
  d.end();
  return out;
}

function header(len: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, len, false);
  return b;
}

function joined(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function code(f: () => void): string | undefined {
  try {
    f();
  } catch (e) {
    return e instanceof HelperFrameError ? e.code : 'other';
  }
  return undefined;
}

describe('helper frames', () => {
  it('round-trips control and data frames over any chunking', () => {
    const wire = joined(
      encodeCtl({ id: 1, op: 'addr' }),
      encodeData(7, new Uint8Array([1, 2, 3])),
      encodeCtl({ id: 7, ok: true, size: 3 }),
    );
    for (const step of [1, 3, 5, wire.length]) {
      const frames = decodeAll(wire, step);
      expect(frames).toEqual([
        { kind: 'ctl', msg: { id: 1, op: 'addr' } },
        { kind: 'data', id: 7, bytes: new Uint8Array([1, 2, 3]) },
        { kind: 'ctl', msg: { id: 7, ok: true, size: 3 } },
      ]);
    }
  });

  it('refuses an oversize length from its header alone, before buffering any body', () => {
    const d = new HelperFrameDecoder(() => undefined);
    expect(
      code(() => {
        d.push(header(MAX_FRAME + 1));
      }),
    ).toBe('frame-too-large');
    expect(d.pendingBytes).toBe(0);
    // Failed for good: nothing after a bad frame is trusted.
    expect(
      code(() => {
        d.push(encodeCtl({ id: 1 }));
      }),
    ).toBe('frame-too-large');
    expect(
      code(() => {
        new HelperFrameDecoder(() => undefined).push(header(0xffff_ffff));
      }),
    ).toBe('frame-too-large');
  });

  it('passes the largest frames and refuses one byte more', () => {
    const big = new Uint8Array(MAX_PAYLOAD).fill(9);
    const frame = encodeData(2, big);
    expect(frame.length).toBe(4 + MAX_FRAME);
    expect(decodeAll(frame)).toEqual([{ kind: 'data', id: 2, bytes: big }]);
    expect(() => encodeData(2, new Uint8Array(MAX_PAYLOAD + 1))).toThrow(HelperFrameError);
    expect(() => encodeCtl({ s: 'x'.repeat(MAX_PAYLOAD) })).toThrow(HelperFrameError);
  });

  it('refuses empty, unknown, non-object and truncated frames', () => {
    const one = (bytes: Uint8Array): string | undefined => code(() => decodeAll(bytes));
    expect(one(header(0))).toBe('frame-empty');
    expect(one(joined(header(1), new Uint8Array([KIND_CTL])))).toBe('frame-empty');
    expect(one(joined(header(5), new Uint8Array([KIND_DATA, 0, 0, 0, 1])))).toBe('frame-empty');
    expect(one(joined(header(2), new Uint8Array([9, 0])))).toBe('unknown-kind');
    expect(one(joined(header(3), new Uint8Array([KIND_CTL, 0x5b, 0x5d])))).toBe('not-an-object');
    expect(one(joined(header(2), new Uint8Array([KIND_CTL, 0x7b])))).toBe('invalid-json');
    expect(one(joined(header(3), new Uint8Array([KIND_CTL, 0xc3, 0x28])))).toBe('invalid-json');
    expect(one(joined(header(9), new Uint8Array([KIND_CTL, 0x7b])))).toBe('truncated');
    expect(one(new Uint8Array([0, 0]))).toBe('truncated');
  });

  it('holds at most one partial frame plus the chunk being pushed', () => {
    const frames: Uint8Array[] = [];
    for (let i = 1; i <= 8; i += 1) frames.push(encodeData(i, new Uint8Array(MAX_PAYLOAD).fill(i)));
    const wire = joined(...frames);
    const d = new HelperFrameDecoder(() => undefined);
    const step = 4096;
    let most = 0;
    for (let i = 0; i < wire.length; i += step) {
      d.push(wire.subarray(i, i + step));
      most = Math.max(most, d.pendingBytes);
    }
    expect(most).toBeLessThanOrEqual(4 + MAX_FRAME + step);
    d.end();
  });

  it('copies data out of the chunk it arrived in', () => {
    const wire = encodeData(3, new Uint8Array([5, 6]));
    const out: HelperFrame[] = [];
    new HelperFrameDecoder((f) => out.push(f)).push(wire);
    wire.fill(0);
    expect(out[0]).toEqual({ kind: 'data', id: 3, bytes: new Uint8Array([5, 6]) });
  });
});
