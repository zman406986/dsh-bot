# 171 — One stage per worker, derived by a first-match table over state we already hold

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** nothing. One new pure module plus one wiring site.
**Origin:** the dispatcher reads `check_workers` to decide what to do next, and today's row cannot answer the question it needs: is this result still owed to the user. That fact is already in core state; nothing surfaces it.
**Related:** ticket 28 (roster sections — the same precedence idea, panel-side), ticket 58 (delivery obligation bound), ticket 61 (liveness signal — the precedent for a derived verdict on a check row), ADR-0007 (the structural todo link this reads), ADR-0006 (a terminal result may still be owed), ADR-0028 (mid-task replies are metadata, not status), ADR-0033 (the access-ask removal that took this ticket's second case with it).

## Scope change — the access-ask half is gone (ADR-0033, 2026-11-03)

This ticket was written before the worker access-ask feature was deleted. It originally carried **two** motivating cases and a **four-row** table. One case no longer exists:

- **Deleted by ADR-0033 (out of scope, do NOT reintroduce):** "a worker parked on a pending access ask renders as plain `running`." There is now no `request_access` tool, no relay, no pending ask, and no `/dispatcher-resolve`. The `waiting-for-answer` stage and `awaitingAnswer` input below are **retired** — they would describe a state the system can no longer enter. ADR-0033's answer to a blocked worker is different: it reports the blocker in its final answer and stops, which is the ordinary settle path (ADR-0028).
- **Still in scope, and the whole of the remaining work:** a settle row cannot distinguish "result already delivered to the user" from "result still owed", so the dispatcher either re-delivers a result the user already read or silently drops one. Dropping one is the S4 failure ADR-0006 exists to prevent; `completed` means the turn ended, not that the result reached the user.

Commit `643a801` (ticket 174) made the same cut inside this module: it removed `deriveWorkerLiveness`'s `blocked` input and built `worker-stage.ts` with **three** rows, no access input. That is the correct reading of ADR-0033 and this ticket now matches it.

## Problem (remaining)

`formatCheckRowLine` renders:

```
completed · "Rewrite auth docs" · 4m12s · 7 tool calls · todo t-3 · transcript: child-9
```

Two workers produce that identical line in two situations needing opposite actions:

- A result **delivered** two wakes ago, and a result **still owed** because its wake was skipped while the user was typing. The dispatcher cannot tell them apart, so it either re-delivers a result the user already read or silently drops one.

This is a decision the dispatcher makes on its own tool result. No panel is involved, and none is mounted.

## The stage table (as shipped — three rows)

One stage per worker. FIRST matching row wins, top to bottom. Every input is existing core state; no new field.

| # | Stage | Condition (first match wins) | Existing source |
|---|---|---|---|
| 1 | `waiting-for-delivery` | terminal, and the linked ledger item exists, is not `delivered`, and is neither `lost` nor `cancelled` | `WorkerRecord.todoId` + `TodoItem.delivered` / `.status` |
| 2 | `working` | `spawned` \| `running` \| `steering` | `WorkerStatus` |
| 3 | `ended` | terminal with nothing owed | the above, negated |

Deliberate properties:

- `spawned` folds into `working`: "not started yet" changes nothing the dispatcher does, and a first turn that never starts is a liveness question (`deriveWorkerLiveness` already measures from `startedAtMs`).
- No `aborted` stage: abort prunes the linked ledger item, so an aborted worker is `ended`. The word stays on `status`.
- No `error` stage: the stage answers "what is it waiting for", not "did it succeed". `error` stays on `status`.
- No `unknown` stage: crash-time holds never reach `listWorkers` (they live in `unknownStateHolds`). A caller that wants them reads `Multitask.listUnknownStateHolds`.
- No `queued` stage: a `pending` todo with no worker is not a worker.
- **No `waiting-for-answer` stage** — retired with the access-ask feature (ADR-0033). See §Scope change.

### Two facts this table deliberately does NOT encode

- **"Finished and ready" vs "finished and it says it failed".** `mapStopReason` maps the HOST stop reason only (`completed` → `completed`, `aborted` → `aborted`, everything else → `error`), so a host-level failure (`refusal`, `max-tokens`, unknown reason) is already `status: error`. A worker that ends its turn normally is always `completed`, even when its report says the work failed, and nothing structured records that. It cannot be derived. Recording it needs a new outcome field on `SettledEvent`, `WorkerRecord`, and the durable marker — a separate ticket. This table does not wait on it.
- **An unanswered `blocked` mid-task reply.** It is metadata only (ADR-0028): the reply tool never touches the FSM, the ledger, or a completion path, and `check_workers` still reads `running`. The core keeps no per-worker record of the last reply status; delivered envelopes are retained in the peer inbox but no accessor returns them, and "unanswered" is not a state this system defines. A worker that reported `blocked` and kept working stays `working`. Also a separate ticket.

## Where it lives (as shipped)

`src/core/worker-stage.ts` (new file, added by `643a801`). Not part of `worker-fsm.ts`: the FSM owns legal transitions between statuses and never sees a ledger obligation.

```ts
import type { TodoStatus } from "./todo-reconciler.js";
import type { WorkerStatus } from "./types.js";

export type WorkerStage = "waiting-for-delivery" | "working" | "ended";

export const WORKER_STAGES: readonly WorkerStage[];

export interface WorkerStageInput {
  readonly status: WorkerStatus;
  /** The structurally linked ledger item, or undefined when there is none. */
  readonly linkedTodo:
    | { readonly delivered: boolean; readonly status: TodoStatus }
    | undefined;
}

export function deriveWorkerStage(input: WorkerStageInput): WorkerStage;
```

Pure, synchronous, no clock, no host, no I/O. The `lost` / `cancelled` exclusion lives inside the
function so no caller can re-derive it differently.

## Wiring (as shipped)

1. `src/core/tool-results.ts`
   - `WorkerCheckRow` has `readonly stage: WorkerStage | null;` — nullable exactly like `liveness`, meaning "not derivable here", never a guess.
   - `toCheckRow(summary, recentActivity = null, liveness = null, stage = null)` — optional fourth parameter, so every existing positional caller keeps compiling and produces `stage: null`.
   - `formatCheckRowLine` appends `stage: <word>` when it is not `null`, in the same place and style as the existing `liveness:` segment.
2. `src/core/tools.ts`, `checkWorkers.execute` only. The ledger index is built once for both branches:
   ```ts
   const todosById = new Map(
     multitask.listTodos(parentSessionId).map((t) => [t.id, t]),
   );
   const stageOf = (summary: WorkerSummary): WorkerStage =>
     deriveWorkerStage({
       status: summary.status,
       linkedTodo:
         summary.todoId !== null ? todosById.get(summary.todoId) : undefined,
     });
   ```
   `stageOf(summary)` is passed at both `toCheckRow` call sites (single-worker branch and roster branch).
3. `src/index.ts` — additive export block beside the `liveness` one: `deriveWorkerStage`, `WORKER_STAGES`, `type WorkerStage`, `type WorkerStageInput`.

Surfaces that do NOT use it, and why:

- **Wake digest** (`composeWakeText` / `assembleActivityDigest`, `src/plugin.ts`): its output is prompt text, which this ticket excludes, and the waking turn reports what settled, which `status` already says.
- **Restart notice** (`src/adapter/restart-notice.ts`): it receives a `RebuildReport` — no ledger — so it cannot build the input; its unknown-state rows are exactly what the table cannot classify, and its copy is fixed.
- **Roster store** (`src/client/roster-store.ts` `rosterSectionFor`): the snapshot row has `delivered` but no todo status, so it cannot compute row 1 honestly (`lost` would read as owed). Two inputs would mean two tables. The panel is also retained-but-unmounted, and this is a client change. Recorded equivalence for a future mount: `waiting-for-delivery` → `needs-you`, `working` → `active`, `ended` → `finished`; the only divergence is a `lost` obligation, which stages `ended` but the panel shows under `needs-you`.
- **Client toolview** (`src/client/toolviews.ts` `describeCheck`): reads named fields and ignores unknown ones, so the new field is inert; rendering is out of scope.

## Acceptance

- [x] `src/core/worker-stage.ts` exists with the exact types and signature above; no clock, host, or I/O import.
- [x] `deriveWorkerStage` implements the three rows in the stated order, including the `lost` / `cancelled` exclusion for row 1.
- [x] `WorkerCheckRow.stage` exists and is nullable; `toCheckRow`'s new parameter defaults to `null`; `formatCheckRowLine` renders `stage: <word>` only when non-null.
- [x] `check_workers` returns a real stage for every row in both branches, and its summary line shows it.
- [x] `test/worker-stage.test.ts` covers all 6 statuses × 5 `linkedTodo` cases in one table-driven test, plus end-to-end `check_workers` tests through `FakeDshHost` proving `waiting-for-delivery` → `ended` after `markDelivered`, the single-worker branch, and an unlinked worker reading `ended`.
- [x] `test/tool-results.test.ts` pins the `null` default (no `stage:` segment) and the segment's position after `liveness`.
- [x] `npx tsc -p tsconfig.json --noEmit` exits 0; the three owned suites pass (20 tests).
- [x] `node tools/issue-index.mjs` includes this ticket (row 171 present; the index was regenerated when the ticket landed in `643a801`).

Deferred with the scope change: the `awaitingAnswer` dimension of the table test (the original 6 × 2 × 5 matrix). It tested a state that no longer exists.

## Constraints

- No prompt text or tool-description change. `TOOL_DESCRIPTIONS` / `TOOL_DESCRIPTIONS_ZH` stay byte-identical; `src/core/policy/**`, `src/worker/**`, `src/adapter/wake-copy.ts` are not edited.
- No change to `src/core/worker-fsm.ts`'s legal transitions, events, or the six-word `WorkerStatus`.
- No new persistence: `DurableWorkerMarker`, the storage domain, and `DOMAIN_VERSION` are untouched. Stage is derived on read.
- No new host seam; no adapter file edited.
- No client change: `src/client/**` untouched.
- No core change: `Multitask` already exposes `listTodos`; `src/core/multitask.ts` is not edited.
- The stage is never stored and never branched on anywhere except the one rendered line.
- **No access-ask concept of any kind** (ADR-0033): no `waiting-for-answer` stage, no `awaitingAnswer` input, no `listPendingAccess`, no `blocked` flag.
- Do not add the success/failure split or the mid-task-reply status to this ticket. Both need new recorded state and are follow-ups; this ticket ships only what is derivable today.
- Do not add the three stage words to `CONTEXT.md`. They describe existing state; the glossary is for domain concepts, not projections. Raise it with the owner if that reading is contested.

## Comments

### 2026-11-04 — implemented; ticket's second case retired by ADR-0033

**What `643a801` (ticket 174) had already done**, found on reading the tree rather than the ticket:
`src/core/worker-stage.ts` already existed with the three-row table, `WorkerCheckRow.stage` and the
`toCheckRow` fourth parameter were already in `tool-results.ts`, `checkWorkers.execute` already
built `todosById` and passed `stageOf(summary)` at both call sites, and `src/index.ts` already
exported the four names. `deriveWorkerLiveness` had lost its `blocked` input.

**What genuinely remained, and was done in this pass:**
1. This ticket file still specified `waiting-for-answer`, `awaitingAnswer`, `listPendingAccess`, and
   the `blockedWorkerIds` wiring — all describing the deleted access-ask feature. Rewritten to the
   three-row table that actually shipped; the scope change is recorded in §Scope change.
2. `test/liveness.test.ts` still passed `access: { timeoutMs, schedule }` to `createMultitask`.
   `MultitaskOptions` has no such field since ADR-0033, so that literal was a `TS2353` error that
   `tsconfig.json` does not cover (it excludes `test/`) and `tsx` strips types, so it failed
   neither gate. Removed.
3. `test/tool-results.test.ts` had no `stage` coverage at all: the `null` default, the absence of
   a `stage:` segment when null, and the segment's position after `liveness` were all unpinned.
   Added four tests.
4. `test/worker-stage.test.ts` covered only the roster branch of `check_workers`, while the
   acceptance requires both. Added the single-worker-branch test and a no-linked-todo test
   (a terminal unlinked worker must read `ended`, not `waiting-for-delivery`).

**Not touched:** `src/core/worker-stage.ts`, `src/core/tool-results.ts`, `src/core/liveness.ts`,
`src/core/tools.ts` — `643a801` rendered them correct for the three-row table, and the acceptance
items they carry already hold.

**Gates:** `npx tsc -p tsconfig.json --noEmit` exits 0. The three owned suites run 20 tests, 0 fail.
A standalone strict typecheck of the three test files is clean. `npm test` was not run (other lanes
mid-edit, per the dispatch instruction).

**Open for the owner:** `node tools/issue-index.mjs --check` reports the index stale, but the
mismatch is the ticket-170 move to `resolved/` made by another lane, not this ticket — the
regeneration is that lane's to run.

### 2026-11-04 — PM closure

Implemented and verified in the tree. The stage table shipped in `643a801` (ticket 174);
this ticket's remaining work (ticket-file accuracy, the dead `access:` option in
`test/liveness.test.ts`, and the missing stage coverage) landed in the pass recorded above.
The access-ask half is out of scope by ADR-0033 and is recorded in §Scope change.

The live `check_workers` render check is folded into ticket 158, which owns the live lane;
no live dsh run was performed here.
