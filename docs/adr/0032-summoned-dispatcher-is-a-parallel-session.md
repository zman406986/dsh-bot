# A summoned dispatcher is a new top-level session parallel to its summoner, not a subagent child

**Status:** **accepted (human-ruled, 2026-10-28, in-session verbal ruling)** — agent-drafted from that ruling; the human ruled the direction, the text below is the agent's draft of it. It supersedes ADR-0025 decision 6 for the dispatcher→dispatcher edge only; ADR-0025 decisions 1–5 stand. Nothing here is a ban on anything else, and no source is edited by this records pass. **2026-10-29 note: open question 1 is answered** by the owner's in-session ruling of that date — asked whether a summoned dispatcher talks to the user directly or only reports back through its summoner, he answered verbatim: "its the same as any other dispatcher". A summoned dispatcher is therefore a dispatcher: in its own session it addresses the user directly, with its own chat, its own sidebar row and its own user; it reports back to its summoner because the summoner asked it something, not because it is mute. The ADR-0025 decision 6 routing clause stays superseded, and no other open question here is touched. Implementation: ticket 166. **2026-11-02/03 note: the policy is two classes again (owner-ruled; tickets 173 and 175)** — the Consequences line below expecting the "spawned" policy wording to be retired in both languages is **reversed**: that wording came back, as the team-leader class. A dispatcher the human started is the chief of staff; a dispatcher another dispatcher summoned is a **team leader** for one large job, and it has its own session section, its own standing rules and its own wake instructions. The 2026-10-28 reading of open question 1 as "one policy text serves every dispatcher" is superseded along with it; question 1's actual answer — the summoned dispatcher addresses its own user directly — stands for both classes, and so does everything else here (top-level creation, no `origin`/`parentSession`/`delegationDepth` in the session header, no cap of ours, cold resume). The split is about the shape of the work, not about who may speak. Nothing else in this ADR changes, and its body is not edited. **2026-11-16 note: the completion-notice-only loss is superseded — the adapter now pushes the leader's final answer.** The stock-subagent swap left this ADR's `delivery: "parent"` removal as an accepted loss — "the completion notice is the only notice", so no leader final-answer push: a top-level summoned dispatcher has no activation, so `notifySettlement` never runs for it and nothing carried the leader's answer or its stop reason to the dispatcher that summoned it (`docs/research/stock-subagent-duplication-audit.md` §5). That loss is **withdrawn**. The adapter observes the leader's idle edge and sends its last non-empty answer to the summoning dispatcher through the **existing peer lane** (`createTeamLeaderPusher`, `src/plugin.ts:2374`, fed by `notifyTeamLeaderIdle`, `src/adapter/parent-agent.ts:1123`): one envelope per changed answer, deduped against a manual `message_agent` report, addressed to the parent session id the mark row already records; only the summoner's peer wake re-arms it, and one stop-reason line is appended per non-completed turn even while a todo is open. Three qualifications belong on the record: it is **adapter-side** — our plugin's own observation plus the peer send decision 4 already licenses, with no new queue and no new store; it is **not a stock flag** — no host setting makes a top-level session emit a settlement notice, and this note does not ask for one; and **no host package was modified** — the installed dsh tree is untouched, so stock dsh without this plugin still reports nothing upward. Everything else stands: the session shape, the delivery route, the uncapped tree, and the open questions. The body is not edited. **2026-11-16 note: dispatcher visibility is ancestry plus workspace, not process-global.** A dated amendment appended below records it: the prompt peer roster and `message_agent` share one predicate, a hidden peer refuses `unknown-target`, the same-name `list_agents` shadow is a deliberate stock-surface divergence, and workers stay off the peer roster. The decision text above is not rewritten, and no host package is edited.

**Numbering:** 0032, the first free number at filing (2026-10-28; highest in use was 0031, a draft). Filed by the records pass from the owner's in-session approval of `.scratch/repo-analysis/2026-10-28-summon-parallel-session-plan.md` §8 item 1, with the other two decisions of that session recorded in the same file §9. Host claims below are cited to the installed dsh 0.2.1-rc.2 tree; the full base path for the `dsh-*/lib/...` citations is in `.scratch/repo-analysis/2026-10-28-host-parallel-session-feasibility.md` §"Base paths used below".

## Supersession of ADR-0025 decision 6

ADR-0025 records, at `docs/adr/0025-chief-of-staff-dispatcher-mitosis.md:49`, that a summoned dispatcher's work routes through its creator "because the host gives a subagent child no chat surface of its own and hides it from the sidebar". That premise is exactly what the child shape causes: the only structural hide is `origin === "subagent"` (`dsh-client-ui-workspace/lib/client.js:965`), so a session with no `origin` has its own sidebar row. The routing clause is superseded for the dispatcher→dispatcher edge only.

