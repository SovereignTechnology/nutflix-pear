import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  AUTO_TOP_UP_MAX_SATS,
  AUTO_TOP_UP_MAX_SATS_PER_DAY,
  MAX_MIN_PAY_SATS,
  mocks,
  nfx,
} from '@sovit/core';

import {
  METHODS,
  isCallMsg,
  isFileToken,
  isGrantFileMsg,
  isHostIn,
  isHostOut,
  MAX_NFX_ADDRESS,
  isMintUrl,
  isNfxAddress,
  isRelayUrl,
  isReplyMsg,
  isSessionId,
  isSubMsg,
  isTopic,
  isVideoManifest,
  isSeederStatusWire,
  promptAnswerFits,
  validateArgs,
} from '../guards.js';
import type { Guard } from '../guards.js';
import { EXCLUDED_METHODS, IPC_V, LIMITS, MAX_SECRET_BYTES, TOPIC_METHODS } from '../protocol.js';
import type { Method } from '../protocol.js';
import { dehydrate } from '../wiremap.js';
import { INVALID, NFX_ADDR, SID, TOKEN, UPLOAD_ID, VALID } from './samples.js';

const methods = Object.keys(VALID) as Method[];

/** Adds an unknown key to the first plain-object argument, if any. */
function withExtraKey(args: readonly unknown[]): unknown[] | undefined {
  const i = args.findIndex((a) => typeof a === 'object' && a !== null && !Array.isArray(a));
  if (i < 0) return undefined;
  const out = [...args];
  out[i] = { ...(args[i] as object), __junk: 1 };
  return out;
}

/** Values that attack the guards themselves rather than their rules. */
function hostile(): unknown[] {
  const getterBomb = Object.defineProperty({}, 'source', {
    enumerable: true,
    get() {
      throw new Error('boom');
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('boom');
      },
      getPrototypeOf() {
        throw new Error('boom');
      },
    },
  );
  const arrayProxy = new Proxy([1], {
    get() {
      throw new Error('boom');
    },
  });
  const sparse: unknown[] = [];
  sparse.length = 3;
  const nullProto = Object.create(null) as object;
  return [getterBomb, proxy, arrayProxy, sparse, nullProto, [getterBomb], [proxy], [arrayProxy]];
}

describe('validateArgs — coverage', () => {
  it('has a guard for every method, and every guard has valid samples', () => {
    expect(new Set(METHODS)).toEqual(new Set(methods));
    // 49 + the five `desktop.signer.*` shell methods (ADR 0013) + `setProfilePicture` (v6, ADR 0015)
    // + `wallet.inputFeePpk` (v6: mint fees shown in the price) + the four
    // `desktop.wallet.recovery.*` shell methods (ADR 0016) + `desktop.wallet.topUp.holds` and
    // `.resume` (R5-R1) + `nfxVideo` (contracts v9, ADR 0020).
    expect(METHODS.length).toBe(63);
  });

  it('D3: wallet.send / wallet.receive (and the engine-internal wallet calls) are not methods', () => {
    for (const m of Object.keys(EXCLUDED_METHODS)) expect(METHODS).not.toContain(m);
    for (const m of Object.keys(TOPIC_METHODS)) expect(METHODS).not.toContain(m);
    expect(Object.keys(EXCLUDED_METHODS)).toEqual(
      expect.arrayContaining(['wallet.send', 'wallet.receive']),
    );
  });
});

