import { buildWorkerSystemPrompt } from "./prompt.js";
import {
  buildWorkerToolFilter,
  type WorkerToolFilter,
} from "./tool-barrier.js";

/**
 * Worker agent type: composition of (system prompt + tool barrier + leaf
 * maxDepth). Applied on every spawn by the adapter. Not a host registry object.
 */
export interface WorkerAgentDef {
  /** Self-contained worker system prompt (new copy). */
  readonly systemPrompt: string;
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
    systemPrompt: buildWorkerSystemPrompt(),
    resolveToolFilter: buildWorkerToolFilter,
    maxDepth: WORKER_MAX_DEPTH,
  };
}
