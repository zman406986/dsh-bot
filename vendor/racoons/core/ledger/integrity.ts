import type { Bytes, Sha256 } from "../types/identity.js";
import { canonicalManifestBytes } from "../util/bytes.js";
import { sha256 } from "../util/hash.js";
import { LedgerError } from "./types.js";

export function assertHash(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new LedgerError("hash-mismatch", "Expected lowercase SHA-256");
  }
}

export async function verifyBytes(
  bytes: Bytes, hash: Sha256, length: number = bytes.byteLength,
): Promise<void> {
  assertHash(hash);
  if (bytes.byteLength !== length || await sha256(bytes) !== hash) {
    throw new LedgerError("hash-mismatch", `Content does not match ${hash}`);
  }
}

export function storageError(error: unknown, message: string): LedgerError {
  return error instanceof LedgerError
    ? error : new LedgerError("storage", message, { cause: error });
}

export function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === code;
}

/**
 * Stable JSON for immutable metadata and event comparison; never stores bytes.
 * Decodes `canonicalManifestBytes` from util/bytes.ts, the single canonical
 * encoder, and maps its TypeError to a storage LedgerError. No second encoding.
 */
export function stableJson(value: unknown): string {
  try { return new TextDecoder().decode(canonicalManifestBytes(value)); }
  catch (error) { throw storageError(error, "Metadata must contain only finite JSON values"); }
}
