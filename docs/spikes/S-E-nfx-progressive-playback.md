# Spike S-E — NFX CMAF played as one progressive fMP4 through the Range proxy

Date: 2026-10-30 · Under test: Electron 44's Chromium (`<video src="nf-media://…">`, the app's
CSP and `protocol.handle` + `net.fetch` proxy) on CMAF from `media.packageNfx` (ffmpeg
`-f hls -hls_segment_type fmp4`, stream copy) · Host: GitHub Actions `ubuntu-24.04` under Xvfb
(the `e2e` job, `e2e/nfx-playback.e2e.ts`) · Plan: slice 3 of the nutflix-pear ⇄ nfx Phase 1

**Verdict: PASS, with layout C.** An NFX rendition plays as one progressive file through the
existing proxy and CSP, with its exact duration and seeking by byte range, once the file is laid
out as **the init, one global `sidx`, then the segments without their own `styp`/`sidx`**. The
other two layouts never start in this architecture. No CSP, scheme, proxy or MSE change is
needed, so no hls.js ADR.

Runs: [40994094108](https://github.com/SovereignTechnology/nutflix-pear/actions/runs/40994094108)
(every CI job green; C passes, B and A fail) and
[40993406783](https://github.com/SovereignTechnology/nutflix-pear/actions/runs/40993406783), the
same result. Earlier runs, each named below, showed the failure modes.

## Question

Can the desktop app play an NFX rendition (an init and 2 s `moof`/`mdat` segments, stored by
sha256) as one progressive file through the existing proxy, with a known duration and seeking by
byte range? Which byte layout does it take:
- **A:** the files as written;
- **B:** segments without their own index;
- **C:** B with one global `sidx`?

## Method

- **The content:** a 90 s 720p clip (testsrc2 + a tone), encoded by the real pipeline
  (`createNodeMediaPipeline`) and packaged by `media.packageNfx`, stored in an `NfxStore`.
- **The layouts:** three layouts of its 720p rendition (`nfx.progressiveLayout`). C's index comes
  from `media.initTrack`, `media.segmentStart` and `media.buildSidx`.
- **Serving:** each layout is served by its own loopback Range server, which reads through
  `nfx.locate` and `NfxStore.file().read`. Electron's main proxies `nf-media://play/<layout>` to
  it as `main/media.ts` does.
- **Each layout is judged on a fresh page:**
  - metadata, and a finite duration within 0.5 s of the hash list's;
  - a seekable range, play and video size;
  - a seek to 60 s that lands, served by a new 206 Range inside the target segment's bytes;
  - (recorded) reaching `ended`.

## Findings

1. **What the packager writes.**
   - The init is `ftyp` + `moov`, with no usable duration of its own.
   - Every segment is `styp`, `sidx`, `sidx` (one per track), `moof`, `mdat`. The index boxes
     always lead.
   - 45 segments of 2 s; the video is track 1 at timescale 12800.
   - Sizes: A 29,270,623 B, B 29,264,863 B, C 29,265,443 B.
2. **C plays as a normal video.**
   - Metadata after **1 request in 20–44 ms** (26 ms in the green run).
   - Duration **90.022 s**, the exact sum of the segments; `seekable` [0, 90.022]; 1280×720.
   - A seek to 60 s lands at **60.0002 s**, through one new 206 (`bytes=18841600-`). It starts
     261 bytes before the segment because Chromium aligns ranges to 32 KiB.
   - It plays through to `ended`.
3. **B never starts.** With no index, Chromium's demuxer walks the file `moof` by `moof` to index
   it before it reports metadata (`bytes=1310720-`, `2621440-`, … in steps of two segments). It
   stalls at 6 open loaders and has no metadata after 60 s.
4. **A never starts either.** With an index per segment, the demuxer hops segment by segment
   (`bytes=655360-`, `1310720-`, …), reading each segment's own `sidx`. It stalls at 7 loaders
   and has no metadata after 60 s; in run 40987868694 it made 7 hops in 20 s. Its startup cost
   grows with the number of segments.
5. **A short 206 is read as the end of the file.** Capping each response at 1 MiB (run
   40992593963) made every layout "end" after its first MiB, and C's seek landed at the end.
   The server must answer the whole range asked for, as the worker's blob server does.
6. **Loaders the player leaves open can starve the next source.**
   - Each open loader holds a connection of the main process's `net.fetch` pool, which allows 6
     per host:port.
   - When layout A had opened 7 (run 40991896607), the next layout's requests never reached its
     server: they queued behind A's.
   - The app's `proxyPlay` (`main/media.ts`) forwards no abort to its upstream `fetch`. A
     seek-heavy session or a quick switch of source could therefore stall the legacy path as
     well. This is not fixed here; it is a follow-up.
7. **The pieces hold on real bytes.**
   - `nfx.renditionMembers`, `nfx.progressiveLayout`, `nfx.locate`, `media.initTrack`,
     `media.segmentStart`, `media.stripSegmentIndex` and `media.buildSidx` run on the real
     packager's output: in `node-real-ffmpeg-nfx.test.ts` (the test job) and in the e2e.
   - Every byte the player received came through `NfxStore.file().read` in reads of at most
     16 MiB.

## Decision

- **The NFX progressive view is layout C:**
  - the init;
  - one global `sidx` per rendition, with one reference per segment and `starts_with_SAP` set
    (every segment begins with an IDR frame);
  - each segment from its `moof` on.
- No CSP, scheme, proxy or MSE change, and no hls.js ADR.
- **For slice 5:**
  - **The worker serves C** from its own playback path: a free `play.open` for NFX, and a range
    server answering whole ranges, separate from the Hypercore blob server.
  - **No copies:** a segment without its index boxes is a suffix of the stored file, so a layout
    part is a stored file read from an offset (its `moof`), never a copy.
  - **The index is computed once:** it needs each segment's `tfdt` and the length of its leading
    boxes, so it is computed when the video is stored (or first played) and kept, not at every
    open.
  - **The proxy:** forward the player's abort to the upstream fetch, or otherwise keep a session
    from holding the pool (finding 6).

## Open questions

- Other packagers, nfx-media's included: segments without `styp`, or several `moof`s per segment
  (one reference per segment still covers them).
- The earliest presentation time: C uses the first `tfdt`, a decode time. Fine here; to watch
  with B-frames and edit lists.
- Long videos: a 2 h rendition is 3,600 references (43 KB of `sidx`); `reference_count` caps a
  rendition at about 36 h of 2 s segments.
- Rendition switching mid-play: the existing `switchRendition` opens a new session.
- Finding 6 in the legacy path: is it reachable by a person seeking?
