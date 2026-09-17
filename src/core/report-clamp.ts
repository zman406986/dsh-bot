/**
 * Worker report clamping for dispatcher context (new copy only).
 * Pure helpers — no host. Clamping protects the dispatcher turn (S1);
 * it is not a rewrite of what the user finally sees.
 */

/** Max characters of a completed worker report body in a wake notice. */
export const REPORT_CLAMP_CHARS = 2000;

/** Max characters of an error message body. */
export const ERROR_CLAMP_CHARS = 800;

/** Max characters of a check-row activity line. */
export const CHECK_ACTIVITY_CHARS = 120;

/**
 * Max characters of the roster snapshot's recent-result excerpt (ticket 41).
 * The bound applies to the WHOLE kept string — the truncation ellipsis
 * included — so the wire field and its defensive parse agree on
 * `text.length <= RECENT_RESULT_EXCERPT_CHARS` exactly.
 */
export const RECENT_RESULT_EXCERPT_CHARS = 200;

/** Check roster rows before head/tail fold. */
export const TOOL_RESULT_SUMMARY_MAX_ROWS = 20;

/** Substituted when a completed worker produced no text. */
export function emptyReportPlaceholder(): string {
  return "(The worker finished but produced no text output. See the transcript for details.)";
}

/** Body used when an aborted worker is ever shown for bookkeeping. */
export function abortedReportBody(): string {
  return "(Stopped before completion. No report.)";
}

/** Truncation marker appended after a hard clamp. */
export function truncationMarker(shown: number, total: number, transcriptRef: string | null): string {
  const pointer =
    transcriptRef !== null && transcriptRef.length > 0
      ? ` Full transcript: ${transcriptRef}`
      : "";
  return `…\n[report truncated: ${shown} of ${total} characters.${pointer}]`;
}

/**
 * Hard character cut. Never strips paths/URLs inside the kept prefix.
 * Empty/whitespace-only → placeholder.
 */
export function clampReport(
  raw: string | null | undefined,
  options?: {
    limit?: number;
    transcriptRef?: string | null;
  },
): string {
  const limit = options?.limit ?? REPORT_CLAMP_CHARS;
  const transcriptRef = options?.transcriptRef ?? null;
  const text = (raw ?? "").trim();
  if (text.length === 0) return emptyReportPlaceholder();
  if (text.length <= limit) return text;
  const kept = text.slice(0, limit);
  return `${kept}${truncationMarker(limit, text.length, transcriptRef)}`;
}

/** Clamp an error message body. Empty → a minimal error note. */
export function clampError(
  raw: string | null | undefined,
  options?: { limit?: number },
): string {
  const limit = options?.limit ?? ERROR_CLAMP_CHARS;
  const text = (raw ?? "").trim();
  if (text.length === 0) return "worker failed with no message";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…\n[error truncated: ${limit} of ${text.length} characters.]`;
}

/**
 * Full wake-context body for one settled worker, by status.
 * Aborted → no report body (bookkeeping only).
 */
export function formatWakeReportBody(
  status: "completed" | "error" | "aborted",
  report: string | null | undefined,
  transcriptRef: string | null = null,
): string {
  if (status === "aborted") return abortedReportBody();
  if (status === "error") {
    return `Worker failed:\n${clampError(report)}`;
  }
  return clampReport(report, { transcriptRef });
}

/** Clamp a check-row activity line. Null/empty stays null. */
export function clampActivity(
  raw: string | null | undefined,
  limit: number = CHECK_ACTIVITY_CHARS,
): string | null {
  if (raw === undefined || raw === null) return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

/**
 * Clamp a settle report down to the roster's recent-result excerpt bound
 * (ticket 41). Null/empty → null (the snapshot carries no excerpt rather
 * than an invented one); over-limit → a hard cut whose TOTAL length —
 * ellipsis included — never exceeds the bound, so the defensive parse and
 * this clamp share one exact rule.
 */
export function clampRecentResultExcerpt(
  raw: string | null | undefined,
  limit: number = RECENT_RESULT_EXCERPT_CHARS,
): string | null {
  if (raw === undefined || raw === null) return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}
