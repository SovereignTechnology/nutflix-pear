/**
 * The host's NIP-11 request (ADR 0022): one bounded GET with `Accept: application/nostr+json`,
 * no redirect followed, no User-Agent, a size cap and a timeout; core's `RelaySearchSupport` reads
 * the answer. Against a real HTTP server on loopback.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { RelayUrl } from '@sovit/core';
import { nostr } from '@sovit/core';

import { hostRelayInfoFetch } from '../nfx/relay-info.js';

let server: Server | undefined;
afterEach(async () => {
  const s = server;
  server = undefined;
  if (s === undefined) return;
  s.closeAllConnections();
  await new Promise((r) => s.close(r));
});

async function serve(
  handler: Parameters<typeof createServer>[1],
): Promise<{ readonly base: string; readonly seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  server = createServer((req, res) => {
    seen.push(req.headers);
    handler?.(req, res);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${String(port)}`, seen };
}

describe('hostRelayInfoFetch', () => {
  it('asks for the NIP-11 document, without a User-Agent, and parses it', async () => {
    const { base, seen } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/nostr+json' });
      res.end(JSON.stringify({ name: 'relay', supported_nips: [1, 11, 50] }));
    });
    await expect(hostRelayInfoFetch()(base)).resolves.toEqual({
      name: 'relay',
      supported_nips: [1, 11, 50],
    });
    expect(seen[0]?.accept).toBe('application/nostr+json');
    expect(seen[0]?.['user-agent']).toBeUndefined();
    expect(seen[0]?.cookie).toBeUndefined();
  });

  it('refuses a redirect, an error status, a body that is not JSON, and one over the cap', async () => {
    const { base } = await serve((req, res) => {
      if (req.url === '/moved') {
        res.writeHead(301, { location: 'https://elsewhere.example/' });
        res.end();
      } else if (req.url === '/gone') {
        res.writeHead(404);
        res.end();
      } else if (req.url === '/html') {
        res.writeHead(200);
        res.end('<html></html>');
      } else {
        res.writeHead(200);
        res.end(JSON.stringify({ pad: 'x'.repeat(2048) }));
      }
    });
    const f = hostRelayInfoFetch({ maxBytes: 1024 });
    await expect(f(`${base}/moved`)).rejects.toThrow(/HTTP 301/);
    await expect(f(`${base}/gone`)).rejects.toThrow(/HTTP 404/);
    await expect(f(`${base}/html`)).rejects.toThrow(/not JSON/);
    await expect(f(`${base}/big`)).rejects.toThrow(/too large/);
    await expect(f('ftp://127.0.0.1/')).rejects.toThrow(/not http/);
    await expect(f('http://u:p@127.0.0.1/')).rejects.toThrow(/credentials/);
  });

  it('gives up after its timeout', async () => {
    const { base } = await serve(() => undefined);
    await expect(hostRelayInfoFetch({ timeoutMs: 100 })(base)).rejects.toThrow(/timed out/);
  });

  it("drives core's RelaySearchSupport: a relay that lists NIP-50 searches, another does not", async () => {
    const { base } = await serve((req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ supported_nips: req.url === '/search' ? [1, 50] : [1] }));
    });
    const ws = base.replace(/^http:/, 'ws:');
    const support = new nostr.RelaySearchSupport(hostRelayInfoFetch());
    expect(await support.supports(`${ws}/search` as RelayUrl)).toBe(true);
    expect(await support.supports(`${ws}/plain` as RelayUrl)).toBe(false);
  });
});
