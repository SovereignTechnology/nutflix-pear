/**
 * Spike S-E — one NFX rendition as one progressive fMP4, played by Electron's Chromium through
 * the real `nf-media:` proxy and CSP. NEVER part of `npm test`; CI runs it in the e2e job:
 *
 *   NUTFLIX_E2E=1 node --test packages/app-desktop/e2e/nfx-playback.e2e.ts
 *
 * Content: a 90 s 720p clip (about 28 MB, so a seek to 60 s needs a new Range, as in the fidelity
 * spike), encoded by the real pipeline and packaged by `media.packageNfx` (CMAF,
 * 2 s segments), stored in an `NfxStore`. Three layouts of its first rendition, each served by
 * a loopback Range server that reads through `NfxStore.file().read` (`nfx.locate`):
 *
 *   A  the init, then the segments as ffmpeg wrote them
 *   B  the init, then the segments with their top-level `styp`/`sidx` removed (moof + mdat only)
 *   C  B with one global `sidx` after the init (`media.buildSidx`)
 *
 * Each is judged on: metadata, a finite duration near the hash list's, a seekable range, play,
 * a seek to ⅔ that lands and was served by a new 206 Range inside the target segment's bytes,
 * and (recorded) reaching `ended`. The findings print as JSON for docs/spikes/S-E-*.md. The
 * suite fails only if no layout plays fully: that is the case for an hls.js ADR instead.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { media, nfx } from '@sovit/core';
import {
  createNodeMediaPipeline,
  findFfmpeg,
  nodeFsAdapter,
  nodeProcessRunner,
  nodeSha256,
} from '@sovit/core/media/node';
import { NfxStore, nodeCrypto, nodeFs } from '@sovit/seeder';
import { build } from 'esbuild';
import type { ElectronApplication, Page } from 'playwright-core';

import { E2E, PKG, electronBinary, launch, sandboxReady } from './support.ts';

const SECONDS = 90;
/** Progress on stdout, so a stall in CI shows where it is. */
const step = (what: string): void => {
  process.stdout.write(`S-E: ${what}\n`);
};
/** No await in this suite may outlast a bound. */
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, no) =>
      setTimeout(() => {
        no(new Error(`timed out after ${String(ms)} ms: ${what}`));
      }, ms),
    ),
  ]);
