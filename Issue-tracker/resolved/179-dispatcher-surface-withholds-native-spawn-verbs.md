# 179 — A dispatcher's tool surface withholds the host's own spawn verbs

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** nothing.
**Origin:** follow-up recorded in ticket 178 §"A real finding, next to the question: two spawn verbs on one surface" (2026-11-04): *"Withhold `subagent` and `subagent_fork` from the dispatcher's tool surface so there is exactly one spawn verb, and one that the ledger can see. Barrier denial alone is not enough: it protects children, not the dispatcher's own choices."*
**Related:** ADR-0019 (per-dispatcher scoped tools — visibility is the fence), ADR-0003 (dispatcher-only spawning), ADR-0007 (structural todo↔worker link), ADR-0032 (a summoned dispatcher is a top-level session), ticket 176 (the same surface mechanism, per class), ticket 122 (`reply_to_dispatcher` is registered on the child's scope only), ticket 178 (the investigation).

## Problem

A dispatcher can create a child two ways, and only one is tracked.

| Route | Roster entry | Stream key | Todo link | Settle record | Wake | Tool barrier | Ledger |
|---|---|---|---|---|---|---|---|
| `spawn_worker` | yes | yes | yes | yes | yes | yes | yes |
| host `subagent` / `subagent_fork` | no | no | no | dropped (`if (!workers.has(workerId)) return;`) | no | no | never appears |

The raw verbs are reachable because the shipped `standard`, `cordis` and `ptc` agent presets all mount the `delegation` group. The `tool-subagent` rows are disabled at the host plane and re-mounted by each preset, so a session under any of those presets gets `subagent` (provider `spawn`) and `subagent_fork` (provider `fork`) on its own surface. Our plugin activates a dispatcher on a session that already carries that surface and adds its eight tools to it; it never takes anything away.

The worker barrier denies `subagent` on **children** (`src/worker/tool-barrier.ts:22`), which is only meaningful because the name is visible on the surface a child inherits. It says nothing about the dispatcher's own choices.

## Fix

Reuse the per-session scoped-tool mechanism ticket 176 already uses: the dispatcher's surface is composed per activation, and what is not on it cannot be called. The mechanism here is the worker barrier's other half — a candidate deny-list intersected with the names actually live on that surface, because the host's `tools.restrict()` throws on a name it does not know (`src/worker/tool-barrier.ts:4-7`).

Chosen over "build fewer definitions" (ticket 176's mechanism) because these tools are not ours: they belong to a preset ancestor layer, so the only way to remove them from the model's view is a restriction on our own layer.

### Why `restrict` and not an execute-time refusal

ADR-0019's rule is that visibility is the fence, not a refusal copy. A restriction is the host's own visibility primitive, and two host behaviours follow from it for free:

- `tools.get(name, scope)` resolves through the restriction, so `dsh-tool-subagent`'s system-prompt section hides itself (`if (visible[0] !== toolName) return ""`) and the depth reminder does too (`get(toolName, context.scope) !== mounted.definition`). The dispatcher is never told about a verb it does not have, with no copy of ours changed.
- `tools.restrict` filters the **inherited** surface (global + every ancestor layer) and never the scope's own registrations, which is exactly the split we need: preset verbs disappear, our eight registered tools stay.

The restriction is owned by the activation's effect, so `deactivateToolSurface` lifts it along with the tools — a session that stops being a dispatcher gets its inherited surface back.

## Verified facts (2026-11-04, this tree and the installed host)

1. **The verbs are on the dispatcher's surface in this repo's composition.** `dsh-web-app/presets/standard.patch.yml:83-97`, `presets/cordis.patch.yml:82-96` and `presets/ptc.patch.yml:85-103` each mount `tool-subagent` with `provider: spawn` / `toolName: subagent` and `tool-subagent-fork` with `provider: fork` / `toolName: subagent_fork`; `presets/minimal.patch.yml` mounts neither. The preset registry defaults to `standard` (`dsh-web-app/cordis.patch.yml:586-589`, `config.default: standard`), and `dsh-api-session-controller/lib/index.js:355-365` mounts the resolved preset into every created/resumed agent's scope.
2. **The host-plane rows are disabled, not absent** — `dsh-web-app/cordis.patch.yml:546-566` disables `tool-subagent` and `tool-subagent-fork` at the host plane so that each preset re-mounts them per session ("What a preset chooses is which delegation TOOLS its agent sees").
3. **Our plugin never restricts a dispatcher.** `.restrict(` appears in this tree only at `src/worker/preset.ts:107`, reached from `applyWorkerComposition`, whose only call sites (`src/adapter/cordis-dsh-host.ts:1861`, `:2148`) are child paths. `src/plugin.ts`'s `activateToolSurface` registers tools and never subtracts anything.
4. **A restriction on our own layer does hide an ancestor's tool.** `dsh-tools/lib/index.js:3055-3072` builds the visible set from inherited names where `layers.every((layer) => layer.admits(name))`, and the chain includes the scope's own layer; `restrictableNames` (`:3065-3068`) holds inherited names only, so a candidate taken from the visible set is always a legal restriction name.
5. **`TOOL_DESCRIPTIONS` does not name the host tool.** `src/core/policy/prompts.ts:298-299` mentions `subagent` only in a doc comment recording the owner's text mapping ("subagents you dispatch with the `subagent` tool" → `spawn_worker`), and `:103` uses "subagent" as a common noun for the host's depth limit. No model-facing copy change is needed, and `src/core/policy/*` is not touched.
6. **`list_subagent_models` is the third name, deliberately included.** It creates nothing, but it is the route-discovery companion of the two spawned verbs and its description tells the model to use the returned ids with "a delegation tool's `provider`, `model` and `reasoning_effort` fields" (`dsh-tool-subagent/lib/index.js:174-190`) — i.e. a verb this surface no longer carries. Dropping the name from the candidate list restores it.

## What this does not change

- `spawn_worker` keeps its place as a dispatcher's only spawn verb; ticket 178's decision stands and the host's `subagents` service is untouched.
- `spawn_dispatcher` (mitosis) is unaffected: it creates a top-level session, not a subagent child, and ticket 176 already governs it per class.
- `send_message` / `interrupt_agent` (from `tool-subagent-control`) are messaging verbs, not spawn verbs. Out of scope here.
- No new mechanism, no new seam, no host change, no schema change. The counterpart guard on the host side is not added: there is nothing left to guard once the verb is not on the surface (ADR-0019's fence, and no rejection copy is needed for a tool the model never sees).

## Files

| File | Change |
|---|---|
| `src/core/tools.ts` | `HOST_SPAWN_TOOL_CANDIDATES`, `DispatcherScopedToolSurface`, `withheldHostSpawnTools`, `withholdHostSpawnTools` |
| `src/plugin.ts` | `activateToolSurface`: apply the withhold on the activated agent's scoped surface, push its disposer |
| `test/dispatcher-tools.test.ts` | candidate list, the intersect, the three no-op shapes, the disposer |
| `test/adapter-dispatcher-tools.test.ts` | one composition test: a surface carrying the host verbs ends with our tools plus one restriction naming them |

## Acceptance

- [x] `withheldHostSpawnTools` returns only names present in the live set — never a hard-coded deny.
- [x] `withholdHostSpawnTools` is a no-op on a surface with no `restrict`, on an empty intersection, and on a throwing `schemas`.
- [x] The returned disposer lifts the restriction (it rides `sessionToolDisposers`).
- [x] A dispatcher's registered tool set is unchanged: still the eight (seven for the spawned class).
- [x] Typecheck clean; owned suites green.

## Comments

**2026-11-04 — implemented.** Mechanism, ordering and one out-of-scope name.

- The withhold runs **before** `registerDispatcherTools` on the same scoped surface, so the live-name read never sees our own eight tools. It is applied only on the scoped path (`agent.ctx.tools`); the plugin-level fallback exists for stub hosts, where `scopeOf(ctx)` is `undefined` and the host's `restrict()` would throw by design.
- Candidate names are `subagent`, `subagent_fork`, `list_subagent_models` — the two spawn verbs plus the route-discovery verb whose copy points at them (see verified fact 6). Drop the third from `HOST_SPAWN_TOOL_CANDIDATES` if the owner wants the strict ticket-178 list.
- `prompts.ts` needed no edit: no model-facing text names `subagent` as a tool (verified fact 5), and the host's own delegation prompt section hides itself once the tool is restricted away.
- Existing doubles are inert: `test/spawn-dispatcher-activation.test.ts`'s `createScopedTools` and `test/plugin-scaffold.test.ts`'s `ctx.tools` expose no `restrict`, so the withhold is a no-op there and no other lane's assertions move. Verified by running both: 18/18 and 16/16 green, unedited.
- Owned suites, run together: `dispatcher-tools` + `adapter-dispatcher-tools` + `tool-schema-shape` → **45 tests, 45 pass, 0 fail**. Adjacent surface suites also re-run green and untouched: `multi-dispatcher` + `dispatcher-resume-reactivation` + `adapter-racoons-mount` → 15/15.
- `npx tsc -p tsconfig.json --noEmit` exit 0; `tsc -p tsconfig.client.json --noEmit` exit 0; `node tools/doc-lint.mjs` clean (0 findings, 6 rules); `node tools/issue-index.mjs --check` fresh (12 rows).

### 2026-11-04 — PM closure

Implemented and pushed. Belt-and-braces verification at closure: full suite 802 tests, 0 fail;
all three typecheck configs clean; `npm run lint:docs` clean.
