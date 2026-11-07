import { isTerminalStatus, type WorkerSummary } from "./types.js";
import type { WakeEvent } from "./wake-bus.js";

/**
 * Dispatcher-private todo ledger status.
 * `cancelled` is an internal close state: dsh has no cancelled status, so the
 * adapter drops the item from the replaced list (prune mutation).
 * `lost` (ticket 58, register D-5) is the terminal state for an obligation we
 * gave up on: the work finished but its result never reached the user, and we
 * stopped retrying. It is deliberately NOT `completed` — `completed` means
 * delivered (ADR-0007), and conflating the two is the bug D-5 describes.
 */
export type TodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "lost";

/**
 * How a settled result's delivery obligation ended (ticket 58, register D-6).
 * Telemetry only — nothing branches on it. It exists so "why did this result
 * never reach the user?" is answerable after the fact.
 */
export type DeliveryDisposition = "delivered" | "superseded" | "dropped";

/**
 * Why an obligation closed the way it did. New copy; descriptive on purpose —
 * a reader of the ledger should not need the source to interpret it.
 */
export type DeliveryReason =
  | "delivered-to-user"
  | "worker-aborted"
  | "superseded-by-redispatch"
  | "max-redrives"
  | "worker-gone"
  | "session-unavailable";

/**
 * Where an externally-intaked item came from (ticket 113, ADR-0023).
 * Present only on ledger items created for an external intake job; it makes
 * delivery routing distinguishable (the plugin's reply writer targets the
 * job dir) without inventing a new wake or worker kind (C15). The inbox
 * never spawns (ADR-0003) — this marker does not change that; it only
 * records provenance.
 */
export interface TodoExternalOrigin {
  readonly kind: "inbox";
  readonly jobId: string;
  readonly jobDir: string;
}

/**
 * Delivery attempts we make *beyond* the settle wake's own opportunity, before
 * escalating to `lost` (ticket 58, register D-5).
 *
 * Chosen to mirror the reference's bound: it stops after **three delivery
 * attempts**. Ours counts redrives, and the settle wake is already one
 * opportunity, so 2 redrives = 3 attempts. The counter is persisted on the
 * durable marker, so — like the reference — the budget is a **lifetime** one
 * that survives restarts rather than resetting per boot. Mirroring the
 * reference is not a deviation, so nothing is logged in the register for it;
 * see the ticket for the rationale and the hazard this accepts.
 */
