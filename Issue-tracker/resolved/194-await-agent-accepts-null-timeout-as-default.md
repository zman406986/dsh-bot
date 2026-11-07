# 194 — `await_agent` accepts null timeout as default

**Status:** resolved
**Labels:** ready-for-agent
**Severity:** P3 / low
**Ship blocker:** NO

## Resolution — 2026-11-08

Fixed on the `feat/spawn-model-option` branch — `timeout_ms: null` is now refused as `invalid-timeout`, with a regression test.

## Problem and requirement

An explicit JSON `null` for optional `timeout_ms` is currently treated as though the argument were omitted. In `src/core/tools.ts`, the handler exempts null from its non-number refusal and passes `undefined` to `awaitWorker`; the core then uses the 30,000 ms default. For example, `await_agent({target: "valid-owned-worker", timeout_ms: null})` waits with the default instead of returning `invalid-timeout`.

This contradicts the established `await_agent` contract: ticket 117 says a non-number timeout is refused as `invalid-timeout`, and `validateAwaitTimeout` defaults only `undefined` while rejecting non-numbers. Keep the omitted-argument behavior unchanged.

## Confirmed source and host path

- [Handler schema and validation:1554](<../../src/core/tools.ts#L1554>) declare an optional numeric timeout. At [1578–1588](<../../src/core/tools.ts#L1578>), the guard expressly exempts `null`; at [1591–1595](<../../src/core/tools.ts#L1591>), the number-only conditional maps null to undefined before calling the core.
- [Adapter forwarding:372](<../../src/adapter/dispatcher-tools.ts#L372>) normalizes only non-object top-level args. [377–388](<../../src/adapter/dispatcher-tools.ts#L377>) forwards that record to `def.execute` without validating its fields.
- The installed host runner at `C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/pipeline.js` parses model tool-call arguments with `JSON.parse` (lines 33–39, 63–69), then resolves the tool and directly calls `tool.execute(exec.arguments, exec)` (lines 455–475). There is no parameter-schema validation before that call in this execution path; thus a parsed JSON null reaches the adapter and handler rather than being rejected by the host runner.
- [Core timeout validation:405](<../../src/core/settle-records.ts#L405>) defaults only `undefined` at [414–416](<../../src/core/settle-records.ts#L414>) and refuses values whose type is not number at [417–422](<../../src/core/settle-records.ts#L417>).
- [Resolved 117 contract:58](<../resolved/117-await-agent-tool.md#L58>) and [outcome table:71](<../resolved/117-await-agent-tool.md#L71>) specify non-number timeouts as `invalid-timeout`.

## Impact and duplicate check

Only an explicit malformed null value takes this path. It causes an unintended bounded 30-second wait instead of an immediate structured refusal; the existing 120-second maximum still applies, so this is low severity and not a ship blocker. An omitted timeout continues to receive its intended 30-second default.

Searched the open, deferred, resolved, and cancelled ticket sets for explicit null-timeout handling and checked ticket number 194 across all four states. No dedicated null-timeout bug ticket or occupied 194 was found. Resolved 117 already records the general non-number contract, but does not identify this null-specific handler exception; resolved 115 covers the core wait contract. The current open 190/191 and 200+ tickets concern separate lifecycle, composition, and delivery issues.

## Acceptance criteria

- [ ] An explicit `timeout_ms: null` returns `invalid-timeout` and does not enter the wait path.
- [ ] An omitted `timeout_ms` still uses the 30,000 ms default.

## Validation limits

This ticket is source-confirmed only. No runtime reproduction, tests, builds, or configuration changes were performed.
