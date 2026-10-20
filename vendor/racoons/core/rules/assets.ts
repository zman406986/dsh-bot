import type { LineRange, RecallId } from "../types/identity.js";
import type { PathEvidence } from "../types/transcript.js";

const CAP_MARKER_TEMPLATE =
  "[Capped: showing <a>–<b> of <N> lines · <M> kB omitted · recall <id>]";
const NEGATIVE_FACT_TEMPLATE =
  "[search: <target>] not found in: <path> · <title or first heading> · <lines> · <size>, …";
const NONE_MATCHED =
  "No match in these files for this target. Do not re-read them.";
const EMPTY_NEGATIVE_FACT_TEMPLATE = `[search: <target>] ${NONE_MATCHED}`;
const SPAN_MARKER_TEMPLATE =
  "[Showing lines X–Y of N in <path>. Full content restorable via recall id.]";

export const RECALL_TOOL_DESCRIPTION =
  "restores the exact original bytes of a sealed record by id.";

export const MODEL_FACING_STRINGS: readonly string[] = [
  CAP_MARKER_TEMPLATE,
  NEGATIVE_FACT_TEMPLATE,
  NONE_MATCHED,
  EMPTY_NEGATIVE_FACT_TEMPLATE,
  SPAN_MARKER_TEMPLATE,
  RECALL_TOOL_DESCRIPTION,
  " lines",
  " bytes",
];

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
