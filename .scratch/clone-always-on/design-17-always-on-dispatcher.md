# Design 17 — The always-on dispatcher model (Phase 2)

**Status**: design-only (implementation is split tickets 27+, on branch `clone/always-on-dispatcher` in the worktree checkout `C:\Users\TZhen\Desktop\dsh-bot-always-on` — see `.scratch/clone-always-on/worktree-workflow.md`)
**Ticket**: `Issue-tracker/open/17-behavior-clone-reference-always-on-dispatcher.md` (Phase 2)
**Blocked by / inputs**: Phase-1 behavior inventory `docs/research/always-on-dispatcher-behavior.md` (commit e389325, cited as "inventory §n" — verified contamination-free); design-16 (activation model, cited as "design-16 §n"); `docs/research/dsh-plugin-ui-patterns.md` (cited as "seams §n"); PRD (source of truth); the shipped ticket 18–26 face on this branch (files cited by path).

Downstream contract: split tickets 27–33 (filed on main) implement this design one at a time in the worktree.

---

## 1. Problem and constraints

The reference product's dispatcher is **always-on**: there is no activation step, because the product *is* the dispatcher (inventory Verdict). Our dispatcher lands through design-16's decided model instead: **default-OFF experience, explicit per-session `/dispatcher-start`** (ADR-0009). That decision is closed — ticket 17 does not re-open it. What Phase 2 must design is the *activated experience*: once a chat is activated, it should feel like the reference's always-on dispatcher (glanceable presence, ambient progress, inline approvals, conversational control), while a dormant boot stays stock dsh.

Shipped baseline this design builds on (all offline-green on this branch, 514 tests):

| Capability | Where |
|---|---|
| Activation: `/dispatcher-start`, dormant boot, deferred tool surface, tool gate | `src/adapter/activation-command.ts`, `src/adapter/parent-agent.ts` (`bindDispatcherLifecycle`), `src/plugin.ts` |
| Steer: `/dispatcher-steer` → core last-wins queue (same path as the `steer_worker` tool) | `src/adapter/steer-command.ts`, `src/core/steer-queue.ts` |
| Access prompts: pending asks through `ctx.userQuestions.ask`, dedupe vs conversational, ADR-0008 timeout | `src/adapter/access-prompt.ts`, `src/core/access-relay.ts` |
| Roster overlay: `shell.overlay` entry, settings-namespace mirror channel, snapshot v1 (workerId/title/status/todoId), stale-degrade panel | `src/client/overlay.ts`, `src/client/panel.tsx`, `src/client/roster-store.ts`, `src/adapter/roster-channel.ts`, `src/core/roster-snapshot.ts` |
| Per-tool rows: `tool.call.toolview` for all five dispatcher tools | `src/client/toolviews.ts`, `src/client/toolview-panel.tsx` |
| Core: 6-status FSM, wake bus, todo reconciler, access relay (policy table + timeout), peer inbox, durable markers + rebuild API | `src/core/*` |

Hard constraints (carried, not re-derived): no notifications/toast seam; no new chat node types; `root` must not be registered; no `conversation.approval.detail` claim; delivery is conversational-only; workers never address the user (S1/S5); todos are the dispatcher's private ledger with `completed` = delivered (S6, ADR-0007); tests offline (S8); all copy new (clean-room); never open the reference tree during implementation.

---

## 2. Evidence base (one line per design input)

| Input | Use |
|---|---|
| inventory §1–2 (lifecycle, roster presence) | activated experience shape: always-visible presence, status dots, blocked-with-reason outranking unread |
| inventory §3 (streaming surfaces: running-tasks panel / sidebar activity / inline chat) | the three-layer presence model, mapped in §4.2–4.3 |
| inventory §4 (steer-via-composer, send journal) | conversational-first steer; journal is host-owned (conflict 9) |
| inventory §5 (NO todo board, NO milestones) | we build neither (§4.9) |
| inventory §6 (approval cards: clamped detail, location line, always-allow, stale fencing) | prompt-copy upgrade concepts, new wording (§4.5) |
| inventory §7 (no stop button; restart amnesia; pending-wake ledger) | no stop control anywhere; restart honesty (§4.6–4.7) |
| inventory §8 (no push notifications) | the designed absence (§4.8) |
| inventory mapping table + seams findings | seam choices and honest gaps per surface |
| `src/core/multitask.ts:602` `rebuildFromDurability` has **no production caller** | gap found during this design — activation must call it (§4.7) |
| `src/core/tools.ts:72` optional `recentActivity` resolver, unplugged in the adapter | live activity line is a verified-seam question (§4.1) |

---

## 3. The always-on model reconciled with the #16 toggle

**Decision: keep design-16's activation gate exactly; make the *activated* state carry the reference's always-on feel.** The reference never activates because it has no dormant mode; we cannot copy that without re-opening ADR-0009 (consent was the whole point of ending the hijack). So "always-on" decomposes for us into three properties we CAN honor once activated:

