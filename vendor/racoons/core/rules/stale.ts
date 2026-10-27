import type { ToolResultNode } from "../types/transcript.js";
import { planProofs } from "./proofs.js";
import type { ProofSubject } from "./proofs.js";
import type { Rule, RuleContext, RulePlan } from "./types.js";

/**
 * The stale-read proof rule (PRD §6.6; ADR-0018; ISSUE-045 chunk C3).
 *
 * A read is burnt when a later call wrote one of the paths that read observed:
 * the file changed after the read, so the bytes in the transcript are provably
 * not what the file holds now. The clock is transcript order, never a wall
 * clock — a write *before* the read is already reflected in the read's bytes and
 * proves nothing.
 *
 * Only a call whose evidence kind is `write` counts. A write is the one kind
 * that proves a path changed (E0); an unclassified call stays `other` with no
 * hit/miss claim, and its unknown outcome is evidence of nothing. The write's
 * own path outcome is never consulted: a write is neither a hit nor a miss, so
 * the kind and the path identity are the whole fact.
 *
 * The guard re-derives this same comparison from the snapshot
 * (`guard/checks-proofs.ts`), so a claim beyond the bytes is refused there.
 */
export class StaleReadRule implements Rule {
  readonly id = "stale-read" as const;

  plan(context: RuleContext): RulePlan | null {
    return planProofs(context, this.id, subject => writtenAfter(context, subject));
  }
}

/** True when a later write names one of the paths this read observed. */
function writtenAfter(context: RuleContext, subject: ProofSubject): boolean {
  const read = readPaths(subject);
  if (read.size === 0) return false;
  const nodes = context.snapshot.nodes;
  for (let at = subject.index + 1; at < nodes.length; at += 1) {
    const later = nodes[at];
    if (later === undefined || later.kind !== "tool-result" || later.evidence.kind !== "write") {
      continue;
    }
    for (const key of writePaths(later)) if (read.has(key)) return true;
  }
  return false;
}

/** The paths a read observed: the host's own path evidence, nothing inferred. */
function readPaths(subject: ProofSubject): ReadonlySet<string> {
  return new Set(
    subject.node.evidence.paths.map(path => path.pathKey).filter(key => key.length > 0),
  );
}

/**
 * A write's paths: every path observation the host recorded, plus the call's own
 * declared target when it names one (E0 keeps both truthful). A write whose
 * observations are empty but whose target is a path still proves that path
 * changed; a write naming no path proves nothing.
 */
function writePaths(node: ToolResultNode): readonly string[] {
  const observed = node.evidence.paths.map(path => path.pathKey).filter(key => key.length > 0);
  const target = node.evidence.target;
  return target === null || target.key.length === 0 ? observed : [...observed, target.key];
}
