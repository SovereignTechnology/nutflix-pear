/**
 * Slice 4a: a stored NFX upload's kind-38504 manifest, built from the legacy NIP-71 event, the
 * check on it once signed, its relays, and the legacy events waiting for their packaging.
 */
import { describe, expect, it } from 'vitest';

import type {
  NostrEventId,
  NostrPubkey,
  RelayUrl,
  Sha256Hex,
  UnixSeconds,
  VideoManifest,
} from '@sovit/core';
import { NFX_NETWORKS, nfx } from '@sovit/core';

import { NFX_DEFAULT_NAMESPACE } from '../../worker/studio/nfx.js';
import type { NfxStored } from '../nfx/publish.js';
import {
  MAX_PENDING_NFX,
  NFX_PUBLISH_NAMESPACE,
  PENDING_NFX_TTL_S,
  PendingNfxUploads,
  isSignedManifest,
  nfxManifestFor,
  nfxManifestRelays,
} from '../nfx/publish.js';
import { coreTestKit } from './support/core-helpers.js';

const kit = await coreTestKit();

const LEGACY_ID = 'ab'.repeat(32) as NostrEventId;
const ADDR = `nfx:testnet:1:nutflix-${LEGACY_ID.slice(0, 32)}`;
const ROOT = 'ef'.repeat(32) as Sha256Hex;
const THUMB = 'cd'.repeat(32) as Sha256Hex;
const AT = 1_757_000_100;

function legacyBy(author: string, over: Partial<VideoManifest> = {}): VideoManifest {
  return {
    id: LEGACY_ID,
    kind: 21,
    author: author as NostrPubkey,
    title: 'A free video',
    description: 'Made with **ffmpeg**.',
    publishedAt: 1_757_000_000 as UnixSeconds,
    durationSec: 90.4,
    tags: ['diy', 'free'],
    renditions: [],
    price: {} as never,
    blossomServers: [],
    event: {} as never,
    ...over,
  };
}

const stored = (over: Partial<NfxStored> = {}): NfxStored => ({
  state: 'stored',
  video: ADDR,
  root: ROOT,
  segs: '45',
  renditions: 2,
  bytes: 1000,
  thumb: { sha256: THUMB, mime: 'image/jpeg' },
  ...over,
});

