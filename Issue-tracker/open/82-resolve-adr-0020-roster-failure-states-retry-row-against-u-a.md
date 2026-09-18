# 82 — Resolve ADR-0020's roster-failure-states retry row against ADR-0018 U-A

**Status:** ready-for-human
**Labels:** ready-for-human
**Blocked by:** none (a human ruling on a drafted ADR; no implementation waits idle — see below)
**Related:** ADR-0020 (surface-inventory table, "Roster failure states" row), ADR-0018 (accepted exception list, item 12 U-A), ticket 79 (implements the conservative reading), ticket 67 (drafted ADR-0020)

## The conflict

ADR-0020 (draft, non-human-approved) carries a surface-inventory row that admits a **retry**
affordance and pairs roster failure states with connection-lifecycle territory that ADR-0018
explicitly excludes:

> ADR-0020, surface inventory (area 1):
> "Roster failure states: empty / unreachable with retry (area 1) | new, honest copy only | ticket 79"
> — and its adjacent row: "Connection lifecycle: phases, reconnect banner, restored snapshot,
> privacy/account gates (area 1) | **excluded U-A** | —"

ADR-0018 (accepted, human-ruled) — exception list item 12:

> "**U-A** — No connection-lifecycle model: no transport state phases, reconnect banner,
> restored-snapshot-while-reconnecting, **roster failure states**, or privacy/account gates."

Ticket 79 (the implementation ticket) already noticed the tension and pinned the conservative
side:

> "Roster failure states with honest copy: empty / unavailable / **retry-less (no reconnect
> banner — U-A)**."

## The question for the human

ADR-0020's row and ADR-0018's U-A cannot both stand as written:

1. **Conservative reading (current implementation):** U-A is exhaustive and ADR-0020's
   "unreachable with retry" cell is a drafting slip — roster failure surfaces degrade to
   honest copy (empty / presence unavailable) with **no retry affordance and no reconnect
   banner**, exactly as U-A requires. Ticket 79 implements and tests this reading
   (retry-less is asserted; the shell ships no retry control).
2. **Alternative reading:** the wrapper era re-opens a narrow slice of U-A — a roster-level
   "unreachable, retry" affordance distinct from a connection-lifecycle model — which would
   require a recorded ADR-0018 amendment (a new exception item or a U-A carve-out) before any
   implementation.

## Interim rule until ruled

Implementation tickets follow the **conservative U-A reading** (retry-less, honest copy only).
No code waits on this ticket: if the human rules for the alternative, the change is additive
(a retry affordance on the roster failure state + an ADR-0018 amendment record), not a
rework of what shipped.

## What to do (human)

- [ ] Rule which reading stands; if the alternative: amend ADR-0018's exception list
      explicitly (per the ADR-amendment convention) and correct ADR-0020's inventory row.
- [ ] Either way, correct the losing text: ADR-0020's row ("with retry") or nothing (if the
      conservative reading stands, ADR-0020's row is the only text to fix — ADRs are
      human-owned, so this ticket does not edit them).

## Comments
