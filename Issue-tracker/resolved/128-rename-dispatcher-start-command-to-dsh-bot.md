# 128 — Rename the /dispatcher-start command to /dsh-bot

**Status:** resolved
**Labels:** ready-for-agent
**Related:** ADR-0030 (the ruling record), ticket 129 (removes `/dispatcher-stop`, same ruling), ADR-0009 (explicit-activation path — substance stands, only the command NAME is superseded)

## Ruling

2026-10-21 human in-session ruling, item 1 (verbatim quote of the whole ruling is in ADR-0030): turn `dispatcher-start` into `"/dsh-bot"`. The activation command's NAME becomes `dsh-bot`, invoked as `/dsh-bot`. Zero behavior change beyond the name.

## What to do (acceptance criteria)

- [ ] `DISPATCHER_START_COMMAND` value becomes `"dsh-bot"` in `src/adapter/activation-command.ts` (was `"dispatcher-start"`, line 19). Only the VALUE is ruled; renaming the constant is optional cleanup, not required.
- [ ] Registration title/description updated: `DISPATCHER_START_DESCRIPTION` in the same file, plus any other copy that names the old command. (`DISPATCHER_START_SUCCESS` names `/dispatcher-steer` — a different command; leave it.)
- [ ] All tests pinning `"dispatcher-start"` updated. Verified pins of the literal string: `test/activation-lifecycle.test.ts:483`. Everything else pins the constant (`DISPATCHER_START_COMMAND`/`DISPATCHER_START_DESCRIPTION` from `src/adapter/activation-command.ts`) and follows the value change automatically — re-exporters: `src/adapter/index.ts`, `src/index.ts`; importers include `src/adapter/session-kind-projection.ts` and the collision-message pins in `test/plugin-scaffold.test.ts`, `test/multi-dispatcher.test.ts`, `test/roster-snapshot.test.ts`, `test/access-prompt.test.ts`, `test/composition-polish.test.ts`.
- [ ] Docs updated: `docs/surfaces.md` rows 243/255 (activation command). The PRD and repo README do not name the command (verified 2026-10-21 at filing). ADR dated notes are already in place at filing (ADR-0009/0024 Status lines, ADR-0030, and the `docs/adr/README.md` rows); add nothing further unless implementation reveals a conflict.
- [ ] Zero behavior change beyond the name: same handler, same activation path, same refusal copy semantics, same registration/unregister lifecycle. The old `dispatcher-` prefix no longer binds this command's name — the human's chosen name governs (note the constant's prefix comment in the same file).

## Constraints

- Do not touch `/dispatcher-stop` here — that is ticket 129's. If the two tickets land in one pass, keep the changes separable.
- Offline tests only; no live dsh run is needed to verify a rename (smallest test set that can fail: the command-name and copy pins).

## Comments

### 2026-10-21 — filing

Filed from the 2026-10-21 human ruling, recorded as ADR-0030. Codebase facts verified at filing: `DISPATCHER_START_COMMAND = "dispatcher-start"` (`src/adapter/activation-command.ts:19`), registration at `src/plugin.ts:1212`.

### 2026-10-21 — docs + client comments half

Renamed the activation command in docs and client comments only (no behavior change; stop-command mentions left alone for ticket 129). Lines changed:

- `docs/surfaces.md:243` — inventory row: `/dispatcher-start` → `/dsh-bot`.
- `docs/surfaces.md:255` — dormant-boot activation sentence: `/dispatcher-start` → `/dsh-bot`.
- `src/client/index.ts:41` — comment: command transaction name → `/dsh-bot`.
- `src/client/index.ts:303` — comment: session-kind projection's `command/run` pair name → `/dsh-bot`.
- `src/client/session-kind.tsx:45` — comment: activation name → `/dsh-bot`; line 46's `/dispatcher-stop` left for ticket 129.
- `src/client/actions.ts:26` — comment: retired client-side line constant name → `/dsh-bot`.

`docs/surfaces.md:84` and `:244` mention only `/dispatcher-stop`, so they were not touched (ticket 129's). Gate: `npx tsc -p tsconfig.client.json --noEmit` passes.

### 2026-10-21 — code + tests half

This agent owned `src/adapter/`, `src/plugin.ts`, tests, and `dev/e2e-mock.mjs`; the docs/`src/client` sweep above ran in a parallel agent under the same ticket. Changes:

Code:

- `src/adapter/activation-command.ts` — `DISPATCHER_START_COMMAND` value is now `"dsh-bot"` (constant NAME kept — public barrel API via `src/adapter/index.ts` / `src/index.ts`); the `dispatcher-` prefix comment now records the intentional break per ADR-0030; added `LEGACY_DISPATCHER_START_COMMAND = "dispatcher-start"` (not barrel-exported); factory doc comment updated. `DISPATCHER_START_DESCRIPTION` text unchanged; `DISPATCHER_START_SUCCESS` still names `/dispatcher-steer` (different command).
- `src/adapter/session-kind-projection.ts` — the fold's start-match accepts BOTH `DISPATCHER_START_COMMAND` and `LEGACY_DISPATCHER_START_COMMAND`, so a restart replay of pre-rename logs (literal `dispatcher-start`) still marks the session dispatcher; settle pairing is by `commandId`, so only the start-match needed the dual name. Header doc gained the rename-durability note (ADR-0030). Stop branches untouched (ticket 129).
- `src/adapter/resolve-command.ts` — `/dispatcher-start` → `/dsh-bot` in `DISPATCHER_RESOLVE_NOT_ACTIVE` and `DISPATCHER_RESOLVE_NOT_DISPATCHER`.
- `src/adapter/steer-command.ts` — same swap in `DISPATCHER_STEER_NOT_ACTIVE` / `DISPATCHER_STEER_NOT_DISPATCHER`; header doc notes the ADR-0030 rename.
- `src/plugin.ts` — comments only (apply-path doc, projection comment, activation-lifecycle comment, steer comments) plus the start-command effect label, now `"multitask-dispatcher: dsh-bot command"`; no wiring change. Stop registration and its comment block untouched (ticket 129).

Tests:

- `test/activation-lifecycle.test.ts` — namespaced-names pin now pins `"dsh-bot"` (literal); the `.sort()` pin reordered (`dsh-bot` sorts after the `dispatcher-` names); description pin unchanged.
- `test/client-command-transport.test.ts` — the `/dispatcher-start` literal is now `/dsh-bot`; the `/dispatcher-stop` literal left for ticket 129.
- `test/steer-command.test.ts` — describe title now "flag ON registers dsh-bot and dispatcher-steer exactly once"; the three `commandNames()` pins reordered for the new sort position (that helper sorts).
- `test/restart-honesty.test.ts` — exact-name set reordered (START entry moves to its new sorted slot via the constant); STOP entry and its exemption untouched (ticket 129).
- `test/session-kind-projection.test.ts` — NEW case: a persisted legacy `dispatcher-start` run+done still projects `sessionKind "dispatcher"` after the rename (fail-closed rules hold under the legacy name too).
- `dev/e2e-mock.mjs` — dispatch phase asserts/executes `/dsh-bot`.

Gates (nothing beyond these): `npx tsc -p tsconfig.json --noEmit` — clean. One grouped tsx invocation over the five touched/name-pinning files (`activation-lifecycle`, `session-kind-projection`, `client-command-transport`, `steer-command`, `restart-honesty`): **75 tests, 75 pass, 0 fail**. No npm test, no full suite, no lint:docs, no build, no commit. Status left claimed; resolution waits on the human.

## Answer

Resolved 2026-10-21 — the rename is complete on the shipped tree; the claims below were spot-checked at the cited lines before resolution.

**Command name (the ruling's substance).** `DISPATCHER_START_COMMAND` is now `"dsh-bot"` (`src/adapter/activation-command.ts:25`). The constant NAME is kept — it is public barrel API via `src/adapter/index.ts` / `src/index.ts` — and the `dispatcher-` prefix-convention comment in the same file records the intentional break per ADR-0030 (:18-24). `LEGACY_DISPATCHER_START_COMMAND = "dispatcher-start"` (:28) is exported from its module but deliberately NOT barrel-exported (grep of both barrels: no hit).

**Rename durability.** The session-kind projection fold's start-match accepts BOTH names (`src/adapter/session-kind-projection.ts:217-224`), so persisted logs from before the rename (literal `dispatcher-start`) still project `sessionKind "dispatcher"` after a restart; settle pairing is by `commandId`, so only the start-match needed the dual name. Pinned by the new test at `test/session-kind-projection.test.ts:146` ("still marks a session from a LEGACY dispatcher-start log (ADR-0030 rename durability)").

**Copy.** `src/adapter/resolve-command.ts` (:53, :62) and `src/adapter/steer-command.ts` (:46, :55) refusal copy says `/dsh-bot`; `src/plugin.ts` comments plus the start-command effect label, now `"multitask-dispatcher: dsh-bot command"` (:1217); `dev/e2e-mock.mjs` :586/:590/:594 asserts and executes `/dsh-bot`.

**Docs/client half** (the parallel 2026-10-21 comment above): `docs/surfaces.md` activation rows (written at :243/:255; now :245/:257 after ticket 129's edits shifted lines), `src/client/index.ts:41`/:303, `src/client/session-kind.tsx:45`, `src/client/actions.ts:26`. ADR dated notes were filed with ADR-0030; nothing further added.

**Gates.** `npx tsc -p tsconfig.json --noEmit` clean; one grouped tsx run of the touched/name-pinning suites **75/75**; the ticket-129 pass subsequently re-ran ten suites including these files at **138/138**; client typecheck (`tsconfig.client.json`) clean.
