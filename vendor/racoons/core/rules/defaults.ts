import type { RacoonsConfig } from "../config.js";
import { SealRule } from "./seal.js";
import { SpanRule } from "./span.js";
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
 * The default rule set: append-mode Seal and the verdict protocol. The entry-time
 * cap is not registered — ADR-0014 (2026-10-23) scrapped it, and removal
 * decisions belong to the agent's verdicts. Evict is deferred (ADR-0001).
 */
export function createDefaultRules(config: RacoonsConfig): readonly Rule[] {
  const rules: Rule[] = [new SealRule(), new VerdictRule()];
  if (config.enableSpans) rules.push(new SpanRule());
  return rules;
}
