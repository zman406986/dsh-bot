/**
 * The model-facing copy of the core, as constants: the marker, receipt and
 * inventory strings, plus the two shipped system prompts.
 *
 * Pure data, no imports. `assets.ts` re-exports every name here, so callers keep
 * importing from `rules/assets.js`; the split exists only to keep each file
 * under the line cap.
 */

const CAP_MARKER_TEMPLATE =
  "[Capped: showing <a>–<b> of <N> lines · <M> kB omitted · recall <id>]";
const NEGATIVE_FACT_TEMPLATE =
  "[search: <target>] not found in: <path> · <title or first heading> · <lines> · <size>, …";
export const NONE_MATCHED =
  "No match in these files for this target. Do not re-read them.";
const EMPTY_NEGATIVE_FACT_TEMPLATE = `[search: <target>] ${NONE_MATCHED}`;
const SPAN_MARKER_TEMPLATE =
  "[Showing lines X–Y of N in <path>. Full content restorable via recall id.]";
// Receipts, one shape per forgetting verdict kind (ISSUE-017 §3). A `forgetall`
// receipt carries the answer's descriptor in the label slot; a `keeplines`
// receipt names the line ranges the answer gave up and carries no descriptor,
// so it ships the floor shape. Which template applies follows from whether a
// label exists, never from the caller claiming a verdict kind.
const RECEIPT_TEMPLATE =
  "[not retained] <path> <ranges> — about: <label> · recall <id>";
const RECEIPT_FLOOR_TEMPLATE =
  "[not retained] <path> <ranges> · recall <id>";

export const RECALL_TOOL_DESCRIPTION =
  "restores the exact original bytes of a sealed record by id.";

/**
 * The shipped system prompt for the verdict judge (ISSUE-021, v4.1; owner
 * ruling 6, 2026-10-23). This is the exact text the product sends with the
 * verdict LLM call; a full-simulation study imports it verbatim, so it is pinned
 * byte for byte by `test/assets.test.ts`.
 *
 * It is the whole static contract, so it is byte-identical across every call of
 * a run and cacheable for the entire run: the judged conversation is rendered
 * as production renders it (no line tags, no duplicated unit), the unit is the
 * last tool result, and one short decision line ends the user message. It
 * states the three v4.1 actions, the `[start,end]` notation, one compact worked
 * example, and the closed output shape: the action is the answer's only
 * top-level key, and the unit id and round are supplied by the caller.
 *
 * It asks for no `reason`: a keep has nothing to describe, and both forgetting
 * actions describe themselves in their summary.
 */
const VERDICT_JUDGE_PROMPT_LINES: readonly string[] = [
  "You judge what leaves a coding agent's context. Decide what stays of one tool result: the unit.",
  "",
  "The conversation you are given is the production conversation, rendered byte for byte: no line",
  "tags, no reformatting, no repeated copy. The unit is the LAST tool result in it. One short",
  'decision line ends the user message — "The last tool result above is the unit. Decide." — and',
  "that line is an instruction, not content to judge.",
  "",
  "Answer with exactly one JSON object and no prose outside it. Its only top-level key is the action:",
  "",
  '{"keepall":true}',
  '{"keeplines":[[2,3],"stale run notes: the superseded TODO and the old deploy host"]}',
  '{"forgetall":"a stale build log from the old host"}',
  "",
  "keepall keeps every line of the unit, and its value is the boolean true.",
  "keeplines keeps only the lines in the listed ranges and drops the rest. The array holds the ranges",
  "and, last, one summary of at most 25 words describing what is dropped.",
  "forgetall replaces the whole unit with its summary of at most 25 words; the summary is the value.",
  "",
  "A range is written [start,end]: 1-based, inclusive and relative to the unit's own lines, so [1,3]",
  "is the unit's first three lines. Name several ranges when the value sits apart; they need not be",
  "sorted or merged.",
  "",
  'Worked example. A five-line unit begins "# cache notes" and ends "deploy: rsync to the old host".',
  "Its second and third lines are the two useful commands; the last two are stale. Keep the commands:",
  '{"keeplines":[[2,3],"stale run notes: the superseded TODO and the old deploy host"]}',
  "",
  "Write exactly one key: the action itself. The unit id and the round are supplied for you and never",
  "appear in your answer. Any other key, any second object, and any prose outside the object make the",
  "answer invalid.",
];

