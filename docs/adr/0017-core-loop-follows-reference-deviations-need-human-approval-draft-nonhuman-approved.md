# The core loop follows the reference; every deviation needs written human approval

**Status:** draft

**Approval:** non-human — agent-drafted from the human's 2026-09-18 directive, pending human sign-off

**Numbering:** 0017, the next free number. 0010–0012 remain reserved to design-17 §9's ADR plan, and 0013–0016 are filed (capsule epic, ticket 50/51 scribe pass). This draft collides with neither set. Filed as part of the scribe pass that logged tickets 52 (the salvage audit) and 53 (the re-spec).

**Amends if accepted:** ADR-0004 (the reference is an inventory source, not a build list). **Suspends if accepted:** design-17 §5's PRD-first conflict-resolution framework, for core-loop items only. **Interacts with:** the in-flight ADR-0016 (draft) and ADR-0009 (accepted) — both touch activation, which is a boundary case here (open question 4).

For the **core loop**, the reference product is **binding specification**, not a feature inventory. Where our implementation of the core loop differs from what the reference does, the difference is a **deviation**. A deviation may exist only with **explicit written human approval**; absent that approval, the implementation must be changed to match the reference.

## Context

- **The directive.** 2026-09-18, from the human: "core loop must follow reference's footsteps, any deviation must have human approval", in the same breath as "we probably need to stash main and rebuild to reclaim features missing in our previous implementation." The human reached this after commissioning two comparisons (below) and reading their results.
- **The comparison evidence that triggered it.** Two research notes were purpose-built to compare us against the reference and both found real divergence rather than parity:
  - `docs/research/reference-agent-prompt-inventory.md` — the reference builds its worker contract as a **system prompt** through a dedicated subagent runner, interpolating the role name into one sentence plus a fixed behavioural block, a conditional readonly line, and **one shared safety section constant**, with `canSendMessage: false` carried in the assembled prompt (note L2 and Appendix B:170). We deliver our (richer) contract as **conversation-role content** and have never verified what base system prompt a spawned child actually carries.
  - `docs/research/reference-agent-lifecycle.md` — the reference has an acknowledgement-obligation controller with a bounded redrive loop and a terminal `lost` record, plus delivery-path telemetry (`delivered` / `superseded` / `dropped`). Its own closing line concedes: "No semantic similarity comparison against our own design was performed" (note:174). That comparison was then done in-conversation on 2026-09-18 and returned three real gaps plus one new risk (the deviation table below).
- **ADR-0004 (accepted) is the decision being amended.** It held that the reference is "an **inventory source of features**, not an automatic build list", and that reference behavior is only "the tiebreaker" once a feature is adopted. That is precisely the latitude under which the deviations below were introduced without escalation: each was defensible as a design improvement, and each was therefore made silently.
- **The latitude was used deliberately, not accidentally.** design-17 §3 answers the always-on model against ADR-0009 and records that "presence layers [were] collapsed deliberately"; design-17 §5 resolves nine PRD-vs-reference conflicts with "PRD-first defaults" plus `revisit-before-merge` markers. Nothing in that process asked the human whether a better-than-reference behaviour was acceptable. This ADR makes that question mandatory.
- **What changed in the human's model.** The earlier product goal (S1–S9) treated the reference as inspiration to be filtered. The new goal is **fidelity**: the reference's loop is the specification, and our job is to reach it as closely as the clean-room rule allows. Feature-improvement is now a *request*, not a *discretion*.
- **The clean-room rule is untouched and outranks fidelity.** AGENTS.md's hard legal boundary and PRD §3/§8/§17 stand exactly as written: no copying, transliterating, or "inspired rewriting" of source, prompts, tool strings, identifiers, or protocol artifacts. Where "as close as legally can" and clean-room conflict, **clean-room wins** — an unattainable behaviour is an *approved deviation by necessity*, recorded as such, never an excuse to paraphrase. This ADR changes *what we target*, never *what we may read or reuse*.
- **The authority for "what the reference does" is our notes, not the tree.** The reference tree is behaviour evidence only, read in dedicated observation passes and summarized at concept level. The named notes are the citable source: `always-on-dispatcher-behavior.md`, `reference-agent-lifecycle.md`, `reference-agent-prompt-inventory.md`, `reference-behavior-notes.md`, `prd-vs-reference-capability-gaps.md`. No deviation may be asserted or dismissed from the tree directly.
- **Precedent for this ADR's shape.** Agent-drafted, not-yet-human-approved decisions are filed with the `-draft-nonhuman-approved` suffix and an `**Approval:**` header (ADR-0013–0016, ticket 37). This draft follows that convention. Mirrored from ADR-0016: the reversal of an accepted ADR still lands as a **draft** until the human signs the *text*.

## What "the core loop" means here

The core loop is the mechanism by which a user request becomes work and the result returns to the user. Concretely, its stages:

