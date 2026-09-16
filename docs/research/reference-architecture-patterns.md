# Research: reference architecture patterns vs dsh candidates

- Question: For each architecture-review candidate in the dsh product tree, how does the reference tree structure the same concern — so we can imitate where it helps and diverge deliberately where it does not?
- Scope: reference tree only (`reference material-NOT LICENSE SAFE DONT COPY-grok bot/`). Structure and behavior in plain language; no code, prompts, tool strings, identifiers, or protocol artifacts copied.
- Related: `reference-behavior-notes.md` (behavior), `prd-vs-reference-capability-gaps.md` (features). This note is about **module shape**, not feature parity.
- Date: 2026-09-17

---

## 1. Wake composition (dsh candidate C1)

**Reference pattern**

- Settle → wake is **runtime → transcript-extension**, not the composition root.
- Pure prompt builders sit **next to the revival orchestrator** as free functions (batch completions into one wake text; quiet-origin variants).
- The composition root only does turn-run wiring; it does not own wake text.
- Injection is a **hidden follow-up user turn** (silence allowed), never a system message and never worker→user delivery.
- The orchestrator does **not** expose a single “compose wake text” method: builders are separate exports; the class calls them at injection time.
- Testability: builders are pure exports (good unit surface); full settle→run path needs mocks.

**Evidence (paths only)**

- `source/host/extensions/transcript/completion-revivals.ts`
- `source/host/extensions/transcript/runner-registry.ts`
- `source/host/runner/background-work.ts`, `subagent-runtime.ts`
- `source/host/host-runner-composition.ts` (turn wiring only)

**dsh gap**

`composeWakeText` lives in `plugin.ts` (composition root), closed over a late-bound Multitask ref, delivered via a host callback. FakeDshHost never exercises it.

**Imitation**

Keep wake-text assembly as pure, co-located functions; call them at injection time; hidden follow-up turn with silence allowed. Aligns with moving composition out of `plugin.ts` into core policy/wake — not necessarily a Multitask method, but never plugin-private glue.

---

## 2. Coordinator interface (dsh candidate C2)

**Reference pattern**

- Real multitask hub is a **large public god-object**: session/run/roster/send root with ~18 public collaborator objects, ~21 DI setters, ~40+ thin facade methods, plus an untyped escape hatch.
- Callers mostly **poke sub-systems** through public fields; the facade is string-dispatched.
- A separate small feature pack holds executor profile + todo tool + prompt section — not the coordinator.
- Overhang exists (no-op registry methods; facade not compile-checked against collaborators).

**Evidence**

- `source/host/extensions/transcript/transcript-manager.ts`
- `source/host/sand-multitask.ts` (feature pack, not hub)
- `source/host/extensions/transcript/extension.ts` (wiring)

**dsh note**

dsh’s Multitask (~20 methods + 4 public sub-objects) is the same *direction* but less extreme.

**Do not imitate.** ADR-0004: inventory features, adopt only what serves the product goal and S1–S9. Narrow typed dispatcher; keep queues/ledgers private. This is a **deliberate structural divergence** from the reference, not a feature gap.

**Worth keeping as a private module (not public hub surface):** the reference’s run-scheduler lanes (user > agent/peer > background, plus a watchdog that abandons a stuck run so a waiting user turn can proceed). dsh’s wake-bus already encodes the same priority idea — keep that knowledge internal; do not expose the bus as part of Multitask’s interface.

---

## 3. Interface overhangs & access (dsh candidate C3)

**Reference pattern**

- Overhangs exist: no-op registry methods; string facade; policy copy that names tools not registered (directory tools).
- **No parent-side resolve tool for worker access asks.** Two paths:
  1. Local-tool permission: UI card → host resolve → widget settle. Parent cannot answer.
  2. Auto-review: blocked actions raise user-facing approval cards; worker escalates by retrying the same tool. Explicitly no separate approve tool.
- Parent stays responsive; the human is the decider.

**Evidence**

- `source/host/extensions/local-tool-permission/`
- `source/host/runner/sand-auto-review.ts`
- `source/host/runner/tools/` (management tools)

**dsh note**

