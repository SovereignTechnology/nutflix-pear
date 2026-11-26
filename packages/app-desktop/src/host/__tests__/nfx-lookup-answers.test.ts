/**
 * NFX-17 §3, the seeder's half of a lookup: which asks this app answers, to whom, how often, on
 * which relays, with which beacon, and when it stays silent. Asks are signed here with throwaway
 * keys (core's `TestSigner`); tells by a real seeder key, and every tell is read back with core's
 * `readLookupTell` as the viewer that asked would read it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  NfxAddress,
  NostrEvent,
  NostrFilter,
  NostrPubkey,
  RelayUrl,
  nostr,
} from '@sovit/core';
import { nfx } from '@sovit/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { memoryLogger } from '../log.js';
import { beaconContent, signBeaconEvent, type SignedBeacon } from '../nfx/beacons.js';
import {
  NfxLookupAnswers,
  NfxRelayShare,
  PAUSE_FIRST_S,
  SHARE_TELLS_PER_MIN,
  VIDEOS_PER_FILTER,
  askFilters,
  type NfxLookupAnswersDeps,
} from '../nfx/lookup-answers.js';
import { NfxSeederKey } from '../nfx/seeder-key.js';
import { coreTestKit, type TestSignerLike } from './support/core-helpers.js';
import { blobTicket, v4 } from './support/iroh-ticket.js';

const kit = await coreTestKit();
const NS = 'nfx:testnet:1';
const NOW = 1_790_000_000;
const SCOPED = 'wss://scoped.test' as RelayUrl;
const SCOPED2 = 'wss://scoped-two.test' as RelayUrl;
const READ = 'wss://read.test' as RelayUrl;
const READ2 = 'wss://read-two.test' as RelayUrl;
const CREATOR = 'd'.repeat(64) as NostrPubkey;
const NODE = 'e1'.repeat(32);
const IROH_RELAY = 'https://iroh-relay.test/';
const video = (i: number): string => `${NS}:nutflix-${i.toString(16).padStart(32, '0')}`;
const address = (i: number): NfxAddress => `38504:${CREATOR}:${video(i)}` as NfxAddress;
const PUBLIC_TICKET = blobTicket(NODE, [v4([9, 9, 9, 9], 4433)], IROH_RELAY);

let dir = '';
let key: NfxSeederKey;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nf-nfx-lookup-'));
  const user = new kit.TestSigner();
  key = await NfxSeederKey.open({
    dir: join(dir, 'nfx'),
    network: NS,
    user: user.pubkey,
    seal: user,
  });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface FakeSub {
  readonly relay: RelayUrl;
  readonly filters: readonly NostrFilter[];
  readonly onEvent: (raw: unknown) => void;
  readonly onClose: () => void;
  closed: boolean;
}

/** A beacon of this app for video `i`, signed at `at`, naming `addrs` and `tickets`. */
async function beacon(
  i: number,
  at: number,
  o: { addrs?: string[]; tickets?: string[] } = {},
): Promise<SignedBeacon> {
  const v = nfx.VideoAddr.parse(video(i));
  if (!v.ok) throw new Error('bad video');
  const tickets = o.tickets ?? [PUBLIC_TICKET];
  const content = beaconContent({
    video: v.value,
    endpoints: [
      {
        t: 'iroh',
        node: NODE,
        relay: IROH_RELAY,
        addrs: o.addrs ?? ['9.9.9.9:4433'],
        tickets: new Map(tickets.map((t, n) => [n === 0 ? 'meta' : `r${String(n)}`, t])),
      },
    ],
  });
  const event = await signBeaconEvent(key, address(i), content, at, memoryLogger());
  if (event === null) throw new Error('the beacon did not build');
  return { address: address(i), video: video(i), event, content, key };
}

/** An ask for video `i`, made at `at`, by `signer` (a fresh throwaway key by default). */
async function ask(
  i: number,
  at: number,
  signer: TestSignerLike = new kit.TestSigner(),
  extraTags: string[][] = [],
): Promise<NostrEvent> {
  const t = nfx.lookupAskTemplate(address(i), at);
  if (!t.ok) throw new Error(t.error.reason);
  return kit.sign(signer, { ...t.value, tags: [...t.value.tags, ...extraTags] });
}

