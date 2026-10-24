/**
 * The decision document of one prune pass (ISSUE-022 chunk 4; ADR-0009).
 *
 * The pass asks every unit still in memory; `./pass-answers.ts` reads the
 * answers per index, and this module turns those decisions into the document.
 * Record-only by ruling: a removal names the unit, the action, the judged ranges
 * and summary, and (for L1) its proof. No receipt, recall id, ledger event or
 * transcript byte appears anywhere — those are claims only an archive can make
 * true, and record-only archives none.
 *
 * An excluded unit is always kept, even when L1 proved it removable: protection
 * wins over every layer. The only throws are caller bugs, and they are the
 * reader's, not this module's. Answer data never throws.
 */

import type { UnitId } from "../types/identity.js";
import type { KeptLineSpan } from "../verdicts/types.js";
import type { WireAnswer, WireVerdictErrorCode } from "../verdicts/wire.js";
import type { PruneAnswerRejection, PruneAnswerRefusalCode } from "./ask-answer.js";
import type { PrunePassPlan } from "./pass.js";
import type { Level1Proof, Level1Rule } from "./types.js";

/** One unit L1 removed whole; the proof travels verbatim. */
export interface PruneL1Removal {
  readonly unitId: UnitId;
  readonly origin: "l1";
  readonly action: "forgetall";
  readonly rule: Level1Rule;
  /** The structured evidence `planLevel1Prune` filed, byte-identical. */
  readonly proof: Level1Proof;
}

/** One unit the ask removes; the fields are the judged claim, not a receipt. */
export type PruneL2Removal =
  | {
      readonly unitId: UnitId;
      readonly origin: "l2";
      readonly action: "keeplines";
      /** 1-based line spans the unit keeps, as the wire parser normalised them. */
      readonly ranges: readonly KeptLineSpan[];
      /** The `keeplines` trailer summary, carried verbatim when the answer had one. */
      readonly keeplinesSummary?: string;
      readonly answeredInRound: number;
    }
  | {
      readonly unitId: UnitId;
      readonly origin: "l2";
      readonly action: "forgetall";
      /** The `forgetall` descriptor exactly as the wire parser read it; blank is legal. */
      readonly summary: string | null;
      readonly answeredInRound: number;
    };

export type PruneRemoval = PruneL1Removal | PruneL2Removal;

/** One verdict that could not be read; its unit is kept. */
export interface PrunePassRefusal {
  readonly unitId: UnitId;
  readonly index: number;
  readonly code: PruneAnswerRefusalCode;
  readonly message: string;
  readonly wireCode: WireVerdictErrorCode | null;
  /** Which answer text produced it; null when the answer was absent or duplicated. */
  readonly answerIndex: number | null;
}

/** A key an answer carried that addresses no unit of this pass. */
export interface PrunePassRejection extends PruneAnswerRejection {
  /** Which answer text carried the key. */
  readonly answerIndex: number;
}

/** The merged pass: what would move, what stays, and why anything was unreadable. */
export interface PrunePassApplication {
  /** Transcript order; L1 proofs first-class, L2 claims beside them. */
  readonly removals: readonly PruneRemoval[];
  /** Transcript order, the units this pass decided to keep. */
  readonly kept: readonly UnitId[];
  /** Transcript order, one entry per unit whose verdict could not be read. */
  readonly refused: readonly PrunePassRefusal[];
  /** Answer order per text, then key order; no unit is affected by one. */
  readonly rejected: readonly PrunePassRejection[];
}

/**
 * The decision document. L1's removals go in first, and an L2 answer never
 * overrides one: a byte proof outranks a verdict (today the ask cannot offer a
 * unit L1 proved, so the guard is a second lock). `keepall` produces nothing.
 * Excluded units drop out of removals and refusals alike; protection wins.
 *
 * `@internal` — `applyPruneAnswers` is the entry point; this is the second half
 * of it, exported so the answer reader and this document share one module graph.
 */
export function mergePass(
  plan: PrunePassPlan,
  verdicts: ReadonlyMap<UnitId, WireAnswer>,
  refusals: ReadonlyMap<UnitId, PrunePassRefusal>,
  rejected: readonly PrunePassRejection[],
): PrunePassApplication {
  const removed = new Map<UnitId, PruneRemoval>();
  for (const removal of plan.l1.removals) {
    removed.set(removal.unitId, {
      unitId: removal.unitId, origin: "l1", action: "forgetall",
      rule: removal.rule, proof: removal.proof,
    });
  }
  for (const [unitId, answer] of verdicts) {
    if (removed.has(unitId)) continue;
    const removal = l2Removal(unitId, answer);
    if (removal !== null) removed.set(unitId, removal);
  }

  const excluded = new Set(plan.excluded.map(entry => entry.unitId));
  const removals: PruneRemoval[] = [];
  const kept: UnitId[] = [];
  const denied: PrunePassRefusal[] = [];
  for (const unit of plan.units) {
    if (excluded.has(unit.id)) {
      kept.push(unit.id);
      continue;
    }
    const removal = removed.get(unit.id);
    if (removal !== undefined) removals.push(removal);
    else kept.push(unit.id);
    const refusal = refusals.get(unit.id);
    if (refusal !== undefined) denied.push(refusal);
  }
  return { removals, kept, refused: denied, rejected };
}

/** The L2 removal one answered verdict claims, or null for `keepall`. */
function l2Removal(unitId: UnitId, answer: WireAnswer): PruneL2Removal | null {
  const verdict = answer.verdict;
  if (verdict.action === "keepall") return null;
  if (verdict.action === "keeplines") {
    return {
      unitId, origin: "l2", action: "keeplines", ranges: verdict.ranges,
      answeredInRound: verdict.answeredInRound,
      ...(answer.keeplinesSummary === undefined ? {} : { keeplinesSummary: answer.keeplinesSummary }),
    };
  }
  return {
    unitId, origin: "l2", action: "forgetall", summary: verdict.summary,
    answeredInRound: verdict.answeredInRound,
  };
}
