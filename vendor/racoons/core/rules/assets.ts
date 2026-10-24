/**
 * The renderers and the re-export surface for the model-facing copy.
 *
 * The copy itself — the marker and receipt templates, the inventory and the two
 * shipped system prompts — lives in `./assets-templates.ts`; every name it
 * exports is re-exported here, so `rules/assets.js` stays the one import site
 * for callers and for `index.ts`.
 */

import type { LineRange, RecallId } from "../types/identity.js";
import type { PathEvidence } from "../types/transcript.js";
import { NONE_MATCHED } from "./assets-templates.js";

export {
  MODEL_FACING_STRINGS, PRUNE_ASK_SYSTEM_PROMPT, RECALL_TOOL_DESCRIPTION,
  VERDICT_JUDGE_SYSTEM_PROMPT,
} from "./assets-templates.js";

interface CapMarkerInput {
  readonly shownLines: LineRange;
  readonly totalLines: number;
  readonly omittedKb: number;
  readonly recallId: RecallId;
}

export function capMarker({
  shownLines,
  totalLines,
  omittedKb,
  recallId,
}: CapMarkerInput): string {
  return `[Capped: showing ${shownLines.startLine}–${shownLines.endLineInclusive} of ${totalLines} lines · ${omittedKb.toFixed(1)} kB omitted · recall ${recallId}]`;
}

interface NegativeFactInput {
  readonly target: string;
  readonly entries: readonly PathEvidence[];
  // Callers may supply the sentence explicitly; the PRD copy is the default.
  readonly noneMatched?: string;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/gu, " ");
}

export { oneLine };

export function negativeFact({
  target,
  entries,
  noneMatched = NONE_MATCHED,
}: NegativeFactInput): string {
  const label = oneLine(target);
  const sentence = oneLine(noneMatched);
  const misses = entries.filter((entry) => entry.outcome === "miss");
  if (misses.length === 0) return `[search: ${label}] ${sentence}`;

  const paths = misses.map((entry) => {
    const segments = [oneLine(entry.displayPath)];
    if (entry.title !== null && entry.title.length > 0) segments.push(oneLine(entry.title));
    if (entry.lineCount !== null) segments.push(`${entry.lineCount} lines`);
    if (entry.byteLength !== null) segments.push(`${entry.byteLength} bytes`);
    return segments.join(" · ");
  });
  return `[search: ${label}] not found in: ${paths.join(", ")}\n${sentence}`;
}

interface SpanMarkerInput {
  readonly shownLines: LineRange;
  readonly totalLines: number;
  readonly path: string;
  readonly recallId: RecallId;
}

export function spanMarker({
  shownLines,
  totalLines,
  path,
  recallId,
}: SpanMarkerInput): string {
  return `[Showing lines ${shownLines.startLine}–${shownLines.endLineInclusive} of ${totalLines} in ${path}. Full content restorable via recall ${recallId}.]`;
}

interface ReceiptLineInput {
  readonly path: string;
  /** Empty means the whole node is not retained: no range segment ships. */
  readonly ranges: readonly LineRange[];
  /** Absent or blank ships the floor line without a topic label. */
  readonly label: string | null;
  readonly recallId: RecallId;
}

/**
 * The programmatic line that replaces a forgotten unit (PRD §6.3). It states
 * only "not retained": unselected content is not condemned. Path and label are
 * collapsed to one line so a receipt can never grow extra lines.
 */
export function receiptLine({
  path,
  ranges,
  label,
  recallId,
}: ReceiptLineInput): string {
  const target = oneLine(path);
  // One <ranges> segment: `lines X–Y`, comma-joined when the spans are disjoint.
  const span = ranges.length === 0
    ? ""
    : ` lines ${ranges.map(range => `${range.startLine}–${range.endLineInclusive}`).join(", ")}`;
  const topic = label === null ? "" : oneLine(label).trim();
  const about = topic.length === 0 ? "" : ` — about: ${topic}`;
  return `[not retained] ${target}${span}${about} · recall ${recallId}`;
}
