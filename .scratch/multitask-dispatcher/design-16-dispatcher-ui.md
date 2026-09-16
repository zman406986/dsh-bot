# Design 16 — Dispatcher UI: activation model and surfaces

**Status**: design-only (implementation is tickets 19+, not this ticket)
**Ticket**: `Issue-tracker/open/16-dispatcher-ui-research-design-implement.md` (Phase 2)
**Blocked by / inputs**: Phase 1 research — `docs/research/dsh-plugin-ui-patterns.md` (commits 8088ff9, e0d0ed1; cited as "seams §n") and `.scratch/multitask-dispatcher/research-16-hijack.md` (commit cbb61a9; cited as "diagnosis §n"); ADR-0005; design-12 (flag/profile split); ticket 13 relay (`src/core/access-relay.ts`); `src/plugin.ts`, `src/adapter/parent-agent.ts`, `src/adapter/cordis-dsh-host.ts`, `src/core/tools.ts`.

Downstream contract: ticket 17's always-on UI work "must land through whatever activation model #16 decides" — this doc is that decision.

---

## 1. Problem and constraints

Today the dispatcher is silent-on-load and total when it acts: with the flag resolving ON (`plugin.ts:40` code default; multitask profile sets it explicitly per ADR-0005), the first top-level session to fire `agent/session-start` is captured as the dispatcher (`parent-agent.ts:99-116`) — policy injected, per-turn reminders (`parent-agent.ts:140-147`), plugin-authored wake turns (`cordis-dsh-host.ts:408-426`), and five process-global tools (`plugin.ts:198-205`). Per ADR-0005 the flag is frozen per session and `onChange` is a deliberate no-op (`settings-section.ts:67-84`), so once captured, the hijack is irreversible for that session. And the dispatcher has no face of its own: no roster, no status surface, no opt-in, no coexistence story with other plugins.

Hard constraints (all from verified evidence):

| Constraint | Source |
|---|---|
| Some live Agent must stay bound as spawn/interrupt authority (`bindParent` single slot; `spawnWorker`/`interruptWorker`/`sendMessage` are parent-relative) | `cordis-dsh-host.ts:224, 258-261, 336-339, 381-398` |
| The only verified delivery path is conversational — the dispatcher speaking in its own activated-chat turns; `deliverToUser` is an optional dep the plugin does not wire | `core/tools.ts:67-71, 375-377`; `plugin.ts:198-202`; `dsh-adapter-api-notes.md:213` |
| No live on/off toggle of a running dispatcher (flag frozen per session; changes apply next session only) | ADR-0005; `plugin.ts:151-163` |
| `ctx.tools.register` is process-global — no verified per-session tool scoping | `dispatcher-tools.ts:120`; seams §Recommendations(a) |
| No notifications/toast seam; no new chat node types; `root` must not be registered; console is not a seam | seams §5, §Recommendations hard limits |
| Tests offline (S8): FakeDshHost / fake seams, `node --test` + tsx | ticket 16 constraints |
| All UI copy new (clean-room); never open the reference tree | AGENTS.md, PRD §8/§12/§17 |

---

## 2. Evidence base (one line per element, all verified)

| Element | Chosen seam | Registration call | Evidence |
|---|---|---|---|
| Activation | Host slash command | `ctx.commands.register({name, description, input?, handler})` | seams Finding 2 (`dsh-commands lib/index.js:142-173`) |
| Activation consent surface (optional) | Client commandUi | `ctx.commandUi.register(...)` / `.decorate(...)` | seams Finding 6 |
| Roster/status panel | Client slot `shell.overlay` (list, additive) | `ctx.slots.register({name: "shell.overlay", id, order, ...}, Comp)` via `ctx.slots.inject` | seams Finding 5 (`registry.d.ts:16-38`) |
| Per-worker detail rows | Client slot `tool.call.toolview` (keyed by wire tool name) | `ctx.slots.register({name: "tool.call.toolview", key: "spawn_worker", ...}, Comp)` | seams Finding 5; worked example 5 (`dsh-client-ui-cordis`) |
| Steer input transport | Host slash command | `ctx.commands.register({name: "dispatcher-steer", ...})` | seams Finding 2 |
| Steer input affordance (optional) | Client slot `conversation.input.dock` (list) | `ctx.slots.register({name: "conversation.input.dock", id, order}, Comp)` | seams Finding 5; order deconflicts with command popup (`order 1`, `lib/client.js:1102-1127`) |
| Access-request prompts | Existing host prompt seams | `ctx.userQuestions.ask(request)`; `ctx.approval` waterfall | seams Finding 3 (`dsh-user-questions lib/index.js:52`) |
| Client code delivery | `dsh.client` package record + `exports["./client"]` | `package.json` declaration; boot graph composition | seams Finding 4 |

