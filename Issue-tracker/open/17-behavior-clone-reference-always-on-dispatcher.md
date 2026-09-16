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
- [ ] Create the dedicated worktree + branch; document the workflow (what may live in the worktree vs main, merge/LQA procedure) so parallel agents don't cross wires.

**Phase 1 — Reference behavior inventory (cited note per `docs/agents/research.md`; abstract concepts only)**
- [ ] Walk the reference reconstruction and produce a concept-level behavior inventory of the always-on dispatcher: activation/lifecycle, roster presentation, worker output streaming, steer interaction, todo/milestone surfaces, permission/secret approval flows, stop/interrupt semantics, notification behavior, whatever else surfaces.
- [ ] For each behavior, note: what the user sees/does, when it appears, how it composes with the host chat, and a PRD cross-reference (S1–S9) or PRD-gap flag.
- [ ] Cross-reference with #16's verified dsh seams: for each reference behavior, which dsh seam can host it, and where dsh simply cannot reproduce it (record honestly rather than spec a fantasy).

**Phase 2 — Design/spec**
- [ ] Design doc (`.scratch/<slug>/design-17-*.md`, format of design-09…design-14): the always-on model mapped onto dsh via #16's activation/toggle decision, per-surface design answers, namespacing/coexistence rules, new copy only.
- [ ] Think like an expert software engineer weighing real UX feedback: an always-on dispatcher that can be toggled has a "what does the user come back to" problem — design the dormant/active transitions, default state, and how the toggle composes with the ticket-12 feature flag/profile split.
- [ ] Decide the ticket split; create follow-up tickets with blocking edges.

**Phase 3 — Implementation** via the split tickets, on the worktree branch, merge-gated by clean-room QA (identifier grep + provenance diff review) and offline tests (S8: core unit tests run without network/LLM).

## Constraints

- PRD is the source of truth; where the reference product's behavior and the PRD conflict, raise it as a decision rather than silently following either.
- Workers stay blank-context with no user messaging; only the dispatcher delivers to the user (S1, S5). "Always-on" applies to the *dispatcher*, not to workers addressing users.
- Todos: `completed` means delivered to user, multiple `in_progress` allowed — do not clone any contrary semantics the reference might appear to have.
- Tests stay offline: no network, no LLM, no running dsh (S8).
- Never commit into the reference folder; never treat it as the product repo.
