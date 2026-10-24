import type { RacoonsConfig } from "../config.js";
import type { ByteRange, NodeId } from "../types/identity.js";
import type { FreshZone, SessionSnapshot } from "../types/transcript.js";

export interface ProtectedSet {
  readonly ranges: ReadonlyMap<NodeId, readonly ByteRange[]>;
  readonly recordRanges: ReadonlyMap<NodeId, readonly ByteRange[]>;
}
export function computeProtectedRanges(snapshot: SessionSnapshot): ProtectedSet {
  const ranges = new Map<NodeId, ByteRange[]>();
  const recordRanges = new Map<NodeId, ByteRange[]>();
  const add = (id: NodeId, range: ByteRange): void => {
    ranges.set(id, [...(ranges.get(id) ?? []), { ...range }]);
  };
  const ids = new Set([
    ...snapshot.protection.newestTailNodeIds,
    ...snapshot.protection.openApprovalNodeIds,
  ]);
  for (const node of snapshot.nodes) {
    const whole = { startByte: 0, endByteExclusive: node.bytes.length };
    if (node.kind === "message" || ids.has(node.id)
      || node.turnOrdinal === snapshot.protection.inFlightTurnOrdinal) add(node.id, whole);
    const records = node.kind === "racoons-record" ? [whole]
      : node.kind === "tool-result" ? node.embeddedRecords.map(r => ({ ...r })) : [];
    if (records.length > 0) recordRanges.set(node.id, records);
    for (const record of records) add(node.id, record);
  }
  // Explicit IDs remain protected even when the snapshot is malformed or incomplete.
  for (const id of ids) if (!ranges.has(id)) {
    add(id, { startByte: 0, endByteExclusive: Number.MAX_SAFE_INTEGER });
  }
  for (const span of [...snapshot.protection.policySpans, ...snapshot.protection.quotedThisTurn]) {
    add(span.source.nodeId, span.range);
  }
  return { ranges, recordRanges };
}
export function verifiedCold(snapshot: SessionSnapshot, nowMs?: number): boolean {
  if (snapshot.cache.kind !== "cold") return false;
  const boundary = snapshot.cache.boundary;
  return ["resume", "idle-past-ttl", "model-switch"].includes(boundary.kind)
    && Number.isFinite(boundary.observedAtMs) && boundary.observedAtMs >= 0
    && (nowMs === undefined || boundary.observedAtMs <= nowMs);
}
export function computeFreshZone(snapshot: SessionSnapshot, config: RacoonsConfig): FreshZone {
  const n = snapshot.nodes.length;
  // ADR-0012: an unknown cache state carries no fresh-zone floor. The host never
  // supplied a watermark, so there is none to protect; a removal applies
  // wherever the bank can restore it. The warm path below is the only fence.
  let start = snapshot.cache.kind === "unknown" ? 0 : n;
  if (snapshot.cache.kind === "warm") {
    const watermark = snapshot.cache.watermarkNodeIndex;
    if (Number.isSafeInteger(watermark) && watermark >= 0 && watermark <= n) start = watermark;
  } else if (verifiedCold(snapshot)) start = 0;
  const maxNodes = config.freshZone.maxNodes;
  if (maxNodes !== null) start = Number.isSafeInteger(maxNodes) && maxNodes >= 0
    ? Math.max(start, n - maxNodes) : n;
  const maxBytes = config.freshZone.maxBytes;
  if (maxBytes !== null) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) start = n;
    else {
      let bytes = 0, suffixStart = n;
      while (suffixStart > start) {
        const node = snapshot.nodes[suffixStart - 1];
        if (node === undefined || bytes + node.bytes.length > maxBytes) break;
        bytes += node.bytes.length; suffixStart--;
      }
      start = Math.max(start, suffixStart);
    }
  }
  return { startNodeIndex: start, endNodeIndexExclusive: n };
}
