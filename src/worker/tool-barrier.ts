/**
 * Worker tool barrier: deny-list intersection with live global tool names.
 *
 * Host `tools.restrict()` throws on unknown names, so never pass a hard-coded
 * full deny list — always intersect the candidates with what is actually
 * registered as a global tool at spawn time.
 */

import { HOST_SPAWN_TOOL_CANDIDATES } from "../core/tools.js";

/**
 * Candidate names denied on every worker spawn.
 * Categories: user messaging, peer/agent messaging, spawn/nested agents,
 * worker-management/jobs, todo ledger, dispatcher tool surface.
 */
export const WORKER_DENIED_TOOL_CANDIDATES: readonly string[] = [
  // User messaging / delivery
  "present",
  "ask_user_question",
  // Agent management. A worker REPLIES to its parent through the stock
  // `send_message` (the parent sees the notice), so that name is allowed.
  // Interrupting, listing or steering through the dispatcher verbs stays
  // denied.
  "interrupt_agent",
  "list_agents",
  "message_agent",
  "deliver_result",
  "spawn_dispatcher",
  // Spawn / nested agents. The dispatcher surface withholds only
  // `subagent_fork` (a fork inherits context; workers must start blank), but
  // a worker must not reach ANY spawn verb — `subagent` / `subagent_fork` /
  // `list_subagent_models` would each slip it an unaccounted child.
  ...HOST_SPAWN_TOOL_CANDIDATES,
  // Ticket 182: `workflow` can start descendants outside the worker leaf barrier.
  "workflow",
  // Worker-management / jobs
  "job_list",
  "job_output",
  "job_kill",
  // Todo ledger
  "todo_write",
  // Ticket 70: workers are leaves of the peer tier — the peer-message tool
  // is dispatcher-only (reference conformance, reference-behavior-notes:60).
  "send_peer",
  // Second-round audit: optional host verbs that reach other agents or the
  // user. They may be absent from a given host — `buildWorkerToolFilter`
  // intersects with the live names, so an absent one is simply omitted, never
  // passed to `tools.restrict()` (which throws on unknown names). On a host
  // that DOES ship them, a worker must not see any of them:
  //   - experimental agent-team tooling (spawn + shared task board),
  //   - the agent-control wait verb (`send_message` above is the exception),
  //   - the retired access-ask verb (ADR-0033 removed OUR tool, but a host
  //     that still mounts its own `request_access` must not hand it to a
  //     worker that has no relay behind it).
  "spawn_teammate",
  "team_task_create",
  "team_task_get",
  "team_task_list",
  "team_task_update",
  "wait_agent",
  "request_access",
] as const;

/** Host-agnostic restriction shape (mirrors dsh ToolRestriction.deny). */
export interface WorkerToolFilter {
  readonly deny: readonly string[];
}

/**
 * Build the worker tool filter by intersecting deny candidates with tools
 * that actually exist as globals. Unknown candidates are omitted (no throw
 * at our layer). An empty deny is valid here — the adapter omits toolFilter
 * when deny is empty because the host rejects empty filters.
 */
export function buildWorkerToolFilter(
  knownGlobalToolNames: ReadonlySet<string>,
): WorkerToolFilter {
  const deny = WORKER_DENIED_TOOL_CANDIDATES.filter((name) =>
    knownGlobalToolNames.has(name),
  );
  return { deny };
}