/** Lets the signing and the publish of every answer in flight finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

function setup(over: Partial<NfxLookupAnswersDeps> = {}): {
  answers: NfxLookupAnswers;
  subs: FakeSub[];
  sent: { event: NostrEvent; relays: readonly RelayUrl[] }[];
  /** On `relay`, the live subscription's event handler. */
  deliver: (relay: RelayUrl, raw: unknown) => void;
  live: (relay: RelayUrl) => FakeSub | undefined;
  /** The relay ends its live subscription (a CLOSED, or the connection dropped). */
  drop: (relay: RelayUrl) => void;
  tick: () => void;
  at: (t: number) => void;
  answer: { fn: (url: RelayUrl) => nostr.PublishResult };
  sentTo: (relay: RelayUrl) => NostrEvent[];
} {
  let now = NOW;
  const subs: FakeSub[] = [];
  const sent: { event: NostrEvent; relays: readonly RelayUrl[] }[] = [];
  const ticks: (() => void)[] = [];
  const answer = { fn: (url: RelayUrl): nostr.PublishResult => ({ url, ok: true }) };
  const answers = new NfxLookupAnswers({
    scopedRelays: () => [SCOPED, SCOPED2],
    readRelays: () => [READ, READ2, `${SCOPED}/` as RelayUrl],
    subscribe: (relay, filters, onEvent, onClose) => {
      const s: FakeSub = { relay, filters, onEvent, onClose, closed: false };
      subs.push(s);
      return () => {
        s.closed = true;
      };
    },
    publish: (event, relays) => {
      sent.push({ event, relays });
      return Promise.resolve(relays.map((url) => answer.fn(url)));
    },
    now: () => now,
    log: memoryLogger(),
    timers: {
      setInterval: (fn) => {
        ticks.push(fn);
        return ticks.length;
      },
      clearInterval: () => undefined,
    },
    ...over,
  });
  const live = (relay: RelayUrl): FakeSub | undefined =>
    subs.filter((s) => s.relay === relay && !s.closed).at(-1);
  return {
    answers,
    subs,
    sent,
    deliver: (relay, raw) => {
      const s = live(relay);
      if (s === undefined) throw new Error(`no live subscription on ${relay}`);
      s.onEvent(raw);
    },
    live,
    drop: (relay) => {
      const s = live(relay);
      if (s === undefined) throw new Error(`no live subscription on ${relay}`);
      s.closed = true;
      s.onClose();
    },
    tick: () => {
      for (const t of ticks) t();
    },
    at: (t) => {
      now = t;
    },
    answer,
    sentTo: (relay) => sent.filter((x) => x.relays.includes(relay)).map((x) => x.event),
  };
}

/** The tell's embedded beacon, as the viewer that asked with `asker` reads it at `now`. */
function read(tell: NostrEvent, asker: string, a: string, now: number): nfx.LookupTell {
  const r = nfx.readLookupTell(tell, { now, asker, a });
  if (!r.ok) throw new Error(r.error.reason);
  return r.value;
}

