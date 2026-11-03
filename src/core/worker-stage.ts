/**
 * One stage per worker (ticket 171).
 *
 * `check_workers` already projects status, elapsed time, tool-call count,
 * activity, and a liveness verdict. None of those answer the question the
 * dispatcher acts on: is this finished result still OWED to the user. That
 * fact is already in core state — this module is a read-only projection over
 * it, never a new stored field.
 *
 * Deliberately NOT part of `worker-fsm.ts`: the FSM owns the legal
 * transitions between statuses, and this table needs an input the FSM never
 * sees (the ledger obligation). Pure, synchronous, no clock, no host, no
 * I/O: the same input always yields the same stage.
 */

import { isTerminalStatus, type WorkerStatus } from "./types.js";
import type { TodoStatus } from "./todo-reconciler.js";

/** The one stage a worker is in. Exactly one applies; the table is total. */
export type WorkerStage =
  /** Terminal, and the result is still owed to the user. */
  | "waiting-for-delivery"
  /** Live: `spawned` | `running` | `steering`. */
  | "working"
  /** Terminal, nothing owed. */
  | "ended";

/**
 * Every stage, in table order. Exported so consumers cannot invent a fifth
 * word, and so a caller can assert the derivation stays inside the set.
 */
export const WORKER_STAGES: readonly WorkerStage[] = [
  "waiting-for-delivery",
  "working",
  "ended",
];

/** Inputs: every one is existing core truth, read at call time. */
export interface WorkerStageInput {
  /** Core FSM status, verbatim (`WorkerStatus`). */
  readonly status: WorkerStatus;
  /**
   * The ledger item this worker is structurally linked to (ADR-0007), or
   * `undefined` when it has none. Only `delivered` and `status` are read; the
   * whole `TodoItem` satisfies this shape, so a caller passes the item it
   * already has.
   */
  readonly linkedTodo:
    | { readonly delivered: boolean; readonly status: TodoStatus }
    | undefined;
}

/**
 * Derive the one stage. Pure, synchronous, no clock, no host, no I/O:
 * same input always yields the same stage.
 *
 * The table, FIRST matching row wins:
 *
 * 1. `waiting-for-delivery` — terminal, and the linked ledger item exists,
 *    is not `delivered`, and is neither `lost` nor `cancelled`. `completed`
 *    means the turn ended, not that the result reached the user (ADR-0006).
 *    The `lost` / `cancelled` exclusion lives HERE so no caller can
 *    re-derive it differently and create a second table.
 * 2. `working` — `spawned` | `running` | `steering`. `spawned` is folded in
 *    on purpose: "not started yet" changes nothing the dispatcher does, and
 *    a first turn that never starts is a liveness question.
 * 3. `ended` — everything else: terminal with nothing owed.
 */
export function deriveWorkerStage(input: WorkerStageInput): WorkerStage {
  const todo = input.linkedTodo;
  if (
    isTerminalStatus(input.status) &&
    todo !== undefined &&
    !todo.delivered &&
    todo.status !== "lost" &&
    todo.status !== "cancelled"
  ) {
    return "waiting-for-delivery";
  }
  // Row 2.
  if (!isTerminalStatus(input.status)) return "working";
  // Row 3.
  return "ended";
}
