/**
 * Shared test samples (not a suite). Valid argument tuples for EVERY method — typed against
 * `MethodTable`, so a method added to the protocol without samples fails compilation — plus
 * invalid ones for the table-driven reject tests.
 */
import { mocks } from '@sovit/core';
import type {
  MeltQuote,
  MintQuote,
  MintUrl,
  NostrEventId,
  NostrPubkey,
  Sats,
  UnixSeconds,
} from '@sovit/core';

import type { FileToken, Method, MethodTable, SessionId, UploadId } from '../protocol.js';

export const VIDEO = mocks.VIDEOS[0]!;
export const VIDEO_ID: NostrEventId = VIDEO.id;
export const PUBKEY: NostrPubkey = mocks.ME;
export const MINT: MintUrl = mocks.MINTS.a;
export const SID = '0123456789abcdef0123456789abcdef' as SessionId;
export const UPLOAD_ID = 'fedcba9876543210fedcba9876543210' as UploadId;
export const TOKEN: FileToken = 'nf-file:00112233445566778899aabbccddeeff';
export const sats = (n: number): Sats => n as Sats;

export const MINT_QUOTE: MintQuote = {
  mint: MINT,
  quoteId: 'mockquote-1',
  amount: 1000,
  bolt11: 'lnbc10u1mockinvoicemockquote1',
  expiry: 1_757_000_600,
  state: 'UNPAID',
};
export const MELT_QUOTE: MeltQuote = {
  mint: MINT,
  quoteId: 'mockmelt-1',
  amount: 500,
  feeReserve: 5,
  expiry: 1_757_000_600,
  state: 'UNPAID',
};

type Samples = { readonly [M in Method]: readonly MethodTable[M][0][] };

