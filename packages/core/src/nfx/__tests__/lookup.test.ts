/**
 * NFX-17, the seeder lookup (kind 20465), against the suite's vectors
 * (docs/vendor/nfx-test-vectors/lookup.json and lookup-invalid.json, nfx 4b6095c): the ask and the
 * tell rebuilt byte for byte from their throwaway keys, every valid event read (those with an
 * unknown tag and every boundary case included), every rejected event refused for the rule it
 * breaks, and the unknown type ignored. Then what the vectors do not carry: a tell to another key
 * or about another video, a tell whose signer is not its beacon's, and an embedded beacon spelled
 * any other way than the compact form.
 *
 * The vectors' keys are published throwaways. Events are signed here with @noble/curves' BIP-340
 * and the zero `aux_rand` the suite signs with, so they reproduce exactly; nothing in
 * `@sovit/core/nfx` signs.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { schnorr } from '@noble/curves/secp256k1.js';
import { getEventHash } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { describe, expect, it } from 'vitest';

import type { NfxAddress } from '../../contracts/index.js';
import {
  KIND_BEACON,
  KIND_LOOKUP,
  LOOKUP_ASK_TTL,
  LOOKUP_MAX_AGE,
  LOOKUP_MAX_ASK_BYTES,
  LOOKUP_MAX_FUTURE,
  LOOKUP_MAX_TELL_BYTES,
  LOOKUP_MAX_TELL_CONTENT,
  beaconTags,
  lookupAskFilter,
  lookupAskTags,
  lookupAskTemplate,
  lookupShape,
  lookupSizeOk,
  lookupTellContent,
  lookupTellFilter,
  lookupTellTags,
  lookupTellTemplate,
  parseBeacon,
  readLookup,
  readLookupAsk,
  readLookupTell,
  verifyEvent,
  type NfxErrorKind,
  type NfxResult,
} from '../index.js';

const DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'docs',
  'vendor',
  'nfx-test-vectors',
);
const load = (name: string): unknown => JSON.parse(readFileSync(join(DIR, name), 'utf8'));

interface RawEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}
interface Case {
  name: string;
  reason: string;
  event: RawEvent;
}

const v = load('lookup.json') as {
  secret_keys_DO_NOT_USE: { seeder: string; asker: string };
  now: number;
  manifest_a: string;
  asker: string;
  seeder: string;
  beacon: RawEvent;
  ask: RawEvent;
  tell: RawEvent;
  ask_with_unknown_tag: RawEvent;
  tell_with_unknown_tag: RawEvent;
  boundaries: { name: string; event: RawEvent }[];
};
const bad = load('lookup-invalid.json') as {
  secret_keys_DO_NOT_USE: { seeder: string; asker: string; stranger: string };
  now: number;
  rejected: Case[];
  ignored: Case[];
};
const keys = bad.secret_keys_DO_NOT_USE;
const NOW = v.now;
const A = v.manifest_a;
const reader = { now: NOW, asker: v.asker, a: A };

function unwrap<T>(r: NfxResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.reason}`);
  return r.value;
}

const pubkeyOf = (sk: string): string => bytesToHex(schnorr.getPublicKey(hexToBytes(sk)));

/** A NIP-01 event signed as the suite signs: BIP-340 with a zero `aux_rand`. */
function sign(
  sk: string,
  t: { kind: number; created_at: number; tags: string[][]; content: string },
): RawEvent {
  const key = hexToBytes(sk);
  const pubkey = bytesToHex(schnorr.getPublicKey(key));
  const id = getEventHash({ ...t, pubkey });
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), key, new Uint8Array(32)));
  return {
    id,
    pubkey,
    created_at: t.created_at,
    kind: t.kind,
    tags: t.tags,
    content: t.content,
    sig,
  };
}

/** A tell by `sk` with `content` in place of whatever it should carry, its tags `beacon`'s. */
function tellWith(sk: string, beacon: RawEvent, content: string, createdAt = NOW): RawEvent {
  const tags = unwrap(lookupTellTags(beacon, v.asker));
  return sign(sk, { kind: KIND_LOOKUP, created_at: createdAt, tags, content });
}

const SIG = 'id or signature does not verify';
const WINDOW = '`created_at` is not within 60 s before to 30 s after now';
const COMPACT = 'the embedded beacon is not in its compact form';
const SIGNER = "the tell's signer is not the beacon's";
const NEWER = 'the embedded beacon is dated after the tell';

