/**
 * NFX-12 §4 flow control for one connection: every `nfx/files/1` frame of every channel on the
 * connection goes through one pump, one frame at a time. A frame is written only while the
 * stream is not asking for a drain; after a write that returns `false`, nothing more is written
 * until `'drain'` (streamx: the buffer has emptied). So at most one frame is ever written on top
 * of a buffer below the stream's high-water mark (16 KiB): ≤ 16 KiB + 64 KiB + 4 B ahead of the
 * transport, inside the 256 KiB cap, and a pay/1 message (written directly, never through the
 * pump) waits behind no more than that.
 *
 * Waiting transfers are served in arrival order, so concurrent requests interleave frame by
 * frame instead of one file starving the rest.
 */
import { nfx } from '@sovit/core';

/** What the pump needs from the connection's stream. */
export interface DrainSource {
  on(event: 'drain' | 'close', cb: () => void): unknown;
  off(event: 'drain' | 'close', cb: () => void): unknown;
}

/** One frame's worth of the cap: 64 KiB of payload plus the 4-byte `req`. */
const MAX_FRAME_BYTES = nfx.MAX_DATA_PAYLOAD + 4;
/** streamx's default high-water mark; secret-stream does not change it. */
const STREAM_HIGH_WATER_MARK = 16_384;

// The bound in the header holds by construction; keep it true if either constant moves.
if (STREAM_HIGH_WATER_MARK + MAX_FRAME_BYTES > nfx.MAX_QUEUED_FILE_BYTES) {
  throw new Error('nfx pump: a frame on a full buffer would exceed the 256 KiB queue cap');
}

export interface PumpStats {
  /** Frames written. */
  readonly frames: number;
  /** Bytes written. */
  readonly bytes: number;
  /** Writes that left the stream asking for a drain. */
  readonly stalls: number;
  /**
   * The most bytes that can have been queued ahead of the transport at once, as an upper
   * bound: a write that returned `true` leaves under 16 KiB buffered, a drain leaves none.
   */
  readonly maxQueuedBytes: number;
}

export class FilePump {
  private blocked = false;
  private closed = false;
  /** One turn is out at a time: the holder writes, then `sent` or `skip` hands it on. */
  private turnTaken = false;
  private readonly waiters: ((open: boolean) => void)[] = [];
  private frames = 0;
  private bytes = 0;
  private stalls = 0;
  /** Upper bound on the bytes buffered in the stream now. */
  private queued = 0;
  private maxQueued = 0;

  private readonly onDrain = (): void => {
    this.blocked = false;
    this.queued = 0;
    this.release();
  };

  private readonly onClose = (): void => {
    this.close();
  };

  constructor(private readonly stream: DrainSource) {
    stream.on('drain', this.onDrain);
    stream.on('close', this.onClose);
  }

  /**
   * Resolves `true` when the caller may write one frame now (synchronously, then `sent`), or
   * `false` once the connection is closed: the caller stops.
   */
  turn(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.release();
    });
  }

  /** Record a frame of `byteLength` written in this turn and whether the stream took it without a drain. */
  sent(byteLength: number, drained: boolean): void {
    this.frames++;
    this.bytes += byteLength;
    this.queued += byteLength;
    if (drained) {
      // streamx accepted it below its high-water mark: less than that is buffered now.
      this.queued = Math.min(this.queued, STREAM_HIGH_WATER_MARK - 1);
    } else {
      this.stalls++;
      this.blocked = true;
    }
    if (this.queued > this.maxQueued) this.maxQueued = this.queued;
    this.turnTaken = false;
    this.release();
  }

  /** Give the turn back without writing (the transfer ended or failed). */
  skip(): void {
    this.turnTaken = false;
    this.release();
  }

  get stats(): PumpStats {
    return {
      frames: this.frames,
      bytes: this.bytes,
      stalls: this.stalls,
      maxQueuedBytes: this.maxQueued,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream.off('drain', this.onDrain);
    this.stream.off('close', this.onClose);
    for (const w of this.waiters.splice(0)) w(false);
  }

  private release(): void {
    if (this.closed || this.blocked || this.turnTaken) return;
    const next = this.waiters.shift();
    if (next === undefined) return;
    this.turnTaken = true;
    next(true);
  }
}
