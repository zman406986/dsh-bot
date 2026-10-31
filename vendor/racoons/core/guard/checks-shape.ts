import type { RulePlan } from "../rules/types.js";

const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const keys = (v: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(v).every(key => expected.includes(key)) && expected.every(key => key in v);
const array = (v: unknown, check: (item: unknown) => boolean): boolean =>
  Array.isArray(v) && Array.from(v as readonly unknown[]).every(check);
const range = (v: unknown): boolean => object(v) && keys(v, ["startByte", "endByteExclusive"])
  && number(v.startByte) && number(v.endByteExclusive);
/** A body of bytes: the landed original and the shaped turn both travel as one. */
const body = (v: unknown): boolean => v instanceof Uint8Array;
const lines = (v: unknown): boolean => object(v) && keys(v, ["startLine", "endLineInclusive"])
  && number(v.startLine) && number(v.endLineInclusive);
const source = (v: unknown): boolean => object(v) && keys(v, ["nodeId", "sha256", "byteLength"])
  && text(v.nodeId) && typeof v.sha256 === "string" && number(v.byteLength);
function removal(v: unknown): boolean {
  return object(v) && keys(v, ["id", "title", "sources"]) && text(v.id)
    && text(v.title) && array(v.sources, s => object(s) && keys(s, ["source", "ranges"])
      && source(s.source) && array(s.ranges, range));
}
function note(v: unknown): boolean {
  if (!object(v) || !text(v.id)) return false;
  switch (v.kind) {
    case "cap-marker": return keys(v, ["id", "kind", "removalId"]) && text(v.removalId);
    case "negative-fact": return keys(v, ["id", "kind", "episodeId"]) && text(v.episodeId);
    // A shaped entry's note declares the one marker the plan accounts for and
    // nothing else: the rendered bytes come from the pinned template, never from
    // the note (ISSUE-056 chunk C4/C5).
    case "shape-marker": return keys(v, ["id", "kind", "removalId"]) && text(v.removalId);
    case "receipt": return keys(v, ["id", "kind", "removalId", "unitId", "path", "ranges", "label"])
      && text(v.removalId) && text(v.unitId) && text(v.path) && array(v.ranges, lines)
      && (v.label === null || typeof v.label === "string");
    // A proof receipt carries the byte fact that justified the burn and no
    // label at all: a proven removal has nothing to describe (ADR-0018).
    case "proof-receipt": return keys(v, ["id", "kind", "proofKind", "removalId", "unitId", "path", "ranges"])
      && proofKind(v.proofKind) && text(v.removalId) && text(v.unitId) && text(v.path)
      && array(v.ranges, lines);
    default: return false;
  }
}
function proofKind(v: unknown): boolean {
  return v === "stale-read" || v === "superseded-read";
}
function op(v: unknown): boolean {
  if (!object(v) || !text(v.noteId)) return false;
  switch (v.kind) {
    case "cap": return keys(v, ["kind", "removalId", "keepHeadEndByte", "noteId"])
      && text(v.removalId) && number(v.keepHeadEndByte);
    case "seal": return keys(v, ["kind", "mode", "episodeId", "removalId", "noteId"])
      && ["append", "replace"].includes(String(v.mode)) && text(v.episodeId)
      && (v.removalId === null || text(v.removalId));
    case "verdict": return keys(v, ["kind", "removalId", "unitId", "noteId"])
      && text(v.removalId) && text(v.unitId);
    case "proof": return keys(v, ["kind", "proofKind", "removalId", "unitId", "noteId"])
      && proofKind(v.proofKind) && text(v.removalId) && text(v.unitId);
    // One shaped entry (ISSUE-056 chunk C4, reworked to the landed-node contract
    // by ISSUE-058 chunk P3b; the validator is C5's). The kept ranges are the
    // ANSWER's claim over the landed body, and the two byte fields are the
    // original the archive covers and the turn the append lands. All three are
    // re-derived from the plan and the landed node in
    // `guard/checks-entry-shape.ts`; this only proves the closed key set.
    case "shape": return keys(v, ["kind", "removalId", "unitId", "keptRanges",
      "replacementBytes", "originalBytes", "noteId"])
      && text(v.removalId) && text(v.unitId) && array(v.keptRanges, range)
      && body(v.replacementBytes) && body(v.originalBytes);
    default: return false;
  }
}
export function isPlan(v: unknown): v is RulePlan {
  return object(v) && keys(v, ["ruleId", "baseRevision", "removals", "notes", "operations"])
    && text(v.ruleId) && text(v.baseRevision) && array(v.removals, removal)
    && array(v.notes, note) && array(v.operations, op);
}

/** Copy plain data only; reject accessors, prototypes, aliases to external bytes and cycles. */
export function privateCopy<T>(input: T): T {
  const active = new Set<object>();
  function copy(v: unknown): unknown {
    if (v instanceof Uint8Array) return Uint8Array.from(v);
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v !== "object") throw new Error("Validation input must contain plain finite data");
    if (active.has(v)) throw new Error("Cyclic validation input");
    if (Object.getOwnPropertySymbols(v).length > 0) throw new Error("Symbol input property");
    const proto: unknown = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) {
      throw new Error("Nonplain validation input");
    }
    active.add(v);
    const output: unknown[] | Record<string, unknown> = Array.isArray(v) ? [] : {};
    for (const key of Object.keys(v)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Unsafe input key");
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (descriptor === undefined || !("value" in descriptor)) throw new Error("Input accessor");
      Object.defineProperty(output, key, { value: copy(descriptor.value as unknown),
        enumerable: true, configurable: true, writable: true });
    }
    if (Array.isArray(v) && Object.keys(v).length !== v.length) throw new Error("Sparse input array");
    active.delete(v);
    return output;
  }
  return copy(input) as T;
}
