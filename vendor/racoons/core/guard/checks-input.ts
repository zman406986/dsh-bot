import { validateConfig } from "../config.js";
import { ENTRY_SHAPE_RULE_ID, PROOF_RULE_IDS } from "../rules/types.js";
import type { ValidationInput } from "./types.js";
import type { Report } from "./context.js";
import { verifiedCold } from "./fresh-zone.js";

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
  // Optional seam: absent means "not declared", but a declared value must be a boolean.
  const revertHistory: unknown = value.capabilities.revertHistory;
  if (revertHistory !== undefined && typeof revertHistory !== "boolean") {
    report("invalid-plan", "Capability revertHistory must be boolean when declared");
  }
  if (value.input.kind !== "entry" && value.input.kind !== "at-rest"
    && value.input.kind !== "prune" && value.input.kind !== "forget") {
    report("unsupported-capability", "An application phase must be entry, at-rest, prune or forget");
  }
  if (value.input.kind === "at-rest" && !["step", "turn-end", "resume", "idle-past-ttl", "model-switch", "revisit"].includes(value.input.reason)) {
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
  // The proof rule ids, `forget` and `entry-shape` are shared vocabulary
  // (ISSUE-045 chunk V0; ISSUE-056 chunk C4/C5). C3 registers a rule per proof
  // kind, C1 plans a manual forget under a `forget` rule id, and the entry
  // checkpoint plans a shape under `entry-shape`. The guard must know those ids
  // are plans, not typos; whether such a plan is applicable is
  // `checkOperations`' judgement.
  for (const plan of value.plans) if (!["cap", "seal", "verdict",
    "forget", ENTRY_SHAPE_RULE_ID, ...PROOF_RULE_IDS].includes(plan.ruleId)) {
    report("wrong-rule", `Unknown rule ID ${plan.ruleId}`);
  }
}
