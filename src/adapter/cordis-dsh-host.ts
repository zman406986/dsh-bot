import type { DshHost } from "../core/dsh-host.js";
import type { DurabilityPort } from "../core/durability.js";
import type { AccessRequestEvent } from "../core/access-types.js";
import type { AgentMessageWakeOrigin } from "../core/peer-types.js";
import { randomUUID } from "node:crypto";
import { clampActivity, clampRecentResultExcerpt } from "../core/report-clamp.js";
import type { UserQuestionsLike } from "./access-prompt.js";
import type { HostApprovalServiceLike } from "./dispatch-approval.js";
import type { SettledEvent, SpawnOptions, TerminalWorkerStatus } from "../core/types.js";
import type {
  DispatcherSpawnOptions,
  DispatcherSpawnResult,
} from "../core/types.js";
import type { RosterRecentResultSource } from "../core/roster-snapshot.js";
import {
  normalizeWorkerErrorReport,
  normalizeWorkerReport as normalizeWorkerTextReport,
} from "../worker/report.js";
import {
  WORKER_MAX_DEPTH,
  dispatcherSpawnMaxDepth,
  workerSpawnMaxDepth,
  type WorkerAgentDef,
} from "../worker/agent-def.js";
import { applyWorkerComposition } from "../worker/preset.js";
import { blocksToText, textBlocks, type ContentBlock } from "./content-blocks.js";
import type { StorageDomainLike } from "./durable-marker.js";
import { RESUME_WAKE_CUE, wakeUserMessage } from "./wake-copy.js";

export type { WorkerAgentDef };

/**
 * Structural Agent view — the live parent object dsh spawn/interrupt/send need.
 * Never re-fetched loosely for authority paths.
 */
export interface AgentLike {
  readonly session: {
    readonly id: unknown;
    readonly header?: {
      readonly parentSession?: unknown;
      readonly delegationDepth?: number;
    };
  };
  followup(message: unknown): void;
  /** Queue context without opening a turn (optional; policy inject). */
  inject?(message: unknown): void;
  /**
   * ADR-0019: the host's own per-agent scoped context (structural view of
   * `agent.ctx` — every agent loop mints one; `tools.register` addressed
   * through it registers in THIS agent's scope only, so a second dispatcher
   * never sees the first's tools and worker children never see any of them).
   * `systemPrompt.section` likewise contributes to this agent's prompt only,
   * which is what makes a scoped `deployment:persona-prefix` shadow the
   * deployment persona for one child. Optional so stub agents stay minimal.
   */
  readonly ctx?: {
    readonly tools?: ToolsLike;
    readonly systemPrompt?: SystemPromptLike;
  };
}

/** Scoped system-prompt surface used to shadow a child's persona section. */
export interface SystemPromptLike {
  section(section: {
    readonly name: string;
    readonly order: number;
    readonly text: string;
    readonly interpolate?: boolean;
  }): () => void;
  getSectionOrder(name: string): number;
}

export interface ActivationLike {
  readonly childId: unknown;
  readonly messageId?: unknown;
  readonly result?: Promise<unknown>;
  /** Stop and release this exact activation; never a later cold resume. */
  dispose(): Promise<void>;
}

export interface ActivationSpecLike {
  readonly provider: string;
  readonly label: string;
  /**
   * Caller-reserved durable child session id (local backends only —
   * `SubagentActivationSpec & { childId }`). Ticket 118 uses it for the
   * DISPATCHER spawn: minting the id up front is what lets `agent/created`
   * recognise that exact child without a per-parent counter, which is the
   * race the per-parent `pendingSpawns` counter cannot express. The host
   * refuses a reserved id that is already live or persisted
   * (`DUPLICATE_CHILD`), exactly as it would for its own minted id.
   */
  readonly childId?: unknown;
  readonly request: {
    readonly prompt: ContentBlock[];
    readonly parent: AgentLike;
    /**
     * Ticket 83: the CHILD'S ABSOLUTE delegation-depth ceiling. The host's
     * `resolveChildDepth` refuses the spawn when `parentDepth + 1 > maxDepth`
     * — it is NOT the worker's own budget. Derive with
     * `workerSpawnMaxDepth` for a worker hop, `dispatcherSpawnMaxDepth` for a
     * dispatcher hop; never send `WORKER_MAX_DEPTH` (0) here raw.
     */
    readonly maxDepth?: number;
  };
  /**
   * Cancellation before publication only. Once the activation is live, stop
   * it through `activation.dispose()` — aborting this signal does nothing.
   */
  readonly signal: AbortSignal;
  /** `parent` supplies the completion notice to the model; we keep it. */
  readonly delivery: "parent" | "caller";
}

export interface JobSnapshotLike {
  readonly id: unknown;
  readonly kind: string;
  readonly label: string;
  readonly status: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly owner?: unknown;
  readonly detail?: string;
}

/**
 * Structural view of `ctx.tools` for listing global tool names at spawn
 * and registering dispatcher tools.
 * `schemas()` with no scope is the global registry view (name per tool).
 */
export interface ToolsLike {
  schemas(scope?: unknown): ReadonlyArray<{ readonly name: string }>;
  /** Register a tool; returns the exact disposer. Optional for stub contexts. */
  register?(definition: unknown): () => void;
}

/**
 * Structural host slash-command invocation (ticket 19). The handler runs
 * instead of sending the line to the model; the result is user-visible copy.
 */
export interface CommandInvocationLike {
  readonly commandId: string;
  /** The live agent (chat) the command was invoked in. */
  readonly agent: AgentLike;
  readonly rawInput?: string;
}

/** User-visible command outcome. */
export interface CommandResultLike {
  readonly kind: "success" | "error";
  readonly text?: string;
}

/** Structural command definition (mirrors dsh CommandRegistry.register). */
export interface CommandDefinitionLike {
  /** Globally unique, fail-loud on collision. */
  readonly name: string;
  readonly description: string;
  /**
   * Optional advertised input (Finding 2: `input?: { hint, attachments? }`).
   * The hint text is shown in the command menu; never enforced by the host.
   */
  readonly input?: {
    readonly hint: string;
    readonly attachments?: boolean;
  };
  readonly handler: (
    invocation: CommandInvocationLike,
  ) => CommandResultLike | Promise<CommandResultLike>;
}

/**
 * Structural view of `ctx.commands` for plugin-owned human slash commands.
 * `register` returns the exact disposer. Optional for stub contexts.
 */
export interface CommandsLike {
  register(definition: CommandDefinitionLike): () => void;
}

/**
 * Structural Cordis context surface the adapter needs.
 * Narrow local interface — prefer this over importing full Cordis types.
 */
export interface AdapterContext {
  /**
   * Global tool registry. Optional so stub contexts stay minimal; live
   * plugin injects `tools` so the deny-list can intersect real names.
   */
  tools?: ToolsLike;
  /**
   * Host slash-command registry. Optional so stub contexts stay minimal;
   * the live plugin injects `commands` so activation can register.
   */
  commands?: CommandsLike;
  /**
   * Structured user-question seam (ticket 23; dsh-user-questions service).
   * Optional so stub contexts stay minimal; when absent the access-prompt
   * pump is inert and the shipped conversational access relay stays the
   * ask surface (ticket 23 fallback clause).
   */
  userQuestions?: UserQuestionsLike;
  /**
   * Host approval answerer service (ticket 69 L3; `ctx.approval`,
   * `@deepseek-ai/dsh-user-approval` — the face documented at
   * `docs/research/dsh-adapter-api-notes.md:220-247`, inject note `:390`).
   * Optional so stub contexts stay minimal; when absent the dispatch
   * approval seam degrades every gated dispatch to `unavailable`, which the
   * chunk-A spawn gate refuses (fail-closed, never a silent allow).
   */
  approval?: HostApprovalServiceLike;
  subagents: {
    startActivation(spec: ActivationSpecLike): Promise<ActivationLike>;
    interrupt(targetSessionId: unknown, authority: unknown): void;
    sendMessage(
      sender: AgentLike,
      targetId: unknown,
      content: ContentBlock[],
      options: { signal: AbortSignal },
    ): Promise<unknown>;
  };
  agents: {
    get(id: unknown): AgentLike | undefined;
  };
  jobs: {
    /** Omitted caller lists unowned jobs only; pass the reading session. */
    list(callerSessionId?: unknown): readonly JobSnapshotLike[];
  };
  storageDomain: StorageDomainLike;
  /** Host event bus. Payload arity varies per event (e.g. session/event is two-arg). */
  on(name: string, cb: (...args: never[]) => void): () => void;
}

export interface CordisDshHostOptions {
  /** Durable marker store (T08 DurabilityPort over storageDomain). */
  markers?: DurabilityPort;
  /** Worker agent definition; T10 supplies the real one. */
  workerAgentDef?: WorkerAgentDef;
  /**
   * Compose the user-visible wake follow-up text for a background settle.
   * Return null to fall back to the short cue. The plugin supplies this so
   * drainWake + assembleWakeTurn land the notices in model context.
   */
  composeWakeText?: (sessionId: string) => string | null;
  /**
   * Build the worker-local tool definitions for one child (ticket 122). The
   * plugin supplies this so the adapter stays core-agnostic; the returned
   * definitions are registered on the child's own scope at `agent/created`.
   */
  workerLocalTools?: (workerSessionId: unknown) => readonly unknown[];
  /**
   * Ticket 118 (ADR-0025 mitosis): activate a freshly spawned DISPATCHER
   * child — bind it as a parent, register its own scoped tool surface, inject
   * the dispatcher policy, add it to the lifecycle registry without the
   * top-level gate, and start its durability rebuild.
   *
   * Called EXACTLY ONCE per successful `spawnDispatcher`, and — when the host
   * announces the child — from the `agent/created` serial listener, i.e. the
   * last moment its own scope can take registrations before its first turn
   * (the same seam the worker composition uses). A host or stub that fires no
   * `agent/created` gets the call right after `startActivation` resolves
   * instead; in that case the child's first turn may already be open, so a
   * tool surface registered here may miss it (recorded limit, not hidden).
   *
   * The adapter passes the exact live child Agent and its session id, plus the
   * child's spawn generation (ticket 141: the spawner's generation + 1, 1 for
   * a user-started dispatcher). It never inspects the outcome — activation
   * failure must not turn a successful spawn into a host error.
   */
  onDispatcherSpawned?: (
    agent: AgentLike,
    sessionId: string,
    generation: number,
  ) => void;
  /**
   * Ticket 141: the spawn generation of a session this host knows, or null.
   * The plugin supplies this (the lifecycle answers it for live sessions), so
   * a spawn from a child computes parent generation + 1 instead of assuming
   * the spawner is a user-started generation 1.
   *
   * Optional: a stub or pre-141 caller that omits it means "generation 1",
   * which is exactly the old single-level shape.
   */
  dispatcherGenerationOf?: (sessionId: string) => number | null;
  /**
   * Ticket 142 (owner ruling 2026-10-22 — children half): a worker this
   * plugin spawned was adopted back into the host's registry after the host
   * re-created its session (a cold resume on send). The plugin wires this to
   * the core's `reclaimWorker`, which turns the ticket-59 unknown-state hold
   * into a live roster record.
   *
   * Fired exactly once per adoption; errors thrown here are logged and
   * swallowed — the child is already live, so a core-side bookkeeping failure
   * must not turn the host's create path into an error.
   */
  onWorkerReattached?: (workerId: string, parentSessionId: string) => void;
}
/**
 * Live `DshHost` over Cordis dsh services.
 * Core stays pure; this is the only place that knows subagents/agents/jobs.
 */
