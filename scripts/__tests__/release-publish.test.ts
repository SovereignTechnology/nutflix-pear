/**
 * scripts/release-publish.mjs (ADR 0017 §8; Cameron, 2026-10-02): sign the release notice with
 * the SovTech key through a NIP-46 bunker, verify it as users will, publish to the relays.
 *
 * Signing here uses a THROWAWAY key made in this process (nostr-tools), held in memory only:
 * it is passed as `trustedPubkey` to the library entry point (the CLI never takes one). The
 * fake bunker signs with it; @sovit/core's real Nip46Signer wraps it, so its check of what
 * comes back (checkRemoteSigned) is exercised for real. Nothing here touches the network.
 */
import { writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { runNode, scriptsDir, tempDir } from './helpers.js';

interface Artifact {
  name: string;
  sha256: string;
  bytes: number;
}
interface Ev {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}
interface Result {
  relay: string;
  ok: boolean;
  message: string;
}
interface Bunker {
  getPublicKey(): Promise<string>;
  signEvent(t: Omit<Ev, 'id' | 'sig' | 'pubkey'>): Promise<unknown>;
  nip44Encrypt(): Promise<string>;
  nip44Decrypt(): Promise<string>;
  close(): Promise<void>;
}
interface PublishLib {
  RELEASE_RELAYS: readonly string[];
  CONFIRM_WORD: string;
  publishRelease(o: Record<string, unknown>): Promise<{ signed: Ev; results: Result[] }>;
  publishToRelays(relays: string[], ev: Ev, timeoutMs?: number): Promise<Result[]>;
}
interface ManifestLib {
  buildManifest(
    paths: string[],
    o: { version: string; commit?: string; createdAt: number },
  ): Promise<{ event: Ev; manifest: { artifacts: Artifact[] } }>;
}

/**
 * @sovit/core's NIP-46 adapter, loaded by name: CI lints before it builds, so core's types
 * (dist/*.d.ts) may not exist when this file is type-checked. Only `adopt` is used.
 */
interface CoreSigner {
  Nip46Signer: { adopt(b: Bunker, relays: readonly string[]): Promise<unknown> };
}
const CORE = '@sovit/core';
const coreSigner = async (): Promise<CoreSigner> =>
  ((await import(/* @vite-ignore */ CORE)) as { signer: CoreSigner }).signer;

const lib = async <T>(file: string): Promise<T> =>
  (await import(/* @vite-ignore */ join(scriptsDir, file))) as T;

const SECRET = 'one-time-bunker-secret-0123456789';
const URI = `bunker://${'ab'.repeat(32)}?relay=wss://bunker.example&secret=${SECRET}`;

let tmp: { dir: string; cleanup(): void };
let sk: Uint8Array;
let pk: string;
let template: Ev;
let calls: string[];
let lines: string[];

/** A bunker that signs with `key` (the throwaway one unless a test says otherwise). */
function bunker(key = sk, tamper?: (e: Ev) => Ev): Bunker {
  return {
    getPublicKey: () => Promise.resolve(getPublicKey(key)),
    signEvent: (t) => {
      calls.push('signEvent');
      const e = finalizeEvent(t, key) as unknown as Ev;
      return Promise.resolve(tamper ? tamper(e) : e);
    },
    nip44Encrypt: () => Promise.reject(new Error('unused')),
    nip44Decrypt: () => Promise.reject(new Error('unused')),
    close: () => {
      calls.push('close');
      return Promise.resolve();
    },
  };
}

/** The flow with every edge faked; `over` replaces any of them. */
function opts(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: template,
    dir: tmp.dir,
    trustedPubkey: pk,
    askBunkerUri: () => {
      calls.push('askBunkerUri');
      return Promise.resolve(URI);
    },
    connect: (uri: string) => {
      calls.push(`connect:${uri === URI ? 'uri' : 'other'}`);
      return Promise.resolve({ bunker: bunker(), relays: ['wss://bunker.example'] });
    },
    adopt: async (b: Bunker, relays: string[]) => (await coreSigner()).Nip46Signer.adopt(b, relays),
    confirm: () => {
      calls.push('confirm');
      return Promise.resolve(true);
    },
    publish: (relays: string[]) => {
      calls.push('publish');
      return Promise.resolve(relays.map((relay) => ({ relay, ok: true, message: '' })));
    },
    save: () => {
      calls.push('save');
      return join(tmp.dir, 'release-event.json');
    },
    log: (l: string) => lines.push(l),
    ...over,
  };
}

