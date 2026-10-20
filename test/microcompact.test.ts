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
import {
  CLEARED_TOOL_RESULT_TEXT,
  MICROCOMPACT_KEEP_NEWEST,
  MICROCOMPACT_MIN_SAVING_TOKENS,
  MICROCOMPACT_TRIGGER_RATIO,
  isClearedToolResultContent,
  selectToolResultsToClear,
  shouldMicrocompact,
  utf8ByteLength,
  type MicrocompactSurfaceNode,
} from "../src/core/microcompact.js";

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

  it("the ratio fires below the native summary threshold on the live route", () => {
    // dsh-compaction-basic: floor(min(W*0.8, W - 256_000 - 65_536)) = 678_464.
    const nativeThreshold = Math.floor(
      Math.min(WINDOW * 0.8, WINDOW - 256_000 - 65_536),
    );
    assert.equal(nativeThreshold, 678_464);
    const ours = Math.floor(WINDOW * MICROCOMPACT_TRIGGER_RATIO);
    assert.ok(
      ours < nativeThreshold,
      `microcompact (${ours}) must fire before native (${nativeThreshold})`,
    );
    // And not so early that it runs during ordinary work.
    assert.ok(ours > WINDOW * 0.5);
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

  it("never compacts on an implausible measurement", () => {
    for (const usedTokens of [undefined, null, Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const decision = shouldMicrocompact({
        usedTokens,
        windowTokens: WINDOW,
        ratio: MICROCOMPACT_TRIGGER_RATIO,
      });
      assert.equal(decision.compact, false, `usage ${String(usedTokens)}`);
      assert.equal(decision.reason, "usage-unavailable");
    }
  });

  it("never compacts on an implausible ratio", () => {
    for (const ratio of [0, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const decision = shouldMicrocompact({
        usedTokens: 999_999,
        windowTokens: WINDOW,
        ratio,
      });
      assert.equal(decision.compact, false, `ratio ${String(ratio)}`);
      assert.equal(decision.reason, "ratio-implausible");
    }
  });

  it("is deterministic: identical inputs give identical decisions", () => {
    const input = {
      usedTokens: 600_000,
      windowTokens: WINDOW,
      ratio: MICROCOMPACT_TRIGGER_RATIO,
    };
    const first = shouldMicrocompact(input);
    for (let i = 0; i < 20; i += 1) {
      assert.deepEqual(shouldMicrocompact(input), first);
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

  it("with exactly N tools nothing is eligible", () => {
    const selection = selectToolResultsToClear(tools(MICROCOMPACT_KEEP_NEWEST), options);
    assert.equal(selection.reason, "nothing-eligible");
    assert.deepEqual(selection.selected, []);
  });

  it("with fewer than N tools nothing is eligible", () => {
    const selection = selectToolResultsToClear(tools(2), options);
    assert.equal(selection.reason, "nothing-eligible");
  });

  it("user, assistant, system and developer nodes are never eligible", () => {
    const nodes: MicrocompactSurfaceNode[] = [
      node(1, "system", 9_000),
      node(2, "developer", 9_000),
      node(3, "user", 90_000),
      node(4, "assistant", 90_000),
      node(5, "user", 90_000),
      ...tools(MICROCOMPACT_KEEP_NEWEST),
    ];
    const selection = selectToolResultsToClear(nodes, options);
    assert.equal(
      selection.reason,
      "nothing-eligible",
      "non-tool nodes are structurally excluded, not merely deprioritized",
    );
    assert.ok(
      !selection.selected.some((n) => n.role !== "tool"),
      "no non-tool node may ever be selected",
    );
  });

  it("only tool nodes are selected even when big non-tool nodes sit oldest", () => {
    const nodes: MicrocompactSurfaceNode[] = [
      node(1, "system", 9_000),
      node(2, "user", 500_000),
      node(3, "assistant", 400_000),
      ...tools(8),
    ];
    const selection = selectToolResultsToClear(nodes, options);
    assert.equal(selection.reason, "selected");
    assert.deepEqual(selection.selected.map((n) => n.seq), [10, 11, 12]);
    assert.ok(selection.selected.every((n) => n.role === "tool"));
  });

  it("stops as soon as the minimum saving is covered", () => {
    const nodes = tools(12, 4_000);
    const selection = selectToolResultsToClear(nodes, options);
    // 4_000 - 8 = 3_992 per node; 3 nodes ≈ 11_976 ≥ 8_192.
    assert.equal(selection.selected.length, 3);
    assert.ok(selection.freedTokens >= MICROCOMPACT_MIN_SAVING_TOKENS);
  });

  it("declines a pass that frees too little to be worth a cache rebuild", () => {
    const selection = selectToolResultsToClear(tools(8, 200), options);
    assert.equal(selection.reason, "insufficient-saving");
    assert.deepEqual(selection.selected, []);
    assert.ok(selection.freedTokens > 0, "the would-be saving is still reported");
  });

  it("already-cleared nodes are skipped, so a repeat pass is a no-op", () => {
    const mixed = [
      node(10, "tool", 8, 8, true),
      node(11, "tool", 5_000),
      node(12, "tool", 5_000),
      ...Array.from({ length: MICROCOMPACT_KEEP_NEWEST }, (_, i) =>
        node(13 + i, "tool", 4_000),
      ),
    ];
    const selection = selectToolResultsToClear(mixed, options);
    assert.equal(selection.reason, "selected");
    assert.deepEqual(
      selection.selected.map((n) => n.seq),
      [11, 12],
      "the cleared node is not cleared again",
    );

    const allCleared = [
      node(10, "tool", 8, 8, true),
      node(11, "tool", 8, 8, true),
      ...Array.from({ length: MICROCOMPACT_KEEP_NEWEST }, (_, i) =>
        node(12 + i, "tool", 4_000),
      ),
    ];
    assert.equal(
      selectToolResultsToClear(allCleared, options).reason,
      "nothing-eligible",
    );
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

  it("is deterministic: the same list and options give the same selection", () => {
    const nodes = tools(9);
    const first = selectToolResultsToClear(nodes, options);
    for (let i = 0; i < 10; i += 1) {
      assert.deepEqual(selectToolResultsToClear(nodes, options), first);
    }
  });

  it("selection is oldest-first", () => {
    const selection = selectToolResultsToClear(tools(9), {
      keepNewest: 2,
      minSavingTokens: 8_192,
    });
    const seqs = selection.selected.map((n) => n.seq);
    assert.deepEqual([...seqs].sort((a, b) => a - b), seqs);
  });
});

describe("microcompact cleared shape (ticket 124)", () => {
  it("names the placeholder the model actually sees", () => {
    assert.equal(
      CLEARED_TOOL_RESULT_TEXT,
      "[old tool result cleared to save context; the full output remains in the session log]",
    );
  });

  it("recognizes exactly the cleared content and nothing else", () => {
    assert.equal(
      isClearedToolResultContent([{ type: "text", text: CLEARED_TOOL_RESULT_TEXT }]),
      true,
    );
    assert.equal(isClearedToolResultContent([{ type: "text", text: "real output" }]), false);
    assert.equal(isClearedToolResultContent([]), false);
    assert.equal(isClearedToolResultContent(undefined), false);
    assert.equal(
      isClearedToolResultContent([
        { type: "text", text: CLEARED_TOOL_RESULT_TEXT },
        { type: "text", text: "extra" },
      ]),
      false,
      "only a single placeholder block counts as cleared",
    );
  });

  it("counts UTF-8 bytes, not characters", () => {
    assert.equal(utf8ByteLength("abc"), 3);
    assert.equal(utf8ByteLength("日"), 3);
  });
});
