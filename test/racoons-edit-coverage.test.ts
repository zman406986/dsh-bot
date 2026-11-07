import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeInvalidation,
  DEFAULT_CONFIG,
  UnitTracker,
  withoutStaleCoverage,
} from "@racoons/core";
import type {
  CapabilityFlags,
  RulePlan,
  SessionSnapshot,
  ToolResultNode,
  ValidationIssue,
} from "@racoons/core";
import { deriveToolEvidence, toCoreEnvelope } from "racoons-dsh";
import type { DshEvidenceInput, DshResultFacts } from "racoons-dsh";
import { checkInvalidation } from "../vendor/racoons/core/lib/guard/checks-invalidation.js";
import type { CheckContext } from "../vendor/racoons/core/lib/guard/context.js";

/**
 * Ticket 187 — a preflight-rejected edit must not become a path-write fact.
 *
 * The installed edit tool rejects `old_string === new_string` before it resolves
 * a path or calls `editText`, so that failure proves no mutation. A later
 * invalidation pass must therefore keep an earlier same-path read covered and
 * its path-coverage row present. Successful writes and failed writes whose
 * mutation is unknown stay conservative: both still invalidate.
 */

const encoder = new TextEncoder();
const PATH = "src/a.ts";
const READ_BYTES = "export const a = 1;\nexport const b = 2;\n";
const SOURCE = { nodeId: "read-1", sha256: "a".repeat(64), byteLength: 1 };

interface ToolFixture {
  readonly id: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly result: DshResultFacts;
  readonly bytes: string;
  readonly step: number;
}

function evidenceOf(fixture: ToolFixture) {
  const item: DshEvidenceInput = {
    toolName: fixture.toolName,
    input: fixture.input,
    result: fixture.result,
  };
  return deriveToolEvidence(item, SOURCE);
}

function resultNode(fixture: ToolFixture): ToolResultNode {
  return toCoreEnvelope({
    id: fixture.id,
    role: "tool",
    callId: fixture.id,
    toolName: fixture.toolName,
    input: fixture.input,
    result: fixture.result,
    turnOrdinal: 1,
    stepOrdinal: fixture.step,
    bytes: encoder.encode(fixture.bytes),
  }, 0).node;
}

function readNode(): ToolResultNode {
  return resultNode({
    id: "read-1",
    toolName: "read",
    input: { file_path: PATH },
    result: {
      complete: false,
      failed: false,
      paths: [{ path: PATH, pathKey: PATH, lineCount: 2 }],
    },
    bytes: READ_BYTES,
    step: 1,
  });
}

function editNode(params: {
  readonly id?: string;
  readonly oldString: string;
  readonly newString: string;
  readonly failed: boolean;
}): ToolResultNode {
  return resultNode({
    id: params.id ?? "edit-1",
    toolName: "edit",
    input: {
      file_path: PATH,
      old_string: params.oldString,
      new_string: params.newString,
    },
    result: {
      complete: params.failed ? false : true,
      failed: params.failed,
      paths: [{ path: PATH, pathKey: PATH }],
    },
    bytes: params.failed
      ? "old_string and new_string must differ"
      : "The file src/a.ts has been updated successfully.",
    step: 2,
  });
}

function snapshot(nodes: readonly ToolResultNode[]): SessionSnapshot {
  return {
    sessionId: "s",
    revision: "1",
    currentTurnOrdinal: 1,
    completedThroughTurnOrdinal: 1,
    currentStepOrdinal: 2,
    nodes,
    cache: { kind: "unknown" },
    retentionEvidence: [],
    pathCoverage: [{
      pathKey: PATH,
      bytes: READ_BYTES.length,
      hitBytes: READ_BYTES.length,
      missBytes: 0,
      unknownBytes: 0,
      observations: 1,
    }],
  };
}

function invalidate(nodes: readonly ToolResultNode[]) {
  const before = snapshot(nodes);
  const units = new UnitTracker({ sessionId: "s", barBytes: 1 }).units(before);
  const invalidation = computeInvalidation({ snapshot: before, units });
  return { before, invalidation, planning: withoutStaleCoverage(before, invalidation) };
}

const CAPABILITIES: CapabilityFlags = {
  mutateResult: true,
  rewriteHistory: true,
  atRest: false,
  liveTokens: false,
  log: false,
  appendRecords: false,
  rehydrateOnResume: false,
};

/**
 * Run the guard's own invalidation check over a partial removal of the read
 * unit. The fixture is a genuine edit-outside-coverage shape: the control below
 * shows the same removal is refused after a committed write.
 */
