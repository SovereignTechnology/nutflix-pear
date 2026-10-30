# Spike S-E — NFX CMAF played as one progressive fMP4 through the Range proxy

Date: 2026-10-29 (running) · Under test: Electron 44's Chromium (`<video src="nf-media://…">`, the
app's CSP and `protocol.handle` + `net.fetch` proxy) on CMAF from `media.packageNfx` (ffmpeg
`-f hls -hls_segment_type fmp4`, stream copy) · Host: GitHub Actions `ubuntu-24.04` under Xvfb
(the `e2e` job, `e2e/nfx-playback.e2e.ts`) · Plan: slice 3 of the nutflix-pear ⇄ nfx Phase 1

**Status: in progress. The verdict and the numbers below come from the CI run they quote.**

## Question

Can the desktop app play an NFX rendition (an init and 2 s `moof`/`mdat` segments, stored by
sha256) as one progressive file through the existing proxy, with a known duration and seeking by
byte range, so that NFX playback needs no CSP, scheme or MSE change? Which byte layout does it
take: the files as written (A), segments without their own index (B), or B with one global `sidx`
(C)?

## Method

A 90 s 720p clip, encoded by the real pipeline and packaged by `media.packageNfx`, stored in an
`NfxStore`. Three layouts of its first rendition (`nfx.progressiveLayout`; C's index from
`media.buildSidx`), each served by a loopback Range server reading through
`NfxStore.file().read` (`nfx.locate`), behind `nf-media://play/<variant>`. For each: metadata, a
finite duration near the hash list's, a seekable range, play, a seek to 60 s served by a new 206
Range inside the target segment's bytes, and (recorded) `ended`.

## Findings

To be written from the run.

## Decision

Pending the run. The rule: A passes → the view is the concatenation (C kept for producers whose
segments carry no index, if B fails); only C passes → the view always writes a global `sidx`;
none passes → an hls.js ADR.

## Open questions

Pending the run. Out of this spike: the worker serving NFX (its playback server reads Hypercore
blocks only), a free `play.open` path, rendition switching mid-play (slice 5).
