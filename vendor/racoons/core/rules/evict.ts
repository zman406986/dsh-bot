import type { Rule, RuleContext, RulePlan } from "./types.js";

export class EvictRule implements Rule {
  readonly id = "evict" as const;

  plan(_context: RuleContext): RulePlan | null {
    // Evict is deferred to Revisit (ADR-0001); this rule plans nothing.
    return null;
  }
}
