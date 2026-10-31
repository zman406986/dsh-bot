import type { ByteRange, Bytes } from "../types/identity.js";
import {
  canonicalBytesWithByteArrays, concatBytes, equalBytes,
} from "../util/bytes.js";
import { sha256Sync } from "../util/hash.js";

/** Single SHA-256 implementation, owned by util/hash.ts. */
export const digest = sha256Sync;
/** Single byte-equality implementation, owned by util/bytes.ts. */
export const equal = equalBytes;
export const length = (r: ByteRange): number => r.endByteExclusive - r.startByte;
export const overlaps = (a: ByteRange, b: ByteRange): boolean =>
  a.startByte < b.endByteExclusive && b.startByte < a.endByteExclusive;
export function validRange(r: ByteRange, size: number): boolean {
  return Number.isSafeInteger(r.startByte) && Number.isSafeInteger(r.endByteExclusive)
    && r.startByte >= 0 && r.endByteExclusive > r.startByte && r.endByteExclusive <= size;
}
/** Delegates to util/bytes.ts; the array argument order is kept for guard call sites. */
export function join(parts: readonly Bytes[]): Bytes {
  return concatBytes(...parts);
}
/**
 * Gaps left by `ranges`. Unlike `complementByteRanges` in util/lines.ts this
 * does not merge adjacent ranges, because the guard compares retained coverage
 * exactly as the plan declared it.
 */
export function complement(ranges: readonly ByteRange[], size: number): ByteRange[] {
  const result: ByteRange[] = [];
  let cursor = 0;
  for (const r of ranges) {
    if (!validRange(r, size) || r.startByte < cursor) throw new Error("Unordered or invalid ranges");
    if (r.startByte > cursor) result.push({ startByte: cursor, endByteExclusive: r.startByte });
    cursor = r.endByteExclusive;
  }
  if (cursor < size) result.push({ startByte: cursor, endByteExclusive: size });
  return result;
}
export function sameRanges(a: readonly ByteRange[], b: readonly ByteRange[]): boolean {
  return a.length === b.length && a.every((r, i) => {
    const other = b[i];
    return other !== undefined && r.startByte === other.startByte
      && r.endByteExclusive === other.endByteExclusive;
  });
}
/**
 * Canonical bytes for application hashes and guard evidence comparison.
 * Encodes Uint8Array leaves as number arrays; for plain JSON input it emits the
 * same bytes as `canonicalManifestBytes`. Persisted recall manifests use
 * `canonicalManifestBytes` directly, so a manifest hash never passes through here.
 */
export function canonicalApplicationBytes(value: unknown): Bytes {
  return canonicalBytesWithByteArrays(value);
}

/** @deprecated Use canonicalApplicationBytes; the old name hid that it encodes byte leaves. */
export const canonical = canonicalApplicationBytes;
