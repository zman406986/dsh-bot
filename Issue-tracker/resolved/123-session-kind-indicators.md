# 123 — Session-kind indicators: dispatcher glyph in the sidebar, worker marker in the conversation header

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** none (114 resolved — the glyph rides the landed 0.2.1 port)
**Related:** ADR-0024 rider + rider addendum (the sidebar glyph is ruled and licensed), ADR-0027 (§Settled identity and dispatch — how a kind is identified), ticket 118 (a spawned dispatcher's preset must be verified), `.scratch/repo-analysis/2026-10-18-open-questions-resolved.md` §Q4

## Problem

The owner asked for small marks separating dispatcher sessions, worker (subagent) sessions, and normal sessions (ADR-0024 rider, 2026-10-18). Two facts narrow what is buildable:

1. **Workers are not sidebar rows.** Subagent sessions are stamped `origin: 'subagent'` (`dsh-subagent/lib/index.js:354`) and filtered out of the sidebar entirely (`dsh-client-ui-workspace/lib/client.js:964-966`). `sidebar.session.row.leading` therefore never renders for a worker, so the three-way glyph reduces to **dispatcher vs normal** in that slot.
2. **The slot is idle-only.** The leading cell mounts only for idle, non-archived, non-blank rows; a running row shows the stock status dot instead (`dsh-client-ui-workspace/lib/client.js:2303-2306`). Any design expecting a persistent mark on every row is wrong.

So the worker half of the request has no seat in the slot the owner named. The only remaining seat that can carry it is the **conversation header**, which is a different slot and is **not** licensed by the ADR-0024 rider (that rider permits exactly one additive sidebar registration).

## What to do

**A. Sidebar glyph (dispatcher vs normal) — ready to build**

- [x] Register `sidebar.session.row.leading` as a `list` entry, 16 px leading cell, `replaceRisk: none`. The stock schedule plugin already occupies the slot at order 10 (`dsh-client-ui-schedule/lib/client.js:7528`); pick an order that does not shadow it.
  - Done: `dispatcherGlyphRegistration()` in `src/client/session-kind.tsx`, entry id `multitask-dispatcher-kind`, **order 20** (above the stock schedule mark at 10), root-scope `list` slot.
- [x] Compute the kind **client-side from the session-list snapshot**, with no new projection and no new store:
  - dispatcher: `projectionValues.agentPreset === "multitask-dispatcher"` — **conditional**: ticket 118 must first confirm the preset exists and lands on live dispatcher sessions. Until then, ship no dispatcher glyph rather than mislabel normal sessions.
  - normal: everything else visible.
  - workers: never appear here (see Problem).
  - Done, with the identity source corrected: `agentPreset` proved unusable (every durable header reads `"standard"`; no `multitask-dispatcher` preset row exists). ADR-0027 superseded that candidate with the adapter's own `sessionKind` projection (`src/adapter/session-kind-projection.ts`), which folds the `command/run` + `command/done` pair `/dsh-bot` already writes. `resolveSessionKind` reads `projectionValues.sessionKind === 'dispatcher'`, checks `origin` first (workers inherit the parent's projection), and needs no new store.
- [x] The payload is only `{sessionId}`; look the session up through `useSessions`.
  - Done: the glyph receives `sessionId` + `useSessions` renderer props and reads `state.byId[sessionId]`.
- [x] Fail closed: if the snapshot is missing the session, render nothing. A throwing entry abdicates per entry and never takes stock dsh down.
  - Done: missing/malformed/wrong-typed facts resolve to `normal`, which renders `null`; a missing `sessionId` or `useSessions` returns `null` without calling a hook.
- [x] Narrow `test/client-face-scaffold.test.ts`'s "renders NOTHING into dsh's layout" pin by exactly this one registration, as the rider already says.
  - Done: the pin now lists three composition injects (toolviews, settings card, sidebar leading cell) and the shell-mount pin asserts exactly the same trio.

