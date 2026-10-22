# 129 — Remove the /dispatcher-stop command

**Status:** resolved
**Labels:** ready-for-agent
**Related:** ADR-0030 (the ruling record), ticket 128 (renames `/dispatcher-start`, same ruling), ADR-0021 decision 3 (the add/delete permission — stands as retained internal machinery), ADR-0024 (its client affordance was already withdrawn)

## Ruling

2026-10-21 human in-session ruling, item 2 (verbatim quote of the whole ruling is in ADR-0030): remove `dispatcher-stop`. The `/dispatcher-stop` user-facing command goes away entirely. The lifecycle deactivation machinery STAYS for internal teardown — only the command goes away.

## What this means for the delete affordance

This withdraws the LAST user-facing delete affordance for a dispatcher session. ADR-0021 decision 3's client affordance (floating-window delete button) was already withdrawn by ADR-0024 (native-dsh posture); this removes the command transport too. Deactivation now happens only implicitly — the host `agent/disposed` teardown path and plugin unload. ADR-0021 decision 3's permission itself stands as retained internal machinery; the internal `deactivateSession` sequence (registry drop, `host.unbindParent`, tool-surface unregister, access-policy rows cleared, prompts abandoned, roster mirror cleared) is untouched.

## What to do (acceptance criteria)

- [ ] `src/adapter/stop-command.ts` deleted, and its registration removed from `src/plugin.ts` (the `registerDispatcherStopCommand` call at line 1278 and its import at line 28).
- [ ] `lifecycle.deactivate` and the host `agent/disposed` teardown path KEPT — internal reuse. No deactivation logic is deleted; a dispose-path deactivation must behave exactly as before.
- [ ] Tests pinning the command removed/updated: `test/stop-command.test.ts` deleted with the file. Sweep the remaining `DISPATCHER_STOP_COMMAND`/`"dispatcher-stop"` pins: `test/activation-lifecycle.test.ts` (`:27`, `:486` literal), `test/coexistence.test.ts`, `test/composition-polish.test.ts`, `test/feature-flag.test.ts`, `test/steer-command.test.ts`, `test/plugin-scaffold.test.ts`, `test/session-kind-projection.test.ts`, `test/restart-honesty.test.ts` (its no-stop/cancel structural guard at `:1075` excepts `DISPATCHER_STOP_COMMAND` — re-base it to the stronger pin: NO stop/cancel command is registered at all), `test/client-command-transport.test.ts`.
- [ ] Sweep the non-test importers: `src/adapter/index.ts` re-export block (lines 190–195), `src/adapter/session-kind-projection.ts` (imports `DISPATCHER_STOP_COMMAND`; its command-run kind detection at line 202 must be re-based — a stop command no longer exists), and the stale comment in `src/client/session-kind.tsx:46`. `src/index.ts` does not export the stop command (verified at filing).
- [ ] Docs updated: `docs/surfaces.md` row 244 and the worker-stop scoping note at line 84. ADR dated notes are already in place at filing (ADR-0021/0024 Status lines, ADR-0030, and the `docs/adr/README.md` rows); add nothing further unless implementation reveals a conflict.

## Constraints

