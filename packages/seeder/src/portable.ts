/**
 * @sovit/seeder, runtime-portable entry (orchestrator wiring, 2026-09-23): the whole public API
 * EXCEPT the Node adapters (`adapters/node/`, which import `node:fs`/`node:crypto`/
 * `node:child_process`). Bare resolves `node:*` as npm packages, so the full barrel cannot
 * load in the desktop worker; `package.json` maps the `bare` export condition here and the
 * worker injects its own `bare-*` adapters. Keep this file and `index.ts` in step: `index.ts`
 * is this module plus the Node adapters plus the daemon CLI (`cli/main.ts`, `cli/config-file.ts`,
 * `cli/providers.ts` — Node only; `entry-hygiene.test.ts` proves this file never reaches them).
 *
 * Original header: @sovit/seeder — Corestore + Hyperblobs seeder daemon (build-plan §2.1, §2.3, §7).
 * Issued against CONTRACTS_VERSION = 2, re-issued at CONTRACTS_VERSION = 3 (ADR 0004).
 * Public API documented in docs/archive/lanes/L2.md.
 */
export const PACKAGE = '@sovit/seeder' as const;

// Façade
export { Seeder } from './seeder.js';
export type { SeederDeps, SeederEvent, SeederStats } from './seeder.js';
export { resolveConfig } from './config.js';
export type { ResolvedSeederConfig, SeederConfig } from './config.js';

// Blobs / CAS
export { BlobStore, DEFAULT_CORE_NAME } from './blobs/blob-store.js';
export type {
  OpenCoreOptions,
  PutError,
  PutOptions,
  PutResult,
  SeedCore,
} from './blobs/blob-store.js';
export { CasIndex, CAS_INDEX_FILE } from './store/cas-index.js';
export type { CasEntry } from './store/cas-index.js';
export { DiskCap } from './store/disk-cap.js';
export { NfxStore, NFX_MAX_READ_BYTES, NFX_STORE_DIR } from './nfx-store/index.js';
export type {
  NfxPutError,
  NfxPutResult,
  NfxPutVideo,
  NfxStoreFile,
  NfxStoreSource,
  NfxStoredFile,
  NfxVideoRecord,
} from './nfx-store/index.js';

// Network / sessions
export { PeerSession } from './net/peer-session.js';
export type { CutReason, PeerSessionInfo } from './net/peer-session.js';
export { SessionRegistry } from './net/session-registry.js';
export type { SessionEvent } from './net/session-registry.js';
export { RateLimiter, DEFAULT_RATE_LIMITS } from './net/rate-limit.js';
export type { AdmitResult, RateLimitConfig } from './net/rate-limit.js';
export { SwarmManager } from './net/swarm.js';
export {
  DEFAULT_STALL_MS,
  MAX_REMEMBERED_REMOTES,
  MIN_STALL_MS,
  OnePeerRouter,
  ROUTED_HYPERCORE_VERSION,
  RoutingUnsupported,
  STALL_HARD_FACTOR,
  UNCAPPED,
  isRoutablePeer,
  routableReplicator,
} from './net/one-peer.js';
export type {
  DownloadPeer,
  OnePeerRouterOptions,
  OnePeerRouterStats,
  PeerBudget,
  RoutableCore,
} from './net/one-peer.js';
export type { SwarmConfig } from './net/swarm.js';
export { BanList, BAN_FILE } from './store/ban-list.js';
export {
  CORE_POLICY_FILE,
  CorePolicyStore,
  MAX_REMEMBERED_CORE_POLICIES,
} from './store/core-policies.js';
export type { PersistedBan } from './store/ban-list.js';

// Payment
export { FlushScheduler } from './payment/flush-scheduler.js';
export type { FlushResult, FlushTrigger } from './payment/flush-scheduler.js';
export { attachPayBridge } from './payment/pay-bridge.js';
export type { PayBridgeOptions } from './payment/pay-bridge.js';
export {
  JOURNAL_COMPACT_FACTOR,
  JOURNAL_FORMAT,
  JournalReadError,
  PendingJournalCore,
  journalKey,
  journalText,
  replayJournal,
} from './payment/pending-journal.js';
export type { JournalIo } from './payment/pending-journal.js';

// Logging (the only output path)
export { createLogger, silentLogger } from './log/logger.js';
export type { Logger, LogFields, LogLevel, LogRecord, LogSink } from './log/logger.js';
export { redact, redactString, REDACTED } from './log/redact.js';

// Host / CLI
// The systemd unit itself is `deploy/systemd/nutflix-seeder.service` (not rendered here).
export { sdNotify, installShutdownHooks } from './host/systemd.js';
export type { SdState, ShutdownHooksOptions } from './host/systemd.js';
export { runMelt, parseMeltArgs, MELT_USAGE } from './cli/melt.js';
export type { MeltCliDeps } from './cli/melt.js';
export {
  runDaemon,
  parseDaemonEnv,
  ENV_DATA_DIR,
  ENV_DISK_CAP,
  ENV_MAX_STREAMS,
} from './cli/daemon.js';

// Adapters
export type { SeederFs, FileStat } from './adapters/fs.js';
export type { SeederCrypto, Sha256Hasher } from './adapters/crypto.js';
export type { SeederProcess, SignalName } from './adapters/process.js';
export { toHex, fromHex } from './util/hex.js';