**B. Worker marker in the conversation header — DECLINED (not licensed)**

- [x] The candidate seats are `conversation.session.header.actions` (`list`, session scope) and `conversation.session.header.corner` (`single`, session scope). Both declared in `dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:225-258`; stock subagent UI already registers into `conversation.session.header.actions` (`dsh-client-ui-subagent/lib/client.js:983`).
  - Read and recorded. `conversation.session.header.lineage` was ruled out as a `single` seat already owned at priority 0 by `dsh-client-ui-subagent` (`:978-982`) — a second entry there throws or displaces the stock breadcrumb.
- [x] **Stop and ask the owner first.** ADR-0024's rider licenses one additive sidebar registration and says no other slot is licensed. Adding a second registration contradicts decision 1 as currently recorded and needs a dated human ruling extending the rider — an agent must not slip it in.
  - **The gate held.** No dated ruling extending the rider exists. An earlier revision of `src/client/index.ts` registered this header entry anyway; the 2026-10-22 pass removed it (see Resolution). The accepted ADR outranks the ticket.
- [ ] ~~Once licensed: a worker marker here is identifiable by `origin === "subagent"` (ADR-0027) and is visible on the worker's own conversation~~ — **declined**. Not built; a future dated human ruling can re-license this seat.
- [x] Do not try to make workers visible in the sidebar. That would overturn stock's visibility rule and contradicts ADR-0024's native posture.
  - Honored: no sidebar behaviour changed; the worker kind resolves but never renders in the sidebar.

## Open questions