Rejected-for-v1 (with reasons): `main` keyed page (how a third-party key gets *opened* is unverified — seams Status item 2); `sidebar.right.pane.tab` keyed entry (shadowing kind, confined surface); `conversation.approval.detail` (single/shadowing slot owned by shipped approval UI — an election against shipped UI); dedicated UI page / daemon (diagnosis (d)) — breaks the delivery constraint above.

---

## 3. Activation model (the decision)

**Decision: default-OFF experience with explicit per-session slash-command opt-in. Install the plugin and dsh boots as stock dsh. The dispatcher exists only in chats where the user runs `/dispatcher-start`.**

### 3.1 Alternatives weighed

| Alternative | Verdict | Why |
|---|---|---|
| (a) Opt-in command (diagnosis §2a; seams §Recommendations(a)) | **Chosen** | The only consent-bearing seam that is verified end to end (Finding 2: fiber-scoped, auditable `command/run`/`command/done` events, fail-loud name collisions). Keeps the conversational delivery path (dispatcher still speaks in the opted-in chat). Smallest diff: capture moves, nothing else restructures. |
| (b) Session-scoped flag marker (diagnosis §2b) | Rejected for v1 | Needs a session-start-readable per-session config source — unverified (settings seam is plugin-namespace-scoped, seams Finding 1). Also has no consent moment: a mis-set marker hijacks silently, exactly the bug being fixed. |
| (c) Per-chat multi-activation (diagnosis §2c) | Deferred | Core is sessionId-keyed, but the host is single-parent throughout, and per-session tool scoping is unverified (`ctx.tools.register` is global). Real host refactor + unresolved cross-delivery questions. Revisit after v1 ships. |
| (d) Pure UI page / daemon (diagnosis §2d) | Rejected for v1 | Delivery has no verified non-conversational path (`deliverToUser` unwired; no send API — `dsh-adapter-api-notes.md:213`). A UI-only dispatcher cannot satisfy PRD "completed means delivered to user". |

### 3.2 What the user sees

1. Install plugin (multitask profile, flag ON) → dsh boots as stock. No capture, no policy inject, no wake turns. The only new thing is a `/dispatcher-start` entry in the command menu.
2. User runs `/dispatcher-start` in a top-level chat → that chat becomes the dispatcher **for that session**: policy context injected once, roster/steer/delivery all live there, worker wakes return as turns in that chat. A success message says so (copy in §6).
3. Session ends (clear / new chat / dispose) → dispatcher is gone; workers keep running to completion (§3.6). Re-activation is another explicit `/dispatcher-start` — re-consent is deliberate: a fresh session never inherits dispatcher mode silently.

There is **no deactivate command**. Activation is once per session and never flipped off while running (ADR-0005 discipline); "off" means the session ended. This is the answer to diagnosis §2a's open question: command activation is *not* a forbidden live-toggle — it creates a session-scoped state that lives exactly as long as the session, and there is no off-while-running transition to define.

### 3.3 Dormant vs active lifecycle (Cordis-reversible effects)

Every registration below is an effect on the plugin fiber; unload/HMR reverses it automatically (seams Findings 1, 2, 5 — "disposing that fiber removes the namespace", "the exact effect disposer that unregisters", slot disposal cascades). `apply` currently already ends with a dispose-all effect (`plugin.ts:236-240`); the split keeps that shape.

