# 93 — Roster channel never attaches: `settings.installSection` returns void on the live host, so the settings document is never written

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** none
**Related:** 21 (the channel), 46 (the client-side half of the same class —
a contract taken from a doc comment instead of the shipped shape), 47
(settings card), 69 (L1/L2 approval cards + blocked marker), 79 (per-session
mirror keys `roster.<sessionId>`), 81 (approval cards render), 86/91
(fake-vs-host contract-gap class)

## Problem

Live browser pass (2026-09-19): `settings/describe` on the
`multitask-dispatcher` namespace returned only
`["onboarding","enabled","accessRequestTimeoutMs"]` at EVERY check — before
activation, after activation, after a worker spawned, and at the end of the
session. `hasRoster: false`, **zero `roster.*` keys ever**, and
`~/.dsh/settings.yaml` byte-identical to the pre-run baseline.

Root cause (established first-hand against the installed host tree,
read-only — `C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\`,
0.1.5-rc.2): **`SettingsProvider.installSection(...)` returns `void`**, not
the owner scope.

- `dsh-settings/lib/index.js:327-343` — `installSection(owner, ns, schema,
  entry, hooks)` calls `this.register(ns, schema, {base: entry, …})` and
  **discards the return value**; only `setSource`/`onChange` bookkeeping
  follows. (The JSDoc above it at `:276` still says "@returns the owner
  scope for reads, observation, and updates" — stale prose; the shipped type
  is authoritative.)
- `dsh-settings/lib/types/index.d.ts:228` —
  `installSection<…>(…): void`.
- `dsh-settings/lib/index.js:281-315` — `register(ns, schema, options?)` is
  the scope-returning API; the `{get, watch, update, replace}` scope is
  built at `:298-314`. Types: `register(...): SettingsScope<T>` at `:216`,
  `SettingsScope<T>` at `:84-112`.
- The canonical host idiom for a plugin that needs a scope is therefore
  `settings.register(...)`, not `installSection`:
  `dsh-agent-presets/lib/index.js:1311-1318`
  (`ctx.inject(["settings"], (settingsCtx) => { this.settings =
  settingsCtx.settings.register(SETTINGS_NAMESPACE, Schema, {base}) })`).
  The host's own `installSection` consumers use only the hooks
  (`dsh-agent-default-model/lib/index.js:45-52`,
  `dsh-permission-presets/lib/index.js:123`) — never a return value.

Product code: `src/adapter/settings-section.ts:100-110` assigns
`installSection`'s return to `scope` and calls `onScope` only when it is
`!== undefined` — on the live host it always is `undefined`, so
`SettingsRosterChannel.attach` (`src/adapter/roster-channel.ts:151-157`)
never runs, and every `publish` falls into the no-scope branch
(`src/adapter/roster-channel.ts:118-131`) as a silent `skipped` count.
Consequence: the client approval feed stays `unfed` forever (ticket 81's
approval cards never render; ticket 69's L2 blocked-marker-on-session-row is
dead).

Fake gap (the 86/91 class): every offline fake hands a writable scope back
from `installSection` (e.g. `test/approval-feed-composition.test.ts:148-158`,
`test/roster-snapshot.test.ts:1004`, `test/feature-flag.test.ts:197`,
`test/restart-honesty.test.ts:121`, `test/coexistence.test.ts:154`), so the
1,000+-test offline gate passes while the live channel is dead. The fake
accepted a shape the host does not honour.

## Acceptance criteria

1. (offline) `installMultitaskSettingsSection` acquires its owner scope
   through the scope-returning host API (`settings.register(ns, schema,
   {base})`), not through `installSection`'s return value; the module header
   cites `dsh-settings/lib/index.js:327-343` + `types/index.d.ts:228` and
   `dsh-agent-presets/lib/index.js:1311-1318` as the idiom. The
   `multitask-dispatcher` namespace stays registered exactly once (the
   settings card's `describe()` pairing must not break), and `onScope` is
   invoked with the real scope on a provider whose `installSection` returns
   void.
   **DONE 2026-09-19.** `src/adapter/settings-section.ts:141-166` now claims
   through `settings.register(SETTINGS_NAMESPACE, schema, {base: config})`
   and hands the returned scope to `onScope`; the `installSection` seam and
   its `SettingsSectionHooksLike` (no-op setSource/onChange, ADR-0005) were
   deleted rather than kept — a second claim of one namespace THROWS
   (`dsh-settings/lib/index.js:283`), so calling both was never an option.
   Registration parity: `installSection` routes through `register`, so the
   descriptor the ticket-47 card pairs on (`settings.describe`,
   `dsh-api-settings-controller/lib/index.js:429`) is identical — and the
   composition test still asserts the settings card renders from the same
   document. Header citation: `src/adapter/settings-section.ts:1-52`.
2. (offline) A test drives the REAL channel publish (real `apply` →
   activation → roster transition → `rosterChannel.publish`) into a real
   settings document and asserts the `roster` key AND the
   `roster.<dispatcherSessionId>` key land with the parsed snapshot, and
   that `clearSession`/`clearAllSessions` write `null` there.
   **DONE 2026-09-19.** `test/approval-feed-composition.test.ts:520` ("ticket
   93: the real channel publishes BOTH mirror families into the document, and
   unload clears the session key"): real `apply` → real `/dispatcher-start`
   → real `spawn_worker` → the document's `roster` and `roster.s-1` keys both
   parse to the published snapshot, and the plugin's fiber teardown writes
   `null` under `roster.s-1`. The pre-existing composition assertions
   (`publishedRoster(bridge)`, the mirror-key check, the approval card on the
   mount's own store) now ride the host-shaped fake and are the live-bug
   detector.
3. (offline) The fakes model the host contract: `installSection` returns
   `void` (host `dsh-settings/lib/index.js:327-343`, types `:228`) while
   `register` returns the writable scope (host `:281-315`); each touched
   fake's header carries that citation. A fake that still feeds the scope
   through `installSection`'s return is a fake-vs-host gap and must be
   fixed, not worked around.
   **DONE 2026-09-19 — 6 fakes aligned, 4 file headers + 2 fake blocks
   cited.** `test/approval-feed-composition.test.ts:59-86` + the host fake's
   inject (`register()` returns the scope; `installSection()` returns
   nothing); `test/roster-snapshot.test.ts:1000-1030` (header citation
   `:14-24`); `test/feature-flag.test.ts:194-240` (header `:6-13`);
   `test/restart-honesty.test.ts:115-145` (header `:13-24`);
   `test/multi-dispatcher.test.ts:151-186` (header `:10-18`);
   `test/composition-polish.test.ts:158-191` (header `:9-21`);
   `test/coexistence.test.ts:139-215` (fake doc comment `:117-133`) — the
   coexistence fake still pins the duplicate rule and now also pins that
   `installSection` claims but returns nothing (`:830`). Every scope's
   `update` now returns `Promise<void>` like the host.
4. (offline) Promise-aware write path: the host's `Scope.update(patch)`
   returns `Promise<void>` (`dsh-settings/lib/types/index.d.ts:105-108`;
   sync throws only for not-registered/disposed/read-only/non-plain-object
   at `dsh-settings/lib/index.js:443-455`), so a rejecting write must be
   contained by the channel (counted as a failure, no unhandled rejection)
   and a resolved one must still count as a write.
   **DONE 2026-09-19.** `src/adapter/roster-channel.ts:135-170` contains the
   returned promise and counts rejections in the new
   `stats.asyncFailures` (interface `:46-60`); sync throws stay in
   `stats.failures`. Pin: `test/roster-snapshot.test.ts` "contains an ASYNC
   write rejection without an unhandled rejection (ticket 93)" (a rejecting
   scope → `writes:2`, `asyncFailures:1`, `failures:0`, snapshot retained,
   no unhandled rejection — which would fail the node runner).
5. `npm test` (0 fail), `npm run typecheck` (both configs),
   `npm run build:client` green with exact numbers recorded here.
   **DONE 2026-09-19.** `npm test` **1098 tests / 267 suites / 1098 pass /
   0 fail** (pre-pass baseline measured on this same worktree before the
   fake alignment: 1079 / 265 / 43 fail — the 43 are the dead-channel
   detector firing under the host-shaped fake); `npm run typecheck` exit 0
   (both configs, no diagnostics); `npm run build:client` green,
   `client\index.js` **163143 bytes** (was 161087 at the ticket-91 figure —
   the delta is ticket 94's client-side feed; this ticket touched no client
   code).

## Notes

- Filed 2026-09-19 by the wt/pipe agent from the live pass evidence.
- The live hypothesis ("`installSection` returned no scope, or
  `scope.update` threw and was swallowed") is confirmed in its FIRST branch
  by host source: the scope was never obtainable from `installSection` at
  all. The second branch (a throwing `update`) is not reachable while the
  scope is missing; AC 4 makes the async half honest anyway.
- Bug B (ticket 94) is the client-side reader half of the same dead
  pipeline: even with the document written, the shell store's mirror reader
  has no live call site. Fixing only one half does not light the surface.

## Comments

- **2026-09-19 (wt/pipe)** — All five ACs met; resolved. Commits: `db7d459`
  (this ticket + 94 filed), `e4b682a` (the fix), `7a4f01e` (header
  citations).
  - Host contract established first-hand, read-only, against
    `C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\` (0.1.5-rc.2):
    `installSection` is declared `void`
    (`dsh-settings/lib/types/index.d.ts:228`) and its implementation
    discards the scope (`dsh-settings/lib/index.js:327-343` — `register(...)`
    is called, its return dropped; the JSDoc at `:276` still claims
    "@returns the owner scope", stale). `register` returns
    `SettingsScope<T>` (`:281-315`, scope built `:298-314`; type `:216`).
    The host's own scope-holding plugin uses `register`
    (`dsh-agent-presets/lib/index.js:1311-1318`); its `installSection`
    consumers use only the hooks (`dsh-agent-default-model/lib/index.js:45`,
    `dsh-permission-presets/lib/index.js:123`). `Scope.update` returns
    `Promise<void>` (`types/index.d.ts:105-108`), with sync throws only at
    `lib/index.js:443-455`.
  - Product change: `src/adapter/settings-section.ts` (claim through
    `register`, hooks deleted), `src/adapter/roster-channel.ts`
    (promise-aware `write`, `stats.asyncFailures`), plus the export lists in
    `src/adapter/index.ts` / `src/index.ts`.
  - Fake alignment: 6 settings fakes now model both host APIs with the
    file:line citation; every fake scope's `update` is async.
  - RED evidence (fix reverted — the scope dropped on the floor):
    `test/approval-feed-composition.test.ts` fails **2 of 2** —
    `AssertionError: undefined !== 's-1'` (the document has no `roster` key)
    and `AssertionError: the mount's store must be fed` (`'unfed' !==
    'ready'`, the approval cards). Restored: 3/3 (with the ticket-93 pin) →
    5/5 (with ticket 94's pins).
  - Gates: `npm test` 1098 / 267 / 0 fail; `npm run typecheck` exit 0 on
    both configs; `npm run build:client` green, `client\index.js` 163143
    bytes.
  - Handover: nothing left in this ticket. Ticket 94 (the client read side)
    is fixed and resolved in the same pass — the pipeline is whole offline;
    a live browser re-verification (settings/describe showing `roster.*`,
    `hasRoster:true`) belongs to the separate live lane.
- **2026-09-19 (wt/pipe, note)** — The two bugs were NOT one root cause:
    93 was a host-contract mismatch on the write side (scope unobtainable
    from `installSection`), 94 was a missing call site on the read side. They
    are filed separately and fixed as separate commits, per the method.
