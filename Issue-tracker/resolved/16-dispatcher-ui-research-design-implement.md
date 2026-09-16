# 16 — Dispatcher UI: research how dsh plugins present UI, then design and implement

**Blocked by:** None — can start immediately.
**Status:** resolved

## Problem

The dispatcher plugin currently "hijacks" dsh: on load it turns the primary chat into the multitask dispatcher with no UI affordances of its own — no status surface, no roster view, no opt-in/opt-out control beyond internals, and no story for coexisting with other plugins that also touch chat or settings. Tickets 01–14 gave the dispatcher a brain but no face.

## What to do

This ticket is the **umbrella** for the whole effort. Work it in phases — research first, then design/spec, then implementation. **Do not assume a fixed ticket count or shape: after the research and design phases, split the implementation into as many follow-up tickets as the evidence demands (2 or 20), create them under `Issue-tracker/open/` with blocking edges, and implement them agent-by-agent.** Each split ticket must be independently implementable and testable offline (FakeDshHost / fake seam providers — S8).

**Phase 1 — Research (cited note at `docs/research/dsh-plugin-ui-patterns.md`, per `docs/agents/research.md` conventions):**

- [x] Inventory every UI/presentation seam a dsh plugin can use, from official docs + shipped plugin source in the local profile's `node_modules` (dsh is MIT, safe to read): settings sections (we already use one — `src/adapter/settings-section.ts`), chat message rendering, commands, events/pages in the web UI (`dsh web` at `http://127.0.0.1:3080`), console output, notifications, and anything else the docs catalog exposes. For each: the registration API, lifecycle (HMR/unload safety), and whether multiple plugins can coexist on it.
- [x] For each seam, document the conflict/coexistence story: namespacing of sections/commands, what happens when two plugins claim the same slot, ordering/priority rules, and any convention the shipped plugins follow. Concrete examples from at least 2–3 shipped `@deepseek-ai/dsh-*` plugins.
- [x] Diagnose the current hijack precisely: identify exactly which registration makes the primary chat behave as dispatcher (look at `src/adapter/parent-agent.ts`, `src/adapter/dispatcher-tools.ts`, `src/plugin.ts`), and list the plausible non-hijacking alternatives the seams above allow (opt-in command, session-scoped toggle like the ticket-12 feature flag, per-chat activation, dedicated UI surface).
- [x] Recommend, with evidence, which seams the dispatcher should use for: (a) activation control, (b) worker roster/status visibility, (c) steer input, (d) access-request prompts (ties into ticket 13's relay UX). Note explicitly what is NOT possible on each seam so the design doesn't spec against a fantasy API.

**Phase 2 — Design/spec** (e.g. `.scratch/multitask-dispatcher/design-16-dispatcher-ui.md`, format of design-09…design-14): activation model ending the hijack (default-OFF / boot-as-stock-dsh is the working assumption — weigh alternatives with evidence before committing), one design answer per UI element against a verified seam, namespacing/conflict rules, new user-facing copy only (clean-room rule). Then **decide the ticket split** and create the follow-up tickets with blocking edges.

**Phase 3 — Implementation** via the split tickets: dispatcher no longer hijacks the primary chat on load; activation control composes with the ticket-12 feature flag/profile split; roster/status, steer, and access-request surfaces ship per the design; coexistence verified alongside another plugin using the same seam type; any forced architectural decision (e.g. dispatcher no longer registers as primary parent agent) recorded as an ADR in `docs/adr/` when the code lands.

## Constraints

- Research sources: official dsh docs, npm/GitHub metadata, MIT-licensed dsh plugin source only. **Never open the `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` tree.**
- Clean-room QA before shipping: grep the shipped tree for reconstruction identifiers (S7 / PRD §12); all UI copy is new.
- Tests stay offline: no network, no LLM, no running dsh (S8).

## Comments

- 2026-09-17 (agent team): Phase 1 research complete. Seam inventory + recommendations: `docs/research/dsh-plugin-ui-patterns.md` (commits 8088ff9 and this commit). Hijack diagnosis: `.scratch/multitask-dispatcher/research-16-hijack.md` (commit cbb61a9). Side finding filed as #18. Phase 2 design next.
- 2026-09-17 (agent team): Phase 2 complete. Design: `.scratch/multitask-dispatcher/design-16-dispatcher-ui.md`. Split into tickets 19 (activation lifecycle: deferred capture + /dispatcher-start + flag matrix + ADR-0009), 20 (client-face scaffold: web bundle + shell.overlay hello-world + locale namespace), 21 (worker roster/status overlay panel + data plumbing), 22 (steer input: /dispatcher-steer command + optional input.dock affordance), 23 (access-request prompt relay via host prompt seams), 24 (per-worker toolviews via tool.call.toolview), 25 (coexistence + clean-room QA close-out). Implementation proceeds per blocking edges.
- 2026-09-17 (agent team): **Umbrella resolved.** All three phases done. Phase 1 research: `docs/research/dsh-plugin-ui-patterns.md` (commits 8088ff9, e0d0ed1) + hijack diagnosis `.scratch/multitask-dispatcher/research-16-hijack.md` (cbb61a9). Phase 2 design: `.scratch/multitask-dispatcher/design-16-dispatcher-ui.md` (cf9a795) — default-OFF activation, per-session `/dispatcher-start`-style command, shell.overlay roster, `/dispatcher-steer` command, approval-seam prompts. Phase 3 via split tickets, each independently verified PASS: 19 activation lifecycle + ADR-0009 (55dcc2e), 20 client scaffold (e6bbb61), 21 roster overlay (591f234), 22 steer command (d4ea74b), 23 access prompts (38750b9), 24 toolviews (200dbfc), 25 coexistence + clean-room QA close-out (9f2c095). Side tickets 18 (worker deny-list) and 26 (test hygiene + deny-path fix) landed separately. Verification pipeline: every split ticket was implemented and then independently verified (coexistence + clean-room QA in ticket 25); current gates — typecheck clean on both configs, 514 tests passing / 0 fail, ~1.2s suite.
  - Deferred live-verification items (documented in split tickets 20-24): live-dsh verification of the client surfaces (web UI at `http://127.0.0.1:3080`) — S8 keeps tests offline, deferred with documented 4-step handovers; steer input.dock affordance (client→host wiring unverifiable offline); roster settings `update` merge-vs-replace semantics live check; toolview renderer prop face live check.
  - Pointers: design doc `.scratch/multitask-dispatcher/design-16-dispatcher-ui.md`; research note `docs/research/dsh-plugin-ui-patterns.md`; ADR `docs/adr/0009-activation-explicit-command-no-capture-on-load.md`.
