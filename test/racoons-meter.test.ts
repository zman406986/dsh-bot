import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Meter } from "@racoons/core";
import type { MeterReading } from "@racoons/core";

/**
 * Ticket 235 — a measured cached-input count of zero is a known zero share,
 * not an absent measurement. Only an unknown cached count or empty input makes
 * `cachedInputShare` null.
 */

function reconcile(inputTokens: number, cachedInputTokens: number | null): MeterReading {
  const meter = new Meter({ estimate: () => 0 });
  return meter.reconcile({
    kind: "usage",
    requestId: "ticket-235",
    revision: "0",
    estimatedInputTokens: inputTokens,
    usage: { inputTokens, outputTokens: 0, cachedInputTokens },
  });
}

describe("meter cache share (ticket 235)", () => {
  it("reports a measured zero cached count as share 0", () => {
    const reading = reconcile(100, 0);
    assert.equal(reading.cachedInputShare, 0);
    assert.equal(reading.cachedInputTokens, 0);
    assert.equal(reading.inputTokens, 100);
  });

  it("keeps an unknown cached count as null", () => {
    assert.equal(reconcile(100, null).cachedInputShare, null);
  });

  it("keeps a positive cached count as its fraction", () => {
    assert.equal(reconcile(100, 25).cachedInputShare, 0.25);
  });

  it("keeps an empty input ratio undefined", () => {
    assert.equal(reconcile(0, 0).cachedInputShare, null);
  });

  it("preserves the raw token counts for a measured zero", () => {
    const meter = new Meter({ estimate: () => 0 });
    const reading = meter.reconcile({
      kind: "usage",
      requestId: "raw-counts",
      revision: "3",
      estimatedInputTokens: 90,
      usage: { inputTokens: 100, outputTokens: 7, cachedInputTokens: 0 },
    });
    assert.deepEqual(
      {
        inputTokens: reading.inputTokens,
        outputTokens: reading.outputTokens,
        cachedInputTokens: reading.cachedInputTokens,
        estimateErrorTokens: reading.estimateErrorTokens,
      },
      { inputTokens: 100, outputTokens: 7, cachedInputTokens: 0, estimateErrorTokens: 10 },
    );
  });
});
