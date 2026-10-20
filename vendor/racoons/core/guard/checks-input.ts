import { validateConfig } from "../config.js";
import type { ValidationInput } from "./types.js";
import type { CheckContext, Report } from "./context.js";
import { digest, validRange } from "./bytes.js";
import { verifiedCold } from "./protection.js";

const count = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
export function checkInput(value: ValidationInput, report: Report): void {
  for (const detail of validateConfig(value.config)) report("invalid-plan", detail);
  const s = value.snapshot;
  if (!count(value.nowMs) || !count(s.currentTurnOrdinal) || !count(s.currentStepOrdinal)
    || !Number.isSafeInteger(s.completedThroughTurnOrdinal)
    || s.completedThroughTurnOrdinal < -1 || s.completedThroughTurnOrdinal > s.currentTurnOrdinal
    || !s.sessionId.trim() || !s.revision.trim() || !value.input.eventId.trim()) {
    report("invalid-plan", "Invalid input identity, timestamp or transcript ordinal");
  }
  for (const key of ["mutateResult", "rewriteHistory", "atRest", "liveTokens", "log",
    "appendRecords", "rehydrateOnResume"] as const) {
    if (typeof value.capabilities[key] !== "boolean") report("invalid-plan", `Capability ${key} must be boolean`);
  }
  if (value.input.kind !== "entry" && value.input.kind !== "at-rest") {
    report("unsupported-capability", "Only entry and at-rest phases exist in M1");
  }
  if (value.input.kind === "at-rest" && !["step", "turn-end", "resume", "idle-past-ttl", "model-switch"].includes(value.input.reason)) {
    report("unsupported-capability", "Unsupported at-rest application reason");
  }
  if (value.input.kind === "entry" && value.input.result.kind !== "tool-result") {
    report("invalid-plan", "Entry input must be a tool-result node");
  }
  if (s.cache.kind === "cold" && !verifiedCold(s, value.nowMs)) {
    report("cold-boundary-required", "Cold boundary is invalid or is later than nowMs");
  }
  if (s.cache.kind === "warm" && (!count(s.cache.watermarkNodeIndex) || s.cache.watermarkNodeIndex > s.nodes.length)) {
    report("invalid-plan", "Cache watermark must name a complete node boundary");
  }
  if (!["warm", "cold", "unknown"].includes(s.cache.kind)) report("invalid-plan", "Unknown cache-state tag");
  for (const plan of value.plans) if (!["cap", "seal", "evict", "span"].includes(plan.ruleId)) {
    report("wrong-rule", `Unknown rule ID ${plan.ruleId}`);
  }
}
export function checkProtection(c: CheckContext): void {
  const report: Report = (code, detail, nodeId = null) => c.issues.push({ code, detail, nodeId,
    ruleId: null, operationIndex: null });
  for (const span of [...c.value.snapshot.protection.policySpans, ...c.value.snapshot.protection.quotedThisTurn]) {
    const node = c.nodes.get(span.source.nodeId);
    if (node === undefined) report("unknown-source", "Protection names a missing node", span.source.nodeId);
    else if (!validRange(span.range, node.bytes.length) || span.source.sha256 !== digest(node.bytes)
      || span.source.byteLength !== node.bytes.length) {
      report("protected-content", "Protection source identity or range is invalid; refusing to weaken protection", node.id);
    }
  }
}
