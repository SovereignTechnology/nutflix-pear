/**
 * Behaviour the vectors do not pin: the codec's encoder checks, beacon and hash-list reader
 * rules that mirror serde_json, and the `bind` check outside a beacon.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_DATA_PAYLOAD,
  MAX_PAY_MESSAGE,
  decodeFilesMessage,
  decodePayMessage,
  encodeFilesMessage,
  encodePayMessage,
  parseBeaconContent,
  verifyHashList,
  VideoAddr,
} from '../index.js';
import { sha256Hex, utf8 } from '../util.js';

const SHA = new Uint8Array(32).fill(7);

describe('nfx/files/1 encoder', () => {
  it('refuses a `req` that is not a u32', () => {
    for (const req of [-1, 2 ** 32, 1.5, Number.NaN]) {
      expect(encodeFilesMessage({ type: 'end', req }).ok, String(req)).toBe(false);
    }
    expect(encodeFilesMessage({ type: 'end', req: 2 ** 32 - 1 }).ok).toBe(true);
  });

  it('refuses a `get` without a 32-byte sha and a `data` payload outside 1 to 64 KiB', () => {
    expect(encodeFilesMessage({ type: 'get', req: 1, sha: SHA.subarray(1) }).ok).toBe(false);
    for (const length of [0, MAX_DATA_PAYLOAD + 1]) {
      const payload = new Uint8Array(length);
      expect(encodeFilesMessage({ type: 'data', req: 1, payload }).ok, String(length)).toBe(false);
    }
    const full = encodeFilesMessage({ type: 'data', req: 1, payload: new Uint8Array(65_536) });
    expect(full.ok && full.value.bytes.length).toBe(4 + 65_536);
  });

  it('reads `req` from a view at an offset', () => {
    const buf = new Uint8Array(3 + 36);
    buf.set([0x2a, 0x00, 0x00, 0x01], 3);
    buf.set(SHA, 7);
    const m = decodeFilesMessage(0, buf.subarray(3));
    expect(m).toEqual({ ok: true, value: { type: 'get', req: 0x0100002a, sha: SHA } });
  });
});

describe('nfx/pay/1 codec', () => {
  it('holds the size, newline and UTF-8 rules both ways', () => {
    expect(encodePayMessage('a'.repeat(MAX_PAY_MESSAGE)).ok).toBe(true);
    expect(encodePayMessage('a'.repeat(MAX_PAY_MESSAGE + 1)).ok).toBe(false);
    expect(encodePayMessage('{"t":"hello"}\n').ok).toBe(false);
    expect(encodePayMessage('\ud800').ok).toBe(false);
    expect(decodePayMessage(0, new Uint8Array([0xc3, 0x28])).ok).toBe(false);
    expect(decodePayMessage(1, utf8('{}')).ok).toBe(false);
    // A BOM is kept, so the engine's JSON parse refuses it rather than it vanishing here.
    expect(decodePayMessage(0, new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toEqual({
      ok: true,
      value: '﻿{}',
    });
  });
});

describe('beacon content reader', () => {
  const seeder = 'ab'.repeat(32);
  const base = {
    v: 1,
    video: 'nfx:testnet:1:some-video',
    endpoints: [{ t: 'https', url: 'https://seed.example/nfx' }],
    chunks: 'all',
    price_hint: 0,
    free: true,
  };

  it('keeps the last of two equal keys, as serde_json `Value` does', () => {
    const text = JSON.stringify(base).replace('"free":true', '"free":false,"free":true');
    expect(parseBeaconContent(text, seeder).ok).toBe(true);
  });

  it('refuses a hyperdht endpoint whose bind does not verify', () => {
    const endpoint = { t: 'hyperdht', peer: 'cd'.repeat(32), bind: 'ef'.repeat(64) };
    const text = JSON.stringify({ ...base, endpoints: [endpoint] });
    expect(parseBeaconContent(text, seeder).ok).toBe(false);
  });

  it('reads `relay` as empty when it is not a string, as nfx-proto does', () => {
    const endpoint = { t: 'iroh', node: '01'.repeat(32), relay: 5 };
    const r = parseBeaconContent(JSON.stringify({ ...base, endpoints: [endpoint] }), seeder);
    expect(r.ok && r.value.endpoints[0]).toEqual({
      t: 'iroh',
      node: '01'.repeat(32),
      relay: '',
      addrs: [],
      tickets: new Map(),
    });
  });
});

describe('hash list reader (serde struct rules)', () => {
  const video = VideoAddr.parse('nfx:testnet:1:some-video');
  if (!video.ok) throw new Error('video');
  const sha = 'a'.repeat(64);
  const list = (extra: string): Uint8Array =>
    utf8(
      `{"v":1,"video":"nfx:testnet:1:some-video",${extra}"files":[` +
        `{"name":"p.m3u8","role":"playlist","sha256":"${sha}","size":1,"dur_ms":null}],` +
        `"renditions":[{"id":"r","playlist":"p.m3u8","bandwidth":1,"codecs":null}]}`,
    );
  const verify = (bytes: Uint8Array): boolean =>
    verifyHashList(bytes, sha256Hex(bytes), video.value, 1n).ok;

  it('accepts null optional fields and ignores unknown ones, repeated or not', () => {
    expect(verify(list(''))).toBe(true);
    expect(verify(list('"x":1,"x":2,'))).toBe(true);
  });

  it('refuses a repeated known field', () => {
    expect(verify(list('"v":1,'))).toBe(false);
  });

  it('refuses a float where an integer belongs', () => {
    expect(verify(utf8(new TextDecoder().decode(list('')).replace('"size":1', '"size":1.0')))).toBe(
      false,
    );
  });
});
