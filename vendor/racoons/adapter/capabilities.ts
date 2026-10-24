import type { CapabilityFlags } from '@racoons/core';

/** The flag set the shipped port implements with no optional seam supplied. */
const BASE = {
  // Tool-result delivery allows changing the body before transcript insertion.
  mutateResult: true,
  // No path rewrites history in place: the port answers rewrite/rehydrate with
  // `not-applied`/`unsupported`, and capability honesty means the flag says so
  // (ISSUE-010; ADR-0007).
  rewriteHistory: false,
  // No path rebuilds resume context from a reduced transcript.
  rehydrateOnResume: false,
  // The pre-step listener runs before the next model request.
  atRest: true,
  // The host meter exposes request usage and cached-input token counts.
  liveTokens: true,
  // storageDomain supplies a session-scoped sink for ledger records.
  log: true,
  // The transcript append seam accepts generated records without history changes.
  appendRecords: true,
} as const;

/**
 * Capability flags for this adapter build (design-protocol §4, Slice 4).
 *
 * `revertHistory` is true **only** when the shadow-replace seam was supplied:
 * absence is a refusal both in the guard (`revertHistory === true`) and in the
 * engine, never an assumption. `rewriteHistory` stays false because no path
 * rewrites in place, even with a revert seam: the revert is a shadow-replace
 * append, not a history rewrite.
 */
export function createDshCapabilities(revertHistory = false): CapabilityFlags {
  // `revertHistory: false` is present, not absent: the flag states that this
  // build declares no revert seam, and the design's acceptance line reads it.
  return Object.freeze({ ...BASE, revertHistory });
}

/**
 * The plain port build, for callers that wire no optional seam. Honest by
 * construction: it is `createDshCapabilities()` with no arguments.
 */
export const DSH_CAPABILITIES: CapabilityFlags = createDshCapabilities();

/**
 * The documented full-seam declaration: every flag true, including the ones the
 * shipped port cannot honour. **No runtime path uses it.** It exists so the gap
 * between "declared" and "implemented" stays named rather than implied.
 */
export const DSH_FULL_SEAM_CAPABILITIES: CapabilityFlags = Object.freeze({
  ...BASE, rewriteHistory: true, rehydrateOnResume: true, revertHistory: true,
});
