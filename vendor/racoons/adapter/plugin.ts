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
  CharHeuristicTokenMeter, DEFAULT_CONFIG, DEFAULT_FLOOR_BYTES, Meter, RacoonsEngine,
  createDefaultRules, estimateContent, estimatedContentTokens, floorForModel,
} from '@racoons/core';
import type {
  AnchorMode, Clock, ContentEstimate, EngineResult, FreshZoneConfig, Ledger, ProtocolConfig,
  RacoonsConfig, RecallId, RecallRecord, RequestPrefix,
  Rule, SessionSnapshot, Thresholds, ToolResultNode, UnitId, WireRequest,
} from '@racoons/core';
import { createDshCapabilities } from './capabilities.js';
import { createDshAdapter } from './adapter.js';
import type { DshAdapter } from './adapter.js';
import { createDshTools } from './tools.js';
import type { DshToolHost, DshToolRegistration, DshToolSources } from './tools.js';
import { forgetAnswerText } from './forget-tool.js';
import type { DshForgetScheduled } from './forget-tool.js';
import { classifyDshTool } from './evidence.js';
import type { DshResultFacts, DshPathObservation } from './evidence.js';
import type { DshToolResultItem, DshTranscriptItem } from './envelope.js';
import { toCoreEnvelope } from './envelope.js';
import { createDshPort } from './port.js';
import type { DshApplicationPort, DshAskExchange } from './port.js';
import type { DshEntryAnswerOutcome } from './adapter.js';
import { askEntry } from './entry-ask.js';
import type { EntryAskTurn } from './entry-ask.js';
import type { EntryAnswer } from '@racoons/core';
import { readAssistantUsage, usageRequestId } from './usage.js';
import { revertSessionFromHost } from './mount-revert.js';
import { DEFAULT_ASK_TIMEOUT_MS } from './llm-ask.js';
import { judgeRouteOf } from './route.js';
import type { JudgeRoute } from './route.js';
import { captureMainRequest, createMainWireCapture } from './main-wire.js';
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
 * "sessions"]`). Both surviving ask moments read it (ADR-0028): the entry
 * checkpoint and the bulk prune. Declaring it here makes that dependency a host
 * fact rather than a later guess.
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
  /**
   * The size floor in bytes (ADR-0020 Decision 3; ISSUE-058 item 2). A tool
   * result under it lands whole and is never asked about. Absent means the
   * per-model table decides (`floorForModel`; authority:
   * `docs/research/floor-calibration-2026-10-26.md` §6), which is why this is
   * not a defaulted clone of `barBytes`: the table needs the model id, and only
   * the adapter sees it. It is never the bulk-pass bar.
   */
  readonly floorBytes?: number;
  readonly minCutFreedBytes?: number;
  /**
   * Accepted and ignored (ADR-0028). The anchor arm belonged to the removed
   * judge pass: the entry checkpoint's ask renders its anchors unconditionally,
   * so no config value selects an arm. The key stays in the host-facing type so
   * an old config row still mounts.
   */
  readonly anchors?: AnchorMode;
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
  /** The ask stream's deadline in ms; `0` disables it. Default 30 s. */
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
  readonly minCutFreedBytes: number;
  readonly enforcement: RacoonsEnforcement;
  readonly recordName: string;
  /** Accepted and ignored (ADR-0028); see `RacoonsPluginConfig['anchors']`. */
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
  /**
   * The flat floor knob, before the per-session resolution; null means "let the
   * per-model table decide" (ADR-0020 Decision 3). The model id lives on the
   * host route, so `resolvePluginConfig` cannot finish this value — the mount
   * does, once it can see the route (`RacoonsSessionEntry.floorBytes`).
   */
  readonly floorBytes: number | null;
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
   * A fixed host route, when the caller knows the provider/model pair. Absent,
   * the mount reads the live session's own request header and refuses with
   * `not-configured` when neither names a route. Both surviving asks read it
   * (ADR-0028): the entry checkpoint and the bulk prune.
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
   * The host's last request header (provider/model), read only to route an ask
   * onto the same resolved model the session uses. Absent on a fake or an old
   * host: the mount then refuses the ask with `not-configured` rather than
   * inventing a route.
   */
  requestHeader?(): { readonly config?: { readonly provider?: string; readonly model?: string } }
    | undefined;
  /**
   * The host's own creation metadata. `cwd` is the session's workspace root,
   * which dsh validates absolute; it is the boundary the recall source lane may
   * read inside (ISSUE-053; PRD §6.7). Absent means this mount can name no root
   * and supplies no reader, so a ledger miss stays `not-found`.
   */
  header?: { readonly cwd?: string };
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

/** The one model call an ask needs: stream a request, read its text deltas. */
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
 * The chunk shapes an ask reads. Only `text-delta` carries answer text; the
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
   * The local estimate of the request the last pre-step was about to send, and
   * the port revision that estimate describes (G8, ISSUE-045 D1). It is the same
   * `estimateContent` arithmetic the half-window trigger uses — one number, two
   * readers — held here because a host usage row arrives in the synchronous
   * `session/event` callback, where no snapshot can be awaited. Null before the
   * first pre-step; a row arriving before it is journaled missing, never
   * reconciled against an invented estimate.
   */
  requestEstimate: { readonly revision: string; readonly inputTokens: number } | null;
  /**
   * Usage request ids already journaled for this session. One host event is one
   * request, so a row seen twice must not read as two calls; the engine's own
   * dedup suppresses only its telemetry, not this mount's line.
   */
  readonly usageSeen: Set<string>;
  /**
   * Manual forgets the `forget` tool resolved and this session has yet to
   * apply (PRD §6.2; ISSUE-045 chunk D2). A tool call cannot apply its own
   * removal — its assistant message is still unanswered on the surface, and
   * every rebuild from the forgotten node re-emits that call unanswered
   * (`tool-pair-imbalance`) — so the mount drains this queue at its next legal
   * boundary, where every other removal applies. One entry per request; a
   * request that was refused never reaches here.
   */
  readonly pendingForgets: DshForgetScheduled[];
  /**
   * The size floor this session resolved, in bytes (ADR-0020 Decision 3;
   * ISSUE-058 item 2). The flat knob wins; otherwise the route's model id picks
   * the table entry (`floorForModel`), and no route means the default 512. It
   * is resolved here because core never sees a model id, and it is held on the
   * entry so the ask lane reads one number instead of re-deriving it.
   */
  readonly floorBytes: number;
  /**
   * Results whose entry answer SETTLED (ISSUE-058 chunk P3c-2; ADR-0025
   * §Decision 3–§5). In memory only, keyed by the capture's own result node id:
   * no ledger row and no marker on bytes, because a de-duplication ledger would
   * be a second source of truth about content the product deliberately never
   * keeps. Since the judge pass's removal (ADR-0028) it is the mount's own
   * "asked exactly once" record: it stops the ASK loop from putting the same
   * capture to the agent twice. A refused or absent answer settles nothing and
   * is not recorded here (ADR-0025 §5).
   */
  readonly entryJudged: Set<string>;
  /**
   * The subset of `entryJudged` whose entry answer was `keepall` AND applied
   * (ISSUE-073): the results a result checkpoint settled as kept content. The
   * bulk prune withholds their units from its ask, because a settled keep is
   * final and re-listing it would ask the agent to decide it twice. Only an
   * APPLIED keepall lands here: a refusal, a fail-open write and an absent
   * answer settle nothing, so their unit stays listable. Keyed the same way as
   * `entryJudged` (the capture's own result node id).
   */
  readonly entryKept: Set<string>;
  takePublication(): RacoonsApplicationRequest | null;
}

export interface StepOutcome {
  readonly entry: RacoonsSessionEntry;
  readonly deliveries: EngineResult[];
  readonly atRest: EngineResult | null;
  readonly entryApplications: readonly {
    readonly request: RacoonsApplicationRequest;
    readonly capture: Capture;
  }[];
  readonly appendRequest: RacoonsApplicationRequest | null;
}

export interface TurnEndOutcome {
  readonly entry: RacoonsSessionEntry;
  readonly atRest: EngineResult | null;
  readonly appendRequest: RacoonsApplicationRequest | null;
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
   * package sent itself is ignored, so an ask never becomes a seed.
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

/**
 * The outcome an answer which threw would have reported: nothing planned,
 * nothing applied. Frozen and shared, because it is a statement about absence
 * and never a value a caller may mutate into a claim.
 */
const UNCHANGED_ENGINE_RESULT: EngineResult = Object.freeze({
  status: 'unchanged', validation: null, intentId: null, receipt: null, invalidation: null,
});

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
  // ADR-0020 Decision 3: absent (null) defers to the per-model table, resolved
  // where the route is visible. An explicit value wins for every model.
  const floorBytes = config.floorBytes ?? null;
  const minCutFreedBytes = config.minCutFreedBytes ?? 4096;
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
  // ADR-0028: accepted and ignored — no ask reads an anchor arm any more.
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
  if (floorBytes !== null && (!isCount(floorBytes) || floorBytes < 1)) {
    throw new Error('racoons: floorBytes must be a positive safe integer');
  }
  if (!isCount(minCutFreedBytes)) {
    throw new Error('racoons: minCutFreedBytes must be a non-negative safe integer');
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
    minCutFreedBytes, enforcement, recordName,
    anchors, judgeTimeoutMs, racoonsStorageRoot, contextWindowTokens, nativeCompactionBackstop,
    floorBytes,
  });
}

/**
 * The engine config this mount builds from the flat knobs.
 *
 * `floorBytes` is passed in because it is resolved per session, where the route
 * (and so the model id) is visible; an absent value falls back to the flat knob
 * and then to the model-less default, so the engine config always carries one
 * number (ADR-0020 Decision 3).
 */
export function engineConfig(config: ResolvedRacoonsConfig, floorBytes?: number): RacoonsConfig {
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
    // CHUNK-2 deletes these three from core's `ProtocolConfig`; until then the
    // core defaults supply them and no caller value reaches the engine. The
    // judge pass and the turn gate they tuned are gone (ADR-0028), so this
    // mount neither resolves nor validates them.
    ...DEFAULT_CONFIG.protocol,
    barBytes: config.barBytes,
    minCutFreedBytes: config.minCutFreedBytes,
    enforcement: config.enforcement,
  };
  return { thresholds, freshZone, sealMode: 'append', enableSpans: false,
    validationFailureLimit: 2, protocol,
    floorBytes: floorBytes ?? config.floorBytes ?? DEFAULT_FLOOR_BYTES };
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
 * The lines a read result's own meta says the call returned, or `null` when the
 * meta proves none. dsh reports them as `meta.lines` (one `{number, text}` entry
 * per returned line) with `meta.offset` as the 1-based number of the first —
 * the shape every live read record this workspace holds agrees on. Only the
 * count travels: `PathEvidence` states a span's length, never its origin
 * (ISSUE-051), and the unit's own span comes from the rendered body's bytes.
 */
function readCoveredLines(meta: Readonly<Record<string, unknown>>): number | null {
  const lines = meta['lines'];
  if (!Array.isArray(lines) || lines.length === 0) return null;
  // `offset` is where the span starts; a meta without a 1-based origin does not
  // say which lines these are, so it proves no span here.
  if (!isCount(meta['offset']) || meta['offset'] < 1) return null;
  return lines.length;
}

/**
 * Turn the host's structured `meta` into the `DshResultFacts` the adapter's
 * evidence derivation reads.
 *
 * Only the host's own projections are treated as proof:
 *   - a `read` result names the path it returned and the lines it returned
 *     (`meta.lines`, 1-based from `meta.offset`): that covered span proves the
 *     call returned the path's content (ISSUE-051). The call's own spelling and
 *     the resolved `meta.path` are both recorded, so a request spelled either
 *     way resolves;
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
  if (classifyDshTool(toolName) === 'read') {
    const covered = readCoveredLines(meta);
    if (covered !== null) {
      const named = targetFromInput(toolName, input);
      const resolved = typeof meta['path'] === 'string' && meta['path'].length > 0 ? meta['path'] : null;
      const key = named?.key ?? resolved;
      if (key !== null) {
        return { complete: false, failed: false, paths: [{
          path: key, pathKey: key, lineCount: covered,
          ...(resolved !== null && resolved !== key ? { displayPath: resolved } : {}) }] };
      }
    }
    // A read whose meta proves no span stays count-free: `unknown`, never a miss.
    return { complete: false, failed: false, paths: observed() };
  }
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
 * The ordinal a surface node's own content states, when it states one.
 *
 * A `tool/result` (and every other message type the host stamps) carries the
 * `turn` and `step` it belongs to. That pair is the node's identity; the seq it
 * currently occupies is a log position and moves when the host replaces it
 * (ISSUE-064). A pair the fold never saw as a `step/start` yields null, and the
 * caller falls back to the log position's ordinal.
 */
function ownOrdinal(event: DshMountEvent,
  stepAt: ReadonlyMap<string, number>): { turn: number; step: number } | null {
  const data = isRecord(event.data) ? event.data : {};
  if (!isCount(data['turn']) || !isCount(data['step'])) return null;
  const step = stepAt.get(`${String(data['turn'])}:${String(data['step'])}`);
  return step === undefined ? null : { turn: data['turn'], step };
}

/**
 * The ordinal of the surface position a replace took over, for a node that
 * states no `(turn, step)` of its own. A replace re-publishes content at a later
 * seq, so the seq's own log ordinal would stamp it with the publishing step and
 * the walk would go backwards; the position it replaced is the ordinal it keeps
 * (ISSUE-064).
 */
function inheritedOrdinal(event: DshMountEvent,
  ordinalAt: ReadonlyMap<number, { turn: number; step: number }>): { turn: number; step: number } | null {
  const op = event.surfaceOp;
  if (!isRecord(op)) return null;
  const startSeq = op['startSeq'];
  return isCount(startSeq) ? ordinalAt.get(startSeq) ?? null : null;
}

/**
 * Walk a session's log once and return, for every surface position, the host
 * transcript item the port should hold.
 *
 * Three host facts shape this projection:
 *   - dsh numbers `step` per turn (it restarts at 1 each turn) while the core's
 *     snapshot wants one monotone step ordinal across the transcript, so each
 *     distinct (turn, step) pair gets the next global ordinal.
 *   - a turn is complete only at its `turn/end`, so `completedThroughTurnOrdinal`
 *     is the last `turn/end`'s turn, never "current turn minus one".
 *   - a surface REPLACE re-publishes a node's content at a later log seq while
 *     the node keeps the position it occupies (ISSUE-064). An ordinal is a
 *     property of the content, so a node carrying its own (turn, step) pair
 *     takes that pair's global ordinal, and a node carrying none takes the
 *     ordinal of the position it replaced; the log position is only the
 *     fallback for a node with neither. Stamping the arrival seq instead
 *     makes the walk decrease (`1:28` then `1:5`) and the guard latches
 *     `adjacency-changed`.
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
  // The fold's own one-pair-one-ordinal table, so a node that names its own
  // (turn, step) is stamped from its CONTENT and never from the seq the host
  // published it at (ISSUE-064: a replace lands at a later seq).
  const stepAt = new Map<string, number>();
  // The `tool/call` facts the log itself states, by call id. A `tool/result`
  // never repeats its call's name or arguments, so a fold that read only the
  // result would carry no target and no evidence (ISSUE-053). The mount's own
  // `observe` map wins where it has an entry: it is the same host event, read
  // once, and a caller that drove `observe` should see what it captured.
  const loggedCalls = new Map<string, CallFacts>();
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
      stepAt.set(key, globalStep);
    }
    if (event.type === 'turn/end' && isCount(data['turn'])) {
      completedThrough = Math.max(completedThrough, data['turn']);
    }
    if (event.type === 'tool/call' && typeof data['callId'] === 'string') {
      loggedCalls.set(data['callId'], { name: data['name'], arguments: data['arguments'] });
    }
    // The log position's ordinal is the fallback, never the rule: a replace's
    // own pair (or the position it took over) decides what it is stamped with,
    // and the resolved map makes a chain of replaces inherit transitively.
    ordinalAt.set(seq, ownOrdinal(event, stepAt) ?? inheritedOrdinal(event, ordinalAt)
      ?? { turn, step: globalStep });
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
        call: options.calls?.get(callId) ?? loggedCalls.get(callId) ?? null,
        turnOrdinal: at.turn, stepOrdinal: at.step });
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
   * The host's model seam. Absent means neither ask moment can run: the entry
   * loop journals `entry-ask-off` with `no-llm-service` and the prune pass keeps
   * its L1 layer, which is the truthful state of a mount without a model
   * (ADR-0028: two ask moments, both through this seam).
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
   * an outgoing request; the entry ask and the prune pass both read it. Empty
   * means the host exposed no waterfall: the pass then fails open with
   * `no-seed`.
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
    // ADR-0020 Decision 3 / ISSUE-058 item 2: the size floor is resolved here
    // because the model id reaches this package and never core. An explicit
    // `floorBytes` wins for every model; otherwise the route's model picks its
    // table entry (`floorForModel`), and a mount with no route falls back to the
    // measured default. The entry carries the number so the ask lane reads one
    // value instead of re-deriving it.
    const floorBytes = config.floorBytes
      ?? floorForModel(judgeRouteOf(host, options.judgeRoute)?.model);
    const publications: unknown[] = [];
    let latestRequest: RacoonsApplicationRequest | null = null;
    // ISSUE-024: the revert seam is derived from the live host session, never
    // from a config flag, so `revertHistory` below can only be true when one
    // exists (ISSUE-010's capability-truth law). The seam closes over the host
    // object and reads its surface at apply time, so a later host mutation is
    // seen; only a mount that opens with no host stays revert-less for good.
    const seam = revertSessionFromHost(host);
    // The workspace root the recall source lane may read inside (ISSUE-053;
    // PRD §6.7). It is the host's own `header.cwd`, which dsh validates
    // absolute; a fake or older host that names none leaves the port with no
    // boundary, so a ledger miss stays `not-found`.
    const workspaceRoot = typeof host?.header?.cwd === 'string' && host.header.cwd.length > 0
      ? host.header.cwd : undefined;
    const port = createDshPort({ sessionId, clock,
      ...(seam === null ? {} : { revert: seam }),
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      publish: (request) => {
        const owned = request as unknown as RacoonsApplicationRequest;
        latestRequest = owned;
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
    // One config object per session, carrying this session's resolved floor, so
    // the engine and the default rules cannot read two different numbers.
    const sessionConfig = engineConfig(config, floorBytes);
    const engine = await RacoonsEngine.open({
      sessionId,
      capabilities: { ...capabilities },
      config: sessionConfig,
      clock,
      meter: new Meter(new CharHeuristicTokenMeter()),
      ledger,
      rules: createDefaultRules(sessionConfig) as readonly Rule[],
      port,
      onTelemetry: (event) => {
        journal('telemetry', { sessionId, event });
      },
    });
    // The manual forget queue (PRD §6.2; ISSUE-045 chunk D2). A `forget` tool
    // call resolves its request against the live snapshot and lands here; the
    // step and turn-end boundaries drain it through `applyForget`, so a forget
    // applies at the same seam every other removal does and never from inside a
    // host callback (which forbids appends). The queue is per session and lives
    // on the entry, so a second session can never apply another's request.
    const pendingForgets: DshForgetScheduled[] = [];
    const adapter = createDshAdapter({ engine, port, clock,
      onForget: decision => { pendingForgets.push(decision); },
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
      publications, host: host ?? null, pruneRounds: persistedRound,
      pruneTrigger: new PruneWindowTrigger(config.contextWindowTokens),
      requestEstimate: null, usageSeen: new Set<string>(), pendingForgets, floorBytes,
      entryJudged: new Set<string>(), entryKept: new Set<string>(),
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
   * before that override: the host appends `turn/end` only after
   * `agent/turn-stopping`, so the turn is still being assembled there.
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
   * Sync the transcript and the ordinals in one call. The mount's engine passes
   * use this wrapper (ISSUE-022 chunk 5): a pass that planned and validated
   * against a transcript older than its ordinals could cut or refuse on stale
   * facts. `syncTranscript` alone stays a transcript/ordinal projection, so a
   * caller that drives its own engine pass keeps using it directly.
   *
   * ADR-0020: there is no protection feed. The automatic protection layer is
   * deleted, so a pass states the transcript and the cache/ordinal facts and
   * nothing else.
   */
  function syncPass(entry: RacoonsSessionEntry, session: DshMountSession,
    syncOptions: TranscriptSyncOptions = {}) {
    return syncTranscript(entry, session, syncOptions);
  }

  /**
   * Record the estimate of the request the next boundary will send, and return
   * it (G8, ISSUE-045 D1; ISSUE-022 chunk 6). One function, so the half-window
   * trigger and the usage reconciliation read the same number by construction:
   * two callers computing the same arithmetic twice is how an estimate error
   * count starts measuring the drift between two estimators instead of the
   * provider's count against ours.
   *
   * The estimate is the WHOLE request — main's captured system+tools prefix plus
   * the live transcript (ADR-0009 §Amendment 2026-10-24) — and the revision is
   * the port's own, so a reading names the state it belongs to.
   */
  function measureRequest(entry: RacoonsSessionEntry, snapshot: SessionSnapshot,
    prefix: RequestPrefix | null): ContentEstimate {
    const estimate = estimateContent(estimateMeter, snapshot, null, prefix);
    entry.requestEstimate = { revision: snapshot.revision, inputTokens: estimate.totalTokens };
    return estimate;
  }

  /**
   * Feed one step's usage row to the engine (G8, ISSUE-045 D1; PRD §6.9).
   *
   * Three outcomes, each journaled once per host event:
   *
   * - a usable reading → `engine.observe({kind:'usage', …})`, and the mount
   *   journals `usage-reconciled` with the meter's own reading;
   * - no row at all → `usage-missing`, no engine call: a step with no
   *   accounting is a fact, never a zero-token request;
   * - a row the meter would refuse → `usage-missing` with the refusal's own
   *   reason. Reconciliation is the meter's, and a value it rejects must not be
   *   dressed up as a reading it accepted.
   *
   * The estimate the row is measured against is the pre-step reading of the
   * request that produced it (`requestEstimate`), never a fresh estimate
   * computed after the fact: the point of `estimateErrorTokens` is which
   * estimate the provider's count disagrees with. Before any pre-step there is
   * no request this mount measured, so the row is journaled missing rather than
   * reconciled against a guess.
   */
  function observeUsage(session: DshMountSession, event: DshMountEvent): void {
    const requestId = usageRequestId(session.id, event.seq);
    const entry = sessions.get(session.id);
    // A mount that never opened this session's entry has no engine to feed, and
    // a host can emit a message before the first pre-step.
    if (entry === undefined) return;
    // Only append-origin messages are main's own requests; a replacement this
    // package appended (a receipt) carries no usage and must stay silent.
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return;
    if (entry.usageSeen.has(requestId)) return;
    entry.usageSeen.add(requestId);
    const read = readAssistantUsage(event);
    if (read === null) return;
    const measured = entry.requestEstimate;
    if (read.kind !== 'usage') {
      journal('usage-missing', { sessionId: session.id, seq: event.seq, requestId,
        ...(read.kind === 'invalid' ? { reason: read.reason } : {}) });
      return;
    }
    if (measured === null) {
      // No pre-step has run, so no request this mount measured exists to answer:
      // the reading would be authoritative about a request we never estimated,
      // and the meter's error count would compare two unrelated things.
      journal('usage-missing', { sessionId: session.id, seq: event.seq, requestId,
        reason: 'no-request-estimate' });
      return;
    }
    try {
      entry.engine.observe({ kind: 'usage', requestId, revision: measured.revision,
        estimatedInputTokens: measured.inputTokens, usage: read.usage });
    } catch (error) {
      // The meter refuses an inconsistent row (a cached count above input). The
      // engine throws before emitting anything, so nothing was recorded.
      journal('usage-missing', { sessionId: session.id, seq: event.seq, requestId,
        revision: measured.revision, reason: 'inconsistent-usage',
        message: error instanceof Error ? error.message : String(error) });
      return;
    }
    journal('usage-reconciled', { sessionId: session.id, seq: event.seq, requestId,
      revision: measured.revision,
      estimatedInputTokens: measured.inputTokens,
      inputTokens: read.usage.inputTokens,
      outputTokens: read.usage.outputTokens,
      cachedInputTokens: read.usage.cachedInputTokens });
  }

  /**
   * Observe one host event. Captures a `tool/call`'s facts, queues its
   * `tool/result` for the next pre-step, and feeds a step's usage row to the
   * engine's meter (G8, ISSUE-045 D1). Never appends: the host forbids it
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
    // A step's authoritative accounting (G8, ISSUE-045 D1; PRD §6.9). The host
    // attaches the model adapter's `usage` row to `assistant/message` and emits
    // no separate usage event, so this callback is the only place a real count
    // is visible. The reading goes to `engine.observe` — never to the estimate
    // lane — and the journal carries one line per request, whether a row
    // arrived (`usage-reconciled`) or not (`usage-missing`).
    if (event.type === 'assistant/message') {
      observeUsage(session, event);
      return null;
    }
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
   * The result an ask loop may put to the agent (ISSUE-058 chunk P3c-2;
   * ADR-0022 §1, ADR-0025 §1–§2).
   *
   * Three facts decide, and each is a reading of the landed capture itself:
   * the body is at or above this session's resolved floor (`entry.floorBytes` —
   * the flat knob or the model's table row; ADR-0020 §Decision 3), the capture
   * is not already settled (`entry.entryJudged`), and — proven by the caller
   * once the unit has minted — the landed result has a unit id to address.
   * Nothing else gates it: no bar, no size ceiling, no re-entry heuristic. A
   * result between the floor and the bar IS asked (the floor is the entry
   * gate, the bar is the bulk-prune gate), and the caller states that
   * consequence rather than inventing a second threshold.
   */
  function entryAskable(entry: RacoonsSessionEntry, capture: Capture): boolean {
    return capture.item.bytes.length >= entry.floorBytes
      && !entry.entryJudged.has(capture.eventId);
  }

  /**
   * The landed result as a core node. The port already holds the host's own
   * item under this id after `deliverToolResult`, so its transcript is
   * authoritative; the capture is the fallback for a host that delivered
   * without the port holding the item.
   */
  function landedNodeOf(entry: RacoonsSessionEntry, capture: Capture): ToolResultNode | null {
    const items = entry.port.transcript();
    const index = items.findIndex(item => item.id === capture.eventId);
    if (index >= 0) {
      const item = items[index];
      if (item === undefined) return null;
      return toCoreEnvelope(item, index).node as ToolResultNode;
    }
    const direct = toCoreEnvelope(capture.item, items.length).node;
    return direct.kind === 'tool-result' ? direct : null;
  }

  /**
   * Main's wire as the HOST SURFACE stated it at the moment ONE result landed —
   * every live node up to and including that result's own turn, in the surface's
   * own order (ISSUE-058 chunk P3d; the live blocker P3c-2 recorded).
   *
   * Why a request capture is not enough: a capture holds a REQUEST, and the
   * assistant turn that made a tool call is a provider RESPONSE, not something
   * any request carries until the following step. So after a session's first
   * tool call, main's next dispatched request already ends with the prior
   * `tool` turn, and appending this result to that capture would put two `tool`
   * turns in a row — the fork's `role-conflict`, which the entry lane reported
   * as a silent fail-open `no-seed` (P3c-2's live observation).
   *
   * Why the CUT matters: a step may land several results (parallel tool calls)
   * and the asks for them run one after another against the surface as it
   * stands at the END of the step. The ask is about the result immediately
   * above it (ADR-0022 §4), so an ask for all but the last would otherwise sit
   * under a LATER result. Cutting after this result's own node gives every ask
   * the wire state the host held when that result landed.
   *
   * It is not a second renderer: the surface nodes are re-wrapped in the host's
   * request-message shape and handed to `captureMainRequest`, the one projection
   * this package uses for a seed — the same role filter, the same text joining
   * and the same `[tool call <name> <args>]` rendering, so a surface seed and a
   * captured seed can never disagree about a shared turn.
   *
   * `system` and `tools` come from the capture when one exists: they are the
   * request's fixed prefix, and the surface carries the prompt as a leading
   * `system/message` (the loop's `in-history` shape), which the projection keeps
   * where main put it. No capture means no tool list, and a fork with no tools
   * would be a different conversation — so this returns null and the caller
   * keeps its fail-open `no-seed`.
   *
   * Returns null when the surface never reaches `stopNodeId`: a prefix that
   * cannot name its own end is not a seed for that result.
   */
  function postLandingWire(session: DshMountSession, sessionId: string,
    stopNodeId: string,
  ): WireRequest | null {
    const captured = mainWire.last(sessionId);
    if (captured === null) return null;
    const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : [];
    const messages: unknown[] = [];
    let reached = false;
    for (const seq of nodes) {
      const event = session.eventAt?.(seq);
      if (event === undefined) continue;
      const data = isRecord(event.data) ? event.data : {};
      if (event.type === 'tool/result') {
        const callId = callIdOf(event);
        if (callId === null) continue;
        const message = isRecord(data['message']) ? data['message'] : {};
        messages.push({ role: 'tool', toolCallId: callId, content: message['content'] });
        if (resultNodeId(sessionId, callId) === stopNodeId) { reached = true; break; }
        continue;
      }
      const role = event.type === 'user/message' ? 'user'
        : event.type === 'assistant/message' ? 'assistant'
          : event.type === 'system/message' ? 'system'
            : event.type === 'developer/message' ? 'developer' : null;
      if (role === null) continue;
      const message = role === 'user' ? data : isRecord(data['message']) ? data['message'] : {};
      messages.push({ role, content: message['content'] });
    }
    if (!reached || messages.length === 0) return null;
    return captureMainRequest({ sessionId, system: captured.wire.system,
      tools: captured.wire.tools, messages })?.wire ?? null;
  }

  /**
   * The ask exchange's turns as ONE host append each (ISSUE-058 chunk P3c-2;
   * ADR-0022 §3, §6, §11). Both are NEW nodes — an append, never an edit — and
   * they are NOT published to the port as a core application: the question is
   * not a removal, and the answer only reaches the engine through
   * `onEntryAnswer`.
   *
   * BOTH rows go out as `user/message` (ISSUE-074, scheme A, leader ruling
   * 2026-10-27). The answer row was an `assistant/message` once; that shape
   * cannot survive a stored-session replay. dsh's replay validator calls
   * `requireOpenStep` on EVERY `assistant/message`, and at these two append
   * seams — `agent/pre-step` (before the host's `step/start`) and
   * `agent/turn-stopping` (after `step/end`) — no step is open. Stamping a
   * turn/step pair was measured and every candidate fails; a `user/message`
   * has no step relationship at all, so the answer is stored as a user turn
   * and the log resumes (`restoreReleasedV4Artifact` and a real dsh resume,
   * ISSUE-074). The exchange is still rewound by both applies, so no
   * model-facing turn reads the answer; a FAILED apply leaves question and
   * answer as two user turns, which is visible where the old shape left a
   * corrupt log.
   *
   * The node ids the caller records come from the host events these appends
   * return, so a rewind names the surface's own ids and never a mount-invented
   * one: `surfaceTranscript` names a message `dsh:<session>:message:<seq>`, and
   * `mount-revert.ts` repeats that formula, so both agree.
   */
  function appendAskTurns(session: DshMountSession,
    turns: readonly EntryAskTurn[]): readonly DshMountEvent[] {
    const events: DshMountEvent[] = [];
    for (const turn of turns) {
      events.push(session.append('user/message', {
        content: [{ type: 'text', text: turn.text }],
        source: { kind: `${config.recordName}/entry-ask` },
        role: 'user',
        id: randomUUID(),
      }, { surfaceOp: 'append' }));
    }
    return events;
  }

  /**
   * The mount-side id of an appended message node: the same formula
   * `surfaceTranscript` and `mount-revert.ts` use, so the exchange the port
   * rewinds later names the nodes the surface actually holds.
   */
  function messageNodeId(sessionId: string, seq: number): string {
    return `dsh:${sessionId}:message:${String(seq)}`;
  }

  /**
   * One answered exchange, applied (ISSUE-058 chunk P3c-2; ADR-0022 §11–§14).
   *
   * The exchange is recorded under the ANSWERED event id (never the
   * observation's: the engine answers one event id once, so reusing it would
   * make the answer a replay), then `onEntryAnswer` decides the surface write:
   * `rewound` for a keep-all, `landed` for a forget, `fail-open` when core
   * refused the answer or the host write refused. The journal carries the
   * outcome with BOTH host seqs P3a's two-append design produces — the exchange
   * rewind's seq first, then (a forget only) the shaped result turn's seq.
   *
   * The seqs are read off the host, never derived from a count this mount
   * keeps: dsh's `seq === log.length` (`revert.ts`, `nextSeq`), so the appends
   * one apply makes are exactly `surfaceBefore, surfaceBefore + 1, …`. A
   * `port` outcome naming another seq would disagree with the log, which is a
   * host fact a test can pin.
   */
  async function applyEntryAnswer(entry: RacoonsSessionEntry, session: DshMountSession,
    capture: Capture, node: ToolResultNode, exchange: DshAskExchange, answerEventId: string,
    answer: EntryAnswer, answerText: string,
  ): Promise<DshEntryAnswerOutcome> {
    const surfaceBefore = typeof session.seq === 'number' ? session.seq : null;
    let outcome: DshEntryAnswerOutcome;
    try {
      outcome = await entry.adapter.onEntryAnswer(answerEventId, node, exchange, answer, answerText);
    } catch (error) {
      // An answer that throws is a host-side defect, never a claim about the
      // content: the result stands whole and the journal names the failure.
      journal('entry-apply-refused', { sessionId: entry.sessionId, eventId: capture.eventId,
        answerEventId, status: 'fail-open', code: 'host-error',
        message: error instanceof Error ? error.message : String(error) });
      return { status: 'fail-open', engine: UNCHANGED_ENGINE_RESULT, refusal: null };
    }
    // Only an applied answer settles the result (ADR-0025 §4–§5): a keep-all
    // rewinds the exchange, a forget lands one shaped turn, and both mean the
    // agent decided this content. A refusal applied nothing and settles
    // nothing, so a repeated delivery may ask once more.
    if (outcome.status !== 'fail-open') {
      entry.entryJudged.add(capture.eventId);
      // Only an APPLIED keep-all settles the unit as kept content (ISSUE-073):
      // that is the one answer that leaves the result standing whole and says
      // the agent decided it stays. Any forget replaced it with a shaped turn.
      if (answer.action === 'keepall') entry.entryKept.add(capture.eventId);
    }
    const write = entry.port.takeEntryWrite();
    const surfaceAfter = typeof session.seq === 'number' ? session.seq : null;
    const appends = surfaceBefore === null || surfaceAfter === null ? null : surfaceAfter - surfaceBefore;
    // The first append one apply makes is the exchange's rewind (§11), and a
    // forget's second is the shaped result turn (§12). A keep-all makes only
    // the first, so it names no result seq at all.
    const exchangeSeq = appends !== null && appends > 0 && surfaceBefore !== null ? surfaceBefore
      : write?.status === 'applied' ? write.seq : null;
    const resultSeq = appends !== null && appends > 1 && surfaceBefore !== null
      ? surfaceBefore + 1 : null;
    journal('entry-apply', { sessionId: entry.sessionId, eventId: capture.eventId,
      answerEventId, status: outcome.status, action: answer.action,
      resultNodeId: exchange.resultNodeId, askNodeId: exchange.askNodeId,
      answerNodeId: exchange.answerNodeId,
      exchangeSeq, resultSeq, appends,
      ...write === null ? {} : { writeStatus: write.status },
      ...write !== null && 'code' in write ? { code: write.code } : {},
      engineStatus: outcome.engine.status, intentId: outcome.engine.intentId,
    });
    if (outcome.status === 'fail-open') {
      journal('entry-apply-refused', { sessionId: entry.sessionId, eventId: capture.eventId,
        answerEventId, status: 'fail-open',
        code: outcome.refusal?.code ?? null,
        detail: outcome.refusal?.detail ?? 'core planned nothing to apply',
        engineStatus: outcome.engine.status });
    }
    return outcome;
  }

  /**
   * The entry checkpoint's ask loop for one step (ISSUE-058 chunk P3c-2;
   * ADR-0022 §1–§6, §11–§14; ADR-0025 §Decision 1).
   *
   * It runs inside `runStep`, AFTER every queued result has landed and BEFORE
   * the at-rest pass and the prune see the step: the checkpoint unit is asked
   * once before any later seam can name it, which is what keeps the two ask
   * moments disjoint by construction (ADR-0028). One ask per result,
   * sequentially, and never a re-ask of a settled one.
   *
   * The seed is `mainWire.last(...)`'s capture, taken BEFORE the ask turns are
   * appended: it ends at the assistant turn that made the tool call, and
   * `askEntry` appends the landed result's own turn to it, so the fork's prefix
   * is main's wire state after the landing (ADR-0022 §3).
   *
   * Fail-open is the loop's shape, not an arm: the breaker is never touched
   * here (an ask failure is not a completed-validation refusal), and every
   * early exit journals ONE line naming why the seam did nothing.
   */
  async function runEntryAsks(entry: RacoonsSessionEntry, session: DshMountSession,
    captures: readonly Capture[]): Promise<void> {
    const llm = options.llm;
    const route = judgeRouteOf(entry.host ?? session, options.judgeRoute);
    // One breaker reading for the whole step. A disabled breaker is machinery
    // health, not a content decision (ADR-0020 §Decision 5b): the ask lane
    // stands down and the results land whole. An unreadable ledger is not a
    // breaker reading at all, and says so.
    const breaker = await breakerReading(entry);
    for (const capture of captures) {
      if (!entryAskable(entry, capture)) continue;
      if (llm === undefined) {
        journal('entry-ask-off', { sessionId: entry.sessionId, eventId: capture.eventId,
          callId: capture.item.callId, byteLength: capture.item.bytes.length,
          reason: 'no-llm-service' });
        continue;
      }
      if (route === null) {
        journal('entry-ask-off', { sessionId: entry.sessionId, eventId: capture.eventId,
          callId: capture.item.callId, byteLength: capture.item.bytes.length,
          reason: 'no-route' });
        continue;
      }
      if (breaker === 'open') {
        journal('entry-ask-off', { sessionId: entry.sessionId, eventId: capture.eventId,
          callId: capture.item.callId, byteLength: capture.item.bytes.length,
          reason: 'breaker-open' });
        continue;
      }
      if (breaker === 'unknown') {
        journal('entry-ask-off', { sessionId: entry.sessionId, eventId: capture.eventId,
          callId: capture.item.callId, byteLength: capture.item.bytes.length,
          reason: 'ledger-unavailable' });
        continue;
      }
      const node = landedNodeOf(entry, capture);
      // The unit is the address the answer's apply needs (`landedUnitId` mints
      // it at bar 0, exactly as the guard re-derives it). No unit means no
      // addressable landed result, so there is nothing to ask about.
      const unitId = landedUnitIdOf(entry, node);
      if (node === null || unitId === null) {
        journal('entry-ask-off', { sessionId: entry.sessionId, eventId: capture.eventId,
          callId: capture.item.callId, byteLength: capture.item.bytes.length,
          reason: 'unit-absent' });
        continue;
      }
      const seed = mainWire.last(entry.sessionId)?.wire ?? null;
      // The surface projection is the seed whenever it can be built: it is the
      // only wire state that holds the assistant turn which made this result's
      // tool call, so it is the only one that stays correct past the session's
      // first tool call (ISSUE-058 chunk P3d).
      const surface = postLandingWire(session, entry.sessionId, node.id);
      // No `timeoutMs` is passed: the entry ask's one deadline is
      // `DEFAULT_ASK_TIMEOUT_MS` in `llm-ask.ts`, which is the bound the step is
      // held to. `judgeTimeoutMs` belongs to the prune pass; an entry ask that
      // shared it would let `judgeTimeoutMs: 0` (deadline off) hold a step
      // indefinitely.
      const outcome = await askEntry({ resultBytes: node.bytes, seed, surface, llm, route });
      if (outcome.status === 'off') {
        journal('entry-ask-off', { sessionId: entry.sessionId, eventId: capture.eventId,
          callId: capture.item.callId, byteLength: capture.item.bytes.length,
          reason: 'route-off' });
        continue;
      }
      if (outcome.status === 'refused') {
        // Fail-open: the result is already landed whole, so nothing is
        // appended and nothing is marked. One line names the code.
        journal('entry-ask-refused', { sessionId: entry.sessionId, eventId: capture.eventId,
          callId: capture.item.callId, unitId, code: outcome.code,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
          retried: outcome.retried,
          turns: outcome.turns.length,
          ...(outcome.usage === undefined ? {} : { usage: outcome.usage }) });
        continue;
      }
      // Answered: append the WHOLE exchange as the turns the ask produced, in
      // order, then apply the answer over them.
      const appended = appendAskTurns(session, outcome.turns);
      const askNode = appended[0], answerNode = appended[appended.length - 1];
      if (askNode === undefined || answerNode === undefined) {
        journal('entry-ask-refused', { sessionId: entry.sessionId, eventId: capture.eventId,
          callId: capture.item.callId, unitId, code: 'no-seed', retried: outcome.retried,
          turns: outcome.turns.length, reason: 'empty-exchange' });
        continue;
      }
      journal('entry-ask', { sessionId: entry.sessionId, eventId: capture.eventId,
        callId: capture.item.callId, unitId, answeredInRound: 0,
        action: outcome.answer.action,
        ...(outcome.answer.action === 'keepall' ? {} : { summary: outcome.answer.summary }),
        raw: outcome.raw, retried: outcome.retried, turns: outcome.turns.length,
        askNodeId: messageNodeId(entry.sessionId, askNode.seq),
        answerNodeId: messageNodeId(entry.sessionId, answerNode.seq),
        ...(outcome.usage === undefined ? {} : { usage: outcome.usage }) });
      // The application event id is the ANSWER turn's own node id, never the
      // observation's: the engine answers one event id once (port.ts:58-62), so
      // an id shared with the landing would make this answer a replay.
      const answerEventId = messageNodeId(entry.sessionId, answerNode.seq);
      const exchange: DshAskExchange = {
        resultNodeId: capture.eventId,
        askNodeId: messageNodeId(entry.sessionId, askNode.seq),
        answerNodeId: answerEventId,
        summary: outcome.answer.action === 'keepall' ? '' : outcome.answer.summary,
      };
      await applyEntryAnswer(entry, session, capture, node, exchange, answerEventId,
        outcome.answer, outcome.raw);
      // The host surface moved (an exchange appended at least, and possibly
      // rewound), so the port's transcript is re-read before the next result's
      // seed and before the at-rest pass plans against it.
      syncPass(entry, session);
    }
  }

  /**
   * The breaker's current state as the session's own durable record states it
   * (ISSUE-057; ADR-0020 §Decision 5b). Read-only, through the public `Ledger`
   * seam: the last `validation` row's own `breaker` is the authoritative
   * reading (`engine/journal.ts` `breakerState` derives exactly this), and the
   * ask lane never appends a validation and never increments the streak, so an
   * ask failure cannot quiet the gate.
   *
   * Three answers, not two, because the third is the honest one: a ledger that
   * cannot be read says nothing about machinery health, so the lane stands down
   * and journals `ledger-unavailable` rather than claiming the breaker tripped.
   */
  async function breakerReading(entry: RacoonsSessionEntry): Promise<'closed' | 'open' | 'unknown'> {
    try {
      let disabled = false;
      for await (const row of entry.ledger.events(entry.sessionId)) {
        if (row.event.kind === 'validation') disabled = row.event.breaker.disabled;
      }
      return disabled ? 'open' : 'closed';
    } catch {
      return 'unknown';
    }
  }

  /**
   * The landed result's whole-result unit id, read through the port's own mint
   * (bar 0: the answered result is one unit whatever its size, ADR-0022 §14's
   * stamped address). Absent when the transcript holds no tool result under
   * that id, which the loop journals as `unit-absent`.
   *
   * The port's mint is the same one the adapter stamps the answered event with
   * (`stampFor` → `landedUnitId`) and the same one the guard re-derives, so a
   * unit id minted here and an applied shape's `unitId` can only agree.
   */
  function landedUnitIdOf(entry: RacoonsSessionEntry, node: ToolResultNode | null): UnitId | null {
    return node === null ? null : entry.port.landedUnitId(node.id);
  }

  /**
   * Run one prune pass (ISSUE-022 chunks 5–6): the snapshot and the transcript
   * come from the port; the ask goes through the host's own model seam. The round ordinal is persisted beside the session's ledger, so a
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
        // The units a settled entry keep already decided (ISSUE-073): a later
        // table must not re-list them. The pass reads the invalidation itself,
        // so a unit a write made stale is still listable.
        settledNodeIds: entry.entryKept,
        ...(options.llm === undefined ? {} : { llm: options.llm }),
        route: () => judgeRouteOf(entry.host ?? session, options.judgeRoute),
        // The capture main's last sent request (ISSUE-027, ADR-0010): a prune
        // ask is a fork of it, never a re-render.
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
   * Apply every manual forget the `forget` tool queued (PRD §6.2; ISSUE-045
   * chunk D2). Runs at the step and turn-end boundaries, after the transcript
   * sync, so the engine plans and validates against the surface the host is
   * about to send.
   *
   * A request is drained BEFORE it is applied and never re-queued: the engine
   * dedupes by event id, so a request it already settled would answer the same
   * thing again, and keeping it queued would repeat the attempt at every later
   * boundary. Each outcome is journaled, so an operator can read why a forget
   * did not apply — including the `unsupported-capability` a build without the
   * revert seam records, which the adapter answers before queueing whenever it
   * can tell.
   */
  async function applyForgets(entry: RacoonsSessionEntry): Promise<EngineResult[]> {
    const outcomes: EngineResult[] = [];
    for (const pending of entry.pendingForgets.splice(0)) {
      let result: EngineResult;
      try {
        result = await entry.engine.process({ kind: 'forget', eventId: pending.eventId,
          request: pending.request });
      } catch (error) {
        journal('forget-error', { sessionId: entry.sessionId, eventId: pending.eventId,
          unitId: pending.unitId,
          message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      journal('forget', { sessionId: entry.sessionId, eventId: pending.eventId,
        unitId: pending.unitId, path: pending.request.source,
        ranges: pending.request.ranges.length, status: result.status,
        intentId: result.intentId,
        issues: result.validation?.ok === false ? result.validation.issues : [] });
      outcomes.push(result);
    }
    return outcomes;
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
    const landed: Capture[] = [];
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
      landed.push(capture);
      const request = entry.takePublication();
      if (request !== null) entryApplications.push({ request, capture });
    }
    // The port's transcript must hold every result this loop is about to ask
    // about, so the landed unit is addressable (`landedUnitId`) and the answer's
    // apply finds the surface node it addresses.
    syncPass(entry, session);
    // The entry checkpoint's ask loop (ISSUE-058 chunk P3c-2; ADR-0025 §1): the
    // results have landed and the at-rest pass and the prune have not seen this
    // step yet, so a result's unit is asked once before any later seam can name
    // it. Sequential, one ask per result, and fail-open throughout: the step is
    // never held past the ask's own deadline.
    await runEntryAsks(entry, session, landed);
    // An answered exchange appended turns and may have rewound them: the
    // at-rest pass must plan against the surface that actually stands now.
    syncPass(entry, session);
    // Manual forgets queued by the `forget` tool apply here, before the at-rest
    // pass plans anything (ISSUE-045 chunk D2). The queue is drained once per
    // boundary: a forget is one revert, and the engine dedupes by event id, so
    // two boundaries can never apply the same request twice.
    const forgets = await applyForgets(entry);
    // A pass that applied changed the surface the at-rest pass must plan
    // against, so the transcript is re-read.
    if (forgets.some(outcome => outcome.status === 'applied')) syncPass(entry, session);
    const atRestId = eventIdFor(session.id, 'step',
      (Number(ordinals.turn) * 1_000_000) + Number(ordinals.step));
    let atRest: EngineResult | null = null;
    let appendRequest: RacoonsApplicationRequest | null = null;
    try {
      atRest = await runAtRest(entry, atRestId, 'step');
      appendRequest = takeAppendRequest(entry);
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
    //
    // The same reading is the estimate the NEXT request's usage row is
    // reconciled against (G8, ISSUE-045 D1): this boundary ends with the state
    // the host is about to send, and `assistant/message` for that request
    // arrives after it. One number, two readers, so the drift the meter reports
    // is never an artefact of two estimators disagreeing.
    //
    // What the number does NOT include is the receipt the caller appends after
    // this function returns (`publishAppend`), and — until the recompute below —
    // a cut this step's prune applied. The prune is recomputed because it
    // shrinks the transcript by design: charging its removed bytes to the
    // estimator would read as drift the meter never measured. The receipt is
    // left out and stated here: it is one short line, and the alternative is a
    // second snapshot on every step.
    const prefix = mainWire.last(entry.sessionId)?.wire ?? null;
    const snapshotNow = await entry.port.snapshot();
    let estimate = measureRequest(entry, snapshotNow, prefix);
    const estimatedTokens = entry.pruneTrigger.enabled ? estimate.totalTokens : null;
    const crossed = estimatedTokens !== null && entry.pruneTrigger.observe(estimatedTokens);
    if (crossed) {
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
    // A `/prune` message seen during this step runs here, after the at-rest
    // pass: that pass leaves the entry's state settled, and a prune reads that
    // state without writing any.
    if (pruneRequests.has(session.id) || crossed) {
      try {
        await runPrune(session);
        // A pass that applied changed the transcript the next request sends.
        // Re-read the estimate rather than leave the pre-pass number standing
        // (G8, ISSUE-045 D1): the row that answers the NEXT request is measured
        // against what that request will actually carry.
        const afterPrune = await entry.port.snapshot();
        estimate = measureRequest(entry, afterPrune, prefix);
      } catch (error) {
        journal('prune-error', { sessionId: entry.sessionId,
          message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { entry, deliveries, atRest, entryApplications, appendRequest };
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
    // A forget queued during the turn's last step applies here too: in a
    // one-shot run no pre-step follows this boundary, so a request left queued
    // would never land (ISSUE-045 chunk D2). Draining before the at-rest pass
    // means a sealed episode sees the surface the removal left.
    const forgets = await applyForgets(entry);
    if (forgets.some(outcome => outcome.status === 'applied')) {
      syncPass(entry, session, { completedThroughTurnOrdinal: Number(turn) });
    }
    const eventId = eventIdFor(session.id, 'turn', Number(turn));
    let atRest: EngineResult | null = null;
    let appendRequest: RacoonsApplicationRequest | null = null;
    try {
      atRest = await runAtRest(entry, eventId, 'turn-end');
      appendRequest = takeAppendRequest(entry);
    } catch (error) {
      journal('at-rest-error', { sessionId: entry.sessionId, eventId,
        message: error instanceof Error ? error.message : String(error) });
    }
    // The turn is closed and the next request follows this boundary: record the
    // estimate that request will be measured against (G8, ISSUE-045 D1).
    measureRequest(entry, await entry.port.snapshot(),
      mainWire.last(entry.sessionId)?.wire ?? null);
    return { entry, atRest, appendRequest };
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
 * The mount entry a tool call answers from: the single live session's entry,
 * else the only one the mount has opened. Both tools resolve their session this
 * way, so a test that drives the mount directly (no `ctx.sessions` store) still
 * gets the same wiring a live host gets.
 */
function liveEntry(mount: RacoonsMount, ctx: DshMountContext): RacoonsSessionEntry | undefined {
  const named = singleLiveSession(ctx);
  if (named !== undefined) {
    const entry = mount.sessions.get(named.id);
    if (entry !== undefined) return entry;
  }
  return [...mount.sessions.values()][0];
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
 * `DSH_TOOL_SPECS` declares `forget`, `expand` and `recall`; `forget` and
 * `recall` have execution paths, so both are registered and `expand` stays out
 * — no model is ever offered a tool that would fail (design-protocol §4;
 * ISSUE-045 chunk D2 added the forget handler).
 *
 * The host's `register` takes a `ToolDefinition` (schema plus a mandatory
 * `output` declaration), while the adapter's seam is `{ spec, execute }`. The
 * mapping lives here so the package still carries no dsh dependency, and so the
 * unregister the host returns is the only disposal contract this file relies on.
 *
 * Registration is all-or-nothing: a host that refuses the second tool leaves
 * neither registered, so a mount can never advertise half its inventory.
 *
 * `execute` must return the projected output, never a raw ledger record: the
 * record carries `Uint8Array` bodies, and the host snapshots every tool value
 * as lossless JSON (`snapshotJsonValue`; non-JSON is `INVALID_TOOL_OUTPUT`).
 * `recallText` is the recall projection — verified bytes decoded as UTF-8, so it
 * is also the second hash check between the ledger and the model — and
 * `forgetAnswerText` is the forget projection: a scheduled request or the
 * lookup's own refusal, never archived bytes.
 */
export function registerPluginTools(host: DshToolHost, sources: DshToolSources): () => void {
  const registrations = createDshTools(sources);
  const registered: (() => void)[] = [];
  try {
    for (const tool of registrations) {
      registered.push(host.register(hostTool(tool) as never));
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
 * The host's `ToolDefinition` as this package reads it: the adapter seam plus
 * the mandatory `output` declaration. Structural, so the package still carries
 * no dsh dependency.
 */
interface DshHostTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly output: {
    readonly schema: Readonly<Record<string, unknown>>;
    render(args: unknown, value: unknown): unknown;
  };
  execute(args: unknown): Promise<unknown>;
}

/**
 * One registration as the host's `ToolDefinition`. `render` turns the canonical
 * JSON value into the one text block the model reads, so the raw value never
 * reaches it. The adapter's seam is `{spec, execute}`; the mandatory `output`
 * declaration is dsh's, so it lives here and not in `tools.ts`.
 */
function hostTool(tool: DshToolRegistration): DshHostTool {
  return {
    name: tool.spec.name,
    description: tool.spec.description,
    parameters: tool.spec.parameters,
    output: {
      // Both payloads are objects; this unconstrained schema accepts them.
      schema: {},
      render: (_args: unknown, value: unknown): unknown => [{ type: 'text',
        text: tool.spec.name === 'forget' ? forgetAnswerText(value) : recallBodyText(value) }],
    },
    execute: async (args: unknown): Promise<unknown> => tool.execute(args),
  };
}

/**
 * The recall answer's one text block: its restored body, every part of a
 * multi-part restore, or nothing. The projection (`tools.ts` `recallText`) sets
 * `text` only when exactly one part exists; a multi-part record has no single
 * body, so it renders as JSON naming each part separately — the same shape the
 * opencode mount's `recallOutputText` produces — and never a join (ADR-0003).
 */
function recallBodyText(value: unknown): string {
  if (!isRecord(value)) return '';
  if (typeof value['text'] === 'string') return value['text'];
  const parts = value['parts'];
  if (!Array.isArray(parts) || parts.length === 0) return '';
  return JSON.stringify({ recallId: value['recallId'], text: null,
    byteLength: value['byteLength'], parts });
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
      // drives. Absent, both surviving asks (ADR-0028: the entry checkpoint
      // and the bulk prune) journal their own off-lines instead of pretending
      // they asked.
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

      // Both handlers need a session, resolved lazily at call time: the
      // registration must not depend on a session existing when the plugin
      // mounts. `forget` answers from the session's own live snapshot and
      // queues the request for that session's next boundary; `recall` reads the
      // ledger of the one live session.
      const toolHost = resolveToolHost(ctx, options.tools);
      let unregisterTools: (() => void) | undefined;
      if (toolHost !== undefined) {
        try {
          unregisterTools = registerPluginTools(toolHost, {
            recall: async (id) => {
              const entry = liveEntry(mount, ctx);
              if (entry === undefined) throw new Error('racoons: recall has no live session to read from');
              return entry.adapter.recall(id as RecallId);
            },
            forget: async (request) => {
              const entry = liveEntry(mount, ctx);
              if (entry === undefined) {
                throw new Error('racoons: forget has no live session to read from');
              }
              return entry.adapter.forget(request);
            },
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
