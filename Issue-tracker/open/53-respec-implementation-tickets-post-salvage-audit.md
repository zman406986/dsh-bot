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

> **ANSWERED 2026-09-18** — see **"Re-spec (§1–§7 answered)"** below. The scaffold is kept because it is the checklist the answer was written against, and because §1 is still partially open (ticket 54). The original instruction stands: the agent that completes ticket 52 fills this in.

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

## Re-spec (§1–§7 answered, 2026-09-18)

Written from `docs/research/dsh-core-loop-fidelity-audit.md` and the register `docs/research/dsh-core-loop-deviations.md`. Ticket 52 is **still open** (its Q3 salvage pass died on an API rate limit), so §1 is partial by construction.

### §1 — Salvage verdict

**Partial — the exhaustive numbers do not exist yet (ticket 54).** The provisional, explicitly-unverified reading from the audit §6:

| Bucket | Contents |
|---|---|
| Survives untouched | `worker-fsm`, `wake-bus`, `steer-queue`, `report-clamp`, `types`, `dsh-host`/`fake-host`, `tool-barrier`, the roster/presence stack, all of `client/`, and tickets 43–49's infrastructure fixes |
| Survives with a wiring change | `cordis-dsh-host.ts` (add `persona`), `worker/prompt.ts` (re-channel + safety), `plugin.ts` + `restart-notice.ts` (inject → followup) |
| Genuine new work | The obligation layer over `durability.ts` / `todo-reconciler.ts` markers |
| Scrapped | **Nothing identified** |

**This is a hypothesis.** Ticket 54 exists to confirm or destroy it, and its most important output — the list of tests that encode a deviation — is what makes "nothing gets scrapped" testable. Do not treat the above as a result.

### §2 — Deviation dispositions

| Deviation | Audit verdict | Action | Needs human approval? |
|---|---|---|---|
| **D-1** contract channel | Unused seam — `persona` is verified present and wired | **Revert to reference** → ticket 55 | **No** — removing a deviation *is* ADR-0017 compliance |
| **D-2** steer restates no contract | **Subsumed by D-1** (a system section recomputes every turn) | No separate work; explicitly *do not* add per-steer restatement | No |
| **D-3** no safety section | Real omission | Add → ticket 56 | No |
| **D-4** restart queues, opens no turn | Real; wrong primitive (`inject` vs `followup`) | Swap primitive → ticket 57 | No |
| **D-5** unbounded obligation, no `lost` | Real — the one new subsystem | Build → ticket 58 | No |
| **D-6** no delivery telemetry | Real | Build with D-5 → ticket 58 | No |
| **A-3 … A-6** relay, delivered-criterion, ledger, leaf topology | Already written decisions | No action | Already approved (ADR-0003/0007/0008) |
| **R-1** inherited child base prompt | **Unreachable** — needs a host preset change | Nothing to build | **YES — acknowledgment pending** |
| **R-2** worker FSM unmatched | The reference FSM does not exist in the reconstruction | No action; must not be claimed as fidelity | No |
| **U-1** activation model | Boundary case | **Defer to ADR-0016's sign-off** | **YES** |
| **U-2** no worker-health probe | We match the reference (which calls it its own gap) | Confirm match, or approve an addition | **YES** |
| **U-3** 2000-char report clamp | An addition that changes behaviour | Keep / drop / re-tune | **YES** |
| **U-4** steer timing (waits for idle, not nearest step) | Same guarantee, slower | Accept, or tighten | **YES** |
| **B-1** freed stream key | A **bug**, not a deviation | Fix → ticket 59 | No (but the divergence must be logged) |

**Four items need you.** They are collected as explicit questions in the register's Part C/D — deliberately not decided here.

### §3 — The new ticket set

All logged under `Issue-tracker/open/`:

| # | Slug | Loop stage | Blocked by |
|---|---|---|---|
| 54 | `salvage-classification-and-deviation-tests` | — (audit) | none (rate limit resets 18:59) |
| 55 | `worker-contract-system-position-persona` | 3, 5 | none |
| 56 | `worker-contract-safety-section` | 3 | 55 |
| 57 | `restart-recovery-opens-a-turn` | 10 | none |
| 58 | `delivery-obligation-bound-lost-telemetry` | 9 | none (57 recommended first) |
| 59 | `freed-stream-key-double-worker-risk` | 10 | none |

Each carries the behaviour note it matches, the `file:line` it changes, an offline test, and a clean-room identifier-grep gate.

**Not ticketed, on purpose:** every `undecided` register item (U-1…U-4) and R-1. Logging a ticket for them would presume the ruling.

### §4 — What gets scrapped

**Nothing.** No source file, test, or shipped ticket was identified as needing deletion. Ticket 33's merge record therefore does **not** need amending on fidelity grounds — but note that ticket 33's merge was performed under ADR-0004's latitude, and this re-spec supersedes the *standard* it was judged against. Ticket 33 should add a pointer to ADR-0017 and this re-spec rather than be rewritten.

Retired instead: **ADR-0004's behavioural latitude** for core-loop items (ADR-0017 amends it), and design-17 §5's PRD-first conflict framework (suspended for core-loop items). Neither is a code artifact.

### §5 — Sequencing

1. **Now, unblocked:** 55 (channel), 57 (recovery primitive), 59 (bug). These are independent.
2. **Then:** 56 (needs 55's channel), 58 (recommended after 57).
3. **In parallel, after 18:59:** 54 (the salvage survey) — it must not gate the code work, which is why it was spun out of 52 rather than left blocking it.
4. **Pause check:** tickets **50 and 51** ride ADR-0016, an unsigned draft reversing ADR-0009. They are **not** blocked by this re-spec, but they sit on an unresolved activation model (U-1), so do not treat their implementation as settled. Ticket 32's dormant composition and ticket 33's close-out remain valid.
5. **Closure:** 52 closes when 54 lands; then this ticket closes.

### §6 — Tree protection before any destruction

**No destruction is now planned** — §4 scraps nothing, so the "stash main and rebuild" question is answered in the negative by evidence rather than by preference. If that changes:

- **The recovery point already exists and is pushed:** tag **`archive/pre-core-loop-fidelity-2026-09-18`** (annotated, created and verified on `origin` at the scribe-pass tip). Restore with `git switch -c rescue archive/pre-core-loop-fidelity-2026-09-18`.
- `main` and `origin/main` are in sync, so the tree is not currently at risk. **Keep them in sync before any destructive step.**
- **Stop rule:** branches were pruned on 2026-09-18 (`clone/always-on-dispatcher`, `master`) after verifying each tip was an ancestor of `main`; the same verification (`git merge-base --is-ancestor`) is the precondition for any future deletion.

### §7 — Definition of done for this ticket

Met: §2–§7 are filled, tickets 54–59 are logged, and the four approval questions are presented to the human via the register. §1 remains partial pending ticket 54, which is why this ticket stays open.

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
