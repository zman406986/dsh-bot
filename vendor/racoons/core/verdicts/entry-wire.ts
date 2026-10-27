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
  "mixed-keys": "An answer carries exactly one top-level key: the action.",
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
 * blank text, unreadable JSON, a non-object, zero or several top-level keys, an
 * action outside the four, `keepall` whose value is not `true`, a `keeplines` or
 * `forgetlines` payload that is not a list of pairs plus a trailing summary, an
 * empty span list, a reversed or fractional span, and a summary past the
 * 25-word cap.
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
  const keys = Object.keys(record);
  if (keys.length !== 1) refuse("mixed-keys");
  const action = keys[0];
  if (action === undefined) refuse("mixed-keys");
  if (!(ENTRY_ANSWER_ACTIONS as readonly string[]).includes(action)) refuse("unknown-action");
  const payload = record[action];
  switch (action) {
    case "keepall":
      if (payload !== true) refuse("invalid-keepall");
      return { action: "keepall" };
    case "keeplines": {
      const { ranges, summary } = readKeptLines(payload);
      return { action: "keeplines", ranges, summary };
    }
    case "forgetlines": {
      const { ranges, summary } = readForgottenLines(payload);
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

/** The answer text as one JSON value; a syntax error is a typed refusal. */
function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return refuse("malformed-json");
  }
}

/**
 * The kept spans a `keeplines` payload names, normalised, plus its trailer
 * summary. The payload is one array: zero or more `[start,end]` pairs and,
 * last, the summary string. Same rule as the gate lane's reader.
 */
function readKeptLines(
  payload: unknown,
): { readonly ranges: readonly KeptLineSpan[]; readonly summary: string } {
  if (!Array.isArray(payload) || payload.length === 0) refuse("invalid-keeplines");
  const last = payload[payload.length - 1];
  if (typeof last !== "string") refuse("summary-missing");
  const pairs = payload.slice(0, -1);
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
  const summary = readSummary(last, "summary-missing");
  return { ranges: normalized, summary };
}

/**
 * The spans a `forgetlines` payload names — the lines that LEAVE the unit —
 * normalised, plus its trailer summary. The payload is the same array shape
 * `keeplines` takes: one or more `[start,end]` pairs and, last, the summary
 * string. Only the polarity differs (ADR-0026 §2–§3), so the rules are the same
 * rules with the action's own `invalid-forgetlines` name.
 */
function readForgottenLines(
  payload: unknown,
): { readonly ranges: readonly KeptLineSpan[]; readonly summary: string } {
  if (!Array.isArray(payload) || payload.length === 0) refuse("invalid-forgetlines");
  const last = payload[payload.length - 1];
  if (typeof last !== "string") refuse("summary-missing");
  const pairs = payload.slice(0, -1);
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
  const summary = readSummary(last, "summary-missing");
  return { ranges: normalized, summary };
}

/** One summary string under the 25-word cap; a blank summary is zero words. */
function readSummary(value: unknown, wrongType: EntryAnswerErrorCode): string {
  if (typeof value !== "string") refuse(wrongType);
  if (descriptorIssue(value) !== null) refuse("summary-too-long");
  return value;
}
