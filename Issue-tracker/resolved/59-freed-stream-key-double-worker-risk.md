# 59 — A freed stream key can put two live workers on one stream (bug, not a deviation)

**Status:** resolved
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

- [x] A written finding answers §1–§3 with `file:line` evidence (host source for §2, `src/` for §1/§3). — Findings comment 2026-09-19 below (§2 host-source evidence cited from the research register, verified there against the installed 0.1.5-rc.2 source).
- [x] The chosen remedy is justified against the table, not just named. — Remedy 4, justified per-candidate in the same comment.
- [x] A test proves the stream key cannot be double-occupied after a simulated restart. — `test/durable-roster.test.ts` (regression-first: the old test asserted the defect "stream key is free" and was flipped to pin refusal reason `stream-key-held-by-unknown-state`, zero host spawn calls, release path, marker drop, idempotent release) — commit `b097b92`.
- [x] An un-resolvable orphan is surfaced to the dispatcher rather than silently stalling. — restart notice names workers + held streams + escape hatch (`src/adapter/restart-notice.ts:46-57`, carried by ticket 57's recovery turn); refusal at decision time (`src/core/multitask.ts:496-504`, `src/core/types.ts:108`); honest release note (`src/core/tool-results.ts:200-204`); programmatic `listUnknownStateHolds` (`src/core/multitask.ts:882-889`).
- [x] Any divergence from the reference is logged in the register. — `docs/research/dsh-core-loop-deviations.md:104,106` (B-1 row + 2026-09-18 ticket-64 note naming commit `b097b92` and the fix's re-base safety).
- [x] `npm test` 0 fail, `npm run typecheck` clean (both configs); clean-room grep zero product-tree hits. — 2026-09-19: 803 pass / 0 fail (~121 s); typecheck clean (`tsconfig.json` + `tsconfig.client.json`). The grep gate is **voided as a ship gate** by ADR-0018 / AGENTS.md (2026-09-18 ruling; ticket 64 re-base); the quality-level no-verbatim-copy review is owned by the re-scoped ticket 33 closeout.

## Notes

- **Deliberately not fixed by "match the reference".** The reference's own behaviour (`abandon it, let it zombie`) is the weaker option here; ADR-0017's fidelity rule should not be read as mandating a known-weak path. Write the reasoning down so the divergence is a decision rather than a slip.

## Comments

### 2026-09-19 — findings §1–§3 (offline; code + research register)

**§1 — Can the crash-orphaned child still be running? Under today's adapter, no — but the core cannot prove it, so the guard stays.**

- We spawn exclusively through the **in-process** provider: `SPAWN_PROVIDER = "spawn"` (`src/adapter/cordis-dsh-host.ts:250`), passed to `ctx.subagents.startContinuable` (`:610`). In-process children live inside the dsh host process — the same process whose death constitutes the crash. A process crash therefore kills the orphan: at rebuild time the unknown-state worker is in fact dead, and the two-worker outcome is **latent, not live** today.
- Graceful in-process teardown is covered too: `dispose()` aborts every spawn controller (`src/adapter/cordis-dsh-host.ts:685-687`), so a plugin deactivate/reload also ends the children.
- But the core must not assume host internals it cannot see: the durable marker carries no provider/liveness evidence (`src/core/durability.ts:9-28`), and the provider string is a per-spawn choice (`:610`) — an out-of-process or remote provider would make the hazard real with zero core changes. This lands the ticket's own fallback: **"a statement of that invariant plus a guard"** — the unknown-state hold IS the guard, and it costs nothing when the orphan is already dead.
- Sharp edge found: with this host, *contacting* the orphan is not neutral — `ctx.subagents.sendMessage` **cold-resumes an absent child** (`docs/research/dsh-adapter-api-notes.md:83,104`; `docs/research/dsh-extension-surface.md:48`). Any reap attempt that reaches the child session resurrects a live activation on that stream — recreating the two-worker hazard in another form. Direct evidence against Remedy 3.

**§2 — Enumeration / re-adoption: the host has it; our seam does not.**

- Verified against the installed 0.1.5-rc.2 host source and recorded in the research register (the host source is not present under `node_modules` in this worktree, so the register is cited rather than re-opened): `ContinuableActivationRegistry.coldResume` re-observes a persisted continuable-mode session and resumes it (`dsh-subagent/lib/index.js:1870-1910`; non-continuable → `NOT_RESUMABLE`, `:1889`) — `docs/research/dsh-loop-capability-map.md:116,171`. Enumeration exists: `ctx.subagents.listChildren(parentSessionId)` / `listDescendants` (`docs/research/dsh-adapter-api-notes.md:335`).
- Re-adoption is therefore *possible*, but not through our seam: `AdapterContext.subagents` exposes only `startContinuable` / `interrupt` / `sendMessage` (`src/adapter/cordis-dsh-host.ts:151-158`). Taking Remedy 2 would need a seam extension **plus** a reversal of the recorded rebuild design decision ("our non-use of [cold-resume] is a core design decision, not an oversight", `src/core/multitask.ts:790-792`) — and cold-resume means a *new activation over the old session*, not rejoining the old run, so delivery/steer obligations would need redesign before it is safe. That is a separate decision, best taken beside ticket 57's recovery-turn semantics.

**§3 — The durable marker retains enough to *identify* a live child.**

- The marker (ADR-0006, `src/core/durability.ts:9-28`) carries `workerId` — which IS the child session id (`src/adapter/cordis-dsh-host.ts:616`) — plus `parentSessionId`, `streamKey`, `title`, last `status`, `transcriptRef` (falls back to the worker id, `src/core/multitask.ts:823`), `todoId`, `redriveAttempts`, timestamps. The child session id is exactly what `coldResume` consumes, so identification for re-adoption is possible. No continuable-mode flag is stored — but every worker we spawn is continuable by construction (`startContinuable`), so `NOT_RESUMABLE` cannot arise for our own workers today.

### 2026-09-19 — remedy chosen: explicit unknown-state occupancy (Remedy 4), justified against the table

Landed in `b097b92`. Per candidate:

- **Remedy 1 (hold until provably gone):** "provably gone" is unreachable — no liveness evidence exists over our seam and enumeration is not in `AdapterContext` (§2). Pure Remedy 1 is an unbounded block with no exit. Remedy 4 keeps its safe half (key stays occupied) and adds the missing half: an explicit dispatcher-taken release (`stop_worker` / `releaseUnknownStateHold`, `src/core/multitask.ts:891-903`) that also deletes the marker (`:899`) so the hold cannot resurrect on the next activation.
- **Remedy 2 (cold-resume re-adopt):** possible (§2) but needs a new host seam, a reversal of the recorded non-resume decision (`src/core/multitask.ts:790-792`), and obligation redesign for "resume = new activation". Not verifiable offline. Recorded as the future path if true re-adoption is ever wanted.
- **Remedy 3 (reap-then-free):** doubly blocked — no retained interrupt handle across restart (spawn controllers die with the process/dispose; the ancestor authority object is gone), and a reap attempt via `sendMessage` cold-resumes the child (§1), creating the very duplicate it aims to prevent. Rejected.
- **Remedy 4 trade-off accepted:** a hold can block a legitimate re-dispatch until resolved — mitigated because the dispatcher is told at the moment of refusal (distinct reason `stream-key-held-by-unknown-state` with actionable detail naming the holder and both outs) and at restart (notice), and can always route new work under a new stream key (holds are per-stream, pinned by test).

R2 interaction: a todo whose worker was live at crash time can still go `lost` under ticket 58's bound (delivery obligation) while its stream stays held (occupancy) — different obligations, no conflict; the hold resolves independently. Accuracy note: the `b097b92` commit message says "check_workers … surface the held-key fact"; in fact `check_workers` does not list holds (unknown-state workers are deliberately off-roster). The surfacing channels are the restart notice, the spawn refusal, the release note, and the programmatic `listUnknownStateHolds`.

### 2026-09-19 — closing

All six ACs closed offline. Findings §1–§3 above; remedy 4 landed and regression-pinned by `b097b92`; register row B-1 already records the fix and its divergence status. No live-only remainder: §1's in-process conclusion is code-verifiable, and §2's host-source evidence is already verified in the research register (`dsh-loop-capability-map.md:116,171`) — the live-pass lane (tickets 45/33) will exercise the behaviour incidentally but settles nothing this ticket still needs. Residual watch item, not a defect: if a non-in-process provider is ever adopted, revisit this ticket's §1 before trusting the latent-hazard analysis.
