/**
 * The entry checkpoint's answer grammar (ISSUE-056 chunk C1, adapted by
 * ISSUE-058 chunk P2; ADR-0022 §9, design §1 "A separate parser (G2)").
 *
 * The vocabulary is exactly four answers, and they are the gate lane's four:
 *
 * ```
 * {"keepall":true}
 * {"keeplines":[[start,end],...,"summary <= 25 words"]}
 * {"forgetall":"summary <= 25 words"}
 * {"forgetlines":[[start,end],...,"summary of the dropped lines, <= 25 words"]}
 * ```
 *
 * A partial answer may spell its summary in the action's array or in a sibling
 * `summary` key beside it (ADR-0033); both spellings decode to one answer, and
 * an answer carrying both is refused rather than merged.
 *
 * `forgetlines` names the lines that LEAVE and keeps every other line of the
 * unit; it is `keeplines` with the opposite polarity in the same shape
 * (ADR-0026). Keeping that shape single-variable is what makes the K-versus-F
 * comparison one difference (ADR-0027).
 *
 * There is no keep-first-N form and no byte offset (ADR-0022 §9). A `keephead`
 * answer is therefore not an action: the action list does not name it, so it
 * falls through to the ordinary `unknown-action` refusal, exactly as it does on
 * the gate lane.
 *
 * The gate lane's parser is deliberately not edited, so the tests pin the two
 * readers against each other over one corpus instead of one reader being
 * imported by the other. This module reads answer TEXT and so owns the two
 * refusals only text can cause (empty text, unreadable JSON); the gate lane is
 * handed an already-parsed value and never sees them.
 *
 * One grammar fact (design §1, N19; pinned by a test): duplicate JSON keys are
 * invisible — `JSON.parse` keeps the last one. Already true on the gate lane;
 * documented here, never repaired.
 *
 * The parser never repairs an answer. One `EntryAnswerError`, a stable code and
 * a fixed message; the mount journals the code and leaves the landed result
 * whole (ADR-0022 §14: fail-open, breaker-free).
 */

import { descriptorIssue, RECEIPT_DESCRIPTOR_WORD_LIMIT } from "./labels.js";
import { normalizeKeptSpans } from "./plan.js";
import type { KeptLineSpan } from "./types.js";

/**
 * The four entry-lane actions, byte for byte the gate lane's four
 * (`verdicts/wire.ts`). `keephead` is not one of them: keeping a first-N prefix
 * is not an answer class (ADR-0022 §9). `keeplines` and `forgetlines` are the
 * two partial classes, naming the kept and the dropped lines respectively
 * (ADR-0026).
 */
export const ENTRY_ANSWER_ACTIONS = ["keepall", "keeplines", "forgetall", "forgetlines"] as const;

export type EntryAnswerAction = (typeof ENTRY_ANSWER_ACTIONS)[number];

/**
 * One decoded entry answer. No unit id and no round: the mount stamps those on
 * the entry event (design §1 "Stamp (N20)"), never the answer.
 *
 * A `keeplines` answer names the lines that stay and the summary of what leaves.
 * A `forgetlines` answer names the lines that leave and the summary of those
 * same lines — the complement inside the unit is kept (ADR-0026 §2, §4).
 * `forgetall` names nothing that stays and carries the summary of the whole.
 */
export type EntryAnswer =
  | { readonly action: "keepall" }
  | {
    readonly action: "keeplines";
    readonly ranges: readonly KeptLineSpan[];
    readonly summary: string;
  }
  | {
    readonly action: "forgetlines";
    readonly ranges: readonly KeptLineSpan[];
    readonly summary: string;
  }
  | { readonly action: "forgetall"; readonly summary: string };

/** Every refusal the entry parser can make; each is one journaled code. */
export type EntryAnswerErrorCode =
  | "empty-text"
  | "malformed-json"
  | "not-an-object"
  | "mixed-keys"
  | "unknown-action"
  | "invalid-keepall"
  | "invalid-keeplines"
  | "invalid-forgetlines"
  | "invalid-span"
  | "empty-ranges"
  | "summary-missing"
  | "summary-too-long"
  | "invalid-forgetall";

/**
 * One refusal from the entry parser. Deliberately a different class from
 * `WireVerdictError`: a mount catching one lane's refusal must not swallow the
 * other lane's by accident. The code names the defect and the message is fixed
 * per code, so a journal and a test can both quote it verbatim.
 */
export class EntryAnswerError extends Error {
  readonly code: EntryAnswerErrorCode;

