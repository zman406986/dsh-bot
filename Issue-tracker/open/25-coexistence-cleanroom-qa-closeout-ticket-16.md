# 25 — Coexistence + clean-room QA close-out for #16

**Blocked by:** 19, 20, 21, 22, 23, 24.
**Status:** open

## Problem

Ticket 16's Phase 3 requires coexistence verified alongside another plugin using the same seam type, and the repo's ship gate is clean-room QA (S7 / PRD §12). Design 16 (§5) defined the namespacing/conflict rules; this ticket proves them and closes out #16.

## What to do

- [ ] **Offline coexistence tests:** on the fake seam providers, prove the plugin's registrations coexist with a second fake plugin on the same seam types — duplicate settings namespace / command name / slot entry id each fail loud and do not corrupt the first claimant (Finding 1 `settings namespace "X" is already registered`; Finding 2 duplicate command throw; Finding 5 list-slot additivity). Namespaced names per design §5 (`multitask-dispatcher` namespace, `dispatcher-` commands, `multitask-dispatcher-` entry ids).
- [ ] **Dormant-state coexistence:** flag ON + not activated = stock experience: no capture on session-start, no policy inject, stock tool surface (asserts the #19 contract end to end at the plugin boundary).
- [ ] **Clean-room grep (S7 / PRD §12):** run the banned-identifier grep over the shipped tree (excluding the reference folder): `grep -rinE "sand|MessageSubagent|SAND_MULTITASK|executor-as-codename-context"` — judge hits: ordinary English words are fine; reconstruction codenames are a fail. Record the command and result in the ticket comments. Grep the new UI copy too — all strings must originate in design §6 / the tickets.
- [ ] **Full suite offline green** (`node --test` via tsx): no network, no LLM, no running dsh — including #18's deny-list tests if that ticket has landed (independent; if not landed, note it and proceed — do not block on it).
- [ ] **ADR completeness:** confirm `docs/adr/0009-*` exists and the ADR index is updated (from #19); confirm any ADR-0010 decision from #21 (client data path) is recorded or explicitly deemed unnecessary per design §9.
- [ ] **Design-vs-shipped drift log:** list every place the shipped implementation deviated from design 16 (names, seams, fallbacks used) in the ticket comments, and tick the corresponding Phase-3 items on #16.
- [ ] Close-out comment on #16 summarizing: activation model shipped, surfaces shipped/deferred, fallbacks used, verification results.

## Constraints

- Offline only (S8); the "coexistence alongside another real plugin" live check is documented as a follow-up manual step, not run here (no running dsh in CI/tests).
- Never open the `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` tree; never commit into it.
- No new features in this ticket — verification and close-out only; anything broken found here gets its own ticket.
