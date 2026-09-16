# Research: Reference always-on dispatcher behavior inventory (concept level)

- Question: What does the always-on multitask dispatcher experience of the reference reconstruction look like at the concept level — activation/lifecycle, roster, worker output streaming, steer, todo/milestone surfaces, permission/secret approvals, stop/interrupt, notifications, and adjacent surfaces — such that we could behavior-clone (never code-clone) it later?
- Scope: observation pass over the reference tree only (dedicated research session, ticket 17 Phase 1). Product code in this repo was not opened. Everything below is abstract product concepts: what the user sees/does, when, and how behaviors compose. No source, prompts, identifiers, UI strings, paths, or protocol artifacts were copied; all phrasing here is original.
- Method: breadth-first survey of the reference tree's renderer feature areas and host control-plane areas, reading structure and behavior-shape only. Sources are cited coarsely by abstract area name (e.g. "the roster area", "the control-plane multitask module"), never by path or identifier.
- Date: 2026-09-17
- Builds on: `prd-vs-reference-capability-gaps.md` (capability gap analysis), `dsh-plugin-ui-patterns.md` (ticket 16's verified dsh seams — used here only for the cross-reference in "Mapping to dsh seams").

## Verdict

The reference product's dispatcher is not a panel bolted onto a chat app; the product *is* the dispatcher. The user always sees a roster of saved agents in a sidebar and talks to one agent in a normal chat. The multitasking machinery is invisible: work streams appear as presence (status dots, activity previews, a running-tasks list), results arrive as ordinary chat messages, and approvals appear as inline cards in that same chat. There is no dispatcher mode to enter, no task board, no dedicated worker console, and — notably — no user-facing stop button anywhere: stopping is done by asking the agent in plain language. The PRD already models the brain of this (S1–S6, wake/steer/todo); the gaps are mostly *face*: presence markers, inline approval cards, the running-tasks surface, reconnect/amnesia UX, and onboarding.

## Behavior areas

### 1. Activation / lifecycle (what a fresh session looks like)

- What the user sees: launching the app lands in a shell whose left sidebar is the agent roster and whose main surface is the selected agent's chat. There is no "enable dispatcher" step; the dispatcher capability is a property of the agent, gated server-side/feature-flag at the host, resolved once at startup — not a user-visible toggle (PRD §6.1 flag-at-session-start matches; our opt-in toggle in ticket 16/ADR-0009 is a deliberate divergence — see Conflicts).
- First run: a guided onboarding sequence (sign-in, an animated "meet your team of agents" beat, a computer-readiness demo, a background-jobs explainer, a tools beat, creating the first agent, then hand-off into the shell). Re-entry is suppressed once the user has seen it or owns at least one agent; probe failures fail open so a transient read cannot strand first-run (PRD-GAP: PRD has no onboarding concept).
- Connection lifecycle: the shell tracks transport states (connecting / connected / down) and presents phases: hidden, loading, connected, reconnecting, unreachable. While reconnecting, a restored roster snapshot from the last good load is shown rather than a blank screen, plus a reconnect banner with a retry action. A privacy-blocked state and an account-binding gate exist ahead of roster load (PRD-GAP: no connection/presence degraded-state model in PRD; dsh seam honesty below).
- Roster-level failure states: a connecting placeholder, an empty state ("no saved agents yet"), an all-hidden state with a one-click "show hidden" action, and an unreachable state whose copy reassures the user their agents are safe, with retry. (Ticket 08's durable roster marker matches the restored-snapshot behavior.)

### 2. Roster presentation

- Each saved agent is a sidebar row with three layouts (expanded / collapsed / pinned). A row carries: a status dot (working / needs-attention / offline / error / info), an animated corner ring while running, a marker chip for "blocked" (with a human-readable waiting reason, e.g. waiting on an approval) that outranks the unread marker, and an unread marker.
- Rows project a live, named activity line — the current work in progress — not just a static label. Hovering a row opens a preview card whose content precedence is: waiting reason > pending draft > last conversation entry; markdown is stripped to plain text and attachments are summarized by kind and count.
- Composition: always-visible, dedicated surface (sidebar), independent of which chat is open. Presence updates are event-driven; the roster is the "glanceable" layer of always-on (PRD-GAP: the PRD has no presence/attention model; S6's todo visibility is the nearest concept but is dispatcher-private).
- Hidden agents: an overlay lists hidden chats with per-item unhide and open actions; opening one closes the overlay first. Roster selection state survives reloads.

### 3. Worker output streaming

- Workers are never chats of their own and never appear in the roster. Running background work is surfaced three ways:
  1. **Running-tasks panel** (in the agent-info area): a live list of the agent's in-flight background tasks, typed by kind — dispatched worker, background one-shot command, remote/cloud job — each with a short label (a real title when available, else a generic kind+id label), start time, and optional detail line. Snapshot states: loading / empty / ready / failed (keeping the last good list) / capability-unavailable. Updates are pushed as events and re-synced on reconnect; a per-parent keying prevents cross-agent leakage.
  2. **Sidebar activity**: the roster row's named activity line and working dot (above).
  3. **Inline chat**: the agent's own replies stream in place (a pulsing placeholder before first text); tool activity renders as collapsible per-tool rows; small non-message "timeline" cards mark housekeeping events (channel connected/disconnected, agent renamed, automation changed) at fixed compact height.
- When a worker finishes, the agent wakes and delivers the result as an ordinary assistant message — there is no separate "result card" for worker output (S4, S5: matches; delivery is always the agent speaking).
- Mid-run streaming of *worker* transcripts to the user is not a first-class surface: the user sees progress only via the activity/panel layers, not a live worker console (PRD-GAP: PRD's `check` capability returns a detail view; the reference's user-visible progress is thinner and ambient — a design decision for us).

### 4. Steer interaction

- There is no separate steer affordance: the user types into the same composer while the agent is running. A send journal makes submission optimistic: phases pending → queued → sent (or failed/cancelled), with offline queueing and automatic flush on reconnect, resend/delete of failed sends, per-agent single-active-send fencing, and stale-generation fencing when the account changes. Only not-yet-sent messages can be cancelled; there is deliberately no stop-generation method in the renderer contract.
- The running agent treats an arriving user message as a mid-run correction/injection per its policy (steer the running stream rather than duplicating it); whether it steers or dispatches anew is the agent's judgment, guided by its always-injected policy section, not a UI distinction (S3 matches at the contract level; the *policy* half lives in the prompt, which is new-copy territory for us).

### 5. Todo / milestone surfaces

- The task list is the agent's private ledger: there is no user-facing task board in the observed UI. The user-visible proxies are the running-tasks panel (live work only, disappears on completion), roster presence, and the agent's own status narration in chat.
- No milestone surface exists anywhere in the reference: no milestone entity, no progress bars per milestone. Long-stream progress is conveyed by labels and activity lines only. (Flag: "milestones" in our repo vocabulary have no reference counterpart — see Conflicts.)
- Cross-reference: S6 / ADR-0007 (todo list is the dispatcher's private ledger, never in worker context) — the reference matches the private-ledger model exactly, including multiple simultaneous in-progress items and completion-only-on-delivery semantics in its policy copy.

### 6. Permission and secret approval flows

- **Risk-gated action approvals ("auto-review")**: when the agent (or anything it spawned — worker dispatches are themselves a gated surface) attempts a risky action, an inline chat card appears, typed by surface: local command (labeled as running on the user's computer), remote-box command/computer action (labeled as running on the product's computer), connected-service (MCP) call, automation write, cloud-agent action, and worker dispatch. Card anatomy: a plain-language title ("the agent wants to …"), the specific command or details (summary clamped to a few hundred characters with an explicit omission marker), a location line for local-vs-remote, resolve actions including a persistent "always allow this rule" choice, and stale/pending projections so a resolved card cannot be re-resolved. A classifier layer, not the model alone, decides what pauses (PRD-GAP beyond ticket 13's relay: the always-allow rule memory and the per-surface location labeling are concepts worth adopting with new copy).
- **Local tool permissions**: a dedicated prompt card (shared component with its settings-area counterpart) for locally-gated tools; fail-closed — if the backing store or transport is missing, the card renders no inert actions.
- **Secret requests**: the agent raises a secret-request card inline: a title and optional description for the needed credential, a password-style input, a save action, and a post-save collapsed state reassuring the user the value is stored securely and never shown to the agent. State machine: idle → pending → provided; stale entries cannot be submitted; submission is scoped to account+agent (ticket 13's relay matches; the saved-state card and the "never shown" promise are UX worth cloning as concepts).
- **Legacy trace**: an older permission-message type survives only as a title-only, action-less card — approvals moved into the card flows above.
- While any of these wait, the roster row shows the blocked marker with the waiting reason (see area 2), closing the loop between approval state and glanceable presence.

### 7. Stop / interrupt semantics

- **The user has no stop button.** Neither the composer, the chat header, nor the running-tasks panel offers a cancel/stop control for a running turn or a running worker; the only cancellation is of a not-yet-sent queued message (area 4). Stopping is conversational: the user asks, the agent decides and stops the worker through its management tooling (PRD §6.3 gives the dispatcher a stop tool — consistent; §15.3 "Stop visibility" resolved as imitate-reference: the reference answer observed here is *no user-visible cancel affordance at all*, agent-mediated only).
- The control plane does distinguish a worker aborted mid-run from one completed or errored — an aborted worker settles to a terminal aborted state without result revival, and the agent reports that honestly (PRD lifecycle matches).
- **Restart amnesia**: in-memory registries are lost on restart; what survives is a durable pending-wake ledger — small control-plane obligation markers written when background work *starts* (kind, work id, title, start time). After a restart the agent learns of pre-crash work "from the durable pending-wake ledger" and reports it as unknown-state/finished honestly rather than replaying it. (Cross-ref: PRD §7.5 resolved hybrid — our durable minimum-to-reconstruct worker record is a deliberate divergence; the start-time marker idiom itself was already absorbed into ADR-0006's wording.)

### 8. Notifications

- There is no global push/toast notification system for work events. Attention is routed through: (a) roster markers — unread and blocked-with-reason; (b) per-surface success/error notices for settings- and plugins-area operations (small transient status messages scoped to the surface that owns the operation); (c) reconnect banners (area 1); (d) the agent itself narrating results in chat as they land rather than batching (policy-level).
- Routine/automation runs deliver their output as ordinary messages in the owning agent's chat, and one-time "notice" lines can be injected into an automation-triggered turn (e.g. a misconfigured listener warning raised exactly once) (PRD-GAP: PRD Gap 4 already flags automation wake sources; the raised-once notice idiom is a small extra concept).

### 9. Adjacent surfaces that compose with the dispatcher

- **Org-chart view**: a graph of agents and groups; edges are group membership or recent conversation (a short recency window marks edges as recent/"talking"); per-agent activity states idle / typing / working / waiting; selecting a node opens an inspector with unread state, last message, and whether the agent awaits the user's reply. This visualizes the multi-agent messaging hub (Phase-2 territory, PRD §7.6), not the worker roster — dispatched workers do not appear as nodes.
- **Routines/automations**: per-agent routine editor (trigger draft schema, schedule with timezone awareness), run history with per-run status icons, listener integrations; runs wake the agent as ordinary turns.
- **Agent info panes**: profile/avatar editing, channels, group membership, a shared-room affordance, and per-agent settings — the "team of agents" identity layer the dispatcher policy leans on.
- **Chat ergonomics**: find-in-chat, reply/thread affordances, reactions, drafts per agent, rich attachments (PDF/spreadsheet/media/mermaid viewers), URL cards — a messaging-app baseline the dispatcher experience silently assumes.
- **Memory**: per-agent durable memory with background synthesis (already inventoried in `prd-vs-reference-capability-gaps.md` Gap 1; confirmed present in the control-plane area — not re-derived here).

## Mapping to dsh seams (ticket 16 cross-reference)

| Reference behavior | dsh seam candidate | Honesty notes |
|---|---|---|
| Always-on shell + roster sidebar | `shell.overlay` list slot (recommended, additive) or `sidebar.right.pane.tab` keyed entry | No left-sidebar list slot we may claim additively; overlay is the documented free-floating surface. Presence *push* is impossible: dsh 0.1.5-rc.1 has no notifications/toast seam, so roster markers are visible only in surfaces the user opens. |
| Running-tasks panel | Right-panel tab or overlay section fed by our core registry; per-tool rows via `tool.call.toolview` for dispatch/steer/check tools | Feasible; data is ours. Live activity labels need core-side activity text (registry already keeps optional live fields — PRD §7.5). |
| Inline approval cards | `ctx.approval` / `ctx.userQuestions` host seams; custom detail via `conversation.approval.detail` (single, shadowing — election against shipped UI) | The waterfall exists; our relay answers through it. Per-surface location labels and always-allow rules are our core/prompt work, not UI seams. |
| Secret request cards | Same host prompt seams; secret storage must not be invented twice | dsh settings redact `.role("secret")` values; a worker-scoped injection path is still an open design (ticket 13). |
| Steer-via-composer | `conversation.input.dock`/`.left`/`.right` affordance; transport stays the existing subagent message path | Send-journal offline queueing is the *host's* composer behavior in dsh; we get it for free and must not rebuild it. No new chat node types — a steer must render as an existing node type (user message), which matches the reference's own "no special steer UI" stance. |
| No stop button | Nothing to build — but our PRD ships a dispatcher-visible stop *tool*; consider withholding any user-facing stop affordance | Keeps behavior parity; the tool remains for the agent. |
| Restart amnesia + pending-wake ledger | Core-side: obligation markers in the dsh session/job store (already ADR-0006) | dsh session store is the only sanctioned persistence; no second DB. |
| Onboarding / first-agent flow | Settings onboarding list slot (`settings.onboarding`) + activation command | Reference onboarding is account/product-bound; ours can only be a lightweight opt-in flow. Feasibility of a full guided overlay is unverified. |
| Org-chart / routines / memory | Out of MVP scope (Phase 2 / Gaps doc) | A `main`-keyed page exists but third-party page *opening* is unverified (ticket 16 Status item 2) — do not spec the org-chart against it. |

## PRD conflicts & gaps (decision list — PRD wins on conflicts)

1. **No user-facing stop affordance (reference) vs PRD's dispatcher-visible stop tool (ours).** Not a true conflict — the tool is agent-facing — but a UX decision: we should ship no user-facing stop button and let stops be conversational, matching the reference and §15.3's resolution. Low risk.
2. **No user-visible todo board in the reference.** S6's "todo list shows multiple in_progress" is satisfied by the dispatcher's private ledger; any visible task surface (e.g. rendering todos in the overlay) would be *our* invention — needs an explicit decision, not silent adoption.
3. **"Milestones" have no reference counterpart.** The reference conveys progress via running-task labels and presence only. Our vocabulary should not assume a milestone surface exists to clone. Documentation-level fix.
4. **Always-on by product identity vs our opt-in toggle.** The reference has no activation step; tickets 16/ADR-0005/ADR-0009 require opt-in. Deliberate divergence, already decided — this note records the reference baseline for the dormant/active transition design (ticket 17 Phase 2).
5. **Approval-card concepts the PRD lacks**: always-allow rule persistence, per-surface location labels ("runs on your computer" vs the product's remote computer), summary clamping with omission marker, stale-resolution fencing. Adopt as concepts with new copy (ticket 13+). The classifier-gated review layer is a larger concept — flag for a separate decision.
6. **Background-work kinds**: the reference's wake/ledger/panel model covers dispatched workers *plus* plain background commands and remote/cloud jobs — one wake bus, several producer kinds. PRD Gap 4's "source-agnostic wake bus" should also be kind-agnostic from day one.
7. **Group-room exception**: in group rooms the reference agent works inline and does not dispatch. PRD Phase 2 has no room/group concept; when Phase 2 lands, this behavioral rule needs a conscious decision.
8. **Presence/attention model**: blocked-with-reason, unread, live activity preview have no PRD home. Feasible on dsh only as pull-surfaces (no push). Design decision for ticket 17 Phase 2 / ticket 21.
9. **Send-journal semantics** (optimistic send, offline queue, reconnect flush) are host-level in the reference. On dsh the composer is the host's; do not re-spec.

## Status

- **Inventoried (breadth over depth, as budgeted):** activation/lifecycle and connection states; roster presentation and presence; worker output streaming surfaces (panel/activity/inline); steer-via-composer and send journal; todo/milestone surfaces (their absence noted); permission/secret/local-tool approval flows; stop/interrupt semantics and restart amnesia; notifications; adjacent surfaces (org chart, routines, agent info, chat ergonomics, memory pointer).
- **Covered shallowly (structure confirmed, behavior not fully walked):** routines/automations detail (trigger schema, run history rendering); agent-info channels/group/shared-room panes; org-chart inspector and layout mechanics; the remote-box/computer feature area; plugins/skills management; settings-area internals beyond notice plumbing.
- **Not inventoried:** OS-level notification behavior (if any) outside the renderer; update/feedback/account/about surfaces; the box/exec daemon internals; inference router (out of scope per PRD non-goals); deep-links and window-chrome details; the reference's own test suite.
- **Legal:** this note was written from a dedicated observation pass; all descriptions are abstract product concepts in original wording. The case-insensitive clean-room grep over the reconstruction codenames listed in PRD §8/§17 was run over this file before committing and returns no matches.
