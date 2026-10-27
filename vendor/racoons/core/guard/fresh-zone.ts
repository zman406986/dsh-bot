import type { RacoonsConfig } from "../config.js";
import type { FreshZone, SessionSnapshot } from "../types/transcript.js";

/**
 * The fresh-zone and cold-boundary arithmetic the guard and the planner share.
 *
 * This module is measurement only (ADR-0020). It answers where the live suffix
 * of the transcript begins and whether a cold boundary can be believed; it
 * never decides which content is kept or forgotten. The automatic protection
 * layer that used to live beside it is deleted: above the size floor the
 * agent's own answer is the only decider, and no class of content is refused.
 */

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
