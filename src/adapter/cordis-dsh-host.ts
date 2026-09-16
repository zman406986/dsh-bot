import type { DshHost } from "../core/dsh-host.js";
import type { DurabilityPort } from "../core/durability.js";
import type { SettledEvent, SpawnOptions, TerminalWorkerStatus } from "../core/types.js";
import { blocksToText, textBlocks, type ContentBlock } from "./content-blocks.js";
import type { StorageDomainLike } from "./durable-marker.js";
import { wakeUserMessage } from "./wake-copy.js";

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
 * Structural Cordis context surface the adapter needs.
 * Narrow local interface — prefer this over importing full Cordis types.
 */
export interface AdapterContext {
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
  on(name: string, cb: (payload: never) => void): () => void;
}

/** Optional worker prompt/tool seam; T10 owns the real definition. */
export interface WorkerAgentDef {
  /** Assemble the worker prompt (system section + task). Identity by default. */
  buildPrompt(prompt: string): string;
  /** Tool filter for spawn. Omitted in T09; T10 injects the barrier. */
  resolveToolFilter?(): unknown;
}

export interface CordisDshHostOptions {
  /** Durable marker store (T08 DurabilityPort over storageDomain). */
  markers?: DurabilityPort;
  /** Worker agent definition; T10 supplies the real one. */
  workerAgentDef?: WorkerAgentDef;
}

/**
 * Live `DshHost` over Cordis dsh services.
 * Core stays pure; this is the only place that knows subagents/agents/jobs.
 */
export interface CordisDshHost extends DshHost {
  /** Bind the exact live dispatcher Agent captured on session-start. */
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
  /** Fire step-boundary callbacks (called from parent-agent status wiring). */
  emitStepBoundary(workerId: string): void;
  /** Notify core that a worker's first turn started (spawned → running). */
  onWorkerTurnStarted?: (workerId: string) => void;
  dispose(): void;
}

/** Default in-process spawn provider name (dsh-subagent-spawn-in-process). */
export const SPAWN_PROVIDER = "spawn";

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

/** Settle report: join text blocks; empty → short adapter-owned placeholder. */
export function normalizeWorkerReport(
  lastAssistantMessage: readonly ContentBlock[] | undefined,
): string {
  const text = blocksToText(lastAssistantMessage).trim();
  if (text.length > 0) return text;
  return "(worker finished without a closing message)";
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

  let parent: AgentLike | null = null;
  let parentSessionId: string | null = null;
  const workers = new Map<string, WorkerEntry>();
  const spawnControllers = new Map<string, AbortController>();
  const settledCallbacks: Array<(event: SettledEvent) => void> = [];
  const stepBoundaryCallbacks: Array<(workerId: string) => void | Promise<void>> = [];
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
    const event: SettledEvent = {
      workerId,
      status: mapStopReason(end.stopReason),
      report: normalizeWorkerReport(end.lastAssistantMessage),
      transcriptRef: workerId,
    };
    for (const cb of [...settledCallbacks]) {
      cb(event);
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

    emitStepBoundary(workerId: string): void {
      for (const cb of [...stepBoundaryCallbacks]) {
        void cb(workerId);
      }
    },

    async spawnWorker(prompt: string, opts: SpawnOptions): Promise<string> {
      if (parent === null) {
        throw new Error(
          "CordisDshHost: no parent agent bound; cannot spawn before agent/session-start",
        );
      }
      const controller = new AbortController();
      const assembled = workerAgentDef?.buildPrompt(prompt) ?? prompt;
      const toolFilter = workerAgentDef?.resolveToolFilter?.();
      const request: ContinuableStartSpecLike["request"] = {
        prompt: textBlocks(assembled),
        parent,
        signal: controller.signal,
        // Leaf: never spawn descendants.
        maxDepth: 0,
      };
      // T09 omits toolFilter entirely — T10 owns the barrier intersection rule.
      if (toolFilter !== undefined) {
        (request as { toolFilter?: unknown }).toolFilter = toolFilter;
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
      agent.followup(wakeUserMessage());
    },

    dispose(): void {
      offSubagentEnd();
      for (const controller of spawnControllers.values()) {
        controller.abort();
      }
      spawnControllers.clear();
      workers.clear();
      settledCallbacks.length = 0;
      stepBoundaryCallbacks.length = 0;
      parent = null;
      parentSessionId = null;
    },
  };

  return host;
}