1. **Presence is glanceable without asking** — the Workers panel is a `shell.overlay` entry: it floats over the app and stays visible no matter which chat is open, like the reference's roster sidebar. It is *not* gated to the dispatcher chat; it is gated to the plugin fiber + an activation existing (already true: `publishRosterSnapshot` runs only for the activated session, `src/plugin.ts:239-262`).
2. **Progress is ambient, not polled** — presence updates ride the existing core observer → mirror channel (event-driven projection), and results arrive as ordinary dispatcher messages (wake turns), never a "result card" (inventory §3, matches S4/S5).
3. **Control is conversational** — no dispatcher-specific buttons on any surface; plain language steers or stops workers through the dispatcher agent (§4.6). The `/dispatcher-steer` command stays as a power affordance for exact worker targeting.

### 3.1 Alternatives weighed

| Alternative | Verdict | Why |
|---|---|---|
| (a) Activated-experience polish on the decided gate | **Chosen** | Honors ADR-0005/0009 (consent, session scope) while cloning every legally clonable *behavior* of the always-on feel. No host refactor. |
| (b) Default-activation (auto-activate the first top-level chat under a profile) | Rejected for Phase 2 | Re-introduces silent capture by another name — the bug #19 removed. Session-scoped config sources are unverified (seams Finding 1). Documented as the revisit path in conflict 4. |
| (c) Persist activation across sessions (remember and re-activate) | Rejected | A fresh session silently inheriting dispatcher mode is exactly the consent failure ADR-0009 forbids; also has no verified per-session storage seam. |
| (d) Multi-chat / always-everywhere dispatcher | Out of scope | Design-16 §12 non-goal; per-session tool scoping unverified (seams §Recommendations(a)). |

### 3.2 Dormant → activated → session-end in reference terms