export const MAX_DELIVERY_REDRIVES = 2;

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
  /**
   * Redrive attempts spent on this item (ticket 58). Persisted on the durable
   * marker so a restart continues the same budget rather than restarting it.
   */
  readonly redriveAttempts: number;
  /** How the obligation ended, once terminal (ticket 58, D-6). */
  readonly disposition: DeliveryDisposition | null;
  readonly dispositionReason: DeliveryReason | null;
  /** External intake provenance (ticket 113); null for ordinary items. */
  readonly external: TodoExternalOrigin | null;
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
      /** Ticket 58: one redrive attempt spent (persisted via the marker). */
      readonly type: "record-redrive";
      readonly todoId: string;
      readonly attempts: number;
      readonly reason: string;
    }
  | {
      /** Ticket 58 (D-6): close the obligation with a disposition + reason. */
      readonly type: "record-disposition";
      readonly todoId: string;
      readonly disposition: DeliveryDisposition;
      readonly reason: DeliveryReason;
    }
  | {
      /**
       * Ticket 58 (D-6): log a delivery observation WITHOUT touching the
       * item's summary disposition. Used when one item carries several
       * obligations (a re-dispatch supersedes a result, then a later one is
       * delivered) — the summary would otherwise have to drop one of them.
       */
      readonly type: "record-delivery-event";
      readonly todoId: string | null;
      readonly workerId: string | null;
      readonly disposition: DeliveryDisposition;
      readonly reason: DeliveryReason;
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
  /**
   * Landed-undelivered items that missed their earlier delivery opportunity
   * and are still inside the bound (ticket 58, D-5): the caller must open a
   * redrive turn for these. Attempts are already incremented on the items
   * here — the mutation is in `mutations`.
   */
  readonly toRedrive: readonly TodoItem[];
  /** Items escalated to terminal `lost` by this reconcile (ticket 58, D-5). */
  readonly lost: readonly TodoItem[];
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
  /**
   * Redrives allowed before an undelivered obligation escalates to `lost`.
   * Defaults to {@link MAX_DELIVERY_REDRIVES}.
   */
  readonly maxRedrives?: number;
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
 * - passed its first delivery opportunity and still undelivered → redrive
 *   or, at the bound, `lost` (ticket 58, D-5) — never unbounded
 * - `lost` older than retention → pruned (ticket 58)
 */
export function reconcileTodos(input: ReconcileInput): ReconcileReport {
  const now = input.nowMs ?? Date.now();
  const completedRetentionMs =
    input.completedRetentionMs ?? DEFAULT_COMPLETED_RETENTION_MS;
  const stalePendingMs = input.stalePendingMs ?? DEFAULT_STALE_PENDING_MS;
  const maxRedrives = input.maxRedrives ?? MAX_DELIVERY_REDRIVES;
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

    // Superseded result (ticket 58, D-6): the item has since been
    // re-dispatched to a different worker, so this settle is an old result
    // nobody is waiting for. The ledger's structural link is the authority —
    // not the settling worker's own `todoId`, which is a stale pointer by
    // definition here. Log it and stop; do not promote the item or count it
    // as landed-undelivered.
    if (todo.workerId !== null && todo.workerId !== notice.workerId) {
      mutations.push({
        type: "record-delivery-event",
        todoId: todo.id,
        workerId: notice.workerId,
        disposition: "superseded",
        reason: "superseded-by-redispatch",
      });
      continue;
    }

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

  // 2b. Delivery obligation (ticket 58, register D-5). A settled worker's
  //     result is owed to the user until it is delivered. If this wake is
  //     not the item's first opportunity (i.e. it already missed one), the
  //     item is either redriven or escalated — never left unbounded, which
  //     is the user-visible defect: a result that never arrives and is never
  //     mentioned. The bound is a persisted lifetime budget (D-5).
  const settledNow = new Set(
    input.wake.settledWorkers.map((notice) => notice.workerId),
  );
  const toRedrive: TodoItem[] = [];
  const lost: TodoItem[] = [];

  for (const todo of [...working.values()]) {
    if (todo.status !== "in_progress" || todo.delivered) continue;
    const worker =
      todo.workerId !== null ? workersById.get(todo.workerId) : undefined;
    if (worker === undefined || !isTerminalStatus(worker.status)) continue;
    // This wake carries the item's own settle → first delivery opportunity.
    // Counting it as a redrive would spend part of the budget on the happy
    // path and shorten the real retry allowance.
    if (todo.workerId !== null && settledNow.has(todo.workerId)) continue;
    if (todo.redriveAttempts >= maxRedrives) {
      const escalated = setStatus(todo, "lost", "max-redrives");
      mutations.push({
        type: "record-disposition",
        todoId: todo.id,
        disposition: "dropped",
        reason: "max-redrives",
      });
      lost.push(escalated);
      continue;
    }
    const attempts = todo.redriveAttempts + 1;
    mutations.push({
      type: "record-redrive",
      todoId: todo.id,
      attempts,
      reason: "delivery-retry",
    });
    const attempted: TodoItem = {
      ...todo,
      redriveAttempts: attempts,
      updatedAtMs: now,
    };
    put(attempted);
    toRedrive.push(attempted);
  }

  // 3. Stale prune. Cancelled already dropped above.
  for (const todo of [...working.values()]) {
    // A `lost` item is reported on the ledger (the per-turn reminder shows it
    // with its reason) and then retired like any other closed item — otherwise
    // escalation would just replace one unbounded row with another.
    if (
      todo.status === "lost" &&
      now - todo.updatedAtMs >= completedRetentionMs
    ) {
      mutations.push({
        type: "prune",
        todoId: todo.id,
        reason: "lost-retention",
      });
      working.delete(todo.id);
      continue;
    }
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

  return { running, landedUndelivered, nextToDispatch, toRedrive, lost, mutations };
}

/**
 * One delivery-path observation (ticket 58, register D-6).
 *
 * This is deliberately separate from `TodoItem.disposition`: an item has ONE
 * final disposition, but a single item can generate several events — a
 * re-dispatch supersedes one result and then a later one is delivered. Folding
 * both into one field would silently drop whichever came first, which is
 * exactly the "why did this never reach the user?" question D-6 exists to
 * answer. Events are in-memory only; the durable marker carries the budget,
 * not the log.
 */
export interface DeliveryEvent {
  readonly todoId: string | null;
  readonly workerId: string | null;
  readonly disposition: DeliveryDisposition;
  readonly reason: DeliveryReason;
  readonly atMs: number;
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
  /**
   * Redrive attempts already spent. Set when a durable marker is restored on
   * activation, so a restart continues the same budget (ticket 58).
   */
  readonly redriveAttempts?: number;
  /** External intake provenance (ticket 113); omit for ordinary items. */
  readonly external?: TodoExternalOrigin;
  readonly nowMs?: number;
}

/**
 * Stateful ledger the multitask core owns. Holds items and applies
 * reconcile mutations. Still no host I/O — pure bookkeeping.
 */
export interface TodoLedger {
  create(input: CreateTodoInput): TodoItem;
  /**
   * Advance the generated id sequence past an explicit id WITHOUT creating a
   * row (ticket 198). Restart recovery is parent-scoped, so the surviving
   * markers of a sibling that has not been rebuilt yet are the only durable
   * record of that sibling's todo ids; reserving them keeps the next
   * generated `todo-N` from stealing one. Non-`todo-N` ids cannot collide
   * with the generated form and are ignored.
   */
  reserveId(todoId: string): void;
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
   * completed = delivered to user. Sets delivered, flips status to
   * completed, and records the `delivered` disposition — the dispatcher
   * calls this only after a successful user send.
   */
  markDelivered(todoId: string, nowMs?: number): boolean;
  /**
   * Spend one redrive attempt (ticket 58, D-5). Returns the new count, or
   * -1 for an unknown / no-longer-open item.
   */
  recordRedrive(todoId: string, nowMs?: number): number;
  /**
   * Close the obligation with a disposition and reason (ticket 58, D-6).
   * Returns false when the item is unknown or already closed.
   */
  recordDisposition(
    todoId: string,
    disposition: DeliveryDisposition,
    reason: DeliveryReason,
    nowMs?: number,
  ): boolean;
  /**
   * Escalate to the terminal `lost` state (ticket 58, D-5): the result will
   * never reach the user and we have stopped trying. Records a `dropped`
   * disposition with the reason so the loss stays explicable.
   */
  markLost(todoId: string, reason: DeliveryReason, nowMs?: number): boolean;
  /** Close as cancelled (aborted stream). */
  markCancelled(todoId: string, nowMs?: number): boolean;
  /**
   * Append a delivery-path observation (ticket 58, D-6). Never throws, never
   * pruned by retention — telemetry outlives the item it describes.
   */
  recordDeliveryEvent(
    event: Omit<DeliveryEvent, "atMs">,
    nowMs?: number,
  ): DeliveryEvent;
  /** Delivery-path observations, oldest first (ticket 58, D-6). */
  listDeliveryEvents(): readonly DeliveryEvent[];
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
  const deliveryEvents: DeliveryEvent[] = [];
  let nextId = 1;

  function logEvent(
    todoId: string,
    workerId: string | null,
    disposition: DeliveryDisposition,
    reason: DeliveryReason,
    atMs: number,
  ): DeliveryEvent {
    const event: DeliveryEvent = {
      todoId,
      workerId,
      disposition,
      reason,
      atMs,
    };
    deliveryEvents.push(event);
    return event;
  }

  function replace(todo: TodoItem): TodoItem {
    items.set(todo.id, todo);
    return todo;
  }

  /**
   * Ticket 151 + 198: an explicit id must advance the generated sequence past
   * itself. Ticket 198 additionally uses this WITHOUT a row for ids a
   * not-yet-rebuilt sibling's durable marker still owns, so a later
   * generated `todo-N` cannot alias them.
   */
  function reserveId(todoId: string): void {
    const generated = /^todo-(\d+)$/.exec(todoId);
    if (generated !== null) {
      nextId = Math.max(nextId, Number(generated[1]) + 1);
    }
  }

  return {
    create(input: CreateTodoInput): TodoItem {
      const at = input.nowMs ?? now();
      // Ticket 151 (review blocker): an explicit id — restore passes the
      // marker's id, tests hand-create `todo-N` — must advance the generated
      // sequence past it. Otherwise a restored `todo-1` leaves nextId at 1
      // and the next generated create throws "todo already exists", killing
      // every auto-created spawn after a restart.
      if (input.id !== undefined) reserveId(input.id);
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
        redriveAttempts: input.redriveAttempts ?? 0,
        disposition: null,
        dispositionReason: null,
        external: input.external ?? null,
        createdAtMs: at,
        updatedAtMs: at,
      });
    },

    reserveId,

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
      const at = nowMs ?? now();
      replace({
        ...todo,
        delivered: true,
        status: "completed",
        disposition: "delivered",
        dispositionReason: "delivered-to-user",
        updatedAtMs: at,
      });
      logEvent(todoId, todo.workerId, "delivered", "delivered-to-user", at);
      return true;
    },

    recordRedrive(todoId: string, nowMs?: number): number {
      const todo = items.get(todoId);
      if (todo === undefined || todo.delivered || todo.status === "cancelled") {
        return -1;
      }
      const attempts = todo.redriveAttempts + 1;
      replace({ ...todo, redriveAttempts: attempts, updatedAtMs: nowMs ?? now() });
      return attempts;
    },

    recordDisposition(
      todoId: string,
      disposition: DeliveryDisposition,
      reason: DeliveryReason,
      nowMs?: number,
    ): boolean {
      const todo = items.get(todoId);
      if (todo === undefined) return false;
      const at = nowMs ?? now();
      // The event log is unconditional — this is the telemetry path, and it
      // must record even when the item's summary slot is already taken.
      logEvent(todoId, todo.workerId, disposition, reason, at);
      // The item's own disposition is final: the first close wins, so the
      // summary cannot be rewritten by a later, weaker observation.
      if (todo.disposition !== null) return false;
      replace({
        ...todo,
        disposition,
        dispositionReason: reason,
        updatedAtMs: at,
      });
      return true;
    },

    markLost(todoId: string, reason: DeliveryReason, nowMs?: number): boolean {
      const todo = items.get(todoId);
      if (todo === undefined || todo.status === "cancelled") return false;
      if (todo.status === "lost") return false;
      const at = nowMs ?? now();
      replace({
        ...todo,
        status: "lost",
        disposition: todo.disposition ?? "dropped",
        dispositionReason: todo.dispositionReason ?? reason,
        updatedAtMs: at,
      });
      logEvent(todoId, todo.workerId, "dropped", reason, at);
      return true;
    },

    markCancelled(todoId: string, nowMs?: number): boolean {
      const todo = items.get(todoId);
      if (todo === undefined || todo.status === "cancelled") return false;
      const at = nowMs ?? now();
      // An aborted stream owes nothing, so the item is closed rather than
      // owing a delivery. The disposition is still recorded: "nothing was
      // owed" and "we gave up" must not look the same in the telemetry.
      replace({
        ...todo,
        status: "cancelled",
        disposition: todo.disposition ?? "dropped",
        dispositionReason: todo.dispositionReason ?? "worker-aborted",
        updatedAtMs: at,
      });
      logEvent(todoId, todo.workerId, "dropped", "worker-aborted", at);
      return true;
    },

    recordDeliveryEvent(
      event: Omit<DeliveryEvent, "atMs">,
      nowMs?: number,
    ): DeliveryEvent {
      return logEvent(
        event.todoId ?? "",
        event.workerId,
        event.disposition,
        event.reason,
        nowMs ?? now(),
      );
    },

    listDeliveryEvents(): readonly DeliveryEvent[] {
      return [...deliveryEvents];
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
              disposition: todo.disposition ?? "delivered",
              dispositionReason: todo.dispositionReason ?? "delivered-to-user",
              updatedAtMs: at,
            });
            logEvent(
              todo.id,
              todo.workerId,
              "delivered",
              "delivered-to-user",
              at,
            );
            break;
          }
          case "record-redrive": {
            const todo = items.get(mutation.todoId);
            if (todo === undefined) break;
            replace({
              ...todo,
              redriveAttempts: mutation.attempts,
              updatedAtMs: at,
            });
            break;
          }
          case "record-disposition": {
            const todo = items.get(mutation.todoId);
            if (todo === undefined) break;
            logEvent(
              todo.id,
              todo.workerId,
              mutation.disposition,
              mutation.reason,
              at,
            );
            // Final once set: the item's summary is not rewritten by later passes.
            if (todo.disposition !== null) break;
            replace({
              ...todo,
              disposition: mutation.disposition,
              dispositionReason: mutation.reason,
              updatedAtMs: at,
            });
            break;
          }
          case "record-delivery-event": {
            logEvent(
              mutation.todoId ?? "",
              mutation.workerId,
              mutation.disposition,
              mutation.reason,
              at,
            );
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
