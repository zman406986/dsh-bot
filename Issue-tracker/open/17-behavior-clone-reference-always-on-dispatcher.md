# 17 — Behavior-clone the reference product's always-on dispatcher experience (separate worktree), UI as toggle

**Blocked by:** None — can start immediately. Coordinates with #16 (UI toggle) rather than duplicating it.
**Status:** open

## Problem / goal

The reference tree (`reference material-NOT LICENSE SAFE DONT COPY-grok bot/`) is an unofficial reconstruction of a proprietary multitask product whose dispatcher is **always-on**: the product simply *is* the dispatcher experience — roster, streaming worker output, steer box, todos, approvals — rather than a plugin bolted onto a chat app. Our current dispatcher (tickets 01–14) has the brain but a very different face: it hijacks the primary chat with no opt-in (the problem #16 was opened to fix).

The goal of this ticket: **in a separate worktree, imitate the reference product as closely as we legally can — clone all functionality and behavior, but never the code — on every part related to achieving the core always-on-dispatcher model on dsh, including UI.** The UI must be a **toggle**, not an overwrite or complete hijack of stock dsh (this is the constraint #16 is researching; #17's UI work must land through whatever activation model #16 decides).

## Why a separate worktree

Behavior-cloning work involves close, repeated comparison against the reference tree. Doing it in a dedicated worktree (off a dedicated branch, e.g. `clone/always-on-dispatcher`) keeps:

- any accidental provenance contamination quarantined away from `main`, reviewable as a whole before merge;
- the legal QA pass (S7 / PRD §12 identifier grep + diff review) a merge gate on the whole branch, not per-commit whack-a-mole;
- `main` unblocked for #16 and other parallel work.

Worktree is created with `git worktree add`, never by touching the reference folder's own `.git`.

## Legal boundary (hard constraints, PRD §8 / §12 / §17 — read first)

- **Clone behavior, not artifacts.** No copying, pasting, transliterating, or "inspired rewriting" of any source, prompts, tool strings, identifiers, or protocol artifacts from the reference tree. All shipped code, identifiers, prompts, and UI copy are new (`prompts/`-style clean-room assets).
- **Observation model:** behavior may be summarized only at the level of abstract product concepts — the kind of description the PRD already contains (actors, FSM, wake/steer, todos, milestones). Summarize what the product *does*, never transcribe *how its code says it*.
- **Do not open the reference tree while writing multitask-core modules.** Read/observe it during dedicated research passes only, write notes as abstract concept summaries, then close it and implement from the notes. An agent must never have the reference tree open and product code in the same editing session.
- Banned identifiers in shipped code: `sand`, `executor`, `MessageSubagent`, `SAND_MULTITASK_*`, etc. Clean-room grep is a ship gate.
- Where "as close as legally can" and the clean-room rule conflict, **the clean-room rule wins** — approximate the behavior with original expression and move on.

## What to do

This ticket is an **umbrella**. Per the scribe's instruction: **do not pre-decide the ticket count or shape.** The implementing agent team must first do proper research (reference behavior inventory + #16's dsh UI-seam research), then do design/spec, then split implementation into as many follow-up tickets under `Issue-tracker/open/` as the evidence demands (10, 100 — their call), each independently implementable and testable offline (FakeDshHost / fake seams — S8).

Suggested phasing (order, not scope commitment):

**Phase 0 — Setup**
- [x] Create the dedicated worktree + branch; document the workflow (what may live in the worktree vs main, merge/LQA procedure) so parallel agents don't cross wires.

**Phase 1 — Reference behavior inventory (cited note per `docs/agents/research.md`; abstract concepts only)**
- [x] Walk the reference reconstruction and produce a concept-level behavior inventory of the always-on dispatcher: activation/lifecycle, roster presentation, worker output streaming, steer interaction, todo/milestone surfaces, permission/secret approval flows, stop/interrupt semantics, notification behavior, whatever else surfaces.
- [x] For each behavior, note: what the user sees/does, when it appears, how it composes with the host chat, and a PRD cross-reference (S1–S9) or PRD-gap flag.
- [x] Cross-reference with #16's verified dsh seams: for each reference behavior, which dsh seam can host it, and where dsh simply cannot reproduce it (record honestly rather than spec a fantasy).

**Phase 2 — Design/spec**
- [x] Design doc (`.scratch/<slug>/design-17-*.md`, format of design-09…design-14): the always-on model mapped onto dsh via #16's activation/toggle decision, per-surface design answers, namespacing/coexistence rules, new copy only.
- [x] Think like an expert software engineer weighing real UX feedback: an always-on dispatcher that can be toggled has a "what does the user come back to" problem — design the dormant/active transitions, default state, and how the toggle composes with the ticket-12 feature flag/profile split.
- [x] Decide the ticket split; create follow-up tickets with blocking edges.

**Phase 3 — Implementation** via the split tickets, on the worktree branch, merge-gated by clean-room QA (identifier grep + provenance diff review) and offline tests (S8: core unit tests run without network/LLM).

## Constraints

- PRD is the source of truth; where the reference product's behavior and the PRD conflict, raise it as a decision rather than silently following either.
- Workers stay blank-context with no user messaging; only the dispatcher delivers to the user (S1, S5). "Always-on" applies to the *dispatcher*, not to workers addressing users.
- Todos: `completed` means delivered to user, multiple `in_progress` allowed — do not clone any contrary semantics the reference might appear to have.
- Tests stay offline: no network, no LLM, no running dsh (S8).
- Never commit into the reference folder; never treat it as the product repo.

## Comments

2026-09-17 — Phase 0 done (agent team). Dedicated worktree created off main @ `b00d355`: `C:\Users\TZhen\Desktop\dsh-bot-always-on` on branch `clone/always-on-dispatcher` (sibling directory, never inside the repo or the reference folder). Worktree verified self-sufficient offline: `npm ci` clean, `npm test` → 514 pass / 0 fail (146 suites), `npm run typecheck` clean. Workflow doc for parallel agent teams written at `.scratch/clone-always-on/worktree-workflow.md` (layout, what lives in worktree vs main, merge/LQA gates, hard legal rules, one-implementation-at-a-time etiquette). Doc + this ticket's Phase-0 tick delivered in one commit: `c571896`.

2026-09-17 — Phase 1 done (agent team). Behavior inventory published at `docs/research/always-on-dispatcher-behavior.md` (commit `e389325`): concept-level walk of activation/lifecycle, roster presence, streaming surfaces, steer/send-journal, todo/milestone absences, approval flows, stop semantics, notifications, adjacent surfaces — each mapped to verified #16 seams with honest gaps, plus a 9-item PRD conflicts/gaps decision list. Verification PASS: the inventory note passed the case-insensitive clean-room grep over the reconstruction codenames (PRD §8/§17) before commit and a separate contamination-free audit confirmed no reference-tree artifacts (paths, identifiers, strings) appear in the note. The reference tree was read only during the dedicated observation pass; product code was not open in that session.

2026-09-17 — Phase 2 done (agent team). Design doc committed on the clone branch: `.scratch/clone-always-on/design-17-always-on-dispatcher.md` (worktree `C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch `clone/always-on-dispatcher`, commit `9c35bf8`). Contents: always-on model reconciled with #16's activation gate (ADR-0009 kept; activated experience carries the reference feel; presence layers collapsed deliberately), per-surface answers for all nine inventory behavior areas with seams + honest gaps, all 9 PRD conflicts/gaps resolved with PRD-first defaults + documented alternatives + `revisit-before-merge` markers, clean-room en/zh copy drafts, ADR plan (ADR-0010/0011/0012), risks/live-verification handovers. Notable evidence find: `Multitask.rebuildFromDurability` has no production caller — rebuild-on-activation + honest unknown-state notice is ticket 31's core item. Ticket split (filed on MAIN, all **Status:** open):

- **#27 — Presence enrichment: snapshot v2, status dots/ring, blocked-with-reason, landed marker, activity lines** (blocked by: none)
- **#28 — Running-tasks panel: Active / Needs-you / Finished sections** (blocked by 27)
- **#29 — Streaming presentation: live-activity verification handover + toolview/wake polish** (blocked by: none to start)
- **#30 — Approval prompt UX: location line, clamped detail, session always-allow, expired/secret copy** (blocked by: none)
- **#31 — Conversational stop semantics + restart honesty (rebuild-on-activation, unknown-state notice)** (blocked by: none)
- **#32 — Dormant/activated composition polish: copy, locale, surfaces README, prompt review** (blocked by 27, 28, 30, 31)
- **#33 — Close-out: clean-room LQA gate + full-diff provenance review + merge to main** (blocked by 27–32)

Phase 3 (implementation) proceeds via those tickets, one-at-a-time in the worktree, merge-gated per the workflow doc.

2026-09-17 — **Session handover (stop-and-wrap-up mid-Phase-3).** Written to be self-contained for a fresh agent with no memory of this session.

**Epic goal.** Behavior-clone the reference product's always-on dispatcher on dsh: in the dedicated worktree, imitate every functionality and behavior we legally can — activation/lifecycle, presence and streaming presentation, steer, approvals, stop semantics, restart honesty, UI included — while cloning no code, prompts, tool strings, or identifiers. The UI lands only through ticket 16's activation model (ADR-0009: default-OFF inert, explicit per-session `/dispatcher-start`), never a hijack of stock dsh.

**State of play.** Ticket 16 is done (closed as resolved; file moved to `Issue-tracker/resolved/`, commit `b00d355`). Tickets 27 (`f09f19d`), 28 (`6874cf2`), 29 (`2054db2`) and 31 (`818d03c`) are implemented and independently verified. Ticket 30 is implemented (`0e2e9fa`), failed one verifier check (a worker-supplied wildcard target made an over-broad session always-allow row), was fixed in `7c90a25`, and the fix was independently re-verified OVERALL PASS — all other ticket-30 checks passed (lifecycle clearance of session rows, expired fencing, clamps, secrets name-only). Ticket 28's verification verdict and findings were recorded in the ticket-28 file by the same wrap-up commit as this entry; the 27/29/31 verdicts are not separately written into their ticket files (ticket 29's comment is labelled verification + implementation), so ticket 33's close-out comments should restate them alongside the hashes. **Ticket 32 is implemented at `77baef8` but NOT independently verified — that is the first thing the next session must do** (checklist in the ticket-32 file). **Ticket 33 (close-out) is NOT started.**

**Commits — worktree** `C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch `clone/always-on-dispatcher` (oldest → newest): `9c35bf8` (design-17, Phase 2), `f09f19d` (ticket 27), `2054db2` (29), `0e2e9fa` (30), `818d03c` (31), `7c90a25` (30 security fix), `6874cf2` (28), `77baef8` (32, current HEAD; unverified).

**Commits — MAIN** `C:\Users\TZhen\Desktop\dsh-bot`, branch `main` (tracker records): `a8515de` (tickets 27–33 filed), `a82634f` (ticket 27 checkoff), `a818873` (29 checkoff), `b996836` (30 checkoff), `5daf186` (30 wildcard-fix record), `bd21e23` (31 checkoff), `23ad565` (28 checkoff), `803ea88` (32 checkoff — implementation claim, verification pending).

**Tests (all offline, S8).** Counts by commit: 514 main baseline → 534 (27) → 551 (29) → 572 (30) → 582 (31) → 588 (30 fix) → 599 (28) → 612 at `77baef8` (32). The 514 setup baseline and the 599 count at `6874cf2` were independently reproduced; **only the newest claim — 612 pass / 0 fail / 162 suites at `77baef8` — is unverified.**

**What remains.** (1) Independently verify ticket 32 at `77baef8`. (2) Ticket 33's three hard merge gates from `.scratch/clone-always-on/worktree-workflow.md` §3: clean-room identifier grep over the whole `main...clone/always-on-dispatcher` diff (only allowed negative-test fixtures may hit, in `test/`); offline tests green + typecheck clean in the worktree; a full-diff provenance review recorded as a dated comment on this ticket. (3) Ticket 33's §5 `revisit-before-merge` spot-checks against the landed code, each recorded in the review comment. (4) Resolve the ADR plan explicitly instead of silently: **ADR-0012** ("Activation replays durability, never work", design-17 §9) was planned to land with ticket 31 but was never written — ticket 31 hands it to ticket 33 to file or amend the design (ticket-31 file, Deferred gaps, ≈lines 74–76); design-17 §9's **ADR-0010** (presence is a projection of core state on pull-only surfaces) and **ADR-0011** (session-scope always-allow option set) likewise do not exist (`docs/adr/` stops at 0009). Note the ADR-0010 number is doubly claimed: design-16 §9.2's conditional ADR-0010 (client data path) was deemed unnecessary by tickets 21/25, which does not by itself decide design-17's presence ADR — ticket 33 must resolve numbering and filing, not collapse the two. (5) Merge `clone/always-on-dispatcher` into `main` (squash or merge, implementer's choice; messages referencing 17.27–17.33), then `npm ci` on main and re-run the suite once. (6) Close tickets 27–33 and this ticket's Phase 3 with dated comments carrying commit hashes; never `git add -A`.

**Carried findings from verification passes (unaddressed, non-blocking).** Ticket 31's verifier noted: the activation guard's false branch is untested; the guard compares session ids rather than an activation generation counter (narrow stale-chain window on same-session re-activation); under a concurrent roster event during the marker read the gated observer can publish before the rebuild lands. Ticket 33 should either file them as a follow-up ticket or fold them into a later fix.

**Design-17 §5 `revisit-before-merge` marker status (as now known).** Closed: conflict 2 — the `todoId` chip cannot be misread as a task board; independently re-confirmed by ticket 28's verifier (evidence in the ticket-28 file). Conflict 3 — no prompt/policy asset implies a milestone view; ticket 32's prompt review found the only match is the prohibitive rule itself (ticket 33's manual copy read should re-confirm). Conflict 5 — session always-allow rows are cleared on deactivation and unload; verified under ticket 30. Still open: conflict 4 — the merge record must state that default-activation remains unadopted by choice, not oversight. Conflict 6 — before any second producer kind lands, a decision ticket must extend the wake bus, ledger, and panel vocabulary together; no second kind exists. Conflict 7 — re-raise when Phase-2 peer/room design starts (attach to ADR-0002 follow-ups). Conflict 8 — standing stop-and-raise rule if a presence field the core does not already expose is needed; no ticket has reported a missing field. Conflicts 1 and 9 also carry markers but are triggered only by future events (user-testing discovery for 1; nothing to revisit for 9); ticket 33's spot-check list names "no stop control", which covers conflict 1, and both should be recorded there.

**Read first.** Design-17 `.scratch/clone-always-on/design-17-always-on-dispatcher.md` §3 (model), §5 (conflict markers), §9 (ADR plan), §11 (ticket split) — this file lives on the clone branch/worktree, not on main; `.scratch/clone-always-on/worktree-workflow.md` §3 (merge gates) on main; `Issue-tracker/open/33-closeout-cleanroom-lqa-provenance-review-merge.md`; the ticket-32 file for the pending verification checklist.

**Standing hard rules (unchanged).** The reference folder `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` is never opened while writing product code and never committed into (it has its own `.git`); all new copy is clean-room. All tests stay offline: no network, no LLM, no running dsh (S8). Never `git add -A` — explicit paths only, in both checkouts. Workers stay blank-context and never address the user; only the dispatcher delivers (S1/S5); a todo's `completed` means delivered to the user (S6).
