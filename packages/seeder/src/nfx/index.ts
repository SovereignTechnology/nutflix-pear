/**
 * The NFX-12 HyperDHT transport (nfx `spec/nfx-12-hyperdht.md`, ADR 0020): dial a seeder by
 * its peer key, fetch whole files over `nfx/files/1`, carry NFX-07 over `nfx/pay/1`. Free mode
 * only; the wire layouts are `@sovit/core`'s `nfx` codec. It runs beside the legacy Hypercore
 * path and shares neither keys nor stores with it.
 */
export { hyperdhtBind, hyperdhtEndpoint } from './bind.js';
export type { HyperdhtEndpoint, PeerKeyPair } from './bind.js';
export { MAX_REJECTED_OPENS, NFX_LIMITS, NfxConnection } from './connection.js';
export type {
  ConnectionHost,
  NfxConnectionOptions,
  NfxLimits,
  NfxServeOptions,
} from './connection.js';
export {
  DEFAULT_DIAL_TIMEOUT_MS,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_CONNECTIONS_PER_PEER,
  dialNfx,
  listenNfx,
} from './endpoint.js';
export type {
  DialResult,
  NfxDht,
  NfxDialOptions,
  NfxListener,
  NfxListenOptions,
} from './endpoint.js';
export { FilesClient } from './files-client.js';
export type { FetchFailure, FetchOptions, FetchResult, NfxSink } from './files-client.js';
export type {
  FilesServerOptions,
  NfxAdmission,
  NfxFileSource,
  NfxRequest,
  NfxServedFile,
} from './files-server.js';
export { PayLane } from './pay-lane.js';
export type { PayLaneHandlers } from './pay-lane.js';
export { FilePump } from './pump.js';
export type { DrainSource, PumpStats } from './pump.js';
export { TRAPPED_TYPES } from './traps.js';
