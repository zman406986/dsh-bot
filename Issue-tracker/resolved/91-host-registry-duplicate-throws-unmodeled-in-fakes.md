# 91 — Host registry duplicate-name throws are unmodeled in the apply-driving fakes

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** none
**Related:** 86 (the hygiene pass that found this — inventory rows 16/17/19),
44 (effect/registration shape), 84/85 (the fake-vs-host divergence class),
25 (the coexistence suite, the only place the duplicate rules ARE modeled)

## Problem

Ticket 86's fake-vs-host inventory found that the host registries our plugin
writes to during `apply()` are **fail-loud on a duplicate name**, and the
offline fakes we drive `apply()` with are **not**:

- `ctx.commands.register(def)` — a second registration of the same command
  name THROWS
  `command "X" is already registered (for a per-agent variant, mount a command-injected plugin under that agent's \`agent.ctx\`)`
  (`@deepseek-ai/dsh-commands/lib/index.js:82`, `NamedEntries` error factory).
- `ctx.tools.register(def)` — a second registration of the same tool name
  THROWS
  `tool "X" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`
  (`@deepseek-ai/dsh-tools/lib/index.js:2538`, same `NamedEntries` factory).
- `ctx.settings.installSection(owner, ns, …)` — a second claim of the same
  namespace THROWS `settings namespace "X" is already registered`
  (`@deepseek-ai/dsh-settings/lib/index.js:283`).

