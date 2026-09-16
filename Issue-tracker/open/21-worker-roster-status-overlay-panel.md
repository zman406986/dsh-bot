# 21 — Worker roster/status overlay panel + data plumbing

**Blocked by:** 19 (activation lifecycle — the panel shows the activated dispatcher's roster), 20 (client-face scaffold).
**Status:** open

## Problem

The dispatcher has no status surface: the user cannot see the worker roster without asking the model. Design 16 (§4.2) specs a `shell.overlay` list entry fed by a verified-or-fallback data channel. The honest gap: the Phase-1 research verified *registration* seams, not a client↔host telemetry channel — this ticket must resolve the data path **before** building the panel.

## What to do

- [ ] **Verify the data channel first.** Known-good fallback: mirror a compact roster snapshot into the plugin's existing settings namespace (`src/adapter/settings-section.ts` — `installSection`'s owner scope exposes `get`/`watch`, research Finding 1) and read it client-side via the settings-scope inject idiom (Finding 7, worked example 3: `dsh-client-ui-agent-preset`). If integration reveals a better host→client channel, use it and record the choice. **Do not build panel UI against an unverified channel.**
- [ ] Host side: on activation (#19) and on every roster-affecting core transition (spawn, FSM change, settle, todo reconcile), publish a snapshot: worker id, title, status (core FSM vocabulary `pending`/`running`/`completed`/`error`), todo link. Keep it a projection — no new source of truth (PRD persistence rule: no second store).
- [ ] Client side: replace #20's hello-world with `RosterPanel` registered into `shell.overlay` (`id: "multitask-dispatcher-roster"`, low `order`, click-through default). Render title, empty state, stale/unavailable state, and status labels using copy from design §6 via the `multitask-dispatcher` locale namespace.
- [ ] Panel degrades honestly: snapshot stale or channel missing → "Worker status is unavailable right now." (design §6) — never a spinner that hangs.
- [ ] Pure-logic tests under `node --test`: snapshot projection from core state (FakeDshHost), stale detection, label mapping. Component rendering: build success + typecheck only (S8, no DOM harness).
- [ ] If the client face proves blocked at integration, ship the documented host-only fallback instead (status stays conversational: wake turns + `check_workers`) and record the deferral here — do not force the overlay.

## Constraints

- Offline tests only (S8): FakeDshHost / fake seams; no network, no LLM, no running dsh.
- The panel is presentation only — it never spawns/steers/stops anything; all authority stays with the bound parent agent via the core (design §3.4).
- Clean-room: all panel copy new; never open the `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` tree.
- No notifications/toast: the panel shows state only while open (research hard limits) — do not spec push.
