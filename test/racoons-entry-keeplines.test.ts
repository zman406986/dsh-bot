import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_CONFIG, planEntryShape, sha256Sync, toBytes, UnitTracker,
} from "@racoons/core";
import type {
  CapabilityFlags, EngineInput, EntryAnswer, EntryShapePlan, RulePlan,
  SessionSnapshot, ToolResultNode, ValidationIssue,
} from "@racoons/core";
import { checkShape } from "../vendor/racoons/core/lib/guard/checks-entry-shape.js";
import type { CheckContext } from "../vendor/racoons/core/lib/guard/context.js";
import type { ShapeOp } from "../vendor/racoons/core/lib/rules/types.js";

/**
 * Ticket 220 — an empty `keeplines` selection is refused before it plans a
 * whole-body removal, and the entry-shape guard binds a plan's kept ranges to
 * the answer's own selection for keepall and keeplines (ticket 220).
 *
 * The guard check is called directly: no adapter or wire parser repairs the
 * hand-built answer this test supplies, which is the path the ticket names.
 */

const SESSION_ID = "session-220";
const RESULT_ID = "result-220";

function landedResult(): ToolResultNode {
  const bytes = toBytes("alpha\nbeta\ngamma\ndelta\n");
  const sha256 = sha256Sync(bytes);
  return {
    kind: "tool-result",
    id: RESULT_ID,
    turnOrdinal: 1,
    stepOrdinal: 1,
    bytes,
    sha256,
    byteLength: bytes.length,
    callId: "call-220",
    evidence: {
      kind: "other",
      target: null,
      paths: [],
      source: { nodeId: RESULT_ID, sha256, byteLength: bytes.length },
      sourceRecallId: null,
    },
    embeddedRecords: [],
  };
}

const node = landedResult();
const snapshot: SessionSnapshot = {
  sessionId: SESSION_ID,
  revision: "rev-220",
  currentTurnOrdinal: 1,
  completedThroughTurnOrdinal: 1,
  currentStepOrdinal: 1,
  nodes: [node],
  cache: { kind: "unknown" },
  retentionEvidence: [],
};
const unit = new UnitTracker({ sessionId: SESSION_ID, barBytes: 0 }).unitsFor(node)[0];
assert.ok(unit);
const unitId = unit.id;

const capabilities: CapabilityFlags = {
  mutateResult: true, rewriteHistory: true, atRest: false, liveTokens: false,
  log: false, appendRecords: false, rehydrateOnResume: false,
};

function plan(answer: EntryAnswer): EntryShapePlan {
  return planEntryShape({
    unitId,
    nodeId: node.id,
    originalBytes: node.bytes,
    answer,
  }, snapshot);
}

/** The guard check over one supplied plan and one supplied answer. */
function guardIssues(rulePlan: RulePlan, answer: EntryAnswer): readonly ValidationIssue[] {
  const op = rulePlan.operations.find((operation): operation is ShapeOp =>
    operation.kind === "shape");
  assert.ok(op, "the plan carries a shape operation");
  const removal = rulePlan.removals.find(item => item.id === op.removalId);
  assert.ok(removal, "the plan carries the shape operation's removal");
  const input: EngineInput = {
    kind: "entry", eventId: "event-220", result: node, answer,
    stamp: { unitId, answeredInRound: 0 },
  };
  const context: CheckContext = {
    value: {
      input, snapshot, capabilities, config: DEFAULT_CONFIG, plans: [rulePlan],
      sealedEpisodeIds: [], nowMs: 1,
    },
    nodes: new Map([[node.id, node]]),
    episodes: [],
    freshStart: 0,
    issues: [],
  };
  const issues: ValidationIssue[] = [];
  checkShape(context, op, removal, (code, detail, nodeId) => {
    issues.push({ code, detail, ruleId: null, operationIndex: null, nodeId: nodeId ?? null });
  });
  return issues;
}

describe("entry keeplines selection (ticket 220)", () => {
  it("refuses an empty keeplines selection instead of planning a whole-body removal", () => {
    const empty = plan({ action: "keeplines", ranges: [], summary: "No lines selected" });
    assert.equal(empty.action, "refuse");
    assert.equal(empty.code, "keeps-no-line");
  });

  it("accepts a coherent keeplines shape and refuses one whose kept ranges contradict the answer", () => {
    const shaped = plan({
      action: "keeplines", ranges: [{ from: 1, to: 2 }], summary: "kept the first two",
    });
    assert.equal(shaped.action, "shape");
    if (shaped.action !== "shape") return;

    assert.deepEqual(guardIssues(shaped.plan, {
      action: "keeplines", ranges: [{ from: 1, to: 2 }], summary: "kept the first two",
    }), []);

    const contradictory = guardIssues(shaped.plan, {
      action: "keeplines", ranges: [{ from: 3, to: 4 }], summary: "kept the last two",
    });
    assert.ok(contradictory.length > 0,
      "a plan that keeps other lines than the keeplines answer names is refused");
  });

  it("refuses a shape plan under a keepall answer", () => {
    const shaped = plan({
      action: "keeplines", ranges: [{ from: 1, to: 2 }], summary: "kept the first two",
    });
    assert.equal(shaped.action, "shape");
    if (shaped.action !== "shape") return;
    assert.ok(guardIssues(shaped.plan, { action: "keepall" }).length > 0,
      "keepall plans no shape, so a provided shape plan contradicts it");
  });

  it("refuses a forgetall shape that keeps lines", () => {
    const shaped = plan({
      action: "keeplines", ranges: [{ from: 1, to: 2 }], summary: "kept the first two",
    });
    assert.equal(shaped.action, "shape");
    if (shaped.action !== "shape") return;
    assert.ok(guardIssues(shaped.plan, {
      action: "forgetall", summary: "dropped the whole result",
    }).length > 0, "forgetall keeps no line, so a partly-kept shape contradicts it");
  });

  it("keeps a valid forgetall shape's whole-body selection", () => {
    const shaped = plan({ action: "forgetall", summary: "dropped the whole result" });
    assert.equal(shaped.action, "shape");
    if (shaped.action !== "shape") return;
    assert.deepEqual(shaped.keptRanges, []);
    assert.deepEqual(guardIssues(shaped.plan, { action: "forgetall", summary: "dropped the whole result" }), []);
  });
});
