import { makeApplication } from "./application.js";
import type { Candidate } from "./candidate.js";
import { checkOutput } from "./checks-output.js";
import type { CheckContext } from "./context.js";
import type { ValidatedApplication, ValidationIssue } from "./types.js";

export type FinalizedCandidate =
  | { readonly ok: true; readonly application: ValidatedApplication }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/** The same final check is used by Guard and corruption tests. No injectable checker. */
export function finalizeCandidate(context: CheckContext, candidate: Candidate): FinalizedCandidate {
  try {
    checkOutput(context, candidate);
    if (context.issues.length > 0) return { ok: false, issues: context.issues };
    return { ok: true, application: makeApplication(context.value, candidate) };
  } catch (error) {
    context.issues.push({ code: "invalid-generated-record", ruleId: null, operationIndex: null,
      nodeId: null, detail: error instanceof Error ? error.message : "Malformed rendered candidate" });
    return { ok: false, issues: context.issues };
  }
}
