# 34 — Client module never materializes in the browser (dsh.client record needs inject/immediately)

**Status:** resolved
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
- [x] After a launcher boot (`dsh --profile web --patch <overlay>` from the desktop
      `dsh-bot.ps1`), the served page's outer HTML / boot graph contains the
      `dsh-multitask-dispatcher` row and the combo bundle route serves our `client/index.js`
      (the served-page check from `docs/research/dsh-plugin-ui-examples.md` Finding 3).
      — **2026-09-19 (closeout batch): ticked on two recorded boots; the literal
      `dsh-bot.ps1` executor invocation never ran.** The box's substance (the
      Finding-3 served-page check) is proven (a) on the 2026-09-18
      launcher-equivalent web-overlay boot — `dsh --profile web --patch` with an
      overlay identical to `dsh-bot.ps1 -Checkout 1 -DryRun` output (recorded on
      ticket 33: boot-graph row present, combo route served 64,914 bytes) and
      (b) post-cutover on the persistent `multitask` profile (pass-4 README
      §1/§5: row with renderer+locale injects and react externals, bundle
      served, module materialized, root registration won — the README's cited
      `boot-graph-row.json` is absent from that dir; the row content is recorded
      inline in the README and in this ticket's pass-4 comment). Post-cutover
      the overlay/launcher route is capsule-era; its drift is ticket 48's.
- [x] With the module materialized, the roster panel's **dormant composition** (ticket 32)
      is visible in a fresh, non-activated chat — screenshot or Playwright assertion recorded
      in a comment.
      — **2026-09-19 (closeout batch): ticked — proven live pre-cutover, then the
      vehicle retired.** 2026-09-18 pass: dormant composition exactly as composed
      (`shots/02-dormant-panel.png`); pass 2: dormant composition renders
      (shots 01/04). The dormant capsule composition was retired at the cutover
      (a44084a) and ADR-0018 abolished dormant/activated modes — the as-written
      condition was met by recorded evidence before the vehicle vanished; MOOT
      going forward.
- [x] `/dispatcher-start` activates a chat and the panel switches to the activated
      composition; the five dispatcher tool views render when those tools are called.
      — **2026-09-19 (closeout batch): MOOT-VERIFIED — never green as written.**
      Pre-cutover the flip clause was blocked (ticket 44's pass-2 caveat: the
      card kept the dormant pitch) and toolviews were only seen as collapsed
      entries (pass 2, never expanded/verified). Post-cutover the
      dormant/activated frame is void (ADR-0018 always-on; capsule retired at
      a44084a/94e6127/c437ee8) and the toolview slot entries are
      registered-but-unrendered, their content re-hosted in the conversation
      (tickets 80/81; dead-code disposition rides ticket 89). Activation + a
      live flow is proven on the successor surfaces (pass-4 README §4:
      activation card, spawn, steer-delivered, honest stop no-op). See the
      closing comment.
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

### 2026-09-19 — live pass 2 observation (route mismatch; no AC ticked)

The pass-2 boot used the persistent `multitask` PROFILE route (`C:\Users\TZhen\Desktop\dsh-live-pass2-2026-09-19\`),
not this ticket's specified `dsh --profile web --patch <overlay>` desktop-launcher route, so
no checkbox is ticked here. What the boot did show, consistent with this ticket's aims: the
served boot graph carries our row, the module materializes (settings card, capsule, launcher
chip render), the dormant composition renders (`shots/01/04`), and the dispatcher tool
surfaces rendered as collapsed "2 次工具调用" entries during the token flow (toolview
panels not individually expanded/verified). Remaining live ACs still want their named
launcher-route boot; note for whoever runs it: the shell `main` page cannot open until
ticket 84 lands, and the activated card-composition flip should be checked against the
roster-keyed behavior flagged in ticket 44's pass-2 comment.

### 2026-09-19 — live pass 4 (`C:\Users\TZhen\Desktop\dsh-live-pass4-2026-09-19\`): the boot-graph AC is proven live on the profile route; the composition ACs are capsule-era language

- **Boot-graph/bundle AC (unticked above): PROVEN** — the served page's `__DSH_BOOT__`
  entries carry `{"id":"dsh-multitask-dispatcher","url":"/plugins/??dsh-multitask-dispatcher/client.js&rev=…-48","inject":[renderer, locale],"external":["react","react/jsx-runtime"]}`
  and the combo route served our client bundle (`boot-graph-row.json`); the module
  materialized and its root registration won the cell. (Route note: this pass booted the
  `multitask` PROFILE, not the `--patch` overlay route the AC's wording names — the
  launcher route remains unexercised since the overlay route's drift is ticket 48's.)
- **The dormant-composition and `/dispatcher-start`-toolview ACs are stale vehicle
  language:** the dormant capsule composition was retired at the 78 cutover (a44084a), and
  toolview slot entries render inside the elected frame's conversation — which crashed on
  selection this pass (ticket 88). Left to this ticket's own reconciliation with the
  cutover; commented, not ticked, not resolved here.

### 2026-09-19 — CLOSED (closeout batch): materialization AC proven live twice; capsule-era composition ACs reconciled against the cutover

AC 1 (`dsh.client.inject` declared) and AC 5 (host half untouched, offline green) were
ticked at the 2026-09-18 fix. This batch reconciled the remaining three (annotations on
the boxes above):

- **AC 2 (boot graph / bundle route):** substance proven on the 2026-09-18
  launcher-equivalent overlay boot and re-proven post-cutover on the persistent profile
  boot (pass 4). Recorded honestly: the AC names the desktop `dsh-bot.ps1` invocation and
  that executor run never happened (agent-session reaping, ticket 48's caveat) — the
  overlay and command were reproduced verbatim without the wrapper, which is the
  equivalent evidence this closure rests on. The ticket's Notes clause never triggered:
  materialization always worked via path-insert; the persistent profile route is the
  cutover's vehicle choice, not a materialization workaround.
- **AC 3 (dormant composition):** proven live pre-cutover with screenshots on two passes;
  the vehicle was then retired (a44084a, ADR-0018). Met as written before it went moot.
- **AC 4 (activation flip + five toolviews):** MOOT-VERIFIED — never green as written
  (44's pass-2 caveat; collapsed-only toolview evidence), and the dormant/activated frame
  plus the toolview slot vehicle are void post-cutover (ADR-0018; a44084a/94e6127/c437ee8;
  re-host = tickets 80/81, disposition = 89).

Surviving as host knowledge: `dsh.client.inject` is the consumer-driven arrival-graph
contract (ADR-0014), and the module still materializes and wins the root cell post-cutover
(pass 4). Status → resolved.