/** Each rejected vector, and the error a reader gives it: the rule the vector says it breaks. */
const REJECTED: Readonly<Record<string, readonly [NfxErrorKind, string]>> = {
  'ask-wrong-kind': ['event', 'wrong kind'],
  'ask-no-n': ['event', 'missing `n` tag'],
  'ask-no-a': ['event', 'missing `a` tag'],
  'ask-no-t': ['event', 'missing `t` tag'],
  'ask-no-expiration': ['event', 'missing `expiration` tag'],
  'ask-two-n': ['event', 'duplicate `n` tag'],
  'ask-two-a': ['event', 'duplicate `a` tag'],
  'ask-two-t': ['event', 'duplicate `t` tag'],
  'ask-two-expiration': ['event', 'duplicate `expiration` tag'],
  'ask-other-network': ['event', '`a` names a different network than `n`'],
  'ask-a-not-a-manifest': ['event', '`a` must address a kind-38504 manifest'],
  'ask-with-p': ['event', 'an ask carries no `p`'],
  'ask-with-content': ['event', 'an ask carries no content'],
  'ask-lifetime-61': ['event', 'an ask lives at most 60 s'],
  'ask-lifetime-0': ['event', '`expiration` is not after `created_at`'],
  'ask-expiration-not-a-number': ['event', '`expiration` is not a canonical decimal integer'],
  'ask-expired': ['event', 'expired'],
  'ask-from-the-future': ['event', WINDOW],
  'ask-bad-signature': ['signature', SIG],
  'ask-bad-id': ['signature', SIG],
  'tell-no-p': ['event', 'missing `p` tag'],
  'tell-two-p': ['event', 'duplicate `p` tag'],
  'tell-p-uppercase': ['event', '`p` is not 64 lowercase hex'],
  'tell-p-short': ['event', '`p` is not 64 lowercase hex'],
  'tell-no-n': ['event', 'missing `n` tag'],
  'tell-no-a': ['event', 'missing `a` tag'],
  'tell-no-t': ['event', 'missing `t` tag'],
  'tell-no-expiration': ['event', 'missing `expiration` tag'],
  'tell-empty-content': ['event', 'a tell carries a beacon'],
  'tell-content-not-json': ['event', 'the content is not JSON'],
  'tell-content-too-large': ['event', 'content over 16384 bytes'],
  'tell-embedded-whitespace': ['event', COMPACT],
  'tell-embedded-reordered': ['event', COMPACT],
  'tell-embedded-extra-member': ['event', 'the embedded event has a member NIP-01 does not'],
  'tell-embedded-duplicate-member': ['event', 'the embedded event repeats a member'],
  'tell-beacon-newer-than-the-tell': ['event', NEWER],
  'tell-beacon-from-the-future': ['event', NEWER],
  'tell-embeds-another-kind': ['event', 'the embedded event is not a beacon'],
  'tell-embedded-bad-signature': ['signature', `the embedded beacon: ${SIG}`],
  'tell-embedded-bad-id': ['signature', `the embedded beacon: ${SIG}`],
  'tell-embedded-changed': ['signature', `the embedded beacon: ${SIG}`],
  'tell-embedded-fails-nfx-03': [
    'beacon',
    'the embedded beacon: `chunks` must be "all" or a count',
  ],
  'tell-embedded-expired': ['beacon', 'the embedded beacon: expired'],
  'tell-expired': ['event', 'expired'],
  'tell-embeds-another-seeders-beacon': ['event', SIGNER],
  'tell-signed-by-another-key': ['event', SIGNER],
  'tell-other-video': ['event', 'the embedded beacon serves another video'],
  'tell-expiration-differs': ['event', "`expiration` is not the embedded beacon's"],
  'tell-too-old': ['event', WINDOW],
  'tell-from-the-future': ['event', WINDOW],
  'tell-bad-signature': ['signature', SIG],
  'tell-bad-id': ['signature', SIG],
};