1. **Intake** — a user message becomes a dispatcher turn.
2. **Triage** — answer inline, or dispatch.
3. **Spawn** — a worker is created with its contract (blank context, no user channel, self-contained brief, leaf topology).
4. **Concurrency** — independent work runs in parallel streams, one worker per stream.
5. **Steer** — a mid-run correction reaches the worker with context preserved, without restarting it.
6. **Stop** — abort is silent and final; a late result is dropped.
7. **Settle → wake** — completion/error/abort becomes a dispatcher wake, deduped and coalesced.
8. **Reconcile + deliver** — todos are reconciled on the wake, and `completed` means **delivered to the user**.
9. **Obligation** — what happens when a settled result is never delivered, and how that is bounded.
10. **Restart** — what survives a process restart, and how the dispatcher is told.

Out of scope for this ADR: presentation surfaces and visual parity (AGENTS.md non-goals), the Phase-2 peer tier, hosting names, and everything dsh owns (inference, transcript, tool runtime, session store). Delivery *is* in scope where it is stage 8 — the channel by which the user receives the result — but not the widget that renders it.

## The deviations currently on the books

Inputs to the decision, not an exhaustive register — ticket 52 must re-derive the full list and the register itself. Line references are as read during the 2026-09-18 comparison pass and **must be re-verified before anything is acted on**.

| # | Deviation | Where (as read) | Reference behaviour |
|---|---|---|---|
| D-1 | The worker contract is delivered as conversation-role turn content — as the child's **first user turn** — rather than in a system position | `src/adapter/cordis-dsh-host.ts:534-544`, `src/worker/prompt.ts` | Contract built as a system prompt by a dedicated subagent runner; `canSendMessage: false` in the assembled prompt |
| D-2 | A steer restates only the correction frame, never the contract | `src/core/steer-queue.ts`, `wrapParentCorrection` | The subagent prompt is re-composed every turn |
| D-3 | No shared safety section in the worker contract | `src/worker/prompt.ts` | One shared safety section constant appended to every subagent prompt |
| D-4 | No boot redrive — activation rebuilds and injects a notice but opens no turn | `src/plugin.ts:414–432` (`rebuildFromDurability` → `injectNotice`) | Recovery work is actively driven on boot |
| D-5 | The delivery obligation has no bound and no `lost` state; an `in_progress` item whose worker settled undelivered is never pruned and never escalated | `src/core/todo-reconciler.ts:187–211` (prune fires only on `completed && delivered`) | Bounded redrive loop, then a terminal `lost` record |
| D-6 | No delivery-path telemetry (`delivered` / `superseded` / `dropped` + reason) | doc comments only | Records the disposition and the reason |

**Separately flagged, not a fidelity deviation:** `rebuildFromDurability` frees a live-at-crash worker's stream key while that worker may still be alive on the host with no retained interrupt handle (`src/core/multitask.ts:640–654`). Re-dispatching the freed key yields **two live workers on one logical stream** — the exact condition one-worker-per-stream exists to prevent. This is a bug, not a deviation; it needs its own ticket either way.

> **Register now live (2026-09-18).** The table above was written as *inputs* to this decision. The maintained register — with a disposition and an approval field per item, plus the items this table missed (additions we have and the reference lacks, and the unreachable-by-necessity residuals) — now lives at **`docs/research/dsh-core-loop-deviations.md`**, alongside the audit that justifies each row: **`docs/research/dsh-core-loop-fidelity-audit.md`**. Two findings already changed this table's content rather than its decision: D-1 is an **unused seam** (`persona`), not a structural impossibility — so it is `to-be-removed`, not a deviation to approve — and D-2 is **subsumed by D-1**, because a system-prompt section is recomputed every turn. The deviations that genuinely need the human are the unreachable residuals and the activation boundary (register Part C/D).

## Considered options

| Option | Rejected/kept because |
|---|---|
| **A. Reference behaviour is normative for the core loop; deviations exist only by written human approval (the directive)** | **Chosen.** Makes fidelity auditable, converts silent discretion into an explicit ask, and gives the salvage audit (ticket 52) a single objective standard to measure against. |
| B. Keep ADR-0004's "inventory, not a build list" latitude (status quo) | Rejected by the directive. It is what produced D-1…D-6 as undocumented design choices with per-item rationales that no human ever weighed as a set. |
| C. Full behavioural parity across the whole product | Rejected: contradicts AGENTS.md's non-goals (no dsh inference/transcript/tool-runtime rebuild, no binary or UI parity) and re-opens capabilities the human already declined. The rule binds the **core loop**, not the product. |
| D. Parity where legal, free rein where dsh makes it impossible | Rejected as a *silent* rule: it is the same discretion in a new costume. Kept as a **reporting** rule — an unattainable behaviour is an approved-by-necessity deviation, named and dated, never assumed. |
| E. Freeze the loop and grandfather shipped surfaces | Rejected as the default. Whether shipped surfaces are re-opened retroactively is a real question, but the default must be **in scope**; grandfathering is the exception that needs approval, not the baseline (open question 3). |