describe.each(methods)('validateArgs[%s]', (m) => {
  const g = validateArgs[m] as Guard<unknown>;

  it('accepts every valid sample, also after a structured clone', () => {
    for (const args of VALID[m] as readonly unknown[][]) {
      expect(g(args), JSON.stringify(args)).toBe(true);
      expect(g(structuredClone(args))).toBe(true);
    }
  });

  it('rejects the hand-picked invalid samples', () => {
    for (const args of INVALID[m] ?? []) expect(g(args), JSON.stringify(args)).toBe(false);
  });

  it('rejects an extra argument, an unknown key, and non-array args', () => {
    for (const args of VALID[m] as readonly unknown[][]) {
      expect(g([...args, 'extra', 'extra', 'extra'])).toBe(false);
      const extra = withExtraKey(args);
      if (extra) expect(g(extra)).toBe(false);
      expect(g(Object.fromEntries(args.map((a, i) => [String(i), a])))).toBe(false);
    }
    for (const x of [undefined, null, 0, '', 'x', {}, true]) expect(g(x)).toBe(false);
  });

  it('never throws, and rejects hostile values', () => {
    for (const h of hostile()) {
      expect(() => g(h)).not.toThrow();
      expect(g(h)).toBe(false);
    }
  });

  it('fuzz: never throws on arbitrary input; non-arrays and oversize arrays are rejected', () => {
    fc.assert(
      fc.property(fc.anything({ withNullPrototype: true, withTypedArray: true }), (x) => {
        const r = g(x);
        expect(typeof r).toBe('boolean');
        if (!Array.isArray(x)) expect(r).toBe(false);
      }),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(fc.array(fc.anything(), { minLength: 5, maxLength: 20 }), (x) => {
        // No method takes more than 4 arguments.
        expect(g(x)).toBe(false);
      }),
      { numRuns: 50 },
    );
  });

  it('fuzz: replacing one argument with junk of another type is rejected', () => {
    const samples = (VALID[m] as readonly unknown[][]).filter((a) => a.length > 0);
    if (samples.length === 0) return;
    fc.assert(
      fc.property(
        fc.constantFrom(...samples),
        fc.nat(),
        fc.oneof(
          fc.constant(null),
          fc.constant(Symbol('s')),
          fc.bigInt(),
          fc.string({ minLength: LIMITS.maxBody + 1, maxLength: LIMITS.maxBody + 2 }),
          fc.array(fc.integer(), {
            minLength: LIMITS.maxPlaylistItems + 1,
            maxLength: LIMITS.maxPlaylistItems + 1,
          }),
          fc.func(fc.boolean()),
        ),
        (args, i, junk) => {
          const out = [...args];
          out[i % args.length] = junk;
          expect(g(out)).toBe(false);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('message envelopes', () => {
  const call = { v: IPC_V, id: 1, method: 'feed', args: [{ source: 'trending' }] };

  it('CallMsg: valid envelope + known method + valid args', () => {
    expect(isCallMsg(call)).toBe(true);
    expect(isCallMsg({ ...call, v: 2 })).toBe(false);
    expect(isCallMsg({ ...call, id: -1 })).toBe(false);
    expect(isCallMsg({ ...call, id: 1.5 })).toBe(false);
    expect(isCallMsg({ ...call, method: 'wallet.send' })).toBe(false);
    expect(isCallMsg({ ...call, method: 'constructor' })).toBe(false);
    expect(isCallMsg({ ...call, method: '__proto__' })).toBe(false);
    expect(isCallMsg({ ...call, method: 'toString' })).toBe(false);
    expect(isCallMsg({ ...call, args: [{ source: 'nope' }] })).toBe(false);
    expect(isCallMsg({ ...call, extra: true })).toBe(false);
    for (const m of methods)
      for (const args of VALID[m] as readonly unknown[][])
        expect(isCallMsg({ v: IPC_V, id: 7, method: m, args })).toBe(true);
  });

  it('Topic / SubMsg', () => {
    for (const t of [
      { t: 'seeder.status' },
      { t: 'notifications' },
      { t: 'wallet.change' },
      { t: 'session.peers', sid: SID },
      { t: 'session.spend', sid: SID },
      { t: 'upload.progress', uploadId: UPLOAD_ID },
    ]) {
      expect(isTopic(t)).toBe(true);
      expect(isSubMsg({ v: IPC_V, op: 'sub', subId: 3, topic: t })).toBe(true);
    }
    expect(isTopic({ t: 'session.peers' })).toBe(false);
    expect(isTopic({ t: 'seeder.status', sid: SID })).toBe(false);
    expect(isTopic({ t: 'wallet.send' })).toBe(false);
    expect(isSubMsg({ v: IPC_V, op: 'unsub', subId: 3 })).toBe(true);
    expect(isSubMsg({ v: IPC_V, op: 'unsub', subId: 3, topic: { t: 'notifications' } })).toBe(
      false,
    );
    expect(isSubMsg({ v: IPC_V, op: 'sub', subId: 3 })).toBe(false);
  });

  it('ReplyMsg: an error must carry a known code and the "<code>: " prefix', () => {
    expect(isReplyMsg({ v: IPC_V, id: 1, ok: true, result: { a: 1 } })).toBe(true);
    expect(isReplyMsg({ v: IPC_V, id: 1, ok: true })).toBe(false);
    const error = { code: 'no-seeders', message: 'no-seeders: nobody' };
    expect(isReplyMsg({ v: IPC_V, id: 1, ok: false, error })).toBe(true);
    expect(isReplyMsg({ v: IPC_V, id: 1, ok: false, error: { ...error, message: 'nobody' } })).toBe(
      false,
    );
    expect(
      isReplyMsg({ v: IPC_V, id: 1, ok: false, error: { code: 'teapot', message: 'teapot: x' } }),
    ).toBe(false);
  });

  it('FileToken / SessionId / grant-file (SE-1)', () => {
    expect(isFileToken(TOKEN)).toBe(true);
    for (const bad of [
      '/home/u/.ssh/id_ed25519',
      'nf-file:',
      'nf-file:00112233445566778899AABBCCDDEEFF',
      `${TOKEN}0`,
      'nf-file:../../../../etc/passwd',
      42,
    ])
      expect(isFileToken(bad)).toBe(false);
    expect(isSessionId(SID)).toBe(true);
    expect(isSessionId(SID.toUpperCase())).toBe(false);
    expect(isGrantFileMsg({ v: IPC_V, path: '/home/u/Videos/a.mp4' })).toBe(true);
    expect(isGrantFileMsg({ v: IPC_V, path: 'C:\\Users\\u\\a.mp4' })).toBe(true);
    expect(isGrantFileMsg({ v: IPC_V, path: 'relative/a.mp4' })).toBe(false);
    expect(isGrantFileMsg({ v: IPC_V, path: '/a\u0000b' })).toBe(false);
    expect(isGrantFileMsg({ v: IPC_V, path: '/' + 'a'.repeat(LIMITS.maxPath) })).toBe(false);
  });

  it('HostIn / HostOut', () => {
    const msg = { v: IPC_V, id: 1, method: 'studio.upload', args: VALID['studio.upload'][0] };
    const file = { path: '/home/u/Videos/a.mp4', name: 'a.mp4', size: 10 };
    expect(isHostIn({ kind: 'call', wc: 3, msg, file })).toBe(true);
    expect(isHostIn({ kind: 'call', wc: 3, msg: call })).toBe(true);
    expect(isHostIn({ kind: 'call', wc: 0, msg: call })).toBe(false);
    expect(isHostIn({ kind: 'call', wc: 3, msg: { ...call, method: 'wallet.receive' } })).toBe(
      false,
    );
    expect(isHostIn({ kind: 'wc-gone', wc: 3 })).toBe(true);
    expect(isHostIn({ kind: 'image', req: 1, id: 'abc' })).toBe(true);
    expect(isHostIn({ kind: 'image', req: 1, id: '../x' })).toBe(false);
    expect(
      isHostOut({ kind: 'media-link', token: 'a'.repeat(43), url: 'http://127.0.0.1:4000/x' }),
    ).toBe(true);
    expect(isHostOut({ kind: 'media-link', token: 'a'.repeat(43), url: null })).toBe(true);
    expect(
      isHostOut({ kind: 'media-link', token: 'a'.repeat(43), url: 'http://evil.example/x' }),
    ).toBe(false);
    expect(isHostOut({ kind: 'image', req: 1, bytes: new Uint8Array(3), type: 'image/png' })).toBe(
      true,
    );
    expect(isHostOut({ kind: 'image', req: 1, bytes: null, type: null })).toBe(true);
    expect(isHostOut({ kind: 'image', req: 1, bytes: [1], type: 'image/png' })).toBe(false);
  });

  it('ADR 0013: prompt and keychain messages carry data only, secrets as bounded bytes', () => {
    const b = (s: string): Uint8Array => new TextEncoder().encode(s);
    // host → main
    for (const form of [
      { kind: 'local-setup', hasKey: false, keychain: true },
      { kind: 'unlock-passphrase', retry: true },
      { kind: 'new-passphrase' },
      { kind: 'import-nsec' },
      { kind: 'bunker', keychain: false },
      { kind: 'create-wallet' },
    ])
      expect(isHostOut({ kind: 'prompt', req: 1, form }), JSON.stringify(form)).toBe(true);
    for (const form of [
      { kind: 'local-setup', hasKey: false },
      { kind: 'unlock-passphrase' },
      { kind: 'new-passphrase', title: 'Type your seed words here' }, // no prose from upstream
      { kind: 'export-key' },
      null,
    ])
      expect(isHostOut({ kind: 'prompt', req: 1, form }), JSON.stringify(form)).toBe(false);
    // ADR 0013 addendum: removing the key; a NIP-46 approval link (https only).
    expect(isHostOut({ kind: 'prompt', req: 1, form: { kind: 'remove-key' } })).toBe(true);
    expect(
      isHostOut({
        kind: 'prompt',
        req: 1,
        form: { kind: 'bunker-auth', url: 'https://auth.example/approve?t=1' },
      }),
    ).toBe(true);
    for (const url of [
      'http://auth.example/x',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://user:pw@auth.example/',
      'https://auth.example/a b',
      'https://auth.example/\u202eevil',
      'https://auth.example/\nx',
      'https://auth.example/' + 'a'.repeat(2048),
      'nf-media://x',
      'https://аuth.example/', // a raw (Cyrillic) IDN host: bunkers must send punycode
      'https://auth.example/\u0085x',
      '',
      42,
    ])
      expect(
        isHostOut({ kind: 'prompt', req: 1, form: { kind: 'bunker-auth', url } }),
        String(url).slice(0, 40),
      ).toBe(false);
    expect(
      isHostOut({
        kind: 'prompt',
        req: 1,
        form: { kind: 'bunker-auth', url: 'https://xn--uth-8cd.example:8443/a?b=c#d' },
      }),
    ).toBe(true);
    expect(isHostOut({ kind: 'prompt-cancel', req: 1 })).toBe(true);
    expect(isHostOut({ kind: 'keychain', req: 1, op: 'get', slot: 'passphrase' })).toBe(true);
    expect(isHostOut({ kind: 'keychain', req: 1, op: 'forget', slot: 'nip46' })).toBe(true);
    expect(isHostOut({ kind: 'keychain', req: 1, op: 'put', slot: 'nip46', value: b('x') })).toBe(
      true,
    );
    expect(isHostOut({ kind: 'keychain', req: 1, op: 'put', slot: 'nip46' })).toBe(false);
    expect(isHostOut({ kind: 'keychain', req: 1, op: 'get', slot: 'nip46', value: b('x') })).toBe(
      false,
    );
    expect(isHostOut({ kind: 'keychain', req: 1, op: 'get', slot: 'nsec' })).toBe(false);
    expect(
      isHostOut({
        kind: 'keychain',
        req: 1,
        op: 'put',
        slot: 'passphrase',
        value: new Uint8Array(MAX_SECRET_BYTES + 1),
      }),
    ).toBe(false);
    expect(
      isHostOut({ kind: 'keychain', req: 1, op: 'put', slot: 'passphrase', value: 'plaintext' }),
    ).toBe(false);
    // main → host
    expect(isHostIn({ kind: 'prompt-answer', req: 1, answer: null })).toBe(true);
    expect(
      isHostIn({ kind: 'prompt-answer', req: 1, answer: { kind: 'secret', value: b('pw') } }),
    ).toBe(true);
    expect(
      isHostIn({
        kind: 'prompt-answer',
        req: 1,
        answer: { kind: 'bunker', uri: b('bunker://x'), remember: false },
      }),
    ).toBe(true);
    expect(
      isHostIn({
        kind: 'prompt-answer',
        req: 1,
        answer: { kind: 'local-setup', method: 'keychain', flow: 'import' },
      }),
    ).toBe(true);
    for (const answer of [
      { kind: 'secret', value: 'a string, not bytes' },
      { kind: 'secret', value: new Uint8Array(0) },
      { kind: 'secret', value: new Uint8Array(MAX_SECRET_BYTES + 1) },
      { kind: 'bunker', uri: b('x') },
      { kind: 'local-setup', method: 'plaintext', flow: 'generate' },
      { kind: 'create-wallet', create: 'yes' },
    ])
      expect(isHostIn({ kind: 'prompt-answer', req: 1, answer }), JSON.stringify(answer)).toBe(
        false,
      );
    expect(
      isHostIn({ kind: 'prompt-answer', req: 1, answer: { kind: 'remove-key', confirm: true } }),
    ).toBe(true);
    expect(
      isHostIn({ kind: 'prompt-answer', req: 1, answer: { kind: 'bunker-auth', open: false } }),
    ).toBe(true);
    expect(isHostIn({ kind: 'keychain-result', req: 1, ok: true, value: null })).toBe(true);
    expect(isHostIn({ kind: 'keychain-result', req: 1, ok: true, value: b('pw') })).toBe(true);
    expect(isHostIn({ kind: 'keychain-result', req: 1, ok: 'yes', value: null })).toBe(false);
  });

  it('ADR 0013: an answer fits only the question it answers, with only what was offered', () => {
    const secret = { kind: 'secret', value: new Uint8Array([1]) } as const;
    const setup = (
      method: 'passphrase' | 'keychain',
      flow: 'unlock' | 'import' | 'generate' | 'remove',
    ) => ({ kind: 'local-setup', method, flow }) as const;
    const noKey = { kind: 'local-setup', hasKey: false, keychain: false } as const;
    const hasKey = { kind: 'local-setup', hasKey: true, keychain: true } as const;
    expect(promptAnswerFits(noKey, setup('passphrase', 'generate'))).toBe(true);
    expect(promptAnswerFits(noKey, setup('passphrase', 'import'))).toBe(true);
    expect(promptAnswerFits(noKey, setup('passphrase', 'unlock'))).toBe(false);
    expect(promptAnswerFits(noKey, setup('keychain', 'generate'))).toBe(false);
    expect(promptAnswerFits(hasKey, setup('keychain', 'unlock'))).toBe(true);
    expect(promptAnswerFits(hasKey, setup('passphrase', 'generate'))).toBe(false);
    expect(promptAnswerFits(hasKey, setup('passphrase', 'remove'))).toBe(true);
    expect(promptAnswerFits(noKey, setup('passphrase', 'remove'))).toBe(false);
    expect(promptAnswerFits({ kind: 'remove-key' }, { kind: 'remove-key', confirm: true })).toBe(
      true,
    );
    expect(promptAnswerFits({ kind: 'remove-key' }, { kind: 'create-wallet', create: true })).toBe(
      false,
    );
    expect(
      promptAnswerFits(
        { kind: 'bunker-auth', url: 'https://a.example/' },
        { kind: 'bunker-auth', open: true },
      ),
    ).toBe(true);
    expect(promptAnswerFits({ kind: 'import-nsec' }, secret)).toBe(true);
    expect(promptAnswerFits({ kind: 'create-wallet' }, secret)).toBe(false);
    const bunker = { kind: 'bunker', uri: new Uint8Array([1]), remember: true } as const;
    expect(promptAnswerFits({ kind: 'bunker', keychain: true }, bunker)).toBe(true);
    expect(promptAnswerFits({ kind: 'bunker', keychain: false }, bunker)).toBe(false);
    expect(
      promptAnswerFits({ kind: 'bunker', keychain: false }, { ...bunker, remember: false }),
    ).toBe(true);
    expect(promptAnswerFits({ kind: 'unlock-passphrase', retry: false }, bunker)).toBe(false);
    expect(
      promptAnswerFits({ kind: 'create-wallet' }, { kind: 'create-wallet', create: true }),
    ).toBe(true);
  });
});

describe('URL rules (consistent with @sovit/ui Settings/Studio validators)', () => {
  it('relays: wss only, no credentials/fragment, ≤ 512', () => {
    for (const ok of [
      'wss://relay.example',
      'wss://relay.example:444/path?x=1',
      'wss://[::1]:7000',
      'wss://127.0.0.1',
    ])
      expect(isRelayUrl(ok), ok).toBe(true);
    for (const bad of [
      'ws://relay.example',
      'https://relay.example',
      'wss://u:p@relay.example',
      'wss://relay.example#x',
      'wss://relay.example/',
      'wss://',
      'wss://relay example',
      'wss://relay.example/\u0000',
      'wss://' + 'a'.repeat(510),
    ])
      expect(isRelayUrl(bad), bad).toBe(false);
  });

  it('mints: https only, no credentials/query/fragment/trailing slash', () => {
    for (const ok of [
      'https://mint.example',
      'https://mint.example:3338/api/v1',
      'https://127.0.0.1:3338',
    ])
      expect(isMintUrl(ok), ok).toBe(true);
    for (const bad of [
      'http://mint.example',
      'https://mint.example/',
      'https://mint.example?x',
      'https://a@mint.example',
    ])
      expect(isMintUrl(bad), bad).toBe(false);
  });

  it('every URL the real Settings validators accept is accepted here', async () => {
    const ui = (await import(
      /* @vite-ignore */ new URL('../../../../ui/src/screens/Settings/model.ts', import.meta.url)
        .href
    )) as {
      validateRelayUrl(s: string): { ok: boolean; value?: string };
      validateMintUrl(s: string): { ok: boolean; value?: string };
    };
    const host = fc.stringMatching(/^[a-z0-9]{1,12}(\.[a-z0-9]{1,8}){0,3}$/);
    const path = fc.stringMatching(/^(\/[A-Za-z0-9._~-]{1,8}){0,3}\/?$/);
    const port = fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined });
    fc.assert(
      fc.property(
        fc.constantFrom('wss', 'WSS', 'https', 'ws', 'http'),
        host,
        port,
        path,
        (s, h, p, pa) => {
          const raw = `${s}://${h}${p === undefined ? '' : `:${p}`}${pa}`;
          const r = ui.validateRelayUrl(raw);
          if (r.ok) expect(isRelayUrl(r.value), `${raw} → ${String(r.value)}`).toBe(true);
          const mt = ui.validateMintUrl(raw);
          if (mt.ok) expect(isMintUrl(mt.value), `${raw} → ${String(mt.value)}`).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });
});

// v6 (Cameron, 2026-09-25): media on Pear only — the renderer cannot hand the host a Blossom
// mirror list, however well-formed.
describe('studio.upload carries no mirror list (v6)', () => {
  it('refuses mirrorTo', () => {
    const [first] = VALID['studio.upload'];
    const input = (first as readonly unknown[] | undefined)?.[0] as Record<string, unknown>;
    expect(validateArgs['studio.upload']([input])).toBe(true);
    expect(
      validateArgs['studio.upload']([{ ...input, mirrorTo: ['https://blossom.example'] }]),
    ).toBe(false);
  });
});

describe('data-shape guards against the core fixtures', () => {
  it('every fixture VideoManifest passes isVideoManifest', () => {
    for (const v of mocks.VIDEOS) expect(isVideoManifest(v), v.title).toBe(true);
    expect(isVideoManifest({ ...mocks.VIDEOS[0], renditions: [] })).toBe(false);
  });

  it('v5: a manifest carrying a creator’s minpay crosses; one outside the parser’s bound does not', () => {
    expect(LIMITS.maxMinPaySats).toBe(MAX_MIN_PAY_SATS);
    const v = mocks.VIDEOS[0]!;
    const withMin = (n: unknown): unknown => ({ ...v, price: { ...v.price, minPaySats: n } });
    expect(isVideoManifest(withMin(50))).toBe(true);
    expect(isVideoManifest(withMin(MAX_MIN_PAY_SATS))).toBe(true);
    for (const bad of [0, -1, 1.5, MAX_MIN_PAY_SATS + 1, '50', undefined])
      expect(isVideoManifest(withMin(bad)), String(bad)).toBe(false);
  });

  it("the mock seeder's status, dehydrated, passes isSeederStatusWire", async () => {
    const status = await new mocks.MockNetworkAdapter().seeder.status();
    expect(isSeederStatusWire(dehydrate(status))).toBe(true);
    expect(isSeederStatusWire(status)).toBe(false); // a raw Map never passes
  });
});

describe('issue #2: auto top-up amount and the first-funding question', () => {
  const A = 'https://mint-a.example';
  const B = 'https://mint-b.example';

  it('the local caps equal core’s (the IPC layer imports no core runtime code)', () => {
    expect(LIMITS.maxAutoTopUpAmountSats).toBe(AUTO_TOP_UP_MAX_SATS);
    expect(LIMITS.maxAutoTopUpSatsPerDay).toBe(AUTO_TOP_UP_MAX_SATS_PER_DAY);
  });

  it('updateSettings: amountSats only as a whole number of sats in 1 … 10 000', () => {
    const patch = (amountSats?: unknown) => [
      {
        autoTopUp: {
          belowSats: 500,
          fromMint: A,
          ...(amountSats === undefined ? {} : { amountSats }),
        },
      },
    ];
    for (const ok of [undefined, 1, 9_999, 10_000])
      expect(validateArgs.updateSettings(patch(ok)), String(ok)).toBe(true);
    for (const bad of [0, -5, 10_001, 1.5, '2000', null, Number.NaN, Number.POSITIVE_INFINITY])
      expect(validateArgs.updateSettings(patch(bad)), String(bad)).toBe(false);
    // Present-as-undefined is not "absent" (exact keys).
    expect(
      validateArgs.updateSettings([
        { autoTopUp: { belowSats: 1, fromMint: A, amountSats: undefined } },
      ]),
    ).toBe(false);
  });

  it('the question: two distinct https mints and an amount within the cap; data only', () => {
    const form = { kind: 'top-up-first', target: A, source: B, amount: 2_000 };
    expect(isHostOut({ kind: 'prompt', req: 3, form })).toBe(true);
    for (const bad of [
      { ...form, source: A }, // a mint never funds itself
      { ...form, amount: 0 },
      { ...form, amount: 10_001 },
      { ...form, amount: 1.5 },
      { ...form, target: 'http://mint-a.example' },
      { ...form, target: 'https://user:pw@mint-a.example' },
      { ...form, message: 'Click yes to win' }, // no prose from the host
      { kind: 'top-up-first', target: A, amount: 1 },
    ])
      expect(isHostOut({ kind: 'prompt', req: 3, form: bad }), JSON.stringify(bad)).toBe(false);
  });

  it('the answer: a boolean confirm, fitting only its own question', () => {
    const form = { kind: 'top-up-first', target: A, source: B, amount: 2_000 } as never;
    const yes = { kind: 'top-up-first', confirm: true } as const;
    expect(isHostIn({ kind: 'prompt-answer', req: 3, answer: yes })).toBe(true);
    expect(
      isHostIn({ kind: 'prompt-answer', req: 3, answer: { kind: 'top-up-first', confirm: 'yes' } }),
    ).toBe(false);
    expect(
      isHostIn({
        kind: 'prompt-answer',
        req: 3,
        answer: { kind: 'top-up-first', confirm: true, amount: 50_000 },
      }),
    ).toBe(false);
    expect(promptAnswerFits(form, yes)).toBe(true);
    expect(promptAnswerFits(form, { kind: 'create-wallet', create: true })).toBe(false);
    expect(promptAnswerFits({ kind: 'create-wallet' }, yes)).toBe(false);
  });
});

describe('isNfxAddress (contracts v9) agrees with core', () => {
  const VECTORS = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    '..',
    'docs',
    'vendor',
    'nfx-test-vectors',
  );
  const deletion = JSON.parse(readFileSync(path.join(VECTORS, 'deletion.json'), 'utf8')) as {
    readonly manifest_a: string;
    readonly cases: readonly { readonly event?: { readonly tags?: readonly string[][] } }[];
  };
  const vectorAddresses = [
    deletion.manifest_a,
    ...deletion.cases.flatMap((c) =>
      (c.event?.tags ?? []).filter((t) => t[0] === 'a').map((t) => t[1] ?? ''),
    ),
  ];
  const pk = mocks.ME;
  const candidates = [
    ...vectorAddresses,
    NFX_ADDR,
    ...mocks.NFX_VIDEOS.map((v) => v.id),
    ...((INVALID.nfxVideo ?? [])
      .map((args) => args[0])
      .filter((a) => typeof a === 'string') as string[]),
    `38504:${pk}:nfx:testnet:18446744073709551615:lagrange-points`,
    `38504:${pk}:nfx:${'n'.repeat(32)}:18446744073709551615:${'v'.repeat(63)}`,
    `38504:${pk}:nfx:${'n'.repeat(33)}:1:lagrange-points`,
    `38504:${pk}:nfx:testnet:1:${'v'.repeat(64)}`,
    `38504:${pk}:nfx:testnet:1:-leading-dash`,
    `38504:${pk}:nfx:t:1:lagrange-points`,
    `38504:${pk}:nfx:testnet:1:lagrange-points\n`,
    `38504:${pk.slice(1)}:nfx:testnet:1:lagrange-points`,
    '',
  ];

  it('accepts exactly the addresses core parses, in their canonical form', () => {
    for (const a of candidates) {
      const parsed = nfx.parseATag(a);
      const core =
        parsed.ok && `38504:${parsed.value.creator}:${parsed.value.addr.toString()}` === a;
      expect(isNfxAddress(a), a).toBe(core);
    }
  });

  it('accepts the vectors and the fixtures, at most MAX_NFX_ADDRESS long', () => {
    for (const a of [deletion.manifest_a, ...mocks.NFX_VIDEOS.map((v) => v.id)]) {
      expect(isNfxAddress(a), a).toBe(true);
    }
    const longest = `38504:${pk}:nfx:${'n'.repeat(32)}:18446744073709551615:${'v'.repeat(63)}`;
    expect(longest.length).toBe(MAX_NFX_ADDRESS);
    expect(isNfxAddress(longest)).toBe(true);
  });

  it('fuzz: never throws, and never accepts what core refuses', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 220 }), (s) => {
        const a = `38504:${pk}:nfx:${s}`;
        const parsed = nfx.parseATag(a);
        const core =
          parsed.ok && `38504:${parsed.value.creator}:${parsed.value.addr.toString()}` === a;
        expect(isNfxAddress(a)).toBe(core);
      }),
      { numRuns: 500 },
    );
  });
});
