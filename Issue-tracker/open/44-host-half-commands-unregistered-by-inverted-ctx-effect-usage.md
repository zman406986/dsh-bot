# 44 — Host-half commands vanish live: plugin passed registration disposers to `ctx.effect` as if it took cleanup callbacks (cordis runs `execute` immediately; nothing is collected for unload)

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none
**Related:** 43 (host apply now runs live — this is the delta it exposed), 33 (live pass), 09 (adapter wiring)

## Context (symptom + evidence)

Live re-pass 2026-09-18 (`C:\Users\TZhen\Desktop\dsh-live-repass-2026-09-18\`, recorded in the
ticket-43 comment): host-half apply RUNS on the multitask profile route — the settings
namespace `multitask-dispatcher` is described via `/api/settings/describe` with our exact
schema, and the probe-wrapper boot logged apply start → clean return, no activation error
(`dsh-server-multitask2.log`). But our activation command never materializes:

- `commands/list` RPC shows built-ins only (blank and resumed session).
- Composer slash menu (`"/dis"` filter, never submitted) shows no dispatcher command.
- Decisive zero-LLM A/B via `commands/execute` RPC: `/goal` MATCHES, `/dispatcher-start`
  returns `{ok:true}` with no value = UNMATCHED (`rpc-probe-excerpts.txt`).
- Client mirror still dead: footer `data-flag="unknown"` before and after reload.

## Root cause (cited)

**Not "sync registration is a silent no-op" — the registration happens and is then silently
UNDONE at apply time, because our `ctx.effect(...)` calls invert the cordis effect contract.**

1. **The contract.** cordis 4.0.2 `Fiber.effect(execute, label)`
   (`@deepseek-ai/cordis/lib/index.js:1168`, `_execute` at `:1141-1165` — identical in the
   repo's vendored copy) calls `execute` **immediately**; its return value decides the
   cleanup: `function` → collected as the unload disposer (`:1142`), generator → iterated
   synchronously, each `yield` collected (`:1145-1152`), promise → resolved, result
   collected (`:1144`), null/undefined → nothing (`:1143`). `ctx.effect` is mixed from the
   fiber (`:742`). There is no "register a cleanup callback" mode.

2. **Our misuse.** `src/plugin.ts:457` `ctx.effect(disposeCommand)` and `:468`
   `ctx.effect(disposeSteerCommand)` hand the **disposers returned by
   `commands.register`** (via `registerDispatcherStartCommand`,
   `src/adapter/activation-command.ts:122-130`, and `registerDispatcherSteerCommand`,
   `src/adapter/steer-command.ts:168-176`) to `effect` as if they were cleanup callbacks.
   Live, cordis **calls them at once** — unregistering `dispatcher-start` and
   `dispatcher-steer` during apply — and collects nothing (the register wrapper returns a
   promise that resolves to undefined; `safeCollect(undefined)` ignores it). Silent: no
   throw, no log. Worse, `src/plugin.ts:482-492` passes the whole unload teardown as
   `execute`, so live it **runs at apply**: `lifecycle.unbind()`,
   `deactivateToolSurface()`, `accessPrompts.reset()`, `host.dispose()` (drops the
   `subagent/end` + `session/event` subscriptions wired in
   `src/adapter/cordis-dsh-host.ts:383-427`), and `markers.dispose()` (sets
   `disposed=true`, `src/adapter/durable-marker.ts:105-107` — every later marker read/write
   rejects). So even had the commands resolved, activation, wake settle handling, and
   durability were dead on arrival. Only the settings section survives — installed before
   any effect call (`src/plugin.ts:205-207`), which is exactly the observed split.

3. **Shipped idioms agree with the contract, not with our old assumption.**
   `@deepseek-ai/dsh-command-compact` registers inside a generator effect — apply yields the
   register disposer as the effect cleanup (`dsh-command-compact/lib/index.js:88-97`,
   `ctx.effect(function* () { … yield ctx.commands.register({…}) }, "command-compact
   lifecycle")`). `@deepseek-ai/dsh-command-goal` registers bare in apply and drops the
   disposer (`dsh-command-goal/lib/index.js` apply) — valid because the registration effect
   itself lives on the commands service's fiber (`ScopedLayers.effect`,
   `dsh-scope/lib/index.js:189-218`). `/goal` matched live, `/compact` ships — sync
   registration is fine; owning the disposer through an effect is the plugin-lifetime idiom.

4. **Why offline passed.** Every host-half fake implements the inverted shape as "collect
   for unload": `test/plugin-scaffold.test.ts:57-59`, `test/activation-lifecycle.test.ts:75-77`,
   `test/feature-flag.test.ts:63-65`, `test/composition-polish.test.ts:143-145`,
   `test/access-prompt.test.ts:692-694`, `test/coexistence.test.ts:194-196` —
   `effect(dispose) { disposers.push(dispose) }`. Nothing ever invokes the passed function
   at apply, so the self-unregister never happens offline. The client-half fakes already
   model the real contract (`test/client-face-scaffold.test.ts:33,55-61`), and our own
   client half uses it correctly (`src/client/index.ts:109-114`,
   documented at `src/client/context.ts:14-15`).

## Requirements (minimal fix)

1. `src/plugin.ts` — use the effect contract (shipped compact idiom) at all three sites:
   command and steer registrations become generator effects
   (`ctx.effect(function* () { yield register…() }, "<label>")`); the teardown becomes an
   effect whose `execute` RETURNS the teardown function
   (`ctx.effect(() => teardown, "<label>")`). No behavior change offline; no new seams.
2. `src/plugin.ts` `CordisContext.effect` type (`:93-96`) corrected from
   `(dispose: () => void) => void` to the real shape
   (`(execute: () => unknown, label?: string) => unknown`).
3. Host-half test fakes updated to the REAL contract (execute now; collect a returned
   function / generator yields), so a regression to `ctx.effect(disposer)` fails offline —
   `registeredCommands` assertions then pin the shape. Guard tests
   (restart-honesty, composition-polish key-set/copy scans) keep their strength — shape
   updates only, no assertion removal.

## Acceptance criteria

- [x] (offline, gate) `npm test`, `npm run typecheck`, `npm run build:client` green with the
      fakes modeling the real effect contract; after `apply`, the fake's command registry
      still contains `dispatcher-start` + `dispatcher-steer` (the contract-faithful fake
      would expose a regression to the old shape). — **2026-09-18: `npm test` 702/0 (185
      suites; +1 new contract-pin test), typecheck clean (both configs), build:client OK;
      see comment below.**
- [ ] (live, ZERO LLM calls) `commands/list` includes `dispatcher-start` and
      `dispatcher-steer`; the composer slash menu shows the command; RPC A/B
      `commands/execute`: `/dispatcher-start` MATCHES (`value` with `commandId`+result),
      `/goal` still matches as control; the `multitask-dispatcher` settings section is
      visible in the Settings UI (插件配置), and the client footer flag mirror reads a real
      value (no `unknown`).
- [ ] (live, BURNS tokens — last, separate pass, single trivial task per AGENTS.md)
      `/dispatcher-start` intercepts composer input (no plain-text leak) → activation flips
      dormant→activated → one trivial worker spawns, delivers, completes →
      `/dispatcher-steer` reaches it → stop → dormant. Owner: the follow-up live pass, not
      the offline fix.

## Verification

- Contract read from the host's own packages (all MIT, 0.1.5-rc.1): cordis
  `Fiber.effect`/`_execute`, `dsh-scope` `ScopedLayers.effect`, `dsh-commands`
  `CommandRuntime.register` (`lib/index.js:257-260` — the register lands on the commands
  fiber via `ctx.effect`), `dsh-command-compact` apply, `dsh-command-goal` apply.
- Reproduction logic: with the contract-faithful fake, the CURRENT plugin.ts leaves
  `registeredCommands` empty after `apply` (both disposers invoked as `execute`), matching
  the live `commands/list` observation exactly.
- Prior pass evidence that framed the (superseded) generator-only hypothesis: ticket 43
  re-pass comment; probe wrapper `probe-wrapper.mjs` (outside the repo).

## Notes

- Ticket 43's re-pass hypothesis ("a generator effect queued on the already-started
  commands-service context plausibly never executes") is REFUTED — cordis runs generator
  bodies synchronously at `effect` call time (`:1145-1152`), and goal's bare sync register
  demonstrably resolves live. The failure is our inverted `effect` usage, not the sync
  call itself.
- Live ACs for tickets 33/34/35/09/10/11/32 stay untouched here; they await the same
  separate pass as AC 3.

## Comments

### 2026-09-18 — offline fix landed (AC 1 green); live ACs 2–3 await the separate pass

Implemented exactly the Requirements, no other product files touched (`dispatcher-tools.ts`
checked: it registers on activation and its disposers are held by the lifecycle, never
handed to `ctx.effect` — no flaw there; `activation-command.ts`/`steer-command.ts` were
already correct — they return the register disposer).

- `src/plugin.ts`: both command registrations are now generator effects yielding the
  register disposer (the shipped `dsh-command-compact` idiom, labeled effects
  `multitask-dispatcher: dispatcher-start/steer command`); the teardown effect's `execute`
  now RETURNS the cleanup (labeled `multitask-dispatcher: plugin teardown`);
  `CordisContext.effect` retyped to `(execute: () => unknown, label?: string) => unknown`.
- Contract-faithful fakes (execute now; collect returned function / drain generator) in
  `test/activation-lifecycle.test.ts`, `test/plugin-scaffold.test.ts` (+ its `effect`
  type and a new pin: "command registration survives apply (cordis effect contract,
  ticket 44)" — asserts both commands still registered after apply and that the 3 collected
  disposers really unregister them), `test/feature-flag.test.ts`, `test/access-prompt.test.ts`,
  `test/steer-command.test.ts`, `test/coexistence.test.ts` (host half; client half was
  already correct), `test/composition-polish.test.ts`, `test/restart-honesty.test.ts` (2 fakes),
  `test/roster-snapshot.test.ts`. Guard tests untouched in strength — the dormant-matrix,
  restart-honesty, and composition-polish assertions all pass unchanged; generator laziness
  was the one trap (a fake that calls `execute()` without draining the iterator never runs
  the registration — the initial red run proved the pin bites).
