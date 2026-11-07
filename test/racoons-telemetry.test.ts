import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarize } from "@racoons/core";
import type {
  ForcedLossObservation, LedgerEntry, MeterReading, SessionSnapshot,
} from "@racoons/core";

/**
 * Ticket 238 — the first distinct forced-loss observation already carries the
 * true pre-loss count. Without a preceding usage reading, the summary must use
 * that count rather than dropping it; the usage fallback stays for observations
 * that have no count of their own.
 */

const snapshot = (): SessionSnapshot => ({
  sessionId: "ticket-238",
  revision: "0",
  currentTurnOrdinal: 1,
  completedThroughTurnOrdinal: 0,
  currentStepOrdinal: 0,
  nodes: [],
  cache: { kind: "unknown" },
  retentionEvidence: [],
});

const loss = (nativeEventId: string, inputTokensBefore: number | null): ForcedLossObservation => ({
  kind: "forced-loss",
  nativeEventId,
  turnOrdinal: 1,
  inputTokensBefore,
  inputTokensAfter: 100_000,
});

const usage = (requestId: string, inputTokens: number): MeterReading => ({
  requestId,
  revision: "0",
  estimatedInputTokens: inputTokens,
  inputTokens,
  outputTokens: 0,
  cachedInputTokens: null,
  estimateErrorTokens: 0,
  cachedInputShare: null,
});

const entries: readonly LedgerEntry[] = [];

describe("first forced-loss token count (ticket 238)", () => {
  it("uses the first loss's own count when no usage was observed", () => {
    const summary = summarize(snapshot(), entries, [loss("loss-1", 300_000)]);
    assert.equal(summary.forcedLossCount, 1);
    assert.equal(summary.tokensAtFirstForcedLoss, 300_000);
  });

  it("keeps null when neither the loss nor a usage reading has a count", () => {
    const summary = summarize(snapshot(), entries, [loss("loss-1", null)]);
    assert.equal(summary.forcedLossCount, 1);
    assert.equal(summary.tokensAtFirstForcedLoss, null);
  });

  it("falls back to the latest preceding usage reading", () => {
    const summary = summarize(snapshot(), entries,
      [usage("usage-1", 250_000), loss("loss-1", null)]);
    assert.equal(summary.tokensAtFirstForcedLoss, 250_000);
  });

  it("prefers the loss's own count over a preceding usage reading", () => {
    const summary = summarize(snapshot(), entries,
      [usage("usage-1", 250_000), loss("loss-1", 300_000)]);
    assert.equal(summary.tokensAtFirstForcedLoss, 300_000);
  });

  it("does not retroactively replace an unknown first-loss count", () => {
    const summary = summarize(snapshot(), entries,
      [loss("loss-1", null), usage("usage-1", 250_000), loss("loss-2", 400_000)]);
    assert.equal(summary.forcedLossCount, 2);
    assert.equal(summary.tokensAtFirstForcedLoss, null);
  });

  it("counts a duplicate native event once without replacing the first count", () => {
    const summary = summarize(snapshot(), entries,
      [loss("loss-1", 300_000), loss("loss-1", 900_000)]);
    assert.equal(summary.forcedLossCount, 1);
    assert.equal(summary.tokensAtFirstForcedLoss, 300_000);
  });

  it("preserves a measured zero before-count instead of treating it as absent", () => {
    const summary = summarize(snapshot(), entries, [loss("loss-1", 0)]);
    assert.equal(summary.tokensAtFirstForcedLoss, 0);
  });
});
