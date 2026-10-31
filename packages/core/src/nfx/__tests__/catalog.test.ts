/**
 * NFX manifests → listings (contracts v9, ADR 0020): NFX-02 §4 revisions, §6 deletions, and the
 * Phase 1 rule that only free videos are listed. Events are really signed (`TestSigner`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { NostrEvent, UnixSeconds } from '../../contracts/index.js';
import { T0, TestSigner, sign } from '../../nostr/__tests__/helpers.js';
import {
  currentRevisions,
  deletionsIn,
  listNfxVideos,
  manifestsIn,
  toNfxVideo,
  withoutDeleted,
} from '../catalog.js';
import { MAX_CLOCK_SKEW } from '../event.js';

const NS = 'nfx:testnet:1';
const ROOT = 'ab'.repeat(32);
const THUMB = 'cd'.repeat(32);
const NOW = (T0 + 10_000) as UnixSeconds;

interface Draft {
  readonly createdAt?: number;
  readonly title?: string;
  readonly ns?: string;
  readonly priceHint?: string;
  readonly publishedAt?: string;
  readonly extra?: readonly string[][];
}

function manifestDraft(videoId: string, o: Draft = {}) {
  const ns = o.ns ?? NS;
  return {
    kind: 38504,
    created_at: o.createdAt ?? T0,
    content: `About ${videoId}.`,
    tags: [
      ['d', `${ns}:${videoId}`],
      ['n', ns],
      ['title', o.title ?? videoId],
      ['published_at', o.publishedAt ?? String(T0 - 100)],
      ['license', 'open'],
      ['root', ROOT],
      ['segs', '4'],
      ['duration', '61'],
      ['thumb', THUMB, 'image/jpeg'],
      ['t', 'space'],
      ...(o.priceHint === undefined ? [] : [['price_hint', o.priceHint]]),
      ...(o.extra ?? []),
    ],
  };
}

const address = (author: string, videoId: string, ns = NS): string =>
  `38504:${author}:${ns}:${videoId}`;

function deletionDraft(addresses: readonly string[], createdAt: number, extra: string[][] = []) {
  return {
    kind: 5,
    created_at: createdAt,
    content: '',
    tags: [...addresses.map((a) => ['a', a]), ['k', '38504'], ...extra],
  };
}

const creator = new TestSigner();
const other = new TestSigner();

describe('listNfxVideos', () => {
  it('lists a free manifest as an NfxVideo, addressed by its NIP-01 coordinate', async () => {
    const legacy = 'ef'.repeat(32);
    const ev = await sign(
      creator,
      manifestDraft('lagrange-points', { extra: [['e', legacy]], title: 'Lagrange' }),
    );
    const [v] = listNfxVideos(NS, [ev], [], NOW);
    expect(v).toEqual({
      kind: 38504,
      id: address(creator.pubkey, 'lagrange-points'),
      eventId: ev.id,
      author: creator.pubkey,
      title: 'Lagrange',
      description: 'About lagrange-points.',
      publishedAt: T0 - 100,
      durationSec: 61,
      tags: ['space'],
      namespace: NS,
      root: ROOT,
      segs: 4,
      thumb: { sha256: THUMB, mime: 'image/jpeg' },
      legacyId: legacy,
      event: ev,
    });
  });

  it('keeps the e link only when it is one 64-hex id', async () => {
    const two = await sign(
      creator,
      manifestDraft('two-links', {
        extra: [
          ['e', 'ef'.repeat(32)],
          ['e', '01'.repeat(32)],
        ],
      }),
    );
    const bad = await sign(creator, manifestDraft('bad-link', { extra: [['e', 'not-hex']] }));
    for (const v of listNfxVideos(NS, [two, bad], [], NOW)) expect(v.legacyId).toBeUndefined();
  });

  it('drops other kinds, other namespaces, and events that fail NFX-02 §4 whole', async () => {
    const elsewhere = await sign(creator, manifestDraft('mainnet-video', { ns: 'nfx:mainnet:1' }));
    const note = await sign(creator, { kind: 1, created_at: T0, content: 'hi', tags: [] });
    const broken = await sign(creator, {
      ...manifestDraft('no-root-video'),
      tags: manifestDraft('no-root-video').tags.filter((t) => t[0] !== 'root'),
    });
    const ok = await sign(creator, manifestDraft('good-video'));
    const ids = listNfxVideos(NS, [elsewhere, note, broken, ok], [], NOW).map((v) => v.id);
    expect(ids).toEqual([address(creator.pubkey, 'good-video')]);
  });

  it('Phase 1: only free videos (open, price_hint absent or 0); licensed ones are not listed', async () => {
    const hinted = await sign(creator, manifestDraft('priced-video', { priceHint: '5' }));
    const zero = await sign(creator, manifestDraft('zero-hint-video', { priceHint: '0' }));
    const ids = listNfxVideos(NS, [hinted, zero], [], NOW).map((v) => v.id);
    expect(ids).toEqual([address(creator.pubkey, 'zero-hint-video')]);

    const dir = join(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      '..',
      '..',
      '..',
      '..',
      'docs',
      'vendor',
      'nfx-test-vectors',
    );
    const vector = (name: string): NostrEvent =>
      (JSON.parse(readFileSync(join(dir, name), 'utf8')) as { event: NostrEvent }).event;
    const licensed = vector('manifest.json');
    const open = vector('manifest-open.json');
    const now = (Math.max(licensed.created_at, open.created_at) + 60) as UnixSeconds;
    // The vectors are two revisions of one address: licensed, then delisted to open (NFX-02 §6).
    expect(listNfxVideos('nfx:mainnet:1', [licensed], [], now)).toEqual([]);
    const listed = listNfxVideos('nfx:mainnet:1', [licensed, open], [], now);
    expect(listed.map((v) => v.eventId)).toEqual([open.id]);
  });

  it('refuses numbers a listing cannot hold exactly', async () => {
    const huge = await sign(
      creator,
      manifestDraft('far-future-video', { publishedAt: '18446744073709551615' }),
    );
    expect(listNfxVideos(NS, [huge], [], NOW)).toEqual([]);
  });
});

describe('currentRevisions (NFX-02 §4)', () => {
  it('the newest revision of an address wins; ties go to the lower id', async () => {
    const old = await sign(creator, manifestDraft('revised-video', { title: 'v1' }));
    const newer = await sign(
      creator,
      manifestDraft('revised-video', { title: 'v2', createdAt: T0 + 60 }),
    );
    const listed = listNfxVideos(NS, [old, newer], [], NOW);
    expect(listed.map((v) => v.title)).toEqual(['v2']);

    const a = await sign(creator, manifestDraft('tied-video', { title: 'a', createdAt: T0 + 5 }));
    const b = await sign(creator, manifestDraft('tied-video', { title: 'b', createdAt: T0 + 5 }));
    const lower = a.id < b.id ? a : b;
    const picked = currentRevisions(manifestsIn(NS, [a, b]), NOW);
    expect(picked.map((m) => m.event.id)).toEqual([lower.id]);
  });

  it(`ignores a revision more than ${MAX_CLOCK_SKEW} s ahead, in favour of the honest one`, async () => {
    const honest = await sign(creator, manifestDraft('skewed-video', { title: 'honest' }));
    const ahead = await sign(
      creator,
      manifestDraft('skewed-video', { title: 'ahead', createdAt: NOW + MAX_CLOCK_SKEW + 1 }),
    );
    const near = await sign(
      creator,
      manifestDraft('near-video', { title: 'near', createdAt: NOW + MAX_CLOCK_SKEW }),
    );
    const titles = listNfxVideos(NS, [honest, ahead, near], [], NOW).map((v) => v.title);
    expect(titles).toEqual(['near', 'honest']);
  });

  it('an address is its author’s: the same d by another key is another video', async () => {
    const mine = await sign(creator, manifestDraft('shared-name'));
    const theirs = await sign(other, manifestDraft('shared-name', { createdAt: T0 + 9 }));
    const ids = listNfxVideos(NS, [mine, theirs], [], NOW).map((v) => v.id);
    expect(ids).toEqual([
      address(other.pubkey, 'shared-name'),
      address(creator.pubkey, 'shared-name'),
    ]);
  });
});

describe('deletions (NFX-02 §6)', () => {
  it('a valid deletion at least as new withdraws the manifest; an older one does not', async () => {
    const m = await sign(creator, manifestDraft('withdrawn-video', { createdAt: T0 + 10 }));
    const a = address(creator.pubkey, 'withdrawn-video');
    const same = await sign(creator, deletionDraft([a], T0 + 10));
    const older = await sign(creator, deletionDraft([a], T0 + 9));
    expect(listNfxVideos(NS, [m], [same], NOW)).toEqual([]);
    expect(listNfxVideos(NS, [m], [older], NOW)).toHaveLength(1);
  });

  it('a later revision republishes the video', async () => {
    const a = address(creator.pubkey, 'back-again');
    const first = await sign(creator, manifestDraft('back-again', { createdAt: T0 }));
    const del = await sign(creator, deletionDraft([a], T0 + 5));
    const again = await sign(creator, manifestDraft('back-again', { createdAt: T0 + 6 }));
    const listed = listNfxVideos(NS, [first, again], [del], NOW);
    expect(listed.map((v) => v.eventId)).toEqual([again.id]);
  });

  it('ignores a deletion by another key, one with an e tag, and one naming no address of ours', async () => {
    const m = await sign(creator, manifestDraft('kept-video'));
    const a = address(creator.pubkey, 'kept-video');
    const foreign = await sign(other, deletionDraft([a], T0 + 50));
    const withE = await sign(creator, deletionDraft([a], T0 + 50, [['e', m.id]]));
    const unrelated = await sign(
      creator,
      deletionDraft([address(creator.pubkey, 'some-other-video')], T0 + 50),
    );
    expect(deletionsIn([foreign, withE])).toEqual([]);
    expect(listNfxVideos(NS, [m], [foreign, withE, unrelated], NOW)).toHaveLength(1);
  });

  it('withoutDeleted and toNfxVideo compose to listNfxVideos', async () => {
    const m = await sign(creator, manifestDraft('composed-video'));
    const current = currentRevisions(manifestsIn(NS, [m]), NOW);
    const live = withoutDeleted(current, []);
    expect(live.map(toNfxVideo)).toEqual(listNfxVideos(NS, [m], [], NOW));
  });
});