**Dormant (flag ON, not activated):**

| What | Registered? | Notes |
|---|---|---|
| Settings section | Yes (existing, `plugin.ts:157`) | Unchanged — the flag control must exist to turn the plugin off for next session (design-12 §5.2 option A) |
| Core + host + durable markers | Yes (existing, `plugin.ts:165-188`) | Constructed at apply so ADR-0006 marker-rebuild semantics are untouched; they are passive until a parent is bound |
| `/dispatcher-start` command | **New — yes** | The dormant plugin's only visible affordance |
| `agent/disposed` + `agent/status` listeners | **New — yes, passive** | Registered in `apply` but they early-return while no dispatcher session is captured (`parent-agent.ts:138, 156` already gate on `dispatcherSessionId`/`workerIdOf`) — no behavior without activation |
| Five dispatcher tools + `request_access` | **Deferred to activation** | Registration moves into the activation path so the dormant tool surface is exactly stock. If implementation finds in-handler registration awkward, fallback is apply-time registration + handler gate (below) — at the cost of dormant name visibility |
| Session-start capture listener | **Removed** | The `agent/session-start` branch that captures (`parent-agent.ts:99-116`) is deleted; capture becomes an explicit function call from the command handler |

**Active (activation command fired in a top-level chat):**

1. Resolve the live agent + session id from the command invocation (Finding 2: invocation carries `{commandId, agent, rawInput, attachments, signal}`).
2. Gate: session must be top-level (`isTopLevel`, `parent-agent.ts:14-20`, unchanged — including its documented fail-open when the header is inaccessible); not already active.
3. Capture: `parentAgentRef = agent; dispatcherSessionId = sessionId; host.bindParent(agent, sessionId)` — the existing capture body, relocated.
4. Inject policy once: `tryInject(agent, assembleSessionPolicy(true))` — unchanged code, now consent-gated.
5. Register the five dispatcher tools + `request_access` (if deferred per the table above).
6. Reply with success copy (§6).

**Deactivation / HMR:** fiber unload disposes command, listeners, tools, and runs `lifecycle.unbind()` + `host.dispose()` (`plugin.ts:236-240` — existing). Session end/clear fires `agent/disposed` → `unbindParent()` (existing, `parent-agent.ts:118-127`). The new fiber starts dormant; the user re-runs the command. Mid-session deactivation by command is deliberately not offered (§3.2).

### 3.4 Spawn/interrupt authority constraint — spelled out

The parent binding is **deferred, not removed**. `host.bindParent(agent, sessionId)` still happens exactly once per activation into the same single slot (`cordis-dsh-host.ts:258-261`); `spawnWorker`/`interruptWorker`/`sendMessage` still resolve through the bound parent (`cordis-dsh-host.ts:336-339, 381-398`). No UI affordance ever replaces this path: the roster panel, steer dock, and prompts drive the core (`multitask.ts`), the core drives the host, the host drives the bound parent. UI is presentation; authority never leaves the parent-agent binding. The only code change is *when* the binding happens (command time instead of first session-start).

### 3.5 Delivery path

Unchanged and explicitly conversational: after activation, the dispatcher is the activated chat's agent; `deliver_result` still marks the todo delivered and the wake-turn path (`requestDispatcherWakeup`, `cordis-dsh-host.ts:408-426` → `composeWakeText`, `plugin.ts:86-137`) puts completion reports into the activated chat. `deliverToUser` (`core/tools.ts:67-71`) stays unwired in v1 — there is no verified host send API to wire it to; wiring it (or re-grounding delivery) is future work only if a verified send seam appears. This is why the activated chat, not a UI page, must be the dispatcher's home (§3.1d).

### 3.6 Running workers on deactivation