Decision 6's other half — **may a summoned dispatcher eventually address the user directly?** — stays open, and moves from host-refused to merely undecided. It is listed in §Open questions below.

Decisions 1–5 stand unchanged: the Chief-of-Staff framing and the peer-of-creator rule (`:45`), workers stay leaves with one owning dispatcher (`:46`, ADR-0003 binds), a summoned dispatcher's state is its own (`:47`, ADR-0019 binds), and no cap of our own beyond what the host enforces (`:48`). ADR-0025's body is not rewritten — this is recorded as a dated note on its Status line and the index row, the convention recorded at `docs/adr/README.md:162-163`.

## Context

Today a summon goes through `ctx.subagents.startActivation(...)` at `src/adapter/cordis-dsh-host.ts:2237-2251`, and the host stamps the child's header with `parentSession`, `origin: 'subagent'`, and `delegationDepth` (`dsh-subagent/lib/types/child-agent.js:113,117,119`). Everything downstream is compensation for that shape, not a design: a dedicated activation path (`activateSpawnedDispatcher`, `src/adapter/parent-agent.ts:142`), a "spawned" policy wording (`src/core/policy/prompts.ts:288` EN, `:350` ZH), a header chip (`src/client/index.ts:320-338`), a seeded mark mirror (`src/adapter/cordis-dsh-host.ts:2226`, read by `initSessionKindProjection`, `src/adapter/session-kind-projection.ts:330-348`), a `maxDepth = parentDepth + 2` ceiling that exists only for subagents (`src/adapter/cordis-dsh-host.ts:2206-2207`), and peer labels read from the subagent descriptor because a child has no other label source (`src/adapter/peer-label.ts:1-32`, `src/adapter/parent-agent.ts:252`).

The host supports the other shape. `ctx.agents.create()` builds a session **and** an agent in one transaction (`dsh-agent/lib/types/index.d.ts:278`) and is the same call the web UI's "new conversation" makes (`dsh-api-session-controller/lib/index.js:517-525`, `meta` carrying only `cwd`).

## Decision

1. **The summon creates a new top-level session, parallel to the summoner.** One call, then a first turn:

   ```ts
   const handle = await ctx.agents.create({
     sessionId,        // our own reserved id
     // parentAgent OMITTED  -> runtime root, no owning agent context
     meta: { cwd },    // and nothing else: no origin, no parentSession, no delegationDepth
     setup,            // scoped tools + policy composed before the first prompt assembly
   });
   handle.agent.followup(createUserMessage({ content, source }));  // first user turn; wakes the driver
   ```

   `sessionId` is required and `parentAgent` is omitted for a root agent (`dsh-agent/lib/types/index.d.ts:50-52`); `meta` is the optional-field bag whose absent fields stay absent in the header (`:64-71`); `setup` composes scoped tools and prompt sections before anything is visible (`:99-103`). `followup` queues a whole turn and wakes the driver (`dsh-agent/lib/types/runtime-types.d.ts:192`; `dsh-agent-loop/lib/index.js:800-813`). The first turn is not optional: a blank session is hidden until it has one (`dsh-client-ui-workspace/lib/client.js:966`). No `parent`, no `origin`, no delegation depth anywhere in the call.

2. **The ownership guard is an OR, and all three fields must go together.** This is the trap. The guard reads:

   ```js
   // dsh-api-session-controller/lib/index.js:128-134
   function hasApiSessionSubagentOwner(ctx, session, agent) {
     if (session.header.origin === "subagent") return true;
     const parentId = session.header.parentSession;
     if (parentId === void 0 || agent === void 0) return false;
     const parent = ctx.agents.get(parentId);
     return parent !== void 0 && ctx.agents.isOwnedBy(agent.id, parent);
   }
   ```

   Dropping only `origin` is **not** enough. A session that keeps `meta.parentSession` — or that passes `parentAgent` "for convenience" — is still classified subagent-owned by the second arm, and the ordinary Session routes then refuse it as `session/agent-busy` ("use subagent delivery for this child session", `dsh-api-session-controller/lib/types/agent.js:121-123`). `origin`, `parentSession`, and `parentAgent` are omitted together or the session is not parallel in any useful sense.

3. **There is no promotion path.** The session header is immutable and assigned exactly once in the constructor (`dsh-session/lib/types/types.d.ts:59-96`; `dsh-session/lib/index.js:1415`), and no reparent/patch API exists anywhere in the host tree (`.scratch/repo-analysis/2026-10-28-host-parallel-session-feasibility.md` §3, greps listed there). An existing child cannot be re-parented. The session must be created right the first time, which is why this decision is a spawn-call replacement and not a migration.