ADR-0008 deliberately chose a **structured relay with the dispatcher answering** (or applying policy) — not the reference’s UI-card waterfall. That is a product decision, not an imitation claim.

**Still a real overhang:** policy copy says “answer with resolve_access” but the product never registers that tool. Either register it or rewrite the policy. Same honesty test for `noteToolCall`, `deliverToUser`, `onWorkerTurnStarted`.

---

## 4. Host ports (dsh candidate C4)

**Reference pattern**

- **Many small ports** under `source/host/ports/` (transport, telemetry, analytics, mcp-state, box, user-computer) plus roster fan-out as tiny ports.
- Live host **gloms** extension lifecycle, roster bookkeeping, runner composition, gateway emit/health/dispose onto one object.

**Evidence**

- `source/host/ports/*`
- `source/host/sand-host.ts`
- `source/host/host-roster-bookkeeping.ts`

**Do not imitate the glom.** Prefer small roster/storage ports; one owner for emit. dsh already has a clean `DshHost` + Fake — keep core depending only on that; move ownership/emit/bind to adapter-only.

---

## 5. Policy / prompt copy homes (dsh candidate C5)

**Reference pattern**

Copy is **scattered**: base system prompt, section composer, multitask policy pack, per-tool prose, peer wake cues, steer wrapper, wake/revive plumbing, extra section collector. Tool description+schema+handler are co-located per tool factory.

**Evidence**

- `source/host/runner/system-prompt.ts`, `system-prompt-assembly.ts`
- `source/host/sand-multitask.ts`
- `source/host/runner/tools/*`
- `source/host/agents/agent-messaging.ts`
- `source/host/runner/background-work.ts`
- `source/host/extensions/transcript/completion-revivals.ts`

**Imitation / divergence**

Keep tool def + description + handler together. Prefer **fewer homes** than the reference — dsh’s five is already better than the reference’s many; consolidating is still a locality win, not a parity chase.

---

## 6. Durability markers (dsh candidate C6)

**Reference pattern**

- Durable = small sidecar JSON ledgers (versioned envelope, atomic rename): pending wakes, ack obligations, upgrade-resume markers.
- **Not** full worker reconstruction. Live worker sessions, steers, run promises are in-memory. Restart redrives wakes/acks, not workers.
- Wake-marker fields are **re-declared in two modules** (dual encoding, no shared schema module).

**Evidence**

- `source/host/extensions/transcript/sand-ack-obligation-store.ts`
- `source/host/extensions/transcript/sand-pending-wake-store.ts`
- `source/host/extensions/transcript/sand-upgrade-resume-store.ts`
- `source/host/extensions/transcript/durable-file-policy.ts`
- `source/host/runner/subagent-runtime.ts`

**dsh note**

ADR-0006 is a **deliberate divergence**: durable minimum-to-reconstruct `WorkerRecord` (for S4 undelivered results) + in-memory `SteerTicket`. Reference would keep workers honest-amnesia and only redrive wakes/acks.

**Still worth imitating (mechanism):** obligation markers through a small port, not a second DB. Single schema home is an improvement on **both** trees (reference dual-encodes).

---

## Summary table

| Candidate | Reference does | Imitate? |
|---|---|---|
| C1 wake composition | Pure builders next to revival; not composition root | **Yes** — out of `plugin.ts` |
| C2 coordinator | Public god-object hub | **No** — deliberate narrow facade |
| C3 overhangs / access | Some overhangs; human answers, no parent resolve tool | **Partial** — close overhangs; keep ADR-0008 relay |
| C4 host ports | Many small ports + live glom | **Yes ports, no glom** |
| C5 policy copy | Many homes; tools co-located | **Yes tools co-located; fewer homes** |
| C6 durability | Markers for wakes/acks; dual field lists | **Yes markers; single schema; keep ADR-0006** |

---

## Open / unclear

- Exact lane-preemption when a priority peer interrupts a *background revival* (behavior notes already mark this partial).
- Whether reference’s ack-obligation store covers “settle landed but user never saw it” the same way dsh’s todo+marker aims to (S4) — likely similar intent, different mechanism.
- Whether a narrower dsh Multitask would still need a public wake-bus for adapter turn bounds, or two turn methods suffice — design decision, not reference fact.
