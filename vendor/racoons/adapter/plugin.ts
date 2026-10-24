/**
 * The shipped dsh mount entry: a Cordis plugin that runs the racoons engine
 * inside a live dsh process.
 *
 * Contract (verified against the installed dsh tree, ISSUE-014 §"Verified mount
 * path"):
 *   - a plugin is `apply(ctx, config)` with optional `inject` / `name`;
 *   - `agent/pre-step` is a waterfall `({agent, messages, turn, step, signal},
 *     next)`, and `agent.session` is the live `Session` with public
 *     `append(type, data, {surfaceOp, sourceEventSeqs})`;
 *   - `session/event` listeners must NEVER append synchronously (append
 *     reentrancy throws), so every append happens from `agent/pre-step` or
 *     `agent/turn-stopping`, where the loop is between steps.
 *
 * Nothing here is engine or adapter logic: this file maps host events onto the
 * public seams of `@racoons/core` and `racoons-dsh`. The subpath export keeps
 * the package's default entry free of any host dependency.
 *
 * Storage (ADR-0013, ISSUE-004 chunk 2): the ledger and blobs are durable per
 * session under `racoonsStorageRoot`; `':memory:'` is the test-only pair. A
 * host that already owns durable storage may inject `openLedger` instead.
 */
import { randomUUID } from 'node:crypto';
import {
  CharHeuristicTokenMeter, DEFAULT_CONFIG, Meter, RacoonsEngine,
  createDefaultRules, estimateContent, estimatedContentTokens, sha256Sync,
} from '@racoons/core';
import type {
  AnchorMode, Clock, EngineResult, FreshZoneConfig, Ledger, ProtocolConfig, ProtectionState,
  RacoonsConfig, RecallId, RecallRecord, Rule, SourceRange, Thresholds,
} from '@racoons/core';
import { createDshCapabilities } from './capabilities.js';
import { createDshAdapter } from './adapter.js';
import type { DshAdapter } from './adapter.js';
import { DSH_TOOL_SPECS, recallText } from './tools.js';
import type { DshToolHost, DshRecallOutput } from './tools.js';
import type { DshResultFacts, DshPathObservation } from './evidence.js';
import type { DshToolResultItem, DshTranscriptItem } from './envelope.js';
import { createDshPort } from './port.js';
import type { DshApplicationPort } from './port.js';
import { revertSessionFromHost } from './mount-revert.js';
import { DEFAULT_ASK_TIMEOUT_MS } from './llm-ask.js';
import { createJudgeSeam, judgeRouteOf } from './judge-seam.js';
import type { JudgeRoute, JudgeSeam, JudgeSettleOutcome } from './judge-seam.js';
import { createMainWireCapture } from './main-wire.js';
import type { MainWireCapture } from './main-wire.js';
import { runRecordOnlyPrune, PRUNE_COMMAND } from './prune.js';
import type { RecordOnlyPruneOutcome } from './prune.js';
import { readPruneRound, writePruneRound } from './prune-round-store.js';
import { PruneWindowTrigger, resolveContextWindowTokens } from './prune-trigger.js';
import { applyPrunePass } from './prune-apply.js';
import {
  STORAGE_OPEN_ATTEMPTS, defaultStorageRoot, openLedger,
  resolveSessionStorage, resolveStorage,
} from './storage.js';
import type { RacoonsStorageOptions, ResolvedRacoonsStorage } from './storage.js';
import { RacoonsStorageError, RacoonsStorageRetryError } from './storage.js';
import { createRefusingLedger } from './refusing-ledger.js';

export { resolveStorage } from './storage.js';
export {
  RacoonsStorageError, RacoonsStorageRetryError, STORAGE_OPEN_ATTEMPTS,
  defaultStorageRoot, resolveSessionStorage,
} from './storage.js';
export type {
  RacoonsStorageErrorCode, RacoonsStorageOptions, ResolvedRacoonsStorage,
} from './storage.js';

/** Stable Cordis plugin name. */
export const RACOONS_PLUGIN_NAME = 'racoons';

/**
 * Services the plugin needs before dsh applies it.
 *
 * `llm` is the host's own model seam — the one the shipped compaction plugin
 * declares (`dsh-compaction-basic`: `static inject = ["llm", "tokenMeter",
 * "sessions"]`). ISSUE-024 chunk 2 asks the judge through it; declaring it here
 * makes that dependency a host fact rather than a later guess.
 */
export const RACOONS_PLUGIN_INJECT: readonly string[] = Object.freeze(['llm', 'sessions']);

/** The enforcement values this mount accepts. Absent means `apply` (ADR-0008). */
export type RacoonsEnforcement = NonNullable<ProtocolConfig['enforcement']>;

/**
 * The host-facing flat config a `--patch` row can set. Every value is a
 * threshold or a protocol knob, never engine state.
 */
export interface RacoonsPluginConfig {
  /**
   * Accepted and ignored. ADR-0014 (2026-10-23) scrapped the entry-time cap:
   * these two keys stay in the host-facing type so an old config file never
   * crashes a mount, and no value of theirs is read or wired anywhere.
   */
  readonly capBytes?: number;
  /** Accepted and ignored; see `capBytes` (ADR-0014, 2026-10-23). */
  readonly capHeadBytes?: number | null;
  readonly episodeNoNewPathSteps?: number | null;
  readonly sealMaxLatencyTurns?: 0 | 1;
  readonly barBytes?: number;
  readonly advertisedLabelLimit?: number;
  readonly retryLimit?: number;
  readonly minCutFreedBytes?: number;
  readonly revisitShare?: number;
  /**
   * Enforcement mode. Absent means `apply`: ADR-0008's owner ruling, the same
   * default `DEFAULT_CONFIG` carries; `record-only` is the explicit opt-out.
   * What a mount can actually apply stays structural — a session with no
   * revert seam records the answers with `unsupported-capability` and plans
   * nothing, so a config value is never a capability claim.
   */
  readonly enforcement?: RacoonsEnforcement;
  /** The `source.kind` an appended negative fact carries. */
  readonly recordName?: string;
  /**
   * The judge's anchor arm (ISSUE-021 point 6). Absent is `off`: the tagless
   * message the v4.1 contract renders. `on` inserts one anchor line before the
   * decision line; the history bytes are unchanged either way.
   */
  readonly anchors?: AnchorMode;
  /** The judge stream's deadline in ms; `0` disables it. Default 30 s. */
  readonly judgeTimeoutMs?: number;
  /**
   * The durable storage root (ADR-0013). Session N's ledger lands at
   * `<racoonsStorageRoot>/sessions/N/ledger.sqlite` with its blobs beside it.
   * Must be absolute. Absent means `defaultStorageRoot()`:
   * `<DSH_HOME>/storages/racoons`, `DSH_HOME` defaulting to `~/.dsh`.
   */
  readonly racoonsStorageRoot?: string;
  /**
   * The context window in tokens, when the host knows it. It is the ONE value
   * the half-window auto prune is measured against: the pass fires when the
   * session's estimated request tokens reach half of it (owner ruling
   * 2026-10-24, ADR-0009 §Amendment). The estimate is the WHOLE request — the
   * fixed system+tools prefix of main's captured request plus the live
   * transcript (ADR-0009 §Amendment 2026-10-24). Absent means the feature is OFF
   * and the mount stays record-only, which is the rollout's first stage
   * (ADR-0008).
   *
   * Provisional default per owner ruling 2026-10-24: `null`. The owner decides
   * the shipped value; the trigger rule itself is ruled, only the number is not.
   */
  readonly contextWindowTokens?: number | null;
  /**
   * The native-compaction backstop (ISSUE-022 DoD; wired per CRITIC-022 P1-1,
   * 2026-10-24). When on, a host `compaction/end` re-arms the half-window latch
   * exactly as a completed pass does: the host rewrote the surface, so the old
   * growth baseline no longer describes the session and the next crossing is
   * pruned instead of waiting out a delta the compaction invalidated. When off,
   * native compaction is observed and ignored. The shipped default is ON (owner
   * ruling 2026-10-24): the host's own compaction stays armed as a backstop, and
   * racoons fires earlier than the host's own trigger would. `false` is the
   * explicit opt-out.
   */
  readonly nativeCompactionBackstop?: boolean;
}

/** `RacoonsPluginConfig` after defaults and validation. */
export interface ResolvedRacoonsConfig {
  readonly episodeNoNewPathSteps: number | null;
  readonly sealMaxLatencyTurns: 0 | 1;
  readonly barBytes: number;
  readonly advertisedLabelLimit: number;
  readonly retryLimit: number;
  readonly minCutFreedBytes: number;
  readonly revisitShare: number;
  readonly enforcement: RacoonsEnforcement;
  readonly recordName: string;
  readonly anchors: AnchorMode;
  readonly judgeTimeoutMs: number;
  readonly racoonsStorageRoot: string;
  /**
   * The half-window trigger's denominator; null means the trigger is off and no
   * auto pass is scheduled (ADR-0009 §Amendment; provisional default per owner
   * ruling 2026-10-24).
   */
  readonly contextWindowTokens: number | null;
  /**
   * True when a host compaction re-arms the half-window latch (ISSUE-022 DoD;
   * CRITIC-022 P1-1). Shipped `true` per owner ruling 2026-10-24: the host's
   * backstop stays armed and racoons fires earlier than the host's own trigger.
   */
  readonly nativeCompactionBackstop: boolean;
}

/**
 * The journal vocabulary is a closed list in `./journal-kinds.ts` (CRITIC-022
 * P3 #14), re-exported here because this module is where a host-looking reader
 * finds it. A typo in a `journal('...')` call is a compile error.
 */
export { RACOONS_JOURNAL_KINDS } from './journal-kinds.js';
export type { RacoonsJournalKind } from './journal-kinds.js';
import type { RacoonsJournalKind } from './journal-kinds.js';

/** One journal record. The host selects where it goes; this file never writes. */
export interface RacoonsJournalRecord {
  readonly kind: RacoonsJournalKind;
  readonly atMs: number;
  readonly [field: string]: unknown;
}

export type RacoonsJournalSink = (record: RacoonsJournalRecord) => void;

/** A host-owned ledger, so a caller can inspect or reopen it. */
export type RacoonsLedgerFactory = (sessionId: string) => Promise<Ledger>;

export interface RacoonsPluginOptions {
  /** Defaults a patch row may override. */
  readonly config?: RacoonsPluginConfig;
  /**
   * The storage target. Absent means the durable per-session plan under
   * `config.racoonsStorageRoot` (ADR-0013); `{ databasePath: ':memory:' }` is
   * the test-only in-memory pair. Only a storage ROOT (or `':memory:'`) is
   * accepted: an explicit durable `{databasePath, blobRoot}` pair is refused
   * with `explicit-storage-paths`, because one shared file would contradict
   * ADR-0013's per-session rule (ISSUE-004 critic fix P2#3).
   */
  readonly storage?: RacoonsStorageOptions;
  /** A host that owns durable storage supplies the ledger, and wins. */
  readonly openLedger?: RacoonsLedgerFactory;
  readonly journal?: RacoonsJournalSink;
  /** The additive host tool registry, when the caller already resolved it. */
  readonly tools?: DshToolHost;
  readonly nowMs?: () => number;
  /**
   * A fixed judge route, when the caller knows the provider/model pair. Absent,
   * the mount reads the live session's own request header and refuses with
   * `not-configured` when neither names a route (ISSUE-024 chunk 2).
   */
  readonly judgeRoute?: JudgeRoute;
}

