# Research 16 (phase 1, part 3) — How the dispatcher hijacks the primary chat, and non-hijacking alternatives

- Question: Exactly which registration(s) make the primary dsh chat behave as the dispatcher? What are the plausible non-hijacking activation alternatives, their blast radius, and forced ADRs?
- Method: bounded read of `src/plugin.ts`, `src/adapter/*`, skim of `src/core/multitask.ts`, ADR-0005, `docs/research/dsh-adapter-api-notes.md`, design-09..14 headers. No web, no runtime, no reference tree. Seam APIs were NOT verified (separate inventory covers that); items depending on unverified seams are flagged.
- Date: 2026-09-17

---

## 1. HIJACK MECHANISM

### 1.1 The registration chain

Everything hangs off one event listener registered in `apply`:

1. `src/plugin.ts:193-195` — when the feature flag is ON, `apply` calls `bindDispatcherLifecycle(ctx, host, multitask, { policyEnabled: enabled })`.
2. `src/adapter/parent-agent.ts:99-116` — that function registers **`ctx.on("agent/session-start", …)`** on the Cordis event bus. This is the hijack registration.
3. On the first `agent/session-start` whose agent passes `isTopLevel` (`src/adapter/parent-agent.ts:14-20`: no parent in header and delegation depth 0; **a missing/inaccessible header also passes**, line 16 `if (header == null) return true`), the listener:
   - captures the live Agent object: `parentAgentRef = agent; dispatcherSessionId = sessionId` (`parent-agent.ts:107-109`) — first top-level wins; later top-level sessions are ignored (`parent-agent.ts:103-106`);
   - binds it as the host's single parent: `host.bindParent(agent, sessionId)` (`parent-agent.ts:110` → `src/adapter/cordis-dsh-host.ts:258-261`, single slot at `cordis-dsh-host.ts:224`);
   - **injects the dispatcher policy** into that agent: `tryInject(agent, assembleSessionPolicy(true))` (`parent-agent.ts:112-114`). The inject is a queued `role: "user"` message with `source.kind: "plugin"` (`parent-agent.ts:23-46`) via `Agent.inject` — context without opening a turn (`parent-agent.ts:49-57`).

From that moment the user's primary chat agent IS the dispatcher. There is no consent step, no target selection, and no other gate than `isTopLevel`.

### 1.2 Reinforcing registrations (what keeps it feeling hijacked)

- **Per-turn reminder** — `ctx.on("agent/status")` (`parent-agent.ts:129-167`): every time the captured dispatcher session turns `running`, the ledger + standing rules are re-injected (`parent-agent.ts:140-147`). The dispatcher persona is refreshed every turn.
- **Wake turns** — worker settles flow `subagent/end` (`cordis-dsh-host.ts:237-255`) → core wakeBus (`src/core/multitask.ts:167`) → `requestDispatcherWakeup` (`cordis-dsh-host.ts:408-426`) → `agent.followup(wakeUserMessage(...))` on the captured primary agent. The wake message is again `role: "user"` with plugin source (`src/adapter/wake-copy.ts:42-53`), cue copy "Background workers finished…" (`wake-copy.ts:11-12`). The user sees assistant turns in their chat that answer work they never asked about there.
- **Global tool registration** — `src/plugin.ts:198-205` → `registerDispatcherTools` (`src/adapter/dispatcher-tools.ts:101-124`) registers the five tools `spawn_worker / check_workers / steer_worker / stop_worker / deliver_result` (`src/core/policy/prompts.ts:8-21`) via **`ctx.tools.register` — the process-global registry** (`ToolsLike.register`, `cordis-dsh-host.ts:69-73`). Tool visibility is not scoped to the captured session; any agent drawing from the global surface sees them while the plugin is enabled.
- **Delivery depends on the hijack** — `deliver_result`'s `deliverToUser` dep is optional and the plugin does NOT wire one (`plugin.ts:198-202` passes only `ctx/multitask/getSessionId`; `src/core/tools.ts:67-71,375-377`). Delivery to the user happens solely because the dispatcher is the primary chat agent and speaks in its own turns (`docs/research/dsh-adapter-api-notes.md:213`, §8 "it is the primary chat agent. No extra send API."). This is the architectural forcing function: today there is **no other delivery path**.