## Consequences

- **A deviation register becomes a shipping artifact.** Every known deviation is listed with its disposition — `approved` (with the approval's date and who gave it), `to-be-removed`, or `undecided` — and no new deviation may be introduced without a written approval. Proposed home: `docs/research/dsh-core-loop-deviations.md`, owned by ticket 52 and maintained thereafter. Scope is decided by ticket 52; the *existence* of the register is decided here.
- **design-17 §5's framework is suspended for core-loop items.** Its nine "PRD-first default + `revisit-before-merge`" resolutions may not be re-applied to the core loop. Where the reference and the PRD conflict inside the loop, the conflict is now a **deviation requiring human approval** — resolving it in the PRD's favour is no longer something the implementation team may decide alone. This is the sharpest consequence of this ADR and the one most likely to be contested.
- **ADR-0004's scope authority survives; its behavioural lateness does not.** *Which* features the product contains is still decided against the product goal and S1–S9 (remote computer use, sandbox, and the other declined capabilities stay declined). *How* the core loop behaves, once in scope, is now the reference's call.
- **Clean-room discipline must be restated wherever fidelity is discussed**, or this ADR becomes a legal hazard: "follow the reference's footsteps" is a target, not an observation licence. Every note in `docs/research/` is still concept-level abstraction; the tree is still never open in a session that also has product code open.
- **Fidelity claims need citations.** Any ticket that closes a core-loop surface must cite the behaviour note it matched and state its deviation status. An unsourced "matches reference" is not evidence.
- **Rebuild is authorized in principle but not by this ADR.** This ADR sets the standard; it does not decide what to scrap. Tickets 52 (audit) and 53 (re-spec) carry the plan, and ticket 53 must protect the existing tree before anything is destroyed — `main` is currently 7 commits ahead of `origin/main`, so a "stash and rebuild" would put unmerged work at risk.
- **Ticket 17's umbrella is affected.** Its Phase-2 note that "presence layers [were] collapsed deliberately" and its Phase-3 tickets (27–33) were built under the latitude this ADR removes. The audit must state, per shipped ticket, whether the result survives.
- **Tracker effects.** Tickets 52 and 53 are filed under `Issue-tracker/open/`. This draft must be signed off, or amended to match what actually ships, before ticket 53's new ticket set is treated as binding.

## Open questions (not decided here)

| # | Question | Where it must be decided |
|---|---|---|
| 1 | Is the core-loop boundary as stage 1–10 above correct, and where exactly does presentation end and delivery begin? | Human sign-off on this ADR |
| 2 | What form does an approval take — per-deviation, blanket by category, or a standing list the human edits? And where is it recorded? | Ticket 52 (deviation register) |
| 3 | Do already-shipped surfaces (tickets 17.27–17.33) get re-opened retroactively, or does the rule bind only new work? | Ticket 52, then ticket 53 |
| 4 | Is **activation** (ADR-0009 accepted, ADR-0016 draft) part of the core loop? The reference is always-on with no activation step; ADR-0009 required an explicit command and ADR-0016 removes it. | Human, folded into ADR-0016's sign-off |
| 5 | Does "deviation" include an addition the reference lacks (e.g. our extra 2000-char report clamp), or only an omission/alteration? An addition that changes behaviour is still a deviation. | Ticket 52 |
| 6 | How is fidelity measured — per stage, per note citation, or as a scored checklist? Ticket 52 must propose a method that is checkable offline. | Ticket 52 |

## Traceability

| Source | Section |
|---|---|
| Human directive, 2026-09-18 ("core loop must follow reference's footsteps…", "stash main and rebuild") | Header, Context ¶1, Considered options A |
| `reference-agent-prompt-inventory.md` (L2, Appendix B:170; legal rule at :80) | Context ¶2, deviation D-1/D-3, Consequences ¶4 |
| `reference-agent-lifecycle.md` (:131, :162, :174) | Context ¶2, deviations D-4/D-5/D-6 |
| In-conversation comparison, 2026-09-18 (prompt inventory + lifecycle vs `src/`) | Deviation table, orphan-stream-key flag |
| ADR-0004 (accepted) | Header, Context ¶3, Considered options B |
| ADR-0005, ADR-0006, ADR-0007, ADR-0008, ADR-0009, ADR-0016 | Context ¶3/¶5, Consequences ¶2, Open question 4 |
| design-17 §3, §5, §9 | Context ¶4, Consequences ¶2 |
| AGENTS.md legal boundary; PRD §3, §8, §12, §17, S1–S9 | Context ¶6, Consequences ¶3, ¶6 |
| Ticket 17 (umbrella), tickets 27–33 (shipped under the old latitude) | Context ¶4, Consequences ¶7 |