Workers are independent dsh sessions once spawned; they are never killed by deactivation (consistent with ADR-0005's superseded-but-spiritually-retained "run to completion, results retained" rule). When the activated session ends, `unbindParent` removes spawn/interrupt/steer/send authority and wake followups have no target: settle notices keep queueing on the wake bus and ADR-0006 markers keep recording state. On the next `/dispatcher-start`, the marker-rebuild path re-attaches the roster and queued material flushes through the normal drain. Between activations the user has no dispatcher surface — acceptable for v1, and the honest cost of consent; the roster panel (§4.2) shows state only while its plugin fiber and a live session exist.

### 3.7 Composition with the ticket-12 flag / profile split (the matrix)

The flag keeps ADR-0005 semantics exactly: read once at `apply`, frozen, settings flip applies next `apply` only. What changes is what ON *means*: "dispatcher **available**", no longer "primary chat **captured**".

| Flag (frozen at apply) | Activation state | Resulting behavior |
|---|---|---|
| OFF | n/a | **Fully inert** — stock dsh: no core, no host, no command, no tools, no listeners; settings section only (existing early return, `plugin.ts:159-163`, unchanged) |
| ON | never activated (dormant) | Stock experience + invisible plumbing + `/dispatcher-start` in the command menu; no capture, no injects, no wake turns, stock tool surface |
| ON | activated | Full dispatcher in that chat: policy, reminders, wakes, tools (registered), roster/steer/delivery surfaces live |

Profile composition (ADR-0005 + design-12 §6): stock profiles don't install the plugin (installation gate) — nothing changes there. The multitask profile installs with flag ON → boot is stock-with-command, and the profile's "always-on" promise is now "one command away". Ticket 17's always-on work can layer a default-activation behavior *on top of* this model later; it does not need to re-open the decision.

### 3.8 Tool-gating rule (until/unless per-session scoping is verified)

`ctx.tools.register` is process-global, so after any activation every chat's model surface can see the five tools — the unverified-scoping leak flagged in seams §Recommendations(a), accepted and documented rather than specced against. Mitigation, both offline-testable:

- **Primary:** every dispatcher-tool handler resolves the *calling* session from the exec shape (the pattern already shipped for `request_access`'s `resolveWorkerId`, `plugin.ts:211-227`) and refuses when it is not the activated dispatcher session, with a structured error (§6 copy).
- **Fallback:** if exec-shape resolution proves unreliable for some host path, gate on "an activation exists" (`getSessionId() !== null`) and document the weaker guarantee in the ticket.

---

## 4. Per-element design answers

### 4.1 Activation control

- **Registration:** `ctx.commands.register({ name: "dispatcher-start", description, handler })` in `apply` (flag ON). Handler result shapes per Finding 2 (`{kind: "success"|"error", text}`); runs instead of sending the line to the model; `command/run`/`command/done` events make consent auditable.
- **Namespacing:** host command names are globally unique and fail loud on collision (Finding 2, `lib/index.js:82`); `dispatcher-` prefix (§5). No shipped `dsh-*` command uses it (Finding 7 inventory).
- **Optional enhancement (separate ticket, not required for v1):** a client `commandUi` contribution to give the command a menu affordance (`popupSelect` confirming the target chat) — Finding 6; client collisions with host commands fail loud at synthesis, never shadow.
- **Fallback:** if the invocation's `agent` shape differs from the `.d.ts` contract at integration time, fall back to resolving the session via the exec-shape idiom (§3.8) and refuse activation with an error copy rather than guessing.

### 4.2 Roster / status surface

- **Primary registration:** client-face entry into `shell.overlay` (list slot — additive, order-sorted, click-through until opted in; dsh's documented home for free-floating plugin surfaces, `registry.d.ts:16-38`): `ctx.slots.inject("shell.overlay", () => ctx.slots.register({ id: "multitask-dispatcher-roster", order: <low, see §5> }, RosterPanel))`. Per-worker detail rides the toolview seam: keyed `tool.call.toolview` entries for `spawn_worker` / `check_workers` / `steer_worker` / `stop_worker` (unclaimed wire-tool keys fall back to the generic row until we claim them — Finding 5).
- **Prerequisite:** this repo has **no client face today** (`package.json` exports only the host entry; no `dsh.client` record). Roster work must first add the client scaffold (ticket 20): `dsh.client: {platform: "web"}` record, `exports["./client"]` bundle, a slot hello-world, and a `ctx.locale.register("multitask-dispatcher", ...)` namespace.
- **Data path (the honest gap):** the research note verifies *registration* seams, not a client↔host telemetry channel. The known-good fallback is our existing settings namespace: `installSection`'s owner scope exposes `get`/`watch` (Finding 1), and the shipped preset plugin demonstrates the client injecting a settings scope (Finding 7, worked example 3). The host can mirror a compact roster snapshot into the plugin's own namespace for the panel to watch. It is a config channel doing telemetry duty — the roster ticket must verify this (or find a better channel) **before** building the panel, and the panel must render a "status unavailable" state if the channel is stale (§6 copy).
- **Fallback if the client face is blocked entirely:** status stays conversational — wake turns + `check_workers` output (shipped, works today, zero new infra). The overlay is an upgrade, not a dependency of correctness.

### 4.3 Steer input

- **Transport (unchanged):** steering remains the core's last-wins queue delivered at step boundaries (`emitStepBoundary`, `parent-agent.ts:162-165`); nothing in the UI re-implements steer semantics.
- **v1 affordance (host, verified):** `/dispatcher-steer` host command — handler validates worker id + text (structured errors reusing core's refusal vocabulary), enqueues into the core steer path for the activated session. Same registration/namespacing rules as §4.1. Works headless, offline-testable, no client face needed.
- **v2 affordance (client, optional):** a `conversation.input.dock` list entry (small "steer" affordance) that pre-fills or submits the same steer payload; `order` deconflicts with the shipped command popup (entry id `command-popup`, order 1 — Finding 6). The dock must not bypass the command/core path; if `input.dock` child-slot wiring proves different from the contract at integration time, ship v1 only.

### 4.4 Access-request prompts (ticket-13 relay)

- **Primary:** the existing host prompt seams — surface pending access asks through `ctx.userQuestions.ask` (Finding 3) from the host side once activated, and route the answer into the existing core relay (`src/core/access-relay.ts`) exactly as a conversational answer would arrive. Timeout/deny-by-default (ADR-0008) is untouched: an unanswered prompt falls to the timeout, never hangs.
- **Status quo remains the fallback:** the conversational relay (asks rendered in dispatcher wake turns) is already shipped (ticket 13) and stays correct if the prompt wiring is deferred or fails verification.
- **Forbidden:** a new host prompt pathway; claiming `conversation.approval.detail` (single/shadowing slot owned by shipped approval UI) without an explicit election decision.

---

## 5. Namespacing / conflict rules (everything the plugin registers)

| Surface | Rule | Values |
|---|---|---|
| Settings namespace | plugin id, globally unique, `/^[a-z][a-z0-9-]*$/` (Finding 1) | `multitask-dispatcher` (existing) |
| Host command names | globally unique, fail loud on collision; `dispatcher-` prefix (Finding 2) | `dispatcher-start`, `dispatcher-steer` |
| Client slot entry `id`s | unique, `multitask-dispatcher-` prefix | `multitask-dispatcher-roster`, `multitask-dispatcher-steer` |
| Slot `name`s | **only dsh-owned shipped slots; never invented** (Finding 5 catalog) | `shell.overlay`, `conversation.input.dock`, `tool.call.toolview` |
| `tool.call.toolview` keys | wire tool names, ours since ticket 11; unclaimed keys are safe to claim (Finding 5) | `spawn_worker`, `check_workers`, `steer_worker`, `stop_worker` |
| Locale namespace | plugin id (Finding 6, `ctx.locale.register(NS, {zh, en})`) | `multitask-dispatcher` |
| Tool names | unchanged, core-owned | `spawn_worker`, `check_workers`, `steer_worker`, `stop_worker`, `deliver_result`, `request_access` |
| Never registered | `root` (documented do-not), boot-once seats (renderer/locale *installs*, exact routes), shipped slot *keys* (no shadowing elections: no shipped node-type keys, no `main:"conversation"`, no `conversation.approval.detail`) | — |

Collisions are fail-loud by design; the rule is fix the name at implementation time and record the replacement in the ticket, never shadow.

---

## 6. New copy (clean-room drafts — all original; no reference text)

Host commands:

- `dispatcher-start` description: "Turn this chat into the multitask dispatcher for this session."
- `dispatcher-start` success: "Dispatcher active in this chat. Workers spawned here report back here; use /dispatcher-steer to nudge a running worker."
- `dispatcher-start` already-active: "The dispatcher is already active in this chat."
- `dispatcher-start` active-elsewhere: "The dispatcher is already active in another chat. Finish or clear that session first."
- `dispatcher-start` not-top-level: "The dispatcher can only be activated in a top-level chat."
- `dispatcher-steer` description: "Send a mid-run instruction to a running worker. The most recent instruction wins."
- `dispatcher-steer` input hint: "worker id, then your instruction"
- `dispatcher-steer` success: "Steer queued for {workerId}."
- Tool-gate refusal (dispatcher tools called from a non-activated session): "Dispatcher tools are only available in the activated dispatcher chat. Run /dispatcher-start there first."

Roster panel (client):

- Title: "Workers"
- Empty state: "No workers yet. Ask the dispatcher to start some."
- Stale/unavailable state: "Worker status is unavailable right now."
- Status labels: reuse the core FSM vocabulary (`pending`, `running`, `completed`, `error`) as-is.

Steer affordance (client, v2):

- Placeholder: "Nudge a worker — e.g. \"focus on the failing test first\""

Access prompts:

- Ask: "Worker {workerId} needs approval to {action}."
- Options: "Allow", "Deny"
- Post-decision and timeout notices: reuse ticket 13's shipped core copy (already clean-room).

Localization: every string above lands in `ctx.locale.register("multitask-dispatcher", { en, zh })` (zh drafts written at implementation, same clean-room rule).

---

## 7. Test plan (offline, S8 — FakeDshHost / fake seams)

- **Activation lifecycle (ticket 19):** dormant `apply` (flag ON) captures nothing on simulated `agent/session-start`; command handler with a fake invocation binds parent + injects policy exactly once; `isTopLevel` refusals; double activation in-session; activation while active elsewhere; `agent/disposed` unbinds; dispose-all reverses everything (HMR simulation). Existing capture-on-load tests in `test/adapter-policy-inject.test.ts` / `test/plugin-scaffold.test.ts` are rewritten to the new contract — their *old* assertions (capture on session-start) are the behavior being deleted.
- **Tool gating (ticket 19):** handlers refuse non-activated calling sessions (exec-shape resolution) and accept the activated one; fallback gate covered by a documented weaker test if used.
- **Flag matrix (ticket 19):** OFF = nothing registered (extends `test/feature-flag.test.ts`).
- **Steer command (ticket 22):** `/dispatcher-steer` handler → core steer queue ordering/last-wins unchanged (`test/steer-queue.test.ts` still green); refusals for unknown worker / inactive dispatcher.
- **Access prompts (ticket 23):** pending ask → prompt emitted; answer routed into `test/access-relay.test.ts` flows; timeout path untouched.
- **Client face (tickets 20/21/24):** pure logic only under `node --test` (roster snapshot reduction, label mapping, steer payload shaping). Component rendering is covered by build success + typecheck, not a DOM harness — no new test toolchain in v1.
- **Regression:** full suite offline green (currently 301 passing; ticket 18's additions compose independently).

---

## 8. Risks and open questions

| Risk / gap | Handling |
|---|---|
| How a third-party `main` page key gets *opened* is unverified (seams Status item 2) | Not specced; `shell.overlay` chosen instead. De-risking a page is a research task, not an assumption |
| Per-session tool scoping unverified (`ctx.tools.register` global) | Execution gate + documented post-activation name leak (§3.8); honest limitation, not a fantasy API |
| Client↔host data channel for the roster unverified | Roster ticket verifies the settings-watch fallback (or finds better) before building UI; panel degrades to "unavailable" copy |
| No client build infra in this repo (host-only today) | Dedicated scaffold ticket (20) before any client surface; host-only fallbacks (§4.2/§4.3) keep every element shippable without it |
| Command invocation `agent` shape is contract-level (.d.ts), not runtime-verified | Verify at integration; refuse-with-error rather than guess (§4.1 fallback) |
| Whether `agent/session-start` fires on HMR reload for an open chat (diagnosis §1.3) | Moot for capture (command-driven now); listener is dormant-without-activation either way |
| `isTopLevel` fail-open when session header inaccessible (`parent-agent.ts:16`) | Preserved (existing documented behavior); flagged, not silently tightened in a UI ticket |
| Official dsh docs site never fetched (seams Status item 3) | All citations are shipped-source; re-verify slot names/service faces at integration (0.1.5-rc.1 preview drift) |
| `deliverToUser` stays unwired — delivery remains conversational-only | Accepted for v1 (§3.5); revisit only if a verified host send seam appears |
| ADR-0005 wording ("ON by default in the multitask profile") reads as auto-capture | Superseded *in meaning* by ADR-0009 (§9): ON now means "activation available", never "primary chat captured" |

---

## 9. ADR plan (written in the implementation tickets, not now)

1. **ADR-0009 — "Activation is an explicit user command; the plugin no longer captures the primary chat on load."** Records: the removal of the `agent/session-start` capture; the deferred parent binding (§3.4); reconciliation with ADR-0005 (flag semantics unchanged; ON means available-not-captured; command activation is not a forbidden live-toggle because it is once-per-session with no off-while-running state). Lands in ticket 19.
2. **ADR-0010 — "Dispatcher client-face surfaces and their data path"** (conditional): records the `shell.overlay` + toolview choices, the roster data-channel decision (settings-watch fallback vs whatever integration verifies), and the no-shadowing rule for shipped slots. Lands with tickets 20/21 only if the data path resolves to something non-obvious; otherwise a paragraph in ADR-0009's consequences suffices. Decision to write it belongs to the ticket implementer, guided by this section.

---

## 10. Ticket split (created as `Issue-tracker/open/19-*.md` … `25-*.md`)

| Ticket | Title | Blocked by |
|---|---|---|
| 19 | Activation lifecycle: deferred capture + /dispatcher-start + flag matrix + ADR-0009 | None — can start immediately |
| 20 | Client-face scaffold: bundle, shell.overlay hello-world, locale namespace | None — can start immediately (independent of 19) |
| 21 | Worker roster/status overlay panel + data plumbing | 19, 20 |
| 22 | Steer input: /dispatcher-steer command (+ optional input.dock affordance) | 19 |
| 23 | Access-request prompt relay via host prompt seams | 19 |
| 24 | Per-worker toolviews (tool.call.toolview) | 20 (21 not required — toolview rows are independent of the overlay) |
| 25 | Coexistence + clean-room QA close-out for #16 | 19–24 |

18 (worker deny-list) is independent and explicitly not a blocker anywhere.

---

## 11. Traceability

| Ticket-16 requirement | Design section |
|---|---|
| Activation model ending the hijack, alternatives weighed | §3, §3.1 |
| Dormant vs active lifecycle, reversible effects | §3.3 |
| Spawn/interrupt authority preserved | §3.4 |
| Delivery path | §3.5 |
| Flag × activation matrix | §3.7 |
| One design answer per element vs verified seam | §4.1–§4.4, §2 |
| Namespacing / conflict rules | §5 |
| New user-facing copy only | §6 |
| Risks incl. unverified gaps + de-risking | §8 |
| ADR plan | §9 |
| Ticket split with blocking edges | §10 |

---

## 12. Non-goals (this design)

- Multi-chat dispatcher coexistence, per-session tool scoping, multi-parent host (diagnosis (c)) — deferred.
- UI-page or daemon dispatcher; wiring `deliverToUser` (diagnosis (d)) — no verified seam.
- Any always-on default-activation behavior — that is ticket 17's layer, built on this model.
- A second transcript DB, notifications infra, or new chat node types — impossible/out of scope per seams.
- Implementing anything in this ticket — design + ticket split only.
