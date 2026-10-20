import type { Bytes, Sha256 } from "../types/identity.js";
import { canonicalBytesWithByteArrays } from "../util/bytes.js";
import type { PreparableApplication } from "./types.js";
import { LedgerError } from "./types.js";

export interface ApplicationHashMaterial {
  readonly bytes: Bytes;
  readonly replacements: readonly { readonly bytes: Bytes; readonly sha256: Sha256 }[];
}

/** No guard runtime dependency. Match its racoons:application:v1 hash envelope
 * when a full application is supplied through the structural prepare interface.
 * A bare subset has no replacements/mode/time and cannot reproduce that digest.
 */
export function snapshotApplicationHash(application: PreparableApplication): ApplicationHashMaterial | null {
  const full = application as PreparableApplication & Record<string, unknown>;
  if (!("mode" in full) && !("replacements" in full) && !("createdAtMs" in full)) return null;
  if (!Array.isArray(full.replacements) || typeof full.createdAtMs !== "number" ||
      !Number.isSafeInteger(full.createdAtMs) ||
      (full.mode !== "entry" && full.mode !== "append" &&
       full.mode !== "rewrite" && full.mode !== "rehydrate")) {
    throw new LedgerError("hash-mismatch", "Incomplete full application hash material");
  }
  const replacements = full.replacements.map((value: unknown) => {
    if (typeof value !== "object" || value === null || !("bytes" in value) ||
        !(value.bytes instanceof Uint8Array) || !("sha256" in value) ||
        typeof value.sha256 !== "string") {
      throw new LedgerError("hash-mismatch", "Invalid replacement hash material");
    }
    return { bytes: new Uint8Array(value.bytes), sha256: value.sha256 };
  });
  const bytes = applicationHashBytes({
    domain: "racoons:application:v1",
    application: {
      sessionId: full.sessionId, eventId: full.eventId, baseRevision: full.baseRevision,
      phase: full.phase, mode: full.mode, replacements: full.replacements,
      appendRecords: full.appendRecords, archives: full.archives,
      sealedEpisodeIds: full.sealedEpisodeIds, createdAtMs: full.createdAtMs,
    },
  });
  return { bytes, replacements };
}

/** The shared encoder rejects non-plain data with TypeError; this seam reports its own code. */
function applicationHashBytes(material: unknown): Bytes {
  try { return canonicalBytesWithByteArrays(material); }
  catch (error) {
    throw error instanceof LedgerError ? error
      : new LedgerError("hash-mismatch", "Invalid application hash material", { cause: error });
  }
}