  constructor(code: EntryAnswerErrorCode, message: string) {
    super(message);
    this.name = "EntryAnswerError";
    this.code = code;
  }
}

const MESSAGES: Readonly<Record<EntryAnswerErrorCode, string>> = {
  "empty-text": "The answer carries no text.",
  "malformed-json": "The answer is not readable JSON.",
  "not-an-object": "An answer is one JSON object.",
  "mixed-keys": "An answer carries exactly one action key: a partial answer may add one summary.",
  "unknown-action": `The entry action is not one of ${ENTRY_ANSWER_ACTIONS.join(", ")}.`,
  "invalid-keepall": "keepall carries the boolean true and nothing else.",
  "invalid-keeplines": "keeplines carries an array of [start,end] pairs and a trailing summary string.",
  "invalid-forgetlines": "forgetlines carries an array of [start,end] pairs and a trailing summary string.",
  "invalid-span": "Every span is a [start,end] pair of integers with 1 <= start <= end.",
  "empty-ranges": "keeplines names at least one [start,end] pair.",
  "summary-missing": "The last element of a keeplines array is one summary string.",
  "summary-too-long": `A summary stays within ${String(RECEIPT_DESCRIPTOR_WORD_LIMIT)} words.`,
  "invalid-forgetall": "forgetall carries its summary string as the value.",
};

function refuse(code: EntryAnswerErrorCode): never {
  throw new EntryAnswerError(code, MESSAGES[code]);
}

/**
 * One entry answer, off the ask's answer text.
 *
 * Refused whole (an `EntryAnswerError`, never a partial reading): absent or
 * blank text, unreadable JSON, a non-object, an answer that is not one action
 * key beside at most one `summary` on a partial answer, an action outside the
 * four, `keepall` whose value is not `true`, a `keeplines` or `forgetlines`
 * payload that is not a list of pairs, no summary or two summaries, an empty
 * span list, a reversed or fractional span, and a summary past the 25-word cap.
 *
 * Span order and overlap are normalised, not refused: `normalizeKeptSpans` is
 * the planner's own function, so an unsorted or touching pair means exactly
 * what the rest of the protocol means by it. Whether a span runs past the
 * result is not decided here — the result's line count is not in the answer.
 */
export function parseEntryAnswer(text: string): EntryAnswer {
  if (typeof text !== "string" || text.trim().length === 0) refuse("empty-text");
  const parsed = parseJsonText(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    refuse("not-an-object");
  }
  const record = parsed as Record<string, unknown>;
  const action = readActionKey(record);
  const payload = record[action];
  const flat = readFlatSummary(record);
  switch (action) {
    case "keepall":
      if (payload !== true) refuse("invalid-keepall");
      return { action: "keepall" };
    case "keeplines": {
      const { ranges, summary } = readKeptLines(payload, flat);
      return { action: "keeplines", ranges, summary };
    }
    case "forgetlines": {
      const { ranges, summary } = readForgottenLines(payload, flat);
      return { action: "forgetlines", ranges, summary };
    }
    case "forgetall":
      return { action: "forgetall", summary: readSummary(payload, "invalid-forgetall") };
    default:
      // The four actions are each cased above; this arm covers a fifth added to
      // ENTRY_ANSWER_ACTIONS before its case, so it refuses rather than parsing
      // as a whole-result drop.
      return refuse("unknown-action");
  }
}

/**
 * Whether this answer says "nothing was dropped", in either of the two legal
 * forms a two-form ask offers: `keepall` itself, or a `keeplines` whose spans
 * merge to `1..lineCount` with the note `None`. Both must plan keep-all, so no
 * lane reads the second form as a refusal.
 *
 * The `None` note is required: the ranges alone are ambiguous with a genuine
 * partial answer that happens to name every line, and only the note says the
 * model meant "nothing was dropped".
 */
export function isKeepEverythingAnswer(answer: EntryAnswer, lineCount: number): boolean {
  if (answer.action === "keepall") return true;
  if (answer.action !== "keeplines" || answer.summary !== "None") return false;
  const merged = normalizeKeptSpans(answer.ranges);
  const span = merged?.[0];
  return merged?.length === 1 && span !== undefined
    && span.from === 1 && span.to === lineCount;
}

/** The answer text as one JSON value; a syntax error is a typed refusal. */
function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return refuse("malformed-json");
  }
}

function isEntryAction(key: string): key is EntryAnswerAction {
  return (ENTRY_ANSWER_ACTIONS as readonly string[]).includes(key);
}

function isPartialAction(action: string): action is "keeplines" | "forgetlines" {
  return action === "keeplines" || action === "forgetlines";
}

