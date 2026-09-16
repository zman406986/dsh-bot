/**
 * Worker settle-report normalization (new copy only).
 * Adapter maps host settle text through these helpers so every consumer
 * sees a consistent report. Core stays policy-free about wording.
 */

/** Substituted when a completed worker produced no text. */
export const EMPTY_WORKER_REPORT_PLACEHOLDER =
  "(no text output — the worker finished without a final answer)";

/** Used when an error settle carries no message. */
export const EMPTY_WORKER_ERROR_REPORT = "worker failed with no message";

/**
 * Trim; empty/whitespace-only → placeholder; non-empty → trimmed text.
 */
export function normalizeWorkerReport(raw: string | undefined | null): string {
  if (raw === undefined || raw === null) return EMPTY_WORKER_REPORT_PLACEHOLDER;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return EMPTY_WORKER_REPORT_PLACEHOLDER;
  return trimmed;
}

/**
 * Error outcomes: pass the error message; never replace with the empty placeholder.
 */
export function normalizeWorkerErrorReport(
  message: string | undefined | null,
): string {
  if (message === undefined || message === null) return EMPTY_WORKER_ERROR_REPORT;
  const trimmed = message.trim();
  if (trimmed.length === 0) return EMPTY_WORKER_ERROR_REPORT;
  return trimmed;
}
