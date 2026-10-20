# Research: reference architecture patterns vs dsh candidates

- Question: For each architecture-review candidate in the dsh product tree, how does the reference tree structure the same concern — so we can imitate where it helps and diverge deliberately where it does not?
- Scope: reference tree only (`reference material-NOT LICENSE SAFE DONT COPY-grok bot/`). Structure and behavior in plain language; no code, prompts, tool strings, identifiers, or protocol artifacts copied.
- Related: `reference-behavior-notes.md` (behavior), `prd-vs-reference-capability-gaps.md` (features). This note is about **module shape**, not feature parity.
- Date: 2026-09-17

---

## 1. Wake composition (dsh candidate C1)

**Reference pattern**

- The settle-to-wake path is handled by the runtime and the transcript extension, not by the composition root.
- Pure prompt builders sit **next to the class that turns completions into wake-up turns** as free functions (batch completions into one wake text; variants for completions whose work started from a routine, which prefer silence).
- The composition root only does turn-run wiring; it does not own wake text.
- Injection is a **hidden follow-up user turn** (silence allowed), never a system message and never worker→user delivery.
- That class does **not** expose a single “compose wake text” method: builders are separate exports; the class calls them at injection time.
- Testability: builders are pure exports (good unit surface); full settle→run path needs mocks.

**Evidence (paths only)**

- `source/host/extensions/transcript/completion-revivals.ts`
- `source/host/extensions/transcript/runner-registry.ts`
- `source/host/runner/background-work.ts`, `subagent-runtime.ts`
- `source/host/host-runner-composition.ts` (turn wiring only)

**dsh gap**

`composeWakeText` lives in `plugin.ts` (composition root), captures a `Multitask` reference that is bound later, and is delivered through a host callback. FakeDshHost never exercises it.

**Imitation**

Keep wake-text assembly as pure, co-located functions; call them at injection time; hidden follow-up turn with silence allowed. Aligns with moving composition out of `plugin.ts` into core policy/wake — not necessarily a Multitask method, but never private code buried in the plugin.

---

## 2. Coordinator interface (dsh candidate C2)

**Reference pattern**

- Real multitask hub is a **large public object that owns everything**: a session/run/roster/send root with ~18 public collaborator objects, ~21 dependency-injection setters, ~40+ thin wrapper methods, plus an untyped catch-all access point.
- Callers mostly **reach into subsystems** through public fields; the wrapper methods dispatch on strings.
- A separate small feature module holds executor profile + todo tool + prompt section — not the coordinator itself.
- Leftover interface surface exists (registry methods that do nothing; the wrapper methods are not compile-checked against the collaborator objects).

**Evidence**

- `source/host/extensions/transcript/transcript-manager.ts`
- `source/host/sand-multitask.ts` (feature module, not the hub)
- `source/host/extensions/transcript/extension.ts` (wiring)

**dsh note**

dsh’s Multitask (~20 methods + 4 public sub-objects) is the same *direction* but less extreme.

**Do not imitate.** ADR-0004: inventory features, adopt only what serves the product goal and S1–S9. Narrow typed dispatcher; keep queues/ledgers private. This is a **deliberate structural difference** from the reference, not a feature gap.

**Worth keeping as a private module (not public hub surface):** the reference’s run-scheduler lanes (user > agent/peer > background, plus a watchdog that abandons a stuck run so a waiting user turn can proceed). dsh’s wake-bus already encodes the same priority idea — keep that knowledge internal; do not expose the bus as part of Multitask’s interface.

---

## 3. Leftover interface surface & access (dsh candidate C3)

**Reference pattern**

- Leftover interface surface exists: registry methods that do nothing; wrapper methods that dispatch on strings; policy text that names tools which are never registered (directory tools).
- **No parent-side resolve tool for worker access asks.** Two paths:
  1. Local-tool permission: UI card → host resolve → widget settle. Parent cannot answer.
  2. Auto-review: blocked actions raise user-facing approval cards; worker escalates by retrying the same tool. Explicitly no separate approve tool.
- Parent stays responsive; the human is the decider.

**Evidence**

- `source/host/extensions/local-tool-permission/`
- `source/host/runner/sand-auto-review.ts`
- `source/host/runner/tools/` (management tools)

**dsh note**

ADR-0008 deliberately chose a **structured relay in which the dispatcher answers** (or applies policy) — not the reference's path of raising a UI card for the human. That is a product decision, not a claim of imitation.