describe('NfxLookupAnswers: listening', () => {
  it('subscribes on the scoped and the read relays, once each, for the videos it beacons', async () => {
    const x = setup();
    x.answers.start();
    expect(x.subs).toEqual([]); // nothing to answer for yet
    x.answers.serve(await beacon(1, NOW));
    expect(x.subs.map((s) => s.relay)).toEqual([SCOPED, SCOPED2, READ, READ2]);
    for (const s of x.subs) expect(s.filters).toEqual([nfx.lookupAskFilter(NS, [address(1)], NOW)]);
    // Another video: subscribed again with both, the old subscriptions closed.
    x.answers.serve(await beacon(2, NOW));
    expect(x.subs.filter((s) => !s.closed).map((s) => s.filters[0]?.['#a'])).toEqual(
      Array.from({ length: 4 }, () => [address(1), address(2)]),
    );
    expect(x.subs.slice(0, 4).every((s) => s.closed)).toBe(true);
    x.answers.stop();
    expect(x.subs.every((s) => s.closed)).toBe(true);
  });

  it('listens nowhere without a scoped relay, and stops when the beacons stop', async () => {
    const none = setup({ scopedRelays: () => [] });
    none.answers.start();
    none.answers.serve(await beacon(1, NOW));
    expect(none.subs).toEqual([]);

    const x = setup();
    x.answers.start();
    x.answers.serve(await beacon(1, NOW));
    expect(x.subs.filter((s) => !s.closed)).toHaveLength(4);
    // No round renewed it: the beacon expired, and the video is no longer answered for.
    x.at(NOW + 60);
    x.tick();
    expect(x.subs.filter((s) => !s.closed)).toEqual([]);
  });

  it('splits long lists at 250 videos a filter, per network', () => {
    const many = Array.from({ length: 600 }, (_, i) => address(i));
    const filters = askFilters(many, NOW);
    expect(filters.map((f) => f['#a']?.length)).toEqual([250, 250, 100]);
    expect(VIDEOS_PER_FILTER).toBeLessThanOrEqual(256);
    expect(filters.flatMap((f) => f['#a'])).toEqual(many);
    for (const f of filters) expect(f).toMatchObject({ kinds: [20465], '#n': [NS], '#t': ['ask'] });
    expect(filters[0]?.since).toBe(NOW - 60);
  });

  it('subscribes again after a relay closed it, with a growing wait, and every 10 minutes', async () => {
    const x = setup();
    x.answers.start();
    x.answers.serve(await beacon(1, NOW));
    x.drop(READ);
    x.tick();
    expect(x.live(READ)).toBeUndefined();
    x.at(NOW + 4);
    x.tick();
    expect(x.live(READ)).toBeUndefined();
    x.at(NOW + 5);
    x.tick();
    expect(x.live(READ)).toBeDefined();
    x.drop(READ); // at once again: 10 s this time
    x.at(NOW + 14);
    x.answers.serve(await beacon(1, NOW + 14));
    x.tick();
    expect(x.live(READ)).toBeUndefined();
    x.at(NOW + 15);
    x.tick();
    expect(x.live(READ)).toBeDefined();
    // The others were never closed; each is remade 10 minutes after it was made.
    const before = x.subs.length;
    x.at(NOW + 600);
    x.answers.serve(await beacon(1, NOW + 600));
    x.tick();
    expect(x.subs.length).toBe(before + 3);
    expect(x.subs.slice(before).map((s) => s.relay)).toEqual([SCOPED, SCOPED2, READ2]);
    x.at(NOW + 615);
    x.tick();
    expect(x.subs.length).toBe(before + 4);
    expect(x.subs.filter((s) => !s.closed)).toHaveLength(4);
  });
});

describe('NfxLookupAnswers: answering', () => {
  it('answers an ask with a tell to its signer that the viewer reads back (round trip)', async () => {
    const x = setup();
    x.answers.start();
    const b = await beacon(1, NOW);
    x.answers.serve(b);
    const viewer = new kit.TestSigner();
    x.deliver(SCOPED, await ask(1, NOW, viewer));
    await settle();
    expect(x.sent).toHaveLength(1);
    expect(x.sent[0]?.relays).toEqual([SCOPED]);
    const tell = x.sent[0]!.event;
    expect(tell.pubkey).toBe(key.pubkey);
    const got = read(tell, viewer.pubkey, address(1), NOW);
    expect(got.seeder).toBe(key.pubkey);
    expect(got.event).toEqual(b.event);
    // Not for anyone else, and not about another video.
    expect(nfx.readLookupTell(tell, { now: NOW, asker: CREATOR, a: address(1) }).ok).toBe(false);
    expect(nfx.readLookupTell(tell, { now: NOW, asker: viewer.pubkey, a: address(2) }).ok).toBe(
      false,
    );
  });

  it('answers the signer only, never a key a tag names', async () => {
    const x = setup();
    x.answers.start();
    x.answers.serve(await beacon(1, NOW));
    const viewer = new kit.TestSigner();
    const victim = new kit.TestSigner();
    x.deliver(SCOPED, await ask(1, NOW, viewer, [['x', victim.pubkey]]));
    // An ask with a `p` breaks §2: no answer at all.
    x.deliver(SCOPED, await ask(1, NOW, new kit.TestSigner(), [['p', victim.pubkey]]));
    await settle();
    expect(x.sent).toHaveLength(1);
    expect(x.sent[0]!.event.tags.filter((t) => t[0] === 'p')).toEqual([['p', viewer.pubkey]]);
  });

  it('answers nothing that is not a valid ask for a video it beacons', async () => {
    const x = setup();
    x.answers.start();
    x.answers.serve(await beacon(1, NOW));
    const good = await ask(1, NOW);
    const tellTemplate = nfx.lookupTellTemplate((await beacon(1, NOW)).event, CREATOR, NOW);
    if (!tellTemplate.ok) throw new Error('no tell');
    const notAnAsk = await kit.sign(new kit.TestSigner(), tellTemplate.value);
    for (const raw of [
      kit.tamper(good, { sig: '0'.repeat(128) }), // a forged signature
      kit.tamper(good, { content: 'hi' }),
      await ask(1, NOW - 61), // too old
      await ask(1, NOW + 31), // too far ahead
      await ask(2, NOW), // a video it does not beacon
      notAnAsk,
      await ask(1, NOW, new kit.TestSigner(), [['pad', 'x'.repeat(1100)]]), // over 1 KiB
      null,
      'an ask',
      { id: 'x' },
    ])
      x.deliver(SCOPED, raw);
    await settle();
    expect(x.sent).toEqual([]);
  });

  it('embeds a fresh beacon when the newest has under 30 s to live, and only then', async () => {
    const x = setup();
    x.answers.start();
    const b = await beacon(1, NOW);
    x.answers.serve(b);
    const viewer = new kit.TestSigner();
    x.at(NOW + 30);
    x.deliver(SCOPED, await ask(1, NOW + 30, viewer));
    await settle();
    expect(read(x.sent[0]!.event, viewer.pubkey, address(1), NOW + 30).event).toEqual(b.event);
    x.at(NOW + 31);
    x.deliver(SCOPED, await ask(1, NOW + 31, viewer));
    await settle();
    const fresh = read(x.sent[1]!.event, viewer.pubkey, address(1), NOW + 31);
    expect(fresh.event.created_at).toBe(NOW + 31);
    expect(fresh.expiration).toBe(BigInt(NOW + 91));
    expect(fresh.seeder).toBe(key.pubkey);
    expect(fresh.beacon.content.endpoints).toEqual(b.content.endpoints);
    // The next answer embeds that one: nothing is signed again for it.
    x.at(NOW + 32);
    x.deliver(SCOPED, await ask(1, NOW + 32));
    await settle();
    expect(nfx.readLookup(x.sent[2]!.event, NOW + 32).ok).toBe(true);
    expect(JSON.parse(x.sent[2]!.event.content)).toEqual(JSON.parse(JSON.stringify(fresh.event)));
  });

  it('answers only while the periodic beacon is live', async () => {
    const x = setup();
    x.answers.start();
    x.answers.serve(await beacon(1, NOW));
    x.at(NOW + 60);
    x.deliver(SCOPED, await ask(1, NOW + 60));
    await settle();
    expect(x.sent).toEqual([]);
    x.answers.stop();
    expect(() => {
      x.deliver(SCOPED, {});
    }).toThrow(/no live subscription/);
  });
});

