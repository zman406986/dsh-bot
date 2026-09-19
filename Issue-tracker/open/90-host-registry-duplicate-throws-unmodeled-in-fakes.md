# 90 — Host registry duplicate-name throws are unmodeled in the apply-driving fakes

**Status:** open
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
2. (offline) At least one new negative-control test proves the rule fires:
   pre-register a command (and a tool) with one of our own names, then drive
   `apply()` over that fake and assert the apply throws the host message —
   the offline detector for a double registration.
3. (offline) The settings-namespace duplicate rule is either taught to the
   remaining fakes that model a settings service, or the inventory's MED note
   is answered with the reason it cannot apply there (the ticket-86 inventory
   row 19).
4. `npm test` (0 fail), `npm run typecheck` (both configs), and
   `npm run build:client` are green after the pass, with exact numbers
   recorded in this ticket.

## Notes

- Filed by the ticket-86 agent (2026-09-19) from the AC1 inventory; the
  inventory rows are `Issue-tracker/open/86-fake-vs-host-client-contract-gaps-44-45-84-85-class.md`
  ("Comments", rows 16/17/19).
- The per-agent scoped registry (`agent.ctx.tools`, `dsh-tools` same
  `NamedEntries`) is in scope for the same reason: the access tool and the
  per-session tool surfaces register there.
- Deliberately NOT in scope: `slots.inject` declaration-wait modeling and the
  84-class guard coverage in non-scaffold client suites (inventory rows 8/9,
  MED — recorded, each with its mitigation).