/**
 * The action the record's top-level keys name. One action key is the rule; a
 * partial action may sit beside the literal key `summary` (ADR-0033). Any other
 * key set — no action, two actions, or a stranger beside one — is mixed.
 */
function readActionKey(record: Record<string, unknown>): EntryAnswerAction {
  const keys = Object.keys(record);
  if (keys.length === 1) {
    const only = keys[0];
    if (only === undefined) refuse("mixed-keys");
    if (!isEntryAction(only)) refuse("unknown-action");
    return only;
  }
  if (keys.length !== 2) refuse("mixed-keys");
  const action = keys.find(isEntryAction);
  if (action === undefined || !isPartialAction(action)) refuse("mixed-keys");
  if (!keys.includes("summary")) refuse("mixed-keys");
  return action;
}

/** The record's sibling `summary` slot: whether it exists, and what it holds. */
interface FlatSummary {
  readonly present: boolean;
  readonly value: unknown;
}

/** The sibling `summary` key's value; absent is not the same as a wrong type. */
function readFlatSummary(record: Record<string, unknown>): FlatSummary {
  const present = Object.hasOwn(record, "summary");
  return { present, value: present ? record.summary : undefined };
}

/**
 * The kept spans a `keeplines` payload names, normalised, plus its summary.
 * The payload is one array: zero or more `[start,end]` pairs and, last, the
 * summary string. Same rule as the gate lane's reader. A summary in the
 * record's sibling key replaces the trailer (ADR-0033); the array then holds
 * pairs only, and a trailer beside it is refused rather than chosen between.
 */
function readKeptLines(
  payload: unknown,
  flat: FlatSummary,
): { readonly ranges: readonly KeptLineSpan[]; readonly summary: string } {
  if (!Array.isArray(payload) || payload.length === 0) refuse("invalid-keeplines");
  const last = payload[payload.length - 1];
  const trailer = typeof last === "string";
  if (trailer && flat.present) refuse("mixed-keys");
  if (!trailer && !flat.present) refuse("summary-missing");
  const pairs = trailer ? payload.slice(0, -1) : payload;
  if (pairs.length === 0) refuse("empty-ranges");
  const spans: KeptLineSpan[] = [];
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) refuse("invalid-span");
    const [from, to] = pair as readonly unknown[];
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) refuse("invalid-span");
    const span = { from: from as number, to: to as number };
    if (span.from < 1 || span.to < span.from) refuse("invalid-span");
    spans.push(span);
  }
  const normalized = normalizeKeptSpans(spans);
  if (normalized === null || normalized.length === 0) refuse("invalid-span");
  const summary = readSummary(trailer ? last : flat.value, "summary-missing");
  return { ranges: normalized, summary };
}

/**
 * The spans a `forgetlines` payload names — the lines that LEAVE the unit —
 * normalised, plus its summary. The payload is the same array shape
 * `keeplines` takes: one or more `[start,end]` pairs and, last, the summary
 * string. Only the polarity differs (ADR-0026 §2–§3), so the rules are the same
 * rules with the action's own `invalid-forgetlines` name.
 */
function readForgottenLines(
  payload: unknown,
  flat: FlatSummary,
): { readonly ranges: readonly KeptLineSpan[]; readonly summary: string } {
  if (!Array.isArray(payload) || payload.length === 0) refuse("invalid-forgetlines");
  const last = payload[payload.length - 1];
  const trailer = typeof last === "string";
  if (trailer && flat.present) refuse("mixed-keys");
  if (!trailer && !flat.present) refuse("summary-missing");
  const pairs = trailer ? payload.slice(0, -1) : payload;
  if (pairs.length === 0) refuse("empty-ranges");
  const spans: KeptLineSpan[] = [];
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) refuse("invalid-span");
    const [from, to] = pair as readonly unknown[];
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) refuse("invalid-span");
    const span = { from: from as number, to: to as number };
    if (span.from < 1 || span.to < span.from) refuse("invalid-span");
    spans.push(span);
  }
  const normalized = normalizeKeptSpans(spans);
  if (normalized === null || normalized.length === 0) refuse("invalid-span");
  const summary = readSummary(trailer ? last : flat.value, "summary-missing");
  return { ranges: normalized, summary };
}

/** One summary string under the 25-word cap; a blank summary is zero words. */
function readSummary(value: unknown, wrongType: EntryAnswerErrorCode): string {
  if (typeof value !== "string") refuse(wrongType);
  if (descriptorIssue(value) !== null) refuse("summary-too-long");
  return value;
}
