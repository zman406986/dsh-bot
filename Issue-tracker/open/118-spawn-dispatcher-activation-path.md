# 118 — `spawn_dispatcher` + spawned-dispatcher activation path

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** 114, 116
**Related:** ADR-0025 (§Settled bounds: no self-imposed cap), ADR-0019 (per-dispatcher scoped tools), ADR-0003 (worker-leaf rule retained), ADR-0027 (dispatcher identity), ticket 123 (session-kind indicators), design `.scratch/adr-drafts/2026-10-18-messaging-await-mitosis-design.md` §8 (untracked input, not authority)

## Problem

A dispatcher can spawn workers but not another dispatcher. ADR-0025 rules mitosis in: a summoned dispatcher carries the full dispatcher tool surface and policy, is a peer of its creator, and keeps its own state. Nothing implements the spawn or the activation path that makes a spawned child a dispatcher rather than a blank subagent.

## What to do

- [ ] Add `spawn_dispatcher(title, prompt)` for dispatcher sessions only. Spawn through `ctx.subagents.startActivation` with provider `spawn`, `delivery: "parent"`, `label: title`, and **no `agentPreset`** (the child joins the parent's composition, which is what "full tool set" means here).
- [ ] **Pass `maxDepth = parentDepth + 2`.** `maxDepth` is the child's absolute ceiling, not a level count: one hop for the child dispatcher itself, one for the workers it will spawn. Passing `parentDepth + 1` accepts the child and then refuses every worker the child tries to create. The worker path already derives its own ceiling this way (`workerSpawnMaxDepth` in `src/worker/agent-def.ts`); mirror that idiom and cite it.
- [ ] Build the activation path (`activateSpawnedDispatcher(agent, sessionId)`):
  1. `host.bindParent(childAgent, childSessionId)`;
  2. register the dispatcher tool set through the child's own scope (`childAgent.ctx.tools`, ADR-0019), holding disposers per session;
  3. inject the dispatcher policy;
  4. add the session to the lifecycle registry **without the top-level gate** (the existing `activate()` refuses non-top-level agents and stays unchanged for user chats);
  5. publish the roster mirror and run the durability rebuild for the child session.
- [ ] **No recursion gate and no live-dispatcher cap of our own.** ADR-0025 settles: the host's `maxDepth` and the 8-active-subagent root pool are the only bounds. Do **not** implement `recursion-limit`, `dispatcher-cap`, generation counters, or a durable spawn budget — the design note's proposals there are explicitly not adopted.
- [ ] Do not pre-empt pool starvation. A child dispatcher's workers and the creator's workers draw on one root pool. If refusals show up as `ACTIVATION_LIMIT_REACHED` during normal use, record it as an incident; do not add a reservation scheme.
- [ ] Tool result: `{ ok: true, dispatcher_id, title, note }`; refusals limited to what is real — `unknown-target`-class input errors and host spawn errors surfaced honestly. No invented caps.
- [ ] No stream key and no todo item: a dispatcher is not a work stream.
- [ ] Verify (not assume) the child's identity signal: confirm a live spawned dispatcher's `projectionValues.agentPreset` matches whatever preset the child actually runs, and record the answer. ADR-0027 records dispatcher identity as `agentPreset === 'multitask-dispatcher'` **conditional on that preset existing and landing on live sessions**; this ticket is where that is checked. If it fails, record the reduced shape rather than inventing a marker (`appendPluginRecord` is not available to third-party plugins).
- [ ] Unit tests: the activation request carries provider `spawn`, no `agentPreset`, and `maxDepth = parentDepth + 2`; the child's tools register into the child's scope; policy is injected; `isDispatcherSession(child)` is true; the child can spawn a worker; the child's wake bus state is separate from the creator's; a second-level dispatcher spawn is refused by the **host depth ceiling**, not by a gate of ours.

## Constraints

- The worker-leaf rule is untouched: a worker never spawns anything and never messages another agent.
- The child gets its own ledger, steer queue, inbox, and wake state (ADR-0019). Nothing is shared with the creator.
- A child dispatcher speaks only to its creator. Do not add a child-to-user path.
- Live checks follow `read-before-running-live-and-browser-tests.md`: kill timer at launch, trivial tasks, evidence under `.scratch/testing/2026-10-18-<slug>/`.
- Offline tests first; the two claims that need live confirmation are the depth ceiling on a two-level tree and `projectionValues.agentPreset` for a spawned dispatcher.

## Comments

### 2026-10-18 — filing

Filed from design note §12 ticket 118, corrected against ADR-0025's settled bounds. The design note proposed a generation-1 gate and a live cap of 4; the owner rejected both after seeing the host evidence. This ticket therefore implements **no cap of ours** and treats the host's pool as the only wall.

Blocked by 114 (host port) and 116 (a child dispatcher is only useful once it can be messaged).
