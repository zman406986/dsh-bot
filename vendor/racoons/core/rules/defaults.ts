import type { RacoonsConfig } from "../config.js";
import { SealRule } from "./seal.js";
import { StaleReadRule } from "./stale.js";
import { SupersededReadRule } from "./superseded.js";
import { ENTRY_SHAPE_RULE_ID } from "./types.js";
import type { Rule, RuleContext, RulePlan } from "./types.js";

/**
 * The verdict rule: a declaration, not a planner. Verdict operations come from
 * `verdicts/plan.ts` on a settled batch and never from `RuleContext`, which
 * carries no protocol state (design-protocol §3). Registering the id keeps the
 * default rule vocabulary complete for the guard, which accepts a `verdict`
 * plan only under this rule id; this class always plans nothing.
 */
export class VerdictRule implements Rule {
  readonly id = "verdict" as const;

  plan(_context: RuleContext): RulePlan | null {
    return null;
  }
}

/**
 * The entry checkpoint's rule: a declaration, not a planner (ISSUE-056 chunk C4;
 * ADR-0022). A shaped entry is the application of an answer the mount already
 * collected over a result that has already landed, so `engine/planning.ts` plans
 * it from the entry event and `options.rules` never sees it: core holds no
 * protocol state and never invents a decision.
 *
 * Registering the id is what keeps the rule vocabulary complete — `checkInput`
 * admits a plan only under a known id, and `checkOperations` refuses a `shape`
 * op under any other rule than `entry-shape`. This class always plans nothing,
 * and the checkpoint is never automatic: with no answer on the event, nothing
 * is shaped and the result stays landed whole.
 */
export class EntryShapeRule implements Rule {
  readonly id = ENTRY_SHAPE_RULE_ID;

  plan(_context: RuleContext): RulePlan | null {
    return null;
  }
}

/**
 * The default rule set: append-mode Seal, the verdict protocol, the entry
 * checkpoint's declaration, and the two proof rules (stale-read,
 * superseded-read). The entry-time cap is not registered — ADR-0014
 * (2026-10-23) scrapped it; the checkpoint that replaced it is an ask, not a
 * size rule (ADR-0022).
 *
 * Order is deliberate. The proof rules come after `verdict` (the protocol they
 * extend, ADR-0018), and stale-read precedes superseded-read because
 * `planApplication` reserves the nodes an earlier plan already removed: a unit
 * the stale fact burns is not offered to the superseded rule afterwards. One
 * node, one burn — a second removal over it would collide at materialization.
 * The entry declaration sits beside `verdict` because both are vocabulary, not
 * planners.
 */
export function createDefaultRules(_config: RacoonsConfig): readonly Rule[] {
  return [new SealRule(), new VerdictRule(), new EntryShapeRule(),
    new StaleReadRule(), new SupersededReadRule()];
}
