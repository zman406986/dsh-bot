# Todo stays the dispatcher's private ledger; the worker link is structural

**Status:** accepted

The dispatcher's todo list is **never handed to a worker** — it stays the dispatcher's own ledger, and a worker keeps its own separate, empty list. Matching a worker's completion notice back to its todo is done **structurally**, not by recollection: our `WorkerRecord` carries the **todo id, set at spawn**. The dispatcher-only half is **imitation** of the reference; the structural link is **our deliberate divergence** from it.

## Context

- Q11 asked whether the todo list should be passed down to the assigned worker or kept purely as the dispatcher's ledger, and whether it needs a structural todo↔worker link. Human's answer (verbatim intent): "if you can confirm something is done in a way in reference, keep it that way unless we HAVE TO change" — i.e. adopt the reference's arrangement — plus agreement to keep the todo dispatcher-only and to the structural link as the one deliberate addition (recommendation (b), approved with "ok").
- Reference recon, plain language and path provenance only (`docs/research/reference-behavior-notes.md` §3 worker toolset gating):
  - The todo tool is **parent-only** — the per-turn tool builder excludes it for a subagent run.
  - The todo list is **per-conversation state**; a worker would have its own, separate, empty list.
  - For a **normal dispatch** nothing crosses into the worker's context: the worker's conversation state starts empty. What crosses is a short title, a work-type, and one self-contained prose instruction (the worker is explicitly told it cannot see the user's message or prior steps). Two opt-in exceptions exist (self-fork inherits the parent's whole state; resume returns a worker's own saved state), neither of which is a normal dispatch, and no shipped config opts into a state mapper.
  - There is **no structural todo↔worker link anywhere** in the reference: no id field on the todo entry, and the completion notice the parent receives carries worker-side ids (task id, tool-call id, agent id, title, status) and never a todo id. The pairing is the parent's own reasoning, aided by the worker's short title string.
  - The reference makes that workable by instructing itself to **reconcile the ledger on every wake**, and by keeping **exactly one worker per stream** so the title→todo mapping stays simple (`reference-behavior-notes.md` §5; ADR-0003 keeps one worker per stream for us too).
  - In the reference, "completed" on a todo already means *delivered to the user*, and the **dispatcher** (never the worker) flips it — matching our S4.
- ADR-0003 already commits every worker to a single parent owning its settle wake and todo reconciliation, so the link never has to be shared with anyone but that parent.

## Considered options

| Option | Rejected because |
|---|---|
| **A. Todo dispatcher-only (imitation) + `WorkerRecord.todo_id` set at spawn (divergence)** | **Chosen.** Keeps the reference's arrangement where it is already correct, and buys the one thing our workload changes: a completion notice that identifies its todo without the parent's recollection. |
| B. Reference-as-is — todo dispatcher-only, no structural link; pair by title recollection | The reference's title-based pairing was designed for **one worker per stream**. Our dispatcher runs several at once, and under S4 a mismatched or dropped notice means a todo wrongly marked `completed` (a false claim to the user that something was delivered) or wrongly left `in_progress`. |
| C. Pass the todo list down to the worker | The worker has no user-messaging tool, so it cannot legitimately mark anything completed and has no use for the list. It also puts a second writer on the ledger and is inconsistent with S4 ("completed" = delivered to the user). |

## Consequences

- **Dispatcher-only (imitation):** the todo list is the dispatcher's ledger; it is not sent into a worker's context, and the worker's own list stays empty. Nothing else about the reference's todo gating is changed.
- **Structural link (divergence):** `WorkerRecord` carries the **todo id, set at spawn**. This is our addition — the reference has no todo id on the worker side and none in the completion notice — and the ADR states it as a divergence, not an imitation.
- **Consistent with ADR-0006:** the durable minimum-to-reconstruct `WorkerRecord` is worker id, transcript pointer, todo link, status, so the todo link is part of that durable minimum. ADR-0006 is not amended; its wording reads correctly.
- **PRD §7.5 data model already carried the link** (`WorkerRecord.stream_key` "logical stream (todo id)" and `todo_id`, `TodoItem.worker_id`) — no change was required. §6.2 now states the dispatcher-only rule. No PRD §15 item is reopened.
- **No glossary term:** the existing "Stream key" entry already names the shared work item, so a "todo ledger" vs "todo list" term would be a synonym the glossary does not use. Skipped deliberately.