import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  abortedReportBody,
  clampActivity,
  clampError,
  clampReport,
  CHECK_ACTIVITY_CHARS,
  emptyReportPlaceholder,
  ERROR_CLAMP_CHARS,
  formatWakeReportBody,
  REPORT_CLAMP_CHARS,
} from "../src/core/report-clamp.js";

const FORBIDDEN_VOCAB = [
  "sand",
  "executor",
  "MessageSubagent",
  "SAND_MULTITASK_",
] as const;

function assertNewCopy(text: string): void {
  const lower = text.toLowerCase();
  for (const term of FORBIDDEN_VOCAB) {
    assert.ok(
      !lower.includes(term.toLowerCase()),
      `forbidden identifier in copy: ${term}`,
    );
  }
}

describe("report clamp — completed body", () => {
  it("trims and returns short text unchanged", () => {
    assert.equal(clampReport("  hello world  "), "hello world");
  });

  it("empty or whitespace-only → placeholder", () => {
    assert.equal(clampReport(""), emptyReportPlaceholder());
    assert.equal(clampReport("   \n\t "), emptyReportPlaceholder());
    assert.equal(clampReport(null), emptyReportPlaceholder());
    assert.equal(clampReport(undefined), emptyReportPlaceholder());
    assertNewCopy(emptyReportPlaceholder());
  });

  it("hard-cuts at REPORT_CLAMP_CHARS and appends a truncation marker", () => {
    const long = "x".repeat(REPORT_CLAMP_CHARS + 100);
    const out = clampReport(long, { transcriptRef: "child-1" });
    assert.ok(out.startsWith("x".repeat(REPORT_CLAMP_CHARS)));
    assert.ok(out.includes(`[report truncated: ${REPORT_CLAMP_CHARS} of ${long.length} characters.`));
    assert.ok(out.includes("Full transcript: child-1"));
    assert.ok(out.length > REPORT_CLAMP_CHARS);
  });

  it("never strips a path inside the kept prefix", () => {
    const path = "C:/work/src/auth/session.ts";
    const padded = path + "y".repeat(REPORT_CLAMP_CHARS);
    const out = clampReport(padded);
    assert.ok(out.startsWith(path));
  });

  it("omits transcript pointer when none is available", () => {
    const long = "z".repeat(REPORT_CLAMP_CHARS + 10);
    const out = clampReport(long);
    assert.ok(!out.includes("Full transcript:"));
  });
});

describe("report clamp — error body", () => {
  it("passes a short error through", () => {
    assert.equal(clampError("boom"), "boom");
  });

  it("empty error → minimal note, not the completed placeholder", () => {
    const out = clampError("");
    assert.ok(out.includes("failed"));
    assert.notEqual(out, emptyReportPlaceholder());
  });

  it("clamps at ERROR_CLAMP_CHARS", () => {
    const long = "e".repeat(ERROR_CLAMP_CHARS + 50);
    const out = clampError(long);
    assert.equal(out.startsWith("e".repeat(ERROR_CLAMP_CHARS)), true);
    assert.ok(out.includes("error truncated"));
  });

  it("formatWakeReportBody prefixes errors", () => {
    const body = formatWakeReportBody("error", "disk full");
    assert.equal(body, "Worker failed:\ndisk full");
    assertNewCopy(body);
  });
});

describe("report clamp — aborted and activity", () => {
  it("aborted body is bookkeeping only", () => {
    const body = formatWakeReportBody("aborted", "should not appear");
    assert.equal(body, abortedReportBody());
    assert.ok(body.includes("No report"));
    assert.ok(!body.includes("should not appear"));
    assertNewCopy(body);
  });

  it("activity clamp keeps null for missing lines", () => {
    assert.equal(clampActivity(null), null);
    assert.equal(clampActivity(undefined), null);
    assert.equal(clampActivity("   "), null);
  });

  it("activity clamp hard-cuts at CHECK_ACTIVITY_CHARS", () => {
    const long = "a".repeat(CHECK_ACTIVITY_CHARS + 20);
    const out = clampActivity(long);
    assert.ok(out !== null);
    assert.ok(out.startsWith("a".repeat(CHECK_ACTIVITY_CHARS)));
    assert.ok(out.endsWith("…"));
  });
});
