/**
 * `nfx/pay/1` (NFX-12 §5) on one channel: the lane NFX-07 messages ride, and nothing more.
 * There is no payment logic here (Phase 2's engine owns sessions, quotes and tokens); the lane
 * only holds the codec's rules both ways (UTF-8, no newline, at most 32,767 bytes) and closes
 * on a message that breaks them or on a trapped unknown type.
 *
 * Its messages are written straight to the stream, never through the files pump, so a pay/1
 * message waits behind at most one `data` frame on a buffer below the stream's high-water
 * mark (`pump.ts`), which keeps NFX-12 §3's 60 s rule on any working link.
 */
import { nfx } from '@sovit/core';
import type { ProtomuxChannel, ProtomuxMessage } from 'protomux';

import type { ConnectionHost } from './connection.js';
import { addTraps } from './traps.js';

export interface PayLaneHandlers {
  /** One NFX-07 §2 message as text, for the engine to parse; reply on `lane`. */
  readonly onMessage: (text: string, lane: PayLane) => void;
  /** The lane closed: `remote` when the peer closed or rejected it. */
  readonly onClose?: (remote: boolean) => void;
  /** Told why the lane closed itself (a short reason, never message content). */
  readonly onProtocolError?: (why: string) => void;
}

export class PayLane {
  private readonly channel: ProtomuxChannel;
  private readonly msg: ProtomuxMessage;

  /** Use `NfxConnection.pay(video, …)` or the listener's `onPay`. Throws if the mux will not open it. */
  constructor(
    host: ConnectionHost,
    readonly video: nfx.VideoAddr,
    private readonly h: PayLaneHandlers,
  ) {
    const ch = host.mux.createChannel({
      protocol: nfx.PAY_PROTOCOL,
      id: video.channelId(),
      onclose: (remote) => {
        this.h.onClose?.(remote);
      },
    });
    if (ch === null) {
      throw new Error('nfx/pay/1: the channel is already open or the stream is gone');
    }
    this.channel = ch;
    // Pinned (NFX-12 §5): 0 msg.
    this.msg = ch.addMessage({
      onmessage: (bytes) => {
        this.onMessage(bytes);
      },
    });
    addTraps(ch, () => {
      this.fail('unknown nfx/pay/1 message type');
    });
    ch.open();
  }

  get closed(): boolean {
    return this.channel.closed;
  }

  /** `true` once the peer opened its side, `false` if it rejected the lane or it closed. */
  opened(): Promise<boolean> {
    return this.channel.fullyOpened();
  }

  /**
   * Send one message. `ok: false` if it breaks the codec's rules (nothing was sent);
   * `ok: true` carries the stream's `write()` result.
   */
  send(text: string): nfx.NfxResult<boolean> {
    const bytes = nfx.encodePayMessage(text);
    if (!bytes.ok) return bytes;
    if (this.channel.closed) return { ok: true, value: false };
    return { ok: true, value: this.msg.send(bytes.value) };
  }

  close(): void {
    this.channel.close();
  }

  private onMessage(bytes: Uint8Array): void {
    const text = nfx.decodePayMessage(0, bytes);
    if (!text.ok) {
      this.fail(text.error.reason);
      return;
    }
    this.h.onMessage(text.value, this);
  }

  private fail(why: string): void {
    this.h.onProtocolError?.(why);
    this.channel.close();
  }
}
