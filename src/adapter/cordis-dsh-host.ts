import type { DshHost } from "../core/dsh-host.js";
import type { DurabilityPort } from "../core/durability.js";
import type { AccessRequestEvent } from "../core/access-types.js";
import { clampActivity, clampRecentResultExcerpt } from "../core/report-clamp.js";
import type { UserQuestionsLike } from "./access-prompt.js";
import type { SettledEvent, SpawnOptions, TerminalWorkerStatus } from "../core/types.js";
import type { RosterRecentResultSource } from "../core/roster-snapshot.js";
import {
  normalizeWorkerErrorReport,
  normalizeWorkerReport as normalizeWorkerTextReport,
} from "../worker/report.js";
import type { WorkerAgentDef } from "../worker/agent-def.js";
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
}

export interface ContinuableStartLike {
  readonly childId: unknown;
  readonly messageId?: unknown;
}

export interface ContinuableStartSpecLike {
  readonly provider: string;
  readonly label: string;
  readonly request: {
    readonly prompt: ContentBlock[];
    readonly parent: AgentLike;
    readonly signal: AbortSignal;
    readonly maxDepth?: number;
    readonly toolFilter?: unknown;
    /**
     * Ticket 55 (register D-1): the child's worker contract, rendered by the
     * host into the `deployment:persona-prefix` **system-prompt section** —
     * recomputed every turn, so it survives compaction and is restated after
     * every steer. Do not put contract text in `prompt` instead; that channel
     * is the child's first user turn.
     */
    readonly persona?: string;
  };
  readonly signal: AbortSignal;
}