describe('NfxLookupAnswers: budgets', () => {
  it('verifies at most 32 asks a second per relay, before any budget is charged', async () => {
    const x = setup();
    x.answers.start();
    x.answers.serve(await beacon(1, NOW));
    const viewer = new kit.TestSigner();
    // Forgeries in the viewer's name: each takes a verification on SCOPED, none a budget.
    for (let n = 0; n < 32; n++) {
      const forged = await ask(1, NOW - n, viewer);
      x.deliver(SCOPED, kit.tamper(forged, { sig: '0'.repeat(128) }));
    }
    const real = await ask(1, NOW, viewer);
    x.deliver(SCOPED, real);
    await settle();
    expect(x.sent).toEqual([]); // no verification left this second on SCOPED
    x.deliver(SCOPED2, real); // another relay has its own
    await settle();
    expect(x.sentTo(SCOPED2)).toHaveLength(1);
    // The forgeries spent nothing of the viewer's: its re-ask is still answered.
    x.at(NOW + 1);
    x.deliver(SCOPED, await ask(1, NOW + 1, viewer));
    await settle();
    expect(x.sentTo(SCOPED)).toHaveLength(1);
  });

  it('per (asker, video): 2 tells per 10 s', async () => {
    const x = setup();
    x.answers.start();
    x.answers.serve(await beacon(1, NOW));
    x.answers.serve(await beacon(2, NOW));
    const viewer = new kit.TestSigner();
    for (let n = 0; n < 3; n++) x.deliver(SCOPED, await ask(1, NOW - n, viewer));
    x.deliver(SCOPED, await ask(2, NOW, viewer)); // another video: its own count
    await settle();
    expect(x.sent).toHaveLength(3);
    x.at(NOW + 10);
    x.deliver(SCOPED, await ask(1, NOW + 10, viewer));
    await settle();
    expect(x.sent).toHaveLength(4);
  });

  it('per video: a burst of 8, then 1 a second', async () => {
    const x = setup();
    x.answers.start();
    x.answers.serve(await beacon(1, NOW));
    for (let n = 0; n < 9; n++) x.deliver(SCOPED, await ask(1, NOW));
    await settle();
    expect(x.sent).toHaveLength(8);
    x.at(NOW + 1);
    for (let n = 0; n < 2; n++) x.deliver(SCOPED, await ask(1, NOW + 1));
    await settle();
    expect(x.sent).toHaveLength(9);
  });

  it('in all: a burst of 32, then 4 a second', async () => {
    const x = setup();
    x.answers.start();
    for (let i = 1; i <= 5; i++) x.answers.serve(await beacon(i, NOW));
    // 33 asks over 5 videos (at most 7 each) and two relays (at most 17 each).
    for (let n = 0; n < 33; n++)
      x.deliver(n % 2 === 0 ? SCOPED : SCOPED2, await ask(1 + (n % 5), NOW));
    await settle();
    expect(x.sent).toHaveLength(32);
    x.at(NOW + 1);
    for (let n = 0; n < 5; n++) x.deliver(SCOPED, await ask(1 + n, NOW + 1));
    await settle();
    expect(x.sent).toHaveLength(36);
  });
});

