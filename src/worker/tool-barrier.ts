/**
 * Worker tool barrier: deny-list intersection with live global tool names.
 *
 * Host `tools.restrict()` throws on unknown names, so never pass a hard-coded
 * full deny list — always intersect the candidates with what is actually
 * registered as a global tool at spawn time.
 */

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
  // Spawn / nested agents
  "subagent",
  "list_subagent_models",
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