**Still a real leftover interface problem:** the policy text says "answer with resolve_access" but the product never registers that tool. Either register it or rewrite the policy. The same test applies to `noteToolCall`, `deliverToUser`, `onWorkerTurnStarted`.

---

## 4. Host ports (dsh candidate C4)

**Reference pattern**

- **Many small interfaces** under `source/host/ports/` (transport, telemetry, analytics, mcp-state, box, user-computer) plus roster fan-out as tiny interfaces.
- The live host **crams** extension lifecycle, roster bookkeeping, runner composition, gateway emit/health/dispose into one object.

**Evidence**

- `source/host/ports/*`
- `source/host/sand-host.ts`
- `source/host/host-roster-bookkeeping.ts`

**Do not imitate the crammed object.** Prefer small roster/storage interfaces; one owner for emit. dsh already has a clean `DshHost` + Fake — keep core depending only on that; move ownership/emit/bind to adapter-only.

---

## 5. Where policy and prompt text lives (dsh candidate C5)

**Reference pattern**

Text is **scattered**: base system prompt, section composer, multitask policy module, per-tool prose, the wake-up prompt sent to a peer, steer wrapper, the code that schedules wake-up turns, extra section collector. Tool description+schema+handler are co-located per tool factory.

**Evidence**

- `source/host/runner/system-prompt.ts`, `system-prompt-assembly.ts`
- `source/host/sand-multitask.ts`
- `source/host/runner/tools/*`
- `source/host/agents/agent-messaging.ts`
- `source/host/runner/background-work.ts`
- `source/host/extensions/transcript/completion-revivals.ts`

**Imitation / divergence**

Keep tool def + description + handler together. Prefer **fewer places** than the reference — dsh's five is already better than the reference's many; consolidating is still a locality win, not a chase for parity.

---

## 6. Durability markers (dsh candidate C6)

**Reference pattern**

- Durable = small JSON ledgers kept alongside the data (versioned envelope, atomic rename): pending wakes, owed acknowledgements, upgrade-resume markers.
- **Not** full worker reconstruction. Live worker sessions, steers, run promises are in-memory. Restart retries wakes and acknowledgements, not workers.
- Wake-marker fields are **declared twice in two modules** (the same set of fields encoded in both, with no shared schema module).

**Evidence**

- `source/host/extensions/transcript/sand-ack-obligation-store.ts`
- `source/host/extensions/transcript/sand-pending-wake-store.ts`
- `source/host/extensions/transcript/sand-upgrade-resume-store.ts`
- `source/host/extensions/transcript/durable-file-policy.ts`
- `source/host/runner/subagent-runtime.ts`

**dsh note**

ADR-0006 is a **deliberate divergence**: durable minimum-to-reconstruct `WorkerRecord` (for S4 undelivered results) + in-memory `SteerTicket`. Reference would let workers forget everything on restart and only retry wakes and acknowledgements.

**Still worth imitating (mechanism):** obligation markers through a small interface, not a second database. A single place for the schema is an improvement on **both** trees (the reference declares the fields twice).

---

## Summary table

| Candidate | Reference does | Imitate? |
|---|---|---|
| C1 wake composition | Pure builders next to the wake-up handler; not composition root | **Yes** — out of `plugin.ts` |
| C2 coordinator | Public all-in-one hub object | **No** — deliberate narrow wrapper |
| C3 leftover interface surface / access | Some leftover methods; the human answers, no parent resolve tool | **Partial** — close the leftovers; keep ADR-0008 relay |
| C4 host interfaces | Many small interfaces + one all-in-one live object | **Yes interfaces, no all-in-one object** |
| C5 policy text | Many places; tools co-located | **Yes tools co-located; fewer places** |
| C6 durability | Markers for wakes/acks; field lists declared twice | **Yes markers; single schema; keep ADR-0006** |

---

## Open / unclear

- Exact lane-preemption when a priority peer interrupts a *background wake-up run* (behavior notes already mark this partial).
- Whether reference’s ack-obligation store covers “the settle was recorded but the user never saw it” the same way dsh’s todo+marker aims to (S4) — likely similar intent, different mechanism.
- Whether a narrower dsh Multitask would still need a public wake-bus for adapter turn bounds, or two turn methods suffice — design decision, not reference fact.