describe('NFX-17 lookup vectors (lookup.json, lookup-invalid.json)', () => {
  it('pins the kind, the limits and the throwaway keys', () => {
    expect([KIND_LOOKUP, LOOKUP_ASK_TTL, LOOKUP_MAX_AGE, LOOKUP_MAX_FUTURE]).toEqual([
      20465, 60, 60, 30,
    ]);
    expect([LOOKUP_MAX_TELL_CONTENT, LOOKUP_MAX_ASK_BYTES, LOOKUP_MAX_TELL_BYTES]).toEqual([
      16384, 1024, 36864,
    ]);
    expect(pubkeyOf(v.secret_keys_DO_NOT_USE.asker)).toBe(v.asker);
    expect(pubkeyOf(v.secret_keys_DO_NOT_USE.seeder)).toBe(v.seeder);
    expect(v.secret_keys_DO_NOT_USE).toEqual({ seeder: keys.seeder, asker: keys.asker });
    expect(bad.now).toBe(NOW);
  });

  it('builds the ask and the tell byte for byte from their keys', () => {
    expect(unwrap(lookupAskTags(A, v.ask.created_at))).toEqual(v.ask.tags);
    expect(unwrap(lookupTellTags(v.beacon, v.asker))).toEqual(v.tell.tags);
    expect(unwrap(lookupTellContent(v.beacon))).toBe(v.tell.content);
    const ask = unwrap(lookupAskTemplate(A, v.ask.created_at));
    expect(sign(v.secret_keys_DO_NOT_USE.asker, ask)).toEqual(v.ask);
    const tell = unwrap(lookupTellTemplate(v.beacon, v.asker, v.tell.created_at));
    expect(sign(v.secret_keys_DO_NOT_USE.seeder, tell)).toEqual(v.tell);
    // Each boundary tell too: its content is the beacon it wraps, compact.
    const tells = v.boundaries.filter((b) => b.name.startsWith('tell-'));
    expect(tells).toHaveLength(4);
    for (const { name, event } of tells) {
      const beacon = JSON.parse(event.content) as RawEvent;
      const t = unwrap(lookupTellTemplate(beacon, v.asker, event.created_at));
      expect(sign(v.secret_keys_DO_NOT_USE.seeder, t), name).toEqual(event);
    }
  });

  it('reads the ask and the tell, and hands over the beacon exactly as it was signed', () => {
    const read = unwrap(readLookup(v.ask, NOW));
    if (read.type !== 'ask') throw new Error(read.type);
    const ask = read.ask;
    expect(ask.id).toBe(v.ask.id);
    expect(ask.asker).toBe(v.asker);
    expect(ask.a).toBe(A);
    expect(ask.creator).toBe(A.split(':')[1]);
    expect(ask.video.toString()).toBe('nfx:mainnet:1:salt-flats-dusk');
    expect(ask.createdAt).toBe(v.ask.created_at);
    expect(ask.expiration).toBe(BigInt(v.ask.created_at + 60));
    expect(unwrap(readLookupAsk(v.ask, NOW))).toEqual(ask);

    const tell = unwrap(readLookupTell(v.tell, reader));
    expect(tell.id).toBe(v.tell.id);
    expect(tell.seeder).toBe(v.seeder);
    expect(tell.asker).toBe(v.asker);
    expect(tell.a).toBe(A);
    expect(tell.creator).toBe(ask.creator);
    expect(tell.createdAt).toBe(v.tell.created_at);
    expect(tell.expiration).toBe(BigInt(v.beacon.created_at + 60));
    expect(tell.event).toEqual(v.beacon);
    expect(Object.isFrozen(tell.event)).toBe(true);
    // The same `Beacon` parseBeacon gives, for the tables that already hold one.
    expect(tell.beacon).toEqual(unwrap(parseBeacon(v.beacon, NOW)));
    expect(tell.beacon.seeder).toBe(tell.seeder);
    const generic = unwrap(readLookup(v.tell, NOW));
    expect(generic.type === 'tell' && generic.tell).toEqual(tell);
  });

  it('accepts the events with an unknown tag, and every boundary case', () => {
    expect(v.boundaries).toHaveLength(7);
    const all = [
      { name: 'ask_with_unknown_tag', event: v.ask_with_unknown_tag },
      { name: 'tell_with_unknown_tag', event: v.tell_with_unknown_tag },
      ...v.boundaries,
    ];
    for (const { name, event } of all) {
      const type = event.tags.find((t) => t[0] === 't')?.[1];
      const read = readLookup(event, NOW);
      expect(read.ok && read.value.type, name).toBe(type);
      // The pre-signature check agrees on who asked, and what about.
      const shape = unwrap(lookupShape(event, NOW));
      expect([shape.type, shape.asker, shape.a], name).toEqual([type, v.asker, A]);
      if (type === 'ask') expect(readLookupAsk(event, NOW).ok, name).toBe(true);
      else expect(unwrap(readLookupTell(event, reader)).seeder, name).toBe(v.seeder);
    }
  });

  it('refuses every rejected event, for the rule it breaks', () => {
    expect(bad.rejected).toHaveLength(52);
    expect(bad.rejected.map((c) => c.name).sort()).toEqual(Object.keys(REJECTED).sort());
    for (const c of bad.rejected) {
      const [kind, reason] = REJECTED[c.name]!;
      const read = readLookup(c.event, NOW);
      expect(read.ok ? read.value : read.error, `${c.name} (${c.reason})`).toEqual({
        kind,
        reason: `lookup: ${reason}`,
      });
      // The typed readers refuse it too, whatever they say first.
      const typed = c.name.startsWith('ask-')
        ? readLookupAsk(c.event, NOW)
        : readLookupTell(c.event, reader);
      expect(typed.ok, c.name).toBe(false);
    }
  });

  it('ignores a type it does not know, without error, and only the generic reader does', () => {
    expect(bad.ignored).toHaveLength(1);
    for (const c of bad.ignored) {
      expect(verifyEvent(c.event).ok, `${c.name} is well signed`).toBe(true);
      expect(unwrap(readLookup(c.event, NOW))).toEqual({
        type: 'ignored',
        why: 'a type this version does not use',
      });
      expect(lookupShape(c.event, NOW).ok).toBe(false);
      expect(readLookupAsk(c.event, NOW)).toEqual({
        ok: false,
        error: { kind: 'event', reason: 'lookup: not an ask' },
      });
      expect(readLookupTell(c.event, reader)).toEqual({
        ok: false,
        error: { kind: 'event', reason: 'lookup: not a tell' },
      });
    }
  });
});

