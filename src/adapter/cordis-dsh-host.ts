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
import { wakeUserMessage } from "./wake-copy.js";

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
   * The adapter passes the exact live child Agent and its session id. It
   * never inspects the outcome — activation failure must not turn a
   * successful spawn into a host error.
   */
  onDispatcherSpawned?: (agent: AgentLike, sessionId: string) => void;
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
  ): void {
    const agent = ctx.agents.get(sessionId);
    if (agent === undefined) {
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

  function ownsSession(agentSessionId: string): string | undefined {
    return workers.has(agentSessionId) ? agentSessionId : undefined;
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
   */
  function activateSpawnedDispatcher(
    childAgent: AgentLike,
    sessionId: string,
  ): void {
    if (onDispatcherSpawned === undefined) return;
    if (dispatcherActivated.has(sessionId)) return;
    dispatcherActivated.add(sessionId);
    try {
      onDispatcherSpawned(childAgent, sessionId);
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
  async function writeDispatcherMark(sessionId: string): Promise<void> {
    const store = markers;
    if (store === undefined || store.writeDispatcherMark === undefined) return;
    try {
      await store.writeDispatcherMark({ sessionId });
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
        activateSpawnedDispatcher(childAgent, sessionId);
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
        // Fallback for a host that announced no `agent/created` (or announced
        // it under a different id). Deduplicated inside the helper, so a host
        // that DID announce the child is not activated twice. It runs BEFORE
        // the mark write so a slow store never delays a child's activation.
        const childAgent = ctx.agents.get(dispatcherId);
        if (childAgent !== undefined) {
          activateSpawnedDispatcher(childAgent, dispatcherId);
        }
        // Ticket 130: the child is durable from here on. Written AFTER the
        // spawn resolved — there is no session id to key on before that — and
        // never deleted: deactivation also runs on plugin unload, so a delete
        // would wipe every mark at each restart. The table grows; accepted. A
        // crash between the spawn and this write simply loses the mark (the
        // accepted window). A marker-store failure is logged and swallowed —
        // the host already accepted the spawn, so it must never read as a
        // host refusal.
        await writeDispatcherMark(dispatcherId);
        // Bounded memory: the reservation is dropped in `finally`, and the
        // activation record stays so a LATE `agent/created` for this child is
        // still recognised as a dispatcher instead of falling through to the
        // worker composition.
        return { dispatcherId };
      } finally {
        reservedDispatcherIds.delete(reservedChildId);
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
