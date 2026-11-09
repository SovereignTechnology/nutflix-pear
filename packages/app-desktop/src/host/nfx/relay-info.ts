/**
 * The host's NIP-11 request (ADR 0022): what core's `RelaySearchSupport` asks to learn whether a
 * relay answers NIP-50 search, so `search` goes only to relays that list it.
 *
 * Only the user's own relays are asked (their read relays and the NFX network's scoped relays),
 * the hosts this app already holds WebSockets to, so a private address is allowed here as it is
 * for those (a relay on the LAN or a tailnet is a legitimate setup). The request is bounded the
 * way the host's other HTTP is: one GET, no redirect followed (a 3xx is an error), no cookies and
 * no User-Agent, `identity` encoding, at most `NIP11_MAX_BYTES`, and a whole-request timeout.
 * Nothing here logs.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

import type { nostr } from '@sovit/core';

/** The most a NIP-11 document may be (a real one is a few hundred bytes). */
export const NIP11_MAX_BYTES = 64 * 1024;
/** Connect to last byte, ms. */
export const NIP11_TIMEOUT_MS = 5_000;

export interface HostRelayInfoOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/** `RelayInfoFetch` over `node:http(s)`: resolves to the parsed document, rejects otherwise. */
export function hostRelayInfoFetch(opts: HostRelayInfoOptions = {}): nostr.RelayInfoFetch {
  const timeoutMs = opts.timeoutMs ?? NIP11_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? NIP11_MAX_BYTES;
  return (raw) =>
    new Promise<unknown>((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        reject(new Error('NIP-11: not a URL'));
        return;
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        reject(new Error('NIP-11: not http(s)'));
        return;
      }
      if (url.username !== '' || url.password !== '') {
        reject(new Error('NIP-11: credentials in the URL'));
        return;
      }
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(url, {
        method: 'GET',
        agent: false,
        headers: { accept: 'application/nostr+json', 'accept-encoding': 'identity' },
        timeout: timeoutMs,
      });
      // `fail` runs only from the events below, all after `timer` is set.
      const fail = (e: Error): void => {
        clearTimeout(timer);
        req.destroy();
        reject(e);
      };
      const timer = setTimeout(() => {
        fail(new Error('NIP-11: timed out'));
      }, timeoutMs);
      req.on('timeout', () => {
        fail(new Error('NIP-11: timed out'));
      });
      req.on('error', (e) => {
        fail(e);
      });
      req.on('response', (res: IncomingMessage) => {
        if (res.statusCode !== 200) {
          res.resume();
          fail(new Error(`NIP-11: HTTP ${String(res.statusCode)}`));
          return;
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isSafeInteger(declared) && declared > maxBytes) {
          res.destroy();
          fail(new Error('NIP-11: too large'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            fail(new Error('NIP-11: too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (e) => {
          fail(e);
        });
        res.on('end', () => {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
          } catch {
            reject(new Error('NIP-11: not JSON'));
          }
        });
      });
      req.end();
    });
}
