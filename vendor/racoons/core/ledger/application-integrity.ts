import type { Bytes, Sha256 } from "../types/identity.js";
import { canonicalBytesWithByteArrays } from "../util/bytes.js";
import type { PreparableApplication } from "./types.js";
import { LedgerError } from "./types.js";

export interface ApplicationHashMaterial {
  readonly bytes: Bytes;
  readonly replacements: readonly { readonly bytes: Bytes; readonly sha256: Sha256 }[];
}

type Mode = "entry" | "append" | "rewrite" | "rehydrate" | "revert";

/**
 * No guard runtime dependency. Match its racoons:application:v1 hash envelope
 * when a full application is supplied through the structural prepare interface.
 * A bare subset has no replacements/mode/time and cannot reproduce that digest.
 *
 * A revert application is a full application whose envelope also carries its
 * `revert` member (`ledger/types.ts`: "Present exactly on a revert
 * application; hashed with the same envelope"). The member is hashed exactly as
 * the guard built it — never re-normalised — because the ledger's only job here
 * is to reproduce the guard's digest byte for byte (ADR-0004: the host must
 * receive what the ledger prepared). Its declared fields are validated first,
 * so an internally impossible plan is refused before any blob is published.
 */
export function snapshotApplicationHash(application: PreparableApplication): ApplicationHashMaterial | null {
  const full = application as PreparableApplication & Record<string, unknown>;
  if (!("mode" in full) && !("replacements" in full) && !("createdAtMs" in full)) return null;
  if (!Array.isArray(full.replacements) || typeof full.createdAtMs !== "number" ||
      !Number.isSafeInteger(full.createdAtMs) ||
      (full.mode !== "entry" && full.mode !== "append" &&
       full.mode !== "rewrite" && full.mode !== "rehydrate" &&
       full.mode !== "revert")) {
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
  // `types.ts`: present exactly on a revert application, absent otherwise.
  const revert = full.revert;
  if (full.mode === "revert") {
    if (revert === undefined) {
      throw new LedgerError("hash-mismatch", "A revert application must carry its revert payload");
    }
    checkRevertPayload(revert);
  } else if (revert !== undefined) {
    throw new LedgerError("hash-mismatch", "Only a revert application may carry a revert payload");
  }
  const bytes = applicationHashBytes({
    domain: "racoons:application:v1",
    application: {
      sessionId: full.sessionId, eventId: full.eventId, baseRevision: full.baseRevision,
      phase: full.phase, mode: full.mode as Mode, replacements: full.replacements,
      appendRecords: full.appendRecords, archives: full.archives,
      sealedEpisodeIds: full.sealedEpisodeIds, createdAtMs: full.createdAtMs,
      ...(revert === undefined ? {} : { revert }),
    },
  });
  return { bytes, replacements };
}

/**
 * Internal consistency of the approved plan (design-protocol §2): the cut, the
 * survivors and the salvage arithmetic must describe one plan. Keys this file
 * does not name are left alone and hashed through, so a wider `ValidatedRevert`
 * still reproduces the guard's digest.
 *
 * Receipt-first ordering is a host fact, enforced by the adapter, not here.
 * `netFreedBytes` is an identity, not a sign test: per-unit application skips
 * the cut chooser, so a legitimately applied unit cut may carry `net <= 0`. It
 * prices one request (freed − kept − receipt), not the standing delta
 * (freed − receipt), which is what shrinks every later request (ISSUE-083).
 */
function checkRevertPayload(value: unknown): void {
  const payload = record(value, "revert payload");
  const cutIndex = payload["cutIndex"], survivors = payload["survivors"], cost = payload["cost"];
  if (!isCount(cutIndex)) {
    throw new LedgerError("hash-mismatch", "Revert payload cut index must be a non-negative integer");
  }
  if (!Array.isArray(survivors) || survivors.some(id => typeof id !== "string" || id.length === 0)) {
    throw new LedgerError("hash-mismatch", "Revert payload survivors must be non-empty node ids");
  }
  if (new Set(survivors as string[]).size !== survivors.length) {
    throw new LedgerError("hash-mismatch", "Revert payload survivors repeat a node id");
  }
  const numbers = record(cost, "revert cost");
  const costCut = numbers["cutIndex"], freedBytes = numbers["freedBytes"];
  const keptBytes = numbers["keptBytes"], receiptBytes = numbers["receiptBytes"];
  const netFreedBytes = numbers["netFreedBytes"];
  if (!isCount(costCut)) {
    throw new LedgerError("hash-mismatch", "Revert cost cut index must be a non-negative integer");
  }
  if (!isCount(freedBytes) || !isCount(keptBytes) || !isCount(receiptBytes)) {
    throw new LedgerError("hash-mismatch", "Revert cost byte counts must be non-negative integers");
  }
  if (typeof netFreedBytes !== "number" || !Number.isSafeInteger(netFreedBytes)) {
    throw new LedgerError("hash-mismatch", "Revert cost net bytes must be an integer");
  }
  if (costCut !== cutIndex) {
    throw new LedgerError("hash-mismatch", "Revert cost cut index differs from the plan");
  }
  if (netFreedBytes !== freedBytes - keptBytes - receiptBytes) {
    throw new LedgerError("hash-mismatch", "Revert cost net bytes disagree with the salvage arithmetic");
  }
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LedgerError("hash-mismatch", `Revert ${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The shared encoder rejects non-plain data with TypeError; this seam reports its own code. */
function applicationHashBytes(material: unknown): Bytes {
  try { return canonicalBytesWithByteArrays(material); }
  catch (error) {
    throw error instanceof LedgerError ? error
      : new LedgerError("hash-mismatch", "Invalid application hash material", { cause: error });
  }
}
