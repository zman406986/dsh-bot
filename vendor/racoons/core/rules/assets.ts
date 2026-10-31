/**
 * The renderers and the re-export surface for the model-facing copy.
 *
 * The copy itself — the marker and receipt templates, the inventory, the entry
 * ask's blocks and the shipped prompts — lives in `./assets-templates.ts`;
 * every name it exports is re-exported here, so `rules/assets.js` stays the one
 * import site for callers and for `index.ts`.
 */

import type { LineRange, RecallId } from "../types/identity.js";
import type { PathEvidence } from "../types/transcript.js";
import {
  ENTRY_ASK_CLOSING_LINE, ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT, ENTRY_ASK_SYSTEM_PROMPT,
  ENTRY_ASK_TWOFORM_SYSTEM_PROMPT,
  NONE_MATCHED, SHAPE_MARKER_EMPTY_TEMPLATE, SHAPE_MARKER_TEMPLATE,
} from "./assets-templates.js";

export {
  ENTRY_ASK_CLOSING_LINE, ENTRY_ASK_END_ANCHOR, ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT,
  ENTRY_ASK_FRAME, ENTRY_ASK_RESULT_CLOSE, ENTRY_ASK_RESULT_OPEN, ENTRY_ASK_SYSTEM_PROMPT,
  ENTRY_ASK_TWOFORM_SYSTEM_PROMPT,
  MODEL_FACING_STRINGS, PRUNE_ASK_SYSTEM_PROMPT, RECALL_TOOL_DESCRIPTION,
  SHAPE_MARKER_EMPTY_TEMPLATE, SHAPE_MARKER_TEMPLATE,
} from "./assets-templates.js";

/**
 * The facts one entry-shaping marker line names (ISSUE-056 chunk C2, design §1
 * "Marker text"). `keptLines` carries the whole-line spans that landed, in
 * ascending order; an empty list is the floor line, the `forgetall` answer that
 * kept no line. `droppedBytes` is the complement's byte count — the one number
 * that is true for every answer form, so the marker states it rather than a
 * count that only one answer form can supply.
 */
interface ShapeMarkerInput {
  readonly keptLines: readonly LineRange[];
  readonly totalLines: number;
  readonly droppedBytes: number;
  readonly recallId: RecallId;
}

/**
 * The marker the shaped entry splices in where the dropped bytes were: what was
 * kept, what left, and the id that restores it. Stated facts only, one line, no
 * size-rule vocabulary. The dropped bytes are banked before this line is
 * rendered, so the id in it is already restorable.
 *
 * The bytes are the pinned template with its four slots filled, never a second
 * literal: the inventory string and the rendered line cannot drift apart.
 */
export function shapeMarker({
  keptLines,
  totalLines,
  droppedBytes,
  recallId,
}: ShapeMarkerInput): string {
  if (keptLines.length === 0) {
    return SHAPE_MARKER_EMPTY_TEMPLATE
      .replace("<N>", String(totalLines))
      .replace("<id>", recallId);
  }
  const ranges = keptLines
    .map(range => `${String(range.startLine)}–${String(range.endLineInclusive)}`)
    .join(", ");
  return SHAPE_MARKER_TEMPLATE
    .replace("<ranges>", ranges)
    .replace("<N>", String(totalLines))
    .replace("<B>", String(droppedBytes))
    .replace("<id>", recallId);
}

/**
 * The facts one entry ask states: the total line count and the quote lines.
 */
export interface EntryAskInput {
  /** The landed result's total line count `N`. */
  readonly lineCount: number;
  /**
   * The quote lines, already rendered by the anchor subsystem (`line L ends with
   * "xxx"` for the entry seam since 2026-10-28: the total is stated once in the
   * range sentence, not on every quote), in ascending line order. Empty when `N`
   * produced no anchor. This function does not derive them and holds no result
   * bytes.
   */
  readonly anchorLines: readonly string[];
  /**
   * Which contract the ask states (ISSUE-061 T-8; ADR-0027 §4). Absent or
   * `'default'` is the shipped `keeplines` contract, byte for byte;
   * `'forgetlines'` is lane F's one-partial-class variant; `'twoform'` is the
   * experiment's two-key contract (no `keepall`, `keeplines` covering every
   * line). The prompts differ only in their contract block and class lines; the
   * facts block and the closing line are shared, so the ask's shape and size are
   * the same on every arm. Any other value throws: a typo is never a silent
   * fallback to the shipped prompt.
   */
  readonly variant?: 'default' | 'forgetlines' | 'twoform';
}

