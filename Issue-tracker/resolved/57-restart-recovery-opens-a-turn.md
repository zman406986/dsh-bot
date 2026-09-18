# 57 — Restart recovery must open a turn (deviation D-4)

**Status:** resolved
**Type:** task
**Labels:** ready-for-agent
**Blocked by:** none for implementation. **Landed 2026-09-18** — `wakeNotice` now drives activation-time recovery through `Agent.followup`.
**Related:** register item **D-4** and undecided item **U-1**; `docs/research/reference-core-loop-spec.md` G2; `docs/research/dsh-loop-capability-map.md` stage 10; ADR-0009 / ADR-0016; ticket 58 (the obligation redrive lands in that subsystem)

## The deviation

On activation we rebuild from durability and then **queue** a restart notice. The notice uses `agent.inject`, and `inject` **queues context without opening a turn** — `ReactLoopAgent.inject` → `send(input, "next-step", false)`, and `wakeup=false` means `wakeDriver` is never called (`dsh-agent-loop/lib/index.js:795-797`).

The reference, by contrast, **actively drives recovery on boot**: it re-arms pending wakes and re-wakes the parent, handing it a synthetic notice to the effect that a restart ended this background task before its result could be delivered, that the in-process run did not survive, that its final state is unknown, and that the parent should check the transcript and dispatch fresh work if it still matters (`docs/research/reference-core-loop-spec.md` G2).

So the gap is not the *content* — our notice is reasonable. It is the **primitive**: we use one that opens nothing, then wait for the user to happen to send a message.

**The fix is a one-function swap.** `agent.followup` calls `send(input, "next-turn", true)`, and `wakeup=true` invokes `wakeDriver` (`dsh-agent-loop/lib/index.js:789-791,787`); the host contract states a wake submitted while idle **always opens its turn boundary** (`runtime-types.d.ts:175-186`). This was verified against the installed v0.1.5-rc.2 bundle in the ticket-52 pass — it is the same guarantee that makes normal worker-completion delivery work.

## What to change

1. **`src/plugin.ts:414-432`** — `bindDispatcherLifecycle` runs `rebuildFromDurability`, publishes the roster, then `lifecycle.injectNotice(notice)`. Route the notice through the **wake path** (`agent.followup`, i.e. the same primitive used at `src/adapter/cordis-dsh-host.ts:588-606`) instead of `inject`. The notice should *open a recovery turn*, exactly as the reference does.
2. **`src/adapter/parent-agent.ts:231-236`** — `injectNotice` currently calls `agent.inject`. Either change it to wake, or add a `wakeNotice` and use that at activation. Do not change the per-turn reminder path (`parent-agent.ts:176-181`): that one *should* stay `inject`, because it rides an already-open turn.
3. **Keep the honest unknown-state reconstruction exactly as it is.** `src/core/multitask.ts:626-700` restores terminal rows and marks live markers `unknownState`. The audit found this **richer than the reference** and it is `not-a-deviation` — the reference reconstructs *nothing* about the worker either (only re-wakes the parent). Do not "fix" it toward the reference.

## The activation-model caveat — read before designing the trigger

The reference has **no activation step**; it is always-on, so "boot redrive" fires at process start. We activate explicitly with `/dispatcher-start` (ADR-0009), and **ADR-0016 is an unsigned draft that reverses that matrix**. So:

- Implement the redrive at **activation**, which is the only trigger we have — and name it in code as activation-driven, not boot-driven, so the two are not conflated.
- **Do not decide U-1 here.** Whether the activation half is itself a deviation is the human's ruling, folded into ADR-0016's sign-off. This ticket fixes the *primitive* and does not touch the *trigger model*.
- If ADR-0016 is signed, a boot hook becomes possible and the trigger can move; the wake primitive from this ticket is what that future hook would call. Say so in a comment.

## Requirements

- **R1** Restart recovery **opens a turn**. A test must prove the notice is delivered via the waking primitive, not the queueing one — assert on the host call, not on the notice text.
- **R2** The per-turn reminder path stays `inject` (it rides an open turn; waking per turn would be a spawn of extra model calls).
- **R3** The notice content stays honest: unknown state is stated as unknown. No claim of completion.
- **R4** No worker is reconstructed or resumed. Note that the host *does* offer continuable-session cold-resume (`ContinuableActivationRegistry.coldResume`) — our deliberate non-use of it is a core design decision, and this ticket must not quietly reverse it. If reversing it is wanted, that is a separate decision.
- **R5** Offline tests only (S8).
- **R6** Clean-room identifier grep as a gate.

## Acceptance criteria

- [x] Activation delivers the restart notice through `agent.followup`; a test asserts the waking primitive is used. — `src/adapter/parent-agent.ts` gains `tryWake` + `wakeNotice`; `src/plugin.ts:431` calls `lifecycle.wakeNotice(notice)`. The activation test reads the notice out of `agent.woken` **and** asserts zero notices on `agent.injected`, so a regression back to the queueing primitive fails loudly.
- [x] A test asserts the per-turn reminder still uses `inject`. — `test/adapter-policy-inject.test.ts` ("re-injects the per-turn reminder…"), strengthened with `assert.equal(agent.followed.length, 0)` so the reminder is pinned to the queueing channel.
- [x] Unknown-state reconstruction is unchanged, with a comment recording that the reference also reconstructs nothing. — `src/core/multitask.ts` `rebuildFromDurability` gains a doc comment stating the reference reconstructs nothing either and that cold-resume non-use is deliberate.
- [x] `npm test` 0 fail, `npm run typecheck` clean (both configs). — **769 tests / 194 suites / 0 fail**; both tsconfigs clean.
- [x] Clean-room identifier grep: zero product-tree hits. — see Comments.

## Comments

### 2026-09-18 — implemented

**The fix is the primitive, not the payload.** `wakeNotice` reuses the same plugin message shape but hands it to `Agent.followup` instead of `Agent.inject`. Verified host semantics (ticket-52 pass, `dsh-loop-capability-map.md` stage 7): `followup` is `send(input, "next-turn", wakeup=true)` and a wake submitted while idle **always opens its turn boundary**; `inject` is `send(input, "next-step", wakeup=false)` and opens nothing. The recovery notice now behaves like the reference's boot redrive — it is acted on without the user speaking first.

**`injectNotice` was deleted, not left as a second path.** After the swap it had no caller, and an unused second delivery primitive next to the correct one is exactly how the wrong one gets reintroduced. `tryInject` remains for the two paths that genuinely ride an open turn: the activation-time session policy and the per-turn reminder.

**Silence stays silence.** The notice is still `null` when the rebuild report is empty, and a new assertion pins `agent.woken.length === 0` for an uneventful activation — waking unconditionally would burn a model call on every activation for nothing.

**Scope note held:** the trigger stays activation-driven and is named `wakeNotice` (not `wakeBoot`/`redrive`) on purpose, so a future boot hook can call it without the name asserting a trigger model we have not adopted. Item U-1 is untouched.

**Deliberately NOT done:** the obligation redrive pass at activation. It belongs to ticket 58, whose whole point is the bound/`lost`/telemetry layer; adding a redrive here would have created a second incomplete mechanism.

Clean-room grep (`\b(sand|executor)\b|MessageSubagent|SAND_MULTITASK`) over `src/` and `lib/`: **zero hits**.

## Notes

- **This is the cheapest high-value fidelity fix in the set** — one primitive swap. It is blocked on nothing.
- Live verification (does the recovery turn actually open in a real boot) belongs to ticket 33's lane.
