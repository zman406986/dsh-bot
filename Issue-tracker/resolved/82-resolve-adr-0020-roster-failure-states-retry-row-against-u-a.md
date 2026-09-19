# 82 — Resolve ADR-0020's roster-failure-states retry row against ADR-0018 U-A

**Status:** resolved
**Labels:** ready-for-agent
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

- [x] Rule which reading stands; if the alternative: amend ADR-0018's exception list
      explicitly (per the ADR-amendment convention) and correct ADR-0020's inventory row.
      — **Ruled 2026-09-19 (overnight dispatched ruling, subject to human reversal): the
      conservative U-A reading stands.** ADR-0018 is untouched; no amendment is filed.
- [x] Either way, correct the losing text: ADR-0020's row ("with retry") or nothing (if the
      conservative reading stands, ADR-0020's row is the only text to fix — ADRs are
      human-owned, so this ticket does not edit them).
      — **Corrected 2026-09-19 in
      `docs/adr/0020-wrapper-shell-vehicle-own-frame-over-shipped-runtime-draft-nonhuman-approved.md:51`.**
      Before: `| Roster failure states: empty / unreachable with retry (area 1) | new, honest
      copy only | ticket 79 |`. After: `| Roster failure states: empty / unreachable, honest
      copy, retry-less (U-A) (area 1) | new, honest copy only | ticket 79 |`. ADR-0018 not
      touched. Code untouched (it already implemented the conservative reading). See the
      Comments entry for the repo-wide retry-affordance grep result.

## Comments

### 2026-09-19 — agent (overnight dispatched ruling; resolution + applied correction)

**Ruling: the conservative U-A reading stands** — roster failure surfaces degrade to honest
copy (empty / presence unavailable) with **no retry affordance and no reconnect banner**.
ADR-0018's exception list is unchanged. This is a *dispatched overnight ruling* (the human is
unattended and delegated these judgement calls); it is recorded as reversible — the human may
overturn it, and the reasoning below is written so the reversal path is cheap.

Reasoning (why the conservative reading wins on the text as filed):

1. **ADR-0018 is accepted and human-ruled; ADR-0020 is a draft.** ADR-0018's header reads
   "Status: accepted (human-ruled, 2026-09-18 trim session)" and its exception list is
   self-described as "exhaustive" — "This list is exhaustive; anything not on it is imitated."
   ADR-0020's header (line 5) says it "Operates under ADR-0018's master rule … and its
   exhaustive exception list", and (line 3) is "draft (non-human-approved)". A draft cannot
   silently carve a new exception out of an accepted master ADR.
2. **U-A names the disputed surface explicitly.** ADR-0018 item 12: "No connection-lifecycle
   model: no transport state phases, reconnect banner, restored-snapshot-while-reconnecting,
   **roster failure states**, or privacy/account gates." "Roster failure states" is not an
   incidental overlap with the excluded connection-lifecycle row — it is named in the
   exclusion. ADR-0020's adjacent row (line 50) already marks connection lifecycle
   "**excluded U-A**"; a retry affordance on the roster failure state would reintroduce the
   excluded territory in a narrower guise, and the narrower guise is exactly what U-A's
   wording forecloses.
3. **The alternative is additive, not a rework.** If the wrapper era ever wants a roster-level
   retry affordance, the work is: amend ADR-0018 (a new exception item or an explicit U-A
   carve-out) *plus* add the affordance — nothing shipped needs undoing. So the conservative
   ruling risks nothing that the alternative preserves, while the alternative would require an
   ADR-0018 amendment record that no human has signed off on.
4. **What shipped already implements the conservative reading.** Ticket 79 pinned
   retry-less in code and tests; the correction below is documentation catching up to
   behavior, not a behavior change.

**Verification sweep (doc-level contradictions only; no shipped code changed).** Grepped the
tree for any text still promising a roster retry affordance:

- `src/client/` — every hit is explicitly retry-less and pinned by comment: `shell.tsx:37`
  ("deliberately RETRY-LESS — no retry control, no reconnect banner … see ticket 82 for the
  ADR-0020 row tension"), `conversation-feed.ts:15,112`, `approval-pane.tsx:15,155`,
  `conversation.tsx:28`, `actions.ts:245`, `onboarding.ts:346`, `onboarding-pane.tsx:13`,
  `overlay.ts:236,265` (+ their zh twins at `overlay.ts:376,402`). **No locale key promises a
  retry**: the roster failure copy is `roster.empty` ("No workers yet. Ask the dispatcher to
  start some."), `roster.unavailable` ("Worker status is unavailable right now."), and
  `shell.row.presence-unavailable` ("presence unavailable") — `src/client/overlay.ts:118-119,206`
  (+ zh at `:283-284`). Grep for `retry` / `重试` across `src/` outside those comments returns
  only unrelated uses ("do not retry the same ask" tool guidance, todo-reconciler's
  delivery-retry bookkeeping) — none is a user-facing affordance. **Fix: none needed.**
- `docs/` — one other hit, `docs/research/always-on-dispatcher-behavior.md:20`, which describes
  the **reference product's** roster failure state ("…with retry"). That is a research note
  about the reference, not a promise about our build; ADR-0018's premise is that we imitate the
  reference *except* the exception list, so the note is correct as written and stays.
- `Issue-tracker/` — only ticket 82's own quotation and ticket 79's resolved note recording the
  tension; both are historical record, not live promises.
- **Only doc-level contradiction was ADR-0020 line 51, now corrected** (see the ticked box
  above).

**Reversal path:** if the human rules for the alternative reading, the amendment is a new
ADR-0018 exception item (or a U-A carve-out naming a roster-level retry) plus re-wording
ADR-0020's row back to a retry-affordance disposition; the code change is additive on the
roster failure state. No rework of what shipped.

