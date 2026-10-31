/**
 * Contracts version (execution plan §0 rule 1).
 *
 * Bumped by the orchestrator, and only the orchestrator, whenever anything under
 * `packages/core/src/contracts/` changes. Every lane records the version it was issued
 * against in `docs/archive/lanes/<lane>.md`; a lane on a stale version is re-issued, never merged.
 *
 * History:
 *   1 — 2026-09-04 Stage 0 initial draft (pre-spike).
 *   2 — 2026-09-04 Post-spike, FROZEN for Stage 1 fan-out. S-A: `recordUpload` is
 *       synchronous-in-`upload`-handler, bans carry the Noise key, `bans()` added.
 *       S-B: `PlaySource` order/docs (service-worker primary, MSE fallback). S-C: new
 *       `media.ts` (pure-planning pipeline with injected `ProcessRunner`/`FsAdapter`).
 *   3 — 2026-09-04 Post-Wave-1 batch (ADR 0004). Additive; every v2 consumer compiles.
 *       (a) `NostrKind.ReleaseNotice = 30071` for the reproducible-build event (L9 request;
 *       30063 rejected — vendored NIP-51 owns it with a different shape). (b) `hyperUrl`
 *       doc corrected to the hex grammar L1/L8/fixtures implement; z32 never accepted.
 *       (c) L2 flag 1 ACCEPTED: `BlockRange.core?` — a `pay/1` channel spans many cores,
 *       policy is per video, so PAY must name the core; optional now, REQUIRED at the
 *       Stage 2 bump; `recordUpload(peer, blocks, core?)` alongside. (d) L2 flag 2
 *       ACCEPTED: `PaymentEngineSeeder.rebind(from, to)` replaces the replay-on-HELLO
 *       workaround for pre-HELLO accounting under the Noise-key hex.
 *   4 — 2026-09-23 Post-L5 (ADR 0007). Additive. (a) `VideoStats.likes`, `.dislikes`
 *       (required — dislikes are always shown) and `.myReaction?`. (b) `NetworkAdapter
 *       .unreact(videoId)` — NIP-09 deletion; un-like must never be sent as a `-` dislike.
 *       (c) `PricePolicy.split` doc points at ADR 0007 (min PAY size + creator carry,
 *       implemented in Stage 2). The Stage 2 bump planned as "v4" in docs/archive/status-2026-10-04.md is v5.
 *   5 — 2026-09-23 Stage 2 (ADR 0010). BREAKING for the money path, additive elsewhere.
 *       (a) `BlockRange.core` REQUIRED; `recordUpload(peer, blocks: BlockRange, policy)`
 *       records block INDEXES (distinct per core) and takes the core's policy (effective
 *       window). (b) Per-PAY split (ADR 0007): `PayMessage.carryIn`, carry + minimum PAY
 *       (`PricePolicy.minPaySats`, `DEFAULT_MIN_PAY_SATS` 10), `PeerWindow.windowBlocks` is the
 *       effective window; `pay(…, opts?.carryIn)`. The minimum is a batching target, not a
 *       seeder-side rejection (ADR 0010 §minimum). (c) `RejectReason` + `double-spend` (local
 *       seen-secret check). (d) pay/1: `HELLO.createdAt` + connection-
 *       bound `challenge` + `windowBlocks`, `ACK.core`, `PRICE.core`, `PAY_HELLO_KIND` /
 *       `NostrKind.PayHello` 21071. (e) Creator set bound to its seeder (`['pay1', p2pk]`
 *       NUT-10 tag); `Wallet.send` takes `tags`/`memo`. (f) `NostrKind.Deletion` 5;
 *       `VideoStats.seedersOnline?` (absent = unknown); `UploadInput.file` = file token on
 *       desktop; `Settings.autoTopUp` semantics normative; `SignerConnectRequest` /
 *       `SignerControl` (core side only; the NetworkAdapter bridge is Stage 3).
 *       Amended 2026-09-24 (Stage 3, no bump): the NIP-71 `minpay` tag is parsed (1 …
 *       `MAX_MIN_PAY_SATS`), and the part of the effective window a minimum PAY adds is capped
 *       at `MAX_MIN_PAY_WINDOW_BLOCKS` (64): a creator's tag must not open huge unpaid windows.
 *   6 — 2026-09-25 Stage 3 (Cameron: media on Pear only). BREAKING for uploads only:
 *       `UploadInput.mirrorTo` and the `mirroring` `UploadProgress` stage are removed — Studio
 *       no longer names or mirrors to Blossom servers, so our manifests carry sha256 +
 *       `hyper://` only. `blossom` / `fallback` tags in other publishers' events are still
 *       parsed and never fetched. (The gateway's Blossom endpoints stay: they are an HTTP face
 *       over its own Pear seeder.) Also (security review F18): `Settings.loadRemoteImages`
 *       (default `false`: only images with a signed sha256 load). And ADR 0015 (images over
 *       Pear): `Rendition.image.size?` + imeta `image-size` (required with a `hyper://` image,
 *       as is `image-x`), `MAX_IMAGE_BYTES`, `Profile.pictureSha256?/pictureSize?/bannerSha256?/
 *       bannerSize?`, `Settings.seeding.serveImages?`; `NetworkAdapter.setProfilePicture`;
 *       `Wallet.inputFeePpk` (mint fees shown in the price). And issue #2 (auto top-ups
 *       execute): `Settings.autoTopUp.amountSats?`, `AUTO_TOP_UP_MAX_SATS` (10 000) and
 *       `AUTO_TOP_UP_MAX_SATS_PER_DAY` (50 000, rolling 24 h).
 *       Amended 2026-09-26 (Stage 3, no bump; Cameron, amendments to ADRs 0015 and 0018),
 *       additive on pay/1: `PriceMessage.free?` (a seeder serves that core outside payment:
 *       `satsPerBlock` and `effectiveFromBlock` 0); `OwedMessage` (tag 5, seeder → viewer: the
 *       unpaid blocks of one core it still counts for the viewer's HELLO pubkey, canonical ranges
 *       bounded by `MAX_OWED_RANGES` 256 / `MAX_OWED_BLOCKS` 1024); `AckMessage.outstanding?`
 *       (after the PAY, the blocks of that core still counted); `PayProtocolEvents.owed` and
 *       `PayProtocol.sendOwed`. Normative for every seeder this repository builds: a core's
 *       `PRICE` (priced, or `free`) as soon as a peer has the core open on a pay/1 connection,
 *       unprompted, and in any case before its first block to that peer; `OWED` once both HELLOs
 *       verify (with the core's priced `PRICE` first); `outstanding` in every ACK
 *       (`pay-protocol.ts`). `PAY_PROTOCOL_VERSION` stays 1: a priced `PRICE` is byte-for-byte the
 *       v5 frame (its flags byte is written only with `free`), while an older build's codec
 *       refuses `OWED`, a `free` PRICE and an ACK carrying `outstanding`, and closes pay/1 (no
 *       deployed base yet).
 *   7 — 2026-10-02 (Cameron, R3/R4; ADR 0018 amendment). Additive: `pay-protocol.ts` rule 5 —
 *       the `OWED` report ends with an end marker (`core` `OWED_END_CORE`, no ranges), sent by
 *       every seeder this repository builds, also when nothing is owed, so a viewer knows the
 *       report is complete without waiting `REPORT_WAIT_MS`. `PAY_PROTOCOL_VERSION` stays 1: an
 *       older build's codec refuses the marker and closes pay/1 (no deployed base yet), as in v6.
 *   8 — 2026-10-24 (ADR 0020, Phase 1 slice 2b). Additive: `UploadInput.nfx?` — also package
 *       the upload for NFX into the node's NFX store; refused for a priced video (free only,
 *       issue #15). Every v7 consumer compiles.
 *   9 — 2026-10-31 (ADR 0020, Phase 1 slice 4b). The NFX identity. `NfxAddress`
 *       (`38504:<author>:<d>`, stable across revisions) and `VideoId`; `NfxVideo`, a free kind-38504
 *       manifest for listing (no `PricePolicy`, no Hyperblob renditions); `CatalogVideo`.
 *       BREAKING for listing: `feed` and `search` return `Page<CatalogVideo>`, so a consumer
 *       narrows on `kind` before it prices, plays or reacts. New `NetworkAdapter.nfxVideo(addr)`.
 *       Everything keyed by event id (`video`, stats, social, library, play) is unchanged.
 *  10 — 2026-10-31 (ADR 0020, Phase 1 slice 5a). Additive: `Settings.nfx?: NfxSettings`
 *       (`enabled`, `network`, `scopedRelays`), `NFX_NETWORKS` (`nfx:testnet:1` only) and
 *       `MAX_NFX_SCOPED_RELAYS` (8). Absent or not `enabled` = no NFX activity. Every v9 consumer
 *       compiles.
 *  11 — 2026-10-31 (ADR 0020, Phase 1 slice 5d). Additive: `NetworkAdapter.playNfx(addr,
 *       rendition?)` → `NfxPlaySession` (`videoId`, `rendition`, `renditions`, `source`, `close`) and
 *       `NfxRenditionInfo`. A free session: no `PricePolicy`, spend or peers; `play` is unchanged.
 *  12 — 2026-10-31 (ADR 0020/0021, Phase 1 slice 5e-2). Additive: `NfxSettings.irohRelays?`, the
 *       network's own iroh relays (NFX-06 §1), `IrohRelayUrl` (`https://host[:port]/`, or `http://`
 *       to a loopback host) and `MAX_NFX_IROH_RELAYS` (4). A local setting, never read from beacons;
 *       absent = none. A stored v10/v11 `nfx` stays valid. Every v11 consumer compiles.
 */
export const CONTRACTS_VERSION = 12 as const;