describe('NfxLookupAnswers: relays one by one', () => {
  it('reuses one tell on each relay the ask reaches within 10 s, charged once; drops replays', async () => {
    const x = setup();
    x.answers.start();
    x.answers.serve(await beacon(1, NOW));
    const viewer = new kit.TestSigner();
    const first = await ask(1, NOW, viewer);
    x.deliver(SCOPED, first);
    await settle();
    x.at(NOW + 5);
    x.deliver(READ, first);
    x.deliver(SCOPED, first); // a replay where it was answered
    await settle();
    expect(x.sentTo(SCOPED)).toHaveLength(1);
    expect(x.sentTo(READ)).toHaveLength(1);
    expect(x.sentTo(READ)[0]).toBe(x.sentTo(SCOPED)[0]);
    // Charged once: the viewer's re-ask still has its second tell.
    x.deliver(SCOPED, await ask(1, NOW + 5, viewer));
    await settle();
    expect(x.sentTo(SCOPED)).toHaveLength(2);
    // Past 10 s from its first arrival, another relay gets nothing for it.
    x.at(NOW + 10);
    x.deliver(READ2, first);
    await settle();
    expect(x.sentTo(READ2)).toEqual([]);
    // Still remembered on SCOPED, whose new subscription replays it (stock relays keep events).
    x.answers.serve(await beacon(2, NOW + 10));
    x.deliver(SCOPED, first);
    await settle();
    expect(x.sentTo(SCOPED)).toHaveLength(2);
  });

  it('sends a general relay at most 15 tells a minute; a scoped relay only the table bounds', async () => {
    const x = setup();
    x.answers.start();
    for (let i = 1; i <= 3; i++) x.answers.serve(await beacon(i, NOW));
    const asks = await Promise.all(Array.from({ length: 16 }, (_, n) => ask(1 + (n % 3), NOW)));
    for (const a of asks) x.deliver(READ, a);
    await settle();
    expect(x.sentTo(READ)).toHaveLength(SHARE_TELLS_PER_MIN);
    // The same asks on a scoped relay: all 16 reuse their tells there, and the 16th is answered.
    for (const a of asks) x.deliver(SCOPED, a);
    await settle();
    expect(x.sentTo(SCOPED)).toHaveLength(16);
    // A reused tell counts against a general relay's share too.
    for (const a of asks) x.deliver(READ2, a);
    await settle();
    expect(x.sentTo(READ2)).toHaveLength(15);
    x.at(NOW + 60);
    x.answers.serve(await beacon(1, NOW + 60));
    x.deliver(READ, await ask(1, NOW + 60));
    await settle();
    expect(x.sentTo(READ)).toHaveLength(16);
  });

  it('backs off a relay that says rate-limited: or blocked:, doubling, until it accepts', async () => {
    const x = setup();
    x.answers.start();
    x.answers.serve(await beacon(1, NOW));
    let t = NOW;
    const tryAt = async (at: number): Promise<number> => {
      t = at;
      x.at(at);
      x.answers.serve(await beacon(1, at)); // the rounds go on meanwhile
      x.deliver(READ, await ask(1, at));
      await settle();
      return x.sentTo(READ).length;
    };
    x.answer.fn = (url) => ({ url, ok: false, reason: 'rate-limited: slow down' });
    expect(await tryAt(NOW)).toBe(1);
    expect(x.answers.paused(READ)).toBe(true);
    expect(x.answers.paused(SCOPED)).toBe(false);
    expect(await tryAt(NOW + PAUSE_FIRST_S - 1)).toBe(1);
    expect(await tryAt(NOW + 60)).toBe(2); // refused again: now 2 minutes
    expect(await tryAt(NOW + 60 + 119)).toBe(2);
    x.answer.fn = (url) => ({ url, ok: false, reason: 'blocked: not here' });
    expect(await tryAt(NOW + 180)).toBe(3); // and 4
    expect(await tryAt(NOW + 180 + 239)).toBe(3);
    x.answer.fn = (url) => ({ url, ok: true });
    expect(await tryAt(NOW + 420)).toBe(4); // accepted: the pause is over
    expect(x.answers.paused(READ)).toBe(false);
    x.answer.fn = (url) => ({ url, ok: false, reason: 'rate-limited: again' });
    expect(await tryAt(NOW + 421)).toBe(5);
    expect(await tryAt(NOW + 421 + 59)).toBe(5); // 1 minute again, not 8
    expect(await tryAt(NOW + 421 + 60)).toBe(6);
    expect(t).toBe(NOW + 481);
  });

  it('a timeout, a lost connection or another refusal is no reason to pause', () => {
    const share = new NfxRelayShare();
    for (const reason of ['publish timed out', 'connection failure: x', 'invalid: bad', 'error: x'])
      share.answered(READ, { url: READ, ok: false, reason }, NOW);
    share.answered(READ, { url: READ, ok: false }, NOW);
    expect(share.paused(READ, NOW)).toBe(false);
    // Spelled with a trailing slash, a relay is the same relay.
    share.answered(`${READ}/`, { url: READ, ok: false, reason: 'blocked: no' }, NOW);
    expect(share.paused(READ, NOW)).toBe(true);
    // Doubling stops at 30 minutes.
    for (let n = 0; n < 10; n++)
      share.answered(READ, { url: READ, ok: false, reason: 'blocked: no' }, NOW);
    expect(share.paused(READ, NOW + 1799)).toBe(true);
    expect(share.paused(READ, NOW + 1800)).toBe(false);
  });

  it('keeps the tells 10 a minute that beacons never take, for the day beacons go there', () => {
    const share = new NfxRelayShare();
    let beacons = 0;
    for (let n = 0; n < 25; n++) if (share.beacon(READ, NOW)) beacons++;
    expect(beacons).toBe(20);
    let tells = 0;
    for (let n = 0; n < 15; n++) if (share.tell(READ, NOW, true)) tells++;
    expect(tells).toBe(10);
    expect(share.tell(SCOPED, NOW, false)).toBe(true);
  });
});