Why this is the HIGH-risk class and not cosmetics: every one of these
registrations rides an effect that runs at `apply()`
(`src/plugin.ts:591-631` generator effects for the three commands;
`registerDispatcherTools` for the tool surface; `installSection` for the
settings namespace). A duplicate throw inside that effect **aborts the whole
activation** — the ticket-84/85 amplifier: the user gets a dead plugin (or the
host's fail-loud screen), not one degraded surface.

Today the only fakes that model these throws are in
`test/coexistence.test.ts` (`:151-200` settings, `:240` commands) — and only
because that suite's whole point is coexistence etiquette with a simulated
second plugin. Every other apply-driving host fake silently accepts a
duplicate (`plugin-scaffold.test.ts:93-99`, `activation-lifecycle.test.ts:146-152`,
`feature-flag.test.ts:98-104`, `steer-command.test.ts`, `restart-honesty.test.ts`,
`roster-snapshot.test.ts`, `multi-dispatcher.test.ts:189-196`,
`composition-polish.test.ts`, `access-prompt.test.ts`,
`adapter-dispatcher-tools.test.ts:16-60`, `tool-schema-shape.test.ts:88-106`),
so a double registration would pass the 1,000+-test offline gate and only fail
live.

## Scope

Teach the existing per-file fakes the shipped rule — the ticket-84/85/86
method: no shared fake framework, one seam at a time, host citation in the
fake's header comment.

## Acceptance criteria

1. (offline) Every apply-driving host fake's `commands.register` and
   `tools.register` throws on a duplicate name with the host's wording
   (`dsh-commands/lib/index.js:82`, `dsh-tools/lib/index.js:2538`), and each
   touched fake's header carries that citation.
   **DONE 2026-09-19.** Contract re-verified first-hand against the installed
   tree `C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\` (0.1.5-rc.2):
   `dsh-commands/lib/index.js:82` (`CommandLayer` → `new NamedEntries(...)`,
   global-scope copy `command "X" is already registered (for a per-agent
   variant, mount a command-injected plugin under that agent's \`agent.ctx\`)`),
   register path `:257-260` (`layers.effect(this.ctx, (layer) =>
   layer.commands.insert(...))`); `dsh-tools/lib/index.js:2538` (`ToolLayer`,
   `tool "X" is already registered (for a per-agent variant, register through
   that agent's \`agent.ctx\` instead)`); the shared mechanism is
   `dsh-scope/lib/index.js:15-33` — `insert()` does `if (data.has(name)) throw
   this.duplicateError(name)` and returns an idempotent per-entry undo;
   scoped layers use the same factory (`dsh-tools/lib/types/index.d.ts:595-601`
   "duplicates within one layer … fail"). **15 register sites across 12 files
   aligned** (all now throw the host's verbatim message; header citation added
   in each touched file):
   `plugin-scaffold.test.ts:109`/`:130`, `activation-lifecycle.test.ts:65`
   (scoped `agent.ctx.tools`)/`:165`/`:186`,
   `feature-flag.test.ts:106`/`:178`, `coexistence.test.ts:240`/`:271`
   (command copy also corrected to the verbatim backticked text),
   `composition-polish.test.ts:196`/`:217`, `access-prompt.test.ts:735`/`:756`,
   `steer-command.test.ts:113`/`:134`, `restart-honesty.test.ts:191`/`:212`
   and the second fake `:513`/`:531`, `roster-snapshot.test.ts:1053`/`:1071`,
   `multi-dispatcher.test.ts:115` (scoped)/`:216`/`:237`,
   `tool-schema-shape.test.ts:105`, `adapter-dispatcher-tools.test.ts:41`.
   Inventory was grep-exhaustive: exactly these 12 files hold a host
   `register(definition)` fake (`src/core/fake-host.ts` has none).
2. (offline) At least one new negative-control test proves the rule fires:
   pre-register a command (and a tool) with one of our own names, then drive
   `apply()` over that fake and assert the apply throws the host message —
   the offline detector for a double registration.
   **DONE 2026-09-19.** `test/plugin-scaffold.test.ts:443` (pre-claim
   `dispatcher-start`, `apply()` throws `command "dispatcher-start" is already
   registered`) and `:459` (pre-claim `spawn_worker`, activation throws
   `tool "spawn_worker" is already registered`). RED-verified: with the two
   duplicate checks short-circuited the pair fails 2/12; restored, 12/12 pass.
   Per-fake-family pins added too (25 new tests in total, matching the
   1049 → 1074 gate delta; one command + one tool per
   apply-driving fake): `activation-lifecycle.test.ts:412`,
   `feature-flag.test.ts:433`, `composition-polish.test.ts:679`,
   `access-prompt.test.ts:1324`, `steer-command.test.ts:563`,
   `restart-honesty.test.ts:922`, `roster-snapshot.test.ts:1293`,
   `multi-dispatcher.test.ts:658` (plugin-level + per-agent SCOPED),
   `tool-schema-shape.test.ts:135`, `adapter-dispatcher-tools.test.ts:88`,
   `coexistence.test.ts:797` (a latecomer cannot claim `spawn_worker` or the
   foreign plugin's tool, and the first claimant's definition stays live).
   No existing assertion was weakened or deleted.
3. (offline) The settings-namespace duplicate rule is either taught to the
   remaining fakes that model a settings service, or the inventory's MED note
   is answered with the reason it cannot apply there (the ticket-86 inventory
   row 19).
   **DONE 2026-09-19 — taught, not excused.** `dsh-settings/lib/index.js:283`
   (`register()`: `if (this.registrations.has(parsedNs)) throw new Error(
   \`settings namespace "${parsedNs}" is already registered\`)`; the claim is a
   fiber effect, `:293-298`). Every settings-modeling fake now throws the same
   copy on a second claim of one namespace:
   `feature-flag.test.ts:200`, `multi-dispatcher.test.ts:155`,
   `composition-polish.test.ts:165`, `restart-honesty.test.ts:119`,
   `roster-snapshot.test.ts:1005`; `coexistence.test.ts:163` already had it.
   Pinned in `restart-honesty.test.ts:950`, `roster-snapshot.test.ts:1320`,
   `multi-dispatcher.test.ts:699`. (The inline one-shot stub inside
   `feature-flag.test.ts:355` is a test-local object, not a host fake.)
4. `npm test` (0 fail), `npm run typecheck` (both configs), and
   `npm run build:client` are green after the pass, with exact numbers
   recorded in this ticket.
   **DONE 2026-09-19.** Pre-pass baseline measured on the same tree by
   stashing the pass (`git stash push -- test/`): **1049 tests / 257 suites /
   0 fail**. After the pass: **`npm test` 1074 tests, 264 suites, 1074 pass,
   0 fail**; `npm run typecheck` exit 0 (tsconfig.json + tsconfig.client.json,
   no diagnostics); `npm run build:client` green — `client\index.js`
   **161087 bytes** (unchanged: no client code touched).

### Mirror-image check (ticket step 4): product-side double registration

- Same-session re-activation is guarded — `src/plugin.ts:445`
  (`if (sessionToolDisposers.has(sessionId)) return;`); the global
  `request_access` surface is reference-counted (`src/plugin.ts:411-441`).
- Re-apply after full teardown is clean (teardown `src/plugin.ts:664-687`
  releases every name). Pinned: `test/plugin-scaffold.test.ts:365` (dispose-all
  → fresh `apply()` → activate again, no duplicate throw).
- Two dispatcher SESSIONS in one host take the per-agent scoped path on a live
  host (`src/plugin.ts:480-486`); each agent loop mints its own scope
  (`dsh-agent-loop/lib/index.js:761-762` `this.ctx = this.scope.ctx`;
  `dsh-agent/lib/types/runtime-types.d.ts:149` makes `ctx` required), so there
  is no collision. The plugin-level fallback is the documented
  single-dispatcher shape, and a second session on a scope-less stub host now
  fails LOUD where the old fake silently replaced the first session's closures
  (mis-routing its calls). Pinned as a limitation, not as desired end-state:
  `test/activation-lifecycle.test.ts:412`; the live-shape two-chat test was
  moved onto scoped agents (`:375`) so the suite stops asserting a host shape
  that cannot exist live.
- Two `apply()` calls on ONE host ctx throw on the second
  (`command "dispatcher-start" is already registered`) — characterized this
  pass with a throwaway script; that is the correct loud outcome for a
  double-instance and matches the host's own fail-loud registry (the dsh
  loader loads a plugin once). No product fix needed; no test pinned.

## Notes

- Filed by the ticket-86 agent (2026-09-19) from the AC1 inventory; the
  inventory rows are `Issue-tracker/open/86-fake-vs-host-client-contract-gaps-44-45-84-85-class.md`
  ("Comments", rows 16/17/19).
- Renumbered 90 → 91 at the merge train (2026-09-19): a parallel workstream
  filed `90-restart-honesty-carried-verifier-findings.md` in the same window;
  the merge kept that one at 90 and moved this file to 91. The ticket-86
  inventory references were updated to match.
- The per-agent scoped registry (`agent.ctx.tools`, `dsh-tools` same
  `NamedEntries`) is in scope for the same reason: the access tool and the
  per-session tool surfaces register there.
- Deliberately NOT in scope: `slots.inject` declaration-wait modeling and the
  84-class guard coverage in non-scaffold client suites (inventory rows 8/9,
  MED — recorded, each with its mitigation).

## Comments

- **2026-09-19 (wt/91)** — All four ACs met; resolved.
  - Re-verified the host contract first-hand before trusting the ticket (the
    installed tree is the flat `C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\`,
    not `profiles/web/node_modules/...`; all packages 0.1.5-rc.2). Exact
    throw sites and copy: `dsh-commands/lib/index.js:82`,
    `dsh-tools/lib/index.js:2538`, `dsh-settings/lib/index.js:283`, with the
    shared `NamedEntries.insert` duplicate check at
    `dsh-scope/lib/index.js:15-33`. The `register` paths route through that
    insert (`dsh-commands/lib/index.js:257-260`), and the scoped agent layer
    uses the same factory — so the per-agent `agent.ctx.tools` fake is the same
    class, confirmed by `dsh-tools/lib/types/index.d.ts:595-601`.
  - Aligned 15 register sites in 12 files to the host's verbatim messages and
    added the file:line citation to each touched header. Two copy fixes:
    `coexistence.test.ts` had dropped the backticks around `` `agent.ctx` ``
    (now verbatim), and its `tools.register` silently overwrote (now throws).
  - 25 new pin tests (command + tool per apply-driving fake, plus the settings
    namespace in the three settings-modeling fakes with an exposed provider,
    plus the scoped-registry case in `multi-dispatcher`), and one
    mirror-image pin: `plugin-scaffold.test.ts:365` re-applies after
    dispose-all and must find every name free.
  - RED evidence: with the `plugin-scaffold` duplicate checks short-circuited,
    its two negative controls fail (2 fail / 10 pass); restored, 12/12 — then
    13/13 with the re-apply pin.
  - No existing assertion was weakened or deleted. The one existing test that
    went red under the aligned fake was
    `activation-lifecycle.test.ts` "a second chat activates as its own
    dispatcher": it drove two CONTEXT-LESS stub agents, which take the
    plugin-level fallback (documented single-dispatcher, `src/plugin.ts:480-486`).
    That is not live-reachable (every agent loop mints `agent.ctx`), so the
    test was moved onto scoped agents (the live shape) and the fallback's
    single-session limitation is now pinned explicitly instead of being
    silently mis-modeled. No product code changed — the product paths are
    correct: same-session guard `src/plugin.ts:445`, ref-counted global access
    tool `:411-441`, complete teardown `:664-687`.
  - Gates on the settled tree: `npm test` **1074 tests / 264 suites / 1074
    pass / 0 fail** (pre-pass baseline on the same tree: 1049 / 257 / 0, so
    +25 tests, +7 suites); `npm run typecheck` exit 0 on both configs;
    `npm run build:client` green, `client\index.js` 161087 bytes (byte-identical
    to the ticket-86 figure — no client code touched).
  - Handover: nothing left in this ticket. Adjacent MED rows from ticket 86
    (slots.inject declaration wait; the 84-class guard coverage in the
    non-scaffold client suites) were deliberately out of scope here; the
    non-backticked command message in `coexistence.test.ts` was the only copy
    drift found, and it is fixed.