beforeEach(async () => {
  tmp = tempDir('nf-publish-');
  sk = generateSecretKey();
  pk = getPublicKey(sk);
  calls = [];
  lines = [];
  const files = ['nutflix_0.1.0_amd64.deb', 'Nutflix-0.1.0-x64.AppImage'].map((n, i) => {
    const p = join(tmp.dir, n);
    writeFileSync(p, `artifact ${String(i)}\n`.repeat(100 + i));
    return p;
  });
  const m = await lib<ManifestLib>('release-manifest.mjs');
  const built = await m.buildManifest(files, {
    version: '0.1.0',
    commit: 'c'.repeat(40),
    createdAt: 1_790_000_000,
  });
  template = { ...built.event, pubkey: pk };
});
afterEach(() => {
  tmp.cleanup();
});

describe('release-publish: the whole flow (fakes for the bunker, prompts and relays)', () => {
  it('signs exactly the template, verifies it against the files, then publishes to the 3 relays', async () => {
    const p = await lib<PublishLib>('release-publish.mjs');
    const published: Ev[] = [];
    const { signed, results } = await p.publishRelease(
      opts({
        publish: (relays: string[], ev: Ev) => {
          calls.push('publish');
          published.push(ev);
          return Promise.resolve(relays.map((relay) => ({ relay, ok: true, message: '' })));
        },
      }),
    );
    expect(calls).toEqual([
      'askBunkerUri',
      'connect:uri',
      'signEvent',
      'close',
      'save',
      'confirm',
      'publish',
    ]);
    expect(signed.pubkey).toBe(pk);
    expect(signed.sig).toMatch(/^[0-9a-f]{128}$/);
    expect({ ...signed, id: '', sig: '' }).toEqual(template);
    expect(published).toEqual([signed]);
    expect(results.map((r) => r.relay)).toEqual([
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.primal.net',
    ]);
    // The bunker URI and its secret are never logged.
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(lines.join('\n')).not.toContain('bunker://');
  });

  it('a file that does not match the template stops it before the bunker is asked for', async () => {
    const p = await lib<PublishLib>('release-publish.mjs');
    writeFileSync(join(tmp.dir, 'nutflix_0.1.0_amd64.deb'), 'tampered\n');
    await expect(p.publishRelease(opts())).rejects.toThrow(/nutflix_0\.1\.0_amd64\.deb: size/);
    expect(calls).toEqual([]);
  });

  it('refuses a template for another key, or one that is already half-filled, before the network', async () => {
    const p = await lib<PublishLib>('release-publish.mjs');
    await expect(
      p.publishRelease(opts({ event: { ...template, pubkey: 'f'.repeat(64) } })),
    ).rejects.toThrow(/not for the SovTech key/);
    await expect(
      p.publishRelease(opts({ event: { ...template, id: 'a'.repeat(64) } })),
    ).rejects.toThrow(/not an unsigned release template/);
    await expect(
      p.publishRelease(opts({ event: { ...template, tags: [...template.tags, ['files', '9']] } })),
    ).rejects.toThrow(/exactly one "files" tag/);
    expect(calls).toEqual([]);
  });

  it('a bunker for another key signs nothing', async () => {
    const p = await lib<PublishLib>('release-publish.mjs');
    const other = generateSecretKey();
    await expect(
      p.publishRelease(
        opts({
          connect: () =>
            Promise.resolve({ bunker: bunker(other), relays: ['wss://bunker.example'] }),
        }),
      ),
    ).rejects.toThrow(/the bunker signs for npub1.*not the SovTech key: nothing was signed/);
    expect(calls).not.toContain('signEvent');
    expect(calls).toContain('close');
    expect(calls).not.toContain('publish');
  });

  it('a bunker that returns a different event than asked is refused, and nothing is saved or sent', async () => {
    const p = await lib<PublishLib>('release-publish.mjs');
    const swapped = (e: Ev): Ev =>
      finalizeEvent(
        { kind: e.kind, created_at: e.created_at, tags: e.tags, content: `${e.content}x` },
        sk,
      );
    await expect(
      p.publishRelease(
        opts({
          connect: () =>
            Promise.resolve({ bunker: bunker(sk, swapped), relays: ['wss://bunker.example'] }),
        }),
      ),
    ).rejects.toThrow(/different event than the one requested/);
    expect(calls).not.toContain('save');
    expect(calls).not.toContain('publish');
  });

  it('nothing is published unless confirmed, nor in a dry run', async () => {
    const p = await lib<PublishLib>('release-publish.mjs');
    const no = await p.publishRelease(opts({ confirm: () => Promise.resolve(false) }));
    expect(no.results).toEqual([]);
    expect(calls).toContain('save');
    expect(calls).not.toContain('publish');
    calls = [];
    const dry = await p.publishRelease(opts({ dryRun: true }));
    expect(dry.results).toEqual([]);
    expect(calls).not.toContain('confirm');
    expect(calls).not.toContain('publish');
  });

  it('an already signed event is verified and published without a bunker', async () => {
    const p = await lib<PublishLib>('release-publish.mjs');
    const { signed } = await p.publishRelease(opts({ dryRun: true }));
    calls = [];
    await p.publishRelease(opts({ event: signed }));
    expect(calls).toEqual(['confirm', 'publish']);
    // …and a signed event whose file no longer matches is refused before publishing.
    calls = [];
    writeFileSync(join(tmp.dir, 'Nutflix-0.1.0-x64.AppImage'), 'tampered\n');
    await expect(p.publishRelease(opts({ event: signed }))).rejects.toThrow(/size/);
    expect(calls).toEqual([]);
  });

  it('reports each relay; fails when none accepted', async () => {
    const p = await lib<PublishLib>('release-publish.mjs');
    const some = await p.publishRelease(
      opts({
        publish: (relays: string[]) =>
          Promise.resolve(
            relays.map((relay, i) => ({ relay, ok: i === 1, message: i === 1 ? '' : 'blocked' })),
          ),
      }),
    );
    expect(some.results.filter((r) => r.ok)).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('FAILED'))).toHaveLength(2);
    await expect(
      p.publishRelease(
        opts({
          event: some.signed,
          publish: (relays: string[]) =>
            Promise.resolve(
              relays.map((relay) => ({ relay, ok: false, message: 'no answer in time' })),
            ),
        }),
      ),
    ).rejects.toThrow(/no relay accepted/);
  });
});

