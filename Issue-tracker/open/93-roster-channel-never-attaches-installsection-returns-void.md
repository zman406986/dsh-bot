# 93 — Roster channel never attaches: `settings.installSection` returns void on the live host, so the settings document is never written

**Status:** open
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
2. (offline) A test drives the REAL channel publish (real `apply` →
   activation → roster transition → `rosterChannel.publish`) into a real
   settings document and asserts the `roster` key AND the
   `roster.<dispatcherSessionId>` key land with the parsed snapshot, and
   that `clearSession`/`clearAllSessions` write `null` there.
3. (offline) The fakes model the host contract: `installSection` returns
   `void` (host `dsh-settings/lib/index.js:327-343`, types `:228`) while
   `register` returns the writable scope (host `:281-315`); each touched
   fake's header carries that citation. A fake that still feeds the scope
   through `installSection`'s return is a fake-vs-host gap and must be
   fixed, not worked around.
4. (offline) Promise-aware write path: the host's `Scope.update(patch)`
   returns `Promise<void>` (`dsh-settings/lib/types/index.d.ts:105-108`;
   sync throws only for not-registered/disposed/read-only/non-plain-object
   at `dsh-settings/lib/index.js:443-455`), so a rejecting write must be
   contained by the channel (counted as a failure, no unhandled rejection)
   and a resolved one must still count as a write.
5. `npm test` (0 fail), `npm run typecheck` (both configs),
   `npm run build:client` green with exact numbers recorded here.

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
