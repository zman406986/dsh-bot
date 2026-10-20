import type {
  ByteRange, Bytes, RecallId, SessionId, Sha256, SourceRef,
} from "../types/identity.js";
import { canonicalManifestBytes } from "../util/bytes.js";
import { sha256 } from "../util/hash.js";
import { assertHash } from "./integrity.js";
import { LedgerError } from "./types.js";

export interface HashedRange {
  readonly range: ByteRange;
  readonly sha256: Sha256;
}

export interface RecallManifestPart {
  readonly source: SourceRef;
  readonly blobSha256: Sha256;
  readonly removedRanges: readonly HashedRange[];
}

export interface RecallManifest {
  readonly version: 1;
  readonly sessionId: SessionId;
  readonly parts: readonly RecallManifestPart[];
}

export interface RecallPart {
  readonly source: SourceRef;
  readonly bytes: Bytes;
  readonly removedRanges: readonly HashedRange[];
}

export interface RecallRecord {
  readonly id: RecallId;
  readonly manifestSha256: Sha256;
  readonly manifest: RecallManifest;
  readonly parts: readonly RecallPart[];
}

export type IndexedManifestPart = RecallManifestPart & {
  readonly part_index?: number;
};

export function buildRecallManifest(
  sessionId: SessionId, parts: readonly IndexedManifestPart[],
): RecallManifest;
export function buildRecallManifest(input: {
  readonly sessionId: SessionId; readonly parts: readonly IndexedManifestPart[];
}): RecallManifest;
export function buildRecallManifest(
  input: SessionId | { readonly sessionId: SessionId; readonly parts: readonly IndexedManifestPart[] },
  suppliedParts?: readonly IndexedManifestPart[],
): RecallManifest {
  const sessionId = typeof input === "string" ? input : input.sessionId;
  const parts = typeof input === "string" ? suppliedParts : input.parts;
  if (typeof sessionId !== "string" || parts === undefined) fail("Invalid manifest");
  const ordered = [...parts];
  if (ordered.some(part => part.part_index !== undefined)) {
    if (ordered.some(part => !Number.isSafeInteger(part.part_index) ||
        part.part_index === undefined || part.part_index < 0)) fail("Invalid part_index");
    ordered.sort((a, b) => (a.part_index ?? 0) - (b.part_index ?? 0));
    if (ordered.some((part, index) => part.part_index !== index)) fail("Noncontiguous part_index");
  }
  return { version: 1, sessionId, parts: ordered.map(part => {
    const { source } = part;
    if (typeof source.nodeId !== "string" || !Number.isSafeInteger(source.byteLength) ||
        source.byteLength < 0) fail("Invalid source reference");
    assertHash(source.sha256);
    assertHash(part.blobSha256);
    if (source.sha256 !== part.blobSha256) fail("Body hash differs from source hash");
    const ranges = part.removedRanges.map(span => ({
      range: { startByte: span.range.startByte, endByteExclusive: span.range.endByteExclusive },
      sha256: span.sha256,
    })).sort((a, b) => a.range.startByte - b.range.startByte ||
      a.range.endByteExclusive - b.range.endByteExclusive);
    let end = 0;
    for (const span of ranges) {
      const { startByte, endByteExclusive } = span.range;
      assertHash(span.sha256);
      if (!Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByteExclusive) ||
          startByte < end || endByteExclusive <= startByte ||
          endByteExclusive > source.byteLength) fail("Invalid or overlapping removed range");
      end = endByteExclusive;
    }
    return {
      source: { nodeId: source.nodeId, sha256: source.sha256, byteLength: source.byteLength },
      blobSha256: part.blobSha256, removedRanges: ranges,
    };
  }) };
}

/** The only encoding used for persisted manifests and manifest hashes. */
export function encodeRecallManifest(manifest: RecallManifest): Bytes {
  if (manifest.version !== 1) fail("Unsupported manifest version");
  return canonicalManifestBytes(buildRecallManifest(manifest));
}

export async function manifestSha256(manifest: RecallManifest): Promise<Sha256> {
  return sha256(encodeRecallManifest(manifest));
}

export function recallIdFor(manifestSha: Sha256): RecallId {
  assertHash(manifestSha);
  return `recall:sha256:${manifestSha}`;
}

export function parseRecallManifest(bytes: Bytes): RecallManifest {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const root = object(value);
    if (root.version !== 1 || typeof root.sessionId !== "string" || !Array.isArray(root.parts)) {
      return fail("Invalid manifest structure");
    }
    const parts: RecallManifestPart[] = root.parts.map((raw: unknown) => {
      const part = object(raw);
      const source = object(part.source);
      if (typeof source.nodeId !== "string" || typeof source.sha256 !== "string" ||
          typeof source.byteLength !== "number" || typeof part.blobSha256 !== "string" ||
          !Array.isArray(part.removedRanges)) return fail("Invalid manifest part");
      const removedRanges: HashedRange[] = part.removedRanges.map((rawSpan: unknown) => {
        const span = object(rawSpan);
        const range = object(span.range);
        if (typeof span.sha256 !== "string" || typeof range.startByte !== "number" ||
            typeof range.endByteExclusive !== "number") return fail("Invalid manifest range");
        return { range: { startByte: range.startByte,
          endByteExclusive: range.endByteExclusive }, sha256: span.sha256 };
      });
      return { source: { nodeId: source.nodeId, sha256: source.sha256,
        byteLength: source.byteLength }, blobSha256: part.blobSha256, removedRanges };
    });
    const manifest = buildRecallManifest(root.sessionId, parts);
    const canonical = encodeRecallManifest(manifest);
    if (bytes.length !== canonical.length || bytes.some((byte, i) => byte !== canonical[i])) {
      return fail("Manifest encoding is not canonical");
    }
    return manifest;
  } catch (error) {
    if (error instanceof LedgerError) throw error;
    throw new LedgerError("hash-mismatch", "Malformed recall manifest", { cause: error });
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("Expected manifest object");
  }
  return value as Record<string, unknown>;
}

function fail(message: string): never {
  throw new LedgerError("hash-mismatch", message);
}
