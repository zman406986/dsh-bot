/**
 * Single-slot, last-wins steer queue (in-memory).
 * One parked message per worker id; a new park replaces any undelivered steer.
 * Steer tickets are deliberately non-durable (ADR-0006).
 */
export interface SteerQueue {
  /** Park `message` for `workerId`, replacing any undelivered steer. */
  park(workerId: string, message: string): void;
  /** Pop the parked steer, or `undefined` when the slot is empty. Never throws. */
  pop(workerId: string): string | undefined;
  /** Drop any parked steer for `workerId` (e.g. on stop). */
  clear(workerId: string): void;
  /** Read the parked steer without removing it. */
  peek(workerId: string): string | undefined;
}

export function createSteerQueue(): SteerQueue {
  const slots = new Map<string, string>();

  return {
    park(workerId: string, message: string): void {
      slots.set(workerId, message);
    },

    pop(workerId: string): string | undefined {
      const message = slots.get(workerId);
      if (message !== undefined) {
        slots.delete(workerId);
      }
      return message;
    },

    clear(workerId: string): void {
      slots.delete(workerId);
    },

    peek(workerId: string): string | undefined {
      return slots.get(workerId);
    },
  };
}

/**
 * Wrap a steer in a short parent-correction note so the worker folds it in
 * and continues rather than restarting. New copy only.
 */
export function wrapParentCorrection(message: string): string {
  return [
    "[Parent correction]",
    "The following message is a correction from your parent.",
    "Fold it into the work you have already done and continue from where you are — do not restart.",
    "",
    message,
  ].join("\n");
}
