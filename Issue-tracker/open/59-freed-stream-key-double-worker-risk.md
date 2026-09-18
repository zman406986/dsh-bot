# 59 — A freed stream key can put two live workers on one stream (bug, not a deviation)

**Status:** open
**Type:** task
**Labels:** ready-for-agent
**Blocked by:** none
**Related:** register Part E item **B-1**; `docs/research/dsh-core-loop-fidelity-audit.md` §6; ADR-0006; `docs/research/dsh-loop-capability-map.md` stage 10

## The defect

On activation, `rebuildFromDurability` restores markers and **frees the stream key** for a worker that was live at crash time — deliberately, "so the dispatcher may re-dispatch" (`src/core/multitask.ts:640-654`).

But that worker may still be **alive on the host**. We hold no interrupt handle for it after a restart. So re-dispatching the same stream key can produce **two live workers on one logical stream** — precisely the condition one-worker-per-stream exists to prevent (`liveByStreamKey`, `src/core/multitask.ts:407-415`, S2).

**This is not a fidelity deviation.** The audit classified it as a bug on its own track: the reference has the same exposure in spirit (it abandons and lets the run zombie), but it at least keeps the id. Our combination — *stream key freed* **plus** *no interrupt handle* — is ours alone and does not appear to have been considered when the rebuild was designed.

The reference's own answer here is poor, so **do not treat "match the reference" as the fix**. This is a place where ADR-0017's fidelity rule and correctness point in different directions, and correctness should win — but that call belongs in the ticket's design note, not in silent code.

## What to establish first (the ticket is partly research)

1. **Can a crash-orphaned child actually still be running?** Under the in-process `spawn` provider, a child shares the process — so a dispatcher restart may kill it too. Determine whether the orphan is reachable in practice, for both in-process and out-of-process providers. If it genuinely cannot outlive the process, the fix is a *statement of that invariant* plus a guard, not a subsystem.
2. **Does the host expose a way to enumerate or re-adopt live children after restart?** The host **does** offer continuable-session cold-resume — `ContinuableActivationRegistry.coldResume` re-observes a persisted `continuable`-mode session and resumes it (`dsh-subagent/lib/index.js:1870-1910`; a non-continuable descriptor throws `NOT_RESUMABLE`). Reading dsh's own MIT source is allowed. This may turn "we cannot know" into "we can re-adopt or confidently reap".
3. **What does the durable marker retain?** ADR-0006 fixed the split as minimum-to-reconstruct. Does it carry enough to identify and re-adopt a live child, or only enough to reconstruct a record?

## Candidate remedies (choose with evidence — do not default to the first)

| Remedy | Trade-off |
|---|---|
| **Keep the stream key occupied** by the unknown-state record until the orphan is provably gone | Safest against duplicates; risks blocking a legitimate re-dispatch indefinitely |
| **Re-adopt** via cold-resume before allowing a re-dispatch | Most faithful to reality; depends on §2's answer and on the child being `continuable` |
| **Reap-then-free** — attempt an interrupt, and free only on confirmation or timeout | Removes the orphan; depends on holding a handle we currently do not have across restart |
| **Explicit unknown-state occupancy** — the record holds the key and the dispatcher is *told* it must resolve it | Honest and simple; pushes the decision to the dispatcher, and pairs naturally with ticket 57's recovery turn |

## Requirements

- **R1** One-worker-per-stream holds **across a restart** for a worker that was live at crash time. State the invariant and test it.
- **R2** Whatever remedy is chosen, an un-resolvable orphan is **surfaced** rather than silently blocking or silently duplicating — it should appear in the semantics ticket 57's recovery turn carries, and interact with ticket 58's `lost` reasons.
- **R3** Do not regress the honest unknown-state reconstruction (`src/core/multitask.ts:626-700`), which the audit found richer than the reference.
- **R4** If the chosen remedy deliberately differs from the reference, record it in `docs/research/dsh-core-loop-deviations.md` — a correctness fix that diverges is still a divergence and must be visible.
- **R5** Offline tests only (S8): simulate crash-then-activate with a marker that was live, and assert the key cannot be double-occupied.
- **R6** Clean-room identifier grep as a gate.

## Acceptance criteria

- [ ] A written finding answers §1–§3 with `file:line` evidence (host source for §2, `src/` for §1/§3).
- [ ] The chosen remedy is justified against the table, not just named.
- [ ] A test proves the stream key cannot be double-occupied after a simulated restart.
- [ ] An un-resolvable orphan is surfaced to the dispatcher rather than silently stalling.
- [ ] Any divergence from the reference is logged in the register.
- [ ] `npm test` 0 fail, `npm run typecheck` clean (both configs); clean-room grep zero product-tree hits.

## Notes

- **Deliberately not fixed by "match the reference".** The reference's own behaviour (`abandon it, let it zombie`) is the weaker option here; ADR-0017's fidelity rule should not be read as mandating a known-weak path. Write the reasoning down so the divergence is a decision rather than a slip.
