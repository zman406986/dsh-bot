/**
 * Per-session delta state for the per-turn ledger reminder.
 *
 * The reminder used to reprint every ledger row on every turn. In a long
 * dispatcher session most of those rows are unchanged, so the ledger becomes
 * repeated prose that the model has already read. This module keeps the one
 * piece of state needed to render a delta: the last-rendered signature for
 * each todo id, per dispatcher session.
 *
 * The store is process memory only. A restart starts from the full ledger,
 * which is the safe direction. One store is shared by all reminder call sites
 * (wake composer, step boundary, adapter middleware) so two sites inside the
 * same session cannot both believe they are rendering the first reminder.
 * Calls without a session key bypass the store entirely and keep the old
 * full-ledger behavior.
 */
import type { TodoItem } from "../todo-reconciler.js";

/** Last rendered row signatures for one session: todo id -> signature. */
export type ReminderDeltaSession = Map<string, string>;

/** In-memory delta store shared by every reminder call site. */
export interface ReminderDeltaStore {
  readonly sessions: Map<string, ReminderDeltaSession>;
}

/** Create an isolated store. Tests use this instead of the process-wide one. */
export function createReminderDeltaStore(): ReminderDeltaStore {
  return { sessions: new Map() };
}

/** Process-wide store used when a caller does not inject its own. */
export const sharedReminderDeltaStore = createReminderDeltaStore();

/**
 * Drop one session's delta state. Called from the dispatcher's session
 * teardown so a later activation of the same session id renders the full
 * ledger again instead of inheriting a previous activation's diff baseline.
 */
export function clearReminderDeltaSession(
  sessionId: string,
  store: ReminderDeltaStore = sharedReminderDeltaStore,
): void {
  store.sessions.delete(sessionId);
}

/**
 * The fields that make one row count as "changed" when any of them moves.
 * The todo id is the map key, so it is deliberately not repeated here.
 */
export function ledgerRowSignature(todo: TodoItem): string {
  return JSON.stringify([
    todo.status,
    todo.delivered,
    todo.redriveAttempts,
    todo.disposition,
    todo.dispositionReason,
    todo.title,
    todo.workerId,
  ]);
}

/** The previous reminder's row signatures for a session, if any. */
export function reminderSignaturesForSession(
  sessionId: string,
  store: ReminderDeltaStore = sharedReminderDeltaStore,
): ReadonlyMap<string, string> | undefined {
  return store.sessions.get(sessionId);
}

/** Record the rows rendered by the current reminder as the next baseline. */
export function rememberReminderSignatures(
  todos: readonly TodoItem[],
  sessionId: string,
  store: ReminderDeltaStore = sharedReminderDeltaStore,
): void {
  const signatures = new Map<string, string>();
  for (const todo of todos) {
    signatures.set(todo.id, ledgerRowSignature(todo));
  }
  store.sessions.set(sessionId, signatures);
}
