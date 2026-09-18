import type { RebuildReport } from "../core/durability.js";

/**
 * Restart-honesty conversational notice (ticket 31; design-17 §4.7, §7).
 *
 * After a host restart the in-memory registry is gone; the durable markers
 * (ADR-0006) are the only truth about pre-crash workers. On activation the
 * plugin rebuilds from markers and, when the rebuild report is not empty,
 * injects ONE honest notice into the activated chat so the dispatcher can
 * tell the user what was in flight before the crash:
 *
 * - unknown-state workers (live at crash time) are stated as UNKNOWN —
 *   never replayed, never resumed, never claimed done (ids + transcript
 *   pointers only), together with the fact that they still hold their stream
 *   keys and how to release one (ticket 59);
 * - restored terminal rows are stated plainly, with the expectation that
 *   anything landed-undelivered flushes on the next wake;
 * - an empty report emits nothing — silence when there is no story.
 *
 * Copy is new and clean-room (design-17 §7 drafts). Machinery vocabulary
 * (worker ids, transcripts) is fine here: the notice goes to the
 * dispatcher agent, which narrates for the user under the standing rules.
 */

/** Stable heading marker for the injected restart notice block. */
export const RESTART_NOTICE_HEADING = "## Restart";

/**
 * Degraded notice when the marker store itself could not be read
 * (rebuild failure). Activation still succeeds; the honest answer is
 * "nothing restored, nothing replayed" — never a fabricated roster.
 */
export const RESTART_DEGRADED_NOTICE =
  "Worker records from before the restart could not be read. " +
  "Nothing was restored and nothing was replayed.";

/**
 * One unknown-state line: count, ids, honest unknown wording, transcript refs,
 * and — since ticket 59 — the fact that their stream keys are **held**.
 *
 * The held-key half is not decoration. Without it the dispatcher knows a worker
 * is missing but not that re-dispatching its stream will be refused, so the
 * refusal would read as a bug rather than as the one-worker-per-stream
 * invariant working across a restart.
 */
export function restartUnknownStateLine(
  count: number,
  ids: readonly string[],
  refs: readonly string[],
  streamKeys: readonly string[],
): string {
  return (
    `Before the last restart, ${count} worker(s) were still running: ` +
    `${ids.join(", ")}. Their state is unknown — nothing was replayed. ` +
    `Transcripts: ${refs.join(", ")}. ` +
    `Stream(s) ${streamKeys.join(", ")} are held by them, so re-dispatching ` +
    `onto those streams is refused; call stop_worker on the worker id to ` +
    `release one once you know that worker is gone, or dispatch under a new ` +
    `stream key.`
  );
}

/** One restored line: count and the next-wake delivery expectation. */
export function restartRestoredLine(count: number): string {
  return (
    `Restored ${count} finished worker(s) from before the restart; ` +
    `anything undelivered will be reported on the next wake.`
  );
}

/**
 * Assemble the one-time restart notice from a rebuild report.
 * Returns `null` when the report is empty — no notice, ever, for an
 * uneventful activation. Unknown-state rows never appear on the roster
 * (core rule); this notice is their ONLY surface.
 */
export function assembleRestartNotice(
  report: RebuildReport,
): string | null {
  const lines: string[] = [];
  if (report.unknownState.length > 0) {
    // Transcript pointer falls back to the worker id at rebuild time; the
    // type still admits null, so fall back again rather than print "null".
    const refs = report.unknownState.map(
      (worker) => worker.transcriptRef ?? worker.workerId,
    );
    lines.push(
      restartUnknownStateLine(
        report.unknownState.length,
        report.unknownState.map((worker) => worker.workerId),
        refs,
        report.unknownState.map((worker) => worker.streamKey),
      ),
    );
  }
  if (report.restored.length > 0) {
    lines.push(restartRestoredLine(report.restored.length));
  }
  if (lines.length === 0) return null;
  return [RESTART_NOTICE_HEADING, ...lines].join("\n");
}
