import {
  isTerminalStatus,
  type TerminalWorkerStatus,
  type WorkerStatus,
} from "./types.js";

/**
 * Lifecycle events the worker FSM accepts.
 * Host settle and core-driven turn/steer notices share this vocabulary.
 */
export type WorkerEvent =
  | { readonly type: "turn-started" }
  | { readonly type: "steer-received" }
  | { readonly type: "steer-injected" }
  | { readonly type: "aborted" }
  | { readonly type: "settled"; readonly status: TerminalWorkerStatus };

/**
 * Pure worker lifecycle FSM (no host, no registry).
 *
 * Legal transitions (PRD worker FSM, plus abort/settle from any live state):
 *   spawned  --turn-started-->     running
 *   running  --steer-received-->   steering
 *   steering --steer-injected-->   running
 *   spawned|running|steering --settled--> completed | error | aborted
 *   spawned|running|steering --aborted--> aborted
 *
 * Terminal states accept nothing: no transition leaves a terminal state.
 */
export function canTransition(from: WorkerStatus, event: WorkerEvent): boolean {
  if (isTerminalStatus(from)) return false;
  switch (event.type) {
    case "turn-started":
      return from === "spawned";
    case "steer-received":
      return from === "running";
    case "steer-injected":
      return from === "steering";
    case "aborted":
    case "settled":
      // `from` is live (spawned | running | steering).
      return true;
  }
}

/**
 * Next status if the transition is legal; `null` when it is not
 * (including every event out of a terminal state).
 */
export function applyEvent(
  from: WorkerStatus,
  event: WorkerEvent,
): WorkerStatus | null {
  if (!canTransition(from, event)) return null;
  switch (event.type) {
    case "turn-started":
    case "steer-injected":
      return "running";
    case "steer-received":
      return "steering";
    case "aborted":
      return "aborted";
    case "settled":
      return event.status;
  }
}
