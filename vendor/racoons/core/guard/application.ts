import type { Candidate } from "./candidate.js";
import { canonicalApplicationBytes, digest } from "./bytes.js";
import type { ValidationInput, ValidatedApplication, ValidatedRevert } from "./types.js";

export type ApplicationBody = Omit<ValidatedApplication, symbol | "applicationSha256">;

export function applicationBytes(application: ApplicationBody): Uint8Array {
  return canonicalApplicationBytes({ domain: "racoons:application:v1", application });
}
/**
 * The digest of one approved revert plan (guard/types.ts `planSha256`): the host
 * receives it through the application, so a host-side substitution of the cut
 * or an anchor is detectable against what the ledger prepared (ADR-0004).
 */
export function revertBytes(revert: Omit<ValidatedRevert, "planSha256">): Uint8Array {
  return canonicalApplicationBytes({ domain: "racoons:revert:v1", revert });
}
export function makeApplication(value: ValidationInput, candidate: Candidate): ValidatedApplication {
  const body: ApplicationBody = {
    sessionId: value.snapshot.sessionId, eventId: value.input.eventId,
    baseRevision: value.snapshot.revision,
    phase: value.input.kind === "entry" ? "entry" : "at-rest",
    // A verdict removal is applied by checkpoint-revert, whatever event carried
    // it; every other phase keeps its append/entry mode.
    mode: value.input.kind === "entry" ? "entry"
      : candidate.revert === null ? "append" : "revert",
    replacements: candidate.replacements, appendRecords: candidate.appendRecords,
    archives: candidate.archives, sealedEpisodeIds: candidate.sealedEpisodeIds,
    createdAtMs: value.nowMs,
    ...(candidate.revert === null ? {} : { revert: sealRevert(candidate.revert) }),
  };
  // This assertion installs only the private compile-time brand after final validation.
  return { ...body, applicationSha256: digest(applicationBytes(body)) } as ValidatedApplication;
}
function sealRevert(revert: Candidate["revert"]): ValidatedRevert {
  if (revert === null) throw new Error("No revert to seal");
  const { plan, unitIds } = revert;
  const approved: Omit<ValidatedRevert, "planSha256"> = {
    unitIds: [...unitIds], cutIndex: plan.cutIndex, survivors: [...plan.survivors],
    appends: plan.appends.map(append => ({ ...append })), cost: { ...plan.cost },
    baseRevision: plan.baseRevision,
  };
  return { ...approved, planSha256: digest(revertBytes(approved)) };
}

