import { equalBytes } from "../util/bytes.js";
import { planProofs } from "./proofs.js";
import type { ProofSubject } from "./proofs.js";
import type { Rule, RuleContext, RulePlan } from "./types.js";

/**
 * The superseded-read proof rule (PRD §6.6; ADR-0018; ISSUE-045 chunk C3).
 *
 * A read is burnt when a later read of the same target key returned exactly the
 * same bytes: the later copy is in the transcript, so this one is redundant. The
 * comparison is exact bytes over the burnt span — never a hash alone and never
 * a target alone (the same comparison `prune/level1-families.ts` proves for
 * `stale-exact-reread`, restructured here; the prune lane keeps its own copy).
 *
 * A changed world is not a superseded read: the same path re-read into different
 * bytes proves the file changed, which is the stale-read rule's opposite case.
 * An empty target key groups nothing — two unnamed reads that happen to print
 * the same text are not one source — and a call that is not a `read` is never a
 * re-read: a search, a glob, or an unclassified `other` result observed nothing
 * about the file's bytes.
 *
 * The guard re-derives the same comparison from the snapshot
 * (`guard/checks-proofs.ts`), so a claim beyond the bytes is refused there.
 */
export class SupersededReadRule implements Rule {
  readonly id = "superseded-read" as const;

  plan(context: RuleContext): RulePlan | null {
    return planProofs(context, this.id, subject => rereadLater(context, subject));
  }
}

/**
 * True when a later read of this read's target key holds exactly the removed
 * bytes. Only nodes after this one are consulted: the rule removes the earlier
 * copy, and the survivor is by construction the later one.
 */
function rereadLater(context: RuleContext, subject: ProofSubject): boolean {
  const target = subject.node.evidence.target;
  if (target === null || target.key.length === 0) return false;
  const { startByte, endByteExclusive } = subject.unit.span.byteRange;
  const removed = subject.node.bytes.slice(startByte, endByteExclusive);
  if (removed.length === 0) return false;
  const nodes = context.snapshot.nodes;
  for (let at = subject.index + 1; at < nodes.length; at += 1) {
    const later = nodes[at];
    if (later === undefined || later.kind !== "tool-result" || later.evidence.kind !== "read") {
      continue;
    }
    const other = later.evidence.target;
    if (other === null || other.key !== target.key) continue;
    // The same span of the later read's bytes, exactly. A shorter later body is
    // a different result, not a substitute for these bytes.
    if (endByteExclusive > later.bytes.length) continue;
    if (equalBytes(later.bytes.slice(startByte, endByteExclusive), removed)) return true;
  }
  return false;
}
