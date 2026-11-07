/**
 * Worker report clamping for dispatcher context (new copy only).
 * Pure helpers — no host. Clamping protects the dispatcher turn (S1);
 * it is not a rewrite of what the user finally sees.
 */

/**
 * Max characters of the KEPT completed-report text in a wake notice.
 *
 * Ticket 63 / register A-7: the reference has **no** equivalent bound — it
 * substitutes only for empty/aborted/error settles, never truncates — so there
 * is nothing to imitate and the protective addition is kept, re-tuned from 2000.
 * The body is the bound that matters most: the wake notice is the dispatcher's
 * only source for the user's answer, so clamping too low silently destroys a
 * real deliverable mid-sentence.
 *
 * The bound applies to the report text itself. The truncation marker is
 * appended AFTER the kept prefix, so the rendered notice can exceed this value
 * by the marker's length (which carries the shown/total counts and an optional
 * transcript pointer). The prefix is never shortened to make room for it.
 */
export const REPORT_CLAMP_CHARS = 4000;

/** Max characters of an error message body. Re-tuned from 800 (ticket 63 / A-7). */
export const ERROR_CLAMP_CHARS = 1200;

/** Max characters of a check-row activity line. Re-tuned from 120 (ticket 63 / A-7). */
export const CHECK_ACTIVITY_CHARS = 200;

/**
 * Max characters of the roster snapshot's recent-result excerpt (ticket 41).
 * Re-tuned from 200 (ticket 63 / A-7). The bound applies to the WHOLE kept
 * string — the truncation ellipsis included — so the wire field and its
 * defensive parse agree on `text.length <= RECENT_RESULT_EXCERPT_CHARS`
 * exactly.
 */
export const RECENT_RESULT_EXCERPT_CHARS = 300;

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

/**
 * The worker-report normalizer's sentinel for an error settle with no text
 * (`src/worker/report.ts`). The adapter normalizes before wake composition, so
 * the sentinel can arrive here as ordinary-looking report text; it carries no
 * failure detail and must be phrased as absent text, not echoed as a message.
 */
const EMPTY_ERROR_MARKER = "worker failed with no message";

/**
 * Status-aware substitute for an error settle that carried no message text.
 * Spelled out as a sentence because it stands alone in the wake notice; the
 * transcript pointer is included only when the caller actually has one.
 */
export function emptyErrorReportBody(
  transcriptRef: string | null = null,
): string {
  const pointer =
    transcriptRef !== null && transcriptRef.length > 0
      ? ` Full transcript: ${transcriptRef}`
      : "";
  return `Worker failed. No error message was recorded.${pointer}`;
}

/** Clamp an error message body. Empty → an honest no-message note. */
export function clampError(
  raw: string | null | undefined,
  options?: { limit?: number },
): string {
  const limit = options?.limit ?? ERROR_CLAMP_CHARS;
  const text = (raw ?? "").trim();
  if (text.length === 0) return "No error message was recorded.";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…\n[error truncated: ${limit} of ${text.length} characters.]`;
}

/**
 * Full wake-context body for one settled worker, by status.
 *
 * Status-aware on purpose: an error settle with no text must say that no error
 * message was recorded (and point at the transcript only when one exists), not
 * reuse the completed-report placeholder or the bare clamp fallback.
 *
 * Aborted is status-aware too: the placeholder is right only when there is no
 * stored text (empty, or the completed-report placeholder a normalized empty
 * settle carries). An aborted worker that DID produce findings keeps them,
 * labelled as partial — discarding them throws away the only answer the
 * dispatcher can report. The label prevents partial work from reading as a
 * completed deliverable.
 */
export function formatWakeReportBody(
  status: "completed" | "error" | "aborted",
  report: string | null | undefined,
  transcriptRef: string | null = null,
): string {
  if (status === "aborted") {
    const text = (report ?? "").trim();
    if (
      text.length === 0 ||
      text === emptyReportPlaceholder() ||
      text === abortedReportBody()
    ) {
      return abortedReportBody();
    }
    return `Worker stopped before completion. Partial report:\n${clampReport(text, { transcriptRef })}`;
  }
  if (status === "error") {
    const text = (report ?? "").trim();
    if (
      text.length === 0 ||
      text === emptyReportPlaceholder() ||
      text === EMPTY_ERROR_MARKER
    ) {
      return emptyErrorReportBody(transcriptRef);
    }
    return `Worker failed:\n${clampError(text)}`;
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