/** The three contract variants `entryAskMessage` renders; anything else throws. */
const ENTRY_ASK_VARIANTS = ['default', 'forgetlines', 'twoform'] as const;

/**
 * One arm's contract: the static prompt, and the partial-class key its range
 * sentence names (the class the answer's ranges belong to on that arm).
 */
interface EntryAskContract {
  readonly prompt: string;
  readonly partialClass: string;
}

/** The three contracts, keyed by variant name. */
const ENTRY_ASK_CONTRACTS: ReadonlyMap<string, EntryAskContract> = new Map<
  string,
  EntryAskContract
>([
  ['default', { prompt: ENTRY_ASK_SYSTEM_PROMPT, partialClass: 'keeplines' }],
  ['forgetlines', { prompt: ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT, partialClass: 'forgetlines' }],
  ['twoform', { prompt: ENTRY_ASK_TWOFORM_SYSTEM_PROMPT, partialClass: 'keeplines' }],
]);

/**
 * The one resolver both renderers use. An unknown variant is a caller bug — a
 * JS caller, a rig config or a bench can name one — so it throws, naming the
 * value and the two arms this module has (critic blocker B1: never a silent
 * fallback to the shipped prompt).
 */
function contractFor(variant: string): EntryAskContract {
  const contract = ENTRY_ASK_CONTRACTS.get(variant);
  if (contract === undefined) {
    throw new Error(
      `entryAskMessage: unknown variant "${variant}"; use one of ${ENTRY_ASK_VARIANTS.join(', ')}`,
    );
  }
  return contract;
}

/**
 * The per-result lines of one ask: the range sentence naming `N` and the class
 * the ranges belong to, then one shortened quote per line. The sentence is the
 * ONE place `N` is stated, which is why the quotes carry no ` of N` (the anchor
 * subsystem renders the entry seam without it).
 *
 * Exported because the one correction turn restates this exact block: the retry
 * copies the first ask's facts through this function instead of re-deriving the
 * sentence, so the two cannot drift.
 */
export function entryAskFactsBlock(
  { lineCount, anchorLines, variant = 'default' }: EntryAskInput,
): string {
  const { partialClass } = contractFor(variant);
  return [
    `This result has ${String(lineCount)} lines, so ${partialClass} ranges sit in `
      + `[1,${String(lineCount)}]. Quotes to help you locate them:`,
    ...anchorLines,
  ].join("\n");
}

/**
 * The one user message an entry ask appends after the result has landed
 * (ISSUE-056 C2; body-free per ISSUE-058 chunk P2; copy rewritten 2026-10-28;
 * ADR-0022 §3). The static contract, then the per-result lines, then the
 * closing line. Nothing else.
 *
 * The per-result lines are `entryAskFactsBlock`: the range sentence naming `N`,
 * then one shortened quote per anchor. The quotes carry no ` of N` because the
 * sentence just stated it.
 *
 * It NEVER carries the result's body: the result already landed in the
 * conversation immediately above the ask, so copying its bytes into the
 * question would double the body on the wire and make the ask's size the
 * result's size (ADR-0022 §Context). The caller passes only facts about the
 * body — its line count and the quotes — so there is no parameter through which
 * the body could enter.
 *
 * The ask is near-constant in size: one base instruction plus one short quote
 * per ~100 lines (ADR-0022 §5). The range sentence and the quotes are one
 * block, then exactly one blank line, then the closing line; empty quotes ship
 * no line of their own, never a blank slot.
 *
 * `variant` picks the contract and nothing else (ISSUE-061 T-8; ADR-0027 §4):
 * unset is the shipped prompt, so every existing caller sends the same bytes it
 * sent before, and lane F's bench is the only caller that names the other arm.
 * An unknown variant throws, naming the value and the two it accepts: a typo is
 * never a silent fallback to the shipped prompt (critic blocker B1).
 *
 * Every refusal is the caller's (`C6a`): a failure to build or send the ask
 * leaves the landed result untouched (ADR-0022 §14).
 */
export function entryAskMessage(input: EntryAskInput): string {
  const { prompt } = contractFor(input.variant ?? 'default');
  return `${prompt}\n\n${entryAskFactsBlock(input)}\n\n${ENTRY_ASK_CLOSING_LINE}`;
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