const SEEK_TO = 60;
const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>nfx playback</title></head>
<body><video id="v" muted playsinline></video></body></html>`;

interface Served {
  readonly variant: string;
  readonly range: string;
  readonly status: number;
  readonly start: number | null;
}

interface Variant {
  readonly name: 'A' | 'B' | 'C';
  readonly layout: nfx.ProgressiveLayout;
  /** Index of the first segment's part in the layout. */
  readonly firstSegment: number;
}

function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'none' | 'bad' {
  if (header === undefined) return 'none';
  const m = /^bytes=(\d{0,16})-(\d{0,16})$/.exec(header);
  if (m === null || (m[1] === '' && m[2] === '')) return 'bad';
  if (m[1] === '') {
    const n = Number(m[2]);
    return n === 0 ? 'bad' : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start >= size || end < start ? 'bad' : { start, end };
}

void describe(
  'spike S-E: NFX CMAF as a progressive fMP4',
  { skip: E2E ? false : 'set NUTFLIX_E2E=1 to run (Electron)' },
  () => {
    let dir = '';
    let app: ElectronApplication | undefined;
    let page: Page;
    let server: ReturnType<typeof createServer> | undefined;
    const served: Served[] = [];
    const variants = new Map<string, Variant>();
    const findings: Record<string, unknown> = {};
    const consoleLines: string[] = [];
    let expectedSec = 0;
    let read: (p: nfx.ProgressivePiece) => Promise<Uint8Array> = () =>
      Promise.reject(new Error('no store'));

    before(
      async () => {
        const sandbox = sandboxReady(electronBinary());
        assert.ok(sandbox.ok, sandbox.why);
        const bins = findFfmpeg();
        assert.ok(bins !== undefined, 'system ffmpeg is required');
        dir = mkdtempSync(join(tmpdir(), 'nf-nfx-playback-'));

        // The content, as Studio makes it: the ladder encode, then the CMAF remux.
        const runner = nodeProcessRunner();
        const source = join(dir, 'source.mp4');
        const gen = await runner.run(bins.ffmpeg, [
          '-hide_banner',
          '-nostdin',
          '-y',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          `testsrc2=size=1280x720:rate=25:duration=${String(SECONDS)}`,
          '-f',
          'lavfi',
          '-i',
          `sine=frequency=440:sample_rate=48000:duration=${String(SECONDS)}`,
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-shortest',
          source,
        ]);
        assert.equal(gen.exitCode, 0, gen.stderr);
        const pipeline = createNodeMediaPipeline({
          binaries: bins,
          tmpDir: dir,
          preset: 'veryfast',
        });
        step('source encoded');
        const encoded = await pipeline.transcode(
          source,
          pipeline.plan(await pipeline.probe(source)),
          () => undefined,
        );
        const addr = nfx.VideoAddr.parse('nfx:regtest:1:s-e-clip');
        if (!addr.ok) throw new Error('video address');
        step('ladder transcoded');
        const packaged = await media.packageNfx(
          { runner, fs: nodeFsAdapter({ tmpDir: dir }), sha256: nodeSha256, binaries: bins },
          { video: addr.value, renditions: encoded.renditions },
        );
        const bytesOf = async (sha: string): Promise<Uint8Array> => {
          const f = packaged.files.find((x) => x.entry.sha256 === sha);
          if (f === undefined) throw new Error(`no file ${sha}`);
          return f.source.kind === 'bytes'
            ? f.source.bytes
            : new Uint8Array(await readFile(f.source.path));
        };

        // Stored as the worker stores NFX videos; every view reads back through the store.
        const store = new NfxStore({ fs: nodeFs, crypto: nodeCrypto, dataDir: join(dir, 'store') });
        await store.load();
        const put = await store.putVideo({
          video: addr.value,
          root: packaged.root,
          segs: packaged.segs,
          hashListBytes: packaged.hashListBytes,
          read: (e) => bytesOf(e.sha256),
        });
        assert.ok(put.ok, put.ok ? '' : put.message);
        read = async (p) => {
          if (p.part.kind === 'bytes') return p.part.bytes.subarray(p.offset, p.offset + p.length);
          const f = store.file(addr.value, p.part.sha256);
          if (f === undefined) throw new Error('not in the store');
          return f.read(p.offset, p.length);
        };

        const list = packaged.hashList;
        const rendition = list.renditions[0];
        assert.ok(rendition !== undefined, 'a rendition');
        const playlist = list.files.find((f) => f.name === rendition.playlist);
        assert.ok(playlist !== undefined, 'its playlist');
        const members = nfx.renditionMembers(list, await bytesOf(playlist.sha256));
        assert.ok(members.ok, members.ok ? '' : members.error.reason);
        const { init, segments } = members.value;
        expectedSec = segments.reduce((n, s) => n + Number(s.durMs ?? 0n), 0) / 1000;
        const initBytes = await bytesOf(init.sha256);
        const segBytes = await Promise.all(segments.map((s) => bytesOf(s.sha256)));
        const stripped = segBytes.map((b) => media.stripSegmentIndex(b));
        const track = media.initTrack(initBytes);
        const starts = segBytes.map((b) => media.segmentStart(b, track.trackId));
        const lastMs = Number(segments.at(-1)?.durMs ?? 0n);
        const end = (starts.at(-1) ?? 0) + Math.round((lastMs * track.timescale) / 1000);
        const sidx = media.buildSidx(
          track,
          stripped.map((b, i) => ({ size: b.length, start: starts[i] ?? 0 })),
          end,
        );
        const file = (e: nfx.FileEntry): nfx.ProgressivePart => ({
          kind: 'file',
          sha256: e.sha256,
          size: Number(e.size),
        });
        variants.set('A', {
          name: 'A',
          layout: nfx.progressiveLayout([file(init), ...segments.map(file)]),
          firstSegment: 1,
        });
        variants.set('B', {
          name: 'B',
          layout: nfx.progressiveLayout([
            file(init),
            ...stripped.map((bytes) => ({ kind: 'bytes' as const, bytes })),
          ]),
          firstSegment: 1,
        });
        variants.set('C', {
          name: 'C',
          layout: nfx.progressiveLayout([
            file(init),
            { kind: 'bytes', bytes: sidx },
            ...stripped.map((bytes) => ({ kind: 'bytes' as const, bytes })),
          ]),
          firstSegment: 2,
        });
        findings['content'] = {
          rendition: rendition.id,
          segments: segments.length,
          expectedSec,
          track,
          initBoxes: media.parseTopLevelBoxes(initBytes).map((b) => b.type),
          segmentBoxes: media
            .parseTopLevelBoxes(segBytes[0] ?? new Uint8Array())
            .map((b) => b.type),
          sizes: Object.fromEntries([...variants].map(([k, v]) => [k, v.layout.size])),
        };

        // The loopback Range server (the worker's blob server's job in the app).
        server = createServer((req: IncomingMessage, res: ServerResponse) => {
          void (async () => {
            const name = (req.url ?? '').slice(1);
            const v = variants.get(name);
            const header = req.headers.range;
            const log = (status: number, start: number | null): void => {
              served.push({ variant: name, range: header ?? '', status, start });
            };
            if (v === undefined) {
              log(404, null);
              res.writeHead(404).end();
              return;
            }
            const size = v.layout.size;
            const r = parseRange(header, size);
            if (r === 'bad') {
              log(416, null);
              res.writeHead(416, { 'content-range': `bytes */${String(size)}` }).end();
              return;
            }
            const { start, end: last } = r === 'none' ? { start: 0, end: size - 1 } : r;
            const pieces = nfx.locate(v.layout, start, last - start + 1);
            const status = r === 'none' ? 200 : 206;
            log(status, start);
            res.writeHead(status, {
              'content-type': 'video/mp4',
              'accept-ranges': 'bytes',
              'content-length': String(last - start + 1),
              ...(status === 206
                ? { 'content-range': `bytes ${String(start)}-${String(last)}/${String(size)}` }
                : {}),
            });
            if (req.method === 'HEAD') {
              res.end();
              return;
            }
            for (const p of pieces) {
              if (res.destroyed) return;
              const chunk = await read(p);
              if (!res.write(chunk)) await new Promise((ok) => res.once('drain', ok));
            }
            res.end();
          })().catch((e: unknown) => {
            process.stderr.write(`S-E server: ${e instanceof Error ? e.message : String(e)}\n`);
            res.destroy();
          });
        });
        await new Promise<void>((ok) => server?.listen(0, '127.0.0.1', ok));
        const port = (server.address() as { port: number }).port;

        const common = {
          bundle: true,
          absWorkingDir: PKG,
          logLevel: 'warning' as const,
          target: 'chrome152',
        };
        await build({
          ...common,
          entryPoints: [join(PKG, 'e2e', 'nfx-playback', 'main.ts')],
          outfile: join(dir, 'main.mjs'),
          format: 'esm',
          platform: 'node',
          external: ['electron'],
        });
        writeFileSync(join(dir, 'index.html'), HTML);
        step(
          `packaged, stored, serving on ${String(port)}: ${JSON.stringify(findings['content'])}`,
        );
        const launched = await within(
          launch(join(dir, 'main.mjs'), [], {
            NUTFLIX_NFX_PLAYBACK_BASE: `http://127.0.0.1:${String(port)}`,
          }),
          120_000,
          'Electron launch',
        );
        app = launched.app;
        page = launched.page;
        await page.waitForSelector('#v', { timeout: 20_000 });
        page.on('console', (m) => {
          consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 300));
        });
        step('Electron up');
      },
      { timeout: 10 * 60_000 },
    );

    after(async () => {
      process.stdout.write(`\nS-E FINDINGS ${JSON.stringify(findings, null, 2)}\n`);
      if (app !== undefined)
        await within(app.close(), 20_000, 'Electron close').catch(() => undefined);
      server?.close();
      if (dir !== '') rmSync(dir, { recursive: true, force: true });
    });

    void it(
      'plays at least one layout fully: duration, seekable, play, a seek by Range',
      { timeout: 6 * 60_000 },
      async () => {
        const passed: string[] = [];
        for (const v of variants.values()) {
          step(`variant ${v.name}`);
          const loaded = await within(
            page.evaluate(async (src: string) => {
              const el = document.getElementById('v') as HTMLVideoElement;
              const meta = new Promise<boolean>((ok) => {
                const t = setTimeout(() => {
                  ok(false);
                }, 20_000);
                el.addEventListener(
                  'loadedmetadata',
                  () => {
                    clearTimeout(t);
                    ok(true);
                  },
                  { once: true },
                );
              });
              // A fresh element for each layout: nothing carries over from the last one.
              el.pause();
              el.removeAttribute('src');
              el.load();
              el.src = src;
              const metadata = await meta;
              await Promise.race([
                el.play().catch(() => undefined),
                new Promise((r) => setTimeout(r, 10_000)),
              ]);
              const t0 = Date.now();
              while (el.currentTime <= 0.5 && Date.now() - t0 < 15_000 && el.error === null)
                await new Promise((r) => setTimeout(r, 100));
              return {
                metadata,
                duration: el.duration,
                seekable:
                  el.seekable.length > 0 ? [el.seekable.start(0), el.seekable.end(0)] : null,
                played: el.currentTime > 0.5,
                videoWidth: el.videoWidth,
                error: el.error?.code ?? null,
                errorMessage: el.error?.message ?? null,
                networkState: el.networkState,
                readyState: el.readyState,
                currentSrc: el.currentSrc,
              };
            }, `nf-media://play/${v.name}`),
            60_000,
            `${v.name} load`,
          );

          // Only requests made after this point can be the seek's.
          const mark = served.length;
          const seek = await within(
            page.evaluate(async (to: number) => {
              const el = document.getElementById('v') as HTMLVideoElement;
              const seeked = new Promise<boolean>((ok) => {
                const t = setTimeout(() => {
                  ok(false);
                }, 15_000);
                el.addEventListener(
                  'seeked',
                  () => {
                    clearTimeout(t);
                    ok(true);
                  },
                  { once: true },
                );
              });
              el.currentTime = to;
              return { seeked: await seeked, seekedTo: el.currentTime };
            }, SEEK_TO),
            30_000,
            `${v.name} seek`,
          );
          const k = Math.floor(SEEK_TO / 2);
          const from = v.layout.parts[v.firstSegment + Math.max(0, k - 1)]?.offset ?? Infinity;
          const target = v.layout.parts[v.firstSegment + k];
          const to = target === undefined ? -1 : target.offset + target.size;
          const seekRequests = served.slice(mark).filter((s) => s.variant === v.name);
          const byRange = seekRequests.some(
            (s) => s.status === 206 && s.start !== null && s.start >= from && s.start < to,
          );

          const ending = await within(
            page.evaluate(async (fallback: number) => {
              const el = document.getElementById('v') as HTMLVideoElement;
              const ended = new Promise<boolean>((ok) => {
                const t = setTimeout(() => {
                  ok(false);
                }, 15_000);
                el.addEventListener(
                  'ended',
                  () => {
                    clearTimeout(t);
                    ok(true);
                  },
                  { once: true },
                );
              });
              el.currentTime = Math.max(
                0,
                (Number.isFinite(el.duration) ? el.duration : fallback) - 1,
              );
              await Promise.race([
                el.play().catch(() => undefined),
                new Promise((r) => setTimeout(r, 10_000)),
              ]);
              const r = await ended;
              el.pause();
              return { ended: r, error: el.error?.code ?? null };
            }, expectedSec),
            40_000,
            `${v.name} end`,
          );

          const ok =
            loaded.metadata &&
            Number.isFinite(loaded.duration) &&
            Math.abs(loaded.duration - expectedSec) <= 0.5 &&
            loaded.seekable !== null &&
            (loaded.seekable[1] ?? 0) >= expectedSec - 1 &&
            loaded.played &&
            loaded.videoWidth > 0 &&
            loaded.error === null &&
            seek.seeked &&
            seek.seekedTo >= SEEK_TO - 0.1 &&
            byRange;
          const proxied = await within(
            app?.evaluate(() => (globalThis as Record<string, unknown>)['__nfxProxied']) ??
              Promise.resolve([]),
            10_000,
            'proxy log',
          ).catch(() => 'unreadable');
          const mine = served.filter((x) => x.variant === v.name);
          findings[v.name] = {
            passed: ok,
            served: mine.slice(0, 12),
            servedCount: mine.length,
            proxied: Array.isArray(proxied) ? proxied.slice(-12) : proxied,
            console: consoleLines.slice(-12),
            ...loaded,
            ...seek,
            seekRange: { byRange, window: [from, to], requests: seekRequests },
            ...ending,
          };
          if (ok) passed.push(v.name);
          step(`${v.name}: ${JSON.stringify(findings[v.name])}`);
        }
        findings['passed'] = passed;
        assert.ok(
          passed.length > 0,
          `no layout played fully: ${JSON.stringify(findings, null, 2)}`,
        );
      },
    );
  },
);