/** At least one valid argument tuple per method. */
export const VALID: Samples = {
  signer: [[]],
  me: [[]],
  profile: [[PUBKEY]],
  setProfilePicture: [[{ bytes: Uint8Array.of(0xff, 0xd8, 0xff), type: 'image/jpeg' }]],
  'wallet.inputFeePpk': [[MINT]],
  feed: [
    [{ source: 'trending' }],
    [{ source: 'shorts', limit: 12, cursor: '12' }],
    [{ source: 'author', author: PUBKEY }],
    [{ source: 'tags', tags: ['physics', 'orbital-mechanics'] }],
  ],
  video: [[VIDEO_ID]],
  stats: [[VIDEO_ID]],
  related: [[VIDEO_ID], [VIDEO_ID, 6], [VIDEO_ID, undefined]],
  search: [
    [{ text: 'orbit' }],
    [
      {
        text: '',
        cursor: '10',
        filters: { since: 1_700_000_000 as UnixSeconds, tags: ['space'], author: PUBKEY },
      },
    ],
  ],
  comments: [
    [VIDEO_ID, 'new'],
    [VIDEO_ID, 'top', '20'],
  ],
  comment: [
    [VIDEO_ID, 'Great video!\nSecond line.'],
    [VIDEO_ID, 'reply', mocks.asEventId('c:parent')],
  ],
  react: [
    [VIDEO_ID, '+'],
    [VIDEO_ID, '-'],
    [VIDEO_ID, ''],
    [VIDEO_ID, '🔥'],
  ],
  unreact: [[VIDEO_ID]],
  nutzap: [
    [VIDEO_ID, sats(21), MINT],
    [VIDEO_ID, sats(1000), MINT, 'thanks!'],
  ],
  subscribe: [[PUBKEY]],
  unsubscribe: [[PUBKEY]],
  subscriptions: [[]],
  report: [[VIDEO_ID, 'spam']],
  'library.history': [[], ['20']],
  'library.recordProgress': [
    [VIDEO_ID, 0],
    [VIDEO_ID, 123.5],
  ],
  'library.watchLater': [[]],
  'library.setWatchLater': [
    [VIDEO_ID, true],
    [VIDEO_ID, false],
  ],
  'library.playlists': [[], [PUBKEY]],
  'library.savePlaylist': [
    [{ title: 'Ceramics', videoIds: [VIDEO_ID], isPrivate: false }],
    [{ id: 'pl-2', title: 'Mine', description: 'desc', videoIds: [], isPrivate: true }],
  ],
  'library.liked': [[]],
  play: [[VIDEO_ID], [VIDEO_ID, '720p']],
  image: [
    ['https://blossom.example/' + 'ab'.repeat(32)],
    ['https://blossom.example/thumb.jpg?x=1', mocks.asSha256('thumb')],
    ['nf-media://img/abc_DEF-123'],
  ],
  'session.pause': [[SID]],
  'session.resume': [[SID]],
  'session.setPrefetchSeconds': [
    [SID, 30],
    [SID, 0],
  ],
  'session.switchRendition': [[SID, '360p']],
  'session.close': [[SID]],
  'wallet.mints': [[]],
  'wallet.balance': [[MINT]],
  'wallet.balances': [[]],
  'wallet.mintQuote': [[MINT, sats(1000)]],
  'wallet.pollQuote': [[MINT_QUOTE]],
  'wallet.meltQuote': [[MINT, 'lnbc500n1pmockinvoice']],
  'wallet.melt': [[MELT_QUOTE]],
  'wallet.history': [[], [{ limit: 50 }], [{ mint: MINT }]],
  'studio.upload': [
    [
      {
        uploadId: UPLOAD_ID,
        file: TOKEN,
        title: 'My video',
        description: '',
        tags: ['space'],
        kind: 21,
        mints: [MINT],
        satsPerBlock: sats(2),
        split: { seeder: 50, creator: 50 },
      },
    ],
    [
      {
        uploadId: UPLOAD_ID,
        file: TOKEN,
        title: 'Short',
        description: 'd',
        tags: [],
        kind: 22,
        mints: [MINT, mocks.MINTS.b],
        satsPerBlock: sats(0),
        split: { seeder: 70, creator: 30 },
        thumbnailChoice: { bytes: new Uint8Array([0xff, 0xd8, 0xff]), type: 'image/jpeg' },
      },
    ],
    [
      {
        uploadId: UPLOAD_ID,
        file: TOKEN,
        title: 'Pick 2',
        description: '',
        tags: [],
        kind: 21,
        mints: [MINT],
        satsPerBlock: sats(1),
        split: { seeder: 100, creator: 0 },
        thumbnailChoice: 2,
      },
    ],
    // Contracts v8: a free video may also be packaged for NFX.
    [
      {
        uploadId: UPLOAD_ID,
        file: TOKEN,
        title: 'Free on NFX',
        description: '',
        tags: [],
        kind: 21,
        mints: [MINT],
        satsPerBlock: sats(0),
        split: { seeder: 50, creator: 50 },
        nfx: true,
      },
    ],
  ],
  'studio.myVideos': [[], ['10']],
  'studio.analytics': [[VIDEO_ID]],
  'seeder.status': [[]],
  'seeder.setEnabled': [[true], [false]],
  'seeder.melt': [[MINT, 'lnbc500n1pmockinvoice']],
  'seeder.unban': [[PUBKEY]],
  settings: [[]],
  updateSettings: [
    [{}],
    [{ theme: 'light' }],
    [{ prefetchSeconds: 60, hoverPreview: false }],
    [{ relays: [{ url: 'wss://relay.example' as never, read: true, write: false }] }],
    [{ defaultMints: [MINT], seeding: { enabled: true, diskCapBytes: 50 * 1024 ** 3 } }],
    [{ autoTopUp: { belowSats: sats(0), fromMint: MINT } }],
  ],
  'desktop.ffmpeg': [[{ recheck: false }], [{ recheck: true }]],
  'desktop.signer.info': [[]],
  'desktop.signer.connect': [[{ kind: 'local' }], [{ kind: 'nip46' }]],
  'desktop.signer.unlock': [[]],
  'desktop.signer.lock': [[]],
  'desktop.signer.signOut': [[]],
  'desktop.wallet.recovery.status': [[]],
  'desktop.wallet.recovery.setup': [[]],
  'desktop.wallet.recovery.show': [[]],
  'desktop.wallet.recovery.restore': [[]],
  'desktop.wallet.topUp.holds': [[]],
  'desktop.wallet.topUp.resume': [['0123456789abcdef']],
};

