/**
 * The model-facing copy of the core, as constants: the marker, receipt and
 * inventory strings, the entry ask's blocks, plus the shipped prompts.
 *
 * Pure data, no imports. `assets.ts` re-exports every name here, so callers keep
 * importing from `rules/assets.js`; the split exists only to keep each file
 * under the line cap.
 */

// The entry checkpoint's marker (ISSUE-056 chunk C2; design §1 "Marker text"
// and ADR-0022 §5). It states the kept line ranges, the result's total line
// count, how many bytes were dropped and the recall id — nothing else, and
// none of the vocabulary the deleted size rule used. The empty form is the
// `forgetall` floor line: no lines were kept, so no byte segment ships. These
// two are the only marker shapes; the entry renderer fills their slots.
//
// The templates END IN A NEWLINE (ISSUE-063, live R-3 defect). A marker is a
// whole line, so its terminator is part of the marker and not the renderer's
// private business: a marker spliced before a kept range without it put the
// recall id's last characters on the next kept line's text (`…sha256:7391633c…
// d2bC:\Users\…`), which made the id unparseable in 9 of 10 live shaped turns.
// Keeping the terminator here is also what makes the converter's independent
// parser — built from these very constants — measure the same `markerBytes`
// the renderer emits, so `landed = kept + gaps·markerBytes + summaryBytes +
// framing` still closes with `framing = 0`.
export const SHAPE_MARKER_TEMPLATE =
  "[racoons] kept lines <ranges> of <N> · <B> bytes dropped · recall <id>\n";
export const SHAPE_MARKER_EMPTY_TEMPLATE =
  "[racoons] kept 0 of <N> lines · recall <id>\n";
// The cap marker left with the cap rule (ADR-0014 deleted it 2026-10-23; the
// entry checkpoint speaks through the two templates above). Its literal is gone
// from the inventory on purpose: the vocabulary test bans "cap" from shipped
// copy, and an unused member cannot be kept "just in case" without it.
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
 * The shipped system prompt for the big prune's batched ask (ISSUE-022 chunk 3;
 * ADR-0009). One ask addresses every unit still in memory, so the answer is one
 * object keyed by the indices we assigned, not one verdict for one result.
 *
 * It is byte-identical across every ask of a run, so a provider can cache it for
 * the run, and it is pinned byte for byte by `test/assets.test.ts`. It is
 * deliberately absent from `MODEL_FACING_STRINGS`: that inventory is the receipt
 * and marker copy, and this asset must name the `summary` field the owner ruling
 * kept.
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
  '2. [Read] config.ts (call #2) — line 60 of 201 ends with "retries: 3, timeoutMs: 30000" · line 140 of 201 ends with "exit 1"',
  "",
  "A row begins with the index you answer with, then the call in brackets, then the target the",
  "call named when it named one. `call #2` says this is the second of identical calls, which is",
  "what tells two otherwise equal rows apart. Each line name is that unit's own line number out",
  "of its own total, closing with the last words of that line: `line 60 of 201` is line 60 of",
  "that unit, the same numbering your answer's ranges use. A run of blank lines reads",
  "`lines 64–67 are blank` instead. The line names only direct your attention.",
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

/**
 * The entry ask's contract (ISSUE-056 chunk C2, adapted by ISSUE-058 chunk P2;
 * ADR-0022 §3 and §9). Static, so it is byte-identical across every ask of a run
 * and cacheable, and it rides inside the one appended user message: the fork's
 * system slot stays main's (ADR-0010).
 *
 * The result has already landed above the ask, so this contract never repeats
 * its body. It states exactly three answer forms — the three the entry parser
 * accepts (`verdicts/entry-wire.ts`) — the `[start,end]` notation, how the
 * line count and the anchors that follow are read, and the fail-open rule. No
 * keep-first-N form: a first-N prefix is not an answer class (ADR-0022 §9).
 * Plain words only: the words the deleted size rule used (cap, capped) do not
 * appear, and a `keeplines`/`forgetall` note is called a note, because the
 * inventory test keeps the word "summary" out of shipped copy.
 */
const ENTRY_ASK_PROMPT_LINES: readonly string[] = [
  "You decide what the coding agent keeps of one tool result. The result has already landed in the",
  "conversation, immediately above this message, and it is not repeated here. Answer about that",
  "result only.",
  "",
  "Answer with exactly one JSON object and no other text. Its only top-level key is one of three",
  "actions:",
  "",
  '{"keepall":true}',
  '{"keeplines":[[2,3],"stale run notes: the superseded TODO and the old deploy host"]}',
  '{"forgetall":"a stale build log from the old host"}',
  "",
  "keepall keeps every line of the result, and its value is the boolean true.",
  "keeplines keeps only the lines the ranges name and drops the rest. The array holds the ranges",
  "and, last, one short note of at most 25 words saying what is dropped.",
  "forgetall keeps no line. Its value is one short note of at most 25 words saying what the whole",
  "result held.",
  "",
  "A range is written [start,end]: 1-based, inclusive, and counted on the result's own lines.",
  "Name several ranges when the useful lines sit apart; they need not be sorted or merged.",
  "",
  "The lines that follow state how many lines the result has and quote the end of a few of them.",
  'An anchor reads `line 67 of 201 ends with "..."`: those are the result\'s own line numbers,',
  "counted from its first line, so name your ranges by them.",
  "",
  "What you keep stays in the conversation. Everything else is dropped from it, stored, and",
  "restored byte for byte by a recall id, so a wrong choice costs one restore, not the content.",
  "",
  "If your answer is missing or cannot be read, the whole result stays as it landed. That is the",
  "fallback, and it is safe: silence keeps everything.",
];