/** The structural slice of a dsh session this mount reads. */
export interface DshMountSession {
  readonly id: string;
  readonly seq?: number;
  readonly surface?: { readonly nodes?: readonly number[] };
  eventAt?(seq: number): DshMountEvent | undefined;
  append(type: string, data: unknown, options?: Record<string, unknown>): DshMountEvent;
  /**
   * The host's last request header (provider/model), read only to route the
   * judge call onto the same resolved model the session uses. Absent on a fake
   * or an old host: the mount then refuses the judge with `not-configured`
   * rather than inventing a route.
   */
  requestHeader?(): { readonly config?: { readonly provider?: string; readonly model?: string } }
    | undefined;
}

export interface DshMountEvent {
  readonly type: string;
  readonly seq: number;
  readonly data?: unknown;
  readonly surfaceOp?: unknown;
  readonly sourceEventSeqs?: readonly number[];
}

/** The structural slice of the Cordis context this mount uses. */
export interface DshMountContext {
  // `never[]` keeps every listener shape assignable without importing cordis.
  on(event: string, listener: (...args: never[]) => unknown): unknown;
  effect?(register: () => (() => unknown) | void, label?: string): unknown;
  logger?: { warn?(message: string): void };
  sessions?: { list?(): readonly DshMountSession[] };
  /**
   * The host's model seam, declared through `RACOONS_PLUGIN_INJECT`'s `llm`.
   * The structural slice below is what the shipped compaction plugin drives
   * (`ctx.llm.stream(options)` → an async iterable of chunks); ISSUE-024
   * chunk 2 is the first caller. Typed here, never imported: this package
   * carries no dsh dependency.
   */
  llm?: DshLlmService;
  tools?: DshToolHost;
  get?(name: string): unknown;
}

/** The one model call a judge needs: stream a request, read its text deltas. */
export interface DshLlmService {
  stream(options: DshLlmStreamOptions): AsyncIterable<DshLlmChunk>;
}

/** The request fields the host's `GenerateOptions` requires; extras pass through. */
export interface DshLlmStreamOptions {
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly Readonly<Record<string, unknown>>[];
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
  readonly [field: string]: unknown;
}

/**
 * The chunk shapes the judge reads. Only `text-delta` carries answer text; the
 * rest are the host's own framing, kept so a caller can see why a stream ended.
 */
export type DshLlmChunk =
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'finish'; readonly reason: string; readonly [field: string]: unknown }
  | { readonly type: string; readonly [field: string]: unknown };

/** The call facts a `tool/call` carries; a `tool/result` does not repeat them. */
interface CallFacts {
  readonly name?: unknown;
  readonly arguments?: unknown;
}

interface Capture {
  readonly eventId: string;
  readonly item: DshToolResultItem;
  readonly seq: number;
}

/** The application request the port hands back for publication. */
export interface RacoonsApplicationRequest {
  readonly intent: { readonly intentId: string };
  readonly application: {
    readonly eventId: string;
    readonly mode: string;
    readonly replacements: readonly {
      readonly source: { readonly nodeId: string; readonly byteLength: number };
      readonly bytes: Uint8Array;
      readonly generatedRanges: readonly unknown[];
      readonly retainedCopies: readonly unknown[];
      readonly evidenceRecallId: string | null;
    }[];
    readonly appendRecords: readonly {
      readonly recordId: string; readonly bytes: Uint8Array;
    }[];
    readonly archives: readonly {
      readonly ruleId: string;
      readonly removalId: string;
      readonly operationKind: string;
      readonly title: string;
      readonly recall: {
        readonly id: string;
        readonly parts: readonly {
          readonly source: {
            readonly sha256?: string;
            readonly nodeId?: string;
            readonly byteLength?: number;
          };
          readonly removedRanges: readonly {
            readonly range: { readonly startByte: number; readonly endByteExclusive: number };
          }[];
        }[];
      };
    }[];
    readonly sealedEpisodeIds: readonly string[];
    readonly applicationSha256: string;
  };
}

export interface RacoonsSessionEntry {
  readonly sessionId: string;
  readonly engine: RacoonsEngine;
  readonly adapter: DshAdapter;
  readonly port: DshApplicationPort;
  readonly ledger: Ledger;
  readonly ownedLedger: boolean;
  readonly publications: unknown[];
  /**
   * The live host session this entry opened with. It is informational for
   * callers; the revert seam was derived from the same object, so a mount that
   * opened without a host never claims the capability (ISSUE-010).
   */
  host: DshMountSession | null;
  /**
   * The judge seam for this session (ISSUE-024 chunk 2): it remembers the
   * window the engine presented and posts the answered verdicts back. Present
   * even when no model seam was wired, where it journals `judge-off`.
   */
  judge: JudgeSeam;
  /**
   * How many prune passes this session has run (ISSUE-022 chunks 5–6). It is
   * the pass's round ordinal, so two passes never share a stamp, and it lives
   * on the entry rather than the engine: a pass mints no engine event of its
   * own. Chunk 6 persists it beside the session's ledger: a remount reads it
   * back, so a resumed dsh process continues the count instead of starting at
   * round 1 again (`./prune-round-store.ts`).
   */
  pruneRounds: number;
  /**
   * The half-window crossing latch (ISSUE-022 chunk 6; ADR-0009 §Amendment).
   * One instance per session: usage that crosses half the configured window
   * schedules one pass, and the latch re-arms only when usage falls back below
   * the line. Disabled (never fires) when no window is configured.
   */
  readonly pruneTrigger: PruneWindowTrigger;
  /**
   * Receipts the judge seam produced and the step boundary has yet to append
   * (ISSUE-026 chunk 3). The seam runs inside `runStep`/`runTurnEnd`, which the
   * host already calls at a legal append boundary; the queue keeps the seam
   * itself host-free so a test can read its text before it lands.
   */
  readonly pendingReceipts: string[];
  takePublication(): RacoonsApplicationRequest | null;
}

export interface StepOutcome {
  readonly entry: RacoonsSessionEntry;
  readonly deliveries: EngineResult[];
  readonly atRest: EngineResult | null;
  /** The judge pass that followed the presentation, or null when none was offered. */
  readonly judged: JudgeSettleOutcome | null;
  readonly entryApplications: readonly {
    readonly request: RacoonsApplicationRequest;
    readonly capture: Capture;
  }[];
  readonly appendRequest: RacoonsApplicationRequest | null;
  /** The receipts this step appended to main (ISSUE-026 chunk 3: at most one). */
  readonly receipts: readonly DshMountEvent[];
}

export interface TurnEndOutcome {
  readonly entry: RacoonsSessionEntry;
  readonly atRest: EngineResult | null;
  readonly judged: JudgeSettleOutcome | null;
  readonly appendRequest: RacoonsApplicationRequest | null;
  /** The receipts this boundary appended to main (ISSUE-026 chunk 3: at most one). */
  readonly receipts: readonly DshMountEvent[];
}

export interface RacoonsMount {
  readonly sessions: Map<string, RacoonsSessionEntry>;
  readonly counters: { entries: number; preSteps: number; publications: number; captured: number };
  sessionFor(sessionId: string, host?: DshMountSession): Promise<RacoonsSessionEntry>;
  syncTranscript(entry: RacoonsSessionEntry, session: DshMountSession,
    options?: TranscriptSyncOptions): ReturnType<typeof surfaceTranscript>;
  observe(session: DshMountSession, event: DshMountEvent): DshToolResultItem | null;
  /**
   * Record one request the host's `llm/stream` waterfall dispatched as main's
   * last sent request for its session (ISSUE-026 chunk 3). A request this
   * package sent itself is ignored, so a judge ask never becomes a seed.
   */
  observeWire(options: unknown): void;
  runStep(session: DshMountSession, ordinals: { turn: number; step: number }): Promise<StepOutcome>;
  runTurnEnd(session: DshMountSession, turn: number): Promise<TurnEndOutcome>;
  /**
   * Run one record-only prune pass now (ISSUE-022 chunk 5). The `/prune`
   * command reaches it from `runStep`, and a test or a rig may call it
   * directly. Nothing is appended, applied or archived.
   */
  runPrune(session: DshMountSession): Promise<RecordOnlyPruneOutcome | null>;
  close(): Promise<void>;
}

