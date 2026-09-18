# 34 — Client module never materializes in the browser (dsh.client record needs inject/immediately)

**Status:** open
**Labels:** ready-for-agent
**Blocking:** everything client-side (35 and its descendants). Fix this first.

## Problem

The dispatcher's host face loads (boot succeeds, no plugin-load error), but the browser half
never runs: the web UI shows pure vanilla dsh. The client-module system registers our factory
and never materializes it.

Root cause, read from `@deepseek-ai/dsh-client-modules` (0.1.5-rc.1):

- Materialization is consumer-driven. `lib/client.js` `arriveGraphRow` walks each row's
  `inject` package list and arrives those rows first; bootstrap = rows with
  `dsh.client.immediately: true`. A package no one points at and that is not `immediately`
  is registered-but-dormant forever.
- Every shipped `dsh-client-ui-*` package declares `dsh.client.inject: [...]`; our record in
  `package.json` is only `{ platform: "web", external: ["react", "react/jsx-runtime"] }`.

## Acceptance criteria

- [x] `package.json` `dsh.client` record declares `inject` naming the client packages whose
      services the module binds at boot — at minimum `@deepseek-ai/dsh-client-ui-renderer`
      (slots) and `@deepseek-ai/dsh-client-locale` (locale, itself `immediately: true`), plus
      `@deepseek-ai/dsh-client-ui-settings` if the roster settings watch needs it materialized.
      Prefer the smallest set that materializes; justify each entry in the ticket comment.
- [ ] After a launcher boot (`dsh --profile web --patch <overlay>` from the desktop
      `dsh-bot.ps1`), the served page's outer HTML / boot graph contains the
      `dsh-multitask-dispatcher` row and the combo bundle route serves our `client/index.js`
      (the served-page check from `docs/research/dsh-plugin-ui-examples.md` Finding 3).
- [ ] With the module materialized, the roster panel's **dormant composition** (ticket 32)
      is visible in a fresh, non-activated chat — screenshot or Playwright assertion recorded
      in a comment.
- [ ] `/dispatcher-start` activates a chat and the panel switches to the activated
      composition; the five dispatcher tool views render when those tools are called.
- [x] No change to the host half's behavior; offline suite stays green (S8); no new deps.

## Notes

- Keep the path-insert launcher route working; if materialization proves impossible without
  profile-tree installation, document exactly why in this ticket and propose the persistent
  install in a follow-up comment before doing it.
- Follow-on UI work is ticket 35; do not grow scope here.

## Comments

### 2026-09-18 — fix landed: `dsh.client.inject` declared (renderer + locale), no `immediately`

**The fix** — `package.json:9-20` (`dsh.client` record):

```json
"client": {
  "platform": "web",
  "inject": [
    "@deepseek-ai/dsh-client-ui-renderer",
    "@deepseek-ai/dsh-client-locale"
  ],
  "external": ["react", "react/jsx-runtime"]
}
```

Pinned by a regression assertion in `test/client-face-scaffold.test.ts:132-148`
(`declares dsh.client.inject after the shipped idiom; no immediately flag`).

**Why each entry** (ground truth re-read from shipped `@deepseek-ai/dsh-*` 0.1.5-rc.1, MIT):

- `@deepseek-ai/dsh-client-ui-renderer` — provides the `slots` service the module binds at
  boot (`src/client/index.ts:45` Cordis-level `inject: ["slots", "locale"]`): the
  `shell.overlay` roster entry and the five `tool.call.toolview` entries. Renderer is the
  slots owner (research `dsh-plugin-ui-patterns.md` Finding 5).
- `@deepseek-ai/dsh-client-locale` — provides the `locale` service (the
  `multitask-dispatcher` en/zh namespace bound at `src/client/index.ts:112` and panel-wide).
- NOT `@deepseek-ai/dsh-client-ui-settings` — the roster settings watch is a *runtime
  dynamic* `ctx.inject(["settings"], …)` (`src/client/index.ts:80`), not a boot-time bind;
  the `settings` service materializes with the shipped composition regardless, because
  bootstrap-tier `dsh-client-locale` already lists `dsh-client-ui-settings` in its own
  `dsh.client.inject` (its package.json). Smallest set wins, per this AC.