/**
 * The prompt is exported joined rather than as one array literal: the purity
 * gate's import regex reads `from "` inside a multi-line `export` statement as a
 * bare package specifier, and the worked example contains that JSON key. The
 * declaration is private and the exported value is the same bytes.
 *
 * It is deliberately absent from `MODEL_FACING_STRINGS`: that inventory is the
 * receipt and marker copy, whose vocabulary test bans the word "summary", and
 * this prompt must name the field that the owner ruling kept.
 */
export const VERDICT_JUDGE_SYSTEM_PROMPT = VERDICT_JUDGE_PROMPT_LINES.join("\n");

/**
 * The shipped system prompt for the big prune's batched ask (ISSUE-022 chunk 3;
 * ADR-0009). One ask addresses every unit still in memory, so this contract
 * differs from the single-unit judge's in exactly one way: the answer is one
 * object keyed by the indices we assigned, not one verdict for the last result.
 *
 * Like `VERDICT_JUDGE_SYSTEM_PROMPT` it is byte-identical across every ask of a
 * run, so a provider can cache it for the run, and it is pinned byte for byte by
 * `test/assets.test.ts`. It is deliberately absent from `MODEL_FACING_STRINGS`:
 * that inventory is the receipt and marker copy, and this asset must name the
 * `summary` field the owner ruling kept.
 *
 * It states the table's row shape with one worked row, the index-as-address
 * rule, the three v4.1 actions, the `[start,end]` notation, and the closed
 * output shape `{"1":{"keepall":true},"2":{"forgetall":"…"}}` verbatim: the
 * model echoes indices and nothing else, and a refused unit keeps.
 */
const PRUNE_ASK_PROMPT_LINES: readonly string[] = [
  "You review what stays in a coding agent's context. Every tool result still in memory is put to",
  "you at once, each under an index we assigned. Nothing else is in the table: forgotten content",
  "is never asked.",
  "",
  "The user message is the production conversation, rendered byte for byte: no line tags, no",
  "reformatting, no repeated copy. After it comes one blank line, a table with one row per unit,",
  "and one instruction line. The table and that line are an instruction, not content to review.",
  "",
  '2. [Read] config.ts (call #2) — "…excerpt A…" … "…excerpt B…"',
  "",
  "A row begins with the index you answer with, then the call in brackets, then the target the",
  "call named when it named one. `call #2` says this is the second of identical calls, which is",
  "what tells two otherwise equal rows apart. The two quoted samples are verbatim bytes of that",
  "unit, drawn near its 30th and 70th percentile: they may span several lines and two rows may",
  "quote the same bytes. The index is the address. The samples only direct your attention.",
  "",
  "A row may instead read `anchor unavailable: <failure>`: the unit is still in memory but no bytes",
  "could be quoted for it. Judge it from the call alone, and keep it when in doubt.",
  "",
  "Answer with exactly one JSON object and no prose outside it. Each key is an index from the",
  "table and its value is that unit's verdict:",
  "",
  '{"keepall":true}',
  '{"keeplines":[[2,3],"stale run notes: the superseded TODO and the old deploy host"]}',
  '{"forgetall":"a stale build log from the old host"}',
  "",
  'For two units the whole answer has two keys: {"1":{"keepall":true},"2":{"forgetall":"…"}}',
  "",
  "keepall keeps every line of that unit, and its value is the boolean true.",
  "keeplines keeps only the lines in the listed ranges and drops the rest. The array holds the",
  "ranges and, last, one summary of at most 25 words describing what is dropped.",
  "forgetall replaces the whole unit with its summary of at most 25 words; the summary is the value.",
  "",
  "A range is written [start,end]: 1-based, inclusive and relative to that unit's own lines, so",
  "[1,3] is its first three lines. Ranges need not be sorted or merged, and a range never refers",
  "to another row.",
  "",
  "Answer every index exactly once. An index you leave out, a key we did not assign and a repeated",
  "key are all refused, and a refused unit is kept.",
];

/** Joined for the same purity-gate reason as the judge prompt above. */
export const PRUNE_ASK_SYSTEM_PROMPT = PRUNE_ASK_PROMPT_LINES.join("\n");

export const MODEL_FACING_STRINGS: readonly string[] = [
  CAP_MARKER_TEMPLATE,
  NEGATIVE_FACT_TEMPLATE,
  NONE_MATCHED,
  EMPTY_NEGATIVE_FACT_TEMPLATE,
  SPAN_MARKER_TEMPLATE,
  RECEIPT_TEMPLATE,
  RECEIPT_FLOOR_TEMPLATE,
  RECALL_TOOL_DESCRIPTION,
  " lines",
  " bytes",
];