| Phase | Reference (inventory) | Ours (seams + shipped code) |
|---|---|---|
| Boot | App *is* the dispatcher shell; roster sidebar visible immediately | Stock dsh; the only affordance is `/dispatcher-start` in the command menu (design-16 §3.3 dormant table). No capture, no policy, no tools, no panel data. |
| Opt-in | none exists | `/dispatcher-start` in a top-level chat → bind + single policy inject + tool surface + roster publish + prompt sync (`onActivated`, `src/plugin.ts:348-356`). Success copy (§7) now also tells the user where presence lives. |
| Steady state | roster presence always visible; running-tasks panel live; approvals inline; results as ordinary messages | Workers panel floats app-wide (activated session's roster); rows carry dots/ring/blocked-reason/activity line (§4.1); panel sections mirror the running-tasks panel (§4.2); access asks surface through the shipped prompt seam with upgraded copy (§4.5); completion reports land as dispatcher chat turns (shipped wake path). |
| Session end / restart | durable pending-wake ledger; post-restart the agent reports pre-crash work as unknown-state honestly | Session dispose unbinds; workers keep running; markers persist (ADR-0006); panel ages to "unavailable" (stale window). On re-activation: **activation must call `rebuildFromDurability`** (currently uncalled — §4.7), restored terminal rows reappear, and a one-time honest restart notice reports unknown-state workers (§7 copy). |
| Deactivation | n/a (no concept) | No off-while-running exists (ADR-0005/0009 discipline). Between activations the panel honestly shows "unavailable" — the accepted cost of consent (design-16 §3.6). |

**Presence layers collapse, stated once and deliberately:** the reference has TWO presence layers — an agent roster (identity: saved agents with their own chats) and a running-tasks panel (live work). We have one dispatcher and N ephemeral workers; our single Workers panel is therefore the reference's *running-tasks panel*, not its agent roster. Workers must never read as persistent identities (no avatars, no profiles, no per-worker chats — PRD §5, workers are leaves). The reference's agent-roster concepts (hidden agents, pinned rows, org chart, agent info panes) are Phase-2-peer territory and are non-goals here.

---

## 4. Per-surface design answers

Each: reference behavior → our answer → seams → honest gaps.

### 4.1 Roster / presence: status dots, running ring, blocked-with-reason, activity line

- **Reference** (inventory §2): rows carry a status dot, an animated ring while running, a blocked marker with human-readable waiting reason that outranks unread, an unread marker, and a live named activity line.
- **Our answer:** enrich the shipped Workers panel (ticket **27**):
  - **Status dot + ring** — pure presentation over data we already ship: `panel.tsx` already emits `data-status={row.statusLabel}`; map the six FSM statuses to visual states (working = `running`/`steering` with animated ring; starting = `spawned`; done = `completed`; failed = `error`; stopped = `aborted`). Labels stay the verbatim core vocabulary (identity contract, `roster-store.ts:139-141`); dots/rings are CSS, ours, namespaced classes.
  - **Blocked-with-reason (outranks everything)** — snapshot **v2** adds structured `blocked: { class, target } | null` per row, projected from `Multitask.listPendingAccess(sessionId)` joined by workerId. The panel composes the localized waiting phrase (§7) — structured on the wire so zh/en both work. Blocked outranks landed/finished markers, matching the reference precedence rule.
  - **Landed-undelivered marker ("result ready")** — our honest analog of the reference's unread marker: terminal worker whose todo is not yet delivered (core already computes `landedUndelivered` on wake; project it into v2 as `delivered: boolean`). It clears when `deliver_result` completes — visible proof of the S6 "completed means delivered" rule.
  - **Activity line** — v1 is *derived ambient presence*, which needs no new truth: `{status} · {elapsed} · {toolCallCount} tool calls` from `startedAtMs`/`toolCallCount` added to v2 (client computes elapsed against `publishedAtMs`). Live *text* activity: the core's check rows already carry `recent_activity` (`src/core/tool-results.ts:24`) fed by an optional `recentActivity` resolver (`src/core/tools.ts:72`) — but **the adapter never implements one**, and whether dsh exposes live child-session events to a plugin is unverified. Ticket **29** attempts to verify a live source; failing that, the derived line ships and live text stays a documented gap (not a fantasy).
- **Seams:** `shell.overlay` (list, additive — seams Finding 5); settings-namespace mirror channel (shipped, `roster-channel.ts`); snapshot schema bump `ROSTER_SNAPSHOT_SCHEMA_VERSION` 1→2 with defensive parse (v1 payloads fail parse → panel degrades to "unavailable", never a half-roster).
- **Honest gaps:** no push — markers are visible only when the user looks (§4.8). No hover preview card (no verified hover seam; skipped). No unread counters beyond the landed marker. No per-row selection/drill-down in v1 (rows are not chats).

### 4.2 Running-tasks panel

- **Reference** (inventory §3.1): live list of in-flight background tasks, typed by kind (worker / background command / remote job), real title or generic kind+id label, start time, detail line; snapshot states loading/empty/ready/failed-keeps-last/capability-unavailable; per-parent keying.
- **Our answer:** the Workers panel *is* this surface (§3 collapse note). Ticket **28** restructures it into sections that answer "what is happening / what needs me / what finished":
  - **Active** — `spawned`/`running`/`steering`, with activity lines (§4.1).
  - **Needs you** — rows that are `blocked` (pending ask) or landed-undelivered. This section is *our addition*, justified by the no-push constraint: when the user returns, the panel must show at a glance that work is waiting on them (the reference routes this through push-like roster markers we cannot emit).
  - **Finished** — terminal rows rendered muted, collapsed to a count line that expands. Deviation from the reference's "disappears on completion": our panel is the only pull-surface and S4 delivery tracking benefits from the row persisting until delivered; delivered rows can be collapsed away.
  - Title-or-generic label already shipped (`roster-store.ts:162`); v2 adds `kind: "worker"` to each row for forward compatibility with conflict 6 (other producer kinds), `startedAtMs` for a start-time detail line.
  - Snapshot states map: `waiting` → loading copy, `empty` → empty copy, `snapshot` → ready, `invalid`/`stale`/`channel-missing` → unavailable copy (store already implements this state machine; only the vocabulary and sections change).
- **Seams:** same overlay + mirror channel; per-parent keying is inherent (snapshot is keyed to `dispatcherSessionId` and only the activated session publishes — cross-chat leakage impossible by construction).
- **Honest gaps:** kind-typing is forward-compatible schema only — no second producer kind exists (conflict 6); a "failed keeps last good list" nuance is inherited from the channel's best-effort retain (`lastSnapshot`) rather than a dedicated retry UI.

### 4.3 Streaming worker output presentation

- **Reference** (inventory §3): worker transcripts are never streamed to the user; presence is ambient (panel + activity) and results arrive as the agent speaking; tool activity renders as collapsible per-tool rows; small timeline cards mark housekeeping events.
- **Our answer: mostly "already correct — do not build a worker console."**
  - Results as ordinary messages: shipped (wake turns, `composeWakeText`).
  - Tool activity rows: shipped for all five dispatcher tools (ticket 24 toolviews). Ticket **29** polishes: check-row `recent_activity` display when a live source exists (§4.1), clamped long values (pattern exists: `TOOLVIEW_TEXT_CLAMP_CHARS`, `report-clamp.ts`).
  - No live worker transcript streaming, deliberately — this *matches* the reference (ambient progress only) and PRD §6.1 "machinery is invisible".
  - **Timeline housekeeping cards: impossible.** Adding a new chat node type is outside the closed keyed domain (seams Finding 5). Housekeeping notices (access denials, restart notices) ride inside wake turns as text — the shipped pattern. Documented as an honest gap, not worked around with hacks (no fake node types, no shadowing elections).
  - The dispatcher's own streaming (pulsing placeholder, in-place streaming) is host-owned — free, nothing to build.
- **Seams:** `tool.call.toolview` (keyed, additive-safe claims verified); conversational wake turns (existing).
- **Honest gaps:** live text activity unverified (§4.1); no collapsible *worker-transcript* view at all (by design); timeline cards impossible.

### 4.4 Steer ergonomics (composer journal vs our command/transport)

- **Reference** (inventory §4): no separate steer affordance — the user types into the same composer while the agent runs; a send journal makes submission optimistic (pending → queued → sent / failed, offline queue, reconnect flush); no stop-generation method.
- **Our answer: conversational-first, unchanged transport.**
  - The primary steer path is *plain language in the activated chat*: the dispatcher agent receives it as a user message and its policy decides steer-vs-spawn (PRD §6.1) — exactly the reference's contract (inventory §4: "whether it steers or dispatches anew is the agent's judgment"). This works today with zero new code; ticket **31** only strengthens the policy copy for stop/change-course phrasing (§7).
  - `/dispatcher-steer` (shipped) is the exact-target power path into the same last-wins queue — the UI distinction the reference deliberately lacks, kept because it is cheap and already shipped; it must never be *required* (copy never tells users they must use the command).
  - The send journal is **the host's composer behavior** — we get optimistic send/queue/reconnect for the conversational path for free and must not rebuild it (conflict 9). The command path returns one-shot success/error copy; no journal simulation.
  - The deferred v2 `conversation.input.dock` steer affordance stays deferred (ticket 22's recorded reason: dock submit wiring unverifiable offline). Revisit only if a live-verification pass proves it.
- **Seams:** host composer (host-owned); `ctx.commands` (Finding 2); core steer queue (unchanged, last-wins, no restart — S3).
- **Honest gaps:** no per-send phase states on the command path; no dock affordance in v1.

### 4.5 Approvals as inline cards

- **Reference** (inventory §6): inline chat cards typed by surface, with plain-language title, detail clamped to a few hundred chars with an explicit omission marker, a local-vs-remote location line, an "always allow this rule" choice, and stale/pending projections; plus secret cards with save + "never shown" collapsed state; while waiting, the roster row shows blocked-with-reason.
- **Our answer: keep the shipped pump-and-relay plumbing; upgrade only the *copy and options* through the existing seam (ticket **30**):**
  - Location line: workers are local dsh child sessions, so every card carries one honest location line: "Runs on your computer." (§7). No remote class exists — the line is constant; if a remote producer ever lands (conflict 6 territory) the line becomes per-class.
  - Clamped detail with omission marker: apply the `report-clamp.ts` pattern (hard cut + marker with counts) to `AccessRequestBody.reason`/target rendering in `access-prompt.ts`.
  - "Always allow" (session scope): the relay already supports a session policy table (`access-relay.ts:38-51`, `lookupPolicy`). Add a third prompt option that inserts a session-scope allow row for that class+target, with the plain label "Always allow (this session)". Profile-scope writes are **out of scope** (mutating user presets from a prompt is a consent trap; revisit separately). Policy-answered asks never prompt (shipped `sync()` no-op path).
  - Stale fencing: the shipped behavior already fences — deactivation abandons prompts, timeouts deny by default (ADR-0008), released asks are never re-prompted (`access-prompt.ts` header docs). Ticket 30 adds the *expired-copy* answer path (§7) so a user who answers after expiry gets the honest "already expired, denied by default" rather than silence.
  - Blocked-with-reason closes the loop: §4.1's blocked marker is the roster-side reflection of a pending ask, matching the reference's "closing the loop" rule.
  - Secret requests: ticket 13's relay already carries names-never-values; the "stored securely, never shown" collapsed-state concept becomes part of the post-decision notice copy (§7).
- **Seams:** `ctx.userQuestions.ask` (Finding 3) — the shipped pump; **not** `conversation.approval.detail` (shadowing, forbidden by design-16 §4.4); not a new prompt pathway.
- **Honest gaps:** our prompts render in the host's question surface, **not** as inline conversation cards — the card *anatomy* (title/detail/actions in the chat flow) cannot be reproduced without claiming forbidden slots; the classifier-gated review layer (inventory §6) is a larger concept explicitly **not** adopted here (conflict 5).

### 4.6 Stop / interrupt semantics (conversational; no dedicated stop control)

- **Reference** (inventory §7): **no stop button anywhere** — composer, header, and running-tasks panel offer no cancel; stopping is conversational; aborted workers settle honestly with no result revival.
- **Our answer:** **ship no user-facing stop control on any surface.** No stop button on panel rows or toolviews; `stop_worker` remains an agent-facing tool (PRD §6.3 / §15.3 resolution). Ticket **31**:
  - Adds a guard test asserting the client face renders no stop/cancel affordance (so a future edit cannot silently reintroduce one).
  - Strengthens the dispatcher policy copy: when the user asks to stop or change course in plain language, treat it as a steer or a stop of the matching worker and confirm honestly what was stopped (new copy, §7 / `prompts/`-style asset).
  - Aborted workers already settle to terminal `aborted` with "(Stopped before completion. No report.)" (`report-clamp.ts`) — matches the reference's no-revival rule; nothing to change.
- **Seams:** none new — deliberately. The absence *is* the design.
- **Honest gaps:** none beyond the command being the only non-conversational control surface (steer), which the reference also lacks-but-tolerates (its "no special steer UI" stance).

### 4.7 Restart amnesia / pending-wake ledger

- **Reference** (inventory §7): in-memory registries die on restart; a durable pending-wake ledger of start-time obligation markers survives; post-restart the agent reports pre-crash work as unknown-state, never replays.
- **Our answer:** PRD §15.7 already resolved a **deliberate divergence** (ADR-0006): our minimum-to-reconstruct `WorkerRecord` is durable; `SteerTicket` stays in-memory. What Phase 2 must add is the *honesty wiring*, because this design found a real gap: **`Multitask.rebuildFromDurability` (`src/core/multitask.ts:602`) has no production caller** — design-16 §3.6 promised "on the next `/dispatcher-start`, the marker-rebuild path re-attaches the roster", but activation today only publishes an empty roster. Ticket **31**:
  - Calls `rebuildFromDurability(sessionId)` inside `onActivated` (before the first roster publish) so restored terminal rows reappear and landed-undelivered items flush on the first wake (S4 across restart).
  - Surfaces the `unknownState` half of the `RebuildReport` as a **one-time honest notice in the activated chat** (§7 copy): pre-restart live workers are reported as unknown-state with transcript pointers, never replayed, never resumed (core rule: unknown-state rows never land on the roster, `multitask.ts:671` — the notice is conversational, the roster stays clean).
  - Panel treatment: restored rows are indistinguishable from live rows (they *are* live records); only the notice carries the restart story. No "restored" badge in v1 (would imply a state the FSM does not have).
- **Seams:** `storageDomain` markers (ADR-0006, shipped); wake bus for the flush; conversational notice (existing wake-turn assembly).
- **Honest gaps:** steers pending at crash are gone (in-memory, by resolved design); the notice can only name workers, not their progress.

### 4.8 Notifications — the honest absence

- **Reference** (inventory §8): no global push/toast system either; attention routes through roster markers, per-surface transient notices, reconnect banners, and the agent narrating results as they land.
- **Our answer: design the absence explicitly.** dsh 0.1.5-rc.1 has no notifications/toast seam (seams hard limits) — so:
  - No surface may promise or simulate push (no "notify me" controls, no fake toasts). Attention routing = (a) the Workers panel's Needs-you section (pull, §4.2), (b) conversational narration (wake turns land whenever the user looks at the activated chat), (c) the activation/steer command copy already setting the expectation that results arrive in-chat.
  - The reference's "agent narrates as work lands rather than batching" is **policy, not UI**: the shipped wake-turn path delivers per-settle; the policy copy already forbids batching (PRD §6.4 anti-patterns). Nothing new to build; ticket 32 records this in the surfaces README.
  - Reconnect-banner analog: the panel's stale→unavailable degrade (§4.1) is our honest "presence feed is down" state; no banner seam exists.
- **Seams:** none (absence by impossibility — documented, not specced against).
- **Honest gaps:** total. The user must look. This is the single largest fidelity gap vs the reference's *feel*, and it is the host's, not ours.

### 4.9 Todo / milestone surfaces — deliberately nothing

- **Reference** (inventory §5): **no user-facing task board**; the ledger is the agent's private ledger; user-visible proxies are the panel, presence, and in-chat narration. **No milestone entity or surface exists at all.**
- **Our answer: build neither.**
  - The todo ledger stays dispatcher-private (ADR-0007); S6's "shows multiple in_progress" is satisfied by the ledger + the dispatcher's conversational reconciliation narration, exactly as the reference satisfies it. The overlay must not grow a todo board — the reference's lack of one is evidence, and inventing one "because we can" would be silent adoption of a surface neither the reference nor the PRD specifies.
  - The `todoId` chip already rendered on panel rows (shipped) is **linkage metadata** (worker↔ledger correlation), not a board; ticket 27 may demote it visually (muted, truncated) but must not turn it into a task list.
  - "Milestones" in repo vocabulary are *development* milestones (PRD §13), not runtime entities; no prompt, tool, or surface may imply a milestone UI exists. Documentation-level fix in ticket 32 (surfaces README + prompt review).
- **Seams:** none.
- **Honest gaps:** none — absence is the design, reconciled with the PRD in conflict 2/3 below.

---

## 5. The nine PRD conflicts/gaps (inventory decision list) — resolutions

Each: PRD-first default, documented alternative, and a `revisit-before-merge` marker. **No silent adoption.**

| # | Conflict / gap | PRD-first default (chosen) | Documented alternative | Marker |
|---|---|---|---|---|
| 1 | No user-facing stop affordance (reference) vs PRD's dispatcher-visible stop tool | Ship the tool, no stop control on any UI surface; stops are conversational (§4.6). This *is* §15.3's resolution. | A panel row action calling the core stop path — rejected: contradicts §15.3 and invites accidental kills without the agent's judgment. | `revisit-before-merge`: only if user testing shows conversational stopping is undiscoverable; then an explicit ADR, not a silent button. |
| 2 | No user-visible todo board vs S6 | No board. S6 satisfied by the private ledger + conversational narration (ADR-0007; inventory §5 shows the reference agrees). `todoId` stays a muted linkage chip. | Rendering the todo list in the overlay — rejected: our-invention surface, reference has none, risks reading as a task board with wrong semantics. | `revisit-before-merge`: confirm the chip cannot be misread as a board after ticket 27's visual pass. |
| 3 | "Milestones" have no reference counterpart | No milestone surface, entity, or prompt mention. PRD §13 milestones are process milestones, not runtime objects. | A milestone progress surface — rejected: nothing to clone and no PRD requirement. | `revisit-before-merge`: ticket 32's prompt review must confirm no prompt text implies milestone UI. |
| 4 | Always-on-by-identity vs our opt-in toggle | Keep ADR-0005/0009 as decided; clone the activated *feel*, not the no-consent boot (§3, alternative (a)). | Default-activation under the multitask profile ((b), §3.1) — rejected for Phase 2 (silent capture). Auto-remember activation ((c)) — rejected (consent + no session-scoped storage). | `revisit-before-merge`: record in the merge ticket that default-activation remains unadopted by choice, not oversight. |
| 5 | Approval-card concepts the PRD lacks (always-allow memory, location labels, clamp+omission marker, stale fencing) | Adopt as concepts with new copy at prompt level: session-scope always-allow, constant local location line, clamped detail, expired-copy (§4.5). Classifier-gated review layer: **not** adopted. | Full card UI via `conversation.approval.detail` — forbidden (shadowing election, design-16 §4.4). Classifier-gated auto-review — deferred: a policy-behavior change beyond face work; needs its own ticket + ADR if ever. | `revisit-before-merge`: confirm session-scope policy rows are cleared on session end (no cross-session leakage of "always"). |
| 6 | Wake/ledger/panel kind-typing (reference: workers + background commands + remote jobs; PRD Gap 4 "source-agnostic" bus) | PRD-first: keep the single implemented kind (workers). Add `kind: "worker"` to snapshot v2 only as forward-compatible schema (§4.2). **No second producer kind is implemented.** | Implementing background-command wakes now — rejected: no PRD requirement, expands core scope beyond face work. | `revisit-before-merge`: before any second kind lands, a decision ticket must extend the wake bus, ledger, and panel vocabulary together (kind-agnostic from day one of that work). |
| 7 | Group-room exception (reference: inline work, no dispatch in group rooms) | Out of scope — PRD Phase 2 has no room/group concept; peers (ADR-0002) are a separate surface with no rooms shipped. Document the rule candidate: "in group rooms, work inline; do not dispatch". | Gating dispatch on chat topology now — rejected: no room model exists to gate on. | `revisit-before-merge`: re-raise when Phase-2 peer/room design starts (attach to ADR-0002 follow-ups). |
| 8 | Presence/attention model (blocked-with-reason, unread/live activity) has no PRD home | Derive presence **from existing core truth only** (FSM statuses, pending asks, delivered flags) — no new core state machine, no second source of truth; presence is a projection (§4.1), consistent with the roster-snapshot rule. | A dedicated presence store/FSM in core — rejected: duplicates truth the registry and relay already hold. | `revisit-before-merge`: if ticket 27 needs a field the core does not already expose, stop and raise a PRD amendment rather than inventing state. |
| 9 | Send-journal semantics (optimistic send, offline queue, reconnect flush) are host-level in the reference | Do not re-spec or rebuild: the conversational path inherits the host composer's behavior; the command path keeps one-shot copy (§4.4). | A plugin-side journal around `/dispatcher-steer` — rejected: duplicates host behavior, no seam for queue introspection. | `revisit-before-merge`: none needed beyond this row (no work exists to revisit). |

---

## 6. Namespacing (delta from design-16 §5)

No new slot names, command names, or namespaces. New values under existing rules:

| Surface | Rule | New values |
|---|---|---|
| Snapshot schema | version bump must fail-parse old payloads cleanly | `ROSTER_SNAPSHOT_SCHEMA_VERSION` 1 → **2** (v2 fields: `kind`, `startedAtMs`, `toolCallCount`, `delivered`, `blocked {class,target}`) |
| Locale keys | dotted keys under `multitask-dispatcher`, identical en/zh key sets (validator shipped, `overlay.ts:123`) | §7 additions (`roster.*`, `approval.*`, `restart.*`) |
| CSS classes | `multitask-dispatcher-` prefix, no shipped kit classes | dot/ring/section classes on `PANEL_CLASS` |
| Prompt/policy copy | new `prompts/`-style assets, clean-room | §7 policy additions |

Never registered (unchanged): `root`, `main`, `sidebar.right.pane.tab`, `conversation.approval.detail`, any shipped node-type key.

---

## 7. New copy (clean-room drafts — all original; no reference text)

Locale dictionary additions (en; zh face drafted alongside, same clean-room rule — validators enforce identical key sets):

Workers panel (ticket 27/28):

- `roster.section.active` — en "Active" / zh "进行中"
- `roster.section.needs-you` — en "Needs you" / zh "需要你处理"
- `roster.section.finished` — en "Finished" / zh "已完成"
- `roster.finished.count` — en "{count} finished" / zh "{count} 个已完成"
- `roster.blocked.tool` — en "Waiting for your approval: use the tool \"{target}\"" / zh "等待你的批准：使用工具“{target}”"
- `roster.blocked.credential` — en "Waiting for your approval: use the credential \"{target}\"" / zh "等待你的批准：使用凭据“{target}”"
- `roster.blocked.network` — en "Waiting for your approval: network access to \"{target}\"" / zh "等待你的批准：访问网络“{target}”"
- `roster.blocked.filesystem` — en "Waiting for your approval: file access to \"{target}\"" / zh "等待你的批准：访问文件“{target}”"
- `roster.blocked.other` — en "Waiting for your approval: {target}" / zh "等待你的批准：{target}"
- `roster.landed` — en "Result ready — not delivered yet" / zh "结果已就绪，尚未送达"
- `roster.activity.toolcalls` — en "{count} tool calls" / zh "{count} 次工具调用" (activity line format: `{status} · {elapsed} · {n} tool calls`)
- `roster.loading` — en "Loading worker status…" / zh "正在加载工作者状态…"

Approvals (ticket 30):

- `approval.location.local` — en "Runs on your computer." / zh "在你的电脑上运行。"
- `approval.option.always-session` — en "Always allow (this session)" / zh "本次会话总是允许"
- `approval.expired` — en "This request already expired and was denied by default." / zh "该请求已过期，已按默认拒绝处理。"
- `approval.detail.omitted` — en "… [+{count} more characters]" / zh "…[其余 {count} 字符已省略]"
- `approval.secret.stored` — en "Saved. The value is stored securely and is never shown to workers or in this chat." / zh "已保存。该值会安全存储，不会展示给工作者，也不会出现在本聊天中。"

Restart honesty (ticket 31; conversational notice + command copy):

- `restart.unknown-state` — en "Before the last restart, {count} worker(s) were still running: {ids}. Their state is unknown — nothing was replayed. Transcripts: {refs}." / zh "上次重启前仍有 {count} 个工作者在运行：{ids}。它们的状态未知——未做任何重放。转录见：{refs}。"
- `restart.restored` — en "Restored {count} finished worker(s) from before the restart; anything undelivered will be reported on the next wake." / zh "已从重启前恢复 {count} 个已完成的工作者；未送达的结果会在下次唤醒时汇报。"

Activation composition (ticket 32):

- `activation.presence-hint` — appended to activation success: en "The Workers panel shows live progress; results arrive in this chat as they finish." / zh "“工作者”面板会显示实时进度；结果完成后会直接送达本聊天。"

Policy prompt additions (ticket 31, `prompts/`-style asset + `src/core/policy/prompts.ts` assembler section, new copy):

- Stop/course-change rule: "If the user asks you to stop or change course in plain language, treat that as a steer or a stop of the matching worker (stop tool), then confirm plainly what you stopped or changed. Never claim a stopped worker produced a result."
- No-milestone/no-board rule: "Progress is conveyed by your own narration and the workers panel; never reference a task board or milestone view."

Command copy (host-side constants, en/zh via locale where the seam allows; command descriptions remain host-registry strings in en with zh in the locale face):

- `dispatcher-start` success gains the `activation.presence-hint` sentence.

---

## 8. Test plan (offline, S8 — fake seams, `node --test` + tsx)

- **Snapshot v2 (27/28):** projection includes new fields; parse rejects v1 payloads and malformed v2 (fail-closed → unavailable); blocked projection joins `listPendingAccess` by workerId; delivered flag flips only via the reconciler's delivered transition; stale math unchanged.
- **Panel view model (27/28):** section assignment (active/needs-you/finished), blocked-over-landed precedence, muted finished rows, activity-line formatting (elapsed computed from injected clock), verbatim status labels unchanged.
- **No-stop guard (31):** the client view models contain no stop/cancel affordance field; panel/toolview render data carries none (a structural assertion, so the absence is tested, not tribal).
- **Approval copy/options (30):** option list = Allow / Always allow (this session) / Deny; "always" inserts a session-scope row and a second ask for the same class+target auto-answers without prompting; expired answer path returns expired copy and resolves nothing; secret stored-copy on the post-decision notice; clamp marker math.
- **Restart wiring (31):** activation calls rebuild before first publish (order asserted); unknown-state notice text contains ids/refs and fires once per activation; restored rows appear in the first snapshot; no notice when the report is empty.
- **Composition (32):** dormant boot registers nothing new; activation hint appended exactly once; locale validator green for the enlarged dictionaries (identical key sets, all strings).
- **Regression:** full suite offline green; `npm run typecheck` clean (both configs); client esbuild contract test green.

---

## 9. ADR plan (written in the implementation tickets, not now)

1. **ADR-0010 — "Dispatcher presence is a projection of core state on pull-only surfaces."** Records: no-push acceptance (seams hard limits), snapshot v2 as the single wire contract, the collapse of roster/run-panel into one surface, and conflict 8's no-new-core-state rule. Lands with ticket 27/28.
2. **ADR-0011 — "Session-scope always-allow answers and the approval prompt option set."** Records: the option set, session-row scope + clearance on session end, the constant local location line, expired-answer fencing, and conflict 5's non-adoption of classifier gating. Lands with ticket 30.
3. **ADR-0012 — "Activation replays durability, never work."** Records: rebuild-on-activation ordering, the one-time unknown-state notice, and the reaffirmed divergence from the reference's pure pending-wake ledger (PRD §15.7 / ADR-0006). Lands with ticket 31.

---

## 10. Risks and open questions

| Risk / question | Handling |
|---|---|
| Live worker activity source unverified (does dsh expose child-session step/tool events to plugins?) | Ticket 29 runs a **live-verification handover** first: read the shipped `@deepseek-ai/*` packages only (never the reference tree) for a child-event seam; if none, ship derived activity lines and record the gap. Never guessed. |
| Settings-namespace write amplification (panel updates now ride settings publishes) | Frequency cap in the channel (coalesce publishes per tick) if integration shows churn; staleness window already tolerates gaps. Verify merge-vs-replace semantics live (recorded residual risk from ticket 21). |
| `blocked` projection races the prompt pump (ask resolved between list and publish) | Snapshot is a projection, best-effort by contract; a stale blocked marker self-heals on the next roster transition; the prompt remains authoritative (dedupe rules shipped). |
| Session policy rows outliving the session (conflict 5 leakage) | Ticket 30 must clear session rows on deactivation and test it; ADR-0011 records the rule. |
| Rebuild-on-activation changes first-wake behavior (restored rows + flush) | Covered by new tests (§8); existing durable-roster tests already pin core semantics — the adapter change is ordering only. |
| dsh preview drift (0.1.5-rc.1 line-pinned citations) | Re-verify slot names/service faces at integration (standing rule, design-16 §8). |
| Clean-room drift across five tickets | Close-out ticket 33 runs the full-branch identifier grep + provenance diff review per `worktree-workflow.md` §3 before merge; per-ticket reviewers grep their own diffs too. |

---

## 11. Ticket split (filed on main as `Issue-tracker/open/27-*.md` … `33-*.md`)

| Ticket | Title | Blocked by |
|---|---|---|
| 27 | Presence enrichment: snapshot v2, status dots/ring, blocked-with-reason, landed marker, activity lines | None — builds on the shipped ticket-21 panel |
| 28 | Running-tasks panel structure: Active / Needs-you / Finished sections + kind-typed rows | 27 |
| 29 | Streaming presentation: live-activity verification handover + toolview/wake polish | None (verification half independent; snapshot-dependent polish follows 27) |
| 30 | Approval prompt UX: location line, clamped detail, session always-allow, expired/secret copy | None — builds on shipped ticket-23 pump |
| 31 | Conversational stop semantics + restart honesty (rebuild-on-activation, unknown-state notice, no-stop guard test, policy copy) | None — core/adapter only |
| 32 | Dormant/activated composition polish: copy, locale, surfaces README, prompt review | 27, 28, 30, 31 |
| 33 | Close-out: LQA clean-room gate + full-diff provenance review + merge to main | 27–32 |

All implementation happens one-at-a-time in the worktree on `clone/always-on-dispatcher`; tracker updates land on main.

---

## 12. Traceability

| Ticket-17 Phase-2 requirement | Design section |
|---|---|
| Always-on model mapped onto dsh via #16's activation decision | §3 |
| Dormant/active transitions, default state, "what does the user come back to" | §3.2, §4.7 |
| Per-surface design answers vs verified seams, honest gaps | §4.1–4.9 |
| PRD conflicts raised, not silently followed | §5 |
| Namespacing / coexistence | §6 |
| New copy only (en/zh) | §7 |
| Ticket split with blocking edges | §11 |
| Offline testability (S8) | §8 |

---

## 13. Non-goals (this design)

- Default-activation, activation persistence, multi-chat dispatchers (§3.1).
- Agent-identity surfaces: saved-agent roster, org chart, agent info panes, routines, memory (Phase-2-peer territory; PRD §7.6, inventory §9).
- Todo boards, milestone surfaces, worker transcript consoles, timeline card node types, push notifications (§4.3, §4.8, §4.9).
- Classifier-gated auto-review (conflict 5); background-command/remote-job wake kinds (conflict 6).
- Implementing anything in this ticket — design + split only.
