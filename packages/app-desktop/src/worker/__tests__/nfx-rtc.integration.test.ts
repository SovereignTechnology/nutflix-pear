/**
 * #89 (ADR 0023): the worker's WebRTC pieces against the REAL helper. Two WebRTC nodes on loopback
 * (`allowPrivate`, no STUN): one serves a stored NFX video through `NfxRtcSeeding`, from a store
 * on disk named as the helper's `root`; the other offers, the first answers (the host's signaling,
 * done in-process here), and `RtcFetcher` fetches every segment the server announced, each
 * checked against the hash list. Then a file outside the store (refused by the helper's `root`)
 * and a hang-up.
 *
 * NFX-10 §1: STUN servers named over Nostr (`NfxRtcNode.setNamed`, the helper's `rtc-stun`) reach
 * the running helper without a restart, and what one reports is offered beside, never instead
 * of, what the configured server reports.
 *
 * Skipped without `NUTFLIX_IROH_HELPER` on a developer machine; in CI (ci.yml builds the helper)
 * it fails instead. Browsers are the `helper-webrtc` workflow's.
 */
import { createSocket } from 'node:dgram';
import { constants } from 'node:fs';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { nfx } from '@sovit/core';
import type { NfxStoreFile } from '@sovit/seeder';
import { silentLogger } from '@sovit/seeder';
import { describe, expect, it, vi } from 'vitest';

import { HelperError } from '../iroh/helper.js';
import type { NfxIrohStore } from '../nfx/iroh-seeding.js';
import { RtcFetcher } from '../nfx/rtc-fetcher.js';
import { NfxRtcNode } from '../nfx/rtc-node.js';
import type { NfxRtcConfig } from '../nfx/rtc-node.js';
import { NfxRtcSeeding } from '../nfx/rtc-seeding.js';
import { nodeHelperSpawn, tempDir } from './helpers/harness.js';
import { segments, testNfxVideo } from './helpers/nfx-video.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const HELPER = process.env['NUTFLIX_IROH_HELPER'] ?? '';
const IN_CI = (process.env['CI'] ?? '') !== '';
const MISSING =
  'NUTFLIX_IROH_HELPER names no iroh helper: CI builds one for this (ci.yml, the iroh-helper job)';
const LOOPBACK: NfxRtcConfig = { stun: [], bind: '127.0.0.1:0', allowPrivate: true };

/**
 * A STUN server on loopback (RFC 8489 Binding only) that reports `ip:port` (IPv4) as the mapping,
 * in XOR-MAPPED-ADDRESS, as a public server would report a NAT's.
 */
async function fakeStun(
  ip: string,
  port: number,
): Promise<{ readonly addr: string; readonly close: () => void }> {
  const sock = createSocket('udp4');
  sock.on('message', (msg, from) => {
    if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001) return;
    const res = Buffer.alloc(32);
    res.writeUInt16BE(0x0101, 0);
    res.writeUInt16BE(12, 2);
    res.writeUInt32BE(0x2112a442, 4);
    msg.copy(res, 8, 8, 20);
    res.writeUInt16BE(0x0020, 20);
    res.writeUInt16BE(8, 22);
    res.writeUInt8(1, 25);
    res.writeUInt16BE(port ^ 0x2112, 26);
    const magic = [0x21, 0x12, 0xa4, 0x42];
    ip.split('.').forEach((o, i) => res.writeUInt8(Number(o) ^ magic[i]!, 28 + i));
    sock.send(res, from.port, from.address);
  });
  await new Promise<void>((done) => sock.bind(0, '127.0.0.1', done));
  return { addr: `127.0.0.1:${String(sock.address().port)}`, close: () => sock.close() };
}