export interface CordisDshHost extends DshHost {
  /** Bind the exact live dispatcher Agent (explicit activation, ticket 19).
   *  ADR-0019: per dispatcher session — a map of live parents, not one slot. */
  bindParent(agent: AgentLike, sessionId: string): void;
  /**
   * Clear parent binding(s) (dispose / replace). ADR-0019: WITH a session id
   * only that session's binding is cleared (a sibling dispatcher stays
   * bound); without one, every binding is cleared (plugin unload).
   */
  unbindParent(sessionId?: string): void;
  /** Whether any parent Agent is currently bound. */
  hasParent(): boolean;
  /**
   * The live parent Agent bound for one dispatcher session, if any
   * (ADR-0019: authority is per session — spawn, interrupt, send, and the
   * access prompts resolve their agent from the session they serve).
   */
  parentAgentOf(sessionId: string): AgentLike | undefined;
  /**
   * Ticket 118 (ADR-0025 mitosis): spawn ANOTHER DISPATCHER from a bound
   * dispatcher session, returning the host-assigned child session id.
   *
   * Deliberately NOT `spawnWorker`: the child is a peer, so this path
   * - does not mark a pending spawn (no worker composition at
   *   `agent/created` — the child inherits the parent's full composition),
   * - does not enter the `workers` registry (it is not a work stream and
   *   no dispatcher-sized cap of ours exists), and
   * - passes no `agentPreset` (none exists in `ActivationSpecLike`).
   *
   * The only bounds are the host's: `maxDepth` (derived with
   * `dispatcherSpawnMaxDepth`, parent depth + 2) and the 8-active root pool.
   * Host errors surface unchanged — no refusal class is invented here.
   */
  spawnDispatcher(opts: DispatcherSpawnOptions): Promise<DispatcherSpawnResult>;
  /** Live job snapshots for the check surface. Process-local; not durable. */
  listLiveJobs(callerSessionId?: string): readonly JobSnapshotLike[];
  /** Durable markers (ADR-0006). */
  readonly markers: DurabilityPort | undefined;
  /**
   * Ticket 138 (owner ruling 2026-10-22 — dispatchers half): whether this
   * session carries our own durable `dispatcher_sessions` mark. Synchronous,
   * backed by an in-memory mirror warmed from the mark table; the peer fence
   * consults it so a marked dispatcher that the host has not re-announced yet
   * is accepted instead of refused (`unknown-target` still applies to a
   * target with NO mark — ticket 70 §2's fence is intact).
   *
   * Only sessions spawned by THIS plugin in THIS OR AN EARLIER process carry
   * a mark, so widening the fence cannot accept an arbitrary id.
   */
  isDurablyMarkedDispatcher(sessionId: string): boolean;
  /**
   * Ticket 138: merge the store's current mark table into the mirror.
   * Called once per dispatcher activation (from the plugin's `onActivated`
   * chain, after the durability rebuild) — in-process writes enter the mirror
   * directly at write time, so this is the restart/boot half only. A failing
   * read leaves the mirror untouched: a marker problem must never turn an
   * activation or a send into a refusal.
   */
  refreshDispatcherMarks(): Promise<void>;
  /**
   * Ticket 142 (owner ruling 2026-10-22 — the children half): the durable
   * wake identity of a WORKER session, from the same synchronous mirror
   * pattern as {@link isDurablyMarkedDispatcher}. Undefined means "no row":
   * never spawned as a worker by us, already terminal, or abandoned.
   *
   * The core consults this when a steer arrives for an id it has no roster
   * record for — a marked id is dormant, not unknown, so the correction is
   * accepted and `wakeDormantWorker` cold-resumes it.
   */
  workerSessionMark(
    workerId: string,
  ): { readonly parentSessionId: string } | undefined;
  /**
   * Ticket 142: merge the store's current `worker_sessions` rows into the
   * mirror. Called once per dispatcher activation beside
   * {@link refreshDispatcherMarks}; in-process writes enter the mirror
   * synchronously. A failing read leaves the mirror untouched — a marker
   * problem must never turn a send into a refusal.
   */
  refreshWorkerSessionMarks(): Promise<void>;
  /** Map agent session id → workerId for owned workers. */
  workerIdOf(agentSessionId: string): string | undefined;
  /** Whether this host spawned the worker id. */
  owns(workerId: string): boolean;
  /**
   * Latest observed activity phrase for an owned worker, derived from the
   * host `session/event` firehose (`tool/call` events; ticket 29). Null
   * when nothing has been observed or the worker settled — never polled,
   * never guessed.
   */
  recentActivity(workerId: string): string | null;
  /**
   * Ticket 61: host-clock ms of the last firehose-observed activity for an
   * owned worker — the observation moment of `recentActivity`'s phrase.
   * Null when nothing has been observed or the worker settled. Same
   * subscription as `recentActivity` — no new seam, no polling.
   */
  lastActivityAtMs(workerId: string): number | null;
  /**
   * Ticket 110: the bounded per-worker activity ring, newest-first — up to
   * `n` of the last firehose-observed phrases with their observation
   * moments, from the same subscription as `recentActivity` (no new seam,
   * no polling, nothing persisted). The breadcrumb is RETAINED through
   * settle so the wake digest (ticket 110 phase 2) can show what the
   * worker did before finishing — `recentActivity`/`lastActivityAtMs`
   * still go null at settle, so the ticket-29 check-row honesty rule is
   * unchanged. Empty when nothing has been observed; `n <= 0` yields an
   * empty array. Cleared on dispose.
   */
  recentActivities(workerId: string, n: number): readonly WorkerActivityEntry[];
  /**
   * Ticket 75: subscribe to firehose-observed tool calls on owned workers.
   * The `session/event` handler already matches every `tool/call` for an
   * owned session (the ticket-29 subscription); this notifies subscribers so
   * the core's `noteToolCall` count advances on the same observation. Fired
   * once per observed event, whether or not the payload was readable enough
   * for an activity phrase. No new seam, no polling.
   */
  onWorkerToolCall(cb: (workerId: string) => void): void;
  /**
   * Ticket 117: subscribe to STRUCTURED user-message observations on any
   * session (never text). Fired once per real user prompt the host records,
   * with the session it landed on.
   *
   * What this watches, verified against `dsh@0.2.1-rc.2`:
   * - `agent/inbox/spliced` (`dsh-agent-loop/lib/index.js:180-207`) — the
   *   commit `Agent.send`/`followup`/`steer` performs SYNCHRONOUSLY
   *   (`:800-814`), so a message user typed while a tool call is blocked
   *   reaches this listener immediately. Its `inserted` entries are the
   *   `UserMessage`s, carrying `source.kind`.
   * - `user/message` — the same message committed at a turn's pre-step
   *   (`dsh-agent-loop/lib/index.js:1069-1073`); only relevant when a wait
   *   spans a turn boundary.
   *
   * Admitted source kinds: `"user"` only — the host's real human prompt
   * (`dsh-api-session-controller/lib/types/index.js:3225`, also every slash
   * command that steers user input, `dsh-plan-mode`). Explicitly NOT our own
   * `plugin:multitask-dispatcher` wakes, NOT `agent-message` peer wakes, NOT
   * `runtime-context`/`system-prompt`/`model` bookkeeping. The text is never
   * inspected, so no wording can forge or suppress a release.
   */
  onDispatcherUserMessage(cb: (sessionId: string) => void): void;
  /**
   * Ticket 41: the bounded settle-report excerpt observed for an owned
   * worker when it settled (adapter-side projection of the same
   * `subagent/end` event the core receives), or `null` when nothing honest
   * was observed (never settled, empty report). The core stores no report
   * text — this seam is how the roster projection sources the deliverables
   * line's excerpt at publish time without new core state.
   */
  recentResult(workerId: string): RosterRecentResultSource | null;
  /** Fire step-boundary callbacks (called from parent-agent status wiring). */
  emitStepBoundary(workerId: string): void;
  /** Notify core that a worker's first turn started (spawned → running). */
  onWorkerTurnStarted?: (workerId: string) => void;
  /**
   * Emit a structured access request from a worker tool into core
   * subscribers. Adapter-only helper for the request_access tool.
   */
  emitAccessRequest(event: AccessRequestEvent): void;
  dispose(): void;
}

/** Default in-process spawn provider name (dsh-subagent-spawn-in-process). */
export const SPAWN_PROVIDER = "spawn";

/** Max characters of the argument hint inside an activity phrase. */
export const ACTIVITY_HINT_CHARS = 60;

/**
 * Committed session event, structural view (`dsh-session` `session/event`
 * firehose; ticket 29 live-verification). Only the fields the activity
 * derivation reads are declared — everything else stays opaque.
 */
export interface SessionEventLike {
  readonly type?: unknown;
  readonly data?: unknown;
}

/** Session handle carried as the first `session/event` argument. */
export interface SessionRefLike {
  readonly id?: unknown;
}

/**
 * Ticket 117: the message source kind of a real human prompt on
 * `dsh@0.2.1-rc.2`. Every host producer of human-authored input stamps
 * exactly this (`dsh-api-session-controller/lib/types/index.js:3225`,
 * `dsh-acp/lib/index.js:835`, `dsh-plan-mode/lib/index.js:221`,
 * `dsh-command-goal/lib/index.js:105`). Our own wakes use
 * `plugin:multitask-dispatcher` and peer wakes `agent-message`, so the
 * filter cannot mistake host background traffic for the user.
 */
export const USER_MESSAGE_SOURCE_KIND = "user";

/** Whether one structural message records a real user prompt by source. */
function isUserSourcedMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const record = message as {
    readonly role?: unknown;
    readonly source?: { readonly kind?: unknown } | null;
  };
  if (record.role !== "user") return false;
  if (typeof record.source !== "object" || record.source === null) return false;
  return record.source.kind === USER_MESSAGE_SOURCE_KIND;
}

