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
    case "evict-marker": return keys(v, ["id", "kind", "episodeId", "removalId"])
      && text(v.episodeId) && text(v.removalId);
    case "span-marker": return keys(v, ["id", "kind", "removalId", "path", "keepLines"])
      && text(v.removalId) && text(v.path) && array(v.keepLines, lines);
    default: return false;
  }
}
function op(v: unknown): boolean {
  if (!object(v) || !text(v.noteId)) return false;
  switch (v.kind) {
    case "cap": return keys(v, ["kind", "removalId", "keepHeadEndByte", "noteId"])
      && text(v.removalId) && number(v.keepHeadEndByte);
    case "seal": return keys(v, ["kind", "mode", "episodeId", "removalId", "noteId"])
      && ["append", "replace"].includes(String(v.mode)) && text(v.episodeId)
      && (v.removalId === null || text(v.removalId));
    case "evict": return keys(v, ["kind", "episodeId", "removalId", "noteId"])
      && text(v.episodeId) && text(v.removalId);
    case "span": return keys(v, ["kind", "removalId", "keepLines", "noteId"])
      && text(v.removalId) && array(v.keepLines, lines);
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