describe.skipIf(HELPER === '' && !IN_CI)('#89: the WebRTC side, worker to worker', () => {
  it('a stored video reaches another node over WebRTC, every segment checked', async () => {
    expect(HELPER, MISSING).not.toBe('');
    const bodies = segments(5);
    const v = testNfxVideo(bodies);
    const parsed = nfx.VideoAddr.parse(v.video);
    if (!parsed.ok) throw new Error('bad test video');
    const video = parsed.value;
    const tmp = await tempDir('nfx-rtc-');
    const root = join(tmp.dir, 'store');
    const nodes: NfxRtcNode[] = [];
    try {
      // The store on disk: every listed file under its sha256, as the NFX store keeps them.
      await mkdir(join(root, 'files'), { recursive: true });
      for (const [sha, bytes] of v.files) await writeFile(join(root, 'files', sha), bytes);
      const record = { video: v.video, root: v.root, segs: String(v.segs), files: [], addedAt: 0 };
      const store: NfxIrohStore = {
        videos: () => [record],
        file: (_video, sha): NfxStoreFile | undefined => {
          const bytes = v.files.get(sha);
          return bytes === undefined
            ? undefined
            : { size: bytes.length, read: (o, n) => Promise.resolve(bytes.slice(o, o + n)) };
        },
        path: (_video, sha) => (v.files.has(sha) ? join(root, 'files', sha) : undefined),
      };
      const node = async (name: string): Promise<NfxRtcNode> => {
        const stateDir = join(tmp.dir, name);
        await mkdir(stateDir, { recursive: true });
        const n = new NfxRtcNode({
          file: HELPER,
          spawn: nodeHelperSpawn,
          isExecutable: (p) =>
            access(p, constants.X_OK).then(
              () => true,
              () => false,
            ),
          stateDir,
          rmTree: (p) => rm(p, { recursive: true, force: true }),
          root,
          logger: silentLogger,
          retryMs: 50,
        });
        nodes.push(n);
        await n.set(LOOPBACK);
        return n;
      };
      const server = await node('server');
      const viewer = await node('viewer');

      const seeding = new NfxRtcSeeding({ node: server, store, logger: silentLogger });
      await seeding.set(true);
      await seeding.idle();
      const swarm = video.webStreamSwarmId('360p');
      expect(seeding.swarms(v.video)).toContain(swarm);

      // The host's signaling, in-process: the viewer offers, the server answers.
      const hv = await viewer.start();
      const hs = await server.start();
      if (hv === null || hs === null) throw new Error('a WebRTC node did not start');
      const offer = await hv.rtcOffer(swarm);
      const answer = await hs.rtcAnswer(swarm, offer.sdp);
      await hv.rtcAccept(offer.peer, answer.sdp);
      await vi.waitFor(
        () => {
          expect(viewer.connection(offer.peer)?.have).toEqual([[0, bodies.length - 1]]);
        },
        { timeout: 30_000, interval: 100 },
      );
      expect(server.connections(swarm)).toHaveLength(1);

      const fetcher = new RtcFetcher({
        video,
        root: v.root,
        segs: v.segs,
        client: () => viewer.start(),
        connections: (s) => viewer.connections(s),
        logger: silentLogger,
      });
      fetcher.learn(v.root, v.files.get(v.root)!);
      for (const [sha, bytes] of v.files) fetcher.learn(sha, bytes);
      for (const [i, body] of bodies.entries())
        await expect(fetcher.fetch(v.segmentShas[i]!, body.length, true)).resolves.toEqual(body);

      // A file outside the store is refused by the helper itself (`root`).
      const outside = join(tmp.dir, 'outside');
      await writeFile(outside, bodies[0]!);
      await expect(
        hs.rtcServe(swarm, [{ id: 0, path: outside, size: bodies[0]!.length }], true),
      ).rejects.toBeInstanceOf(HelperError);

      // A hang-up leaves the viewer's table at once, through the helper's `closed` event.
      await hv.rtcHangup(offer.peer);
      await vi.waitFor(
        () => {
          expect(viewer.connections(swarm)).toEqual([]);
        },
        { timeout: 10_000, interval: 50 },
      );
      await fetcher.close();
      await seeding.close();
      // A helper that goes away says so once, so the host forgets the ids it gave.
      let resets = 0;
      server.onReset(() => {
        resets += 1;
      });
      await server.close();
      expect(resets).toBe(1);
    } finally {
      for (const n of nodes) await n.close();
      await tmp.rm();
    }
  });

  it('NFX-10 §1: named STUN servers reach the running helper, beside its own and never instead', async () => {
    expect(HELPER, MISSING).not.toBe('');
    const own = await fakeStun('1.2.3.4', 40000);
    const named = await fakeStun('5.6.7.8', 40001);
    const tmp = await tempDir('nfx-rtc-stun-');
    const node = new NfxRtcNode({
      file: HELPER,
      spawn: nodeHelperSpawn,
      isExecutable: (p) =>
        access(p, constants.X_OK).then(
          () => true,
          () => false,
        ),
      stateDir: join(tmp.dir, 'state'),
      rmTree: (p) => rm(p, { recursive: true, force: true }),
      root: tmp.dir,
      logger: silentLogger,
      retryMs: 50,
    });
    const swarm = 'nfx/1/web/nfx:testnet:1:named-stun/720p';
    try {
      await mkdir(join(tmp.dir, 'state'), { recursive: true });
      await node.set({ ...LOOPBACK, stun: [own.addr] });
      const h = await node.start();
      if (h === null) throw new Error('the WebRTC node did not start');
      const offered = async (): Promise<string> => {
        const o = await h.rtcOffer(swarm);
        await h.rtcHangup(o.peer);
        return o.sdp;
      };
      const before = await offered();
      expect(before).toContain('1.2.3.4 40000 typ srflx');
      expect(before).not.toContain('5.6.7.8');

      const generation = node.generation;
      await node.setNamed([named.addr]);
      await vi.waitFor(
        async () => {
          const sdp = await offered();
          expect(sdp).toContain('5.6.7.8 40001 typ srflx');
          // The configured server's mapping stays, and comes first.
          expect(sdp.indexOf('1.2.3.4 40000 typ srflx')).toBeGreaterThan(-1);
          expect(sdp.indexOf('1.2.3.4 40000')).toBeLessThan(sdp.indexOf('5.6.7.8 40001'));
        },
        { timeout: 10_000, interval: 100 },
      );
      // Taken live: the same helper, no restart.
      expect(node.generation).toBe(generation);
      expect(node.current()).toBe(h);

      // None again: only the configured mapping.
      await node.setNamed([]);
      await vi.waitFor(
        async () => {
          expect(await offered()).not.toContain('5.6.7.8');
        },
        { timeout: 10_000, interval: 100 },
      );
      expect(node.generation).toBe(generation);
    } finally {
      await node.close();
      own.close();
      named.close();
      await tmp.rm();
    }
  });
});
