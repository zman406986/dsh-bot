import type { Rule, RuleContext, RulePlan } from "./types.js";

export class SpanRule implements Rule {
  readonly id = "span" as const;

  plan(_context: RuleContext): RulePlan | null {
    // Spans are deferred to Revisit (ADR-0001); this rule plans nothing.
    return null;
  }
}