4. **Delivery between peers is `resolveAgent` + an explicit `followup`.** `ctx.sessionController.resolveAgent(sessionId)` returns a live agent or cold-resumes it, deduped (`dsh-api-session-controller/lib/index.js:221-246`, facade `:3036-3038`), and `agent.followup(msg)` wakes it. A shipped package already does exactly this against sessions it does not own: `dsh-schedule/lib/index.js:1576-1596`. The only guard on that route is the one in item 2, and a clean top-level session passes it. Two hard rules:

   - **Never append a `user/message` into another session's log.** `session.append('user/message', …)` renders in the transcript but never enters that session's inbox and never calls the wake driver — the only step-time append is `dsh-agent-loop/lib/index.js:1072`, and `wakeDriver` is reachable only from `send(..., true)` (`:800-813`, `:854-869`). It looks right and does nothing.
   - **Resume alone runs nothing.** A restored inbox stays parked (`dsh-agent-loop/lib/index.js:841`, `:898`; nothing in the publication path sets `wakeRequested`, `:1942-1956`). Every resume pairs with an explicit `followup`.

5. **No cap of our own.** The depth ceiling and the 8-child pool are subagent-runtime bounds keyed off a parent agent (`dsh-subagent/lib/types/index.d.ts:98-103`; reserved only in the activation path, `dsh-subagent/lib/index.js:1672-1677`; depth resolved only there, `:1396-1399`). Neither touches a session created this way, so a tree of summoned dispatchers is uncapped. We observe before adding a bound — the same stance ADR-0025 records at `docs/adr/0025-chief-of-staff-dispatcher-mitosis.md:48` and reaffirms in its dated note at `:67`.

## Rejected alternatives

- **Keep a hidden subagent edge purely as a message pipe.** The owner rejected it (`.scratch/repo-analysis/2026-10-28-summon-parallel-session-plan.md` §9): the session is created correctly, but a second child session would be retained only to carry messages. It re-imports the shape being removed and keeps the parent-scoped pool and depth in the delivery path.
- **Deliver by appending a `user/message` into the peer's log.** Rejected outright for the reason in item 4: the row renders and nothing runs (`.scratch/repo-analysis/2026-10-28-cross-session-delivery-feasibility.md` §1.2, "Rejected outright").

## Consequences

- **The compensations for the subagent shape retire**: `activateSpawnedDispatcher` and `SpawnedActivationOutcome` (`src/adapter/parent-agent.ts:142`, `:109`) collapse into the ordinary top-level activation; the "spawned" policy wording goes in both languages (`src/core/policy/prompts.ts:288`, `:350`); the header chip goes, leaving the sidebar glyph as the one ADR-0024 seat (`src/client/index.ts:320-338`); the seeded mark mirror and its `init` probe shrink, since a top-level session's own log can run `/dsh-bot` (`src/adapter/cordis-dsh-host.ts:2226`, `src/adapter/session-kind-projection.ts:330-348`); `maxDepth = parentDepth + 2` and `delivery: "parent"` disappear from the spawn path (`src/adapter/cordis-dsh-host.ts:2206-2207`, `:2250`); and the spawner no longer has to be live in this process (`:2194-2198`).
- **Peer labels need a new source.** `subagent.label` exists only on spawned children (`src/adapter/parent-agent.ts:249-250`; read at `src/adapter/peer-label.ts:1-32`). A top-level summoned dispatcher has none, so without a replacement every summoned peer renders its raw session id — a regression against ADR-0027's label chain.
- **The delivery facade is web-profile-only.** `sessionController` is not in the plugin's inject list today (`src/plugin.ts:177-186`) and is mounted by the web-app profile only (`dsh-web-app/cordis.patch.yml:122`). Other deployments need a capability check and a stated degraded mode, not a throw at boot.
- **The cold-resume trigger moves.** `resumeDormantDispatcher` and `requestDormantWorkerWake` (both in `src/adapter/cordis-dsh-host.ts`) resolve a sender through `parents.get(...)` and send via `ctx.subagents.sendMessage`; both swap to `resolveAgent` + `followup`. `flushPendingWakeTurn` must also be reachable from the no-parent branch (`src/adapter/cordis-dsh-host.ts`), or a wake parked during a cold resume is never discharged. `openWakeTurn`'s `followup` half and `resumeUserStartedDispatcher` already assume no parent and survive as-is. **2026-11-07 note: this bullet is half wrong, and the worker half is corrected here.** A worker is still a subagent child (`origin: "subagent"`, `parentSession` set), and the host's ownership guard refuses exactly that shape on `resolveAgent` with `session/agent-busy` (`dsh-api-session-controller/lib/index.js`, `hasApiSessionSubagentOwner`) — the facade cannot cold-resume a worker at all. `requestDormantWorkerWake` therefore stays on `ctx.subagents.sendMessage` from the spawner recorded on the durable `worker_sessions` row, and on a facade refusal the dispatcher half falls back to that same recorded-spawner route for pre-ADR-0032 rows (which point at subagent-owned sessions the facade refuses forever). Only a TOP-LEVEL dispatcher peer rides `resolveAgent` + `followup`. Nothing else in this ADR changes, and its body is not edited.
- **ADR-0031's draft premise is void.** It hangs a mark on the header because stock dsh hides subagent children (ADR-0024 rider). With no `origin` there is a sidebar row. ADR-0031 stays a draft and its body is not edited; the same dated-note convention applies.
- **Downstream prose is no longer stale (re-checked 2026-11-07)**: PRD §6.2/§6.3/§16 and `docs/surfaces.md` no longer assert a depth/pool bound on a summoned dispatcher; they state that the host's subagent bounds do not apply to a top-level session. The original note citing them is superseded, and no body edit is made.

