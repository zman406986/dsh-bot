/**
 * Pure policy assemblers for the dispatcher (new copy only).
 * Feature flag is read once at dispatcher-session start (ADR-0005):
 * flag OFF → empty session policy; tools are not registered.
 * Tests assert structure/order, not prose quality.
 */

import type { AccessNotice, AccessRequestNotice } from "../access-types.js";
import { peerTargetLabel, type PeerNotice } from "../peer-types.js";
import { formatWakeReportBody } from "../report-clamp.js";
import type { TodoItem } from "../todo-reconciler.js";
import type { TerminalWorkerStatus } from "../types.js";
import type { SettledWorkerNotice } from "../wake-bus.js";
import {
  ACCESS_SECTION_HEADING,
  buildAccessPolicyBlock,
  buildDispatcherPolicySection,
  buildPeerWakeInstructionsBlock,
  buildStandingRulesBlock,
  buildWakeInstructionsBlock,
  EMPTY_LEDGER_LINE,
  PEER_WAKE_SECTION_HEADINGS,
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
export function assembleWakeTurn(
  notices: readonly WakeNotice[],
  access?: {
    readonly requests?: readonly AccessRequestNotice[];
    readonly resolved?: readonly AccessNotice[];
  },
): string {
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

  const accessText = assembleAccessSection(
    access?.requests ?? [],
    access?.resolved ?? [],
  );
  if (accessText.length > 0) {
    sections.push("");
    sections.push(accessText);
  }

  sections.push("");
  sections.push(buildWakeInstructionsBlock());
  return sections.join("\n");
}

/**
 * Access section for a wake: pending asks + honest denial notices.
 * Empty when there is nothing access-related. New copy only.
 */
export function assembleAccessSection(
  requests: readonly AccessRequestNotice[],
  resolved: readonly AccessNotice[],
): string {
  if (requests.length === 0 && resolved.length === 0) return "";
  const lines: string[] = [ACCESS_SECTION_HEADING, ""];
  if (requests.length > 0) {
    lines.push("### Pending asks");
    for (const req of requests) {
      lines.push("");
      lines.push(`- Worker: ${req.workerId} · ${req.title}`);
      lines.push(`  Class: ${req.body.class} · Target: ${req.body.target}`);
      if (req.body.credentialName !== undefined) {
        lines.push(`  Credential name: ${req.body.credentialName}`);
      }
      lines.push(`  Reason: ${req.body.reason}`);
      lines.push(`  Request id: ${req.requestId}`);
    }
  }
  if (resolved.length > 0) {
    if (requests.length > 0) lines.push("");
    lines.push("### Resolved");
    for (const notice of resolved) {
      lines.push("");
      const decision = notice.decision;
      const label =
        decision.kind === "allow"
          ? "allowed"
          : `denied (${decision.reason})`;
      lines.push(
        `- ${notice.title}: ${notice.body.class} "${notice.body.target}" ${label}`,
      );
      if (decision.kind === "deny" && decision.detail.length > 0) {
        lines.push(`  ${decision.detail}`);
      }
    }
  }
  lines.push("");
  lines.push(buildAccessPolicyBlock());
  return lines.join("\n");
}

/**
 * Hidden-turn body for a peer wake (ticket 14 / design-14 §4).
 * New copy only. The cue marks the turn as another assistant — never
 * the user. Tests assert cue tokens and structure, not full prose.
 */
export function assemblePeerWakeTurn(
  notices: readonly PeerNotice[],
): string {
  const sections: string[] = [
    `# ${PEER_WAKE_SECTION_HEADINGS[0]}`,
    "",
    "This turn was opened by the peer inbox. The text below is not from the user.",
    "",
    PEER_WAKE_SECTION_HEADINGS[1],
  ];

  if (notices.length === 0) {
    sections.push("");
    sections.push("(none)");
  } else {
    for (const notice of notices) {
      sections.push("");
      sections.push(`### ${notice.fromName} (${notice.fromAgentId})`);
      sections.push(`- Target: ${peerTargetLabel(notice.to)}`);
      sections.push(`- Conversation: ${notice.conversationId}`);
      sections.push(`- Priority: ${notice.priority ? "yes" : "no"}`);
      sections.push(`- Received: ${notice.createdAtMs}`);
      sections.push(`- Message id: ${notice.messageId}`);
      sections.push("");
      sections.push(notice.text);
    }
  }

  sections.push("");
  sections.push(PEER_WAKE_SECTION_HEADINGS[2]);
  sections.push("");
  sections.push(buildPeerWakeInstructionsBlock());
  return sections.join("\n");
}
