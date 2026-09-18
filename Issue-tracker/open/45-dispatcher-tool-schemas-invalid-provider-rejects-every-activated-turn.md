# 45 — Dispatcher tool schemas are invalid JSON Schema: the provider rejects EVERY dispatcher turn (`false is not of type "array"`), so no worker can ever spawn live

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none (discovered by the ticket-44 live re-pass #2, 2026-09-18)
**Related:** 44 (live pass evidence), 11 (dispatcher tools), 09/10 (spawn path this blocks), 33 (live close-out)

## Symptom (live, cited)

Ticket-44 re-pass #2, `multitask` profile, activation via `commands/execute /dispatcher-start`
(MATCHED — `{kind:"success"}`), then ONE plain-text spawn ask. The dispatcher turn failed at
the LLM provider before any model output:

```
本轮运行失败  Invalid schema for function 'check_workers': false is not of type "array"   INVALID_REQUEST
```

(`C:\Users\TZhen\Desktop\dsh-live-repass2-2026-09-18\shots\09-trivial-prompt-sent.png`,
`shots\10-flow-blocked-invalid-schema.png`). Consequence: in an activated session every turn
carries the five dispatcher tools, the provider refuses the payload on schema validation, and
the product's core loop — spawn → steer → deliver — can never run against the real host.
Offline this is invisible: `FakeDshHost` and the stub tool registry never validate JSON Schema
shape, so 702/0 green means nothing for this defect.

## Root cause (cited)

`ToolParameterNode` (`src/core/tools.ts:30-40`) declares `required?: boolean` as a NODE field,
and the adapter serializes these nodes verbatim as the tool's JSON Schema
(`src/adapter/dispatcher-tools.ts:96` `parameters: def.parameters`). In JSON Schema `required`
is only valid as an **object-level array of property names**; inside a `properties` entry a
boolean `required` is an unknown keyword of the wrong type, and the provider's strict
function-schema validator rejects it (`"false" is not of type "array"`). Every tool carries it:

- `spawn_worker`: `todo_id` `required: false` (`src/core/tools.ts:168`)
- `check_workers`: `worker_id` `required: false` (`src/core/tools.ts:220`) — first to be validated
- `steer_worker`: `message` `required: true` (`:285`)
- `stop_worker`: `worker_id` `required: true` (`:349`)
- `deliver_result`: `text` `required: true` (`:355`), `todo_id` `required: false` (`:361`),
  `attachment_paths` `required: false` (`:361` block)

`true` inside a property is equally invalid — fixing only the `false` sites would move the
failure to the next tool.

## Requirements (minimal fix direction; final call belongs to the implementer)

1. Emit standard JSON Schema: drop `required` from every property node; derive the PARENT
   object's `required: [...]` array from the nodes' `required: true` flag at serialization time
   (one place: `toRegisterableTool` / the core defs — no new seams). Optionality semantics are
   preserved: `required: false` ≡ absent from the array.
2. Pin the shape offline: a test that walks all five serialized `parameters` and asserts every
   `properties.*` contains no `required` key and each object level's `required` (when present)
   is a string array — so a regression fails without a live host.
3. No prompt/copy changes, no tool-name or result-shape changes; worker deny-list untouched.

## Acceptance criteria

- [x] (offline, gate) `npm test`, `npm run typecheck`, `npm run build:client` green including
      the new schema-shape pin over all five dispatcher tools.
- [ ] (live, ZERO LLM calls) an activated session's dispatcher turn completes without
      INVALID_REQUEST — provable cheapest by re-running the ticket-44 re-pass #2 probe chain:
      `/dispatcher-start` via `commands/execute`, one trivial spawn ask, worker appears.
- [ ] (live, BURNS tokens — same single trivial flow per AGENTS.md) the ticket-44 AC 3 flow
      (start → one trivial worker → one mid-run steer → stop) executes and is recorded there.

## Notes

- Discovered live 2026-09-18; full probe chain, kill/token discipline, and the (deliberately
  unattempted) recovery legs are recorded in the ticket-44 re-pass #2 comment. The one failed
  turn was refused at request validation — no completion tokens were generated.
- Two further client-half defects found in the same pass (NOT this ticket's scope, owners to be
  assigned when filed): the Settings 插件配置 section never renders (needs a client-side
  `settings.plugin.item` registration — shipped cards are explicit per-namespace client
  registrations), and the client roster/flag watch (`ctx.inject(["settings"])` in
  `src/client/index.ts:128`) never fires in the browser, so the capsule composition and footer
  flag stay dormant/`unknown` even with a roster document present in the namespace.

## Comments

### 2026-09-18 — offline fix landed (AC 1 green); live ACs 2–3 await the separate pass

Fix at the serialization boundary, per the ticket's minimal direction. The authoring model is
UNCHANGED (per-field `required` booleans stay in `ToolParameterNode`); only the emitted schema
changed:

- `src/core/tools.ts`: new pure `toToolParametersSchema(node)` — walks the node tree, drops
  `required` from every property schema, and derives the parent object's
  `required: ["field", ...]` from children with `required: true` (emitted only when
  non-empty, so `check_workers` carries no `required` key at all). `description`, `enum`,
  `items`, `properties`, `additionalProperties` pass through recursively.
- `src/adapter/dispatcher-tools.ts`: `toRegisterableTool` now registers
  `parameters: toToolParametersSchema(def.parameters)` instead of the verbatim node tree —
  the single serialization site for all five dispatcher tools. `request_access`
  (`src/adapter/worker-access-tool.ts`) was audited in the same pass: its hand-written schema
  already uses the correct object-level array and is untouched, but it is now covered by the
  same pin.
- `test/tool-schema-shape.test.ts` (new): the offline regression pin AC 1 asked for. It
  registers all five tools through `registerDispatcherTools`, structurally walks every
  emitted `parameters` tree (anywhere `required` appears it must be an array of strings;
  booleans fail; `type` must be a valid JSON-Schema type string; properties/items recurse),
  pins each tool's required array, and walks the worker-side `request_access` schema with the
  same validator. Verified RED before the fix (e.g. `deliver_result.properties.text still
  carries required`, `spawn_worker.parameters.required` was `undefined`), GREEN after.
  No existing test asserted on parameter shapes, so none needed updating.

Before/after for `check_workers` (the tool the provider validated first):

```jsonc
// BEFORE (verbatim ToolParameterNode — INVALID, provider: INVALID_REQUEST)
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "worker_id": { "type": "string", "required": false, "description": "…" }
  }
}

// AFTER (toToolParametersSchema — valid JSON Schema)
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "worker_id": { "type": "string", "description": "…" }
  }
}
// required fields, e.g. steer_worker: "required": ["worker_id", "message"] at object level
```

Gates: `npm test` 706/0 across 186 suites (was 702/0 — +4 pins), `npm run typecheck` clean,
`npm run build:client` clean. Audit scope note: `grep` over `src/` found exactly two
`ctx.tools.register` call sites (dispatcher five + worker `request_access`); no worker-side
tool uses the `ToolParameterNode` path, so no other serialization branch exists. The dsh host
receiving `ctx.tools.register` is structural and out of our tree; if the host re-validates or
re-serializes differently live, that belongs to AC 2's zero-LLM probe. Live ACs 2–3 left
unchecked (not run here).
