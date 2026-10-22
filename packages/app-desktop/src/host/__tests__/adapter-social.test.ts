/**
 * `DesktopNetworkAdapter` social + catalogue paths over L1 and a `FakeRelayPool`:
 * SE-5 `unreact` (a NIP-09 kind-5 of the viewer's OWN kind-7 ids — never a `-`, never anyone
 * else's), deletion-aware `stats()`, and Stage 1's "writes need a signer" rule.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { NostrEvent, NostrEventId, RelayUrl } from '@sovit/core';
import { NostrKind, mocks, nostr } from '@sovit/core';

import type { IpcError } from '../../ipc/errors.js';
import { SignerIdentity } from '../identity.js';
import { DELETION_KIND, buildUnreactDeletion, ownReactionIds } from '../social/reactions.js';
import type { SeededVideo } from './support/catalog.js';
import { seedVideos, storeReaction } from './support/catalog.js';
import { coreTestKit } from './support/core-helpers.js';
import type { Rig } from './support/rig.js';
import { rig } from './support/rig.js';

const kit = await coreTestKit();

let r: Rig | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    const err = e as IpcError;
    expect(err.message.startsWith(`${err.code}: `), err.message).toBe(true);
    return err.code;
  }
};

async function signedIn(): Promise<{
  r: Rig;
  viewer: InstanceType<typeof kit.TestSigner>;
  creator: InstanceType<typeof kit.TestSigner>;
  videos: SeededVideo[];
}> {
  const viewer = new kit.TestSigner();
  const creator = new kit.TestSigner();
  r = await rig({ identity: new SignerIdentity(viewer) });
  const videos = await seedVideos(kit, r.pool, creator, mocks.VIDEOS.slice(0, 4));
  return { r, viewer, creator, videos };
}

const publishedSince = (rr: Rig, n: number): NostrEvent[] =>
  rr.pool.published.slice(n).map((p) => p.event);

describe('unreact (SE-5)', () => {
  it('publishes ONE kind-5 referencing only the viewer’s own kind-7 ids on that video — never a "-"', async () => {
    const { r, viewer, videos } = await signedIn();
    const other = new kit.TestSigner();
    const v = videos[0]!.video;
    const elsewhere = videos[1]!.video;
    const a = r.host.adapter;

    // The viewer liked, then disliked (two own reactions); someone else liked; the viewer
    // also reacted to ANOTHER video.
    await a.react(v.id, '+');
    await a.react(v.id, '-');
    await a.react(elsewhere.id, '+');
    const theirs = await storeReaction(kit, r.pool, other, v, '+', 1_757_000_500);
    const mine = r.pool
      .events()
      .filter((e) => e.kind === NostrKind.Reaction && e.pubkey === viewer.pubkey);
    const mineOnV = mine.filter((e) => e.tags.some((t) => t[0] === 'e' && t[1] === v.id));
    expect(mineOnV).toHaveLength(2);

    const before = r.pool.published.length;
    await a.unreact(v.id);
    const added = publishedSince(r, before);

    // Never a kind-7 (a "-" would be a public dislike).
    expect(added.filter((e) => e.kind === NostrKind.Reaction)).toEqual([]);
    const deletions = added.filter((e) => e.kind === DELETION_KIND);
    expect(deletions).toHaveLength(1);
    const del = deletions[0]!;
    expect(del.pubkey).toBe(viewer.pubkey);
    expect(del.content).toBe('');
    const eTags = del.tags.filter((t) => t[0] === 'e').map((t) => t[1]);
    expect(new Set(eTags)).toEqual(new Set(mineOnV.map((e) => e.id)));
    expect(eTags).not.toContain(theirs.id);
    expect(eTags).not.toContain(v.id);
    for (const e of mine.filter((x) => !mineOnV.includes(x))) expect(eTags).not.toContain(e.id);
    expect(del.tags).toContainEqual(['k', '7']);
    // Only e + k tags: nothing else identifies anyone.
    expect(del.tags.every((t) => t[0] === 'e' || t[0] === 'k')).toBe(true);

    // Back to neutral: the other viewer's like still counts, ours does not.
    const s = await a.stats(v.id);
    expect(s).toMatchObject({ likes: 1, dislikes: 0 });
    expect(s.myReaction).toBeUndefined();
    // The other video keeps our like.
    expect((await a.stats(elsewhere.id)).myReaction).toBe('like');
  });

  it('with no own reaction it publishes no deletion at all', async () => {
    const { r, videos } = await signedIn();
    const before = r.pool.published.length;
    await r.host.adapter.unreact(videos[2]!.video.id);
    expect(publishedSince(r, before).filter((e) => e.kind === DELETION_KIND)).toEqual([]);
  });

  it('ownReactionIds drops a relay’s answer that is not the viewer’s (validly signed or not)', async () => {
    const { videos } = await signedIn();
    const v = videos[0]!.video;
    const viewer = new kit.TestSigner();
    const other = new kit.TestSigner();
    const theirs = await kit.sign(
      other,
      nostr.buildReactionEvent(
        { id: v.id, pubkey: v.author, kind: 21 },
        '+',
        1_757_000_001 as never,
      ),
    );
    const ours = await kit.sign(
      viewer,
      nostr.buildReactionEvent(
        { id: v.id, pubkey: v.author, kind: 21 },
        '+',
        1_757_000_002 as never,
      ),
    );
    // A lying relay: answers every query with everything, plus a forged "viewer" event.
    const forged = kit.tamper(ours, { content: '-' });
    const liar: nostr.PoolLike = {
      query: () => Promise.resolve([theirs, ours, forged]),
      subscribe: () => () => undefined,
      publish: () => Promise.resolve([]),
      close: () => undefined,
    };
    const client = new nostr.NostrClient({
      pool: liar,
      relays: [{ url: 'wss://liar.test' as RelayUrl, read: true, write: false }],
    });
    expect(await ownReactionIds(client, viewer.pubkey, v.id)).toEqual([ours.id]);
  });

  it('buildUnreactDeletion refuses an empty list and dedupes ids', () => {
    expect(() => buildUnreactDeletion([], 1 as never)).toThrow(RangeError);
    const id = 'a'.repeat(64) as NostrEventId;
    expect(buildUnreactDeletion([id, id], 5 as never)).toEqual({
      kind: 5,
      created_at: 5,
      tags: [
        ['e', id],
        ['k', '7'],
      ],
      content: '',
    });
  });
});

describe('stats()', () => {
  it('fills likes/dislikes/myReaction from L1 summarizeReactions (newest per pubkey)', async () => {
    const { r, viewer, videos } = await signedIn();
    const v = videos[0]!.video;
    const users = [new kit.TestSigner(), new kit.TestSigner(), new kit.TestSigner()];
    await storeReaction(kit, r.pool, users[0]!, v, '+', 1_757_000_100);
    await storeReaction(kit, r.pool, users[1]!, v, '-', 1_757_000_100);
    await storeReaction(kit, r.pool, users[2]!, v, '🔥', 1_757_000_100);
    // users[0] changes their mind: newest wins.
    await storeReaction(kit, r.pool, users[0]!, v, '-', 1_757_000_200);
    await storeReaction(kit, r.pool, viewer, v, '', 1_757_000_300); // '' = like (NIP-25)
    const s = await r.host.adapter.stats(v.id);
    expect(s).toEqual({
      paidViews: 0,
      satsToCreator: 0,
      reactions: 4,
      likes: 1,
      dislikes: 2,
      myReaction: 'like',
      comments: 0,
    });
    // Relay videos have no seeder count on the host: absent = unknown, never a guessed 0 (#23).
    expect('seedersOnline' in s).toBe(false);
  });

  it('honours NIP-09 only when the deletion is signed by the reaction’s author', async () => {
    const { r, videos } = await signedIn();
    const v = videos[0]!.video;
    const alice = new kit.TestSigner();
    const mallory = new kit.TestSigner();
    const like = await storeReaction(kit, r.pool, alice, v, '+', 1_757_000_100);
    // Mallory "deletes" Alice's like: ignored.
    r.pool.store(await kit.sign(mallory, buildUnreactDeletion([like.id], 1_757_000_200 as never)));
    expect((await r.host.adapter.stats(v.id)).likes).toBe(1);
    // Alice deletes it: honoured.
    r.pool.store(await kit.sign(alice, buildUnreactDeletion([like.id], 1_757_000_300 as never)));
    expect((await r.host.adapter.stats(v.id)).likes).toBe(0);
  });

  it('counts comments on the video, and a forged comment is not counted', async () => {
    const { r, viewer, videos } = await signedIn();
    const v = videos[0]!.video;
    await r.host.adapter.comment(v.id, 'first!');
    const c2 = await r.host.adapter.comment(v.id, 'second');
    await r.host.adapter.comment(v.id, 'a reply', c2.id);
    r.pool.inject(kit.tamper(c2.event, { content: 'forged' }));
    const s = await r.host.adapter.stats(v.id);
    expect(s.comments).toBe(3);
    const page = await r.host.adapter.comments(v.id, 'new');
    expect(page.items.map((c) => c.content).sort()).toEqual(['a reply', 'first!', 'second']);
    expect(page.items.every((c) => c.author === viewer.pubkey)).toBe(true);
    expect(page.items.find((c) => c.content === 'a reply')?.parent).toBe(c2.id);
    // A parent that is not a comment on this video is refused.
    expect(await codeOf(r.host.adapter.comment(v.id, 'x', videos[1]!.video.id))).toBe('not-found');
  });
});

describe('Stage 1 without a signer: every write rejects `no-signer:` and publishes nothing', () => {
  it.each([
    ['comment', (a: Rig['host']['adapter'], id: NostrEventId) => a.comment(id, 'hi')],
    ['react', (a: Rig['host']['adapter'], id: NostrEventId) => a.react(id, '+')],
    ['unreact', (a: Rig['host']['adapter'], id: NostrEventId) => a.unreact(id)],
    [
      'nutzap',
      (a: Rig['host']['adapter'], id: NostrEventId) => a.nutzap(id, 21 as never, mocks.MINTS.a),
    ],
    ['subscribe', (a: Rig['host']['adapter']) => a.subscribe(mocks.ME)],
    ['unsubscribe', (a: Rig['host']['adapter']) => a.unsubscribe(mocks.ME)],
    ['report', (a: Rig['host']['adapter'], id: NostrEventId) => a.report(id, 'spam')],
    [
      'recordProgress',
      (a: Rig['host']['adapter'], id: NostrEventId) => a.library.recordProgress(id, 3),
    ],
    [
      'setWatchLater',
      (a: Rig['host']['adapter'], id: NostrEventId) => a.library.setWatchLater(id, true),
    ],
    [
      'savePlaylist',
      (a: Rig['host']['adapter'], id: NostrEventId) =>
        a.library.savePlaylist({ title: 'x', videoIds: [id], isPrivate: false }),
    ],
    [
      'studio.upload',
      (a: Rig['host']['adapter']) =>
        a.studio.upload(
          {
            file: '/tmp/in.mp4',
            title: 't',
            description: '',
            tags: [],
            kind: 21,
            mints: [mocks.MINTS.a],
            satsPerBlock: 1 as never,
            split: { seeder: 50, creator: 50 },
          },
          () => undefined,
        ),
    ],
  ] as const)('%s', async (_name, call) => {
    r = await rig();
    await r.ready();
    const videos = await seedVideos(kit, r.pool, new kit.TestSigner(), mocks.VIDEOS.slice(0, 1));
    const before = r.pool.published.length;
    const workerCalls = r.worker().received.length;
    expect(await codeOf(call(r.host.adapter, videos[0]!.video.id))).toBe('no-signer');
    expect(r.pool.published.length).toBe(before);
    expect(r.worker().received.length).toBe(workerCalls);
  });

  it('identity reads report signed-out; library reads are empty, not errors', async () => {
    r = await rig();
    const a = r.host.adapter;
    expect(await a.me()).toBeNull();
    expect(await a.signer()).toMatchObject({ pubkey: null, locked: true });
    expect(await a.subscriptions()).toEqual([]);
    expect(await a.library.history()).toEqual({ items: [] });
    expect(await a.library.watchLater()).toEqual([]);
    expect(await a.library.liked()).toEqual([]);
    expect(await a.library.playlists()).toEqual([]);
    expect(await a.studio.myVideos()).toEqual({ items: [] });
    expect(await a.feed({ source: 'subscriptions' })).toEqual({ items: [] });
  });
});

describe('reads through L1', () => {
  it('feed/video/related/search/profile come from verified relay events only', async () => {
    const { r, creator, videos } = await signedIn();
    const a = r.host.adapter;
    const v = videos[0]!.video;
    // A tampered copy of a real video, served by a malicious relay, is dropped.
    r.pool.inject(kit.tamper(videos[1]!.event, { content: 'tampered' }));
    expect(await a.video(v.id)).toEqual(v);
    expect(await a.video('f'.repeat(64) as NostrEventId)).toBeNull();
    const author = await a.feed({ source: 'author', author: creator.pubkey });
    expect(author.items.map((x) => x.id).sort()).toEqual(videos.map((x) => x.video.id).sort());
    expect(author.items.find((x) => x.id === videos[1]!.video.id)?.description).toBe(
      videos[1]!.video.description,
    );
    const tags = await a.feed({ source: 'tags', tags: ['ceramics'] });
    expect(tags.items.every((x) => x.tags.includes('ceramics'))).toBe(true);
    const related = await a.related(v.id);
    expect(related.map((x) => x.id)).not.toContain(v.id);
    const found = await a.search({ text: 'hohmann' });
    expect(found.items.map((x) => x.id)).toEqual([v.id]);
    expect(await a.profile(creator.pubkey)).toBeNull();
  });

  it('no read relay configured → relay-down; a failing pool → relay-down', async () => {
    r = await rig();
    await r.host.adapter.updateSettings({ relays: [] });
    expect(await codeOf(r.host.adapter.feed({ source: 'trending' }))).toBe('relay-down');
    await r.host.adapter.updateSettings({
      relays: [{ url: 'wss://a.test' as RelayUrl, read: true, write: true }],
    });
    r.pool.query = () => Promise.reject(new Error('socket hang up'));
    for (const p of [
      r.host.adapter.feed({ source: 'trending' }),
      r.host.adapter.video('a'.repeat(64) as NostrEventId),
      r.host.adapter.stats('a'.repeat(64) as NostrEventId),
      r.host.adapter.comments('a'.repeat(64) as NostrEventId, 'new'),
      r.host.adapter.search({ text: 'x' }),
    ])
      expect(await codeOf(p)).toBe('relay-down');
  });
});

describe('library with a signer (NIP-51, private sets)', () => {
  it('watch later, history, liked and playlists round-trip through L1', async () => {
    const { r, viewer, videos } = await signedIn();
    const a = r.host.adapter;
    const [v0, v1] = [videos[0]!.video, videos[1]!.video];
    await a.library.setWatchLater(v1.id, true);
    expect((await a.library.watchLater()).map((v) => v.id)).toEqual([v1.id]);
    await a.library.recordProgress(v0.id, 42);
    const h = await a.library.history();
    expect(h.items.map((i) => [i.video.id, i.positionSec])).toEqual([[v0.id, 42]]);
    await a.react(v0.id, '+');
    expect((await a.library.liked()).map((v) => v.id)).toEqual([v0.id]);
    await a.unreact(v0.id);
    expect(await a.library.liked()).toEqual([]);
    const pl = await a.library.savePlaylist({
      title: 'Mine',
      videoIds: [v0.id, v1.id],
      isPrivate: true,
    });
    expect(pl).toMatchObject({ author: viewer.pubkey, title: 'Mine', isPrivate: true });
    expect((await a.library.playlists()).map((p) => p.id)).toEqual([pl.id]);
    // Private items were encrypted to the viewer's own key (the fake nip44 records calls).
    expect(viewer.calls.some((c) => c.method === 'nip44Encrypt' && c.peer === viewer.pubkey)).toBe(
      true,
    );
    await a.subscribe(videos[2]!.video.author);
    expect(await a.subscriptions()).toEqual([videos[2]!.video.author]);
  });
});
