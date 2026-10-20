import type { Candidate } from "./candidate.js";
import { canonicalApplicationBytes, digest } from "./bytes.js";
import type { ValidationInput, ValidatedApplication } from "./types.js";

export type ApplicationBody = Omit<ValidatedApplication, symbol | "applicationSha256">;

export function applicationBytes(application: ApplicationBody): Uint8Array {
  return canonicalApplicationBytes({ domain: "racoons:application:v1", application });
}
export function makeApplication(value: ValidationInput, candidate: Candidate): ValidatedApplication {
  const body: ApplicationBody = {
    sessionId: value.snapshot.sessionId, eventId: value.input.eventId,
    baseRevision: value.snapshot.revision, phase: value.input.kind,
    mode: value.input.kind === "entry" ? "entry" : "append",
    replacements: candidate.replacements, appendRecords: candidate.appendRecords,
    archives: candidate.archives, sealedEpisodeIds: candidate.sealedEpisodeIds,
    createdAtMs: value.nowMs,
  };
  // This assertion installs only the private compile-time brand after final validation.
  return { ...body, applicationSha256: digest(applicationBytes(body)) } as ValidatedApplication;
}
