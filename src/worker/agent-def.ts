import { REPLY_TO_DISPATCHER_TOOL } from "../core/tools.js";
import { buildWorkerSystemPrompt } from "./prompt.js";
import {
  buildWorkerToolFilter,
  type WorkerToolFilter,
} from "./tool-barrier.js";

/**
 * Tools that exist ONLY on a worker's own scoped surface (ticket 122 /
 * ADR-0028), declared here so the composition seam and the barrier agree on
 * one list without hard-coded names.
 *
 * These are worker-only, not dispatcher-only: they are registered on the
 * child's scope (the inverse of how dispatcher tools register on the
 * activated agent's scope), and the barrier must never deny them. A worker
 * using one can reach exactly one address — its owning dispatcher — because
 * the handler derives that address from the roster record.
 */
export const WORKER_LOCAL_TOOL_NAMES = [REPLY_TO_DISPATCHER_TOOL] as const;

/**
 * Worker agent type: composition of (contract persona + tool barrier + leaf
 * delegation budget). The persona and barrier are declared by the
 * `multitask-worker` Agent Preset (`src/worker/preset.ts`); this definition
 * is the offline seam that names the preset and carries its inputs.
 * Not a host registry object.
 */
export interface WorkerAgentDef {
  /**
   * The worker **contract** text. The preset's contract row renders it into
   * the `deployment:persona-prefix` system-prompt section, recomputed every
   * turn, so it survives compaction and needs no steer restatement. It is
   * deliberately NOT concatenated into `request.prompt` — that would put the
   * contract back in conversation history, where a compaction can drop it
   * (register D-1).
   */
  readonly persona: string;
  /**
   * Resolve the deny list against tools that actually exist as globals.
   * Never invents names the host does not know; `tools.restrict()` throws on
   * unknown names.
   */
  resolveToolFilter(knownGlobalToolNames: ReadonlySet<string>): WorkerToolFilter;
  /**
   * How many delegation levels the worker may open BELOW itself — a budget
   * relative to the worker's own depth. This is NOT the value for the spawn
   * request's `maxDepth` slot (the host reads that slot as the child's
   * ABSOLUTE ceiling; derive it with `workerSpawnMaxDepth`).
   */
  readonly maxDepth: number;
}

/**
 * Leaf-worker delegation BUDGET: a worker opens zero levels below itself
 * (ADR-0003, dispatcher-only spawning). Deliberately named as a budget: it
 * must never be shipped raw in the spawn request's `maxDepth` slot — the
 * host reads that slot as the CHILD'S ABSOLUTE delegation-depth ceiling
 * (`resolveChildDepth`, dsh-subagent/lib/index.js:432-437 computes
 * `childDepth = delegationDepthOf(parent) + 1` and throws SubagentDepthError
 * when `childDepth > maxDepth`), so sending this 0 there refused every live
 * spawn with "subagent depth 1 exceeds maxDepth 0" (ticket 83, live pass
 * 2026-09-19). The request value is derived by `workerSpawnMaxDepth`.
 * Leaf-ness does not depend on this number: the worker preset does not mount
 * any delegation tool.
 */
export const WORKER_MAX_DEPTH = 0;

/**
 * Ticket 83: the ABSOLUTE delegation-depth ceiling to send in the spawn
 * request's `maxDepth` slot for the dispatcher→worker hop. The host accepts
 * the spawn iff `parentDepth + 1 <= maxDepth` (dsh-subagent
 * `resolveChildDepth`, lib/index.js:432-437; parent depth is the monotone
 * floor of the persisted session header and the runtime option,
 * `delegationDepthOf` :144-147 — our `AgentLike` seam exposes the header
 * side). The worker lands one hop below its parent and carries
 * `WORKER_MAX_DEPTH` levels of its own budget, hence
 * `parentDepth + 1 + budget`: for the depth-0 dispatcher chat this is
 * exactly 1 — the depth-1 child is accepted and any deeper spawn is refused
 * at the host, before the tool barrier is even consulted.
 */
export function workerSpawnMaxDepth(
  parentDelegationDepth: number,
  budget: number = WORKER_MAX_DEPTH,
): number {
  return parentDelegationDepth + 1 + budget;
}

/** Create the default worker agent definition. */
export function createWorkerAgentDef(): WorkerAgentDef {
  return {
    persona: buildWorkerSystemPrompt(),
    resolveToolFilter: buildWorkerToolFilter,
    maxDepth: WORKER_MAX_DEPTH,
  };
}
