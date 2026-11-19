# 299 — Stored worker_model default is bypassed by the active stock worker spawn

**Status:** resolved
**Type:** bug
**Labels:** ready-for-agent
**Severity:** P2 — an accepted worker default does not select the later worker's creation route; unexpected model cost or capability is possible. No live inference impact was measured.
**Confidence:** high at the child-creation boundary; not a proof of a model/API request or response identity.
**Blocked by:** nothing for diagnosis or the targeted offline regression. The remedy must respect stock model-selection authorization.
**Origin:** 2026-11-18 behavior audit; producer reproduced the assertion failure twice and an independent reviewer reproduced it once. This filing pass read the proof/source but did not rerun tests.
**Related:** [285 — implemented model choices](<../resolved/285-opt-in-spawn-model-choice.md>); [ADR-0035 — draft, not owner-approved](<../../docs/adr/0035-spawn-model-option.md#L3>); [stock worker replacement](<../../docs/research/stock-subagent-duplication-audit.md#L25>).

## Problem and required behavior

The plugin accepts `spawn_dispatcher.worker_model`, stores the resolved value for the summoned team leader, and still promises that it applies to later workers when their explicit route is omitted:

- [README:86–95](<../../README.md#L86-L95>) explicitly names the active stock `subagent` call and says the stored default applies when its argument is omitted.
- [Tool parameter:274–280](<../../src/core/tools.ts#L274-L280>) promises a default for **every** later worker and says an explicit worker model wins.
- [Model-facing description:120](<../../src/core/policy/prompts.ts#L120>) advertises the same default.

Required precedence for the advertised feature: explicit worker route → this leader's stored worker default → normal host inheritance. This is a current shipped contract mismatch, not a claim that unsigned ADR-0035 is an owner ruling.

Observed: the leader runs on route A and has valid stored default B. Its active stock `subagent` call with provider/model omitted creates the worker on A. An explicit provider/model B control creates on B. Both children reach real descriptor creation and product worker adoption before the proof stops.

## Current call chain and missing integration

1. The real product summon tool resolves `worker_model` and calls the host spawn; the proof checks the created leader and durable mark ([proof:168–184](<../../.scratch/behavior-audit-2026-11-18/default-route/default-route.test.ts#L168-L184>)). The host mirrors the default under the actual leader id and writes `workerModel` into its mark ([storage:3090–3122](<../../src/adapter/cordis-dsh-host.ts#L3090-L3122>)).
2. The active worker tool is stock `subagent`, not the retired custom `spawn_worker` ([current tool surface:104–111](<../../src/core/policy/prompts.ts#L104-L111>)). Stock merges call/config/parent options and authorizes/preflights before `startActivation` ([installed tool:431–472](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-subagent/lib/index.js#L431-L472>)). That path has no bridge from our stored worker default.
3. Runtime authority checks capabilities and requires the exact live parent, then calls the real manager ([installed runtime:3051–3062](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js#L3051-L3062>)). The manager resolves child options and puts their provider/model in the descriptor ([manager:1397–1416](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js#L1397-L1416>)); materialization passes those options into `agents.create` and appends the descriptor during setup ([materialization:1800–1829](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js#L1800-L1829>)).
4. Our stock-worker observer adopts the child; adoption is not evidence that the promised default was applied ([adoption:3658–3670](<../../src/adapter/cordis-dsh-host.ts#L3658-L3670>)).
5. The stored default's route-selection read remains in the retained adapter `spawnWorker` method ([method:4302](<../../src/adapter/cordis-dsh-host.ts#L4302>), [precedence:4338–4367](<../../src/adapter/cordis-dsh-host.ts#L4338-L4367>)), not the active stock tool path.

Stock inheritance is correct by itself. The defect is **our integration's unfulfilled default**, not an upstream violation of its own tool contract.

## Minimal offline reproduction

Run from the repository root:

```text
node --import tsx --import ./.scratch/behavior-audit-2026-11-18/default-route/export-manager.mjs --test --test-timeout=10000 .scratch/behavior-audit-2026-11-18/default-route/default-route.test.ts
```

[Proof:168–212](<../../.scratch/behavior-audit-2026-11-18/default-route/default-route.test.ts#L168-L212>):

1. Summon a real product team leader on A (`deepseek-official/deepseek-flash`) with `worker_model` B (`qwen/qwen4-max-preview`); assert B is stored in its durable dispatcher mark. These are synthetic fixture routes, not evidence of actual account availability.
2. Execute the real registered stock tool with explicit provider/model B; inspect the real manager's descriptor and `agents.create` inputs. Both are B.
3. Execute that same tool with provider/model omitted. Both creation inputs and descriptor use A, despite stored B. The assertion at line 212 expects B and fails.
4. Both children were adopted by the product and received durable worker markers before the named stop sentinel. No inference stream runs.

### Evidence limits

- The [preload:1–12](<../../.scratch/behavior-audit-2026-11-18/default-route/export-manager.mjs#L1-L12>) adds only a named export for the installed private manager in memory; it does not write installed source or replace route/authorization/manager logic.
- Actual stock tool merge, Runtime authority, manager startup/materialization/setup, descriptor appending, product summon and adoption execute.
- The event bus, session/agent factory, storage and boot composition are structural fixtures, not a complete stock application boot. Synthetic model-selection policy allows A and B.
- Proof stops at `agents.create` after real setup/adoption. It establishes creation options and descriptor values, **not** a real request header, inference-stream route, model response identity, entitlement or billing.
- Original submission/activation incident and composer behavior are unrelated and unproven by this test.

## Smallest next implementation task

Preserve the stock tool and its authority checks. Add the narrowest supported integration that supplies the leader's stored default to **the active stock child-option merge before authorization and route preflight**, only when the call does not explicitly choose a route. Do not change a child's model afterward in `agent/created`: that is too late for the selected-route validation and descriptor truth. Do not bypass the recorded allowed-model policy or invent prompt directives.

If no supported pre-authorization bridge exists, explicitly deprecate/remove the exposed default and its user/model-facing promise instead of continuing to accept a value that does nothing. Record that feature loss against #285; changing the advertised behavior must be deliberate.

### Acceptance criteria

- [x] At the real stock tool → Runtime → manager → descriptor/creation seam, omitted route selects stored B while the leader remains on A.
- [x] An explicit worker route wins over stored B; no stored default leaves ordinary host inheritance unchanged.
- [x] Authorization/preflight applies to the final route; an unauthorized/unavailable default never silently bypasses stock policy. Preserve normal explicit-route errors.
- [x] The default applies to multiple later workers and after mark restoration, not only the first worker.
- [x] Keep the regression at the active stock seam, not solely the retained adapter `spawnWorker` unit tests. No live model/API call is required.
- Not selected: removing/deprecating the parameter. The supported bridge preserves the exposed feature.

## Duplicate check

Searched all four tracker status folders for `worker_model`, `workerModel`, worker/subagent model-default and route terms. Open contained no tickets; deferred/cancelled contained no matching default issue. The only direct matches were resolved [285:46–84](<../resolved/285-opt-in-spawn-model-choice.md#L46-L84>): the original custom-spawn feature and its adapter tests. It did not record the later stock-spawn integration regression, so this is a follow-up, not a duplicate or a reopening of its historical resolution.

## Resolution — 2026-11-18

- `src/adapter/stock-worker-model-default.ts` registers a per-Agent same-name shadow that delegates to the original stock definition. It adds the stored provider/model only when both route fields are omitted, preserves explicit reasoning effort and partial-route errors, and passes the exact execution context through unchanged. The stock Session allowlist, selection-enabled check, live adapter preflight, Runtime authority and manager remain authoritative.
- `src/adapter/cordis-dsh-host.ts` exposes an exact-live-Agent default reader. An absent mirror awaits the durable mark rather than silently inheriting A. A disposed/replaced Agent is refused before the restored value can populate its mirror or create a child.
- `src/plugin.ts` owns registration/disposal with the existing per-session tool transaction. The bridge uses public `scopeParentOf` plus parent-scope registry reads to retain stable wrapper/admission identity for unrelated global tool changes. Actual replacement/removal revokes old wrappers; conditional stock replacements remain unshadowed.
- Public host peer `@deepseek-ai/dsh-scope@0.2.2-rc.1` is declared in `package.json`. This no-install workspace uses the test-only `test/support/stock-scope-loader.mjs` resolver to the existing installed public package. The tiny `src/adapter/dsh-scope-peer.d.ts` describes only its public function; no host implementation is vendored. Normal host deployment supplies the declared peer.
- Independent reviewer 185 approved the source and reproduced the then-current 14 controls. Two subsequent composed restore branches and repeated-worker/no-default assertions were test-only additions; the final focused run passed all 16 tests.

### Verification

First composed red: the real registered surface produced descriptor/creation A instead of expected stored B. After the bridge, the same seam is green. Final command (bypasses all vendor prebuild scripts):

```text
node --import ./test/support/stock-scope-loader.mjs --import tsx --test --test-timeout=10000 test/stock-worker-model-default.test.ts
```

Final result: 16 passed, 0 failed, 1248.619 ms. Cases include omitted B twice, no-default A inheritance, explicit A/B precedence, effort-only B, unauthorized default/explicit rejection, absent Session policy, disabled selection, allowed-but-unavailable route rejection, two-Agent registry stability, replacement/removal/conditional safety, delayed durable restoration and disposal during that delay. Rejections assert no activation, child, descriptor, product marker or inference stream.

Direct no-vendor typecheck: `node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit --pretty false` — exit 0. No live model/API calls, stock package writes, config/profile edits, installs, restarts, vendor/generated/RACOONS/reference edits, commits, staging or pushes were performed. The fixture proves creation options and descriptor truth, not billing or live response identity.

## Comments

- 2026-11-18 — Filed from the independently reviewed behavior audit as one P2 integration bug. Documentation only; no test rerun, product/config edit, deployment change, restart or commit. Severity reflects wrong default creation route and possible cost/capability impact, not measured live inference harm.
