/**
 * Reading the L2 batch ask's answer (ISSUE-022 chunk 3; ADR-0009).
 *
 * One answer is one JSON object keyed by the indices the ask assigned. This
 * module turns it into exactly one result per assigned index: the unit's wire
 * verdict, or a typed refusal that means KEEP. The batch never crashes on
 * answer data — an unreadable answer, a missing index, a duplicated index, an
 * index we never assigned and a malformed row each keep their unit — because a
 * prune fails open (`PRUNE_ASK_RETRY_LIMIT` is 0) and the caller re-asks if it
 * wants to. The verdict per row comes from `parseWireVerdict`, the parser the
 * single-unit judge uses, so the three v4.1 shapes mean here what they mean
 * there; a `keeplines` summary rides beside the verdict.
 *
 * Pass the raw answer TEXT when duplicates matter: `JSON.parse` keeps only the
 * last of two equal keys, so a parsed object has already lost the duplicate this
 * rule exists to catch. The text path scans the top-level keys itself first.
 */

import type { UnitId } from "../types/identity.js";
import type { WireAnswer, WireStamp, WireVerdictErrorCode } from "../verdicts/wire.js";
import { parseWireVerdict, WireVerdictError } from "../verdicts/wire.js";
import { canonicalIndex, orderedKeys, topLevelKeys } from "./ask-keys.js";

/**
 * Why one assigned index produced no verdict, as data. Every one of these keeps
 * the unit, so a caller can count refusals by code without a second list.
 */
export const PRUNE_ANSWER_REFUSAL_CODES = [
  "missing-index",
  "duplicate-index",
  "malformed-row",
  "answer-not-an-object",
  "answer-unreadable",
] as const;

/** Why one assigned index produced no verdict. Every one of these keeps the unit. */
export type PruneAnswerRefusalCode = (typeof PRUNE_ANSWER_REFUSAL_CODES)[number];

/** Why a key named no unit of this ask; no unit is affected. */
export type PruneAnswerRejectionCode = "unknown-index" | "out-of-range" | "duplicate-index";

export interface PruneAnswerRowAnswered {
  readonly index: number;
  readonly unitId: UnitId;
  readonly status: "answered";
  /** The wire verdict plus its `keeplines` summary when the answer carried one. */
  readonly answer: WireAnswer;
}

export interface PruneAnswerRowRefused {
  readonly index: number;
  readonly unitId: UnitId;
  readonly status: "refused";
  readonly code: PruneAnswerRefusalCode;
  readonly message: string;
  /** The wire parser's own code when the row itself was malformed; else null. */
  readonly wireCode: WireVerdictErrorCode | null;
}

export type PruneAnswerRow = PruneAnswerRowAnswered | PruneAnswerRowRefused;

/** A key the answer carried that names no unit of this ask. */
export interface PruneAnswerRejection {
  readonly key: string;
  /** The key read as an index, or null when it is not a canonical integer. */
  readonly index: number | null;
  readonly code: PruneAnswerRejectionCode;
  readonly message: string;
}

/** One parsed answer: one row per assigned index, ascending, plus stray keys. */
export interface PruneAnswerParse {
  /** One entry per assigned index, in ascending index order, never fewer. */
  readonly rows: readonly PruneAnswerRow[];
  /** Keys that addressed no unit of this ask, in answer order. */
  readonly rejected: readonly PruneAnswerRejection[];
}

export interface ParsePruneAnswerOptions {
  /** The indices this ask assigned; each must carry a stamp. */
  readonly indices: readonly number[];
  /** The stamp per index: its unit id and the pass's round. */
  readonly stamps: ReadonlyMap<number, WireStamp>;
}

/**
 * Reads one batch answer into one result per assigned index.
 *
 * A key that is not a canonical positive integer (`"1"`, never `"01"`, `"0"` or
 * `"1.5"`), names no assigned index, or lies outside the assigned range is
 * recorded in `rejected` and can never address a unit. A key that does address
 * one but carries a shape the wire parser refuses becomes that unit's
 * `malformed-row` refusal, carrying the parser's own code.
 */
