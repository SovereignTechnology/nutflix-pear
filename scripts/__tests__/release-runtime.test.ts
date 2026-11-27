// nutflix-runtime's release notice (kind 30071, `d` = nutflix-runtime): one more product on the same
// scripts, with a versioned link, its five targets and its own three relays. Nothing about the two
// existing products may change: the events they produce and the relays they go to are pinned here.
//
// The vector in scripts/__fixtures__ is byte-identical to the one in nutflix-runtime
// (shells/pear-v3/scripts/release/__tests__/fixtures), whose test reads it with the app's own
// `notice.ts`. Both tests pin its sha256, so neither copy can move alone.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fixtures, runNode, scriptsDir, tempDir } from './helpers.js';

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
type Entry =
  | { path: string; kind: 'file'; exec: boolean; text: string }
  | { path: string; kind: 'link'; target: string };
interface Vector {
  input: {
    version: string;
    verlink: string;
    commit: string;
    createdAt: number;
    artifacts: Artifact[];
  };
  unsigned: Ev;
  signed: Ev;
  bundle: { name: string; sha256: string; bytes: number; entries: Entry[] };
}
interface Manifest {
  RUNTIME_D_TAG: string;
  RUNTIME_ARTIFACT_NAMES: readonly string[];
  unsignedEvent(o: Record<string, unknown>): Ev;
  treeDigest(dir: string): Promise<{ sha256: string; bytes: number }>;
}
interface Verify {
  checkEvent(ev: unknown, pk: string, d?: string): { verlink?: string; version: string };
  checkUnsignedRelease(ev: unknown, pk: string, d?: string): unknown;
  verifyRelease(
    ev: unknown,
    o: { allDir?: string; trustedPubkey?: string; d?: string },
  ): Promise<{ verlink?: string; files: Artifact[] }>;
}
interface Template {
  templateFor(files: string[], o: Record<string, unknown>): Promise<Ev>;
}
interface Result {
  relay: string;
  ok: boolean;
  message: string;
}
interface Publish {
  RELEASE_RELAYS: readonly string[];
  RUNTIME_RELEASE_RELAYS: readonly string[];
  RUNTIME_REQUIRED_RELAYS: readonly string[];
  relaysFor(d: string): readonly string[];
  publishRelease(o: Record<string, unknown>): Promise<{ signed: Ev; results: Result[] }>;
}

const load = async <T>(name: string): Promise<T> =>
  (await import(/* @vite-ignore */ join(scriptsDir, name))) as T;

const VECTOR_FILE = join(fixtures, 'nutflix-runtime-notice.vector.json');
/** The same pin as in nutflix-runtime's test: the two copies are one file. */
const VECTOR_SHA256 = 'd6299ca3209cdd0032e1609df95e0adf42c9cd923ce3e5fc7465d34595456850';
const vector = (): Vector => JSON.parse(readFileSync(VECTOR_FILE, 'utf8')) as Vector;

const KEY = 'y'.repeat(52);
const VERLINK = `pear://0.42.${KEY}`;
const COMMIT = 'ab'.repeat(20);
const CREATED = 1_800_000_000;
const LINK = `pear://${KEY}`;
/** What a publish of a runtime notice needs from the source, passed as the library allows. */
const RUNTIME_PUBLISH = { runtimeLink: LINK, nowS: CREATED };

let tmp: { dir: string; cleanup(): void };
beforeEach(() => {
  tmp = tempDir('release-runtime');
});
afterEach(() => {
  tmp.cleanup();
});