- Gates: `npm test` 702 pass / 0 fail / 185 suites (701 prior + the new pin); `npm run
  typecheck` clean (root + client configs); `npm run build:client` OK (64,658 bytes).
- Replay of the live symptom, offline: reverting plugin.ts to `ctx.effect(disposer)` against
  the new fakes leaves `registeredCommands` empty after apply — matching the live
  `commands/list` (built-ins only) and the `/dispatcher-start` UNMATCHED probe exactly.
- Not done here (per the pass split): live ACs 2 (zero-LLM surfaces) and 3 (token flow) —
  they are the follow-up pass's script, together with the still-open 33/34/35/09/10/11/32
  live ACs.

### 2026-09-18 — live re-pass #2 (evidence: `C:\Users\TZhen\Desktop\dsh-live-repass2-2026-09-18\`, outside the repo): the command-registration fix is PROVEN live — AC 2 green on its command/admission/activation clauses, red on its two client-surface clauses; AC 3 BLOCKED by a NEW product defect (dispatcher tool schemas rejected by the provider)

Setup per ticket 43's recipe: throwaway `multitask` profile recreated (`--from-default-profile web`), `npm run build` + `build:client` at `c4a7f29`, `dsh plugin --profile multitask add file:C:/Users/TZhen/Desktop/dsh-bot` (forward slashes), insert row written into the profile's `cordis.patch.yml` BEFORE boot (`multitask-config-dump.yml:541-542` composes it). Boot `dsh --profile multitask --port 8809 --no-open`, healthy, no activation error (`dsh-server-multitask2.log`). Kill timers armed at launch (port-keyed `taskkill /F /T`; the first 10-min backstop FIRED mid-pass on schedule and the boot was repeated with a 25-min window — driver had its own 18-min self-exit). Stock `web` profile untouched; throwaway profile deleted after. Zero-LLM phase first; the ONE trivial flow attempted last per the budget.

