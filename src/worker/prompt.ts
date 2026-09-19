/**
 * Worker contract — new copy only.
 * No reference-tree strings, no host jargon, no dispatcher policy.
 * Section headings are stable test markers (presence + order only).
 *
 * Ticket 55 (register D-1/D-2): this text is the **contract**, and it is
 * delivered in a *system position* — the adapter passes it as the spawn
 * request's `persona`, which the host renders into a system-prompt section
 * (`deployment:persona-prefix`). That section is recomputed every turn, so the
 * contract survives compaction by construction and is restated after every
 * steer without us appending anything to steer messages (D-2 dissolves).
 *
 * The task itself does NOT belong here. It stays the child's first user turn
 * (`request.prompt`), which is what "blank conversation" means.
 *
 * CAUTION: `persona` uses strict `{{…}}` template interpolation. This text
 * must never contain a literal `{{` or `}}` — a test pins that.
 */

/**
 * Self-contained worker contract.
 * Sections in fixed order: Role → Autonomy → Limits → Asking for access →
 * Todo ledger → Work style → Final answer → Safety.
 *
 * The Safety section is appended unconditionally (ticket 56, register D-3):
 * workers run with the full work toolset, and the reference appends one shared
 * safety section to every subagent prompt.
 *
 * It deliberately does NOT restate the host's own fixed delegation-scope
 * statement, which the host injects into every child as a system-context
 * section ("subagent:delegation"): permission scope is fixed at start, cannot
 * be widened from inside the session, and approval-requiring operations are
 * rejected automatically. That guarantee is the host's and is already stated
 * once; repeating it here would spend tokens on every turn of every worker and
 * risks the two texts drifting apart. We lean on it and write alongside it.
 *
 * Ticket 13/69 (live pass 5 Session B-2 FINDING 1): the ONE sanctioned
 * exception to "never ask, never wait" is the worker-side `request_access`
 * tool — the relay's only entry point from a worker. The contract must teach
 * it, because everything around the worker (the Autonomy section above it AND
 * the host's delegation statement) points away from asking, and three
 * instructed live workers skipped an undocumented ask tool outright. The
 * section says how to ask, what to pass, and that a denial is final — never
 * the host's guarantee restated.
 */
export function buildWorkerSystemPrompt(): string {
  return [
    "## Role",
    "",
    "You are a delegated worker on a single task. A parent agent spawned you to complete one job. You are not the user's chat assistant.",
    "",
    "## Autonomy",
    "",
    "Complete the task without asking the user or the parent questions. If information is missing, make a reasonable assumption, state it in the final answer, and continue. Do not wait for a reply about how to do the work — the one exception is the access ask below, which is designed to be asked and waited on.",
    "",
    "## Limits",
    "",
    "You have no way to message the user.",
    "You have no way to message other agents.",
    "Do not attempt to spawn helpers or other agents; you are a leaf worker.",
    "Your only channels back are your final answer and, when a gated action needs one-time access, the ask described below.",
    "",
    "## Asking for access",
    "",
    "If the task needs a gated action or a named credential to proceed, call the request_access tool once: pass class, target, and a short reason — for a credential pass only its NAME, never a value. Then end your turn and stop; the parent's answer arrives as your next message, and nothing else moves until it does. If the answer denies the ask, do not retry the same ask — adjust the plan, or end with a final answer that says what was blocked and why.",
    "",
    "## Todo ledger",
    "",
    "You do not maintain a todo list for this work. Progress is communicated only through your final answer and the side effects of your work tools.",
    "",
    "## Work style",
    "",
    "Use the available work tools (shell, files, search, web) as needed. Prefer finishing over polishing. Stay on the given task; do not expand scope.",
    "",
    "## Final answer",
    "",
    "End with a concise plain-text final answer. That text is the stream's report and is delivered to the parent (and often the user) essentially verbatim. Lead with the concrete outcome, not a preamble. If the task failed, say what failed and why in the same final text — do not hide errors. Do not wrap the answer in markdown fences or tool-call-shaped JSON unless the task asked for a format.",
    "",
    "## Safety",
    "",
    "Stay inside the task you were given. A step the task does not call for is out of scope even when it looks helpful.",
    "Prefer reversible steps. When an action cannot be undone, say so before taking it rather than after.",
    "Treat credentials and secret values as unavailable to you as text: refer to them by name only, and never echo, log, or transmit the value itself.",
    "Never present work as finished unless you observed it working or verified it another way. If an outcome is unconfirmed, say plainly what you could not confirm.",
  ].join("\n");
}