/**
 * Ticket 117: the session id when ONE committed `session/event` reports a
 * real user-authored message, otherwise null. Structured only — no text is
 * read, no heading is matched, so copy can neither forge nor suppress a
 * release.
 *
 * Two event types count, both host-authored (`dsh@0.2.1-rc.2`):
 * - `agent/inbox/spliced` — the durable inbox mutation `Agent.send`/
 *   `followup`/`steer` commits synchronously inside the send call
 *   (`dsh-agent-loop/lib/index.js:180-207`, sinks at `:800-814`). This is
 *   the one that fires while a tool call is blocked, i.e. during an await.
 *   Only `inserted` entries count: they are the messages the caller supplied,
 *   while `removedCount`/`outcome` describe queue management.
 * - `user/message` — the same message committed at a turn's pre-step
 *   (`dsh-agent-loop/lib/index.js:1069-1073`). It arrives after a wait has
 *   already ended in the common case, so it is a secondary, harmless catch
 *   for a wait that spans a turn boundary.
 *
 * Explicit non-matches, by source: our `plugin:multitask-dispatcher` wakes,
 * `agent-message` peer sends, `runtime-context`/`system-prompt` context, and
 * `model`/`tool` traffic.
 */
export function dispatcherUserMessageSession(
  sessionRef: unknown,
  event: unknown,
): string | null {
  if (typeof event !== "object" || event === null) return null;
  const record = event as { readonly type?: unknown; readonly data?: unknown };
  const data = record.data;
  if (typeof data !== "object" || data === null) return null;

  let userAuthored = false;
  if (record.type === "agent/inbox/spliced") {
    const inserted = (data as { readonly inserted?: unknown }).inserted;
    userAuthored =
      Array.isArray(inserted) && inserted.some(isUserSourcedMessage);
  } else if (record.type === "user/message") {
    userAuthored = isUserSourcedMessage(data);
  }
  if (!userAuthored) return null;

  if (typeof sessionRef !== "object" || sessionRef === null) return null;
  const sessionId = (sessionRef as SessionRefLike).id;
  if (sessionId === undefined || sessionId === null) return null;
  return String(sessionId);
}

/**
 * One human-readable activity phrase from a `tool/call` event body
 * (`{ name, arguments }`): the tool name plus a short primary-argument
 * hint, whitespace-collapsed and clamped to `CHECK_ACTIVITY_CHARS`.
 * Null for anything unreadable — never invented.
 */
export function describeToolActivity(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.length === 0) {
    return null;
  }
  const hint = primaryArgumentHint(record.arguments);
  return clampActivity(hint === null ? record.name : `${record.name}: ${hint}`);
}

/**
 * First non-empty string field of the parsed raw-arguments JSON — a generic
 * primary-argument hint without knowing any host tool's vocabulary. Junk,
 * non-JSON, or no string field → null.
 */
function primaryArgumentHint(rawArguments: unknown): string | null {
  if (typeof rawArguments !== "string" || rawArguments.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, ACTIVITY_HINT_CHARS);
    }
  }
  return null;
}

/**
 * Map dsh SubagentStopReason → core TerminalWorkerStatus.
 * max-tokens / refusal / unknown → error.
 */
export function mapStopReason(stopReason: string): TerminalWorkerStatus {
  switch (stopReason) {
    case "completed":
      return "completed";
    case "aborted":
      return "aborted";
    default:
      return "error";
  }
}

/**
 * Settle report from host ContentBlocks: join text, then apply worker
 * normalization (empty → placeholder; error passes message).
 * Abort delivers no invented report — empty text stays empty.
 */
export function normalizeSettleReport(
  status: TerminalWorkerStatus,
  lastAssistantMessage: readonly ContentBlock[] | undefined,
): string {
  const text = blocksToText(lastAssistantMessage);
  if (status === "aborted") {
    // Abort must not invent a report; keep any real text, else empty.
    return text.trim();
  }
  if (status === "error") {
    return normalizeWorkerErrorReport(text);
  }
  return normalizeWorkerTextReport(text);
}

/**
 * Back-compat ContentBlock wrapper: completed-style empty → placeholder.
 * Prefer {@link normalizeSettleReport} when status is known.
 */
export function normalizeWorkerReport(
  lastAssistantMessage: readonly ContentBlock[] | undefined,
): string {
  return normalizeSettleReport("completed", lastAssistantMessage);
}

/** Live global tool names visible to the registry (empty when tools absent). */
export function listGlobalToolNames(ctx: AdapterContext): ReadonlySet<string> {
  const tools = ctx.tools;
  if (tools === undefined) return new Set();
  try {
    const schemas = tools.schemas();
    return new Set(schemas.map((schema) => schema.name));
  } catch {
    return new Set();
  }
}

interface WorkerEntry {
  readonly parentSessionId: string;
  readonly agentSessionId: string;
}

/** Max phrases retained per worker in the activity ring (ticket 110). */
export const WORKER_ACTIVITY_RING_CAPACITY = 5;

/** One firehose-observed activity phrase with its observation moment. */
export interface WorkerActivityEntry {
  readonly phrase: string;
  readonly atMs: number;
}

/**
 * Ticket 110: bounded in-memory per-worker activity ring — the last
 * {@link WORKER_ACTIVITY_RING_CAPACITY} observed phrases,
 * insertion-ordered, oldest evicted. Plain adapter state: nothing
 * persisted, no new seam. The existing single-entry accessors
 * (`recentActivity`, `lastActivityAtMs`) read `latest` and are gated on
 * settle (ticket 29 honesty: a settled worker has no LIVE activity), while
 * the wake digest reads `recent` (newest-first) — retained through settle
 * so the digest can show the final breadcrumb.
 */
export class WorkerActivityRing {
  readonly #rings = new Map<string, WorkerActivityEntry[]>();

  /** Append an observed phrase, evicting the oldest past the capacity. */
  record(workerId: string, phrase: string, atMs: number): void {
    const ring = this.#rings.get(workerId);
    const entries = ring ?? [];
    entries.push({ phrase, atMs });
    if (entries.length > WORKER_ACTIVITY_RING_CAPACITY) {
      entries.splice(0, entries.length - WORKER_ACTIVITY_RING_CAPACITY);
    }
    this.#rings.set(workerId, entries);
  }

  /** The newest entry — the view the single-entry accessors read. */
  latest(workerId: string): WorkerActivityEntry | undefined {
    const ring = this.#rings.get(workerId);
    return ring?.[ring.length - 1];
  }

  /** Up to `n` entries, newest-first. `n <= 0` (or non-finite) → empty. */
  recent(workerId: string, n: number): readonly WorkerActivityEntry[] {
    if (!Number.isFinite(n) || n <= 0) return [];
    const ring = this.#rings.get(workerId);
    if (ring === undefined) return [];
    return ring.slice(-n).reverse();
  }

  /** Drop one worker's ring (settle/abort cleanup). */
  clear(workerId: string): void {
    this.#rings.delete(workerId);
  }

  /** Drop every ring (dispose). */
  clearAll(): void {
    this.#rings.clear();
  }
}

