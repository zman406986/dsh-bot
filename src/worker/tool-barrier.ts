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
  // Peer / agent messaging & management
  "send_message",
  "interrupt_agent",
  // Spawn / nested agents. Ticket 179: one candidate list for both barriers —
  // the same host verbs the dispatcher surface withholds are denied here, so
  // `subagent_fork` cannot slip a worker an unaccounted child either.
  ...HOST_SPAWN_TOOL_CANDIDATES,
  // Ticket 182: `workflow` can start descendants outside the worker leaf barrier.
  "workflow",
  // Worker-management / jobs
  "job_list",
  "job_output",
  "job_kill",
  // Todo ledger
  "todo_write",
  // Dispatcher tool surface
  "spawn_worker",
  "check_workers",
  "steer_worker",
  "stop_worker",
  "deliver_result",
  // Ticket 70: workers are leaves of the peer tier — the peer-message tool
  // is dispatcher-only (reference conformance, reference-behavior-notes:60).
  "send_peer",
  // Ticket 116: the unified agent-message verb is dispatcher-only — workers
  // must never see it. (Ticket 119 keeps its remaining policy/barrier
  // checkboxes; this single line is all this half adds.)
  "message_agent",
  // Ticket 117: the bounded await is dispatcher-only too. Workers are leaves
  // and have no await tool, which is exactly why `A awaits B awaits A` is not
  // constructible — the cycle rule depends on this name never reaching a
  // worker's scope.
  "await_agent",
  // Ticket 118: mitosis is dispatcher-only. The worker-leaf rule (ADR-0003,
  // retained by ADR-0025) says a worker spawns no agent at all, so the
  // dispatcher-summoning verb must never reach a worker's scope either.
  "spawn_dispatcher",
  // Second-round audit: optional host verbs that reach other agents or the
  // user. They may be absent from a given host — `buildWorkerToolFilter`
  // intersects with the live names, so an absent one is simply omitted, never
  // passed to `tools.restrict()` (which throws on unknown names). On a host
  // that DOES ship them, a worker must not see any of them:
  //   - experimental agent-team tooling (spawn + shared task board),
  //   - the agent-control surface (list/wait),
  //   - the retired access-ask verb (ADR-0033 removed OUR tool, but a host
  //     that still mounts its own `request_access` must not hand it to a
  //     worker that has no relay behind it).
  "spawn_teammate",
  "team_task_create",
  "team_task_get",
  "team_task_list",
  "team_task_update",
  "wait_agent",
  "list_agents",
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