export function parsePruneAnswer(
  value: unknown,
  options: ParsePruneAnswerOptions,
): PruneAnswerParse {
  const indices = checkedIndices(options);
  const assigned = new Set(indices);
  const highest = indices[indices.length - 1] ?? 0;
  const answer = readAnswer(value);
  const answered = new Map<number, WireAnswer>();
  const refusals = new Map<number, PruneAnswerRowRefused>();
  const rejected: PruneAnswerRejection[] = [];
  const refuseAll = (code: PruneAnswerRefusalCode, message: string): void => {
    for (const index of indices) {
      refusals.set(index, refusalRow(index, options, code, message, null));
    }
  };

  if (answer.kind !== "record") {
    refuseAll(answer.kind, answer.kind === "answer-unreadable"
      ? "The answer is not readable JSON; every unit is kept."
      : "The answer is not one JSON object; every unit is kept.");
  } else {
    const duplicates = new Set(answer.duplicateKeys);
    for (const key of orderedKeys(answer.record)) {
      const index = canonicalIndex(key);
      if (index === null) {
        rejected.push({ key, index: null, code: "unknown-index",
          message: `Key ${JSON.stringify(key)} is not an index; no unit is affected.` });
      } else if (duplicates.has(key)) {
        if (assigned.has(index)) {
          refusals.set(index, refusalRow(index, options, "duplicate-index",
            `Index ${key} appears more than once; that unit is kept.`, null));
        } else {
          rejected.push({ key, index, code: "duplicate-index",
            message: `Index ${key} appears more than once; no unit is affected.` });
        }
      } else if (!assigned.has(index)) {
        const outOfRange = index < 1 || index > highest;
        rejected.push({
          key, index,
          code: outOfRange ? "out-of-range" : "unknown-index",
          message: outOfRange
            ? `Index ${key} is outside the assigned range; no unit is affected.`
            : `Index ${key} was not assigned by this ask; no unit is affected.`,
        });
      } else {
        try {
          answered.set(index, parseWireVerdict(answer.record[key], stampAt(options, index)));
        } catch (error) {
          const wireCode = error instanceof WireVerdictError ? error.code : null;
          refusals.set(index,
            refusalRow(index, options, "malformed-row", messageOf(error), wireCode));
        }
      }
    }
    for (const index of indices) {
      if (answered.has(index) || refusals.has(index)) continue;
      refusals.set(index, refusalRow(index, options, "missing-index",
        `No verdict was given for index ${String(index)}; that unit is kept.`, null));
    }
  }

  const rows: PruneAnswerRow[] = indices.map(index => {
    const verdict = answered.get(index);
    if (verdict !== undefined) {
      return { index, unitId: stampAt(options, index).unitId, status: "answered", answer: verdict };
    }
    // Every index is answered or refused above; the fallback is the refusal rule
    // itself, never a silent keepall, so a bug here still keeps the unit.
    return refusals.get(index) ?? refusalRow(index, options, "missing-index",
      `No verdict was given for index ${String(index)}; that unit is kept.`, null);
  });
  return { rows, rejected };
}

/** The assigned indices, ascending and unique, each carrying a usable stamp. */
function checkedIndices(options: ParsePruneAnswerOptions): readonly number[] {
  if (options.indices.length === 0) {
    throw new RangeError("indices must name at least one assigned index.");
  }
  const sorted = [...options.indices].sort((left, right) => left - right);
  for (const [position, index] of sorted.entries()) {
    if (!Number.isSafeInteger(index) || index < 1) {
      throw new RangeError("Every assigned index must be a positive safe integer.");
    }
    if (position > 0 && sorted[position - 1] === index) {
      throw new RangeError(`Assigned index ${index} is duplicated.`);
    }
    stampAt(options, index);
  }
  return sorted;
}

/** The stamp for one index; a missing or unusable one is a caller bug. */
function stampAt(options: ParsePruneAnswerOptions, index: number): WireStamp {
  const stamp = options.stamps.get(index);
  if (stamp === undefined) throw new RangeError(`No stamp for index ${String(index)}.`);
  if (typeof stamp.unitId !== "string" || stamp.unitId.length === 0) {
    throw new RangeError(`The stamp for index ${String(index)} carries an empty unit id.`);
  }
  if (!Number.isSafeInteger(stamp.answeredInRound)) {
    throw new RangeError(`The stamp for index ${String(index)} carries a non-integer round.`);
  }
  return stamp;
}

function refusalRow(
  index: number,
  options: ParsePruneAnswerOptions,
  code: PruneAnswerRefusalCode,
  message: string,
  wireCode: WireVerdictErrorCode | null,
): PruneAnswerRowRefused {
  const unitId = stampAt(options, index).unitId;
  return { index, unitId, status: "refused", code, message, wireCode };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The answer as an object, or the reason it is not one. */
type ReadAnswer =
  | {
      readonly kind: "record";
      readonly record: Record<string, unknown>;
      /** Top-level keys that occurred more than once in the answer text. */
      readonly duplicateKeys: readonly string[];
    }
  | { readonly kind: "answer-not-an-object" }
  | { readonly kind: "answer-unreadable" };

function readAnswer(value: unknown): ReadAnswer {
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return { kind: "answer-unreadable" };
    }
    if (!isRecord(parsed)) return { kind: "answer-not-an-object" };
    const counts = new Map<string, number>();
    for (const key of topLevelKeys(value) ?? []) counts.set(key, (counts.get(key) ?? 0) + 1);
    return {
      kind: "record",
      record: parsed,
      duplicateKeys: [...counts].filter(([, count]) => count > 1).map(([key]) => key),
    };
  }
  if (!isRecord(value)) return { kind: "answer-not-an-object" };
  return { kind: "record", record: value, duplicateKeys: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