describe('release-publish: the CLI', () => {
  it('refuses bad usage before loading anything', () => {
    for (const args of [
      [],
      ['--dir', 'x'],
      ['ev.json'],
      ['ev.json', '--dir'],
      ['ev.json', '--key', 'k'],
    ]) {
      const r = runNode('release-publish.mjs', args);
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr).toMatch(/release-publish: FAILED: (usage|--dir|unknown argument)/);
    }
  });

  it('refuses to read the bunker URI without a terminal (never from argv or a pipe)', () => {
    const t = join(tmp.dir, 'release-event.unsigned.json');
    writeFileSync(t, JSON.stringify(template));
    // The template is for the throwaway key, so the CLI (pinned to SovTech) refuses it first;
    // a SovTech-keyed template with matching files would reach the prompt and refuse the pipe.
    const r = runNode('release-publish.mjs', [t, '--dir', tmp.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not for the SovTech key/);
  });

  it('refuses before the bunker when release-event.json exists already (never overwritten)', () => {
    const t = join(tmp.dir, 'release-event.unsigned.json');
    writeFileSync(t, JSON.stringify(template));
    writeFileSync(join(tmp.dir, 'release-event.json'), '{}');
    const r = runNode('release-publish.mjs', [t, '--dir', tmp.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/release-event\.json exists already/);
  });

  it('pins the SovTech key and the three relays; no option takes a key, a URI or a relay', async () => {
    const p = await lib<PublishLib>('release-publish.mjs');
    expect(p.RELEASE_RELAYS).toEqual([
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.primal.net',
    ]);
    expect(Object.isFrozen(p.RELEASE_RELAYS)).toBe(true);
    expect(p.CONFIRM_WORD).toBe('publish');
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(scriptsDir, 'release-publish.mjs'), 'utf8');
    const flags = [...src.matchAll(/rest\[i\] === '(--[a-z-]+)'/g)].map((m) => m[1]);
    // `--d` names which release notice (an allow-listed product, never a key, a URI or a relay).
    expect(flags.sort()).toEqual(['--d', '--dir', '--dry-run']);
    expect(src).toMatch(/RELEASE_D_TAGS\.includes\(d\)/);
    // The URI is read from the terminal only, and never written anywhere.
    expect(src).toMatch(/askHidden\('bunker:\/\/ URI/);
    // Every pool uses `ws`: Node 22's built-in WebSocket overflows the stack on an unreachable
    // relay under nostr-tools 2.25.2 (reproduced; see the script).
    expect(src).toContain("import WebSocket from 'ws';");
    // … through RelaySocket, `ws` with an `error` listener on every socket (a relay that never
    // finishes the handshake must not end the process).
    expect(src).toMatch(/^class RelaySocket extends WebSocket \{$/m);
    expect(src).toMatch(/^useWebSocketImplementation\(RelaySocket\);$/m);
    expect(src.match(/useWebSocketImplementation\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/process\.env\[?['.]?\w*BUNKER/i);
  });
});

// The one piece that talks to relays, against three local ones (`ws`, already a workspace
// dependency): one accepts, one refuses, one never answers. Loopback only.
describe('release-publish: publishToRelays', () => {
  it('reports accepted, refused and silent relays, each with its own answer', async () => {
    const p = await lib<PublishLib>('release-publish.mjs');
    const seen: unknown[] = [];
    const relay = (answer: (id: string) => unknown[] | null): Promise<WebSocketServer> =>
      new Promise((resolve) => {
        const s = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => {
          resolve(s);
        });
        s.on('connection', (ws) => {
          ws.on('message', (data: Buffer) => {
            const msg = JSON.parse(data.toString('utf8')) as [string, Ev];
            if (msg[0] !== 'EVENT') return;
            seen.push(msg[1]);
            const out = answer(msg[1].id);
            if (out !== null) ws.send(JSON.stringify(out));
          });
        });
      });
    const servers = await Promise.all([
      relay((id) => ['OK', id, true, '']),
      relay((id) => ['OK', id, false, 'blocked: not on the list']),
      relay(() => null),
    ]);
    try {
      const urls = servers.map((s) => {
        const a = s.address();
        return `ws://127.0.0.1:${String(a !== null && typeof a === 'object' ? a.port : 0)}`;
      });
      const ev = finalizeEvent(
        {
          kind: template.kind,
          created_at: template.created_at,
          tags: template.tags,
          content: template.content,
        },
        sk,
      ) as unknown as Ev;
      const results = await p.publishToRelays(urls, ev, 800);
      expect(results.map((r) => [r.relay, r.ok])).toEqual([
        [urls[0], true],
        [urls[1], false],
        [urls[2], false],
      ]);
      expect(results[1]?.message).toMatch(/blocked: not on the list/);
      expect(results[2]?.message).toMatch(/no answer in time/);
      expect(seen).toHaveLength(3);
      // What crossed the wire is the event's JSON (nostr-tools' verifiedSymbol flag stays behind).
      for (const e of seen) expect(e).toEqual(JSON.parse(JSON.stringify(ev)));
    } finally {
      for (const s of servers) {
        for (const c of s.clients) c.terminate();
        s.close();
      }
    }
  });

  // A relay that is down behind a live TCP endpoint (relay.primal.net, 2026-10-05): the
  // connection is accepted and the handshake never finishes. nostr-tools gives up and closes the
  // socket still connecting, and `ws` then emits an `error` that nothing listened for: the
  // script died mid-publish, with no relay reported. The run of this test fails with that
  // uncaught error unless every socket has a listener.
  it('a relay that never finishes the handshake is reported, and does not end the process', async () => {
    const p = await lib<PublishLib>('release-publish.mjs');
    const held: Socket[] = [];
    const server = createServer((s) => {
      held.push(s);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const a = server.address();
      const url = `ws://127.0.0.1:${String(a !== null && typeof a === 'object' ? a.port : 0)}`;
      const ev = finalizeEvent(
        {
          kind: template.kind,
          created_at: template.created_at,
          tags: template.tags,
          content: template.content,
        },
        sk,
      ) as unknown as Ev;
      const results = await p.publishToRelays([url], ev, 15_000);
      expect(results.map((r) => [r.relay, r.ok])).toEqual([[url, false]]);
      // Let the socket's late `error` arrive inside this test, where it would fail it.
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      for (const s of held) s.destroy();
      server.close();
    }
  }, 30_000);
});
