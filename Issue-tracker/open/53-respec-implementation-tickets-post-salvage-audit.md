# 53 — Re-spec and re-log the implementation tickets from the salvage audit's answer

**Status:** open — **PLACEHOLDER. Do not start. Do not claim.**
**Type:** task (planning / re-specification)
**Labels:** ready-for-human — this ticket is only *claimable* once ticket 52 is resolved, and its body must first be filled in by whoever resolves 52.
**Blocked by:** 52. Nothing here may be written, planned, or started before 52 has an `## Answer` and is moved to `Issue-tracker/resolved/`.
**Related:** ADR-0017 (the standard), 17 (the umbrella this re-specs), 33 (the merge record — closure state that may need amending), 50/51 (in-flight work whose validity depends on 52's answer)

## This file is a placeholder, on purpose

The human's instruction was to log a ticket **for the agent that completes ticket 52 to fill in**, because the shape of the work is unknown until the audit says how much of the tree is salvageable. The body below is a **contract for that agent**, not a plan. It is deliberately empty of content so that nobody implements a guess.

**If you are reading this and ticket 52 is not resolved: stop. Go do ticket 52 instead.**

## Fill-in contract

The agent that resolves ticket 52 must, in the same pass, replace the scaffold below with real content. Each section is required; leave a section present and marked `NOT YET KNOWN — needs <what>` rather than deleting it, so the gap stays visible.

### 1. Salvage verdict (from ticket 52 Q3/Q5)

How much of `src/` survives, how much adapts, how much is scrapped — the numbers from the audit, restated as the basis for everything below. No new analysis here; this section quotes ticket 52.

### 2. Deviation dispositions

One row per deviation in the register, each carried to a decision-ready state:

| Deviation | Audit verdict | Proposed action | Needs human approval? |
|---|---|---|---|
| _(from ticket 52's register)_ | | revert to reference / keep as approved deviation / keep, not core-loop | yes / no |

**Reverting is a proposal here, never an action.** Each `yes` row becomes an explicit ask to the human, with the reference behaviour and our behaviour side by side, so the approval is a real decision rather than a rubber stamp.

### 3. The new ticket set

The implementation tickets this re-spec produces, logged under `Issue-tracker/open/` with real numbers (continue from the current highest). For each:

| Field | Requirement |
|---|---|
| Number + slug | `NN-<slug>.md`, numbered onward from the existing sequence |
| Scope | One independently verifiable unit — chunked the way ticket 35 chunked the capsule, not one mega-ticket |
| Blocked by | Real edges; the frontier must be unambiguous |
| Loop stage | Which of ADR-0017's stages 1–10 it touches |
| Fidelity evidence | The behaviour note it matches, and how the match is asserted |
| Offline test | What proves it without network/LLM/running dsh (S8) |

### 4. What gets scrapped

An explicit list — paths, tests, and *tracker tickets* — that this re-spec retires, with the reason. Cross-reference ticket 33's close-out: if a shipped ticket's outcome no longer holds, say whether ticket 33's record is amended or a superseding ticket is filed. Do not silently leave the merge record claiming something we are about to undo.

### 5. Sequencing

What must land before what, and what can run in parallel. Call out any work that must be **paused** before new work starts — particularly tickets 50 and 51, whose ADR-0016 is still an unsigned draft sitting on top of a model that this re-spec may invalidate.

### 6. Tree protection before any destruction

The human floated "stash main and rebuild". Any step that removes or rewrites existing work must be preceded by a durable, pushed recovery point. Record the chosen mechanism:

- `main` is **7 commits ahead of `origin/main`** — so a rebuild without pushing first puts unmerged work at risk. Push, or tag, or branch, before anything else.
- Name the exact tag/branch, and state the restore procedure in one command.
- State the stop rule: if the destructive step fails partway, what is the recovery?

### 7. Definition of done for this ticket

This ticket is done when the sections above are filled, the new tickets are logged, and the human has been given the approval questions from §2. **It does not implement anything.** Code changes belong to the tickets it creates.

## Constraints (inherited, not optional)

- **Scribe/planner only.** This ticket produces tickets and decisions, never code.
- **Clean-room, strictly** — reference tree is behaviour evidence only; notes cite `docs/research/`, never reference source or strings (PRD §3, §8, §17; AGENTS.md legal boundary).
- **Non-destructive.** No stash/reset/rebase/branch deletion without §6 satisfied first.
- **No implementation before the log.** Per the repo rule, every implementation task this re-spec produces must exist as an issue file before it starts.
- **Tests stay offline** (S8); any live verification belongs to a live lane with the AGENTS.md kill timer set at launch.

## Acceptance criteria

- [ ] All seven sections filled — no `NOT YET KNOWN` left except where the gap is explicitly escalated to the human.
- [ ] Every deviation in ticket 52's register has a disposition row and, where needed, a written approval question.
- [ ] New implementation tickets are logged under `Issue-tracker/open/` with numbers, blockers, loop stage, fidelity evidence, and an offline test each.
- [ ] The scrap list names paths, tests, and tracker tickets, and states how ticket 33's merge record is reconciled.
- [ ] §6 names a concrete recovery point and the restore command, and confirms `main` is either pushed or tagged before any destructive step.
- [ ] Ticket 33's record and any invalidated ticket (50/51 in particular) are either amended or explicitly flagged as superseded.
- [ ] Nothing was implemented: `git status` shows tracker and research files only.

## Comments

### 2026-09-18 — scribe pass (placeholder logged, intentionally empty)

Logged from the human's instruction: *"log a ticket placeholder — to be filled in by agent that did above ticket's research: need to re-spec and re-log implementation tickets based on research result, how much we need to scrap, how much new work we need to do."*

Judgement calls recorded so the filling agent need not re-derive them:

1. **Kept as a placeholder rather than pre-scoped.** The instruction is explicit that the content depends on ticket 52's answer. Anything written here now would be a guess dressed as a plan, and a guess in the tracker is worse than a blank, because a blank is visible.
2. **Blocked by 52, hard.** Not "related to" — blocked. This ticket's body is unwritable until the audit lands.
3. **§6 exists because the human's framing included "stash main and rebuild".** That is a destructive instruction attached to a repo whose `main` is 7 commits ahead of its remote. Requiring a named, pushed recovery point before any removal is the one guard this ticket adds to the instruction rather than deriving from it.
4. **§4 forces the ticket-33 reconciliation** so a rebuild does not quietly leave the merge record asserting a fidelity we then undo — the same class of problem as the design-17 `revisit-before-merge` markers that ticket 33 exists to close.
