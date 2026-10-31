/**
 * NFX catalog reads through `NostrClient` (contracts v9, ADR 0020; NFX-04 §5): pages under the
 * shared time cursor, one deletion query per page, single manifests by address.
 */
import { describe, expect, it, vi } from 'vitest';

import type { NfxAddress, NostrEvent, NostrFilter } from '../../contracts/index.js';
import {
  fetchNfxVideo,
  nfxAuthorsFeed,
  nfxTagsFeed,
  nfxVideoPage,
  searchNfxVideos,
} from '../nfx-feeds.js';
import { T0, TestSigner, rig, sign } from './helpers.js';

const NS = 'nfx:testnet:1';

function manifestDraft(videoId: string, createdAt: number, title = videoId, duration = '61') {
  return {
    kind: 38504,
    created_at: createdAt,
    content: `About ${title}.`,
    tags: [
      ['d', `${NS}:${videoId}`],
      ['n', NS],
      ['title', title],
      ['published_at', String(createdAt)],
      ['license', 'open'],
      ['root', 'ab'.repeat(32)],
      ['segs', '4'],
      ['duration', duration],
      ['t', 'space'],
    ],
  };
}

const addr = (author: string, videoId: string): NfxAddress =>
  `38504:${author}:${NS}:${videoId}` as NfxAddress;

async function seeded(n: number): Promise<{
  r: ReturnType<typeof rig>;
  creator: TestSigner;
  events: NostrEvent[];
}> {
  const r = rig();
  const creator = new TestSigner();
  const events: NostrEvent[] = [];
  for (let i = 0; i < n; i++) {
    const ev = await sign(
      creator,
      manifestDraft(`video-${String(i).padStart(3, '0')}`, T0 - 1000 + i),
    );
    r.pool.store(ev);
    events.push(ev);
  }
  return { r, creator, events };
}

describe('nfxVideoPage', () => {
  it('pages newest first under the time cursor, losing and repeating nothing', async () => {
    const { r, events } = await seeded(7);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await nfxTagsFeed(r.client, NS, ['space'], { limit: 3, cursor });
      seen.push(...page.items.map((v) => v.eventId));
      cursor = page.next;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([...events].reverse().map((e) => e.id));
  });

  it('asks for deletions of exactly the page’s addresses, and honours them', async () => {
    const { r, creator } = await seeded(3);
    const gone = addr(creator.pubkey, 'video-001');
    r.pool.store(
      await sign(creator, {
        kind: 5,
        created_at: T0,
        content: '',
        tags: [
          ['a', gone],
          ['k', '38504'],
        ],
      }),
    );
    const query = vi.spyOn(r.pool, 'query');
    const page = await nfxAuthorsFeed(r.client, NS, [creator.pubkey]);
    expect(page.items.map((v) => v.id)).toEqual([
      addr(creator.pubkey, 'video-002'),
      addr(creator.pubkey, 'video-000'),
    ]);
    const filters = query.mock.calls.map((c) => c[1] as NostrFilter);
    const deletionQuery = filters.find((f) => f.kinds?.includes(5));
    expect(deletionQuery?.authors).toEqual([creator.pubkey]);
    expect([...(deletionQuery?.['#a'] ?? [])].sort()).toEqual(
      ['video-000', 'video-001', 'video-002'].map((id) => addr(creator.pubkey, id)).sort(),
    );
    expect(filters.find((f) => f.kinds?.includes(38504))?.['#n']).toEqual([NS]);
  });

  it('a manifest from another namespace never lists, even if a relay returns it', async () => {
    const r = rig();
    const creator = new TestSigner();
    const draft = manifestDraft('mainnet-video', T0 - 5);
    const elsewhere = await sign(creator, {
      ...draft,
      tags: draft.tags.map((t) =>
        t[0] === 'd'
          ? ['d', 'nfx:mainnet:1:mainnet-video']
          : t[0] === 'n'
            ? ['n', 'nfx:mainnet:1']
            : t,
      ),
    });
    r.pool.inject(elsewhere); // a relay that ignores `#n`
    expect((await nfxVideoPage(r.client, NS, {})).items).toEqual([]);
  });

  it('an empty author list asks nothing', async () => {
    const r = rig();
    const query = vi.spyOn(r.pool, 'query');
    expect(await nfxAuthorsFeed(r.client, NS, [])).toEqual({ items: [] });
    expect(await nfxTagsFeed(r.client, NS, [' '])).toEqual({ items: [] });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('searchNfxVideos', () => {
  it('matches text and applies the duration limits locally', async () => {
    const r = rig();
    const creator = new TestSigner();
    r.pool.store(await sign(creator, manifestDraft('short-clip', T0 - 3, 'Kiln clip', '30')));
    r.pool.store(await sign(creator, manifestDraft('long-film', T0 - 2, 'Kiln film', '3600')));
    const all = await searchNfxVideos(r.client, NS, 'kiln');
    expect(all.items.map((v) => v.title)).toEqual(['Kiln film', 'Kiln clip']);
    const long = await searchNfxVideos(r.client, NS, 'kiln', { minDurationSec: 600 });
    expect(long.items.map((v) => v.title)).toEqual(['Kiln film']);
    expect(await searchNfxVideos(r.client, NS, '  ')).toEqual({ items: [] });
  });
});

describe('fetchNfxVideo', () => {
  it('returns the current revision of an address, whatever an older relay still holds', async () => {
    const r = rig();
    const creator = new TestSigner();
    const old = await sign(creator, manifestDraft('revised-video', T0 - 50, 'v1'));
    const current = await sign(creator, manifestDraft('revised-video', T0 - 10, 'v2'));
    r.pool.store(current);
    r.pool.inject(old); // a second relay that kept the older revision
    const v = await fetchNfxVideo(r.client, addr(creator.pubkey, 'revised-video'));
    expect(v?.title).toBe('v2');
    expect(v?.eventId).toBe(current.id);
  });

  it('is null once deleted, for an unknown address, and for a malformed one', async () => {
    const { r, creator } = await seeded(1);
    const a = addr(creator.pubkey, 'video-000');
    expect((await fetchNfxVideo(r.client, a))?.id).toBe(a);
    r.pool.store(
      await sign(creator, {
        kind: 5,
        created_at: T0,
        content: '',
        tags: [['a', a]],
      }),
    );
    expect(await fetchNfxVideo(r.client, a)).toBeNull();
    expect(await fetchNfxVideo(r.client, addr(creator.pubkey, 'never-published'))).toBeNull();
    expect(await fetchNfxVideo(r.client, 'not-an-address' as NfxAddress)).toBeNull();
  });
});