- Do not touch `/dispatcher-start` here — that is ticket 128's. If the two tickets land in one pass, keep the changes separable.
- The worker/turn stop exclusion stands (stop-command.ts's own scope note): this ticket adds no worker stop affordance and touches `stop_worker` not at all.
- Offline tests only; no live dsh run is needed (smallest test set that can fail: the registration and teardown pins).

## Comments

### 2026-10-21 — filing

Filed from the 2026-10-21 human ruling, recorded as ADR-0030. Codebase facts verified at filing: `DISPATCHER_STOP_COMMAND = "dispatcher-stop"` (`src/adapter/stop-command.ts:39`); the command handler runs the SAME deactivation the host `agent/disposed` listener runs (`lifecycle.deactivate` → the internal `deactivateSession` sequence), so removing the command removes no deactivation semantics.

### 2026-10-21 — implementation pass (claimed → work done, gates green; left claimed for acceptance)

Removed the command; kept every piece of teardown machinery. What changed:

- **Deleted** `src/adapter/stop-command.ts` and `test/stop-command.test.ts`.
- **`src/plugin.ts`** — removed the `registerDispatcherStopCommand` import (was :28) and the registration effect + its comment block (was :1266-1284). Nothing else in the file touched (its :453 session-kind comment still names `/dispatcher-stop` in passing — left per "touch nothing else"; flag for the next doc pass if wanted).
- **`src/adapter/index.ts`** — removed the whole stop re-export block (was :188-197). `src/index.ts` never exported it (verified by grep).
- **Teardown machinery KEPT and verified in place**: `lifecycle.deactivate` decl `src/adapter/parent-agent.ts:153` + impl :385-387; the host `agent/disposed` listener (parent-agent.ts:255-264, calls the internal `deactivateSession` per-session); the plugin unload `unbind()` path (plugin.ts teardown effect, now ~:1288-1310). A dispose-path deactivation is byte-identical to before.
- **`deactivate()` has no production caller now — kept anyway per the ticket.** In fact it has no caller of ANY kind after this pass (the deleted `test/stop-command.test.ts` was its only direct exercise; the dispose-path tests reach the same `deactivateSession` sequence via `agent/disposed` and `unbind()`). The interface method and impl stay for internal reuse exactly as ruled.
- **`src/adapter/session-kind-projection.ts`** — the STOP fold branches STAY. The `DISPATCHER_STOP_COMMAND` import is replaced by a local exported `LEGACY_DISPATCHER_STOP_COMMAND = "dispatcher-stop"` (:105), mirroring W1's `LEGACY_DISPATCHER_START_COMMAND` pattern; fold match at :236 and the file's doc comments now say the command is withdrawn (ADR-0030) and the fold matches legacy persisted logs only (restart replay of an old stop settlement still clears the mark).
- **Docs** — `docs/surfaces.md` :84-88 (worker-stop scoping note: command withdrawn per ADR-0030, deactivation implicit via host disposal/plugin unload) and the inventory row :244 (State cell now "**Withdrawn** — ADR-0030 (2026-10-21, ticket 129)…", same pattern as the floating-window row). `src/client/session-kind.tsx:46` comment says the stop fold matches legacy logs only and the mark clears implicitly. `docs/adr/` and `docs/research/` untouched.
- **Test pins updated** (every grep hit fixed): `activation-lifecycle` (import, boot array, dormant matrix, :483 literal array), `restart-honesty` (guard re-based — see below), `feature-flag` (array, disposer count 5→4, command counts 4→3 at :275/:345/:368, two comments), `plugin-scaffold` (import, three arrays, disposer count 5→4), `composition-polish` (import, sorted array), `coexistence` (import, three sorted arrays), `steer-command` (import, three arrays), `client-command-transport` (:100 literal now sends a live command name — the :28-61 posture ban on stop/cancel host KEYS stays, and no fixture ever listed stop as permitted), `approval-feed-composition` (:13 header). Stop-fold tests in `session-kind-projection.test.ts` kept as-is except the import now comes from `session-kind-projection.js` (`LEGACY_DISPATCHER_STOP_COMMAND`) since `stop-command.ts` is gone.

**New restart-honesty guard wording** (was "no stop/cancel command beyond the sanctioned session deactivation" with a `DISPATCHER_STOP_COMMAND` exemption): the test is now "the plugin registers no stop/cancel command at all (design-17 §4.6; strengthened by ADR-0030 — ticket 129)" and the filter is unconditional — `names.filter((name) => /stop|cancel/i.test(name))` must be empty, with the message "no stop/cancel-shaped command may be registered (ADR-0030 withdrew the last one)". Strictly stronger than the original pre-ADR-0021 form, as ADR-0030's consequence line asked.

Note: coexistence and composition-polish had pre-existing failures on this tree (ticket 128's rename left their `.sort()` arrays mis-ordered for `dsh-bot`); since this pass edited those exact arrays to drop the STOP entry, they are re-ordered correctly and green — no other 128 work touched.

**Gates (2026-10-21):** `npx tsc -p tsconfig.json --noEmit` → exit 0. One grouped `tsx --test` run of exactly the ten touched files (activation-lifecycle, approval-feed-composition, client-command-transport, coexistence, composition-polish, feature-flag, plugin-scaffold, restart-honesty, session-kind-projection, steer-command) → 138 pass / 0 fail. No npm test / full suite / build / commit, per ticket constraints.

## Answer

Resolved 2026-10-21 — the command is gone, every piece of teardown machinery kept; the claims below were spot-checked on the shipped tree before resolution.

**Deletions and wiring.** `src/adapter/stop-command.ts` and `test/stop-command.test.ts` are deleted (both verified absent); the `registerDispatcherStopCommand` import and the registration effect are out of `src/plugin.ts`; the adapter barrel's stop re-export block is removed (`src/adapter/index.ts` — no stop symbol remains; `src/index.ts` never exported them, grep-verified).

**Projection keeps its memory.** `src/adapter/session-kind-projection.ts` keeps the stop-fold branches via a local exported `LEGACY_DISPATCHER_STOP_COMMAND = "dispatcher-stop"` (:105), fold match at :236 — a restart replay of a historical stop settlement still clears the dispatcher mark, though no live command can produce one any more.

**Teardown kept.** `lifecycle.deactivate` (`src/adapter/parent-agent.ts:153` interface decl, impl :385-387 delegating to the internal `deactivateSession`), the host `agent/disposed` listener, and the plugin-unload `unbind()` path are all in place; a dispose-path deactivation behaves exactly as before. `deactivate()` now has no caller of any kind (the deleted test file was its only direct exercise) — kept per the ticket for internal reuse, as noted.

**Docs.** `docs/surfaces.md` worker-stop scoping note (:84-88) and the inventory row (written at :244; now :246 after line drift) marked **Withdrawn — ADR-0030 (2026-10-21, ticket 129)**, same pattern as the floating-window row; `src/client/session-kind.tsx` comment says the stop fold matches legacy logs only and the mark clears implicitly.

**Guard strengthened.** `test/restart-honesty.test.ts:1062-1077` — "the plugin registers no stop/cancel command at all (design-17 §4.6; strengthened by ADR-0030 — ticket 129)": the exact-name set pins the three surviving commands, and an unconditional filter `names.filter((name) => /stop|cancel/i.test(name))` must be empty ("no stop/cancel-shaped command may be registered (ADR-0030 withdrew the last one)"). Strictly stronger than the original form with its sanctioned-stop exemption.

**Known cosmetic leftover.** `src/plugin.ts:453` still names `/dispatcher-stop` in a passing comment — a parallel wiring agent is fixing it; recorded here so the Answer matches the tree at resolution time.

**Gates.** `npx tsc -p tsconfig.json --noEmit` exit 0; one grouped tsx run of the ten touched suites (activation-lifecycle, approval-feed-composition, client-command-transport, coexistence, composition-polish, feature-flag, plugin-scaffold, restart-honesty, session-kind-projection, steer-command) **138/138**.

**Behavioral note.** This withdraws the LAST user-facing delete affordance for a dispatcher session: ADR-0021 decision 3's permission stands as retained internal machinery, and its last transport (the command — the client affordance was already withdrawn by ADR-0024) is gone. Deactivation is now implicit only, via host `agent/disposed` disposal or plugin unload. That implicitness is the ruling's intent.