export function createCordisDshHost(
  ctx: AdapterContext,
  options?: CordisDshHostOptions,
): CordisDshHost {
  const workerAgentDef = options?.workerAgentDef;
  const markers = options?.markers;
  const composeWakeText = options?.composeWakeText;
  const workerLocalTools = options?.workerLocalTools;
  const onDispatcherSpawned = options?.onDispatcherSpawned;
  const dispatcherGenerationOf = options?.dispatcherGenerationOf;
  const onWorkerReattachedRaw = options?.onWorkerReattached;

  /**
   * Ticket 142: fire the re-attachment hook, never letting it break the
   * host's create path — the child is already live, so a core bookkeeping
   * failure must not read as a spawn error.
   */
  function onWorkerReattached(workerId: string, parentSessionId: string): void {
    if (onWorkerReattachedRaw === undefined) return;
    try {
      onWorkerReattachedRaw(workerId, parentSessionId);
    } catch (error) {
      try {
        console.warn(
          `[multitask-dispatcher] worker ${workerId} could not be re-adopted by the core:`,
          error,
        );
      } catch {
        // A broken console must not break the create path either.
      }
    }
  }

  /**
   * The child's mid-task reply tool (ticket 122). Null when the plugin did not
   * supply a builder, so composition simply registers nothing extra.
   */
  function buildWorkerLocalTools(workerSessionId: unknown): readonly unknown[] {
    if (workerLocalTools === undefined) return [];
    return workerLocalTools(workerSessionId);
  }

  /**
   * ADR-0019: live dispatcher parents, keyed by dispatcher session id —
   * a map of sessions, not one slot. Spawn, interrupt, and sendMessage
   * resolve the authority agent from the session they serve (spawn from the
   * request's `parentSessionId`; interrupt/send from the worker's recorded
   * parent).
   */
  const parents = new Map<string, AgentLike>();
  const workers = new Map<string, WorkerEntry>();
  const spawnControllers = new Map<string, AbortController>();
  /**
   * Live activations keyed by worker id. `startActivation`'s signal owns
   * pre-publication cancellation only; a published worker is stopped by
   * disposing this exact activation.
   */
  const workerActivations = new Map<string, ActivationLike>();
  /**
   * Spawns in flight per dispatcher session. `agent/created` is the only seam
   * that hands us a child's own scoped context BEFORE its first turn, and it
   * fires inside `startActivation`; this counter is what identifies the child
   * that call created (a dispatcher can also delegate through the host's own
   * `subagent` tool, whose child must not receive the worker composition).
   */
  const pendingSpawns = new Map<string, number>();
  /**
   * Ticket 118 chunk 3: child ids this host RESERVED for a dispatcher spawn,
   * recorded before `startActivation` is called. A reserved id is the exact
   * answer to the `agent/created` identification problem that `pendingSpawns`
   * cannot give: `spawnDispatcher` mints the id and passes it as
   * `spec.childId`, so the listener matches this child by IDENTITY, never by
   * a counter shared with concurrent worker spawns from the same parent.
   *
   * The window is therefore closed in both directions:
   * - a dispatcher child announced while a worker spawn is in flight is
   *   activated as a dispatcher and never receives the worker composition;
   * - a worker child announced while a dispatcher spawn is in flight cannot
   *   match a reserved id, so it still takes the normal `pendingSpawns` path.
   *
   * Entries are removed in `spawnDispatcher`'s `finally`, so a stale id can
   * never mislabel a later child. `dispatcherActivated` is the durable half of
   * the same answer — every child this host ever activated as a dispatcher —
   * so an announcement that arrives AFTER the spawn resolved still cannot be
   * composed as a worker. Its cardinality matches the `workers` map (which
   * also lives for the process), and dispatcher spawns are bounded by the
   * host's own live-child pool, so it is not a leak this adapter invents.
   */
  const reservedDispatcherIds = new Set<string>();
  const dispatcherActivated = new Set<string>();
  /**
   * Ticket 138: in-memory mirror of the durable `dispatcher_sessions` table,
   * keyed by session id → the spawner recorded on the row (undefined for a
   * pre-138 row). The peer fence is synchronous and cannot await a store
   * read, so the mark table is warmed once per dispatcher activation
   * (`refreshDispatcherMarks`, called from the plugin's `onActivated`) and
   * every in-process write is added immediately. Entries are never removed
   * (the table never deletes either — see ticket 130).
   */
  const dispatcherMarks = new Map<string, string | undefined>();
  /**
   * Ticket 141: spawn generation per spawned dispatcher session (1 =
   * user-started, +1 per spawn). A SEPARATE map on purpose: `dispatcherMarks`
   * is read as a bare parent id in several places, and the generation is not
   * a property of the parent — it is the child's depth in the dispatcher tree.
   *
   * Filled from three places, in this order of authority:
   * - the reserved-id seed in `spawnDispatcher` (BEFORE `startActivation`
   *   resolves, because `agent/created` fires inside that call and the mark
   *   row does not exist yet);
   * - the mark row, on a cold resume (`resumeMarkedDispatcher`) and on the
   *   boot read (`refreshDispatcherMarks`);
   * - never removed until `dispose` — a re-announcement of the same child
   *   must resolve the same number.
   */
  const dispatcherGenerations = new Map<string, number>();
  /**
   * Ticket 138: sessions whose cold resume this process already asked the
   * host for. A second send before the resumed child is announced must not
   * ask again — both messages are queued in our own peer inbox and wake lane,
   * so one request is enough. Cleared when the resume call fails.
   */
  const resumeRequested = new Set<string>();
  /**
   * Ticket 138: wake turns the host was asked to open for a session that was
   * NOT live. They are parked here and re-opened by the activation hook — the
   * "deliver on activation" half of wake-on-send, carried by the SAME
   * `openWakeTurn` → `composeWakeText` → wake-bus path a live wake uses. Only
   * durably marked targets are parked; an unmarked id keeps today's silent
   * no-op (the core fence refuses those sends before a wake is ever asked
   * for).
   */
  const pendingWakeTurns = new Map<string, AgentMessageWakeOrigin | undefined>();
  /**
   * Ticket 142: in-memory mirror of the durable `worker_sessions` table,
   * keyed by worker id → the spawner recorded on the row. Same discipline as
   * `dispatcherMarks` (the fence is synchronous): warmed once per activation
   * from the store, extended synchronously at spawn, and DROPPED on settle,
   * stop, or hold release — a finished worker must never be woken back.
   */
  const workerSessions = new Map<string, string>();
  /**
   * Ticket 142: corrections sent to a dormant worker, one slot per worker id
   * (last-wins — the same rule the core's steer queue applies to a live
   * worker). Delivered once when the resumed child is announced, then
   * dropped. A worker that is resumed by something OTHER than our wake keeps
   * its text here until the next activation, which is the honest place for it.
   */
  const parkedWorkerWakes = new Map<string, string>();
  const settledCallbacks: Array<(event: SettledEvent) => void> = [];
  const stepBoundaryCallbacks: Array<(workerId: string) => void | Promise<void>> = [];
  const accessRequestCallbacks: Array<(event: AccessRequestEvent) => void> = [];
  // Ticket 75: firehose-observed tool calls on owned workers, fanned out to
  // subscribers (the plugin wires the core's noteToolCall onto this).
  const toolCallCallbacks: Array<(workerId: string) => void> = [];
  // Ticket 117: structured user-message observations on ANY session, fanned
  // out to subscribers (the plugin wires `multitask.releaseWaits` onto this).
  // The observation is the SAME `session/event` subscription below — no new
  // host seam, no polling, no timers.
  const userMessageCallbacks: Array<(sessionId: string) => void> = [];
  // Ticket 29: per-worker activity phrases, projected from the host
  // `session/event` firehose. Pure subscription — no polling, no timers.
  // Ticket 61: each entry carries its observation moment (host clock at
  // event arrival) so the liveness verdict is derivable over existing truth
  // — no new subscription, no new seam, no background machinery.
  // Ticket 110: the single-entry slot became a bounded ring (last 5
  // phrases, oldest evicted) so the wake digest can show a multi-step
  // breadcrumb; `recentActivity`/`lastActivityAtMs` still read the newest
  // entry, so their semantics are unchanged. Plain in-memory state —
  // nothing persisted; entries clear on dispose. Ticket 110 phase 2: the
  // ring is no longer cleared at settle — the digest composes AFTER the
  // settle, so the breadcrumb must survive it — and settle honesty is
  // enforced instead by `settledWorkerIds`, which gates the live-activity
  // accessors to null while `recentActivities` keeps the full breadcrumb.
  const activityRing = new WorkerActivityRing();
  // Ticket 29 honesty, ticket 110 phase 2 mechanism: workers whose
  // `subagent/end` was observed. A settled worker has no live activity —
  // the check row shows the terminal status — so the single-entry
  // accessors read null for these ids even though the ring retains the
  // breadcrumb for the wake digest.
  const settledWorkerIds = new Set<string>();
  // Ticket 41: latest bounded settle-report excerpt per settled worker,
  // clamped once at observation. Same subscription discipline as
  // `workerActivity`: adapter-side projection of host-observed truth —
  // the core stores no report text and no second transcript exists.
  const workerResults = new Map<string, RosterRecentResultSource>();
  let wakeMissingLogged = false;

  /**
   * Shared wake-turn mechanics (ticket 116). `origin` is the optional
   * structured source override: a peer wake passes the `agent-message`
   * shape, everything else keeps the producer-owned plugin kind. The
   * composed text is never consulted for origin.
   */
  function openWakeTurn(
    sessionId: string,
    origin?: AgentMessageWakeOrigin,
    liveAgent?: AgentLike,
  ): void {
    const agent = liveAgent ?? ctx.agents.get(sessionId);
    if (agent === undefined) {
      // Ticket 138: a marked dispatcher that is not live is exactly the
      // wake-on-send case. Park the turn (latest send wins — one turn
      // surfaces the whole inbox) and ask the host to cold-resume the child;
      // the activation hook re-opens it. An UNMARKED id keeps the pre-138
      // no-op: nothing can resume it, and the core fence refuses such sends
      // before a wake is ever requested.
      if (dispatcherMarks.has(sessionId)) {
        pendingWakeTurns.set(sessionId, origin);
        resumeDormantDispatcher(sessionId);
        return;
      }
      if (!wakeMissingLogged) {
        wakeMissingLogged = true;
        // Unknown session: no-op. Never throw into the wake bus.
      }
      return;
    }
    let text: string | null = null;
    if (composeWakeText !== undefined) {
      try {
        text = composeWakeText(sessionId);
      } catch {
        text = null;
      }
    }
    agent.followup(wakeUserMessage(text ?? undefined, origin));
  }

  /**
   * Ticket 138 (owner ruling 2026-10-22 — "bots should be wake-able, both
   * dispatchers and children"; this is the DISPATCHERS half): cold-resume a
   * marked dispatcher the host has not re-announced since the restart.
   *
   * Mechanism: `ctx.subagents.sendMessage(sender, targetId, …)` is the host's
   * documented resume path — for an absent child it cold-resumes a new
   * Activation and then delivers. The sender must be the exact live parent
   * Agent the host recorded as this child's parent, so the mark carries the
   * spawner's session id and the parent binding supplies the object.
   *
   * The payload is `RESUME_WAKE_CUE`, NOT the peer text: this call only
   * wakes the child. The peer message itself is drained from our wake bus
   * once the child activates (`pendingWakeTurns` → `openWakeTurn` →
   * `composeWakeText` → `assemblePeerWakeTurn`), so it is never delivered
   * twice and always carries its `agent-message` origin.
   *
   * Failure is honest and quiet: the send was already ACCEPTED by the core
   * (the mark is the whole permission), so a resume that cannot be issued —
   * no row parent, no bound parent Agent, a host refusal — leaves the message
   * in the peer inbox for the next activation to deliver. Nothing is thrown
   * into the wake bus, and no refusal class is invented.
   */
  function resumeDormantDispatcher(sessionId: string): void {
    if (resumeRequested.has(sessionId)) return;
    const parentSessionId = dispatcherMarks.get(sessionId);
    if (parentSessionId === undefined) {
      // A pre-138 row: the mark is enough to accept a send, but not enough
      // to resume (the host needs the sender Agent, not just an id).
      return;
    }
    const sender = parents.get(parentSessionId);
    if (sender === undefined) {
      // The spawner is not bound in this process (it never activated this
      // boot): the message waits in the inbox for when it does.
      return;
    }
    resumeRequested.add(sessionId);
    const controller = new AbortController();
    void Promise.resolve()
      .then(() =>
        ctx.subagents.sendMessage(
          sender,
          sessionId,
          textBlocks(RESUME_WAKE_CUE),
          { signal: controller.signal },
        ),
      )
      .catch((error) => {
        // Retry on the NEXT send: the resume never reached the host.
        resumeRequested.delete(sessionId);
        try {
          console.warn(
            `[multitask-dispatcher] dispatcher ${sessionId} could not be resumed on send:`,
            error,
          );
        } catch {
          // A broken console must not break the wake path either.
        }
      });
  }

  function ownsSession(agentSessionId: string): string | undefined {
    return workers.has(agentSessionId) ? agentSessionId : undefined;
  }

  /**
   * Ticket 142 (owner ruling 2026-10-22 — "bots should be wake-able, both
   * dispatchers and children"; this is the CHILDREN half): wake a worker that
   * carries our own durable `worker_sessions` row but has no live Agent.
   *
   * The mechanics mirror `resumeDormantDispatcher` exactly: park the text
   * (last-wins — one slot, like the core's steer queue), then ask the host to
   * cold-resume through `ctx.subagents.sendMessage` from the SPAWNER recorded
   * on the row, using `RESUME_WAKE_CUE` rather than the correction. The
   * correction itself is delivered by `deliverParkedWorkerWake` once the
   * resumed child is announced, so it is never sent twice.
   *
   * Failure is honest and quiet, same rule as the dispatcher half: the send
   * was already ACCEPTED by the core (the mark is the whole permission), so a
   * wake that cannot be issued — no bound spawner, a host refusal — logs, and
   * the text stays parked for the next activation. Nothing is thrown into the
   * caller and no refusal class is invented.
   */
  function requestDormantWorkerWake(workerId: string, message: string): void {
    parkedWorkerWakes.set(workerId, message);
    if (resumeRequested.has(workerId)) return;
    const parentSessionId = workerSessions.get(workerId);
    if (parentSessionId === undefined) return;
    const sender = parents.get(parentSessionId);
    if (sender === undefined) {
      // The spawner is not bound in this process (it never activated this
      // boot): the text waits here for when it does.
      return;
    }
    resumeRequested.add(workerId);
    const controller = new AbortController();
    void Promise.resolve()
      .then(() =>
        ctx.subagents.sendMessage(
          sender,
          workerId,
          textBlocks(RESUME_WAKE_CUE),
          { signal: controller.signal },
        ),
      )
      .catch((error) => {
        // Retry on the NEXT send: the resume never reached the host. The
        // parked text stays, so nothing was lost.
        resumeRequested.delete(workerId);
        try {
          console.warn(
            `[multitask-dispatcher] worker ${workerId} could not be resumed on send:`,
            error,
          );
        } catch {
          // A broken console must not break the wake path either.
        }
      });
  }

  /**
   * Ticket 142: hand a parked correction to a worker the host just brought
   * back. The slot is cleared BEFORE the send, so a repeat announcement of the
   * same session delivers nothing a second time; a failing send is logged and
   * not retried (the send was already accepted — see `wakeDormantWorker`).
   */
  function deliverParkedWorkerWake(workerId: string): void {
    resumeRequested.delete(workerId);
    const text = parkedWorkerWakes.get(workerId);
    if (text === undefined) return;
    parkedWorkerWakes.delete(workerId);
    const entry = workers.get(workerId);
    const parentSessionId = entry?.parentSessionId ?? workerSessions.get(workerId);
    const sender =
      parentSessionId !== undefined ? parents.get(parentSessionId) : undefined;
    if (sender === undefined) {
      // Nothing to send WITH (the spawner is gone): drop the text rather than
      // hold it against a worker that is now live and would receive it on top
      // of whatever it did meanwhile. Logged, never silently swallowed.
      try {
        console.warn(
          `[multitask-dispatcher] worker ${workerId} was resumed but its spawner is not bound; the parked correction was dropped`,
        );
      } catch {
        // A broken console must not break the create path either.
      }
      return;
    }
    const controller = new AbortController();
    void Promise.resolve()
      .then(() =>
        ctx.subagents.sendMessage(sender, workerId, textBlocks(text), {
          signal: controller.signal,
        }),
      )
      .catch((error) => {
        try {
          console.warn(
            `[multitask-dispatcher] correction for resumed worker ${workerId} could not be delivered:`,
            error,
          );
        } catch {
          // A broken console must not break the create path either.
        }
      });
  }

  const offSubagentEnd = ctx.on("subagent/end", (info: never) => {    const end = info as {
      id: unknown;
      stopReason: string;
      lastAssistantMessage?: ContentBlock[];
    };
    const workerId = String(end.id);
    if (!workers.has(workerId)) return;
    // A settled worker has no live activity; the check row shows the
    // terminal status instead (ticket 29 honesty rule). Ticket 110 phase 2:
    // the ring itself is retained — the wake digest composes after this
    // event and reads the final breadcrumb via `recentActivities` — so
    // settle honesty is enforced here by marking the worker settled, which
    // gates `recentActivity`/`lastActivityAtMs` to null.
    settledWorkerIds.add(workerId);
    const status = mapStopReason(end.stopReason);
    const event: SettledEvent = {
      workerId,
      status,
      report: normalizeSettleReport(status, end.lastAssistantMessage),
      transcriptRef: workerId,
    };
    // Ticket 41: hold the bounded excerpt for the roster's deliverables
    // line BEFORE the core observers run, so the publish the settle
    // transition triggers already sees it. Empty report (an aborted worker
    // with no text) → no excerpt rather than an invented one.
    const excerpt = clampRecentResultExcerpt(event.report);
    if (excerpt !== null) {
      workerResults.set(workerId, { text: excerpt, settledAtMs: Date.now() });
    } else {
      workerResults.delete(workerId);
    }
    for (const cb of [...settledCallbacks]) {
      cb(event);
    }
  });

  const offSessionEvent = ctx.on("session/event", (...args: never[]) => {
    const [sessionRef, rawEvent] = args as unknown as [unknown, unknown];
    const event = rawEvent as SessionEventLike | null;
    if (typeof event !== "object" || event === null) return;
    // Ticket 117: a real user prompt on ANY session releases that session's
    // await waiters. Read BEFORE the worker-only filter below, because the
    // dispatcher session is never an owned worker — the filter would drop it.
    // Structured source only; the text is never inspected.
    if (userMessageCallbacks.length > 0) {
      const userId = dispatcherUserMessageSession(sessionRef, event);
      if (userId !== null) {
        for (const cb of [...userMessageCallbacks]) {
          cb(userId);
        }
      }
    }
    if (event.type !== "tool/call") return;
    const session = sessionRef as SessionRefLike | null;
    if (typeof session !== "object" || session === null) return;
    const workerId = String(session.id);
    if (!workers.has(workerId)) return;
    // Ticket 75: an observed `tool/call` is a tool call whether or not the
    // payload was readable — the count advances unconditionally, while the
    // phrase stays null (never invented) for unreadable payloads.
    for (const cb of [...toolCallCallbacks]) {
      cb(workerId);
    }
    const phrase = describeToolActivity(event.data);
    if (phrase !== null) {
      activityRing.record(workerId, phrase, Date.now());
    }
  });

  /**
   * Ticket 118 chunk 3: the one activation call per spawned dispatcher,
   * deduplicated by session id so the `agent/created` listener and the
   * post-`startActivation` fallback can never both activate the same child.
   *
   * Failure policy: the hook is the PLUGIN's step (bind parent, scoped tool
   * surface, policy, lifecycle, rebuild) and must not turn a spawn the host
   * already accepted into a host refusal — the model would be told nothing
   * started while a live child exists. A throw is therefore logged honestly
   * and the child stays live but inert; `dispatcherActivated` still records
   * the attempt so neither path retries it.
   *
   * `generation` (ticket 141) is resolved by the caller from the map/mark and
   * forwarded to the hook; it is the number the policy text names.
   */
  function activateSpawnedDispatcher(
    childAgent: AgentLike,
    sessionId: string,
    generation: number = dispatcherGenerations.get(sessionId) ?? 2,
  ): void {
    if (onDispatcherSpawned === undefined) {
      flushPendingWakeTurn(sessionId, childAgent);
      return;
    }
    if (dispatcherActivated.has(sessionId)) {
      // Ticket 130: a repeat resume does nothing twice. Ticket 138: a wake a
      // send parked for this id is still discharged — for a child that is
      // live again it lands normally, and there is no second activation to
      // wait for.
      flushPendingWakeTurn(sessionId, childAgent);
      return;
    }
    dispatcherActivated.add(sessionId);
    try {
      onDispatcherSpawned(childAgent, sessionId, generation);
    } catch (error) {
      try {
        console.warn(
          `[multitask-dispatcher] spawned dispatcher ${sessionId} could not be activated:`,
          error,
        );
      } catch {
        // A broken console must not break the spawn either.
      }
    }
    // Ticket 138: the parked wake turn is opened LAST — after the tool
    // surface, the policy inject and the lifecycle registration have landed
    // (the plugin's `onDispatcherSpawned` runs synchronously above) — so the
    // resumed dispatcher's first turn already has its own tools and policy.
    // If no send parked a turn for this id, this is a no-op.
    flushPendingWakeTurn(sessionId, childAgent);
  }

  /**
   * Ticket 138: discharge a wake turn a send parked for a session the host
   * had not announced yet. Called from the activation helper, i.e. only once
   * the resumed child exists, and handed the exact child Agent the host
   * announced (no re-fetch from `ctx.agents`).
   *
   * `resumeRequested` is cleared HERE, on activation: the resume is finished,
   * so a later cold death of the same session may be resumed again. It is
   * also cleared when a resume call FAILS (so the next send retries).
   */
  function flushPendingWakeTurn(
    sessionId: string,
    childAgent: AgentLike,
  ): void {
    resumeRequested.delete(sessionId);
    if (!pendingWakeTurns.has(sessionId)) return;
    const origin = pendingWakeTurns.get(sessionId);
    pendingWakeTurns.delete(sessionId);
    openWakeTurn(sessionId, origin, childAgent);
  }

  /**
   * Ticket 130: record the child's dispatcher identity durably.
   *
   * Called once per successful `spawnDispatcher`, after `startActivation`
   * resolved (before that there is no session id to key on). Never deleted —
   * deactivation also runs on plugin unload, so a delete would wipe the mark
   * at every restart; the table grows and that is accepted.
   *
   * A store that omits the optional seam (pre-130 doubles) is a no-op, and a
   * failing write is logged rather than surfaced: the host already accepted
   * the spawn, so a marker problem must never read as a host refusal. The
   * lost mark is the accepted crash window, one step wider.
   */
  async function writeDispatcherMark(
    sessionId: string,
    parentSessionId?: string,
    generation?: number,
  ): Promise<void> {
    // Ticket 138: the local mirror is updated FIRST and synchronously, so a
    // send arriving before the store write settles already sees the mark. The
    // parent rides the row because a send-triggered cold resume needs the
    // exact live parent Agent as the host's sender.
    dispatcherMarks.set(sessionId, parentSessionId);
    // Ticket 141: the generation is mirrored the same way, so a re-announced
    // child resolves its number even before the store round-trips.
    if (generation !== undefined) {
      dispatcherGenerations.set(sessionId, generation);
    }
    const store = markers;
    if (store === undefined || store.writeDispatcherMark === undefined) return;
    try {
      await store.writeDispatcherMark({
        sessionId,
        ...(parentSessionId !== undefined ? { parentSessionId } : {}),
        ...(generation !== undefined ? { generation } : {}),
      });
    } catch (error) {
      try {
        console.warn(
          `[multitask-dispatcher] dispatcher mark for ${sessionId} could not be written:`,
          error,
        );
      } catch {
        // A broken console must not break the spawn either.
      }
    }
  }

  /**
   * Ticket 130: re-activate a child that carries a DURABLE dispatcher mark.
   *
   * A spawned dispatcher's only other identity is this process's in-memory
   * registry, which dies with the process. The mark was written at spawn, so
   * a cold-resumed child (or one the host re-announces) is recognised here and
   * routed into the SAME activation path the spawn hook uses: role, scoped
   * tool surface, and policy injection all come back.
   *
   * The store read may be asynchronous while this listener must return
   * synchronously, so the activation lands as soon as the read resolves —
   * the same residual limit the no-announcement fallback already documents.
   * Idempotency is the activation helper's: `dispatcherActivated` is checked
   * synchronously, so a second resume never double-registers tools or
   * double-injects policy.
   *
   * Residual limit, stated: if the SAME parent has a worker spawn in flight
   * when a marked child is announced, the worker composition can land in the
   * one-microtask window before the mark is read. The mark still re-activates
   * the child, so its dispatcher role comes back (with the worker persona and
   * reply tool alongside). At boot no spawn is in flight, so a cold resume
   * does not hit this window.
   *
   * Nothing here deletes the mark (deactivation also runs on plugin unload,
   * so a delete would wipe it at every restart) and nothing recomputes the
   * child's `delegationDepth` — the resumed session keeps its persisted one.
   */
  function resumeMarkedDispatcher(
    childAgent: AgentLike,
    sessionId: string,
  ): void {
    const store = markers;
    if (store === undefined || store.readDispatcherMark === undefined) return;
    if (dispatcherActivated.has(sessionId)) return;
    void Promise.resolve()
      .then(() => store.readDispatcherMark?.(sessionId))
      .then((mark) => {
        if (mark === undefined) return;
        // Ticket 141: the resumed child keeps the number it was spawned with.
        // A pre-141 row has no field — every such row came from a spawn, so
        // its honest reading is generation 2 (a direct child of a
        // user-started dispatcher).
        const generation = mark.generation ?? 2;
        dispatcherGenerations.set(sessionId, generation);
        activateSpawnedDispatcher(childAgent, sessionId, generation);
      })
      .catch((error) => {
        // A marker-store failure must not break the host's create path; the
        // child simply stays an ordinary subagent, exactly as before 130.
        try {
          console.warn(
            `[multitask-dispatcher] dispatcher mark for ${sessionId} could not be read:`,
            error,
          );
        } catch {
          // A broken console must not break the create path either.
        }
      });
  }

  /**
   * Ticket 142: re-adopt a worker the host brought back from the dormant
   * state, and hand it the correction a send parked.
   *
   * Identity is the durable `worker_sessions` row, never a guess. The mirror
   * is consulted first because a send could only have been accepted (and a
   * resume only issued) when the row was already mirrored; the store read is
   * the fallback for a session the host resumes on its own, before this
   * process warmed anything.
   *
   * WHAT this restores matters for safety: a cold-resumed child starts with
   * its INHERITED composition — the parent dispatcher's — so without the
   * worker composition (contract section, tool barrier, local reply tool) it
   * would come back able to call the dispatcher's own tools. The registry
   * entry is what makes `interruptWorker`/`sendMessage`/settle resolve again.
   *
   * `workers.has` is the idempotency gate: a normal in-process spawn reserved
   * its id BEFORE `startActivation`, so it is already registered and this
   * branch is skipped (the existing composition path handles it).
   */
  function reattachMarkedWorker(childAgent: AgentLike, workerId: string): boolean {
    // Fast path: an in-process spawn reserved this id before `startActivation`
    // (ticket 120), so it is already registered and the caller's normal
    // composition path handles it — return false so the listener falls
    // through. Only a wake parked for a live worker still needs discharging
    // here (a second send before the resume landed).
    if (workers.has(workerId)) {
      deliverParkedWorkerWake(workerId);
      return false;
    }
    const adopt = (parentSessionId: string): boolean => {
      if (workers.has(workerId)) {
        // Lost a race with a spawn that registered in the meantime — the
        // parked correction still has to reach it exactly once, and the
        // caller's normal path still applies.
        deliverParkedWorkerWake(workerId);
        return false;
      }
      workers.set(workerId, { parentSessionId, agentSessionId: workerId });
      if (
        workerAgentDef !== undefined &&
        typeof childAgent.ctx === "object" &&
        childAgent.ctx !== null
      ) {
        try {
          applyWorkerComposition(
            childAgent.ctx as Parameters<typeof applyWorkerComposition>[0],
            workerAgentDef,
            childAgent,
            buildWorkerLocalTools(workerId),
          );
        } catch (error) {
          // A resumed child inherits the parent dispatcher's composition, so a
          // failed barrier would leave it with tools a worker must not have.
          // Nothing can roll that back here (the child is already live), so it
          // is logged loudly rather than hidden — the same failure policy the
          // dispatcher activation path uses.
          try {
            console.warn(
              `[multitask-dispatcher] resumed worker ${workerId} could not be composed; it keeps its inherited surface:`,
              error,
            );
          } catch {
            // A broken console must not break the create path either.
          }
        }
      }
      // Core side: resolve the unknown-state hold into a live roster record,
      // so the worker is visible and stoppable again.
      onWorkerReattached?.(workerId, parentSessionId);
      deliverParkedWorkerWake(workerId);
      return true;
    };
    const mirrored = workerSessions.get(workerId);
    if (mirrored !== undefined) {
      return adopt(mirrored);
    }
    const store = markers;
    if (store === undefined || store.readWorkerSession === undefined) {
      return false;
    }
    void Promise.resolve()
      .then(() => store.readWorkerSession?.(workerId))
      .then((row) => {
        if (row === undefined) return;
        workerSessions.set(row.sessionId, row.parentSessionId);
        adopt(row.parentSessionId);
      })
      .catch((error) => {
        // A marker-store failure must not break the host's create path.
        try {
          console.warn(
            `[multitask-dispatcher] worker session row for ${workerId} could not be read:`,
            error,
          );
        } catch {
          // A broken console must not break the create path either.
        }
      });
    return false;
  }

  /**
   * Worker composition for a child we are about to publish, plus (ticket
   * 118) dispatcher activation for a child WE reserved.
   *
   * `agent/created` is the last moment a child's own scope can take
   * registrations before its first turn: the loop holds queued input until
   * every serial listener returns. Registering here — rather than through a
   * named Agent Preset — keeps the composition identical on every boot route
   * and needs no preset registry.
   *
   * Dispatcher child vs worker child is decided by IDENTITY (the reserved
   * `childId`), never by the per-parent `pendingSpawns` counter: the counter
   * cannot tell two concurrently spawned children of one parent apart, so a
   * dispatcher spawn racing a worker spawn used to be composable as a worker
   * (chunk 1's recorded limit). With the reservation, the dispatcher child is
   * matched by id and returns before the counter is even read.
   *
   * Ticket 130: BEFORE the reservation is consulted, the child's durable
   * dispatcher mark is read. A child that was spawned as a dispatcher in an
   * earlier process carries no reservation and no activation record here, and
   * without this check it would fall through to the worker path (or to
   * nothing) and degrade to a plain subagent.
   */
  const offAgentCreated = ctx.on("agent/created", (payload: never) => {
    const record = payload as {
      agent?: {
        session?: { header?: { parentSession?: unknown }; id?: unknown };
        ctx?: unknown;
      };
    };
    const child = record.agent;
    if (child === undefined) return;
    const parentSessionId = String(child.session?.header?.parentSession ?? "");
    if (parentSessionId === "") return;
    const childSessionId = String(child.session?.id ?? "");
    // Ticket 130: durable identity first — a resumed dispatcher is matched by
    // its mark, not by anything this process remembers.
    if (childSessionId !== "") {
      resumeMarkedDispatcher(child as AgentLike, childSessionId);
    }
    if (
      childSessionId !== "" &&
      (reservedDispatcherIds.has(childSessionId) ||
        dispatcherActivated.has(childSessionId))
    ) {
      // Ticket 118: the child of our `spawnDispatcher` call — a dispatcher
      // peer, never a worker. No composition, no barrier, no registry entry.
      activateSpawnedDispatcher(child as AgentLike, childSessionId);
      return;
    }
    // Ticket 142: a WORKER this plugin spawned. A live in-process spawn is
    // already registered (its id was reserved before `startActivation`), so
    // this only does real work for a session the host re-created after a
    // restart — the wake-on-send case. It must run BEFORE the
    // `pendingSpawns` guard: a resumed worker has no in-flight spawn, and the
    // guard would drop it. The mirror consult is synchronous, so a worker
    // THIS process knows about is adopted (and the listener returns) before
    // the guard; a store fallback runs asynchronously and the guard below
    // simply sees no pending spawn, which is also correct.
    if (childSessionId !== "") {
      const adopted = reattachMarkedWorker(child as AgentLike, childSessionId);
      // Only a session THIS branch adopted returns here — it composed the
      // child itself. A normal in-process spawn is already registered (its id
      // was reserved) and must fall through to the pendingSpawns path below,
      // which is what composes it.
      if (adopted) return;
    }
    if (workerAgentDef === undefined) return;
    if ((pendingSpawns.get(parentSessionId) ?? 0) === 0) return;
    if (typeof child.ctx !== "object" || child.ctx === null) return;
    applyWorkerComposition(
      child.ctx as Parameters<typeof applyWorkerComposition>[0],
      workerAgentDef,
      child,
      // The mid-task reply channel (ticket 122). Registered on the child's own
      // scope, so the dispatcher's surface never lists it.
      buildWorkerLocalTools(child.session?.id),
    );
  });

  const host: CordisDshHost = {
    bindParent(agent: AgentLike, sessionId: string): void {
      parents.set(sessionId, agent);
    },

    unbindParent(sessionId?: string): void {
      if (sessionId === undefined) {
        parents.clear();
        return;
      }
      parents.delete(sessionId);
    },

    hasParent(): boolean {
      return parents.size > 0;
    },

    parentAgentOf(sessionId: string): AgentLike | undefined {
      return parents.get(sessionId);
    },

    get markers(): DurabilityPort | undefined {
      return markers;
    },

    isDurablyMarkedDispatcher(sessionId: string): boolean {
      return dispatcherMarks.has(sessionId);
    },

    async refreshDispatcherMarks(): Promise<void> {
      const store = markers;
      if (store === undefined || store.listDispatcherMarks === undefined) {
        return;
      }
      try {
        const marks = await store.listDispatcherMarks();
        for (const mark of marks) {
          // A row written in this process may be richer than the store's
          // copy; never downgrade a known parent to `undefined`.
          if (!dispatcherMarks.has(mark.sessionId)) {
            dispatcherMarks.set(mark.sessionId, mark.parentSessionId);
          }
          // Ticket 141: same rule for the generation — an in-process value
          // (from the reserved-id seed or a spawn) is authoritative, so the
          // store only fills the gap. A pre-141 row reads as generation 2.
          if (!dispatcherGenerations.has(mark.sessionId)) {
            dispatcherGenerations.set(mark.sessionId, mark.generation ?? 2);
          }
        }
      } catch (error) {
        // A marker-store failure must never turn an activation or a send into
        // a refusal; the mirror simply stays as it was.
        try {
          console.warn(
            "[multitask-dispatcher] dispatcher marks could not be read:",
            error,
          );
        } catch {
          // A broken console must not break the host either.
        }
      }
    },

    workerSessionMark(
      workerId: string,
    ): { readonly parentSessionId: string } | undefined {
      const parentSessionId = workerSessions.get(workerId);
      return parentSessionId === undefined ? undefined : { parentSessionId };
    },

    async refreshWorkerSessionMarks(): Promise<void> {
      const store = markers;
      if (store === undefined || store.listWorkerSessions === undefined) {
        return;
      }
      try {
        const rows = await store.listWorkerSessions();
        for (const row of rows) {
          // Same discipline as the dispatcher mirror: an in-process write is
          // authoritative, so a store row never overrides it. A row ABSENT
          // from the store but present here is kept — the settle path that
          // deletes rows also drops the mirror entry, so a mirror-only entry
          // means a write whose delete has not been issued yet.
          if (!workerSessions.has(row.sessionId)) {
            workerSessions.set(row.sessionId, row.parentSessionId);
          }
        }
      } catch (error) {
        try {
          console.warn(
            "[multitask-dispatcher] worker session rows could not be read:",
            error,
          );
        } catch {
          // A broken console must not break the host either.
        }
      }
    },

    rememberWorkerWake(workerId: string, parentSessionId: string): void {
      workerSessions.set(workerId, parentSessionId);
    },

    forgetWorkerWake(workerId: string): void {
      workerSessions.delete(workerId);
      // A worker that is terminal or abandoned gets nothing delivered: the
      // parked slot is a delivery obligation to a session that no longer
      // exists.
      parkedWorkerWakes.delete(workerId);
      resumeRequested.delete(workerId);
    },

    async wakeDormantWorker(workerId: string, message: string): Promise<void> {
      requestDormantWorkerWake(workerId, message);
    },

    listLiveJobs(callerSessionId?: string): readonly JobSnapshotLike[] {
      try {
        return ctx.jobs.list(callerSessionId) ?? [];
      } catch {
        return [];
      }
    },

    workerIdOf(agentSessionId: string): string | undefined {
      return ownsSession(agentSessionId);
    },

    owns(workerId: string): boolean {
      return workers.has(workerId);
    },

    recentActivity(workerId: string): string | null {
      // Ticket 29: a settled worker has no live activity — null, never the
      // stale last phrase (the ring keeps it only for the wake digest).
      if (settledWorkerIds.has(workerId)) return null;
      return activityRing.latest(workerId)?.phrase ?? null;
    },

    /**
     * Ticket 61: host-clock ms of the last firehose-observed activity for an
     * owned worker — the observation moment of `recentActivity`'s phrase,
     * recorded at the same event arrival. Null when nothing has been
     * observed or the worker settled. Same subscription as
     * `recentActivity` — no new seam, no polling.
     */
    lastActivityAtMs(workerId: string): number | null {
      // Same settle gate as `recentActivity` — null once settled.
      if (settledWorkerIds.has(workerId)) return null;
      return activityRing.latest(workerId)?.atMs ?? null;
    },

    /**
     * Ticket 110: the bounded per-worker activity ring, newest-first — up
     * to `n` of the last firehose-observed phrases with their observation
     * moments, from the same `session/event` subscription as
     * `recentActivity` (no new seam, no polling, nothing persisted).
     * Retained through settle so the wake digest can show the final
     * breadcrumb (the single-entry accessors go null at settle); empty
     * once nothing has been observed; `n <= 0` yields an empty array.
     */
    recentActivities(
      workerId: string,
      n: number,
    ): readonly WorkerActivityEntry[] {
      return activityRing.recent(workerId, n);
    },

    /**
     * Ticket 75: subscribers hear every firehose-observed tool call on an
     * owned worker — the same observation moment the activity phrase is
     * recorded at. Fired from the ticket-29 `session/event` subscription.
     */
    onWorkerToolCall(cb: (workerId: string) => void): void {
      toolCallCallbacks.push(cb);
    },

    onDispatcherUserMessage(cb: (sessionId: string) => void): void {
      userMessageCallbacks.push(cb);
    },

    recentResult(workerId: string): RosterRecentResultSource | null {
      return workerResults.get(workerId) ?? null;
    },

    emitStepBoundary(workerId: string): void {
      for (const cb of [...stepBoundaryCallbacks]) {
        void cb(workerId);
      }
    },

    emitAccessRequest(event: AccessRequestEvent): void {
      for (const cb of [...accessRequestCallbacks]) {
        cb(event);
      }
    },

    onAccessRequest(cb: (event: AccessRequestEvent) => void): void {
      accessRequestCallbacks.push(cb);
    },

    // Ticket 102b hardening: the adapter no longer implements the optional
    // `resolveCredential` seam. Its read was `(ctx as { credentials? }).credentials`
    // — a Cordis service declared in NEITHER `plugin.ts`'s `inject` nor
    // `AdapterContext`, behind a cast that hid it from the type system. The
    // resolver matches inject entries by EXACT STRING and throws at property
    // ACCESS, so this was a latent fuse: no caller existed, but the first
    // ticket to wire one would throw on an undeclared service while every
    // offline test stayed green. Deleted rather than declared, because
    // declaring `credentials` in `inject` would gate the whole plugin's apply
    // on a service it never uses, and ADR-0008 routes credentials through
    // `SpawnOptions.credentialNames` (resolved inside adapter/tools), not this
    // seam. The optional `DshHost` member stays for contract compatibility
    // (see `src/core/dsh-host.ts`); like `FakeDshHost`, the live adapter simply
    // does not provide it.

    async spawnWorker(prompt: string, opts: SpawnOptions): Promise<string> {
      // ADR-0019: the authority agent is the worker's OWN dispatcher session.
      const parent = parents.get(opts.parentSessionId);
      if (parent === undefined) {
        throw new Error(
          `CordisDshHost: no parent agent bound for session ${opts.parentSessionId}; cannot spawn before that dispatcher activation`,
        );
      }
      const controller = new AbortController();
      // Blank context is free with the in-process spawn provider.
      //
      // Ticket 55 (register D-1/D-2) — two channels, deliberately:
      //   - the worker CONTRACT and tool barrier are registered on the
      //     child's own scope at `agent/created` (see `offAgentCreated`). The
      //     contract lands in a system-prompt section recomputed every turn,
      //     so it cannot be compacted away and needs no per-steer restatement.
      //   - the TASK stays in `prompt`, i.e. the child's first user turn. That
      //     is what "blank conversation" means, and it matches the reference:
      //     blank conversation, not blank system prompt.
      // Ticket 83 (live pass 2026-09-19): `request.maxDepth` is the child's
      // ABSOLUTE delegation-depth ceiling, NOT the worker's leaf budget. The
      // host's `resolveChildDepth` computes `childDepth =
      // delegationDepthOf(parent) + 1` and throws `SubagentDepthError` when
      // `childDepth > maxDepth`, so shipping the leaf budget 0 in this slot
      // refused every live spawn ("subagent depth 1 exceeds maxDepth 0").
      // Derive the ceiling from the parent's real depth + one hop + the
      // worker's own budget. The `?? 0` fallback assumes the bound dispatcher
      // is top-level, which holds today because activation is isTopLevel-gated
      // (parent-agent.ts; the gate also fails open on an unreadable header);
      // multi-level nesting is deferred by ADR-0003 and would need a revisit
      // if a deeper parent is ever bound here.
      const parentDelegationDepth = parent.session.header?.delegationDepth ?? 0;
      const maxDepth = workerSpawnMaxDepth(
        parentDelegationDepth,
        workerAgentDef?.maxDepth ?? WORKER_MAX_DEPTH,
      );
      const request: ActivationSpecLike["request"] = {
        prompt: textBlocks(prompt),
        parent,
        // Child's absolute ceiling: parent depth + 1 hop + leaf budget.
        maxDepth,
      };
      // Ticket 120: RESERVE the child id before the spawn, exactly as
      // `spawnDispatcher` does (ticket 118) and for the same reason — the
      // child is already live inside `startActivation`.
      //
      // The host mints the id when the spec carries none, so a worker spawn
      // used to learn its own id only when `startActivation` RESOLVED. By
      // then the child had already emitted `agent/created` and its first
      // `agent/status: running`, and the plugin's status handler called
      // `workerIdOf(...)` on an id this host had not registered yet: it got
      // `undefined` and dropped the event. There is one `running` edge per
      // turn, so `multitask.noteTurnStarted` never ran and the worker FSM sat
      // at `spawned` for the whole first turn — `steer_worker`/`message_agent`
      // refused `not-running` and `check_workers` under-reported.
      //
      // Reserving the id fixes that at the right layer: this registry answers
      // `workerIdOf` and becomes TRUE (the child exists, under this exact
      // id) before the child can emit anything. Passed as `spec.childId`, so
      // the host either creates the child under this id or refuses the
      // spawn — no other id can ever come back.
      const reservedChildId = randomUUID();
      // Registered here, not after the await: `owns`/`workerIdOf` are what
      // the status and settle listeners consult, and the child is live the
      // moment `startActivation` is entered.
      workers.set(reservedChildId, {
        parentSessionId: opts.parentSessionId,
        agentSessionId: reservedChildId,
      });
      // Mark the in-flight spawn BEFORE it starts: `agent/created` fires
      // inside `startActivation`, and that listener is what composes the child.
      pendingSpawns.set(
        opts.parentSessionId,
        (pendingSpawns.get(opts.parentSessionId) ?? 0) + 1,
      );
      let activation: ActivationLike;
      try {
        // The core registers its own record through this callback BEFORE the
        // child can emit its first status edge (ticket 120). Both registries
        // must be truthful at the same moment.
        opts.onWorkerId?.(reservedChildId);
        activation = await ctx.subagents.startActivation({
          provider: SPAWN_PROVIDER,
          label: opts.title,
          childId: reservedChildId,
          request,
          signal: controller.signal,
          delivery: "parent",
        });
      } catch (error) {
        // The spawn was refused or aborted before publication: no child
        // exists, so neither registry may keep the reservation.
        workers.delete(reservedChildId);
        throw error;
      } finally {
        const remaining = (pendingSpawns.get(opts.parentSessionId) ?? 1) - 1;
        if (remaining <= 0) pendingSpawns.delete(opts.parentSessionId);
        else pendingSpawns.set(opts.parentSessionId, remaining);
      }
      // workerId === child SessionId. Brand erased at the boundary.
      const workerId = String(activation.childId);
      if (workerId !== reservedChildId) {
        // The host minted its own id despite the reservation. Keep the
        // registry truthful: move the entry, never leave the reservation
        // behind as a phantom worker.
        workers.delete(reservedChildId);
        workers.set(workerId, {
          parentSessionId: opts.parentSessionId,
          agentSessionId: workerId,
        });
      }
      spawnControllers.set(workerId, controller);
      workerActivations.set(workerId, activation);
      return workerId;
    },

    /**
     * Ticket 118 (ADR-0025 mitosis): spawn another DISPATCHER from a bound
     * dispatcher session, then hand the child to the activation path. Across
     * the two chunks this is the whole "mitosis" seam: chunk 1 built the
     * spawn, chunk 3 (this one) adds the reservation that identifies the
     * child and the single `onDispatcherSpawned` call that turns it into a
     * real dispatcher (bind, scoped tools, policy, lifecycle, rebuild).
     *
     * Three deliberate differences from `spawnWorker`:
     * - the child id is RESERVED here and passed as `spec.childId`, not left
     *   to the host. That is what closes chunk 1's recorded race:
     *   `pendingSpawns` is keyed per parent and cannot tell two children of
     *   one parent apart, so while a worker spawn from the same parent was in
     *   flight the `agent/created` listener could compose the dispatcher
     *   child as a worker. With a reserved id the listener matches by
     *   IDENTITY — a dispatcher child returns before the counter is read, and
     *   a worker child can never match a reserved id. The host refuses a
     *   reserved id that is already live or persisted (`DUPLICATE_CHILD`),
     *   exactly as for its own minted id.
     * - NO `pendingSpawns` bump and NO `workers` registry entry: the child is
     *   a peer, not a work stream, so the firehose/settle subscriptions
     *   ignore it.
     * - NO `agentPreset` in the spec: the child joins the parent's
     *   composition, which is exactly what "full tool set" means here.
     *
     * Depth: `dispatcherSpawnMaxDepth` gives the child an ABSOLUTE ceiling of
     * parent depth + 2 — one hop for the child dispatcher, one for the
     * workers it will spawn. Sending +1 would admit the child and then refuse
     * every one of its workers.
     *
     * Activation hook: `onDispatcherSpawned` runs from the `agent/created`
     * listener — the last moment the child's own scope can take
     * registrations before its first turn. When the host announces nothing
     * (a stub), the post-resolve fallback below makes the same single call
     * from `ctx.agents.get(childId)`; a child absent from that registry is
     * left live but inactive, which is the honest degraded shape because no
     * Agent object exists to bind.
     *
     * Host errors propagate unchanged: `ACTIVATION_LIMIT_REACHED` arrives as
     * a rejection of `startActivation` (the 8-active root pool) and
     * `SubagentDepthError` as the host's own throw. No wrapper, no invented
     * refusal class, no cap of ours (ADR-0025 §Starting bounds).
     */
    async spawnDispatcher(
      opts: DispatcherSpawnOptions,
    ): Promise<DispatcherSpawnResult> {
      // ADR-0019: the authority agent is the SPAWNING dispatcher's own
      // session, resolved exactly as `spawnWorker` does.
      const parent = parents.get(opts.parentSessionId);
      if (parent === undefined) {
        throw new Error(
          `CordisDshHost: no parent agent bound for session ${opts.parentSessionId}; cannot spawn a dispatcher before that dispatcher activation`,
        );
      }
      const controller = new AbortController();
      const signal = opts.signal ?? controller.signal;
      // A child dispatcher of a depth-N parent lands at N+1. Its own workers
      // land at N+2, so the ceiling admitted here must reach N+2. The `?? 0`
      // fallback mirrors `spawnWorker`: a bound parent is assumed top-level
      // only when its header carries no depth.
      const parentDelegationDepth = parent.session.header?.delegationDepth ?? 0;
      const maxDepth = dispatcherSpawnMaxDepth(parentDelegationDepth);
      // Ticket 118 chunk 3: reserve the child id BEFORE the spawn. The
      // `agent/created` listener fires inside `startActivation` — awaited
      // before it resolves on the installed host — so identity is the only
      // correlation available while the spawn is in flight.
      const reservedChildId = randomUUID();
      reservedDispatcherIds.add(reservedChildId);
      // Ticket 141: the child is one generation past its spawner. A
      // user-started dispatcher is generation 1 (the option is absent for
      // every pre-141 caller), so a direct spawn is generation 2.
      const spawnerGeneration =
        dispatcherGenerationOf?.(opts.parentSessionId) ?? 1;
      const childGeneration = spawnerGeneration + 1;
      // Seed it BEFORE `startActivation`: `agent/created` fires inside that
      // call, and the mark row — the other source of this number — is only
      // written after it resolves. Without the seed the first activation
      // would read no generation at all.
      dispatcherGenerations.set(reservedChildId, childGeneration);
      /** The id the host actually gave the child, or null if it refused. */
      let spawnedId: string | null = null;
      try {
        const activation = await ctx.subagents.startActivation({
          provider: SPAWN_PROVIDER,
          label: opts.title,
          childId: reservedChildId,
          // No `agentPreset` field exists on the spec — omitting it is
          // automatic and is the mitosis requirement.
          request: {
            prompt: textBlocks(opts.prompt),
            parent,
            // Child's absolute ceiling: parent depth + 1 hop + its own worker hop.
            maxDepth,
          },
          signal,
          delivery: "parent",
        });
        // The child session id IS the dispatcher identity the activation path
        // binds. Brand erased at the boundary; normally it equals the
        // reservation, and a host that minted its own id is still handled.
        const dispatcherId = String(activation.childId);
        // Ticket 141: mirror the number under the id the host actually gave
        // the child, so a host that minted its own id still activates with
        // the right generation.
        dispatcherGenerations.set(dispatcherId, childGeneration);
        spawnedId = dispatcherId;
        // Fallback for a host that announced no `agent/created` (or announced
        // it under a different id). Deduplicated inside the helper, so a host
        // that DID announce the child is not activated twice. It runs BEFORE
        // the mark write so a slow store never delays a child's activation.
        const childAgent = ctx.agents.get(dispatcherId);
        if (childAgent !== undefined) {
          activateSpawnedDispatcher(childAgent, dispatcherId, childGeneration);
        }
        // Ticket 130: the child is durable from here on. Written AFTER the
        // spawn resolved — there is no session id to key on before that — and
        // never deleted: deactivation also runs on plugin unload, so a delete
        // would wipe every mark at each restart. The table grows; accepted. A
        // crash between the spawn and this write simply loses the mark (the
        // accepted window). A marker-store failure is logged and swallowed —
        // the host already accepted the spawn, so it must never read as a
        // host refusal. Ticket 141: the row carries the generation, so a
        // cold-resumed child comes back with the same number.
        await writeDispatcherMark(
          dispatcherId,
          opts.parentSessionId,
          childGeneration,
        );
        // Bounded memory: the reservation is dropped in `finally`, and the
        // activation record stays so a LATE `agent/created` for this child is
        // still recognised as a dispatcher instead of falling through to the
        // worker composition.
        return { dispatcherId };
      } finally {
        reservedDispatcherIds.delete(reservedChildId);
        // A refused spawn leaves no generation behind. (The reservation itself
        // is normally the child id; a host that minted its own id gets its
        // seed moved under that id above.)
        if (spawnedId === null) {
          dispatcherGenerations.delete(reservedChildId);
        }
      }
    },

    async interruptWorker(workerId: string): Promise<void> {
      // ADR-0019: interrupt authority resolves from the worker's recorded
      // parent — one dispatcher's unbinding never strands another's worker.
      const entry = workers.get(workerId);
      const parent =
        entry !== undefined ? parents.get(entry.parentSessionId) : undefined;
      if (parent === undefined) return;
      // Fire-and-return: cancel signal issued before return.
      ctx.subagents.interrupt(workerId, {
        kind: "ancestor",
        agent: parent,
      });
    },

    async sendMessage(workerId: string, message: string): Promise<void> {
      // ADR-0019: delivery authority resolves from the worker's recorded
      // parent — the answer reaches the worker through ITS dispatcher.
      const entry = workers.get(workerId);
      const parent =
        entry !== undefined ? parents.get(entry.parentSessionId) : undefined;
      if (parent === undefined) {
        throw new Error("CordisDshHost: no parent agent bound; cannot send");
      }
      const controller = new AbortController();
      await ctx.subagents.sendMessage(parent, workerId, textBlocks(message), {
        signal: controller.signal,
      });
    },

    onWorkerSettled(cb: (event: SettledEvent) => void): void {
      settledCallbacks.push(cb);
    },

    onStepBoundary(cb: (workerId: string) => void | Promise<void>): void {
      stepBoundaryCallbacks.push(cb);
    },

    /**
     * Ticket 116 / ADR-0025: `origin` is the optional structured source
     * override for a wake caused by another agent. Turn mechanics are
     * identical (`followup` + composed text); only the follow-up message's
     * `source` changes, from our producer-owned plugin kind to
     * `{kind:"agent-message", form:"relay", senderSessionId}`. The text
     * heading stays presentation only — nothing here derives origin from
     * it.
     */
    async requestDispatcherWakeup(
      sessionId: string,
      origin?: AgentMessageWakeOrigin,
    ): Promise<void> {
      openWakeTurn(sessionId, origin);
    },

    /**
     * Soft fallback (ticket 14): the local install has no public mid-turn
     * cancel for a dispatcher Agent. Priority already became the ready
     * wake on the bus; the running non-user turn ends and the next flush
     * delivers it. Recorded as a no-op so the seam stays honest.
     */
    async requestDispatcherInterrupt(_sessionId: string): Promise<void> {
      return;
    },

    dispose(): void {
      offSubagentEnd();
      offSessionEvent();
      offAgentCreated();
      pendingSpawns.clear();
      reservedDispatcherIds.clear();
      dispatcherActivated.clear();
      dispatcherMarks.clear();
      dispatcherGenerations.clear();
      resumeRequested.clear();
      pendingWakeTurns.clear();
      workerSessions.clear();
      parkedWorkerWakes.clear();
      // Abort covers spawns still pre-publication; a published worker ignores
      // its start signal, so it is released through its activation instead.
      for (const controller of spawnControllers.values()) {
        controller.abort();
      }
      spawnControllers.clear();
      const activations = [...workerActivations.values()];
      workerActivations.clear();
      void Promise.allSettled(activations.map((a) => a.dispose()));
      workers.clear();
      activityRing.clearAll();
      settledWorkerIds.clear();
      workerResults.clear();
      settledCallbacks.length = 0;
      stepBoundaryCallbacks.length = 0;
      accessRequestCallbacks.length = 0;
      toolCallCallbacks.length = 0;
      userMessageCallbacks.length = 0;
      parents.clear();
    },
  };

  return host;
}