describe('NfxLookupAnswers: address class', () => {
  it('answers only for a beacon whose every address, tickets included, is public', async () => {
    const x = setup();
    x.answers.start();
    x.answers.serve(await beacon(1, NOW));
    x.answers.serve(await beacon(2, NOW, { addrs: ['192.168.1.5:4433'] }));
    x.answers.serve(
      await beacon(3, NOW, {
        tickets: [
          PUBLIC_TICKET,
          blobTicket(NODE, [v4([9, 9, 9, 9], 4433), v4([10, 0, 0, 7], 4433)]),
        ],
      }),
    );
    x.answers.serve(await beacon(4, NOW, { tickets: [blobTicket('e2'.repeat(32), [])] }));
    x.answers.serve(await beacon(5, NOW, { tickets: ['blobaaaaaaaa'] }));
    // Listened for: the public one only.
    expect(x.live(SCOPED)?.filters[0]?.['#a']).toEqual([address(1)]);
    for (let i = 1; i <= 5; i++) x.deliver(SCOPED, await ask(i, NOW));
    await settle();
    expect(x.sent).toHaveLength(1);
    expect(x.sent[0]!.event.tags.find((t) => t[0] === 'a')?.[1]).toBe(address(1));
  });

  it('stops answering when a round signs a beacon that names a private address, and resumes', async () => {
    const x = setup();
    x.answers.start();
    x.answers.serve(await beacon(1, NOW));
    x.at(NOW + 30);
    x.answers.serve(await beacon(1, NOW + 30, { addrs: ['9.9.9.9:4433', '[fd00::5]:4433'] }));
    expect(x.live(SCOPED)).toBeUndefined();
    x.at(NOW + 60);
    x.answers.serve(await beacon(1, NOW + 60));
    x.deliver(SCOPED, await ask(1, NOW + 60));
    await settle();
    expect(x.sent).toHaveLength(1);
  });
});
