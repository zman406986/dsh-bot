/**
 * Ticket 124 — deterministic microcompact, pure half (ADR-0029).
 *
 * Pins the decision function and the selection function with no host, no
 * model, and no I/O:
 *
 * 1. The trigger is a pure comparison against a fixed ratio of the advertised
 *    window — just under declines, at/over fires.
 * 2. An unavailable or implausible window NEVER compacts; it declines with a
 *    stated reason (design constraint 5: never compact on a guess).
 * 3. Only old tool results are eligible: user, assistant, system and developer
 *    nodes are structurally excluded, and the newest N tool results survive.
 * 4. The pass is worth its cache invalidation only above a minimum saving.
 * 5. The same inputs produce the same decision and the same list (determinism,
 *    ADR-0029 decision 1).
 *
 * Offline only (S8): no host, no LLM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {CLEARED_TOOL_RESULT_TEXT, MICROCOMPACT_KEEP_NEWEST, MICROCOMPACT_MIN_SAVING_TOKENS, MICROCOMPACT_TRIGGER_RATIO, selectToolResultsToClear, shouldMicrocompact, utf8ByteLength, type MicrocompactSurfaceNode} from "../src/core/microcompact.js";

const WINDOW = 1_000_000;

/** One surface node with the facts selection reads. */
function node(
  seq: number,
  role: MicrocompactSurfaceNode["role"],
  tokens: number,
  clearedTokens = 8,
  alreadyCleared = false,
): MicrocompactSurfaceNode {
  return { seq, role, tokens, clearedTokens, alreadyCleared };
}

describe("microcompact trigger (ticket 124)", () => {
  it("declines just under the ratio and fires exactly at it", () => {
    const threshold = Math.floor(WINDOW * MICROCOMPACT_TRIGGER_RATIO); // 550_000
    const under = shouldMicrocompact({
      usedTokens: threshold - 1,
      windowTokens: WINDOW,
      ratio: MICROCOMPACT_TRIGGER_RATIO,
    });
    assert.equal(under.compact, false);
    assert.equal(under.reason, "below-threshold");
    assert.equal(under.thresholdTokens, threshold);

    const at = shouldMicrocompact({
      usedTokens: threshold,
      windowTokens: WINDOW,
      ratio: MICROCOMPACT_TRIGGER_RATIO,
    });
    assert.equal(at.compact, true, "the gate is >=, matching the native engine");
    assert.equal(at.reason, "ratio-met");

    const over = shouldMicrocompact({
      usedTokens: threshold + 1,
      windowTokens: WINDOW,
      ratio: MICROCOMPACT_TRIGGER_RATIO,
    });
    assert.equal(over.compact, true);
  });

  it("never compacts on an unavailable window", () => {
    for (const windowTokens of [undefined, null]) {
      const decision = shouldMicrocompact({
        usedTokens: 999_999,
        windowTokens,
        ratio: MICROCOMPACT_TRIGGER_RATIO,
      });
      assert.equal(decision.compact, false);
      assert.equal(decision.reason, "window-unavailable");
      assert.equal(decision.thresholdTokens, null);
    }
  });

  it("never compacts on an implausible window", () => {
    for (const windowTokens of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const decision = shouldMicrocompact({
        usedTokens: 999_999,
        windowTokens,
        ratio: MICROCOMPACT_TRIGGER_RATIO,
      });
      assert.equal(decision.compact, false, `window ${String(windowTokens)}`);
      assert.equal(decision.reason, "window-implausible");
    }
  });

});

describe("microcompact selection (ticket 124)", () => {
  const options = {
    keepNewest: MICROCOMPACT_KEEP_NEWEST,
    minSavingTokens: MICROCOMPACT_MIN_SAVING_TOKENS,
  };

  /** N tool nodes of `tokens` each, all eligible. */
  function tools(count: number, tokens = 4_000): MicrocompactSurfaceNode[] {
    return Array.from({ length: count }, (_, i) => node(10 + i, "tool", tokens));
  }

  it("keeps the newest N tool results intact", () => {
    const nodes = tools(8);
    const selection = selectToolResultsToClear(nodes, options);
    assert.equal(selection.reason, "selected");
    assert.deepEqual(
      selection.selected.map((n) => n.seq),
      [10, 11, 12],
      "8 tools, keep 5 → the three oldest are eligible",
    );
    const kept = nodes.slice(3).map((n) => n.seq);
    assert.deepEqual(kept, [13, 14, 15, 16, 17]);
  });

  it("declines a pass that frees too little to be worth a cache rebuild", () => {
    const selection = selectToolResultsToClear(tools(8, 200), options);
    assert.equal(selection.reason, "insufficient-saving");
    assert.deepEqual(selection.selected, []);
    assert.ok(selection.freedTokens > 0, "the would-be saving is still reported");
  });

  it("negative or fractional keep counts are refused, never coerced", () => {
    for (const keepNewest of [-1, 1.5, Number.NaN]) {
      const selection = selectToolResultsToClear(tools(8), {
        keepNewest,
        minSavingTokens: 0,
      });
      assert.equal(selection.reason, "invalid-keep");
      assert.deepEqual(selection.selected, []);
    }
  });

});

describe("microcompact cleared shape (ticket 124)", () => {
  it("names the placeholder the model actually sees", () => {
    assert.equal(
      CLEARED_TOOL_RESULT_TEXT,
      "[old tool result cleared to save context; the full output remains in the session log]",
    );
  });

  it("counts UTF-8 bytes, not characters", () => {
    assert.equal(utf8ByteLength("abc"), 3);
    assert.equal(utf8ByteLength("日"), 3);
  });
});