export interface TranscriptSyncOptions {
  readonly beforeSeq?: number;
  readonly completedThroughTurnOrdinal?: number;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate the flat knobs and fill the engine's defaults. */
export function resolvePluginConfig(raw: RacoonsPluginConfig | undefined): ResolvedRacoonsConfig {
  const config: RacoonsPluginConfig = isRecord(raw) ? raw : {};
  // ADR-0014 (2026-10-23): `capBytes` / `capHeadBytes` are accepted and ignored.
  // They are deliberately not read here: an old config file still mounts, and
  // no value of theirs can reach the engine.
  const episodeNoNewPathSteps = config.episodeNoNewPathSteps === undefined
    ? null : config.episodeNoNewPathSteps;
  const sealMaxLatencyTurns = config.sealMaxLatencyTurns ?? 1;
  const barBytes = config.barBytes ?? 8192; // provisional per owner 2026-10-23
  const advertisedLabelLimit = config.advertisedLabelLimit ?? 40;
  const retryLimit = config.retryLimit ?? 2;
  const minCutFreedBytes = config.minCutFreedBytes ?? 4096;
  const revisitShare = config.revisitShare ?? 0.5;
  // ADR-0008: absent means `apply` (owner ruling 2026-10-23 — the same default
  // `DEFAULT_CONFIG` carries); `record-only` is the explicit opt-out. The mount
  // no longer pins the opt-out. That pin was a config statement about a
  // capability, and the mount now has the capability whenever a host session
  // supplies the revert seam. A mount without one still applies nothing: the
  // engine reads the structural flag and records the answers with
  // `unsupported-capability` (`packages/core/src/engine/engine.ts`,
  // `settleVerdicts`), so this default can never manufacture a removal.
  const enforcement = config.enforcement ?? 'apply';
  const recordName = config.recordName ?? 'racoons/negation';
  const anchors = config.anchors ?? 'off';
  const judgeTimeoutMs = config.judgeTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  const racoonsStorageRoot = config.racoonsStorageRoot ?? defaultStorageRoot();
  // Provisional default per owner ruling 2026-10-24: no window, so no auto pass.
  // The trigger rule is ruled (one-half, ADR-0009 §Amendment); the shipped number
  // is the owner's. The coercion is the trigger's own validator, so the config
  // and the latch cannot disagree about what a window is (CRITIC-022 P3 #16).
  const contextWindowTokens = resolveContextWindowTokens(config.contextWindowTokens);
  // Owner ruling 2026-10-24: the backstop ships ON. The host's native compaction
  // stays armed, and racoons must fire earlier than the host's own trigger would
  // (the ruling applies to any harness, not only dsh); `false` is the opt-out.
  const nativeCompactionBackstop = config.nativeCompactionBackstop ?? true;
  if (episodeNoNewPathSteps !== null && !isCount(episodeNoNewPathSteps)) {
    throw new Error('racoons: episodeNoNewPathSteps must be null or a non-negative safe integer');
  }
  if (sealMaxLatencyTurns !== 0 && sealMaxLatencyTurns !== 1) {
    throw new Error('racoons: sealMaxLatencyTurns must be 0 or 1');
  }
  if (!isCount(barBytes) || barBytes < 1) {
    throw new Error('racoons: barBytes must be a positive safe integer');
  }
  if (!isCount(advertisedLabelLimit) || advertisedLabelLimit < 1) {
    throw new Error('racoons: advertisedLabelLimit must be a positive safe integer');
  }
  if (!isCount(retryLimit)) throw new Error('racoons: retryLimit must be a non-negative safe integer');
  if (!isCount(minCutFreedBytes)) {
    throw new Error('racoons: minCutFreedBytes must be a non-negative safe integer');
  }
  if (typeof revisitShare !== 'number' || !Number.isFinite(revisitShare)
    || revisitShare <= 0 || revisitShare > 1) {
    throw new Error('racoons: revisitShare must be a number greater than 0 and at most 1');
  }
  if (enforcement !== 'record-only' && enforcement !== 'apply') {
    throw new Error('racoons: enforcement must be "record-only" or "apply"');
  }
  if (typeof recordName !== 'string' || recordName.trim() === '') {
    throw new Error('racoons: recordName must be a non-empty string');
  }
  if (anchors !== 'off' && anchors !== 'on') {
    throw new Error('racoons: anchors must be "off" or "on"');
  }
  if (!isCount(judgeTimeoutMs)) {
    throw new Error('racoons: judgeTimeoutMs must be a non-negative safe integer');
  }
  if (typeof racoonsStorageRoot !== 'string' || racoonsStorageRoot.trim() === '') {
    throw new Error('racoons: racoonsStorageRoot must be a non-empty path');
  }
  if (typeof nativeCompactionBackstop !== 'boolean') {
    throw new Error('racoons: nativeCompactionBackstop must be a boolean');
  }
  return Object.freeze({
    episodeNoNewPathSteps, sealMaxLatencyTurns, barBytes,
    advertisedLabelLimit, retryLimit, minCutFreedBytes, revisitShare, enforcement, recordName,
    anchors, judgeTimeoutMs, racoonsStorageRoot, contextWindowTokens, nativeCompactionBackstop,
  });
}

/** The engine config this mount builds from the flat knobs. */
export function engineConfig(config: ResolvedRacoonsConfig): RacoonsConfig {
  const thresholds: Thresholds = {
    // ADR-0014 (2026-10-23): the entry-time cap is scrapped. The core's
    // Thresholds type still carries both fields for old config files, so the
    // mount states the core defaults and never wires a caller's value in.
    capBytes: DEFAULT_CONFIG.thresholds.capBytes,
    capHeadBytes: DEFAULT_CONFIG.thresholds.capHeadBytes,
    episodeNoNewPathSteps: config.episodeNoNewPathSteps,
    sealMaxLatencyTurns: config.sealMaxLatencyTurns,
    evictAfterClosedTurns: null,
  };
  const freshZone: FreshZoneConfig = { maxNodes: null, maxBytes: null };
  const protocol: ProtocolConfig = {
    barBytes: config.barBytes,
    advertisedLabelLimit: config.advertisedLabelLimit,
    retryLimit: config.retryLimit,
    minCutFreedBytes: config.minCutFreedBytes,
    revisitShare: config.revisitShare,
    enforcement: config.enforcement,
  };
  return { thresholds, freshZone, sealMode: 'append', enableSpans: false,
    validationFailureLimit: 2, protocol };
}

/** Rendered text of one host message's content blocks. */
function textOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((block) => isRecord(block) && block['type'] === 'text'
    && typeof block['text'] === 'string').map((block) => block['text'] as string).join('');
}

