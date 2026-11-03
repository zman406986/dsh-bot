# 173 — Two dispatcher classes: chief of staff (human-started) and team leader (summoned)

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** nothing. Copy change plus one argument at the spawn path.
**Origin:** owner-directed, 2026-11-03. The owner supplied both texts verbatim and asked for "a class for dispatcher spawned dispatcher (not human spawned)". This **reverses** the owner ruling of 2026-10-28 (ADR-0032 open question 1, ticket 166) that one policy text served every dispatcher.
**Related:** ADR-0032 (a summoned dispatcher is a top-level session), ticket 166 (that ruling's implementation), ticket 170 (the worker-contract half of the same prompt pass), ADR-0018 (copy policy).

## Problem

One policy text served every dispatcher. The owner's ruling of 2026-10-28 made that explicit: a summoned dispatcher addresses its own user directly, so it got the same instructions as the user's own chat.

In practice the two situations are not the same job. The user's dispatcher is a chief of staff: it talks to one person and delegates their requests. A dispatcher that another dispatcher summoned is running **one large job** that is too big for its context window, and its work is dispatching parts of that job to workers. The owner now wants two texts.

## What was implemented

**`src/core/policy/prompts.ts`**

- `DispatcherOrigin` restored to `"user" | "spawned"`. It had been narrowed to `"user"` when the single-text ruling landed.
- `buildDispatcherPolicySection` branches on the class: `"spawned"` returns the new team-leader text, everything else returns the chief-of-staff text.
- New `buildSpawnedDispatcherSectionEn` / `Zh`: the owner's text, with the 45-minute health check and its five-item template.
- `buildDispatcherPolicySectionEn` / `Zh` replaced with the owner's four chief-of-staff bullets, and `POLICY_SECTION_HEADINGS` / `_ZH` reduced to the H1 only (the two `##` sections are gone).
- `buildStandingRulesBlock` replaced with the owner's six rules, both faces.
- `buildWakeInstructionsBlock` replaced with the owner's steps, both faces.
- `TOOL_DESCRIPTIONS` / `_ZH` shortened across all eight tools. The `spawn_worker`, `message_agent` and `spawn_dispatcher` entries lost detail the policy already states; `message_agent` also stopped naming `list_agents`.

**`src/plugin.ts`** — `onDispatcherSpawned` now passes `origin: "spawned"`. Without this line the new class could never load: the origin defaulted to `"user"` on every spawn.

## Three tool names in the owner's text do not exist on this surface

The supplied team-leader text names three tools. Two are not ours, and each was mapped rather than dropped, with the reason recorded in the function's doc comment:

| Owner's text | Shipped | Why |
|---|---|---|
| "subagents you dispatch with the `subagent` tool" | `spawn_worker` | The host's raw `subagent` tool exists, but its children skip the worker contract, the tool barrier and the ledger entry (`src/worker/preset.ts`). A team leader using it would create children this plugin cannot see, steer or bill to a todo. `spawn_worker` is the same underlying call plus that composition. |
| `list_agents` (health check, step 2) | `check_workers` | `list_agents` belongs to `dsh-tool-subagent-control`, which this plugin does not mount. `check_workers` is the live registry this plugin actually owns. |
| `schedule_create` with `every_seconds: 2700` | prose, no literal argument shape | dsh's scheduling tool takes `every`, not `every_seconds`; it has a 5-minute floor; and it is **session-local** — it fires only while that session is live. The text says what the check is for and that the reminder is session-local, and leaves the argument shape to the model reading the tool. |

The prompt also says a reminder "only fires while this session is live", because that is the host's behaviour and a leader that assumed otherwise would silently lose its health check.

## Known limitation: the class is not restored after a restart

`origin` is chosen at spawn time and is **not** written into the durable `dispatcher_sessions` mark row. A summoned dispatcher that is cold-resumed comes back through the ordinary activation path with no origin, so it receives the **chief-of-staff** text rather than the team-leader text. Its tools, ledger, workers and inbox are all restored correctly; only the instruction class falls back.

Recorded in the code comment on the cold-resume test. Fixing it means adding the class to the durable mark and reading it in `resumeMarkedDispatcher`, which is a persistence change this ticket does not make. Two tests currently pin the fallback so it cannot drift silently.

## Tests

- `test/policy-assembler.test.ts`: describe renamed to the two-class model; the one-text pins and the origin-equality test replaced; new coverage for both classes, generation independence, and the two ZH faces; all tool-description pins repointed at the shortened copy.
- `test/spawn-dispatcher-activation.test.ts`: the summoned dispatcher is asserted to get the team-leader class and the user chat the chief-of-staff one; the cold-resume and grandchild tests pin the known fallback above.
- `test/adapter-policy-inject.test.ts`, `test/restart-honesty.test.ts`: pins moved from `"not the workhorse"` and the retired stop/no-board rules to the new bullets.
- `test/policy-zh-assets.test.ts`: the `list_agents` pin inverted, since the name is deliberately gone.

## Acceptance

- [x] `DispatcherOrigin` accepts both classes and the typecheck passes.
- [x] A human-started dispatcher gets the four chief-of-staff bullets; a summoned one gets the team-leader text.
- [x] `onDispatcherSpawned` passes `origin: "spawned"`, so the class actually loads.
- [x] Both faces of every changed block are EN/ZH matched, with the parity pins passing.
- [x] Tool descriptions shortened in both faces; no test pins stale wording.
- [x] `npx tsc -p tsconfig.json --noEmit` exits 0; the full suite was green (1696 tests) before the test-prune ticket (172) began.
- [ ] Rulebook / PRD note that the 2026-10-28 one-text ruling is superseded — **not yet written**.
- [ ] Live check that a summoned dispatcher really receives the team-leader text — **not run**; needs the live-test protocol in `read-before-running-live-and-browser-tests.md`.
- [ ] The class survives a restart — **deliberately not done**, see the limitation above.

## Constraints

- Adapted copy only (ADR-0018). The owner supplied the text, so it is the owner's own copy, not reference-tree text.
- Both language faces move together.
- No change to which tools a dispatcher has: both classes still get the same eight tools. The class changes the instructions, not the surface.
- ADR-0032 decision 1 (top-level parallel session) is untouched by this ticket. Only the "one text" consequence is reversed.

## Comments

**2026-11-03 — implemented ahead of filing, again.** The owner asked in conversation and the change was made and tested before this ticket existed. The repo rule is to log first; this is the second time in two days that pass went the other way, recorded here rather than hidden.
