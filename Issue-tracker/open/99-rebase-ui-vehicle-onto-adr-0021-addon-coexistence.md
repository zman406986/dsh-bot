# 99 — Rebase the UI vehicle onto ADR-0021: retire the root election, stock dsh stays primary

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none
**Related:** ADR-0021 (the ruling — addon coexistence), ADR-0018 (vehicle clause amended), ADR-0020 (vehicle superseded; machinery re-hosted), 78 (resolved — the cutover this ticket reverses), 89 (resolved — retired-asset deletion precedent), 98 (deferred — its gap 1 is expected-moot under this ticket's outcome)

## Problem

Today the client module REPLACES dsh's UI: `src/client/shell-mount.ts` elects the `root` single slot (explicit priority −1, ticket 85) shadowing the shipped frame, and `src/client/index.ts` also registers the full-cell keyed `main` page (`MAIN_PAGE_SLOT` / `SHELL_PAGE_KEY` "multitask-dispatcher-shell"). Stock dsh is displaced-yet-standby. ADR-0021 (human-ruled 2026-09-20) reverses the vehicle: **stock dsh is the user's primary UI and is never displaced** — dispatcher functions move to a separate floating window (ticket 100) with add/delete session affordances (ticket 101). The displacement registrations must leave the default posture.

## What to do

- [ ] Retire the `root` election from the default posture: remove the `root` slot inject and its registration from `src/client/shell-mount.ts` + `src/client/index.ts` (the `shellRootRegistration()` / `SHELL_ROOT_DYNAMIC_PRIORITY` composition). Whether the retired-path code is kept as a record or removed with the wiring is per what the implementation finds — record the disposition either way.
- [ ] Retire the full-cell keyed `main`-page registration from the default posture. The keyed-page/registration machinery (`MAIN_PAGE_SLOT`, `SHIPPED_MAIN_PAGE_KEY`, `SHELL_PAGE_KEY`, `shellPageRegistration`) stays available and reversible at one registration site per ADR-0021 decision 1 — do not delete the contracts unless implementation shows true dead code.
- [ ] Re-base the pins in `test/client-shell-mount.test.ts`: the `root` election / priority / abdication tests (`shellCellWinner`, the ticket-85 collision pins, the unload-abdication path) become records of the retired path or are removed with the code, per what the implementation finds.
- [ ] Keep fail-isolation honesty: our module crashing must not break stock dsh. With no root election there is no cell to abdicate — record what the isolation guarantee now is (our registrations fail within our own module; the stock app is never shadowed).
- [ ] Gates green: `npm run typecheck`, `npm test`, `npm run lint:docs`.

## Constraints

- Stock dsh must be visibly primary after this ticket: no registration of ours covers the `root` slot or claims a full-cell `main` page.
- The shell surfaces themselves (sidebar roster, conversation pane, approval cards, roster panel) stay in the tree — ticket 100 re-hosts them into the floating window. This ticket changes WHERE they mount, not what exists.
- No live testing in this pass (the ADR-0015 / ticket-33 convention): live confirmation of the stock-first posture is a later live lane; do not tick any live-only box from offline work.
- Resolved ticket 78's live-pass record is history, not something to rewrite; the retirement rides forward from here.

## Comments

### 2026-09-20 — team-leader session

Filed with ADR-0021 (human-ruled, quoted verbatim there). This ticket is the vehicle-reversal slice; 100 (floating window + launcher) and 101 (add/delete dispatcher sessions) are blocked by it.

**PRD check (performed at filing, recorded here).** Read PRD §6.1 and §11.5 and grepped the whole file for `displaces|replace|whole UI|wrapper window`. No PRD text says our UI displaces dsh outright, but three hits carry the superseded vehicle wording "the wrapper window / expanded surface *is* the dispatcher" — §6.1 (line 112), §11.5 item 5 (line 357), §15 item 6 (line 409). Each now carries a minimal dated amendment in the ticket-64 style citing ADR-0021 (stock dsh stays primary; the dispatcher's surface is a separate floating window called out from the stock UI; the always-on / no-mode ruling unchanged). The §8 and §12 "replaced" hits are copy-policy text, untouched. The PRD edits were made at filing, so this ticket's box for them is closed by this comment.