describe('nfxManifestFor', () => {
  it('announces on the network the worker packages for', () => {
    // Contracts v10 speaks one network, so the worker and the host each name it as a constant;
    // this pins both to the contract's (a test is not bundled).
    expect(NFX_PUBLISH_NAMESPACE).toBe(NFX_DEFAULT_NAMESPACE);
    expect(NFX_NETWORKS).toEqual([NFX_PUBLISH_NAMESPACE]);
  });

  it('builds the NFX-02 tags, the thumb, and one `e` link back to the legacy event', () => {
    const built = nfxManifestFor(legacyBy('aa'.repeat(32)), stored(), AT);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.draft.event).toEqual({
      kind: 38504,
      created_at: AT,
      tags: [
        ['d', ADDR],
        ['n', 'nfx:testnet:1'],
        ['title', 'A free video'],
        ['published_at', '1757000000'],
        ['license', 'open'],
        ['root', ROOT],
        ['segs', '45'],
        ['duration', '90'],
        ['thumb', THUMB, 'image/jpeg'],
        ['t', 'diy'],
        ['t', 'free'],
        ['e', LEGACY_ID],
      ],
      content: 'Made with **ffmpeg**.',
    });
  });

  it('signed by the author, it parses as a free NFX-02 manifest and passes the check', async () => {
    const signer = new kit.TestSigner();
    const built = nfxManifestFor(legacyBy(signer.pubkey), stored(), AT);
    if (!built.ok) throw new Error(built.reason);
    const event = await kit.sign(signer, built.draft.event);
    const parsed = nfx.parseManifest(event);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      author: signer.pubkey,
      root: ROOT,
      segs: 45n,
      duration: 90n,
      thumb: { sha256: THUMB, mime: 'image/jpeg' },
      license: { mode: 'open' },
      hashtags: ['diy', 'free'],
    });
    expect(parsed.value.priceHint).toBeUndefined();
    expect(isSignedManifest(event, built.draft, signer.pubkey)).toBe(true);
  });

  it("refuses a stored video that is not this upload's", () => {
    for (const video of [
      `nfx:testnet:1:nutflix-${'cd'.repeat(16)}`,
      `nfx:mainnet:1:nutflix-${LEGACY_ID.slice(0, 32)}`,
      'not an address',
    ]) {
      expect(nfxManifestFor(legacyBy('aa'.repeat(32)), stored({ video }), AT)).toEqual({
        ok: false,
        reason: 'address-mismatch',
      });
    }
    expect(
      nfxManifestFor(legacyBy('aa'.repeat(32), { id: 'XYZ' as NostrEventId }), stored(), AT),
    ).toEqual({ ok: false, reason: 'address-mismatch' });
  });

  it('leaves out a missing thumb or an unusable duration; a bad time is invalid', () => {
    const { thumb: _thumb, ...noThumb } = stored();
    const { durationSec: _duration, ...noDuration } = legacyBy('aa'.repeat(32));
    const legacies: VideoManifest[] = [
      noDuration,
      ...[Number.NaN, -1, Number.POSITIVE_INFINITY].map((durationSec) => ({
        ...noDuration,
        durationSec,
      })),
    ];
    for (const legacy of legacies) {
      const built = nfxManifestFor(legacy, noThumb, AT);
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const names = built.draft.event.tags.map((t) => t[0]);
      expect(names).not.toContain('thumb');
      expect(names).not.toContain('duration');
    }
    const author = 'aa'.repeat(32);
    expect(
      nfxManifestFor(legacyBy(author, { publishedAt: 1.5 as UnixSeconds }), stored(), AT),
    ).toEqual({ ok: false, reason: 'invalid' });
    expect(nfxManifestFor(legacyBy(author), stored(), -1)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('isSignedManifest', () => {
  it('refuses another author, other tags, time or content, and a broken signature', async () => {
    const signer = new kit.TestSigner();
    const built = nfxManifestFor(legacyBy(signer.pubkey), stored(), AT);
    if (!built.ok) throw new Error(built.reason);
    const { draft } = built;
    const event = await kit.sign(signer, draft.event);
    expect(isSignedManifest(event, draft, 'bb'.repeat(32))).toBe(false);
    const noLink = await kit.sign(signer, {
      ...draft.event,
      tags: draft.event.tags.filter((t) => t[0] !== 'e'),
    });
    expect(isSignedManifest(noLink, draft, signer.pubkey)).toBe(false);
    const later = await kit.sign(signer, { ...draft.event, created_at: AT + 1 });
    expect(isSignedManifest(later, draft, signer.pubkey)).toBe(false);
    const other = await kit.sign(signer, { ...draft.event, content: 'something else' });
    expect(isSignedManifest(other, draft, signer.pubkey)).toBe(false);
    expect(
      isSignedManifest(kit.tamper(event, { sig: '00'.repeat(64) }), draft, signer.pubkey),
    ).toBe(false);
  });
});

describe('nfxManifestRelays', () => {
  it('is the write relays, then the scoped ones, each once', () => {
    const a = 'wss://a.test' as RelayUrl;
    const b = 'wss://b.test' as RelayUrl;
    const s = 'wss://scoped.test' as RelayUrl;
    expect(nfxManifestRelays([a, b], [s, a])).toEqual([a, b, s]);
    expect(nfxManifestRelays([a], [])).toEqual([a]);
  });
});

describe('PendingNfxUploads', () => {
  const legacy = legacyBy('aa'.repeat(32));

  it('gives an upload its legacy event once', () => {
    const p = new PendingNfxUploads();
    p.remember('u1', legacy, 100);
    expect(p.take('u2', 101)).toBeUndefined();
    expect(p.take('u1', 101)).toBe(legacy);
    expect(p.take('u1', 102)).toBeUndefined();
    expect(p.size).toBe(0);
  });

  it(`holds at most ${String(MAX_PENDING_NFX)}, the oldest going first`, () => {
    const p = new PendingNfxUploads();
    for (let i = 0; i <= MAX_PENDING_NFX; i++) p.remember(`u${String(i)}`, legacy, 200);
    expect(p.size).toBe(MAX_PENDING_NFX);
    expect(p.take('u0', 200)).toBeUndefined();
    expect(p.take(`u${String(MAX_PENDING_NFX)}`, 200)).toBe(legacy);
  });

  it(`forgets an entry after ${String(PENDING_NFX_TTL_S)} s`, () => {
    const p = new PendingNfxUploads();
    p.remember('late', legacy, 300);
    expect(p.take('late', 300 + PENDING_NFX_TTL_S)).toBeUndefined();
    p.remember('soon', legacy, 300);
    expect(p.take('soon', 300 + PENDING_NFX_TTL_S - 1)).toBe(legacy);
  });
});
