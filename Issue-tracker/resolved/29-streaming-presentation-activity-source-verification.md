# 29 — Streaming presentation: live-activity verification handover + toolview/wake polish

**Blocked by:** None to start (the verification half is independent; the snapshot-dependent polish lands after 27).
**Status:** resolved

## Problem

The reference surfaces running work ambiently (activity lines, per-tool collapsible rows) and deliberately never streams worker transcripts to the user — results arrive as the agent speaking (inventory §3). Our face already matches the big strokes (wake turns + five toolviews). Two gaps remain: (1) the core's `recent_activity` check-row field is fed by an optional `recentActivity` resolver (`src/core/tools.ts:72`) that the adapter **never implements**, so live activity text is always null in practice; (2) whether dsh exposes any live child-session step/tool event to a plugin is unverified. Design: `.scratch/clone-always-on/design-17-always-on-dispatcher.md` §4.3 (worktree).

## What to do

Implementation lands in the worktree checkout `C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch `clone/always-on-dispatcher`, one ticket at a time per `.scratch/clone-always-on/worktree-workflow.md`.

- [x] **Live-verification handover first (read-only on dsh, never the reference tree):** survey the installed `@deepseek-ai/*` packages (WinGet install path recorded in `docs/research/dsh-plugin-ui-patterns.md` Finding 0) for a child-session/worker event surface a plugin can subscribe to (agents/subagents services, session events, job progress). Write findings as a dated comment on THIS ticket: seam found (with file/line) or verified-absent.
- [x] If a seam is verified: implement a `recentActivity` resolver in `src/adapter/cordis-dsh-host.ts` (per-worker latest activity phrase, clamped with `CHECK_ACTIVITY_CHARS`), wire it into the dispatcher-tool deps, and mirror it into snapshot v3-or-later ONLY via the design-17 conflict-8 rule (projection of host-observed truth; raise on the ticket before any schema bump).
- [ ] If no seam: record the honest gap (derived activity lines from ticket 27 remain the answer; live text stays impossible) — do not fake liveness from polling or timers. *(conditional — not triggered: a seam was verified, see comment)*
- [x] Toolview polish (`src/client/toolviews.ts` / `toolview-panel.tsx`): render `recent_activity` on `check_workers` rows when present; keep the 160-char clamp and verbatim-vocabulary contracts unchanged.
- [x] Wake-turn delivery polish (`src/adapter/wake-copy.ts` / `src/core/policy/assembler.ts`): confirm settle notices read as ordinary narration (no "worker console" jargon, no machinery leakage per PRD §6.1); tighten only with new copy — no behavioral change to the wake path.
- [x] Explicit non-goals, asserted by a comment on this ticket (not code): no worker-transcript streaming surface, no timeline housekeeping cards (new chat node types are impossible — closed keyed domain, seams Finding 5), no result cards (results are the dispatcher speaking, S4/S5).
- [x] Offline tests (S8): resolver clamp/null behavior (if implemented), toolview activity-row parsing, wake-copy snapshot tests for the polished strings; full suite green, typecheck clean.

## Constraints

- Offline tests only (S8); the dsh package survey is read-only on the INSTALLED dsh (MIT) — never on `reference material-NOT LICENSE SAFE DONT COPY-grok bot/`.
- Clean-room copy only; no polling/fake-liveness fallbacks.
- The wake path's semantics (drain, reconcile, dedupe) are frozen — presentation-only changes; anything else goes back to design.
- Implementation one-at-a-time in the worktree; the verification handover comment lands on MAIN.

## Comments

### 2026-09-17 — agent team (verification + implementation, worktree `clone/always-on-dispatcher` @ `2054db2`)

All checkboxes done except the conditional "if no seam" branch (not triggered — a seam WAS
verified). `npm test` 551 pass / 0 fail (baseline 534 / 0; +17 new), `npm run typecheck` clean on
both configs, offline only (S8). Worktree commit: `2054db2` ("Stream live worker activity into
check rows (ticket 29)"), 8 files. Read-only survey of the INSTALLED `@deepseek-ai/*` packages
only (WinGet path per seams Finding 0); the reference tree was never opened.

**Verification result: seam FOUND — a plugin-subscribable live child-session event surface exists.**

- `session/event` is a declared global Cordis event `(session, event)`:
  `@deepseek-ai/dsh-session` `lib/types/index.d.ts:62`. It is emitted synchronously per committed
  session event from the sessions registry's app-level ctx (`dsh-session`
  `lib/index.js:1202` via `invokeContainedSessionObservers`; `emitCtx: this.ctx` at
  `lib/index.js:1437`).
- Scope routing admits untagged (plugin-level) listeners and enclosing scopes:
  `@deepseek-ai/dsh-scope` `lib/index.js:327-347` (`scopeTarget`) — "a listener owned by an
  enclosing scope receives every descendant scope's events … events flow up the chain, never
  down". In-process worker child sessions (`dsh-subagent-spawn-in-process` spawn provider) are
  therefore visible to our plugin ctx.
- The child-session stream carries tool-level events. `tool/call` =
  `{turn, step, callId, name, arguments}` (`dsh-session` `lib/types/types.d.ts:333-339`;
  `arguments` is the raw model-produced JSON string); `tool/result` and `step/start|end` also
  exist.
- Corroboration: dsh's own `dsh-session-projection` service subscribes exactly this way at app
  level (`lib/index.js:64` `ctx.on("session/event", …)`) and drives projections for every session.
- Ruled out / not used: `subagent/start|end|provider-added` (`dsh-subagent`
  `lib/index.js:301-352`; only `end` carries content and is already wired); `agent/status`
  carries only `{status: "idle"|"running"}` on the loop scope (`dsh-agent-loop`
  `lib/index.js:781`); `agent/assistant-stream` frames (`lib/index.js:1032`) are
  worker-transcript-shaped and deliberately unused (no worker-transcript streaming, by design).

**What landed (implementation, worktree):**

- **`recentActivity` resolver** (`src/adapter/cordis-dsh-host.ts`): the host subscribes to
  `session/event`, and for owned workers records a latest-wins phrase per `tool/call` — tool
  name + first string argument hint (generic, no host tool vocabulary; hint capped at 60 chars),
  whitespace-collapsed and clamped via `clampActivity` / `CHECK_ACTIVITY_CHARS` (120). Null-safe
  on hostile payloads; cleared when the worker settles (`subagent/end`); subscription disposed
  with the host. No polling, no timers — pure event-driven projection of host-observed truth.
- **Wiring** (`src/plugin.ts`): the resolver is passed into `registerDispatcherTools` →
  `createDispatcherTools({recentActivity})` → `toCheckRow`, so `check_workers` rows carry
  `recent_activity` (core clamp contract unchanged).
- **Toolview polish** (`src/client/toolviews.ts` + `toolview-panel.tsx`): check-row view models
  gain `activity`; parsed with whitespace-collapse + the unchanged 160-char compact clamp
  (`TOOLVIEW_TEXT_CLAMP_CHARS`); rendered as an `__row-activity` line, omitted entirely when null.
  Verbatim FSM-vocabulary status labels untouched. No new locale keys needed (unlabeled ambient
  line, matching design-17 §4.1).
- **Wake-copy narration guard** (`test/policy-assembler.test.ts`): settle copy (wake turn, cue,
  spawn/steer/stop notes, wake instructions, standing rules) asserted free of machinery tokens
  ("console", "subagent", "toolview", "overlay", "timeline", "progress bar", "streaming") and
  reconstruction identifiers. Copy reviewed: already reads as ordinary narration — tightened
  nothing, zero behavioral change to the wake path.
- **Tests (+17)**: resolver derivation/clamp/nulls/fallback/dispose (host tests, fake `ctx.on`
  firehose idiom); adapter pass-through of `recentActivity` into registered check rows; toolview
  activity-row parsing (present/null/whitespace/oversized/junk-typed); narration guard suite.

**Raised per the schema-bump rule: NO snapshot bump.** Roster snapshot stays at v2. The panel
keeps ticket 27's derived activity lines; live text now reaches the model via `check_workers`
(and its toolview), which needs no wire change. If the panel ever wants live text, a v3 field
projected from this same host-observed truth is the conflict-8-legal path — left to a future
ticket, not done here.

**Non-goals asserted (per ticket, recorded here, not code):** no worker-transcript streaming
surface (assistant-stream frames exist in the host but are deliberately unused — ambient presence
only, matching the reference); no timeline housekeeping cards (new chat node types are
impossible — closed keyed domain, seams Finding 5); no result cards (results are the dispatcher
speaking, S4/S5); no fake-liveness fallbacks (polling/timers) anywhere.

**Residual handover:** verification is static read-only against installed 0.1.5-rc.1 (offline
mandate S8 forbids a live-host run). The subscription mirrors dsh's own session-projection
consumer pattern exactly, which is the strongest offline-verifiable evidence; first live
integration should confirm the firehose end-to-end and note actual child-session ids appear as
expected. Activity phrasing is best-effort (first string argument hint) — presentation only,
never authority.

### 2026-09-19 — re-based onto the wrapper-UI vehicle (ADR-0018; ticket 64)

The verification half survives fully and is vehicle-independent host research: the
`session/event` `tool/call` firehose seam and the `recentActivity` resolver. The toolview polish
was plugin-UI (superseded vehicle); activity presentation re-hosts in the wrapper. This ticket's
non-goals are now codified by ADR-0018: no timeline housekeeping cards = exception U-C;
results-as-dispatcher-speech / text-only delivery = U-E; no worker-transcript streaming remains
plain imitation (the reference streams none). Status stays open, re-scoped.

### 2026-09-20 — live pass 5, Session C (W13): the `session/event` → `recentActivity` → `check_workers` firehose is LIVE-VERIFIED (phrase on a real check row, with provenance); no polish item remains open

Evidence root: `C:\Users\TZhen\Desktop\dsh-live-pass5-2026-09-20\session-C\`
(README maps artifacts to claims). One trivial task (1 of 3 budget).

**The firehose AC ("`recent_activity` text arrives on `check_workers` rows
from a real `session/event`/`tool/call`") is confirmed live:**
- A check_workers toolview row in the live page renders the phrase
  **`request_access: credential`** — the resolver's exact output shape
  (tool name + first-string-argument hint, whitespace-collapsed) for the ONE
  real `request_access` call worker 2dbc148e ever made. Provenance: that call
  happened LIVE tonight during the B-4 lane on this same session
  (`../session-B4/probes/w21-worker-2dbc148e-turnoutline.json` — the offline
  turn outline proves the real `tool/call`); the phrase rode the resolver
  into that live check row, was persisted in the session transcript, and
  re-renders in tonight's live page (`driver/w13-23-cwrows.json.out.json` —
  row HTML: `data-status="spawned"` + field value `request_access:
  credential`). This is resolver-fed text on a live check row, not fixture
  data.
- Tonight's OWN flow exercised the same path end-to-end: the dispatcher's
  live check_workers on the fresh worker (ddf56ee3) ran BEFORE the worker's
  first tool call, and the row honestly OMITTED the activity line (null →
  omitted per the shipped contract — `driver/w13-23`, second row). The
  null-path is therefore also live-confirmed, not just the happy path.
- The panel keeps ticket 27's derived activity lines; live text remains a
  check-rows surface only — the recorded no-schema-bump decision held live
  (`w13-17`: workers carry `recentActivity: null` after settle — cleared on
  settlement, as designed).

**Polish items:** none remain open on this ticket — every box is ticked
in-ticket; the conditional "if no seam" branch was never triggered (seam
verified 2026-09-17). The 2026-09-17 residual ("first live integration should
confirm the firehose end-to-end and note actual child-session ids appear as
expected") is satisfied: child-session worker ids (2dbc148e…, ddf56ee3…)
appear verbatim on the check rows. No AC box ticked here (sweep's job).

One honest boundary: tonight's lane did not produce a NEW
mid-run-activity-text event (the fresh worker was checked before its first
tool call and settled ~10–15 s later); the positive live text is the B-4-run
phrase rendered live. If the sweep wants a fresh positive capture, a future
lane should instruct the worker to make two tool calls and check AFTER the
first (poll cadence ≤2 s during the spawn window).

### 2026-09-20 — RESOLVED (W17 closure sweep): first-live firehose confirmation landed with provenance; moved open/ → resolved/

**Verified.** All actionable boxes ticked; implementation + offline tests (worktree commit `2054db2`, 551 pass / 0 fail; merged to main in `400450f`); the `session/event` → `recentActivity` → `check_workers` seam verified read-only against the installed dsh packages and re-based vehicle-independently (ADR-0018). The one item this ticket still owed — the first-live firehose confirmation — is DONE: live pass 5 Session C (record `ae9cf4c` on ticket 33; evidence `C:\Users\TZhen\Desktop\dsh-live-pass5-2026-09-20\session-C\`) renders `request_access: credential` on a real check_workers toolview row — the resolver's exact output shape (tool name + first-string-argument hint, whitespace-collapsed) for the ONE real `request_access` tool/call, made live in the same night's B-4 lane on the same session and persisted in the transcript (provenance chain: `session-B4/probes/w21-worker-2dbc148e-turnoutline.json` + `session-C/driver/w13-23-cwrows.json.out.json`). The null-omission path is also live-confirmed on the session's own fresh check (a row checked before the worker's first tool call honestly omits the line). Child-session worker ids appear verbatim on rows (2dbc148e…, ddf56ee3…) — the 2026-09-17 residual ("first live integration should confirm end-to-end") is satisfied. No polish item open. Offline gates at closure: `npm run typecheck` clean (both configs); `npm test` 1125 pass / 0 fail / 272 suites.

**Nuance (recorded, not a gap):**
- The conditional "if no seam" box stays unticked — the condition never triggered (a seam was verified 2026-09-17); per the 2026-09-19 closeout precedent (ticket-33 batch `9126909`), ticking it would claim an action never performed.
- Tonight's lane produced no NEW mid-run positive capture (the positive live text carries the B-4 provenance chain above, rendered live); a future lane wanting a fresh capture should poll ≤2 s during the spawn window after instructing two tool calls.

Moved `Issue-tracker/open/29-streaming-presentation-activity-source-verification.md` →
`Issue-tracker/resolved/`, `**Status:**` → resolved. No other file moved.
