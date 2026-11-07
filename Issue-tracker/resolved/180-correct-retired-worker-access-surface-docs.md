# 180 — Correct retired worker access surfaces still documented as live

**Status:** resolved
**Labels:** ready-for-agent
**Severity:** low
**Ship blocker:** no

## Problem and evidence

The surfaces guide still describes the worker access-ask feature as live after ADR-0033 and ticket 174 removed it:

- [docs/surfaces.md:286](../../docs/surfaces.md#L286) promises localized access blocks and access-prompt labels and cites the deleted access-prompt implementation.
- [docs/surfaces.md:291–292](../../docs/surfaces.md#L291-L292) marks the Resolve command (`/dispatcher-resolve`) and Allow / Always allow this session / Deny prompts **Live**.
- [docs/surfaces.md:299–300](../../docs/surfaces.md#L299-L300) says dormant boot registers three host commands, including `/dispatcher-resolve`.
- [ADR-0033:6](../../docs/adr/0033-worker-access-ask-removed.md#L6) removes the ask channel, relay, dispatcher-side prompt and resolve command; [ADR-0033:39](../../docs/adr/0033-worker-access-ask-removed.md#L39) explicitly withdraws `/dispatcher-resolve`.
- [Ticket 174:31–36](../resolved/174-remove-worker-access-ask-feature.md#L31-L36) lists the deleted prompt/resolve implementations; its [closure:95–96](../resolved/174-remove-worker-access-ask-feature.md#L95-L96) records shipment in `643a801`.
- [src/plugin.ts:2103](../../src/plugin.ts#L2103) and [src/plugin.ts:2137](../../src/plugin.ts#L2137) register only the start and steer commands. A static search finds no resolve registration.

## Impact

Readers can try a withdrawn command or expect worker access prompts that no longer exist. This is documentation residue; the current implementation follows the removal decision. Low severity and non-blocking.

## Static reproduction

1. Read the locale row, Resolve/Access rows and dormant-boot paragraph linked above.
2. Compare their live claims with ADR-0033 and ticket 174's deletion list and closure.
3. Search the plugin for `registerDispatcher.*Command|dispatcher-resolve`: only start/steer imports and registrations remain. The named access-prompt and resolve-command adapter files are absent.

## Acceptance criteria

- [ ] Mark the Resolve command and Access prompts rows **Withdrawn/removed**, identify the implementations as deleted, and link ADR-0033 / ticket 174.
- [ ] Correct the locale row's access-block/access-prompt-label claims and remove its deleted implementation citation while retaining accurate EN/ZH coverage.
- [ ] Change dormant boot's count and list to exactly **two** host commands: `/dsh-bot` and `/dispatcher-steer`.
- [ ] Keep the fix limited to documentation. Do not restore the access relay, prompts or `/dispatcher-resolve`.

## Checks performed

- Read [tracker conventions](../issue-tracker.md) and [agent triage conventions](../../agent.md); the issue is fully specified for `ready-for-agent`.
- Verified every evidence location above, the two command registrations, and the absent adapter implementations by static reads/searches.
- Duplicate search across `open`, `deferred`, `resolved` and `cancelled` for `surfaces.md`, `dispatcher-resolve`, worker access asks and retired-access wording found no ticket tracking this residue. Open/deferred had no matches; resolved/cancelled matches concern historical implementation or other surfaces, including tickets 171/174.
- No tests or builds run; this is a static documentation audit.

## Comments

- 2026-11-07 — Filed from the documentation audit; ADR-0033 remains the authority for the removed feature.

## Resolution - 2026-11-08

Fixed in `4f23838`: `docs/surfaces.md` no longer lists the resolve command or the Allow/Deny access prompts as live, and no longer cites the deleted access-prompt adapter.