**GREEN — AC 2's command/admission/activation clauses (the bug this ticket fixed):**
- `commands/list` RPC now includes `dispatcher-start` AND `dispatcher-steer` alongside built-ins (`rpc-commands-list.json`: `compact,dispatcher-start,dispatcher-steer,export,feedback,goal,permission,plan`) — reproduced on both boots.
- Composer slash menu (`"/dis"` typed, never submitted) lists both commands with descriptions (`shots/07-slash-menu-dis.png`).
- RPC A/B `commands/execute` (args: agentId + line + `submittedAttachments: []`): `/goal` MATCHES (`rpc-execute-goal.json`), `/dispatcher-start` MATCHES — `{ok:true, value:{commandId:"cmd-1c47b59d-2", result:{kind:"success", text:"Dispatcher active in this chat. …"}}}` (`rpc-execute-dispatcher-start.json`). The activation is REAL, not just an ack: the next (failed; see below) turn's context shows two `multitask-dispatcher` policy injections (`上下文注入 · multitask-dispatcher`, `shots/09`), i.e. the session policy + turn-reminder path is live.
- Settings namespace service-side: `/api/settings/describe` carries `multitask-dispatcher` with our exact schema dict and `value = base = {enabled:true, accessRequestTimeoutMs:120000}`, applies "live" (`rpc-settings-describe2.json`).
- Dormant capsule renders in the browser (chip `data-dot="dormant"`, expand → dormant pitch + start affordance, `shots/01–03`).

