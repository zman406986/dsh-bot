import type { ByteRange, LineRange } from "../types/identity.js";

export function splitLineOffsets(bytes: Uint8Array): ByteRange[] {
  const offsets: ByteRange[] = [];
  let startByte = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0a) {
      offsets.push({ startByte, endByteExclusive: index + 1 });
      startByte = index + 1;
    }
  }
  if (startByte < bytes.byteLength) {
    offsets.push({ startByte, endByteExclusive: bytes.byteLength });
  }
  return offsets;
}

export function lineCount(bytes: Uint8Array): number {
  return splitLineOffsets(bytes).length;
}

export function byteRangeForLines(
  bytes: Uint8Array,
  lines: readonly LineRange[],
): ByteRange[] {
  const offsets = splitLineOffsets(bytes);
  const ranges: ByteRange[] = [];
  let previousEndLine = 0;
  for (const { startLine, endLineInclusive } of lines) {
    if (
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLineInclusive) ||
      startLine < 1 ||
      endLineInclusive < startLine ||
      endLineInclusive > offsets.length ||
      startLine <= previousEndLine
    ) {
      throw new RangeError("Line ranges must be in bounds, ordered, and non-overlapping.");
    }
    const first = offsets[startLine - 1];
    const last = offsets[endLineInclusive - 1];
    if (first === undefined || last === undefined) {
      throw new RangeError("Line range does not identify existing lines.");
    }
    ranges.push({ startByte: first.startByte, endByteExclusive: last.endByteExclusive });
    previousEndLine = endLineInclusive;
  }
  return mergeByteRanges(bytes.byteLength, ranges);
}

export function complementByteRanges(
  totalBytes: number,
  keep: readonly ByteRange[],
): ByteRange[] {
  const retained = mergeByteRanges(totalBytes, keep);
  const omitted: ByteRange[] = [];
  let startByte = 0;
  for (const range of retained) {
    if (startByte < range.startByte) {
      omitted.push({ startByte, endByteExclusive: range.startByte });
    }
    startByte = range.endByteExclusive;
  }
  if (startByte < totalBytes) {
    omitted.push({ startByte, endByteExclusive: totalBytes });
  }
  return omitted;
}

function mergeByteRanges(totalBytes: number, ranges: readonly ByteRange[]): ByteRange[] {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    throw new RangeError("Total bytes must be a non-negative safe integer.");
  }
  const merged: ByteRange[] = [];
  let previousEndByte = 0;
  for (const { startByte, endByteExclusive } of ranges) {
    if (
      !Number.isSafeInteger(startByte) ||
      !Number.isSafeInteger(endByteExclusive) ||
      startByte < 0 ||
      endByteExclusive <= startByte ||
      endByteExclusive > totalBytes ||
      startByte < previousEndByte
    ) {
      throw new RangeError("Byte ranges must be nonempty, in bounds, ordered, and non-overlapping.");
    }
    const previous = merged[merged.length - 1];
    if (previous !== undefined && previous.endByteExclusive === startByte) {
      merged[merged.length - 1] = { startByte: previous.startByte, endByteExclusive };
    } else {
      merged.push({ startByte, endByteExclusive });
    }
    previousEndByte = endByteExclusive;
  }
  return merged;
}