/** Joined for the same purity-gate reason as the judge prompt above. */
export const ENTRY_ASK_SYSTEM_PROMPT = ENTRY_ASK_PROMPT_LINES.join("\n");

/**
 * Lane F's contract (ADR-0027 §4): the entry ask above with `forgetlines` in
 * place of `keeplines`, so the arm admits exactly one partial class while
 * `keepall` and `forgetall` stay in both. Inert: nothing reads it, and it is
 * absent from `assets.ts`'s surface, so the shipped ask is still the default.
 */
const ENTRY_ASK_FORGETLINES_PROMPT_LINES: readonly string[] = [
  "You decide what the coding agent keeps of one tool result. The result has already landed in the",
  "conversation, immediately above this message, and it is not repeated here. Answer about that",
  "result only.",
  "",
  "Answer with exactly one JSON object and no other text. Its only top-level key is one of three",
  "actions:",
  "",
  '{"keepall":true}',
  '{"forgetlines":[[2,3],"stale run notes: the superseded TODO and the old deploy host"]}',
  '{"forgetall":"a stale build log from the old host"}',
  "",
  "keepall keeps every line of the result, and its value is the boolean true.",
  "forgetlines drops only the lines the ranges name and keeps the rest. The array holds the ranges",
  "and, last, one short note of at most 25 words saying what is dropped.",
  "forgetall keeps no line. Its value is one short note of at most 25 words saying what the whole",
  "result held.",
  "",
  "A range is written [start,end]: 1-based, inclusive, and counted on the result's own lines.",
  "Name several ranges when the useful lines sit apart; they need not be sorted or merged.",
  "",
  "The lines that follow state how many lines the result has and quote the end of a few of them.",
  'An anchor reads `line 67 of 201 ends with "..."`: those are the result\'s own line numbers,',
  "counted from its first line, so name your ranges by them.",
  "",
  "What you keep stays in the conversation. Everything else is dropped from it, stored, and",
  "restored byte for byte by a recall id, so a wrong choice costs one restore, not the content.",
  "",
  "If your answer is missing or cannot be read, the whole result stays as it landed. That is the",
  "fallback, and it is safe: silence keeps everything.",
];

/** Joined like the two prompts above; T-8 adds it to the surface when a caller selects it. */
export const ENTRY_ASK_FORGETLINES_SYSTEM_PROMPT = ENTRY_ASK_FORGETLINES_PROMPT_LINES.join("\n");

/**
 * The framing line that introduced the result's block. Retained for the export
 * surface and the tests' byte pin, but unused by the body-free ask (ISSUE-058
 * P2): the result has already landed, so nothing in the ask brackets it. The
 * fence literals below are in the same position — kept, not rendered.
 */
export const ENTRY_ASK_FRAME =
  "The incoming tool result follows, copied verbatim between two fence lines.";

/**
 * The line that opened the result's block. Not a backtick fence: a code result
 * carries backticks. Not rendered by the body-free ask; see `ENTRY_ASK_FRAME`.
 */
export const ENTRY_ASK_RESULT_OPEN = "----- the result begins below, verbatim -----";

/** The line that closed the result's block. Not rendered by the body-free ask. */
export const ENTRY_ASK_RESULT_CLOSE = "----- the result ends above -----";

/**
 * The end anchor a bench or rig matcher keys on (ISSUE-056 C9a): a
 * random-looking literal, the LAST text of every entry ask, so a matcher anchors
 * on the message's end (`ENTRY_ASK_CLOSING_LINE` escaped, then `$`) instead of
 * searching for a phrase a result body could also carry.
 */
export const ENTRY_ASK_END_ANCHOR = "[[entry-ask-end:3f8b2d71c04e4a9db6e05c17]]";

/** The one closing instruction line: the action, then the end anchor. */
export const ENTRY_ASK_CLOSING_LINE =
  `Answer with one JSON object for the result above and nothing else. ${ENTRY_ASK_END_ANCHOR}`;

export const MODEL_FACING_STRINGS: readonly string[] = [
  SHAPE_MARKER_TEMPLATE,
  SHAPE_MARKER_EMPTY_TEMPLATE,
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