/** Parse the tool arguments the host recorded. */
function inputOf(argumentsText: unknown): Readonly<Record<string, unknown>> {
  if (typeof argumentsText !== 'string' || argumentsText === '') return {};
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The call id on a tool result, from either host spelling. */
function callIdOf(event: DshMountEvent): string | null {
  const data = isRecord(event.data) ? event.data : {};
  const message = isRecord(data['message']) ? data['message'] : {};
  const source = isRecord(message['source']) ? message['source'] : {};
  if (typeof source['callId'] === 'string') return source['callId'];
  return typeof message['toolCallId'] === 'string' ? message['toolCallId'] : null;
}

/**
 * The pair the host put in the tool call, when it names one. `read` names
 * `file_path`; `grep`/`glob` name `pattern` (plus an optional `path` scope).
 */
export function targetFromInput(
  toolName: string, input: Readonly<Record<string, unknown>>,
): { readonly key: string; readonly label: string } | null {
  const pick = (value: unknown): string | null =>
    (typeof value === 'string' && value.length > 0 ? value : null);
  const kind = toolName.toLowerCase();
  if (kind === 'grep' || kind === 'rg' || kind === 'search' || kind === 'glob') {
    const pattern = pick(input['pattern']);
    return pattern === null ? null : { key: pattern, label: pattern };
  }
  const path = pick(input['file_path']) ?? pick(input['filePath']) ?? pick(input['path']);
  return path === null ? null : { key: path, label: path };
}

/**
 * Turn the host's structured `meta` into the `DshResultFacts` the adapter's
 * evidence derivation reads.
 *
 * Only the host's own search projection is treated as proof:
 *   - a `matches`-shaped result with `truncated:false` and `total === 0` proves a
 *     miss;
 *   - a `matches`-shaped result with matches proves a hit, per file;
 *   - a `paths`-shaped result (glob) does the same for discovered paths.
 * Every other shape stays `complete:false` with no counted paths, so it can
 * never become a negative fact.
 */
export function resultFactsFromMeta(
  toolName: string, input: Readonly<Record<string, unknown>>, meta: unknown,
): DshResultFacts {
  const scope = typeof input['path'] === 'string' && input['path'].length > 0 ? input['path'] : null;
  const fallback = scope ?? (isRecord(meta) && typeof meta['path'] === 'string' ? meta['path'] : null) ?? '.';
  const observed = (): DshPathObservation[] => {
    const path = targetFromInput(toolName, input);
    // No count: an observation that proves nothing. `DeriveToolEvidence` reads a
    // missing count and an explicit null the same way.
    return path === null ? [] : [{ path: path.key }];
  };
  if (!isRecord(meta)) return { complete: false, failed: false, paths: observed() };
  const files = meta['files'];
  const paths = meta['paths'];
  if (meta['shape'] === 'matches' && Array.isArray(files) && meta['truncated'] === false
    && isCount(meta['total'])) {
    if (meta['total'] === 0) {
      return { complete: true, failed: false,
        paths: [{ path: fallback, pathKey: fallback, matchCount: 0 }] };
    }
    const hits = files.flatMap((file) => (isRecord(file) && typeof file['path'] === 'string'
      && file['path'].length > 0
      ? [{ path: file['path'], pathKey: file['path'],
        matchCount: Array.isArray(file['matches']) ? file['matches'].length : 0 }] : []));
    return { complete: true, failed: false, paths: hits.length > 0 ? hits
      : [{ path: fallback, pathKey: fallback, matchCount: meta['total'] }] };
  }
  if (meta['shape'] === 'paths' && Array.isArray(paths) && meta['truncated'] === false
    && isCount(meta['total'])) {
    if (meta['total'] === 0) {
      return { complete: true, failed: false,
        paths: [{ path: fallback, pathKey: fallback, matchCount: 0 }] };
    }
    const discovered = paths.flatMap((path) => (typeof path === 'string' && path.length > 0
      ? [{ path, pathKey: path, matchCount: 1 }] : []));
    return { complete: true, failed: false, paths: discovered.length > 0 ? discovered
      : [{ path: fallback, pathKey: fallback, matchCount: meta['total'] }] };
  }
  return { complete: false, failed: false, paths: observed() };
}

/** Deterministic per-(session, kind, seq) ids, so a replayed event never doubles an intent. */
export function eventIdFor(sessionId: string, kind: string, seq: number | string): string {
  return `dsh:${sessionId}:${kind}:${String(seq)}`;
}

/**
 * A tool result's transcript identity: one live result per call id in dsh, so
 * the call id survives a content replacement that re-appends the node.
 */
export function resultNodeId(sessionId: string, callId: string): string {
  return `dsh:${sessionId}:result:${callId}`;
}

/** The one current surface seq for a call id, or null when none is live. */
export function currentResultSeq(session: DshMountSession, callId: string): number | null {
  const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : [];
  for (const seq of [...nodes].reverse()) {
    const event = session.eventAt?.(seq);
    if (event?.type !== 'tool/result') continue;
    if (callIdOf(event) === callId) return seq;
  }
  return null;
}

/**
 * Map one captured `tool/result` host event to the adapter's item shape.
 *
 * The body is the concatenation of the rendered `text` blocks — the same bytes
 * the model reads. `evidence` stays absent so the adapter's own
 * `deriveToolEvidence` derives it from `toolName` + `input` + `result`.
 *
 * A failed result carries `failed: true` and is never `complete`: a failure
 * proves nothing about the search space, so it can never become a negative fact
 * (S7's evidence half; the cap half is enforced in `observe`).
 */
export function toolResultItem(params: {
  eventId: string;
  event: DshMountEvent;
  call: CallFacts | null;
  turnOrdinal: number;
  stepOrdinal: number;
}): DshToolResultItem | null {
  const data = isRecord(params.event.data) ? params.event.data : {};
  const message = isRecord(data['message']) ? data['message'] : {};
  const callId = callIdOf(params.event);
  if (callId === null) return null;
  const failed = message['isError'] === true;
  const toolName = typeof params.call?.name === 'string' ? params.call.name : '';
  const input = inputOf(params.call?.arguments);
  const facts = resultFactsFromMeta(toolName, input, data['meta']);
  return {
    id: params.eventId,
    role: 'tool',
    callId,
    toolName,
    input,
    target: targetFromInput(toolName, input),
    result: failed ? { ...facts, failed: true, complete: false } : facts,
    bytes: new TextEncoder().encode(textOf(message['content'])),
    turnOrdinal: params.turnOrdinal,
    stepOrdinal: params.stepOrdinal,
    hostData: { meta: data['meta'] ?? null, isError: failed, seq: params.event.seq },
  };
}

/**
 * Walk a session's log once and return, for every surface position, the host
 * transcript item the port should hold.
 *
 * Two host facts shape this projection:
 *   - dsh numbers `step` per turn (it restarts at 1 each turn) while the core's
 *     snapshot wants one monotone step ordinal across the transcript, so each
 *     distinct (turn, step) pair gets the next global ordinal.
 *   - a turn is complete only at its `turn/end`, so `completedThroughTurnOrdinal`
 *     is the last `turn/end`'s turn, never "current turn minus one".
 *
 * `beforeSeq` cuts the surface at one seq, exclusive. The dsh port grows by
 * appending the result it is handed, so the snapshot it plans against must be
 * the surface prefix that precedes that result — not the surface minus it.
 */
export function surfaceTranscript(session: DshMountSession, options: {
  beforeSeq?: number;
  sessionId?: string;
  calls?: ReadonlyMap<string, CallFacts>;
} = {}): {
  items: DshTranscriptItem[];
  seqs: number[];
  currentTurnOrdinal: number;
  currentStepOrdinal: number;
  completedThroughTurnOrdinal: number;
} {
  const beforeSeq = options.beforeSeq ?? Number.POSITIVE_INFINITY;
  const sessionId = options.sessionId ?? session.id;
  const length = typeof session.seq === 'number' ? session.seq : 0;
  const ordinalAt = new Map<number, { turn: number; step: number }>();
  let turn = 0;
  let globalStep = 0;
  let completedThrough = -1;
  let lastKey: string | null = null;
  for (let seq = 0; seq < length; seq += 1) {
    const event = session.eventAt?.(seq);
    if (event === undefined) continue;
    const data = isRecord(event.data) ? event.data : {};
    if (event.type === 'turn/start' && isCount(data['turn'])) turn = data['turn'];
    if (event.type === 'step/start' && isCount(data['step'])) {
      const key = `${String(turn)}:${String(data['step'])}`;
      if (key !== lastKey) { globalStep += 1; lastKey = key; }
    }
    if (event.type === 'turn/end' && isCount(data['turn'])) {
      completedThrough = Math.max(completedThrough, data['turn']);
    }
    ordinalAt.set(seq, { turn, step: globalStep });
  }
  const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : [];
  const items: DshTranscriptItem[] = [];
  const seqs: number[] = [];
  for (const seq of nodes) {
    if (seq >= beforeSeq) break;
    const event = session.eventAt?.(seq);
    if (event === undefined) continue;
    const at = ordinalAt.get(seq) ?? { turn, step: globalStep };
    if (event.type === 'tool/result') {
      const callId = callIdOf(event);
      if (callId === null) continue;
      const item = toolResultItem({ eventId: resultNodeId(sessionId, callId), event,
        call: options.calls?.get(callId) ?? null, turnOrdinal: at.turn, stepOrdinal: at.step });
      if (item === null) continue;
      items.push(item);
      seqs.push(seq);
      continue;
    }
    const role = event.type === 'user/message' ? 'user'
      : event.type === 'system/message' ? 'system'
        : event.type === 'developer/message' ? 'developer'
          : event.type === 'assistant/message' ? 'assistant' : null;
    if (role === null) continue;
    const data = isRecord(event.data) ? event.data : {};
    const message = role === 'user' ? data
      : isRecord(data['message']) ? data['message'] : {};
    const content = message['content'];
    const toolCallIds = Array.isArray(content)
      ? content.filter((block) => isRecord(block) && block['type'] === 'tool-call'
        && typeof block['id'] === 'string').map((block) => block['id'] as string) : [];
    items.push({ id: `dsh:${sessionId}:message:${String(seq)}`, role,
      bytes: new TextEncoder().encode(textOf(content)),
      turnOrdinal: at.turn, stepOrdinal: at.step,
      ...toolCallIds.length > 0 ? { toolCallIds } : {} });
    seqs.push(seq);
  }
  return { items, seqs, currentTurnOrdinal: turn, currentStepOrdinal: globalStep,
    completedThroughTurnOrdinal: Math.min(completedThrough, turn) };
}

/**
 * The shortest quotation the feed treats as evidence of use. A shorter run is
 * too likely to be punctuation or a variable name repeated by accident, and
 * every span the feed emits is recomputed on every pass.
 */
export const QUOTED_SPAN_MIN_BYTES = 8;

/** How many quoted spans one pass may protect; protection is re-derived each time. */
export const QUOTED_SPAN_LIMIT = 16;

/** The first exact byte occurrence of `needle` in `haystack`, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  const first = needle[0];
  if (first === undefined || needle.length > haystack.length) return -1;
  const last = haystack.length - needle.length;
  outer: for (let start = 0; start <= last; start += 1) {
    if (haystack[start] !== first) continue;
    for (let offset = 1; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return start;
  }
  return -1;
}

/**
 * The text a user message presents as a quotation: inline code spans and
 * blockquote lines. Both are the shapes an agent uses to quote content back,
 * and both yield an exact string whose bytes can be located in the transcript.
 */
function quoteCandidates(text: string): readonly string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/`([^`\n]+)`/gu)) {
    const value = (match[1] ?? '').trim();
    if (value.length > 0) candidates.push(value);
  }
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*>\s?(.+)$/u.exec(line);
    const value = (match?.[1] ?? '').trim();
    if (value.length > 0) candidates.push(value);
  }
  return candidates;
}

/**
 * The spans the newest user message quotes from earlier transcript content
 * (ISSUE-022 chunk 5). Matching is exact: the bytes the guard protects are a
 * byte-identical occurrence in the source node, with that node's own sha256 and
 * length, so `checkProtection` can verify the span instead of refusing it.
 *
 * The newest node that contains the quotation wins: an agent quotes what it
 * just read. A span is emitted once per (node, start) and the list is capped.
 */
export function quotedSpansOf(items: readonly DshTranscriptItem[]): readonly SourceRange[] {
  let newestUser = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.role === 'user') { newestUser = index; break; }
  }
  if (newestUser <= 0) return [];
  const message = items[newestUser];
  if (message === undefined) return [];
  const text = new TextDecoder('utf-8', { fatal: false }).decode(message.bytes);
  const encoder = new TextEncoder();
  const spans: SourceRange[] = [];
  const seen = new Set<string>();
  for (const candidate of quoteCandidates(text)) {
    const needle = encoder.encode(candidate);
    if (needle.length < QUOTED_SPAN_MIN_BYTES) continue;
    for (let index = newestUser - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item === undefined) continue;
      const start = indexOfBytes(item.bytes, needle);
      if (start < 0) continue;
      const key = `${item.id}:${String(start)}`;
      // The same quotation twice in one message protects the same bytes once.
      if (seen.has(key)) break;
      seen.add(key);
      const bytes = new Uint8Array(item.bytes);
      spans.push({ source: { nodeId: item.id, sha256: sha256Sync(bytes), byteLength: bytes.length },
        range: { startByte: start, endByteExclusive: start + needle.length } });
      break;
    }
    if (spans.length >= QUOTED_SPAN_LIMIT) break;
  }
  return spans;
}

/**
 * The protection feed for one engine pass (ISSUE-022 chunk 5): the live state
 * the guard must refuse to cut.
 *
 * Populated:
 *   - `inFlightTurnOrdinal` — the turn currently being assembled, i.e. the
 *     surface's newest turn while no `turn/end` for it has been seen. Its bytes
 *     may not be cut, including a tool result the model has just received.
 *   - `quotedThisTurn` — `quotedSpansOf`, the exact earlier bytes the newest
 *     user message quotes.
 *
 * Reported as still unpopulated, never faked:
 *   - `newestTailNodeIds` — the PRD names a "newest tail", but no configured
 *     tail width exists in this repo. Any number chosen here would silently
 *     protect content the owner never sized, so the list stays empty.
 *   - `openApprovalNodeIds` — dsh exposes no approval concept to the mount.
 *   - `policySpans` — the system/developer message nodes are already protected
 *     whole by `computeProtectedRanges` (any `message` node is), so naming
 *     spans would add nothing the guard does not already have.
 */
export function protectionStateOf(items: readonly DshTranscriptItem[], params: {
  readonly currentTurnOrdinal: number;
  readonly completedThroughTurnOrdinal: number;
}): ProtectionState {
  const inFlightTurnOrdinal = params.currentTurnOrdinal > 0
    && params.currentTurnOrdinal > params.completedThroughTurnOrdinal
    ? params.currentTurnOrdinal : null;
  return {
    inFlightTurnOrdinal,
    newestTailNodeIds: [],
    openApprovalNodeIds: [],
    policySpans: [],
    quotedThisTurn: quotedSpansOf(items),
  };
}

/** The journal fields one published application records. */
function publishFields(sessionId: string, request: RacoonsApplicationRequest): Record<string, unknown> {
  return {
    sessionId,
    eventId: request.application.eventId,
    mode: request.application.mode,
    replacements: request.application.replacements.map((replacement) => ({
      nodeId: replacement.source.nodeId,
      sourceByteLength: replacement.source.byteLength,
      byteLength: replacement.bytes.length,
      text: new TextDecoder().decode(replacement.bytes),
      generatedRanges: replacement.generatedRanges,
      retainedCopies: replacement.retainedCopies,
      evidenceRecallId: replacement.evidenceRecallId,
    })),
    appendRecords: request.application.appendRecords.map((record) => ({
      recordId: record.recordId, byteLength: record.bytes.length,
      text: new TextDecoder().decode(record.bytes),
    })),
    archives: request.application.archives.map((archive) => ({
      ruleId: archive.ruleId, removalId: archive.removalId,
      operationKind: archive.operationKind, recallId: archive.recall.id,
      title: archive.title,
      sourceSha256: archive.recall.parts[0]?.source.sha256 ?? null,
      sourceNodeId: archive.recall.parts[0]?.source.nodeId ?? null,
      sourceByteLength: archive.recall.parts[0]?.source.byteLength ?? null,
      removedBytes: archive.recall.parts.reduce((sum, part) => sum + part.removedRanges
        .reduce((count, span) => count + span.range.endByteExclusive - span.range.startByte, 0), 0),
    })),
    sealedEpisodeIds: request.application.sealedEpisodeIds,
    applicationSha256: request.application.applicationSha256,
    intentId: request.intent.intentId,
  };
}

/**
 * Build the mount runtime: engine + adapter + port + per-session observation
 * state. Separated from `apply` so a test can exercise the whole seam against
 * a fake context and fake sessions with the real engine and adapter.
 *
 * The mount owns the two pieces of host state the seams need: the `tool/call`
 * facts (name and arguments, which a `tool/result` does not repeat) and the
 * queue of results waiting for the next `agent/pre-step`.
 */
export function createRacoonsMount(options: {
  readonly config: ResolvedRacoonsConfig;
  readonly storage: ResolvedRacoonsStorage;
  readonly openLedger?: RacoonsLedgerFactory;
  readonly journal?: RacoonsJournalSink;
  readonly clock?: Clock;
  /**
   * The host's model seam. Absent means the mount presents to the gate and
   * never answers it: the judge is journaled `off` with `no-llm-service`, which
   * is the truthful state of a mount without a model (ISSUE-024 chunk 2).
   */
  readonly llm?: DshLlmService;
  /** A fixed route, when the caller knows one; otherwise the host header decides. */
  readonly judgeRoute?: JudgeRoute;
  /**
   * The store of main's last dispatched request (ISSUE-026 chunk 3). The shipped
   * plugin fills it from its `llm/stream` observer; a test or a rig may inject
   * one it fills itself.
   */
  readonly mainWire?: MainWireCapture;
  /**
   * The host's own warning channel (`ctx.logger.warn`), when the plugin has one.
   * A storage open that will be retried is warned here as well as journaled, so
   * the operator sees the transient failure without reading the journal sink.
   */
  readonly warn?: (message: string) => void;
}): RacoonsMount {
  const { config, storage } = options;
  const clock: Clock = options.clock ?? { nowMs: () => Date.now() };
  const emit = options.journal ?? (() => {});
  const journal = (kind: RacoonsJournalKind, fields: Record<string, unknown>): void => {
    try {
      emit(Object.freeze({ kind, atMs: clock.nowMs(), ...fields }) as RacoonsJournalRecord);
    } catch { /* a journal sink must never alter engine outcomes */ }
  };
  const sessions = new Map<string, RacoonsSessionEntry>();
  const calls = new Map<string, Map<string, CallFacts>>();
  const buffers = new Map<string, Capture[]>();
  /**
   * Sessions a `/prune` user message named (ISSUE-022 chunk 5). `session/event`
   * may not append, so the trigger is only remembered here; the pass itself runs
   * at the next `agent/pre-step`, which is already the at-rest boundary.
   */
  const pruneRequests = new Set<string>();
  /**
   * Main's last dispatched request per session (ISSUE-026 chunk 3, ADR-0010).
   * Filled by the `llm/stream` observer at the only point this package can see
   * an outgoing request; the judge pass seeds its fork from it. Empty means the
   * host exposed no waterfall: the pass then fails open with `no-seed`.
   */
  const mainWire: MainWireCapture = options.mainWire ?? createMainWireCapture();
  const counters = { entries: 0, preSteps: 0, publications: 0, captured: 0 };
  /** Sessions already journaled `storage-unavailable`; the line is written once. */
  const unavailable = new Set<string>();
  /** Durable-open failures so far per session; the retry is bounded by `STORAGE_OPEN_ATTEMPTS`. */
  const openFailures = new Map<string, number>();
  /** Sessions whose effective per-session paths were journaled; one `storage-plan` each. */
  const planned = new Set<string>();
  /**
   * Each session's durable target, resolved once at its entry (ISSUE-022 chunk
   * 6). The prune round store writes beside the same `ledger.sqlite`; a session
   * with no durable plan (in-memory tests, or a refused id) has no entry here,
   * and its round stays in-process.
   */
  const targets = new Map<string, ResolvedRacoonsStorage>();
  /**
   * The token estimate every boundary reads (ISSUE-022 chunk 6): the same four
   * bytes-per-token heuristic the engine's own meter uses, kept here as an
   * estimate-only instance so the trigger and the engine cannot disagree about
   * how full the session is. The trigger adds main's captured system+tools
   * prefix to it (ADR-0009 §Amendment 2026-10-24); this meter itself only
   * measures bytes it is handed. It records no usage observations.
   */
  const estimateMeter = new Meter(new CharHeuristicTokenMeter());

  /**
   * Journal the final refusal and return the wallet that refuses every call
   * (ADR-0013 ruling 4). `storage-unavailable` is written once per session.
   */
  function refuseStorage(sessionId: string, failure: {
    readonly code: string; readonly path: string | null; readonly message: string;
    readonly storagePath: string;
  }): Ledger {
    if (!unavailable.has(sessionId)) {
      unavailable.add(sessionId);
      // ADR-0013 ruling 8: runtime evidence comes from inside the mount.
      journal('storage-unavailable', { sessionId, code: failure.code, path: failure.path,
        node: process.version, storage: failure.storagePath, message: failure.message });
    }
    return createRefusingLedger({ code: failure.code, path: failure.path, message: failure.message });
  }

  /**
   * Open this session's ledger, or install a refusing one (ADR-0013 ruling 4,
   * ISSUE-004 chunk 4). Only the adapter's own open is wrapped: a host-supplied
   * `openLedger` belongs to the host, so its failure stays the host's.
   *
   * A transient failure is retried at the next boundary instead of degrading
   * the mount for its whole lifetime (critic fix P2#4): the first failure
   * journals `storage-retry`, warns, and throws `RacoonsStorageRetryError` so
   * this pre-step is skipped; the next `sessionFor` call (next pre-step,
   * turn-end or prune) tries the real open again. Only a second failure
   * installs the refusing ledger and journals `storage-unavailable` once. A
   * successful retry journals `storage-recovered`. Neither line repeats.
   */
  async function openOrRefuse(target: ResolvedRacoonsStorage,
    sessionId: string): Promise<Ledger> {
    if (options.openLedger !== undefined) return options.openLedger(sessionId);
    try {
      const ledger = await openLedger(target, clock);
      const failures = openFailures.get(sessionId) ?? 0;
      if (failures > 0) {
        openFailures.delete(sessionId);
        journal('storage-recovered', { sessionId, attempts: failures, node: process.version,
          storage: target.databasePath });
      }
      return ledger;
    } catch (error) {
      const code = error instanceof RacoonsStorageError ? error.code : 'unexpected';
      const path = error instanceof RacoonsStorageError ? error.path : target.databasePath;
      const message = error instanceof Error ? error.message : String(error);
      const failures = (openFailures.get(sessionId) ?? 0) + 1;
      openFailures.set(sessionId, failures);
      if (failures < STORAGE_OPEN_ATTEMPTS) {
        journal('storage-retry', { sessionId, attempt: failures,
          attempts: STORAGE_OPEN_ATTEMPTS, code, path, node: process.version,
          storage: target.databasePath, message });
        options.warn?.(`storage open failed (${code} at ${path ?? target.databasePath});`
          + ` retrying at the next step boundary: ${message}`);
        throw new RacoonsStorageRetryError(sessionId, failures, { code, path, message });
      }
      return refuseStorage(sessionId, { code, path, message,
        storagePath: target.databasePath });
    }
  }

  /**
   * This session's own durable target, or the typed refusal when the id cannot
   * be a directory name. An unsafe id goes through the same refusal path as a
   * failed open (critic fix P3#8): a refusing ledger plus one journal line,
   * never a throw into the host's retry loop — a retry cannot fix the id.
   */
  function deriveTarget(sessionId: string):
  { readonly target: ResolvedRacoonsStorage } | { readonly refusal: {
    readonly code: string; readonly path: string | null; readonly message: string;
    readonly storagePath: string;
  } } {
    if (storage.root === undefined) return { target: storage };
    try {
      return { target: resolveSessionStorage(storage.root, sessionId) };
    } catch (error) {
      const refusal = error instanceof RacoonsStorageError ? error : null;
      return { refusal: {
        code: refusal?.code ?? 'invalid-session-id',
        path: refusal?.path ?? sessionId,
        message: error instanceof Error ? error.message : String(error),
        // No per-session plan exists (the id is the fault), so the line names
        // the durable root rather than an unrefined `<sessionId>` layout.
        storagePath: storage.root,
      } };
    }
  }

  /** One engine/adapter/port triple per dsh session, opened on first use. */
  async function sessionFor(sessionId: string, host?: DshMountSession): Promise<RacoonsSessionEntry> {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) {
      if (host !== undefined) existing.host = host;
      return existing;
    }
    const ownedLedger = options.openLedger === undefined;
    // ADR-0013: a durable plan carries `root`; it becomes this session's own
    // `sessions/<id>/ledger.sqlite` + `blobs/`. `':memory:'` opens the pair.
    // An unsafe id is refused here, through the same refusing ledger a failed
    // open installs (critic fix P3#8) — a retry can never fix the id.
    const derived = deriveTarget(sessionId);
    if ('target' in derived && storage.root !== undefined && !planned.has(sessionId)) {
      planned.add(sessionId);
      // The EFFECTIVE refined plan, journaled where the refinement happens
      // (critic fix P3#10): the mount line must never carry `<sessionId>`.
      journal('storage-plan', { sessionId, databasePath: derived.target.databasePath,
        blobRoot: derived.target.blobRoot, node: process.version });
    }
    const ledger = 'refusal' in derived
      ? refuseStorage(sessionId, derived.refusal)
      : await openOrRefuse(derived.target, sessionId);
    // A retryable open failure throws `RacoonsStorageRetryError` out of here
    // before any state is installed: the caller's next boundary retries, and no
    // half-built entry is ever visible to `sessions`.
    const publications: unknown[] = [];
    let latestRequest: RacoonsApplicationRequest | null = null;
    /** The judge pass's receipts, appended by the step boundary (chunk 3). */
    const pendingReceipts: string[] = [];
    /**
     * Recall ids the applied applications minted, drained by the judge receipt
     * (ISSUE-026 chunk 3). A refused cut mints none, so the pass only quotes
     * them when the engine reports `applied`.
     */
    const mintedRecallIds: string[] = [];
    // ISSUE-024: the revert seam is derived from the live host session, never
    // from a config flag, so `revertHistory` below can only be true when one
    // exists (ISSUE-010's capability-truth law). The seam closes over the host
    // object and reads its surface at apply time, so a later host mutation is
    // seen; only a mount that opens with no host stays revert-less for good.
    const seam = revertSessionFromHost(host);
    const port = createDshPort({ sessionId, clock,
      ...(seam === null ? {} : { revert: seam }),
      publish: (request) => {
        const owned = request as unknown as RacoonsApplicationRequest;
        latestRequest = owned;
        for (const archive of owned.application.archives) mintedRecallIds.push(archive.recall.id);
        try { publications.push(structuredClone(request)); }
        catch { publications.push(request); }
        counters.publications += 1;
        journal('publish', publishFields(sessionId, owned));
      } });
    const capabilities = createDshCapabilities(seam !== null);
    // The seam is a capability; a *removal* needs no cache watermark. ADR-0012:
    // removal applies unconditionally, and an unknown cache has no fresh-zone
    // floor (`computeFreshZone` starts at 0), so the guard never refuses a cut
    // merely for being below a watermark. Only a real warm watermark can refuse
    // `cut-below-watermark`. The mount cannot derive one from dsh yet, so it
    // states the cache as `unknown` and lets the guard apply (ISSUE-024).
    journal('capabilities', { sessionId, revertHistory: capabilities.revertHistory,
      reason: seam === null ? 'no-host-revert-seam' : 'host-session',
      cacheState: 'unknown' });
    // The judge seam is built after the engine (it drives `engine.process` for
    // the verdict batch), while the engine's telemetry needs it to see
    // `gate-presented`. One forward reference holds the pair together.
    let capturePresentation: JudgeSeam | null = null;
    const engine = await RacoonsEngine.open({
      sessionId,
      capabilities: { ...capabilities },
      config: engineConfig(config),
      clock,
      meter: new Meter(new CharHeuristicTokenMeter()),
      ledger,
      rules: createDefaultRules(engineConfig(config)) as readonly Rule[],
      port,
      onTelemetry: (event) => {
        journal('telemetry', { sessionId, event });
        // The gate's own presentation is the judge's only input (ISSUE-024
        // chunk 2): the ids and round come from the core, never from the mount.
        capturePresentation?.capture(event);
      },
    });
    const judge = createJudgeSeam({
      sessionId, engine, port, barBytes: config.barBytes, journal,
      ...(options.llm === undefined ? {} : { llm: options.llm }),
      ...(config.anchors === 'off' ? {} : { anchors: config.anchors }),
      timeoutMs: config.judgeTimeoutMs,
      route: () => judgeRouteOf(host, options.judgeRoute),
      // Main's last dispatched request is the only seed: a re-rendered or
      // transcript-derived seed shares no prefix with what the provider already
      // saw. Absent (the host exposed no waterfall, or no main call yet) the
      // pass seeds nothing and fails open — it never invents a seed.
      seed: () => mainWire.last(sessionId),
      recallIds: () => { const ids = mintedRecallIds.slice(); mintedRecallIds.length = 0; return ids; },
      appendReceipt: (text) => { pendingReceipts.push(text); },
    });
    capturePresentation = judge;
    const adapter = createDshAdapter({ engine, port, clock,
      ...(seam === null ? {} : { revert: seam }) });
    // The round the last process completed, read back from this session's own
    // directory (ISSUE-022 chunk 6). `':memory:'` answers 0, so tests keep the
    // old per-process behaviour unless they opt into a durable root.
    const durable = 'target' in derived && derived.target.databasePath !== ':memory:'
      ? derived.target : null;
    if (durable !== null) targets.set(sessionId, durable);
    const persistedRound = durable === null ? 0 : readPruneRound(durable);
    if (persistedRound > 0) {
      journal('prune-round-resumed', { sessionId, round: persistedRound });
    }
    const entry: RacoonsSessionEntry = { sessionId, engine, adapter, port, ledger, ownedLedger,
      publications, host: host ?? null, judge, pruneRounds: persistedRound, pendingReceipts,
      pruneTrigger: new PruneWindowTrigger(config.contextWindowTokens),
      takePublication: () => { const value = latestRequest; latestRequest = null; return value; } };
    sessions.set(sessionId, entry);
    return entry;
  }

  /**
   * Sync the port's transcript from the live surface (optionally a prefix), then
   * report the ordinals. `completedThroughTurnOrdinal` may be raised by the
   * caller: at `agent/turn-stopping` the current turn is about to end, and the
   * core's `turn-end` at-rest reason exists for exactly that boundary.
   *
   * `surfaceCompletedThroughTurnOrdinal` is the surface's own last `turn/end`,
   * before that override. Protection derives the in-flight turn from the host
   * log, not from a caller's boundary intent: the host appends `turn/end` only
   * after `agent/turn-stopping`, so the turn is still being assembled there.
   */
  function syncTranscript(entry: RacoonsSessionEntry, session: DshMountSession,
    syncOptions: TranscriptSyncOptions = {}) {
    const callFacts = calls.get(entry.sessionId);
    const synced = surfaceTranscript(session, {
      ...syncOptions.beforeSeq === undefined ? {} : { beforeSeq: syncOptions.beforeSeq },
      sessionId: entry.sessionId,
      ...callFacts === undefined ? {} : { calls: callFacts },
    });
    entry.port.setTranscript(synced.items);
    const completedThrough = syncOptions.completedThroughTurnOrdinal
      ?? synced.completedThroughTurnOrdinal;
    entry.port.updateState({
      currentTurnOrdinal: synced.currentTurnOrdinal,
      currentStepOrdinal: synced.currentStepOrdinal,
      completedThroughTurnOrdinal: completedThrough,
    });
    return { ...synced, completedThroughTurnOrdinal: completedThrough,
      surfaceCompletedThroughTurnOrdinal: synced.completedThroughTurnOrdinal };
  }

  /**
   * Sync the transcript and feed the guard's protection in one call. The mount's
   * engine passes use this wrapper (ISSUE-022 chunk 5): a pass that planned and
   * validated against a protection state older than its transcript could either
   * cut an in-flight result or refuse a legal plan. `syncTranscript` alone stays
   * a transcript/ordinal projection, so a caller that drives its own engine pass
   * must feed protection itself.
   */
  function syncPass(entry: RacoonsSessionEntry, session: DshMountSession,
    syncOptions: TranscriptSyncOptions = {}) {
    const synced = syncTranscript(entry, session, syncOptions);
    entry.port.updateState({ protection: protectionStateOf(synced.items, {
      currentTurnOrdinal: synced.currentTurnOrdinal,
      completedThroughTurnOrdinal: synced.surfaceCompletedThroughTurnOrdinal,
    }) });
    return synced;
  }

  /**
   * Observe one host event. Captures a `tool/call`'s facts and queues its
   * `tool/result` for the next pre-step. Never appends: the host forbids it
   * inside this callback.
   *
   * Only append-origin results are captured (`surfaceOp === 'append'`), so the
   * mount never re-caps its own replacement.
   *
   * A failed result is captured for the transcript projection but never queued
   * for the entry seam: failure is not a cappable result (S7). The transcript
   * still carries it, so the episode tracker reads `failed: true` and no search
   * episode can call it a miss.
   */
  function observe(session: DshMountSession, event: DshMountEvent): DshToolResultItem | null {
    const data = isRecord(event.data) ? event.data : {};
    if (event.type === 'tool/call' && typeof data['callId'] === 'string') {
      const list = calls.get(session.id) ?? new Map<string, CallFacts>();
      list.set(data['callId'], { name: data['name'], arguments: data['arguments'] });
      calls.set(session.id, list);
      return null;
    }
    // The `/prune` command (ISSUE-022 chunk 5). The mount owns this trigger, not
    // the engine's tool union: the pass is mount state read by mount code, and
    // a registered host tool would have to fake an engine event to reach it. A
    // message is observed here (no append) and the pass runs at the next
    // pre-step, which is already the at-rest boundary a prune may use.
    if (event.type === 'user/message') {
      const message = isRecord(data['message']) ? data['message'] : data;
      if (textOf(message['content']).trim() === PRUNE_COMMAND) {
        pruneRequests.add(session.id);
        journal('prune-requested', { sessionId: session.id, seq: event.seq });
      }
      return null;
    }
    // The native-compaction backstop (ISSUE-022 DoD; CRITIC-022 P1-1). The host
    // rewrites the surface on its own, so the latch's growth baseline no longer
    // describes the session: with the flag on, the end of a compaction re-arms
    // exactly as a completed pass does. This mount never suppresses, intercepts
    // or rewrites the host's compaction (owner ruling 2026-10-23, ISSUE-029);
    // the flag only decides whether the observation re-arms our own latch. The
    // observation is journaled either way, so a run shows that it happened.
    if (event.type === 'compaction/end') {
      const armed = config.nativeCompactionBackstop;
      const entry = sessions.get(session.id);
      if (armed && entry !== undefined) entry.pruneTrigger.noteNativeCompaction();
      journal('native-compaction', { sessionId: session.id, seq: event.seq,
        rearmed: armed && entry !== undefined });
      return null;
    }
    if (event.type !== 'tool/result' || event.surfaceOp !== 'append') return null;
    const callId = callIdOf(event);
    // A result with no call id cannot be paired with its call, so the surface
    // projection skips it and the entry seam must not invent an identity.
    if (callId === null) return null;
    const call = calls.get(session.id)?.get(callId) ?? null;
    const item = toolResultItem({
      // One host node, one transcript id: `surfaceTranscript` names a result by
      // its call id, so the entry seam must too. A seq-based id here would make
      // the same node two units the moment the step re-syncs, and a gate would
      // present an id the next snapshot cannot reproduce (ISSUE-024 chunk 2's
      // unit resolution).
      eventId: resultNodeId(session.id, callId),
      event,
      call,
      turnOrdinal: isCount(data['turn']) ? data['turn'] : 0,
      stepOrdinal: isCount(data['step']) ? data['step'] : 0,
    });
    if (item === null) return null;
    if (isRecord(item.hostData) && item.hostData['isError'] === true) {
      journal('skip', { sessionId: session.id, eventId: item.id, callId: item.callId,
        toolName: item.toolName, byteLength: item.bytes.length, reason: 'failed-result' });
      return null;
    }
    const buffer = buffers.get(session.id) ?? [];
    buffer.push({ eventId: item.id, item, seq: event.seq });
    buffers.set(session.id, buffer);
    counters.captured += 1;
    return item;
  }

  /** Observe one request the host dispatched; junk and our own asks are skipped. */
  function observeWire(options: unknown): void {
    mainWire.note(options);
  }

  /** Drain one captured tool result through the entry seam. */
  async function deliverEntry(entry: RacoonsSessionEntry, capture: Capture): Promise<EngineResult> {
    counters.entries += 1;
    const result = await entry.adapter.onToolResult(capture.eventId, capture.item);
    journal('entry', { sessionId: entry.sessionId, eventId: capture.eventId,
      callId: capture.item.callId, toolName: capture.item.toolName,
      byteLength: capture.item.bytes.length, status: result.status,
      intentId: result.intentId,
      issues: result.validation?.ok === false ? result.validation.issues : [],
    });
    return result;
  }

  /**
   * Answer the gate the at-rest pass just opened (ISSUE-024 chunk 2). The
   * window and round come from the engine's own `gate-presented` event, which
   * the telemetry sink above hands to `judge.capture`. A refused ask is
   * journaled and skipped; nothing here throws into the host's step.
   */
  async function runJudge(entry: RacoonsSessionEntry): Promise<JudgeSettleOutcome | null> {
    try {
      return await entry.judge.settle();
    } catch (error) {
      journal('judge-error', { sessionId: entry.sessionId,
        message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  /**
   * Run one prune pass (ISSUE-022 chunks 5–6): the snapshot, the transcript and
   * the protection all come from the port; the ask goes through the host's own
   * model seam. The round ordinal is persisted beside the session's ledger, so a
   * resumed process continues the count instead of starting at round 1.
   *
   * Record-only stays the structural default: a pass with no window configured
   * applies nothing, and the record is telemetry. When a window IS configured
   * the enforcement mode decides — `apply` hands the merged document to the
   * engine's `{kind:'prune'}` input, which plans one checkpoint-revert for the
   * whole pass (one epoch break, ADR-0009); `record-only` still records.
   */
  async function runPrune(session: DshMountSession): Promise<RecordOnlyPruneOutcome | null> {
    // Reached from `runStep` (the entry exists) or directly by a rig/test, where
    // a retryable open surfaces as `RacoonsStorageRetryError` to the caller —
    // the same seam every other boundary uses.
    const entry = await sessionFor(session.id, session);
    pruneRequests.delete(session.id);
    syncPass(entry, session);
    const snapshot = await entry.port.snapshot();
    // The pass's own pre-pass reading is the latch's new baseline (CRITIC-022
    // P1-1): a completed pass re-arms, so the next fire needs a below-half
    // excursion or half a window of growth past what this pass saw. It carries
    // the same fixed prefix the step observation does (ADR-0009 §Amendment
    // 2026-10-24), or the baseline would sit a whole prefix below every later
    // reading and the next step would re-fire on unchanged content.
    const prePassUsage = estimatedContentTokens(estimateMeter, snapshot, null,
      mainWire.last(entry.sessionId)?.wire ?? null);
    entry.pruneRounds += 1;
    try {
      const outcome = await runRecordOnlyPrune({
        sessionId: entry.sessionId,
        snapshot,
        transcript: entry.port.transcript(),
        round: entry.pruneRounds,
        barBytes: config.barBytes,
        episodeNoNewPathSteps: config.episodeNoNewPathSteps,
        ...(options.llm === undefined ? {} : { llm: options.llm }),
        route: () => judgeRouteOf(entry.host ?? session, options.judgeRoute),
        // The same capture the judge pass seeds from (ISSUE-027, ADR-0010): a
        // prune ask is a fork of main's last sent request, never a re-render.
        seed: () => mainWire.last(entry.sessionId),
        journal,
        timeoutMs: config.judgeTimeoutMs,
      });
      // The pass completed; the next one gets the next ordinal even after a
      // restart. A write failure is journaled inside and never fails the pass.
      const target = targets.get(entry.sessionId);
      if (target !== undefined) writePruneRound(target, entry.pruneRounds, journal, entry.sessionId);
      // The apply leg (ISSUE-022 chunk 6; ADR-0009): one engine event for the
      // whole pass, so the guard validates once and the pass costs exactly one
      // checkpoint-revert. A mount with no window stays record-only, which is
      // the rollout's first stage (ADR-0008).
      await applyPrunePass({ sessionId: entry.sessionId, engine: entry.engine,
        application: outcome.application, round: outcome.plan.round,
        windowTokens: config.contextWindowTokens, journal,
        // Read for the journal line only: the engine decides, and its answer is
        // what the line reports (CRITIC-022 P2 #8).
        enforcement: config.enforcement,
        revertHistory: entry.adapter.capabilities.revertHistory });
      return outcome;
    } catch (error) {
      // A caller bug inside core's planners is the only throw; a host must
      // still see its step finish, so it lands as a named record.
      journal('prune-error', { sessionId: entry.sessionId,
        message: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      // CRITIC-022 P1-1: a pass ends here whether it applied, refused or threw,
      // and every ending re-arms the latch. The baseline is this pass's own
      // pre-pass reading, so the next fire needs half a window of growth past
      // it or a below-half excursion — one pass (or one throw) can no longer
      // close the latch for the rest of the session.
      entry.pruneTrigger.notePassCompleted(prePassUsage);
    }
  }

  /**
   * Take the publication a pass produced, if the host still has to publish it.
   *
   * Only an append-mode application is a host publication. An entry application
   * is published by its own `agent/pre-step` branch (`entryApplications`), and
   * a revert splices the surface itself through the derived seam
   * (`port.applyRevert` → `applyValidatedRevert`) without ever calling
   * `publish`; taking either here would append what already landed elsewhere.
   * The journal recorded all of them (`publish`), so dropping the taken value
   * loses nothing.
   */
  function takeAppendRequest(entry: RacoonsSessionEntry): RacoonsApplicationRequest | null {
    const request = entry.takePublication();
    return request !== null && request.application.mode === 'append' ? request : null;
  }

  /** Run one at-rest pass. `turn-end` uses the engine's own turn-end reason. */
  async function runAtRest(entry: RacoonsSessionEntry, eventId: string,
    reason: 'step' | 'turn-end'): Promise<EngineResult> {
    counters.preSteps += 1;
    const result = reason === 'turn-end'
      ? await entry.engine.process({ kind: 'at-rest', eventId, reason: 'turn-end' })
      : await entry.adapter.onPreStep(eventId);
    journal('at-rest', { sessionId: entry.sessionId, eventId, reason,
      status: result.status, intentId: result.intentId,
      issues: result.validation?.ok === false ? result.validation.issues : [],
    });
    return result;
  }

  /**
   * One step boundary: sync the transcript, deliver every queued result, then
   * run the at-rest pass. Publication is the caller's job, because only it holds
   * the live session.
   */
  async function runStep(session: DshMountSession,
    ordinals: { turn: number; step: number }): Promise<StepOutcome> {
    const entry = await sessionFor(session.id, session);
    const queued = buffers.get(session.id) ?? [];
    buffers.set(session.id, []);
    const deliveries: EngineResult[] = [];
    const entryApplications: { request: RacoonsApplicationRequest; capture: Capture }[] = [];
    for (const capture of queued) {
      let result: EngineResult;
      try {
        // The port appends what it is handed, so it plans against the prefix
        // that ends exactly where this result sits in the host surface.
        syncPass(entry, session, { beforeSeq: capture.seq });
        result = await deliverEntry(entry, capture);
      } catch (error) {
        // A host refusal must not stop the next result or the at-rest pass; the
        // journal records it and the scenario fails by name.
        journal('entry-error', { sessionId: entry.sessionId, eventId: capture.eventId,
          message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      deliveries.push(result);
      const request = entry.takePublication();
      if (request !== null) entryApplications.push({ request, capture });
    }
    // The at-rest pass sees the whole live surface, including any node the
    // deliveries added after the last captured result.
    syncPass(entry, session);
    const atRestId = eventIdFor(session.id, 'step',
      (Number(ordinals.turn) * 1_000_000) + Number(ordinals.step));
    let atRest: EngineResult | null = null;
    let appendRequest: RacoonsApplicationRequest | null = null;
    let judged: JudgeSettleOutcome | null = null;
    try {
      atRest = await runAtRest(entry, atRestId, 'step');
      appendRequest = takeAppendRequest(entry);
      judged = await runJudge(entry);
      appendRequest = takeAppendRequest(entry) ?? appendRequest;
    } catch (error) {
      journal('at-rest-error', { sessionId: entry.sessionId, eventId: atRestId,
        message: error instanceof Error ? error.message : String(error) });
    }
    // The half-window estimate is observed at EVERY step boundary, whatever runs
    // after it (CRITIC-022 P2 #5). The old `else if` observed only on a step with
    // no `/prune`, so a command step left the latch blind to its own reading and
    // the session's next crossing was judged against a stale baseline. The
    // crossing is journaled even when a manual pass also runs, and that pass
    // consumes it: `runPrune`'s finally re-arms the latch from its own reading,
    // so one step never runs two passes.
    //
    // The denominator is the WHOLE request: the fixed system+tools prefix of
    // main's captured request plus the live transcript (ADR-0009 §Amendment
    // 2026-10-24). The prefix is read from the capture's own `system` and
    // `tools` fields — the object the host dispatched — never re-rendered from
    // config. A session whose first main request is not captured yet has no
    // prefix to count, and the journal line says `content` for that reading.
    const prefix = mainWire.last(entry.sessionId)?.wire ?? null;
    const estimate = entry.pruneTrigger.enabled
      ? estimateContent(estimateMeter, await entry.port.snapshot(), null, prefix) : null;
    const estimatedTokens = estimate === null ? null : estimate.totalTokens;
    const crossed = estimatedTokens !== null && entry.pruneTrigger.observe(estimatedTokens);
    if (crossed && estimate !== null) {
      // The half-window auto trigger (ISSUE-022 chunk 6; ADR-0009 §Amendment):
      // the SAME seam as the command, one boundary later. The latch fires on a
      // crossing and re-arms when a pass ends or a compaction lands (CRITIC-022
      // P1-1), so a grown session re-prunes only after half a window of new
      // content — never on every step. No window configured means the latch is
      // disabled and nothing is scheduled (record-only, ADR-0008).
      journal('prune-threshold', { sessionId: entry.sessionId, estimatedTokens,
        contentTokens: estimate.contentTokens, prefixTokens: estimate.prefixTokens,
        estimate: prefix === null ? 'content' : 'content+prefix',
        threshold: entry.pruneTrigger.threshold });
    }
    // A `/prune` message seen during this step runs here, after the at-rest pass
    // and the judge: both leave the entry's state settled, and a prune reads
    // that state without writing any.
    if (pruneRequests.has(session.id) || crossed) {
      try { await runPrune(session); }
      catch (error) {
        journal('prune-error', { sessionId: entry.sessionId,
          message: error instanceof Error ? error.message : String(error) });
      }
    }
    // The judge's one receipt per pass, appended here — the pre-step dispatch is
    // a serial hook, so appending is legal, and the receipt never enters the
    // fork (ISSUE-026 chunk 3 / ADR-0010).
    const receipts = appendReceipts(entry, session);
    return { entry, deliveries, atRest, judged, entryApplications, appendRequest, receipts };
  }

  /**
   * Append every receipt the judge seam queued, one user-role message each. The
   * pass itself appends exactly one; the queue exists so the seam stays free of
   * host calls and a test can read the text before it lands.
   */
  function appendReceipts(entry: RacoonsSessionEntry, session: DshMountSession): DshMountEvent[] {
    const events: DshMountEvent[] = [];
    for (const text of entry.pendingReceipts.splice(0)) {
      try {
        events.push(session.append('user/message', {
          content: [{ type: 'text', text }],
          source: { kind: `${config.recordName}/judge-receipt` },
          role: 'user',
          id: randomUUID(),
        }, { surfaceOp: 'append' }));
      } catch (error) {
        journal('judge-receipt-error', { sessionId: entry.sessionId,
          message: error instanceof Error ? error.message : String(error) });
      }
    }
    return events;
  }

  /**
   * The turn-end boundary: dsh appends `turn/end` after `agent/turn-stopping`
   * and no further pre-step follows in a one-shot run, so this is the last safe
   * place to seal an episode that just closed. Appending here is legal — the
   * dispatch is a serial hook, not the `session/event` observer.
   */
  async function runTurnEnd(session: DshMountSession, turn: number): Promise<TurnEndOutcome> {
    const entry = await sessionFor(session.id, session);
    syncPass(entry, session, { completedThroughTurnOrdinal: Number(turn) });
    const eventId = eventIdFor(session.id, 'turn', Number(turn));
    let atRest: EngineResult | null = null;
    let appendRequest: RacoonsApplicationRequest | null = null;
    let judged: JudgeSettleOutcome | null = null;
    try {
      atRest = await runAtRest(entry, eventId, 'turn-end');
      appendRequest = takeAppendRequest(entry);
      judged = await runJudge(entry);
      appendRequest = takeAppendRequest(entry) ?? appendRequest;
    } catch (error) {
      journal('at-rest-error', { sessionId: entry.sessionId, eventId,
        message: error instanceof Error ? error.message : String(error) });
    }
    const receipts = appendReceipts(entry, session);
    return { entry, atRest, judged, appendRequest, receipts };
  }

  return { sessions, counters, sessionFor, syncTranscript, observe, observeWire,
    runStep, runTurnEnd, runPrune,
    close: async () => {
      for (const entry of sessions.values()) {
        if (entry.ownedLedger) await entry.ledger.close().catch(() => {});
      }
      sessions.clear();
    } };
}

/**
 * Publish the entry application the port just committed: one content-only
 * `tool/result` surface replacement over exactly the captured node.
 */
export function publishEntry(session: DshMountSession, request: RacoonsApplicationRequest,
  capture: Capture): DshMountEvent | null {
  const replacement = request.application.replacements[0];
  if (replacement === undefined) return null;
  // The result's current surface position, not the seq it was captured at: a
  // later cap already replaced the node once, and the surface moved with it.
  const seq = currentResultSeq(session, capture.item.callId);
  if (seq === null) throw new Error(`racoons: no live tool/result for call ${capture.item.callId}`);
  const original = session.eventAt?.(seq);
  if (original === undefined) throw new Error(`racoons: no host event at seq ${String(seq)}`);
  const data = isRecord(original.data) ? original.data : {};
  const message = isRecord(data['message']) ? data['message'] : {};
  const text = new TextDecoder('utf-8', { fatal: false }).decode(replacement.bytes);
  return session.append('tool/result', {
    turn: data['turn'],
    step: data['step'],
    message: { ...message, content: [{ type: 'text', text }] },
    ...data['meta'] !== undefined ? { meta: data['meta'] } : {},
    ...data['error'] !== undefined ? { error: data['error'] } : {},
  }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
}

/**
 * Publish the append application the port just committed: every generated record
 * becomes one appended `user/message` carrying its rendered text.
 */
export function publishAppend(session: DshMountSession, request: RacoonsApplicationRequest,
  config: ResolvedRacoonsConfig): DshMountEvent[] {
  const events: DshMountEvent[] = [];
  for (const record of request.application.appendRecords) {
    const text = new TextDecoder().decode(record.bytes);
    events.push(session.append('user/message', {
      content: [{ type: 'text', text }],
      source: { kind: config.recordName, recordId: record.recordId },
      role: 'user',
      id: randomUUID(),
    }, { surfaceOp: 'append' }));
  }
  return events;
}

/**
 * The one live session this process is driving. dsh's turn-stopping hook may
 * carry no agent, and the headless profile runs exactly one session per process,
 * so the store's single live session is that turn's owner. More than one live
 * session means this hook cannot know which one ended: it refuses rather than
 * guess.
 */
export function singleLiveSession(ctx: DshMountContext): DshMountSession | undefined {
  const store = ctx.sessions;
  if (store === undefined || typeof store.list !== 'function') return undefined;
  const live = store.list();
  return live.length === 1 ? live[0] : undefined;
}

/**
 * The host tool registry, when the context provides one. Resolved through
 * `ctx.get` so an unavailable service is a miss, not a proxy throw.
 */
export function resolveToolHost(ctx: DshMountContext,
  fallback: DshToolHost | undefined): DshToolHost | undefined {
  if (fallback !== undefined) return fallback;
  let value: unknown;
  try {
    value = typeof ctx.get === 'function' ? ctx.get('tools') : undefined;
  } catch {
    return undefined;
  }
  if (value === undefined) {
    try { value = ctx.tools; } catch { return undefined; }
  }
  return isRecord(value) && typeof value['register'] === 'function'
    ? value as unknown as DshToolHost : undefined;
}

/**
 * Register the handler-backed tools once, at mount, and return one disposer.
 * `DSH_TOOL_SPECS` declares `forget`, `expand` and `recall`, but only `recall`
 * has an execution path, so only `recall` is registered: no model is ever
 * offered a tool that would fail (design-protocol §4).
 *
 * The host's `register` takes a `ToolDefinition` (schema plus a mandatory
 * `output` declaration), while the adapter's seam is `{ spec, execute }`. The
 * mapping lives here so the package still carries no dsh dependency, and so the
 * unregister the host returns is the only disposal contract this file relies on.
 *
 * `execute` must return the projected output, never the raw ledger record: the
 * record carries `Uint8Array` bodies, and the host snapshots every tool value
 * as lossless JSON (`snapshotJsonValue`; non-JSON is `INVALID_TOOL_OUTPUT`).
 * `recallText` is the projection — verified bytes decoded as UTF-8 — so it is
 * also the second hash check between the ledger and the model.
 */
export function registerPluginTools(
  host: DshToolHost, recall: (id: string) => Promise<RecallRecord>,
): () => void {
  const registered: (() => void)[] = [];
  try {
    for (const spec of DSH_TOOL_SPECS) {
      // Handler-filtered by construction: only the tool with an execution path.
      if (spec.name !== 'recall') continue;
      registered.push(host.register({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: {
          // The recall payload is an object; this unconstrained schema accepts
          // it and `render` turns it into the one text block the model reads.
          schema: {},
          render: (_args: unknown, value: unknown): unknown => {
            const text = isRecord(value) && typeof value['text'] === 'string' ? value['text'] : '';
            return [{ type: 'text', text }];
          },
        },
        execute: async (args: unknown): Promise<DshRecallOutput> => {
          const id = isRecord(args) && typeof args['id'] === 'string' ? args['id'] : null;
          if (id === null) throw new Error('recall expects a non-empty id');
          const record = await recall(id);
          return recallText(record, id as RecallId);
        },
      } as never));
    }
  } catch (error) {
    for (const unregister of registered.reverse()) {
      try { unregister(); } catch { /* best effort on a failed mount */ }
    }
    throw error;
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const unregister of registered.reverse()) {
      try { unregister(); } catch { /* teardown only */ }
    }
  };
}

/**
 * Create the shipped mount plugin. The returned object is the Cordis plugin
 * itself: `{ name, inject, apply }`.
 *
 * `apply(ctx, config)` merges the patch row's config over the factory defaults,
 * so a `--patch` row can tune thresholds without code.
 */
export function createRacoonsPlugin(options: RacoonsPluginOptions = {}): {
  readonly name: string;
  readonly inject: readonly string[];
  apply(ctx: DshMountContext, config?: RacoonsPluginConfig): Promise<void>;
} {
  const nowMs = options.nowMs ?? (() => Date.now());
  return {
    name: RACOONS_PLUGIN_NAME,
    inject: RACOONS_PLUGIN_INJECT,
    async apply(ctx, rawConfig) {
      const config = resolvePluginConfig({ ...options.config, ...rawConfig });
      const storage = resolveStorage(options.storage, config.racoonsStorageRoot);
      // A host-supplied ledger wins; otherwise the default plan is durable
      // (ADR-0013) and `':memory:'` only appears when a test asks for it.
      const ledgerSource = options.openLedger !== undefined ? 'host'
        : storage.databasePath === ':memory:' ? 'memory' : 'durable';
      // The host's model seam: the same `llm` service dsh-compaction-basic
      // drives. Absent, the mount presents to the gate and journals `judge-off`
      // instead of pretending it asked (ISSUE-024 chunk 2).
      const llm = ctx.llm ?? undefined;
      const warn = (message: string): void => {
        try { ctx.logger?.warn?.(`racoons: ${message}`); } catch { /* logging only */ }
      };
      const mount = createRacoonsMount({ config, storage, clock: { nowMs },
        ...llm === undefined ? {} : { llm },
        ...options.judgeRoute === undefined ? {} : { judgeRoute: options.judgeRoute },
        ...options.openLedger === undefined ? {} : { openLedger: options.openLedger },
        ...options.journal === undefined ? {} : { journal: options.journal },
        warn });
      // Typed, not cast: `kind` must be a member of the closed journal
      // vocabulary, so the mount line can never drift from the union
      // (CRITIC-022 P3 #14).
      const mountedLine: RacoonsJournalRecord = Object.freeze({
        kind: 'mounted', atMs: nowMs(),
        episodeNoNewPathSteps: config.episodeNoNewPathSteps, barBytes: config.barBytes,
        enforcement: config.enforcement,
        // The mount line names the configured ROOT, never a derived path: the
        // literal `<sessionId>` is not a path any session uses (critic fix
        // P3#10). Each session's effective plan is journaled as `storage-plan`
        // where the refinement happens.
        ...storage.root === undefined
          ? { storage: storage.databasePath } : { storageRoot: storage.root },
        // ADR-0013 ruling 8: runtime evidence comes from inside the mount.
        ledgerSource, node: process.version,
        judge: llm === undefined ? 'off' : 'on', anchors: config.anchors,
        judgeTimeoutMs: config.judgeTimeoutMs,
        // ISSUE-022 chunks 5–6: both entry points are wired. `command` is the
        // `/prune` message; `threshold` is the half-window auto trigger, and it
        // reads `window` as its denominator. The two flags below name what the
        // apply leg will actually do with a pass, so an `unchanged` in a later
        // line is readable from this one (CRITIC-022 P2 #8, P2 #11).
        prune: config.contextWindowTokens === null ? 'command' : 'command+threshold',
        window: config.contextWindowTokens,
        // What the threshold counts (ADR-0009 §Amendment 2026-10-24): the whole
        // request — main's captured system+tools prefix plus the live transcript.
        // Before main's first request is captured there is no prefix to count;
        // each `prune-threshold` line says which reading it took.
        estimate: 'content+prefix',
        nativeCompactionBackstop: config.nativeCompactionBackstop,
      });
      options.journal?.(mountedLine);

      // The recall handler needs a session, resolved lazily at call time: the
      // registration must not depend on a session existing when the plugin mounts.
      const toolHost = resolveToolHost(ctx, options.tools);
      let unregisterTools: (() => void) | undefined;
      if (toolHost !== undefined) {
        try {
          unregisterTools = registerPluginTools(toolHost, async (id) => {
            const named = singleLiveSession(ctx);
            const entry = named === undefined
              ? [...mount.sessions.values()][0]
              : mount.sessions.get(named.id) ?? [...mount.sessions.values()][0];
            if (entry === undefined) throw new Error('racoons: recall has no live session to read from');
            return entry.adapter.recall(id as RecallId);
          });
        } catch (error) {
          warn(`tool registration: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Observe only. Appending here reenters the host's publication boundary.
      ctx.on('session/event', (session: DshMountSession, event: DshMountEvent) => {
        try { mount.observe(session, event); }
        catch (error) {
          warn(`observe ${String(event?.type)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      });

      // Main's outgoing request, captured where the runtime dispatches it
      // (ISSUE-026 chunk 3 / ADR-0010). The waterfall listener must call
      // `next()`: it is an observer, never an interceptor. The host hands over
      // the request OBJECT, not the provider's HTTP body — the mount journals
      // which shape a seed came from and never claims byte-exactness.
      ctx.on('llm/stream', (options: unknown, next: () => AsyncIterable<unknown>) => {
        try { mount.observeWire(options); }
        catch (error) {
          warn(`wire capture: ${error instanceof Error ? error.message : String(error)}`);
        }
        return next();
      });

      ctx.on('agent/pre-step', async (payload: {
        agent?: { session?: DshMountSession };
        turn?: number;
        step?: number;
      }, next: () => unknown) => {
        const session = payload.agent?.session;
        if (session === undefined) return next();
        try {
          const stepResult = await mount.runStep(session,
            { turn: Number(payload.turn ?? 0), step: Number(payload.step ?? 0) });
          for (const application of stepResult.entryApplications) {
            try { publishEntry(session, application.request, application.capture); }
            catch (error) {
              warn(`entry publish: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          if (stepResult.appendRequest !== null) {
            try { publishAppend(session, stepResult.appendRequest, config); }
            catch (error) {
              warn(`append publish: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        } catch (error) {
          // A retryable storage open already warned inside the mount; the
          // boundary is simply skipped and the next one tries again.
          if (!(error instanceof RacoonsStorageRetryError)) {
            warn(`pre-step: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return next();
      });
      // The last seal opportunity in a one-shot run: the loop appends `turn/end`
      // right after this serial hook, and no pre-step follows. Dispatching a
      // serial hook is not the `session/event` boundary, so appending is legal.
      ctx.on('agent/turn-stopping', async (payload: {
        turn?: number;
        agent?: { session?: DshMountSession };
      }) => {
        const session = payload.agent?.session ?? singleLiveSession(ctx);
        if (session === undefined) return;
        try {
          const turnResult = await mount.runTurnEnd(session, Number(payload.turn ?? 0));
          if (turnResult.appendRequest !== null) {
            try { publishAppend(session, turnResult.appendRequest, config); }
            catch (error) {
              warn(`turn-end append publish: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        } catch (error) {
          if (!(error instanceof RacoonsStorageRetryError)) {
            warn(`turn-end: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      });

      // Cordis owns plugin teardown through `ctx.effect`: the returned function
      // runs when the plugin's fiber unloads, which is where the mount closes
      // each ledger it owns (the durable file stays on disk, unmodified).
      ctx.effect?.(() => async () => {
        unregisterTools?.();
        await mount.close();
      }, 'racoons.close()');
    },
  };
}

/** The default plugin instance a `file:///` patch row can name directly. */
export default createRacoonsPlugin();