function writeBundle(dir: string, entries: readonly Entry[]): void {
  for (const e of entries) {
    const p = join(dir, ...e.path.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    if (e.kind === 'link') symlinkSync(e.target, p);
    else {
      writeFileSync(p, e.text);
      chmodSync(p, e.exec ? 0o755 : 0o644);
    }
  }
}

/** The five artifacts on disk, under the names a notice gives them. */
function writeFive(dir: string): string[] {
  const m = vector().bundle.entries;
  const paths: string[] = [];
  for (const name of [
    'Nutflix-darwin-arm64.app',
    'Nutflix-darwin-x64.app',
    'Nutflix-linux-arm64.AppImage',
    'Nutflix-linux-x64.AppImage',
    'Nutflix-win32-x64.msix',
  ]) {
    const p = join(dir, name);
    if (name.endsWith('.app')) writeBundle(p, m);
    else writeFileSync(p, `the bytes of ${name}`);
    paths.push(p);
  }
  return paths;
}

const sign = (t: Ev, sk: Uint8Array): Ev =>
  finalizeEvent({ kind: t.kind, created_at: t.created_at, tags: t.tags, content: t.content }, sk);

/** Every release that is not nutflix-runtime's: the desktop app, and the NFX node under both its names. */
const OTHERS = ['nutflix-desktop', 'nfx', 'nutflixd'] as const;

describe('the existing releases do not change', () => {
  // Written out from the code as it was before nutflix-runtime was added.
  const A = { name: 'Nutflix-0.1.0-x64.AppImage', sha256: 'a'.repeat(64), bytes: 10 };
  const B = { name: 'nutflix_0.1.0_amd64.deb', sha256: 'b'.repeat(64), bytes: 32 };
  const content = `${A.sha256}  ${A.name}\n${B.sha256}  ${B.name}\n`;
  const x = createHash('sha256').update(content, 'utf8').digest('hex');
  const event = (d: string): Record<string, unknown> => ({
    id: '',
    pubkey: '83d8bce2f7d6966f306e6f1a712497cf0a2c77d073923136a0e2bb54963b3434',
    created_at: CREATED,
    kind: 30071,
    tags: [
      ['d', d],
      ['version', '0.1.0'],
      ['commit', COMMIT],
      ['x', x],
      ['files', '2'],
      ['size', '42'],
      ['artifact', A.name, A.sha256, '10'],
      ['artifact', B.name, B.sha256, '32'],
    ],
    content,
    sig: '',
  });

  it.each(OTHERS)('%s: the same event, byte for byte', async (d) => {
    const m = await load<Manifest>('release-manifest.mjs');
    const got = m.unsignedEvent({
      artifacts: [B, A],
      version: '0.1.0',
      commit: COMMIT,
      createdAt: CREATED,
      d,
    });
    expect(JSON.stringify(got)).toBe(JSON.stringify(event(d)));
  });

  it.each(OTHERS)('%s refuses a versioned link', async (d) => {
    const m = await load<Manifest>('release-manifest.mjs');
    expect(() =>
      m.unsignedEvent({
        artifacts: [A],
        version: '0.1.0',
        createdAt: CREATED,
        d,
        verlink: VERLINK,
      }),
    ).toThrow(/has no versioned link/);
  });

  it('the same relays, in the same order', async () => {
    const p = await load<Publish>('release-publish.mjs');
    const before = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.ditto.pub'];
    expect(p.RELEASE_RELAYS).toEqual(before);
    expect(p.relaysFor('nutflix-desktop')).toBe(p.RELEASE_RELAYS);
    expect(p.relaysFor('nfx')).toBe(p.RELEASE_RELAYS);
    expect(p.relaysFor('nutflixd')).toBe(p.RELEASE_RELAYS);
  });

  it.each(OTHERS)('%s still takes a regular file only', async (d) => {
    const v = await load<Verify>('release-verify.mjs');
    const sk = generateSecretKey();
    const name = 'Nutflix-0.1.0-x64.AppImage';
    mkdirSync(join(tmp.dir, name));
    const m = await load<Manifest>('release-manifest.mjs');
    const t = m.unsignedEvent({
      artifacts: [{ name, sha256: 'a'.repeat(64), bytes: 0 }],
      version: '0.1.0',
      createdAt: CREATED,
      d,
    });
    await expect(
      v.verifyRelease(sign(t, sk), { allDir: tmp.dir, trustedPubkey: getPublicKey(sk), d }),
    ).rejects.toThrow(/not a regular file/);
  });

  it.each(OTHERS)('%s publishes to its old relays', async (d) => {
    const p = await load<Publish>('release-publish.mjs');
    const m = await load<Manifest>('release-manifest.mjs');
    const sk = generateSecretKey();
    const name = 'Nutflix-0.1.0-x64.AppImage';
    writeFileSync(join(tmp.dir, name), 'bytes');
    const sha256 = createHash('sha256').update('bytes').digest('hex');
    const t = m.unsignedEvent({
      artifacts: [{ name, sha256, bytes: 5 }],
      version: '0.1.0',
      createdAt: CREATED,
      d,
    });
    let to: readonly string[] = [];
    await p.publishRelease({
      event: sign(t, sk),
      dir: tmp.dir,
      trustedPubkey: getPublicKey(sk),
      d,
      confirm: () => Promise.resolve(true),
      publish: (relays: readonly string[]) => {
        to = relays;
        return Promise.resolve(relays.map((relay) => ({ relay, ok: true, message: '' })));
      },
      save: () => 'unused',
      log: () => undefined,
    });
    expect(to).toEqual(['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.ditto.pub']);
  });
});

describe('the vector shared with nutflix-runtime', () => {
  it('is the pinned file', () => {
    expect(createHash('sha256').update(readFileSync(VECTOR_FILE)).digest('hex')).toBe(
      VECTOR_SHA256,
    );
  });

  it('is what these scripts produce, byte for byte', async () => {
    const m = await load<Manifest>('release-manifest.mjs');
    const v = vector();
    const got = m.unsignedEvent({
      artifacts: v.input.artifacts,
      version: v.input.version,
      commit: v.input.commit,
      createdAt: v.input.createdAt,
      d: m.RUNTIME_D_TAG,
      verlink: v.input.verlink,
    });
    expect(JSON.stringify(got)).toBe(JSON.stringify(v.unsigned));
  });

  it('verifies, signed', async () => {
    const c = await load<Verify>('release-verify.mjs');
    const v = vector();
    const r = c.checkEvent(v.signed, v.signed.pubkey, 'nutflix-runtime');
    expect(r.verlink).toBe(v.input.verlink);
    expect(r.version).toBe(v.input.version);
  });

  it('its bundle has the digest the app computes', async () => {
    const m = await load<Manifest>('release-manifest.mjs');
    const v = vector();
    const dir = join(tmp.dir, v.bundle.name);
    writeBundle(dir, v.bundle.entries);
    expect(await m.treeDigest(dir)).toEqual({ sha256: v.bundle.sha256, bytes: v.bundle.bytes });
  });
});

describe('a nutflix-runtime notice', () => {
  const input = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    artifacts: vector().input.artifacts,
    version: '0.2.0',
    createdAt: CREATED,
    d: 'nutflix-runtime',
    verlink: VERLINK,
    ...over,
  });

  it.each([
    ['no link', { verlink: undefined }],
    ['an unversioned link', { verlink: `pear://${KEY}` }],
    ['a version with a suffix', { version: '0.2.0-rc.1' }],
    ['four targets', { artifacts: vector().input.artifacts.slice(1) }],
    [
      'a name that is no target',
      {
        artifacts: [
          ...vector().input.artifacts.slice(1),
          { name: 'Nutflix-0.2.0-x64.AppImage', sha256: 'a'.repeat(64), bytes: 1 },
        ],
      },
    ],
  ])('refuses %s', async (_n, over) => {
    const m = await load<Manifest>('release-manifest.mjs');
    expect(() => m.unsignedEvent(input(over))).toThrow(/nutflix-runtime/);
  });

  it('a signed event with no link, or a second one, does not verify', async () => {
    const m = await load<Manifest>('release-manifest.mjs');
    const c = await load<Verify>('release-verify.mjs');
    const sk = generateSecretKey();
    const t = m.unsignedEvent(input());
    const noLink = { ...t, tags: t.tags.filter((x) => x[0] !== 'verlink') };
    expect(() => c.checkEvent(sign(noLink, sk), getPublicKey(sk), 'nutflix-runtime')).toThrow(
      /verlink/,
    );
    const two = { ...t, tags: [...t.tags, ['verlink', VERLINK]] };
    expect(() => c.checkEvent(sign(two, sk), getPublicKey(sk), 'nutflix-runtime')).toThrow(
      /verlink/,
    );
  });

  it.each(['d', 'version', 'verlink'])(
    'refuses a %s tag with a second value, which the app would refuse',
    async (name) => {
      const m = await load<Manifest>('release-manifest.mjs');
      const c = await load<Verify>('release-verify.mjs');
      const sk = generateSecretKey();
      const t = m.unsignedEvent(input());
      const tags = t.tags.map((x) => (x[0] === name ? [...x, 'extra'] : x));
      expect(() =>
        c.checkEvent(sign({ ...t, tags }, sk), getPublicKey(sk), 'nutflix-runtime'),
      ).toThrow(/exactly one value/);
    },
  );

  it('refuses more tags than the app reads', async () => {
    const m = await load<Manifest>('release-manifest.mjs');
    const c = await load<Verify>('release-verify.mjs');
    const sk = generateSecretKey();
    const t = m.unsignedEvent(input());
    const padded = (n: number): string[][] => [
      ...t.tags,
      ...Array.from({ length: n - t.tags.length }, (_, i) => ['n', String(i)]),
    ];
    expect(
      c.checkEvent(sign({ ...t, tags: padded(32) }, sk), getPublicKey(sk), 'nutflix-runtime')
        .verlink,
    ).toBe(VERLINK);
    expect(() =>
      c.checkEvent(sign({ ...t, tags: padded(33) }, sk), getPublicKey(sk), 'nutflix-runtime'),
    ).toThrow(/at most 32/);
  });

  it('is never read as another product, nor another as it', async () => {
    const m = await load<Manifest>('release-manifest.mjs');
    const c = await load<Verify>('release-verify.mjs');
    const sk = generateSecretKey();
    const ev = sign(m.unsignedEvent(input()), sk);
    for (const d of OTHERS) expect(() => c.checkEvent(ev, getPublicKey(sk), d)).toThrow(/not a /);
    const nfx = sign(
      m.unsignedEvent({
        artifacts: [{ name: 'nfx.tar.gz', sha256: 'a'.repeat(64), bytes: 1 }],
        version: '0.2.0',
        createdAt: CREATED,
        d: 'nfx',
      }),
      sk,
    );
    expect(() => c.checkEvent(nfx, getPublicKey(sk), 'nutflix-runtime')).toThrow(/not a /);
  });

  it('release-template builds one over the five files, and it verifies against them', async () => {
    const t = await load<Template>('release-template.mjs');
    const c = await load<Verify>('release-verify.mjs');
    const paths = writeFive(tmp.dir);
    const unsigned = await t.templateFor(paths, {
      d: 'nutflix-runtime',
      version: '0.2.0',
      commit: COMMIT,
      createdAt: CREATED,
      verlink: VERLINK,
    });
    expect(unsigned.tags.find((x) => x[0] === 'verlink')).toEqual(['verlink', VERLINK]);
    const sk = generateSecretKey();
    const r = await c.verifyRelease(sign(unsigned, sk), {
      allDir: tmp.dir,
      trustedPubkey: getPublicKey(sk),
      d: 'nutflix-runtime',
    });
    expect(r.verlink).toBe(VERLINK);
    expect(r.files).toHaveLength(5);
  });

  it('a changed file in a bundle fails the check', async () => {
    const t = await load<Template>('release-template.mjs');
    const c = await load<Verify>('release-verify.mjs');
    const paths = writeFive(tmp.dir);
    const unsigned = await t.templateFor(paths, {
      d: 'nutflix-runtime',
      version: '0.2.0',
      commit: COMMIT,
      createdAt: CREATED,
      verlink: VERLINK,
    });
    writeFileSync(join(tmp.dir, 'Nutflix-darwin-x64.app', 'Contents', 'Info.plist'), 'CHANGED!!');
    const sk = generateSecretKey();
    await expect(
      c.verifyRelease(sign(unsigned, sk), {
        allDir: tmp.dir,
        trustedPubkey: getPublicKey(sk),
        d: 'nutflix-runtime',
      }),
    ).rejects.toThrow(/Nutflix-darwin-x64\.app/);
  });

  it('a flipped executable bit in a bundle fails the check', async () => {
    const m = await load<Manifest>('release-manifest.mjs');
    const dir = join(tmp.dir, 'b.app');
    writeBundle(dir, vector().bundle.entries);
    const before = await m.treeDigest(dir);
    chmodSync(join(dir, 'Contents', 'MacOS', 'Nutflix'), 0o644);
    expect((await m.treeDigest(dir)).sha256).not.toBe(before.sha256);
  });

  it('refuses a path that is not a bundle directory', async () => {
    const m = await load<Manifest>('release-manifest.mjs');
    await expect(m.treeDigest(join(tmp.dir, 'missing'))).rejects.toThrow();
    const f = join(tmp.dir, 'file');
    writeFileSync(f, 'x');
    await expect(m.treeDigest(f)).rejects.toThrow(/not a directory/);
  });

  it('goes to exactly its three relays, and to nothing else', async () => {
    const p = await load<Publish>('release-publish.mjs');
    const t = await load<Template>('release-template.mjs');
    expect(p.RUNTIME_RELEASE_RELAYS).toEqual([
      'wss://relay.nutflix.xyz',
      'wss://relay.primal.net',
      'wss://relay.ditto.pub',
    ]);
    expect(Object.isFrozen(p.RUNTIME_RELEASE_RELAYS)).toBe(true);
    expect(p.relaysFor('nutflix-runtime')).toBe(p.RUNTIME_RELEASE_RELAYS);
    const paths = writeFive(tmp.dir);
    const unsigned = await t.templateFor(paths, {
      d: 'nutflix-runtime',
      version: '0.2.0',
      commit: COMMIT,
      createdAt: CREATED,
      verlink: VERLINK,
    });
    const sk = generateSecretKey();
    let to: readonly string[] = [];
    const lines: string[] = [];
    await p.publishRelease({
      event: sign(unsigned, sk),
      dir: tmp.dir,
      trustedPubkey: getPublicKey(sk),
      d: 'nutflix-runtime',
      ...RUNTIME_PUBLISH,
      confirm: (text: string) => {
        lines.push(text);
        return Promise.resolve(true);
      },
      publish: (relays: readonly string[]) => {
        to = relays;
        return Promise.resolve(relays.map((relay) => ({ relay, ok: true, message: '' })));
      },
      save: () => 'unused',
      log: () => undefined,
    });
    expect(to).toEqual(p.RUNTIME_RELEASE_RELAYS);
    expect(lines.join('\n')).toContain(`versioned link: ${VERLINK}`);
  });

  it('a dry run of the publish script contacts no relay', async () => {
    const p = await load<Publish>('release-publish.mjs');
    const t = await load<Template>('release-template.mjs');
    const paths = writeFive(tmp.dir);
    const unsigned = await t.templateFor(paths, {
      d: 'nutflix-runtime',
      version: '0.2.0',
      commit: COMMIT,
      createdAt: CREATED,
      verlink: VERLINK,
    });
    const sk = generateSecretKey();
    const r = await p.publishRelease({
      event: sign(unsigned, sk),
      dir: tmp.dir,
      trustedPubkey: getPublicKey(sk),
      d: 'nutflix-runtime',
      ...RUNTIME_PUBLISH,
      dryRun: true,
      publish: () => Promise.reject(new Error('must not publish')),
      log: () => undefined,
    });
    expect(r.results).toEqual([]);
  });

  describe('what may be published', () => {
    const signedNotice = async (
      over: Record<string, unknown> = {},
    ): Promise<{ ev: Ev; pk: string }> => {
      const t = await load<Template>('release-template.mjs');
      const paths = writeFive(tmp.dir);
      const unsigned = await t.templateFor(paths, {
        d: 'nutflix-runtime',
        version: '0.2.0',
        commit: COMMIT,
        createdAt: CREATED,
        verlink: VERLINK,
        ...over,
      });
      const sk = generateSecretKey();
      return { ev: sign(unsigned, sk), pk: getPublicKey(sk) };
    };
    const publish = async (
      ev: Ev,
      pk: string,
      over: Record<string, unknown> = {},
    ): Promise<{ results: Result[] }> => {
      const p = await load<Publish>('release-publish.mjs');
      return p.publishRelease({
        event: ev,
        dir: tmp.dir,
        trustedPubkey: pk,
        d: 'nutflix-runtime',
        ...RUNTIME_PUBLISH,
        confirm: () => Promise.resolve(true),
        publish: (relays: readonly string[]) =>
          Promise.resolve(relays.map((relay) => ({ relay, ok: true, message: '' }))),
        save: () => 'unused',
        log: () => undefined,
        ...over,
      });
    };

    it('nothing while the production link is not set', async () => {
      const { ev, pk } = await signedNotice();
      await expect(publish(ev, pk, { runtimeLink: null })).rejects.toThrow(
        /RUNTIME_PRODUCTION_LINK is not set/,
      );
    });

    it('not a version of another link', async () => {
      const { ev, pk } = await signedNotice();
      await expect(publish(ev, pk, { runtimeLink: `pear://${'b'.repeat(52)}` })).rejects.toThrow(
        /not a version of the production link/,
      );
    });

    it('not an empty version', async () => {
      const { ev, pk } = await signedNotice({ verlink: `pear://0.0.${KEY}` });
      await expect(publish(ev, pk)).rejects.toThrow(/empty version/);
    });

    it('not a date ahead of the clock', async () => {
      const { ev, pk } = await signedNotice();
      await expect(publish(ev, pk, { nowS: CREATED - 601 })).rejects.toThrow(/in the future/);
      expect((await publish(ev, pk, { nowS: CREATED - 600 })).results).toHaveLength(3);
    });

    it('fails unless both required relays took it, and tolerates relay.nutflix.xyz', async () => {
      const p = await load<Publish>('release-publish.mjs');
      expect(p.RUNTIME_REQUIRED_RELAYS).toEqual([
        'wss://relay.primal.net',
        'wss://relay.ditto.pub',
      ]);
      const { ev, pk } = await signedNotice();
      const answering =
        (refusing: string) =>
        (relays: readonly string[]): Promise<Result[]> =>
          Promise.resolve(relays.map((relay) => ({ relay, ok: relay !== refusing, message: '' })));
      expect(
        (await publish(ev, pk, { publish: answering('wss://relay.nutflix.xyz') })).results,
      ).toHaveLength(3);
      await expect(
        publish(ev, pk, { publish: answering('wss://relay.ditto.pub') }),
      ).rejects.toThrow(/did not reach wss:\/\/relay\.ditto\.pub/);
    });

    it.each([
      ['an empty tag', (t: string[][]) => [...t, []], /no empty tag/],
      [
        'a tag of seven items',
        (t: string[][]) => [...t, ['n', '1', '2', '3', '4', '5', '6']],
        /at most 6/,
      ],
      ['a value over 512', (t: string[][]) => [...t, ['n', 'x'.repeat(513)]], /at most 512/],
    ])('refuses %s, which the app would refuse', async (_n, change, re) => {
      const m = await load<Manifest>('release-manifest.mjs');
      const c = await load<Verify>('release-verify.mjs');
      const sk = generateSecretKey();
      const t = m.unsignedEvent(input());
      expect(() =>
        c.checkEvent(sign({ ...t, tags: change(t.tags) }, sk), getPublicKey(sk), 'nutflix-runtime'),
      ).toThrow(re);
    });

    it('refuses content over what the app reads', async () => {
      const m = await load<
        Manifest & { assertRuntimeBounds(e: { tags: string[][]; content: string }): void }
      >('release-manifest.mjs');
      const tags = m.unsignedEvent(input()).tags;
      expect(() => {
        m.assertRuntimeBounds({ tags, content: 'x'.repeat(16 * 1024) });
      }).not.toThrow();
      expect(() => {
        m.assertRuntimeBounds({ tags, content: 'x'.repeat(16 * 1024 + 1) });
      }).toThrow(/at most 16384 characters/);
    });
  });

  it('the command line refuses a runtime template without a link', () => {
    const paths = writeFive(tmp.dir);
    const r = runNode('release-template.mjs', [
      '--d',
      'nutflix-runtime',
      '--version',
      '0.2.0',
      '--commit',
      COMMIT,
      ...paths,
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/versioned link/);
  });
});