### 1.3 When it activates

- `agent/session-start` fires for `source: 'startup' | 'resume' | 'clear' | 'compact'` (`docs/research/dsh-adapter-api-notes.md:315`). So the hijack lands on the first top-level session event after plugin load — in a single-chat install, the user's main chat, including on resume/clear.
- Undetermined from source alone: whether a chat that is already mid-session when the plugin loads/HMR-reloads gets captured immediately (depends on whether Cordis fires `session-start` on plugin reload) or only at the next session event.

### 1.4 Interaction with the ticket-12 feature flag

- The flag is read once in `apply` (`plugin.ts:153`), the settings section is installed **before** the gate (`plugin.ts:155-157`), and when `enabled` is false `apply` returns early (`plugin.ts:159-163`): no host, no Multitask core, no lifecycle bind, no tools, no worker agent type.
- **Answer: the hijack does NOT happen when the flag is off.** The flag is the sole master switch; there is no partial registration on the OFF path.
- When the flag is ON (default `true`, `plugin.ts:40`), the hijack of the first top-level session is **unconditional**. The inner `policyEnabled` check (`parent-agent.ts:94,112-114`) is redundant — `plugin.ts:193-195` passes the same frozen `enabled` that already got us past the early return.
- Per ADR-0005 the flag is session-scoped, not live (`docs/adr/0005-feature-flag-session-scoped-toggle.md:26-31`; design-12 §2): a settings flip (`src/adapter/settings-section.ts:67-84`, `onChange` is a deliberate no-op) only affects the next `apply`. So a user cannot turn the hijack off for the running chat — they can only prevent the *next* one.
- Net user experience: install the plugin in any profile (or default-on config) → the very next chat they open is silently repurposed as the dispatcher, with hidden policy context, per-turn reminder injections, plugin-authored user-role wake turns, and five new global tools.

### 1.5 Side observation (gap found while reading)

The worker deny-list `WORKER_DENIED_TOOL_CANDIDATES` (`src/worker/tool-barrier.ts:14-30`) denies user/peer/spawn/job/todo tools but **not the five dispatcher tool names**. Workers are spawned with `toolFilter: { deny }` resolved against live global names (`cordis-dsh-host.ts:349-364`), so spawned workers plausibly see `spawn_worker` etc. in their prompt surface. Not runtime-verified; flag for ticket 10 follow-up.

---

## 2. ALTERNATIVES (non-hijacking activation)

Common constraint for ALL alternatives: `spawnWorker`/`interruptWorker`/`sendMessage` require a **live parent Agent object** (`cordis-dsh-host.ts:336-339, 381-398`; interrupt authority `{ kind: 'ancestor', agent: parent }`). So every alternative still captures or creates *some* live Agent — the design question is **which agent, and by what consent**, plus **who delivers to the user** (see 1.2: delivery currently has no path other than "dispatcher is the primary chat").

### (a) Opt-in command

- **Mechanism sketch:** a user-invoked command in a chat (e.g. `/dispatch` or equivalent dsh command idiom) flips that chat into dispatcher mode for the session. The lifecycle still listens on `agent/session-start`, but capture is deferred: policy is injected and the host parent bound only when the command fires in a session (tool-exec-style session resolution already exists structurally — `plugin.ts:211-227` pulls session ids from exec shapes for `request_access`).
- **Seam needs:** a plugin-facing user-command registration seam in dsh — **UNVERIFIED** (seam inventory pending). Fallback without a command seam: a global `start_dispatching` model tool gated to no-op unless the calling session is top-level — weaker (model-invoked, not user-invoked).
- **Pros:** explicit consent; primary chat stays stock until asked; smallest change; keeps the conversational delivery path (dispatcher still talks in the opted-in chat, satisfying PRD "only the dispatcher delivers").
- **Cons:** activation mid-conversation injects policy late (behavior differs from session-start injection); user must know the command; a stray command still hijacks that chat for the session.
- **Open questions:** does dsh expose a command seam to plugins? Does `Agent.inject` mid-session compose identically to session-start injection? Should the command also be able to deactivate (ADR-0005 forbids live flag flips — does a command activation count as the same forbidden state)?

