# 29 — Streaming presentation: live-activity verification handover + toolview/wake polish

**Blocked by:** None to start (the verification half is independent; the snapshot-dependent polish lands after 27).
**Status:** open

## Problem

The reference surfaces running work ambiently (activity lines, per-tool collapsible rows) and deliberately never streams worker transcripts to the user — results arrive as the agent speaking (inventory §3). Our face already matches the big strokes (wake turns + five toolviews). Two gaps remain: (1) the core's `recent_activity` check-row field is fed by an optional `recentActivity` resolver (`src/core/tools.ts:72`) that the adapter **never implements**, so live activity text is always null in practice; (2) whether dsh exposes any live child-session step/tool event to a plugin is unverified. Design: `.scratch/clone-always-on/design-17-always-on-dispatcher.md` §4.3 (worktree).

## What to do

Implementation lands in the worktree checkout `C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch `clone/always-on-dispatcher`, one ticket at a time per `.scratch/clone-always-on/worktree-workflow.md`.

- [ ] **Live-verification handover first (read-only on dsh, never the reference tree):** survey the installed `@deepseek-ai/*` packages (WinGet install path recorded in `docs/research/dsh-plugin-ui-patterns.md` Finding 0) for a child-session/worker event surface a plugin can subscribe to (agents/subagents services, session events, job progress). Write findings as a dated comment on THIS ticket: seam found (with file/line) or verified-absent.
- [ ] If a seam is verified: implement a `recentActivity` resolver in `src/adapter/cordis-dsh-host.ts` (per-worker latest activity phrase, clamped with `CHECK_ACTIVITY_CHARS`), wire it into the dispatcher-tool deps, and mirror it into snapshot v3-or-later ONLY via the design-17 conflict-8 rule (projection of host-observed truth; raise on the ticket before any schema bump).
- [ ] If no seam: record the honest gap (derived activity lines from ticket 27 remain the answer; live text stays impossible) — do not fake liveness from polling or timers.
- [ ] Toolview polish (`src/client/toolviews.ts` / `toolview-panel.tsx`): render `recent_activity` on `check_workers` rows when present; keep the 160-char clamp and verbatim-vocabulary contracts unchanged.
- [ ] Wake-turn delivery polish (`src/adapter/wake-copy.ts` / `src/core/policy/assembler.ts`): confirm settle notices read as ordinary narration (no "worker console" jargon, no machinery leakage per PRD §6.1); tighten only with new copy — no behavioral change to the wake path.
- [ ] Explicit non-goals, asserted by a comment on this ticket (not code): no worker-transcript streaming surface, no timeline housekeeping cards (new chat node types are impossible — closed keyed domain, seams Finding 5), no result cards (results are the dispatcher speaking, S4/S5).
- [ ] Offline tests (S8): resolver clamp/null behavior (if implemented), toolview activity-row parsing, wake-copy snapshot tests for the polished strings; full suite green, typecheck clean.

## Constraints

- Offline tests only (S8); the dsh package survey is read-only on the INSTALLED dsh (MIT) — never on `reference material-NOT LICENSE SAFE DONT COPY-grok bot/`.
- Clean-room copy only; no polling/fake-liveness fallbacks.
- The wake path's semantics (drain, reconcile, dedupe) are frozen — presentation-only changes; anything else goes back to design.
- Implementation one-at-a-time in the worktree; the verification handover comment lands on MAIN.
