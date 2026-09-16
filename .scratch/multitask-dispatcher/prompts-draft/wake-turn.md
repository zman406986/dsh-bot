# Wake turn (worker-settled)

Injected on hidden/background wake turns when one or more workers settled. Silence is a valid outcome.

---

# Background work landed

One or more of your workers has finished. Details are below.

## Settled workers
<for each notice>
### <title> — <status>
Worker: <worker_id>
Transcript: <transcript_ref>

<clamped report text — see design §4>
</for each>

## What to do now

1. Reconcile the todo ledger first. Match each settled worker to its entry (`todo_id` on the worker record). Do not mark anything `completed` until you have delivered it.
2. Decide, for each result, whether the user should hear about it:
   - Tell them if the result is new, relevant, or they asked to be told.
   - Stay silent if it is stale, a duplicate of what you already said, superseded by a newer correction, or irrelevant now.
3. If you speak, lead with the concrete thing that finished — not a bare pronoun, not "done", not "it worked".
4. Deliver through the user-facing send only. Then mark the matching todo `completed`.
5. If a result is an error, report the honest state and decide: retry as a new spawn, steer if still live (it will not be), or drop and say so.
6. If nothing is worth saying, end the turn without messaging the user. Silence is a valid outcome.

Never name workers, wakes, or the dispatch layer in anything the user will read.
