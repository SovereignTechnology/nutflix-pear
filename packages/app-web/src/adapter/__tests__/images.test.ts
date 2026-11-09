/**
 * `WebImages` on its own: the magic numbers it takes, the bounded cache (the oldest URL revoked
 * first, never the one just made), one request per hash at a time.
 */
import { describe, expect, it } from 'vitest';

import type { Sha256Hex } from '@sovit/core';

import type { FetchFn } from '../http.js';
import { WebImages, sniffImage } from '../images.js';

const png = (n: number): Uint8Array =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]);

async function sha(b: Uint8Array): Promise<Sha256Hex> {
  const d = await crypto.subtle.digest('SHA-256', b as BufferSource);
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join(
    '',
  ) as Sha256Hex;
}

function images(max: number, body: (url: string) => Uint8Array) {
  const made: string[] = [];
  const revoked: string[] = [];
  const asked: string[] = [];
  const fetchFn: FetchFn = (url) => {
    asked.push(url);
    return Promise.resolve(new Response(body(url) as BodyInit, { status: 200 }));
  };
  const imgs = new WebImages({
    fetch: fetchFn,
    createObjectURL: () => {
      made.push(`blob:${String(made.length + 1)}`);
      return made.at(-1)!;
    },
    revokeObjectURL: (u) => revoked.push(u),
    max,
  });
  return { imgs, made, revoked, asked };
}

describe('sniffImage', () => {
  it.each([
    [[0xff, 0xd8, 0xff, 0xe0], 'image/jpeg'],
    [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png'],
    [[0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 'image/webp'],
    [[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 'image/gif'],
    [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], 'image/gif'],
    [[0x3c, 0x73, 0x76, 0x67], null],
    [[0x3c, 0x68, 0x74, 0x6d, 0x6c], null],
    [[0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20], null],
    [[0xff, 0xd8], null],
    [[], null],
  ])('%j → %s', (bytes, type) => {
    expect(sniffImage(new Uint8Array(bytes))).toBe(type);
  });
});

describe('WebImages', () => {
  it('keeps at most `max` URLs and revokes the oldest first; a hit moves to the back', async () => {
    const bodies = [png(1), png(2), png(3)];
    const t = images(2, (url) => bodies[Number(url.slice(-1))]!);
    const h = await Promise.all(bodies.map(sha));
    const u0 = await t.imgs.image('https://img.example/0', h[0]);
    const u1 = await t.imgs.image('https://img.example/1', h[1]);
    expect(await t.imgs.image('https://img.example/0', h[0])).toBe(u0);
    const u2 = await t.imgs.image('https://img.example/2', h[2]);
    expect(t.revoked).toEqual([u1]);
    expect(u2).toBe('blob:3');
    t.imgs.clear();
    expect(t.revoked.sort()).toEqual([u0, u1, u2].sort());
  });

  it('a cache of 0 still hands back a live URL (it is taken as 1)', async () => {
    const t = images(0, () => png(1));
    const u = await t.imgs.image('https://img.example/a', await sha(png(1)));
    expect(t.revoked).not.toContain(u);
  });

  it('one request per hash at a time', async () => {
    const t = images(8, () => png(7));
    const h = await sha(png(7));
    const [a, b] = await Promise.all([
      t.imgs.image('https://img.example/a', h),
      t.imgs.image('https://img.example/b', h),
    ]);
    expect(a).toBe(b);
    expect(t.asked).toHaveLength(1);
  });

  it('arguments of the wrong type are refused, never thrown', async () => {
    const t = images(8, () => png(1));
    await expect(t.imgs.image(42 as never)).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(
      t.imgs.image('https://img.example/a', 'ab'.repeat(32) as Sha256Hex, 1.5),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(t.asked).toHaveLength(0);
  });
});