describe('NFX-17 beyond the vectors', () => {
  const strangerPk = pubkeyOf(keys.stranger);
  const err = (reason: string, kind: NfxErrorKind = 'event'): NfxResult<never> => ({
    ok: false,
    error: { kind, reason: `lookup: ${reason}` },
  });

  it('drops a tell to another key, or about another video, before any cryptography', () => {
    // Valid by §2, which leaves the address to the viewer: here it is someone else's.
    const toStranger = sign(
      keys.seeder,
      unwrap(lookupTellTemplate(v.beacon, strangerPk, v.tell.created_at)),
    );
    expect(unwrap(readLookup(toStranger, NOW)).type).toBe('tell');
    expect(readLookupTell(toStranger, reader)).toEqual(err('a tell to another key'));
    expect(readLookupTell(toStranger, { ...reader, asker: strangerPk }).ok).toBe(true);
    // Our own tell, read as if we had asked with another key or about another video.
    expect(readLookupTell(v.tell, { ...reader, asker: v.seeder })).toEqual(
      err('a tell to another key'),
    );
    const other = `${A.slice(0, A.lastIndexOf(':'))}:another-video`;
    expect(readLookupTell(v.tell, { ...reader, a: other })).toEqual(
      err('a tell about another video'),
    );
    // A broken signature is never looked at for a tell that is not ours.
    const forged = { ...v.tell, sig: '00'.repeat(64) };
    expect(readLookupTell(forged, { ...reader, asker: strangerPk })).toEqual(
      err('a tell to another key'),
    );
    expect(readLookupTell(forged, reader)).toEqual(err(SIG, 'signature'));
    expect(readLookupTell(v.tell, { ...reader, asker: v.asker.toUpperCase() })).toEqual(
      err('the asker is not 64 lowercase hex'),
    );
  });

  it("refuses a tell whose signer is not its beacon's, and counts the beacon's signer", () => {
    // The seeder's beacon, wrapped and signed by a stranger.
    const wrapped = tellWith(keys.stranger, v.beacon, v.tell.content, v.tell.created_at);
    expect(readLookupTell(wrapped, reader)).toEqual(err(SIGNER));
    // A stranger's own beacon, wrapped and signed by the seeder.
    const created = v.beacon.created_at;
    const theirs = sign(keys.stranger, {
      kind: KIND_BEACON,
      created_at: created,
      tags: unwrap(beaconTags(A, created, 60)),
      content: v.beacon.content,
    });
    expect(parseBeacon(theirs, NOW).ok).toBe(true);
    const content = unwrap(lookupTellContent(theirs));
    expect(readLookupTell(tellWith(keys.seeder, theirs, content), reader)).toEqual(err(SIGNER));
    // Wrapped by the key that signed it, it is that key's tell, and that key is the seeder.
    const own = readLookupTell(tellWith(keys.stranger, theirs, content), reader);
    expect(own.ok && own.value.seeder).toBe(strangerPk);
    expect(own.ok && own.value.beacon.seeder).toBe(strangerPk);
  });

  it('takes the embedded beacon in its one compact spelling only', () => {
    const compact = v.tell.content;
    const canonical = tellWith(keys.seeder, v.beacon, compact);
    expect(readLookupTell(canonical, reader).ok, 'the control').toBe(true);
    const firstSlash = compact.indexOf('/');
    const firstQuote = compact.indexOf('\\"');
    expect(firstSlash > 0 && firstQuote > 0).toBe(true);
    /** `compact` with the `cut` characters at `at` written as `put`. */
    const spell = (at: number, cut: number, put: string): string =>
      compact.slice(0, at) + put + compact.slice(at + cut);
    // Each spells the very same event: a reader that only parsed would take it.
    const respelled: Record<string, string> = {
      'trailing newline': `${compact}\n`,
      'leading space': ` ${compact}`,
      'space after a colon': compact.replace('"kind":', '"kind": '),
      'escaped solidus': spell(firstSlash, 1, '\\/'),
      'unicode escape for a quote': spell(firstQuote, 2, '\\u0022'),
      'unicode escape in a member name': compact.replace('"kind":', '"\\u006bind":'),
      'uppercase unicode escape': compact.replace('"kind":', '"\\u006Bind":'),
    };
    for (const [name, content] of Object.entries(respelled)) {
      expect(content, name).not.toBe(compact);
      expect(JSON.parse(content), name).toEqual(v.beacon);
      expect(readLookupTell(tellWith(keys.seeder, v.beacon, content), reader), name).toEqual(
        err(COMPACT),
      );
    }
    // Numbers spelled as anything but a plain integer are not NIP-01's types.
    const types = 'the content is not an event with NIP-01 members and types';
    for (const [name, content] of Object.entries({
      'kind with an exponent': compact.replace('"kind":20464', '"kind":2.0464e4'),
      'created_at with a fraction': compact.replace(
        `"created_at":${String(v.beacon.created_at)}`,
        `"created_at":${String(v.beacon.created_at)}.0`,
      ),
      'kind as a string': compact.replace('"kind":20464', '"kind":"20464"'),
      'a tag value that is a number': compact.replace('["n","nfx:mainnet:1"]', '["n",1]'),
    })) {
      expect(content, name).not.toBe(compact);
      expect(readLookupTell(tellWith(keys.seeder, v.beacon, content), reader), name).toEqual(
        err(types),
      );
    }
  });

  it('lets a tell live no longer than its beacon', () => {
    const expiration = v.beacon.created_at + 60;
    expect(readLookupTell(v.tell, { ...reader, now: expiration - 1 }).ok).toBe(true);
    expect(readLookupTell(v.tell, { ...reader, now: expiration })).toEqual(err('expired'));
  });

  it('names who asked without a signature, and verifies before it hands over an ask', () => {
    const unsigned = { ...v.ask, sig: '00'.repeat(64) };
    const shape = unwrap(lookupShape(unsigned, NOW));
    expect([shape.type, shape.sender, shape.asker, shape.a]).toEqual(['ask', v.asker, v.asker, A]);
    expect(readLookupAsk(unsigned, NOW)).toEqual(err(SIG, 'signature'));
    expect(readLookupAsk(v.tell, NOW)).toEqual(err('not an ask'));
    expect(readLookupTell(v.ask, reader)).toEqual(err('not a tell'));
    const tellShape = unwrap(lookupShape(v.tell, NOW));
    expect([tellShape.type, tellShape.sender, tellShape.asker]).toEqual([
      'tell',
      v.seeder,
      v.asker,
    ]);
  });

  it('never throws, needs a clock, and reads an untrusted object once', () => {
    const junk: unknown[] = [
      null,
      undefined,
      7,
      'x',
      [],
      {},
      { kind: KIND_LOOKUP },
      { ...v.ask, tags: [[]] },
      { ...v.ask, tags: [['t', 'ask', 7]] },
      { ...v.ask, tags: 'n' },
      { ...v.ask, created_at: 1.5 },
      { ...v.ask, created_at: -1 },
      { ...v.ask, pubkey: v.asker.toUpperCase() },
      new Proxy(
        {},
        {
          get: () => {
            throw new Error('trap');
          },
        },
      ),
    ];
    for (const raw of junk) {
      expect(readLookup(raw, NOW).ok).toBe(false);
      expect(readLookupAsk(raw, NOW).ok).toBe(false);
      expect(readLookupTell(raw, reader).ok).toBe(false);
      expect(lookupShape(raw, NOW).ok).toBe(false);
    }
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1]) {
      expect(readLookup(v.ask, now)).toEqual(err('`now` is not a unix time'));
      expect(readLookupTell(v.tell, { ...reader, now }).ok).toBe(false);
    }
    // A getter that shows the real tags first and others later cannot split the checks.
    let reads = 0;
    const shifty = {
      ...v.ask,
      get tags(): string[][] {
        reads += 1;
        return reads === 1 ? v.ask.tags : [['t', 'tell']];
      },
    };
    const read = readLookup(shifty, NOW);
    expect(read.ok && read.value.type).toBe('ask');
    expect(reads).toBe(1);
  });

  it('builds nothing a reader would refuse', () => {
    expect(lookupAskTags('not an address', NOW).ok).toBe(false);
    expect(lookupAskTags(`1${A}`, NOW).ok).toBe(false);
    for (const at of [-1, 1.5, Number.NaN]) expect(lookupAskTags(A, at).ok).toBe(false);
    expect(lookupTellTags({ ...v.beacon, kind: 1 }, v.asker)).toEqual(
      err('the embedded event is not a beacon'),
    );
    expect(lookupTellTags(v.beacon, v.asker.toUpperCase())).toEqual(
      err('`p` is not 64 lowercase hex'),
    );
    const noExpiration = { ...v.beacon, tags: v.beacon.tags.filter((t) => t[0] !== 'expiration') };
    expect(lookupTellTags(noExpiration, v.asker)).toEqual(err('missing `expiration` tag'));
    // Dated within the beacon's lifetime, or not at all.
    const born = v.beacon.created_at;
    const dies = born + 60;
    const dated = "a tell is dated within its beacon's lifetime";
    expect(lookupTellTemplate(v.beacon, v.asker, born - 1)).toEqual(err(dated));
    expect(lookupTellTemplate(v.beacon, v.asker, dies)).toEqual(err(dated));
    expect(lookupTellTemplate(v.beacon, v.asker, born).ok).toBe(true);
    expect(lookupTellTemplate(v.beacon, v.asker, dies - 1).ok).toBe(true);
    // A beacon too large to wrap: 16384 bytes of content alone, before its JSON.
    const huge = { ...v.beacon, content: 'x'.repeat(LOOKUP_MAX_TELL_CONTENT) };
    expect(lookupTellContent(huge)).toEqual(err('content over 16384 bytes'));
    expect(lookupTellTemplate(huge, v.asker, born)).toEqual(err('content over 16384 bytes'));
    // Multi-byte characters count as their UTF-8 bytes.
    const wide = { ...v.beacon, content: 'é'.repeat(LOOKUP_MAX_TELL_CONTENT / 2) };
    expect(lookupTellContent(wide)).toEqual(err('content over 16384 bytes'));
  });

  it('holds a scoped relay’s size limits by type', () => {
    expect(lookupSizeOk('ask', LOOKUP_MAX_ASK_BYTES)).toBe(true);
    expect(lookupSizeOk('ask', LOOKUP_MAX_ASK_BYTES + 1)).toBe(false);
    expect(lookupSizeOk('tell', LOOKUP_MAX_TELL_BYTES)).toBe(true);
    expect(lookupSizeOk('tell', LOOKUP_MAX_TELL_BYTES + 1)).toBe(false);
    const bytes = (e: RawEvent): number => new TextEncoder().encode(JSON.stringify(e)).length;
    expect(lookupSizeOk('ask', bytes(v.ask))).toBe(true);
    expect(lookupSizeOk('tell', bytes(v.tell))).toBe(true);
  });

  it('subscribes as §3 and §4 say', () => {
    const namespace = 'nfx:mainnet:1';
    expect(lookupAskFilter(namespace, [A], NOW)).toEqual({
      kinds: [20465],
      '#n': [namespace],
      '#t': ['ask'],
      '#a': [A],
      since: NOW - 60,
    });
    expect(lookupTellFilter({ namespace, id: A as NfxAddress }, v.asker, NOW)).toEqual({
      kinds: [20465],
      '#n': [namespace],
      '#p': [v.asker],
      '#t': ['tell'],
      '#a': [A],
      since: NOW - 60,
    });
  });
});