- NOT `immediately: true` — in shipped 0.1.5-rc.1 only the bootstrap tier declares it
  (`dsh-client-ui-renderer`, `dsh-client-locale` package.json records); no ordinary plugin
  package does. The web boot creates a plugin for **every** boot-graph row
  (`runPluginBoot` maps `manifest.plugins` → `loader.create({name})`, then
  `assertEntriesActive` fails loud on any non-activated entry — `dsh-web-frontend` dist),
  and `dsh.client.inject` is "informational package-name dependencies, not Cordis service
  injection" that orders arrival (`DshClientManifest`,
  `dsh-package-manifest/lib/types/types.d.ts:38-52`; `arriveGraphRow` walks inject rows
  before the consumer, `dsh-client-modules/lib/client.js:253-269`).

**Verification done offline** (no live boot/browser — deferred with ACs 2–4 to the ticket-33
launcher/browser pass):

- `npm run build:client` → `client/index.js` 20627 bytes (byte-identical to the previous
  build — the fix is declaration-only).
- Record validated against the shipped host-half parser's exact rules
  (`parseDshClient`, `dsh-client-modules/lib/index.js:140-157`): platform string, inject/
  external string arrays, immediately boolean|undefined → parses clean; `exports["./client"]`
  string form resolves to an existing `client/index.js` that registers
  `window.__ModuleLoader__.load({id: "dsh-multitask-dispatcher", …})` — the artifact the
  combo route serves.
- `npm test` → 515 pass / 0 fail (146 suites), including the module-behavior fixture
  coverage behind ACs 3–4: dormant composition view model
  (`test/client-roster-panel.test.ts`), `/dispatcher-start` activation lifecycle
  (`test/activation-lifecycle.test.ts`), five tool views from persisted state
  (`test/client-toolviews.test.ts`).
- `npm run typecheck` clean (both tsconfigs); `npm run build` clean; no new deps; host-face
  behavior untouched (declaration-only diff: `package.json` + one test).

**Remaining for close-out:** the three unchecked ACs need one real launcher boot
(`dsh --profile web --patch <overlay>`): served-page/boot-graph row check (Finding 3
method), dormant composition screenshot/Playwright assertion, `/dispatcher-start` flip +
tool-view render. These are exactly the ticket-33 browser pass; nothing further to change
in code for this ticket.

### 2026-09-18 — re-pass #2 vs AC 4: activation is now REAL host-side (command matches, policy injects live) but the panel composition never flips — AC 4 stays unchecked, blocked by two recorded defects

Evidence: `C:\Users\TZhen\Desktop\dsh-live-repass2-2026-09-18\` (ticket-44 re-pass #2; full probe chain in the ticket-44 comment). `/dispatcher-start` via `commands/execute` MATCHES and the following turn carries two `上下文注入 · multitask-dispatcher` rows (session policy + reminder live — `shots/09`). But the browser capsule stays `data-dot="dormant"` with footer `data-flag="unknown"` before and after reload, even with a roster document manually present in the settings namespace — the client watch (`ctx.inject(["settings"], …)`, `src/client/index.ts:128`) never fires (ticket 44 re-pass comment, defect 2), so this AC's "panel switches to the activated composition" clause cannot render. The tool-view clause is additionally blocked by ticket 45 (provider rejects every activated turn's tool schemas, so no tool call ever executes to render). AC 4 deliberately NOT checked; no code changed.

### 2026-09-19 — re-based onto the wrapper-UI vehicle (ADR-0018; ticket 64)

The materialization research and fix (`dsh.client.inject` consumer-driven arrival graph, ADR-0014's
contract) is host-mechanism knowledge and survives as design input. This ticket's open ACs 2–4
(served-page boot-graph row, dormant composition visible, `/dispatcher-start` flip + toolviews)
are capsule-vehicle assertions — moot under the wrapper vehicle. Kept open as a research record;
the wrapper shell scope ticket owns the new boot/materialization design (a standalone wrapper is
not a plugin client module and does not ride this contract).