export interface JobSnapshotLike {
  readonly id: unknown;
  readonly kind: string;
  readonly label: string;
  readonly status: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly ownerSession?: unknown;
  readonly detail?: string;
  readonly reported?: boolean;
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
  subagents: {
    startContinuable(spec: ContinuableStartSpecLike): Promise<ContinuableStartLike>;
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
    list(caller?: unknown): readonly JobSnapshotLike[];
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
}

/**
 * Live `DshHost` over Cordis dsh services.
 * Core stays pure; this is the only place that knows subagents/agents/jobs.
 */
export interface CordisDshHost extends DshHost {
  /** Bind the exact live dispatcher Agent (explicit activation, ticket 19). */
  bindParent(agent: AgentLike, sessionId: string): void;
  /** Clear the parent Agent (dispose / replace). */
  unbindParent(): void;
  /** Whether a parent Agent is currently bound. */
  hasParent(): boolean;
  /** Live parent Agent, if bound. */
  readonly parentAgent: AgentLike | null;
  /** Live job snapshots for the check surface. Process-local; not durable. */
  listLiveJobs(): readonly JobSnapshotLike[];
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

export function createCordisDshHost(
  ctx: AdapterContext,
  options?: CordisDshHostOptions,
): CordisDshHost {
  const workerAgentDef = options?.workerAgentDef;
  const markers = options?.markers;
  const composeWakeText = options?.composeWakeText;

  let parent: AgentLike | null = null;
  let parentSessionId: string | null = null;
  const workers = new Map<string, WorkerEntry>();
  const spawnControllers = new Map<string, AbortController>();
  const settledCallbacks: Array<(event: SettledEvent) => void> = [];
  const stepBoundaryCallbacks: Array<(workerId: string) => void | Promise<void>> = [];
  const accessRequestCallbacks: Array<(event: AccessRequestEvent) => void> = [];
  // Ticket 29: latest activity phrase per owned worker, projected from the
  // host `session/event` firehose. Pure subscription — no polling, no timers.
  // Ticket 61: the entry also carries its observation moment (host clock at
  // event arrival) so the liveness verdict is derivable over existing truth
  // — no new subscription, no new seam, no background machinery.
  const workerActivity = new Map<string, { phrase: string; atMs: number }>();
  // Ticket 41: latest bounded settle-report excerpt per settled worker,
  // clamped once at observation. Same subscription discipline as
  // `workerActivity`: adapter-side projection of host-observed truth —
  // the core stores no report text and no second transcript exists.
  const workerResults = new Map<string, RosterRecentResultSource>();
  let wakeMissingLogged = false;

  function ownsSession(agentSessionId: string): string | undefined {
    return workers.has(agentSessionId) ? agentSessionId : undefined;
  }

  const offSubagentEnd = ctx.on("subagent/end", (info: never) => {
    const end = info as {
      id: unknown;
      stopReason: string;
      lastAssistantMessage?: ContentBlock[];
    };
    const workerId = String(end.id);
    if (!workers.has(workerId)) return;
    // A settled worker has no live activity; the check row shows the
    // terminal status instead (ticket 29 honesty rule).
    workerActivity.delete(workerId);
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
    if (event.type !== "tool/call") return;
    const session = sessionRef as SessionRefLike | null;
    if (typeof session !== "object" || session === null) return;
    const workerId = String(session.id);
    if (!workers.has(workerId)) return;
    const phrase = describeToolActivity(event.data);
    if (phrase !== null) {
      workerActivity.set(workerId, { phrase, atMs: Date.now() });
    }
  });

  const host: CordisDshHost = {
    bindParent(agent: AgentLike, sessionId: string): void {
      parent = agent;
      parentSessionId = sessionId;
    },

    unbindParent(): void {
      parent = null;
      parentSessionId = null;
    },

    hasParent(): boolean {
      return parent !== null;
    },

    get parentAgent(): AgentLike | null {
      return parent;
    },

    get markers(): DurabilityPort | undefined {
      return markers;
    },

    listLiveJobs(): readonly JobSnapshotLike[] {
      try {
        return ctx.jobs.list() ?? [];
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
      return workerActivity.get(workerId)?.phrase ?? null;
    },

    /**
     * Ticket 61: host-clock ms of the last firehose-observed activity for an
     * owned worker — the observation moment of `recentActivity`'s phrase,
     * recorded at the same event arrival. Null when nothing has been
     * observed or the worker settled. Same subscription as
     * `recentActivity` — no new seam, no polling.
     */
    lastActivityAtMs(workerId: string): number | null {
      return workerActivity.get(workerId)?.atMs ?? null;
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

    async resolveCredential(
      credentialName: string,
    ): Promise<{ value: string; source: string } | undefined> {
      // Adapter-only: resolve a credential *name* for scoped injection.
      // Core never sees the string. Missing credentials service → undefined.
      const credentials = (ctx as { credentials?: {
        resolve?: (ref: unknown) => Promise<{ value: string; source: string } | undefined>;
        credentialRef?: (name: string) => unknown;
      } }).credentials;
      if (credentials === undefined || typeof credentials.resolve !== "function") {
        return undefined;
      }
      try {
        const ref =
          typeof credentials.credentialRef === "function"
            ? credentials.credentialRef(credentialName)
            : credentialName;
        return await credentials.resolve(ref);
      } catch {
        return undefined;
      }
    },

    async spawnWorker(prompt: string, opts: SpawnOptions): Promise<string> {
      if (parent === null) {
        throw new Error(
          "CordisDshHost: no parent agent bound; cannot spawn before dispatcher activation",
        );
      }
      const controller = new AbortController();
      // Blank context is free with the in-process spawn provider.
      //
      // Ticket 55 (register D-1/D-2) — two channels, deliberately:
      //   - the worker CONTRACT goes in `persona`, so the host places it in a
      //     system position. A system section is recomputed every turn, so the
      //     contract cannot be compacted away and needs no per-steer restatement.
      //   - the TASK stays in `prompt`, i.e. the child's first user turn. That
      //     is what "blank conversation" means, and it matches the reference:
      //     blank conversation, not blank system prompt.
      const persona = workerAgentDef?.persona;
      // Re-resolve against live global names every spawn (no cache across HMR).
      const toolFilter =
        workerAgentDef === undefined
          ? undefined
          : workerAgentDef.resolveToolFilter(listGlobalToolNames(ctx));
      const maxDepth = workerAgentDef?.maxDepth ?? 0;
      const request: ContinuableStartSpecLike["request"] = {
        prompt: textBlocks(prompt),
        parent,
        signal: controller.signal,
        // Leaf: never spawn descendants.
        maxDepth,
      };
      if (persona !== undefined && persona.length > 0) {
        (request as { persona?: string }).persona = persona;
      }
      // Host rejects empty filters and unknown names — omit when deny is empty.
      if (toolFilter !== undefined && toolFilter.deny.length > 0) {
        (request as { toolFilter?: unknown }).toolFilter = { deny: toolFilter.deny };
      }
      const started = await ctx.subagents.startContinuable({
        provider: SPAWN_PROVIDER,
        label: opts.title,
        request,
        signal: controller.signal,
      });
      // workerId === child SessionId. Brand erased at the boundary.
      const workerId = String(started.childId);
      workers.set(workerId, {
        parentSessionId: opts.parentSessionId,
        agentSessionId: workerId,
      });
      spawnControllers.set(workerId, controller);
      return workerId;
    },

    async interruptWorker(workerId: string): Promise<void> {
      if (parent === null) return;
      // Fire-and-return: cancel signal issued before return.
      ctx.subagents.interrupt(workerId, {
        kind: "ancestor",
        agent: parent,
      });
    },

    async sendMessage(workerId: string, message: string): Promise<void> {
      if (parent === null) {
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

    async requestDispatcherWakeup(sessionId: string): Promise<void> {
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
      agent.followup(wakeUserMessage(text ?? undefined));
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
      for (const controller of spawnControllers.values()) {
        controller.abort();
      }
      spawnControllers.clear();
      workers.clear();
      workerActivity.clear();
      workerResults.clear();
      settledCallbacks.length = 0;
      stepBoundaryCallbacks.length = 0;
      accessRequestCallbacks.length = 0;
      parent = null;
      parentSessionId = null;
    },
  };

  return host;
}