1. **Does the owner want the worker marker at all**, given it can only live in the conversation header rather than the session list? (Recorded in ticket 114's 2026-10-18 comment as a scope limit.)
   - Still open, and now moot until a ruling extends the rider.
2. Which header seat, if any: `conversation.session.header.actions` (list, title-adjacent) or `conversation.session.header.corner` (single).
   - Still open; no seat chosen, nothing registered.
3. Should a spawned dispatcher get a distinct glyph from a top-level dispatcher? The rider leaves the visual distinction TBD and this ticket invents no icon vocabulary.
   - Not decided; the shipped glyph is one mark for all dispatchers.

## Constraints

- Glyph only. No text, no tooltip surface, no new panel, no floating surface, no stock-layout replacement.
- The 16 px cell takes an icon, not a label.
- One additive registration in the sidebar until a human extends the rider.
- The client revert in ticket 114 must land first; this ticket rides the post-revert composition point. (114 is resolved; the glyph rides that composition.)

## Comments

### 2026-10-18 — filing

Filed for ADR-0024's rider and its addendum. The scope limit is the important part of this ticket: the sidebar hides subagent rows, so the worker half of the owner's three-way request is unreachable in the named slot and must move to the conversation header — which needs a fresh human ruling before implementation. That is recorded as a gate, not worked around.

Dispatcher identity is written as conditional for the same reason ADR-0027 records it: no dispatcher preset row exists in the working tree today, so `agentPreset` cannot yet discriminate a dispatcher.

## Resolution — 2026-10-22

**Authority applied.** ADR-0024 (accepted, human-ruled) outranks this ticket's text (authority stack: accepted ADRs at level 2, ticket rulings at level 7). Its 2026-10-18 rider says, verbatim:

> **1. Exactly one additional additive registration is permitted, and it is this one.** The client module may register `sidebar.session.row.leading` to render a small glyph for dispatcher-owned sessions, including peer dispatchers. Decision 1's enumeration otherwise stands; no other slot is licensed by this rider. Dispatcher identity already reaches the client through the existing roster mirror (`roster.<sessionId>`), so no new host channel is licensed either.

The addendum adds nothing to the licensed seat count: "**3. Nothing else in the rider changes.** Still one additive registration, glyph only, no layout replacement, no floating surface."

**Decision.** The rider licenses the sidebar cell only. The dispatcher sidebar glyph is kept and remains the single session-kind registration; the worker marker in `conversation.session.header.actions` is **removed**, because the code composed it without the dated ruling the ticket itself required. This is the ticket's §B gate resolving as "declined" — not a change of mind about the owner's goal. A future dated human ruling can extend the rider and the header marker can then be composed at the one composition point.

**What shipped (kept).**
- `dispatcherGlyphRegistration()` — `sidebar.session.row.leading`, entry id `multitask-dispatcher-kind`, order 20, locale `multitask-dispatcher`. Composed by `apply` in `src/client/index.ts`.
- `resolveSessionKind` / `createSessionKindGlyph` — pure, fail-closed kind resolution over `SessionSummary` facts (`origin` first, then `projectionValues.sessionKind`).

**What was removed / declined.**
- The `conversation.session.header.actions` inject and its `workerGlyphRegistration()` composition in `src/client/index.ts`.
- `workerGlyphRegistration`, `HEADER_ACTIONS_SLOT`, `WORKER_GLYPH_ENTRY_ID`, `WORKER_GLYPH_ORDER` in `src/client/session-kind.tsx` (now unused).
- Worker-header coverage in `test/client-session-kind.test.ts`: the header registration contract test and the header composition test were replaced by a "no worker/header registration exists" pin and a single-entry composition pin. The worker glyph's own rendering tests stay — the factory is retained, uncomposed machinery.
- **Declined:** any worker mark in the conversation header, in any seat, until a dated human ruling extends ADR-0024's rider. `WORKER_GLYPH` and the `indicator.worker` locale key stay in the tree (inert) so that ruling is a composition edit, not a rewrite.

**Fixes made while in the file (trivially safe only).**
- The stale doc comment on `DISPATCHER_GLYPH_ORDER` said "NOT COMPOSED" and that `apply` registers no sidebar entry — wrong since the dispatcher glyph became composition. Corrected, along with the module header's "Where each kind can be marked" section (the header seat is now documented as declined, not as the chosen seat).
- The typo constants named in the brief (`DISATCHER_GLYPH`, `DISATCHER_GLYPH_ENTRY_ID`, `DISATCHER_GLYPH_ORDER`) **did not exist** in the tree — the module already spelled them `DISPATCHER_*`. No rename was needed; nothing ripples outside the client package.
- Stale prose corrected in `src/client/overlay.ts` (the locale comment claimed the worker mark was the composed one), `src/client/index.ts` (module header item 4), and `docs/surfaces.md` (inventory row said "Ruled, not implemented"; it is live, and now records the header decline).

**Tests run (targeted; full suite per repo rule not run).**
- `npx tsx --tsconfig tsconfig.client.json --test test/client-session-kind.test.ts` — **18 tests, 5 suites, 18 pass, 0 fail**.
- `npx tsx --tsconfig tsconfig.client.json --test test/client-shell-mount.test.ts test/client-face-scaffold.test.ts test/client-roster-panel.test.ts test/client-onboarding.test.ts test/client-settings-card.test.ts test/client-toolviews.test.ts test/client-conversation-surface.test.ts` — **317 tests, 56 suites, 317 pass, 0 fail**.
- `npx tsx --tsconfig tsconfig.client.json --test test/spawn-dispatcher-activation.test.ts` — **12 tests, 1 suite, 12 pass, 0 fail**.
- `npx tsx --tsconfig tsconfig.client.json --test test/composition-polish.test.ts` — **14 tests, 5 suites, 14 pass, 0 fail**.
- `npx tsx --tsconfig tsconfig.client.json --test test/coexistence.test.ts` — **14 tests, 3 suites, 14 pass, 0 fail**.
- `npx tsc -p tsconfig.client.json --noEmit` — exit 0.
- Inject-count pins re-based 4 → 3 in `client-face-scaffold`, `client-shell-mount`, `client-roster-panel`, `client-onboarding`, `client-settings-card`, `client-toolviews` (the removed header inject).

**No live testing.** Everything above is offline; no dsh, no LLM, no browser, no network.
