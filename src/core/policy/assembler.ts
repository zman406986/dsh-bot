/**
 * Pure policy assemblers for the dispatcher (new copy only).
 * Feature flag is read once at dispatcher-session start (ADR-0005):
 * flag OFF → empty session policy; tools are not registered.
 * Tests assert structure/order, not prose quality.
 */

import { formatWakeReportBody } from "../report-clamp.js";
import type { TodoItem } from "../todo-reconciler.js";
import type { TerminalWorkerStatus } from "../types.js";
import type { SettledWorkerNotice } from "../wake-bus.js";
import {
  buildDispatcherPolicySection,
  buildStandingRulesBlock,
  buildWakeInstructionsBlock,
  EMPTY_LEDGER_LINE,
} from "./prompts.js";

/**
 * One settled worker carried into a wake turn.
 * `transcriptRef` may be null when the host has not recorded one.
 */
export interface WakeNotice {
  readonly workerId: string;
  readonly title: string;
  readonly status: TerminalWorkerStatus;
  readonly report: string;
  readonly transcriptRef: string | null;
}

/** Session policy section. Empty string when the flag is OFF. */
export function assembleSessionPolicy(enabled: boolean): string {
  if (!enabled) return "";
  return buildDispatcherPolicySection();
}

/** Render one ledger line for the per-turn reminder. */
export function formatLedgerLine(todo: TodoItem): string {
  return `- ${todo.id} · ${todo.status} · ${todo.title}`;
}

/**
 * Per-turn reminder: ledger + standing rules.
 * Empty ledger still injects the rules; ledger line becomes `(empty)`.
 */
export function assembleTurnReminder(todos: readonly TodoItem[]): string {
  const ledgerLines =
    todos.length === 0
      ? [`- ${EMPTY_LEDGER_LINE}`]
      : todos.map(formatLedgerLine);
  return [
    "## Ledger",
    ...ledgerLines,
    "",
    buildStandingRulesBlock(),
  ].join("\n");
}

/** Map a settle notice onto the wake-notice shape. */
export function noticeFromSettled(
  notice: SettledWorkerNotice,
  transcriptRef: string | null = null,
): WakeNotice {
  return {
    workerId: notice.workerId,
    title: notice.title,
    status: notice.status,
    report: notice.resultText,
    transcriptRef,
  };
}

/**
 * Wake-turn instructions for worker-settled hidden turns.
 * Silence is a valid outcome (stale / duplicate / irrelevant).
 */
export function assembleWakeTurn(notices: readonly WakeNotice[]): string {
  const sections: string[] = [
    "# Background work landed",
    "",
    "One or more of your workers has finished. Details are below.",
    "",
    "## Settled workers",
  ];

  if (notices.length === 0) {
    sections.push("(none)");
  } else {
    for (const notice of notices) {
      sections.push("");
      sections.push(`### ${notice.title} — ${notice.status}`);
      sections.push(`Worker: ${notice.workerId}`);
      sections.push(
        notice.transcriptRef !== null
          ? `Transcript: ${notice.transcriptRef}`
          : "Transcript: (none)",
      );
      sections.push("");
      sections.push(
        formatWakeReportBody(notice.status, notice.report, notice.transcriptRef),
      );
    }
  }

  sections.push("");
  sections.push(buildWakeInstructionsBlock());
  return sections.join("\n");
}
