import { buildWorkerSystemPrompt } from "./prompt.js";
import {
  buildWorkerToolFilter,
  type WorkerToolFilter,
} from "./tool-barrier.js";

/**
 * Worker agent type: composition of (contract persona + tool barrier + leaf
 * maxDepth). Applied on every spawn by the adapter. Not a host registry object.
 */
export interface WorkerAgentDef {
  /**
   * The worker **contract**, delivered in a system position.
   *
   * Ticket 55: the adapter passes this as the spawn request's `persona`, which
   * the host renders into a system-prompt section. It is deliberately NOT
   * concatenated into `request.prompt` — that would put the contract back in
   * conversation history, where a compaction can drop it (register D-1).
   */
  readonly persona: string;
  /**
   * Resolve the deny list against tools that actually exist as globals.
   * Never invents names the host does not know.
   */
  resolveToolFilter(knownGlobalToolNames: ReadonlySet<string>): WorkerToolFilter;
  /** Host maxDepth for leaf workers (0 = no children). */
  readonly maxDepth: number;
}

/** Leaf-worker depth: a worker never spawns descendants. */
export const WORKER_MAX_DEPTH = 0;

/** Create the default worker agent definition. */
export function createWorkerAgentDef(): WorkerAgentDef {
  return {
    persona: buildWorkerSystemPrompt(),
    resolveToolFilter: buildWorkerToolFilter,
    maxDepth: WORKER_MAX_DEPTH,
  };
}
