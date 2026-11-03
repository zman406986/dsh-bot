# 171 — One stage per worker, derived by a first-match table over state we already hold

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** nothing. One new pure module plus one wiring site.
**Origin:** the dispatcher reads `check_workers` to decide what to do next, and today's row cannot answer the two questions it needs: is this result still owed to the user, and is this worker waiting for me to answer an access ask. Both facts are already in core state; nothing surfaces them together.
**Related:** ticket 28 (roster sections — the same precedence idea, panel-side), ticket 58 (delivery obligation bound), ticket 61 (liveness signal — the precedent for a derived verdict on a check row), ADR-0007 (the structural todo link this reads), ADR-0006 (a terminal result may still be owed), ADR-0028 (mid-task replies are metadata, not status).

## Problem

`formatCheckRowLine` renders:

```
completed · "Rewrite auth docs" · 4m12s · 7 tool calls · todo t-3 · transcript: child-9
```

Two workers produce the same line in two different situations that need opposite actions:

- A result **delivered** two wakes ago, and a result that **is still owed** because its wake was skipped while the user was typing. The dispatcher cannot tell them apart, so it either re-delivers a result the user already read or silently drops one. Dropping one is the S4 failure ADR-0006 exists to prevent; `completed` means the turn ended, not that the result reached the user.
- A worker parked on a pending access ask renders as plain `running`. The `blocked` fact is already joined in `check_workers` but only feeds `deriveWorkerLiveness`, and `liveness` is `null` whenever the activity-time seam is absent. With no seam, "waiting for the dispatcher to answer" and "working" are the same line. The dispatcher does nothing and the ask dies at the deny timeout.

Both are decisions the dispatcher makes on its own tool result. No panel is involved, and none is mounted.

## The stage table

One stage per worker. FIRST matching row wins, top to bottom. All four inputs are existing core state; no new field.

| # | Stage | Condition (first match wins) | Existing source |
|---|---|---|---|
| 1 | `waiting-for-answer` | a pending access ask is parked for this worker | `Multitask.listPendingAccess(sessionId)` |
| 2 | `waiting-for-delivery` | terminal, and the linked ledger item exists, is not `delivered`, and is neither `lost` nor `cancelled` | `WorkerRecord.todoId` + `TodoItem.delivered` / `.status` |
| 3 | `working` | `spawned` \| `running` \| `steering` | `WorkerStatus` |
| 4 | `ended` | terminal with nothing owed | the above, negated |

Deliberate properties:

- Row 1 before row 2 is defensive: the core clears the access ticket on settle and on abort, so a terminal worker never carries a pending ask. The order is stated so the table is total for any input.
- `spawned` folds into `working`: "not started yet" changes nothing the dispatcher does, and a first turn that never starts is a liveness question (`deriveWorkerLiveness` already measures from `startedAtMs`).
- No `aborted` stage: abort prunes the linked ledger item, so an aborted worker is `ended`. The word stays on `status`.
- No `error` stage: the stage answers "what is it waiting for", not "did it succeed". `error` stays on `status`.
- No `unknown` stage: crash-time holds never reach `listWorkers` (they live in `unknownStateHolds`). A caller that wants them reads `Multitask.listUnknownStateHolds`.
- No `queued` stage: a `pending` todo with no worker is not a worker.

### Two facts this table deliberately does NOT encode

- **"Finished and ready" vs "finished and it says it failed".** `mapStopReason` maps the HOST stop reason only (`completed` → `completed`, `aborted` → `aborted`, everything else → `error`), so a host-level failure (`refusal`, `max-tokens`, unknown reason) is already `status: error`. A worker that ends its turn normally is always `completed`, even when its report says the work failed, and nothing structured records that. It cannot be derived. Recording it needs a new outcome field on `SettledEvent`, `WorkerRecord`, and the durable marker — a separate ticket. This table does not wait on it.
- **An unanswered `blocked` mid-task reply.** It is metadata only (ADR-0028): the reply tool never touches the FSM, the ledger, or a completion path, and `check_workers` still reads `running`. The core keeps no per-worker record of the last reply status; delivered envelopes are retained in the peer inbox but no accessor returns them, and "unanswered" is not a state this system defines. A worker that reported `blocked` and kept working stays `working`. Also a separate ticket.

## Where it lives

New file `src/core/worker-stage.ts`. Do not extend `worker-fsm.ts`: the FSM owns legal transitions between statuses and never sees an access ask or a ledger obligation.

```ts
import type { TodoStatus } from "./todo-reconciler.js";
import type { WorkerStatus } from "./types.js";

export type WorkerStage =
  | "waiting-for-answer"
  | "waiting-for-delivery"
  | "working"
  | "ended";

export const WORKER_STAGES: readonly WorkerStage[];

export interface WorkerStageInput {
  readonly status: WorkerStatus;
  /** True when a pending access ask is parked for this worker. */
  readonly awaitingAnswer: boolean;
  /** The structurally linked ledger item, or undefined when there is none. */
  readonly linkedTodo:
    | { readonly delivered: boolean; readonly status: TodoStatus }
    | undefined;
}

export function deriveWorkerStage(input: WorkerStageInput): WorkerStage;
```