function coverageRefusals(nodes: readonly ToolResultNode[]): readonly ValidationIssue[] {
  const before = snapshot(nodes);
  const units = new UnitTracker({ sessionId: "s", barBytes: 1 }).units(before);
  const readUnit = units.find((unit) => unit.nodeId === "read-1");
  assert.ok(readUnit, "the read fixture yields one unit");
  const plan: RulePlan = {
    ruleId: "test-rule",
    baseRevision: before.revision,
    removals: [{
      id: "rem-1",
      title: "kept lines of src/a.ts",
      sources: [{
        source: readUnit.source,
        ranges: [{ startByte: 0, endByteExclusive: 1 }],
      }],
    }],
    notes: [],
    operations: [{
      kind: "verdict",
      removalId: "rem-1",
      unitId: readUnit.id,
      noteId: "note-1",
    }],
  };
  const context: CheckContext = {
    value: {
      input: { kind: "at-rest", eventId: "event-187", reason: "step" },
      snapshot: before,
      capabilities: CAPABILITIES,
      // The ticket's deterministic probe uses barBytes = 1 so the small read
      // body yields a unit; the guard must read the same bar.
      config: {
        ...DEFAULT_CONFIG,
        protocol: { ...DEFAULT_CONFIG.protocol, barBytes: 1 },
      },
      plans: [plan],
      sealedEpisodeIds: [],
      nowMs: 1,
    },
    nodes: new Map(before.nodes.map((node) => [node.id, node])),
    episodes: [],
    freshStart: 0,
    issues: [],
  };
  checkInvalidation(context, [plan]);
  return context.issues;
}

describe("racoons edit invalidation (ticket 187)", () => {
  it("distinguishes a committed write from a proven no-mutation refusal and an unknown failure", () => {
    const committed = evidenceOf({
      id: "edit-committed",
      toolName: "edit",
      input: { file_path: PATH, old_string: "a", new_string: "b" },
      result: { complete: true, failed: false, paths: [{ path: PATH }] },
      bytes: "updated",
      step: 2,
    });
    const refused = evidenceOf({
      id: "edit-refused",
      toolName: "edit",
      input: { file_path: PATH, old_string: "a", new_string: "a" },
      result: { complete: false, failed: true, paths: [{ path: PATH }] },
      bytes: "old_string and new_string must differ",
      step: 2,
    });
    const unknown = evidenceOf({
      id: "edit-unknown",
      toolName: "edit",
      input: { file_path: PATH, old_string: "a", new_string: "b" },
      result: { complete: false, failed: true, paths: [{ path: PATH }] },
      bytes: "edit failed",
      step: 2,
    });

    assert.equal(committed.kind, "write");
    assert.equal(committed.writeOutcome, "committed");
    assert.equal(refused.kind, "write");
    assert.equal(refused.writeOutcome, "no-mutation");
    assert.equal(unknown.kind, "write");
    assert.equal(unknown.writeOutcome, "unknown");
  });

  it("keeps a same-path read covered after a preflight-rejected edit", () => {
    const read = readNode();
    const { before, invalidation, planning } = invalidate([
      read,
      editNode({ oldString: "export const b = 2;", newString: "export const b = 2;", failed: true }),
    ]);

    assert.equal(invalidation.invalidatedNodeIds.size, 0, "the read is not invalidated");
    assert.equal(invalidation.units.length, 0, "no unit is invalidated");
    assert.deepEqual(invalidation.staleCoverage, [], "the path-coverage row is not stale");
    assert.deepEqual(invalidation.staleMaps, [], "no stale path map is claimed");
    assert.deepEqual(planning.pathCoverage, before.pathCoverage, "the coverage row survives planning");
  });

  it("does not refuse a partial removal as edit-outside-coverage after the refusal", () => {
    const read = readNode();
    const refused = editNode({
      oldString: "export const b = 2;",
      newString: "export const b = 2;",
      failed: true,
    });
    assert.deepEqual(coverageRefusals([read, refused]), [],
      "the no-mutation refusal alone causes no edit-outside-coverage");
  });

  it("still refuses a partial removal after a committed write (guard control)", () => {
    const read = readNode();
    const committed = editNode({
      oldString: "export const b = 2;",
      newString: "export const b = 3;",
      failed: false,
    });
    const issues = coverageRefusals([read, committed]);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.code, "edit-outside-coverage");
  });

  it("still invalidates a same-path read after a committed write", () => {
    const read = readNode();
    const { invalidation, planning } = invalidate([
      read,
      editNode({ oldString: "export const b = 2;", newString: "export const b = 3;", failed: false }),
    ]);

    assert.ok(invalidation.invalidatedNodeIds.has(read.id), "the read is invalidated");
    assert.equal(invalidation.staleCoverage.length, 1, "the path-coverage row is stale");
    assert.equal(planning.pathCoverage?.length, 0, "the stale row leaves the planning snapshot");
  });

  it("still invalidates a same-path read after a failed write with unknown mutation", () => {
    const read = readNode();
    const { invalidation } = invalidate([
      read,
      editNode({ oldString: "export const b = 2;", newString: "export const b = 3;", failed: true }),
    ]);

    assert.ok(invalidation.invalidatedNodeIds.has(read.id), "a possibly partial failure stays conservative");
    assert.equal(invalidation.staleCoverage.length, 1, "the path-coverage row is still stale");
  });

  it("still invalidates when a failed non-edit write has no no-mutation proof", () => {
    const read = readNode();
    const failedWrite = resultNode({
      id: "write-1",
      toolName: "write",
      input: { file_path: PATH, content: "partial" },
      result: { complete: false, failed: true, paths: [{ path: PATH }] },
      bytes: "write failed",
      step: 2,
    });
    const { invalidation } = invalidate([read, failedWrite]);

    assert.ok(invalidation.invalidatedNodeIds.has(read.id), "a failed write without proof stays conservative");
  });
});