/** Hand-picked invalid argument lists per method (on top of the generic mutations). */
export const INVALID: Partial<Record<Method, readonly unknown[][]>> = {
  profile: [['npub1xyz'], [PUBKEY.toUpperCase()], [PUBKEY.slice(1)], [42]],
  setProfilePicture: [
    [{ bytes: Uint8Array.of(1), type: 'image/svg+xml' }],
    [{ bytes: 'ffd8', type: 'image/jpeg' }],
    [{ bytes: new Uint8Array(5 * 1024 * 1024 + 1), type: 'image/jpeg' }],
    [],
  ],
  feed: [
    [{ source: 'everything' }],
    [{ source: 'trending', limit: 0 }],
    [{ source: 'trending', limit: 10_000 }],
    [{ source: 'trending', limit: 1.5 }],
    [{ source: 'trending', cursor: 'x'.repeat(5000) }],
    [{ source: 'tags', tags: Array.from({ length: 257 }, () => 't') }],
    [{ source: 'trending', author: undefined }],
    [{ source: 'trending', __proto__: { polluted: true } }],
  ],
  related: [
    [VIDEO_ID, -1],
    [VIDEO_ID, '6'],
    [VIDEO_ID, 6, 7],
  ],
  comment: [
    [VIDEO_ID, ''],
    [VIDEO_ID, 'x'.repeat(16385)],
    [VIDEO_ID, 'nul\u0000byte'],
  ],
  react: [[VIDEO_ID, 'x'.repeat(65)]],
  nutzap: [
    [VIDEO_ID, 0, MINT],
    [VIDEO_ID, -5, MINT],
    [VIDEO_ID, 1.5, MINT],
    [VIDEO_ID, Number.MAX_SAFE_INTEGER, MINT],
    [VIDEO_ID, 21, 'http://mint.example'],
    [VIDEO_ID, 21, 'https://user:pw@mint.example'],
    [VIDEO_ID, 21, 'https://mint.example/?q=1'],
    [VIDEO_ID, 21, 'https://mint.example#frag'],
    [VIDEO_ID, 21, 'https://mint.example/'],
    [VIDEO_ID, 21, 'javascript:alert(1)'],
  ],
  'library.recordProgress': [
    [VIDEO_ID, -1],
    [VIDEO_ID, Number.NaN],
    [VIDEO_ID, Infinity],
  ],
  'library.savePlaylist': [
    [{ title: 'x', videoIds: [VIDEO_ID], isPrivate: false, author: PUBKEY }],
    [{ title: '', videoIds: [], isPrivate: false }],
    [{ title: 'x', videoIds: Array.from({ length: 1001 }, () => VIDEO_ID), isPrivate: false }],
    [{ title: 'x', videoIds: [], isPrivate: 'no' }],
  ],
  play: [[VIDEO_ID, ''], ['not-hex']],
  image: [
    ['http://blossom.example/a.jpg'],
    ['file:///etc/passwd'],
    ['https://user:pw@blossom.example/a.jpg'],
    ['https://blossom.example/a b.jpg'],
    ['data:image/png;base64,AAAA'],
    ['nf-media://play/abc'],
    ['https://blossom.example/' + 'a'.repeat(2100)],
  ],
  'session.pause': [['0123456789ABCDEF0123456789ABCDEF'], ['abc'], [SID + '0']],
  'session.setPrefetchSeconds': [
    [SID, -1],
    [SID, 601],
    [SID, Number.NaN],
  ],
  'wallet.mintQuote': [[MINT, 0]],
  'wallet.pollQuote': [[{ ...MINT_QUOTE, state: 'LOST' }], [{ ...MINT_QUOTE, extra: 1 }]],
  'wallet.melt': [[{ ...MELT_QUOTE, amount: -1 }], [{ ...MELT_QUOTE, mint: 'http://x' }]],
  'wallet.meltQuote': [
    [MINT, 'lnbc 500'],
    [MINT, ''],
  ],
  'studio.upload': [
    // SE-1: a raw path, never a token
    [{ ...VALID['studio.upload'][0]![0], file: '/home/user/.ssh/id_ed25519' }],
    [{ ...VALID['studio.upload'][0]![0], file: 'nf-file:../../etc/passwd' }],
    [{ ...VALID['studio.upload'][0]![0], file: { name: 'x.mp4', size: 1 } }],
    [{ ...VALID['studio.upload'][0]![0], split: { seeder: 60, creator: 60 } }],
    [{ ...VALID['studio.upload'][0]![0], split: { seeder: 50.5, creator: 49.5 } }],
    [{ ...VALID['studio.upload'][0]![0], mints: [] }],
    [{ ...VALID['studio.upload'][0]![0], kind: 1 }],
    [{ ...VALID['studio.upload'][0]![0], mirrorTo: ['http://blossom.example'] }],
    [
      {
        ...VALID['studio.upload'][0]![0],
        thumbnailChoice: { bytes: [1, 2, 3], type: 'image/jpeg' },
      },
    ],
    [
      {
        ...VALID['studio.upload'][0]![0],
        thumbnailChoice: { bytes: new Uint8Array(1), type: 'image/svg+xml' },
      },
    ],
    [{ ...VALID['studio.upload'][0]![0], thumbnailChoice: 64 }],
    [{ ...VALID['studio.upload'][0]![0], uploadId: undefined }],
    // Contracts v8: NFX never for a priced video (free only, issue #15), and only a boolean.
    [{ ...VALID['studio.upload'][0]![0], nfx: true }],
    [{ ...VALID['studio.upload'][0]![0], satsPerBlock: sats(0), nfx: 1 }],
  ],
  updateSettings: [
    [{ theme: 'neon' }],
    [{ relays: [{ url: 'ws://relay.example', read: true, write: true }] }],
    [{ relays: [{ url: 'wss://relay.example#x', read: true, write: true }] }],
    [{ relays: [{ url: 'wss://relay.example', read: true }] }],
    [{ defaultMints: ['http://mint.example'] }],
    [{ seeding: { enabled: true, diskCapBytes: -1 } }],
    [{ autoTopUp: { belowSats: -1, fromMint: MINT } }],
    [{ autoTopUp: undefined }],
    [{ prefetchSeconds: 1e9 }],
    [{ unknownSetting: true }],
  ],
  'desktop.ffmpeg': [[{}], [{ recheck: 'yes' }], [{ recheck: true, path: '/usr/bin/ffmpeg' }]],
  // The renderer names a kind only: no NIP-07 on desktop, and never a URI, flow or passphrase.
  'desktop.signer.connect': [
    [{ kind: 'nip07' }],
    [{ kind: 'nip46', uri: 'bunker://' + 'a'.repeat(64) + '?relay=wss://r.example' }],
    [{ kind: 'local', flow: 'generate' }],
    [{ kind: 'local', passphrase: 'hunter2' }],
    [{}],
  ],
  'desktop.signer.signOut': [[true]],
  // ADR 0016: the renderer names an action only — never words, indices, a phrase, a mint or a fee.
  'desktop.wallet.recovery.status': [[{}], [true]],
  'desktop.wallet.recovery.setup': [
    [{ words: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }],
    [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
    ['abandon ability able about above absent absorb abstract absurd abuse access accident'],
    [{ skipReissue: true }],
  ],
  'desktop.wallet.recovery.show': [[{ again: true }], ['now']],
  'desktop.wallet.recovery.restore': [
    ['abandon ability able about above absent absorb abstract absurd abuse access accident'],
    [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
    [{ mints: [MINT] }],
    [MINT],
  ],
  // R5-R1: a ledger entry id only — never a mint, an amount, a quote or a yes.
  'desktop.wallet.topUp.holds': [[{}], [true]],
  'desktop.wallet.topUp.resume': [
    [],
    [MINT],
    ['0123456789ABCDEF'],
    ['0123456789abcde'],
    [{ id: '0123456789abcdef', confirmed: true }],
    ['0123456789abcdef', true],
  ],
};
