import { isTerminalStatus, type WorkerSummary } from "./types.js";
import type { WakeEvent } from "./wake-bus.js";

/**
 * Dispatcher-private todo ledger status.
 * `cancelled` is an internal close state: dsh has no cancelled status, so the
 * adapter drops the item from the replaced list (prune mutation).
 */
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

/**
 * One ledger entry. The list is the dispatcher's private bookkeeping —
 * never handed to a worker (ADR-0007). The structural link to work is
 * `workerId` / `streamKey`, set when the dispatcher spawns for this item.
 */
export interface TodoItem {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string;
  readonly status: TodoStatus;
  readonly streamKey: string | null;
  readonly workerId: string | null;
  /** True only after the result has been delivered to the user (S4). */
  readonly delivered: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/**
 * A pure description of one ledger change. Reconcile returns mutations;
 * the ledger applies them. Same inputs always produce the same list.
 */
export type TodoMutation =
  | {
      readonly type: "set-status";
      readonly todoId: string;
      readonly status: TodoStatus;
      readonly reason: string;
    }
  | {
      readonly type: "link-worker";
      readonly todoId: string;
      readonly workerId: string;
      readonly streamKey: string;
      readonly reason: string;
    }
  | {
      readonly type: "mark-delivered";
      readonly todoId: string;
      readonly reason: string;
    }
  | {
      readonly type: "prune";
      readonly todoId: string;
      readonly reason: string;
    };

/** Outstanding work the reconciler reports for one wake. */
export interface ReconcileReport {
  /** in_progress items whose worker is still live. */
  readonly running: readonly TodoItem[];
  /** Items whose worker has settled but the result is not yet delivered. */
  readonly landedUndelivered: readonly TodoItem[];
  /** pending items with no live worker — still waiting to be dispatched. */
  readonly nextToDispatch: readonly TodoItem[];
  readonly mutations: readonly TodoMutation[];
}

/** Inputs to the pure reconciler. */
export interface ReconcileInput {
  readonly wake: WakeEvent;
  readonly todos: readonly TodoItem[];
  /** Roster for the wake session (includes terminal entries). */
  readonly workers: readonly WorkerSummary[];
  /** Clock for stale pruning. Defaults to Date.now(). */
  readonly nowMs?: number;
  /** How long a completed+delivered item is kept before prune. Default 1h. */
  readonly completedRetentionMs?: number;
  /** How long a pending item with no worker is kept before prune. Default 1h. */
  readonly stalePendingMs?: number;
}

const DEFAULT_COMPLETED_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_STALE_PENDING_MS = 60 * 60 * 1000;

/** Live (non-terminal) worker statuses that mean the stream has started. */
function isLiveWorker(status: WorkerSummary["status"]): boolean {
  return !isTerminalStatus(status);
}

/** Worker statuses that mean the worker has begun its first turn. */
function hasStarted(status: WorkerSummary["status"]): boolean {
  return status === "running" || status === "steering";
}

/**
 * Pure reconcile: same wake + todo state + roster always yields the same
 * mutations and buckets. Never mutates the input arrays or items.
 *
 * Rules (PRD §6.5, ticket 07):
 * - pending + started worker → in_progress
 * - several in_progress allowed
 * - completed/error settle leaves the item in_progress until delivered
 * - aborted worker → cancelled → pruned (dsh has no cancelled status)
 * - completed+delivered older than retention → pruned
 * - pending with no worker older than stale age → pruned
 */
export function reconcileTodos(input: ReconcileInput): ReconcileReport {
  const now = input.nowMs ?? Date.now();
  const completedRetentionMs =
    input.completedRetentionMs ?? DEFAULT_COMPLETED_RETENTION_MS;
  const stalePendingMs = input.stalePendingMs ?? DEFAULT_STALE_PENDING_MS;
  const mutations: TodoMutation[] = [];

  const workersById = new Map(input.workers.map((w) => [w.workerId, w]));

  /** Working copy so we can build buckets after applying logical mutations. */
  const working = new Map<string, TodoItem>();
  for (const todo of input.todos) {
    working.set(todo.id, { ...todo });
  }

  function put(todo: TodoItem): void {
    working.set(todo.id, todo);
  }

  function setStatus(
    todo: TodoItem,
    status: TodoStatus,
    reason: string,
  ): TodoItem {
    if (todo.status === status) return todo;
    mutations.push({
      type: "set-status",
      todoId: todo.id,
      status,
      reason,
    });
    const next: TodoItem = { ...todo, status, updatedAtMs: now };
    put(next);
    return next;
  }

  // Resolve the todo linked to a settled worker (structural link first).
  function todoForWorker(workerId: string): TodoItem | undefined {
    const worker = workersById.get(workerId);
    if (worker?.todoId != null) {
      const byId = working.get(worker.todoId);
      if (byId !== undefined) return byId;
    }
    for (const todo of working.values()) {
      if (todo.workerId === workerId) return todo;
    }
    return undefined;
  }

  // 1. Wake settlements: aborted → cancel+prune; completed/error stay open
  //    until the dispatcher marks delivery.
  for (const notice of input.wake.settledWorkers) {
    const todo = todoForWorker(notice.workerId);
    if (todo === undefined) continue;

    if (notice.status === "aborted") {
      setStatus(todo, "cancelled", "worker-aborted");
      mutations.push({ type: "prune", todoId: todo.id, reason: "cancelled" });
      working.delete(todo.id);
      continue;
    }

    // The stream did run — promote if reconcile sees it before noteTurnStarted.
    if (todo.status === "pending") {
      setStatus(todo, "in_progress", "worker-settled");
    }
    // completed | error: leave in_progress, delivered=false → landedUndelivered.
  }

  // 2. pending + started worker → in_progress (several allowed).
  for (const todo of [...working.values()]) {
    if (todo.status !== "pending" || todo.workerId === null) continue;
    const worker = workersById.get(todo.workerId);
    if (worker !== undefined && hasStarted(worker.status)) {
      setStatus(todo, "in_progress", "worker-started");
    }
  }

  // 3. Stale prune. Cancelled already dropped above.
  for (const todo of [...working.values()]) {
    if (
      todo.status === "completed" &&
      todo.delivered &&
      now - todo.updatedAtMs >= completedRetentionMs
    ) {
      mutations.push({
        type: "prune",
        todoId: todo.id,
        reason: "completed-retention",
      });
      working.delete(todo.id);
      continue;
    }
    if (todo.status === "pending" && todo.workerId === null) {
      if (now - todo.createdAtMs >= stalePendingMs) {
        mutations.push({
          type: "prune",
          todoId: todo.id,
          reason: "stale-pending",
        });
        working.delete(todo.id);
      }
    }
  }

  // 4. Buckets for the report.
  const running: TodoItem[] = [];
  const landedUndelivered: TodoItem[] = [];
  const nextToDispatch: TodoItem[] = [];

  for (const todo of working.values()) {
    if (todo.status === "in_progress" && !todo.delivered) {
      const worker =
        todo.workerId !== null ? workersById.get(todo.workerId) : undefined;
      if (worker !== undefined && isTerminalStatus(worker.status)) {
        // Settled (this wake or an earlier one) and not yet delivered.
        landedUndelivered.push(todo);
      } else {
        // Live worker (spawned/running/steering) or inline dispatcher work.
        running.push(todo);
      }
      continue;
    }
    if (todo.status === "pending") {
      if (todo.workerId === null) {
        nextToDispatch.push(todo);
        continue;
      }
      const worker = workersById.get(todo.workerId);
      if (worker === undefined) {
        nextToDispatch.push(todo);
      } else {
        running.push(todo);
      }
    }
  }

  return { running, landedUndelivered, nextToDispatch, mutations };
}

/** Create a new pending (or inline in_progress) ledger item. */
export interface CreateTodoInput {
  readonly sessionId: string;
  readonly title: string;
  /** Optional stable id; the ledger assigns one when omitted. */
  readonly id?: string;
  readonly streamKey?: string;
  /** Inline work the dispatcher does itself starts as in_progress. */
  readonly status?: "pending" | "in_progress";
  readonly nowMs?: number;
}

/**
 * Stateful ledger the multitask core owns. Holds items and applies
 * reconcile mutations. Still no host I/O — pure bookkeeping.
 */
export interface TodoLedger {
  create(input: CreateTodoInput): TodoItem;
  get(todoId: string): TodoItem | undefined;
  list(sessionId: string): TodoItem[];
  /** Structural link set at spawn (ADR-0007). */
  linkWorker(
    todoId: string,
    workerId: string,
    streamKey: string,
    nowMs?: number,
  ): boolean;
  /** pending → in_progress when the worker starts. */
  markInProgress(todoId: string, nowMs?: number): boolean;
  /**
   * completed = delivered to user. Sets delivered and flips status to
   * completed — the dispatcher calls this only after a successful user send.
   */
  markDelivered(todoId: string, nowMs?: number): boolean;
  /** Close as cancelled (aborted stream). */
  markCancelled(todoId: string, nowMs?: number): boolean;
  /** Drop an item from the list. */
  prune(todoId: string): boolean;
  /** Apply a batch of reconcile mutations in order. */
  apply(mutations: readonly TodoMutation[], nowMs?: number): void;
}

export function createTodoLedger(options?: {
  now?: () => number;
}): TodoLedger {
  const now = options?.now ?? (() => Date.now());
  const items = new Map<string, TodoItem>();
  let nextId = 1;

  function replace(todo: TodoItem): TodoItem {
    items.set(todo.id, todo);
    return todo;
  }

  return {
    create(input: CreateTodoInput): TodoItem {
      const at = input.nowMs ?? now();
      const id = input.id ?? `todo-${nextId++}`;
      if (items.has(id)) {
        throw new Error(`todo already exists: ${id}`);
      }
      return replace({
        id,
        sessionId: input.sessionId,
        title: input.title,
        status: input.status ?? "pending",
        streamKey: input.streamKey ?? null,
        workerId: null,
        delivered: false,
        createdAtMs: at,
        updatedAtMs: at,
      });
    },

    get(todoId: string): TodoItem | undefined {
      return items.get(todoId);
    },

    list(sessionId: string): TodoItem[] {
      return [...items.values()].filter((t) => t.sessionId === sessionId);
    },

    linkWorker(
      todoId: string,
      workerId: string,
      streamKey: string,
      nowMs?: number,
    ): boolean {
      const todo = items.get(todoId);
      if (todo === undefined) return false;
      replace({
        ...todo,
        workerId,
        streamKey: todo.streamKey ?? streamKey,
        updatedAtMs: nowMs ?? now(),
      });
      return true;
    },

    markInProgress(todoId: string, nowMs?: number): boolean {
      const todo = items.get(todoId);
      if (todo === undefined || todo.status !== "pending") return false;
      replace({ ...todo, status: "in_progress", updatedAtMs: nowMs ?? now() });
      return true;
    },

    markDelivered(todoId: string, nowMs?: number): boolean {
      const todo = items.get(todoId);
      if (todo === undefined || todo.status === "cancelled") return false;
      replace({
        ...todo,
        delivered: true,
        status: "completed",
        updatedAtMs: nowMs ?? now(),
      });
      return true;
    },

    markCancelled(todoId: string, nowMs?: number): boolean {
      const todo = items.get(todoId);
      if (todo === undefined || todo.status === "cancelled") return false;
      replace({ ...todo, status: "cancelled", updatedAtMs: nowMs ?? now() });
      return true;
    },

    prune(todoId: string): boolean {
      return items.delete(todoId);
    },

    apply(mutations: readonly TodoMutation[], nowMs?: number): void {
      const at = nowMs ?? now();
      for (const mutation of mutations) {
        switch (mutation.type) {
          case "set-status": {
            const todo = items.get(mutation.todoId);
            if (todo === undefined) break;
            if (mutation.status === "cancelled") {
              replace({ ...todo, status: "cancelled", updatedAtMs: at });
            } else {
              replace({ ...todo, status: mutation.status, updatedAtMs: at });
            }
            break;
          }
          case "link-worker": {
            const todo = items.get(mutation.todoId);
            if (todo === undefined) break;
            replace({
              ...todo,
              workerId: mutation.workerId,
              streamKey: todo.streamKey ?? mutation.streamKey,
              updatedAtMs: at,
            });
            break;
          }
          case "mark-delivered": {
            const todo = items.get(mutation.todoId);
            if (todo === undefined) break;
            replace({
              ...todo,
              delivered: true,
              status: "completed",
              updatedAtMs: at,
            });
            break;
          }
          case "prune": {
            items.delete(mutation.todoId);
            break;
          }
        }
      }
    },
  };
}