**RED — AC 2's two client-surface clauses (both are CLIENT-half defects, not regressions of this fix):**
1. Settings → 插件配置 still renders only 终端/Agent 循环/Subagent/网页搜索 (`shots/05`). Root cause, read from the shipped host tree: those cards are explicit client-side slot registrations (`settings.plugin.item`, keyed per namespace — `dsh-client-ui-settings-plugins/lib/client.js:1795-1810`); describe payloads carry no titles, so a section cannot appear without a client registration our plugin never ships (`src/client` registers only locale, the settings watch, the shell.overlay capsule, and toolviews). This closes ticket 43's open delta: the section was never going to render from the host-half `installSection` alone.
2. Footer flag stays `data-flag="unknown"` before and after reload (`shots/03/08`), and the panel never leaves `dormant` — even after a roster document was manually present in the namespace (diagnostic `settings/update` RPC wrote `roster:{publishedAtMs,…}`; it persisted to `settings.yaml` and resolves WITH the `roster` key — `rpc-update-roster.json`; schema does not prune extra keys, verified offline against our `Config`). The client's dynamic `ctx.inject(["settings"], …)` (`src/client/index.ts:128`) never fires in the browser — the store never leaves its initial `waiting` (a channel-missing delivery would render `error`, also not observed; no console errors). Same shipped-idiom class of problem as this ticket's host-half bug, but on the client half: needs its own ticket; NOT fixed here (no-product-change rule).

**BLOCKED — AC 3 (the one trivial token flow):** activation (via the A/B probe above, counting as the flow start) + ONE plain-text spawn ask → the dispatcher turn FAILED at the provider: `本轮运行失败 Invalid schema for function 'check_workers': false is not of type "array"` (INVALID_REQUEST, `shots/09`, `shots/10`). Root cause (product): `ToolParameterNode.required` (`src/core/tools.ts:38`) is a boolean that is serialized verbatim into each property schema (`required: true/false` inside `properties`, e.g. `src/core/tools.ts:168,220,285,349,355,361`) — invalid JSON Schema (the keyword is an object-level string array), so the provider rejects the request payload for ANY turn of an activated session. All five dispatcher tools carry the pattern; no worker spawned; the steer and stop legs were therefore not attempted (no worker exists; further sends would be guaranteed-rejected requests). LLM contact for the whole pass: exactly ONE turn attempt, refused at request validation (no completion). **Follow-up filed: ticket 45.**

No AC checkbox is ticked by this comment (AC 2's section+flag clauses and AC 3 are red/blocked as recorded); no ticket files moved.