### (b) Session-scoped toggle extending the ticket-12 flag

- **Mechanism sketch:** keep ADR-0005's read-once-freeze semantics, but source the flag **per session** instead of per plugin install: at `agent/session-start`, read a session-scoped marker (session template/profile identity, a session-header attribute, or a per-session settings entry) and only capture sessions flagged as "dispatcher sessions." Stock chats in the same process stay stock.
- **Seam needs:** a session-scoped config/profile-identity source readable at session-start — **UNVERIFIED**. The current settings section (`settings-section.ts`) is plugin-namespace-scoped, not session-scoped; `permissionPresets` shows dsh has per-session durable-log overrides (`docs/research/dsh-adapter-api-notes.md:284-305`), so an analogous per-session control idiom plausibly exists.
- **Pros:** perfectly consistent with ADR-0005 (no live toggle, no off-while-running state — the flag is just evaluated at each session's start rather than once per process); "multitask profile" becomes a real per-session product concept; zero consent friction for dispatcher-intended chats.
- **Cons:** needs a UX for *creating* a dispatcher session (how does a user open one?); if the marker is profile-level rather than session-level it degenerates into today's behavior for that profile.
- **Open questions:** what session-start-visible datum distinguishes a "dispatcher session"? Can the settings UI write per-session state, or only plugin config?

### (c) Per-chat activation (multi-chat coexistence)

- **Mechanism sketch:** replace the single `parentAgentRef`/`parent` slot with a registry of activated sessions (`Map<sessionId, AgentLike>`). Chats opt in/out independently (via (a)'s command or (b)'s per-session marker — the activation trigger composes with either). Policy inject, per-turn reminders, and wake followups target only activated sessions; the five tools gate execution on "calling session is activated." Core already supports multi-session: todo ledger, `drainWake`, and wakeBus are all sessionId-keyed (`src/core/multitask.ts:135,151,167`).
- **Seam needs:** per-session tool scoping (today `ctx.tools.register` is global — `dispatcher-tools.ts:120` — so non-activated chats would still see the five tools unless dsh can restrict a registered tool per session) — **UNVERIFIED**. Persistent per-session activation store (storageDomain KV exists, `plugin.ts:165-167`; a session-event idiom for plugin-owned state is unverified).
- **Pros:** dispatcher and ordinary chats genuinely coexist; closest to the PRD's "dedicated dispatcher chat" without inventing new surfaces; core is already shaped for it (sessionId-keyed).
- **Cons:** host refactor is real (single-parent assumptions throughout `cordis-dsh-host.ts`); without per-session tool scoping, tool-surface leakage undermines isolation; two activated dispatchers raise cross-delivery questions (whose user? same user?).
- **Open questions:** per-session tool restriction seam? Does core tolerate two concurrently active dispatcher sessions end-to-end (wake bus turn-owner logic, access relay targeting)? How is "the user" defined per session?

### (d) Dedicated UI surface (web UI page) instead of the chat

- **Mechanism sketch:** the dispatcher stops being a chat persona at all. Variant **d1 (UI page):** a dsh web-UI page lists todos/workers with spawn/steer/stop/deliver controls driving the core directly; delivery lands in the UI, not a chat. Variant **d2 (dispatcher-as-daemon):** the plugin *creates its own* headless Agent via dsh's agent-creation surface (AgentRegistry create/resume is cited in `docs/research/dsh-adapter-api-notes.md:416` but **not verified here**) and binds *that* as the host parent; the primary chat is never touched, and the daemon's chat (if surfaced at all) is a dedicated dispatcher chat the user visits deliberately. d2 can exist without any UI seam and is the minimal non-hijacking end-state.
- **Seam needs:** d1 requires a web-UI/plugin-page extension seam — **UNVERIFIED and high-risk to assume**. d2 requires programmatic agent/session creation owned by the plugin (plus lifecycle: persistence across restart pairs with the ADR-0006 durable markers, `plugin.ts:165-167`).
- **Pros:** zero chat hijack by construction; cleanest product separation ("dispatcher is a place you go", not "your chat was repurposed"); workers' delivery target is unambiguous.
- **Cons:** biggest build; d1 likely blocked if dsh has no UI seam; loses free conversational steering/delivery unless the UI re-implements it; PRD's "completed means delivered to user" must be re-grounded (what counts as *delivered* — a UI push? an unread badge?); daemon must survive restarts (markers exist but full FSM restore is unproven).
- **Open questions:** any dsh UI extension seam at all? Can a plugin-owned Agent persist across process restarts and receive `followup` wakes? Does `deliver_result`'s semantics survive when "the user" is a UI surface rather than the chat?

---

## 3. BLAST RADIUS

| Alternative | Files/modules that change | Forced architectural decisions (ADR) |
|---|---|---|
| (a) Opt-in command | `src/adapter/parent-agent.ts` (split *capture* from *activate*; activation-time policy inject; `isTopLevel` gate moves into the command path); `src/plugin.ts` (register command/tool; thread activation state); `src/core/tools.ts` + `src/adapter/dispatcher-tools.ts` (gate tool execution on calling session == activated session; needs exec session resolution in core deps, pattern at `plugin.ts:211-227`); `FakeDshHost`/tests for activation ordering. Core (`multitask.ts`) largely unchanged. | New ADR: "dispatcher activates by explicit user act in a chat"; must reconcile with ADR-0005 (is command activation a forbidden live-toggle? recommend: no — it happens once at session scope, never off-while-running, or off means workers run to completion per the superseded ADR-0005 rule). |
| (b) Session-scoped toggle | `src/plugin.ts` (session-start-time flag source); `src/adapter/parent-agent.ts` (capture only flagged sessions); `src/adapter/settings-section.ts` (possible second, session-scoped control — seam-dependent); profile docs. | ADR amendment to ADR-0005: *what defines* a "session with the dispatcher" (plugin config → session marker). If the marker is a profile, the multitask-profile story needs updating. |
| (c) Per-chat coexistence | `src/adapter/cordis-dsh-host.ts` (parent slot → per-session map; `bindParent/unbindParent/spawnWorker/interruptWorker/sendMessage` all parent-relative today); `src/adapter/parent-agent.ts` (multi-capture); `src/core/tools.ts` + dispatcher-tools (session gating); `src/core/multitask.ts` (verify, likely no change — sessionId-keyed); FakeDshHost single-parent assumptions; new activation store module. | ADR: multi-dispatcher coexistence + tool-visibility policy (global tools visible to all chats vs per-session scoping). If scoping is unavailable, an ADR-level decision to accept leakage or wrap tools is forced. |
| (d) UI surface / daemon | Everything in (c) plus: new `src/daemon/` (or sidecar) owning agent creation/lifecycle; delivery rework (`deliverToUser` finally wired — `core/tools.ts:67-71` was built for this); durability/restart path for the daemon (ADR-0006 markers get a new owner); d1 additionally a whole UI module. | ADR (major): "dispatcher is no longer the primary chat agent"; delivery surface redefined (amends PRD §2/S5 wording and the todo `completed`-means-delivered rule); restart/resurrection semantics for the daemon; possibly a PRD amendment, not just an ADR. |

Forced decisions common to all: (1) *some* live Agent must always be bound as spawn/interrupt authority — the change is consent and identity, not elimination; (2) the delivery story must be answered explicitly, because today's only delivery mechanism is "the dispatcher is the primary chat" (`docs/research/dsh-adapter-api-notes.md:213`).

## Handover

- Seam existence (command seam, session-scoped config, per-session tool restriction, UI page, agent creation) was deliberately **not verified** — the separate seam inventory governs.
- Undetermined from source: whether `agent/session-start` fires on plugin HMR reload for an already-open chat (1.3).
- Side gap for ticket 10 follow-up: worker deny-list omits the five dispatcher tool names (1.5).