Pure, synchronous, no clock, no host, no I/O. The `lost` / `cancelled` exclusion lives inside the
function so no caller can re-derive it differently.

## Wiring

1. `src/core/tool-results.ts`
   - `WorkerCheckRow` gains `readonly stage: WorkerStage | null;` — nullable exactly like `liveness`, meaning "not derivable here", never a guess.
   - `toCheckRow(summary, recentActivity = null, liveness = null, stage = null)` — optional fourth parameter, so every existing positional caller keeps compiling and produces `stage: null`.
   - `formatCheckRowLine` appends `stage: <word>` when it is not `null`, in the same place and style as the existing `liveness:` segment.
2. `src/core/tools.ts`, `checkWorkers.execute` only. Build the ledger index once beside `blockedWorkerIds`:
   ```ts
   const todosById = new Map(multitask.listTodos(parentSessionId).map((t) => [t.id, t]));
   const stageOf = (summary: WorkerSummary): WorkerStage =>
     deriveWorkerStage({
       status: summary.status,
       awaitingAnswer: blockedWorkerIds.has(summary.workerId),
       linkedTodo: summary.todoId !== null ? todosById.get(summary.todoId) : undefined,
     });
   ```
   Pass `stageOf(summary)` at both `toCheckRow` call sites (single-worker branch and roster branch).
3. `src/index.ts` — one additive export block beside the `liveness` one: `deriveWorkerStage`, `WORKER_STAGES`, `type WorkerStage`, `type WorkerStageInput`.

Surfaces that do NOT use it, and why:

- **Wake digest** (`composeWakeText` / `assembleActivityDigest`, `src/plugin.ts`): its output is prompt text, which this ticket excludes, and the waking turn reports what settled, which `status` already says.
- **Restart notice** (`src/adapter/restart-notice.ts`): it receives a `RebuildReport` — no ledger, no access tickets — so it cannot build the input; its unknown-state rows are exactly what the table cannot classify, and its copy is fixed.
- **Roster store** (`src/client/roster-store.ts` `rosterSectionFor`): the snapshot row has `delivered` but no todo status, so it cannot compute row 2 honestly (`lost` would read as owed). Two inputs would mean two tables. The panel is also retained-but-unmounted, and this is a client change. Recorded equivalence for a future mount: `waiting-for-answer` → `needs-you`, `waiting-for-delivery` → `needs-you`, `working` → `active`, `ended` → `finished`; the only divergence is a `lost` obligation, which stages `ended` but the panel shows under `needs-you`.
- **Client toolview** (`src/client/toolviews.ts` `describeCheck`): reads named fields and ignores unknown ones, so the new field is inert; rendering is out of scope.

## Acceptance

- [ ] `src/core/worker-stage.ts` exists with the exact types and signature above; no clock, host, or I/O import.
- [ ] `deriveWorkerStage` implements the four rows in the stated order, including the `lost` / `cancelled` exclusion for row 2.
- [ ] `WorkerCheckRow.stage` exists and is nullable; `toCheckRow`'s new parameter defaults to `null`; `formatCheckRowLine` renders `stage: <word>` only when non-null.
- [ ] `check_workers` returns a real stage for every row in both branches, and its summary line shows it.
- [ ] `test/worker-stage.test.ts` covers all 6 statuses × 2 `awaitingAnswer` × 5 `linkedTodo` cases in one table-driven test, plus one end-to-end `check_workers` test through `FakeDshHost` proving `waiting-for-delivery` → `ended` after `markDelivered`.
- [ ] `npx tsc -p tsconfig.json --noEmit` exits 0; `npx tsx --test test/worker-stage.test.ts test/tool-results.test.ts test/liveness.test.ts test/dispatcher-tools.test.ts` passes.
- [ ] `node tools/issue-index.mjs` is re-run so `Issue-tracker/open-issue-index.md` includes this ticket.

## Constraints

- No prompt text or tool-description change. `TOOL_DESCRIPTIONS` / `TOOL_DESCRIPTIONS_ZH` stay byte-identical; `src/core/policy/**`, `src/worker/**`, `src/adapter/wake-copy.ts` are not edited.
- No change to `src/core/worker-fsm.ts`'s legal transitions, events, or the six-word `WorkerStatus`.
- No new persistence: `DurableWorkerMarker`, the storage domain, and `DOMAIN_VERSION` are untouched. Stage is derived on read.
- No new host seam; no adapter file edited.
- No client change: `src/client/**` untouched.
- No core change: `Multitask` already exposes `listTodos` and `listPendingAccess`; `src/core/multitask.ts` is not edited.
- The stage is never stored and never branched on anywhere except the one rendered line.
- Do not add the success/failure split or the mid-task-reply status to this ticket. Both need new recorded state and are follow-ups; this ticket ships only what is derivable today.
- Do not add the four stage words to `CONTEXT.md`. They describe existing state; the glossary is for domain concepts, not projections. Raise it with the owner if that reading is contested.