## 2026-11-16 amendment: dispatcher visibility is ancestry plus workspace

**Appended 2026-11-16; the decision text above is not rewritten.** Decision 4 licenses the delivery route but never said **which** peers a dispatcher may list or address. That is now one shared rule, in `src/core/dispatcher-visibility.ts`, used by both the prompt peer roster and `message_agent`:

- **Ancestry, plus workspace only on root↔root edges.** A root dispatcher sees its own direct children and other root dispatchers in the same normalized cwd; a team leader sees its parent, its siblings and its own direct children. Nothing else — no grandchildren, no unrelated dispatcher, no other team. A missing cwd on either root fails closed, so cross-workspace peer messaging is unintended rather than a feature.
- **The offer and the refusal are the same predicate.** A hidden target refuses `unknown-target`, byte-identical to a nonexistent target, so the refusal leaks no existence.
- **The same-name `list_agents` shadow is a deliberate divergence from the stock surface.** On each activated dispatcher's scope a wrapper keeps the stock name, description, schema and output but clamps `descendants` to the caller's direct children; `children` is unchanged and no host package is edited. This is defense-in-depth: a new-style leader is a top-level session, so stock `descendants` already ended at the caller for it, and the clamp covers the legacy parented shape.
- **Workers stay off the peer roster.** A worker is not a `message_agent` peer; it remains visible to its own parent through the durable ledger and stock `list_agents`.

Lineage is read from the durable dispatcher mark's parent, not stock `header.parentSession`: decision 1 creates a summoned leader with no such header field. A mark with no parent is treated as unknown lineage and hidden from root peers.

## Open questions

1. **Does a summoned dispatcher address the user directly, or still report through its summoner?** ADR-0025's question, now host-supported instead of host-refused, and not decided by this records pass.
2. **What bounds a tree of summoned dispatchers?** Nothing today (item 5). Observation first; a bound needs a ticket that states the tradeoff.
3. **What carries a summoned peer's human label?** The `subagent.label` source is gone; the replacement is ticket-level.

## Traceability

- Ruling: `.scratch/repo-analysis/2026-10-28-summon-parallel-session-plan.md` §8 item 1 (approve the direction) and §9 (the same session's messaging, cold-resume, and cap decisions). Owner-approved 2026-10-28 in session; the ADR text is the agent's draft of it.
- Host capability: `.scratch/repo-analysis/2026-10-28-host-parallel-session-feasibility.md` — §1b/§1d (two working create routes), §2 (sidebar visibility, blank rule), §3 (no promotion path; the ownership-guard OR), §5 (subagent messaging is adjacency-only), §6 (bounds do not apply).
- Delivery: `.scratch/repo-analysis/2026-10-28-cross-session-delivery-feasibility.md` — §1.4/§1.5 (`resolveAgent` facade and the `dsh-schedule` precedent), §1.2 (log append never wakes), §4.3 (resume leaves the inbox parked), §6 (what breaks in `src/adapter/cordis-dsh-host.ts`).
- Change surface: `.scratch/repo-analysis/2026-10-28-summon-parallel-session-plan.md` §2 (compensation table), §3 (per-area change), §6 (paperwork list, including the proposed implementation ticket 157).
- ADRs: 0025 (decision 6 superseded; decisions 1–5 stand), 0003 (worker-leaf and single-parent bind), 0018 (U-G amendment for the dispatcher edge is untouched; no new exception), 0019 (per-dispatcher scoped tools — what `setup` must compose), 0024 (one seat, the sidebar glyph), 0027 (peer identity and label chain), 0031 (draft whose premise this voids; not edited).
