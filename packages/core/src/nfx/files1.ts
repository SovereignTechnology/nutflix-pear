/**
 * The NFX-12 message layouts (§§4–5): `nfx/files/1` and `nfx/pay/1` on Protomux. Each message
 * is its raw bytes under a pinned type index (compact-encoding `raw`); `req` is a u32, little
 * endian. Pure byte layouts: the transport, flow control and the pay/1 session live with the
 * worker, which takes the limits below from here.
 */
import { fail, ok, type NfxResult } from './errors.js';
import { decodeUtf8, isWellFormed, utf8 } from './util.js';

export const FILES_PROTOCOL = 'nfx/files/1';
export const PAY_PROTOCOL = 'nfx/pay/1';

/** `nfx/files/1` message types by Protomux index. A new type gets a new protocol name. */
export const FILES_MESSAGE_TYPES = ['get', 'data', 'end', 'missing'] as const;
/** `nfx/pay/1` message types by Protomux index. */
export const PAY_MESSAGE_TYPES = ['msg'] as const;

/** Largest `data` payload: 64 KiB of the file per frame. */
export const MAX_DATA_PAYLOAD = 65_536;
/** Largest pay/1 message: NFX-07's 32 KiB line less its newline. */
export const MAX_PAY_MESSAGE = 32_767;
/** `nfx/files/1` bytes a sender queues ahead of the transport, per connection (§4). */
export const MAX_QUEUED_FILE_BYTES = 256 * 1024;
/** Per-connection limits (§4): videos, so channels, and open requests per free channel. */
export const MAX_VIDEOS_PER_CONNECTION = 16;
export const MAX_CHANNELS_PER_CONNECTION = 32;
export const MAX_FREE_REQUESTS_PER_CHANNEL = 8;
/** Liveness (§3): keepalive at most every 25 s, close after 60 s of silence. */
export const KEEPALIVE_INTERVAL_MS = 25_000;
export const INACTIVITY_TIMEOUT_MS = 60_000;
/** The receiver's cap on the hash list itself (§4). */
export const MAX_HASH_LIST_BYTES = 16 * 1024 * 1024;

const U32_MAX = 0xffff_ffff;
const SHA256_BYTES = 32;

export type FilesMessage =
  /** watcher → seeder: one whole file by its sha256 (32 bytes). */
  | { readonly type: 'get'; readonly req: number; readonly sha: Uint8Array }
  /** seeder → watcher: 1 to 65,536 bytes of the file, in order. */
  | { readonly type: 'data'; readonly req: number; readonly payload: Uint8Array }
  /** seeder → watcher: the file is complete. */
  | { readonly type: 'end'; readonly req: number }
  /** seeder → watcher, free mode only: not served. */
  | { readonly type: 'missing'; readonly req: number };

const bad = (reason: string): NfxResult<never> => fail('files', reason);

/** The Protomux type index and bytes of a message. */
export function encodeFilesMessage(
  message: FilesMessage,
): NfxResult<{ readonly index: number; readonly bytes: Uint8Array }> {
  if (!Number.isInteger(message.req) || message.req < 0 || message.req > U32_MAX) {
    return bad('`req` is not a u32');
  }
  let tail: Uint8Array = new Uint8Array(0);
  if (message.type === 'get') {
    if (message.sha.length !== SHA256_BYTES) return bad('`sha` is not 32 bytes');
    tail = message.sha;
  } else if (message.type === 'data') {
    if (message.payload.length < 1 || message.payload.length > MAX_DATA_PAYLOAD) {
      return bad('`data` payload is not 1 to 65,536 bytes');
    }
    tail = message.payload;
  }
  const bytes = new Uint8Array(4 + tail.length);
  new DataView(bytes.buffer).setUint32(0, message.req, true);
  bytes.set(tail, 4);
  return ok({ index: FILES_MESSAGE_TYPES.indexOf(message.type), bytes });
}

/**
 * Decode an `nfx/files/1` message received under type `index`. A wrong length or an unknown
 * index is a protocol error: the receiver closes the channel (§4). A `data` payload is a view
 * into `bytes`, not a copy.
 */
export function decodeFilesMessage(index: number, bytes: Uint8Array): NfxResult<FilesMessage> {
  const type = FILES_MESSAGE_TYPES[index];
  if (type === undefined) return bad(`unknown nfx/files/1 message type ${index}`);
  if (bytes.length < 4) return bad(`\`${type}\` is shorter than its \`req\``);
  const req = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  switch (type) {
    case 'get':
      if (bytes.length !== 4 + SHA256_BYTES) return bad('`get` is not exactly 36 bytes');
      return ok({ type, req, sha: bytes.slice(4) });
    case 'data':
      if (bytes.length < 5 || bytes.length > 4 + MAX_DATA_PAYLOAD) {
        return bad('`data` payload is not 1 to 65,536 bytes');
      }
      return ok({ type, req, payload: bytes.subarray(4) });
    case 'end':
    case 'missing':
      if (bytes.length !== 4) return bad(`\`${type}\` is not exactly 4 bytes`);
      return ok({ type, req });
  }
}

/** The bytes of one NFX-07 §2 message: UTF-8, no newline, at most 32,767 bytes (§5). */
export function encodePayMessage(text: string): NfxResult<Uint8Array> {
  if (!isWellFormed(text)) return bad('pay/1 message is not valid Unicode');
  const bytes = utf8(text);
  const reason = payMessageFault(bytes);
  return reason === undefined ? ok(bytes) : bad(reason);
}

/**
 * Decode an `nfx/pay/1` message received under type `index`, to the text the NFX-07 engine
 * parses. Its JSON and message rules are the engine's.
 */
export function decodePayMessage(index: number, bytes: Uint8Array): NfxResult<string> {
  if (index !== 0) return bad(`unknown nfx/pay/1 message type ${index}`);
  const reason = payMessageFault(bytes);
  if (reason !== undefined) return bad(reason);
  const text = decodeUtf8(bytes);
  return text === undefined ? bad('pay/1 message is not UTF-8') : ok(text);
}

function payMessageFault(bytes: Uint8Array): string | undefined {
  if (bytes.length > MAX_PAY_MESSAGE) return 'pay/1 message is over 32,767 bytes';
  if (bytes.includes(0x0a)) return 'pay/1 message contains a newline';
  return undefined;
}
