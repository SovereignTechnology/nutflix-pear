/**
 * NFX wire formats (nfx `spec/`), the TypeScript side of nfx-proto: namespaces (NFX-01),
 * kind-38504 manifests and deletions (NFX-02), kind-20464 beacons with the NFX-12 `hyperdht`
 * endpoint (NFX-03), hash lists and playlists (NFX-05), canonical JSON (NFX-11 §9) and the
 * NFX-12 `nfx/files/1` / `nfx/pay/1` message layouts. Pinned by the suite's vectors
 * (`docs/vendor/nfx-test-vectors`).
 *
 * Everything here is pure: no I/O, no clock (callers pass `now`), no randomness, no signing.
 * It runs beside the legacy NIP-71 protocol (ADR 0020) and shares nothing with it.
 */
export * from './beacon.js';
export * from './canon.js';
export * from './deletion.js';
export type { NfxError, NfxErrorKind, NfxResult, Verified } from './errors.js';
export * from './event.js';
export * from './files1.js';
export * from './hashlist.js';
export { JsonNumber, JsonObject, parseJson, type JsonValue } from './json.js';
export * from './manifest.js';
export * from './namespace.js';
export * from './progressive.js';
