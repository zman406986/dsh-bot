# 35 — Dispatcher control capsule: expandable shell-overlay UI (epic)

**Status:** open
**Labels:** needs-triage
**Blocked by:** 34 (client module materialization — nothing browser-side is visible until it lands).
**Read first:** `docs/research/dsh-plugin-ui-examples.md` (three reference plugins, pattern-only),
`docs/research/dsh-plugin-ui-patterns.md` (host-tree seam findings), design-16 §4/§5,
`.scratch/clone-always-on/worktree-workflow.md` (tree/merge rules), ticket 17 (ADR numbering note).

## Goal

One always-available control surface for the dispatcher in the dsh web client: a **floating,
expandable capsule** registered into the shipped additive `shell.overlay` list slot — the
surface we already register (tickets 20/21/24) but that never ran until ticket 34's fix.
Design and build it end-to-end: expanded panel, activation control, roster, steer, and the
dormant/activated compositions from ticket 32.

## Design direction (decided here; implementers refine, don't reopen)

**Surface: capsule, not sidebar takeover.** Better Sidebar (research Finding 1) abandoned its
own floating panel for native slots; our equivalent of that lesson: `shell.overlay` is
additive, order-sorted, click-through, and safe to stack — a takeover of the right sidebar is
not. Collapsed state = one small chip (dispatcher glyph + a status dot); expanded state = a
panel card anchored to the chip.

**Collapsed chip shows:** activation state (dormant / active / error) as dot color, worker
count when active, and a wake badge (settled workers with undelivered results) — the chip is
the glanceable presence projection.

**Expanded panel sections (top to bottom):**
1. **Activation row** — the on/off switch. Reflects the real per-session `/dispatcher-start`
   state (ADR-0009); its button calls the same command path, it must not invent a second
   activation channel. Dormant: single "Start dispatcher in this chat" affordance. Active:
   stop affordance + since-timestamp.
2. **Roster** — one row per worker: FSM status, title, elapsed, and a per-row steer affordance
   (opens the steer input). Follows ticket 28's running-tasks sectioning (running / settled /
   undelivered buckets from the reconciler view model).
3. **Deliverables line** — count of todos `completed`-but-not-`delivered` (S6 semantics:
   delivered means the user got it) with the most recent result text, expandable.
4. **Tool views** — NOT in the capsule: the five dispatcher tool-call views stay keyed in
   `tool.call.toolview` (ticket 24) where the calls happen; the capsule links to the latest.
5. **Footer** — profile/flag provenance line (which profile, flag state) and a link into
   Settings; nothing editable inline in v1.

**Honesty rules (binding):** every element renders from core state (the roster snapshot via
the settings-mirror channel — design-16 §4.2's documented fallback); no invented push channel,
no fake status. The dormant composition (ticket 32) is the unactivated chat's whole experience:
chip visible, panel shows the activation pitch, nothing else pretends to run.

**Locale:** all copy through the `multitask-dispatcher` namespace ({en, zh}) — no literals.

## Process requirements (binding on the implementing team)

1. **This epic must brew tickets and draft ADRs — do not implement it as one blob.** Spawn
   small, granular child tickets (one surface section or one concern each), each with its own
   acceptance criteria, filed under `Issue-tracker/open/36-*`, `37-*`, ... as needed.
2. **ADR plan (draft, non-human-approved):** file the decisions this epic makes as ADRs under
   `docs/adr/`, numbered continuing from the current sequence, **with the suffix
   `-draft-nonhuman-approved` in the file name and an `**Approval:** non-human — agent-drafted,
   pending human sign-off` header line**. Expected at minimum: capsule-vs-sidebar slot choice;
   client-bundle materialization requirements (what `dsh.client.inject` sets a plugin must
   declare); real-browser testing infra choice (Playwright). Respect ticket 33's open ADR
   numbering conflict (design-16's conditional ADR-0010 vs design-17's presence ADR) — resolve
   the numbers explicitly in the draft headers, don't collide.
3. **Full flow per chunk:** design note → review pass (separate agent from the implementer) →
   implement → **Playwright real-browser test** (mount smoke test against a
   `dsh --profile web --patch` launcher boot; research Finding 1 shows the pattern —
   `test:mount`-style). No chunk is done on unit tests alone.
4. **No single subagent implements everything:** dispatch so that design, review,
   implementation, and test authorship rotate across agents; the epic closes only when every
   child ticket has an independent verification comment.
5. **Clean-room:** the three reference plugin repos are pattern references only (mixed
   licenses; one flagged) — never vendor, transliterate, or name-match their code or assets
   (legal boundary per AGENTS.md; `docs/research/dsh-plugin-ui-examples.md` header).
6. **Tree:** implementation rides the ticket-17 worktree
   (`C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch `clone/always-on-dispatcher`) if ticket
   33's merge has not landed yet; otherwise on `main` after the merge. Tracker records stay on
   `main` either way (worktree-workflow §2).

## Acceptance criteria (epic-level)

- [ ] Ticket 34 landed; capsule visible in a real browser on a launcher boot, dormant and
      activated compositions both exercised, Playwright-asserted.
- [ ] All child tickets implemented, reviewed by a different agent than wrote them, and
      independently verified; Playwright suite green offline-only where possible (browser
      local, no network/LLM — S8 constraint interpreted in the ticket comments).
- [ ] Draft ADRs filed with the non-human-approved marking; ticket 33's numbering conflict
      addressed in their headers.
- [ ] Offline unit suite (`npm test`) still 0-fail; no regression in the host face.
- [ ] Epic close-out comment lists every spawned ticket + ADR with hashes.
